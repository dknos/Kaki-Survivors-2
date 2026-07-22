#!/usr/bin/env node
/**
 * Deterministic renderer-migration capture and metrics harness.
 *
 * Examples:
 *   node tools/webgpu/baseline.mjs --scene stage-forest
 *   node tools/webgpu/baseline.mjs --scene menu --scene forest-horde --samples 180
 *   node tools/webgpu/baseline.mjs --suite viewports
 *   node tools/webgpu/baseline.mjs --all
 *   node tools/webgpu/baseline.mjs --all --resume
 *
 * Shared-tool overrides:
 *   KK_BASELINE_PLAYWRIGHT=/path/to/playwright
 *   KK_BASELINE_CHROMIUM=/path/to/chrome
 *   KK_BASELINE_ORIGIN=http://127.0.0.1:8080/
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  analyzeCanvasRgba,
  collectBaselineValidationFailures,
} from './baseline-validation.mjs';
import { resolveChromiumArgs } from './chromiumProfiles.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { PNG } = require('pngjs');

const QA_SCENES = Object.freeze([
  'menu', 'main-menu', 'hero-selection',
  'stage-forest', 'stage-twilight', 'stage-cinder', 'stage-void', 'stage-cave', 'stage-kakiland',
  'forest-horde', 'max-weapon-fx',
  'final-boss-forest', 'final-boss-twilight', 'final-boss-cinder',
  'final-boss-void', 'final-boss-cave', 'final-boss-kakiland', 'kakiland-boss',
  'town-night', 'town-house-interior', 'town-casino-interior', 'catacomb',
  'bullet-hell', 'rally-heavy', 'rally-first-person', 'rally-chase', 'monster-smash',
  'monster-smash-chase',
  'draw-track', 'trials', 'catastrophe', 'postfx',
  'low-effects', 'reduced-motion', 'reduced-flashing', 'high-contrast',
]);
const QA_SCENE_SET = new Set(QA_SCENES);

const VIEWPORTS = Object.freeze({
  'desktop-16x9': Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false }),
  'desktop-21x9': Object.freeze({ width: 1680, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false }),
  'desktop-32x9': Object.freeze({ width: 1920, height: 540, deviceScaleFactor: 1, isMobile: false, hasTouch: false }),
  'mobile-landscape': Object.freeze({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
  'mobile-portrait': Object.freeze({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }),
});
const DEFAULT_VIEWPORT = 'desktop-16x9';

// Complete Phase-0 ledger. Rows without a selector stay in the metrics file as
// explicit `unavailable` work instead of disappearing from the baseline.
const CAPTURE_CATALOG = Object.freeze([
  { id: 'main-menu', label: 'Main menu', selector: 'menu' },
  { id: 'hero-selection', label: 'Hero selection', selector: 'hero-selection' },
  { id: 'town', label: 'Town', selector: 'town-night' },
  { id: 'town-house-interior', label: 'Town house interior', selector: 'town-house-interior' },
  { id: 'town-casino-interior', label: 'Town casino interior', selector: 'town-casino-interior' },
  { id: 'forest', label: 'Forest', selector: 'stage-forest' },
  { id: 'twilight', label: 'Twilight', selector: 'stage-twilight' },
  { id: 'cinder', label: 'Cinder', selector: 'stage-cinder' },
  { id: 'void', label: 'Void', selector: 'stage-void' },
  { id: 'cave', label: 'Cave', selector: 'stage-cave' },
  { id: 'kaki-land', label: 'Kaki Land', selector: 'stage-kakiland' },
  { id: 'catacomb', label: 'Catacomb', selector: 'catacomb' },
  { id: 'final-boss-forest', label: 'Forest final boss', selector: 'final-boss-forest' },
  { id: 'final-boss-twilight', label: 'Twilight final boss', selector: 'final-boss-twilight' },
  { id: 'final-boss-cinder', label: 'Cinder final boss', selector: 'final-boss-cinder' },
  { id: 'final-boss-void', label: 'Void final boss', selector: 'final-boss-void' },
  { id: 'final-boss-cave', label: 'Cave final boss', selector: 'final-boss-cave' },
  { id: 'final-boss-kakiland', label: 'Kaki Land final boss', selector: 'kakiland-boss' },
  { id: 'heavy-horde', label: 'Heavy horde scene', selector: 'forest-horde' },
  { id: 'maximum-weapon-effects', label: 'Maximum weapon effects', selector: 'max-weapon-fx' },
  { id: 'bullet-hell', label: 'Bullet Hell', selector: 'bullet-hell' },
  { id: 'kaki-rally', label: 'Kaki Rally', selector: 'rally-heavy' },
  { id: 'draw-track', label: 'Draw Track', selector: 'draw-track' },
  { id: 'monster-smash', label: 'Monster Smash', selector: 'monster-smash' },
  { id: 'monster-smash-chase', label: 'Monster Smash chase camera', selector: 'monster-smash-chase' },
  { id: 'kaki-trials', label: 'Kaki Trials', selector: 'trials' },
  { id: 'kaki-catastrophe', label: 'Kaki Catastrophe', selector: 'catastrophe', deferred: true },
  { id: 'postfx', label: 'Post-processing stress', selector: 'postfx' },
  { id: 'first-person-camera', label: 'First-person camera', selector: 'rally-first-person' },
  { id: 'chase-camera', label: 'Chase camera', selector: 'rally-chase' },
  { id: 'low-effects', label: 'Low-effects mode', selector: 'low-effects' },
  { id: 'reduced-motion', label: 'Reduced-motion mode', selector: 'reduced-motion' },
  { id: 'reduced-flashing', label: 'Reduced-flashing mode', selector: 'reduced-flashing' },
  { id: 'high-contrast', label: 'High-contrast mode', selector: 'high-contrast' },
  { id: 'viewport-16x9', label: '16:9', selector: 'stage-forest', viewport: 'desktop-16x9' },
  { id: 'viewport-21x9', label: '21:9', selector: 'stage-forest', viewport: 'desktop-21x9' },
  { id: 'viewport-32x9', label: '32:9', selector: 'stage-forest', viewport: 'desktop-32x9' },
  { id: 'mobile-landscape', label: 'Mobile landscape', selector: 'stage-forest', viewport: 'mobile-landscape' },
  { id: 'mobile-portrait', label: 'Mobile portrait where supported', selector: 'stage-forest', viewport: 'mobile-portrait' },
]);
const CATALOG_BY_ID = new Map(CAPTURE_CATALOG.map((row) => [row.id, row]));

const SUITES = Object.freeze({
  core: Object.freeze(['main-menu', 'forest', 'heavy-horde', 'maximum-weapon-effects', 'postfx']),
  stages: Object.freeze(['forest', 'twilight', 'cinder', 'void', 'cave', 'kaki-land', 'catacomb']),
  bosses: Object.freeze([
    'final-boss-forest', 'final-boss-twilight', 'final-boss-cinder',
    'final-boss-void', 'final-boss-cave', 'final-boss-kakiland',
  ]),
  // Catastrophe stays explicitly selectable for archived/regression work but
  // is intentionally outside the active migration suite while its port is
  // deferred (docs/webgpu/DEFERRED_MODES.md).
  modes: Object.freeze([
    'bullet-hell', 'kaki-rally', 'first-person-camera', 'chase-camera',
    'draw-track', 'monster-smash', 'monster-smash-chase', 'kaki-trials',
  ]),
  town: Object.freeze(['hero-selection', 'town', 'town-house-interior', 'town-casino-interior']),
  accessibility: Object.freeze(['low-effects', 'reduced-motion', 'reduced-flashing', 'high-contrast']),
  viewports: Object.freeze(['viewport-16x9', 'viewport-21x9', 'viewport-32x9', 'mobile-landscape', 'mobile-portrait']),
});

function usage() {
  console.log(`Usage: node tools/webgpu/baseline.mjs [selection] [options]

Selection:
  --all                     Capture every currently runnable Phase-0 row.
  --scene <id>              Capture a QA selector or Phase-0 catalog id (repeatable).
  --suite <name>            core | stages | bosses | modes | town | accessibility | viewports

Options:
  --out <dir>               Screenshot directory.
  --metrics <file>          JSON metrics ledger path.
  --samples <count>         Number of requestAnimationFrame deltas (default 120).
  --settle-ms <ms>          Settle time after QA readiness (default 1500).
  --timeout-ms <ms>         Per-scene boot/setup timeout (default 120000).
  --port <port>             Local static-server port (default 8787).
  --origin <url>            Use an existing server instead of starting one.
  --backend <mode>          auto | webgpu | webgl (forwarded as ?renderer=).
  --seed <uint32>           Deterministic QA seed (default 12625741).
  --resume                  Reuse successful selected cases from --metrics;
                            rerun only missing or previously failed cases.
  --headed                  Show Chromium.
  --help                    Print this help.
`);
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

function parseArgs(argv) {
  const config = {
    all: false,
    scenes: [],
    suites: [],
    out: process.env.KK_BASELINE_OUT || path.join(ROOT, 'docs/webgpu/BASELINE_SCREENSHOTS'),
    metrics: process.env.KK_BASELINE_METRICS || path.join(ROOT, 'docs/webgpu/BASELINE_METRICS.json'),
    samples: envNumber('KK_BASELINE_SAMPLES', 120),
    settleMs: envNumber('KK_BASELINE_SETTLE_MS', 1500),
    timeoutMs: envNumber('KK_BASELINE_TIMEOUT_MS', 120000),
    port: envNumber('KK_BASELINE_PORT', 8787),
    origin: process.env.KK_BASELINE_ORIGIN || '',
    backend: process.env.KK_BASELINE_BACKEND || 'auto',
    seed: envNumber('KK_BASELINE_SEED', 12625741),
    resume: false,
    headed: /^(1|true|yes)$/i.test(process.env.KK_BASELINE_HEADED || ''),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else if (arg === '--all') config.all = true;
    else if (arg === '--resume') config.resume = true;
    else if (arg === '--headed') config.headed = true;
    else if (arg === '--scene') config.scenes.push(...takeValue(argv, i++, arg).split(',').filter(Boolean));
    else if (arg.startsWith('--scene=')) config.scenes.push(...arg.slice(8).split(',').filter(Boolean));
    else if (arg === '--suite') config.suites.push(...takeValue(argv, i++, arg).split(',').filter(Boolean));
    else if (arg.startsWith('--suite=')) config.suites.push(...arg.slice(8).split(',').filter(Boolean));
    else if (arg === '--out') config.out = takeValue(argv, i++, arg);
    else if (arg.startsWith('--out=')) config.out = arg.slice(6);
    else if (arg === '--metrics') config.metrics = takeValue(argv, i++, arg);
    else if (arg.startsWith('--metrics=')) config.metrics = arg.slice(10);
    else if (arg === '--samples') config.samples = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith('--samples=')) config.samples = Number(arg.slice(10));
    else if (arg === '--settle-ms') config.settleMs = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith('--settle-ms=')) config.settleMs = Number(arg.slice(12));
    else if (arg === '--timeout-ms') config.timeoutMs = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith('--timeout-ms=')) config.timeoutMs = Number(arg.slice(13));
    else if (arg === '--port') config.port = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith('--port=')) config.port = Number(arg.slice(7));
    else if (arg === '--origin' || arg === '--base-url') config.origin = takeValue(argv, i++, arg);
    else if (arg.startsWith('--origin=')) config.origin = arg.slice(9);
    else if (arg.startsWith('--base-url=')) config.origin = arg.slice(11);
    else if (arg === '--backend') config.backend = takeValue(argv, i++, arg);
    else if (arg.startsWith('--backend=')) config.backend = arg.slice(10);
    else if (arg === '--seed') config.seed = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith('--seed=')) config.seed = Number(arg.slice(7));
    else throw new Error(`Unknown option: ${arg}`);
  }
  config.out = path.resolve(ROOT, config.out);
  config.metrics = path.resolve(ROOT, config.metrics);
  config.samples = Math.max(2, Math.trunc(config.samples));
  config.settleMs = Math.max(0, Math.trunc(config.settleMs));
  config.timeoutMs = Math.max(1000, Math.trunc(config.timeoutMs));
  config.port = Math.max(0, Math.min(65535, Math.trunc(config.port)));
  config.seed = Number(config.seed) >>> 0;
  if (!['auto', 'webgpu', 'webgl'].includes(config.backend)) throw new Error(`Invalid backend: ${config.backend}`);
  for (const suite of config.suites) if (!SUITES[suite]) throw new Error(`Unknown suite: ${suite}`);
  if (!config.all && config.scenes.length === 0 && config.suites.length === 0) config.suites.push('core');
  return config;
}

function selection(config) {
  const requestedIds = new Set();
  const adHoc = [];
  if (config.all) {
    for (const row of CAPTURE_CATALOG) {
      if (!row.deferred) requestedIds.add(row.id);
    }
  }
  for (const suite of config.suites) for (const id of SUITES[suite]) requestedIds.add(id);
  for (const scene of config.scenes) {
    if (CATALOG_BY_ID.has(scene)) requestedIds.add(scene);
    else if (QA_SCENE_SET.has(scene)) {
      const catalogRow = CAPTURE_CATALOG.find((row) => row.selector === scene && !row.viewport);
      if (catalogRow) requestedIds.add(catalogRow.id);
      else adHoc.push(scene);
    }
    else throw new Error(`Unknown scene or capture id: ${scene}`);
  }

  const cases = [];
  for (const id of requestedIds) {
    const row = CATALOG_BY_ID.get(id);
    if (!row?.selector) continue;
    cases.push({ captureId: row.id, selector: row.selector, viewport: row.viewport || DEFAULT_VIEWPORT });
  }
  for (const selector of adHoc) cases.push({ captureId: selector, selector, viewport: DEFAULT_VIEWPORT });

  const seen = new Set();
  const deduped = cases.filter((entry) => {
    const key = `${entry.selector}::${entry.viewport}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { requestedIds, cases: deduped };
}

function gitValue(args, fallback = 'unknown') {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback; }
  catch (_) { return fallback; }
}

function gitWorkingTree() {
  const raw = gitValue(['status', '--short', '--untracked-files=all'], '');
  const status = raw ? raw.split(/\r?\n/).filter(Boolean) : [];
  return { dirty: status.length > 0, status };
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json',
    '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
    '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  })[ext] || 'application/octet-stream';
}

async function startServer(port) {
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end('bad request'); return; }
    if (pathname === '/') pathname = '/index.html';
    let file = path.resolve(ROOT, `.${pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
      response.writeHead(403); response.end('forbidden'); return;
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch (_) {}
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end(`not found: ${pathname}`); return; }
      response.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store' });
      response.end(data);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}/` };
}

function resolvePlaywright() {
  const playwrightPath = process.env.KK_BASELINE_PLAYWRIGHT
    || process.env.PLAYWRIGHT_PATH
    || '/home/nemoclaw/node_modules/playwright';
  if (path.isAbsolute(playwrightPath) && !fs.existsSync(playwrightPath)) {
    throw new Error(`Playwright is unavailable at ${playwrightPath}`);
  }
  const playwright = require(playwrightPath);
  const chromiumPath = process.env.KK_BASELINE_CHROMIUM
    || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || process.env.CHROMIUM_PATH
    || '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  if (chromiumPath && !fs.existsSync(chromiumPath)) throw new Error(`Chromium is unavailable at ${chromiumPath}`);
  return { chromium: playwright.chromium, chromiumPath };
}

function boundedPush(array, value, max = 500) {
  if (array.length < max) array.push(value);
}

function caseUrl(origin, entry, config) {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  const url = new URL('index.html', base);
  url.searchParams.set('qa', entry.selector);
  url.searchParams.set('qaSeed', String(config.seed));
  url.searchParams.set('renderer', config.backend);
  url.searchParams.set('rendererDiagnostics', '1');
  if (VIEWPORTS[entry.viewport].hasTouch) url.searchParams.set('touch', '1');
  return url.href;
}

async function sampleAnimationFrames(page, count) {
  const deltas = await page.evaluate((target) => new Promise((resolve) => {
    const rows = [];
    let previous = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(rows);
    };
    const timeout = setTimeout(finish, Math.max(15000, target * 120));
    const tick = (time) => {
      if (done) return;
      if (previous != null) rows.push(time - previous);
      previous = time;
      if (rows.length >= target) {
        clearTimeout(timeout);
        finish();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), count);
  const valid = deltas.filter((value) => Number.isFinite(value) && value > 0 && value < 5000);
  if (valid.length === 0) return { samples: 0, averageFps: null, onePercentLowFps: null, averageFrameMs: null, p95FrameMs: null, p99FrameMs: null };
  const averageFrameMs = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const ascending = [...valid].sort((a, b) => a - b);
  const percentile = (fraction) => ascending[Math.min(ascending.length - 1, Math.floor((ascending.length - 1) * fraction))];
  const worstCount = Math.max(1, Math.ceil(valid.length * 0.01));
  const worst = ascending.slice(-worstCount);
  const worstAverageMs = worst.reduce((sum, value) => sum + value, 0) / worst.length;
  return {
    samples: valid.length,
    averageFps: +(1000 / averageFrameMs).toFixed(2),
    onePercentLowFps: +(1000 / worstAverageMs).toFixed(2),
    averageFrameMs: +averageFrameMs.toFixed(3),
    minFrameMs: +ascending[0].toFixed(3),
    maxFrameMs: +ascending.at(-1).toFixed(3),
    p95FrameMs: +percentile(0.95).toFixed(3),
    p99FrameMs: +percentile(0.99).toFixed(3),
  };
}

async function runtimeSnapshot(page) {
  return page.evaluate(async () => {
    const state = window.kkState;
    const renderer = state?.renderer;
    const info = renderer?.info;
    const renderTargets = [];
    const seenTargets = new Set();
    const seenObjects = new Set();

    const channelsForFormat = (format) => {
      if ([1021, 1024, 1026].includes(format)) return 1;
      if (format === 1025) return 2;
      if (format === 1022) return 3;
      return 4;
    };
    const bytesForType = (type) => {
      if ([1010, 1009].includes(type)) return 1;
      if ([1011, 1012, 1016].includes(type)) return 2;
      if ([1013, 1014, 1015].includes(type)) return 4;
      return 1;
    };
    const addTarget = (target, label) => {
      if (!target || seenTargets.has(target)) return;
      const looksLikeTarget = !!(target.isWebGLRenderTarget || target.isRenderTarget
        || (Number.isFinite(target.width) && Number.isFinite(target.height) && (target.texture || target.textures)));
      if (!looksLikeTarget) return;
      seenTargets.add(target);
      const width = Math.max(0, Number(target.width) || 0);
      const height = Math.max(0, Number(target.height) || 0);
      const textures = Array.isArray(target.textures) ? target.textures : target.texture ? [target.texture] : [];
      let colorBytes = 0;
      for (const texture of textures) {
        const channels = channelsForFormat(texture?.format);
        const componentBytes = bytesForType(texture?.type);
        const mipFactor = texture?.generateMipmaps ? 4 / 3 : 1;
        colorBytes += width * height * channels * componentBytes * mipFactor;
      }
      const samples = Math.max(1, Number(target.samples) || 1);
      const resolvedColorBytes = colorBytes;
      const multisampleBytes = samples > 1 ? colorBytes * samples : 0;
      const depthBytes = target.depthBuffer === false ? 0 : width * height * 4 * samples;
      renderTargets.push({
        label, width, height, textures: textures.length, samples,
        estimatedBytes: Math.round(resolvedColorBytes + multisampleBytes + depthBytes),
      });
    };
    const scan = (value, label, depth = 0) => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function') || seenObjects.has(value) || depth > 4) return;
      seenObjects.add(value);
      addTarget(value, label);
      if (Array.isArray(value)) {
        value.slice(0, 64).forEach((item, index) => scan(item, `${label}[${index}]`, depth + 1));
        return;
      }
      let keys = [];
      try { keys = Object.keys(value).slice(0, 160); } catch (_) { return; }
      for (const key of keys) {
        if (/^(scene|camera|renderer|domElement|parent|children|material|geometry)$/.test(key)) continue;
        let child;
        try { child = value[key]; } catch (_) { continue; }
        scan(child, `${label}.${key}`, depth + 1);
      }
    };
    scan(state?.composer, 'state.composer');
    scan(state?.bloomComposer, 'state.bloomComposer');
    scan(state?.bloomPass, 'state.bloomPass');
    scan(state?.renderPipeline, 'state.renderPipeline');
    scan(window.__kkRendererService, 'rendererService');

    let diagnostics = null;
    try {
      const source = window.__kkRendererService?.getDiagnostics?.()
        ?? window.__kkRendererDiagnostics?.snapshot?.()
        ?? window.__kkRendererDiagnostics
        ?? null;
      const resolved = await Promise.resolve(source);
      diagnostics = resolved == null ? null : JSON.parse(JSON.stringify(resolved));
    } catch (error) {
      diagnostics = { error: error?.message || String(error) };
    }

    const navigation = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime]));
    const heap = performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
    } : null;
    const qa = window.__kkQa?.snapshot?.() || null;
    const perf = window.kkPerfSnapshot?.() || null;
    const gpuFrameMs = diagnostics?.gpuFrameTimeMs
      ?? diagnostics?.gpuFrameMs
      ?? diagnostics?.gpu?.frameTimeMs
      ?? diagnostics?.timings?.gpuMs
      ?? null;
    return {
      qa,
      backend: qa?.renderer?.backend || diagnostics?.backend || 'unknown',
      threeRevision: qa?.renderer?.threeRevision || null,
      renderer: qa?.renderer?.renderer || renderer?.constructor?.name || null,
      rendererInfo: info ? {
        memory: { ...(info.memory || {}) },
        render: { ...(info.render || {}) },
        programs: Array.isArray(info.programs) ? info.programs.length : null,
      } : null,
      diagnostics,
      gpuFrameMs,
      heap,
      renderTargets: {
        count: renderTargets.length,
        estimatedBytes: renderTargets.reduce((sum, target) => sum + target.estimatedBytes, 0),
        targets: renderTargets,
      },
      perf,
      timing: {
        navigation: navigation ? {
          domInteractive: navigation.domInteractive,
          domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
          loadEventEnd: navigation.loadEventEnd,
          responseEnd: navigation.responseEnd,
          transferSize: navigation.transferSize,
          decodedBodySize: navigation.decodedBodySize,
        } : null,
        paints,
        qaCreatedAtMs: qa?.createdAtMs ?? null,
        qaReadyAtMs: qa?.readyAtMs ?? null,
        qaSetupDurationMs: qa?.setupDurationMs ?? null,
        firstPlayableFrameMs: qa?.readyAtMs ?? null,
      },
      canvas: renderer?.domElement ? {
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        clientWidth: renderer.domElement.clientWidth,
        clientHeight: renderer.domElement.clientHeight,
      } : null,
      longTasks: (window.__kkBaselineLongTasks || []).slice(),
      browserErrors: (window.__kkBaselineErrors || []).slice(),
      resourceCount: performance.getEntriesByType('resource').length,
    };
  });
}

async function captureRendererCanvasFrame(page) {
  const canvasHandle = await page.evaluateHandle(() => (
    window.__kkRendererService?.canvas
      || window.kkState?.rendererService?.canvas
      || window.kkState?.renderer?.domElement
      || null
  ));
  const canvasElement = canvasHandle.asElement();
  if (!canvasElement) {
    await canvasHandle.dispose();
    throw new Error('The active renderer canvas is unavailable after QA readiness.');
  }

  try {
    // Playwright element screenshots include overlapping siblings. Temporarily
    // hide only nodes outside the renderer-canvas ancestry so this probe tests
    // the GPU frame rather than menu/UI pixels. The normal baseline screenshot
    // is taken before this isolation and therefore remains unchanged.
    await page.evaluate((canvas) => {
      const changed = [];
      for (const element of document.body.querySelectorAll('*')) {
        if (element === canvas || element.contains(canvas)) continue;
        changed.push({
          element,
          value: element.style.getPropertyValue('visibility'),
          priority: element.style.getPropertyPriority('visibility'),
        });
        element.style.setProperty('visibility', 'hidden', 'important');
      }
      window.__kkBaselineRestoreCanvasIsolation = () => {
        for (const row of changed) {
          if (row.value) row.element.style.setProperty('visibility', row.value, row.priority);
          else row.element.style.removeProperty('visibility');
        }
      };
    }, canvasElement);
    const pngBuffer = await canvasElement.screenshot({ type: 'png', animations: 'allow' });
    const decoded = PNG.sync.read(pngBuffer);
    return analyzeCanvasRgba(decoded.data, decoded.width, decoded.height);
  } finally {
    try {
      await page.evaluate(() => {
        window.__kkBaselineRestoreCanvasIsolation?.();
        delete window.__kkBaselineRestoreCanvasIsolation;
      });
    } catch (_) {}
    await canvasHandle.dispose();
  }
}

function safeFilePart(value) {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'capture';
}

function relativeToRoot(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith('..') ? file : relative;
}

function writeMetrics(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function resultCaseKey(result) {
  return `${result?.scene || ''}::${result?.viewport?.id || ''}`;
}

function resumeCases(config, selected, source) {
  const fallback = {
    previous: null,
    retained: [],
    pending: selected.cases,
  };
  if (!config.resume || !fs.existsSync(config.metrics)) return fallback;

  let previous;
  try { previous = JSON.parse(fs.readFileSync(config.metrics, 'utf8')); }
  catch (error) { throw new Error(`Could not resume metrics ${config.metrics}: ${error.message}`); }
  if (source.dirty || previous.source?.dirty !== false) {
    throw new Error('Cannot resume baseline metrics unless both source trees are recorded clean');
  }
  const expectedScreenshotDirectory = relativeToRoot(config.out);
  const compatibility = [
    ['source commit', previous.source?.commit, source.commit],
    ['preferred backend', previous.harness?.preferredBackend, config.backend],
    ['seed', Number(previous.harness?.seed), config.seed],
    ['screenshot directory', previous.harness?.screenshotDirectory, expectedScreenshotDirectory],
    ['frame samples', Number(previous.harness?.samples), config.samples],
    ['settle time', Number(previous.harness?.settleMs), config.settleMs],
  ];
  const mismatches = compatibility
    .filter(([, previousValue, currentValue]) => previousValue !== currentValue)
    .map(([label, previousValue, currentValue]) => `${label} ${JSON.stringify(previousValue)} != ${JSON.stringify(currentValue)}`);
  if (mismatches.length > 0) {
    throw new Error(`Cannot resume incompatible baseline metrics: ${mismatches.join('; ')}`);
  }
  const selectedByKey = new Map(selected.cases.map((entry) => [`${entry.selector}::${entry.viewport}`, entry]));
  const successfulByKey = new Map();
  for (const result of Array.isArray(previous.results) ? previous.results : []) {
    const key = resultCaseKey(result);
    const selectedCase = selectedByKey.get(key);
    const expectedViewport = selectedCase && VIEWPORTS[selectedCase.viewport];
    const viewportMatches = !!expectedViewport
      && ['width', 'height', 'deviceScaleFactor', 'isMobile', 'hasTouch']
        .every((field) => result?.viewport?.[field] === expectedViewport[field]);
    const backendMatches = config.backend === 'auto'
      || (config.backend === 'webgpu' && result?.runtime?.backend === 'webgpu')
      || (config.backend === 'webgl' && /^webgl/i.test(result?.runtime?.backend || ''));
    if (result?.success === true && selectedCase && viewportMatches && backendMatches) {
      successfulByKey.set(key, result);
    }
  }
  const retained = [...successfulByKey.values()];
  const pending = selected.cases.filter((entry) => !successfulByKey.has(`${entry.selector}::${entry.viewport}`));
  return { previous, retained, pending };
}

async function captureCase(browser, origin, entry, config) {
  const viewport = VIEWPORTS[entry.viewport];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    screen: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(() => {
    window.__kkBaselineErrors = [];
    window.__kkBaselineLongTasks = [];
    const record = (source, value) => {
      const error = value instanceof Error ? value : new Error(String(value ?? 'Unknown error'));
      window.__kkBaselineErrors.push({ source, name: error.name, message: error.message, stack: error.stack || '', atMs: performance.now() });
    };
    addEventListener('error', (event) => record('window.error', event.error || event.message));
    addEventListener('unhandledrejection', (event) => record('unhandledrejection', event.reason));
    try {
      new PerformanceObserver((list) => {
        for (const item of list.getEntries()) {
          if (window.__kkBaselineLongTasks.length < 1000) {
            window.__kkBaselineLongTasks.push({ startTime: item.startTime, duration: item.duration });
          }
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) {}
  });

  const page = await context.newPage();
  const consoleRows = [];
  const pageErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  page.on('console', (message) => boundedPush(consoleRows, {
    type: message.type(), text: message.text(), location: message.location(), at: Date.now(),
  }));
  page.on('pageerror', (error) => boundedPush(pageErrors, { message: error.message, stack: error.stack || '', at: Date.now() }));
  page.on('requestfailed', (request) => boundedPush(requestFailures, {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    error: request.failure()?.errorText || 'request failed',
  }));
  page.on('response', (response) => {
    if (response.status() >= 400) boundedPush(httpErrors, { url: response.url(), status: response.status() });
  });

  const id = `${safeFilePart(entry.selector)}__${safeFilePart(entry.viewport)}`;
  const screenshotFile = path.join(config.out, `${id}.png`);
  const url = caseUrl(origin, entry, config);
  const result = {
    id,
    captureId: entry.captureId,
    scene: entry.selector,
    viewport: { id: entry.viewport, ...viewport },
    url,
    success: false,
    screenshot: null,
    wallClockSetupMs: null,
    frameTiming: null,
    runtime: null,
    failure: null,
    console: consoleRows,
    pageErrors,
    requestFailures,
    httpErrors,
    validationFailures: [],
  };
  const wallStarted = Date.now();
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    if (!response || !response.ok()) throw new Error(`Navigation failed with HTTP ${response?.status() ?? 'no response'}`);
    await page.waitForFunction(
      () => window.__kkQa && (window.__kkQa.status === 'ready' || window.__kkQa.status === 'error'),
      null,
      { timeout: config.timeoutMs },
    );
    const status = await page.evaluate(() => window.__kkQa.snapshot?.() || { status: window.__kkQa.status, errors: window.__kkQa.errors });
    if (status.status !== 'ready') throw new Error(`QA setup failed: ${status.errors?.map((row) => row.message).join('; ') || status.status}`);
    result.wallClockSetupMs = Date.now() - wallStarted;
    if (config.settleMs) await page.waitForTimeout(config.settleMs);
    fs.mkdirSync(config.out, { recursive: true });
    await page.screenshot({ path: screenshotFile, fullPage: false, animations: 'allow' });
    result.screenshot = relativeToRoot(screenshotFile);
    result.frameTiming = await sampleAnimationFrames(page, config.samples);
    result.runtime = await runtimeSnapshot(page);
    result.runtime.canvasFrame = await captureRendererCanvasFrame(page);
    result.validationFailures = collectBaselineValidationFailures(result, origin);
    if (result.validationFailures.length > 0) {
      throw new Error(`Post-readiness validation failed: ${result.validationFailures.join(' | ')}`);
    }
    result.success = true;
  } catch (error) {
    result.wallClockSetupMs = Date.now() - wallStarted;
    result.failure = { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
    try {
      fs.mkdirSync(config.out, { recursive: true });
      const errorShot = path.join(config.out, `${id}__ERROR.png`);
      await page.screenshot({ path: errorShot, fullPage: false, animations: 'allow' });
      result.screenshot = relativeToRoot(errorShot);
    } catch (_) {}
    try { result.runtime = await runtimeSnapshot(page); } catch (_) {}
  } finally {
    await context.close();
  }
  return result;
}

function buildLedger(selected, results) {
  const resultByKey = new Map(results.map((result) => [`${result.scene}::${result.viewport.id}`, result]));
  return CAPTURE_CATALOG.map((row) => {
    const viewport = row.viewport || DEFAULT_VIEWPORT;
    if (!row.selector) {
      return { id: row.id, label: row.label, selector: null, viewport, status: 'unavailable', reason: row.unavailableReason };
    }
    const chosen = selected.requestedIds.has(row.id);
    const result = resultByKey.get(`${row.selector}::${viewport}`);
    if (chosen && result) {
      return {
        id: row.id, label: row.label, selector: row.selector, viewport,
        status: result.success ? 'captured' : 'failed', resultId: result.id,
        reason: result.failure?.message || null,
      };
    }
    return { id: row.id, label: row.label, selector: row.selector, viewport, status: 'not-selected', reason: null };
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const selected = selection(config);
  const workingTree = gitWorkingTree();
  const source = {
    repository: ROOT,
    commit: gitValue(['rev-parse', 'HEAD']),
    branch: gitValue(['branch', '--show-current']),
    dirty: workingTree.dirty,
    status: workingTree.status,
  };
  const resumed = resumeCases(config, selected, source);
  const casesToRun = resumed.pending;
  const metrics = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    harness: {
      samples: config.samples,
      settleMs: config.settleMs,
      timeoutMs: config.timeoutMs,
      preferredBackend: config.backend,
      seed: config.seed,
      screenshotDirectory: relativeToRoot(config.out),
      resume: {
        enabled: config.resume,
        retained: resumed.retained.length,
        pending: casesToRun.length,
        previousGeneratedAt: resumed.previous?.generatedAt || null,
      },
    },
    captureLedger: [],
    results: resumed.retained,
    summary: null,
  };

  let localServer = null;
  let browser = null;
  try {
    let origin = config.origin;
    if (!origin && casesToRun.length > 0) {
      localServer = await startServer(config.port);
      origin = localServer.origin;
    }
    metrics.harness.origin = origin || null;
    if (casesToRun.length > 0) {
      const { chromium, chromiumPath } = resolvePlaywright();
      const launchArgs = resolveChromiumArgs(config.backend, process.env.KK_BASELINE_CHROMIUM_ARGS);
      metrics.harness.chromium = chromiumPath;
      metrics.harness.chromiumArgs = launchArgs;
      browser = await chromium.launch({
        executablePath: chromiumPath,
        headless: !config.headed,
        args: launchArgs,
      });
      for (let index = 0; index < casesToRun.length; index++) {
        const entry = casesToRun[index];
        console.log(`[baseline ${index + 1}/${casesToRun.length}] ${entry.selector} @ ${entry.viewport}`);
        const result = await captureCase(browser, origin, entry, config);
        metrics.results.push(result);
        metrics.captureLedger = buildLedger(selected, metrics.results);
        metrics.summary = {
          requested: selected.cases.length,
          captured: metrics.results.filter((row) => row.success).length,
          failed: metrics.results.filter((row) => !row.success).length,
          unavailable: metrics.captureLedger.filter((row) => row.status === 'unavailable').length,
        };
        writeMetrics(config.metrics, metrics);
        console.log(`  ${result.success ? 'ok' : 'FAILED'}${result.runtime?.backend ? ` backend=${result.runtime.backend}` : ''}${result.screenshot ? ` screenshot=${result.screenshot}` : ''}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    if (localServer) await new Promise((resolve) => localServer.server.close(resolve));
  }

  metrics.captureLedger = buildLedger(selected, metrics.results);
  metrics.summary = {
    requested: selected.cases.length,
    captured: metrics.results.filter((row) => row.success).length,
    failed: metrics.results.filter((row) => !row.success).length,
    unavailable: metrics.captureLedger.filter((row) => row.status === 'unavailable').length,
  };
  writeMetrics(config.metrics, metrics);
  console.log(`[baseline] metrics=${relativeToRoot(config.metrics)} captured=${metrics.summary.captured} failed=${metrics.summary.failed} unavailable=${metrics.summary.unavailable}`);
  if (metrics.summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[baseline] FAIL', error);
  process.exitCode = 1;
});
