/**
 * Lockdown Arena — stage-agnostic "doors slam, clear waves or elite" mechanic.
 *
 * Spec (FOREST ITER C1):
 *   Hero enters a registered zone → doors VISUALLY slam into place around the
 *   zone (player can see them; collision is a soft clamp keeping the hero
 *   inside). spawnDirector pauses normal cadence. Lockdown dispatches 3 gated
 *   waves of mobs (one per ~6-8s). Clear condition is whichever fires first:
 *     - all 3 waves cleared (every wave-tagged mob dead)
 *     - any one Elite-tier mob killed (skill window)
 *   On clear: doors retract smoothly, reward bundle drops (8 gems + 1 chest +
 *   bloom punch + sfx), state.run.lockdownActive resets to false.
 *
 * Stage-agnostic by design — Forest is the first consumer but any stage can:
 *   import { armLockdown, triggerLockdown } from './lockdownArena.js';
 *   const id = armLockdown({ center: { x, z }, radius: 8, paletteSlots: { wall, glow, clear } });
 *   ... later: triggerLockdown(id);
 *
 * Multiple arenas may be armed per stage, but only ONE active lockdown at a
 * time (the second triggerLockdown call is a no-op while another is live).
 *
 * Door visuals — match the active stage's locked palette via paletteSlots:
 *   wall:  stone/trunk base color (Forest slot 2 #2d3a55)
 *   glow:  pulse-rim emissive during slam-in / active (Forest slot 4 #7df0c4)
 *   clear: amber flash on retract (Forest slot 6/7 #f5a300 → #ffd86b)
 * Banner uses '#a8e6ff' (Forest slot 8 cyan-white) for the wave counter.
 *
 * Door geometry — MERGED BufferGeometry + flatShading per
 * docs/FOREST_VISUAL_STYLE.md "Crystal facet edges". Pre-pooled at arm time
 * (center + palette known then); triggerLockdown only mutates position +
 * material opacity/emissive intensity — ZERO per-trigger allocation.
 *
 * spawnDirector integration: spawnDirector.tickSpawnDirector early-returns
 * when state.run.lockdownActive is true (mirrors the PUZZLE_ACTIVE pause).
 * This file owns the substitute wave-dispatcher tick (tickLockdownArena).
 *
 * Failure mode: hero death during lockdown is handled normally — the run-end
 * teardown calls disposeLockdownArenas which drops any live door geometry
 * and clears the state flags.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENEMY_TIERS, SPAWN } from './config.js';
import { spawnEnemy } from './enemies.js';
import { spawnChest } from './chest.js';
import { dropGem } from './xp.js';
import { showBanner } from './ui.js';
import { sfx } from './audio.js';
import { setLeapMarker, clearLeapMarker } from './enemyTells.js';
import { cloneCached } from './assets.js';

// ─── module state ─────────────────────────────────────────────────────────────
/** @type {THREE.Scene|null} */
let _scene = null;

/**
 * Registered arenas (stage-agnostic). Each entry:
 *   {
 *     id, center: {x,z}, radius,
 *     paletteSlots: { wall, glow, clear },     // hex numbers
 *     doors: { group, north, south, east, west, materials: [...] },
 *     state: 'idle' | 'slamming' | 'active' | 'retracting',
 *     slamT: 0,            // seconds into slam-in animation
 *     retractT: 0,         // seconds into retract animation
 *     waveIdx: 0,          // 0-based wave currently dispatching (0..2)
 *     wavesCleared: 0,
 *     nextWaveAt: 0,       // state.time.game when next wave dispatches
 *     mobsThisWave: 0,     // count spawned this wave (used to detect "wave non-empty")
 *     eliteSpawned: false, // any elite seen by this lockdown (for run-state mirror)
 *     activeArena: false,  // true between trigger and clear
 *     drip: null,          // pending wave sub-burst queue (see _queueWave)
 *   }
 */
const _arenas = [];
let _nextArenaId = 1;

/** Id of the currently-active arena, or null when no lockdown is live. */
let _activeArenaId = null;

// ─── tuning constants ─────────────────────────────────────────────────────────
const SLAM_DURATION = 0.55;      // door drop-in animation seconds
const RETRACT_DURATION = 0.7;    // door lift-out animation seconds
const SLAM_START_Y = 8.0;        // doors begin this far above target Y
const DOOR_REST_Y = 0.0;         // resting Y for the door bottom edge
const WAVE_INTERVAL_SEC = 6.5;   // ~6-8s per spec (middle of range)
const PULSE_HZ = 0.9;            // emissive pulse frequency while active
const PULSE_MIN = 0.30;
const PULSE_MAX = 0.58;
const DOOR_THICK = 0.6;          // wall thickness (world units)
const DOOR_HEIGHT = 4.0;         // visible wall height
const DOOR_SPAN_MUL = 1.8;       // door length = radius * 2 * DOOR_SPAN_MUL/2 (spans most of arc face)
const CONTAINMENT_EPS = 0.35;    // hero-clamp inset from radius
const GLOW_RIM_INTENSITY = 0.9;  // slam-in rim emissive baseline

