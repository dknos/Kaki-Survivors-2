/**
 * Procedural Kaki Land world-map stage.
 *
 * A low-poly, floating-island lobby: a central main-boss island connects to
 * three trial islands by plank bridges. The world shell is generated from
 * Three.js primitives and finished with the generated Kaki Land material kit,
 * so it can be mounted/unmounted cleanly as a self-contained stage.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from '../../rendering/bloomLayers.js';
import {
  KAKI_LAND_MAIN_PORTAL_REQUIREMENT,
  KAKI_LAND_PALETTE,
  KAKI_LAND_PORTAL_LAYOUT,
} from './kakiLandPalette.js';

export const KAKI_LAND_STAGE_GROUP_NAME = 'kakiLandStage';

const SURFACE_Y = 0.04;
const MAIN_ISLAND_RADIUS = 26;
const SATELLITE_RADIUS = 15;
const PORTAL_INTERACT_RADIUS = 5.25;
const MAIN_PLAYABLE_RADIUS = MAIN_ISLAND_RADIUS - 1.15;
const SATELLITE_PLAYABLE_RADIUS = SATELLITE_RADIUS - 1.05;
const BRIDGE_PLAYABLE_HALF_WIDTH = 2.34;

let _stage = null;
let _skyTexture = null;
let _skyLoading = false;
const KAKI_LAND_SKY_URL = new URL('../../../assets/kakiland/kaki-land-sky-gpt-v2.png', import.meta.url).href;
const KAKI_LAND_SKY_FALLBACK = 0x76bced;

// Vertex-generated material set. The maps are shared across every island and
// preloaded by assets.js before the Kaki run begins, preventing a flat-color
// first frame while keeping the stage's procedural geometry lightweight.
const KAKI_LAND_TERRAIN_TEXTURES = Object.freeze({
  turf:          { url: new URL('../../../assets/kakiland/kaki-land-turf-vertex-v1.png', import.meta.url).href, color: true,  repeat: [3.25, 3.25] },
  // A close-range detail pass generated for the final chapter. The original
  // authored turf remains on the island rim; this one fills the walkable
  // meadow inset where players actually spend their time.
  turfDetail:    { url: new URL('../../../assets/kakiland/kaki-land-turf-grok-v1.webp', import.meta.url).href, color: true,  repeat: [4.35, 4.35] },
  turfNormal:    { url: new URL('../../../assets/kakiland/kaki-land-turf-vertex-v1-normal.png', import.meta.url).href, color: false, repeat: [3.25, 3.25] },
  turfRoughness: { url: new URL('../../../assets/kakiland/kaki-land-turf-vertex-v1-roughness.png', import.meta.url).href, color: false, repeat: [3.25, 3.25] },
  cliff:          { url: new URL('../../../assets/kakiland/kaki-land-cliff-vertex-v1.png', import.meta.url).href, color: true,  repeat: [2.6, 1.25] },
  // Keep the old cliff material on the underside, while this richer strata
  // sheet gives the visible vertical walls a readable close-up identity.
  cliffDetail:    { url: new URL('../../../assets/kakiland/kaki-land-cliff-grok-v1.webp', import.meta.url).href, color: true,  repeat: [2.6, 1.25] },
  cliffNormal:    { url: new URL('../../../assets/kakiland/kaki-land-cliff-vertex-v1-normal.png', import.meta.url).href, color: false, repeat: [2.6, 1.25] },
  cliffRoughness: { url: new URL('../../../assets/kakiland/kaki-land-cliff-vertex-v1-roughness.png', import.meta.url).href, color: false, repeat: [2.6, 1.25] },
  ember:          { url: new URL('../../../assets/kakiland/kaki-land-ember-vertex-v1.png', import.meta.url).href, color: true,  repeat: [1.9, 1.9] },
  emberNormal:    { url: new URL('../../../assets/kakiland/kaki-land-ember-vertex-v1-normal.png', import.meta.url).href, color: false, repeat: [1.9, 1.9] },
  emberRoughness: { url: new URL('../../../assets/kakiland/kaki-land-ember-vertex-v1-roughness.png', import.meta.url).href, color: false, repeat: [1.9, 1.9] },
  tide:          { url: new URL('../../../assets/kakiland/kaki-land-tide-vertex-v1.png', import.meta.url).href, color: true,  repeat: [1.2, 1.2] },
  tideNormal:    { url: new URL('../../../assets/kakiland/kaki-land-tide-vertex-v1-normal.png', import.meta.url).href, color: false, repeat: [1.2, 1.2] },
  tideRoughness: { url: new URL('../../../assets/kakiland/kaki-land-tide-vertex-v1-roughness.png', import.meta.url).href, color: false, repeat: [1.2, 1.2] },
  bloom:          { url: new URL('../../../assets/kakiland/kaki-land-bloom-vertex-v1.png', import.meta.url).href, color: true,  repeat: [1.8, 1.8] },
  bloomNormal:    { url: new URL('../../../assets/kakiland/kaki-land-bloom-vertex-v1-normal.png', import.meta.url).href, color: false, repeat: [1.8, 1.8] },
  bloomRoughness: { url: new URL('../../../assets/kakiland/kaki-land-bloom-vertex-v1-roughness.png', import.meta.url).href, color: false, repeat: [1.8, 1.8] },
  plaza:          { url: new URL('../../../assets/kakiland/kaki-land-plaza-vertex-v1.png', import.meta.url).href, color: true,  repeat: [1, 1] },
  plazaNormal:    { url: new URL('../../../assets/kakiland/kaki-land-plaza-vertex-v1-normal.png', import.meta.url).href, color: false, repeat: [1, 1] },
  plazaRoughness: { url: new URL('../../../assets/kakiland/kaki-land-plaza-vertex-v1-roughness.png', import.meta.url).href, color: false, repeat: [1, 1] },
});

const _terrainTextureCache = new Map();
const _terrainTextureLoads = new Map();
let _terrainPreloadPromise = null;
let _terrainPreloadStatus = null;

// The island meshes are visual geometry, so they do not participate in a
// physics world. Keep the hero on the authored discs and plank corridors with
// a tiny scalar-only clamp instead of adding a collider dependency.
const _PLAYABLE_ISLANDS = Object.freeze([
  Object.freeze({ x: KAKI_LAND_PORTAL_LAYOUT.main.x, z: KAKI_LAND_PORTAL_LAYOUT.main.z, radius: MAIN_PLAYABLE_RADIUS }),
  ...KAKI_LAND_PORTAL_LAYOUT.trials.map((portal) => Object.freeze({
    x: portal.x, z: portal.z, radius: SATELLITE_PLAYABLE_RADIUS,
  })),
]);

/**
 * Clamp a mutable `{ x, z }` hero position to an island or bridge corridor.
 * Returns true only when it corrected an off-map position.
 */
