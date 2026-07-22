#!/usr/bin/env node
/** Dual-backend rendered smoke for atmosphere, Trials, and sprite-pool TSL materials. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILIES = Object.freeze(['atmosphere', 'trials', 'sprite']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const config = {
    webgl: true,
    webgpu: true,
    headed: false,
    port: 0,
    origin: process.env.KK_WEBGPU_SMOKE_ORIGIN || null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--webgl-only') {
      config.webgpu = false;
    } else if (arg === '--webgpu-only') {
      config.webgl = false;
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
      console.log(`Usage: node tools/webgpu/smoke-instanced-materials.mjs [options]

Options:
  --webgl-only       Run only forced WebGL 2.
  --webgpu-only      Run only software WebGPU.
  --headed           Show Chromium.
  --port <port>      Static server port; 0 selects a free port.
  --origin <url>     Use an existing static server.
  --output <dir>     Save per-case PNGs and report.json.
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
  return { chromium: playwright.chromium, chromiumPath };
}

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
});

async function startServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(
        requestUrl.pathname === '/' ? '/webgpu-instanced-materials-smoke.html' : requestUrl.pathname,
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

function analyzePng(buffer) {
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
    if (luminance >= 55) bright += 1;
    if (colors.size <= 4096) colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
  }
  const mean = sum / pixels;
  return {
    width: png.width,
    height: png.height,
    meanLuminance: Number(mean.toFixed(3)),
    luminanceStdDev: Number(Math.sqrt(Math.max(0, sumSquared / pixels - mean * mean)).toFixed(3)),
    brightPixelRatio: Number((bright / pixels).toFixed(6)),
    quantizedColorCount: colors.size,
  };
}

async function runCase(browser, origin, backend, family, outputDirectory) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 500 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText || 'failed'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.url()} (HTTP ${response.status()})`);
  });
  try {
    const url = new URL('webgpu-instanced-materials-smoke.html', origin);
    url.searchParams.set('renderer', backend);
    url.searchParams.set('family', family);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__kkWebGPUInstancedMaterialsProbe?.status),
      null,
      { timeout: 120_000 },
    );
    const state = await page.evaluate(() => structuredClone(window.__kkWebGPUInstancedMaterialsProbe));
    assert(state.status === 'ready', `${backend}/${family}: ${state.errors?.join('; ') || 'probe failed'}`);
    assert(state.backend === backend, `${backend}/${family}: initialized ${state.backend}.`);
    assert(state.requestedFamily === family, `${backend}/${family}: family state mismatch.`);
    assert(state.compiled && state.frames >= 3, `${backend}/${family}: compile/render loop incomplete.`);
    assert(state.drawCalls >= 1, `${backend}/${family}: no recorded draws.`);
    assert(state.triangles >= ({ atmosphere: 6, trials: 60, sprite: 4 })[family],
      `${backend}/${family}: incomplete geometry (${state.triangles} triangles).`);
    assert(errors.length === 0, `${backend}/${family}: ${errors.join('; ')}`);
    assert(failedRequests.length === 0, `${backend}/${family}: ${failedRequests.join('; ')}`);

    const png = await page.locator('#probe-canvas').screenshot({ type: 'png' });
    const image = analyzePng(png);
    assert(image.meanLuminance > 5, `${backend}/${family}: effectively black ${JSON.stringify(image)}.`);
    assert(image.luminanceStdDev > 1, `${backend}/${family}: no rendered contrast ${JSON.stringify(image)}.`);
    assert(image.brightPixelRatio > 0.0001, `${backend}/${family}: no bright material pixels.`);
    // Nearest-filtered one-color fixtures intentionally quantize to only the
    // background plus a small number of authored texel colors.
    assert(image.quantizedColorCount > 1, `${backend}/${family}: insufficient rendered colors.`);
    let screenshot = null;
    if (outputDirectory) {
      screenshot = path.join(outputDirectory, `${backend}-${family}.png`);
      fs.writeFileSync(screenshot, png);
      screenshot = path.relative(ROOT, screenshot).replaceAll(path.sep, '/');
    }
    return { backend, family, drawCalls: state.drawCalls, triangles: state.triangles, image, screenshot };
  } finally {
    await context.close();
  }
}

const DEFAULT_ARGS = Object.freeze([
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
]);
const WEBGPU_ARGS = Object.freeze([
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--use-vulkan=swiftshader',
  '--enable-dawn-features=allow_unsafe_apis',
]);

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const { chromium, chromiumPath } = resolveBrowserTools();
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
  const report = { entrypoint: 'webgpu-instanced-materials-smoke.html', cases: [] };
  try {
    for (const [backend, enabled, args] of [
      ['webgl', config.webgl, DEFAULT_ARGS],
      ['webgpu', config.webgpu, WEBGPU_ARGS],
    ]) {
      if (!enabled) continue;
      const browser = await chromium.launch({
        headless: !config.headed,
        executablePath: chromiumPath || undefined,
        args,
      });
      try {
        for (const family of FAMILIES) {
          report.cases.push(await runCase(browser, origin, backend, family, outputDirectory));
        }
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
    console.log(`PASS: ${report.cases.length} instanced-material rendered case(s).`);
    for (const entry of report.cases) {
      console.log(`${entry.backend}/${entry.family}: ${entry.drawCalls} draws, ${entry.triangles} triangles, `
        + `mean=${entry.image.meanLuminance}, contrast=${entry.image.luminanceStdDev}`);
    }
  } finally {
    if (ownedServer) await new Promise((resolve) => ownedServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
