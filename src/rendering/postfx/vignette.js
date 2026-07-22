import {
  Fn,
  float,
  smoothstep,
  uv,
  vec4,
} from 'three/tsl';

/** Legacy vignette: 1 - smoothstep(.35, .95, length(d) * 1.4) * intensity. */
export function createVignetteNode({ inputNode, intensity, enabled = float(1) }) {
  return Fn(() => {
    const distance = uv().sub(0.5).length();
    const vignette = float(1).sub(
      smoothstep(0.35, 0.95, distance.mul(1.4)).mul(intensity).mul(enabled),
    );
    return vec4(inputNode.rgb.mul(vignette), inputNode.a);
  })();
}
