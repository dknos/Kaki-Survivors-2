import {
  Fn,
  float,
  uv,
  vec4,
} from 'three/tsl';

/**
 * Reproduces the legacy radial RGB split without a composite RTT. Both inputs
 * are already stable textures, so base + bloom can be sampled directly at the
 * three channel UVs. This saves one full-resolution render target and pass.
 */
export function createChromaticAberration({
  sceneColorNode,
  bloomTextureNode = null,
  amount,
  reduceMotion,
  enabled = float(1),
}) {
  if (!sceneColorNode?.sample) {
    throw new TypeError('createChromaticAberration requires a scene color texture node.');
  }

  const coord = sceneColorNode.uvNode || uv();
  const sampleComposite = (sampleUv) => {
    const base = sceneColorNode.sample(sampleUv);
    return bloomTextureNode ? base.rgb.add(bloomTextureNode.sample(sampleUv).rgb) : base.rgb;
  };

  const effectNode = Fn(() => {
    const delta = coord.sub(0.5);
    const distance = delta.length();
    const motionGate = float(1).sub(reduceMotion).mul(enabled);
    const offset = delta.mul(amount).mul(distance).mul(2).mul(motionGate);

    const red = sampleComposite(coord.add(offset)).r;
    const green = sampleComposite(coord).g;
    const blue = sampleComposite(coord.sub(offset)).b;

    return vec4(red, green, blue, 1);
  })();

  return {
    node: effectNode,
    inputTextures: bloomTextureNode ? [sceneColorNode, bloomTextureNode] : [sceneColorNode],
    dispose() {},
  };
}
