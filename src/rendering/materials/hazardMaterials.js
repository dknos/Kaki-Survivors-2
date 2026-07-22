/**
 * TSL ports of the two custom stage hazard shaders.
 */
import {
  FrontSide,
  MeshBasicNodeMaterial,
  NormalBlending,
  Vector2,
} from 'three/webgpu';
import {
  Fn,
  atan,
  distance,
  float,
  length,
  mix,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';

function attachLegacyUniforms(material, uniforms, family) {
  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: uniforms,
  });
  material.userData.tslMaterialFamily = family;
  return material;
}

/** Port of the Twilight hero-centered fog-of-war plane. */
export function createTwilightFogMaterial(options = {}) {
  const initialHero = options.hero?.isVector2
    ? options.hero.clone()
    : new Vector2(
      Number.isFinite(options.heroX) ? options.heroX : 0,
      Number.isFinite(options.heroZ) ? options.heroZ : 0,
    );
  const uHero = uniform(initialHero);
  const uInner = uniform(Number.isFinite(options.inner) ? options.inner : 14);
  const uOuter = uniform(Number.isFinite(options.outer) ? options.outer : 32);
  const uniforms = { uHero, uInner, uOuter };

  const worldXZ = positionWorld.xz;
  const d = distance(worldXZ, uHero);
  const k = smoothstep(uInner, uOuter, d);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: FrontSide,
    blending: NormalBlending,
    fog: false,
  });
  material.name = 'KakiTwilightFogNodeMaterial';
  material.lights = false;
  material.outputNode = vec4(vec3(0.02, 0.05, 0.09), k.mul(0.78));

  Object.defineProperty(material, 'setHeroPosition', {
    configurable: true,
    enumerable: false,
    value(x, z) {
      if (x?.isVector2) uHero.value.copy(x);
      else uHero.value.set(Number(x) || 0, Number(z) || 0);
      return material;
    },
  });

  return attachLegacyUniforms(material, uniforms, 'twilight-fog');
}

/**
 * Port of the instanced Void chasm shader.
 *
 * A custom outputNode is intentional. MeshBasicNodeMaterial's default
 * diffuse path always multiplies `InstancedMesh.instanceColor`; the legacy
 * shader ignored the hazard pool's cyan instance colors. Bypassing
 * that diffuse path preserves the authored near-black abyss and dim rim.
 */
export function createVoidChasmMaterial() {
  const outputNode = Fn(() => {
    const p = uv().sub(0.5).mul(2).toVar('chasmUv');
    const angle = atan(p.y, p.x);
    const jaggedRim = float(0.88)
      .add(sin(angle.mul(5).add(0.7)).mul(0.065))
      .add(sin(angle.mul(9).sub(1.1)).mul(0.035))
      .add(sin(angle.mul(14).add(2)).mul(0.020));
    const d = length(p);

    // Match `if (d > 1.0) discard;` exactly. Keeping the full 1.0 radius
    // avoids restoring the historical invisible damage annulus.
    d.greaterThan(1).discard();

    const rim = smoothstep(
      jaggedRim.sub(0.10),
      jaggedRim.sub(0.015),
      d,
    ).mul(float(1).sub(smoothstep(0.965, 1, d)));
    const depth = smoothstep(0, 1, d);
    const abyss = mix(
      vec3(0.004, 0.002, 0.010),
      vec3(0.025, 0.010, 0.055),
      depth,
    );
    const rimColor = vec3(0.04, 0.44, 0.58);
    return vec4(mix(abyss, rimColor, rim.mul(0.72)), 0.97);
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: FrontSide,
    blending: NormalBlending,
    fog: false,
  });
  material.name = 'KakiVoidChasmNodeMaterial';
  material.lights = false;
  // outputNode bypasses diffuse/instance-color tint while still allowing the
  // renderer's MRT output struct to wrap the result. fragmentNode cannot be
  // used here: r185 deliberately bypasses MRT construction for that property.
  material.outputNode = outputNode;
  material.userData.tslMaterialFamily = 'void-chasm';
  material.userData.ignoresInstanceColor = true;
  return material;
}
