import { ownRootMaterials } from './materialOwnership.js';
import { createRimLightMaterial } from './rimLightMaterial.js';
import { createDamageFlashController } from './damageFlashMaterial.js';
import { createCreatureAnimationController } from './creatureAnimationMaterial.js';

const rootStates = new WeakMap();

function requireRoot(root) {
  if (!root || typeof root !== 'object' || typeof root.traverse !== 'function') {
    throw new TypeError('Character material pipeline requires an Object3D root.');
  }
}

function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function supportsCharacterMaterial(material) {
  return material?.isMeshStandardMaterial === true
    || material?.isMeshPhysicalMaterial === true
    || material?.isMeshStandardNodeMaterial === true
    || material?.isMeshPhysicalNodeMaterial === true;
}

function collectMaterials(root) {
  const materials = new Set();
  root.traverse((object) => {
    if (!object?.isMesh || object.material == null) return;
    for (const material of materialList(object.material)) {
      if (material) materials.add(material);
    }
  });
  return materials;
}

function configureOwnedMaterials(state, options) {
  const roughness = options.roughness;
  for (const material of collectMaterials(state.root)) {
    if (!supportsCharacterMaterial(material)) continue;
    if (roughness != null && 'roughness' in material) material.roughness = roughness;
    options.configureMaterial?.(material, options.envMapIntensity);
    material.needsUpdate = true;
  }
}

/**
 * Clone/promote every material exactly once for one GLTF clone.
 *
 * Call after geometry collapse and before any color styling or node effects.
 * Repeated calls update scalar PBR settings but never clone a second time.
 */
export function prepareCharacterMaterialRoot(root, {
  constructors,
  envMapIntensity = 0.55,
  roughness = null,
  metalness = 0.05,
  configureMaterial = null,
} = {}) {
  requireRoot(root);
  let state = rootStates.get(root);
  const options = {
    envMapIntensity,
    roughness,
    configureMaterial,
  };

  if (!state) {
    // The released Lambert/Phong/Basic promotion used 0.85 when callers did
    // not request a family-specific roughness. Existing Standard/Physical
    // materials remain authored because this object is promotion-only.
    const standardParameters = {
      metalness,
      roughness: roughness ?? 0.85,
    };
    const ownership = ownRootMaterials(root, {
      promoteLegacy: true,
      constructors,
      standardParameters,
    });
    state = {
      root,
      ownership,
      rimApplied: false,
      damageFlashController: null,
      creatureAnimationController: null,
      disposed: false,
      configureMaterial,
      envMapIntensity,
    };
    rootStates.set(root, state);
  }

  if (state.disposed) throw new Error('Cannot reuse a disposed character material root.');
  state.configureMaterial = configureMaterial || state.configureMaterial;
  state.envMapIntensity = envMapIntensity;
  configureOwnedMaterials(state, {
    ...options,
    configureMaterial: state.configureMaterial,
  });
  return state;
}

/** Convert all supported owned materials to their matching node peer + rim. */
export function applyCharacterRimLight(root, {
  filterObject = null,
  filterMaterial = null,
  onMaterialReplaced = null,
  ...rimOptions
} = {}) {
  requireRoot(root);
  const state = rootStates.get(root);
  if (!state || state.disposed) {
    throw new Error('Character materials must be prepared before applying rim light.');
  }
  if (state.rimApplied) return state;

  const replacements = new Map();
  root.traverse((object) => {
    if (!object?.isMesh || object.material == null) return;
    if (filterObject && filterObject(object) === false) return;
    const sourceMaterials = materialList(object.material);
    const converted = sourceMaterials.map((source, index) => {
      if (!supportsCharacterMaterial(source)) return source;
      if (filterMaterial && filterMaterial(source, object, index) === false) return source;
      let material = replacements.get(source);
      if (!material) {
        material = createRimLightMaterial(source, rimOptions);
        replacements.set(source, material);
        state.configureMaterial?.(material, state.envMapIntensity);
      }
      return material;
    });
    object.material = Array.isArray(object.material) ? converted : converted[0];
  });

  // The root-local classic clones are now unreachable from render objects.
  // Dispose their Material state only; textures remain shared with the GLTF
  // cache and are intentionally not traversed or disposed here.
  for (const [source, material] of replacements) {
    if (source === material) continue;
    onMaterialReplaced?.(source, material);
    try { source.dispose?.(); } catch (_) {}
  }
  state.rimApplied = true;
  return state;
}

export function attachCharacterDamageFlash(root, options = {}) {
  requireRoot(root);
  const state = rootStates.get(root);
  if (!state || !state.rimApplied || state.disposed) {
    throw new Error('Damage flash must be attached after ownership and rim conversion.');
  }
  const controller = createDamageFlashController(root, options);
  state.damageFlashController = controller;
  return controller;
}

/** Return false for geometry families the released deformation never supported. */
export function isCreatureAnimationEligible(root) {
  requireRoot(root);
  let eligible = true;
  root.traverse((object) => {
    if (!eligible || !object?.isMesh) return;
    const affected = materialList(object.material).some(supportsCharacterMaterial);
    if (!affected) return;
    if (object.isSkinnedMesh || object.isInstancedMesh || object.isBatchedMesh) {
      eligible = false;
      return;
    }
    const morphAttributes = object.geometry?.morphAttributes || {};
    if (Object.values(morphAttributes).some((entries) => Array.isArray(entries) && entries.length)) {
      eligible = false;
      return;
    }
    if (materialList(object.material).some((material) => material?.displacementMap)) {
      eligible = false;
    }
  });
  return eligible;
}

export function attachCharacterCreatureAnimation(root, options = {}) {
  requireRoot(root);
  const state = rootStates.get(root);
  if (!state || !state.rimApplied || state.disposed) {
    throw new Error('Creature animation must be attached after ownership and rim conversion.');
  }
  if (!isCreatureAnimationEligible(root)) return null;
  const controller = createCreatureAnimationController(root, options);
  state.creatureAnimationController = controller;
  return controller;
}

export function getCharacterMaterialPipelineState(root) {
  return rootStates.get(root) || null;
}

/** Reset mutable controller values before hiding or lending a pooled root. */
export function resetCharacterMaterialControllers(root, {
  creatureTime = 0,
  creatureAmplitude = 1,
} = {}) {
  const state = rootStates.get(root);
  if (!state || state.disposed) return false;
  state.damageFlashController?.setAmount(0);
  state.creatureAnimationController?.updateTime(creatureTime);
  state.creatureAnimationController?.setAmplitude(creatureAmplitude);
  return true;
}

/** Dispose root-owned materials while retaining cache-owned textures/geometry. */
export function disposeCharacterMaterialRoot(root) {
  const state = rootStates.get(root);
  if (!state || state.disposed) return 0;
  resetCharacterMaterialControllers(root);
  const materials = collectMaterials(root);
  for (const material of materials) {
    try { material.dispose?.(); } catch (_) {}
  }
  state.damageFlashController = null;
  state.creatureAnimationController = null;
  state.disposed = true;
  rootStates.delete(root);
  return materials.size;
}
