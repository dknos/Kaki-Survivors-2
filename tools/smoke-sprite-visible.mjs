#!/usr/bin/env node
/**
 * Sprite-visibility gate (2026-05-21).
 *
 * Closes the blind spot that let "only shadows show up for mobs" ship: the
 * trash horde renders as billboard sprites (commit 30fd4ac), but NO smoke ever
 * entered a combat run to confirm those sprites actually draw above the floor.
 * The CC7/CC9 render gates only sample a center cross on the cave/town hub.
 *
 * Root cause this gate would have caught: spritePool VS anchor math hung
 * anchor.y=1 ("feet") sprites BELOW the floor (world.y ∈ [iPos.y-aScale,
 * iPos.y]); only the separate blob-shadow decal stayed visible.
 *
 * Boot: goto /index.html?smoke=1&touch=1 → wait for window.kkStartRun → start a
 * real run (forest default) → wait until a sprite enemy is alive → settle so the
 * sprite tick + moveSprite position the horde → checks:
 *   (a) >=1 enemy with _isSprite is active (sprite path engaged).
 *   (b) The 'enemies' InstancedMesh has live (non-stashed) instances and their
 *       world-y sits at the spawn plane (~0.06), NOT parked at STASH_Y. The
 *       sprite quad rises UP from there post-fix; a regression that re-inverts
 *       the anchor would not move the instance origin, so we also screenshot.
 *   (c) Save tools/_thumb_sprite_visible.png (gitignored, 8KB floor) so a human
 *       eyeballs that mob bodies — not just shadows — are on screen.
 *   (d) 0 page errors.
 *
 * NOT a perf gate (headless swiftshader). Run: node tools/smoke-sprite-visible.mjs
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
const PORT = Number(process.env.PORT || 8780);
const BOOT_TIMEOUT_MS = 60000;
const SPRITE_WAIT_MS = 20000;
const SETTLE_MS = Number(process.env.SETTLE_MS || 2000);

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

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-sprite-visible] FAIL: playwright not installed at ' + PLAY_PATH);
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-sprite-visible] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-sprite-visible] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-sprite-visible] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
           '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[pageerror]', e.message); });

  let exitCode = 0;
  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1&touch=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-sprite-visible] page loaded; waiting for kkStartRun');

    await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: BOOT_TIMEOUT_MS });

    await page.evaluate(async () => {
      if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
      await window.kkStartRun();
    });
    await page.waitForFunction(() => !!window.kkState && window.kkState.mode === 'run', null, { timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-sprite-visible] in run; waiting for a sprite enemy to spawn');

    await page.waitForFunction(
      () => {
        const s = window.kkState;
        return !!(s && s.enemies && s.enemies.active && s.enemies.active.some((e) => e._isSprite));
      },
      null,
      { timeout: SPRITE_WAIT_MS },
    );
    console.log('[smoke-sprite-visible] sprite enemy alive; settling ' + SETTLE_MS + 'ms');
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const shot = path.join(__dirname, '_thumb_sprite_visible.png');
    await page.screenshot({ path: shot, fullPage: false });
    const shotBytes = (() => { try { return fs.statSync(shot).size; } catch (_) { return -1; } })();

    const probe = await page.evaluate(() => {
      const s = window.kkState;
      const active = (s && s.enemies && s.enemies.active) || [];
      const spriteCount = active.filter((e) => e._isSprite).length;
      // Locate the enemies-atlas InstancedMesh by its bound texture URL.
      let em = null;
      s.scene.traverse((o) => {
        if (em) return;
        if (o.isInstancedMesh && o.material && o.material.uniforms && o.material.uniforms.uMap) {
          const tex = o.material.uniforms.uMap.value;
          const img = tex && tex.image;
          const src = (img && (img.currentSrc || img.src)) || '';
          if (src.indexOf('enemies_v1') >= 0) em = o;
        }
      });
      if (!em) return { spriteCount, found: false };
      const arr = em.instanceMatrix.array; // 16 floats / instance, y-translate at +13
      const sc = em.geometry.getAttribute('aScale');
      let alive = 0, yMin = Infinity, yMax = -Infinity, sampleScale = 0;
      for (let i = 0; i < em.count; i++) {
        const y = arr[i * 16 + 13];
        if (y > -9000) { // not parked at STASH_Y (-10000)
          alive++;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
          if (sampleScale === 0 && sc) sampleScale = sc.array[i];
        }
      }
      return { spriteCount, found: true, instAlive: alive, yMin, yMax, sampleScale, count: em.count };
    });

    let pass = true; const why = [];
    if (!(probe.spriteCount >= 1)) { pass = false; why.push('no _isSprite enemies active'); }
    if (!probe.found) { pass = false; why.push('enemies InstancedMesh not found in scene'); }
    else {
      if (!(probe.instAlive >= 1)) { pass = false; why.push('enemies mesh has 0 live instances (all stashed)'); }
      if (!(probe.yMin > -9000)) { pass = false; why.push('live instances parked off-screen'); }
    }
    if (!(shotBytes > 8000)) { pass = false; why.push('screenshot too small (' + shotBytes + 'B)'); }

    console.log('sprite enemies active : ' + probe.spriteCount);
    console.log('enemies mesh found    : ' + probe.found);
    if (probe.found) {
      console.log('  live instances      : ' + probe.instAlive + ' / ' + probe.count);
      console.log('  instance y-range    : ' + (probe.yMin === Infinity ? 'n/a' : probe.yMin.toFixed(3) + ' .. ' + probe.yMax.toFixed(3)) + '  (spawn plane ~0.06)');
      console.log('  sample aScale       : ' + (probe.sampleScale || 0).toFixed(3) + '  (sprite rises ~aScale above the plane post-fix)');
    }
    console.log('screenshot            : ' + shot + ' (' + shotBytes + 'B)');
    console.log('pageerrors            : ' + pageErrors.length);
    for (const e of pageErrors) console.log('  - ' + e);

    if (!pass || pageErrors.length > 0) {
      console.error('[smoke-sprite-visible] FAIL — ' + (why.join('; ') || ('pageerrors=' + pageErrors.length)));
      exitCode = 1;
    } else {
      console.log('[smoke-sprite-visible] OK — sprite mobs spawn + render on the floor plane (eyeball the PNG)');
    }
  } catch (e) {
    console.error('[smoke-sprite-visible] EXCEPTION:', e && (e.stack || e.message || e));
    exitCode = exitCode || 1;
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[smoke-sprite-visible] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
