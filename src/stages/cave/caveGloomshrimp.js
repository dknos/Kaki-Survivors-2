/**
 * Cave gloomshrimp neutrals (P4A cohort 5, 2026-05-20).
 *
 * Bioluminescent cave creatures — the cave's ambient-life answer to forest
 * fireflies/deer (canonical neutral pattern: src/forestNeutrals.js). NON-
 * COMBAT: no XP, no damage dealt or taken, no progression hook. They drift
 * slowly above the cave floor and dart away when the hero gets close, so the
 * cave reads as inhabited rather than a static decor box.
 *
 * Visual: a small slot-2 stone body with a slot-3 moss EMISSIVE glow
 * (CAVE_PALETTE.moss = 0x7fffe4) on BLOOM_LAYER — same quality bar as the
 * cohort-3 glowmoss / cohort-2 stalactite tips. One InstancedMesh, N=12.
 *
 * Motion (zero allocation in tick — typed arrays + one scratch Object3D):
 *   - Each shrimp holds a heading + base hover-Y + phase. Drifts at
 *     DRIFT_SPEED, weaving via a sine on the shared anim clock (no per-frame
 *     RNG, so the swim is deterministic across daily seeds).
 *   - Soft annulus bound (RING_R_MIN..RING_R_MAX around origin): when a shrimp
 *     wanders past the bound its heading steers back toward center.
 *   - Hero proximity (within FLEE_R) flips it to a FLEE state: heading snaps
 *     away from the hero at FLEE_SPEED for FLEE_DURATION, then resumes drift.
 *   - Y bob via sine on the anim clock; a slight nose tilt sells the swim.
 *
 * Lifecycle mirrors the other active cave cohorts (for example,
 * caveCeilingDrips):
 *   buildGloomshrimp(parent)  — InstancedMesh under a named group; returns
 *                               { group, count } for the caveStage userData
 *                               probe. Idempotent.
 *   tickGloomshrimp(dt)       — self-gated per-frame swim + flee. Reads hero
 *                               pos from the shared state import (tickCave only
 *                               forwards dt, like forestNeutrals reads _gameState).
 *   disposeGloomshrimp()      — idempotent teardown of geo + material.
 *
 * Constraints honored:
 *   - Static imports only ([[feedback_kks_export_origin_module_break.md]]).
 *   - One InstancedMesh (≥ instance break-even at N=12 vs 12 draw calls).
 *   - Zero per-frame allocation (scratch _dummy + typed arrays).
 *   - Palette-locked: slot-2 body, slot-3 emissive only.
 *   - Self-gated tick ([[feedback_kks_wave_dispatcher_throttle.md]]).
 *   - Does not flee a dead hero (state.gameOver guard), matching forestNeutrals.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';
import { BLOOM_LAYER } from '../../rendering/bloomLayers.js';
import { state as _gameState } from '../../state.js';

const COHORT_SEED  = 0xC0CA0E3;   // distinct from stalactites(0E1)/glowmoss(0E2)/drips
const COUNT        = 12;
const RING_R_MIN   = 9;           // keep clear of hero spawn at (0,0)
const RING_R_MAX   = 24;          // outer drift bound
const BASE_Y_MIN   = 0.7;         // hover height band above the floor
const BASE_Y_MAX   = 1.5;

const DRIFT_SPEED  = 0.7;         // u/s lazy cruise
const FLEE_SPEED   = 3.2;         // u/s startled dart
const FLEE_R       = 5.0;         // hero within this → flee
const FLEE_R2      = FLEE_R * FLEE_R;
const FLEE_DUR     = 1.4;         // seconds of darting before resuming drift

const WANDER_FREQ  = 0.6;         // rad/s weave frequency
const WANDER_AMP   = 0.9;         // heading wobble (rad/s peak)
const STEER_GAIN   = 1.8;         // how hard the annulus bound pulls heading back

const BOB_HZ       = 0.5;         // vertical bob frequency
const BOB_AMP      = 0.18;        // vertical bob amplitude (u)
const NOSE_TILT    = 0.25;        // rad — slight downward nose so it reads as swimming

// Body: a small 6-sided cone as a stylized tadpole/shrimp. Cone default axis
// is +Y; rotate the GEOMETRY so the tip points +Z (the heading/forward axis),
// then per-instance yaw aims it along travel.
const BODY_RADIUS  = 0.16;
const BODY_LENGTH  = 0.52;
const EMISSIVE_INT = 1.25;        // moss glow strength under bloom

// Inlined mulberry32 — placement + per-instance initialization
// only; the swim itself uses no RNG so it's identical every run.
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _state = null;   // { group, inst, geo, mat, count }
const _dummy = new THREE.Object3D();

// Per-instance motion state (typed arrays — zero alloc in tick).
let _x = null, _z = null, _baseY = null, _heading = null, _phase = null;
let _fleeT = null;          // Float32Array — remaining flee time (0 = drifting)
let _animClock = 0;

/**
 * Build the gloomshrimp InstancedMesh and parent it under `parent` (the
 * caveStage group). Returns { group, count } so caveStage can stash
 * userData.gloomshrimpCount for the smoke probe. Idempotent.
 */
