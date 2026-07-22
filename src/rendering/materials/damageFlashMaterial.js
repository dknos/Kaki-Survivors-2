import { Color } from 'three/webgpu';
import {
  materialEmissive,
  texture,
  uniform,
} from 'three/tsl';

import { convertStandardMaterial } from './rimLightMaterial.js';

export const DEFAULT_DAMAGE_FLASH = Object.freeze({
  color: 0xffffff,
  intensity: 1.6,
  amount: 0,
});

const flashTemplates = new WeakMap();
const rootControllers = new WeakMap();
const objectFlashStates = new WeakMap();

function supportsCharacterMaterial(material) {
  return material?.isMeshStandardMaterial === true
    || material?.isMeshPhysicalMaterial === true
    || material?.isMeshStandardNodeMaterial === true
    || material?.isMeshPhysicalNodeMaterial === true;
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const range = Number.isFinite(min) || Number.isFinite(max)
      ? ` in [${Number.isFinite(min) ? min : '-Infinity'}, ${Number.isFinite(max) ? max : 'Infinity'}]`
      : '';
    throw new RangeError(`${label} must be a finite number${range}.`);
  }
  return number;
}

function createTemplate(material, options) {
  const defaultState = {
    color: new Color(options.color),
    intensity: finiteNumber(options.intensity, 'damage flash intensity', { min: 0 }),
    amount: finiteNumber(options.amount, 'damage flash amount', { min: 0, max: 1 }),
  };
  const colorNode = uniform(defaultState.color.clone()).onObjectUpdate(({ object }) => (
    objectFlashStates.get(object)?.color ?? defaultState.color
  ));
  const intensityNode = uniform(defaultState.intensity).onObjectUpdate(({ object }) => (
    objectFlashStates.get(object)?.intensity ?? defaultState.intensity
  ));
  const amountNode = uniform(defaultState.amount).onObjectUpdate(({ object }) => (
    objectFlashStates.get(object)?.amount ?? defaultState.amount
  ));

  // The legacy flash replaces emissive color/intensity with white * 1.6. Add
  // only that replacement delta so independent contributions (notably the rim
  // light) remain present regardless of which controller was installed first.
  const materialBaseEmissiveNode = materialEmissive;
  const previousEmissiveNode = material.emissiveNode || materialBaseEmissiveNode;
  let flashTargetNode = colorNode.mul(intensityNode);
  if (material.emissiveMap) {
    // Legacy property mutation still passed through emissiveMap; retain that
    // modulation instead of turning mapped dark regions into a solid mask.
    flashTargetNode = flashTargetNode.mul(texture(material.emissiveMap).rgb);
  }
  const flashDeltaNode = flashTargetNode.sub(materialBaseEmissiveNode).mul(amountNode);
  material.emissiveNode = previousEmissiveNode.add(flashDeltaNode);
  material.needsUpdate = true;

  const controller = {
    material,
    defaultState,
    uniforms: Object.freeze({
      color: colorNode,
      intensity: intensityNode,
      amount: amountNode,
    }),
    nodes: Object.freeze({
      target: flashTargetNode,
      delta: flashDeltaNode,
    }),
    setColor(value) {
      defaultState.color.set(value);
      colorNode.value.copy(defaultState.color);
      return controller;
    },
    setIntensity(value) {
      defaultState.intensity = finiteNumber(value, 'damage flash intensity', { min: 0 });
      intensityNode.value = defaultState.intensity;
      return controller;
    },
    setAmount(value) {
      defaultState.amount = finiteNumber(value, 'damage flash amount', { min: 0, max: 1 });
      amountNode.value = defaultState.amount;
      return controller;
    },
  };

  flashTemplates.set(material, controller);
  return controller;
}

function applyExplicitOptions(controller, options) {
  if (Object.prototype.hasOwnProperty.call(options, 'color')) controller.setColor(options.color);
  if (Object.prototype.hasOwnProperty.call(options, 'intensity')) controller.setIntensity(options.intensity);
  if (Object.prototype.hasOwnProperty.call(options, 'amount')) controller.setAmount(options.amount);
}

