/**
 * Cave ceiling-drip particle system (P4A cohort 4, 2026-05-18).
 *
 * Pooled drip particles that spawn from stalactite tips (cohort 2), fall
 * under gravity, and fade on landing. Authored per docs/CAVE_VISUAL_STYLE.md
 * row P4A-c4 (ceiling drip texture row, rerouted from the originally
 * scheduled c5 per cohort-3 advisor):
 *   - Single InstancedMesh of 24 PlaneGeometry streaks (slot-3 moss
 *     CAVE_PALETTE.moss 0x7fffe4, additive blend, bloom-tagged via
 *     BLOOM_LAYER so the glow pops the same way the stalactite tips +
 *     glowmoss patches do).
 *   - Per-frame matrix updates only (no per-frame allocations); inactive
 *     slots collapse to a zero-scale matrix so they're invisible without
 *     paying per-instance-alpha shader complexity (per cohort-4 advisor
 *     "instanceColor doesn't carry alpha" guidance).
 *   - Landing fade is a scale-Y collapse over 0.15s — combined with
 *     additive bloom on slot-3 it reads as a "splash flatten" without
 *     needing a custom shader for opacity per instance.
 *
 * Spawn behavior:
 *   - Pick a random stalactite tip from caveStalactites.getStalactiteTipPositions()
 *     each tick. Tip world Y varies 0.4..1.6u (per cohort-2 height jitter),
 *     so flight times land ~0.3-0.6s under g=9 m/s² to y=0.
 *   - Self-gated dispatcher per [[feedback_kks_wave_dispatcher_throttle.md]]:
 *     `_nextSpawnAt = t + interval` ALWAYS advances after the spawn-attempt
 *     window elapses — even when the pool is fully occupied — so a saturated
 *     pool never burns a tight loop re-evaluating every frame.
 *   - Rate: 0.5 drips/s baseline scaled by stalactite count (cap at the
 *     pool size so spawns never out-pace recycle in normal play).
 *
 * Audio (this cohort): DEFERRED. audio.js exposes `playStageAmbient(stageId)`
 * as a stage-bed switcher, not an event hook for arbitrary ambient triggers;
 * no drip sample exists under assets/audio/ (no cave/ dir, no drip/water
 * matches). Per spec, do NOT add a shim to audio.js (P4G scope). A future
 * cohort can land a Kenney CC0 drip sample + an audio.js ambient-event hook
 * and wire `_maybePlayDripSfx()` (currently a no-op stub) to it.
 *
 * Disposal: single module-level state pointer; idempotent disposeCeilingDrips
 * tears down the InstancedMesh geometry + material, matching the cohort 2
 * stalactite + cohort 3 glowmoss contracts.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';
import { BLOOM_LAYER } from '../../rendering/bloomLayers.js';
import { getStalactiteTipPositions } from './caveStalactites.js';

// Pool sizing — 24 slots accommodates the cohort-2 stalactite count (26
// instances) at the 0.5/s baseline rate with a generous safety margin even
// at peak overlap (longest flight ~0.6s → ~13 in-flight at 1 drip/s).
const POOL_SIZE         = 24;

// Drip streak geometry — narrow PlaneGeometry billboard. 0.08u wide reads
// as a clean line under bloom; 0.5u tall gives the streak a length without
// over-stretching the silhouette when scale-Y-collapsing on landing.
const STREAK_WIDTH      = 0.08;
const STREAK_HEIGHT     = 0.5;

// Spawn rate — 0.5 drips/s baseline, scaled by stalactite count / 26
// (cohort-2 canonical count). Caps at 1.0/s so a future cohort that doubles
// the cluster count doesn't accidentally machine-gun the pool.
const SPAWN_RATE_BASE_HZ = 0.5;
const SPAWN_RATE_CAP_HZ  = 1.0;
const REFERENCE_TIP_CNT  = 26;

// Physics — falling under gravity from tip to y=0.
const GRAVITY            = 9.0;            // m/s², near earth-g for game feel
const GROUND_Y           = 0.0;            // env ground sits at y=0

// Landing fade — scale-Y collapse over LAND_FADE_DUR seconds. Recycle slot
// the frame after the fade window completes (no abrupt pop).
const LAND_FADE_DUR      = 0.15;

// Module-level scratch — reused every frame for matrix composition. NEVER
// allocate inside tickCeilingDrips per [[feedback_kks_wave_dispatcher_throttle.md]]
// hot-path discipline + cohort-4 advisor "no new THREE.Vector3() in tick".
const _dummy             = new THREE.Object3D();
const _zeroMatrix        = new THREE.Matrix4().makeScale(0, 0, 0);

let _state = null;
// {
//   group, inst, geo, mat,
//   pool: [{ active, x, y, z, vy, age, landed, landAge }, ...],
//   tAcc, nextSpawnAt,
//   totalSpawned,        // monotonic counter for smoke probe
// }

/**
 * Build the ceiling-drip InstancedMesh and parent it under `parent`
 * (typically the caveStage group). Pre-allocates POOL_SIZE slots — all
 * start inactive (zero-scale matrix), spawn-dispatched by tickCeilingDrips.
 *
 * Stashes `parent.userData.dripPoolSize = POOL_SIZE` for the smoke probe.
 * Returns `{ group, poolSize }`.
 *
 * Idempotent — if already mounted (re-entry on stage swap), dispose first.
 */
