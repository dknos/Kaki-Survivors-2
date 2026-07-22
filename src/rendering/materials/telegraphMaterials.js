/**
 * TSL materials for gameplay telegraphs and portal surfaces.
 */
import {
  Color,
  DoubleSide,
  MeshBasicNodeMaterial,
  NormalBlending,
} from 'three/webgpu';
import {
  Fn,
  float,
  length,
  pow,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/** Port of forestPortals.js::_makeGateVeilMaterial. */
export function createForestGateVeilMaterial(colorHex, options = {}) {
  const sharedColor = new Color(colorHex);
  const uColor = uniform(sharedColor);
  const uTime = uniform(finiteNumber(options.time, 0));
  const uOpacity = uniform(finiteNumber(options.opacity, 0.50));
  const uMotionScale = uniform(Math.max(0, finiteNumber(options.motionScale, 1)));
  const uniforms = { uColor, uTime, uOpacity, uMotionScale };

  const outputNode = Fn(() => {
    const p = uv()
      .sub(0.5)
      .mul(vec2(1.08, 0.88))
      .mul(2)
      .toVar('gateVeilUv');
    const d = length(p);
    const oval = float(1).sub(smoothstep(0.72, 0.98, d));
    const edge = smoothstep(0.48, 0.86, d)
      .mul(float(1).sub(smoothstep(0.86, 0.98, d)));
    const animatedTime = uTime.mul(uMotionScale);
    const wispA = float(0.5).add(
      sin(
        p.y.mul(11)
          .add(p.x.mul(5.5))
          .add(animatedTime.mul(1.9)),
      ).mul(0.5),
    );
    const wispB = float(0.5).add(
      sin(
        p.x.mul(13)
          .sub(p.y.mul(4))
          .sub(animatedTime.mul(1.35)),
      ).mul(0.5),
    );
    const wisps = pow(wispA.mul(wispB), 1.6);
    const alpha = oval
      .mul(float(0.07).add(wisps.mul(0.15)))
      .add(edge.mul(0.24))
      .mul(uOpacity);

    alpha.lessThan(0.012).discard();
    return vec4(uColor.mul(float(0.72).add(edge.mul(0.22))), alpha);
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    fog: false,
  });
  material.name = 'ForestTrialGateVeilNodeMaterial';
  material.lights = false;
  material.outputNode = outputNode;

  // Preserve the compatibility surface used by portal pose and beacon code.
  // The color property and uColor uniform intentionally share one Color.
  material.color = sharedColor;
  material.opacity = uOpacity.value;
  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: uniforms,
  });
  Object.defineProperties(material, {
    setAnimationTime: {
      configurable: true,
      enumerable: false,
      value(seconds) {
        uTime.value = finiteNumber(seconds, 0);
        return material;
      },
    },
    setMotionScale: {
      configurable: true,
      enumerable: false,
      value(scale) {
        uMotionScale.value = Math.max(0, finiteNumber(scale, 1));
        return material;
      },
    },
    setReducedMotion: {
      configurable: true,
      enumerable: false,
      value(reduced) {
        uMotionScale.value = reduced ? 0 : 1;
        return material;
      },
    },
    setVeilOpacity: {
      configurable: true,
      enumerable: false,
      value(opacity) {
        const value = Math.max(0, finiteNumber(opacity, 0));
        material.opacity = value;
        uOpacity.value = value;
        return material;
      },
    },
  });
  material.userData.tslMaterialFamily = 'forest-gate-veil';
  material.userData.reducedMotionUniform = 'uMotionScale';
  material.userData.selectiveBloom = false;
  return material;
}
