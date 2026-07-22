#!/usr/bin/env node
/**
 * Dual-backend browser smoke for the real production entrypoint (index.html).
 *
 * WebGL 2 and software WebGPU use separate Chromium launches because Dawn's
 * Vulkan/SwiftShader flags can make WebGL context creation unreliable in the
 * same browser process.
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
import { SOFTWARE_WEBGPU_ARGS } from './chromiumProfiles.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_REVISION = '185';
const EXPECTED_PACKAGE_VERSION = '0.185.1';
const MIN_FRAME_ADVANCE = 8;
let atomicWriteCounter = 0;

function usage() {
  console.log(`Usage: node tools/webgpu/smoke-production-backends.mjs [options]

Options:
  --webgl-only       Run only forced WebGL 2.
  --webgpu-only      Run only forced software WebGPU.
  --headed           Show Chromium.
  --port <port>      Static server port; 0 selects a free port (default 0).
  --origin <url>     Use an existing static server instead of starting one.
  --output <dir>     Save menu/canvas PNGs plus report.json and report.md.
  --help             Print this help.
`);
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
      config.webgl = true;
      config.webgpu = false;
    } else if (arg === '--webgpu-only') {
      config.webgl = false;
      config.webgpu = true;
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
    throw new Error(`Playwright is unavailable at ${playwrightPath}.`);
  }
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
});

async function startServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
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
        'cross-origin-resource-policy': 'same-origin',
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

function writeFileAtomic(filePath, data) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${atomicWriteCounter++}`;
  fs.writeFileSync(temporaryPath, data);
  fs.renameSync(temporaryPath, filePath);
}

function serializeError(error) {
  return error?.stack || error?.message || String(error);
}

function analyzePng(buffer) {
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(buffer);
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let visiblePixels = 0;
  const quantizedColors = new Set();
  const pixels = png.width * png.height;

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const alpha = png.data[index + 3];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;
    if (alpha > 8 && luminance > 3) visiblePixels += 1;
    if (quantizedColors.size <= 8192) {
      quantizedColors.add(`${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 5}`);
    }
  }

  const meanLuminance = luminanceSum / pixels;
  const variance = Math.max(0, luminanceSquaredSum / pixels - meanLuminance * meanLuminance);
  return {
    width: png.width,
    height: png.height,
    meanLuminance: Number(meanLuminance.toFixed(3)),
    luminanceStdDev: Number(Math.sqrt(variance).toFixed(3)),
    visiblePixelRatio: Number((visiblePixels / pixels).toFixed(5)),
    quantizedColorCount: quantizedColors.size,
  };
}

function addCheck(failures, condition, message) {
  if (!condition) failures.push(message);
}

function isLocalUrl(candidate, origin) {
  try { return new URL(candidate, origin).origin === new URL(origin).origin; }
  catch (_) { return false; }
}

async function inspectProductionState(page) {
  return page.evaluate(async (minimumFrames) => {
    const service = window.__kkRendererService;
    const renderer = service?.renderer;
    const diagnostics = await Promise.resolve(service?.getDiagnostics?.() || null);
    const capabilities = service?.getCapabilities?.() || null;
    const mainCanvas = document.getElementById('game-canvas');
    const before = window.__kkMainLoop?.snapshot?.() || null;

    await new Promise((resolve) => {
      let frames = 0;
      const deadline = performance.now() + 20_000;
      const tick = () => {
        frames += 1;
        const current = window.__kkMainLoop?.snapshot?.();
        const advanced = before && current
          ? current.frameCount - before.frameCount
          : frames;
        if (advanced >= minimumFrames || performance.now() >= deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const after = window.__kkMainLoop?.snapshot?.() || null;
    const three = await import('three');
    const threeWebGPU = await import('three/webgpu');
    let packageVersion = null;
    try {
      const response = await fetch('./vendor/three/package.json', { cache: 'no-store' });
      if (response.ok) packageVersion = (await response.json()).version || null;
    } catch (_) {}

    const backendObject = renderer?.backend;
    const backendFlags = {
      webgpu: backendObject?.isWebGPUBackend === true,
      webgl: backendObject?.isWebGLBackend === true,
      webgpuDevice: backendObject?.isWebGPUBackend === true ? Boolean(backendObject.device) : null,
      webgl2Context: backendObject?.isWebGLBackend === true
        ? (typeof WebGL2RenderingContext !== 'undefined'
          && backendObject.gl instanceof WebGL2RenderingContext)
        : null,
    };
    const menu = document.querySelector('.kkv2-root');
    const menuStage = document.querySelector('.kkv2-stage');
    const activeMenuItem = document.querySelector('.kkv2-navitem.is-active');
    const menuRect = menu?.getBoundingClientRect() || null;
    const canvasRect = mainCanvas?.getBoundingClientRect() || null;
    const canvasStyle = mainCanvas ? getComputedStyle(mainCanvas) : null;
    const allCanvases = [...document.querySelectorAll('canvas')];
    const mainCanvasCount = document.querySelectorAll('canvas#game-canvas').length;
    const directStageCanvases = [...document.querySelectorAll('#kk-stage > canvas')];
    const fullStageCanvases = directStageCanvases.filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return canvas === mainCanvas
        || (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8);
    });
    const rendererSizedCanvases = allCanvases.filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return canvas === mainCanvas
        || (canvas.width === mainCanvas?.width && canvas.height === mainCanvas?.height)
        || (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8);
    });
    const renderInfo = renderer?.info?.render || {};
    const runtimeErrors = window.__kkProductionBackendSmokeErrors || { errors: [], rejections: [] };
    const rendererFrameCapture = {
      ok: false,
      type: null,
      bytes: 0,
      width: 0,
      height: 0,
      meanLuminance: 0,
      luminanceStdDev: 0,
      quantizedColorCount: 0,
      error: null,
    };
    try {
      const blob = await service.captureFrame({ render: true });
      rendererFrameCapture.type = blob?.type || null;
      rendererFrameCapture.bytes = blob?.size || 0;
      const bitmap = await createImageBitmap(blob);
      rendererFrameCapture.width = bitmap.width;
      rendererFrameCapture.height = bitmap.height;
      const scratch = document.createElement('canvas');
      scratch.width = bitmap.width;
      scratch.height = bitmap.height;
      const context = scratch.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
      let sum = 0;
      let squared = 0;
      let count = 0;
      const colors = new Set();
      // Sampling every fourth pixel keeps the production smoke inexpensive
      // while still rejecting transparent/solid/black readbacks.
      for (let index = 0; index < pixels.length; index += 16) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        sum += luminance;
        squared += luminance * luminance;
        count += 1;
        if (colors.size <= 8192) colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
      }
      const mean = count ? sum / count : 0;
      const variance = count ? Math.max(0, squared / count - mean * mean) : 0;
      rendererFrameCapture.meanLuminance = Number(mean.toFixed(3));
      rendererFrameCapture.luminanceStdDev = Number(Math.sqrt(variance).toFixed(3));
      rendererFrameCapture.quantizedColorCount = colors.size;
      rendererFrameCapture.ok = true;
    } catch (error) {
      rendererFrameCapture.error = error?.stack || error?.message || String(error);
    }

    return {
      serviceState: service?.state || null,
      requestedBackend: diagnostics?.requestedBackend || null,
      actualBackend: service?.backend || diagnostics?.backend || null,
      diagnostics,
      capabilities,
      rendererIsWebGPURenderer: renderer?.isWebGPURenderer === true,
      rendererInitialized: typeof renderer?.hasInitialized === 'function'
        ? renderer.hasInitialized()
        : null,
      backendFlags,
      revisions: {
        three: three.REVISION || null,
        threeWebGPU: threeWebGPU.REVISION || null,
        packageVersion,
        oneModuleUniverse: three.Scene === threeWebGPU.Scene
          && three.WebGPURenderer === threeWebGPU.WebGPURenderer,
      },
      loop: {
        before,
        after,
        frameAdvance: before && after ? after.frameCount - before.frameCount : 0,
      },
      renderInfo: {
        drawCalls: Number(renderInfo.drawCalls ?? renderInfo.calls ?? 0),
        frameCalls: Number(renderInfo.frameCalls ?? 0),
        renderCalls: Number(renderInfo.calls ?? 0),
        triangles: Number(renderInfo.triangles ?? 0),
      },
      canvas: {
        mainCanvasCount,
        directStageCanvasCount: directStageCanvases.length,
        fullStageCanvasCount: fullStageCanvases.length,
        rendererSizedCanvasCount: rendererSizedCanvases.length,
        rendererOwnsMainCanvas: renderer?.domElement === mainCanvas && service?.canvas === mainCanvas,
        width: mainCanvas?.width || 0,
        height: mainCanvas?.height || 0,
        cssWidth: canvasRect?.width || 0,
        cssHeight: canvasRect?.height || 0,
        display: canvasStyle?.display || null,
        visibility: canvasStyle?.visibility || null,
        totalDocumentCanvasCount: allCanvases.length,
        auxiliaryCanvases: allCanvases
          .filter((canvas) => canvas !== mainCanvas)
          .map((canvas) => ({
            id: canvas.id || null,
            className: typeof canvas.className === 'string' ? canvas.className : null,
            width: canvas.width,
            height: canvas.height,
          })),
      },
      menu: {
        present: Boolean(menu && menuStage),
        visible: Boolean(menuRect && menuRect.width > 100 && menuRect.height > 100),
        activeItem: activeMenuItem?.textContent?.trim() || null,
        navItemCount: document.querySelectorAll('.kkv2-navitem').length,
        textLength: menu?.textContent?.trim().length || 0,
        bootLoaderPresent: Boolean(document.getElementById('kk-boot-loader')),
      },
      rendererFrameCapture,
      runtimeErrors: JSON.parse(JSON.stringify(runtimeErrors)),
    };
  }, MIN_FRAME_ADVANCE);
}

async function validateCase(browser, origin, requestedBackend, launchProfile, outputDirectory) {
  const failures = [];
  const consoleErrors = [];
  const failedRequests = [];
  const successfulLocalResponses = new Set();
  let state = null;
  let pageImage = null;
  let canvasImage = null;
  let pageScreenshot = null;
  let canvasScreenshot = null;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  // Keep the smoke deterministic and offline. Fonts are decorative; returning
  // an empty stylesheet avoids treating unavailable Google Fonts as a renderer
  // failure while every production-local resource remains strict.
  await context.route(/^https:\/\/fonts\.googleapis\.com\//, (route) => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '/* production backend smoke: use local fallbacks */',
  }));
  await context.addInitScript(() => {
    window.__kkProductionBackendSmokeErrors = { errors: [], rejections: [] };
    window.addEventListener('error', (event) => {
      window.__kkProductionBackendSmokeErrors.errors.push({
        message: event.message || 'window error',
        source: event.filename || null,
        line: event.lineno || null,
        column: event.colno || null,
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__kkProductionBackendSmokeErrors.rejections.push({
        name: reason?.name || null,
        message: reason?.message || String(reason),
        stack: reason?.stack || null,
      });
    });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => {
    consoleErrors.push({ type: 'pageerror', text: error.message, url: page.url() });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    consoleErrors.push({
      type: 'console',
      text: message.text(),
      url: location.url || page.url(),
      line: location.lineNumber ?? null,
      column: location.columnNumber ?? null,
    });
  });
  page.on('requestfailed', (request) => {
    if (!isLocalUrl(request.url(), origin)) return;
    failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'failed' });
  });
  page.on('response', (response) => {
    if (!isLocalUrl(response.url(), origin)) return;
    if (response.status() < 400) successfulLocalResponses.add(response.url());
    else {
      failedRequests.push({ url: response.url(), error: `HTTP ${response.status()}` });
    }
  });

  const url = new URL('index.html', origin);
  url.searchParams.set('renderer', requestedBackend);
  url.searchParams.set('rendererDiagnostics', '1');

  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => window.__kkRendererService?.state === 'ready'
        && window.__kkMainLoop?.snapshot?.().running === true
        && document.querySelector('.kkv2-root')
        && !document.getElementById('kk-boot-loader'),
      null,
      { timeout: 180_000 },
    );
    state = await inspectProductionState(page);

    addCheck(failures, state.serviceState === 'ready',
      `renderer service is ${state.serviceState || 'missing'}, not ready`);
    addCheck(failures, state.requestedBackend === requestedBackend,
      `requested backend state is ${state.requestedBackend}, expected ${requestedBackend}`);
    addCheck(failures, state.actualBackend === requestedBackend,
      `actual backend is ${state.actualBackend}, expected ${requestedBackend}`);
    addCheck(failures, state.rendererIsWebGPURenderer,
      'production renderer is not THREE.WebGPURenderer');
    addCheck(failures, state.rendererInitialized === true && state.capabilities?.initialized === true,
      'renderer did not report successful asynchronous initialization');
    addCheck(failures,
      state.revisions.three === EXPECTED_REVISION
        && state.revisions.threeWebGPU === EXPECTED_REVISION,
      `runtime Three.js revision is ${state.revisions.three}/${state.revisions.threeWebGPU}, expected r${EXPECTED_REVISION}`);
    addCheck(failures, state.revisions.packageVersion === EXPECTED_PACKAGE_VERSION,
      `vendored package is ${state.revisions.packageVersion}, expected ${EXPECTED_PACKAGE_VERSION}`);
    addCheck(failures, state.revisions.oneModuleUniverse,
      'three and three/webgpu do not share one object universe');
    addCheck(failures, state.backendFlags.webgpu !== state.backendFlags.webgl,
      `backend flags are ambiguous: ${JSON.stringify(state.backendFlags)}`);
    if (requestedBackend === 'webgpu') {
      addCheck(failures, state.backendFlags.webgpu && state.backendFlags.webgpuDevice === true,
        'forced WebGPU has no initialized GPUDevice');
    } else {
      addCheck(failures, state.backendFlags.webgl && state.backendFlags.webgl2Context === true,
        'forced fallback did not initialize a WebGL2RenderingContext');
      addCheck(failures, state.capabilities?.forceWebGL === true,
        'forced WebGL preference did not reach the WebGPURenderer backend');
    }

    const loop = state.loop.after;
    addCheck(failures, loop?.running === true, 'main animation loop is not running');
    addCheck(failures, loop?.owner === 'renderer.setAnimationLoop',
      `main loop owner is ${loop?.owner || 'missing'}`);
    addCheck(failures, loop?.startCount === 1,
      `main animation loop started ${loop?.startCount ?? 'unknown'} times`);
    addCheck(failures, loop?.duplicateTimestampCount === 0,
      `main animation loop observed ${loop?.duplicateTimestampCount ?? 'unknown'} duplicate timestamps`);
    addCheck(failures, state.loop.frameAdvance >= MIN_FRAME_ADVANCE,
      `main animation loop advanced only ${state.loop.frameAdvance}/${MIN_FRAME_ADVANCE} frames`);

    addCheck(failures, state.canvas.mainCanvasCount === 1,
      `found ${state.canvas.mainCanvasCount} #game-canvas elements`);
    addCheck(failures, state.canvas.fullStageCanvasCount === 1,
      `found ${state.canvas.fullStageCanvasCount} full-stage renderer-sized canvases`);
    addCheck(failures, state.canvas.rendererSizedCanvasCount === 1,
      `found ${state.canvas.rendererSizedCanvasCount} production-renderer-sized canvases`);
    addCheck(failures, state.canvas.rendererOwnsMainCanvas,
      'renderer service and renderer do not own the production #game-canvas');
    addCheck(failures, state.canvas.width > 100 && state.canvas.height > 100
      && state.canvas.cssWidth > 100 && state.canvas.cssHeight > 100,
    `production canvas has invalid dimensions ${state.canvas.width}x${state.canvas.height}`);
    addCheck(failures, state.canvas.display !== 'none' && state.canvas.visibility !== 'hidden',
      'production canvas is hidden');
    addCheck(failures, state.renderInfo.drawCalls > 0 && state.renderInfo.renderCalls > 0,
      `renderer submitted no visible work: ${JSON.stringify(state.renderInfo)}`);
    addCheck(failures,
      state.rendererFrameCapture?.ok === true
        && state.rendererFrameCapture.type === 'image/png'
        && state.rendererFrameCapture.bytes > 1000,
      `renderer captureFrame failed: ${JSON.stringify(state.rendererFrameCapture)}`);
    addCheck(failures,
      state.rendererFrameCapture?.width === state.canvas.width
        && state.rendererFrameCapture?.height === state.canvas.height,
      `renderer capture dimensions do not match the canvas: ${JSON.stringify(state.rendererFrameCapture)}`);
    addCheck(failures,
      state.rendererFrameCapture?.meanLuminance > 1
        && state.rendererFrameCapture?.luminanceStdDev > 1
        && state.rendererFrameCapture?.quantizedColorCount > 8,
      `renderer captureFrame is blank or flat: ${JSON.stringify(state.rendererFrameCapture)}`);

    addCheck(failures, state.menu.present && state.menu.visible,
      'production menu did not mount visibly');
    addCheck(failures, state.menu.navItemCount >= 8 && state.menu.textLength >= 80,
      `production menu is incomplete: ${JSON.stringify(state.menu)}`);
    addCheck(failures, /Embark/i.test(state.menu.activeItem || ''),
      `unexpected active menu item: ${state.menu.activeItem || 'missing'}`);
    addCheck(failures, state.menu.bootLoaderPresent === false,
      'boot loader still covers the production menu');
  } catch (error) {
    failures.push(`startup inspection failed: ${serializeError(error)}`);
  }

  try {
    const png = await page.screenshot({ type: 'png', fullPage: false });
    pageImage = analyzePng(png);
    addCheck(failures, pageImage.meanLuminance > 8 && pageImage.luminanceStdDev > 6
      && pageImage.quantizedColorCount > 32 && pageImage.visiblePixelRatio > 0.2,
    `production menu capture is blank or flat: ${JSON.stringify(pageImage)}`);
    if (outputDirectory) {
      const screenshotPath = path.join(outputDirectory, `${requestedBackend}-menu.png`);
      writeFileAtomic(screenshotPath, png);
      pageScreenshot = path.relative(ROOT, screenshotPath).replaceAll(path.sep, '/');
    }
  } catch (error) {
    failures.push(`menu screenshot failed: ${serializeError(error)}`);
  }

  try {
    const canvas = page.locator('#game-canvas');
    if (await canvas.count() === 1) {
      const png = await canvas.screenshot({ type: 'png' });
      canvasImage = analyzePng(png);
      addCheck(failures, canvasImage.meanLuminance > 1
        && canvasImage.visiblePixelRatio > 0.05
        && canvasImage.quantizedColorCount > 8,
      `production canvas capture is blank: ${JSON.stringify(canvasImage)}`);
      if (outputDirectory) {
        const screenshotPath = path.join(outputDirectory, `${requestedBackend}-game-canvas.png`);
        writeFileAtomic(screenshotPath, png);
        canvasScreenshot = path.relative(ROOT, screenshotPath).replaceAll(path.sep, '/');
      }
    } else {
      failures.push('could not capture the unique #game-canvas');
    }
  } catch (error) {
    failures.push(`canvas screenshot failed: ${serializeError(error)}`);
  }

  try {
    const finalRuntimeErrors = await page.evaluate(() => JSON.parse(JSON.stringify(
      window.__kkProductionBackendSmokeErrors || { errors: [], rejections: [] },
    )));
    if (state) state.runtimeErrors = finalRuntimeErrors;
    addCheck(failures, finalRuntimeErrors.errors.length === 0,
      `window errors: ${JSON.stringify(finalRuntimeErrors.errors)}`);
    addCheck(failures, finalRuntimeErrors.rejections.length === 0,
      `unhandled rejections: ${JSON.stringify(finalRuntimeErrors.rejections)}`);
  } catch (error) {
    failures.push(`could not read final runtime-error state: ${serializeError(error)}`);
  }

  const localConsoleErrors = consoleErrors.filter((row) => (
    row.type === 'pageerror'
    || isLocalUrl(row.url, origin)
    || /(?:webgpu|webgl|renderer|rendering|shader|pipeline|wgsl|glsl|gpu validation)/i.test(row.text)
  ));
  // GLTFLoader can complete a 200 response and then cancel a redundant stream
  // consumer. That transport-level ERR_ABORTED is harmless only when this run
  // observed a successful response for the exact same URL; 4xx/5xx responses
  // and every other local request failure remain fatal.
  const ignoredRequestFailures = failedRequests.filter((failure) => (
    failure.error === 'net::ERR_ABORTED' && successfulLocalResponses.has(failure.url)
  ));
  const actionableRequestFailures = failedRequests.filter(
    (failure) => !ignoredRequestFailures.includes(failure),
  );
  addCheck(failures, localConsoleErrors.length === 0,
    `browser/render console errors: ${JSON.stringify(localConsoleErrors)}`);
  addCheck(failures, actionableRequestFailures.length === 0,
    `production-local request failures: ${JSON.stringify(actionableRequestFailures)}`);

  await context.close();
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    launchProfile,
    requestedBackend,
    actualBackend: state?.actualBackend || null,
    revision: state?.revisions?.three || null,
    packageVersion: state?.revisions?.packageVersion || null,
    serviceState: state?.serviceState || null,
    diagnostics: state?.diagnostics || null,
    capabilities: state?.capabilities || null,
    loop: state?.loop || null,
    renderInfo: state?.renderInfo || null,
    rendererCapture: state?.rendererFrameCapture || null,
    canvas: state?.canvas || null,
    menu: state?.menu || null,
    image: { menu: pageImage, canvas: canvasImage },
    screenshots: { menu: pageScreenshot, canvas: canvasScreenshot },
    consoleErrors,
    failedRequests,
    ignoredRequestFailures,
    failures,
  };
}