export function constrainKakiLandPosition(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return false;
  const x = position.x;
  const z = position.z;
  let bestD2 = Infinity;
  let bestX = x;
  let bestZ = z;

  for (const island of _PLAYABLE_ISLANDS) {
    const dx = x - island.x;
    const dz = z - island.z;
    const d2 = dx * dx + dz * dz;
    const r2 = island.radius * island.radius;
    if (d2 <= r2) return false;
    const d = Math.sqrt(d2) || 1;
    const cx = island.x + dx / d * island.radius;
    const cz = island.z + dz / d * island.radius;
    if (d2 < bestD2) { bestD2 = d2; bestX = cx; bestZ = cz; }
  }

  const main = KAKI_LAND_PORTAL_LAYOUT.main;
  for (const trial of KAKI_LAND_PORTAL_LAYOUT.trials) {
    const dx = trial.x - main.x;
    const dz = trial.z - main.z;
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2) || 1;
    const startT = (MAIN_PLAYABLE_RADIUS - 0.35) / len;
    const endT = 1 - (SATELLITE_PLAYABLE_RADIUS - 0.35) / len;
    let t = ((x - main.x) * dx + (z - main.z) * dz) / len2;
    t = Math.max(startT, Math.min(endT, t));
    const px = main.x + dx * t;
    const pz = main.z + dz * t;
    const ox = x - px;
    const oz = z - pz;
    const d2 = ox * ox + oz * oz;
    if (d2 <= BRIDGE_PLAYABLE_HALF_WIDTH * BRIDGE_PLAYABLE_HALF_WIDTH) return false;
    if (d2 < bestD2) {
      const d = Math.sqrt(d2) || 1;
      bestD2 = d2;
      bestX = px + ox / d * BRIDGE_PLAYABLE_HALF_WIDTH;
      bestZ = pz + oz / d * BRIDGE_PLAYABLE_HALF_WIDTH;
    }
  }
  position.x = bestX;
  position.z = bestZ;
  return true;
}

function loadTerrainTexture(key) {
  if (_terrainTextureCache.has(key)) return Promise.resolve(_terrainTextureCache.get(key));
  if (_terrainTextureLoads.has(key)) return _terrainTextureLoads.get(key);
  const spec = KAKI_LAND_TERRAIN_TEXTURES[key];
  if (!spec) return Promise.resolve(null);
  const pending = new Promise((resolve) => {
    new THREE.TextureLoader().load(
      spec.url,
      (texture) => {
        texture.colorSpace = spec.color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(spec.repeat[0], spec.repeat[1]);
        texture.anisotropy = 8;
        _terrainTextureCache.set(key, texture);
        _terrainTextureLoads.delete(key);
        resolve(texture);
      },
      undefined,
      () => {
        _terrainTextureLoads.delete(key);
        resolve(null);
      },
    );
  });
  _terrainTextureLoads.set(key, pending);
  return pending;
}

/** Preload the shared terrain kit during the stage loading overlay. */
export function preloadKakiLandTerrain() {
  if (_terrainPreloadPromise) return _terrainPreloadPromise;
  const keys = Object.keys(KAKI_LAND_TERRAIN_TEXTURES);
  _terrainPreloadPromise = Promise.all(keys.map(loadTerrainTexture))
    .then((textures) => {
      const loaded = [];
      const failed = [];
      for (let i = 0; i < keys.length; i++) {
        (textures[i] ? loaded : failed).push(keys[i]);
      }
      _terrainPreloadStatus = Object.freeze({
        ready: failed.length === 0,
        loaded: Object.freeze(loaded),
        failed: Object.freeze(failed),
      });
      return _terrainPreloadStatus;
    })
    .catch(() => {
      _terrainPreloadStatus = Object.freeze({
        ready: false,
        loaded: Object.freeze([]),
        failed: Object.freeze(keys.slice()),
      });
      return _terrainPreloadStatus;
    });
  return _terrainPreloadPromise;
}

function applyMaterialMaps(materials, colorKey, normalKey, roughnessKey) {
  const map = _terrainTextureCache.get(colorKey);
  const normalMap = _terrainTextureCache.get(normalKey);
  const roughnessMap = _terrainTextureCache.get(roughnessKey);
  if (!map) return;
  for (const material of materials) {
    if (!material) continue;
    material.map = map;
    material.normalMap = normalMap || null;
    material.roughnessMap = roughnessMap || null;
    material.needsUpdate = true;
  }
}

function hydrateTerrainMaterials(stage, kit) {
  preloadKakiLandTerrain().then((status) => {
    if (_stage !== stage) return;
    const materials = kit.materials;
    applyMaterialMaps([materials.grass], 'turf', 'turfNormal', 'turfRoughness');
    applyMaterialMaps([materials.grassLight], 'turfDetail', 'turfNormal', 'turfRoughness');
    applyMaterialMaps([materials.stone], 'cliffDetail', 'cliffNormal', 'cliffRoughness');
    applyMaterialMaps([materials.stoneWarm], 'cliff', 'cliffNormal', 'cliffRoughness');
    applyMaterialMaps([materials.plaza], 'plaza', 'plazaNormal', 'plazaRoughness');
    applyMaterialMaps([materials.emberRock], 'ember', 'emberNormal', 'emberRoughness');
    applyMaterialMaps([materials.tideStone], 'tide', 'tideNormal', 'tideRoughness');
    applyMaterialMaps([materials.bloomStone], 'bloom', 'bloomNormal', 'bloomRoughness');
    applyMaterialMaps([materials.emberGround], 'ember', 'emberNormal', 'emberRoughness');
    applyMaterialMaps([materials.tideGround], 'tide', 'tideNormal', 'tideRoughness');
    applyMaterialMaps([materials.bloomGround], 'bloom', 'bloomNormal', 'bloomRoughness');
    // A visual "ready" flag is only true if every authored terrain texture
    // actually decoded. This makes an HTTP/missing-image failure observable
    // instead of quietly presenting a flat-color island as a finished map.
    stage.userData.terrainTextureStatus = status;
    stage.userData.terrainTexturesReady = !!(status && status.ready);
  });
}

