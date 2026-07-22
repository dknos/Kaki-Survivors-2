/**
 * Map secrets — one stage-authored breakable family per overworld biome.
 *
 * Static decorative props that the player can smash for loot. Intentionally
 * NOT in the enemy pool so weapons don't auto-DPS them; they break only on
 * explicit interactions:
 *   - Hero dash overlap          → instant break
 *   - Bomb pickup AoE            → instant break
 *
 * Forest uses fallen logs; Twilight moon urns, Cinder ember ore, Void star
 * crystals, and Cave spore pods use the same one-draw InstancedMesh budget.
 * Each secret drops a gem and occasionally a heart/chest. Sparks + bloom sell
 * the moment, while six and twelve finds guarantee exploration milestones.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { state } from './state.js';
import {
  FOREST_PORTAL_POSITIONS,
  FOREST_ROOMS,
  getForestTravelAnchors,
} from './forestRooms.js';
import { isPointOnTerrainBridge, sampleStageTerrain } from './stageTerrainLayout.js';
import { isPointInStageExplorationKeepout } from './stageExplorationLayout.js';

const LOG_CAP = 42;
const OPEN_STAGE_SECRET_COUNT = 26;
const FOREST_LOGS_PER_ROOM = 5;
const SPAWN_RING_MIN = 12;
const SECRET_CHEST_CHANCE = 0.08; // ~8% per log for the "hidden grove" feel
const HEART_CHANCE = 0.30;

let _inst = null;            // InstancedMesh
let _logs = [];              // { x, z, alive, idx }
let _appearanceStage = null;
let _secretKind = 'fallen-log';
let _secretFxColor = 0xc8884a;

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();

export function initDestructibles(scene) {
  const { geo, mat, kind, fxColor } = _makeStageAppearance('forest');
  _appearanceStage = 'forest';
  _secretKind = kind;
  _secretFxColor = fxColor;
  _inst = new THREE.InstancedMesh(geo, mat, LOG_CAP);
  _inst.name = '__dashSmashSecrets';
  _inst.userData.environmentRole = 'destructible';
  _inst.userData.landscapePurpose = 'dash-smash-secret';
  _inst.userData.secretKind = kind;
  _inst.castShadow = false;
  _inst.receiveShadow = false;
  _inst.frustumCulled = false;
  scene.add(_inst);
  resetDestructibles();
}

/** Scatter logs around the spawn ring. Called on run start + restart. */
export function resetDestructibles() {
  if (!_inst) return;
  _logs.length = 0;
  const stageId = (state.run && state.run.stage && state.run.stage.id) || 'forest';
  // Kaki Land's authored islands do not have an open-arena floor for the
  // normal radial secret scatter. Keep the instanced pool empty rather than
  // placing fallback logs in open sky.
  if (stageId === 'kakiland') {
    if (state.run) state.run.stageSecretsBroken = 0;
    _inst.count = 0;
    _inst.visible = false;
    _inst.instanceMatrix.needsUpdate = true;
    return;
  }
  _setStageAppearance(stageId);
  if (state.run) state.run.stageSecretsBroken = 0;
  if (stageId === 'forest') _placeForestLogs();
  else _placeOpenStageSecrets(stageId);
  _inst.instanceMatrix.needsUpdate = true;
  _inst.count = _logs.length;
  syncDestructiblesVisibility();
}