const DEFAULT_BROWSER_ARGS = Object.freeze([
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
]);

function launch(chromium, chromiumPath, headed, args) {
  return chromium.launch({
    headless: !headed,
    executablePath: chromiumPath || undefined,
    args,
  });
}

function markdownReport(report) {
  const lines = [
    '# Production backend smoke evidence',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '| Requested | Actual | Three.js | Service | Frames | Draw calls | `captureFrame()` | Menu image | Result |',
    '| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |',
  ];
  for (const entry of report.cases) {
    const menuEvidence = entry.screenshots?.menu
      ? `[menu](${path.basename(entry.screenshots.menu)})`
      : 'not saved';
    const rendererCapture = entry.rendererCapture?.ok
      ? `${entry.rendererCapture.width}x${entry.rendererCapture.height}, ${entry.rendererCapture.bytes} B`
      : 'failed';
    lines.push(`| ${entry.requestedBackend} | ${entry.actualBackend || 'unknown'} | ${entry.packageVersion || 'unknown'} (r${entry.revision || '?'}) | ${entry.serviceState || 'unknown'} | ${entry.loop?.frameAdvance ?? 0} | ${entry.renderInfo?.drawCalls ?? 0} | ${rendererCapture} | ${menuEvidence} | ${entry.status.toUpperCase()} |`);
  }
  lines.push('', 'Validated contracts:', '');
  lines.push(
    '- Production `index.html` boots through the renderer service on each explicitly requested backend.',
    '- Runtime imports resolve to the pinned Three.js 0.185.1 / r185 module universe.',
    '- The main game loop has one `renderer.setAnimationLoop` owner and advances without duplicate timestamps.',
    '- The renderer owns one production `#game-canvas`; the menu hero preview remains an allowed auxiliary canvas.',
    '- The production menu and rendered canvas contain visible, nonblank output.',
    '- The renderer service returns a decoded, nonblank, canvas-sized PNG through `captureFrame()`.',
    '- Page errors, unhandled rejections, render-console errors, and actionable local resource failures are fatal.',
  );
  const failed = report.cases.filter((entry) => entry.status !== 'passed');
  if (failed.length) {
    lines.push('## Failures', '');
    for (const entry of failed) {
      lines.push(`### ${entry.requestedBackend}`, '');
      for (const failure of entry.failures) lines.push(`- ${failure}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function runBrowserCase({ chromium, chromiumPath, config, origin, backend, args, profile, outputDirectory }) {
  let browser = null;
  try {
    browser = await launch(chromium, chromiumPath, config.headed, args);
    return await validateCase(browser, origin, backend, profile, outputDirectory);
  } catch (error) {
    return {
      status: 'failed',
      launchProfile: profile,
      requestedBackend: backend,
      actualBackend: null,
      failures: [`browser case failed: ${serializeError(error)}`],
    };
  } finally {
    if (browser) await browser.close();
  }
}

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

  const report = {
    schemaVersion: 1,
    entrypoint: 'index.html',
    generatedAt: new Date().toISOString(),
    expectedThree: { packageVersion: EXPECTED_PACKAGE_VERSION, revision: EXPECTED_REVISION },
    chromium: chromiumPath || 'playwright-managed',
    origin,
    cases: [],
  };

  try {
    if (config.webgl) {
      report.cases.push(await runBrowserCase({
        chromium,
        chromiumPath,
        config,
        origin,
        backend: 'webgl',
        args: DEFAULT_BROWSER_ARGS,
        profile: 'default-webgl2',
        outputDirectory,
      }));
    }
    if (config.webgpu) {
      report.cases.push(await runBrowserCase({
        chromium,
        chromiumPath,
        config,
        origin,
        backend: 'webgpu',
        args: SOFTWARE_WEBGPU_ARGS,
        profile: 'software-webgpu',
        outputDirectory,
      }));
    }

    if (outputDirectory) {
      writeFileAtomic(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileAtomic(path.join(outputDirectory, 'report.md'), markdownReport(report));
    }
    console.log(JSON.stringify(report, null, 2));

    const failed = report.cases.filter((entry) => entry.status !== 'passed');
    if (failed.length) {
      throw new Error(`${failed.length}/${report.cases.length} production backend smoke case(s) failed: ${failed.map((entry) => entry.requestedBackend).join(', ')}`);
    }
    console.log(`PASS: ${report.cases.length} production backend smoke case(s).`);
  } finally {
    if (ownedServer) await new Promise((resolve) => ownedServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(`FAIL: ${serializeError(error)}`);
  process.exitCode = 1;
});