function activateKakiLandSky(scene, stage) {
  if (!scene || !stage) return;
  // Capture the background only when Kaki begins owning it. A visibility
  // toggle restores this value, then a later re-show captures the current
  // normal stage/town background again.
  if (!Object.prototype.hasOwnProperty.call(stage.userData, 'previousSceneBackground')) {
    stage.userData.previousSceneBackground = scene.background;
  }
  // Own a replacement Color instead of mutating the shared Town/overworld
  // background. That keeps the painted-sky loading frame pleasant while
  // guaranteeing visibility toggles restore the exact object that was there.
  if (!stage.userData.skyFallback) {
    stage.userData.skyFallback = new THREE.Color(KAKI_LAND_SKY_FALLBACK);
  }
  const applySky = (texture) => {
    if (!texture || _stage !== stage || stage.parent !== scene || !stage.visible) return;
    scene.background = texture;
    stage.userData.skyTexture = texture;
  };
  if (_skyTexture) {
    applySky(_skyTexture);
    return;
  }
  if (stage.visible) scene.background = stage.userData.skyFallback;
  if (_skyLoading) return;
  _skyLoading = true;
  new THREE.TextureLoader().load(
    KAKI_LAND_SKY_URL,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      _skyTexture = texture;
      _skyLoading = false;
      // A stage can be hidden/disposed while this first decode is in flight.
      // Re-target the currently live Kaki stage rather than reviving an old
      // one or leaking the sky into Town.
      const activeStage = _stage;
      const activeScene = activeStage && activeStage.parent && activeStage.parent.isScene
        ? activeStage.parent
        : null;
      if (activeStage && activeScene && activeStage.visible) {
        activateKakiLandSky(activeScene, activeStage);
      }
    },
    undefined,
    () => { _skyLoading = false; },
  );
}

function restoreKakiLandSky(scene, stage) {
  if (!scene || !stage) return;
  const ownsTexture = stage.userData.skyTexture && scene.background === stage.userData.skyTexture;
  const ownsFallback = stage.userData.skyFallback && scene.background === stage.userData.skyFallback;
  if (ownsTexture || ownsFallback) {
    scene.background = stage.userData.previousSceneBackground || new THREE.Color(KAKI_LAND_PALETTE.cloudShadow);
  }
  stage.userData.skyTexture = null;
  delete stage.userData.skyFallback;
  delete stage.userData.previousSceneBackground;
}

function standard(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0.02,
    flatShading: true,
    ...options,
  });
}

function emissive(color, intensity = 1, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.38,
    metalness: 0.08,
    flatShading: true,
    toneMapped: false,
    ...options,
  });
}

function makeTerrainKit() {
  return {
    materials: {
      grass: standard(0xffffff, { roughness: 0.88, flatShading: false }),
      grassLight: standard(0xdff8d5, { roughness: 0.84, flatShading: false }),
      stone: standard(0xffffff, { roughness: 0.92, flatShading: false }),
      stoneLight: standard(KAKI_LAND_PALETTE.stoneLight, { roughness: 0.9 }),
      stoneWarm: standard(0xf4dfc5, { roughness: 0.94, flatShading: false }),
      wood: standard(KAKI_LAND_PALETTE.bridgeWood, { roughness: 0.88 }),
      woodLight: standard(KAKI_LAND_PALETTE.bridgeHighlight, { roughness: 0.76 }),
      plaza: standard(0xffffff, { roughness: 0.86, flatShading: false }),
      plazaInlay: emissive(KAKI_LAND_PALETTE.plazaInlay, 0.42),
      ruin: standard(KAKI_LAND_PALETTE.ruinStone, { roughness: 0.88 }),
      emberRock: standard(0xffffff, { roughness: 0.9, flatShading: false }),
      emberGlow: emissive(KAKI_LAND_PALETTE.emberGlow, 1.05),
      tideStone: standard(0xffffff, { roughness: 0.8, flatShading: false }),
      tideGlow: emissive(KAKI_LAND_PALETTE.tideGlow, 0.92, {
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      }),
      bloomStone: standard(0xffffff, { roughness: 0.9, flatShading: false }),
      bloomGlow: emissive(KAKI_LAND_PALETTE.bloomGlow, 0.96, {
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
      }),
      // Satellite ground swatches turn the three routes into distinct places
      // rather than identical green circles with different portal colors.
      emberGround: standard(0xffffff, {
        roughness: 0.92,
        flatShading: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
      tideGround: standard(0xffffff, {
        roughness: 0.82,
        flatShading: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
      bloomGround: standard(0xffffff, {
        roughness: 0.88,
        flatShading: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
      flower: emissive(KAKI_LAND_PALETTE.flower, 0.34),
      cloud: standard(KAKI_LAND_PALETTE.cloud, {
        roughness: 1,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
      cloudShadow: standard(KAKI_LAND_PALETTE.cloudShadow, {
        roughness: 1,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      }),
      rune: emissive(KAKI_LAND_PALETTE.rune, 0.6),
    },
    geometry: {
      crystal: new THREE.OctahedronGeometry(0.62, 0),
      flower: new THREE.IcosahedronGeometry(0.3, 1),
      bridgePost: new THREE.CylinderGeometry(0.13, 0.17, 1.2, 6),
      bridgeRope: new THREE.CylinderGeometry(0.065, 0.065, 1, 6),
    },
  };
}

function shadowFlags(mesh, casts = true) {
  mesh.castShadow = casts;
  mesh.receiveShadow = true;
  return mesh;
}

function bloom(mesh) {
  mesh.layers.enable(BLOOM_LAYER);
  return mesh;
}

function unit(seed) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function polar(radius, angle) {
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

function makeOrganicPatchGeometry(radius, seed) {
  const shape = new THREE.Shape();
  const points = 22;
  for (let index = 0; index < points; index++) {
    const angle = (index / points) * Math.PI * 2;
    const r = radius * (0.76 + unit(seed + index * 29) * 0.22);
    const pos = polar(r, angle);
    if (index === 0) shape.moveTo(pos.x, pos.z);
    else shape.lineTo(pos.x, pos.z);
  }
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI * 0.5);
  return geometry;
}

function addBiomeSurface(parent, kit, radius, id, seed) {
  const material = id === 'kaki-ember'
    ? kit.materials.emberGround
    : id === 'kaki-tide'
      ? kit.materials.tideGround
      : id === 'kaki-bloom'
        ? kit.materials.bloomGround
        : null;
  if (!material) return null;
  const patch = new THREE.Mesh(
    makeOrganicPatchGeometry(radius * 0.73, seed + 701),
    material,
  );
  patch.name = `kakiLand_${id}_biomeSurface`;
  // The grass inset's visible top is SURFACE_Y + 0.05. Keep this essentially
  // coplanar (with polygon offset above) so it reads as terrain, never as a
  // raised combat disc or an AoE marker.
  patch.position.y = SURFACE_Y + 0.052;
  patch.rotation.y = unit(seed + 709) * Math.PI * 2;
  patch.castShadow = false;
  patch.receiveShadow = true;
  parent.add(patch);
  return patch;
}

function addCrystalCluster(parent, kit, x, z, material, seed, scale = 1) {
  const cluster = new THREE.Group();
  const count = 3 + Math.floor(unit(seed) * 3);
  for (let i = 0; i < count; i++) {
    const angle = unit(seed + i * 13) * Math.PI * 2;
    const distance = i === 0 ? 0 : 0.28 + unit(seed + i * 17) * 0.74;
    const height = (0.95 + unit(seed + i * 23) * 1.6) * scale;
    const crystal = bloom(new THREE.Mesh(kit.geometry.crystal, material));
    crystal.position.set(
      x + Math.cos(angle) * distance,
      SURFACE_Y + height * 0.48,
      z + Math.sin(angle) * distance,
    );
    crystal.scale.set(0.48 * scale, height, 0.48 * scale);
    crystal.rotation.set(unit(seed + i * 29) * 0.22, angle, unit(seed + i * 31) * 0.24);
    crystal.castShadow = false;
    cluster.add(crystal);
  }
  parent.add(cluster);
  return cluster;
}

function addRuinPylon(parent, kit, x, z, seed, accentMaterial = kit.materials.plazaInlay) {
  const pylon = new THREE.Group();
  pylon.position.set(x, SURFACE_Y, z);
  pylon.rotation.y = unit(seed) * Math.PI;

  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.92, 0.36, 6), kit.materials.ruin);
  foot.position.y = 0.18;
  shadowFlags(foot);
  pylon.add(foot);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.52, 2.15, 0.52), kit.materials.ruin);
  shaft.position.y = 1.38;
  shadowFlags(shaft);
  pylon.add(shaft);
  const glyph = bloom(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.78, 0.08), accentMaterial));
  glyph.position.set(0, 1.48, 0.29);
  glyph.castShadow = false;
  pylon.add(glyph);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.72, 4), kit.materials.plaza);
  cap.position.y = 2.8;
  cap.rotation.y = Math.PI * 0.25;
  shadowFlags(cap);
  pylon.add(cap);
  parent.add(pylon);
  return pylon;
}

