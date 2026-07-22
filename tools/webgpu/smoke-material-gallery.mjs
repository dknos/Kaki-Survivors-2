#!/usr/bin/env node
/** Dual-backend browser validation for webgpu-material-gallery.html. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const config = {
    webgl: true,
    webgpu: true,
    standard: true,
    reduced: true,
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
    } else if (arg === '--webgpu-only') {
      config.webgl = false;
      config.webgpu = true;
    } else if (arg === '--standard-only') {
      config.standard = true;
      config.reduced = false;
    } else if (arg === '--reduced-only') {
      config.standard = false;
      config.reduced = true;
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
      console.log(`Usage: node tools/webgpu/smoke-material-gallery.mjs [options]

Options:
  --webgl-only       Run only forced WebGL 2.
  --webgpu-only      Run only software WebGPU.
  --standard-only    Run only standard accessibility.
  --reduced-only     Run only reduced-motion/flashing accessibility.
  --headed           Show Chromium.
  --port <port>      Static server port; 0 selects a free port.
  --origin <url>     Use an existing static server.
  --output <dir>     Save PNG evidence and report.json.
`);
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
  const playwright = require(playwrightPath);
  const knownChromium = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const chromiumPath = process.env.KK_WEBGPU_SMOKE_CHROMIUM
    || (fs.existsSync(knownChromium) ? knownChromium : null);
  if (chromiumPath && !fs.existsSync(chromiumPath)) {
    throw new Error(`Chromium is unavailable at ${chromiumPath}.`);
  }
  return { chromium: playwright.chromium, chromiumPath };
}

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
});

async function startServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(
        requestUrl.pathname === '/' ? '/webgpu-material-gallery.html' : requestUrl.pathname,
      );
      const filePath = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
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
  return { server, origin: `http://127.0.0.1:${server.address().port}/` };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function analyzePng(buffer, samplePoints) {
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(buffer);
  let sum = 0;
  let sumSquared = 0;
  let bright = 0;
  const colors = new Set();
  const pixels = png.width * png.height;
  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    sum += luminance;
    sumSquared += luminance * luminance;
    if (luminance >= 70) bright += 1;
    if (colors.size <= 4096) colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
  }
  const samples = {};
  for (const [name, point] of Object.entries(samplePoints || {})) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    const centerX = Math.round(point.x);
    const centerY = Math.round(point.y);
    for (let y = centerY - 4; y <= centerY + 4; y += 1) {
      for (let x = centerX - 4; x <= centerX + 4; x += 1) {
        if (x < 0 || x >= png.width || y < 0 || y >= png.height) continue;
        const offset = (y * png.width + x) * 4;
        red += png.data[offset];
        green += png.data[offset + 1];
        blue += png.data[offset + 2];
        count += 1;
      }
    }
    samples[name] = {
      red: Number((red / Math.max(1, count)).toFixed(2)),
      green: Number((green / Math.max(1, count)).toFixed(2)),
      blue: Number((blue / Math.max(1, count)).toFixed(2)),
    };
  }
  const mean = sum / pixels;
  return {
    width: png.width,
    height: png.height,
    meanLuminance: Number(mean.toFixed(3)),
    luminanceStdDev: Number(Math.sqrt(Math.max(0, sumSquared / pixels - mean * mean)).toFixed(3)),
    brightPixelRatio: Number((bright / pixels).toFixed(5)),
    quantizedColorCount: colors.size,
    samples,
  };
}

async function validateCase(browser, origin, backend, accessibility, outputDirectory) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 760 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const browserErrors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText || 'failed'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.url()} (HTTP ${response.status()})`);
  });

  try {
    const url = new URL('webgpu-material-gallery.html', origin);
    url.searchParams.set('renderer', backend);
    url.searchParams.set('accessibility', accessibility);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__kkWebGPUMaterialGallery?.status),
      null,
      { timeout: 120_000 },
    );
    await page.waitForFunction(
      () => window.__kkWebGPUMaterialGallery?.status !== 'ready'
        || window.__kkWebGPUMaterialGallery.frameCount >= 20,
      null,
      { timeout: 30_000 },
    );
    const state = await page.evaluate(() => structuredClone(window.__kkWebGPUMaterialGallery));

    assert(state.status === 'ready', `${backend}/${accessibility}: ${state.error || 'probe failed'}`);
    assert(state.backend === backend, `${backend}/${accessibility}: actual backend is ${state.backend}.`);
    assert(state.requestedBackend === backend, `${backend}/${accessibility}: request state mismatch.`);
    assert(state.accessibilityMode === accessibility, `${backend}/${accessibility}: accessibility mismatch.`);
    assert(state.rendererIsWebGPURenderer, `${backend}/${accessibility}: not WebGPURenderer.`);
    assert(state.oneModuleUniverse, `${backend}/${accessibility}: mixed Three.js module universes.`);
    assert(state.threeRevision === '185', `${backend}/${accessibility}: expected r185.`);
    assert(state.compiled, `${backend}/${accessibility}: compileAsync did not complete.`);
    assert(state.backendFlags.webgpu !== state.backendFlags.webgl, `${backend}: ambiguous backend flags.`);
    if (backend === 'webgpu') {
      assert(state.backendFlags.webgpuDevice === true, 'WebGPU backend has no GPUDevice.');
    } else {
      assert(state.backendFlags.webgl2Context === true, 'Forced fallback has no WebGL 2 context.');
    }
    assert(state.materials.expectedCount === 14, 'Material family contract changed without test update.');
    assert(state.materials.nodeMaterialCount === 14, 'Not every custom family uses a node material.');
    assert(state.materials.physicalNodeMaterialCount >= 1, 'Physical hero material path was not compiled.');
    assert(state.materials.customOutputCount === 8, 'Custom output graph count mismatch.');
    assert(state.materials.missingFamilies.length === 0, `Missing: ${state.materials.missingFamilies.join(', ')}`);
    assert(state.materials.voidIgnoresInstanceColor, 'Void chasm did not exercise cyan instanceColor bypass.');
    assert(state.materials.skyFactoryBackSide, 'Sky factories did not retain BackSide dome rendering.');
    assert(state.materials.skySwatchSideOverride, 'Flat sky gallery swatches were not made visible.');
    assert(state.frameCount >= 20 && state.animationAdvanced, 'Gallery animation loop did not advance.');
    assert(state.renderCalls >= state.frameCount, 'Render submission count is invalid.');
    assert(state.renderInfo.drawCalls > 20, 'Gallery recorded too few draws.');
    assert(state.renderInfo.triangles > 1_000, 'Gallery recorded too few triangles.');
    assert(state.runtimeErrors.length === 0, `Runtime errors: ${state.runtimeErrors.join('; ')}`);
    assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join('; ')}`);
    assert(failedRequests.length === 0, `Failed requests: ${failedRequests.join('; ')}`);
    if (accessibility === 'reduced') {
      assert(state.accessibility.creatureAmplitude === 0, 'Reduced motion did not stop creature deformation.');
      assert(state.accessibility.surfaceMotionScale === 0, 'Reduced motion did not stop surface motion.');
      assert(state.accessibility.flashAmount < 0.2, 'Reduced flashing did not clamp the damage flash.');
    } else {
      assert(state.accessibility.creatureAmplitude === 1, 'Standard creature amplitude changed.');
      assert(state.accessibility.surfaceMotionScale === 1, 'Standard surface motion changed.');
      assert(state.accessibility.flashAmount === 1, 'Standard damage flash changed.');
    }

    await page.locator('#probe-panel').evaluate((panel) => { panel.style.visibility = 'hidden'; });
    const png = await page.locator('#gallery-canvas').screenshot({ type: 'png' });
    if (process.env.KK_WEBGPU_GALLERY_DEBUG_CAPTURE) {
      fs.writeFileSync(process.env.KK_WEBGPU_GALLERY_DEBUG_CAPTURE, png);
    }
    const image = analyzePng(png, state.samplePoints);
    assert(image.meanLuminance > 8, `Gallery is effectively black: ${JSON.stringify(image)}.`);
    assert(image.luminanceStdDev > 8, `Gallery lacks contrast: ${JSON.stringify(image)}.`);
    assert(image.brightPixelRatio > 0.001, `Gallery has no bright content: ${JSON.stringify(image)}.`);
    assert(image.quantizedColorCount > 80, `Gallery has too few colors: ${JSON.stringify(image)}.`);
    const voidSample = image.samples.voidChasm;
    assert(voidSample && Math.max(voidSample.red, voidSample.green, voidSample.blue) < 105,
      `Void center inherited a bright instance tint: ${JSON.stringify(voidSample)}.`);
    assert(image.samples.forestSky && Math.max(
      image.samples.forestSky.red,
      image.samples.forestSky.green,
      image.samples.forestSky.blue,
    ) > 12,
      `Forest sky back-face panel is absent: ${JSON.stringify(image.samples.forestSky)}.`);
    assert(image.samples.caveSky && Math.max(
      image.samples.caveSky.red,
      image.samples.caveSky.green,
      image.samples.caveSky.blue,
    ) > 12,
      `Cave sky back-face panel is absent: ${JSON.stringify(image.samples.caveSky)}.`);

    let screenshot = null;
    if (outputDirectory) {
      const screenshotPath = path.join(outputDirectory, `${backend}-${accessibility}.png`);
      fs.writeFileSync(screenshotPath, png);
      screenshot = path.relative(ROOT, screenshotPath).replaceAll(path.sep, '/');
    }
    return {
      requestedBackend: backend,
      actualBackend: state.backend,
      accessibility,
      revision: state.threeRevision,
      frameCount: state.frameCount,
      renderInfo: state.renderInfo,
      materials: state.materials,
      accessibilityState: state.accessibility,
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
  const accessibilityCases = [
    ...(config.standard ? ['standard'] : []),
    ...(config.reduced ? ['reduced'] : []),
  ];
  let ownedServer = null;
  let origin = config.origin;
  if (!origin) {
    const started = await startServer(config.port);
    ownedServer = started.server;
    origin = started.origin;
  }
  if (!origin.endsWith('/')) origin += '/';
  const outputDirectory = config.output ? path.resolve(ROOT, config.output) : null;
  if (outputDirectory) fs.mkdirSync(outputDirectory, { recursive: true });
  const report = {
    entrypoint: 'webgpu-material-gallery.html',
    chromium: chromiumPath || 'playwright-managed',
    generatedAt: new Date().toISOString(),
    cases: [],
  };

  try {
    if (config.webgl) {
      const browser = await launch(chromium, chromiumPath, config.headed, DEFAULT_BROWSER_ARGS);
      try {
        for (const accessibility of accessibilityCases) {
          report.cases.push(await validateCase(
            browser,
            origin,
            'webgl',
            accessibility,
            outputDirectory,
          ));
        }
      } finally {
        await browser.close();
      }
    }
    if (config.webgpu) {
      const browser = await launch(chromium, chromiumPath, config.headed, SOFTWARE_WEBGPU_ARGS);
      try {
        for (const accessibility of accessibilityCases) {
          report.cases.push(await validateCase(
            browser,
            origin,
            'webgpu',
            accessibility,
            outputDirectory,
          ));
        }
      } finally {
        await browser.close();
      }
    }
    if (outputDirectory) {
      fs.writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (ownedServer) await new Promise((resolve) => ownedServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