function _part(geo, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
  geo.scale(sx, sy, sz);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

function _mergeParts(parts) {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (merged) {
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
  }
  return merged || new THREE.DodecahedronGeometry(0.5, 0);
}

function _makeStageAppearance(stageId) {
  let geo;
  let kind;
  let color;
  let emissive = 0x000000;
  let emissiveIntensity = 0;
  let fxColor;
  if (stageId === 'twilight') {
    const rim = new THREE.TorusGeometry(0.37, 0.055, 6, 14);
    rim.rotateX(Math.PI / 2);
    geo = _mergeParts([
      _part(new THREE.CylinderGeometry(0.30, 0.42, 0.72, 9), 1, 1, 1, 0, 0.36, 0),
      _part(new THREE.SphereGeometry(0.40, 9, 6), 1, 0.76, 1, 0, 0.66, 0),
      _part(rim, 1, 1, 1, 0, 0.97, 0),
      _part(new THREE.SphereGeometry(0.10, 6, 4), 1, 1, 1, 0, 1.08, 0),
    ]);
    kind = 'moon-urn'; color = 0x75658f; emissive = 0x342750; emissiveIntensity = 0.22; fxColor = 0xc6b7ff;
  } else if (stageId === 'cinder') {
    geo = _mergeParts([
      _part(new THREE.DodecahedronGeometry(0.48, 0), 1.20, 0.76, 0.92, 0, 0.43, 0, 0, 0.18, 0),
      _part(new THREE.TetrahedronGeometry(0.25, 0), 0.8, 1.3, 0.8, -0.38, 0.45, 0.06, 0, -0.35, 0),
      _part(new THREE.TetrahedronGeometry(0.21, 0), 0.8, 1.2, 0.8, 0.38, 0.39, -0.04, 0, 0.35, 0),
    ]);
    kind = 'ember-ore'; color = 0x5d2616; emissive = 0xff571a; emissiveIntensity = 0.34; fxColor = 0xff8a3d;
  } else if (stageId === 'void') {
    geo = _mergeParts([
      _part(new THREE.OctahedronGeometry(0.38, 0), 0.72, 1.85, 0.72, 0, 0.67, 0, 0, -0.16, 0),
      _part(new THREE.OctahedronGeometry(0.25, 0), 0.68, 1.42, 0.68, -0.33, 0.41, 0.05, 0, -0.42, 0),
      _part(new THREE.OctahedronGeometry(0.21, 0), 0.64, 1.32, 0.64, 0.31, 0.36, 0.05, 0, 0.38, 0),
    ]);
    kind = 'star-crystal'; color = 0x32647a; emissive = 0x5cecff; emissiveIntensity = 0.38; fxColor = 0x77dce8;
  } else if (stageId === 'cave') {
    geo = _mergeParts([
      _part(new THREE.SphereGeometry(0.46, 9, 6), 1, 0.72, 1, 0, 0.38, 0),
      _part(new THREE.SphereGeometry(0.52, 9, 5), 1.18, 0.34, 1.12, 0, 0.75, 0),
      _part(new THREE.CylinderGeometry(0.12, 0.17, 0.44, 7), 1, 1, 1, 0, 0.28, 0),
    ]);
    kind = 'spore-pod'; color = 0x476d61; emissive = 0x72d9c6; emissiveIntensity = 0.28; fxColor = 0x82dfcf;
  } else {
    geo = new THREE.CylinderGeometry(0.38, 0.46, 1.65, 10);
    geo.rotateZ(Math.PI / 2);
    geo.translate(0, 0.46, 0);
    kind = 'fallen-log'; color = 0x5b3d22; fxColor = 0xc8884a;
  }
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    roughness: stageId === 'void' ? 0.48 : 0.92,
    metalness: stageId === 'cinder' ? 0.12 : 0,
    flatShading: stageId !== 'forest',
  });
  return { geo, mat, kind, fxColor };
}

