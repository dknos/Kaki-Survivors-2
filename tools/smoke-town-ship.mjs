#!/usr/bin/env node
/**
 * Town ship-path smoke.
 *
 * Exercises the actual hub lifecycle against a browser: modal input lock,
 * house/casino scene isolation, repeat house visits, and cancellation of a
 * deferred gate launch when the player returns to the menu.
 *
 * Run from WSL: node tools/smoke-town-ship.mjs
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8786);
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const TIMEOUT = 60000;

function mime(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function moveHero(page, x, z) {
  await page.evaluate(({ x: nx, z: nz }) => {
    const s = window.kkState;
    s.hero.pos.set(nx, 0, nz);
    s.hero.vel.set(0, 0, 0);
    if (s.hero.mesh) s.hero.mesh.position.set(nx, 0, nz);
  }, { x, z });
  await page.waitForTimeout(120);
}

async function interact(page) {
  await page.keyboard.press('e');
}

async function waitForMode(page, mode) {
  await page.waitForFunction((expected) => window.kkState && window.kkState.mode === expected, mode, { timeout: TIMEOUT });
}

async function townSnapshot(page) {
  return page.evaluate(async () => {
    const s = window.kkState;
    const [{ getZoom }, { WORLD }] = await Promise.all([
      import('/src/input.js'),
      import('/src/config.js'),
    ]);
    const town = s.scene.getObjectByName('townGroup');
    const prompt = document.getElementById('kk-town-prompt');
    const hud = document.querySelector('.kk-hud');
    return {
      mode: s.mode,
      townVisible: !!(town && town.visible),
      envVisible: !!(s.envGroup && s.envGroup.visible),
      promptVisible: !!(prompt && getComputedStyle(prompt).display !== 'none'),
      hudVisible: !!(hud && getComputedStyle(hud).display !== 'none'),
      cameraTop: s.camera && s.camera.top,
      expectedCameraTop: WORLD.cameraDistance / getZoom(),
    };
  });
}

async function assertCleanTown(page, label) {
  const snap = await townSnapshot(page);
  assert(snap.mode === 'town', `${label}: expected town mode, got ${snap.mode}`);
  assert(snap.townVisible, `${label}: town group is hidden`);
  assert(snap.envVisible, `${label}: shared environment is hidden`);
  assert(!snap.hudVisible, `${label}: combat HUD leaked into Town`);
  assert(Math.abs(snap.cameraTop - snap.expectedCameraTop) < 0.01,
    `${label}: Town camera frustum is ${snap.cameraTop}, expected ${snap.expectedCameraTop}`);
}

async function main() {
  assert(fs.existsSync(PLAY_PATH) && fs.existsSync(CHROMIUM), 'Playwright/Chromium is unavailable at the documented WSL paths.');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=1`, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => typeof window.kkEnterTown === 'function', null, { timeout: TIMEOUT });
    await page.evaluate(() => window.kkEnterTown());
    await waitForMode(page, 'town');
    await page.waitForTimeout(250);
    await assertCleanTown(page, 'initial entry');

    // A visible modal owns input: pressing E while standing at the house must
    // not move the player into an interior behind the dialog.
    await moveHero(page, 0, -14);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-modal="true"]'), null, { timeout: TIMEOUT });
    await interact(page);
    await page.waitForTimeout(250);
    assert((await townSnapshot(page)).mode === 'town', 'modal input lock: E entered the house behind Options');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), null, { timeout: TIMEOUT });

    // Keyboard E is normalized by hero.js and consumed by Town after proximity.
    await moveHero(page, 0, -14);
    await interact(page);
    await waitForMode(page, 'interior');
    const house = await page.evaluate(() => {
      const s = window.kkState;
      const town = s.scene.getObjectByName('townGroup');
      const prompt = document.getElementById('kk-town-prompt');
      const interior = s.scene.getObjectByName('interiorGroup');
      window.__townShipComputer = interior && interior.userData._computer;
      return {
        townVisible: !!(town && town.visible),
        envVisible: !!(s.envGroup && s.envGroup.visible),
        townPromptVisible: !!(prompt && getComputedStyle(prompt).display !== 'none'),
        hasComputer: !!window.__townShipComputer,
      };
    });
    assert(!house.townVisible && !house.envVisible && !house.townPromptVisible, 'house entry leaked Town world or prompt');
    assert(house.hasComputer, 'house entry did not mount its computer desk');
    await page.keyboard.press('Escape');
    await waitForMode(page, 'town');
    await page.waitForTimeout(150);
    await assertCleanTown(page, 'house return');

    // A second visit must reuse the desk rather than rebuild/dispose it.
    await moveHero(page, 0, -14);
    await interact(page);
    await waitForMode(page, 'interior');
    const deskReused = await page.evaluate(() => {
      const interior = window.kkState.scene.getObjectByName('interiorGroup');
      return !!(interior && interior.userData._computer === window.__townShipComputer);
    });
    assert(deskReused, 'repeat house visit rebuilt the unchanged computer desk');
    await page.keyboard.press('Escape');
    await waitForMode(page, 'town');
    await page.waitForTimeout(150);
    await assertCleanTown(page, 'repeat house return');

    // Casino has an asynchronous preload; after it resolves it still has to
    // suspend Town and its shared backdrop before showing the interior.
    await moveHero(page, 12, -3);
    await interact(page);
    await waitForMode(page, 'casino_interior');
    const casino = await page.evaluate(() => {
      const s = window.kkState;
      const town = s.scene.getObjectByName('townGroup');
      const prompt = document.getElementById('kk-town-prompt');
      return {
        townVisible: !!(town && town.visible),
        envVisible: !!(s.envGroup && s.envGroup.visible),
        townPromptVisible: !!(prompt && getComputedStyle(prompt).display !== 'none'),
      };
    });
    assert(!casino.townVisible && !casino.envVisible && !casino.townPromptVisible, 'casino entry leaked Town world or prompt');
    await page.keyboard.press('Escape');
    await waitForMode(page, 'town');
    await page.waitForTimeout(150);
    await assertCleanTown(page, 'casino return');

    // Start itself is asynchronous. Pause it while a deliberately delayed
    // first stage asset is loading; it must return to Town instead of entering
    // combat behind the Options dialog.
    let stageLoadIntercepted = false;
    const delayedStageAsset = '**/assets/breakroom/Mushnub.glb';
    await page.route(delayedStageAsset, async (route) => {
      stageLoadIntercepted = true;
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    await page.evaluate(() => { window.kkStartRun(); });
    const interceptDeadline = Date.now() + 8000;
    while (!stageLoadIntercepted && Date.now() < interceptDeadline) await page.waitForTimeout(40);
    assert(stageLoadIntercepted, 'async start guard: expected the delayed stage asset to begin loading');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-modal="true"]'), null, { timeout: TIMEOUT });
    await page.waitForFunction(() => !document.getElementById('kk-stage-loader'), null, { timeout: TIMEOUT });
    const pausedStart = await townSnapshot(page);
    assert(pausedStart.mode === 'town' && pausedStart.townVisible && pausedStart.envVisible
      && !pausedStart.hudVisible
      && Math.abs(pausedStart.cameraTop - pausedStart.expectedCameraTop) < 0.01,
    `async start guard: Options allowed a run behind the dialog: ${JSON.stringify(pausedStart)}`);
    await page.unroute(delayedStageAsset);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'), null, { timeout: TIMEOUT });

    // Gate activation is intentionally delayed for the flourish. Navigating
    // away in that window must cancel the old callback instead of starting a
    // run over the menu.
    await moveHero(page, 0, 14);
    await interact(page);
    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForTimeout(900);
    const menu = await page.evaluate(() => ({
      mode: window.kkState.mode,
      started: window.kkState.started,
      stageLoader: !!document.getElementById('kk-stage-loader'),
      townVisible: !!window.kkState.scene.getObjectByName('townGroup')?.visible,
      hudVisible: !!(document.querySelector('.kk-hud') && getComputedStyle(document.querySelector('.kk-hud')).display !== 'none'),
    }));
    assert(menu.mode === 'menu' && !menu.started, `gate cancellation: menu was replaced by ${JSON.stringify(menu)}`);
    assert(!menu.stageLoader && !menu.townVisible && !menu.hudVisible, `gate cancellation left visual residue: ${JSON.stringify(menu)}`);

    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    console.log('[smoke-town-ship] PASS - modal lock, house/casino isolation, desk reuse, and gate cancellation');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error('[smoke-town-ship] FAIL:', error && (error.stack || error.message || error));
  try { server.close(); } catch (_) {}
  process.exit(1);
});
