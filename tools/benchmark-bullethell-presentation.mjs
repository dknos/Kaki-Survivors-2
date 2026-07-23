#!/usr/bin/env node
/**
 * Dense Bullet Hell presentation benchmark for both production renderers.
 *
 * This intentionally fills the complete 1,024-bullet instance pool, then
 * measures real animation-loop progress. It guards the failure where gameplay
 * continues but an oversized hero render starves canvas presentation.
 *
 *   node tools/benchmark-bullethell-presentation.mjs
 *   BACKENDS=webgl FRAMES=60 node tools/benchmark-bullethell-presentation.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resolveChromiumArgs } from './webgpu/chromiumProfiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8897);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const FRAMES = Math.max(10, Number(process.env.FRAMES || 60));
const WIDTH = Math.max(640, Number(process.env.WIDTH || 1280));
const HEIGHT = Math.max(360, Number(process.env.HEIGHT || 720));
const DPR = Math.max(1, Number(process.env.DPR || 1));
const BACKENDS = String(process.env.BACKENDS || 'webgl,webgpu')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value === 'webgl' || value === 'webgpu');
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
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  const averageMs = sum / Math.max(1, values.length);
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
  return {
    samples: values.length,
    averageMs: Number(averageMs.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    fps: Number((1000 / Math.max(0.001, averageMs)).toFixed(2)),
  };
}

function createServer() {
  return http.createServer((request, response) => {
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
}

async function runCase(chromium, backend) {
  console.error(`[bullethell-benchmark] ${backend}: launching`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM,
    args: resolveChromiumArgs(backend),
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DPR,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('crash', () => errors.push('page crashed'));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route(/fonts\.(?:googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    window.__kkPresentationLosses = [];
    document.addEventListener('webglcontextlost', (event) => {
      window.__kkPresentationLosses.push(`webgl: ${event.statusMessage || 'context lost'}`);
    }, true);
  });

  try {
    await page.goto(`${ORIGIN}/index.html?qa=bullet-hell&renderer=${backend}`, {
      waitUntil: 'load',
      timeout: 120_000,
    });
    await page.waitForFunction(
      () => window.__kkQa?.status === 'ready' && window.__kkBh?.active,
      null,
      { timeout: 120_000 },
    );
    console.error(`[bullethell-benchmark] ${backend}: scene ready`);
    const prepared = await page.evaluate(async () => {
      const state = window.kkState;
      state.hero.hp = 1e9;
      state.hero.hpMax = 1e9;
      if (state.run) state.run.invulnerable = true;

      const bullets = await import('./src/bullethell/bullets.js');
      const { ARENA_CX, ARENA_CZ } = await import('./src/bullethell/bhState.js');
      bullets.clearAllBullets();
      for (let index = 0; index < 1024; index++) {
        const angle = (index / 1024) * Math.PI * 2;
        const radius = 7 + (index % 24) * 0.8;
        bullets.spawnBullet(
          ARENA_CX + Math.cos(angle) * radius,
          ARENA_CZ + Math.sin(angle) * radius,
          0,
          0,
          index % 4 === 0 ? 'rain' : index % 3 === 0 ? 'spiral' : 'ring',
          { ttl: 60 },
        );
      }

      const renderer = window.__kkRendererService?.renderer;
      const device = renderer?.backend?.device;
      if (device?.lost?.then) {
        device.lost.then((info) => window.__kkPresentationLosses.push(
          `webgpu: ${info?.reason || 'device lost'} ${info?.message || ''}`.trim(),
        ));
      }

      let heroTriangles = 0;
      state.hero.mesh?.traverse?.((node) => {
        if (!node.isMesh || !node.geometry) return;
        const elements = node.geometry.index?.count
          || node.geometry.attributes?.position?.count
          || 0;
        heroTriangles += Math.floor(elements / 3) * (node.isInstancedMesh ? node.count : 1);
      });
      return {
        actualBackend: window.__kkRendererService?.getDiagnostics?.()?.backend || null,
        heroTriangles,
        bullets: bullets.liveBulletCount(),
      };
    });
    console.error(`[bullethell-benchmark] ${backend}: ${prepared.bullets} bullets, ${prepared.heroTriangles} hero triangles`);

    await page.evaluate(() => new Promise((resolve) => {
      let remaining = 10;
      const step = () => { if (--remaining <= 0) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }));
    console.error(`[bullethell-benchmark] ${backend}: warmup complete, sampling ${FRAMES} frames`);
    const measured = await page.evaluate((frameCount) => new Promise((resolve) => {
      const started = performance.now();
      const initialLoop = window.__kkMainLoop?.snapshot?.().frameCount || 0;
      const initialGameTime = window.kkState?.time?.game || 0;
      const intervals = [];
      let previous = started;
      const step = (now) => {
        intervals.push(now - previous);
        previous = now;
        if (intervals.length < frameCount) return requestAnimationFrame(step);
        const diagnostics = window.__kkRendererService?.getDiagnostics?.() || null;
        resolve({
          intervals,
          elapsedMs: now - started,
          mainLoopFrames: (window.__kkMainLoop?.snapshot?.().frameCount || 0) - initialLoop,
          gameTimeDelta: (window.kkState?.time?.game || 0) - initialGameTime,
          diagnostics,
          losses: [...(window.__kkPresentationLosses || [])],
        });
      };
      requestAnimationFrame(step);
    }), FRAMES);

    const row = {
      requestedBackend: backend,
      actualBackend: prepared.actualBackend,
      viewport: [WIDTH, HEIGHT],
      dpr: DPR,
      stressBullets: prepared.bullets,
      heroTriangles: prepared.heroTriangles,
      frame: summarize(measured.intervals),
      elapsedMs: Number(measured.elapsedMs.toFixed(2)),
      mainLoopFrames: measured.mainLoopFrames,
      gameTimeDelta: Number(measured.gameTimeDelta.toFixed(3)),
      render: measured.diagnostics,
      losses: measured.losses,
      errors,
    };
    console.error(`[bullethell-benchmark] ${backend}: ${row.frame.fps} fps, ${row.mainLoopFrames} loop frames`);
    if (row.actualBackend !== backend) throw new Error(`${backend} initialized as ${row.actualBackend}`);
    if (row.stressBullets !== 1024) throw new Error(`${backend} rendered ${row.stressBullets}/1024 bullets`);
    if (row.heroTriangles < 1 || row.heroTriangles > 50_000) {
      throw new Error(`${backend} hero geometry budget failed: ${row.heroTriangles} triangles`);
    }
    if (row.mainLoopFrames < FRAMES - 1 || row.gameTimeDelta <= 0) {
      throw new Error(`${backend} presentation loop did not advance: ${JSON.stringify(row)}`);
    }
    if (row.losses.length || row.errors.length) {
      throw new Error(`${backend} emitted renderer errors: ${JSON.stringify({ losses: row.losses, errors: row.errors })}`);
    }
    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => window.kkState?.mode === 'menu', null, { timeout: 30_000 });
    row.exit = await page.evaluate(() => ({
      mode: window.kkState?.mode || null,
      dynamicResolutionScale: window.__kkRendererService?.getDiagnostics?.().dynamicResolutionScale ?? null,
      environmentVisible: window.kkState?.envGroup?.visible ?? null,
    }));
    if (Math.abs(Number(row.exit.dynamicResolutionScale) - 1) > 0.001
        || row.exit.environmentVisible === false) {
      throw new Error(`${backend} did not restore presentation state: ${JSON.stringify(row.exit)}`);
    }
    return row;
  } finally {
    await context.close();
    await browser.close();
  }
}

if (!BACKENDS.length) throw new Error('BACKENDS must include webgl, webgpu, or both');
if (!fs.existsSync(PLAYWRIGHT) || !fs.existsSync(CHROMIUM)) {
  throw new Error('The shared Playwright/Chromium installation is unavailable');
}

const server = createServer();
let results = [];
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  const { chromium } = require(PLAYWRIGHT);
  for (const backend of BACKENDS) results.push(await runCase(chromium, backend));
  console.log(JSON.stringify({ frames: FRAMES, results }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