// ── wave fairness (fun-loop 2026-06-12) ──────────────────────────────────────
// Playtest deaths during lockdown read as unfair: a full wave landed in ONE
// tick, uniform around the ring, so mobs materialized at ~0u from a hero who
// is door-clamped inside the arena (teleport-encirclement, 100→0 HP with no
// escape route). Three rules fix the read without changing wave totals:
//   1. Placement floor — spawns prefer >= MIN_SPAWN_DIST from the hero. A
//      radius-8 arena can't always honor 10u (max hero→ring distance is
//      heroDist+ring), so the floor clamps to the farthest reachable ring
//      point and re-rolls keep the farthest candidate ("wall, not ambush").
//   2. Ramp-in — each wave drips in WAVE_SUB_BURSTS sub-bursts across
//      WAVE_DRIP_SEC instead of one beat. Total count unchanged.
//   3. Escape valve — the first sub-burst leaves an ESCAPE_GAP_ARC slice of
//      the ring empty, centered on the hero's bearing from the arena center,
//      so there is always a readable gap to dash through. Later sub-bursts
//      may close it.
// 6.8 not 10: at 10 vs the default radius-8 arena (ring 6.8) the floor was a
// no-op for a centered hero and rejected the entire near hemisphere for a
// wall-hugger — deleting encirclement pressure for the exact degenerate
// strategy. ~ring radius keeps flanks legal; the gap + front-load carry
// fairness instead.
const MIN_SPAWN_DIST = 6.8;             // placement floor from hero (world units)
const WAVE_DRIP_SEC = 3.0;              // per-wave spawn-in window (spec 2.5-4s)
const WAVE_SUB_BURSTS = 6;              // sub-bursts per wave
// Keep the same wave roster and three-second staging window, but avoid the
// old 55% first packet. That packet could expose a fresh barricade pipeline
// and several enemy instances in one frame, reading as a hang on cold GPUs.
// The opening is still the largest packet (so the arena reads as a lockdown),
// with the rest arriving in renderer-friendly batches.
const WAVE_BURST_W = [0.28, 0.20, 0.16, 0.14, 0.12, 0.10];
const ESCAPE_GAP_ARC = Math.PI / 2.5;   // 72° kept empty on first sub-burst (spec >= 60°)

// Wave-size scaler per current difficulty D. D ranges 0..SPAWN.difficultyMax
// (~7-9 typical for Forest). Base 6 + ceil(D * 1.5) ≈ 8-19 mobs per wave.
function _waveCount(D) {
  return 6 + Math.ceil(Math.max(0, D) * 1.5);
}

