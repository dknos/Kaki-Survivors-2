#!/usr/bin/env node
/**
 * STAGE-FILL smoke — guards the phone letterbox fix.
 *
 * computeStage() used to force the stage to EXACTLY MAX_ASPECT (21:9 on touch),
 * so a 19.5:9 phone in landscape (S24 = 2.167 < 2.333) got black bars top/
 * bottom and the body-mounted HUD floated inset from the real corners. The fix
 * makes the cap a MAXIMUM: on coarse pointers the stage fills the screen.
 *
 * Asserts, at 780x360 (S24-ish landscape, coarse via ?touch=1):
 *   - #kk-stage height === innerHeight  (no top/bottom bars)
 *   - #kk-stage width  === innerWidth   (no left/right bars)
 * And, on a non-touch 1280x720 desktop, the stage is STILL letterboxed to 16:9
 * (height < innerHeight) — the desktop FoV is intentionally unchanged.
 *
 * No npm install. Run: node tools/smoke-stage-fill.mjs   Port: 8805.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8805);
const BOOT_TIMEOUT_MS = 90000;

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

async function readStage(page) {
  return page.evaluate(() => {
    const s = document.getElementById('kk-stage').getBoundingClientRect();
    return { w: Math.round(s.width), h: Math.round(s.height), vw: window.innerWidth, vh: window.innerHeight };
  });
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-stage-fill] FAIL: playwright missing'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-stage-fill] FAIL: chromium missing'); process.exit(2); }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-stage-fill] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const failures = [];

  // ── Phone landscape (coarse): must FILL ──
  const ctx = await browser.newContext({ viewport: { width: 780, height: 360 }, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1&touch=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });
    // Forest HUD must NOT bleed onto the main menu (no run started yet).
    const hudOnMenu = await page.evaluate(() => { const k = document.getElementById('kk-forest-hud'); return k ? getComputedStyle(k).visibility : 'absent'; });
    if (hudOnMenu === 'visible') failures.push('forest HUD (Chests/Kills/Sigils) visible on the main menu before a run started');
    const s = await readStage(page);
    // Allow 2px rounding slack.
    if (Math.abs(s.h - s.vh) > 2) failures.push(`phone stage NOT full height: ${s.h} vs vh ${s.vh} (letterbox bars top/bottom)`);
    if (Math.abs(s.w - s.vw) > 2) failures.push(`phone stage NOT full width: ${s.w} vs vw ${s.vw}`);
    // Landscape: rotate gate must be hidden.
    const gateLand = await page.evaluate(() => { const g = document.getElementById('kk-rotate-gate'); return g ? getComputedStyle(g).display : 'absent'; });
    if (gateLand !== 'none') failures.push(`rotate gate not hidden in landscape (display=${gateLand})`);
    // Rotate to portrait: gate must show + stage still fills.
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForTimeout(200);
    const sp = await readStage(page);
    const gatePort = await page.evaluate(() => { const g = document.getElementById('kk-rotate-gate'); return g ? getComputedStyle(g).display : 'absent'; });
    if (gatePort !== 'flex') failures.push(`rotate gate not shown in portrait (display=${gatePort})`);
    if (Math.abs(sp.h - sp.vh) > 2) failures.push(`portrait stage NOT full height: ${sp.h} vs ${sp.vh}`);
    // The actual S24 report: landscape AR > 21:9 (browser chrome eats height,
    // ~2.34). The OLD code pillarboxed this into side bars. Must fill.
    await page.setViewportSize({ width: 940, height: 400 });   // AR 2.35 > 2.333
    await page.waitForTimeout(150);
    const sw = await readStage(page);
    if (Math.abs(sw.w - sw.vw) > 2) failures.push(`wide landscape (AR 2.35) stage NOT full width: ${sw.w} vs ${sw.vw} (side bars — the S24 report)`);
    if (Math.abs(sw.h - sw.vh) > 2) failures.push(`wide landscape (AR 2.35) stage NOT full height: ${sw.h} vs ${sw.vh}`);
    console.log(`  coarse landscape 780x360: stage ${s.w}x${s.h} gate=${gateLand} | portrait 360x780: stage ${sp.w}x${sp.h} gate=${gatePort} | wide 940x400: stage ${sw.w}x${sw.h}`);
  } catch (e) {
    failures.push('phone ctx exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx.close();
  }

  // ── Desktop (non-coarse): must STILL be 16:9 letterboxed (unchanged) ──
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page2 = await ctx2.newPage();
  try {
    await page2.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page2.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });
    const s = await readStage(page2);
    // 1280x720 IS exactly 16:9, so it fills — use a non-16:9 desktop to prove the cap.
    // Re-check at 1280x900 (taller than 16:9): height should cap below vh.
    await page2.setViewportSize({ width: 1280, height: 900 });
    await page2.waitForTimeout(200);
    const s2 = await readStage(page2);
    if (!(s2.h < s2.vh - 2)) failures.push(`desktop 1280x900 stage should stay 16:9-capped (h=${s2.h}, vh=${s2.vh}) — desktop FoV must not change`);
    const gateDesk = await page2.evaluate(() => !!document.getElementById('kk-rotate-gate'));
    if (gateDesk) failures.push('rotate gate created on desktop (should be touch-only)');
    console.log(`  desktop 1280x900: stage ${s2.w}x${s2.h}  (capped=${s2.h < s2.vh}, gate=${gateDesk})`);
  } catch (e) {
    failures.push('desktop ctx exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx2.close();
  }

  await browser.close();
  server.close();

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-stage-fill] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-stage-fill] PASS — phones fill the screen (no bars); desktop stays 16:9');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-stage-fill] FATAL', e); process.exit(2); });
