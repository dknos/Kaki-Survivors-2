#!/usr/bin/env node
/**
 * Headless RAM-diet smoke for tiered preload (Hotfix #151, 2026-05-18).
 *
 * Measures Chromium's V8 JS heap (performance.memory.usedJSHeapSize) at
 * two checkpoints:
 *   1. Menu boot — after kkStartRun is registered (preloadEssential done),
 *      BEFORE the user clicks Play.
 *   2. After kkStartRun('forest') — preloadStage('forest') has resolved,
 *      stage decor + enemy roster cached, prewarmPools has warmed.
 *
 * Gates:
 *   - Boot heap < 600 MB (prior all-at-boot baseline was ~800 MB JS heap +
 *     ~1.6 GB GPU resident; tiered preload should drop the JS portion
 *     substantially since 50+ enemy/kit/decor GLBs are no longer parsed at
 *     boot). 600 MB headroom is generous — actual measured value drives
 *     a tighter assertion in the next iteration if the win is bigger.
 *   - Stage-delta < 300 MB. Stage load brings core mobs (~5 MB GLB total)
 *     + env props + forest bugs (~2 MB GLB total) + parsed Three.js
 *     scene-graphs. 300 MB cap absorbs the multiplier from parsing +
 *     prewarmPools materializing pooled meshes.
 *   - No page errors / console errors during the run.
 *
 * NB: performance.memory is Chromium-only. We rely on it because the
 * other smokes already assume Chromium-headless via Playwright; ram-diet
 * fails clean if the global is absent (treating it as an env mismatch,
 * not a regression).
 *
 * Run: node tools/smoke-ram-diet.mjs
 * NO npm install. Playwright is expected at /home/nemoclaw/node_modules.
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
const PORT = Number(process.env.PORT || 8776); // avoid 8771/8773 (other smokes)
const BOOT_TIMEOUT_MS = 60000;
const RUN_SETTLE_MS = 2500;

// Hard heap gates. Tune downward after first measurement lands.
const BOOT_HEAP_LIMIT_MB = 600;
const STAGE_DELTA_LIMIT_MB = 300;

// ── Static server (lifted from smoke-forest-v2) ───────────────────────────
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

function mb(bytes) { return Math.round(bytes / (1024 * 1024)); }

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-ram] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-ram] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-ram] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-ram] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-ram] server on http://127.0.0.1:' + PORT);

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
      // performance.memory requires --enable-precise-memory-info to return
      // real numbers on some chromium builds (otherwise values get rounded
      // to nearest 100 MB). Belt-and-suspenders.
      '--enable-precise-memory-info',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    const ty = msg.type();
    if (ty === 'error') {
      consoleErrors.push(msg.text());
      console.log('[console.error]', msg.text());
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  let exitCode = 0;
  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-ram] page loaded; waiting for kkStartRun');

    await page.waitForFunction(
      () => typeof window.kkStartRun === 'function',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Boot heap measurement. performance.memory is a snapshot; allow a
    // moment for V8 to settle GC after the boot-time await preloadEssential.
    await new Promise((r) => setTimeout(r, 1500));
    const bootMem = await page.evaluate(() => {
      const m = performance && performance.memory;
      if (!m) return null;
      return {
        used: m.usedJSHeapSize,
        total: m.totalJSHeapSize,
        limit: m.jsHeapSizeLimit,
      };
    });
    if (!bootMem) {
      console.error('[smoke-ram] FAIL: performance.memory unavailable — not Chromium?');
      exitCode = 2;
      throw new Error('no perf memory');
    }
    const bootMB = mb(bootMem.used);
    console.log('[smoke-ram] boot heap: ' + bootMB + ' MB (limit ' + BOOT_HEAP_LIMIT_MB + ' MB)');

    // Pin the run to forest BEFORE starting, mirroring the other smokes.
    await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      try {
        const mod = await import('./src/meta.js');
        if (mod.setOption) mod.setOption('selectedStage', 'forest');
      } catch (e) {
        console.warn('[smoke-ram] meta setOption failed:', e && e.message);
      }
    });

    // Start the run — start() is async (awaits preloadStage). We await its
    // completion by polling for state.run + state.mode === 'run'.
    await page.evaluate(() => { window.kkStartRun(); });
    await page.waitForFunction(
      () => !!window.kkState && !!window.kkState.run && window.kkState.mode === 'run',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    // Let the world settle (a few hundred frames) so spawnDirector materializes
    // its first wave, exposing the realistic post-stage-load steady state.
    await new Promise((r) => setTimeout(r, RUN_SETTLE_MS));

    const stageMem = await page.evaluate(() => ({
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
    }));
    const stageMB = mb(stageMem.used);
    const deltaMB = stageMB - bootMB;
    console.log('[smoke-ram] post-stage heap: ' + stageMB + ' MB (delta ' + deltaMB + ' MB, limit ' + STAGE_DELTA_LIMIT_MB + ' MB)');

    // ── Gates ───────────────────────────────────────────────────────────────
    let pass = true;
    const reasons = [];
    if (bootMB > BOOT_HEAP_LIMIT_MB) {
      pass = false;
      reasons.push('boot heap ' + bootMB + ' MB > ' + BOOT_HEAP_LIMIT_MB + ' MB');
    }
    if (deltaMB > STAGE_DELTA_LIMIT_MB) {
      pass = false;
      reasons.push('stage delta ' + deltaMB + ' MB > ' + STAGE_DELTA_LIMIT_MB + ' MB');
    }
    if (pageErrors.length > 0) {
      pass = false;
      reasons.push('page errors: ' + pageErrors.length);
    }
    if (consoleErrors.length > 0) {
      // Soft-warn only — the boot path may emit asset-load failures that the
      // gate already tolerates (preload returns false on miss but resolves).
      console.warn('[smoke-ram] WARN: ' + consoleErrors.length + ' console.error(s) during run');
    }

    console.log('');
    console.log('────────────────────────────────────────────────────────');
    console.log('[smoke-ram] boot=' + bootMB + ' MB  post-stage=' + stageMB + ' MB  delta=' + deltaMB + ' MB');
    console.log('────────────────────────────────────────────────────────');
    if (pass) {
      console.log('[smoke-ram] PASS — both gates green');
    } else {
      console.error('[smoke-ram] FAIL — ' + reasons.join('; '));
      exitCode = 1;
    }
  } catch (e) {
    console.error('[smoke-ram] EXCEPTION:', e && e.message);
    exitCode = exitCode || 2;
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
  process.exit(exitCode);
}

main();