// ─── geometry pre-pool (per-arena) ────────────────────────────────────────────
// Build four cardinal barricades from the authored KayKit dungeon wall. The
// Forest preload tier guarantees this asset is cached before armLockdown runs;
// the box fallback is retained only for load failures/offline development.
// Each side is one InstancedMesh, so the repeated textured blocks still cost a
// single draw call and triggerLockdown only mutates transforms/material values.
function _buildDoorMeshes(arena) {
  const { center, radius, paletteSlots } = arena;
  const wallColor = paletteSlots.wall;
  const glowColor = paletteSlots.glow;

  const spanLen = radius * DOOR_SPAN_MUL; // door length (world units)
  const halfSpan = spanLen / 2;

  let sourceGeo = null;
  let sourceMat = null;
  let segmentWidth = 4;
  const authored = cloneCached('kkd_wall');
  if (authored) {
    authored.updateMatrixWorld(true);
    authored.traverse((o) => {
      if (sourceGeo || !o.isMesh || !o.geometry || !o.material || Array.isArray(o.material)) return;
      sourceGeo = o.geometry.clone();
      sourceGeo.applyMatrix4(o.matrixWorld);
      sourceGeo.computeBoundingBox();
      const box = sourceGeo.boundingBox;
      const nativeH = Math.max(0.001, box.max.y - box.min.y);
      const fit = DOOR_HEIGHT / nativeH;
      sourceGeo.scale(fit, fit, fit);
      sourceGeo.computeBoundingBox();
      const fitted = sourceGeo.boundingBox;
      const centerX = (fitted.min.x + fitted.max.x) * 0.5;
      const centerZ = (fitted.min.z + fitted.max.z) * 0.5;
      sourceGeo.translate(-centerX, -fitted.min.y, -centerZ);
      sourceGeo.computeBoundingBox();
      segmentWidth = Math.max(0.5, sourceGeo.boundingBox.max.x - sourceGeo.boundingBox.min.x);
      sourceMat = o.material;
    });
  }
  const usesAuthoredAsset = !!(sourceGeo && sourceMat);
  if (!usesAuthoredAsset) {
    sourceGeo = new THREE.BoxGeometry(4, DOOR_HEIGHT, DOOR_THICK);
    sourceGeo.translate(0, DOOR_HEIGHT / 2, 0);
    segmentWidth = 4;
  }

  function _makeWallMat() {
    const mat = usesAuthoredAsset
      ? sourceMat.clone()
      : new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    // Keep the authored stone/brick texture legible. A dark palette multiply
    // made the whole wall read as a flat neon slab once emissive was added.
    if (mat.color) mat.color.setHex(0xb9c2cb).lerp(new THREE.Color(wallColor), 0.28);
    if (!mat.emissive) mat.emissive = new THREE.Color(glowColor);
    else mat.emissive.setHex(glowColor);
    mat.emissiveIntensity = 0.0;
    mat.transparent = true;
    mat.opacity = 0.0;
    mat.depthWrite = true;
    mat.needsUpdate = true;
    return mat;
  }

  const group = new THREE.Group();
  group.name = `lockdownArena:${arena.id}`;
  group.visible = false;

  // 4 doors arranged on cardinal arcs around center
  // North: +Z face, rotation about Y so door's long axis lies along X
  // South: -Z face, same rotation
  // East:  +X face, rotation 90° about Y so long axis lies along Z
  // West:  -X face, rotation 90° about Y
  const restY = DOOR_REST_Y; // authored geometry has its feet at local y=0
  const offset = radius + DOOR_THICK / 2;
  const segmentCount = Math.max(1, Math.ceil(spanLen / segmentWidth));
  const segmentStep = spanLen / segmentCount;
  const segmentScaleX = Math.min(1.08, segmentStep / segmentWidth * 1.03);
  const instanceMatrix = new THREE.Matrix4();

  const doors = {};
  const materials = [];
  const _addDoor = (name, dx, dz, rotY) => {
    const mat = _makeWallMat();
    materials.push(mat);
    const mesh = new THREE.InstancedMesh(sourceGeo, mat, segmentCount);
    for (let i = 0; i < segmentCount; i++) {
      const x = (i - (segmentCount - 1) * 0.5) * segmentStep;
      instanceMatrix.compose(
        new THREE.Vector3(x, 0, 0),
        new THREE.Quaternion(),
        new THREE.Vector3(segmentScaleX, 1, 1),
      );
      mesh.setMatrixAt(i, instanceMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `lockdownWall_${name}`;
    mesh.userData.assetKey = usesAuthoredAsset ? 'kkd_wall' : 'fallback';
    mesh.position.set(center.x + dx, restY, center.z + dz);
    mesh.rotation.y = rotY;
    mesh.userData.targetY = restY;
    mesh.userData.dx = dx;
    mesh.userData.dz = dz;
    group.add(mesh);
    doors[name] = mesh;
  };

  _addDoor('north', 0,       offset,  0);
  _addDoor('south', 0,      -offset,  0);
  _addDoor('east',  offset,  0,       Math.PI / 2);
  _addDoor('west', -offset,  0,       Math.PI / 2);

  // Use far halfSpan to ensure doors visually overlap at the corners
  // (slab corners meet ~radius+thick offset, span is 1.8×radius long;
  // overlap is small but visible enough to read as "sealed").
  void halfSpan; // referenced for future tuning; suppress unused-var lint

  arena.doors = {
    group,
    north: doors.north,
    south: doors.south,
    east:  doors.east,
    west:  doors.west,
    materials,
    sharedGeometry: sourceGeo,
    usesAuthoredAsset,
  };
}

// ─── per-tick: door animation ─────────────────────────────────────────────────
function _tickDoorAnim(arena, dt) {
  const { state: aState, doors } = arena;
  if (!doors) return;

  if (aState === 'slamming') {
    arena.slamT += dt;
    const k = Math.min(1, arena.slamT / SLAM_DURATION);
    // ease-out cubic for the drop
    const ease = 1 - Math.pow(1 - k, 3);
    const startY = SLAM_START_Y + DOOR_REST_Y;
    const endY = DOOR_REST_Y;
    const y = startY + (endY - startY) * ease;
    const opacity = k; // fade-in alongside drop so doors don't pop into view
    const rim = (1 - k) * GLOW_RIM_INTENSITY + PULSE_MIN * k;

    for (const name of ['north', 'south', 'east', 'west']) {
      const d = doors[name];
      if (!d) continue;
      d.position.y = y;
      d.material.opacity = opacity;
      d.material.emissiveIntensity = rim;
    }
    if (k >= 1) {
      arena.state = 'active';
      arena.slamT = 0;
    }
  } else if (aState === 'active') {
    // Bio-glow pulse — emissive sin between PULSE_MIN and PULSE_MAX
    const t = state.time.real;
    const phase = (Math.sin(t * Math.PI * 2 * PULSE_HZ) + 1) * 0.5; // 0..1
    const e = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * phase;
    for (const m of doors.materials) {
      m.emissiveIntensity = e;
      m.opacity = 1.0;
    }
  } else if (aState === 'retracting') {
    arena.retractT += dt;
    const k = Math.min(1, arena.retractT / RETRACT_DURATION);
    const ease = k * k; // ease-in (lift accelerates)
    const startY = DOOR_REST_Y;
    const endY = SLAM_START_Y + DOOR_REST_Y;
    const y = startY + (endY - startY) * ease;
    const opacity = 1 - k;
    // amber flash: glow lerps from clear color back to wall slot at the very end
    const clearColor = arena.paletteSlots.clear;
    for (const m of doors.materials) {
      m.opacity = opacity;
      m.emissiveIntensity = 2.0 * (1 - k * 0.6);
      // Briefly tint emissive toward "clear" slot for the retract punctuation.
      // Only set once at start (k<0.05) to avoid per-frame Color allocs.
      if (arena.retractT - dt <= 0 && m.emissive) {
        m.emissive.setHex(clearColor);
      }
    }
    for (const name of ['north', 'south', 'east', 'west']) {
      const d = doors[name];
      if (d) d.position.y = y;
    }
    if (k >= 1) {
      arena.state = 'idle';
      arena.retractT = 0;
      if (doors.group) doors.group.visible = false;
      // Reset emissive back to glow slot so the next trigger reads "active glow"
      // rather than "clear amber" on the first slam-in pulse.
      for (const m of doors.materials) {
        if (m.emissive) m.emissive.setHex(arena.paletteSlots.glow);
      }
    }
  }
}

// ─── wave dispatcher (substitutes for spawnDirector cadence) ──────────────────

/**
 * Pick one wave-spawn position on the arena's inner ring. Angles avoid the
 * escape gap (gapArc > 0 on the first sub-burst) and re-rolls keep the
 * candidate farthest from the hero — so when the 10u floor is unreachable
 * inside a small arena, placement clamps to the farthest available ring
 * points instead of landing on top of the hero.
 */
function _placeWaveSpawn(arena, gapAngle, gapArc) {
  const r = arena.radius * 0.85; // spawn just inside the door ring
  const cx = arena.center.x, cz = arena.center.z;
  const hero = state.hero && state.hero.pos;
  const hx = hero ? hero.x : cx;
  const hz = hero ? hero.z : cz;
  const heroDist = Math.hypot(hx - cx, hz - cz);
  // Farthest hero→ring distance is heroDist + r; clamp the floor under it
  // so the accept test below can always terminate.
  const floor = Math.min(MIN_SPAWN_DIST, heroDist + r - 0.75);
  const floor2 = floor * floor;
  const span = Math.PI * 2 - gapArc;
  let bx = cx + r, bz = cz, bd2 = -1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = (gapArc > 0)
      ? gapAngle + gapArc * 0.5 + Math.random() * span
      : Math.random() * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const dx = x - hx, dz = z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= floor2) return { x, z };
    if (d2 > bd2) { bd2 = d2; bx = x; bz = z; }
  }
  return { x: bx, z: bz };
}

