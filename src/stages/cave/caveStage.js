/**
 * Cave stage builder — P4A cohort 2, 2026-05-18.
 *
 * The cave stage rides on top of the shared env (src/env.js#buildEnv)
 * exactly like forest/twilight/cinder/void do — applyStageTint recolors
 * ground + fog from the STAGES entry (groundTint / fogColor) and now
 * (cohort 2) drives the cave lighting + atmospheric particle cluster.
 *
 * What this module DOES (cohort 2):
 *   - Mounts a single scene-named group `caveStage`.
 *   - Preserves the shared cave PBR floor and layers an authored wet grotto,
 *     stepping stones, and a collapsed vault precinct over it.
 *   - Calls buildStalactiteCluster (src/stages/cave/caveStalactites.js) to
 *     mount 24-30 InstancedMesh stalactites in 6 author-anchored clusters
 *     (4 ring + 2 interior), each with a slot-3 moss-emissive tip patch.
 *   - Records `userData.stalactiteCount` on the group so smoke phase 2 can
 *     assert ≥6 instances landed.
 *   - Exports buildCaveStage(scene) + disposeCaveStage(scene) — idempotent,
 *     safe to call across stage swaps / run-end. Dispose tears down both
 *     InstancedMeshes via disposeStalactites().
 *
 * Cohort 1 deltas (now removed):
 *   - BoxGeometry placeholder stalactite — replaced by real cluster.
 *   - applyStageTint cave arm TODO — cohort 2 wires it in src/env.js.
 *   - ATMOS_SPECS cave entry TODO — cohort 2 wires it in src/env.js.
 *
 * What this module STILL does NOT do (deferred to P4A cohorts c3…cN):
 *   - Rooms, neutrals, hazards, weapons, chests, coffins, achievements.
 *   - Music phases, ceiling shader, ground normal, stone wall textures.
 *   - See docs/P4_BACKLOG.md for the cohort cadence.
 *
 * Constraints honored:
 *   - Static import per [[feedback_kks_export_origin_module_break.md]].
 *   - 5-color palette only (slot 2 + slot 3 used here).
 *   - Idempotent dispose (early-return if not mounted).
 */
import * as THREE from 'three';
import { buildStalactiteCluster, disposeStalactites } from './caveStalactites.js';
import { buildCeilingDrips, disposeCeilingDrips, tickCeilingDrips } from './caveCeilingDrips.js';
import { buildGloomshrimp, disposeGloomshrimp, tickGloomshrimp } from './caveGloomshrimp.js';
import { buildCaveStalagmites, disposeCaveStalagmites } from './caveStalagmites.js';
import { buildCaveMushrooms, disposeCaveMushrooms } from './caveMushrooms.js';
import { buildCaveSkyDome, disposeCaveSkyDome } from './caveSkyDome.js';
import { buildCaveHazard, disposeCaveHazard, tickCaveHazard } from './caveHazard.js';
import { buildCaveVault, disposeCaveVault, tickCaveVault } from './caveVault.js';
import { loadCaveAchievements, tickCaveAchievements } from '../../caveAchievements.js';
import { buildStageLandscape, disposeStageLandscape } from '../../stageLandscapes.js';

const STAGE_GROUP_NAME = 'caveStage';

// Single-instance module state. The shared env (one buildEnv at boot)
// runs once per process; the cave decor group is built/disposed per
// run-start / run-end, so module-level singletons are fine.
let _group = null;

/**
 * Build the cave-stage decor group and add it to the scene. Called from
 * main.js#applyMetaUpgrades when stage.id === 'cave'. Idempotent — if a
 * group is already mounted on a previous run, dispose first then rebuild.
 */