function addWaterfall(parent, kit, angle, radius, height, material, seed) {
  const pos = polar(radius * 0.91, angle);
  const waterfall = new THREE.Group();
  waterfall.position.set(pos.x, SURFACE_Y - 0.95 - height * 0.5, pos.z);
  waterfall.rotation.y = -angle;

  const fall = bloom(new THREE.Mesh(new THREE.BoxGeometry(1.05, height, 0.2), material));
  fall.scale.x = 0.82 + unit(seed) * 0.44;
  fall.castShadow = false;
  fall.receiveShadow = false;
  waterfall.add(fall);
  const mist = new THREE.Mesh(new THREE.SphereGeometry(0.86, 8, 6), kit.materials.cloud);
  mist.position.y = -height * 0.52;
  mist.scale.set(1.45, 0.38, 0.72);
  mist.castShadow = false;
  mist.receiveShadow = false;
  waterfall.add(mist);
  parent.add(waterfall);
  return waterfall;
}

function addBiomeLandmarks(parent, kit, radius, bodyHeight, undersideHeight, id, seed) {
  const outer = radius * 0.57;
  if (id === 'kaki-ember') {
    for (let i = 0; i < 5; i++) {
      const angle = -0.68 + i * 1.22;
      const pos = polar(outer + unit(seed + i) * 1.8, angle);
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.7 + unit(seed + i * 5) * 0.28, 2.4 + unit(seed + i * 7), 5), kit.materials.emberRock);
      spike.position.set(pos.x, SURFACE_Y + 1.05, pos.z);
      spike.rotation.set(0, angle, (unit(seed + i * 11) - 0.5) * 0.34);
      shadowFlags(spike);
      parent.add(spike);
      addCrystalCluster(parent, kit, pos.x * 0.86, pos.z * 0.86, kit.materials.emberGlow, seed + i * 31, 0.85);
    }
    for (let i = 0; i < 3; i++) {
      const angle = -0.35 + i * 1.6;
      const fissure = bloom(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 3.3), kit.materials.emberGlow));
      const pos = polar(radius * (0.34 + i * 0.08), angle);
      fissure.position.set(pos.x, SURFACE_Y + 0.08, pos.z);
      fissure.rotation.y = angle + Math.PI * 0.5;
      fissure.castShadow = false;
      parent.add(fissure);
    }
    addWaterfall(parent, kit, -2.1, radius, bodyHeight + undersideHeight * 0.42, kit.materials.emberGlow, seed + 91);
    return;
  }

  if (id === 'kaki-tide') {
    for (let i = 0; i < 5; i++) {
      const pos = polar(outer + unit(seed + i * 7) * 1.4, 0.44 + i * 1.15);
      addCrystalCluster(parent, kit, pos.x, pos.z, kit.materials.tideGlow, seed + i * 37, 0.98);
      if (i % 2 === 0) addRuinPylon(parent, kit, pos.x * 0.76, pos.z * 0.76, seed + i * 41, kit.materials.tideGlow);
    }
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.3, 0.06, 18), kit.materials.tideGlow);
    pool.position.set(0, SURFACE_Y + 0.075, -radius * 0.35);
    pool.scale.z = 0.68;
    pool.castShadow = false;
    parent.add(pool);
    addWaterfall(parent, kit, -1.75, radius, bodyHeight + undersideHeight * 0.55, kit.materials.tideGlow, seed + 101);
    addWaterfall(parent, kit, 1.58, radius, bodyHeight + undersideHeight * 0.42, kit.materials.tideGlow, seed + 107);
    return;
  }

  if (id === 'kaki-bloom') {
    for (let i = 0; i < 6; i++) {
      const angle = -0.25 + i * 1.03;
      const pos = polar(outer + unit(seed + i * 5) * 1.2, angle);
      const thorn = new THREE.Mesh(new THREE.ConeGeometry(0.42 + unit(seed + i * 9) * 0.2, 2.25 + unit(seed + i * 11), 5), kit.materials.bloomStone);
      thorn.position.set(pos.x, SURFACE_Y + 0.92, pos.z);
      thorn.rotation.set(0, angle, (unit(seed + i * 17) - 0.5) * 0.42);
      shadowFlags(thorn);
      parent.add(thorn);
      const flower = bloom(new THREE.Mesh(kit.geometry.flower, kit.materials.flower));
      flower.position.set(pos.x * 0.83, SURFACE_Y + 0.58 + unit(seed + i * 19) * 0.25, pos.z * 0.83);
      flower.scale.setScalar(1.2 + unit(seed + i * 23) * 0.68);
      flower.rotation.set(unit(seed + i * 29), angle, 0);
      flower.castShadow = false;
      parent.add(flower);
      if (i % 2 === 0) addCrystalCluster(parent, kit, pos.x * 0.91, pos.z * 0.91, kit.materials.bloomGlow, seed + i * 43, 0.72);
    }
    addWaterfall(parent, kit, 2.25, radius, bodyHeight + undersideHeight * 0.32, kit.materials.bloomGlow, seed + 113);
    return;
  }

  // The central island gets pale sanctuary ruins and cool waterfalls so it
  // reads as the final destination before its gate is unlocked.
  for (let i = 0; i < 7; i++) {
    const pos = polar(radius * (0.6 + (i % 2) * 0.08), i * 0.9 + 0.22);
    addRuinPylon(parent, kit, pos.x, pos.z, seed + i * 47, kit.materials.plazaInlay);
  }
  addWaterfall(parent, kit, -2.1, radius, bodyHeight + undersideHeight * 0.45, kit.materials.tideGlow, seed + 121);
  addWaterfall(parent, kit, 0.58, radius, bodyHeight + undersideHeight * 0.37, kit.materials.tideGlow, seed + 127);
}

