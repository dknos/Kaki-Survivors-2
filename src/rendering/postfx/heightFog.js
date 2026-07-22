import {
  Fn,
  mix,
  smoothstep,
  uv,
  vec4,
} from 'three/tsl';

/**
 * Legacy screen-height fog. This intentionally keeps the original UV formula;
 * r185 QuadMesh UV increases from top to bottom, opposite the legacy
 * fullscreen triangle. `uv().y` therefore preserves legacy `1.0 - vUv.y` on
 * the displayed image. A browser diagnostic produced identical top/middle/
 * bottom values (255/121/0) for the legacy pass and both stable backends.
 * This is not a world-space depth fog replacement.
 */
export function createHeightFogNode({ inputNode, tint, amount }) {
  return Fn(() => {
    const heightFactor = smoothstep(0, 0.7, uv().y).mul(amount);
    return vec4(mix(inputNode.rgb, tint, heightFactor), inputNode.a);
  })();
}