function _setStageAppearance(stageId) {
  if (!_inst || stageId === _appearanceStage) return;
  const oldGeo = _inst.geometry;
  const oldMat = _inst.material;
  const next = _makeStageAppearance(stageId);
  _inst.geometry = next.geo;
  _inst.material = next.mat;
  _appearanceStage = stageId;
  _secretKind = next.kind;
  _secretFxColor = next.fxColor;
  _inst.userData.secretKind = next.kind;
  try { oldGeo && oldGeo.dispose(); } catch (_) {}
  try { oldMat && oldMat.dispose(); } catch (_) {}
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

function _writeLog(x, z, rot, scale = 1, roomId = null) {
  if (_logs.length >= LOG_CAP) return;
  const i = _logs.length;
  _q.setFromAxisAngle(_v.set(0, 1, 0), rot);
  _s.set(scale, 0.9 + scale * 0.1, scale);
  _v.set(x, 0, z);
  _m4.compose(_v, _q, _s);
  _inst.setMatrixAt(i, _m4);
  _logs.push({
    x, z, alive: true, idx: i, roomId,
    stageId: _appearanceStage,
    kind: _secretKind,
    fxColor: _secretFxColor,
  });
}

function _placeOpenStageSecrets(stageId) {
  const stageHash = Array.from(stageId).reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const seed = (((state.run && state.run.environmentSeed) || 0x51EC7E) ^ stageHash ^ 0xD45A) >>> 0;
  const rand = _rng(seed);
  let placed = 0;
  for (let attempt = 0; attempt < 260 && placed < OPEN_STAGE_SECRET_COUNT; attempt++) {
    const wedge = placed / OPEN_STAGE_SECRET_COUNT * Math.PI * 2;
    const angle = wedge + (rand() - 0.5) * 0.34;
    const r = SPAWN_RING_MIN + 4 + rand() * (98 - SPAWN_RING_MIN - 4);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    if (x * x + z * z < 13 * 13) continue;
    if (sampleStageTerrain(stageId, x, z).active) continue;
    if (isPointOnTerrainBridge(stageId, x, z, 3.0)) continue;
    if (isPointInStageExplorationKeepout(stageId, x, z, 1.2)) continue;
    let separated = true;
    for (const other of _logs) {
      const dx = other.x - x;
      const dz = other.z - z;
      if (dx * dx + dz * dz < 7.5 * 7.5) { separated = false; break; }
    }
    if (!separated) continue;
    const sector = Math.floor(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 3));
    _writeLog(x, z, rand() * Math.PI * 2, 0.82 + rand() * 0.42, `${stageId}-sector-${sector}`);
    placed++;
  }
}

function _forestLogSpotAllowed(room, x, z) {
  const dcx = x - room.center.x;
  const dcz = z - room.center.z;
  if (dcx * dcx + dcz * dcz < 12 * 12) return false;
  if (sampleStageTerrain('forest', x, z).active) return false;
  if (room.isHub) {
    const ldx = x - 1, ldz = z + 28;
    if (ldx * ldx + ldz * ldz < 11 * 11) return false;
    for (const portal of Object.values(FOREST_PORTAL_POSITIONS)) {
      const dx = x - portal.x, dz = z - portal.z;
      if (dx * dx + dz * dz < 6 * 6) return false;
    }
  } else {
    const anchors = getForestTravelAnchors(room.id);
    if (anchors) {
      for (const anchor of [anchors.entry, anchors.return]) {
        const dx = x - anchor.x, dz = z - anchor.z;
        if (dx * dx + dz * dz < 6 * 6) return false;
      }
    }
  }
  return true;
}

function _placeForestLogs() {
  const seed = ((state.run && state.run.environmentSeed) || 0xF012E57) ^ 0x10A65;
  const rand = _rng(seed >>> 0);
  for (const room of Object.values(FOREST_ROOMS)) {
    const halfX = (room.bounds.maxX - room.bounds.minX) * 0.5;
    const halfZ = (room.bounds.maxZ - room.bounds.minZ) * 0.5;
    let placed = 0;
    for (let attempt = 0; attempt < 80 && placed < FOREST_LOGS_PER_ROOM; attempt++) {
      const angle = rand() * Math.PI * 2;
      const edge = 0.57 + rand() * 0.30;
      const x = room.center.x + Math.cos(angle) * halfX * edge;
      const z = room.center.z + Math.sin(angle) * halfZ * edge;
      if (!_forestLogSpotAllowed(room, x, z)) continue;
      _writeLog(x, z, rand() * Math.PI * 2, 0.82 + rand() * 0.42, room.id);
      placed++;
    }
  }
}

/** Hide an instance by collapsing its matrix to zero scale at far-away pos. */
function _hideInstance(i) {
  _q.identity();
  _s.set(0, 0, 0);
  _v.set(0, -1000, 0);
  _m4.compose(_v, _q, _s);
  _inst.setMatrixAt(i, _m4);
  _inst.instanceMatrix.needsUpdate = true;
}

/**
 * Smash any log within `radius` of (x, z). Returns the number broken so the
 * caller can decide on extra feedback (kill ring, etc.).
 */
