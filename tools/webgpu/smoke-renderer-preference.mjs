#!/usr/bin/env node
/**
 * Focused production smoke for the persisted renderer selector.
 *
 * The two contracts intentionally use separate Chromium launches:
 *   1. A saved `webgl` preference with no `?renderer=` query boots the forced
 *      WebGL 2 backend.
 *   2. `?renderer=webgpu` overrides that same saved preference and boots a real
 *      WebGPU device through the Vulkan SwiftShader profile.
 *
 * The WebGPU case also opens the production Options > Display UI and verifies
 * the advanced selector, all three choices, and the visible URL-override hint.
 *
 * Environment overrides match the other WebGPU production smokes:
 *   KK_WEBGPU_SMOKE_PLAYWRIGHT=/path/to/playwright
 *   KK_WEBGPU_SMOKE_CHROMIUM=/path/to/chrome
 *   KK_WEBGPU_SMOKE_ORIGIN=http://127.0.0.1:8080/
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resolveChromiumArgs } from './chromiumProfiles.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIN_FRAME_ADVANCE = 4;

const CASES = Object.freeze([
  Object.freeze({
    id: 'saved-webgl-no-query',
    launchBackend: 'webgl',
    queryBackend: null,
    expectedRequested: 'webgl',
    expectedActual: 'webgl',
    inspectSettings: false,
  }),
  Object.freeze({
    id: 'query-webgpu-overrides-saved-webgl',
    launchBackend: 'webgpu',
    queryBackend: 'webgpu',
    expectedRequested: 'webgpu',
    expectedActual: 'webgpu',
    inspectSettings: true,
  }),
]);

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
  '.woff2': 'font/woff2',
});

function usage() {
  console.log(`Usage: node tools/webgpu/smoke-renderer-preference.mjs [options]

Options:
  --headed        Show Chromium.
  --port <port>   Static server port; 0 selects a free port (default 0).
  --origin <url>  Use an existing static server instead of starting one.
  --output <file> Write the JSON evidence report.
  --help          Print this help.
`);
}

function parseArgs(argv) {
  const config = {
    headed: false,
    port: 0,
    origin: process.env.KK_WEBGPU_SMOKE_ORIGIN || null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headed') config.headed = true;
    else if (argument === '--port') {
      config.port = Number(argv[++index]);
      if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw new Error('--port must be an integer from 0 through 65535.');
      }
    } else if (argument === '--origin') {
      config.origin = argv[++index];
      if (!config.origin) throw new Error('--origin requires a URL.');
    } else if (argument === '--output') {
      config.output = argv[++index];
      if (!config.output) throw new Error('--output requires a file path.');
    } else if (argument === '--help') {
      usage();
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
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

async function startServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(
        requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname,
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

function isLocalUrl(candidate, origin) {
  try { return new URL(candidate, origin).origin === new URL(origin).origin; }
  catch (_) { return false; }
}

function serializeError(error) {
  return error?.stack || error?.message || String(error);
}

function check(failures, condition, message) {
  if (!condition) failures.push(message);
}

async function installProductionHardening(context, origin, evidence) {
  await context.route(/^https:\/\/fonts\.googleapis\.com\//, (route) => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '/* renderer preference smoke: use deterministic local font fallbacks */',
  }));
  await context.addInitScript(() => {
    try {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        localStorage.removeItem('kk-survivors-meta-v1');
        localStorage.setItem('kk-survivors-meta-v2', JSON.stringify({
          version: 1,
          migrationVersion: 2,
          optRenderer: 'webgl',
          optMusic: false,
          optMenuMusicMuted: true,
          optReduceMotion: true,
          optReduceMotionUserSet: true,
        }));
        localStorage.setItem('kks_introSeen', '1');
        localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      }
    } catch (error) {
      globalThis.__kkRendererPreferenceSeedError = error?.message || String(error);
    }
    globalThis.__kkRendererPreferenceSmokeErrors = { errors: [], rejections: [] };
    addEventListener('error', (event) => {
      globalThis.__kkRendererPreferenceSmokeErrors.errors.push({
        message: event.message || 'window error',
        source: event.filename || null,
        line: event.lineno || null,
      });
    });
    addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      globalThis.__kkRendererPreferenceSmokeErrors.rejections.push({
        name: reason?.name || null,
        message: reason?.message || String(reason),
        stack: reason?.stack || null,
      });
    });
  });

  evidence.page = await context.newPage();
  evidence.page.on('pageerror', (error) => {
    evidence.consoleErrors.push({ type: 'pageerror', text: error.message, url: evidence.page.url() });
  });
  evidence.page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    evidence.consoleErrors.push({
      type: 'console',
      text: message.text(),
      url: location.url || evidence.page.url(),
      line: location.lineNumber ?? null,
    });
  });
  evidence.page.on('requestfailed', (request) => {
    if (!isLocalUrl(request.url(), origin)) return;
    evidence.failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText || 'failed',
    });
  });
  evidence.page.on('response', (response) => {
    if (!isLocalUrl(response.url(), origin)) return;
    if (response.status() < 400) evidence.successfulLocalResponses.add(response.url());
    else evidence.failedRequests.push({ url: response.url(), error: `HTTP ${response.status()}` });
  });
}

