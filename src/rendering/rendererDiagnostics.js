import { detectRendererBackend, getRendererCapabilities } from './rendererCapabilities.js';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)))];
}

/**
 * Normalizes WebGPURenderer diagnostic counters across its WebGPU and WebGL 2
 * backends. In r185, `render.calls` is cumulative and `drawCalls` is the
 * per-frame draw count.
 */
export function readRendererInfo(info) {
  const render = info && info.render ? info.render : {};
  const memory = info && info.memory ? info.memory : {};
  return {
    drawCalls: finite(render.drawCalls ?? render.calls),
    renderCalls: finite(render.calls),
    frameRenderCalls: finite(render.frameCalls ?? render.calls),
    triangles: finite(render.triangles),
    points: finite(render.points),
    lines: finite(render.lines),
    gpuFrameTimeMs: finite(render.timestamp, 0) > 0 ? finite(render.timestamp) : null,
    textures: finite(memory.textures),
    renderTargets: finite(memory.renderTargets),
    geometries: finite(memory.geometries),
    gpuMemoryBytes: finite(memory.total, null),
    programs: finite(memory.programs ?? (info && info.programs && info.programs.length)),
  };
}

function canvasResolution(renderer) {
  const canvas = renderer && renderer.domElement;
  if (!canvas) return { width: 0, height: 0, cssWidth: 0, cssHeight: 0 };
  return {
    width: finite(canvas.width),
    height: finite(canvas.height),
    cssWidth: finite(canvas.clientWidth, finite(canvas.width)),
    cssHeight: finite(canvas.clientHeight, finite(canvas.height)),
  };
}

export function createRendererDiagnostics({
  renderer,
  threeRevision = null,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  sampleCount = 120,
  contextProvider = null,
} = {}) {
  if (!renderer) throw new TypeError('createRendererDiagnostics requires a renderer.');

  const frameTimes = [];
  const frameIntervals = [];
  const renderSubmissionTimes = [];
  const compilationEvents = [];
  let frameStart = null;
  let renderSubmissionStart = null;
  let previousFrameStart = null;
  let deviceLossCount = 0;
  let compilationEventTotal = 0;

  const pushSample = (array, value) => {
    if (!Number.isFinite(value) || value < 0) return;
    array.push(value);
    while (array.length > sampleCount) array.shift();
  };

  const diagnostics = {
    beginFrame(timestamp = now()) {
      frameStart = finite(timestamp, now());
      if (previousFrameStart != null) pushSample(frameIntervals, frameStart - previousFrameStart);
      previousFrameStart = frameStart;
    },

    endFrame(timestamp = now()) {
      if (frameStart == null) return;
      pushSample(frameTimes, finite(timestamp, frameStart) - frameStart);
      frameStart = null;
    },

    beginRenderSubmission(timestamp = now()) {
      renderSubmissionStart = finite(timestamp, now());
    },

    endRenderSubmission(timestamp = now()) {
      if (renderSubmissionStart == null) return;
      pushSample(
        renderSubmissionTimes,
        finite(timestamp, renderSubmissionStart) - renderSubmissionStart,
      );
      renderSubmissionStart = null;
    },

    recordCompilation(event = {}) {
      compilationEventTotal += 1;
      compilationEvents.push({
        time: Date.now(),
        type: event.type || 'pipeline',
        label: event.label || null,
        durationMs: finite(event.durationMs, null),
        status: event.status || 'complete',
      });
      while (compilationEvents.length > 100) compilationEvents.shift();
    },

    recordDeviceLoss() {
      deviceLossCount += 1;
      return deviceLossCount;
    },

    snapshot(overrides = {}) {
      const context = typeof contextProvider === 'function' ? (contextProvider() || {}) : {};
      const resolution = canvasResolution(renderer);
      const interval = mean(frameIntervals);
      const capabilities = getRendererCapabilities(renderer, { includeDeviceLabel: true });
      return {
        backend: detectRendererBackend(renderer),
        deviceDescription: capabilities.deviceLabel || capabilities.backendDescription || null,
        threeRevision,
        initialized: typeof renderer.hasInitialized === 'function'
          ? renderer.hasInitialized()
          : null,
        resolution,
        dpr: typeof renderer.getPixelRatio === 'function'
          ? finite(renderer.getPixelRatio(), null)
          : null,
        fps: interval > 0 ? 1000 / interval : 0,
        cpuFrameTimeMs: frameTimes.length ? mean(frameTimes) : null,
        cpuFrameTimeP99Ms: frameTimes.length ? percentile(frameTimes, 0.99) : null,
        renderSubmissionTimeMs: renderSubmissionTimes.length
          ? mean(renderSubmissionTimes)
          : null,
        renderSubmissionTimeP99Ms: renderSubmissionTimes.length
          ? percentile(renderSubmissionTimes, 0.99)
          : null,
        ...readRendererInfo(renderer.info),
        compilationEventCount: compilationEventTotal,
        recentCompilationEvents: compilationEvents.slice(-10),
        deviceLossCount,
        ...context,
        ...overrides,
      };
    },

    getCapabilities(options) {
      return getRendererCapabilities(renderer, options);
    },

    resetFrameSamples() {
      frameTimes.length = 0;
      frameIntervals.length = 0;
      renderSubmissionTimes.length = 0;
      frameStart = null;
      renderSubmissionStart = null;
      previousFrameStart = null;
    },
  };

  return diagnostics;
}