export function smashLogsInRadius(x, z, radius) {
  if (state.mode !== 'run') return 0;
  if (!_logs.length) return 0;
  const r2 = radius * radius;
  let broken = 0;
  for (const log of _logs) {
    if (!log.alive) continue;
    const dx = log.x - x, dz = log.z - z;
    if (dx * dx + dz * dz <= r2) {
      log.alive = false;
      broken++;
      _breakLog(log);
    }
  }
  return broken;
}

function _breakLog(log) {
  _hideInstance(log.idx);
  // Drop a gem + maybe a heart + rare chest. Dynamic-import to dodge cycles.
  import('./xp.js').then(({ dropGem }) => dropGem(new THREE.Vector3(log.x, 0, log.z), 1));
  if (Math.random() < HEART_CHANCE) {
    import('./pickups.js').then(({ spawnHeart }) => spawnHeart(log.x, log.z));
  }
  if (Math.random() < SECRET_CHEST_CHANCE) {
    // Forest stage-gate (slot-machine soft-lock vs forest-v2 rooms) lives
    // inside spawnChest — one choke point covers every spawner.
    import('./chest.js').then(({ spawnChest }) => spawnChest(log.x, log.z));
  }
  // Spark burst matches the authored secret family, not a generic amber puff.
  import('./fx.js').then(({ spawnMagnetSpark, spawnKillRing }) => {
    spawnKillRing(log.x, log.z, false);
    for (let i = 0; i < 7; i++) spawnMagnetSpark(log.x, 0.3, log.z, log.fxColor || 0xc8884a);
  });
  if (state.run) {
    state.run.stageSecretsBroken = (state.run.stageSecretsBroken || 0) + 1;
    const found = state.run.stageSecretsBroken;
    if (found === 6 || found === 12) {
      import('./pickups.js').then(({ spawnHeart, spawnStar }) => {
        if (found === 6) spawnHeart(log.x, log.z);
        else spawnStar(log.x, log.z);
      }).catch(() => {});
      const label = String(log.kind || 'secret').replace(/-/g, ' ').toUpperCase();
      import('./ui.js').then(({ showBanner }) => showBanner(
        `${label} TRAIL  ${found} FOUND — ${found === 6 ? 'HEART' : 'STAR'} REWARD`,
        2.4,
        `#${(log.fxColor || 0xc8884a).toString(16).padStart(6, '0')}`,
      )).catch(() => {});
    }
  }
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.25);
}

/**
 * Sample-side helper: if the hero is currently dashing, smash logs within
 * the dash damage radius. Cheap O(LOG_COUNT) check; called once per dash tick
 * from hero.js's existing dash hit-resolution block.
 */
export function smashLogsAtHero(radius) {
  const h = state.hero && state.hero.pos;
  if (!h) return 0;
  return smashLogsInRadius(h.x, h.z, radius);
}

/** Called before every mode branch so scene-root secrets never bleed modes. */
export function syncDestructiblesVisibility() {
  if (_inst) {
    const stageId = state.run && state.run.stage && state.run.stage.id;
    _inst.visible = state.mode === 'run' && stageId !== 'kakiland';
  }
}

export function _debugDestructibles() {
  const rooms = new Set();
  let placementHash = 2166136261 >>> 0;
  for (const log of _logs) if (log.roomId) rooms.add(log.roomId);
  for (const log of _logs) {
    placementHash ^= Math.round(log.x * 1000); placementHash = Math.imul(placementHash, 16777619) >>> 0;
    placementHash ^= Math.round(log.z * 1000); placementHash = Math.imul(placementHash, 16777619) >>> 0;
  }
  return {
    count: _logs.length,
    alive: _logs.reduce((n, log) => n + (log.alive ? 1 : 0), 0),
    roomCount: rooms.size,
    purpose: _inst && _inst.userData && _inst.userData.landscapePurpose,
    stageId: _appearanceStage,
    secretKind: _secretKind,
    placementHash,
    locations: _logs.map((log) => ({ x: log.x, z: log.z, alive: log.alive, kind: log.kind })),
  };
}