async function inspectProductionBoot(page) {
  return page.evaluate(async (minimumFrames) => {
    const service = globalThis.__kkRendererService;
    const renderer = service?.renderer;
    const before = globalThis.__kkMainLoop?.snapshot?.() || null;
    await new Promise((resolve) => {
      const deadline = performance.now() + 20_000;
      const tick = () => {
        const current = globalThis.__kkMainLoop?.snapshot?.();
        if ((before && current && current.frameCount - before.frameCount >= minimumFrames)
          || performance.now() >= deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const after = globalThis.__kkMainLoop?.snapshot?.() || null;
    const diagnostics = service?.getDiagnostics?.() || null;
    const capabilities = service?.getCapabilities?.() || null;
    const backend = renderer?.backend;
    const renderInfo = renderer?.info?.render || {};
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('kk-survivors-meta-v2') || 'null'); }
    catch (_) {}
    return {
      serviceState: service?.state || null,
      requestedBackend: diagnostics?.requestedBackend || null,
      actualBackend: service?.backend || diagnostics?.backend || null,
      rendererIsWebGPURenderer: renderer?.isWebGPURenderer === true,
      initialized: typeof renderer?.hasInitialized === 'function'
        ? renderer.hasInitialized()
        : capabilities?.initialized === true,
      backendFlags: {
        webgpu: backend?.isWebGPUBackend === true,
        webgl: backend?.isWebGLBackend === true,
        webgpuDevice: backend?.isWebGPUBackend === true ? Boolean(backend.device) : null,
        webgl2Context: backend?.isWebGLBackend === true
          ? (typeof WebGL2RenderingContext !== 'undefined'
            && backend.gl instanceof WebGL2RenderingContext)
          : null,
      },
      forceWebGL: capabilities?.forceWebGL === true,
      navigatorGpu: Boolean(navigator.gpu),
      savedRenderer: saved?.optRenderer || null,
      seedError: globalThis.__kkRendererPreferenceSeedError || null,
      loop: {
        before,
        after,
        frameAdvance: before && after ? after.frameCount - before.frameCount : 0,
      },
      renderInfo: {
        drawCalls: Number(renderInfo.drawCalls ?? renderInfo.calls ?? 0),
        triangles: Number(renderInfo.triangles ?? 0),
      },
      menuVisible: Boolean(document.querySelector('.kkv2-root')),
      bootLoaderPresent: Boolean(document.getElementById('kk-boot-loader')),
      urlHasRendererOverride: new URL(location.href).searchParams.has('renderer'),
    };
  }, MIN_FRAME_ADVANCE);
}

async function inspectAdvancedDisplaySettings(page) {
  const settingsButton = page.locator('.kkv2-iconbtn[aria-label="Settings"]');
  await settingsButton.waitFor({ state: 'visible', timeout: 20_000 });
  await settingsButton.click();
  const dialog = page.locator('[role="dialog"][aria-label="Options"]');
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  await dialog.getByRole('tab', { name: 'Display', exact: true }).click();

  const rendererSelect = dialog.locator('select[aria-label="Renderer backend"]');
  await rendererSelect.waitFor({ state: 'visible', timeout: 10_000 });
  const selectState = await rendererSelect.evaluate((select) => ({
    value: select.value,
    options: [...select.options].map((option) => ({
      value: option.value,
      label: option.textContent?.trim() || '',
    })),
  }));
  const hint = dialog.getByText(/URL override active \(webgpu\)/i);
  return {
    advancedLabelVisible: await dialog.getByText('Renderer · Advanced', { exact: true }).isVisible(),
    applyButtonVisible: await dialog.getByRole('button', { name: 'Apply & Reload', exact: true }).isVisible(),
    overrideHintVisible: await hint.isVisible(),
    overrideHintText: (await hint.textContent())?.trim() || '',
    ...selectState,
  };
}

async function finishHardening(page, origin, evidence, failures) {
  const runtime = await page.evaluate(() => ({
    seedError: globalThis.__kkRendererPreferenceSeedError || null,
    runtime: JSON.parse(JSON.stringify(
      globalThis.__kkRendererPreferenceSmokeErrors || { errors: [], rejections: [] },
    )),
  }));
  check(failures, !runtime.seedError, `save seed failed: ${runtime.seedError}`);
  check(failures, runtime.runtime.errors.length === 0,
    `window errors: ${JSON.stringify(runtime.runtime.errors)}`);
  check(failures, runtime.runtime.rejections.length === 0,
    `unhandled rejections: ${JSON.stringify(runtime.runtime.rejections)}`);

  const actionableConsoleErrors = evidence.consoleErrors.filter((entry) => (
    entry.type === 'pageerror'
    || isLocalUrl(entry.url, origin)
    || /(?:webgpu|webgl|renderer|shader|pipeline|wgsl|glsl|gpu validation)/i.test(entry.text)
  ));
  const ignoredRequestFailures = evidence.failedRequests.filter((failure) => (
    failure.error === 'net::ERR_ABORTED'
      && evidence.successfulLocalResponses.has(failure.url)
  ));
  const actionableRequestFailures = evidence.failedRequests.filter(
    (failure) => !ignoredRequestFailures.includes(failure),
  );
  check(failures, actionableConsoleErrors.length === 0,
    `browser/render console errors: ${JSON.stringify(actionableConsoleErrors)}`);
  check(failures, actionableRequestFailures.length === 0,
    `production-local request failures: ${JSON.stringify(actionableRequestFailures)}`);
  return { runtime, actionableConsoleErrors, actionableRequestFailures };
}

async function runCase({ chromium, chromiumPath, config, origin, definition }) {
  const failures = [];
  const launchArgs = resolveChromiumArgs(
    definition.launchBackend,
    process.env[`KK_RENDERER_PREFERENCE_${definition.launchBackend.toUpperCase()}_ARGS`],
  );
  let browser = null;
  let context = null;
  const evidence = {
    page: null,
    consoleErrors: [],
    failedRequests: [],
    successfulLocalResponses: new Set(),
  };
  let boot = null;
  let settings = null;
  let hardening = null;

  try {
    browser = await chromium.launch({
      headless: !config.headed,
      executablePath: chromiumPath || undefined,
      args: launchArgs,
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    await installProductionHardening(context, origin, evidence);
    const url = new URL('index.html', origin);
    url.searchParams.set('rendererDiagnostics', '1');
    if (definition.queryBackend) url.searchParams.set('renderer', definition.queryBackend);

    await evidence.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await evidence.page.waitForFunction(
      () => globalThis.__kkRendererService?.state === 'ready'
        && globalThis.__kkMainLoop?.snapshot?.().running === true
        && document.querySelector('.kkv2-root')
        && !document.getElementById('kk-boot-loader'),
      null,
      { timeout: 180_000 },
    );
    boot = await inspectProductionBoot(evidence.page);

    check(failures, boot.serviceState === 'ready',
      `renderer service is ${boot.serviceState || 'missing'}, not ready`);
    check(failures, boot.requestedBackend === definition.expectedRequested,
      `requested backend is ${boot.requestedBackend}, expected ${definition.expectedRequested}`);
    check(failures, boot.actualBackend === definition.expectedActual,
      `actual backend is ${boot.actualBackend}, expected ${definition.expectedActual}`);
    check(failures, boot.savedRenderer === 'webgl',
      `persisted preference changed to ${boot.savedRenderer}, expected webgl`);
    check(failures, boot.rendererIsWebGPURenderer && boot.initialized,
      'production did not initialize THREE.WebGPURenderer');
    check(failures, boot.loop.frameAdvance >= MIN_FRAME_ADVANCE,
      `main loop advanced ${boot.loop.frameAdvance}/${MIN_FRAME_ADVANCE} frames`);
    check(failures, boot.renderInfo.drawCalls > 0 && boot.renderInfo.triangles > 0,
      `production submitted no visible work: ${JSON.stringify(boot.renderInfo)}`);
    check(failures, boot.menuVisible && !boot.bootLoaderPresent,
      'production menu is missing or still covered by the boot loader');
    check(failures, boot.urlHasRendererOverride === Boolean(definition.queryBackend),
      `renderer query presence did not match case ${definition.id}`);

    if (definition.expectedActual === 'webgl') {
      check(failures, boot.backendFlags.webgl && boot.backendFlags.webgl2Context,
        `saved webgl did not produce WebGL 2: ${JSON.stringify(boot.backendFlags)}`);
      check(failures, boot.forceWebGL,
        'saved webgl did not reach WebGPURenderer forceWebGL');
    } else {
      check(failures, boot.navigatorGpu && boot.backendFlags.webgpu && boot.backendFlags.webgpuDevice,
        `query override did not initialize a WebGPU GPUDevice: ${JSON.stringify(boot.backendFlags)}`);
      for (const requiredFlag of [
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--use-vulkan=swiftshader',
      ]) {
        check(failures, launchArgs.includes(requiredFlag),
          `WebGPU case omitted Vulkan SwiftShader flag ${requiredFlag}`);
      }
    }

    if (definition.inspectSettings) {
      settings = await inspectAdvancedDisplaySettings(evidence.page);
      check(failures, settings.advancedLabelVisible,
        'Display does not show Renderer · Advanced');
      check(failures, settings.applyButtonVisible,
        'Display does not show Apply & Reload');
      check(failures, settings.overrideHintVisible,
        `URL override hint is not visible: ${settings.overrideHintText}`);
      check(failures, settings.value === 'webgl',
        `selector value is ${settings.value}, expected saved webgl`);
      check(failures,
        JSON.stringify(settings.options.map((option) => option.value))
          === JSON.stringify(['auto', 'webgpu', 'webgl']),
        `renderer selector values are ${JSON.stringify(settings.options)}`);
    }

    hardening = await finishHardening(evidence.page, origin, evidence, failures);
  } catch (error) {
    failures.push(`case execution failed: ${serializeError(error)}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return {
    id: definition.id,
    status: failures.length ? 'failed' : 'passed',
    savedPreference: 'webgl',
    queryBackend: definition.queryBackend,
    launchBackend: definition.launchBackend,
    launchArgs,
    boot,
    settings,
    hardening: hardening ? {
      runtime: hardening.runtime,
      actionableConsoleErrors: hardening.actionableConsoleErrors,
      actionableRequestFailures: hardening.actionableRequestFailures,
    } : null,
    failures,
  };
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

  const report = {
    schemaVersion: 1,
    entrypoint: 'index.html',
    generatedAt: new Date().toISOString(),
    chromium: chromiumPath || 'playwright-managed',
    origin,
    cases: [],
  };
  try {
    for (const definition of CASES) {
      report.cases.push(await runCase({
        chromium,
        chromiumPath,
        config,
        origin,
        definition,
      }));
    }
  } finally {
    if (ownedServer) await new Promise((resolve) => ownedServer.close(resolve));
  }

  console.log(JSON.stringify(report, null, 2));
  if (config.output) {
    const outputPath = path.resolve(ROOT, config.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const failed = report.cases.filter((entry) => entry.status !== 'passed');
  if (failed.length) {
    throw new Error(
      `${failed.length}/${report.cases.length} renderer preference case(s) failed: ${failed.map((entry) => entry.id).join(', ')}`,
    );
  }
  console.log(`PASS: ${report.cases.length} persisted renderer preference cases.`);
}

main().catch((error) => {
  console.error(`FAIL: ${serializeError(error)}`);
  process.exitCode = 1;
});