export function buildGloomshrimp(parent) {
  if (_state) disposeGloomshrimp();
  if (!parent) return { group: null, count: 0 };

  const geo = new THREE.ConeGeometry(BODY_RADIUS, BODY_LENGTH, 6);
  geo.rotateX(Math.PI / 2);   // tip now points +Z (forward/heading axis)

  const mat = new THREE.MeshStandardMaterial({
    color:             CAVE_PALETTE.stone,
    emissive:          CAVE_PALETTE.moss,
    emissiveIntensity: EMISSIVE_INT,
    roughness:         0.55,
    metalness:         0.05,
    flatShading:       true,
  });

  const inst = new THREE.InstancedMesh(geo, mat, COUNT);
  inst.name = 'caveStage_gloomshrimp';
  inst.layers.enable(BLOOM_LAYER);   // slot-3 emissive pops under bloom
  inst.castShadow = false;
  inst.receiveShadow = false;
  inst.frustumCulled = false;        // small, scattered, fixed N — skip cull cost

  _x = new Float32Array(COUNT);
  _z = new Float32Array(COUNT);
  _baseY = new Float32Array(COUNT);
  _heading = new Float32Array(COUNT);
  _phase = new Float32Array(COUNT);
  _fleeT = new Float32Array(COUNT);

  // Set _state before the stamp loop — _stamp() reads _state.inst (shared with
  // the per-frame path). group is filled in after the loop.
  _state = { group: null, inst, geo, mat, count: COUNT };

  const rng = _mulberry32(COHORT_SEED);
  for (let i = 0; i < COUNT; i++) {
    const theta = rng() * Math.PI * 2;
    const r = RING_R_MIN + rng() * (RING_R_MAX - RING_R_MIN);
    _x[i] = Math.cos(theta) * r;
    _z[i] = Math.sin(theta) * r;
    _baseY[i] = BASE_Y_MIN + rng() * (BASE_Y_MAX - BASE_Y_MIN);
    _heading[i] = rng() * Math.PI * 2;
    _phase[i] = rng() * Math.PI * 2;
    _fleeT[i] = 0;
    _stamp(i, 0);
  }
  inst.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'caveStage_gloomshrimpGroup';
  group.add(inst);
  parent.add(group);

  _state.group = group;
  _animClock = 0;
  return { group, count: COUNT };
}

