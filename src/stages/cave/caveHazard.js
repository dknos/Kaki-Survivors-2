/**
 * Cave-in environmental hazard (P4A cohort 13, 2026-05-21).
 *
 * The cave's signature environmental threat — the answer to the forest's
 * spore-puff hazards (src/forestEnvHazards.js) and the boss shockwave
 * telegraph (src/bossTelegraphs.js). Periodically a stretch of ceiling gives
 * way: a sigil-rune danger ring blooms on the floor near the hero, pulses for
 * a ~1.3s wind-up, then a stone chunk plummets from the vault and slams down.
 * Stand in the ring at impact → take a hit; walk or dash clear → safe. Fully
 * telegraphed, fully dodgeable — same counterplay grammar as the boss tells.
 *
 * Visual quality bar (feedback_kitty_kaki_fx_quality — SHIP-BLOCKER):
 *   - The danger ring is the canonical `makeRuneRingTexture()` art on a
 *     `floorDecalMaterial` plane (additive + depthWrite off), pinned to the
 *     `telegraph` floor tier (renderOrder -3, bloom on) via `applyFloorTier`.
 *     NOT a flat RingGeometry + MeshBasicMaterial (the explicit anti-pattern).
 *   - Ring tint = CAVE_PALETTE.sigil (0xc87bff) — slot 4, reserved for cave
 *     hazard rings per cavePalette.js.
 *   - Impact debris reuses the shared fx.js pools (spawnKillRing dust pop +
 *     spawnMagnetSpark shards) — no bespoke texture.
 *   - The falling chunk is a slot-2 stone boulder (flatShading), no emissive —
 *     the danger glow lives entirely in the ring, the rock reads as mass.
 *
 * Architecture (mirrors caveGloomshrimp.js):
 *   buildCaveHazard(parent)  — pools the ring + boulder meshes under a named
 *                              group; returns { group, count } (count = pool
 *                              size) for the caveStage userData probe.
 *   tickCaveHazard(dt)       — self-gated dispatcher + wind-up + impact + fade.
 *                              Reads hero pos from the shared state import;
 *                              does not fire while the hero is dead.
 *   disposeCaveHazard()      — idempotent teardown of geo + materials.
 *   getCaveHazardTotalSpawned() — monotonic counter for the smoke probe
 *                              (counter-based, sidesteps catching a falling
 *                              boulder mid-air).
 *
 * Constraints honored:
 *   - Static imports only ([[feedback_kks_export_origin_module_break.md]]).
 *   - Zero per-frame allocation (fixed mesh pool + scalar math, scratch only).
 *   - Self-gated dispatcher: `_nextSpawnAt` always advances, even when the
 *     pool is saturated or the hero is dead ([[feedback_kks_wave_dispatcher_throttle]]).
 *   - 5-color palette: slot-2 boulder, slot-4 sigil ring.
 *   - Hero damage via the shared hero.takeDamage (i-frame-aware) — same path
 *     the boss shockwave uses, never a bespoke damage write.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';
import { state } from '../../state.js';
import { makeRuneRingTexture } from '../../enemyTells.js';
import { floorDecalGeometry, floorDecalMaterial, applyFloorTier } from '../../fxLayers.js';
import { takeDamage as heroTakeDamage } from '../../hero.js';
import { spawnKillRing, spawnMagnetSpark } from '../../fx.js';

const POOL          = 4;       // max concurrent cave-ins
const WINDUP        = 1.3;     // s — ground ring telegraph before impact
const ROCK_VISIBLE  = 0.55;    // s — boulder is falling for the last slice of windup
const CEILING_Y     = 6.5;     // boulder spawn height
const IMPACT_RADIUS = 5.5;     // u — danger radius (ring shows exactly this)
const IMPACT_DMG    = 17;      // matches the boss mini-shockwave band (14-26)
const FADE          = 0.28;    // s — ring fade-out after impact
const SHAKE         = 0.42;    // state.fx.shake bump on impact
const DEBRIS        = 7;       // shard sparks per impact

const FIRST_DELAY   = 4.0;     // s — first cave-in comes early so the player meets the (telegraphed) mechanic
const INT_MIN       = 8;       // s — dispatcher interval band thereafter
const INT_MAX       = 14;
const VOLLEY_MAX    = 3;       // up to N cave-ins per volley
const OFFSET_MIN    = 4;       // u — keep clear of the hero's exact spot
const OFFSET_MAX    = 14;

const RING_GROW_FROM = 0.62;   // ring scale lerps from this fraction → full

// Slot states
const IDLE = 0, WINDUP_S = 1, FADE_S = 2;

let _state = null;             // { group, ringGeo, ringMats[], ringMeshes[], rockGeo, rockMat, rockMeshes[] }
let _slots = null;             // per-slot motion/phase (plain objects, built once — no per-frame alloc)
let _nextSpawnAt = 0;
let _clock = 0;
let _totalSpawned = 0;

/**
 * Build the hazard mesh pool under `parent` (the caveStage group). Returns
 * { group, count } so caveStage can stash userData.caveHazardCount. Idempotent.
 */
