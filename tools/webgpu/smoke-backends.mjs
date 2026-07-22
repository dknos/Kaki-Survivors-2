#!/usr/bin/env node
/**
 * Browser smoke test for webgpu-smoke.html.
 *
 * The default run uses two separate Chromium launches because the Vulkan
 * SwiftShader flags needed to expose software WebGPU can make WebGL context
 * creation unreliable in the same browser process.
 *
 * Environment overrides:
 *   KK_WEBGPU_SMOKE_PLAYWRIGHT=/path/to/playwright
 *   KK_WEBGPU_SMOKE_CHROMIUM=/path/to/chrome
 *   KK_WEBGPU_SMOKE_ORIGIN=http://127.0.0.1:8080/
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function usage() {
  console.log(`Usage: node tools/webgpu/smoke-backends.mjs [options]

Options:
  --webgl-only       Run only the forced-WebGL 2 case.
  --webgpu-only      Run only the software-WebGPU case.
  --skip-auto        Do not verify automatic backend selection.
  --headed           Show Chromium while testing.
  --port <port>      Static server port; 0 selects a free port (default 0).
  --origin <url>     Use an existing static server instead of starting one.
  --output <dir>     Save per-backend PNGs and report.json under this directory.
  --help             Print this help.
`);
}

function parseArgs(argv) {
  const config = {
    webgl: true,
    webgpu: true,
    auto: true,
    headed: false,
    port: 0,
    origin: process.env.KK_WEBGPU_SMOKE_ORIGIN || null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--webgl-only') {
      config.webgl = true;
      config.webgpu = false;
      config.auto = false;
    } else if (arg === '--webgpu-only') {
      config.webgl = false;
      config.webgpu = true;
      config.auto = false;
    } else if (arg === '--skip-auto') {
      config.auto = false;
    } else if (arg === '--headed') {
      config.headed = true;
    } else if (arg === '--port') {
      config.port = Number(argv[++index]);
      if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw new Error('--port must be an integer from 0 through 65535.');
      }
    } else if (arg === '--origin') {
      config.origin = argv[++index];
      if (!config.origin) throw new Error('--origin requires a URL.');
    } else if (arg === '--output') {
      config.output = argv[++index];
      if (!config.output) throw new Error('--output requires a directory.');
    } else if (arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return config;
}

function resolveBrowserTools() {
  const playwrightPath = process.env.KK_WEBGPU_SMOKE_PLAYWRIGHT
    || (fs.existsSync('/home/nemoclaw/node_modules/playwright')
      ? '/home/nemoclaw/node_modules/playwright'
      : 'playwright');
  if (path.isAbsolute(playwrightPath) && !fs.existsSync(playwrightPath)) {
    throw new Error(`Playwright is unavailable at ${playwrightPath}`);
  }
  const playwright = require(playwrightPath);

  const knownChromium = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const chromiumPath = process.env.KK_WEBGPU_SMOKE_CHROMIUM
    || (fs.existsSync(knownChromium) ? knownChromium : null);
  if (chromiumPath && !fs.existsSync(chromiumPath)) {
    throw new Error(`Chromium is unavailable at ${chromiumPath}`);
  }
  return { chromium: playwright.chromium, chromiumPath };
}

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

async function startServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/webgpu-smoke.html' : requestUrl.pathname);
      const relative = pathname.replace(/^\/+/, '');
      const filePath = path.resolve(ROOT, relative);
      const withinRoot = filePath === ROOT || filePath.startsWith(`${ROOT}${path.sep}`);
      if (!withinRoot || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}/`,
  };
}

function analyzePng(buffer) {
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(buffer);
  let sum = 0;
  let sumSquared = 0;
  let bright = 0;
  const quantizedColors = new Set();
  const pixels = png.width * png.height;

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    sum += luminance;
    sumSquared += luminance * luminance;
    if (luminance >= 70) bright += 1;
    if (quantizedColors.size <= 4096) {
      quantizedColors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
    }
  }

  const meanLuminance = sum / pixels;
  const variance = Math.max(0, sumSquared / pixels - meanLuminance * meanLuminance);
  return {
    width: png.width,
    height: png.height,
    meanLuminance: Number(meanLuminance.toFixed(3)),
    luminanceStdDev: Number(Math.sqrt(variance).toFixed(3)),
    brightPixelRatio: Number((bright / pixels).toFixed(5)),
    quantizedColorCount: quantizedColors.size,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function validateCase(
  browser,
  origin,
  request,
  expectedBackend,
  launchProfile,
  outputDirectory,
) {
  const context = await browser.newContext({
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const browserErrors = [];
  const failedRequests = [];

  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (failed) => {
    failedRequests.push({
      url: failed.url(),
      errorText: failed.failure()?.errorText || 'failed',
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push({ url: response.url(), errorText: `HTTP ${response.status()}` });
    }
  });

  try {
    const url = new URL('webgpu-smoke.html', origin);
    url.searchParams.set('renderer', request);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__kkWebGPUStandardScene?.status),
      null,
      { timeout: 120_000 },
    );
    await page.waitForFunction(
      () => window.__kkWebGPUStandardScene?.status !== 'ready'
        || window.__kkWebGPUStandardScene.frameCount >= 8,
      null,
      { timeout: 30_000 },
    );

    const state = await page.evaluate(() => structuredClone(window.__kkWebGPUStandardScene));
    assert(state.status === 'ready', `${request}: probe failed: ${state.error || 'unknown error'}`);
    assert(state.requestedBackend === request, `${request}: requested-backend state mismatch.`);
    assert(state.rendererIsWebGPURenderer, `${request}: renderer is not WebGPURenderer.`);
    assert(state.oneModuleUniverse, `${request}: Three.js module identity mismatch.`);
    assert(state.threeRevision === '185', `${request}: expected Three.js r185, got r${state.threeRevision}.`);
    assert(state.backendFlags.webgpu !== state.backendFlags.webgl, `${request}: backend flags are ambiguous.`);
    assert(['webgpu', 'webgl'].includes(state.backend), `${request}: invalid actual backend ${state.backend}.`);
    if (expectedBackend) {
      assert(state.backend === expectedBackend, `${request}: expected ${expectedBackend}, got ${state.backend}.`);
    }
    if (state.backend === 'webgl') {
      assert(state.backendFlags.webgl2Context === true, `${request}: fallback backend has no WebGL 2 context.`);
    } else {
      assert(state.backendFlags.webgpuDevice === true, `${request}: WebGPU backend has no initialized GPUDevice.`);
    }

    assert(state.assets.hero.loaded && state.features.heroGlb, `${request}: hero GLB did not load.`);
    assert(state.assets.enemy.loaded && state.features.enemyGlb, `${request}: enemy GLB did not load.`);
    assert(state.assets.instancedEnemy.loaded, `${request}: instanced-enemy GLB did not load.`);
    assert(state.features.authoredAnimation, `${request}: authored GLB animation is inactive.`);
    assert(state.features.instancedEnemyCount === 24, `${request}: expected 24 instanced enemies.`);
    assert(state.features.transparentSprite, `${request}: transparent sprite is absent.`);
    assert(state.features.canvasTexture, `${request}: CanvasTexture is absent.`);
    assert(state.features.shadowCasterCount >= 3, `${request}: shadow casters are absent.`);
    assert(state.features.shadowReceiver, `${request}: shadow receiver is absent.`);
    assert(state.features.pickup && state.features.tslNodeMaterial, `${request}: TSL pickup is absent.`);
    assert(state.features.particleCount === 128, `${request}: particle pool is incomplete.`);
    assert(state.frameCount >= 8 && state.animationSeconds > 0, `${request}: animation loop did not advance.`);
    assert(state.renderInfo.drawCalls > 0, `${request}: renderer recorded no draw calls.`);
    assert(state.renderInfo.frameCalls > 0, `${request}: renderer recorded no frame render call.`);
    assert(state.renderInfo.renderCalls >= state.frameCount, `${request}: cumulative render calls are invalid.`);
    assert(state.renderInfo.triangles > 0, `${request}: renderer recorded no triangles.`);
    assert(state.runtimeErrors.length === 0, `${request}: runtime errors: ${state.runtimeErrors.join('; ')}`);
    assert(browserErrors.length === 0, `${request}: browser errors: ${browserErrors.join('; ')}`);
    // Chromium's software-WebGPU path sometimes reports ERR_ABORTED for a
    // duplicate GLB request after GLTFLoader has already completed it. Treat
    // only that narrow, proven-loaded case as transport noise; all HTTP errors,
    // missing assets, and other failed requests still fail the smoke test.
    const loadedAssetUrls = new Set(Object.values(state.assets)
      .filter((asset) => asset.loaded)
      .map((asset) => new URL(asset.url, page.url()).href));
    const ignoredTransportAborts = failedRequests.filter((failure) => (
      failure.errorText === 'net::ERR_ABORTED' && loadedAssetUrls.has(failure.url)
    ));
    const actionableRequestFailures = failedRequests.filter((failure) => !ignoredTransportAborts.includes(failure));
    assert(
      actionableRequestFailures.length === 0,
      `${request}: failed requests: ${actionableRequestFailures.map((failure) => `${failure.url} (${failure.errorText})`).join('; ')}`,
    );

    // Element screenshots include higher z-index siblings in Chromium. Hide
    // the diagnostics panel so image analysis evaluates only rendered pixels.
    await page.locator('#probe-panel').evaluate((panel) => { panel.style.visibility = 'hidden'; });
    const png = await page.locator('#scene-canvas').screenshot({ type: 'png' });
    if (process.env.KK_WEBGPU_SMOKE_DEBUG_CAPTURE) {
      fs.writeFileSync(process.env.KK_WEBGPU_SMOKE_DEBUG_CAPTURE, png);
    }
    const image = analyzePng(png);
    const imageSummary = JSON.stringify(image);
    assert(image.meanLuminance > 8, `${request}: captured canvas is effectively black (${imageSummary}).`);
    assert(image.luminanceStdDev > 4, `${request}: captured canvas lacks rendered contrast (${imageSummary}).`);
    assert(image.brightPixelRatio > 0.002, `${request}: captured canvas has no bright scene content (${imageSummary}).`);
    assert(image.quantizedColorCount > 24, `${request}: captured canvas has too few colors (${imageSummary}).`);

    let screenshot = null;
    if (outputDirectory) {
      const screenshotPath = path.join(outputDirectory, `${request}-${state.backend}.png`);
      fs.writeFileSync(screenshotPath, png);
      screenshot = path.relative(ROOT, screenshotPath).replaceAll(path.sep, '/');
    }

    return {
      launchProfile,
      requestedBackend: request,
      actualBackend: state.backend,
      revision: state.threeRevision,
      navigatorGpuPresent: state.navigatorGpuPresent,
      frameCount: state.frameCount,
      renderInfo: state.renderInfo,
      animationClip: state.features.authoredAnimationClip,
      instancedEnemies: state.features.instancedEnemyCount,
      particleCount: state.features.particleCount,
      ignoredTransportAborts: ignoredTransportAborts.map((failure) => ({
        url: new URL(failure.url).pathname,
        errorText: failure.errorText,
      })),
      image,
      screenshot,
    };
  } finally {
    await context.close();
  }
}

const DEFAULT_BROWSER_ARGS = Object.freeze([
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
]);

const SOFTWARE_WEBGPU_ARGS = Object.freeze([
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--use-vulkan=swiftshader',
  '--enable-dawn-features=allow_unsafe_apis',
]);

async function launch(chromium, chromiumPath, headed, args) {
  return chromium.launch({
    headless: !headed,
    executablePath: chromiumPath || undefined,
    args,
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const { chromium, chromiumPath } = resolveBrowserTools();
  let ownedServer = null;
  let origin = config.origin;
  const outputDirectory = config.output ? path.resolve(ROOT, config.output) : null;
  if (outputDirectory) fs.mkdirSync(outputDirectory, { recursive: true });
  if (!origin) {
    const started = await startServer(config.port);
    ownedServer = started.server;
    origin = started.origin;
  }
  if (!origin.endsWith('/')) origin += '/';

  const report = {
    entrypoint: 'webgpu-smoke.html',
    chromium: chromiumPath || 'playwright-managed',
    cases: [],
  };

  try {
    if (config.webgl || config.auto) {
      const browser = await launch(chromium, chromiumPath, config.headed, DEFAULT_BROWSER_ARGS);
      try {
        if (config.webgl) report.cases.push(await validateCase(
          browser,
          origin,
          'webgl',
          'webgl',
          'default',
          outputDirectory,
        ));
        if (config.auto) report.cases.push(await validateCase(
          browser,
          origin,
          'auto',
          null,
          'default',
          outputDirectory,
        ));
      } finally {
        await browser.close();
      }
    }

    if (config.webgpu) {
      const browser = await launch(chromium, chromiumPath, config.headed, SOFTWARE_WEBGPU_ARGS);
      try {
        report.cases.push(await validateCase(
          browser,
          origin,
          'webgpu',
          'webgpu',
          'software-webgpu',
          outputDirectory,
        ));
      } finally {
        await browser.close();
      }
    }

    if (outputDirectory) {
      fs.writeFileSync(
        path.join(outputDirectory, 'report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    console.log(JSON.stringify(report, null, 2));
    console.log(`PASS: ${report.cases.length} WebGPURenderer backend smoke case(s).`);
  } finally {
    if (ownedServer) await new Promise((resolve) => ownedServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
