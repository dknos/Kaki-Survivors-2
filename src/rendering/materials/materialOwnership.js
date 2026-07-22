/**
 * Root-local material ownership for cached GLTF clones.
 *
 * This module deliberately has no Three.js imports. The production entrypoint
 * can use it while it still imports the classic build, and the eventual WebGPU
 * entrypoint can inject constructors from its one `three/webgpu` universe.
 *
 * Call this once after static-geometry collapse and before adding rim, damage,
 * creature-animation or other per-object node graphs. Texture references stay
 * shared with the asset cache; material instances do not.
 */

const STANDARD_REFERENCE_FIELDS = Object.freeze([
  'map',
  'lightMap',
  'aoMap',
  'emissiveMap',
  'bumpMap',
  'normalMap',
  'displacementMap',
  'roughnessMap',
  'metalnessMap',
  'alphaMap',
  'envMap',
]);

const STANDARD_SCALAR_FIELDS = Object.freeze([
  'lightMapIntensity',
  'aoMapIntensity',
  'emissiveIntensity',
  'bumpScale',
  'normalMapType',
  'displacementScale',
  'displacementBias',
  'roughness',
  'metalness',
  'envMapIntensity',
  'wireframe',
  'wireframeLinewidth',
  'wireframeLinecap',
  'wireframeLinejoin',
  'flatShading',
  'fog',
]);

const STANDARD_VALUE_FIELDS = Object.freeze([
  'color',
  'emissive',
  'normalScale',
  'envMapRotation',
]);

function requireRoot(root) {
  if (!root || typeof root !== 'object' || typeof root.traverse !== 'function') {
    throw new TypeError('Material ownership requires an Object3D root with traverse().');
  }
}

function requireMaterial(material) {
  if (!material || typeof material !== 'object' || typeof material.clone !== 'function') {
    throw new TypeError('Every mesh material must be a cloneable material object.');
  }
}

function requireConstructors(constructors) {
  if (!constructors || typeof constructors.MeshStandardMaterial !== 'function') {
    throw new TypeError(
      'Classic material promotion requires injected { MeshStandardMaterial } constructors.',
    );
  }
}

function baseMaterialCopy(target, source, constructors) {
  const explicitCopy = constructors?.Material?.prototype?.copy;
  const inferredPrototype = Object.getPrototypeOf(constructors.MeshStandardMaterial.prototype);
  const inferredCopy = inferredPrototype?.copy;
  const copy = typeof explicitCopy === 'function' ? explicitCopy : inferredCopy;

  if (typeof copy !== 'function') {
    throw new TypeError(
      'Injected MeshStandardMaterial must inherit a Material.prototype.copy() implementation.',
    );
  }

  // Calling only the base implementation is intentional. Calling
  // MeshStandardMaterial.copy() with a Lambert/Phong/Basic source would copy
  // undefined standard-only fields over valid defaults.
  copy.call(target, source);
}

function copyValue(target, source, field) {
  const sourceValue = source[field];
  if (sourceValue === undefined) return;

  const targetValue = target[field];
  if (targetValue && typeof targetValue.copy === 'function') {
    targetValue.copy(sourceValue);
  } else if (sourceValue && typeof sourceValue.clone === 'function') {
    target[field] = sourceValue.clone();
  } else {
    target[field] = sourceValue;
  }
}

function applyStandardParameters(material, parameters) {
  if (!parameters || typeof parameters !== 'object') return;

  if (typeof material.setValues === 'function') {
    material.setValues(parameters);
    return;
  }

  // Kept for narrow fake-constructor tests and embedders. Actual Three.js
  // constructors always provide Material.setValues().
  for (const [field, value] of Object.entries(parameters)) {
    if (value === undefined || !(field in material)) continue;
    const current = material[field];
    if (current && typeof current.copy === 'function') current.copy(value);
    else material[field] = value;
  }
}

/**
 * Whether a classic material should be promoted to MeshStandardMaterial.
 *
 * Physical, Standard and Node materials are explicitly excluded even if a
 * third-party subclass exposes more than one type flag. This prevents a
 * physical GLTF material from being silently demoted.
 */
export function isLegacyLitMaterial(material) {
  if (!material || typeof material !== 'object') return false;
  if (
    material.isNodeMaterial === true
    || material.isMeshPhysicalMaterial === true
    || material.isMeshStandardMaterial === true
  ) return false;

  return material.isMeshBasicMaterial === true
    || material.isMeshLambertMaterial === true
    || material.isMeshPhongMaterial === true;
}

/**
 * Promote one classic Basic/Lambert/Phong material to MeshStandardMaterial.
 *
 * Common Material render state is copied through the injected release's own
 * Material.copy implementation. Compatible surface fields and textures are
 * then copied without duplicating texture ownership. `standardParameters` are
 * applied last so the caller can intentionally choose migration roughness,
 * metalness or environment defaults.
 */