// Stamp one shrimp's matrix from its motion state. bob is derived from the
// shared anim clock so the whole school undulates without per-instance timers.
function _stamp(i, clock) {
  const bob = Math.sin(clock * BOB_HZ * Math.PI * 2 + _phase[i]) * BOB_AMP;
  _dummy.position.set(_x[i], _baseY[i] + bob, _z[i]);
  // yaw aims the +Z nose along heading; a fixed nose-down tilt sells the swim.
  _dummy.rotation.set(NOSE_TILT, _heading[i], 0);
  _dummy.scale.setScalar(1);
  _dummy.updateMatrix();
  _state.inst.setMatrixAt(i, _dummy.matrix);
}

/**
 * Per-frame swim + flee. Self-gated: a non-cave run (no _state) is a free
 * no-op. Reads hero pos from the shared state import; does not flee a dead
 * hero (gameOver guard). dt is wall-clock seconds.
 */
export function tickGloomshrimp(dt) {
  if (!_state) return;
  if (!Number.isFinite(dt) || dt <= 0) return;
  _animClock += dt;

  const heroPos = _gameState && _gameState.hero && _gameState.hero.pos;
  const heroLive = !!heroPos && !_gameState.gameOver;
  const hx = heroPos ? heroPos.x : 0;
  const hz = heroPos ? heroPos.z : 0;

  for (let i = 0; i < COUNT; i++) {
    let speed = DRIFT_SPEED;

    if (_fleeT[i] > 0) {
      // Mid-dart: keep the stored heading, decay the timer.
      _fleeT[i] -= dt;
      speed = FLEE_SPEED;
    } else if (heroLive) {
      // Drifting: startle if the hero is inside FLEE_R.
      const dx = _x[i] - hx;
      const dz = _z[i] - hz;
      const d2 = dx * dx + dz * dz;
      if (d2 < FLEE_R2) {
        let nx = dx, nz = dz;
        const m = Math.sqrt(d2);
        if (m > 0.001) { nx /= m; nz /= m; }
        else { nx = Math.cos(i * 1.7); nz = Math.sin(i * 1.7); }
        _heading[i] = Math.atan2(nx, nz);   // face away from hero
        _fleeT[i] = FLEE_DUR;
        speed = FLEE_SPEED;
        // Cohort-6 achievement tie-in: first startle flags cave_gloomshrimp.
        if (_gameState.run) _gameState.run._caveShrimpStartled = true;
      }
    }

    if (_fleeT[i] <= 0) {
      // Lazy weave while drifting (deterministic, anim-clock driven).
      _heading[i] += Math.sin(_animClock * WANDER_FREQ + _phase[i]) * WANDER_AMP * dt;
    }

    // Soft annulus bound: steer heading toward / away from center when out of
    // the [RING_R_MIN, RING_R_MAX] band so the school stays in the play area.
    const r = Math.sqrt(_x[i] * _x[i] + _z[i] * _z[i]);
    if (r > RING_R_MAX || r < RING_R_MIN) {
      // Heading that points back toward the center of the band.
      const toCenter = Math.atan2(-_x[i], -_z[i]);
      const target = (r > RING_R_MAX) ? toCenter : toCenter + Math.PI; // inward / outward
      // Shortest-arc blend toward the target heading.
      let diff = target - _heading[i];
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      _heading[i] += diff * Math.min(1, STEER_GAIN * dt);
    }

    // Advance along heading (Math.atan2(nx,nz) convention → +Z is sin-free at 0).
    const step = speed * dt;
    _x[i] += Math.sin(_heading[i]) * step;
    _z[i] += Math.cos(_heading[i]) * step;

    _stamp(i, _animClock);
  }
  _state.inst.instanceMatrix.needsUpdate = true;
}

/**
 * Tear down the gloomshrimp cluster. Idempotent — safe when not mounted.
 */
export function disposeGloomshrimp() {
  if (!_state) return false;
  const { group, geo, mat } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { geo && geo.dispose(); } catch (_) {}
  try { mat && mat.dispose(); } catch (_) {}
  _state = null;
  _x = _z = _baseY = _heading = _phase = _fleeT = null;
  _animClock = 0;
  return true;
}
