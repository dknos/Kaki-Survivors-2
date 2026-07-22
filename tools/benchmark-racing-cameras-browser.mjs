#!/usr/bin/env node
/** Comparative CPU benchmark for Monster Smash camera modes. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.KK_CAMERA_BENCH_ROOT
  ? path.resolve(process.env.KK_CAMERA_BENCH_ROOT)
  : SCRIPT_ROOT;
const PORT = Number(process.env.PORT || 8896);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BACKEND = /^(?:webgpu|webgl)$/.test(process.env.BACKEND || '') ? process.env.BACKEND : 'webgl';
const QA_SCENE = /^[a-z0-9-]+$/.test(process.env.SCENE || '') ? process.env.SCENE : 'monster-smash';
const FRAMES = Math.max(1, Number(process.env.FRAMES || 180));
const CAMERA_MODES = String(process.env.MODES || 'isometric,chase,driver_fpv')
  .split(',')
  .filter((mode) => ['isometric', 'chase', 'driver_fpv'].includes(mode));
const MONSTER_ASSETS = process.env.MONSTER_ASSETS === 'full' ? 'full' : '';
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const require = createRequire(import.meta.url);

function mime(file) {
  if (/\.m?js$/.test(file)) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(file)) return 'image/jpeg';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function summarize(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    samples: values.length,
    averageMs: Number(average.toFixed(4)),
    p95Ms: Number(percentile(values, 0.95).toFixed(4)),
    maxMs: Number(Math.max(0, ...values).toFixed(4)),
  };
}

const server = http.createServer((request, response) => {
  let relative = decodeURIComponent(request.url.split('?')[0]);
  if (relative === '/') relative = '/index.html';
  const file = path.resolve(ROOT, `.${relative}`);
  const within = path.relative(ROOT, file);
  if (within.startsWith('..') || path.isAbsolute(within)) return response.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end('not found');
    response.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
    response.end(data);
  });
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  const { chromium } = require(PLAYWRIGHT);
  browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM,
    args: BACKEND === 'webgpu'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan']
      : ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.route(/fonts\.(?:googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_racing_camera_mode_v1', 'chase');
  });
  const monsterAssetsQuery = MONSTER_ASSETS ? `&monsterAssets=${MONSTER_ASSETS}` : '';
  await page.goto(`${ORIGIN}/index.html?qa=${QA_SCENE}&renderer=${BACKEND}${monsterAssetsQuery}`, {
    waitUntil: 'load',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__kkQa?.status === 'ready', null, { timeout: 120000 });
  const actualBackend = await page.evaluate(() => window.__kkRendererService?.getDiagnostics?.()?.backend || '');
  if (actualBackend !== BACKEND) {
    throw new Error(`Requested ${BACKEND}, but renderer initialized ${actualBackend || 'an unknown backend'}`);
  }
  const startup = await page.evaluate(() => ({
    qaSetupDurationMs: window.__kkQa?.snapshot?.()?.setupDurationMs ?? null,
    assets: window.__kkRacing?.snapshot?.()?.assets?.ids || [],
    performance: window.__kkRacing?.snapshot?.()?.performance || null,
  }));
  await page.evaluate(() => {
    const manager = window.kkState.racing.cameraManager;
    const originalUpdate = manager.update;
    const originalIntersect = manager.collision.raycaster.intersectObjects;
    const probe = { durations: [], raycasts: 0 };
    manager.update = function measuredCameraUpdate(...args) {
      const started = performance.now();
      try { return originalUpdate.apply(this, args); }
      finally { probe.durations.push(performance.now() - started); }
    };
    manager.collision.raycaster.intersectObjects = function measuredIntersection(...args) {
      probe.raycasts += 1;
      return originalIntersect.apply(this, args);
    };
    window.__cameraBenchmark = probe;
  });

  const rows = [];
  for (const mode of CAMERA_MODES) {
    await page.evaluate((nextMode) => window.__kkRacing.setCameraMode(nextMode), mode);
    await page.waitForFunction((nextMode) => window.__kkRacing.snapshot().camera.mode === nextMode, mode);
    await page.evaluate(() => new Promise((resolve) => {
      let remaining = 20;
      const step = () => { if (--remaining <= 0) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }));
    const measured = await page.evaluate((frameCount) => new Promise((resolve) => {
      const probe = window.__cameraBenchmark;
      probe.durations.length = 0;
      probe.raycasts = 0;
      const frameDeltas = [];
      let previous = performance.now();
      const step = (now) => {
        frameDeltas.push(now - previous);
        previous = now;
        if (frameDeltas.length >= frameCount) {
          resolve({
            durations: [...probe.durations],
            frameDeltas,
            raycasts: probe.raycasts,
            collision: window.__kkRacing.snapshot().camera.collision || null,
            render: window.__kkRendererService?.getDiagnostics?.() || null,
          });
        } else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }), FRAMES);
    rows.push({
      mode,
      cameraUpdate: summarize(measured.durations),
      frame: summarize(measured.frameDeltas),
      raycasts: measured.raycasts,
      raycastsPerFrame: Number((measured.raycasts / FRAMES).toFixed(3)),
      collision: measured.collision,
      drawCalls: measured.render?.drawCalls ?? null,
      triangles: measured.render?.triangles ?? null,
    });
  }
  console.log(JSON.stringify({
    backend: actualBackend,
    scene: QA_SCENE,
    assetTier: MONSTER_ASSETS || 'performance',
    frames: FRAMES,
    startup,
    rows,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