export function promoteLegacyMaterialToStandard(
  source,
  {
    constructors,
    standardParameters = null,
  } = {},
) {
  requireMaterial(source);
  requireConstructors(constructors);

  if (!isLegacyLitMaterial(source)) {
    throw new TypeError(
      'Only classic MeshBasicMaterial, MeshLambertMaterial or MeshPhongMaterial can be promoted.',
    );
  }

  const material = new constructors.MeshStandardMaterial();
  baseMaterialCopy(material, source, constructors);

  for (const field of STANDARD_REFERENCE_FIELDS) {
    if (source[field] !== undefined) material[field] = source[field];
  }
  for (const field of STANDARD_SCALAR_FIELDS) {
    if (source[field] !== undefined) material[field] = source[field];
  }
  for (const field of STANDARD_VALUE_FIELDS) copyValue(material, source, field);

  applyStandardParameters(material, standardParameters);
  material.needsUpdate = true;
  return material;
}

function ownMaterial(source, options) {
  requireMaterial(source);

  const shouldPromote = options.promoteLegacy === true && isLegacyLitMaterial(source);
  const owned = shouldPromote
    ? promoteLegacyMaterialToStandard(source, options)
    : source.clone();

  if (!owned || typeof owned !== 'object' || owned === source) {
    throw new TypeError('Material clone/promotion must return a distinct material instance.');
  }

  return { owned, promoted: shouldPromote };
}

function collectMeshBindings(root) {
  const bindings = [];
  root.traverse((object) => {
    if (object?.isMesh !== true || object.material == null) return;

    const materials = Array.isArray(object.material)
      ? [...object.material]
      : [object.material];
    bindings.push({
      object,
      wasArray: Array.isArray(object.material),
      materials,
    });
  });
  return bindings;
}

/**
 * Give every mesh below `root` a root-local material instance.
 *
 * A single Map is built for this invocation, so every occurrence of the same
 * source material is replaced by the same owned material. A different root (or
 * a later explicit invocation) receives different material instances. All
 * owned materials are prepared before any mesh is mutated, making failure
 * atomic rather than leaving half of the hierarchy rewritten.
 *
 * @param {Object3D} root
 * @param {object} [options]
 * @param {boolean} [options.promoteLegacy=false]
 * @param {object} [options.constructors] Inject the active Three.js namespace
 *   or an object containing Material and MeshStandardMaterial.
 * @param {object} [options.standardParameters] Intentional overrides applied
 *   after compatible legacy fields have been copied.
 * @returns {{root: object, sourceToOwned: Map, sourceMaterials: object[],
 *   ownedMaterials: object[], meshCount: number, materialSlotCount: number,
 *   clonedCount: number, promotedCount: number}}
 */
export function ownRootMaterials(
  root,
  {
    promoteLegacy = false,
    constructors = null,
    standardParameters = null,
  } = {},
) {
  requireRoot(root);
  if (promoteLegacy) requireConstructors(constructors);

  const bindings = collectMeshBindings(root);
  const sourceToOwned = new Map();
  let promotedCount = 0;
  let materialSlotCount = 0;

  // Build the complete replacement table first. This deliberately uses a Map,
  // not the old WeakSet: every later occurrence can retrieve and install the
  // first replacement instead of being skipped and left on the cache source.
  try {
    for (const binding of bindings) {
      for (const source of binding.materials) {
        if (source == null) continue;
        materialSlotCount += 1;
        if (sourceToOwned.has(source)) continue;

        const { owned, promoted } = ownMaterial(source, {
          promoteLegacy,
          constructors,
          standardParameters,
        });
        sourceToOwned.set(source, owned);
        if (promoted) promotedCount += 1;
      }
    }
  } catch (error) {
    // A later clone can fail (corrupt/third-party material). No mesh has been
    // mutated yet, but earlier clones may already own renderer resources.
    // Release those temporary materials before surfacing the original error.
    for (const material of sourceToOwned.values()) {
      try { material.dispose?.(); } catch (_) {}
    }
    throw error;
  }

  // No mutation happens before every unique clone/promotion has succeeded.
  for (const binding of bindings) {
    const replacements = binding.materials.map((source) => (
      source == null ? source : sourceToOwned.get(source)
    ));
    binding.object.material = binding.wasArray ? replacements : replacements[0];
  }

  return {
    root,
    sourceToOwned,
    sourceMaterials: [...sourceToOwned.keys()],
    ownedMaterials: [...sourceToOwned.values()],
    meshCount: bindings.length,
    materialSlotCount,
    clonedCount: sourceToOwned.size,
    promotedCount,
  };
}
