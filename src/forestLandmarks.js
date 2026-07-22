/**
 * Forest Landmarks — VS-style interactable density for the Forest stage.
 * Ships 2 interactive landmark types as a single pre-pooled module:
 *
 *   1. shrine_moss   — cat-eared stone stele + sculpted moss + gold paw beacon.
 *                      AABB r=0.9 trigger; one-shot
 *                      per instance. Effect: state.run._dmgGlobalBonus += 0.05
 *                      (composed in enemies.js damage hot path). Compact
 *                      "MOSS BLESSING · +5% DMG" feedback.
 *
 *   2. altar_statue  — pedestal + tilted broken bone pillar fragment + faint
 *                      amber base glow when undiscovered. AABB r=0.9 trigger;
 *                      one-shot per instance. Effect: hero.maxHp += 10 and
 *                      heal to full. Floaty +10 heal.
 * Architecture:
 *   - One InstancedMesh per visual component (3 shrine pools, 3 altar pools)
 *     so per-instance state can be cheaply written via setMatrixAt + zero-scale
 *     to "hide" a triggered landmark's beacon/glow without per-spawn alloc.
 *   - InstancedMesh caps: 64 shrines and 32 altars, pre-allocated at load.
 *   - Triggered/visible state lives in parallel typed arrays per type.
 *   - Pulse FX (telegraph rings on trigger) live in a pre-pooled RingGeometry
 *     mesh array; zero allocation in the hot path. tickForestLandmarks fades
 *     active pulses each frame.
 *   - BLOOM_LAYER is reserved for short trigger pulses and altar glow. Shrine
 *     bodies stay opaque/non-bloom so repeated landmarks do not become rings.
 *
 * Palette discipline (no new hex constants):
 *   - slot-1 #c7b89a — muted bone (altar pillar fragment)
 *   - slot-2 #4a7a4a — forest green (shrine moss)
 *   - slot-3 #6b4f3a — earth brown (altar pedestal)
 *   - slot-5 #e89c4a — amber (altar base glow + telegraph burst)
 *   - slot-6 #d9a648 — gold (shrine paw beacon + telegraph pulse)
 *
 * Public API:
 *   loadForestLandmarks(scene, state, rng)
 *   tickForestLandmarks(dt, state)
 *   disposeForestLandmarks(scene)
 *   getLandmarkPositions() — read-only snapshot of placed landmark XZ centers
 *     (shrines + altars flattened). Used by sibling modules
 *     (e.g. forestCoffins.js) that need to keep-out around placed landmarks.
 *     Returns [] before loadForestLandmarks runs, or after dispose.
 *
 * Constraints honored:
 *   - Static imports only (no dynamic import in hot path).
 *   - Pre-pooled InstancedMesh — zero per-spawn allocation in tick.
 *   - Self-gating: triggered[i]=true set BEFORE effect dispatch.
 *   - RNG: dedicated _mulberry32 seed (0xC0FFE8) — non-overlapping with the
 *     existing forest decor seeds (0xC0FFE2..0xC0FFE7).
 *   - Bounds keep-out: rejects placements within (1,-28) r=10 (Lockdown +
 *     2u margin), (-1, 19/22/25) r=3.6 each (Trap Corridor + margin), and
 *     within r=2 of any FOREST_PORTAL_POSITIONS post.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { FOREST_ROOMS, FOREST_PORTAL_POSITIONS } from './forestRooms.js';
import { spawnHealNumber, spawnHeroTextFloater } from './damageNumbers.js';
import { sfx } from './audio.js';
import { createRuneRing } from './fx/runeRing.js';

// ── PHASE 3 P3B — forest stone texture (lazy luminance map; assets/textures/README.md) ──
let _stoneTex = null;
function _stoneTexture() {
  if (_stoneTex) return _stoneTex;
  _stoneTex = new THREE.TextureLoader().load('assets/textures/forest_stone_512.png');
  _stoneTex.wrapS = _stoneTex.wrapT = THREE.RepeatWrapping;
  _stoneTex.repeat.set(1, 1);
  _stoneTex.colorSpace = THREE.SRGBColorSpace;
  _stoneTex.anisotropy = 8;
  return _stoneTex;
}

// ── caps ─────────────────────────────────────────────────────────────────────
const CAP_SHRINES = 64;
const CAP_ALTARS  = 32;
const CAP_PULSES  = 16; // active telegraph rings on screen simultaneously

// ── budgets (per room defaults; override via FOREST_ROOMS[id].landmarkBudget) ─
const DEFAULT_BUDGET = { shrines: 5, altars: 2 };

// ── trigger radius (AABB-ish circular gate) ─────────────────────────────────
const TRIGGER_R  = 0.9;
const TRIGGER_R2 = TRIGGER_R * TRIGGER_R;

// ── pulse FX tunables ────────────────────────────────────────────────────────
const PULSE_LIFE       = 0.4;   // seconds
const PULSE_MAX_SCALE  = 2.4;
const PULSE_OUTER      = 0.32;

// ── palette (slots from FOREST_VISUAL_STYLE.md — already used elsewhere) ────
const SLOT1_BONE   = 0xc7b89a;
const SLOT2_GREEN  = 0x4a7a4a;
const SLOT3_BROWN  = 0x6b4f3a;
const SLOT5_AMBER  = 0xe89c4a;
const SLOT6_GOLD   = 0xd9a648;

// ── bounds keep-out ──────────────────────────────────────────────────────────
const LOCKDOWN = { x: 1.0, z: -28.0, r2: (8 + 2) * (8 + 2) }; // r=10
const TRAP_SHARDS = [
  { x: -1.0, z: 19.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 22.0, r2: (1.6 + 2) * (1.6 + 2) },
  { x: -1.0, z: 25.0, r2: (1.6 + 2) * (1.6 + 2) },
];
const PORTAL_KEEPOUT_R2 = 2 * 2; // r=2 around each portal post

// ── module state ─────────────────────────────────────────────────────────────
let _loaded = false;
let _group = null;        // THREE.Group parent for all landmark meshes
let _disposables = [];    // geometries + materials to dispose on teardown

// Shrines: sculpted stone body, moss dressing, and a literal paw beacon.
// Every component is shared across all instances, so the richer silhouette has
// a fixed draw-call cost rather than one object hierarchy per placement.
let _shrineCount = 0;
let _shrineBaseMesh = null;     // merged cat-eared stone stele + plinth
let _shrineObeliskMesh = null;  // merged moss/root dressing
let _shrinePawMesh = null;      // hovering paw beacon, hidden when spent
let _shrinePos = null;          // Float32Array [x,z,x,z,...]
let _shrineTriggered = null;    // Uint8Array (0 / 1)

// Altars: 4 InstancedMesh components
let _altarCount = 0;
let _altarPedestalMesh = null;  // CylinderGeometry r=0.7 h=0.2
let _altarPillarMesh = null;    // BoxGeometry 0.5×1.0×0.5, rotated
let _altarGlowMesh = null;      // CylinderGeometry r=0.6 h=0.05 (additive)
let _altarPos = null;
let _altarTriggered = null;

// Pulse pool — pre-allocated ring meshes for telegraph FX
let _pulseMeshes = [];
let _pulseActive = []; // {idx, t, life, scaleEnd, color}

// Reusable scratch (no allocations in hot path)
const _dummy = new THREE.Object3D();
const _zeroDummy = new THREE.Object3D();
_zeroDummy.scale.set(0, 0, 0);
_zeroDummy.updateMatrix();
const _ZERO_MATRIX = _zeroDummy.matrix.clone();

// ── deterministic RNG (mulberry32, fresh seed) ──────────────────────────────
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function _isInKeepout(x, z) {
  // Lockdown arena keep-out
  let dx = x - LOCKDOWN.x;
  let dz = z - LOCKDOWN.z;
  if (dx * dx + dz * dz < LOCKDOWN.r2) return true;
  // Trap corridor shards
  for (let i = 0; i < TRAP_SHARDS.length; i++) {
    const s = TRAP_SHARDS[i];
    dx = x - s.x;
    dz = z - s.z;
    if (dx * dx + dz * dz < s.r2) return true;
  }
  // Portal posts (FOREST_PORTAL_POSITIONS values)
  for (const k in FOREST_PORTAL_POSITIONS) {
    const p = FOREST_PORTAL_POSITIONS[k];
    dx = x - p.x;
    dz = z - p.z;
    if (dx * dx + dz * dz < PORTAL_KEEPOUT_R2) return true;
  }
  return false;
}

/**
 * Try to find a valid placement inside a room's bounds, avoiding keep-out
 * zones AND already-placed landmark positions (min spacing 1.6u). Returns
 * {x, z} or null if no valid spot found after `attempts`.
 */
