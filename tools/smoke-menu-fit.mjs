#!/usr/bin/env node
/**
 * Iter 30 — MENU-FIT smoke.
 *
 * Verifies every full-screen menu "fits with scrolling" on a SHORT stage,
 * instead of clipping its top/bottom out of reach. The bug class: a
 * `position:fixed; inset:0` flex container with `justify-content:center`
 * and NO `overflow-y` clips BOTH ends when content exceeds the box — the
 * title scrolls above the top edge and can't be reached, and the buttons
 * fall below the bottom edge with no way to scroll to them.
 *
 * We boot at 800x360 (the aspect-capped #kk-stage becomes ~640x360, short
 * enough to force overflow on every menu) and, for each menu, assert:
 *   1. the container exists,
 *   2. its computed overflow-y is auto|scroll (it CAN scroll), and
 *   3. when content overflows (scrollHeight > clientHeight) the element
 *      actually scrolls — max scrollTop > 0. A broken center+visible
 *      container reports scrollHeight > clientHeight but maxScroll === 0
 *      (content is clipped, unreachable). That asymmetry is the detector.
 *
 * Menus covered: slot machine (showSlotMachine), pause/options
 * (showOptions), level-up (showLevelUpModal), death (showDeathScreen).
 *
 * No npm install — Playwright + Chromium at the shared cache paths, same
 * as smoke-p4h-a11y.mjs.
 *
 * Run: node tools/smoke-menu-fit.mjs
 * Port: 8782.
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
const PORT = Number(process.env.PORT || 8782);
const BOOT_TIMEOUT_MS = 60000;

function mime(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript';
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

async function waitBoot(page) {
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && window.kkState,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-menu-fit] FAIL: playwright not at ' + PLAY_PATH + ' (smoke NEVER npm installs)');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-menu-fit] FAIL: chromium not at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-menu-fit] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-menu-fit] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  // Short stage: 800x360 -> aspect-capped #kk-stage ~640x360. Forces every
  // menu to overflow vertically so the scroll path is actually exercised.
  const ctx = await browser.newContext({ viewport: { width: 800, height: 360 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[pageerror]', e.message); });

  const failures = [];
  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    // Start a run so weapons/state are live for level-up + death.
    await page.evaluate(() => window.kkStartRun && window.kkStartRun());
    await page.waitForTimeout(300);
    console.log('[smoke-menu-fit] boot OK; stage', await page.evaluate(() => {
      const s = document.getElementById('kk-stage');
      return s ? s.clientWidth + 'x' + s.clientHeight : 'none';
    }));

    const results = await page.evaluate(async () => {
      const ui = await import('./src/ui.js');
      const wi = await import('./src/weapons/index.js');
      const out = {};

      function probe(el) {
        if (!el) return { found: false };
        const cs = getComputedStyle(el);
        el.scrollTop = 0;
        el.scrollTop = 999999;        // try to scroll to the very bottom
        const maxScroll = el.scrollTop;
        el.scrollTop = 0;
        return {
          found: true,
          overflowY: cs.overflowY,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflows: el.scrollHeight > el.clientHeight + 1,
          maxScroll,
        };
      }
      // inline-styled overlays are identified by their fixed z-index
      const findZ = (z) => [...document.querySelectorAll('div')]
        .find((d) => d.style && d.style.position === 'fixed' && d.style.zIndex === z) || null;

      // 1. slot machine (z-index 105)
      ui.showSlotMachine();
      out.slot = probe(findZ('105'));
      const s = findZ('105'); if (s) s.remove();

      // 2. pause / options (z-index 120)
      ui.showOptions();
      out.pause = probe(findZ('120'));
      const o = findZ('120'); if (o) o.remove();

      // 3. level-up (.kk-modal)
      const choices = wi.weaponChoices(3);
      if (window.kkState) window.kkState.levelUpChoices = choices;
      ui.showLevelUpModal(choices);
      out.levelup = probe(document.querySelector('.kk-modal'));
      const lm = document.querySelector('.kk-modal'); if (lm) lm.remove();

      // 4. death (.kk-death) — last; mutates state
      ui.showDeathScreen();
      out.death = probe(document.querySelector('.kk-death'));

      return out;
    });

    for (const [name, r] of Object.entries(results)) {
      if (!r.found) { failures.push(`${name}: container not found`); console.log(`  ${name}: NOT FOUND`); continue; }
      const scrollable = r.overflowY === 'auto' || r.overflowY === 'scroll';
      const reachable = !r.overflows || r.maxScroll > 0;
      console.log(`  ${name}: overflowY=${r.overflowY} scrollH=${r.scrollHeight} clientH=${r.clientHeight} overflows=${r.overflows} maxScroll=${r.maxScroll} -> ${scrollable && reachable ? 'OK' : 'FAIL'}`);
      if (!scrollable) failures.push(`${name}: overflow-y is "${r.overflowY}" (must be auto|scroll so it can scroll)`);
      if (!reachable)  failures.push(`${name}: content overflows (scrollH ${r.scrollHeight} > clientH ${r.clientHeight}) but maxScroll=0 — top/bottom clipped, unreachable`);
    }

    if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));
  } catch (e) {
    failures.push('exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-menu-fit] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-menu-fit] PASS — every menu fits with scrolling at 800x360');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-menu-fit] FATAL', e); process.exit(2); });