export function buildCeilingDrips(parent) {
  if (_state) disposeCeilingDrips();
  if (!parent) return { group: null, poolSize: 0 };

  // Narrow vertical streak. Plane is XY (z=0) so the "billboard" face
  // points along world +z by default — that's fine because additive
  // blending + bloom makes the orientation read as a thin line from any
  // gameplay-camera angle (top-down isometric in this game).
  const geo = new THREE.PlaneGeometry(STREAK_WIDTH, STREAK_HEIGHT);

  // Additive + slot-3 moss recipe — same chrome as the cohort-2 stalactite
  // tips and cohort-3 glowmoss patches so the visual reads as the same
  // bioluminescence-leaking-from-the-ceiling motif.
  const mat = new THREE.MeshBasicMaterial({
    color:       CAVE_PALETTE.moss,
    transparent: true,
    opacity:     0.85,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
    side:        THREE.DoubleSide,
  });

  const inst = new THREE.InstancedMesh(geo, mat, POOL_SIZE);
  inst.name = 'caveStage_ceilingDrips';
  inst.layers.enable(BLOOM_LAYER);   // slot-3 emissive bloom per style doc
  inst.castShadow = false;
  inst.receiveShadow = false;
  inst.frustumCulled = false;        // small fast-moving particles; skip
                                     // the per-instance cull cost for a
                                     // fixed N=24 pool

  // Pre-allocate ALL slots as zero-scale (invisible) matrices. tickCeilingDrips
  // will replace these with live transforms when a slot is occupied; on land
  // + recycle we restore the zero matrix.
  for (let i = 0; i < POOL_SIZE; i++) {
    inst.setMatrixAt(i, _zeroMatrix);
  }
  inst.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'caveStage_ceilingDrips_group';
  group.add(inst);
  parent.add(group);

  // Pool — plain objects, all inactive at boot. Reused across spawns; the
  // slot index maps 1:1 to the InstancedMesh instance index.
  const pool = new Array(POOL_SIZE);
  for (let i = 0; i < POOL_SIZE; i++) {
    pool[i] = {
      active:  false,
      x: 0, y: 0, z: 0,
      vy: 0,
      age: 0,
      landed:  false,
      landAge: 0,
    };
  }

  _state = {
    group, inst, geo, mat,
    pool,
    tAcc: 0,
    nextSpawnAt: 0,
    totalSpawned: 0,
  };

  // Smoke probe hook — stash pool size on caveStage userData. The cohort 4
  // smoke phase 5 reads this to verify the system mounted.
  if (parent.userData) {
    parent.userData.dripPoolSize = POOL_SIZE;
  }

  return { group, poolSize: POOL_SIZE };
}

/**
 * Per-frame tick — drives the spawn dispatcher + falling-drip physics +
 * landing-fade + recycle. Self-gated — early-return when no system is
 * mounted (per [[feedback_kks_wave_dispatcher_throttle.md]]).
 *
 * Hot-path constraints (cohort 4):
 *   - NO `new` inside this function. Use module-level _dummy + _zeroMatrix.
 *   - Spawn dispatcher MUST advance _nextSpawnAt even when pool is full so
 *     a saturated pool never burns a tight loop.
 */