function _tryPlace(room, rand, placedX, placedZ, attempts) {
  const minX = room.bounds.minX + 2;
  const maxX = room.bounds.maxX - 2;
  const minZ = room.bounds.minZ + 2;
  const maxZ = room.bounds.maxZ - 2;
  const SPACING2 = 1.6 * 1.6;
  for (let a = 0; a < attempts; a++) {
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    if (_isInKeepout(x, z)) continue;
    // Spacing check against already-placed landmark positions
    let collide = false;
    for (let i = 0; i < placedX.length; i++) {
      const dx = x - placedX[i];
      const dz = z - placedZ[i];
      if (dx * dx + dz * dz < SPACING2) { collide = true; break; }
    }
    if (collide) continue;
    return { x, z };
  }
  return null;
}

function _track(obj) { _disposables.push(obj); }

function _landmarkPart(geo, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
  geo.scale(sx, sy, sz);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

function _mergeLandmarkParts(parts) {
  const mixedIndexing = parts.some((part) => !!part.index)
    && parts.some((part) => !part.index);
  const normalized = mixedIndexing
    ? parts.map((part) => part.index ? part.toNonIndexed() : part)
    : parts;
  const geo = mergeGeometries(normalized, false);
  const disposed = new Set();
  for (const part of [...normalized, ...parts]) {
    if (!part || disposed.has(part)) continue;
    disposed.add(part);
    part.dispose();
  }
  if (!geo) return new THREE.DodecahedronGeometry(0.5, 0);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function _pawBeaconGeometry() {
  const parts = [
    _landmarkPart(new THREE.SphereGeometry(0.31, 8, 5), 1.08, 0.24, 0.88, 0, 0, -0.10),
  ];
  const toes = [
    [-0.25, 0.18, 0.12], [-0.09, 0.30, 0.13],
    [0.09, 0.30, 0.13], [0.25, 0.18, 0.12],
  ];
  for (const [x, z, radius] of toes) {
    parts.push(_landmarkPart(
      new THREE.SphereGeometry(radius, 7, 4),
      0.92, 0.22, 1.0, x, 0, z,
    ));
  }
  return _mergeLandmarkParts(parts);
}

// ── builders ─────────────────────────────────────────────────────────────────
function _buildShrineMeshes() {
  // The old shrine was a brown disc plus a plain green box. From the game
  // camera it read as a placeholder post. This shared composite has a stepped
  // plinth, tapered stele, round cat face, and unmistakable ears.
  const baseGeo = _mergeLandmarkParts([
    _landmarkPart(new THREE.CylinderGeometry(0.57, 0.68, 0.18, 10), 1, 1, 1, 0, 0.09, 0),
    _landmarkPart(new THREE.CylinderGeometry(0.49, 0.56, 0.16, 10), 1, 1, 1, 0, 0.24, 0),
    _landmarkPart(new THREE.CylinderGeometry(0.32, 0.44, 0.82, 8), 1, 1, 1, 0, 0.70, 0),
    _landmarkPart(new THREE.DodecahedronGeometry(0.43, 0), 1.03, 0.91, 0.88, 0, 1.27, 0),
    _landmarkPart(new THREE.ConeGeometry(0.20, 0.44, 3), 1, 1, 0.86, -0.28, 1.66, 0, 0, 0, -0.10),
    _landmarkPart(new THREE.ConeGeometry(0.20, 0.44, 3), 1, 1, 0.86, 0.28, 1.66, 0, 0, 0, 0.10),
    _landmarkPart(new THREE.ConeGeometry(0.13, 0.46, 5), 1, 1, 0.76, -0.43, 0.37, 0.02, 0, 0, -0.72),
    _landmarkPart(new THREE.ConeGeometry(0.13, 0.46, 5), 1, 1, 0.76, 0.43, 0.37, 0.02, 0, 0, 0.72),
  ]);
  const baseMat = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.93, metalness: 0.02, flatShading: true,
    map: _stoneTexture(),
  });
  _shrineBaseMesh = new THREE.InstancedMesh(baseGeo, baseMat, CAP_SHRINES);
  _shrineBaseMesh.userData.landmarkKind = 'shrine_cat_stele';
  _shrineBaseMesh.userData.environmentRole = 'interactive';
  _shrineBaseMesh.userData.landscapePurpose = 'damage-blessing-shrine';
  _track(baseGeo); _track(baseMat);

  // Chunky moss clumps read at gameplay zoom and break up the stone profile.
  const obeGeo = _mergeLandmarkParts([
    _landmarkPart(new THREE.DodecahedronGeometry(0.23, 0), 1.35, 0.55, 0.92, -0.30, 0.34, 0.31),
    _landmarkPart(new THREE.DodecahedronGeometry(0.22, 0), 1.25, 0.50, 0.92, 0.27, 0.36, 0.33),
    _landmarkPart(new THREE.DodecahedronGeometry(0.18, 0), 1.18, 0.52, 0.84, 0.02, 1.48, 0.24),
    _landmarkPart(new THREE.DodecahedronGeometry(0.14, 0), 1.05, 0.58, 0.82, -0.30, 1.39, 0.20),
  ]);
  const obeMat = new THREE.MeshStandardMaterial({
    color: SLOT2_GREEN, roughness: 0.96, metalness: 0, flatShading: true,
  });
  _shrineObeliskMesh = new THREE.InstancedMesh(obeGeo, obeMat, CAP_SHRINES);
  _shrineObeliskMesh.userData.landmarkKind = 'shrine_moss';
  _track(obeGeo); _track(obeMat);

  // A literal gold paw communicates "cat blessing" at a glance. It is a
  // horizontal low-poly sculpt, not a billboard or an ambiguous floating hoop.
  const pawGeo = _pawBeaconGeometry();
  const pawMat = new THREE.MeshStandardMaterial({
    color: 0xffd75e,
    emissive: SLOT6_GOLD,
    emissiveIntensity: 0.42,
    roughness: 0.52,
    metalness: 0.06,
    flatShading: true,
  });
  _shrinePawMesh = new THREE.InstancedMesh(pawGeo, pawMat, CAP_SHRINES);
  _shrinePawMesh.userData.landmarkKind = 'shrine_paw_beacon';
  _track(pawGeo); _track(pawMat);

}

