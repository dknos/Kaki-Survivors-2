import {
  Color,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import {
  dot,
  float,
  materialEmissive,
  max,
  normalViewGeometry,
  normalize,
  positionView,
  pow,
  uniform,
} from 'three/tsl';

export const DEFAULT_RIM_LIGHT = Object.freeze({
  color: 0xaaccff,
  power: 2.4,
  strength: 0.35,
});

// GLTF clones normally share their source materials. Keeping this conversion
// cache weak preserves that sharing without retaining disposed stage assets.
const convertedStandardMaterials = new WeakMap();
const rimControllers = new WeakMap();

function requireMaterial(sourceMaterial) {
  if (!sourceMaterial || typeof sourceMaterial !== 'object') {
    throw new TypeError('A Three.js material is required.');
  }
  if (
    sourceMaterial.isMeshStandardNodeMaterial === true
    || sourceMaterial.isMeshPhysicalNodeMaterial === true
  ) return;
  if (
    sourceMaterial.isMeshStandardMaterial !== true
    && sourceMaterial.isMeshPhysicalMaterial !== true
  ) {
    throw new TypeError(
      'Character TSL effects require a standard or physical mesh material.',
    );
  }
}

function finiteNumber(value, label, { min = -Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) {
    throw new RangeError(`${label} must be a finite number${Number.isFinite(min) ? ` >= ${min}` : ''}.`);
  }
  return number;
}

/**
 * Convert a classic MeshStandardMaterial or MeshPhysicalMaterial into its
 * matching r185 node-material peer.
 *
 * NodeMaterial.copy() carries the standard color, texture, PBR, transparency,
 * depth, side, blending, clipping and render-state fields. Texture objects stay
 * shared, matching the GLTF cache's current ownership model. Repeated calls for
 * the same source return the same node material and never rebuild a node graph.
 */
export function convertStandardMaterial(sourceMaterial, options = {}) {
  requireMaterial(sourceMaterial);

  if (sourceMaterial.isMeshStandardNodeMaterial === true) {
    convertedStandardMaterials.set(sourceMaterial, sourceMaterial);
    return sourceMaterial;
  }

  const cached = convertedStandardMaterials.get(sourceMaterial);
  if (cached) return cached;

  // GLTFLoader promotes KHR_materials_ior/specular/transmission and related
  // extensions to MeshPhysicalMaterial. Preserve that lighting model instead
  // of flattening released hero materials into a standard material.
  const material = sourceMaterial.isMeshPhysicalMaterial === true
    ? new MeshPhysicalNodeMaterial()
    : new MeshStandardNodeMaterial();
  material.copy(sourceMaterial);

  // NodeMaterial.copy() covers the physical fields but shallow-assigns plain
  // arrays/objects. Keep the classic source independently disposable/mutable,
  // matching MeshPhysicalMaterial.copy() ownership semantics.
  if (Array.isArray(sourceMaterial.iridescenceThicknessRange)) {
    material.iridescenceThicknessRange = [...sourceMaterial.iridescenceThicknessRange];
  }
  if (sourceMaterial.defines && typeof sourceMaterial.defines === 'object') {
    material.defines = { ...sourceMaterial.defines };
  }

  // r185 NodeMaterial.copy() deliberately skips underscore-prefixed storage.
  // Material.alphaTest is the one standard render property backed by such a
  // field (`_alphaTest`), and the inherited setter is not visited by that copy
  // implementation, so carry it explicitly through the public API.
  material.alphaTest = sourceMaterial.alphaTest;

  if (options.name !== undefined) material.name = String(options.name);
  if (options.userData && typeof options.userData === 'object') {
    material.userData = { ...material.userData, ...options.userData };
  }

  convertedStandardMaterials.set(sourceMaterial, material);
  convertedStandardMaterials.set(material, material);
  return material;
}

function createController(material, options) {
  const colorNode = uniform(new Color(options.color));
  const powerNode = uniform(finiteNumber(options.power, 'rim power', { min: 0 }));
  const strengthNode = uniform(finiteNumber(options.strength, 'rim strength', { min: 0 }));

  // Keep the released orthographic-camera relationship exactly: the surface
  // normal is compared with normalize(-positionView), not cameraPosition or a
  // world-space approximation. The term remains additive to outgoing emissive
  // light, just as the old outgoingLight injection was.
  const viewDirectionNode = normalize(positionView.negate());
  // Legacy GLSL sampled normalize(vNormal), before normal/bump mapping and
  // without double-sided face negation. normalViewGeometry is that r185 TSL
  // equivalent; normalView would make authored normal maps reshape the rim.
  const facingNode = max(dot(normalViewGeometry, viewDirectionNode), float(0));
  const rimFactorNode = pow(float(1).sub(facingNode), powerNode);
  const rimContributionNode = colorNode.mul(rimFactorNode.mul(strengthNode));
  const previousEmissiveNode = material.emissiveNode || materialEmissive;

  material.emissiveNode = previousEmissiveNode.add(rimContributionNode);
  material.needsUpdate = true;

  const controller = {
    material,
    uniforms: Object.freeze({
      color: colorNode,
      power: powerNode,
      strength: strengthNode,
    }),
    nodes: Object.freeze({
      viewDirection: viewDirectionNode,
      facing: facingNode,
      factor: rimFactorNode,
      contribution: rimContributionNode,
    }),
    setColor(value) {
      colorNode.value.set(value);
      return controller;
    },
    setPower(value) {
      powerNode.value = finiteNumber(value, 'rim power', { min: 0 });
      return controller;
    },
    setStrength(value) {
      strengthNode.value = finiteNumber(value, 'rim strength', { min: 0 });
      return controller;
    },
  };

  rimControllers.set(material, controller);
  return controller;
}

function applyExplicitOptions(controller, options) {
  if (Object.prototype.hasOwnProperty.call(options, 'color')) controller.setColor(options.color);
  if (Object.prototype.hasOwnProperty.call(options, 'power')) controller.setPower(options.power);
  if (Object.prototype.hasOwnProperty.call(options, 'strength')) controller.setStrength(options.strength);
}

/**
 * Add the released character rim light to a standard material.
 *
 * @returns {MeshStandardNodeMaterial} The cached node material.
 */
export function createRimLightMaterial(sourceMaterial, options = {}) {
  const material = convertStandardMaterial(sourceMaterial, options);
  let controller = rimControllers.get(material);

  if (!controller) {
    controller = createController(material, {
      color: options.color ?? DEFAULT_RIM_LIGHT.color,
      power: options.power ?? DEFAULT_RIM_LIGHT.power,
      strength: options.strength ?? DEFAULT_RIM_LIGHT.strength,
    });
  } else {
    applyExplicitOptions(controller, options);
  }

  // Make lookup idempotent whether integration retains the classic source or
  // replaces it with the returned node material.
  rimControllers.set(sourceMaterial, controller);
  return material;
}

/** Return the uniform/controller bundle without exposing module caches. */
export function getRimLightController(sourceOrNodeMaterial) {
  return rimControllers.get(sourceOrNodeMaterial)
    || rimControllers.get(convertedStandardMaterials.get(sourceOrNodeMaterial))
    || null;
}
