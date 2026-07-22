/**
 * Renderer-neutral selective-bloom membership.
 *
 * Layer 1 remains the released game's serialized/runtime convention, but
 * gameplay modules import it from this dependency-free module instead of
 * loading either the legacy composer or the WebGPU post graph.
 */
export const BLOOM_LAYER = 1;
export const BLOOM_INTENSITY_KEY = 'kkSelectiveBloomIntensity';

function finiteIntensity(value) {
  const intensity = Number(value);
  if (!Number.isFinite(intensity) || intensity < 0) {
    throw new RangeError('Selective-bloom intensity must be a finite number >= 0.');
  }
  return intensity;
}

function applyMembership(object, enabled, intensity) {
  if (!object?.layers?.enable || !object?.layers?.disable) return false;
  if (enabled) object.layers.enable(BLOOM_LAYER);
  else object.layers.disable(BLOOM_LAYER);
  if (object.userData && typeof object.userData === 'object') {
    object.userData[BLOOM_INTENSITY_KEY] = enabled ? intensity : 0;
  }
  return true;
}

/**
 * Mark an Object3D as a selective-bloom contributor without exposing MRT
 * attachment names to gameplay. Existing direct layer calls remain compatible.
 */
export function setSelectiveBloom(object, enabled = true, intensity = 1, options = {}) {
  const resolvedIntensity = finiteIntensity(intensity);
  let changed = 0;
  const apply = (entry) => {
    if (applyMembership(entry, enabled && resolvedIntensity > 0, resolvedIntensity)) changed += 1;
  };
  if (options.recursive === true && typeof object?.traverse === 'function') object.traverse(apply);
  else apply(object);
  return changed;
}

export function getSelectiveBloomIntensity(object) {
  if (!object?.layers?.isEnabled?.(BLOOM_LAYER)) return 0;
  const stored = object.userData?.[BLOOM_INTENSITY_KEY];
  return Number.isFinite(stored) && stored >= 0 ? stored : 1;
}

export function isSelectiveBloom(object) {
  return getSelectiveBloomIntensity(object) > 0;
}