export function tickCeilingDrips(dt) {
  if (!_state) return;
  if (!Number.isFinite(dt) || dt <= 0) return;
  _state.tAcc += dt;
  const t = _state.tAcc;

  // ── Spawn dispatcher (self-gated) ────────────────────────────────────
  if (t >= _state.nextSpawnAt) {
    const tips = getStalactiteTipPositions();
    const tipCount = tips.length;

    // Compute spawn interval scaled to stalactite density. If no tips are
    // available (cohort-2 not built yet, or just disposed), default to the
    // base rate so we still advance _nextSpawnAt — see throttle feedback.
    let rateHz = SPAWN_RATE_BASE_HZ;
    if (tipCount > 0) {
      rateHz = SPAWN_RATE_BASE_HZ * (tipCount / REFERENCE_TIP_CNT);
      if (rateHz > SPAWN_RATE_CAP_HZ) rateHz = SPAWN_RATE_CAP_HZ;
    }
    const interval = 1.0 / rateHz;

    // Attempt spawn only if there's both a tip pool AND a free drip slot.
    // CRITICAL: always advance _nextSpawnAt regardless of attempt success
    // (full-pool / empty-tips both fall through to the increment).
    if (tipCount > 0) {
      // Linear scan for first inactive slot. Pool size is 24, branchless
      // would micro-optimize but the explicit loop reads cleaner.
      let freeIdx = -1;
      for (let i = 0; i < POOL_SIZE; i++) {
        if (!_state.pool[i].active) { freeIdx = i; break; }
      }
      if (freeIdx >= 0) {
        // Pick a deterministic-but-varied tip. Using _state.totalSpawned as
        // a counter (mod tipCount) avoids per-tick Math.random allocs and
        // also makes the smoke test more predictable run-to-run.
        const tipIdx = _state.totalSpawned % tipCount;
        const tip = tips[tipIdx];
        const slot = _state.pool[freeIdx];
        slot.active  = true;
        slot.x       = tip.x;
        slot.y       = tip.y;
        slot.z       = tip.z;
        slot.vy      = 0;
        slot.age     = 0;
        slot.landed  = false;
        slot.landAge = 0;
        _state.totalSpawned++;
      }
      // else: pool saturated — nothing to do, _nextSpawnAt still advances.
    }

    _state.nextSpawnAt = t + interval;
  }

  // ── Per-slot physics + landing fade ─────────────────────────────────
  let dirty = false;
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = _state.pool[i];
    if (!slot.active) continue;

    if (!slot.landed) {
      // Free-fall integration: vy -= g*dt; y += vy*dt (semi-implicit Euler;
      // small dt so the simple form is fine for game-feel particles).
      slot.vy -= GRAVITY * dt;
      slot.y  += slot.vy * dt;
      slot.age += dt;

      if (slot.y <= GROUND_Y) {
        slot.y = GROUND_Y;
        slot.landed = true;
        slot.landAge = 0;
      }
      // Compose matrix: position at (x, y, z), scale Y to streak length so
      // it reads as a long vertical streak during flight.
      _dummy.position.set(slot.x, slot.y, slot.z);
      _dummy.scale.set(1, 1, 1);
      _dummy.rotation.set(0, 0, 0);
      _dummy.updateMatrix();
      _state.inst.setMatrixAt(i, _dummy.matrix);
      dirty = true;
    } else {
      // Landed — scale-Y collapse over LAND_FADE_DUR seconds. At fade end,
      // zero out the matrix + mark inactive (slot recycled).
      slot.landAge += dt;
      const k = slot.landAge / LAND_FADE_DUR;
      if (k >= 1) {
        slot.active = false;
        _state.inst.setMatrixAt(i, _zeroMatrix);
        dirty = true;
      } else {
        // Splash-flatten: scale-Y → 0, slightly widen X so the additive
        // bloom puff reads as a flat splash disc on the floor.
        const sy = 1 - k;
        const sxz = 1 + k * 0.6;
        _dummy.position.set(slot.x, slot.y + 0.02, slot.z);
        _dummy.scale.set(sxz, sy, sxz);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        _state.inst.setMatrixAt(i, _dummy.matrix);
        dirty = true;
      }
    }
  }

  if (dirty) _state.inst.instanceMatrix.needsUpdate = true;
}

/**
 * Tear down the ceiling-drip system. Idempotent — safe to call when not
 * mounted. Disposes geometry + material.
 */
export function disposeCeilingDrips() {
  if (!_state) return false;
  const { group, geo, mat } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { geo && geo.dispose(); } catch (_) {}
  try { mat && mat.dispose(); } catch (_) {}
  _state = null;
  return true;
}

/**
 * Smoke probe accessor — read the monotonic spawn counter without exposing
 * the entire state object. Returns 0 when no system is mounted.
 *
 * Used by tools/smoke-cave-v2.mjs phase 5 to verify drips actually spawn
 * (counter ≥ 1) after settle, sidestepping the flake of trying to catch a
 * 0.3-0.6s-flight particle mid-air at probe time.
 */
export function getCeilingDripTotalSpawned() {
  if (!_state) return 0;
  return _state.totalSpawned | 0;
}