/** Add a uniform-driven damage flash to one material and return that material. */
export function createDamageFlashMaterial(sourceMaterial, options = {}) {
  const material = convertStandardMaterial(sourceMaterial, options);
  let controller = flashTemplates.get(material);
  if (!controller) {
    controller = createTemplate(material, {
      color: options.color ?? DEFAULT_DAMAGE_FLASH.color,
      intensity: options.intensity ?? DEFAULT_DAMAGE_FLASH.intensity,
      amount: options.amount ?? DEFAULT_DAMAGE_FLASH.amount,
    });
  } else {
    applyExplicitOptions(controller, options);
  }
  flashTemplates.set(sourceMaterial, controller);
  return material;
}

/** Get the node/uniform template installed on a material. */
export function getDamageFlashMaterialController(sourceOrNodeMaterial) {
  return flashTemplates.get(sourceOrNodeMaterial) || null;
}

function convertOneMaterial(sourceMaterial, options, materials, templates) {
  if (!supportsCharacterMaterial(sourceMaterial)) return sourceMaterial;
  const material = createDamageFlashMaterial(sourceMaterial, options);
  materials.add(material);
  templates.add(flashTemplates.get(material));
  return material;
}

function convertObjectMaterial(object, state, materials, templates, filters) {
  if (!object?.isMesh || !object.material) return false;
  if (filters.filterObject && filters.filterObject(object) === false) return false;

  let converted = 0;

  if (Array.isArray(object.material)) {
    object.material = object.material.map((sourceMaterial, materialIndex) => {
      if (
        filters.filterMaterial
        && filters.filterMaterial(sourceMaterial, object, materialIndex) === false
      ) {
        return sourceMaterial;
      }
      const material = convertOneMaterial(sourceMaterial, {}, materials, templates);
      if (material !== sourceMaterial || supportsCharacterMaterial(sourceMaterial)) converted += 1;
      return material;
    });
  } else {
    const sourceMaterial = object.material;
    if (filters.filterMaterial && filters.filterMaterial(sourceMaterial, object, 0) === false) {
      return false;
    }
    const material = convertOneMaterial(sourceMaterial, {}, materials, templates);
    object.material = material;
    if (material !== sourceMaterial || supportsCharacterMaterial(sourceMaterial)) converted += 1;
  }

  if (converted > 0) objectFlashStates.set(object, state);
  return converted > 0;
}

function collect(rootOrMaterials, options, state) {
  const materials = new Set();
  const templates = new Set();
  const bareTemplates = new Set();
  const objects = new Set();
  const filters = {
    filterObject: options.filterObject || null,
    filterMaterial: options.filterMaterial || null,
  };

  if (filters.filterObject != null && typeof filters.filterObject !== 'function') {
    throw new TypeError('Damage flash filterObject must be a function.');
  }
  if (filters.filterMaterial != null && typeof filters.filterMaterial !== 'function') {
    throw new TypeError('Damage flash filterMaterial must be a function.');
  }

  if (Array.isArray(rootOrMaterials)) {
    for (const entry of rootOrMaterials) {
      if (entry?.isMaterial === true || entry?.traverse instanceof Function) continue;
      throw new TypeError('Damage flash arrays may contain materials or Object3D roots only.');
    }
  }

  if (rootOrMaterials?.isMaterial === true) {
    if (
      supportsCharacterMaterial(rootOrMaterials)
      && (!filters.filterMaterial || filters.filterMaterial(rootOrMaterials, null, 0) !== false)
    ) {
      const material = createDamageFlashMaterial(rootOrMaterials, options);
      materials.add(material);
      const template = flashTemplates.get(material);
      templates.add(template);
      bareTemplates.add(template);
    }
  } else if (Array.isArray(rootOrMaterials)) {
    for (let index = 0; index < rootOrMaterials.length; index += 1) {
      const entry = rootOrMaterials[index];
      if (entry?.isMaterial === true) {
        if (!supportsCharacterMaterial(entry)) continue;
        if (filters.filterMaterial && filters.filterMaterial(entry, null, index) === false) continue;
        const material = createDamageFlashMaterial(entry, options);
        rootOrMaterials[index] = material;
        materials.add(material);
        const template = flashTemplates.get(material);
        templates.add(template);
        bareTemplates.add(template);
      } else if (entry?.traverse instanceof Function) {
        entry.traverse((object) => {
          if (convertObjectMaterial(object, state, materials, templates, filters)) objects.add(object);
        });
      }
    }
  } else if (rootOrMaterials?.traverse instanceof Function) {
    rootOrMaterials.traverse((object) => {
      if (convertObjectMaterial(object, state, materials, templates, filters)) objects.add(object);
    });
  } else {
    throw new TypeError('Damage flash requires a material, material array, or Object3D root.');
  }

  return { materials, templates, bareTemplates, objects };
}

