import {
  QUALITY_PRESETS,
  normalizeQualityLevel,
} from './rendererSettings.js';

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
export function createQualityManager({
  renderer,
  initialSettings = {},
  presets = QUALITY_PRESETS,
  devicePixelRatioProvider = () => globalThis.devicePixelRatio || 1,
  applyPostfx = null,
  onChange = null,
} = {}) {
  if (!renderer) throw new TypeError('createQualityManager requires a renderer.');

  let quality = normalizeQualityLevel(initialSettings.quality);
  let dynamicResolutionScale = Math.max(
    0.25,
    Math.min(1, positive(initialSettings.dynamicResolutionScale, 1)),
  );
  let width = positive(initialSettings.width, 1);
  let height = positive(initialSettings.height, 1);
  let updateStyle = initialSettings.updateStyle !== false;
  const requestedPixelRatio = initialSettings.pixelRatioIsExplicit
    ? positive(initialSettings.requestedPixelRatio ?? initialSettings.pixelRatio, 1)
    : null;

  const getPreset = (level = quality) => ({ ...presets[level] });
  const getPixelRatio = (level = quality, scale = dynamicResolutionScale) => {
    const base = requestedPixelRatio ?? positive(devicePixelRatioProvider(), 1);
    return Math.max(0.25, Math.min(base, positive(getPreset(level).dprCap, 1.25)) * scale);
  };

  const applyResolution = (level = quality, scale = dynamicResolutionScale) => {
    const pixelRatio = getPixelRatio(level, scale);
    if (typeof renderer.setPixelRatio === 'function') renderer.setPixelRatio(pixelRatio);
    if (typeof renderer.setSize === 'function') renderer.setSize(width, height, updateStyle);
    return pixelRatio;
  };

  const makeState = (level = quality, scale = dynamicResolutionScale) => Object.freeze({
    quality: level,
    width,
    height,
    pixelRatio: getPixelRatio(level, scale),
    dynamicResolutionScale: scale,
    ...getPreset(level),
  });

  const applyPostfxSynchronously = (state) => {
    if (typeof applyPostfx !== 'function') return;
    const result = applyPostfx(state);
    if (result && typeof result.then === 'function') {
      // Prevent a rejected accidental async callback from becoming an
      // unhandled rejection after we report the contract violation.
      result.catch?.(() => {});
      throw new TypeError(
        'QualityManager applyPostfx must be synchronous; rebuild async pipelines before committing quality.',
      );
    }
  };

  const notifyChange = (state) => {
    if (typeof onChange === 'function') onChange(state);
    return state;
  };

  const manager = {
    apply() {
      const state = makeState();
      // Let post-processing reject topology-changing presets before DPR or
      // settings mutate. This keeps a failed LOW <-> bloom transition atomic.
      applyPostfxSynchronously(state);
      applyResolution();
      return notifyChange(state);
    },

    setQuality(nextQuality) {
      const candidateQuality = normalizeQualityLevel(nextQuality, quality);
      const candidate = makeState(candidateQuality, dynamicResolutionScale);
      applyPostfxSynchronously(candidate);
      quality = candidateQuality;
      applyResolution();
      return notifyChange(candidate);
    },

    setDynamicResolutionScale(scale) {
      const candidateScale = Math.max(0.25, Math.min(1, positive(scale, 1)));
      const candidate = makeState(quality, candidateScale);
      applyPostfxSynchronously(candidate);
      dynamicResolutionScale = candidateScale;
      applyResolution();
      return notifyChange(candidate);
    },

    resize(nextWidth, nextHeight, options = {}) {
      width = positive(nextWidth, width);
      height = positive(nextHeight, height);
      if (options.updateStyle != null) updateStyle = options.updateStyle !== false;
      const pixelRatio = applyResolution();
      return { width, height, pixelRatio };
    },

    getState() {
      return makeState();
    },
  };

  return manager;
}