export function formatRendererDiagnostics(snapshot) {
  const value = snapshot || {};
  const resolution = value.resolution || {};
  const compilationEvents = Array.isArray(value.recentCompilationEvents)
    ? value.recentCompilationEvents
    : [];
  const latestCompilation = compilationEvents.at(-1) || null;
  const lines = [
    `Backend: ${value.backend || 'unknown'}`,
    `Device: ${value.deviceDescription || 'not exposed'}`,
    `Three.js: ${value.threeRevision || 'unknown'}`,
    `Resolution: ${resolution.width || 0}x${resolution.height || 0} @ DPR ${value.dpr ?? 'unknown'}`,
    `Quality: ${value.quality || 'unknown'}`,
    `FPS: ${finite(value.fps).toFixed(1)}`,
    `CPU frame: ${value.cpuFrameTimeMs == null ? 'unavailable' : `${finite(value.cpuFrameTimeMs).toFixed(2)} ms`}`,
    `Render submit: ${value.renderSubmissionTimeMs == null ? 'unavailable' : `${finite(value.renderSubmissionTimeMs).toFixed(2)} ms`}`,
    `GPU frame: ${value.gpuFrameTimeMs == null ? 'unavailable' : `${finite(value.gpuFrameTimeMs).toFixed(2)} ms`}`,
    `Draw calls: ${finite(value.drawCalls)}`,
    `Triangles: ${finite(value.triangles)}`,
    `Points: ${finite(value.points)}`,
    `Lines: ${finite(value.lines)}`,
    `Geometries: ${finite(value.geometries)}`,
    `Textures: ${finite(value.textures)}`,
    `Render targets: ${finite(value.renderTargets)}`,
    `Scene: ${value.activeScene || 'unknown'}`,
    `Mode: ${value.activeMode || 'unknown'}`,
    `Dynamic resolution: ${value.dynamicResolutionScale ?? 1}`,
    `Compilation events: ${finite(value.compilationEventCount)}`,
    `Device losses: ${finite(value.deviceLossCount)}`,
  ];
  if (latestCompilation) {
    const duration = latestCompilation.durationMs == null
      ? ''
      : `, ${finite(latestCompilation.durationMs).toFixed(2)} ms`;
    const label = latestCompilation.label ? ` ${latestCompilation.label}` : '';
    lines.push(
      `Latest compilation: ${latestCompilation.type || 'pipeline'}${label} — `
      + `${latestCompilation.status || 'complete'}${duration}`,
    );
  }
  return lines.join('\n');
}

export async function copyRendererDiagnostics(snapshot, clipboard = globalThis.navigator?.clipboard) {
  const text = formatRendererDiagnostics(snapshot);
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('Clipboard API is unavailable.');
  }
  await clipboard.writeText(text);
  return text;
}
