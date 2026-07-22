#!/usr/bin/env node

/** Browser-level victory UI gate at desktop and phone viewports. */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8801);
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const require = createRequire(import.meta.url);

function mime(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.jpg')) return 'image/jpeg';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (error, data) => {
    if (error) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

async function checkViewport(browser, name, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/index.html?victory-smoke=1`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => !!window.kkState && typeof window.kkReturnToMenu === 'function', null, { timeout: 60_000 });
  await page.evaluate(async () => {
    const [{ state }, { completeFinalBossVictory }, ui, menu] = await Promise.all([
      import('/src/state.js'),
      import('/src/enemies.js'),
      import('/src/ui.js'),
      import('/src/menuV2.js'),
    ]);
    menu.hideMenuV2();
    state.started = true;
    state.mode = 'run';
    state.run.stage = { id: 'forest', name: 'Verdant Forest' };
    state.run.avatar = 'kitty';
    state.run.character = 'kitty';
    state.run.kills = 87;
    state.run.dmgDealt = 54_321;
    state.run.dmgByWeapon = { orbitals: 40_000, autoaim: 14_321 };
    state.hero.level = 12;
    state.hero.hp = 64;
    state.hero.hpMax = 100;
    state.time.game = 512;
    completeFinalBossVictory(0, 0, { dropEndlessChests: false });
    ui.showDeathScreen();
  });
  await page.waitForSelector('.kk-victory-screen .kk-victory-shell', { timeout: 20_000 });
  await page.waitForTimeout(180);

  const result = await page.evaluate(() => {
    const screen = document.querySelector('.kk-death.kk-victory-screen');
    const shell = screen && screen.querySelector('.kk-victory-shell');
    const primary = shell && shell.querySelector('.kk-victory-primary');
    const screenRect = screen && screen.getBoundingClientRect();
    const shellRect = shell && shell.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      state: {
        victory: !!window.kkState.victory,
        gameOver: !!window.kkState.gameOver,
        outcome: window.kkState.run.outcome,
        hp: window.kkState.hero.hp,
      },
      title: shell?.querySelector('.kk-death-title')?.textContent || '',
      subtitle: shell?.querySelector('.kk-victory-subtitle')?.textContent || '',
      primary: primary?.textContent || '',
      background: screen ? getComputedStyle(screen).backgroundImage : '',
      screenRect: screenRect && { left: screenRect.left, top: screenRect.top, right: screenRect.right, bottom: screenRect.bottom },
      shellRect: shellRect && { left: shellRect.left, top: shellRect.top, right: shellRect.right, bottom: shellRect.bottom, width: shellRect.width },
      horizontalOverflow: screen ? screen.scrollWidth - screen.clientWidth : 999,
      screenScrollable: screen ? screen.scrollHeight >= screen.clientHeight : false,
      shellScrollTop: shell ? shell.scrollTop : -1,
      details: !!shell?.querySelector('.kk-victory-details'),
    };
  });

  const epsilon = 2;
  if (!result.state.victory
    || !result.state.gameOver
    || result.state.outcome?.kind !== 'victory'
    || result.state.outcome?.stageId !== 'forest'
    || !(result.state.hp > 0)
    || result.title !== 'THE CREW DID IT!'
    || !result.subtitle.includes('Verdant Forest')
    || !result.primary.includes('Celebrate in Town')
    || !result.background.includes('victory_crew_hangout_20260716.webp')
    || !result.details
    || !result.screenRect
    || !result.shellRect
    || result.shellRect.left < -epsilon
    || result.shellRect.right > result.viewport.width + epsilon
    || result.shellRect.width > result.viewport.width + epsilon
    || result.horizontalOverflow > epsilon
    || result.shellScrollTop > epsilon) {
    throw new Error(`${name} victory layout failed: ${JSON.stringify(result)}`);
  }

  const shot = `/tmp/kks-victory-${name}.png`;
  await page.screenshot({ path: shot, fullPage: false });
  if (!fs.existsSync(shot) || fs.statSync(shot).size < 20_000) {
    throw new Error(`${name} victory screenshot missing or too small`);
  }
  if (errors.length) throw new Error(`${name} page errors: ${errors.join(' | ')}`);
  await context.close();
  return { name, shot, bytes: fs.statSync(shot).size, shell: result.shellRect };
}

async function main() {
  if (!fs.existsSync(PLAYWRIGHT) || !fs.existsSync(CHROME)) throw new Error('Playwright/Chromium cache missing');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  try {
    const desktop = await checkViewport(browser, 'desktop', { width: 1280, height: 720 });
    const phone = await checkViewport(browser, 'phone', { width: 390, height: 844 });
    console.log('[smoke-victory-screen] PASS — dedicated victory UI fits desktop + phone');
    console.log('[smoke-victory-screen] ' + JSON.stringify({ desktop, phone }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  try { server.close(); } catch (_) {}
  console.error('[smoke-victory-screen] FAIL:', error && (error.stack || error.message || error));
  process.exit(1);
});
