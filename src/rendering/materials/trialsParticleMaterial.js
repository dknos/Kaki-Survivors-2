/**
 * TSL replacement for Trials' per-instance particle-alpha injection.
 *
 * MeshBasicNodeMaterial already retains the released instanceColor, vertex
 * color, scene-fog, color-management, and MRT behavior. Only the missing
 * `instanceAlpha` multiplier is supplied here.
 */
import {
  Color,
  MeshBasicNodeMaterial,
  NormalBlending,
} from 'three/webgpu';
import {
  attribute,
  uniform,
} from 'three/tsl';

function finiteOpacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new RangeError('Trials particle opacity must be a finite number in [0, 1].');
  }
  return number;
}

/**
 * Create the one-draw Trials dust/spark material.
 *
 * Geometry must keep the released `instanceAlpha` InstancedBufferAttribute;
 * InstancedMesh.instanceColor continues to tint individual dust and sparks.
 */
export function createTrialsParticleMaterial(options = {}) {
  const uOpacity = uniform(finiteOpacity(options.opacity ?? 1));
  const instanceAlpha = attribute('instanceAlpha', 'float');
  const material = new MeshBasicNodeMaterial({
    color: new Color(options.color ?? 0xffffff),
    vertexColors: options.vertexColors ?? true,
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? true,
    blending: options.blending ?? NormalBlending,
    fog: options.fog ?? true,
  });
  material.name = 'KakiTrialsParticleAlphaNodeMaterial';
  material.opacityNode = instanceAlpha.mul(uOpacity);
  material.userData.tslMaterialFamily = 'trials-instanced-particle-alpha';
  material.userData.instanceAlphaAttribute = 'instanceAlpha';

  Object.defineProperty(material, 'uniforms', {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ uOpacity }),
  });
  Object.defineProperty(material, 'setPoolOpacity', {
    configurable: true,
    enumerable: false,
    value(value) {
      uOpacity.value = finiteOpacity(value);
      return material;
    },
  });
  return material;
}
