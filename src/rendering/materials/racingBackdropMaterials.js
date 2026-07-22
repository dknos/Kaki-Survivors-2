/**
 * Backend-neutral TSL materials for world-anchored racing backdrops.
 *
 * The source Monster Smash painting is a flat 16:9 plate, not an
 * equirectangular environment.  The horizon material deliberately uses only
 * its useful upper portion on a curved cyclorama and fades it into a separate
 * sky dome.  This keeps illustrated landmarks fixed in world space without
 * exposing the hard edges of a rectangular image.
 */
import {
  BackSide,
  Color,
  MeshBasicNodeMaterial,
  NormalBlending,
  NoBlending,
} from 'three/webgpu';
import {
  abs,
  float,
  fract,
  mix,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';

function finite(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function createRacingSkyGradientMaterial(options = {}) {
  const horizon = uniform(new Color(options.horizon ?? 0xf6d994));
  const zenith = uniform(new Color(options.zenith ?? 0x45c7df));
  const blend = smoothstep(0.08, 0.88, uv().y);
  const material = new MeshBasicNodeMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
    blending: NoBlending,
  });
  material.name = 'KakiRacingSkyGradientNodeMaterial';
  material.lights = false;
  material.outputNode = vec4(mix(horizon, zenith, blend), 1);
  material.userData.tslMaterialFamily = 'racing-sky-gradient';
  return material;
}

export function createRacingHorizonMaterial(map, options = {}) {
  if (!map?.isTexture) throw new TypeError('createRacingHorizonMaterial requires a Three.js texture.');
  const sourceMin = Math.max(0, Math.min(1, finite(options.sourceMin, 0.46)));
  const sourceMax = Math.max(sourceMin, Math.min(1, finite(options.sourceMax, 1)));
  const mirroredRepeats = Math.max(2, Math.round(finite(options.mirroredRepeats, 4) / 2) * 2);
  const surfaceUv = uv();
  // Alternate forward/reversed copies. Every join therefore samples the same
  // source edge on both sides, which makes a non-panoramic plate continuous
  // without smearing one 16:9 image across the entire circumference.
  const mirroredX = abs(
    fract(surfaceUv.x.mul(float(mirroredRepeats * 0.5)))
      .mul(2)
      .sub(1),
  );
  const sampleUv = vec2(
    mirroredX,
    mix(float(sourceMin), float(sourceMax), surfaceUv.y),
  );
  const sampled = texture(map, sampleUv);
  const bottomFade = smoothstep(0, 0.14, surfaceUv.y);
  const topFade = float(1).sub(smoothstep(0.78, 1, surfaceUv.y));
  const alpha = sampled.a.mul(bottomFade).mul(topFade);
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    side: BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
    blending: NormalBlending,
  });
  material.name = 'KakiRacingHorizonNodeMaterial';
  material.lights = false;
  material.outputNode = vec4(sampled.rgb, alpha);
  material.userData.tslMaterialFamily = 'racing-curved-horizon';
  material.userData.worldAnchored = true;
  material.userData.mirroredRepeats = mirroredRepeats;
  return material;
}
