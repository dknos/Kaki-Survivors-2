/**
 * Seeded lived-in environment overlay for every overworld stage.
 *
 * Three tightly-budgeted baseline batches add local composition without
 * changing the authored terrain or collision map:
 *   1) stage growth clusters (flowers / embers / crystals / mushrooms),
 *   2) low paw-stone trails that act as exploration cues, and
 *   3) a 32-slot ambient-life pool that drifts around the hero.
 * Forest adds three tiny instanced yarn layers for its seven collectible
 * caches. Every other overworld adds two instanced discovery layers with a
 * biome-specific interaction: Moon Bells, Forgehearts, Star Kittens, or Echo
 * Crystals. No discovery uses a floor decal, so collectibles never resemble
 * enemy AoE telegraphs.
 *
 * Growth visibly intensifies with objective progress (Grove Trials in Forest,
 * Portal Shards elsewhere). All placement is deterministic for the stored
 * per-run environment seed, avoids the spawn circle and authoritative terrain
 * hazards, and costs three baseline draw calls plus two discovery calls.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { state } from './state.js';
import {
  FOREST_PORTAL_POSITIONS,
  FOREST_ROOMS,
  getForestTravelAnchors,
} from './forestRooms.js';
import { getStageTerrainLayout, sampleStageTerrain } from './stageTerrainLayout.js';
import { activateNearestBallista } from './cinderBallistas.js';
import { rechargeVoidPads } from './voidTeleportPads.js';
import {
  AMBIENT_TEXTURES,
  DISCOVERY_PROFILES,
  isPointInStageGrowthCore,
  isPointNearStageDiscovery,
} from './stageExplorationLayout.js';

const LIFE_CAP = 32;
const START_CLEARANCE = 9;
const _terrainSample = {};

const PROFILES = Object.freeze({
  forest: Object.freeze({
    kind: 'flower', seed: 0xF07E57, growth: 336, initial: 0.54,
    color: 0xf0a6c2, accent: 0xf6d28b, emissive: 0x35121f,
    spread: 6.6, trailRadius: 39,
    anchors: Object.freeze([
      [-30, -26], [-18, 14], [18, -18], [31, 13], [-7, 33], [8, -34],
      [-80, -105], [-58, -72],          // Sap Hollow
      [-17, 92], [18, 70],              // Crystal Choir
      [116, -11], [147, 12],            // Amber Labyrinth
      [80, 91], [111, 69],              // Bramble Maze
      [-20, -158], [22, -125],          // Mossroot Hollow
      [-185, 17], [-143, -17],          // Glowfen Marshes
      // Continuous Wildwood travel corridors between Glade gates and rooms.
      [-38, -52], [-53, -68],           // toward Sap Hollow
      [0, 52], [0, 64],                 // toward Crystal Choir
      [60, 9], [80, 8], [100, 8],       // east toward Amber Labyrinth
      [53, 49], [69, 61],               // northeast toward Bramble Maze
      [13, -62], [9, -84], [4, -105],   // south toward Mossroot
      [-65, 1], [-90, -2], [-115, 2],   // west toward Glowfen
    ]),
  }),
  twilight: Object.freeze({
    kind: 'moonflower', seed: 0x71A7E1, growth: 304, initial: 0.54,
    color: 0xd8c7ff, accent: 0x9db8d8, emissive: 0x2f2458,
    spread: 7.4, trailRadius: 88,
    anchors: Object.freeze([
      [-30, 0], [2, 27], [-74, 55], [71, -63], [-25, 18], [58, -36],
      [-64, -42], [57, 62],
    ]),
  }),
  cinder: Object.freeze({
    kind: 'ember', seed: 0xC1D3E8, growth: 288, initial: 0.52,
    color: 0xcc5b2e, accent: 0xe5a24a, emissive: 0x6e1708,
    spread: 6.2, trailRadius: 90,
    anchors: Object.freeze([
      [-23, 25], [27, 39], [17, -44], [54, -13], [-45, 37], [42, 15],
      [-68, -54], [67, 59],
    ]),
  }),
  void: Object.freeze({
    kind: 'crystal', seed: 0xB01D1F, growth: 300, initial: 0.50,
    color: 0x77dce8, accent: 0xc39af4, emissive: 0x174b61,
    spread: 6.8, trailRadius: 90,
    anchors: Object.freeze([
      [17, 29], [-27, 18], [44, -2], [30, -34], [0, 82], [78, 61],
      [86, -52], [0, -88], [-82, -58], [-88, 48],
    ]),
  }),
  cave: Object.freeze({
    kind: 'mushroom', seed: 0xCA7E1F, growth: 312, initial: 0.55,
    color: 0x82dfcf, accent: 0xc7a9e8, emissive: 0x164d48,
    spread: 7.0, trailRadius: 91,
    anchors: Object.freeze([
      [-10, -6], [12, 11], [21, -12], [-58, 44], [64, -48], [74, 66],
      [-68, -55], [-74, 61], [68, -69],
    ]),
  }),
});

let _group = null;
let _growth = null;
let _paws = null;
let _life = null;
let _profile = null;
let _stageId = null;
let _resources = [];
let _growthTotal = 0;
let _lastShardCount = -1;
let _lifeInitialized = false;
let _lifeAcc = 0;
let _clock = 0;
let _lifeX = null;
let _lifeZ = null;
let _lifePhase = null;
let _lifeSpeed = null;
let _yarnCore = null;
let _yarnLoopA = null;
let _yarnLoopB = null;
let _yarnCaches = [];
let _yarnFound = 0;
let _discoveryCore = null;
let _discoveryGlow = null;
let _discoveryItems = [];
let _discoveryFound = 0;
let _discoveryProfile = null;
let _discoveryHintAt = -Infinity;

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

function _track(...items) {
  for (const item of items) if (item) _resources.push(item);
}

function _rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _hashString(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _runSeed(stageId) {
  if (!state.run) return _hashString(stageId);
  if (!Number.isFinite(state.run.environmentSeed)) {
    const replay = state.replaySeed && state.replaySeed.seed;
    state.run.environmentSeed = replay
      ? _hashString(String(replay))
      : ((Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
  }
  return (state.run.environmentSeed ^ _hashString(stageId)) >>> 0;
}

function _merge(parts) {
  // PolyhedronGeometry is non-indexed while cones/toruses are indexed. Normalize
  // before merging so composite discovery silhouettes never fall back (or emit
  // BufferGeometryUtils console errors) when the two families are combined.
  const hasIndexed = parts.some((part) => !!part.index);
  const hasNonIndexed = parts.some((part) => !part.index);
  const normalized = hasIndexed && hasNonIndexed
    ? parts.map((part) => part.index ? part.toNonIndexed() : part)
    : parts;
  const geo = mergeGeometries(normalized, false);
  const disposed = new Set();
  for (const part of [...normalized, ...parts]) {
    if (!part || disposed.has(part)) continue;
    disposed.add(part);
    part.dispose();
  }
  if (!geo) return new THREE.TetrahedronGeometry(0.3, 0);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function _scaledPart(geo, sx, sy, sz, x, y, z, rotY = 0) {
  geo.scale(sx, sy, sz);
  if (rotY) geo.rotateY(rotY);
  geo.translate(x, y, z);
  return geo;
}

function _growthGeometry(kind) {
  if (kind === 'crystal') {
    return _merge([
      _scaledPart(new THREE.OctahedronGeometry(0.34, 0), 0.7, 1.8, 0.7, 0, 0.50, 0, -0.18),
      _scaledPart(new THREE.OctahedronGeometry(0.22, 0), 0.65, 1.4, 0.65, 0.25, 0.29, 0.06, 0.28),
      _scaledPart(new THREE.OctahedronGeometry(0.18, 0), 0.62, 1.25, 0.62, -0.22, 0.23, 0.08, -0.42),
    ]);
  }
  if (kind === 'ember') {
    return _merge([
      _scaledPart(new THREE.DodecahedronGeometry(0.30, 0), 1.2, 0.42, 0.9, 0, 0.13, 0, 0.2),
      _scaledPart(new THREE.TetrahedronGeometry(0.20, 0), 0.8, 0.55, 0.8, 0.28, 0.12, 0.06, 0.6),
    ]);
  }
  if (kind === 'mushroom') {
    return _merge([
      _scaledPart(new THREE.CylinderGeometry(0.10, 0.13, 0.42, 6), 1, 1, 1, 0, 0.21, 0),
      _scaledPart(new THREE.SphereGeometry(0.25, 7, 4), 1.25, 0.48, 1.1, 0, 0.46, 0),
    ]);
  }

  const parts = [
    _scaledPart(new THREE.ConeGeometry(0.09, 0.48, 5), 1, 1, 1, 0, 0.24, 0),
  ];
  const petalCount = kind === 'moonflower' ? 6 : 5;
  const petalRadius = kind === 'moonflower' ? 0.22 : 0.18;
  for (let i = 0; i < petalCount; i++) {
    const a = i / petalCount * Math.PI * 2;
    parts.push(_scaledPart(
      new THREE.SphereGeometry(0.15, 5, 3),
      1.25, 0.34, 0.72,
      Math.cos(a) * petalRadius, 0.51, Math.sin(a) * petalRadius,
      -a,
    ));
  }
  parts.push(_scaledPart(new THREE.SphereGeometry(0.11, 6, 4), 1, 0.65, 1, 0, 0.52, 0));
  return _merge(parts);
}

function _pawGeometry() {
  const parts = [
    _scaledPart(new THREE.SphereGeometry(0.28, 7, 4), 1.1, 0.18, 0.85, 0, 0.055, -0.12),
  ];
  const toes = [[-0.24, 0.18], [-0.08, 0.30], [0.10, 0.30], [0.27, 0.18]];
  for (const toe of toes) {
    parts.push(_scaledPart(new THREE.SphereGeometry(0.12, 6, 3), 0.88, 0.16, 1.0, toe[0], 0.045, toe[1]));
  }
  return _merge(parts);
}

function _lifeGeometry() {
  // Grok-authored top-down butterfly sprite. A horizontal quad keeps the
  // silhouette unambiguously environmental from the isometric camera; the
  // former primitive bow-tie read too much like a directional combat tell.
  const geo = new THREE.PlaneGeometry(0.82, 0.82, 1, 1);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function _safe(stageId, x, z) {
  if (x * x + z * z < START_CLEARANCE * START_CLEARANCE) return false;
  const terrain = sampleStageTerrain(stageId, x, z, _terrainSample);
  return !terrain.active;
}

function _buildGrowth(parent, profile, rng) {
  const geo = _growthGeometry(profile.kind);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0,
    flatShading: true,
    emissive: profile.emissive,
    emissiveIntensity: 0.10,
  });
  const placements = [];
  for (let i = 0; i < profile.growth; i++) {
    const anchor = profile.anchors[i % profile.anchors.length];
    for (let attempt = 0; attempt < 18; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * profile.spread;
      const x = anchor[0] + Math.cos(a) * r;
      const z = anchor[1] + Math.sin(a) * r;
      if (!_safe(_stageId, x, z)) continue;
      if (isPointNearStageDiscovery(_stageId, x, z, 1.35)) continue;
      if (isPointInStageGrowthCore(_stageId, x, z, 0.25)) continue;
      placements.push({ x, z, yaw: rng() * Math.PI * 2, s: 0.72 + rng() * 0.72, shade: 0.82 + rng() * 0.20 });
      break;
    }
  }
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  mesh.name = `stageLife_${_stageId}_growth`;
  mesh.userData.landscapePurpose = 'shard-responsive-living-cluster';
  mesh.userData.dynamicEnvironment = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    _dummy.position.set(p.x, 0.015, p.z);
    _dummy.rotation.set(0, p.yaw, 0);
    _dummy.scale.setScalar(p.s);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
    _color.setHex(profile.color).multiplyScalar(p.shade);
    mesh.setColorAt(i, _color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  _track(geo, mat);
  _growthTotal = placements.length;
  return mesh;
}

function _buildPawTrails(parent, profile) {
  const geo = _pawGeometry();
  const mat = new THREE.MeshStandardMaterial({ color: profile.accent, roughness: 0.94, flatShading: true });
  const placements = [];
  const placementKeys = new Set();
  const addSegment = (a, b, steps, startInset = 0, endInset = 0) => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    const ux = dx / length;
    const uz = dz / length;
    const usable = Math.max(0.1, length - startInset - endInset);
    const yaw = Math.atan2(dx, dz);
    for (let step = 0; step < steps; step++) {
      const along = startInset + (step + 0.5) / steps * usable;
      const side = step % 2 ? 0.31 : -0.31;
      const x = a.x + ux * along - uz * side;
      const z = a.z + uz * along + ux * side;
      if (!_safe(_stageId, x, z)) continue;
      const key = `${Math.round(x * 5)},${Math.round(z * 5)}`;
      if (placementKeys.has(key)) continue;
      placementKeys.add(key);
      placements.push({ x, z, yaw, s: 0.50 + (step % 3) * 0.045 });
    }
  };

  if (_stageId === 'forest') {
    const glade = FOREST_ROOMS.glade.center;
    const bridges = getStageTerrainLayout('forest')?.bridges || [];
    const bridgeWest = bridges[0];
    const bridgeEast = bridges[1];
    for (const [key, portal] of Object.entries(FOREST_PORTAL_POSITIONS)) {
      const crossing = key === 'toCrystalchoir'
        ? bridgeWest
        : (key === 'toBramblemaze' ? bridgeEast : null);
      if (crossing) {
        addSegment(glade, crossing, 5, 9, 1.1);
        addSegment(crossing, portal, 5, 1.1, 2.4);
      } else {
        addSegment(glade, portal, 7, 9, 2.4);
      }
    }
    for (const room of Object.values(FOREST_ROOMS)) {
      if (room.isHub) continue;
      const anchors = getForestTravelAnchors(room.id);
      if (anchors) addSegment(anchors.entry, room.center, 8, 1.5, 5.5);
    }
    // No paw trail spans Glade-to-room world space: those links are portals,
    // and a continuous footprint path made the gate look optional.
  } else {
    const origin = { x: 0, z: 0 };
    const layout = getStageTerrainLayout(_stageId);
    const discoveries = DISCOVERY_PROFILES[_stageId];
    const segmentHitsCut = (a, b) => {
      for (let i = 1; i < 24; i++) {
        const t = i / 24;
        if (sampleStageTerrain(_stageId, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, _terrainSample).active) return true;
      }
      return false;
    };
    for (const targetTuple of (discoveries ? discoveries.placements : [])) {
      const target = { x: targetTuple[0], z: targetTuple[1] };
      if (layout && layout.bridges && segmentHitsCut(origin, target)) {
        let bridge = layout.bridges[0];
        let best = Infinity;
        for (const candidate of layout.bridges) {
          const score = Math.hypot(candidate.x - origin.x, candidate.z - origin.z)
            + Math.hypot(target.x - candidate.x, target.z - candidate.z);
          if (score < best) { best = score; bridge = candidate; }
        }
        addSegment(origin, bridge, 5, 9, 1.0);
        addSegment(bridge, target, 6, 1.0, 3.4);
      } else {
        addSegment(origin, target, 10, 9, 3.4);
      }
    }
  }
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  mesh.name = `stageLife_${_stageId}_pawRoutes`;
  mesh.userData.landscapePurpose = 'cat-navigation-cue';
  mesh.userData.navigationCue = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    _dummy.position.set(p.x, 0.01, p.z);
    _dummy.rotation.set(0, p.yaw, 0);
    _dummy.scale.setScalar(p.s);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  _track(geo, mat);
  return mesh;
}

function _forestYarnPlacements(rng) {
  const preferred = [
    ['glade', -17, -13],
    ['saphollow', -83, -108],
    ['crystalchoir', 18, 96],
    ['amberlabyrinth', 149, -12],
    ['bramblemaze', 112, 91],
    ['mossroot', -26, -158],
    ['glowfen', -187, 18],
  ];
  return preferred.map(([roomId, x, z]) => ({
    roomId, x, z,
    yaw: rng() * Math.PI * 2,
    phase: rng() * Math.PI * 2,
    found: false,
  }));
}

function _buildForestYarn(parent, rng) {
  if (_stageId !== 'forest') return null;
  _yarnCaches = _forestYarnPlacements(rng);
  _yarnFound = 0;
  if (state.run) state.run.forestYarnFound = 0;

  const coreGeo = new THREE.SphereGeometry(0.66, 10, 7);
  const loopGeoA = new THREE.TorusGeometry(0.59, 0.052, 5, 16);
  const loopGeoB = loopGeoA.clone();
  loopGeoA.rotateX(Math.PI / 2);
  loopGeoA.rotateZ(0.58);
  loopGeoB.rotateY(Math.PI / 2);
  loopGeoB.rotateZ(-0.48);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xd886b6,
    roughness: 0.84,
    metalness: 0,
    emissive: 0x35121f,
    emissiveIntensity: 0.18,
    flatShading: true,
  });
  const loopMat = new THREE.MeshBasicMaterial({ color: 0xffd7ec });
  _yarnCore = new THREE.InstancedMesh(coreGeo, coreMat, _yarnCaches.length);
  _yarnLoopA = new THREE.InstancedMesh(loopGeoA, loopMat, _yarnCaches.length);
  _yarnLoopB = new THREE.InstancedMesh(loopGeoB, loopMat, _yarnCaches.length);
  _yarnCore.name = 'stageLife_forest_yarnCore';
  _yarnLoopA.name = 'stageLife_forest_yarnLoopA';
  _yarnLoopB.name = 'stageLife_forest_yarnLoopB';
  for (const mesh of [_yarnCore, _yarnLoopA, _yarnLoopB]) {
    mesh.userData.landscapePurpose = 'interactive-lost-yarn';
    mesh.userData.environmentRole = 'interactive';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  _track(coreGeo, loopGeoA, loopGeoB, coreMat, loopMat);
  _updateForestYarnMatrices();
  for (const mesh of [_yarnCore, _yarnLoopA, _yarnLoopB]) mesh.computeBoundingSphere();
  return _yarnCore;
}

function _updateForestYarnMatrices() {
  if (!_yarnCore || !_yarnLoopA || !_yarnLoopB) return;
  for (let i = 0; i < _yarnCaches.length; i++) {
    const cache = _yarnCaches[i];
    if (cache.found) {
      _dummy.position.set(0, -1000, 0);
      _dummy.scale.setScalar(0);
    } else {
      _dummy.position.set(cache.x, 0.76 + Math.sin(_clock * 2.1 + cache.phase) * 0.10, cache.z);
      _dummy.rotation.set(0, cache.yaw + _clock * 0.42, 0);
      _dummy.scale.setScalar(0.96 + Math.sin(_clock * 2.8 + cache.phase) * 0.045);
    }
    _dummy.updateMatrix();
    _yarnCore.setMatrixAt(i, _dummy.matrix);
    _yarnLoopA.setMatrixAt(i, _dummy.matrix);
    _yarnLoopB.setMatrixAt(i, _dummy.matrix);
  }
  _yarnCore.instanceMatrix.needsUpdate = true;
  _yarnLoopA.instanceMatrix.needsUpdate = true;
  _yarnLoopB.instanceMatrix.needsUpdate = true;
}

function _collectForestYarn(cache) {
  if (!cache || cache.found) return;
  cache.found = true;
  _yarnFound++;
  if (state.run) state.run.forestYarnFound = _yarnFound;
  const x = cache.x, z = cache.z;
  import('./xp.js').then(({ dropGem }) => {
    dropGem(new THREE.Vector3(x - 0.45, 0.35, z), 2);
    dropGem(new THREE.Vector3(x + 0.45, 0.35, z), 2);
  }).catch(() => {});
  import('./fx.js').then(({ spawnMagnetSpark }) => {
    for (let i = 0; i < 10; i++) spawnMagnetSpark(x, 0.55, z, i % 2 ? 0xf6d28b : 0xf0a6c2);
  }).catch(() => {});

  let message = `LOST YARN FOUND  ${_yarnFound} / ${_yarnCaches.length}`;
  if (_yarnFound === 3) {
    import('./pickups.js').then(({ spawnHeart }) => spawnHeart(x, z)).catch(() => {});
    message = 'MAOMAO\'S YARN TRAIL — HEART FOUND';
  } else if (_yarnFound === _yarnCaches.length) {
    if (state.hero) state.hero.rerolls = (state.hero.rerolls || 0) + 1;
    import('./pickups.js').then(({ spawnStar }) => spawnStar(x, z)).catch(() => {});
    message = 'ALL LOST YARN FOUND — +1 REROLL';
  }
  import('./ui.js').then(({ showBanner }) => showBanner(message, 2.4, '#f0a6c2')).catch(() => {});
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.42);
  state.fx.shake = Math.max(state.fx.shake || 0, 0.18);
  _updateForestYarnMatrices();
}

function _discoveryGeometry(kind) {
  if (kind === 'bell') {
    const rim = new THREE.TorusGeometry(0.43, 0.065, 6, 16);
    rim.rotateX(Math.PI / 2);
    return _merge([
      _scaledPart(new THREE.ConeGeometry(0.46, 0.72, 9, 1, true), 1, 1, 1, 0, 0.58, 0),
      _scaledPart(rim, 1, 1, 1, 0, 0.22, 0),
      _scaledPart(new THREE.SphereGeometry(0.11, 7, 5), 1, 1, 1, 0, 0.15, 0),
      _scaledPart(new THREE.TorusGeometry(0.13, 0.045, 5, 12), 1, 1, 1, 0, 1.00, 0),
    ]);
  }
  if (kind === 'forgeheart') {
    return _merge([
      _scaledPart(new THREE.DodecahedronGeometry(0.47, 0), 1.05, 1.24, 0.86, 0, 0.70, 0, 0.24),
      _scaledPart(new THREE.TetrahedronGeometry(0.25, 0), 0.72, 1.45, 0.72, -0.34, 0.72, 0, -0.42),
      _scaledPart(new THREE.TetrahedronGeometry(0.23, 0), 0.70, 1.35, 0.70, 0.34, 0.69, 0, 0.42),
      _scaledPart(new THREE.ConeGeometry(0.13, 0.42, 6), 1, 1, 1, 0, 1.28, 0),
    ]);
  }
  if (kind === 'star') {
    return _merge([
      _scaledPart(new THREE.SphereGeometry(0.43, 9, 6), 1, 0.92, 1, 0, 0.70, 0),
      _scaledPart(new THREE.ConeGeometry(0.20, 0.42, 5), 0.9, 1, 0.9, -0.25, 1.12, 0, -0.10),
      _scaledPart(new THREE.ConeGeometry(0.20, 0.42, 5), 0.9, 1, 0.9, 0.25, 1.12, 0, 0.10),
      _scaledPart(new THREE.ConeGeometry(0.15, 0.58, 5), 0.9, 1, 0.9, 0.42, 0.52, 0, -1.05),
    ]);
  }
  return _merge([
    _scaledPart(new THREE.OctahedronGeometry(0.38, 0), 0.74, 1.85, 0.74, 0, 0.72, 0, -0.15),
    _scaledPart(new THREE.OctahedronGeometry(0.25, 0), 0.68, 1.50, 0.68, -0.31, 0.46, 0.08, -0.42),
    _scaledPart(new THREE.OctahedronGeometry(0.22, 0), 0.65, 1.35, 0.65, 0.30, 0.40, 0.06, 0.38),
  ]);
}

function _discoveryGlowGeometry() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2;
    parts.push(_scaledPart(
      new THREE.TetrahedronGeometry(0.10, 0),
      0.8, 1.35, 0.8,
      Math.cos(a) * 0.70, 0.82 + (i % 2) * 0.18, Math.sin(a) * 0.70,
      -a,
    ));
  }
  return _merge(parts);
}

function _buildDiscoveries(parent, rng) {
  _discoveryProfile = DISCOVERY_PROFILES[_stageId] || null;
  if (!_discoveryProfile) return null;
  _discoveryFound = 0;
  _discoveryHintAt = -Infinity;
  _discoveryItems = _discoveryProfile.placements.map((p, index) => ({
    index, x: p[0], z: p[1], found: false,
    yaw: rng() * Math.PI * 2,
    phase: rng() * Math.PI * 2,
  }));
  if (state.run) {
    state.run.stageDiscovery = {
      id: _discoveryProfile.id,
      found: 0,
      total: _discoveryItems.length,
    };
    if (_stageId === 'cave') state.run.caveEchoCredits = 0;
  }

  const coreGeo = _discoveryGeometry(_discoveryProfile.kind);
  const glowGeo = _discoveryGlowGeometry();
  const coreMat = new THREE.MeshStandardMaterial({
    color: _discoveryProfile.color,
    emissive: _discoveryProfile.accent,
    emissiveIntensity: 0.45,
    roughness: 0.48,
    metalness: _stageId === 'cinder' ? 0.18 : 0.06,
    flatShading: true,
  });
  const glowMat = new THREE.MeshBasicMaterial({
    color: _discoveryProfile.accent,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _discoveryCore = new THREE.InstancedMesh(coreGeo, coreMat, _discoveryItems.length);
  _discoveryGlow = new THREE.InstancedMesh(glowGeo, glowMat, _discoveryItems.length);
  _discoveryCore.name = `stageLife_${_stageId}_discoveryCore`;
  _discoveryGlow.name = `stageLife_${_stageId}_discoveryGlow`;
  for (const mesh of [_discoveryCore, _discoveryGlow]) {
    mesh.userData.landscapePurpose = `interactive-${_discoveryProfile.id}`;
    mesh.userData.environmentRole = 'interactive';
    mesh.userData.interaction = _discoveryProfile.trigger;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  _track(coreGeo, glowGeo, coreMat, glowMat);
  _updateDiscoveryMatrices();
  for (const mesh of [_discoveryCore, _discoveryGlow]) mesh.computeBoundingSphere();
  return _discoveryCore;
}

function _updateDiscoveryMatrices() {
  if (!_discoveryCore || !_discoveryGlow) return;
  for (let i = 0; i < _discoveryItems.length; i++) {
    const item = _discoveryItems[i];
    if (item.found) {
      _dummy.position.set(0, -1000, 0);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      _discoveryCore.setMatrixAt(i, _dummy.matrix);
      _discoveryGlow.setMatrixAt(i, _dummy.matrix);
      continue;
    }
    const bob = Math.sin(_clock * 2.2 + item.phase) * 0.12;
    _dummy.position.set(item.x, 0.12 + bob, item.z);
    _dummy.rotation.set(0, item.yaw + _clock * 0.34, 0);
    _dummy.scale.setScalar(1.18 + Math.sin(_clock * 2.8 + item.phase) * 0.055);
    _dummy.updateMatrix();
    _discoveryCore.setMatrixAt(i, _dummy.matrix);

    _dummy.position.set(item.x, 0.12 + bob, item.z);
    _dummy.rotation.set(0.12, -item.yaw - _clock * 1.25, -0.08);
    _dummy.scale.setScalar(1.10 + Math.sin(_clock * 3.4 + item.phase) * 0.09);
    _dummy.updateMatrix();
    _discoveryGlow.setMatrixAt(i, _dummy.matrix);
  }
  _discoveryCore.instanceMatrix.needsUpdate = true;
  _discoveryGlow.instanceMatrix.needsUpdate = true;
}

function _discoveryBanner(message, duration = 2.3) {
  const color = _discoveryProfile
    ? `#${_discoveryProfile.rewardColor.toString(16).padStart(6, '0')}`
    : '#ffffff';
  import('./ui.js').then(({ showBanner }) => showBanner(message, duration, color)).catch(() => {});
}

function _collectDiscovery(item) {
  if (!item || item.found || !_discoveryProfile) return;
  item.found = true;
  _discoveryFound++;
  const x = item.x;
  const z = item.z;
  if (state.run) {
    state.run.stageDiscovery = {
      id: _discoveryProfile.id,
      found: _discoveryFound,
      total: _discoveryItems.length,
    };
  }

  import('./xp.js').then(({ dropGem }) => {
    dropGem(new THREE.Vector3(x - 0.42, 0.35, z), 2);
    dropGem(new THREE.Vector3(x + 0.42, 0.35, z), 2);
  }).catch(() => {});
  import('./fx.js').then(({ spawnMagnetSpark }) => {
    for (let i = 0; i < 12; i++) {
      spawnMagnetSpark(x, 0.65 + (i % 3) * 0.12, z, i % 2 ? _discoveryProfile.accent : _discoveryProfile.color);
    }
  }).catch(() => {});

  let message = `${_discoveryProfile.label} FOUND  ${_discoveryFound} / ${_discoveryItems.length}`;
  if (_stageId === 'twilight' && state.run) {
    const current = state.run.fountainSpeedBuff;
    const currentActive = current && current.expiresAt > state.time.game;
    state.run.fountainSpeedBuff = {
      mul: Math.max(currentActive ? current.mul : 1, 1.28),
      expiresAt: Math.max(currentActive ? current.expiresAt : 0, state.time.game + 3.5),
    };
    message = `MOONSTEP AWAKENED  ${_discoveryFound} / ${_discoveryItems.length}`;
  } else if (_stageId === 'cinder') {
    const awakened = activateNearestBallista(x, z, 16);
    if (awakened) {
      message = `FORGEHEART SHATTERED — BALLISTA AWAKENS  ${_discoveryFound} / ${_discoveryItems.length}`;
    } else {
      import('./pickups.js').then(({ spawnBomb }) => spawnBomb(x, z)).catch(() => {});
      message = `FORGEHEART OVERFLOW — BOMB FORGED  ${_discoveryFound} / ${_discoveryItems.length}`;
    }
  } else if (_stageId === 'void') {
    rechargeVoidPads(2.5);
    message = `STAR KITTEN RESCUED — NEXT PAD OVERCHARGED  ${_discoveryFound} / ${_discoveryItems.length}`;
  } else if (_stageId === 'cave' && state.run) {
    state.run.caveEchoCredits = (state.run.caveEchoCredits || 0) + 8;
    message = `ECHO CRYSTAL RESONATES — VAULT -8 KILLS  ${_discoveryFound} / ${_discoveryItems.length}`;
  }

  if (_discoveryFound === 3) {
    import('./pickups.js').then(({ spawnHeart, spawnBomb, spawnStar }) => {
      if (_stageId === 'cinder') spawnBomb(x, z);
      else if (_stageId === 'void') spawnStar(x, z);
      else spawnHeart(x, z);
    }).catch(() => {});
  }
  if (_discoveryFound === _discoveryItems.length) {
    if (state.hero) state.hero.rerolls = (state.hero.rerolls || 0) + 1;
    import('./pickups.js').then(({ spawnStar }) => spawnStar(x, z)).catch(() => {});
    const finales = {
      twilight: 'MOON CHOIR COMPLETE — +1 REROLL',
      cinder: 'ALL FORGEHEARTS LIT — +1 REROLL',
      void: 'STAR-KITTEN CONSTELLATION COMPLETE — +1 REROLL',
      cave: 'CRYSTAL CHORUS COMPLETE — VAULT SEAL FRACTURED',
    };
    message = finales[_stageId] || message;
  }
  _discoveryBanner(message, _discoveryFound === _discoveryItems.length ? 3.0 : 2.3);
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.46);
  state.fx.shake = Math.max(state.fx.shake || 0, 0.16);
  _updateDiscoveryMatrices();
}

function _tickDiscoveries(hx, hz) {
  if (!_discoveryProfile || !_discoveryItems.length || state.mode !== 'run') return;
  const trigger = _discoveryProfile.trigger;
  const dashing = !!(state.hero && state.time.real < (state.hero.dashUntil || 0));
  const interact = !!(state.input && state.input.interactPressed);
  for (const item of _discoveryItems) {
    if (item.found) continue;
    const dx = item.x - hx;
    const dz = item.z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 2.0 * 2.0) continue;
    if (trigger === 'dash' && !dashing) {
      if (_clock >= _discoveryHintAt) {
        _discoveryHintAt = _clock + 5;
        _discoveryBanner('DASH THROUGH THE FORGEHEART TO AWAKEN A BALLISTA', 2.0);
      }
      break;
    }
    const coarsePointer = trigger === 'interact'
      && typeof window !== 'undefined'
      && (((window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
        || ('ontouchstart' in window)
        || /[?&]touch=1/.test(window.location && window.location.search || '')));
    if (trigger === 'interact' && !interact && !coarsePointer) {
      if (_clock >= _discoveryHintAt) {
        _discoveryHintAt = _clock + 5;
        _discoveryBanner('PRESS E / B — RESONATE ECHO CRYSTAL', 2.0);
      }
      break;
    }
    _collectDiscovery(item);
    break;
  }
  _updateDiscoveryMatrices();
}

function _buildAmbientLife(parent, profile, rng) {
  const geo = _lifeGeometry();
  const loader = new THREE.TextureLoader();
  const ambientUrl = AMBIENT_TEXTURES[_stageId] || AMBIENT_TEXTURES.forest;
  let mat = null;
  const map = loader.load(
    ambientUrl,
    tex => { tex.needsUpdate = true; },
    undefined,
    () => {
      if (ambientUrl === AMBIENT_TEXTURES.forest) return;
      loader.load(AMBIENT_TEXTURES.forest, (fallback) => {
        fallback.colorSpace = THREE.SRGBColorSpace;
        if (mat && _group === parent) {
          const failed = mat.map;
          mat.map = fallback;
          mat.needsUpdate = true;
          try { failed && failed.dispose(); } catch (_) {}
          _track(fallback);
        } else {
          try { fallback.dispose(); } catch (_) {}
        }
      });
    },
  );
  map.colorSpace = THREE.SRGBColorSpace;
  mat = new THREE.MeshBasicMaterial({
    color: _stageId === 'forest' ? profile.accent : 0xffffff,
    map,
    transparent: true,
    opacity: 0.92,
    alphaTest: 0.10,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, LIFE_CAP);
  mesh.name = `stageLife_${_stageId}_ambient`;
  mesh.userData.landscapePurpose = 'ambient-life';
  mesh.userData.ambientKind = {
    forest: 'butterflies',
    twilight: 'moon-moths',
    cinder: 'ember-moths',
    void: 'star-kitten-wisps',
    cave: 'glowbats',
  }[_stageId] || 'ambient-life';
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _lifeX = new Float32Array(LIFE_CAP);
  _lifeZ = new Float32Array(LIFE_CAP);
  _lifePhase = new Float32Array(LIFE_CAP);
  _lifeSpeed = new Float32Array(LIFE_CAP);
  for (let i = 0; i < LIFE_CAP; i++) {
    const a = rng() * Math.PI * 2;
    const r = 4 + Math.sqrt(rng()) * 23;
    _lifeX[i] = Math.cos(a) * r;
    _lifeZ[i] = Math.sin(a) * r;
    _lifePhase[i] = rng() * Math.PI * 2;
    _lifeSpeed[i] = 0.28 + rng() * 0.46;
    _dummy.scale.set(0, 0, 0);
    _dummy.updateMatrix();
    mesh.setMatrixAt(i, _dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  parent.add(mesh);
  _track(geo, mat, map);
  return mesh;
}

function _syncShardGrowth() {
  if (!_growth || !_profile) return;
  const forestTrials = _stageId === 'forest' && state.run && state.run.forestPortalTrials;
  const total = forestTrials ? Math.max(1, forestTrials.total || 6) : 5;
  const progress = Math.max(0, Math.min(total, forestTrials
    ? forestTrials.cleared || 0
    : state.run && state.run.portalShards || 0));
  const progressKey = progress + total * 100;
  if (progressKey === _lastShardCount) return;
  _lastShardCount = progressKey;
  const ratio = progress / total;
  const fraction = Math.min(1, _profile.initial + ratio * (1 - _profile.initial));
  _growth.count = Math.max(1, Math.floor(_growthTotal * fraction));
  if (_growth.material) _growth.material.emissiveIntensity = 0.10 + ratio * 0.275;
  if (_life) _life.count = Math.min(LIFE_CAP, 18 + Math.round(ratio * 15));
}

export function loadStageLife(stageId, scene) {
  disposeStageLife();
  const profile = PROFILES[stageId];
  if (!scene || !profile) return null;
  _stageId = stageId;
  _profile = profile;
  const rng = _rng((_runSeed(stageId) ^ profile.seed) >>> 0);
  const group = new THREE.Group();
  group.name = '__stageLife';
  group.userData.stageId = stageId;
  _group = group;
  _growth = _buildGrowth(group, profile, rng);
  _paws = _buildPawTrails(group, profile);
  _life = _buildAmbientLife(group, profile, rng);
  _buildForestYarn(group, rng);
  _buildDiscoveries(group, rng);
  group.userData.counts = {
    growth: _growthTotal,
    paws: _paws ? _paws.count : 0,
    ambient: LIFE_CAP,
    yarn: _yarnCaches.length,
    discoveries: _discoveryItems.length,
    discoveryKind: _discoveryProfile ? _discoveryProfile.id : null,
    drawBatches: _stageId === 'forest' ? 6 : 5,
  };
  scene.add(group);
  _syncShardGrowth();
  return group;
}

export function tickStageLife(dt) {
  if (!_group || !_life || !_profile) return;
  syncStageLifeVisibility();
  const overworldVisible = _group.visible;
  if (!overworldVisible || !state.hero || !state.hero.pos) return;
  _syncShardGrowth();
  const safeDt = Math.min(0.05, Math.max(0, dt || 0));
  _clock += safeDt;
  _lifeAcc += safeDt;
  // Discovery verbs must sample every frame. In particular, E/B is a one-frame
  // edge cleared at the end of main's tick; checking it only on the 20 Hz
  // ambient update would discard most legitimate Cave interactions at 60fps.
  const hx = state.hero.pos.x;
  const hz = state.hero.pos.z;
  _tickDiscoveries(hx, hz);
  if (_lifeAcc < 0.05) return;
  const stepDt = _lifeAcc;
  _lifeAcc = 0;
  if (_stageId === 'forest' && state.mode === 'run' && _yarnCaches.length) {
    for (const cache of _yarnCaches) {
      if (cache.found) continue;
      const dx = cache.x - hx;
      const dz = cache.z - hz;
      if (dx * dx + dz * dz <= 1.75 * 1.75) {
        _collectForestYarn(cache);
        break;
      }
    }
    _updateForestYarnMatrices();
  }
  if (!_lifeInitialized) {
    for (let i = 0; i < LIFE_CAP; i++) { _lifeX[i] += hx; _lifeZ[i] += hz; }
    _lifeInitialized = true;
  }
  const radius = 28;
  const radius2 = radius * radius;
  for (let i = 0; i < _life.count; i++) {
    const phase = _lifePhase[i];
    const speed = _lifeSpeed[i];
    _lifeX[i] += Math.cos(_clock * speed + phase) * stepDt * 0.52;
    _lifeZ[i] += Math.sin(_clock * speed * 0.83 + phase) * stepDt * 0.52;
    let dx = _lifeX[i] - hx;
    let dz = _lifeZ[i] - hz;
    if (dx * dx + dz * dz > radius2) {
      _lifeX[i] = hx - dx * 0.82;
      _lifeZ[i] = hz - dz * 0.82;
      dx = _lifeX[i] - hx;
      dz = _lifeZ[i] - hz;
    }
    const flap = 0.56 + Math.abs(Math.sin(_clock * 8.5 + phase)) * 0.64;
    _dummy.position.set(_lifeX[i], 0.75 + Math.sin(_clock * 1.7 + phase) * 0.32, _lifeZ[i]);
    _dummy.rotation.set(0, Math.atan2(dx, dz) + _clock * 0.08, 0);
    _dummy.scale.set(flap, 1, 0.82 + Math.sin(_clock * 2.1 + phase) * 0.12);
    _dummy.updateMatrix();
    _life.setMatrixAt(i, _dummy.matrix);
  }
  _life.instanceMatrix.needsUpdate = true;
}

/** Called before every mode branch so scene-root life cannot bleed modes. */
export function syncStageLifeVisibility() {
  if (_group) _group.visible = state.mode === 'run';
}

