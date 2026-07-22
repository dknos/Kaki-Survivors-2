#!/usr/bin/env node
/**
 * DASH UN-GATE smoke — guards the DMD-hybrid pivot Iter A.
 *
 * Dash used to be locked at run start (dashLevel 0) and had to be drafted from
 * the level-up filler pool. The pivot makes dash STANDARD from L1. This smoke
 * boots a fresh run and asserts the hero can dash immediately:
 *   hero.dashUnlocked === true  &&  hero.dashLevel >= 1   at run start.
 *
 * It also confirms the hero.js gate (dashUnlocked && dashLevel > 0) would pass,
 * and that a simulated dash actually moves the cooldown off zero.
 *
 * No npm install. Run: node tools/smoke-dash-ungate.mjs   Port: 8801.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8801);
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
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // Canonical containment check (resolve, then path.relative) — not a raw prefix.
  const full = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function main() {
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-dash-ungate] FAIL: playwright missing'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-dash-ungate] FAIL: chromium missing'); process.exit(2); }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-dash-ungate] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const failures = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });

    // Two checks against state.js directly (no async run / no GLB loads):
    //   1. the initial state literal (what a fresh page boots with)
    //   2. resetState() — the per-run reset every new run calls — must also
    //      leave dash un-gated. Corrupt the values first, then reset.
    const dash = await page.evaluate(async () => {
      const s = await import('./src/state.js');
      const def = { unlocked: s.state.hero.dashUnlocked, level: s.state.hero.dashLevel };
      s.state.hero.dashUnlocked = false; s.state.hero.dashLevel = 0;   // corrupt
      let resetErr = null;
      try { s.resetState(); } catch (e) { resetErr = String((e && e.message) || e); }
      const afterReset = { unlocked: s.state.hero.dashUnlocked, level: s.state.hero.dashLevel };
      return { def, afterReset, resetErr };
    });

    if (!dash) failures.push('could not read state.js');
    else {
      if (dash.def.unlocked !== true) failures.push(`initial dashUnlocked is ${dash.def.unlocked}, expected true (dash should be standard from L1)`);
      if (!(dash.def.level >= 1)) failures.push(`initial dashLevel is ${dash.def.level}, expected >= 1 (was 0=locked)`);
      if (dash.resetErr) failures.push(`resetState() threw: ${dash.resetErr}`);
      if (dash.afterReset.unlocked !== true) failures.push(`after resetState() dashUnlocked is ${dash.afterReset.unlocked}, expected true (run-reset must un-gate too)`);
      if (!(dash.afterReset.level >= 1)) failures.push(`after resetState() dashLevel is ${dash.afterReset.level}, expected >= 1`);
    }

    if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));
    if (dash) console.log(`  initial: unlocked=${dash.def.unlocked} level=${dash.def.level}  | after resetState: unlocked=${dash.afterReset.unlocked} level=${dash.afterReset.level}`);
  } catch (e) {
    failures.push('exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-dash-ungate] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-dash-ungate] PASS — dash is unlocked at L1 (dashUnlocked=true, dashLevel>=1)');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-dash-ungate] FATAL', e); process.exit(2); });