function _buildAltarMeshes() {
  // Pedestal — wider brown cylinder.
  const pedGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.2, 16);
  const pedMat = new THREE.MeshStandardMaterial({
    color: SLOT3_BROWN, roughness: 0.95, metalness: 0.02, flatShading: true,
    map: _stoneTexture(),
  });
  _altarPedestalMesh = new THREE.InstancedMesh(pedGeo, pedMat, CAP_ALTARS);
  _altarPedestalMesh.userData.landmarkKind = 'altar_pedestal';
  _track(pedGeo); _track(pedMat);

  // Pillar fragment — bone-colored box, tilted ~25° on x-axis.
  const pillarGeo = new THREE.BoxGeometry(0.5, 1.0, 0.5);
  const pillarMat = new THREE.MeshStandardMaterial({
    color: SLOT1_BONE, roughness: 0.7, metalness: 0.05, flatShading: true,
    map: _stoneTexture(),
  });
  _altarPillarMesh = new THREE.InstancedMesh(pillarGeo, pillarMat, CAP_ALTARS);
  _altarPillarMesh.userData.landmarkKind = 'altar_pillar';
  _track(pillarGeo); _track(pillarMat);

  // Amber base glow — flat low cylinder, additive, bloom-tagged, low opacity.
  const glowGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.05, 16);
  const glowMat = new THREE.MeshBasicMaterial({
    color: SLOT5_AMBER,
    transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    // Ground-decal Z-order fix (2026-05-17 user report): flat glow at y=0.01
    // must render below hero/enemies. polygonOffset biases it further BELOW
    // in the depth buffer.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  _altarGlowMesh = new THREE.InstancedMesh(glowGeo, glowMat, CAP_ALTARS);
  _altarGlowMesh.layers.enable(BLOOM_LAYER);
  _altarGlowMesh.userData.landmarkKind = 'altar_glow';
  _altarGlowMesh.renderOrder = -1;
  _track(glowGeo); _track(glowMat);
}

function _buildPulsePool() {
  // Pre-allocate CAP_PULSES ring meshes via canonical rune-ring helper
  // (PHASE 2 P2A). Each pulse owns its own MATERIAL so opacity/color can be
  // animated independently per-frame (helper's shared geometry is reused).
  for (let i = 0; i < CAP_PULSES; i++) {
    const pulse = createRuneRing({
      radius: PULSE_OUTER, color: SLOT6_GOLD, opacity: 0,
      userData: { landmarkKind: 'pulse' },
    });
    pulse.mesh.visible = false;
    _pulseMeshes.push(pulse.mesh);
    _track(pulse.material);
  }
}

// ── placement ────────────────────────────────────────────────────────────────
function _placeShrines(rand) {
  _shrinePos = new Float32Array(CAP_SHRINES * 2);
  _shrineTriggered = new Uint8Array(CAP_SHRINES);
  const placedX = [];
  const placedZ = [];
  let idx = 0;

  for (const id in FOREST_ROOMS) {
    if (idx >= CAP_SHRINES) break;
    const room = FOREST_ROOMS[id];
    const budget = (room.landmarkBudget && typeof room.landmarkBudget.shrines === 'number')
      ? room.landmarkBudget.shrines
      : DEFAULT_BUDGET.shrines;
    const n = 4 + ((rand() * 3) | 0); // 4..6 baseline
    const target = Math.min(budget, n);
    for (let i = 0; i < target && idx < CAP_SHRINES; i++) {
      const spot = _tryPlace(room, rand, placedX, placedZ, 24);
      if (!spot) continue;
      _shrinePos[idx * 2 + 0] = spot.x;
      _shrinePos[idx * 2 + 1] = spot.z;
      placedX.push(spot.x); placedZ.push(spot.z);

      // Stamp one coherent yaw across the sculpted body and moss. The literal
      // paw at ear height is the only persistent interaction cue; a repeated
      // ground rune made every shrine look like the same yellow pickup ring.
      const yaw = rand() * Math.PI * 2;
      _dummy.position.set(spot.x, 0, spot.z);
      _dummy.rotation.set(0, yaw, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _shrineBaseMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 0, spot.z);
      _dummy.rotation.set(0, yaw, 0);
      _dummy.updateMatrix();
      _shrineObeliskMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 2.02, spot.z);
      _dummy.rotation.set(0, yaw, 0);
      _dummy.scale.setScalar(0.90);
      _dummy.updateMatrix();
      _shrinePawMesh.setMatrixAt(idx, _dummy.matrix);

      idx++;
    }
  }
  // Zero-out remaining unused slots so stray identity matrices don't render.
  for (let i = idx; i < CAP_SHRINES; i++) {
    _shrineBaseMesh.setMatrixAt(i, _ZERO_MATRIX);
    _shrineObeliskMesh.setMatrixAt(i, _ZERO_MATRIX);
    _shrinePawMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _shrineBaseMesh.instanceMatrix.needsUpdate = true;
  _shrineObeliskMesh.instanceMatrix.needsUpdate = true;
  _shrinePawMesh.instanceMatrix.needsUpdate = true;
  _shrineCount = idx;
  _shrineBaseMesh.count = idx;
  _shrineObeliskMesh.count = idx;
  _shrinePawMesh.count = idx;
}

function _placeAltars(rand) {
  _altarPos = new Float32Array(CAP_ALTARS * 2);
  _altarTriggered = new Uint8Array(CAP_ALTARS);
  const placedX = [];
  const placedZ = [];
  // Seed placedX/Z with existing shrine positions so altars space away from
  // shrines too (single global spacing budget for landmark cluster reads).
  for (let i = 0; i < _shrineCount; i++) {
    placedX.push(_shrinePos[i * 2]);
    placedZ.push(_shrinePos[i * 2 + 1]);
  }
  let idx = 0;

  for (const id in FOREST_ROOMS) {
    if (idx >= CAP_ALTARS) break;
    const room = FOREST_ROOMS[id];
    const budget = (room.landmarkBudget && typeof room.landmarkBudget.altars === 'number')
      ? room.landmarkBudget.altars
      : DEFAULT_BUDGET.altars;
    const n = 2 + ((rand() * 2) | 0); // 2..3 baseline
    const target = Math.min(budget, n);
    for (let i = 0; i < target && idx < CAP_ALTARS; i++) {
      const spot = _tryPlace(room, rand, placedX, placedZ, 24);
      if (!spot) continue;
      _altarPos[idx * 2 + 0] = spot.x;
      _altarPos[idx * 2 + 1] = spot.z;
      placedX.push(spot.x); placedZ.push(spot.z);

      // Pedestal at y=0.1, pillar tilted ~25° on X-axis, offset upward + back
      // so the broken pillar looks like it fell over the pedestal. Glow disc
      // at floor level y=0.01 to avoid z-fighting with terrain at y=0.
      _dummy.position.set(spot.x, 0.1, spot.z);
      _dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _altarPedestalMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 0.6, spot.z);
      _dummy.rotation.set(25 * Math.PI / 180, rand() * Math.PI * 2, 0);
      _dummy.updateMatrix();
      _altarPillarMesh.setMatrixAt(idx, _dummy.matrix);

      _dummy.position.set(spot.x, 0.01, spot.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      _altarGlowMesh.setMatrixAt(idx, _dummy.matrix);

      idx++;
    }
  }
  for (let i = idx; i < CAP_ALTARS; i++) {
    _altarPedestalMesh.setMatrixAt(i, _ZERO_MATRIX);
    _altarPillarMesh.setMatrixAt(i, _ZERO_MATRIX);
    _altarGlowMesh.setMatrixAt(i, _ZERO_MATRIX);
  }
  _altarPedestalMesh.instanceMatrix.needsUpdate = true;
  _altarPillarMesh.instanceMatrix.needsUpdate = true;
  _altarGlowMesh.instanceMatrix.needsUpdate = true;
  _altarCount = idx;
  _altarPedestalMesh.count = idx;
  _altarPillarMesh.count = idx;
  _altarGlowMesh.count = idx;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build pre-pooled landmark meshes and scatter them across all 7 Forest rooms.
 * Idempotent — calling twice without dispose is a no-op (gated on _loaded).
 *
 * @param {THREE.Scene} scene
 * @param {Object} _state - unused; reserved for future seed override hooks
 * @param {Function} [rngOverride] - optional rng to override the default
 *   landmark seed (mulberry32 0xC0FFE8). Tests pass deterministic streams here.
 */
export function loadForestLandmarks(scene, _state, rngOverride) {
  if (_loaded) return;
  if (!scene) return;
  _group = new THREE.Group();
  _group.name = '__forestLandmarks';

  _buildShrineMeshes();
  _buildAltarMeshes();
  _buildPulsePool();

  _group.add(_shrineBaseMesh);
  _group.add(_shrineObeliskMesh);
  _group.add(_shrinePawMesh);
  _group.add(_altarPedestalMesh);
  _group.add(_altarPillarMesh);
  _group.add(_altarGlowMesh);
  for (let i = 0; i < _pulseMeshes.length; i++) _group.add(_pulseMeshes[i]);

  const rand = (typeof rngOverride === 'function') ? rngOverride : _mulberry32(0xC0FFE8);

  _placeShrines(rand);
  _placeAltars(rand);

  scene.add(_group);
  _loaded = true;
}

function _spawnPulse(x, z, color, scaleEnd) {
  // Find an idle pulse mesh slot. Drop the pulse on overflow (graceful — never
  // grow the pool).
  let slot = -1;
  for (let i = 0; i < _pulseMeshes.length; i++) {
    if (!_pulseMeshes[i].visible) { slot = i; break; }
  }
  if (slot < 0) return;
  const mesh = _pulseMeshes[slot];
  mesh.position.set(x, 0.1, z);
  mesh.scale.setScalar(0.2);
  mesh.material.color.setHex(color);
  mesh.material.opacity = 0.9;
  mesh.visible = true;
  _pulseActive.push({
    slot, t: 0, life: PULSE_LIFE, scaleEnd: scaleEnd || PULSE_MAX_SCALE,
  });
}

/**
 * Per-frame: hero trigger detection + pulse FX fade. Cheap when no landmarks
 * have been loaded (early-out on _loaded). No per-spawn allocation in the
 * hot path — all state lives in pre-pooled typed arrays and the pulse pool.
 *
 * @param {number} dt
 * @param {Object} state - GameState
 */
export function tickForestLandmarks(dt, state) {
  if (!_loaded) return;
  if (!state || !state.hero || !state.hero.pos || state.gameOver) {
    // Still fade active pulses so a dead-hero frame doesn't strand them.
    _fadePulses(dt);
    return;
  }
  const hx = state.hero.pos.x;
  const hz = state.hero.pos.z;

  // Shrines — circular AABB trigger r=0.9 against base position.
  for (let i = 0; i < _shrineCount; i++) {
    if (_shrineTriggered[i]) continue;
    const sx = _shrinePos[i * 2];
    const sz = _shrinePos[i * 2 + 1];
    const dx = hx - sx;
    const dz = hz - sz;
    if (dx * dx + dz * dz <= TRIGGER_R2) {
      // Self-gate FIRST so a same-frame re-entry can't double-dispatch.
      _shrineTriggered[i] = 1;
      // Effect: +5% global damage bonus.
      if (state.run) {
        state.run._dmgGlobalBonus = (state.run._dmgGlobalBonus || 0) + 0.05;
      }
      // Compact, truthful feedback: this is damage, not a green heal.
      try { spawnHeroTextFloater('MOSS BLESSING · +5% DMG', 'blessing'); } catch (_) {}
      // Telegraph pulse — palette-locked slot-6 gold.
      _spawnPulse(sx, sz, SLOT6_GOLD, 2.4);
      // Extinguish the explicit reward beacon. The sculpted stone cat + moss
      // stay behind as a readable spent landmark.
      _shrinePawMesh.setMatrixAt(i, _ZERO_MATRIX);
      _shrinePawMesh.instanceMatrix.needsUpdate = true;
      try { sfx.landmarkActivate && sfx.landmarkActivate(); } catch (_) {}
    }
  }

  // Altars — circular AABB trigger r=0.9 against pedestal position.
  for (let i = 0; i < _altarCount; i++) {
    if (_altarTriggered[i]) continue;
    const ax = _altarPos[i * 2];
    const az = _altarPos[i * 2 + 1];
    const dx = hx - ax;
    const dz = hz - az;
    if (dx * dx + dz * dz <= TRIGGER_R2) {
      _altarTriggered[i] = 1;
      if (state.hero) {
        state.hero.hpMax = (state.hero.hpMax || 0) + 10;
        state.hero.hp = state.hero.hpMax;
      }
      try { spawnHealNumber(10); } catch (_) {}
      _spawnPulse(ax, az, SLOT5_AMBER, 2.2);
      // Hide the base glow disc — pedestal + pillar remain as the "spent" form.
      _altarGlowMesh.setMatrixAt(i, _ZERO_MATRIX);
      _altarGlowMesh.instanceMatrix.needsUpdate = true;
      try { sfx.landmarkActivate && sfx.landmarkActivate(); } catch (_) {}
    }
  }

  _fadePulses(dt);
}

function _fadePulses(dt) {
  // Walk pulses in reverse so splice doesn't skip neighbors.
  for (let i = _pulseActive.length - 1; i >= 0; i--) {
    const p = _pulseActive[i];
    p.t += dt;
    const k = p.t / p.life;
    const mesh = _pulseMeshes[p.slot];
    if (k >= 1) {
      mesh.visible = false;
      mesh.material.opacity = 0;
      _pulseActive.splice(i, 1);
      continue;
    }
    // Cubic ease-out expand + linear fade.
    const ease = 1 - Math.pow(1 - k, 3);
    const s = 0.2 + (p.scaleEnd - 0.2) * ease;
    mesh.scale.setScalar(s);
    mesh.material.opacity = 0.9 * (1 - k);
  }
}

/**
 * Tear down all landmark meshes + pulse pool. Idempotent — safe to call when
 * not loaded. Pairs with `disposeFlowWeaver`-style site in main.js teardown.
 */
export function disposeForestLandmarks(scene) {
  if (!_loaded && !_group) return;
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (let i = 0; i < _disposables.length; i++) {
    const d = _disposables[i];
    try { d.dispose && d.dispose(); } catch (_) {}
  }
  _disposables = [];
  _pulseMeshes = [];
  _pulseActive = [];
  _shrineBaseMesh = _shrineObeliskMesh = _shrinePawMesh = null;
  _altarPedestalMesh = _altarPillarMesh = _altarGlowMesh = null;
  _shrinePos = _shrineTriggered = null;
  _altarPos = _altarTriggered = null;
  _shrineCount = _altarCount = 0;
  _loaded = false;
}

/**
 * Read-only snapshot of placed landmark XZ centers. Returns a flat
 * array of {x, z} objects covering interactive shrines and altars
 * in placement order. Empty array if landmarks haven't been loaded or
 * have been disposed. Intended for sibling modules (forestCoffins.js)
 * that need a quick keep-out test against already-placed landmarks.
 *
 * Allocation: O(n) — called once at coffin placement time (not in a
 * hot path). Safe to call before/after dispose without throwing.
 *
 * @returns {Array<{x:number, z:number}>}
 */
export function getLandmarkPositions() {
  const out = [];
  if (_shrinePos && _shrineCount > 0) {
    for (let i = 0; i < _shrineCount; i++) {
      out.push({ x: _shrinePos[i * 2], z: _shrinePos[i * 2 + 1] });
    }
  }
  if (_altarPos && _altarCount > 0) {
    for (let i = 0; i < _altarCount; i++) {
      out.push({ x: _altarPos[i * 2], z: _altarPos[i * 2 + 1] });
    }
  }
  return out;
}