export function buildCaveStage(scene) {
  if (!scene) return null;
  if (_group) disposeCaveStage(scene);

  const group = new THREE.Group();
  group.name = STAGE_GROUP_NAME;

  // P4A cohort 2: stalactite landmark cluster. 6 author-anchored clusters
  // (4 ring + 2 interior), 4-5 stalactites each = 24-30 InstancedMesh
  // instances total. Tip glow patches are a second InstancedMesh tagged
  // for bloom (slot-3 moss emissive).
  let stalCount = 0;
  try {
    const built = buildStalactiteCluster(group);
    stalCount = built && built.count ? built.count : 0;
  } catch (e) {
    console.warn('[caveStage] buildStalactiteCluster failed:', e);
  }
  group.userData.stalactiteCount = stalCount;

  // P4A cohort 4: ceiling-drip particle system. Pooled InstancedMesh (24
  // slots) spawning slot-3 moss-emissive streaks from each cohort-2
  // stalactite tip at 0.5 drips/s scaled by tip count. Fall under gravity,
  // splash-flatten on landing, recycle. Stashes userData.dripPoolSize on
  // this caveStage group for the smoke phase 5 probe (the builder writes
  // it directly; we also read it back for the log line below).
  try {
    buildCeilingDrips(group);
  } catch (e) {
    console.warn('[caveStage] buildCeilingDrips failed:', e);
  }

  // P4A cohort 5: gloomshrimp neutrals. 12 bioluminescent cave creatures
  // (slot-2 body + slot-3 moss emissive, bloom-tagged) drifting above the
  // floor and darting away from the hero. Non-combat ambient life — the cave
  // equivalent of forest fireflies/deer (src/forestNeutrals.js). Ticked via
  // tickGloomshrimp → tickCave. Records gloomshrimpCount for the smoke probe.
  let shrimpCount = 0;
  try {
    const built = buildGloomshrimp(group);
    shrimpCount = built && built.count ? built.count : 0;
  } catch (e) {
    console.warn('[caveStage] buildGloomshrimp failed:', e);
  }
  group.userData.gloomshrimpCount = shrimpCount;

  // P4A cohort 9: perimeter stalagmite formations. Floor-rising stone columns
  // (cave_stone diffuse+normal textured) in 8 gapped clusters at r≈33-39 — the
  // mirror of the cohort-2 hanging stalactites, ringing the cave bounds clear of
  // the r≤26 decor footprint. Static decor (no tick). Records the count for the
  // smoke phase 10 probe.
  let stalagCount = 0;
  try {
    const built = buildCaveStalagmites(group);
    stalagCount = built && built.count ? built.count : 0;
  } catch (e) {
    console.warn('[caveStage] buildCaveStalagmites failed:', e);
  }
  group.userData.stalagmiteCount = stalagCount;

  // P4A cohort 10: glowmoss mushroom clusters at the feet of the cohort-9
  // stalagmites (r≈30-38). Two-tone (slot-2 stalk + slot-3 emissive cap),
  // perimeter-only so a vertical slot-3 glow never enters the pickup band.
  // Static decor (no tick). Records the count for the smoke phase 11 probe.
  let mushroomCount = 0;
  try {
    const built = buildCaveMushrooms(group);
    mushroomCount = built && built.count ? built.count : 0;
  } catch (e) {
    console.warn('[caveStage] buildCaveMushrooms failed:', e);
  }
  group.userData.mushroomCount = mushroomCount;

  // P4A cohort 12: cave ceiling / sky-dome. A large BackSide gradient dome
  // (mirrors forestSkyDome) wrapping the arena as a dark stone vault backdrop —
  // occlusion-safe by construction (renderOrder -100, depthWrite off). Static.
  let skyDome = false;
  try {
    const built = buildCaveSkyDome(group);
    skyDome = !!(built && built.present);
  } catch (e) {
    console.warn('[caveStage] buildCaveSkyDome failed:', e);
  }
  group.userData.skyDome = skyDome;

  // P4A cohort 13: cave-in environmental hazard. Telegraphed falling-stone
  // strikes near the hero — a rune-ring danger zone (slot-4 sigil) blooms,
  // pulses ~1.3s, then a slot-2 boulder slams down (damage if inside, dust +
  // shards + shake). The cave's signature threat (forest's spore-puff
  // equivalent). Ticked via tickCaveHazard → tickCave. Records the pool size.
  let hazardCount = 0;
  try {
    const built = buildCaveHazard(group);
    hazardCount = built && built.count ? built.count : 0;
  } catch (e) {
    console.warn('[caveStage] buildCaveHazard failed:', e);
  }
  group.userData.caveHazardCount = hazardCount;

  // P4A cohort 15: cave sealed vault. A rune-sealed slot-2 stone door at the
  // arena edge; clearing the horde (kills >= OPEN_KILLS) fails the slot-4 sigil
  // seal, grinds the slab into the floor, and yields a chest + hearts. The
  // cave's "sealed door" beat without forest's puzzle/room machinery. Ticked
  // via tickCaveVault → tickCave. Flags userData for the smoke probe.
  let caveVault = false;
  try {
    const built = buildCaveVault(group);
    caveVault = !!(built && built.present);
  } catch (e) {
    console.warn('[caveStage] buildCaveVault failed:', e);
  }
  group.userData.caveVault = caveVault;

  // Authored grotto composition: subdued water pools, stepping stones, and a
  // collapsed-arch frame around the real kill-gated vault. This replaces the
  // old full-screen floor overlay and permanent rune decal, both of which hid
  // the PBR cave floor and read like non-functional attack telegraphs.
  try {
    const landscape = buildStageLandscape('cave', group);
    group.userData.landscapeCounts = landscape ? landscape.userData.counts : null;
  } catch (e) {
    console.warn('[caveStage] buildStageLandscape failed:', e);
  }

  // P4A cohort 6: register cave-specific achievements into the shared registry
  // (docs/STAGE_AUTHORING.md §8d). Eligibility is scanned in tickCave via
  // tickCaveAchievements — no main.js edit. Idempotent.
  try {
    loadCaveAchievements();
  } catch (e) {
    console.warn('[caveStage] loadCaveAchievements failed:', e);
  }

  scene.add(group);
  _group = group;
  return group;
}

