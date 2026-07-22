import {
  abs,
  float,
  positionLocal,
  sign,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';

import { convertStandardMaterial } from './rimLightMaterial.js';

export const CREATURE_ANIMATION_KINDS = Object.freeze([
  'crawl',
  'flap',
  'hover',
  'inch',
]);

const animationTemplates = new WeakMap();
const rootControllers = new WeakMap();
const objectAnimationStates = new WeakMap();

function supportsCharacterMaterial(material) {
  return material?.isMeshStandardMaterial === true
    || material?.isMeshPhysicalMaterial === true
    || material?.isMeshStandardNodeMaterial === true
    || material?.isMeshPhysicalNodeMaterial === true;
}

function requireKind(kind) {
  if (!CREATURE_ANIMATION_KINDS.includes(kind)) {
    throw new RangeError(`Unknown creature animation kind "${kind}".`);
  }
  return kind;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError(`${label} must be a finite number.`);
  return number;
}

function createDeformationNode(kind, basePosition, timeNode, amplitudeNode) {
  const sourcePosition = positionLocal;

  switch (kind) {
    case 'crawl': {
      // The released GLSL wrote smoothstep(0.5, -0.5, y). Reversed edges are
      // undefined in GLSL and WGSL even though desktop drivers implemented the
      // intended inverse ramp. Spell that observed ramp portably so the two
      // backends cannot choose different results.
      const legMask = float(1).sub(
        smoothstep(float(-0.5), float(0.5), sourcePosition.y),
      );
      const xWave = sin(timeNode.mul(18).add(sourcePosition.x.mul(6)));
      const zWave = sin(timeNode.mul(18).add(sourcePosition.z.mul(6)));
      const displacement = vec3(
        xWave.mul(0.10).mul(legMask).mul(amplitudeNode),
        0,
        zWave.mul(0.06).mul(legMask).mul(amplitudeNode),
      );
      return { position: basePosition.add(displacement), nodes: { legMask, xWave, zWave, displacement } };
    }

    case 'flap': {
      const wingMask = smoothstep(float(0.15), float(0.8), abs(sourcePosition.x));
      const flap = sin(timeNode.mul(22));
      const displacement = vec3(
        0,
        flap.mul(sign(sourcePosition.x)).mul(0.45).mul(wingMask).mul(amplitudeNode),
        0,
      );
      return { position: basePosition.add(displacement), nodes: { wingMask, flap, displacement } };
    }

    case 'hover': {
      const wingMask = smoothstep(float(0.1), float(0.6), abs(sourcePosition.x));
      const buzz = sin(timeNode.mul(80));
      const displacement = vec3(
        0,
        buzz.mul(sign(sourcePosition.x)).mul(0.10).mul(wingMask).mul(amplitudeNode),
        0,
      );
      return { position: basePosition.add(displacement), nodes: { wingMask, buzz, displacement } };
    }

    case 'inch': {
      const bodyMask = float(1).sub(smoothstep(float(0.5), float(1), abs(sourcePosition.y)));
      const pulse = sin(timeNode.mul(6).add(sourcePosition.x.mul(4)));
      const lift = sin(timeNode.mul(6));
      const displacement = vec3(
        pulse.mul(0.08).mul(bodyMask).mul(amplitudeNode),
        lift.mul(0.04).mul(bodyMask).mul(amplitudeNode),
        0,
      );
      return { position: basePosition.add(displacement), nodes: { bodyMask, pulse, lift, displacement } };
    }

    default:
      // requireKind() makes this unreachable, but preserving a hard failure is
      // safer than silently shipping a static replacement.
      throw new RangeError(`Unknown creature animation kind "${kind}".`);
  }
}

function createTemplate(material, options) {
  const kind = requireKind(options.kind);
  const defaultState = {
    time: finiteNumber(options.time, 'creature animation time'),
    amplitude: finiteNumber(options.amplitude, 'creature animation amplitude'),
  };
  const timeNode = uniform(defaultState.time).onObjectUpdate(({ object }) => (
    objectAnimationStates.get(object)?.time ?? defaultState.time
  ));
  const amplitudeNode = uniform(defaultState.amplitude).onObjectUpdate(({ object }) => (
    objectAnimationStates.get(object)?.amplitude ?? defaultState.amplitude
  ));

  const previousPositionNode = material.positionNode || positionLocal;
  const deformation = createDeformationNode(
    kind,
    previousPositionNode,
    timeNode,
    amplitudeNode,
  );
  material.positionNode = deformation.position;
  material.needsUpdate = true;

  const template = {
    material,
    kind,
    defaultState,
    uniforms: Object.freeze({
      time: timeNode,
      amplitude: amplitudeNode,
    }),
    nodes: Object.freeze({
      sourcePosition: positionLocal,
      previousPosition: previousPositionNode,
      position: deformation.position,
      ...deformation.nodes,
    }),
    updateTime(value) {
      defaultState.time = finiteNumber(value, 'creature animation time');
      timeNode.value = defaultState.time;
      return template;
    },
    setAmplitude(value) {
      defaultState.amplitude = finiteNumber(value, 'creature animation amplitude');
      amplitudeNode.value = defaultState.amplitude;
      return template;
    },
  };

  animationTemplates.set(material, template);
  return template;
}

function applyExplicitOptions(template, options) {
  if (Object.prototype.hasOwnProperty.call(options, 'time')) template.updateTime(options.time);
  if (Object.prototype.hasOwnProperty.call(options, 'amplitude')) template.setAmplitude(options.amplitude);
}

/**
 * Convert one material and attach one released procedural deformation.
 *
 * This low-level helper is for ordinary static geometry only. Prefer
 * createCreatureAnimationController(root), which atomically rejects skinned,
 * instanced, batched, morph-target, and displacement-mapped meshes.
 */
export function createCreatureAnimationMaterial(sourceMaterial, options = {}) {
  const kind = requireKind(options.kind);
  const material = convertStandardMaterial(sourceMaterial, options);
  let template = animationTemplates.get(material);

  if (template && template.kind !== kind) {
    throw new Error(
      `Material "${material.name || material.uuid}" already has ${template.kind} animation; `
      + `${kind} cannot be stacked on the same vertex position.`,
    );
  }

  if (!template) {
    template = createTemplate(material, {
      kind,
      time: options.time ?? 0,
      amplitude: options.amplitude ?? 1,
    });
  } else {
    applyExplicitOptions(template, options);
  }

  animationTemplates.set(sourceMaterial, template);
  return material;
}

/** Get the graph/uniform template attached to a material. */
export function getCreatureAnimationMaterialController(sourceOrNodeMaterial) {
  return animationTemplates.get(sourceOrNodeMaterial) || null;
}

function objectMaterials(object) {
  if (!object?.material) return [];
  return Array.isArray(object.material) ? object.material : [object.material];
}

function assertStaticCreatureMesh(object) {
  if (!object?.isMesh) return;
  if (object.isSkinnedMesh || object.isInstancedMesh || object.isBatchedMesh) {
    throw new TypeError(
      `Creature deformation requires an ordinary static Mesh; "${object.name || object.uuid}" `
      + 'uses skinning, instancing, or batching.',
    );
  }
  const morphAttributes = object.geometry?.morphAttributes || {};
  const hasMorphTargets = Object.values(morphAttributes)
    .some((attributes) => Array.isArray(attributes) && attributes.length > 0);
  if (hasMorphTargets) {
    throw new TypeError(
      `Creature deformation requires a static mesh without morph targets; `
      + `"${object.name || object.uuid}" has morph data.`,
    );
  }
  if (objectMaterials(object).some((material) => material?.displacementMap)) {
    throw new TypeError(
      `Creature deformation requires a material without displacementMap; `
      + `"${object.name || object.uuid}" has one.`,
    );
  }
}

function convertOneMaterial(sourceMaterial, options, materials, templates) {
  if (!supportsCharacterMaterial(sourceMaterial)) return sourceMaterial;
  const material = createCreatureAnimationMaterial(sourceMaterial, options);
  materials.add(material);
  templates.add(animationTemplates.get(material));
  return material;
}

function convertObjectMaterial(object, options, state, materials, templates) {
  if (!object?.isMesh || !object.material) return false;

  let converted = 0;

  if (Array.isArray(object.material)) {
    object.material = object.material.map((sourceMaterial) => {
      const material = convertOneMaterial(sourceMaterial, { kind: options.kind }, materials, templates);
      if (supportsCharacterMaterial(sourceMaterial)) converted += 1;
      return material;
    });
  } else {
    const sourceMaterial = object.material;
    const material = convertOneMaterial(sourceMaterial, { kind: options.kind }, materials, templates);
    object.material = material;
    if (supportsCharacterMaterial(sourceMaterial)) converted += 1;
  }

  if (converted > 0) {
    objectAnimationStates.set(object, state);
    object.userData.tslCreatureAnimationKind = options.kind;
  }
  return converted > 0;
}

function collect(rootOrMaterials, options, state) {
  const materials = new Set();
  const templates = new Set();
  const bareTemplates = new Set();
  const objects = new Set();

  if (Array.isArray(rootOrMaterials)) {
    for (const entry of rootOrMaterials) {
      if (entry?.isMaterial === true || entry?.traverse instanceof Function) continue;
      throw new TypeError('Creature animation arrays may contain materials or Object3D roots only.');
    }
  }

  // NodeMaterial evaluates positionNode after morphing, skinning, displacement,
  // batching, and instancing in r185. The released shader injection was built
  // specifically for ordinary static bug GLBs and ran at <begin_vertex>.
  // Validate every affected object before mutating any material so unsupported
  // geometry fails atomically instead of producing subtly displaced gameplay.
  const objectCandidates = [];
  const collectCandidate = (object) => {
    if (!object?.isMesh || !objectMaterials(object).some(supportsCharacterMaterial)) return;
    objectCandidates.push(object);
  };
  if (rootOrMaterials?.traverse instanceof Function && rootOrMaterials?.isMaterial !== true) {
    rootOrMaterials.traverse(collectCandidate);
  } else if (Array.isArray(rootOrMaterials)) {
    for (const entry of rootOrMaterials) {
      if (entry?.traverse instanceof Function) entry.traverse(collectCandidate);
    }
  }
  for (const object of objectCandidates) assertStaticCreatureMesh(object);

  if (rootOrMaterials?.isMaterial === true) {
    if (supportsCharacterMaterial(rootOrMaterials)) {
      const material = createCreatureAnimationMaterial(rootOrMaterials, options);
      materials.add(material);
      const template = animationTemplates.get(material);
      templates.add(template);
      bareTemplates.add(template);
    }
  } else if (Array.isArray(rootOrMaterials)) {
    for (let index = 0; index < rootOrMaterials.length; index += 1) {
      const entry = rootOrMaterials[index];
      if (entry?.isMaterial === true) {
        if (!supportsCharacterMaterial(entry)) continue;
        const material = createCreatureAnimationMaterial(entry, options);
        rootOrMaterials[index] = material;
        materials.add(material);
        const template = animationTemplates.get(material);
        templates.add(template);
        bareTemplates.add(template);
      } else if (entry?.traverse instanceof Function) {
        entry.traverse((object) => {
          if (convertObjectMaterial(object, options, state, materials, templates)) objects.add(object);
        });
      }
    }
  } else if (rootOrMaterials?.traverse instanceof Function) {
    rootOrMaterials.traverse((object) => {
      if (convertObjectMaterial(object, options, state, materials, templates)) objects.add(object);
    });
  } else {
    throw new TypeError('Creature animation requires a material, material array, or Object3D root.');
  }

  return { materials, templates, bareTemplates, objects };
}

/**
 * Convert all standard materials below a root and expose one animation clock.
 *
 * The node graphs and material templates are cached. updateTime() and
 * setAmplitude() only mutate numbers consumed by per-object uniforms, so no
 * per-frame nodes, materials, bind groups or GPU buffers are allocated.
 */
export function createCreatureAnimationController(rootOrMaterials, options = {}) {
  if (!rootOrMaterials || (typeof rootOrMaterials !== 'object' && !Array.isArray(rootOrMaterials))) {
    throw new TypeError('Creature animation requires an object-backed material target.');
  }
  const kind = requireKind(options.kind);

  const cached = rootControllers.get(rootOrMaterials);
  if (cached) {
    if (cached.kind !== kind) {
      throw new Error(`Creature root already uses ${cached.kind} animation, not ${kind}.`);
    }
    if (Object.prototype.hasOwnProperty.call(options, 'time')) cached.updateTime(options.time);
    if (Object.prototype.hasOwnProperty.call(options, 'amplitude')) cached.setAmplitude(options.amplitude);
    return cached;
  }

  const state = {
    time: finiteNumber(options.time ?? 0, 'creature animation time'),
    amplitude: finiteNumber(options.amplitude ?? 1, 'creature animation amplitude'),
  };
  const collected = collect(rootOrMaterials, { ...options, kind }, state);
  if (collected.materials.size === 0) {
    throw new TypeError('Creature animation target contains no materials.');
  }

  const materials = [...collected.materials];
  const templates = [...collected.templates];
  const bareTemplates = [...collected.bareTemplates];
  const objects = [...collected.objects];
  let controller;
  const timeValue = {
    get value() { return state.time; },
    set value(value) { controller.updateTime(value); },
  };
  const amplitudeValue = {
    get value() { return state.amplitude; },
    set value(value) { controller.setAmplitude(value); },
  };
  controller = {
    kind,
    materials,
    objects,
    time: timeValue,
    amplitude: amplitudeValue,
    uniforms: templates.map((template) => template.uniforms),
    values: state,
    updateTime(value) {
      state.time = finiteNumber(value, 'creature animation time');
      // Only explicit bare-material targets depend on template defaults. Root
      // objects use per-object state, so unrelated draws sharing the material
      // do not inherit this controller's clock.
      for (const template of bareTemplates) template.updateTime(state.time);
      return controller;
    },
    setAmplitude(value) {
      state.amplitude = finiteNumber(value, 'creature animation amplitude');
      for (const template of bareTemplates) template.setAmplitude(state.amplitude);
      return controller;
    },
  };

  rootControllers.set(rootOrMaterials, controller);
  return controller;
}