/**
 * Build a wave's spawn list and queue it as a drip (arena.drip). Spawning
 * happens in _tickWaveDrip — first sub-burst lands the same tick this is
 * called, the rest spread across WAVE_DRIP_SEC. Total count unchanged from
 * the old single-beat dispatch.
 */
function _queueWave(arena, waveIdx) {
  // Mirror spawnDirector.computeDifficulty without import-cycle pain — read
  // the same SPAWN constants and use state.time.game directly.
  const t = state.time.game;
  let D;
  if (t <= 0) D = 0;
  else if (t < SPAWN.difficultyRampSec) D = t / SPAWN.difficultyRampSec;
  else if (t < SPAWN.difficultyMaxSec) {
    const span = SPAWN.difficultyMaxSec - SPAWN.difficultyRampSec;
    const k = (t - SPAWN.difficultyRampSec) / span;
    D = 1 + k * (SPAWN.difficultyMax - 1);
  } else {
    D = SPAWN.difficultyMax;
  }

  // Use non-elite tiers unlocked at current D for mob fodder. Wave 3 has a
  // small chance to swap in an elite (the "skill window" mob — killing it
  // clears the lockdown early).
  const allowed = ENEMY_TIERS.filter(tier => tier.minD <= D && !tier.elite);
  const eliteAllowed = ENEMY_TIERS.filter(tier => tier.minD <= D + 1 && tier.elite);
  const pool = allowed.length > 0 ? allowed : ENEMY_TIERS.filter(tier => !tier.elite);

  const count = _waveCount(D);
  arena.mobsThisWave = 0;
  // Dispatch flag decouples wave-advance from spawn SUCCESS: if every spawn
  // fails (pool exhaustion/GLB not loaded), mobsThisWave stays 0 and the old
  // `mobsThisWave > 0` advance test trapped the player until the watchdog.
  arena.waveDispatched = true;

  const entries = [];
  // Wave 3 elite gate — coin-flip (50%) to inject one elite from the eligible
  // pool. Tagging it _lockdownElite lets the clear scan early-exit the run.
  // Elite rides the FIRST sub-burst so the skill window opens immediately.
  const injectElite = (waveIdx === 2) && eliteAllowed.length > 0 && Math.random() < 0.5;
  if (injectElite) {
    entries.push({
      tier: eliteAllowed[Math.floor(Math.random() * eliteAllowed.length)],
      elite: true,
    });
  }
  for (let i = 0; i < count; i++) {
    entries.push({ tier: pool[Math.floor(Math.random() * pool.length)], elite: false });
  }

  // Escape gap OFFSET 90-135° off the hero's bearing — a gap centered where
  // the player already stands is invisible (safety delivered to their feet,
  // no dash decision). Offset means the player must read the wall and move
  // through it. Bearing is meaningless at dead center; fall back to random.
  const hero = state.hero && state.hero.pos;
  const dxh = hero ? hero.x - arena.center.x : 0;
  const dzh = hero ? hero.z - arena.center.z : 0;
  const gapAngle = (dxh * dxh + dzh * dzh > 0.25)
    ? Math.atan2(dzh, dxh)
      + (Math.random() < 0.5 ? 1 : -1) * (Math.PI * 0.5 + Math.random() * Math.PI * 0.25)
    : Math.random() * Math.PI * 2;

  arena.drip = {
    waveIdx,
    entries,
    cursor: 0,            // next entry to spawn
    burstIdx: 0,
    nextBurstAt: t,       // first sub-burst fires this tick
    gapAngle,
  };
}

