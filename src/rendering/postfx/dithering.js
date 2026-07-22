import {
  Fn,
  dot,
  fract,
  screenCoordinate,
  sin,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Optional static sub-LSB dither. This intentionally does not clamp RGB:
 * pre-output-transform HDR values must survive into tone mapping unchanged.
 * The pipeline omits this node entirely for tiers whose amount is zero.
 */
export function createDitheringNode({ inputNode, amount }) {
  return Fn(() => {
    const hash = fract(
      sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453),
    );
    const noise = hash.sub(0.5).mul(amount).div(255);
    const result = inputNode.rgb.add(vec3(noise));
    return vec4(result, inputNode.a);
  })();
}