function createCentralDais(parent, kit, trialSpecs) {
  const dais = new THREE.Group();
  dais.name = 'kakiLand_mainSanctuaryDais';

  const foundation = new THREE.Mesh(new THREE.CylinderGeometry(12.8, 13.5, 0.42, 24), kit.materials.stoneWarm);
  foundation.position.y = SURFACE_Y + 0.02;
  shadowFlags(foundation);
  dais.add(foundation);
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(11.9, 12.25, 0.22, 24), kit.materials.plaza);
  plaza.position.y = SURFACE_Y + 0.31;
  shadowFlags(plaza);
  dais.add(plaza);

  for (const radius of [4.7, 8.3, 11.25]) {
    const ring = bloom(new THREE.Mesh(new THREE.TorusGeometry(radius, 0.1, 5, 40), kit.materials.plazaInlay));
    ring.position.y = SURFACE_Y + 0.45;
    ring.rotation.x = Math.PI * 0.5;
    ring.castShadow = false;
    dais.add(ring);
  }
  const rune = bloom(new THREE.Mesh(new THREE.RingGeometry(2.35, 3.8, 12), kit.materials.plazaInlay));
  rune.position.y = SURFACE_Y + 0.47;
  rune.rotation.x = -Math.PI * 0.5;
  rune.castShadow = false;
  dais.add(rune);

  for (const spec of trialSpecs) {
    const length = 11.5;
    const angle = Math.atan2(spec.x, spec.z);
    const path = new THREE.Mesh(new THREE.BoxGeometry(2.75, 0.12, length), kit.materials.plaza);
    path.position.set(Math.sin(angle) * 11.6, SURFACE_Y + 0.45, Math.cos(angle) * 11.6);
    path.rotation.y = angle;
    shadowFlags(path, false);
    dais.add(path);
    const seam = bloom(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, length - 0.7), kit.materials.plazaInlay));
    seam.position.set(Math.sin(angle) * 11.6, SURFACE_Y + 0.53, Math.cos(angle) * 11.6);
    seam.rotation.y = angle;
    seam.castShadow = false;
    dais.add(seam);
  }
  for (let i = 0; i < 6; i++) {
    const pos = polar(10.7, i * Math.PI / 3 + Math.PI / 6);
    addRuinPylon(dais, kit, pos.x, pos.z, 501 + i, kit.materials.plazaInlay);
  }

  parent.add(dais);
  return dais;
}

function createFloatingIsland({ id, x, z, radius, seed, kit }) {
  const island = new THREE.Group();
  island.name = `kakiLand_${id}Island`;
  island.position.set(x, 0, z);
  island.userData.islandId = id;

  // Dense enough for the generated cliff strata to read as a shaped island
  // rather than a low-sided cylinder, while staying below a single character
  // mesh worth of geometry for all four islands combined.
  const segments = radius > 20 ? 36 : 28;
  const bodyHeight = radius > 20 ? 4.4 : 3.35;
  const undersideHeight = radius > 20 ? 15.5 : 9.8;

  // The cap is a separate mesh from the cliff, giving the grass a pleasantly
  // thick, toy-like edge while the rock can taper hard toward a floating tip.
  const grassCap = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.985, 0.58, segments),
    kit.materials.grass,
  );
  grassCap.position.y = SURFACE_Y - 0.29;
  shadowFlags(grassCap);
  island.add(grassCap);

  const grassInset = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.82, radius * 0.88, 0.08, segments),
    kit.materials.grassLight,
  );
  grassInset.position.y = SURFACE_Y + 0.01;
  grassInset.scale.z = 0.92;
  grassInset.castShadow = false;
  grassInset.receiveShadow = true;
  island.add(grassInset);

  // Satellite routes now carry biome-scale terrain, rather than placing a
  // colored portal on top of the same anonymous lawn three times.
  const biomeSurface = addBiomeSurface(island, kit, radius, id, seed);

  const cliff = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.97, radius * 0.79, bodyHeight, segments),
    kit.materials.stone,
  );
  cliff.position.y = SURFACE_Y - 0.58 - bodyHeight * 0.5;
  shadowFlags(cliff);
  island.add(cliff);

  const underside = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 0.79, undersideHeight, segments),
    kit.materials.stoneWarm,
  );
  underside.position.y = SURFACE_Y - 0.58 - bodyHeight - undersideHeight * 0.5;
  underside.rotation.y = unit(seed) * Math.PI;
  shadowFlags(underside);
  island.add(underside);

  // A ring of faceted ledges breaks up the primitive silhouette and makes the
  // underside read as chipped rock rather than a perfect cone.
  const ledgeCount = radius > 20 ? 13 : 8;
  for (let i = 0; i < ledgeCount; i++) {
    const angle = (i / ledgeCount) * Math.PI * 2 + unit(seed + i * 41) * 0.23;
    const r = radius * (0.71 + unit(seed + i * 43) * 0.17);
    const pos = polar(r, angle);
    const ledge = new THREE.Mesh(
      new THREE.DodecahedronGeometry(radius * (0.075 + unit(seed + i * 47) * 0.038), 0),
      i % 2 === 0 ? kit.materials.stoneLight : kit.materials.stone,
    );
    ledge.position.set(
      pos.x,
      SURFACE_Y - 1.35 - unit(seed + i * 53) * Math.min(4.6, bodyHeight + 0.65),
      pos.z,
    );
    ledge.scale.set(1.45, 0.75, 1.05);
    ledge.rotation.set(unit(seed + i * 59), angle, unit(seed + i * 61) * 0.25);
    shadowFlags(ledge);
    island.add(ledge);
  }

  addBiomeLandmarks(island, kit, radius, bodyHeight, undersideHeight, id, seed + 173);
  island.userData.biomeSurface = biomeSurface;
  return island;
}

