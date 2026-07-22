#!/usr/bin/env node
/**
 * Iter 37 — MENU HERO SPLASH smoke.
 *
 * Verifies the main menu shows the real 3D hero model instead of the static
 * SVG placeholder, and that the SVG remains a graceful fallback when the
 * hero GLTF isn't cached.
 *
 * Assertions:
 *   1. Real model: after the hero GLTF preloads, rebuilding the menu mounts a
 *      <canvas> inside .kkv2-hero (the splash renderer), the canvas gets a
 *      non-zero backing store (RO fired -> setSize ran), and the SVG
 *      silhouette is NOT present.
 *   2. Graceful fallback: with GLTF_CACHE.hero temporarily cleared,
 *      createHeroSplash() returns null (caller would keep the SVG).
 *   3. No page errors across the flow.
 *
 * No npm install — Playwright + Chromium at the shared cache paths.
 *
 * Run: node tools/smoke-menu-hero.mjs
 * Port: 8783.
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
const PORT = Number(process.env.PORT || 8783);
const BOOT_TIMEOUT_MS = 60000;
const HERO_TIMEOUT_MS = 45000;

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
    console.error('[smoke-menu-hero] FAIL: playwright not at ' + PLAY_PATH + ' (smoke NEVER npm installs)');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-menu-hero] FAIL: chromium not at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-menu-hero] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-menu-hero] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[pageerror]', e.message); });

  const failures = [];
  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-menu-hero] boot OK; waiting for hero GLTF preload');

    // Wait for the (~15MB) hero donor to land in GLTF_CACHE.
    await page.waitForFunction(async () => {
      const a = await import('./src/assets.js');
      return !!a.GLTF_CACHE.hero;
    }, null, { timeout: HERO_TIMEOUT_MS });
    console.log('[smoke-menu-hero] GLTF_CACHE.hero ready');

    // ── Assertion 1: real model splash ────────────────────────────────
    const real = await page.evaluate(async () => {
      const menu = await import('./src/menuV2.js');
      // Rebuild the menu now that the hero GLTF is cached, so _buildHeroSilhouette
      // runs the splash path deterministically.
      try { menu.hideMenuV2(); } catch (_) {}
      menu.showMenuV2();
      return new Promise((resolve) => {
        // Give the ResizeObserver a couple frames to fire setSize.
        setTimeout(() => {
          const host = document.querySelector('.kkv2-hero');
          const canvas = host ? host.querySelector('canvas') : null;
          const svg = host ? host.querySelector('svg.kkv2-hero-svg') : null;
          resolve({
            hostFound: !!host,
            canvasFound: !!canvas,
            canvasW: canvas ? canvas.width : 0,
            canvasH: canvas ? canvas.height : 0,
            svgPresent: !!svg,
          });
        }, 400);
      });
    });
    console.log('  real-model:', JSON.stringify(real));
    if (!real.hostFound)   failures.push('real-model: .kkv2-hero host not found');
    if (!real.canvasFound) failures.push('real-model: no <canvas> mounted in .kkv2-hero (splash did not render the hero model)');
    if (real.canvasFound && !(real.canvasW > 0 && real.canvasH > 0)) failures.push(`real-model: canvas backing store is ${real.canvasW}x${real.canvasH} (RO/setSize never ran)`);
    if (real.svgPresent)   failures.push('real-model: SVG silhouette still present alongside the model (should be model OR svg, not both)');

    // ── Assertion 2: graceful fallback (no hero GLTF -> null) ──────────
    const fb = await page.evaluate(async () => {
      const a = await import('./src/assets.js');
      const splash = await import('./src/menuHeroSplash.js');
      const saved = a.GLTF_CACHE.hero;
      const savedKitty = a.GLTF_CACHE.hero_kitty;
      delete a.GLTF_CACHE.hero;
      delete a.GLTF_CACHE.hero_kitty;
      const tmp = document.createElement('div');
      document.body.appendChild(tmp);
      let res;
      try { res = splash.createHeroSplash(tmp, { avatarId: 'kitty' }); }
      finally {
        a.GLTF_CACHE.hero = saved;
        if (savedKitty !== undefined) a.GLTF_CACHE.hero_kitty = savedKitty;
        tmp.remove();
      }
      return { returnedNull: res === null };
    });
    console.log('  fallback:', JSON.stringify(fb));
    if (!fb.returnedNull) failures.push('fallback: createHeroSplash should return null when no hero GLTF is cached (so the caller keeps the SVG), but it did not');

    if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));
  } catch (e) {
    failures.push('exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-menu-hero] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-menu-hero] PASS — main menu renders the real hero model, SVG kept as graceful fallback');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-menu-hero] FATAL', e); process.exit(2); });
