#!/usr/bin/env node
/** Comparative CPU benchmark for Monster Smash camera modes. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveChromiumArgs } from './webgpu/chromiumProfiles.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.KK_CAMERA_BENCH_ROOT
  ? path.resolve(process.env.KK_CAMERA_BENCH_ROOT)
  : SCRIPT_ROOT;
const PORT = Number(process.env.PORT || 8896);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BACKEND = /^(?:webgpu|webgl)$/.test(process.env.BACKEND || '') ? process.env.BACKEND : 'webgl';
const QA_SCENE = /^[a-z0-9-]+$/.test(process.env.SCENE || '') ? process.env.SCENE : 'monster-smash';
const FRAMES = Math.max(1, Number(process.env.FRAMES || 180));
const WIDTH = Math.max(640, Number(process.env.WIDTH || 1280));
const HEIGHT = Math.max(360, Number(process.env.HEIGHT || 720));
const DPR = Math.max(1, Number(process.env.DPR || 1));
const CAMERA_MODES = String(process.env.MODES || 'isometric,chase,driver_fpv')
  .split(',')
  .filter((mode) => ['isometric', 'chase', 'driver_fpv'].includes(mode));
const MONSTER_ASSETS = process.env.MONSTER_ASSETS === 'full' ? 'full' : '';
const CAPTURE_DIR = process.env.CAPTURE_DIR ? path.resolve(process.env.CAPTURE_DIR) : '';
const RAW_RENDER = process.env.RAW_RENDER === '1';
const HIDE_HUD = process.env.HIDE_HUD === '1';
const RENDERER_DIAGNOSTICS = process.env.RENDERER_DIAGNOSTICS === '1';
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
    args: resolveChromiumArgs(BACKEND),
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DPR,
  });
  const page = await context.newPage();
  const browserDiagnostics = { errors: [], consoleErrors: [], warnings: [] };
  page.on('pageerror', (error) => browserDiagnostics.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserDiagnostics.consoleErrors.push(message.text());
    if (message.type() === 'warning') browserDiagnostics.warnings.push(message.text());
  });
  await page.route(/fonts\.(?:googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_racing_camera_mode_v1', 'chase');
  });
  const monsterAssetsQuery = MONSTER_ASSETS ? `&monsterAssets=${MONSTER_ASSETS}` : '';
  const diagnosticsQuery = RENDERER_DIAGNOSTICS ? '&rendererDiagnostics=1' : '';
  await page.goto(`${ORIGIN}/index.html?qa=${QA_SCENE}&renderer=${BACKEND}${monsterAssetsQuery}${diagnosticsQuery}`, {
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
  if (RAW_RENDER) {
    await page.evaluate(() => {
      const service = window.__kkRendererService;
      service.pipeline.render = (scene, camera) => service.renderer.render(scene, camera);
    });
  }
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
  if (CAPTURE_DIR) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const mode of CAMERA_MODES) {
    await page.evaluate((nextMode) => {
      if (window.__kkRacing.snapshot().camera.mode !== nextMode) {
        window.__kkRacing.setCameraMode(nextMode);
      }
    }, mode);
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
          const root = window.kkState?.racing?.root || null;
          const groups = new Map();
          root?.traverse?.((node) => {
            if (!node.isMesh || !node.geometry || !node.visible) return;
            let branch = node;
            while (branch.parent && branch.parent !== root) branch = branch.parent;
            const key = branch.name || branch.type || '(unnamed)';
            const elements = node.geometry.index?.count
              || node.geometry.attributes?.position?.count
              || 0;
            const instances = node.isInstancedMesh ? node.count : 1;
            const previous = groups.get(key) || { meshes: 0, triangles: 0 };
            previous.meshes += 1;
            previous.triangles += Math.floor(elements / 3) * instances;
            groups.set(key, previous);
          });
          resolve({
            durations: [...probe.durations],
            frameDeltas,
            raycasts: probe.raycasts,
            collision: window.__kkRacing.snapshot().camera.collision || null,
            render: window.__kkRendererService?.getDiagnostics?.() || null,
            recovery: window.__kkRendererService?.recovery?.getState?.() || null,
            sceneState: (() => {
              const session = window.kkState?.racing;
              const kart = session?.cars?.[0]?.physics;
              const camera = window.__kkRendererService?.pipeline?.getCamera?.();
              const badTransforms = [];
              let maxInstanceElement = 0;
              session?.root?.traverse?.((node) => {
                const world = node.matrixWorld?.elements;
                if (world && world.some((value) => !Number.isFinite(value))) {
                  badTransforms.push(`${node.name || node.type}:world`);
                }
                const values = node.isInstancedMesh ? node.instanceMatrix?.array : null;
                if (!values) return;
                for (let index = 0; index < values.length; index += 1) {
                  const value = values[index];
                  if (!Number.isFinite(value)) {
                    badTransforms.push(`${node.name || node.type}:instance:${Math.floor(index / 16)}`);
                    break;
                  }
                  maxInstanceElement = Math.max(maxInstanceElement, Math.abs(value));
                }
              });
              return {
                rootVisible: session?.root?.visible ?? null,
                kart: kart ? { x: kart.x, y: kart.y, z: kart.z, speed: kart.speed, grounded: kart.grounded } : null,
                camera: camera ? {
                  x: camera.position.x, y: camera.position.y, z: camera.position.z,
                  near: camera.near, far: camera.far,
                } : null,
                trafficAttached: !!session?.monsterArena?.trafficModelsAttached,
                storyDressingAttached: !!session?.monsterArenaView?.storyDressingAttached,
                badTransforms,
                maxInstanceElement,
                callout: (() => {
                  const element = document.querySelector('.kkr-callout');
                  if (!element) return null;
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  return {
                    className: element.className,
                    text: element.textContent,
                    opacity: style.opacity,
                    filter: style.filter,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  };
                })(),
              };
            })(),
            breakdown: [...groups.entries()]
              .map(([name, value]) => ({ name, ...value }))
              .sort((a, b) => b.triangles - a.triangles)
              .slice(0, 20),
          });
        } else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }), FRAMES);
    const screenshot = CAPTURE_DIR
      ? path.join(CAPTURE_DIR, `${BACKEND}-${MONSTER_ASSETS || 'runtime'}-${mode}.png`)
      : '';
    if (HIDE_HUD) {
      await page.evaluate(() => {
        const hud = document.querySelector('.kkr-hud');
        if (hud) hud.style.display = 'none';
      });
    }
    if (screenshot) await page.screenshot({ path: screenshot });
    rows.push({
      mode,
      cameraUpdate: summarize(measured.durations),
      frame: summarize(measured.frameDeltas),
      raycasts: measured.raycasts,
      raycastsPerFrame: Number((measured.raycasts / FRAMES).toFixed(3)),
      collision: measured.collision,
      drawCalls: measured.render?.drawCalls ?? null,
      triangles: measured.render?.triangles ?? null,
      rendererFps: measured.render?.fps ?? null,
      resolution: measured.render?.resolution ?? null,
      dynamicResolutionScale: measured.render?.dynamicResolutionScale ?? null,
      gpuMemoryBytes: measured.render?.gpuMemoryBytes ?? null,
      renderTargets: measured.render?.renderTargets ?? null,
      recovery: measured.recovery,
      sceneState: measured.sceneState,
      screenshot,
      breakdown: measured.breakdown,
    });
  }
  console.log(JSON.stringify({
    backend: actualBackend,
    scene: QA_SCENE,
    assetTier: MONSTER_ASSETS || 'performance',
    rawRender: RAW_RENDER,
    viewport: [WIDTH, HEIGHT],
    dpr: DPR,
    frames: FRAMES,
    startup,
    browserDiagnostics,
    rows,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