function createBridge(parent, kit, from, to, fromRadius, toRadius, id) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= fromRadius + toRadius + 1) return null;

  const nx = dx / distance;
  const nz = dz / distance;
  const start = { x: from.x + nx * (fromRadius - 1.1), z: from.z + nz * (fromRadius - 1.1) };
  const end = { x: to.x - nx * (toRadius - 1.05), z: to.z - nz * (toRadius - 1.05) };
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  const bridge = new THREE.Group();
  bridge.name = `kakiLand_bridge_${id}`;
  bridge.position.set((start.x + end.x) * 0.5, SURFACE_Y + 0.19, (start.z + end.z) * 0.5);
  bridge.rotation.y = Math.atan2(nx, nz);
  bridge.userData.connects = [from.id, to.id];

  const width = 5.3;
  const routeColor = id === 'kaki-ember'
    ? KAKI_LAND_PALETTE.trialEmber
    : id === 'kaki-tide'
      ? KAKI_LAND_PALETTE.trialTide
      : KAKI_LAND_PALETTE.trialBloom;
  const underlay = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.62, 0.42, length + 0.9),
    kit.materials.stoneWarm,
  );
  underlay.position.y = -0.12;
  shadowFlags(underlay);
  bridge.add(underlay);

  const plankCount = Math.max(4, Math.ceil(length / 1.42));
  const plankDepth = length / plankCount;
  for (let i = 0; i < plankCount; i++) {
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.25, Math.max(0.38, plankDepth - 0.075)),
      i % 3 === 0 ? kit.materials.woodLight : kit.materials.wood,
    );
    plank.position.set(0, 0.2 + (i % 2) * 0.025, -length * 0.5 + plankDepth * (i + 0.5));
    plank.rotation.y = (i % 2 === 0 ? 1 : -1) * 0.018;
    shadowFlags(plank);
    bridge.add(plank);
  }

  // A restrained route seam makes each bridge a colour-coded invitation from
  // the hub instead of a generic plank path. It stays narrow enough that the
  // neutral wood deck remains readable during combat.
  const routeSeam = bloom(new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.055, Math.max(0.6, length - 0.74)),
    emissive(routeColor, 0.72),
  ));
  routeSeam.position.y = 0.355;
  routeSeam.castShadow = false;
  bridge.add(routeSeam);
  bridge.userData.routeSeam = routeSeam;

  // Simple rope rails keep the bridges legible from the iso camera without
  // turning them into a dense fence. The low-poly posts echo the island rock.
  const railPositions = [-width * 0.5 - 0.08, width * 0.5 + 0.08];
  for (const railX of railPositions) {
    const rope = new THREE.Mesh(kit.geometry.bridgeRope, kit.materials.woodLight);
    rope.position.set(railX, 0.97, 0);
    rope.scale.y = length;
    rope.rotation.x = Math.PI * 0.5;
    rope.castShadow = false;
    rope.receiveShadow = false;
    bridge.add(rope);
  }

  const postCount = Math.max(2, Math.floor(length / 5));
  for (let i = 0; i <= postCount; i++) {
    const localZ = -length * 0.5 + (length * i) / postCount;
    for (const postX of railPositions) {
      const post = new THREE.Mesh(kit.geometry.bridgePost, kit.materials.wood);
      post.position.set(postX, 0.65, localZ);
      shadowFlags(post);
      bridge.add(post);
    }
  }

  parent.add(bridge);
  return bridge;
}

function makePortalMaterialSet(color, isMain) {
  return {
    ring: emissive(color, isMain ? 0.52 : 1.1),
    frame: standard(KAKI_LAND_PALETTE.ruinStone, { roughness: 0.76 }),
    frameTrim: emissive(isMain ? KAKI_LAND_PALETTE.mainPortalGlow : color, isMain ? 0.36 : 0.58),
    core: new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isMain ? 0.32 : 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
    base: emissive(color, isMain ? 0.36 : 0.75),
    lock: emissive(KAKI_LAND_PALETTE.locked, 0.18),
  };
}

function setPortalVisualState(portal, { unlocked, completed = false, completedTrials = 0 }) {
  const data = portal.userData;
  data.unlocked = unlocked;
  data.completed = completed;
  data.completedTrials = completedTrials;
  if (data.locks) {
    data.locks.forEach((lock, index) => {
      // The main gate starts with three runic locks; each completed trial
      // physically removes one so progression is readable at a glance.
      lock.visible = data.kind === 'main' && !unlocked && index >= completedTrials;
    });
  }
  if (data.lock) data.lock.visible = data.kind === 'main' && !unlocked;

  if (data.kind === 'main') {
    data.materials.ring.emissiveIntensity = unlocked ? 1.5 : 0.18;
    data.materials.base.emissiveIntensity = unlocked ? 1.25 : 0.12;
    data.materials.core.opacity = unlocked ? 0.78 : 0.2;
    data.materials.core.color.setHex(unlocked ? KAKI_LAND_PALETTE.mainPortalGlow : KAKI_LAND_PALETTE.locked);
  } else {
    data.materials.ring.emissiveIntensity = completed ? 0.28 : 1.1;
    data.materials.base.emissiveIntensity = completed ? 0.22 : 0.75;
    data.materials.core.opacity = completed ? 0.2 : 0.62;
  }
}

