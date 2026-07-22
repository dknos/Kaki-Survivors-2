#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SOFTWARE_WEBGL_ARGS, SOFTWARE_WEBGPU_ARGS } from './webgpu/chromiumProfiles.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.resolve(ROOT, process.argv[2] || 'docs/enemy-animation/evidence/showcase');
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
});

function server() {
  const instance = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname === '/' ? '/enemy-animation-showcase.html' : url.pathname);
    const file = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => resolve({
      instance,
      origin: `http://127.0.0.1:${instance.address().port}/`,
    }));
  });
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pixelDifference(leftBuffer, rightBuffer) {
  const { PNG } = require('pngjs');
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  if (left.width !== right.width || left.height !== right.height) throw new Error('frame dimensions differ');
  let changed = 0;
  let magnitude = 0;
  const pixels = left.width * left.height;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta = Math.abs(left.data[offset] - right.data[offset])
      + Math.abs(left.data[offset + 1] - right.data[offset + 1])
      + Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    if (delta > 12) changed++;
    magnitude += delta;
  }
  return {
    changedPixelRatio: changed / pixels,
    meanRgbDelta: magnitude / (pixels * 3),
  };
}

async function captureBackend(browserType, origin, backend) {
  const browser = await browserType.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: backend === 'webgpu' ? SOFTWARE_WEBGPU_ARGS : SOFTWARE_WEBGL_ARGS,
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
  try {
    await page.goto(`${origin}enemy-animation-showcase.html?renderer=${backend}&scenario=overview`, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__kkEnemyAnimationQA?.status),
      null,
      { timeout: 120_000 },
    );
    const boot = await page.evaluate(() => ({
      status: window.__kkEnemyAnimationQA.status,
      backend: window.__kkEnemyAnimationQA.backend,
      errors: window.__kkEnemyAnimationQA.errors,
    }));
    if (boot.status !== 'ready' || boot.backend !== backend) {
      throw new Error(`${backend} showcase boot failed: ${JSON.stringify(boot)}`);
    }
    await page.evaluate(() => {
      window.__kkEnemyAnimationQA.pause();
      window.__kkEnemyAnimationQA.reset('overview', 'both');
    });
    const frameDeltas = [0, 0.06, 0.06, 0.06, 0.06];
    const frames = [];
    let previous = null;
    for (let index = 0; index < frameDeltas.length; index++) {
      const probe = await page.evaluate((dt) => window.__kkEnemyAnimationQA.step(dt), frameDeltas[index]);
      await page.waitForTimeout(60);
      const png = await page.screenshot({ type: 'png' });
      const name = `${backend}-overview-${String(index).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(OUTPUT, name), png);
      const difference = previous ? pixelDifference(previous, png) : null;
      frames.push({ name, sha256: digest(png), bytes: png.length, probe, difference });
      previous = png;
    }
    if (!frames.slice(1).every((entry) => entry.difference.changedPixelRatio > 0.0005)) {
      throw new Error(`${backend}: adjacent showcase frames do not visibly change`);
    }
    if (frames.at(-1).probe.deathAlive !== 0) {
      throw new Error(`${backend}: death one-shots did not release by frame sequence end`);
    }

    const before = await page.screenshot({ type: 'png', clip: { x: 90, y: 55, width: 190, height: 1090 } });
    const after = await page.screenshot({ type: 'png', clip: { x: 280, y: 55, width: 1550, height: 1090 } });
    fs.writeFileSync(path.join(OUTPUT, `${backend}-before-v1.png`), before);
    fs.writeFileSync(path.join(OUTPUT, `${backend}-after-v2.png`), after);

    const denseProbe = await page.evaluate(() => {
      window.__kkEnemyAnimationQA.reset('dense', 'v2');
      return window.__kkEnemyAnimationQA.step(0.08);
    });
    await page.waitForTimeout(80);
    const dense = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUTPUT, `${backend}-dense-350.png`), dense);
    if (denseProbe.activeSprites !== 350 || denseProbe.activePages !== 1) {
      throw new Error(`${backend}: dense probe mismatch ${JSON.stringify(denseProbe)}`);
    }
    if (errors.length || failedRequests.length) {
      throw new Error(`${backend}: browser errors=${errors.join('; ')} requests=${failedRequests.join('; ')}`);
    }
    return {
      backend,
      frames,
      before: { name: `${backend}-before-v1.png`, sha256: digest(before), bytes: before.length },
      after: { name: `${backend}-after-v2.png`, sha256: digest(after), bytes: after.length },
      dense: { name: `${backend}-dense-350.png`, sha256: digest(dense), bytes: dense.length, probe: denseProbe },
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  if (!fs.existsSync(PLAYWRIGHT) || !fs.existsSync(CHROMIUM)) throw new Error('Playwright/Chromium is unavailable');
  fs.mkdirSync(OUTPUT, { recursive: true });
  const hosted = await server();
  const { chromium } = require(PLAYWRIGHT);
  const report = {
    generatedAt: new Date().toISOString(),
    entrypoint: 'enemy-animation-showcase.html',
    viewport: { width: 1920, height: 1200 },
    cases: [],
  };
  try {
    for (const backend of ['webgl', 'webgpu']) {
      report.cases.push(await captureBackend(chromium, hosted.origin, backend));
    }
    fs.writeFileSync(path.join(OUTPUT, 'SHOWCASE_EVIDENCE.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS: ${report.cases.length} backends, 10 animation frames, 2 dense 350-enemy captures`);
  } finally {
    await new Promise((resolve) => hosted.instance.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