/**
 * Advance the wave drip. Each sub-burst is STAGED 0.45s before it
 * materializes: positions are rolled at stage time and marked with pulsing
 * ground decals (the leap-marker pool — auto-expires when not refreshed), so
 * the player reads a near-complete ring of warnings with one dark slice (the
 * escape gap) BEFORE anything can hit them.
 */
const SPAWN_TELL_SEC = 0.45;
function _tickWaveDrip(arena, t) {
  const drip = arena.drip;
  if (!drip) return;
  // Materialize staged spawns first; refresh tells on those still pending.
  if (drip.staged && drip.staged.length) {
    for (let i = drip.staged.length - 1; i >= 0; i--) {
      const s = drip.staged[i];
      if (t < s.at) {
        try { setLeapMarker(s.x, s.z, s.at - t, SPAWN_TELL_SEC, s); } catch (_) {}
        continue;
      }
      try { clearLeapMarker(s); } catch (_) {}
      drip.staged.splice(i, 1);
      let e = null;
      try { e = spawnEnemy(s.entry.tier, s.x, s.z); } catch (_) {}
      if (!e) continue; // pool exhaustion — skip tag, totals tracked by mobsThisWave
      e._lockdownWave = drip.waveIdx;
      e._lockdownElite = !!s.entry.elite;
      e._lockdownArenaId = arena.id;
      arena.mobsThisWave++;
      if (s.entry.elite) {
        arena.eliteSpawned = true;
        if (state.run) state.run.lockdownEliteSeen = true;
      }
    }
  }
  if (drip.cursor >= drip.entries.length) {
    if (!drip.staged || drip.staged.length === 0) arena.drip = null;
    return;
  }
  if (t < drip.nextBurstAt) return;
  const total = drip.entries.length;
  // Front-loaded split (WAVE_BURST_W); the final burst flushes the cursor so
  // rounding never strands entries.
  const isLast = drip.burstIdx >= WAVE_SUB_BURSTS - 1;
  const n = isLast
    ? (total - drip.cursor)
    : Math.max(1, Math.round(total * (WAVE_BURST_W[drip.burstIdx] || 0.1)));
  const gapArc = (drip.burstIdx === 0) ? ESCAPE_GAP_ARC : 0;
  if (!drip.staged) drip.staged = [];
  for (let i = 0; i < n && drip.cursor < total; i++) {
    const entry = drip.entries[drip.cursor++];
    const p = _placeWaveSpawn(arena, drip.gapAngle, gapArc);
    drip.staged.push({ entry, x: p.x, z: p.z, at: t + SPAWN_TELL_SEC });
  }
  drip.burstIdx++;
  drip.nextBurstAt = t + WAVE_DRIP_SEC / (WAVE_SUB_BURSTS - 1);
}