function createPortal(spec, isMain) {
  const portal = new THREE.Group();
  portal.name = `kakiLand_portal_${spec.id}`;
  portal.position.set(spec.x, SURFACE_Y, spec.z);

  // Satellite doors face inward so the central island reads as the hub. The
  // main door faces the default camera-friendly direction.
  if (!isMain) portal.rotation.y = Math.atan2(-spec.x, -spec.z);

  const color = isMain ? KAKI_LAND_PALETTE.mainPortal : spec.color;
  const materials = makePortalMaterialSet(color, isMain);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 6.9, 0.34, 12), materials.lock);
  base.position.y = 0.15;
  shadowFlags(base);
  portal.add(base);

  const baseRing = bloom(new THREE.Mesh(new THREE.TorusGeometry(5.32, 0.12, 6, 32), materials.base));
  baseRing.position.y = 0.38;
  baseRing.rotation.x = Math.PI * 0.5;
  baseRing.castShadow = false;
  portal.add(baseRing);

  // The old portal was mostly a floor ring from the overview. A broad stone
  // arch, two pylon silhouettes and an inset glow make it a real landmark.
  const frame = new THREE.Mesh(new THREE.TorusGeometry(4.35, 0.46, 7, 32), materials.frame);
  frame.position.y = 4.45;
  shadowFlags(frame);
  portal.add(frame);
  const frameTrim = bloom(new THREE.Mesh(new THREE.TorusGeometry(4.35, 0.075, 5, 32), materials.frameTrim));
  frameTrim.position.y = 4.45;
  frameTrim.castShadow = false;
  portal.add(frameTrim);
  for (const side of [-1, 1]) {
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.94, 1.18, 0.48, 6), materials.frame);
    plinth.position.set(side * 4.22, 0.28, 0.02);
    shadowFlags(plinth);
    portal.add(plinth);
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.74, 4.7, 6), materials.frame);
    pylon.position.set(side * 4.22, 2.6, 0.02);
    shadowFlags(pylon);
    portal.add(pylon);
    const pylonGlyph = bloom(new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.62, 0.08), materials.frameTrim));
    pylonGlyph.position.set(side * 4.22, 2.63, 0.58);
    pylonGlyph.castShadow = false;
    portal.add(pylonGlyph);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.86, 0.86, 4), materials.frame);
    cap.position.set(side * 4.22, 5.38, 0.02);
    cap.rotation.y = Math.PI * 0.25;
    shadowFlags(cap);
    portal.add(cap);
  }

  const ring = bloom(new THREE.Mesh(new THREE.TorusGeometry(3.48, 0.29, 7, 32), materials.ring));
  ring.position.y = 4.45;
  ring.castShadow = false;
  portal.add(ring);

  const inner = bloom(new THREE.Mesh(new THREE.CircleGeometry(3.16, 32), materials.core));
  inner.position.set(0, 4.45, -0.025);
  inner.castShadow = false;
  inner.renderOrder = 2;
  portal.add(inner);

  const crest = bloom(new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), materials.ring));
  crest.position.set(0, 8.92, 0);
  crest.rotation.y = Math.PI * 0.25;
  crest.castShadow = false;
  portal.add(crest);

  const orbiters = new THREE.Group();
  orbiters.position.y = 4.45;
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI * 0.25;
    const shard = bloom(new THREE.Mesh(new THREE.TetrahedronGeometry(0.35, 0), materials.ring));
    shard.position.set(Math.cos(angle) * 4.72, Math.sin(angle) * 3.0, 0.04);
    shard.rotation.set(angle, angle * 0.5, 0);
    shard.castShadow = false;
    orbiters.add(shard);
  }
  portal.add(orbiters);

  const lock = new THREE.Group();
  lock.name = `${portal.name}_locks`;
  const locks = [];
  if (isMain) {
    const lockAngles = [Math.PI * 0.5, Math.PI * 1.12, -Math.PI * 0.12];
    for (let i = 0; i < lockAngles.length; i++) {
      const angle = lockAngles[i];
      const lockMark = new THREE.Group();
      lockMark.name = `${portal.name}_lock_${i + 1}`;
      lockMark.position.set(Math.cos(angle) * 4.48, 4.45 + Math.sin(angle) * 2.55, 0.22);
      const lockBody = bloom(new THREE.Mesh(new THREE.BoxGeometry(1.18, 1.2, 0.2), materials.lock));
      lockBody.position.y = -0.16;
      lockMark.add(lockBody);
      const lockShackle = bloom(new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.11, 6, 18, Math.PI), materials.lock));
      lockShackle.position.y = 0.48;
      lockShackle.rotation.z = Math.PI;
      lockMark.add(lockShackle);
      lock.add(lockMark);
      locks.push(lockMark);
    }
  }
  portal.add(lock);

  portal.userData = {
    portalId: spec.id,
    kind: spec.kind,
    label: spec.label,
    landing: { x: spec.x, z: spec.z },
    interactRadius: PORTAL_INTERACT_RADIUS,
    materials,
    lock,
    locks,
    orbiters,
    baseRing,
    ring,
    core: inner,
    crest,
    frameTrim,
    unlocked: !isMain,
    completed: false,
  };
  setPortalVisualState(portal, { unlocked: !isMain });
  return portal;
}

function disposeTree(root) {
  const geometry = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry) geometry.add(object.geometry);
    if (!object.material) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) materials.add(material);
  });
  for (const item of geometry) {
    try { item.dispose(); } catch (_) {}
  }
  for (const item of materials) {
    try { item.dispose(); } catch (_) {}
  }
}

function stageInScene(scene) {
  if (!scene || typeof scene.getObjectByName !== 'function') return null;
  const existing = scene.getObjectByName(KAKI_LAND_STAGE_GROUP_NAME);
  return existing && existing.userData && existing.userData.isKakiLandStage ? existing : null;
}

/**
 * Build Kaki Land and attach it to `scene`.
 *
 * The function is idempotent: a prior Kaki Land instance is safely removed
 * before a new group is mounted, including across scene swaps.
 */
