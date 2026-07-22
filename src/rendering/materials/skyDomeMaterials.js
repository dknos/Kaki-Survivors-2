/**
 * TSL sky-dome materials shared by the Forest phase sky and Cave vault.
 */
import {
  BackSide,
  Color,
  MeshBasicNodeMaterial,
  NormalBlending,
} from 'three/webgpu';
import {
  float,
  mix,
  smoothstep,
  texture,
  uniform,
  uv,
  vec4,
} from 'three/tsl';

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function configureSkyMaterial(material, name, family) {
  material.name = name;
  material.lights = false;
  material.fog = false;
  material.toneMapped = false;
  material.transparent = false;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = BackSide;
  material.blending = NormalBlending;
  material.userData.tslMaterialFamily = family;
  return material;
}

/**
 * Port of forestSkyDome.js's two-sampler phase crossfade.
 * TextureNode.value is intentionally exposed through the legacy uniform names
 * so changing phase textures remains a binding update, not a recompile.
 */
export function createForestSkyDomeMaterial(currentTexture, nextTexture, options = {}) {
  if (!currentTexture?.isTexture || !nextTexture?.isTexture) {
    throw new TypeError('createForestSkyDomeMaterial requires two Three.js textures.');
  }

  const uCurrent = texture(currentTexture, uv());
  const uNext = texture(nextTexture, uv());
  const uBlend = uniform(finiteNumber(options.blend, 0));
  const uMotionScale = uniform(Math.max(0, finiteNumber(options.motionScale, 1)));
  const uniforms = {
    u_current: uCurrent,
    u_next: uNext,
    u_blend: uBlend,
    uMotionScale,
  };

  const clampedBlend = uBlend.clamp(0, 1);
  // At the default scale of 1 this is exactly clamp(u_blend, 0, 1). Reduced
  // motion (scale 0) snaps to the target sky instead of animating the fade.
  const accessibleBlend = mix(float(1), clampedBlend, uMotionScale);
  const rgb = mix(uCurrent.rgb, uNext.rgb, accessibleBlend);

  const material = configureSkyMaterial(
    new MeshBasicNodeMaterial(),
    'ForestSkyDomeNodeMaterial',
    'forest-sky-dome',
  );
  material.outputNode = vec4(rgb, 1);
  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: uniforms,
  });
  Object.defineProperties(material, {
    setBlend: {
      configurable: true,
      enumerable: false,
      value(blend) {
        uBlend.value = finiteNumber(blend, 0);
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
  });
  material.userData.reducedMotionUniform = 'uMotionScale';
  return material;
}

/** Port of stages/cave/caveSkyDome.js's palette-pure vertical vault. */
export function createCaveSkyDomeMaterial(
  lowColor = 0x1a1820,
  highColor = 0x4a4a52,
) {
  const uLo = uniform(new Color(lowColor));
  const uHi = uniform(new Color(highColor));
  const uniforms = { uLo, uHi };
  const t = smoothstep(0.4, 1, uv().y);
  const rgb = mix(uLo, uHi, t);

  const material = configureSkyMaterial(
    new MeshBasicNodeMaterial(),
    'CaveSkyDomeNodeMaterial',
    'cave-sky-dome',
  );
  material.outputNode = vec4(rgb, 1);
  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: uniforms,
  });
  return material;
}
