/**
 * Renderer settings that are safe to evaluate before Three.js is loaded.
 *
 * Keep numeric Three.js constants (tone mapping, output color space, shadow
 * type, output buffer type) out of this module. Integration supplies those via
 * `rendererProperties` or `configureRenderer`, which prevents a second Three.js
 * build from entering the application during the staged migration.
 */

export const RENDERER_BACKENDS = Object.freeze({
  AUTO: 'auto',
  WEBGPU: 'webgpu',
  WEBGL: 'webgl',
});

export const QUALITY_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  ULTRA: 'ultra',
});

export const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({
    dprCap: 0.85,
    bloom: false,
    bloomScale: 0.5,
    grading: 'minimal',
    vignette: false,
    dithering: false,
    chromaticAberration: false,
    particleBrightnessScale: 0.72,
  }),
  medium: Object.freeze({
    dprCap: 1,
    bloom: true,
    bloomScale: 0.5,
    grading: 'full',
    vignette: true,
    dithering: true,
    chromaticAberration: false,
    particleBrightnessScale: 0.88,
  }),
  high: Object.freeze({
    dprCap: 1.25,
    bloom: true,
    bloomScale: 0.75,
    grading: 'full',
    vignette: true,
    dithering: true,
    chromaticAberration: true,
    particleBrightnessScale: 1,
  }),
  ultra: Object.freeze({
    dprCap: 1.75,
    bloom: true,
    bloomScale: 1,
    grading: 'full',
    vignette: true,
    dithering: true,
    chromaticAberration: true,
    particleBrightnessScale: 1,
  }),
});

export const DEFAULT_RENDERER_SETTINGS = Object.freeze({
  antialias: false,
  alpha: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  quality: QUALITY_LEVELS.HIGH,
  dprCap: 1.25,
  dynamicResolutionScale: 1,
  pixelRatio: null,
  width: null,
  height: null,
  updateStyle: true,
  autoRecover: false,
  resetInfoBeforeRender: true,
  captureMimeType: 'image/png',
  captureQuality: undefined,
});

const BACKEND_VALUES = new Set(Object.values(RENDERER_BACKENDS));
const QUALITY_VALUES = new Set(Object.values(QUALITY_LEVELS));

export function normalizeBackendPreference(value, fallback = RENDERER_BACKENDS.AUTO) {
  const normalized = String(value || '').trim().toLowerCase();
  if (BACKEND_VALUES.has(normalized)) return normalized;
  return BACKEND_VALUES.has(fallback) ? fallback : RENDERER_BACKENDS.AUTO;
}

export function normalizeQualityLevel(value, fallback = QUALITY_LEVELS.HIGH) {
  const normalized = String(value || '').trim().toLowerCase();
  if (QUALITY_VALUES.has(normalized)) return normalized;
  return QUALITY_VALUES.has(fallback) ? fallback : QUALITY_LEVELS.HIGH;
}

/**
 * Resolve the renderer backend before asynchronous renderer initialization.
 * An explicit `?renderer=` parameter always wins, including an invalid value
 * (which strictly normalizes to `auto` instead of falling through to a saved
 * forced backend). Without the parameter, the validated saved preference is
 * used.
 */
export function readBackendPreference(search = '', savedPreference = RENDERER_BACKENDS.AUTO) {
  const saved = normalizeBackendPreference(savedPreference);
  try {
    const params = search instanceof URLSearchParams
      ? search
      : new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (!params.has('renderer')) return saved;
    return normalizeBackendPreference(params.get('renderer'));
  } catch (_) {
    return saved;
  }
}

/**
 * Apply a persisted renderer choice by removing a temporary URL override while
 * preserving every unrelated query parameter and the fragment.
 */
export function rendererPreferenceReloadUrl(currentHref) {
  try {
    const url = new URL(String(currentHref || ''));
    url.searchParams.delete('renderer');
    return url.href;
  } catch (_) {
    return String(currentHref || '');
  }
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function resolvePixelRatio(settings, devicePixelRatio = 1) {
  const requested = settings.pixelRatio == null
    ? finitePositive(devicePixelRatio, 1)
    : finitePositive(settings.pixelRatio, 1);
  const dprCap = finitePositive(settings.dprCap, DEFAULT_RENDERER_SETTINGS.dprCap);
  const dynamicScale = Math.min(1, finitePositive(settings.dynamicResolutionScale, 1));
  return Math.max(0.25, Math.min(requested, dprCap) * dynamicScale);
}

export function normalizeRendererSettings(input = {}, environment = {}) {
  const quality = normalizeQualityLevel(input.quality);
  const preset = QUALITY_PRESETS[quality];
  const settings = {
    ...DEFAULT_RENDERER_SETTINGS,
    ...preset,
    ...input,
    quality,
  };

  settings.dprCap = finitePositive(settings.dprCap, preset.dprCap);
  settings.dynamicResolutionScale = Math.max(
    0.25,
    Math.min(1, finitePositive(settings.dynamicResolutionScale, 1)),
  );
  settings.width = settings.width == null ? null : finitePositive(settings.width, null);
  settings.height = settings.height == null ? null : finitePositive(settings.height, null);
  settings.pixelRatioIsExplicit = input.pixelRatio != null;
  settings.requestedPixelRatio = settings.pixelRatioIsExplicit
    ? finitePositive(input.pixelRatio, 1)
    : null;
  settings.pixelRatio = resolvePixelRatio(
    settings,
    environment.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
  );
  settings.rendererOptions = { ...(input.rendererOptions || {}) };
  settings.rendererProperties = { ...(input.rendererProperties || {}) };

  return settings;
}