export function buildKakiLandStage(scene) {
  if (!scene || typeof scene.add !== 'function') return null;
  if (_stage) disposeKakiLandStage();

  const existing = stageInScene(scene);
  if (existing) {
    if (existing.parent) existing.parent.remove(existing);
    disposeTree(existing);
  }

  const kit = makeTerrainKit();
  const stage = new THREE.Group();
  stage.name = KAKI_LAND_STAGE_GROUP_NAME;
  stage.userData.isKakiLandStage = true;
  stage.userData.surfaceY = SURFACE_Y;
  stage.userData.portalLayout = KAKI_LAND_PORTAL_LAYOUT;
  const horizonClouds = [];

  const mainSpec = KAKI_LAND_PORTAL_LAYOUT.main;
  const mainIsland = createFloatingIsland({
    id: 'main',
    x: mainSpec.x,
    z: mainSpec.z,
    radius: MAIN_ISLAND_RADIUS,
    seed: 19,
    kit,
  });
  stage.add(mainIsland);
  const centralDais = createCentralDais(mainIsland, kit, KAKI_LAND_PORTAL_LAYOUT.trials);

  const satellites = KAKI_LAND_PORTAL_LAYOUT.trials.map((spec, index) => {
    const island = createFloatingIsland({
      id: spec.id,
      x: spec.x,
      z: spec.z,
      radius: SATELLITE_RADIUS,
      seed: 113 + index * 71,
      kit,
    });
    stage.add(island);
    createBridge(
      stage,
      kit,
      { id: 'main', x: mainSpec.x, z: mainSpec.z },
      spec,
      MAIN_ISLAND_RADIUS,
      SATELLITE_RADIUS,
      spec.id,
    );
    return island;
  });

  const mainPortal = createPortal(mainSpec, true);
  stage.add(mainPortal);
  const trialPortals = KAKI_LAND_PORTAL_LAYOUT.trials.map((spec) => {
    const portal = createPortal(spec, false);
    stage.add(portal);
    return portal;
  });

  stage.userData.islands = { main: mainIsland, satellites };
  stage.userData.centralDais = centralDais;
  stage.userData.portals = { main: mainPortal, trials: trialPortals };
  stage.userData.portalById = new Map([
    [mainSpec.id, mainPortal],
    ...trialPortals.map((portal) => [portal.userData.portalId, portal]),
  ]);
  stage.userData.mainPortalRequirement = KAKI_LAND_MAIN_PORTAL_REQUIREMENT;
  stage.userData.horizonClouds = horizonClouds;
  stage.userData.cloudStyle = 'painted-sky-clouds';
  stage.userData.animationTime = 0;
  stage.userData.terrainTexturesReady = false;
  stage.userData.terrainTextureStatus = null;

  scene.add(stage);
  _stage = stage;
  hydrateTerrainMaterials(stage, kit);
  activateKakiLandSky(scene, stage);
  return stage;
}

/**
 * Mark a trial portal complete/incomplete. When all three trials are complete
 * the main-boss portal opens automatically. Returns false for an unknown id
 * or when Kaki Land is not mounted.
 */
export function setKakiLandTrialPortalCompleted(portalId, completed = true) {
  const portal = _stage && _stage.userData.portalById && _stage.userData.portalById.get(portalId);
  if (!portal || portal.userData.kind !== 'trial') return false;

  setPortalVisualState(portal, { unlocked: true, completed: !!completed });
  const allTrialsComplete = _stage.userData.portals.trials.every((trial) => trial.userData.completed);
  setKakiLandMainPortalUnlocked(allTrialsComplete);
  return true;
}

/**
 * Explicit main-portal state hook for save restoration or progression events.
 */
export function setKakiLandMainPortalUnlocked(unlocked = true) {
  if (!_stage || !_stage.userData.portals) return false;
  const completedTrials = _stage.userData.portals.trials
    .filter((trial) => trial.userData.completed)
    .length;
  setPortalVisualState(_stage.userData.portals.main, {
    unlocked: !!unlocked,
    completedTrials,
  });
  return true;
}

/** Hide/show the world map without discarding its progression visuals. */
export function setKakiLandStageVisible(visible, scene) {
  const stage = _stage || stageInScene(scene);
  if (!stage) return false;
  const ownerScene = stage.parent && stage.parent.isScene ? stage.parent : scene;
  if (!visible) {
    restoreKakiLandSky(ownerScene, stage);
    stage.visible = false;
    return true;
  }
  stage.visible = true;
  activateKakiLandSky(ownerScene, stage);
  return true;
}

/** Animate the world-map-only props without touching gameplay transforms. */
export function tickKakiLandStage(dt) {
  if (!_stage || !_stage.visible) return;
  const time = (_stage.userData.animationTime || 0) + Math.min(Math.max(dt || 0, 0), 0.05);
  _stage.userData.animationTime = time;
  const portals = _stage.userData.portals
    ? [_stage.userData.portals.main, ..._stage.userData.portals.trials]
    : [];
  portals.forEach((portal, index) => {
    const data = portal.userData;
    const phase = time * (0.9 + index * 0.07) + index * 1.7;
    const pulse = 1 + Math.sin(phase * 2.1) * 0.045;
    if (data.core) data.core.scale.setScalar(pulse);
    if (data.ring) data.ring.rotation.z = phase * 0.23;
    if (data.frameTrim) data.frameTrim.rotation.z = -phase * 0.12;
    if (data.baseRing) data.baseRing.rotation.z = phase * 0.16;
    if (data.orbiters) data.orbiters.rotation.z = phase * 0.42;
    if (data.crest) data.crest.position.y = 8.92 + Math.sin(phase * 1.8) * 0.16;
  });
  for (const cloud of _stage.userData.horizonClouds || []) {
    const phase = time * 0.24 + (cloud.userData.driftOffset || 0);
    cloud.position.x = cloud.userData.baseX + Math.sin(phase) * 1.25;
    cloud.position.z = cloud.userData.baseZ + Math.cos(phase * 0.78) * 0.7;
    cloud.position.y = cloud.userData.baseY + Math.sin(phase * 1.4) * 0.36;
  }
}

/**
 * Remove the mounted stage and dispose all generated GPU resources. Safe to
 * call repeatedly, or with a scene after a hot reload where module state was
 * reset. Returns whether a stage was actually removed.
 */
export function disposeKakiLandStage(scene) {
  const stage = _stage || stageInScene(scene);
  if (!stage) return false;
  const ownerScene = stage.parent && stage.parent.isScene ? stage.parent : scene;
  restoreKakiLandSky(ownerScene, stage);
  if (stage.parent) stage.parent.remove(stage);
  disposeTree(stage);
  if (stage === _stage) _stage = null;
  return true;
}
