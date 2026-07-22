import { uniform } from 'three/tsl';

export const COLORBLIND_MODES = Object.freeze({
  off: 0,
  deuteranopia: 1,
  protanopia: 2,
  tritanopia: 3,
});

export function createAccessibilityUniforms() {
  return {
    uReduceMotion: uniform(0),
    uReduceFlashing: uniform(0),
    uColorblind: uniform(0),
    uHighContrast: uniform(0),
  };
}
function uniformMap(target) {
  return target?.uniforms || target || null;
}

function writeUniform(uniforms, name, value) {
  if (uniforms?.[name] && 'value' in uniforms[name]) uniforms[name].value = value;
}

/**
 * Updates the stable accessibility uniforms without replacing the node graph.
 * Accepts either the complete uniform map or the compatibility `postFXPass`.
 */
export function applyAccessibilityOptions(target, options = {}) {
  const uniforms = uniformMap(target);
  if (!uniforms) return null;

  const reduceMotion = Boolean(options.reduceMotion ?? options.reducedMotion);
  const reduceFlashing = Boolean(options.reduceFlashing ?? options.reducedFlashing);
  const highContrast = Boolean(options.highContrast);
  const colorblindName = options.colorblind ?? options.colorBlind ?? 'off';
  const colorblind = COLORBLIND_MODES[colorblindName] ?? COLORBLIND_MODES.off;

  writeUniform(uniforms, 'uReduceMotion', reduceMotion ? 1 : 0);
  writeUniform(uniforms, 'uReduceFlashing', reduceFlashing ? 1 : 0);
  writeUniform(uniforms, 'uHighContrast', highContrast ? 1 : 0);
  writeUniform(uniforms, 'uColorblind', colorblind);

  return { reduceMotion, reduceFlashing, highContrast, colorblind, colorblindName };
}
