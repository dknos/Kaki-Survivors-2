import {
  Fn,
  clamp,
  float,
  max,
  mix,
  pow,
  vec3,
  vec4,
} from 'three/tsl';

function colorblindRemap(color, mode) {
  const deuteranopia = vec3(
    color.r.mul(0.85).add(color.g.mul(0.15)),
    color.r.mul(0.20).add(color.g.mul(0.80)),
    color.b,
  );
  const protanopia = vec3(
    color.r.mul(0.70).add(color.g.mul(0.30)),
    color.g.mul(0.95).add(color.r.mul(0.05)),
    color.b,
  );
  const tritanopia = vec3(
    color.r,
    color.g.mul(0.85).add(color.b.mul(0.15)),
    color.b.mul(0.65).add(color.g.mul(0.35)),
  );

  return mode.lessThan(0.5).select(
    color,
    mode.lessThan(1.5).select(
      deuteranopia,
      mode.lessThan(2.5).select(protanopia, tritanopia),
    ),
  );
}
/** Reproduces legacy Lift/Gamma/Gain, colorblind remap, and contrast stretch. */
export function createColorGradeNode({
  inputNode,
  lift,
  gamma,
  gain,
  colorblind,
  highContrast,
  enabled = float(1),
}) {
  return Fn(() => {
    const source = inputNode.rgb;
    const safeGamma = max(gamma, vec3(0.001));
    const graded = pow(max(source.add(lift), vec3(0)), vec3(1).div(safeGamma)).mul(gain);
    const accessible = colorblindRemap(graded, colorblind);
    const stretched = clamp(accessible.sub(0.04).mul(1.18), 0, 1);
    const contrasted = mix(accessible, stretched, clamp(highContrast, 0, 1));
    const result = mix(source, contrasted, enabled);
    return vec4(result, inputNode.a);
  })();
}