export function buildCaveHazard(parent) {
  if (_state) disposeCaveHazard();
  if (!parent) return { group: null, count: 0 };

  const group = new THREE.Group();
  group.name = 'caveStage_hazardGroup';

  // ── Danger rings: rune-textured floor decals, one material clone per slot
  // (opacity animates per wind-up, so per-slot materials are correct — same
  // reasoning as the boss-telegraph pool). 2x2 plane scaled to the radius.
  const ringTex = makeRuneRingTexture();
  const ringGeo = floorDecalGeometry(2, 2);
  const ringMats = [];
  const ringMeshes = [];
  for (let i = 0; i < POOL; i++) {
    const mat = floorDecalMaterial({ map: ringTex, color: CAVE_PALETTE.sigil, opacity: 0 });
    const mesh = new THREE.Mesh(ringGeo, mat);
    applyFloorTier(mesh, 'telegraph');   // renderOrder -3 + bloom on
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.name = 'caveStage_hazardRing';
    group.add(mesh);
    ringMats.push(mat);
    ringMeshes.push(mesh);
  }

  // ── Falling boulders: rough slot-2 stone, flatShading, no emissive. Shared
  // geo + material across the pool (only position/rotation animate).
  const rockGeo = new THREE.IcosahedronGeometry(0.55, 0);
  const rockMat = new THREE.MeshStandardMaterial({
    color: CAVE_PALETTE.stone,
    roughness: 0.92,
    metalness: 0.04,
    flatShading: true,
  });
  const rockMeshes = [];
  for (let i = 0; i < POOL; i++) {
    const mesh = new THREE.Mesh(rockGeo, rockMat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.name = 'caveStage_hazardRock';
    group.add(mesh);
    rockMeshes.push(mesh);
  }

  _slots = [];
  for (let i = 0; i < POOL; i++) {
    _slots.push({ st: IDLE, t: 0, x: 0, z: 0, spin: 0, spinAxis: 0 });
  }

  parent.add(group);
  _state = { group, ringTex, ringGeo, ringMats, ringMeshes, rockGeo, rockMat, rockMeshes };
  _clock = 0;
  _totalSpawned = 0;
  _nextSpawnAt = FIRST_DELAY;
  return { group, count: POOL };
}

function _freeSlot() {
  for (let i = 0; i < POOL; i++) if (_slots[i].st === IDLE) return i;
  return -1;
}

// Arm one cave-in at (x,z). Caller guarantees a free slot.
function _arm(i, x, z) {
  const s = _slots[i];
  s.st = WINDUP_S;
  s.t = 0;
  s.x = x;
  s.z = z;
  s.spin = 0;
  s.spinAxis = Math.random() * Math.PI * 2;
  _state.ringMeshes[i].position.set(x, 0.02, z);
  _state.ringMeshes[i].visible = true;
  _totalSpawned++;
}

/**
 * Per-frame dispatcher + wind-up + impact + fade. Self-gated: no _state (a
 * non-cave run) is a free no-op. The scheduler always advances even when the
 * pool is saturated or the hero is dead, so it never stalls.
 */
export function tickCaveHazard(dt) {
  if (!_state) return;
  if (!Number.isFinite(dt) || dt <= 0) return;
  _clock += dt;

  const heroPos = state && state.hero && state.hero.pos;
  const heroLive = !!heroPos && !state.gameOver;

  // ── Dispatcher: fire a volley of 1..VOLLEY_MAX cave-ins near the hero.
  if (_clock >= _nextSpawnAt) {
    _nextSpawnAt = _clock + INT_MIN + Math.random() * (INT_MAX - INT_MIN);
    if (heroLive) {
      const want = 1 + Math.floor(Math.random() * VOLLEY_MAX);
      for (let n = 0; n < want; n++) {
        const slot = _freeSlot();
        if (slot < 0) break;
        const ang = Math.random() * Math.PI * 2;
        const off = OFFSET_MIN + Math.random() * (OFFSET_MAX - OFFSET_MIN);
        _arm(slot, heroPos.x + Math.cos(ang) * off, heroPos.z + Math.sin(ang) * off);
      }
    }
  }

  // ── Advance each active slot.
  for (let i = 0; i < POOL; i++) {
    const s = _slots[i];
    if (s.st === IDLE) continue;
    const ring = _state.ringMeshes[i];
    const mat = _state.ringMats[i];
    const rock = _state.rockMeshes[i];

    if (s.st === WINDUP_S) {
      s.t += dt;
      const p = Math.min(1, s.t / WINDUP);            // 0..1 wind-up progress
      // Ring grows + brightens, with a danger pulse that quickens near impact.
      const scl = (RING_GROW_FROM + (1 - RING_GROW_FROM) * p) * IMPACT_RADIUS;
      ring.scale.setScalar(scl);
      const pulse = 0.5 + 0.5 * Math.sin(_clock * (6 + 10 * p));
      mat.opacity = (0.35 + 0.5 * p) * (0.6 + 0.4 * pulse);

      // Boulder drops for the last ROCK_VISIBLE seconds of the wind-up, hitting
      // the floor exactly at impact. Ease-in (p^2) reads as gravity.
      const fallLeft = WINDUP - s.t;
      if (fallLeft <= ROCK_VISIBLE) {
        const fp = 1 - (fallLeft / ROCK_VISIBLE);     // 0..1 fall progress
        rock.visible = true;
        rock.position.set(s.x, CEILING_Y * (1 - fp * fp), s.z);
        s.spin += dt * 6;
        rock.rotation.set(s.spin, s.spinAxis, s.spin * 0.6);
      }

      if (s.t >= WINDUP) {
        // ── IMPACT.
        rock.visible = false;
        if (heroLive) {
          const dx = heroPos.x - s.x;
          const dz = heroPos.z - s.z;
          if (dx * dx + dz * dz <= IMPACT_RADIUS * IMPACT_RADIUS) {
            heroTakeDamage(IMPACT_DMG);               // i-frame-aware
          }
        }
        if (state.fx) state.fx.shake = Math.max(state.fx.shake || 0, SHAKE);
        try { spawnKillRing(s.x, s.z, true); } catch (_) {}   // dust pop (bloom)
        for (let d = 0; d < DEBRIS; d++) {
          const a = (d / DEBRIS) * Math.PI * 2;
          const rr = 0.6 + Math.random() * (IMPACT_RADIUS * 0.7);
          try {
            spawnMagnetSpark(s.x + Math.cos(a) * rr, 0.35, s.z + Math.sin(a) * rr, CAVE_PALETTE.amber);
          } catch (_) {}
        }
        // Flash the ring bright, then fade.
        mat.opacity = 0.95;
        ring.scale.setScalar(IMPACT_RADIUS);
        s.st = FADE_S;
        s.t = 0;
      }
    } else if (s.st === FADE_S) {
      s.t += dt;
      const p = Math.min(1, s.t / FADE);
      mat.opacity = 0.95 * (1 - p);
      if (s.t >= FADE) {
        ring.visible = false;
        mat.opacity = 0;
        s.st = IDLE;
      }
    }
  }
}

/** Monotonic count of cave-ins armed since build — smoke probe accessor. */
export function getCaveHazardTotalSpawned() {
  return _totalSpawned;
}

/** Idempotent teardown of geometry + materials. Safe when not mounted. */
export function disposeCaveHazard() {
  if (!_state) return false;
  const { group, ringTex, ringGeo, ringMats, rockGeo, rockMat } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { ringTex && ringTex.dispose(); } catch (_) {}   // shared across all ring mats — drop once
  try { ringGeo && ringGeo.dispose(); } catch (_) {}
  for (const m of ringMats) { try { m && m.dispose(); } catch (_) {} }
  try { rockGeo && rockGeo.dispose(); } catch (_) {}
  try { rockMat && rockMat.dispose(); } catch (_) {}
  _state = null;
  _slots = null;
  _clock = 0;
  _nextSpawnAt = 0;
  _totalSpawned = 0;
  return true;
}
