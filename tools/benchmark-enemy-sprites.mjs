#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SOFTWARE_WEBGL_ARGS, SOFTWARE_WEBGPU_ARGS } from './webgpu/chromiumProfiles.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.resolve(ROOT, process.argv[2] || 'docs/enemy-animation/evidence/BENCHMARK_350.json');
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const PAIRED_TRIALS = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname === '/' ? '/enemy-animation-showcase.html' : url.pathname);
    const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : (ext === '.js' || ext === '.mjs') ? 'text/javascript; charset=utf-8'
        : ext === '.json' ? 'application/json; charset=utf-8'
          : ext === '.png' ? 'image/png' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      origin: `http://127.0.0.1:${server.address().port}/`,
    }));
  });
}

async function benchmarkTrial(chromium, origin, backend, trial) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: backend === 'webgpu' ? SOFTWARE_WEBGPU_ARGS : SOFTWARE_WEBGL_ARGS,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto(`${origin}enemy-animation-showcase.html?renderer=${backend}&scenario=dense&atlas=v1`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__kkEnemyAnimationQA?.status),
      null,
      { timeout: 120_000 },
    );
    const status = await page.evaluate(() => ({
      status: window.__kkEnemyAnimationQA.status,
      backend: window.__kkEnemyAnimationQA.backend,
      errors: window.__kkEnemyAnimationQA.errors,
    }));
    if (status.status !== 'ready' || status.backend !== backend) throw new Error(JSON.stringify(status));
    const order = trial % 2 === 0 ? ['v1', 'v2'] : ['v2', 'v1'];
    const results = {};
    for (const atlasMode of order) {
      results[atlasMode] = await page.evaluate(
        (mode) => window.__kkEnemyAnimationQA.benchmark({
          atlasMode: mode,
          iterations: 5000,
          frames: 120,
        }),
        atlasMode,
      );
    }
    if (errors.length) throw new Error(`${backend}: ${errors.join('; ')}`);
    return {
      trial,
      order,
      results,
      fpsChangePercent: (
        (results.v2.frameMs.sustainedFps / results.v1.frameMs.sustainedFps) - 1
      ) * 100,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function benchmarkBackend(chromium, origin, backend) {
  // Software Chromium quantizes many samples into 50/66/83 ms buckets.
  // A single always-v1-then-v2 run can therefore mistake scheduler drift for
  // an atlas regression. Use fresh-browser paired trials with alternating
  // order and gate on their median paired delta.
  const trials = [];
  for (let trial = 0; trial < PAIRED_TRIALS; trial++) {
    console.error(`[enemy-sprite-benchmark] ${backend} paired trial ${trial + 1}/${PAIRED_TRIALS}`);
    trials.push(await benchmarkTrial(chromium, origin, backend, trial));
  }
  const fpsChangePercent = median(trials.map((trial) => trial.fpsChangePercent));
  const representative = trials.reduce((best, trial) => (
    Math.abs(trial.fpsChangePercent - fpsChangePercent)
      < Math.abs(best.fpsChangePercent - fpsChangePercent)
      ? trial
      : best
  ));
  const before = representative.results.v1;
  const after = representative.results.v2;
  const cpuAnimationChangePercent = ((after.cpuAnimationMs.mean / before.cpuAnimationMs.mean) - 1) * 100;
  return {
    backend,
    before,
    after,
    pairedTrials: trials.map((trial) => ({
      trial: trial.trial,
      order: trial.order,
      v1Fps: trial.results.v1.frameMs.sustainedFps,
      v2Fps: trial.results.v2.frameMs.sustainedFps,
      fpsChangePercent: trial.fpsChangePercent,
    })),
    comparison: {
      fpsChangePercent,
      cpuAnimationChangePercent,
      method: `median of ${PAIRED_TRIALS} fresh-browser paired trials with alternating order`,
      withinFivePercentFpsBudget: fpsChangePercent >= -5,
    },
  };
}

async function main() {
  if (!fs.existsSync(PLAYWRIGHT) || !fs.existsSync(CHROMIUM)) throw new Error('Playwright/Chromium is unavailable');
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const hosted = await startServer();
  const { chromium } = require(PLAYWRIGHT);
  const report = {
    generatedAt: new Date().toISOString(),
    scenario: 'isolated deterministic 350-enemy atlas comparison',
    environment: 'headless Chromium software WebGL2/WebGPU; paired median FPS is comparative, not physical-GPU throughput',
    cases: [],
  };
  try {
    for (const backend of ['webgl', 'webgpu']) {
      report.cases.push(await benchmarkBackend(chromium, hosted.origin, backend));
    }
    report.pass = report.cases.every((entry) => entry.comparison.withinFivePercentFpsBudget
      && entry.after.activeSprites === 350
      && entry.after.enemyAtlasDrawCalls <= 2
      && entry.after.textureBytes <= 32 * 1024 * 1024);
    fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    if (!report.pass) throw new Error(`350-enemy budget failed; inspect ${path.relative(ROOT, OUTPUT)}`);
    console.log('PASS: 350 enemies on WebGL2 + WebGPU; v2 stayed within the 5% sustained-FPS budget');
    for (const entry of report.cases) {
      console.log(`${entry.backend}: ${entry.before.frameMs.sustainedFps.toFixed(2)} -> ${entry.after.frameMs.sustainedFps.toFixed(2)} FPS (${entry.comparison.fpsChangePercent.toFixed(2)}%)`);
    }
  } finally {
    await new Promise((resolve) => hosted.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