/**
 * Convert and control every standard material below an Object3D root.
 *
 * Per-render-object values live in a WeakMap and feed one cached template
 * uniform through onObjectUpdate. Multiple enemies can therefore share a node
 * material without flashing in lockstep or creating nodes during gameplay.
 * `filterObject(object)` and `filterMaterial(material, object, index)` preserve
 * authored exclusions such as Nemesis' ruby/core meshes. InstancedMesh state
 * applies to the whole draw; per-instance horde flashes continue to use the
 * existing `aFlash` instance attribute path.
 */
export function createDamageFlashController(rootOrMaterials, options = {}) {
  if (!rootOrMaterials || (typeof rootOrMaterials !== 'object' && !Array.isArray(rootOrMaterials))) {
    throw new TypeError('Damage flash requires an object-backed material target.');
  }

  const cached = rootControllers.get(rootOrMaterials);
  if (cached) {
    if (
      (options.filterObject && options.filterObject !== cached.filterObject)
      || (options.filterMaterial && options.filterMaterial !== cached.filterMaterial)
    ) {
      throw new Error('Damage flash filters cannot change after a target is converted.');
    }
    if (Object.prototype.hasOwnProperty.call(options, 'color')) cached.setColor(options.color);
    if (Object.prototype.hasOwnProperty.call(options, 'intensity')) cached.setIntensity(options.intensity);
    if (Object.prototype.hasOwnProperty.call(options, 'amount')) cached.setAmount(options.amount);
    return cached;
  }

  const state = {
    color: new Color(options.color ?? DEFAULT_DAMAGE_FLASH.color),
    intensity: finiteNumber(
      options.intensity ?? DEFAULT_DAMAGE_FLASH.intensity,
      'damage flash intensity',
      { min: 0 },
    ),
    amount: finiteNumber(options.amount ?? DEFAULT_DAMAGE_FLASH.amount, 'damage flash amount', { min: 0, max: 1 }),
  };
  const collected = collect(rootOrMaterials, options, state);
  if (collected.materials.size === 0) {
    throw new TypeError('Damage flash target contains no materials.');
  }

  const materials = [...collected.materials];
  const templates = [...collected.templates];
  const bareTemplates = [...collected.bareTemplates];
  const objects = [...collected.objects];
  let controller;
  const amountValue = {
    get value() { return state.amount; },
    set value(value) { controller.setAmount(value); },
  };
  const colorValue = {
    get value() { return state.color; },
    set value(value) { controller.setColor(value); },
  };
  const intensityValue = {
    get value() { return state.intensity; },
    set value(value) { controller.setIntensity(value); },
  };
  controller = {
    materials,
    objects,
    amount: amountValue,
    color: colorValue,
    intensity: intensityValue,
    filterObject: options.filterObject || null,
    filterMaterial: options.filterMaterial || null,
    uniforms: templates.map((template) => template.uniforms),
    values: state,
    setFlashing(enabled) {
      return controller.setAmount(enabled ? 1 : 0);
    },
    setAmount(value) {
      state.amount = finiteNumber(value, 'damage flash amount', { min: 0, max: 1 });
      // Only explicitly targeted bare materials use template defaults. Root
      // objects resolve isolated values through onObjectUpdate; leaving their
      // defaults at zero also keeps filtered/external draws that share the
      // material from inheriting a flash.
      for (const template of bareTemplates) template.setAmount(state.amount);
      return controller;
    },
    setColor(value) {
      state.color.set(value);
      for (const template of bareTemplates) template.setColor(state.color);
      return controller;
    },
    setIntensity(value) {
      state.intensity = finiteNumber(value, 'damage flash intensity', { min: 0 });
      for (const template of bareTemplates) template.setIntensity(state.intensity);
      return controller;
    },
  };

  rootControllers.set(rootOrMaterials, controller);
  return controller;
}