// ─── clear detection ──────────────────────────────────────────────────────────
// Returns true if (a) any elite tagged for this arena is dead, OR
// (b) all currently-tagged mobs (across all waves) are dead AND wavesCleared
// has reached 3.
function _checkClear(arena) {
  let aliveTagged = 0;
  let eliteAlive = 0;
  let eliteDeadSeen = false;
  const active = state.enemies.active;
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || e._lockdownArenaId !== arena.id) continue;
    if (e.alive) {
      aliveTagged++;
      if (e._lockdownElite) eliteAlive++;
    } else if (e._lockdownElite) {
      eliteDeadSeen = true;
    }
  }
  // Early clear via elite kill: the spawned-elite was alive last frame, dead
  // this frame. We detect by "elite tag exists in the list AND not alive".
  // (Dead enemies linger in state.enemies.active for a few frames before
  // killEnemy removes them — that's our detection window.)
  if (arena.eliteSpawned && eliteAlive === 0 && eliteDeadSeen) {
    return { cleared: true, reason: 'elite' };
  }
  // Wave-progression clear: each wave's mobs must all be dead before we
  // advance. Track the "current wave" via arena.waveIdx and only count
  // aliveTagged that match it. A wave with sub-bursts still queued is NOT
  // clearable — else killing the first sub-burst fast would advance the wave
  // and orphan the pending drip onto a stale waveIdx.
  const waveStillAlive = active.some(e =>
    e && e.alive && e._lockdownArenaId === arena.id && e._lockdownWave === arena.waveIdx
  );
  if (!waveStillAlive && arena.waveDispatched && !arena.drip) {
    return { cleared: false, advance: true, reason: 'wave-cleared' };
  }
  // Defensive total-empty check (covers the all-3-waves edge if mobsThisWave
  // tracking ever drifts): if 3 waves were dispatched + no tagged mobs alive.
  if (arena.wavesCleared >= 3 && aliveTagged === 0) {
    return { cleared: true, reason: 'all-waves' };
  }
  return { cleared: false };
}

// ─── reward bundle ────────────────────────────────────────────────────────────
function _queueRewardBundle(arena) {
  // Pickups allocate/update their own pooled visuals. Releasing all nine at
  // once made the clear punctuation the second largest lockdown frame. Queue
  // one gem per short beat; the value and final chest are unchanged.
  arena.rewardQueue = { gemIndex: 0, nextAt: state.time.game, chestDropped: false };

  // FX punctuation is intentionally immediate; only the pickup work is
  // spread across frames.
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.9);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.4);
  }
  try { if (sfx && sfx.eliteDeath) sfx.eliteDeath(); } catch (_) {}
}

function _tickRewardBundle(arena, t) {
  const queue = arena.rewardQueue;
  if (!queue || t < queue.nextAt) return;
  const cx = arena.center.x;
  const cz = arena.center.z;

  if (queue.gemIndex < 8) {
    const i = queue.gemIndex++;
    const a = (i / 8) * Math.PI * 2;
    const r = 1.2 + Math.random() * 0.6;
    try { dropGem(new THREE.Vector3(cx + Math.cos(a) * r, 0.3, cz + Math.sin(a) * r), 3); } catch (_) {}
    queue.nextAt = t + 0.075;
    return;
  }
  if (!queue.chestDropped) {
    queue.chestDropped = true;
    try { spawnChest(cx, cz); } catch (e) { console.warn('[lockdownArena] spawnChest failed:', e); }
  }
  arena.rewardQueue = null;
}

// ─── public API ───────────────────────────────────────────────────────────────
export function initLockdownArena(scene) {
  _scene = scene;
}

/**
 * Register a lockdown arena. Pre-builds door geometry at this call (zero
 * allocation at trigger time). Returns the arena id used by triggerLockdown.
 *
 * @param {object} opts
 * @param {{x:number,z:number}} opts.center   World-space center
 * @param {number} opts.radius                Arena radius (world units, default 8)
 * @param {{wall:number, glow:number, clear:number}} opts.paletteSlots
 *        Hex color numbers (use stage's locked palette slots).
 * @returns {number} arenaId
 */
export function armLockdown(opts) {
  if (!_scene) { console.warn('[lockdownArena] armLockdown called before initLockdownArena'); return -1; }
  if (!opts || !opts.center) { console.warn('[lockdownArena] armLockdown missing opts.center'); return -1; }
  const id = _nextArenaId++;
  const arena = {
    id,
    center: { x: opts.center.x, z: opts.center.z },
    radius: opts.radius || 8,
    paletteSlots: {
      wall:  (opts.paletteSlots && opts.paletteSlots.wall)  || 0x2d3a55,
      glow:  (opts.paletteSlots && opts.paletteSlots.glow)  || 0x7df0c4,
      clear: (opts.paletteSlots && opts.paletteSlots.clear) || 0xf5a300,
    },
    doors: null,
    state: 'idle',
    slamT: 0,
    retractT: 0,
    waveIdx: 0,
    wavesCleared: 0,
    nextWaveAt: 0,
    mobsThisWave: 0,
    eliteSpawned: false,
    activeArena: false,
    drip: null,
    rewardQueue: null,
  };
  _buildDoorMeshes(arena);
  _scene.add(arena.doors.group);
  _arenas.push(arena);
  return id;
}

