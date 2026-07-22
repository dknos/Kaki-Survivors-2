#!/usr/bin/env node
/**
 * Production browser smoke for repeated renderer-neutral mode transitions.
 *
 * The smoke uses only public entry/exit hooks exposed by src/main.js. Draw
 * Track uses a deterministic authored course and Kaki Catastrophe is
 * deliberately excluded from this migration check.
 *
 * Environment overrides:
 *   KK_WEBGPU_SMOKE_PLAYWRIGHT=/path/to/playwright
 *   KK_WEBGPU_SMOKE_CHROMIUM=/path/to/chrome
 *   KK_WEBGPU_SMOKE_ORIGIN=http://127.0.0.1:8080/
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SOFTWARE_WEBGL_ARGS, SOFTWARE_WEBGPU_ARGS } from './chromiumProfiles.mjs';

const require = createRequire(import.meta.url);
const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS_FILE), '../..');
const MIN_FRAME_ADVANCE = 4;
const POST_ASSET_FRAME_ADVANCE = 2;
const LOCAL_NETWORK_IDLE_MS = 750;
const LOCAL_NETWORK_IDLE_TIMEOUT_MS = 60_000;

const DRAW_TRACK_LIFECYCLE_COURSE = Object.freeze({
  id: 'forest',
  customTrackId: 'renderer-lifecycle-loop-v1',
  isDrawTrack: true,
  name: 'Renderer Lifecycle Loop',
  tagline: 'A deterministic circuit for renderer lifecycle validation.',
  laps: 1,
  trackWidth: 9,
  drawSizeId: 'grand',
  drawWidthId: 'standard',
  drawDirection: 'forward',
  drawStats: Object.freeze({ length: 310, personality: 'FLOWING QA LOOP' }),
  points: Object.freeze([
    Object.freeze([-44, -10]), Object.freeze([-35, -35]), Object.freeze([-8, -47]),
    Object.freeze([24, -40]), Object.freeze([45, -17]), Object.freeze([42, 18]),
    Object.freeze([20, 42]), Object.freeze([-12, 46]), Object.freeze([-39, 25]),
    Object.freeze([-50, 4]),
  ]),
  rampFractions: Object.freeze([0.18, 0.64]),
  boostFractions: Object.freeze([0.38, 0.82]),
  repairFractions: Object.freeze([0.9]),
  overpasses: Object.freeze([]),
});

const PROFILE_DEFINITIONS = Object.freeze([
  Object.freeze({
    requestedBackend: 'webgl',
    name: 'software-webgl2',
    args: Object.freeze([...SOFTWARE_WEBGL_ARGS]),
  }),
  Object.freeze({
    requestedBackend: 'webgpu',
    name: 'software-webgpu',
    args: Object.freeze([...SOFTWARE_WEBGPU_ARGS]),
  }),
]);

export const MODE_SEQUENCE = Object.freeze([
  Object.freeze({ id: 'bullethell-first', label: 'Bullet Hell', kind: 'bullethell' }),
  Object.freeze({
    id: 'rally-first',
    label: 'Kaki Rally',
    kind: 'racing',
    raceMode: 'circuit',
    courseId: 'forest',
    options: Object.freeze({ mode: 'circuit', carCount: 4 }),
  }),
  Object.freeze({
    id: 'monster-smash',
    label: 'Monster Smash',
    kind: 'racing',
    raceMode: 'monster',
    courseId: 'kakiland',
    options: Object.freeze({
      mode: 'monster',
      monsterVehicle: 'cyber',
      monsterArena: 'crown-chaos-coliseum',
    }),
  }),
  Object.freeze({
    id: 'trials',
    label: 'Kaki Trials',
    kind: 'racing',
    raceMode: 'trials',
    courseId: 'forest',
    options: Object.freeze({ mode: 'trials', trialsTrackId: 'meadow', trialsVehicle: 'buggy' }),
  }),
  Object.freeze({
    id: 'draw-track',
    label: 'Draw Track',
    kind: 'racing',
    raceMode: 'draw',
    courseId: 'forest',
    options: Object.freeze({
      mode: 'draw',
      carCount: 8,
      customCourse: DRAW_TRACK_LIFECYCLE_COURSE,
      customTrack: Object.freeze({
        id: DRAW_TRACK_LIFECYCLE_COURSE.customTrackId,
        name: DRAW_TRACK_LIFECYCLE_COURSE.name,
        widthId: DRAW_TRACK_LIFECYCLE_COURSE.drawWidthId,
      }),
    }),
  }),
  Object.freeze({ id: 'bullethell-reentry', label: 'Bullet Hell re-entry', kind: 'bullethell' }),
  Object.freeze({
    id: 'rally-reentry',
    label: 'Kaki Rally re-entry',
    kind: 'racing',
    raceMode: 'circuit',
    courseId: 'forest',
    options: Object.freeze({ mode: 'circuit', carCount: 4 }),
  }),
]);

function addCheck(failures, condition, message) {
  if (!condition) failures.push(message);
}

export function validateLifecycleSnapshot(snapshot, {
  backend,
  phase,
  mode = null,
  minimumFrames = MIN_FRAME_ADVANCE,
} = {}) {
  const failures = [];
  const loop = snapshot?.loop?.after;

  addCheck(failures, snapshot?.serviceState === 'ready',
    `renderer service is ${snapshot?.serviceState || 'missing'}, not ready`);
  addCheck(failures, snapshot?.backend === backend,
    `active backend is ${snapshot?.backend || 'missing'}, expected ${backend}`);
  addCheck(failures, snapshot?.rendererIsWebGPURenderer === true,
    'production renderer is not THREE.WebGPURenderer');
  addCheck(failures,
    backend === 'webgpu'
      ? snapshot?.backendFlags?.webgpu === true && snapshot?.backendFlags?.deviceReady === true
      : snapshot?.backendFlags?.webgl === true && snapshot?.backendFlags?.webgl2 === true,
    `renderer backend object does not confirm forced ${backend}: ${JSON.stringify(snapshot?.backendFlags || null)}`);
  addCheck(failures, snapshot?.identity?.serviceStable === true
    && snapshot?.identity?.rendererStable === true
    && snapshot?.identity?.canvasStable === true,
  'renderer service, renderer, or main canvas identity changed during a mode transition');

  addCheck(failures, loop?.running === true, 'main animation loop is not running');
  addCheck(failures, loop?.owner === 'renderer.setAnimationLoop',
    `main animation loop owner is ${loop?.owner || 'missing'}`);
  addCheck(failures, loop?.startCount === 1,
    `duplicate animation loop/RAF owner detected: startCount=${loop?.startCount ?? 'missing'}`);
  addCheck(failures, loop?.duplicateTimestampCount === 0,
    `duplicate animation loop/RAF timestamps detected: ${loop?.duplicateTimestampCount ?? 'missing'}`);
  addCheck(failures, snapshot?.loop?.frameAdvance >= minimumFrames,
    `main animation loop advanced ${snapshot?.loop?.frameAdvance ?? 0}/${minimumFrames} frames`);

  addCheck(failures, snapshot?.canvas?.mainCanvasCount === 1,
    `found ${snapshot?.canvas?.mainCanvasCount ?? 'unknown'} #game-canvas elements`);
  addCheck(failures, snapshot?.canvas?.fullStageCanvasCount === 1,
    `found ${snapshot?.canvas?.fullStageCanvasCount ?? 'unknown'} full-stage canvases`);
  addCheck(failures, snapshot?.canvas?.rendererOwnsMainCanvas === true,
    'renderer service and renderer do not own the production #game-canvas');
  addCheck(failures, snapshot?.renderInfo?.drawCalls > 0,
    `renderer submitted no draw calls: ${JSON.stringify(snapshot?.renderInfo || null)}`);

  addCheck(failures, snapshot?.runtimeErrors?.errors?.length === 0,
    `window errors: ${JSON.stringify(snapshot?.runtimeErrors?.errors || [])}`);
  addCheck(failures, snapshot?.runtimeErrors?.rejections?.length === 0,
    `unhandled rejections: ${JSON.stringify(snapshot?.runtimeErrors?.rejections || [])}`);

  if (phase === 'active' && mode?.kind === 'bullethell') {
    addCheck(failures, snapshot?.game?.mode === 'bullethell' && snapshot?.game?.started === true,
      `Bullet Hell did not become active: ${JSON.stringify(snapshot?.game || null)}`);
    addCheck(failures, snapshot?.game?.bulletHellActive === true,
      'Bullet Hell QA state is missing or inactive');
    addCheck(failures, snapshot?.dom?.bulletHellHudCount === 1
      && snapshot?.dom?.racingHudCount === 0,
    `Bullet Hell HUD ownership is invalid: ${JSON.stringify(snapshot?.dom || null)}`);
    addCheck(failures, snapshot?.scene?.bulletHellObjectCount > 0
      && snapshot?.scene?.racingRootCount === 0,
    `Bullet Hell scene ownership is invalid: ${JSON.stringify(snapshot?.scene || null)}`);
  } else if (phase === 'active' && mode?.kind === 'racing') {
    const assets = snapshot?.assets;
    const assetIds = Array.isArray(assets?.ids) ? assets.ids : [];
    const assetCache = Array.isArray(assets?.cache) ? assets.cache : [];
    const invalidAssetRows = assetCache.filter((entry) => (
      entry?.loaded !== true || !(Number(entry?.refs) > 0)
    ));
    addCheck(failures, snapshot?.game?.mode === 'racing' && snapshot?.game?.started === true,
      `${mode.label} did not become active: ${JSON.stringify(snapshot?.game || null)}`);
    addCheck(failures, snapshot?.game?.raceMode === mode.raceMode,
      `${mode.label} race mode is ${snapshot?.game?.raceMode || 'missing'}, expected ${mode.raceMode}`);
    addCheck(failures, snapshot?.readiness?.racingAssetsReady === true,
      `${mode.label} asset lease was not observed ready before validation`);
    addCheck(failures,
      (snapshot?.readiness?.postAssetFrames?.frameAdvance ?? 0) >= POST_ASSET_FRAME_ADVANCE,
      `${mode.label} rendered ${snapshot?.readiness?.postAssetFrames?.frameAdvance ?? 0}/${POST_ASSET_FRAME_ADVANCE} frames after asset readiness`);
    addCheck(failures, assets?.error === '',
      `${mode.label} asset snapshot reported an error: ${assets?.error || 'missing asset snapshot'}`);
    addCheck(failures, assetIds.length > 0,
      `${mode.label} asset lease exposes no manifest ids`);
    addCheck(failures, assetCache.length > 0,
      `${mode.label} asset cache is empty after lease readiness`);
    addCheck(failures, invalidAssetRows.length === 0,
      `${mode.label} has unloaded or unreferenced asset rows: ${JSON.stringify(invalidAssetRows)}`);
    addCheck(failures, snapshot?.dom?.racingHudCount === 1
      && snapshot?.dom?.bulletHellHudCount === 0,
    `${mode.label} HUD ownership is invalid: ${JSON.stringify(snapshot?.dom || null)}`);
    addCheck(failures, snapshot?.scene?.racingRootCount === 1
      && snapshot?.scene?.racingOwnedObjectCount > 0
      && snapshot?.scene?.bulletHellObjectCount === 0,
    `${mode.label} scene ownership is invalid: ${JSON.stringify(snapshot?.scene || null)}`);
  } else if (phase === 'menu') {
    addCheck(failures, snapshot?.game?.mode === 'menu' && snapshot?.game?.started === false,
      `menu state was not restored: ${JSON.stringify(snapshot?.game || null)}`);
    addCheck(failures, snapshot?.game?.hasRacingSession === false
      && snapshot?.game?.raceMode === null
      && snapshot?.game?.bulletHellActive === false,
    `mode state leaked after exit: ${JSON.stringify(snapshot?.game || null)}`);
    addCheck(failures, snapshot?.dom?.racingHudCount === 0
      && snapshot?.dom?.bulletHellHudCount === 0
      && snapshot?.dom?.bulletHellFlashCount === 0
      && snapshot?.dom?.bulletHellNoticeCount === 0,
    `mode DOM leaked after exit: ${JSON.stringify(snapshot?.dom || null)}`);
    addCheck(failures, snapshot?.scene?.racingRootCount === 0
      && snapshot?.scene?.racingOwnedObjectCount === 0
      && snapshot?.scene?.bulletHellObjectCount === 0,
    `mode scene root leaked after exit: ${JSON.stringify(snapshot?.scene || null)}`);
    addCheck(failures, snapshot?.menu?.present === true && snapshot?.menu?.visible === true,
      'production menu did not remount visibly after mode exit');
  }

  return failures;
}

export function validateBrowserSignals({ consoleErrors = [], pageErrors = [], requestFailures = [] } = {}) {
  const failures = [];
  addCheck(failures, pageErrors.length === 0,
    `page errors: ${JSON.stringify(pageErrors)}`);
  addCheck(failures, consoleErrors.length === 0,
    `browser/render console errors: ${JSON.stringify(consoleErrors)}`);
  addCheck(failures, requestFailures.length === 0,
    `production-local request failures: ${JSON.stringify(requestFailures)}`);
  return failures;
}

function usage() {
  console.log(`Usage: node tools/webgpu/smoke-mode-lifecycle.mjs [options]

Options:
  --webgl-only       Run only forced WebGL 2.
  --webgpu-only      Run only forced software WebGPU.
  --headed           Show Chromium.
  --port <port>      Static server port; 0 selects a free port (default 0).
  --origin <url>     Use an existing static server instead of starting one.
  --output <file>    Save the JSON report outside or inside the repository.
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
      if (!config.output) throw new Error('--output requires a file.');
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
  '.woff2': 'font/woff2',
});

function parseByteRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function startServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
      const filePath = path.resolve(ROOT, pathname.replace(/^\/+/, ''));
      const withinRoot = filePath === ROOT || filePath.startsWith(`${ROOT}${path.sep}`);
      if (!withinRoot || !fs.existsSync(filePath)) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, {
          allow: 'GET, HEAD',
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('Method not allowed');
        return;
      }

      const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
      const headers = {
        'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'public, max-age=3600',
        'cross-origin-resource-policy': 'same-origin',
        'accept-ranges': 'bytes',
        etag,
        'last-modified': stat.mtime.toUTCString(),
      };
      if (!request.headers.range && request.headers['if-none-match'] === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
      }

      const range = parseByteRange(request.headers.range, stat.size);
      if (range === false) {
        response.writeHead(416, {
          ...headers,
          'content-range': `bytes */${stat.size}`,
          'content-length': '0',
        });
        response.end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? stat.size - 1;
      const contentLength = end - start + 1;
      response.writeHead(range ? 206 : 200, {
        ...headers,
        'content-length': String(contentLength),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
      });
      if (request.method === 'HEAD') response.end();
      else {
        const stream = fs.createReadStream(filePath, range ? { start, end } : undefined);
        stream.on('error', (error) => response.destroy(error));
        stream.pipe(response);
      }
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

function gitValue(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (_) {
    return '';
  }
}

function commandLine(argv) {
  return argv.map((value) => {
    const text = String(value);
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", `'\\''`)}'`;
  }).join(' ');
}

/** Build stable attribution for a persisted lifecycle report. */
export function collectLifecycleAttribution({
  root = ROOT,
  argv = process.argv,
  browserExecutable = null,
  reportOutput = null,
} = {}) {
  const statusText = gitValue(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const reportPath = reportOutput
    ? path.relative(root, path.resolve(root, reportOutput)).split(path.sep).join('/')
    : null;
  const status = statusText
    ? statusText.split(/\r?\n/).filter((entry) => entry && entry.slice(3) !== reportPath)
    : [];
  let packageVersion = null;
  try {
    packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'vendor/three/package.json'), 'utf8')).version || null;
  } catch (_) {}
  const revisionMatch = /^0\.(\d+)(?:\.|$)/.exec(packageVersion || '');
  const command = [...argv].map(String);

  return {
    source: {
      repository: root,
      commit: gitValue(root, ['rev-parse', 'HEAD']) || null,
      branch: gitValue(root, ['branch', '--show-current']) || null,
      dirty: status.length > 0,
      status,
    },
    three: {
      packageVersion,
      revision: revisionMatch?.[1] || null,
    },
    harness: {
      npmScript: 'test:renderer:lifecycle',
      command,
      commandLine: commandLine(command),
      reducedMotion: 'no-preference',
      browserExecutable,
      profiles: PROFILE_DEFINITIONS.map((profile) => ({
        requestedBackend: profile.requestedBackend,
        name: profile.name,
        args: [...profile.args],
      })),
    },
  };
}

/** Normalize per-browser launch attribution before it is written to a report. */
export function createLaunchEvidence({
  profile = null,
  args = [],
  browserVersion = null,
  browserExecutable = null,
} = {}) {
  return {
    launchProfile: profile,
    launchArgs: [...args].map(String),
    browserVersion,
    browserExecutable,
  };
}

/**
 * Classify one concrete failed request. No URL-level success can mask another
 * request: callers pass the exact Playwright request identity and its phases.
 */
export function classifyRequestFailure(failure = {}) {
  let pathname = '';
  try { pathname = new URL(failure.url).pathname; } catch (_) {}
  const intentionalMenuAudioCancellation = failure.error === 'net::ERR_ABORTED'
    && failure.resourceType === 'media'
    && pathname === '/assets/music/menu_glitch.mp3'
    && /^menu:/.test(failure.startedPhase || '')
    // Chromium can deliver the cancellation event immediately during entry or
    // a few frames later after the destination mode has become active.
    && /^(?:enter|active):/.test(failure.failurePhase || '');
  if (intentionalMenuAudioCancellation) {
    return {
      actionable: false,
      reason: 'menu music media request intentionally cancelled during mode entry',
    };
  }
  return { actionable: true, reason: null };
}

function createLocalNetworkTracker(page, origin) {
  let phase = 'boot';
  let nextRequestId = 1;
  let lastActivityAt = Date.now();
  let started = 0;
  let finished = 0;
  let failed = 0;
  let httpErrors = 0;
  const ids = new WeakMap();
  const pending = new Map();
  const failures = [];

  const requestId = (request) => {
    if (!ids.has(request)) ids.set(request, nextRequestId++);
    return ids.get(request);
  };
  const requestDetails = (request, startedPhase = phase) => ({
    requestId: requestId(request),
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    startedPhase,
  });
  const markActivity = () => { lastActivityAt = Date.now(); };

  page.on('request', (request) => {
    if (!isLocalUrl(request.url(), origin)) return;
    started += 1;
    pending.set(request, requestDetails(request));
    markActivity();
  });
  page.on('requestfinished', (request) => {
    if (!isLocalUrl(request.url(), origin)) return;
    finished += 1;
    pending.delete(request);
    markActivity();
  });
  page.on('requestfailed', (request) => {
    if (!isLocalUrl(request.url(), origin)) return;
    failed += 1;
    const details = pending.get(request) || requestDetails(request);
    pending.delete(request);
    failures.push({
      ...details,
      failurePhase: phase,
      kind: 'network',
      error: request.failure()?.errorText || 'failed',
    });
    markActivity();
  });
  page.on('response', (response) => {
    if (!isLocalUrl(response.url(), origin) || response.status() < 400) return;
    httpErrors += 1;
    const request = response.request();
    const details = pending.get(request) || requestDetails(request);
    failures.push({
      ...details,
      failurePhase: phase,
      kind: 'http',
      error: `HTTP ${response.status()}`,
    });
    markActivity();
  });

  return {
    failures,
    setPhase(nextPhase) { phase = nextPhase; },
    async waitForIdle({
      label = 'local network',
      idleMs = LOCAL_NETWORK_IDLE_MS,
      timeoutMs = LOCAL_NETWORK_IDLE_TIMEOUT_MS,
    } = {}) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const quietFor = Date.now() - lastActivityAt;
        // HTML media requests may remain open while the browser streams or
        // buffers playback. They are still tracked and any failure is still
        // classified below, but they cannot define asset readiness. GLBs,
        // textures, scripts, JSON, and other local resources remain blocking.
        const blockingPending = [...pending.values()].filter((entry) => entry.resourceType !== 'media');
        if (blockingPending.length === 0 && quietFor >= idleMs) {
          return {
            idleMs: quietFor,
            pending: pending.size,
            ignoredStreamingMedia: pending.size,
          };
        }
        await page.waitForTimeout(Math.min(100, Math.max(20, idleMs - quietFor)));
      }
      const pendingRequests = [...pending.values()]
        .filter((entry) => entry.resourceType !== 'media')
        .slice(0, 20);
      throw new Error(`Timed out waiting for ${label} to become idle; ${pendingRequests.length} blocking local request(s) remain: ${JSON.stringify(pendingRequests)}`);
    },
    summary() {
      return {
        started,
        finished,
        failed,
        httpErrors,
        pending: pending.size,
        phase,
      };
    },
  };
}

async function inspectLifecycleState(page) {
  return page.evaluate(async (minimumFrames) => {
    const service = window.__kkRendererService;
    const renderer = service?.renderer;
    const mainCanvas = document.getElementById('game-canvas');
    const before = window.__kkMainLoop?.snapshot?.() || null;
    await new Promise((resolve) => {
      const deadline = performance.now() + 20_000;
      const tick = () => {
        const current = window.__kkMainLoop?.snapshot?.();
        const frameAdvance = before && current ? current.frameCount - before.frameCount : 0;
        if (frameAdvance >= minimumFrames || performance.now() >= deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const after = window.__kkMainLoop?.snapshot?.() || null;
    const diagnostics = await Promise.resolve(service?.getDiagnostics?.() || null);
    const backendObject = renderer?.backend;
    const allCanvases = [...document.querySelectorAll('canvas')];
    const directStageCanvases = [...document.querySelectorAll('#kk-stage > canvas')];
    const fullStageCanvases = allCanvases.filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return canvas === mainCanvas
        || (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8);
    });
    const runtimeErrors = window.__kkModeLifecycleSmokeRuntime || { errors: [], rejections: [] };
    const racingSnapshot = window.__kkRacing?.snapshot?.() || null;
    let racingRootCount = 0;
    let racingOwnedObjectCount = 0;
    let bulletHellObjectCount = 0;
    const scene = window.kkState?.scene;
    for (const object of scene?.children || []) {
      if (typeof object?.name === 'string'
        && (object.name.startsWith('kaki-rally-') || object.name.startsWith('kaki-trials-'))) {
        racingRootCount += 1;
      }
    }
    scene?.traverse?.((object) => {
      if (typeof object?.name === 'string'
        && (object.name.startsWith('kaki-rally-') || object.name.startsWith('kaki-trials-'))) {
        racingOwnedObjectCount += 1;
      }
      if (object?.userData?.kkBulletHell === true) bulletHellObjectCount += 1;
    });
    const menuRoot = document.querySelector('.kkv2-root');
    const menuRect = menuRoot?.getBoundingClientRect();
    const renderInfo = renderer?.info?.render || {};
    const baseline = window.__kkModeLifecycleSmokeIdentity || {};

    return {
      serviceState: service?.state || null,
      backend: service?.backend || diagnostics?.backend || null,
      threeRevision: diagnostics?.threeRevision || null,
      rendererIsWebGPURenderer: renderer?.isWebGPURenderer === true,
      backendFlags: {
        webgpu: backendObject?.isWebGPUBackend === true,
        webgl: backendObject?.isWebGLBackend === true,
        deviceReady: backendObject?.isWebGPUBackend === true ? Boolean(backendObject.device) : null,
        webgl2: backendObject?.isWebGLBackend === true
          ? (typeof WebGL2RenderingContext !== 'undefined'
            && backendObject.gl instanceof WebGL2RenderingContext)
          : null,
      },
      identity: {
        serviceStable: baseline.service === service,
        rendererStable: baseline.renderer === renderer,
        canvasStable: baseline.canvas === mainCanvas,
      },
      loop: {
        before,
        after,
        frameAdvance: before && after ? after.frameCount - before.frameCount : 0,
      },
      canvas: {
        mainCanvasCount: document.querySelectorAll('canvas#game-canvas').length,
        directStageCanvasCount: directStageCanvases.length,
        fullStageCanvasCount: fullStageCanvases.length,
        totalDocumentCanvasCount: allCanvases.length,
        rendererOwnsMainCanvas: renderer?.domElement === mainCanvas && service?.canvas === mainCanvas,
      },
      renderInfo: {
        drawCalls: Number(renderInfo.drawCalls ?? renderInfo.calls ?? 0),
        triangles: Number(renderInfo.triangles ?? 0),
      },
      game: {
        mode: window.kkState?.mode || null,
        started: window.kkState?.started === true,
        hasRacingSession: Boolean(window.kkState?.racing),
        raceMode: racingSnapshot?.raceMode || null,
        bulletHellActive: window.__kkBh?.active === true,
      },
      assets: racingSnapshot?.assets
        ? {
            ids: Array.isArray(racingSnapshot.assets.ids) ? [...racingSnapshot.assets.ids] : [],
            error: racingSnapshot.assets.error || '',
            cache: Array.isArray(racingSnapshot.assets.cache)
              ? racingSnapshot.assets.cache.map((entry) => ({ ...entry }))
              : [],
          }
        : null,
      dom: {
        racingHudCount: document.querySelectorAll('#kk-racing-hud, .kkt-hud').length,
        bulletHellHudCount: document.querySelectorAll('#kk-bh-hud').length,
        bulletHellFlashCount: document.querySelectorAll('#kk-bh-flash').length,
        bulletHellNoticeCount: document.querySelectorAll('#kk-bh-notice').length,
      },
      scene: { racingRootCount, racingOwnedObjectCount, bulletHellObjectCount },
      menu: {
        present: Boolean(menuRoot),
        visible: Boolean(menuRect && menuRect.width > 100 && menuRect.height > 100),
      },
      runtimeErrors: JSON.parse(JSON.stringify(runtimeErrors)),
    };
  }, MIN_FRAME_ADVANCE);
}

async function waitForMainFrames(page, minimumFrames = POST_ASSET_FRAME_ADVANCE) {
  return page.evaluate(async ({ minimumFrames: requiredFrames, timeoutMs }) => {
    const before = window.__kkMainLoop?.snapshot?.() || null;
    const deadline = performance.now() + timeoutMs;
    await new Promise((resolve) => {
      const tick = () => {
        const current = window.__kkMainLoop?.snapshot?.() || null;
        const frameAdvance = before && current ? current.frameCount - before.frameCount : 0;
        if (frameAdvance >= requiredFrames || performance.now() >= deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const after = window.__kkMainLoop?.snapshot?.() || null;
    return {
      before,
      after,
      frameAdvance: before && after ? after.frameCount - before.frameCount : 0,
    };
  }, { minimumFrames, timeoutMs: 20_000 });
}

async function enterMode(page, mode) {
  await page.evaluate(async (definition) => {
    if (definition.kind === 'bullethell') {
      await window.kkStartBulletHell();
    } else {
      await window.kkStartRacing(definition.courseId, definition.options);
    }
  }, mode);
  await page.waitForFunction((definition) => {
    if (definition.kind === 'bullethell') {
      return window.kkState?.mode === 'bullethell'
        && window.kkState?.started === true
        && window.__kkBh?.active === true
        && document.querySelectorAll('#kk-bh-hud').length === 1;
    }
    const snapshot = window.__kkRacing?.snapshot?.();
    return window.kkState?.mode === 'racing'
      && window.kkState?.started === true
      && snapshot?.raceMode === definition.raceMode
      && document.querySelectorAll('#kk-racing-hud, .kkt-hud').length === 1;
  }, mode, { timeout: 120_000 });
  if (mode.kind === 'racing') {
    await page.evaluate(() => window.__kkRacing?.skipCountdown?.());
    await page.evaluate(async () => {
      const session = window.kkState?.racing;
      const ready = session?.assetLease?.ready;
      if (!session || !ready || typeof ready.then !== 'function') {
        throw new Error('Racing mode did not expose an asset lease readiness promise.');
      }
      await ready;
      if (window.kkState?.racing !== session) {
        throw new Error('Racing session changed while its asset lease was loading.');
      }
    });
    const postAssetFrames = await waitForMainFrames(page, POST_ASSET_FRAME_ADVANCE);
    return { racingAssetsReady: true, postAssetFrames };
  }
  return { racingAssetsReady: null, postAssetFrames: null };
}

async function returnToMenu(page) {
  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => (
    window.kkState?.mode === 'menu'
      && window.kkState?.started === false
      && !window.kkState?.racing
      && !window.__kkRacing
      && !window.__kkBh?.active
      && !document.querySelector('#kk-racing-hud, .kkt-hud, #kk-bh-hud, #kk-bh-flash')
      && document.querySelector('.kkv2-root')
  ), null, { timeout: 60_000 });
}

async function validateCase(browser, origin, requestedBackend, launchMetadata) {
  const failures = [];
  const pageErrors = [];
  const consoleErrors = [];
  const transitions = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  await context.route(/^https:\/\/fonts\.googleapis\.com\//, (route) => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '/* mode lifecycle smoke: use local fallbacks */',
  }));
  await context.route(/^https:\/\/fonts\.gstatic\.com\//, (route) => route.fulfill({ status: 204, body: '' }));
  await context.addInitScript(() => {
    window.__kkModeLifecycleSmokeRuntime = { errors: [], rejections: [] };
    window.addEventListener('error', (event) => {
      window.__kkModeLifecycleSmokeRuntime.errors.push({
        message: event.message || 'window error',
        source: event.filename || null,
        line: event.lineno || null,
        column: event.colno || null,
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__kkModeLifecycleSmokeRuntime.rejections.push({
        name: reason?.name || null,
        message: reason?.message || String(reason),
        stack: reason?.stack || null,
      });
    });
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
  });

  const page = await context.newPage();
  const network = createLocalNetworkTracker(page, origin);
  page.on('pageerror', (error) => pageErrors.push({ message: error.message, stack: error.stack || null }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    consoleErrors.push({
      text: message.text(),
      url: location.url || page.url(),
      line: location.lineNumber ?? null,
      column: location.columnNumber ?? null,
    });
  });

  const url = new URL('index.html', origin);
  url.searchParams.set('renderer', requestedBackend);
  url.searchParams.set('rendererDiagnostics', '1');
  url.searchParams.set('modeLifecycleSmoke', '1');

  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => (
      window.__kkRendererService?.state === 'ready'
        && window.__kkMainLoop?.snapshot?.().running === true
        && window.__kkMainLoop?.snapshot?.().startCount === 1
        && typeof window.kkStartBulletHell === 'function'
        && typeof window.kkStartRacing === 'function'
        && typeof window.kkReturnToMenu === 'function'
        && document.querySelector('.kkv2-root')
        && !document.getElementById('kk-boot-loader')
    ), null, { timeout: 180_000 });
    await page.evaluate(() => {
      window.__kkModeLifecycleSmokeIdentity = {
        service: window.__kkRendererService,
        renderer: window.__kkRendererService?.renderer,
        canvas: document.getElementById('game-canvas'),
      };
    });
    network.setPhase('menu:boot');
    await network.waitForIdle({ label: 'boot menu preview requests' });

    const boot = await inspectLifecycleState(page);
    const bootFailures = validateLifecycleSnapshot(boot, {
      backend: requestedBackend,
      phase: 'menu',
    });
    failures.push(...bootFailures.map((failure) => `boot: ${failure}`));
    transitions.push({ id: 'boot', phase: 'menu', status: bootFailures.length ? 'failed' : 'passed', snapshot: boot });
    console.error(`[mode-lifecycle:${requestedBackend}] boot ${bootFailures.length ? 'FAILED' : 'passed'}`);

    let bulletHellObjectBaseline = null;
    for (const mode of MODE_SEQUENCE) {
      try {
        network.setPhase(`menu:before-${mode.id}`);
        await network.waitForIdle({ label: `menu requests before ${mode.id}` });
        network.setPhase(`enter:${mode.id}`);
        console.error(`[mode-lifecycle:${requestedBackend}] entering ${mode.id}`);
        const readiness = await enterMode(page, mode);
        await network.waitForIdle({ label: `${mode.id} active asset requests` });
        network.setPhase(`active:${mode.id}`);
        const active = await inspectLifecycleState(page);
        active.readiness = readiness;
        const activeFailures = validateLifecycleSnapshot(active, {
          backend: requestedBackend,
          phase: 'active',
          mode,
        });
        if (mode.kind === 'bullethell') {
          if (bulletHellObjectBaseline === null) {
            bulletHellObjectBaseline = active.scene.bulletHellObjectCount;
          } else {
            addCheck(activeFailures,
              active.scene.bulletHellObjectCount === bulletHellObjectBaseline,
              `Bullet Hell re-entry owns ${active.scene.bulletHellObjectCount} scene objects; first entry owned ${bulletHellObjectBaseline}`);
          }
        }
        failures.push(...activeFailures.map((failure) => `${mode.id} active: ${failure}`));
        transitions.push({
          id: mode.id,
          label: mode.label,
          phase: 'active',
          status: activeFailures.length ? 'failed' : 'passed',
          snapshot: active,
        });
        console.error(`[mode-lifecycle:${requestedBackend}] ${mode.id} active ${activeFailures.length ? 'FAILED' : 'passed'}`);

        await network.waitForIdle({ label: `requests before exiting ${mode.id}` });
        network.setPhase(`exit:${mode.id}`);
        await returnToMenu(page);
        network.setPhase(`menu:after-${mode.id}`);
        const menu = await inspectLifecycleState(page);
        const menuFailures = validateLifecycleSnapshot(menu, {
          backend: requestedBackend,
          phase: 'menu',
          mode,
        });
        failures.push(...menuFailures.map((failure) => `${mode.id} exit: ${failure}`));
        transitions.push({
          id: mode.id,
          label: mode.label,
          phase: 'menu',
          status: menuFailures.length ? 'failed' : 'passed',
          snapshot: menu,
        });
        console.error(`[mode-lifecycle:${requestedBackend}] ${mode.id} exit ${menuFailures.length ? 'FAILED' : 'passed'}`);
      } catch (error) {
        failures.push(`${mode.id}: ${serializeError(error)}`);
        transitions.push({ id: mode.id, label: mode.label, phase: 'exception', status: 'failed', error: serializeError(error) });
        break;
      }
    }
    network.setPhase('menu:final');
    await network.waitForIdle({ label: 'final menu preview requests' });
  } catch (error) {
    failures.push(`startup/lifecycle inspection failed: ${serializeError(error)}`);
  }

  const requestFailures = network.failures.map((failure) => ({
    ...failure,
    classification: classifyRequestFailure(failure),
  }));
  const ignoredRequestFailures = requestFailures.filter((failure) => !failure.classification.actionable);
  const actionableRequestFailures = requestFailures.filter((failure) => failure.classification.actionable);
  failures.push(...validateBrowserSignals({
    consoleErrors,
    pageErrors,
    requestFailures: actionableRequestFailures,
  }));

  await context.close();
  return {
    status: failures.length ? 'failed' : 'passed',
    ...launchMetadata,
    requestedBackend,
    transitionCount: transitions.length,
    transitions,
    pageErrors,
    consoleErrors,
    requestFailures,
    ignoredRequestFailures,
    network: network.summary(),
    failures,
  };
}

async function runBrowserCase({ chromium, chromiumPath, config, origin, backend, args, profile }) {
  let browser = null;
  let browserVersion = null;
  try {
    browser = await chromium.launch({
      headless: !config.headed,
      executablePath: chromiumPath || undefined,
      args,
    });
    browserVersion = browser.version();
    const launchEvidence = createLaunchEvidence({
      profile,
      args,
      browserVersion,
      browserExecutable: chromiumPath,
    });
    return await validateCase(browser, origin, backend, launchEvidence);
  } catch (error) {
    return {
      status: 'failed',
      ...createLaunchEvidence({
        profile,
        args,
        browserVersion,
        browserExecutable: chromiumPath,
      }),
      requestedBackend: backend,
      failures: [`browser case failed: ${serializeError(error)}`],
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const { chromium, chromiumPath } = resolveBrowserTools();
  const browserExecutable = chromiumPath || chromium.executablePath?.() || null;
  const attribution = collectLifecycleAttribution({
    browserExecutable,
    reportOutput: config.output,
  });
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
    origin,
    source: attribution.source,
    three: attribution.three,
    harness: {
      ...attribution.harness,
      headed: config.headed,
      requestedBackends: [
        ...(config.webgl ? ['webgl'] : []),
        ...(config.webgpu ? ['webgpu'] : []),
      ],
    },
    exclusions: ['Kaki Catastrophe'],
    sequence: MODE_SEQUENCE.map(({ id, label, kind, raceMode }) => ({ id, label, kind, raceMode: raceMode || null })),
    cases: [],
  };

  try {
    if (config.webgl) {
      report.cases.push(await runBrowserCase({
        chromium,
        chromiumPath: browserExecutable,
        config,
        origin,
        backend: 'webgl',
        args: SOFTWARE_WEBGL_ARGS,
        profile: 'software-webgl2',
      }));
    }
    if (config.webgpu) {
      report.cases.push(await runBrowserCase({
        chromium,
        chromiumPath: browserExecutable,
        config,
        origin,
        backend: 'webgpu',
        args: SOFTWARE_WEBGPU_ARGS,
        profile: 'software-webgpu',
      }));
    }

    if (config.output) {
      const outputPath = path.resolve(ROOT, config.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
    const failed = report.cases.filter((entry) => entry.status !== 'passed');
    if (failed.length) {
      throw new Error(`${failed.length}/${report.cases.length} mode lifecycle backend case(s) failed: ${failed.map((entry) => entry.requestedBackend).join(', ')}`);
    }
    console.log(`PASS: ${report.cases.length} backend case(s), ${MODE_SEQUENCE.length} repeated mode entries each.`);
  } finally {
    if (ownedServer) await new Promise((resolve) => ownedServer.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main().catch((error) => {
    console.error(`FAIL: ${serializeError(error)}`);
    process.exitCode = 1;
  });
}
