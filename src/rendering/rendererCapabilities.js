import { RENDERER_BACKENDS } from './rendererSettings.js';

export function hasWebGPUApi(navigatorLike = globalThis.navigator) {
  return !!(
    navigatorLike
    && navigatorLike.gpu
    && typeof navigatorLike.gpu.requestAdapter === 'function'
  );
}

/**
 * The renderer type flag is deliberately not consulted here: a
 * WebGPURenderer using its WebGL 2 fallback still has `isWebGPURenderer=true`.
 */
export function detectRendererBackend(renderer) {
  const backend = renderer && renderer.backend;
  if (backend && backend.isWebGPUBackend === true) return RENDERER_BACKENDS.WEBGPU;
  if (backend && backend.isWebGLBackend === true) return RENDERER_BACKENDS.WEBGL;
  return 'unknown';
}

export function rendererHasInitialized(renderer) {
  if (!renderer) return false;
  if (typeof renderer.hasInitialized === 'function') {
    try { return renderer.hasInitialized() === true; } catch (_) { return false; }
  }
  return false;
}

function safeNumber(read, fallback = null) {
  try {
    const value = Number(read());
    return Number.isFinite(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

export function getRendererCapabilities(renderer, options = {}) {
  const backend = detectRendererBackend(renderer);
  const backendObject = renderer && renderer.backend;
  const device = backend === RENDERER_BACKENDS.WEBGPU && backendObject
    ? backendObject.device
    : null;

  const result = {
    backend,
    initialized: rendererHasInitialized(renderer),
    webgpuApiPresent: hasWebGPUApi(options.navigatorLike),
    forceWebGL: !!(backendObject && backendObject.parameters && backendObject.parameters.forceWebGL),
    compatibilityMode: backendObject && typeof backendObject.compatibilityMode === 'boolean'
      ? backendObject.compatibilityMode
      : null,
    maxAnisotropy: safeNumber(() => (
      renderer.getMaxAnisotropy?.()
      ?? renderer.capabilities?.getMaxAnisotropy?.()
    )),
    samples: safeNumber(() => renderer.currentSamples),
    backendDescription: backend === RENDERER_BACKENDS.WEBGPU
      ? 'WebGPU'
      : backend === RENDERER_BACKENDS.WEBGL ? 'WebGL 2' : 'Unknown',
    deviceLabel: options.includeDeviceLabel
      && device
      && typeof device.label === 'string'
      && device.label.trim()
      ? device.label.trim()
      : null,
    features: [],
    limits: null,
  };

  if (
    options.includeFeatures
    && device
    && device.features
    && typeof device.features.values === 'function'
  ) {
    try { result.features = Array.from(device.features.values()).sort(); } catch (_) {}
  }

  // Limits are useful for debugging, but can contribute to fingerprinting.
  // Only include the caller-approved subset and only in diagnostics mode.
  if (device && device.limits && Array.isArray(options.limitNames)) {
    result.limits = {};
    for (const name of options.limitNames) {
      const value = device.limits[name];
      if (typeof value === 'number') result.limits[name] = value;
    }
  }

  return result;
}

export function assertRequestedBackend(renderer, preference) {
  const actual = detectRendererBackend(renderer);
  if (preference === RENDERER_BACKENDS.WEBGPU && actual !== RENDERER_BACKENDS.WEBGPU) {
    throw new Error(`WebGPU was required, but WebGPURenderer initialized the ${actual} backend.`);
  }
  if (preference === RENDERER_BACKENDS.WEBGL && actual !== RENDERER_BACKENDS.WEBGL) {
    throw new Error(`WebGL 2 was required, but WebGPURenderer initialized the ${actual} backend.`);
  }
  if (actual === 'unknown') {
    throw new Error('WebGPURenderer initialized without a recognizable backend flag.');
  }
  return actual;
}