/**
 * Activate a previously-armed arena. Returns true if the lockdown started,
 * false if another lockdown is already live (single-active rule).
 */
export function triggerLockdown(arenaId) {
  if (_activeArenaId != null) return false; // single-active rule
  const arena = _arenas.find(a => a.id === arenaId);
  if (!arena) { console.warn('[lockdownArena] triggerLockdown: unknown arena', arenaId); return false; }
  if (arena.state !== 'idle') return false;

  _activeArenaId = arenaId;
  arena.activeArena = true;
  arena.state = 'slamming';
  arena.slamT = 0;
  arena.retractT = 0;
  arena.waveIdx = 0;
  arena.wavesCleared = 0;
  arena.mobsThisWave = 0;
  arena.eliteSpawned = false;
  arena.drip = null;
  arena.rewardQueue = null;
  arena.triggeredAt = state.time.game; // watchdog timestamp for force-clear safety net

  // Reveal door group + reset opacity (in case a prior run left them hidden
  // mid-fade). The pulse loop in _tickDoorAnim will rewrite per frame.
  if (arena.doors && arena.doors.group) {
    arena.doors.group.visible = true;
    for (const m of arena.doors.materials) {
      m.opacity = 0.0;
      m.emissiveIntensity = 0.0;
    }
  }

  // Mirror to run-state so spawnDirector + UI can read.
  if (state.run) {
    state.run.lockdownActive = true;
    state.run.lockdownWavesCleared = 0;
    state.run.lockdownEliteSeen = false;
  }

  // First wave dispatches right when slam-in completes; queue it now.
  arena.nextWaveAt = state.time.game + SLAM_DURATION;

  // Wave banner — slot 8 cyan-white per Forest spec
  try { showBanner('LOCKDOWN — WAVE 1/3', 2.0, '#a8e6ff'); } catch (_) {}
  if (state.fx) {
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
    state.fx.shake = Math.max(state.fx.shake || 0, 0.3);
  }
  return true;
}

/**
 * Per-frame tick. Drives door animation, wave dispatcher, clear detection,
 * and hero containment clamp. Call once per frame from main.js (after
 * spawnDirector so wave spawns happen on the same frame the director would
 * have run a top-up).
 */
