#!/usr/bin/env node
/**
 * Live browser regression for the refined run HUD and camera-aligned minimap.
 * Captures desktop + touch-landscape frames and proves real W/D movement moves
 * the minimap marker up/right respectively.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 8821);
const TIMEOUT = 90000;
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function mime(file) {
  if (/\.m?js$/.test(file)) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, `.${rel}`);
  const within = path.relative(ROOT, file);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function bootForest(page, touch = false) {
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=1${touch ? '&touch=1' : ''}`, {
    waitUntil: 'load', timeout: TIMEOUT,
  });
  await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: TIMEOUT });
  await page.evaluate(async () => {
    const meta = await import('./src/meta.js');
    meta.setOption('selectedStage', 'forest');
    await window.kkStartRun();
  });
  await page.waitForFunction(() => {
    const s = window.kkState;
    return !!(s && s.started && s.mode === 'run');
  }, null, { timeout: TIMEOUT });
  await page.evaluate(() => {
    const s = window.kkState;
    s.hero.hpMax = 1e9;
    s.hero.hp = 1e9;
    // Exercise both formerly-oversized READY cards. The compact deck should
    // surface these as action slots with a state dot, not text panels.
    s.hero.dashUnlocked = true;
    s.hero.dashLevel = Math.max(1, s.hero.dashLevel || 0);
    s.hero.dashCD = 0;
    s.hero.active = { id: 'nova', level: 2, cd: 0 };
  });
  await page.waitForFunction(() => {
    const map = document.getElementById('kk-portal-minimap');
    return !!(map && map.dataset.projection === 'camera-aligned'
      && Number.isFinite(Number(map.dataset.heroX))
      && getComputedStyle(map).display !== 'none');
  }, null, { timeout: TIMEOUT });
}

async function hudSnapshot(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const overlap = (a, b) => !!(a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y);
    const contains = (outer, inner, slop = 1) => !!(outer && inner
      && inner.x >= outer.x - slop && inner.right <= outer.right + slop
      && inner.y >= outer.y - slop && inner.bottom <= outer.bottom + slop);
    const deck = rect('#kk-command-deck');
    const hp = rect('.kk-hp-wrap');
    const stats = rect('.kk-stats');
    const map = rect('#kk-portal-minimap');
    const clock = rect('#kk-forest-hud-clock');
    const ability = rect('.kk-ability-dock');
    const weapons = rect('#kk-weapon-panel');
    const pause = rect('#kk-touch-pause');
    const touchDash = rect('#kk-touch-dash');
    const touchActive = rect('#kk-touch-active');
    const sigils = rect('#kk-forest-sigil-hud-counter');
    const toast = rect('.kk-achievement-toast,.kk-secret-toast');
    const abilityChips = Array.from(document.querySelectorAll('.kk-ability-chip'))
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.id, width: r.width, height: r.height,
          status: el.querySelector('.kk-ability-status')?.textContent || '',
          ready: el.classList.contains('kk-ability-ready'),
        };
      });
    return {
      deck, hp, stats, map, clock, ability, abilityChips, weapons,
      pause, touchDash, touchActive, sigils, toast,
      hpMapOverlap: overlap(hp, map),
      clockStatsOverlap: overlap(clock, stats),
      pauseStatsOverlap: overlap(pause, stats),
      pauseSigilsOverlap: overlap(pause, sigils),
      weaponDashOverlap: overlap(weapons, touchDash),
      weaponActiveOverlap: overlap(weapons, touchActive),
      toastUtilitiesOverlap: overlap(toast, pause) || overlap(toast, sigils),
      hpInDeck: contains(deck, hp),
      statsInDeck: contains(deck, stats),
      weaponsInDeck: !weapons || contains(deck, weapons),
      hpText: document.querySelector('.kk-hp-value')?.textContent || '',
      statLabels: Array.from(document.querySelectorAll('.kk-stat-label')).map((el) => el.textContent),
      projection: document.getElementById('kk-portal-minimap')?.dataset.projection || '',
      weaponCells: document.querySelectorAll('.kk-weapon-cell').length,
      viewport: { w: innerWidth, h: innerHeight, scrollW: document.documentElement.scrollWidth },
    };
  });
}

async function mapPoint(page) {
  return page.evaluate(() => {
    const map = document.getElementById('kk-portal-minimap');
    const p = window.kkState.hero.pos;
    return { x: Number(map.dataset.heroX), y: Number(map.dataset.heroY), worldX: p.x, worldZ: p.z };
  });
}

async function main() {
  assert(fs.existsSync(PLAY_PATH), 'shared Playwright install missing');
  assert(fs.existsSync(PLAYWRIGHT_EXEC), 'shared Chromium binary missing');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const pageErrors = [];

  try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await desktop.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await bootForest(page);

    const start = await mapPoint(page);
    await page.keyboard.down('w');
    try {
      // SwiftShader can render the authored Forest at only a few frames per
      // second on a busy CI host. Wait for actual simulated movement instead
      // of assuming 1.8 wall-clock seconds contains enough gameplay frames.
      await page.waitForFunction(({ worldX, worldZ, mapY }) => {
        const map = document.getElementById('kk-portal-minimap');
        const p = window.kkState?.hero?.pos;
        return !!(map && p
          && p.x < worldX && p.z < worldZ
          && Number(map.dataset.heroY) < mapY - 0.15);
      }, { worldX: start.worldX, worldZ: start.worldZ, mapY: start.y }, { timeout: 30000, polling: 100 });
    } finally {
      await page.keyboard.up('w');
    }
    await page.waitForTimeout(500);
    const up = await mapPoint(page);
    assert(up.worldX < start.worldX && up.worldZ < start.worldZ,
      `W did not follow the isometric world-up vector: ${JSON.stringify({ start, up })}`);
    assert(up.y < start.y - 0.15, `W did not move the minimap marker up: ${JSON.stringify({ start, up })}`);
    assert(Math.abs(up.x - start.x) < Math.max(1.4, Math.abs(up.y - start.y) * 0.28),
      `W leaked sideways on the minimap: ${JSON.stringify({ start, up })}`);

    await page.keyboard.down('d');
    try {
      await page.waitForFunction(({ worldX, worldZ, mapX }) => {
        const map = document.getElementById('kk-portal-minimap');
        const p = window.kkState?.hero?.pos;
        return !!(map && p
          && p.x > worldX && p.z < worldZ
          && Number(map.dataset.heroX) > mapX + 0.15);
      }, { worldX: up.worldX, worldZ: up.worldZ, mapX: up.x }, { timeout: 30000, polling: 100 });
    } finally {
      await page.keyboard.up('d');
    }
    await page.waitForTimeout(500);
    const right = await mapPoint(page);
    assert(right.worldX > up.worldX && right.worldZ < up.worldZ,
      `D did not follow the isometric world-right vector: ${JSON.stringify({ up, right })}`);
    assert(right.x > up.x + 0.15, `D did not move the minimap marker right: ${JSON.stringify({ up, right })}`);
    assert(Math.abs(right.y - up.y) < Math.max(1.4, Math.abs(right.x - up.x) * 0.28),
      `D leaked vertically on the minimap: ${JSON.stringify({ up, right })}`);

    // Let initial unlock toasts clear before judging the stable HUD frame.
    await page.waitForTimeout(3800);
    const desktopHud = await hudSnapshot(page);
    assert(desktopHud.projection === 'camera-aligned', 'minimap projection stamp missing');
    assert(/\d+\s*\/\s*\d+/.test(desktopHud.hpText), `vitality number missing: ${desktopHud.hpText}`);
    assert(['Level', 'Run Time', 'Kills', 'DPS'].every((label) => desktopHud.statLabels.includes(label)),
      `run telemetry hierarchy incomplete: ${desktopHud.statLabels.join(', ')}`);
    assert(desktopHud.deck && desktopHud.deck.height <= 74,
      `desktop command deck is too tall: ${JSON.stringify(desktopHud.deck)}`);
    assert(desktopHud.hpInDeck && desktopHud.statsInDeck && desktopHud.weaponsInDeck,
      `desktop HUD escaped the command deck: ${JSON.stringify(desktopHud)}`);
    assert(desktopHud.map && desktopHud.map.width <= 134 && desktopHud.map.height <= 92,
      `desktop minimap is not compact: ${JSON.stringify(desktopHud.map)}`);
    assert(Math.abs((desktopHud.map.x + desktopHud.map.width * 0.5) - desktopHud.viewport.w * 0.5) <= 2,
      `desktop minimap is not centered: ${JSON.stringify(desktopHud.map)}`);
    assert(Math.min(desktopHud.deck.y, desktopHud.map.y) >= desktopHud.viewport.h * 0.84,
      `persistent HUD intrudes into gameplay space: ${JSON.stringify(desktopHud)}`);
    assert(desktopHud.clock && desktopHud.clock.width <= 2 && desktopHud.clock.height <= 2,
      `duplicate Forest clock is still visually exposed: ${JSON.stringify(desktopHud.clock)}`);
    assert(desktopHud.abilityChips.length === 2
      && desktopHud.abilityChips.every((chip) => chip.width <= 48 && chip.height <= 52
        && chip.ready && !/ready/i.test(chip.status)),
    `READY cards were not reduced to compact action slots: ${JSON.stringify(desktopHud.abilityChips)}`);
    assert(!desktopHud.hpMapOverlap, `vitality and minimap overlap: ${JSON.stringify(desktopHud)}`);
    assert(!desktopHud.clockStatsOverlap, `clock and run telemetry overlap: ${JSON.stringify(desktopHud)}`);
    assert(desktopHud.viewport.scrollW <= desktopHud.viewport.w, 'desktop HUD causes horizontal overflow');
    await page.screenshot({ path: '/tmp/kks-ui-polish-desktop.png', fullPage: false });
    const dialogIsolation = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.setAttribute('role', 'dialog');
      document.getElementById('ui-root').appendChild(probe);
      const forest = document.getElementById('kk-forest-hud');
      const sigils = document.getElementById('kk-forest-sigil-hud');
      const result = {
        forest: forest ? getComputedStyle(forest).visibility : 'missing',
        sigils: sigils ? getComputedStyle(sigils).visibility : 'missing',
      };
      probe.remove();
      return result;
    });
    assert(dialogIsolation.forest === 'hidden' && dialogIsolation.sigils === 'hidden',
      `Forest utility chrome leaks over dialogs: ${JSON.stringify(dialogIsolation)}`);
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    const mobilePage = await mobile.newPage();
    mobilePage.on('pageerror', (err) => pageErrors.push(err.message));
    await bootForest(mobilePage, true);
    await mobilePage.waitForTimeout(1600);
    const mobileHud = await hudSnapshot(mobilePage);
    assert(mobileHud.viewport.scrollW <= mobileHud.viewport.w, 'touch HUD causes horizontal overflow');
    assert(mobileHud.deck && mobileHud.deck.height <= 66
      && mobileHud.hpInDeck && mobileHud.statsInDeck && mobileHud.weaponsInDeck,
    `touch command deck escaped or grew too tall: ${JSON.stringify(mobileHud)}`);
    assert(mobileHud.map && mobileHud.map.width <= 114 && mobileHud.map.height <= 78,
      `touch minimap is not compact: ${JSON.stringify(mobileHud.map)}`);
    assert(Math.abs((mobileHud.map.x + mobileHud.map.width * 0.5) - mobileHud.viewport.w * 0.5) <= 2,
      `touch minimap is not centered: ${JSON.stringify(mobileHud.map)}`);
    assert(Math.min(mobileHud.deck.y, mobileHud.map.y) >= mobileHud.viewport.h * 0.72,
      `touch HUD intrudes into gameplay space: ${JSON.stringify(mobileHud)}`);
    assert(!mobileHud.hpMapOverlap, `touch vitality and minimap overlap: ${JSON.stringify(mobileHud)}`);
    assert(!mobileHud.pauseStatsOverlap && !mobileHud.pauseSigilsOverlap,
      `touch pause utility overlaps telemetry/currency: ${JSON.stringify(mobileHud)}`);
    assert(!mobileHud.toastUtilitiesOverlap, `touch notification overlaps utility row: ${JSON.stringify(mobileHud)}`);
    assert(!mobileHud.weaponDashOverlap && !mobileHud.weaponActiveOverlap,
      `touch action buttons overlap weapon slots: ${JSON.stringify(mobileHud)}`);
    assert(mobileHud.touchDash && mobileHud.touchDash.width <= 70 && mobileHud.touchDash.height <= 70
      && mobileHud.touchActive && mobileHud.touchActive.width <= 56 && mobileHud.touchActive.height <= 56,
    `touch action targets are oversized: ${JSON.stringify({ dash: mobileHud.touchDash, active: mobileHud.touchActive })}`);
    assert(mobileHud.hp && mobileHud.hp.x >= 0 && mobileHud.hp.right <= mobileHud.viewport.w, 'touch vitality is off-screen');
    assert(mobileHud.stats && mobileHud.stats.x >= 0 && mobileHud.stats.right <= mobileHud.viewport.w, 'touch telemetry is off-screen');
    await mobilePage.screenshot({ path: '/tmp/kks-ui-polish-mobile.png', fullPage: false });
    await mobile.close();

    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    console.log('[smoke-ui-polish] PASS — W→up, D→right; desktop + touch HUD frames clean');
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error('[smoke-ui-polish] FAIL —', err && err.stack ? err.stack : err);
  server.close(() => process.exit(1));
});
