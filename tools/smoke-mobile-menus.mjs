#!/usr/bin/env node
/**
 * MOBILE MENUS smoke — guards the portrait-phone fix.
 *
 * #ui-root lives inside #kk-stage, an aspect-capped box (overflow:hidden +
 * a load-bearing transform). #ui-root-mounted full-screen menus were clipped
 * to it — the bug the user hit ("game over menu doesn't work on mobile").
 *
 * NOTE: as of the coarse-fill fix, computeStage() fills the screen on touch,
 * so the stage no longer collapses to a strip on phones (the "stage not
 * letterboxed here" note below now fires). The menus still mount on <body> as
 * the durable guarantee regardless of stage size — that's what this asserts.
 *
 * Fix: the pause (options) panel + the game-over surfaces (.kk-death and the
 * endRunSummary panel) mount on document.body instead, escaping the stage.
 *
 * This smoke proves, at 390x844 portrait AND 844x390 short-landscape:
 *   1. The stage really IS a letterbox strip (sanity — the trap exists).
 *   2. The pause panel covers ~the full viewport (NOT the strip).
 *   3. The death screen covers ~the full viewport (NOT the strip).
 *
 * No npm install. Run: node tools/smoke-mobile-menus.mjs   Port: 8799.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8799);
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
  // Canonical containment check (resolve, then path.relative) — not a raw
  // prefix match, which a sibling like /../x can defeat.
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
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-mobile-menus] FAIL: playwright missing'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-mobile-menus] FAIL: chromium missing'); process.exit(2); }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-mobile-menus] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const failures = [];

  // Run the same assertions at portrait + short-landscape.
  for (const vp of [{ w: 390, h: 844, tag: 'portrait' }, { w: 844, h: 390, tag: 'landscape' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.w < vp.h, hasTouch: true });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    try {
      await page.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1&touch=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
      await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });

      // Pre-fill the stage WAS a letterbox strip on touch (the trap a
      // fixed,inset:0 child fell into if mounted in #ui-root). Post coarse-fill
      // it fills the screen — so this just logs; the real guarantee is the
      // body-mounted menus covering the viewport, asserted below.
      const stage = await page.evaluate(() => {
        const s = document.getElementById('kk-stage').getBoundingClientRect();
        return { h: Math.round(s.height), vh: window.innerHeight };
      });
      const stageIsStrip = stage.h < stage.vh * 0.92;
      if (!stageIsStrip) console.log(`  [${vp.tag}] note: stage not letterboxed here (h=${stage.h}/${stage.vh}) — escape still required`);

      // Pause / options panel.
      const pause = await page.evaluate(async () => {
        const u = await import('./src/ui.js');
        u.showOptions();
        const p = document.querySelector('[aria-label="Options"]');
        if (!p) return { found: false };
        const b = p.getBoundingClientRect();
        return { found: true, h: Math.round(b.height), top: Math.round(b.top), vh: window.innerHeight };
      });
      if (!pause.found) failures.push(`[${vp.tag}] pause: options panel not found`);
      else if (pause.h < pause.vh * 0.9 || pause.top > pause.vh * 0.08)
        failures.push(`[${vp.tag}] pause: panel not full-viewport (h=${pause.h}/${pause.vh}, top=${pause.top}) — still clipped to stage strip`);

      // Game-over / death screen.
      const death = await page.evaluate(async () => {
        const u = await import('./src/ui.js');
        const er = await import('./src/endRunSummary.js');
        try { er.loadEndRunSummary(window.kkState); } catch (_) {}
        u.showDeathScreen();
        try { er.showSummary('defeat'); } catch (_) {}
        const d = document.querySelector('.kk-death');
        if (!d) return { found: false };
        const b = d.getBoundingClientRect();
        return { found: true, h: Math.round(b.height), top: Math.round(b.top), vh: window.innerHeight };
      });
      if (!death.found) failures.push(`[${vp.tag}] death: .kk-death not found`);
      else if (death.h < death.vh * 0.9 || death.top > death.vh * 0.08)
        failures.push(`[${vp.tag}] death: screen not full-viewport (h=${death.h}/${death.vh}, top=${death.top}) — still clipped to stage strip`);

      if (pageErrors.length) failures.push(`[${vp.tag}] page errors: ` + pageErrors.join(' | '));
      console.log(`  [${vp.tag}] stage.h=${stage.h}/${stage.vh}  pause.h=${pause.h}  death.h=${death.h}`);
    } catch (e) {
      failures.push(`[${vp.tag}] exception: ` + (e && e.message ? e.message : String(e)));
    } finally {
      await ctx.close();
    }
  }

  await browser.close();
  server.close();

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-mobile-menus] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-mobile-menus] PASS — pause + game-over cover the full viewport on portrait & landscape (escape the letterboxed stage)');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-mobile-menus] FATAL', e); process.exit(2); });
