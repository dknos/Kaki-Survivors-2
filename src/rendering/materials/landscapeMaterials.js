/**
 * Backend-neutral TSL replacements for the procedural landscape
 * custom shaders in stageLandscapes.js.
 *
 * These factories deliberately return MeshBasicNodeMaterial instances with a
 * small legacy-compatible `uniforms` surface. The compatibility
 * surface lets the eventual production integration keep the existing pooled
 * geometry and onBeforeRender time updates while the renderer changes.
 */
import {
  Color,
  DoubleSide,
  MeshBasicNodeMaterial,
  NormalBlending,
} from 'three/webgpu';
import {
  abs,
  distance,
  float,
  min,
  mix,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function attachLegacyUniforms(material, uniforms, family) {
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
        uniforms.uTime.value = finiteNumber(seconds, 0);
        return material;
      },
    },
    setMotionScale: {
      configurable: true,
      enumerable: false,
      value(scale) {
        uniforms.uMotionScale.value = Math.max(0, finiteNumber(scale, 1));
        return material;
      },
    },
    setReducedMotion: {
      configurable: true,
      enumerable: false,
      value(reduced) {
        uniforms.uMotionScale.value = reduced ? 0 : 1;
        return material;
      },
    },
  });

  material.userData.tslMaterialFamily = family;
  material.userData.reducedMotionUniform = 'uMotionScale';
  return material;
}

/**
 * Port of stageLandscapes.js::_waterMaterial.
 *
 * Default `uMotionScale = 1` is mathematically identical to the legacy GLSL.
 * Setting it to zero freezes procedural motion without rebuilding a pipeline.
 */
export function createWaterMaterial(deep, shallow, opacity, options = {}) {
  const uTime = uniform(finiteNumber(options.time, 0));
  const uMotionScale = uniform(Math.max(0, finiteNumber(options.motionScale, 1)));
  const uDeep = uniform(new Color(deep));
  const uShallow = uniform(new Color(shallow));
  const uOpacity = uniform(finiteNumber(opacity, 1));
  const uniforms = { uTime, uMotionScale, uDeep, uShallow, uOpacity };

  const animatedTime = uTime.mul(uMotionScale);
  const world = positionWorld;
  const surfaceUv = uv();
  const r1 = sin(
    world.x.mul(0.72)
      .add(world.z.mul(0.31))
      .add(animatedTime.mul(0.62)),
  );
  const r2 = sin(
    world.z.mul(1.08)
      .sub(world.x.mul(0.24))
      .sub(animatedTime.mul(0.48)),
  );
  const ripples = r1.add(r2).mul(0.5);
  const edge = smoothstep(
    0.08,
    0.48,
    float(1).sub(distance(surfaceUv, vec2(0.5))),
  );
  const mixAmount = float(0.34)
    .add(ripples.mul(0.10))
    .add(edge.mul(0.12));
  const surfaceColor = mix(uDeep, uShallow, mixAmount);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
    fog: false,
  });
  material.name = 'KakiWaterNodeMaterial';
  material.lights = false;
  // outputNode keeps the material inside r185's MRT path. fragmentNode would
  // bypass renderer MRT outputs and make this surface incompatible with the
  // selective-bloom scene pass even when its bloom membership is zero.
  material.outputNode = vec4(surfaceColor, uOpacity);

  return attachLegacyUniforms(material, uniforms, 'water');
}

/**
 * Port of stageLandscapes.js::_terrainRibbonMaterial.
 *
 * @param {object} layout A stage terrain layout with `kind` and
 * `colors.{deep,shallow,edge}` matching stageTerrainLayout.js.
 */
export function createTerrainRibbonMaterial(layout, options = {}) {
  if (!layout?.colors) {
    throw new TypeError('createTerrainRibbonMaterial requires a layout with colors.');
  }

  const isAbyss = layout.kind === 'abyss-fracture';
  const isLava = layout.kind === 'lava-ravine';
  const uTime = uniform(finiteNumber(options.time, 0));
  const uMotionScale = uniform(Math.max(0, finiteNumber(options.motionScale, 1)));
  const uDeep = uniform(new Color(layout.colors.deep));
  const uShallow = uniform(new Color(layout.colors.shallow));
  const uEdge = uniform(new Color(layout.colors.edge));
  const uAbyss = uniform(isAbyss ? 1 : 0);
  const uLava = uniform(isLava ? 1 : 0);
  const uniforms = {
    uTime,
    uMotionScale,
    uDeep,
    uShallow,
    uEdge,
    uAbyss,
    uLava,
  };

  const ribbonUv = uv();
  const animatedTime = uTime.mul(uMotionScale);
  const abyssEnabled = uAbyss.greaterThan(0.5);
  const lavaEnabled = uLava.greaterThan(0.5);
  const bank = min(ribbonUv.y, float(1).sub(ribbonUv.y)).mul(2);
  const edge = float(1).sub(smoothstep(0.02, 0.18, bank));
  const flowSpeed = lavaEnabled.select(1.2, 0.55);
  const flowA = sin(
    ribbonUv.x.mul(5.4).sub(animatedTime.mul(flowSpeed)),
  );
  const flowB = sin(
    ribbonUv.x.mul(9.1)
      .add(ribbonUv.y.mul(7))
      .add(animatedTime.mul(0.38)),
  );
  const flow = flowA.add(flowB).mul(0.5);

  const baseColor = mix(
    uDeep,
    uShallow,
    float(0.34).add(flow.mul(0.10)),
  );
  const fracture = smoothstep(0.58, 0.92, abs(flow));
  const abyssColor = mix(
    vec3(0.002, 0.001, 0.008),
    uShallow,
    fracture.mul(0.18),
  );
  const colorAfterAbyss = abyssEnabled.select(abyssColor, baseColor);

  const vein = smoothstep(0.30, 0.92, flow.mul(0.5).add(0.5));
  const lavaColor = mix(uDeep, uShallow, vein.mul(0.78));
  const colorAfterLava = lavaEnabled.select(lavaColor, colorAfterAbyss);
  const edgeStrength = abyssEnabled.select(0.66, 0.42);
  const finalColor = mix(
    colorAfterLava,
    uEdge,
    edge.mul(edgeStrength),
  );

  const material = new MeshBasicNodeMaterial({
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: DoubleSide,
    blending: NormalBlending,
    fog: false,
  });
  material.name = 'KakiTerrainRibbonNodeMaterial';
  material.lights = false;
  material.outputNode = vec4(finalColor, 0.98);

  return attachLegacyUniforms(material, uniforms, `terrain-${layout.kind || 'unknown'}`);
}