export function disposeStageLife() {
  if (_group && _group.parent) _group.parent.remove(_group);
  if (_group) {
    _group.traverse((o) => {
      if (o.isInstancedMesh && o.dispose) {
        try { o.dispose(); } catch (_) {}
      }
    });
  }
  for (const item of _resources) {
    try { if (item && item.dispose) item.dispose(); } catch (_) {}
  }
  _resources = [];
  _group = null;
  _growth = null;
  _paws = null;
  _life = null;
  _yarnCore = null;
  _yarnLoopA = null;
  _yarnLoopB = null;
  _yarnCaches = [];
  _yarnFound = 0;
  _discoveryCore = null;
  _discoveryGlow = null;
  _discoveryItems = [];
  _discoveryFound = 0;
  _discoveryProfile = null;
  _discoveryHintAt = -Infinity;
  _profile = null;
  _stageId = null;
  _growthTotal = 0;
  _lastShardCount = -1;
  _lifeInitialized = false;
  _lifeAcc = 0;
  _clock = 0;
  _lifeX = _lifeZ = _lifePhase = _lifeSpeed = null;
}

export function _debugStageLife() {
  return {
    mounted: !!_group,
    stageId: _stageId,
    seed: state.run && state.run.environmentSeed,
    growthVisible: _growth ? _growth.count : 0,
    growthTotal: _growthTotal,
    paws: _paws ? _paws.count : 0,
    ambient: _life ? _life.count : 0,
    yarn: _yarnCaches.length,
    yarnFound: _yarnFound,
    firstYarn: _yarnCaches.length
      ? { x: _yarnCaches[0].x, z: _yarnCaches[0].z, found: _yarnCaches[0].found }
      : null,
    discoveries: _discoveryItems.length,
    discoveryFound: _discoveryFound,
    discoveryKind: _discoveryProfile ? _discoveryProfile.id : null,
    discoveryTrigger: _discoveryProfile ? _discoveryProfile.trigger : null,
    firstDiscovery: _discoveryItems.length
      ? {
          x: _discoveryItems[0].x,
          z: _discoveryItems[0].z,
          found: _discoveryItems[0].found,
        }
      : null,
    shards: _lastShardCount,
  };
}
