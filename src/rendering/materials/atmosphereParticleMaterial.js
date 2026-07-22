/**
 * Backend-neutral atmospheric particles for env.js.
 *
 * WebGPU point primitives are fixed at one pixel in Three.js r185. Keeping the
 * released THREE.Points topology would therefore make the atmosphere almost
 * invisible. The companion geometry adapter expands the unchanged CPU particle
 * arrays as one instanced quad per particle, while PointsNodeMaterial supplies
 * the camera-facing quad path on both WebGPU and forced WebGL 2.
 */
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  PlaneGeometry,
  PointsNodeMaterial,
} from 'three/webgpu';
import {
  attribute,
  max,
  positionView,
  screenDPR,
  texture,
  uniform,
  uv,
  vec4,
} from 'three/tsl';

function finiteNumber(value, label, { min = -Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) {
    throw new RangeError(`${label} must be a finite number >= ${min}.`);
  }
  return number;
}

function requireAttribute(geometry, name, itemSize) {
  const source = geometry?.getAttribute?.(name);
  if (!source?.isBufferAttribute || source.itemSize !== itemSize) {
    throw new TypeError(
      `Atmosphere geometry requires a ${name} BufferAttribute with itemSize ${itemSize}.`,
    );
  }
  return source;
}

function asInstancedAttribute(source) {
  if (source.isInstancedBufferAttribute) return source;
  const attribute = new InstancedBufferAttribute(
    source.array,
    source.itemSize,
    source.normalized,
  );
  attribute.setUsage(source.usage);
  attribute.name = source.name;
  return attribute;
}

/**
 * Convert env.js's released point geometry into the r185 portable quad layout.
 *
 * The large position/size/alpha arrays are shared, not copied. Production tick
 * code must update `geometry.atmosphereAttributes.position` and `.alpha`
 * (`aPosition` and `aAlpha`) on the returned geometry so normal BufferAttribute
 * versioning reaches the GPU. By default the now-redundant source geometry is
 * disposed after its CPU arrays are transferred; pass `{ disposeSource: false }`
 * only when another owner intentionally retains it.
 */
export function createAtmosphereParticleGeometry(sourceGeometry, options = {}) {
  const sourcePosition = requireAttribute(sourceGeometry, 'position', 3);
  const sourceSize = requireAttribute(sourceGeometry, 'aSize', 1);
  const sourceAlpha = requireAttribute(sourceGeometry, 'aAlpha', 1);
  const count = sourcePosition.count;
  if (sourceSize.count !== count || sourceAlpha.count !== count) {
    throw new RangeError('Atmosphere position, aSize, and aAlpha counts must match.');
  }

  const quad = new PlaneGeometry(1, 1, 1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.name = sourceGeometry.name
    ? `${sourceGeometry.name}-webgpu-quads`
    : 'KakiAtmosphereParticleQuads';
  geometry.setIndex(quad.index.clone());
  geometry.setAttribute('position', quad.getAttribute('position').clone());
  geometry.setAttribute('uv', quad.getAttribute('uv').clone());
  const positionAttribute = asInstancedAttribute(sourcePosition);
  const sizeAttribute = asInstancedAttribute(sourceSize);
  const alphaAttribute = asInstancedAttribute(sourceAlpha);
  geometry.setAttribute('aPosition', positionAttribute);
  geometry.setAttribute('aSize', sizeAttribute);
  geometry.setAttribute('aAlpha', alphaAttribute);
  geometry.instanceCount = count;
  geometry.boundingSphere = sourceGeometry.boundingSphere?.clone() || null;
  geometry.boundingBox = sourceGeometry.boundingBox?.clone() || null;
  geometry.userData.tslMaterialFamily = 'atmosphere-particles';
  geometry.userData.sourceAttributeContract = Object.freeze({
    position: 'aPosition',
    size: 'aSize',
    alpha: 'aAlpha',
  });
  Object.defineProperty(geometry, 'atmosphereAttributes', {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      position: positionAttribute,
      size: sizeAttribute,
      alpha: alphaAttribute,
    }),
  });
  quad.dispose();
  if (options.disposeSource !== false) {
    sourceGeometry.dispose();
    geometry.userData.sourceGeometryDisposed = true;
  } else {
    geometry.userData.sourceGeometryDisposed = false;
  }
  return geometry;
}

/**
 * Exact port of env.js's atmospheric particle color, alpha cutout, and
 * `aSize * (300 / max(0.1, -viewZ))` pixel-size equation.
 *
 * Use this material with a Mesh whose geometry was returned by
 * createAtmosphereParticleGeometry(). PointsNodeMaterial intentionally runs its
 * sprite-quad path for that Mesh; using it on THREE.Points would reintroduce the
 * WebGPU one-pixel limitation.
 */
export function createAtmosphereParticleMaterial(options = {}) {
  const map = options.map;
  if (!map?.isTexture) {
    throw new TypeError('createAtmosphereParticleMaterial requires a Three.js texture map.');
  }

  const uMap = texture(map, uv());
  const uColor = uniform(new Color(options.color ?? 0xffffff));
  const uAlphaScale = uniform(finiteNumber(options.alphaScale ?? 1, 'alpha scale', { min: 0 }));
  const aPosition = attribute('aPosition', 'vec3');
  const aSize = attribute('aSize', 'float');
  const aAlpha = attribute('aAlpha', 'float');

  const material = new PointsNodeMaterial();
  material.name = 'KakiAtmosphereParticleNodeMaterial';
  material.positionNode = aPosition;

  // PointsNodeMaterial multiplies sizeNode by DPR. Divide it out so the result
  // remains the released physical-pixel equation at every renderer DPR. Build
  // the complete attenuation here and disable the material's separate camera
  // attenuation path, preserving the original near-depth clamp as well.
  const viewDepth = positionView.z.negate();
  material.sizeNode = aSize
    .mul(300)
    .div(max(0.1, viewDepth))
    .div(screenDPR);
  material.sizeAttenuation = false;

  const sampled = uMap;
  const alpha = sampled.a.mul(aAlpha).mul(uAlphaScale);
  alpha.lessThan(0.01).discard();
  material.outputNode = vec4(uColor.mul(sampled.rgb), alpha);
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.alphaToCoverage = false;
  material.blending = options.blending ?? NormalBlending;
  material.fog = false;
  material.lights = false;

  material.userData.tslMaterialFamily = 'atmosphere-particles';
  material.userData.primitiveTopology = 'instanced-quad';
  material.userData.webgpuPointPrimitiveFallback = true;

  const uniforms = Object.freeze({ uMap, uColor, uAlphaScale });
  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: uniforms,
  });
  Object.defineProperties(material, {
    setMap: {
      configurable: true,
      enumerable: false,
      value(value) {
        if (!value?.isTexture) throw new TypeError('Atmosphere map must be a Three.js texture.');
        uMap.value = value;
        return material;
      },
    },
    setColor: {
      configurable: true,
      enumerable: false,
      value(value) {
        uColor.value.set(value);
        return material;
      },
    },
    setAlphaScale: {
      configurable: true,
      enumerable: false,
      value(value) {
        uAlphaScale.value = finiteNumber(value, 'alpha scale', { min: 0 });
        return material;
      },
    },
  });

  // Kept separate so tests and diagnostics can inspect the released constant.
  material.userData.releasedPointSizeConstant = 300;
  return material;
}