export function tickLockdownArena(dt) {
  // Anim all arenas (idle ones early-out inside _tickDoorAnim)
  for (let i = 0; i < _arenas.length; i++) {
    _tickDoorAnim(_arenas[i], dt);
    _tickRewardBundle(_arenas[i], state.time.game);
  }

  if (_activeArenaId == null) return;
  const arena = _arenas.find(a => a.id === _activeArenaId);
  if (!arena) { _activeArenaId = null; return; }

  // Hero containment clamp — soft push back inside radius. Only while doors
  // are actively up (slamming/active/retracting all count; retracting still
  // keeps the player inside for the reward beat).
  const hero = state.hero;
  if (hero && hero.pos && arena.state !== 'idle') {
    const dx = hero.pos.x - arena.center.x;
    const dz = hero.pos.z - arena.center.z;
    const d2 = dx * dx + dz * dz;
    const maxR = arena.radius - CONTAINMENT_EPS;
    if (d2 > maxR * maxR) {
      const d = Math.sqrt(d2);
      const k = maxR / d;
      hero.pos.x = arena.center.x + dx * k;
      hero.pos.z = arena.center.z + dz * k;
      if (hero.mesh && hero.mesh.position) {
        hero.mesh.position.x = hero.pos.x;
        hero.mesh.position.z = hero.pos.z;
      }
    }
  }

  // Wave + clear logic only runs while doors are up (active state).
  if (arena.state !== 'active') return;

  // Watchdog: if lockdown has been active for >90s without resolving, force-
  // clear. Protects against edge cases (death-respawn, lost enemy tags,
  // spawnEnemy returning null, etc.) where the player would otherwise be
  // trapped indefinitely.
  if (arena.triggeredAt && (state.time.game - arena.triggeredAt) > 90) {
    arena.state = 'retracting';
    arena.retractT = 0;
    arena.activeArena = false;
    arena.drip = null;
    _activeArenaId = null;
    if (state.run) state.run.lockdownActive = false;
    try { showBanner('LOCKDOWN TIMED OUT', 2.2, '#ff7a52'); } catch (_) {}
    _queueRewardBundle(arena);
    return;
  }

  // Dispatch next wave if due. Gate via nextWaveAt = +Infinity so we only
  // dispatch ONCE per wave (else this fires every tick at 60/s, spawning
  // hundreds of mobs/sec and freezing the game — first-playtest bug 2026-05-16).
  const t = state.time.game;
  if (arena.waveIdx < 3 && t >= arena.nextWaveAt && Number.isFinite(arena.nextWaveAt)) {
    _queueWave(arena, arena.waveIdx);
    arena.nextWaveAt = Number.POSITIVE_INFINITY; // re-armed by wave-advance below
  }

  // Drip the queued wave in sub-bursts (first sub-burst lands the same tick
  // the wave is queued; spec FIX 2 ramp-in).
  _tickWaveDrip(arena, t);

  // Check clear / wave-advance
  const res = _checkClear(arena);
  if (res.cleared) {
    arena.state = 'retracting';
    arena.retractT = 0;
    arena.activeArena = false;
    arena.drip = null; // cancel pending sub-bursts (elite-kill early clear)
    _activeArenaId = null;
    if (state.run) {
      state.run.lockdownActive = false;
      // wavesCleared mirror: full clear via elite still counts the waves
      // actually completed; full-clear path bumps to 3.
      if (res.reason === 'all-waves') state.run.lockdownWavesCleared = 3;
    }
    try { showBanner('LOCKDOWN CLEARED', 2.2, '#ffd86b'); } catch (_) {}
    _queueRewardBundle(arena);
    return;
  }
  if (res.advance) {
    arena.waveIdx++;
    arena.wavesCleared++;
    arena.mobsThisWave = 0; // reset so next wave's _checkClear "advance" condition needs a fresh non-empty wave
    arena.waveDispatched = false;
    if (state.run) state.run.lockdownWavesCleared = arena.wavesCleared;
    if (arena.waveIdx < 3) {
      arena.nextWaveAt = t + WAVE_INTERVAL_SEC;
      const label = `LOCKDOWN — WAVE ${arena.waveIdx + 1}/3`;
      try { showBanner(label, 2.0, '#a8e6ff'); } catch (_) {}
    } else {
      // All 3 waves dispatched + all dead — next tick will hit the
      // wavesCleared>=3 + aliveTagged===0 branch and clear.
      arena.nextWaveAt = Number.POSITIVE_INFINITY;
    }
  }
}

/**
 * Run-reset hook: wipe per-arena live state (waves, active) but keep the
 * registered arenas + door meshes around (cheap; re-armed next run).
 */
export function resetLockdownArenas() {
  for (const arena of _arenas) {
    arena.state = 'idle';
    arena.slamT = 0;
    arena.retractT = 0;
    arena.waveIdx = 0;
    arena.wavesCleared = 0;
    arena.nextWaveAt = 0;
    arena.mobsThisWave = 0;
    arena.waveDispatched = false;
    arena.eliteSpawned = false;
    arena.activeArena = false;
    arena.drip = null;
    arena.rewardQueue = null;
    if (arena.doors) {
      arena.doors.group.visible = false;
      for (const m of arena.doors.materials) {
        m.opacity = 0.0;
        m.emissiveIntensity = 0.0;
        if (m.emissive) m.emissive.setHex(arena.paletteSlots.glow);
      }
      for (const name of ['north', 'south', 'east', 'west']) {
        const d = arena.doors[name];
        if (d) d.position.y = DOOR_REST_Y;
      }
    }
  }
  _activeArenaId = null;
  if (state.run) {
    state.run.lockdownActive = false;
    state.run.lockdownWavesCleared = 0;
    state.run.lockdownEliteSeen = false;
  }
}

/**
 * Full teardown — removes door meshes from scene + disposes geometry/materials.
 * Call from the run-reset path (paired with clearArenaDecor / clearForestAmber).
 */
export function disposeLockdownArenas(scene) {
  const s = scene || _scene;
  for (const arena of _arenas) {
    if (!arena.doors) continue;
    if (arena.doors.group && arena.doors.group.parent) {
      arena.doors.group.parent.remove(arena.doors.group);
    } else if (s && arena.doors.group) {
      s.remove(arena.doors.group);
    }
    if (arena.doors.sharedGeometry) arena.doors.sharedGeometry.dispose();
    for (const name of ['north', 'south', 'east', 'west']) {
      const d = arena.doors[name];
      if (d) {
        if (d.material && d.material.dispose) d.material.dispose();
        if (d.dispose) d.dispose();
      }
    }
    arena.doors = null;
  }
  _arenas.length = 0;
  _nextArenaId = 1;
  _activeArenaId = null;
  if (state.run) {
    state.run.lockdownActive = false;
    state.run.lockdownWavesCleared = 0;
    state.run.lockdownEliteSeen = false;
  }
}