/**
 * Per-frame stage tick for cave-owned decor that needs animation. Called
 * from main.js#frame after tickAtmosphere. Self-gates on `_group` so a
 * non-cave run (or pre-build / post-dispose frame) is a free no-op per
 * `[[feedback_kks_wave_dispatcher_throttle.md]]`. dt is wall-clock seconds.
 *
 * Drives the cave-owned ambient life and actual hazard/reward systems.
 */
export function tickCave(dt) {
  if (!_group) return;
  tickCeilingDrips(dt);   // P4A cohort 4 — gravity-fall + landing fade + recycle
  tickGloomshrimp(dt);    // P4A cohort 5 — drift + hero-flee swim
  tickCaveHazard(dt);     // P4A cohort 13 — cave-in telegraph + impact
  tickCaveVault(dt);      // P4A cohort 15 — sealed vault open + reward
  tickCaveAchievements(); // P4A cohort 6 — cave-only achievement eligibility
}

/**
 * Tear down the cave-stage decor group, disposing geometry + materials so
 * GPU memory doesn't leak across stage swaps / run-end. Idempotent — safe
 * to call when nothing is mounted (e.g. on a forest run). Disposes the
 * stalactite cluster's InstancedMeshes first (they own their own geo+mat
 * lifecycles), then walks any remaining group children.
 */
export function disposeCaveStage(scene) {
  if (!_group) return false;
  // Tear down stalactite-owned resources first — disposeStalactites is
  // idempotent and detaches its own group from the parent.
  try { disposeStalactites(); } catch (_) {}
  // Landscape owns its instanced kit bakes, water shader, and path texture.
  // Detach it before the generic traversal to avoid double-disposal.
  try { disposeStageLandscape(); } catch (_) {}
  // Ceiling drips own their own InstancedMesh + pool state; same idempotent
  // contract — detach before the group traverse to avoid double-dispose.
  try { disposeCeilingDrips(); } catch (_) {}
  // Gloomshrimp (cohort 5) own their InstancedMesh geo+mat; idempotent + self-
  // detaching — drop before the group traverse to avoid double-dispose.
  try { disposeGloomshrimp(); } catch (_) {}
  // Stalagmites (cohort 9) own their InstancedMesh geo+mat+textures; idempotent
  // + self-detaching — drop before the group traverse to avoid double-dispose.
  try { disposeCaveStalagmites(); } catch (_) {}
  // Mushrooms (cohort 10) own their two InstancedMesh geo+mat; idempotent +
  // self-detaching — drop before the group traverse to avoid double-dispose.
  try { disposeCaveMushrooms(); } catch (_) {}
  // Sky-dome (cohort 12) owns its big sphere geo + ShaderMaterial; idempotent +
  // self-detaching — drop before the group traverse to avoid double-dispose.
  try { disposeCaveSkyDome(); } catch (_) {}
  // Cave-in hazard (cohort 13) owns its ring + boulder mesh pool + the shared
  // rune texture; idempotent + self-detaching — drop before the group traverse.
  try { disposeCaveHazard(); } catch (_) {}
  // Sealed vault (cohort 15) owns its slab + seal geo+mat + stone textures;
  // idempotent + self-detaching — drop before the group traverse.
  try { disposeCaveVault(); } catch (_) {}
  // Detach the stage group itself so traversal doesn't race with re-add.
  if (_group.parent) _group.parent.remove(_group);
  _group.traverse((o) => {
    if (o.geometry && typeof o.geometry.dispose === 'function') {
      try { o.geometry.dispose(); } catch (_) {}
    }
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m && typeof m.dispose === 'function') {
        try { m.dispose(); } catch (_) {}
      }
    }
  });
  _group = null;
  return true;
}
