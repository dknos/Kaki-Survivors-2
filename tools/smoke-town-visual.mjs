#!/usr/bin/env node
/**
 * Town visual self-check (CC9, 2026-05-20).
 *
 * The town's render-level gate — mirrors CC7 (smoke-cave-v2 phase 13) for the
 * TOWN. The 4 town cohorts (grimoire/shop wiring, sage NPC, biome gate
 * dressing, gate-launch flare) all shipped verified ONLY by the static-source
 * smoke-town.mjs — never rendered, so the NPC look / planter colors / portal
 * read all shipped blind exactly like the cave was pre-CC7.
 *
 * Boot path (mirrors smoke-cave-v2): goto /index.html?smoke=1 → wait for the
 * window.kkEnterTown hook (main.js:675; hides menu, buildTown + enterTown,
 * sets state.started) → await it → wait for state.mode === 'town' → settle so
 * the NPC spawns + the plaza ticks → render check + screenshot.
 *
 * Checks:
 *   (a) Force one render to the canvas back buffer + readPixels a 5-point
 *       center cross → assert the town is NOT a black/empty frame (maxLum > 2).
 *       readPixels-after-our-own-render reads the back buffer in the same task
 *       (valid regardless of preserveDrawingBuffer). The lit plaza floor makes
 *       a real render clear this trivially; a broken render reads ~0.
 *   (b) Save tools/_thumb_town_visual.png (gitignored) so a human can eyeball
 *       the NPC / planters / portal without launching, + an 8KB byte floor.
 *   (c) 0 page errors during the town boot.
 *
 * NOT a perf gate (headless swiftshader). Run: node tools/smoke-town-visual.mjs
 * NO npm install. Playwright expected at /home/nemoclaw/node_modules.
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
// Distinct port from the other smokes (cave=8778, forest-v2=8773, amber=8771).
const PORT = Number(process.env.PORT || 8779);
const BOOT_TIMEOUT_MS = 60000;
const SETTLE_MS = 3500;

function mime(p) {
  if (p.endsWith('.js'))   return 'application/javascript';
  if (p.endsWith('.mjs'))  return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg'))  return 'image/svg+xml';
  if (p.endsWith('.mp3'))  return 'audio/mpeg';
  if (p.endsWith('.wav'))  return 'audio/wav';
  if (p.endsWith('.ogg'))  return 'audio/ogg';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-town-visual] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-town-visual] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-town-visual] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-town-visual] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-town-visual] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  if (process.env.ALL_HEROES === '1') {
    await page.addInitScript(() => {
      const ids = ['kitty','sote','cowboy','pipes','bomdia','mothman','camper','space','radcat','mona','bezelbug','rocker','borgirboss','rune_kitten','mire_kitten','shroud_kitten'];
      const avatarUnlocks = Object.fromEntries(ids.map(id => [id, { unlockedAt: 1, kills: 0, runs: 0, source: 'smoke' }]));
      localStorage.setItem('kk-survivors-meta-v2', JSON.stringify({ version: 1, migrationVersion: 2, selectedAvatar: 'kitty', selectedStage: 'forest', avatarUnlocks }));
    });
  }

  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[pageerror]', e.message); });

  let exitCode = 0;
  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-town-visual] page loaded; waiting for kkEnterTown');

    await page.waitForFunction(
      () => typeof window.kkEnterTown === 'function',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Enter town (buildTown + enterTown). kkEnterTown is async (awaits the
    // town-kit preload); evaluate awaits it so the town is built on return.
    await page.evaluate(async () => {
      if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
      await window.kkEnterTown();
    });

    await page.waitForFunction(
      () => !!window.kkState && window.kkState.mode === 'town',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    console.log('[smoke-town-visual] in town; settling ' + SETTLE_MS + 'ms (NPC spawn + plaza tick)');
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const heroNpcs = await page.evaluate(() => typeof window.kkTownHeroesDebug === 'function'
      ? window.kkTownHeroesDebug()
      : []);
    const visibleHeroNpcs = heroNpcs.filter(n => n.hasFigure && n.present && n.visible);
    console.log('  town heroes:', heroNpcs.map(n => `${n.id}:${n.hasFigure ? 'mesh' : 'empty'}:${n.visible ? 'visible' : 'hidden'}`).join(', '));

    const shot = path.join(__dirname, '_thumb_town_visual.png');
    await page.screenshot({ path: shot, fullPage: false });
    const shotBytes = (() => { try { return fs.statSync(shot).size; } catch (_) { return -1; } })();

    const pv = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.renderer || !s.scene || !s.camera) {
        return { ok: false, reason: 'renderer/scene/camera missing on kkState' };
      }
      const r = s.renderer;
      try { r.setRenderTarget(null); r.render(s.scene, s.camera); }
      catch (e) { return { ok: false, reason: 'render threw: ' + (e && e.message) }; }
      let gl;
      try { gl = r.getContext(); } catch (_) { return { ok: false, reason: 'getContext threw' }; }
      const cv = r.domElement;
      const w = cv.width | 0, h = cv.height | 0;
      if (w < 2 || h < 2) return { ok: false, reason: 'canvas too small ' + w + 'x' + h };
      const pts = [[0.5, 0.5], [0.42, 0.5], [0.58, 0.5], [0.5, 0.42], [0.5, 0.58]];
      const buf = new Uint8Array(4);
      let maxLum = 0;
      for (const [fx, fy] of pts) {
        const x = Math.min(w - 1, Math.max(0, Math.floor(w * fx)));
        const y = Math.min(h - 1, Math.max(0, Math.floor(h * fy)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const lum = 0.2126 * buf[0] + 0.7152 * buf[1] + 0.0722 * buf[2];
        if (lum > maxLum) maxLum = lum;
      }
      return { ok: true, maxLum, w, h };
    });

    let pass, reason;
    if (!pv.ok) { pass = false; reason = pv.reason; }
    else if (!(pv.maxLum > 2)) { pass = false; reason = 'town center is black (maxLum=' + pv.maxLum.toFixed(1) + ') — empty/failed render'; }
    else if (visibleHeroNpcs.length < 2) { pass = false; reason = `starter townsfolk missing (${visibleHeroNpcs.length}/2 visible real meshes)`; }
    else if (visibleHeroNpcs.length > 6) { pass = false; reason = `town hero memory cap broken (${visibleHeroNpcs.length}/6 visible)`; }
    else if (!(shotBytes > 8000)) { pass = false; reason = 'screenshot too small (' + shotBytes + 'B) — capture failed'; }
    else { pass = true; reason = 'town renders (center maxLum=' + pv.maxLum.toFixed(1) + ', shot=' + shotBytes + 'B @ ' + pv.w + 'x' + pv.h + ')'; }

    console.log('town visual: ' + (pass ? 'PASS' : 'FAIL') + ' — ' + reason);
    console.log('  town screenshot: ' + shot + ' (' + shotBytes + 'B)');
    console.log('pageerrors: ' + pageErrors.length);
    for (const e of pageErrors) console.log('  - ' + e);

    if (!pass || pageErrors.length > 0) {
      console.error('[smoke-town-visual] FAIL — pass=' + pass + ' pageerrors=' + pageErrors.length);
      exitCode = 1;
    } else {
      console.log('[smoke-town-visual] OK — town renders + eyeball PNG saved');
    }
  } catch (e) {
    console.error('[smoke-town-visual] EXCEPTION:', e && (e.stack || e.message || e));
    exitCode = exitCode || 1;
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[smoke-town-visual] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
