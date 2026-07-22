import {
  BlendMode,
  MaterialBlending,
} from 'three/webgpu';
import {
  float,
  min,
  mix,
  mrt,
  output,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import {
  BLOOM_LAYER,
  getSelectiveBloomIntensity,
} from '../bloomLayers.js';

export { BLOOM_LAYER } from '../bloomLayers.js';
// The released composer ran at half size and r160 UnrealBloomPass halved that
// again for its bright/first-blur targets: W*0.25 by H*0.25 (6.25% pixels).
export const LEGACY_BLOOM_RESOLUTION_SCALE = 0.25;
export const LEGACY_BLOOM_PIXEL_SCALE = LEGACY_BLOOM_RESOLUTION_SCALE ** 2;

export function bloomPixelScaleToResolutionScale(pixelScale) {
  const safePixelScale = Math.min(1, Math.max(1 / 4096, Number(pixelScale) || 0));
  return Math.sqrt(safePixelScale);
}

function layerMembershipUniform(layer) {
  return uniform(0).onObjectUpdate(({ object }) => (
    object?.layers?.isEnabled(layer)
      ? (layer === BLOOM_LAYER ? getSelectiveBloomIntensity(object) : 1)
      : 0
  ));
}

/**
 * Adds a bloom-only MRT attachment to the scene pass. MaterialBlending is
 * essential here: transparent and additive objects must blend into the bloom
 * attachment with the same policy as the beauty attachment.
 */
export function createSelectiveBloom({
  scenePass,
  layer = BLOOM_LAYER,
  strength = uniform(0.70),
  radius = uniform(0.50),
  threshold = uniform(0),
  enabled = uniform(1),
  reduceFlashing = uniform(0),
  pixelScale = LEGACY_BLOOM_PIXEL_SCALE,
} = {}) {
  if (!scenePass?.setMRT || !scenePass?.getTextureNode) {
    throw new TypeError('createSelectiveBloom requires a configured r185 scene PassNode.');
  }

  const membership = layerMembershipUniform(layer);
  const unclamped = output.rgb;
  const flashClamped = min(unclamped, vec3(1.5));
  const safeColor = mix(unclamped, flashClamped, reduceFlashing);
  const contribution = membership.mul(enabled);
  const bloomOutput = vec4(safeColor.mul(contribution), output.a.mul(contribution));
  const sceneMrt = mrt({ output, bloom: bloomOutput });
  sceneMrt.setBlendMode('bloom', new BlendMode(MaterialBlending));
  scenePass.setMRT(sceneMrt);

  // Texture nodes must be requested only after the MRT is fully configured.
  const sceneColorNode = scenePass.getTextureNode('output');
  const bloomSourceNode = scenePass.getTextureNode('bloom');
  const flashingGate = mix(float(1), float(0.35), reduceFlashing);
  const bloomNode = bloom(
    bloomSourceNode,
    strength.mul(enabled).mul(flashingGate),
    radius,
    threshold,
  );
  bloomNode.setResolutionScale(bloomPixelScaleToResolutionScale(pixelScale));
  const bloomTextureNode = bloomNode.getTextureNode();

  let disposed = false;
  return {
    bloomNode,
    bloomSourceNode,
    bloomTextureNode,
    membership,
    mrt: sceneMrt,
    sceneColorNode,
    uniforms: { strength, radius, threshold, enabled, reduceFlashing },
    setPixelScale(value) {
      pixelScale = Math.min(1, Math.max(1 / 4096, Number(value) || 0));
      bloomNode.setResolutionScale(bloomPixelScaleToResolutionScale(pixelScale));
      return this;
    },
    getPixelScale() {
      return pixelScale;
    },
    setResolutionScale(value) {
      const resolutionScale = Math.min(1, Math.max(1 / 64, Number(value) || 0));
      pixelScale = resolutionScale * resolutionScale;
      bloomNode.setResolutionScale(resolutionScale);
      return this;
    },
    getResolutionScale() {
      return bloomNode.getResolutionScale();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bloomNode.dispose();
    },
  };
}
