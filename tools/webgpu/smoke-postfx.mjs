#!/usr/bin/env node
/** Dual-backend visual validation for webgpu-postfx-smoke.html. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let atomicWriteCounter = 0;

function writeFileAtomic(filePath, data) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${atomicWriteCounter++}`;
  fs.writeFileSync(temporaryPath, data);
  fs.renameSync(temporaryPath, filePath);
}

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
      console.log(`Usage: node tools/webgpu/smoke-postfx.mjs [options]

Options:
  --webgl-only       Run only forced WebGL 2.
  --webgpu-only      Run only software WebGPU.
  --standard-only    Run only standard accessibility.
  --reduced-only     Run only reduced-motion/flashing accessibility.
  --headed           Show Chromium.
  --port <port>      Static server port; 0 selects a free port.
  --origin <url>     Use an existing static server.
  --output <dir>     Save bloom-on/off PNGs, report.json, and report.md.
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
        requestUrl.pathname === '/' ? '/webgpu-postfx-smoke.html' : requestUrl.pathname,
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

function decodePng(buffer) {
  const { PNG } = require('pngjs');
  return PNG.sync.read(buffer);
}

function luminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function imageStatistics(png) {
  let sum = 0;
  let sumSquared = 0;
  let bright = 0;
  const colors = new Set();
  const pixels = png.width * png.height;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const value = luminance(png.data[offset], png.data[offset + 1], png.data[offset + 2]);
    sum += value;
    sumSquared += value * value;
    if (value >= 70) bright += 1;
    if (colors.size <= 4096) {
      colors.add(`${png.data[offset] >> 4}:${png.data[offset + 1] >> 4}:${png.data[offset + 2] >> 4}`);
    }
  }
  const mean = sum / pixels;
  return {
    width: png.width,
    height: png.height,
    meanLuminance: Number(mean.toFixed(4)),
    luminanceStdDev: Number(Math.sqrt(Math.max(0, sumSquared / pixels - mean * mean)).toFixed(4)),
    brightPixelRatio: Number((bright / pixels).toFixed(6)),
    quantizedColorCount: colors.size,
  };
}

function radialPairStatistics(onPng, offPng, point, innerScale, outerScale) {
  const centerX = Number(point.x);
  const centerY = Number(point.y);
  const inner = Number(point.radius) * innerScale;
  const outer = Number(point.radius) * outerScale;
  const minX = Math.max(0, Math.floor(centerX - outer));
  const maxX = Math.min(onPng.width - 1, Math.ceil(centerX + outer));
  const minY = Math.max(0, Math.floor(centerY - outer));
  const maxY = Math.min(onPng.height - 1, Math.ceil(centerY + outer));
  let onSum = 0;
  let offSum = 0;
  let signedGain = 0;
  let absoluteDifference = 0;
  let count = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance < inner || distance > outer) continue;
      const offset = (y * onPng.width + x) * 4;
      const onValue = luminance(onPng.data[offset], onPng.data[offset + 1], onPng.data[offset + 2]);
      const offValue = luminance(offPng.data[offset], offPng.data[offset + 1], offPng.data[offset + 2]);
      onSum += onValue;
      offSum += offValue;
      signedGain += onValue - offValue;
      absoluteDifference += (
        Math.abs(onPng.data[offset] - offPng.data[offset])
        + Math.abs(onPng.data[offset + 1] - offPng.data[offset + 1])
        + Math.abs(onPng.data[offset + 2] - offPng.data[offset + 2])
      ) / 3;
      count += 1;
    }
  }
  return {
    pixels: count,
    bloomOnLuminance: Number((onSum / Math.max(1, count)).toFixed(4)),
    bloomOffLuminance: Number((offSum / Math.max(1, count)).toFixed(4)),
    signedLuminanceGain: Number((signedGain / Math.max(1, count)).toFixed(4)),
    meanAbsoluteRgbDifference: Number((absoluteDifference / Math.max(1, count)).toFixed(4)),
  };
}

function patchStatistics(png, point, radiusScale = 0.7) {
  const radius = Math.max(2, Number(point.radius) * radiusScale);
  let sum = 0;
  let sumSquared = 0;
  let count = 0;
  for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y += 1) {
    for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x += 1) {
      if (x < 0 || x >= png.width || y < 0 || y >= png.height) continue;
      if (Math.hypot(x - point.x, y - point.y) > radius) continue;
      const offset = (y * png.width + x) * 4;
      const value = luminance(png.data[offset], png.data[offset + 1], png.data[offset + 2]);
      sum += value;
      sumSquared += value * value;
      count += 1;
    }
  }
  const mean = sum / Math.max(1, count);
  return {
    pixels: count,
    meanLuminance: Number(mean.toFixed(4)),
    luminanceStdDev: Number(Math.sqrt(Math.max(0, sumSquared / Math.max(1, count) - mean * mean)).toFixed(4)),
  };
}

function analyzePair(onBuffer, offBuffer, samplePoints) {
  const onPng = decodePng(onBuffer);
  const offPng = decodePng(offBuffer);
  assert(onPng.width === offPng.width && onPng.height === offPng.height, 'Capture dimensions differ.');
  const objects = {};
  for (const name of ['brightNonBloom', 'opaqueBloom', 'additiveBloom']) {
    objects[name] = {
      core: patchStatistics(onPng, samplePoints[name], 0.68),
      halo: radialPairStatistics(onPng, offPng, samplePoints[name], 1.15, 2.45),
    };
  }
  objects.waterSurface = {
    core: patchStatistics(offPng, samplePoints.waterSurface, 1.25),
  };
  return {
    bloomOn: imageStatistics(onPng),
    bloomOff: imageStatistics(offPng),
    objects,
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
    const url = new URL('webgpu-postfx-smoke.html', origin);
    url.searchParams.set('renderer', backend);
    url.searchParams.set('accessibility', accessibility);
    url.searchParams.set('quality', 'legacy');
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__kkWebGPUPostfxSmoke?.status),
      null,
      { timeout: 120_000 },
    );
    const initialState = await page.evaluate(() => structuredClone(window.__kkWebGPUPostfxSmoke));
    assert(initialState.status === 'ready', `${backend}/${accessibility}: ${initialState.error || 'probe failed'}`);
    assert(initialState.backend === backend, `${backend}/${accessibility}: actual backend is ${initialState.backend}.`);
    assert(initialState.requestedBackend === backend, `${backend}/${accessibility}: request state mismatch.`);
    assert(initialState.accessibilityMode === accessibility, `${backend}/${accessibility}: accessibility mismatch.`);
    assert(initialState.rendererIsWebGPURenderer, `${backend}/${accessibility}: not WebGPURenderer.`);
    assert(initialState.threeRevision === '185', `${backend}/${accessibility}: expected r185.`);
    assert(initialState.initialized, `${backend}/${accessibility}: renderer service did not initialize.`);
    assert(initialState.compiled && initialState.compileResult, `${backend}/${accessibility}: pipeline compilation failed.`);
    assert(initialState.compileMethod, `${backend}/${accessibility}: facade compile() is absent.`);
    assert(initialState.compileDiagnostics?.compiled === true,
      `${backend}/${accessibility}: scene-pass compilation diagnostic is false.`);
    assert(initialState.compileDiagnostics?.warmupRenderCount === 1,
      `${backend}/${accessibility}: full-graph warmup count is not one.`);
    assert(initialState.hasBloomGraph, `${backend}/${accessibility}: legacy quality omitted bloom graph.`);
    assert(initialState.selectiveBloomMrt, `${backend}/${accessibility}: MRT selective bloom graph is absent.`);
    assert(initialState.customOutputNode, `${backend}/${accessibility}: custom outputNode material is absent.`);
    assert(!initialState.customFragmentNode,
      `${backend}/${accessibility}: custom MRT material still uses fragmentNode.`);
    assert(initialState.sceneSamples === 0, `${backend}/${accessibility}: scene pass samples=${initialState.sceneSamples}, expected 0.`);
    assert(initialState.quality === 'legacy', `${backend}/${accessibility}: expected legacy parity graph.`);
    assert(initialState.compileDiagnostics?.quality === 'legacy', `${backend}/${accessibility}: compiled quality mismatch.`);
    assert(initialState.compileDiagnostics?.graphTopology?.dithering === false,
      `${backend}/${accessibility}: legacy graph unexpectedly includes dithering.`);
    assert(initialState.backendFlags.webgpu !== initialState.backendFlags.webgl, `${backend}: ambiguous backend flags.`);
    if (backend === 'webgpu') {
      assert(initialState.backendFlags.webgpuDevice === true, 'WebGPU backend has no GPUDevice.');
    } else {
      assert(initialState.backendFlags.webgl2Context === true, 'Forced fallback has no WebGL 2 context.');
    }
    assert(initialState.objects.brightNonBloom.layer0, 'Bright non-bloom object is hidden from beauty layer.');
    assert(initialState.objects.brightNonBloom.hdrPeak > 1, 'Bright control is not an HDR source.');
    assert(!initialState.objects.brightNonBloom.bloomLayer, 'Bright control object entered bloom layer.');
    assert(initialState.objects.opaqueBloom.bloomLayer, 'Opaque bloom object lacks bloom membership.');
    assert(initialState.objects.opaqueBloom.hdrPeak > 1, 'Opaque bloom object is not an HDR source.');
    assert(initialState.objects.additiveBloom.bloomLayer, 'Additive bloom object lacks bloom membership.');
    assert(initialState.objects.additiveBloom.hdrPeak > 1, 'Additive bloom object is not an HDR source.');
    assert(initialState.objects.additiveBloom.transparent, 'Additive object is not transparent.');
    assert(initialState.objects.additiveBloom.additive, 'Transparent object is not additive blended.');
    assert(initialState.objects.additiveBloom.opacity > 0 && initialState.objects.additiveBloom.opacity < 1,
      'Additive object did not exercise partial opacity.');
    assert(initialState.objects.waterSurface.material === 'MeshBasicNodeMaterial', 'Water is not a node material.');
    assert(!initialState.objects.waterSurface.bloomLayer, 'Water control surface entered bloom layer.');
    assert(initialState.frameCount >= 14 && initialState.renderCalls >= initialState.frameCount,
      'Post-processing animation loop did not render enough frames.');
    if (accessibility === 'reduced') {
      assert(initialState.accessibility.uReduceMotion === 1, 'Reduced motion uniform was not set.');
      assert(initialState.accessibility.uReduceFlashing === 1, 'Reduced flashing uniform was not set.');
      assert(initialState.accessibility.uHighContrast === 1, 'High-contrast uniform was not set.');
    } else {
      assert(initialState.accessibility.uReduceMotion === 0, 'Standard reduce-motion uniform changed.');
      assert(initialState.accessibility.uReduceFlashing === 0, 'Standard reduce-flashing uniform changed.');
      assert(initialState.accessibility.uHighContrast === 0, 'Standard high-contrast uniform changed.');
    }

    await page.locator('#probe-panel').evaluate((panel) => { panel.style.visibility = 'hidden'; });
    async function captureBloomPair(objectName = 'all') {
      await page.evaluate((name) => window.__kkWebGPUPostfxControl.showOnly(name), objectName);
      await page.evaluate(() => window.__kkWebGPUPostfxControl.setBloomEnabled(true));
      const bloomOn = await page.locator('#postfx-canvas').screenshot({ type: 'png' });
      await page.evaluate(() => window.__kkWebGPUPostfxControl.setBloomEnabled(false));
      const bloomOff = await page.locator('#postfx-canvas').screenshot({ type: 'png' });
      return { bloomOn, bloomOff };
    }

    const allPair = await captureBloomPair('all');
    const isolatedPairs = {};
    for (const objectName of ['brightNonBloom', 'opaqueBloom', 'additiveBloom']) {
      isolatedPairs[objectName] = await captureBloomPair(objectName);
    }
    const finalState = await page.evaluate(() => structuredClone(window.__kkWebGPUPostfxSmoke));
    const image = analyzePair(allPair.bloomOn, allPair.bloomOff, initialState.samplePoints);
    for (const objectName of Object.keys(isolatedPairs)) {
      const pair = isolatedPairs[objectName];
      const isolatedAnalysis = analyzePair(pair.bloomOn, pair.bloomOff, initialState.samplePoints);
      image.objects[objectName] = isolatedAnalysis.objects[objectName];
    }

    assert(image.bloomOff.meanLuminance > 4, `Frame is effectively black: ${JSON.stringify(image.bloomOff)}.`);
    assert(image.bloomOff.luminanceStdDev > 7, `Frame lacks contrast: ${JSON.stringify(image.bloomOff)}.`);
    assert(image.bloomOff.quantizedColorCount > 10, `Frame has too few colors: ${JSON.stringify(image.bloomOff)}.`);
    assert(image.objects.brightNonBloom.core.meanLuminance > 245,
      'HDR bright control was flattened before ACES output transform.');
    assert(image.objects.opaqueBloom.core.meanLuminance > 75, 'Opaque bloom object is absent.');
    assert(image.objects.additiveBloom.core.meanLuminance > 35, 'Transparent additive object is absent.');
    assert(image.objects.waterSurface.core.meanLuminance > 5, 'Custom outputNode water surface is absent.');

    const nonBloomDelta = image.objects.brightNonBloom.halo.meanAbsoluteRgbDifference;
    const opaqueDelta = image.objects.opaqueBloom.halo.meanAbsoluteRgbDifference;
    const additiveDelta = image.objects.additiveBloom.halo.meanAbsoluteRgbDifference;
    assert(opaqueDelta > 0.35, `Opaque bloom did not produce a measurable halo: ${opaqueDelta}.`);
    assert(additiveDelta > 0.12, `Transparent additive bloom did not produce a measurable halo: ${additiveDelta}.`);
    assert(nonBloomDelta < 0.08,
      `Isolated bright non-bloom control produced a halo delta of ${nonBloomDelta}.`);
    assert(opaqueDelta > nonBloomDelta * 3 + 0.2,
      `Bright non-bloom control changed too much (${nonBloomDelta}) versus opaque bloom (${opaqueDelta}).`);
    assert(additiveDelta > nonBloomDelta * 2 + 0.08,
      `Additive bloom is not selective (${additiveDelta}) versus control (${nonBloomDelta}).`);
    assert(image.objects.opaqueBloom.halo.signedLuminanceGain > 0.1,
      'Opaque bloom did not increase halo luminance.');
    assert(image.objects.additiveBloom.halo.signedLuminanceGain > 0.04,
      'Additive bloom did not increase halo luminance.');
    assert(finalState.runtimeErrors.length === 0, `Runtime errors: ${finalState.runtimeErrors.join('; ')}`);
    assert(browserErrors.length === 0, `Browser errors: ${browserErrors.join('; ')}`);
    assert(failedRequests.length === 0, `Failed requests: ${failedRequests.join('; ')}`);

    const screenshots = { bloomOn: null, bloomOff: null, isolated: {} };
    if (outputDirectory) {
      const stem = `${backend}-${accessibility}`;
      const bloomOnPath = path.join(outputDirectory, `${stem}-bloom-on.png`);
      const bloomOffPath = path.join(outputDirectory, `${stem}-bloom-off.png`);
      writeFileAtomic(bloomOnPath, allPair.bloomOn);
      writeFileAtomic(bloomOffPath, allPair.bloomOff);
      screenshots.bloomOn = path.relative(ROOT, bloomOnPath).replaceAll(path.sep, '/');
      screenshots.bloomOff = path.relative(ROOT, bloomOffPath).replaceAll(path.sep, '/');
      for (const [objectName, pair] of Object.entries(isolatedPairs)) {
        const objectOnPath = path.join(outputDirectory, `${stem}-${objectName}-bloom-on.png`);
        const objectOffPath = path.join(outputDirectory, `${stem}-${objectName}-bloom-off.png`);
        writeFileAtomic(objectOnPath, pair.bloomOn);
        writeFileAtomic(objectOffPath, pair.bloomOff);
        screenshots.isolated[objectName] = {
          bloomOn: path.relative(ROOT, objectOnPath).replaceAll(path.sep, '/'),
          bloomOff: path.relative(ROOT, objectOffPath).replaceAll(path.sep, '/'),
        };
      }
    }

    return {
      requestedBackend: backend,
      actualBackend: initialState.backend,
      accessibility,
      revision: initialState.threeRevision,
      sceneSamples: initialState.sceneSamples,
      compileResult: initialState.compileResult,
      compileDiagnostics: initialState.compileDiagnostics,
      quality: initialState.quality,
      frameCount: finalState.frameCount,
      renderInfo: finalState.renderInfo,
      objects: initialState.objects,
      accessibilityState: initialState.accessibility,
      image,
      screenshots,
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

function validateAccessibilityAttenuation(cases) {
  for (const backend of ['webgl', 'webgpu']) {
    const standard = cases.find((entry) => entry.actualBackend === backend && entry.accessibility === 'standard');
    const reduced = cases.find((entry) => entry.actualBackend === backend && entry.accessibility === 'reduced');
    if (!standard || !reduced) continue;
    for (const objectName of ['opaqueBloom', 'additiveBloom']) {
      const standardDelta = standard.image.objects[objectName].halo.meanAbsoluteRgbDifference;
      const reducedDelta = reduced.image.objects[objectName].halo.meanAbsoluteRgbDifference;
      assert(reducedDelta < standardDelta * 0.78,
        `${backend}: reduced flashing did not attenuate ${objectName} (${reducedDelta} vs ${standardDelta}).`);
    }
  }
}

function validateBackendParity(cases) {
  const comparisons = [];
  for (const accessibility of ['standard', 'reduced']) {
    const webgl = cases.find((entry) => entry.actualBackend === 'webgl'
      && entry.accessibility === accessibility);
    const webgpu = cases.find((entry) => entry.actualBackend === 'webgpu'
      && entry.accessibility === accessibility);
    if (!webgl || !webgpu) continue;
    const comparison = {
      accessibility,
      bloomOnMeanLuminanceDifference: Number(Math.abs(
        webgl.image.bloomOn.meanLuminance - webgpu.image.bloomOn.meanLuminance,
      ).toFixed(4)),
      hdrHighlightDifference: Number(Math.abs(
        webgl.image.objects.brightNonBloom.core.meanLuminance
          - webgpu.image.objects.brightNonBloom.core.meanLuminance,
      ).toFixed(4)),
      opaqueHaloDifference: Number(Math.abs(
        webgl.image.objects.opaqueBloom.halo.meanAbsoluteRgbDifference
          - webgpu.image.objects.opaqueBloom.halo.meanAbsoluteRgbDifference,
      ).toFixed(4)),
      additiveHaloDifference: Number(Math.abs(
        webgl.image.objects.additiveBloom.halo.meanAbsoluteRgbDifference
          - webgpu.image.objects.additiveBloom.halo.meanAbsoluteRgbDifference,
      ).toFixed(4)),
    };
    assert(comparison.bloomOnMeanLuminanceDifference < 0.5,
      `${accessibility}: backend bloom frame mean diverged by ${comparison.bloomOnMeanLuminanceDifference}.`);
    assert(comparison.hdrHighlightDifference < 0.5,
      `${accessibility}: backend HDR highlight diverged by ${comparison.hdrHighlightDifference}.`);
    assert(comparison.opaqueHaloDifference < 0.5,
      `${accessibility}: backend opaque bloom diverged by ${comparison.opaqueHaloDifference}.`);
    assert(comparison.additiveHaloDifference < 0.5,
      `${accessibility}: backend additive bloom diverged by ${comparison.additiveHaloDifference}.`);
    comparisons.push(comparison);
  }
  return comparisons;
}

function markdownReport(report) {
  const lines = [
    '# WebGPU post-processing browser smoke evidence',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'The same pinned Three.js r185 RenderPipeline and TSL graph was exercised through forced WebGL 2 and software WebGPU. Each case compares deterministic bloom-on and bloom-off captures.',
    '',
    '| Backend | Accessibility | Samples | HDR highlight | Opaque halo delta | Additive halo delta | Non-bloom delta | Draws | Result |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const entry of report.cases) {
    lines.push(
      `| ${entry.actualBackend} | ${entry.accessibility} | ${entry.sceneSamples} | `
      + `${entry.image.objects.brightNonBloom.core.meanLuminance} | `
      + `${entry.image.objects.opaqueBloom.halo.meanAbsoluteRgbDifference} | `
      + `${entry.image.objects.additiveBloom.halo.meanAbsoluteRgbDifference} | `
      + `${entry.image.objects.brightNonBloom.halo.meanAbsoluteRgbDifference} | `
      + `${entry.renderInfo.drawCalls} | pass |`,
    );
  }
  lines.push(
    '',
    'Validated invariants:',
    '',
    '- Renderer initialization and full post-processing graph compilation completed without browser errors.',
    '- MRT selective bloom rejected an equally bright non-bloom control while blooming opaque and transparent additive members.',
    '- The production-style water `outputNode` material rendered through the MRT scene pass.',
    '- HDR source values above 1 reached ACES tone mapping through the legacy graph, whose zero-dither topology omits the dither node.',
    '- Reduced-flashing uniforms measurably attenuated both bloom halos without rebuilding the graph.',
    '- WebGPU and forced WebGL 2 bloom/highlight measurements remained within the smoke tolerance.',
    '- The post-processing scene pass used zero MSAA samples, matching the legacy composer target behavior.',
    '',
  );
  return `${lines.join('\n')}\n`;
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
    entrypoint: 'webgpu-postfx-smoke.html',
    chromium: chromiumPath || 'playwright-managed',
    generatedAt: new Date().toISOString(),
    cases: [],
  };

  try {
    if (config.webgl) {
      const browser = await launch(chromium, chromiumPath, config.headed, DEFAULT_BROWSER_ARGS);
      try {
        for (const accessibility of accessibilityCases) {
          report.cases.push(await validateCase(browser, origin, 'webgl', accessibility, outputDirectory));
        }
      } finally {
        await browser.close();
      }
    }
    if (config.webgpu) {
      const browser = await launch(chromium, chromiumPath, config.headed, SOFTWARE_WEBGPU_ARGS);
      try {
        for (const accessibility of accessibilityCases) {
          report.cases.push(await validateCase(browser, origin, 'webgpu', accessibility, outputDirectory));
        }
      } finally {
        await browser.close();
      }
    }
    validateAccessibilityAttenuation(report.cases);
    report.backendParity = validateBackendParity(report.cases);
    if (outputDirectory) {
      writeFileAtomic(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileAtomic(path.join(outputDirectory, 'report.md'), markdownReport(report));
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
