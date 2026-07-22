/**
 * Weapon registry + lifecycle. Add a new weapon by:
 *   1) creating src/weapons/foo.js with the default-export contract,
 *   2) importing it here and adding to REGISTRY.
 *
 * The rest of the game talks to weapons only through the four exports below.
 */
import { state } from '../state.js';
import { damageEnemy, queryRadiusInto } from '../enemies.js';
import { unlockZoomLevel, getMaxZoomNotch, getZoomNotchCount, consumeActiveCast } from '../input.js';
import { spawnImpactBurst } from '../vfxBurst.js';

import orbitals from './orbitals.js';
import autoAim, { spawnGlasswindShards, syncProjectileVisuals, flushProjectileVisuals, releaseProjectileVisuals } from './autoAim.js';
// DMD-hybrid pivot — the always-equipped, player-aimed, hold-to-fire primary.
import primary from './primary.js';
// DMD-hybrid pivot — the drafted active-ability slot (RMB/Q cast).
import { tickActive, castActive, activeChoices } from './actives.js';
import chain from './chain.js';
import web, { tickWebs, resetWebs } from './web.js';
import frostbloom from './frostbloom.js';
import sigilbell from './sigilbell.js';
// P4A cohort 7 (2026-05-20) — cave-stage weapon (stages:['cave'] gated).
import gloomsigil from './gloomsigil.js';
// P4A cohort 8 (2026-05-20) — 2nd cave weapon, projectile (stages:['cave']).
import echobolt from './echobolt.js';
// Iter 34 — Phase D signature weapons (1 bespoke kit per avatar; Phase F adds the rest).
import sigCowboySixshooter from './sig/cowboy_sixshooter.js';
import sigMothmanDustcloak from './sig/mothman_dustcloak.js';
import sigSpaceSatellites  from './sig/space_satellites.js';
// Phase F1 sig kits.
import sigKittyLuckyPaw    from './sig/kitty_lucky_paw.js';
import sigSoteWarhowl      from './sig/sote_warhowl.js';
import sigPipesArcwrench   from './sig/pipes_arcwrench.js';
import sigBomdiaSunburst   from './sig/bomdia_sunburst.js';
// Phase F2 sig kits.
import sigCamperSignalfire from './sig/camper_signalfire.js';
import sigRadcatFallout    from './sig/radcat_fallout.js';
import sigMonaBrushstroke  from './sig/mona_brushstroke.js';
// Phase F3 sig kits.
import sigBezelbugFacet    from './sig/bezelbug_facet.js';
import sigRockerPowerchord from './sig/rocker_powerchord.js';
// BorgirBoss (unlock-gated 13th avatar, post-Phase F).
import sigBorgirbossRocketrack from './sig/borgirboss_rocketrack.js';
// Forest Expansion C1B (FE-C1B) — special weapons unlocked by Forest puzzles.
// Registered in REGISTRY so `tickWeapons` picks them up, but `hidden: true`
// keeps them out of the level-up card pool (see weaponChoices filter below).
// Auto-equipped into a hidden 5th slot at run start when the player has
// unlocked them via `meta.forestWeapons` (puzzle reward).
import sapWeaver    from './sapWeaver.js';
import choirLance   from './choirLance.js';
import prismWarden  from './prismWarden.js';
// Forest Expansion v0.2 (FE-V2, 2026-05-17) — 2 new hidden specials.
// root_grasp: Mossroot Hollow puzzle reward (mossroot_pulse → unlock).
// wisp_lantern: Glowfen Marshes — REGISTRY-ready scaffolding; v0.2 ships
//   WITHOUT a Glowfen puzzle, so nothing currently calls unlockForestWeapon
//   for it. Future ticket wires the unlock; once meta.forestWeapons carries
//   the id, _equipForestSpecialsForRun() picks it up with no further change.
import rootGrasp    from './rootGrasp.js';
import wispLantern  from './wispLantern.js';
// FE-V2 cohort 2 (2026-05-17) — 3 more hidden Forest specials. These are
// REGISTRY-only / `hidden: true` — no in-game unlock path yet (PHASE 1 P1D
// adds the weapons; future puzzle/coffin tickets wire unlock). Once
// meta.forestWeapons carries any of these ids, _equipForestSpecialsForRun()
// picks them up unchanged.
import sporeCloud   from './sporeCloud.js';
import briarWhip    from './briarWhip.js';
import lightningBug from './lightningBug.js';
// Forest Expansion v0.2 (FE-V2 Coffins, 2026-05-17) — Evolution Coffin
// superweapons. Unlocked PER RUN (not via meta) by opening a Coffin in
// mossroot / glowfen while holding base@L8 + paired-passive@L5. Coffin
// dispatch path lives in src/forestCoffins.js — it calls acquireWeapon
// with these ids directly. Added to REGISTRY so the weapon tick picks
// them up; `hidden: true` keeps them out of the level-up card pool.
import chainStorm   from './chainStorm.js';
import frostEternal from './frostEternal.js';
import { getMeta } from '../meta.js';
import { WEAPONS } from '../config.js';
import { passiveChoices, applyPassive, PASSIVES } from './passives.js';
// PHASE 4 P4J (#140) — Telemetry weapon_take + weapon_evolve hooks. Called
// from acquireWeapon (first-pickup branch only) and applyEvolution.
import { event as telemetryEvent } from '../telemetry.js';
export { applyPassive, PASSIVES };

export const REGISTRY = {
  [orbitals.id]:   orbitals,
  [autoAim.id]:    autoAim,
  [primary.id]:    primary,
  [chain.id]:      chain,
  [web.id]:        web,
  [frostbloom.id]: frostbloom,
  [sigilbell.id]:  sigilbell,
  [gloomsigil.id]: gloomsigil,
  [echobolt.id]:   echobolt,
  [sigCowboySixshooter.id]: sigCowboySixshooter,
  [sigMothmanDustcloak.id]: sigMothmanDustcloak,
  [sigSpaceSatellites.id]:  sigSpaceSatellites,
  [sigKittyLuckyPaw.id]:    sigKittyLuckyPaw,
  [sigSoteWarhowl.id]:      sigSoteWarhowl,
  [sigPipesArcwrench.id]:   sigPipesArcwrench,
  [sigBomdiaSunburst.id]:   sigBomdiaSunburst,
  [sigCamperSignalfire.id]: sigCamperSignalfire,
  [sigRadcatFallout.id]:    sigRadcatFallout,
  [sigMonaBrushstroke.id]:  sigMonaBrushstroke,
  [sigBezelbugFacet.id]:    sigBezelbugFacet,
  [sigRockerPowerchord.id]: sigRockerPowerchord,
  [sigBorgirbossRocketrack.id]: sigBorgirbossRocketrack,
  // Forest Expansion C1B — hidden special weapons (auto-equipped per
  // meta.forestWeapons; filtered out of weaponChoices via the `hidden` flag).
  [sapWeaver.id]:    sapWeaver,
  [choirLance.id]:   choirLance,
  [prismWarden.id]:  prismWarden,
  // FE-V2
  [rootGrasp.id]:    rootGrasp,
  [wispLantern.id]:  wispLantern,
  // FE-V2 cohort 2
  [sporeCloud.id]:   sporeCloud,
  [briarWhip.id]:    briarWhip,
  [lightningBug.id]: lightningBug,
  // FE-V2 Coffins — coffin-unlocked evolved superweapons. Per-run only;
  // never enter meta.forestWeapons. acquireWeapon path = forestCoffins.js
  // _dispatchEvolution.
  [chainStorm.id]:   chainStorm,
  [frostEternal.id]: frostEternal,
};

// FE-C1B — list of weapon ids that count as Forest "special" (5th-slot)
// weapons. These are auto-equipped at run start per `meta.forestWeapons`
// (the puzzle-reward unlock list owned by Agent 1 — backward-compat: read
// defensively with `|| []`). Order is stable so equip is deterministic.
const FOREST_SPECIAL_IDS = ['sap_weaver', 'choir_lance', 'prism_warden',
  // FE-V2 — Forest v0.2 additions. wisp_lantern has no in-game unlock path
  // yet (Glowfen has no puzzle in v0.2); root_grasp unlocks via the
  // mossroot_pulse puzzle reward.
  'root_grasp', 'wisp_lantern',
  // FE-V2 cohort 2 — scaffolding only in this iter (no unlock path yet;
  // future puzzle/coffin assignments wire them in). Listed here so when
  // a future ticket flips them on via meta.forestWeapons the equip flow
  // picks them up with zero further changes.
  'spore_cloud', 'briar_whip', 'lightning_bug',
  // FE-V2 Coffins — these are per-run (coffin-dispatched), never persisted
  // to meta.forestWeapons. Listed here for consistency with the seam
  // contract; auto-equip is a no-op for them because the meta gate never
  // fires (they're acquired live mid-run via acquireWeapon). Future
  // tickets that want a "permanent unlock once opened" path can flip on
  // meta persistence and the equip helper will pick them up unchanged.
  'chain_storm', 'frost_eternal'];

// Auto-equip Forest special weapons (FE-C1B) into the hidden 5th slot at run
// start. Idempotent: we early-return on any weapon id that's already in
// `state.weapons`, so the Cellar's repeated starter acquires (which loop
// through acquireWeapon multiple times) trigger this helper many times but
// each forest weapon is only pushed once. resetState() clears
// `state.weapons.length = 0` between runs, so the next run starts the loop
// fresh — no run-id bookkeeping needed.
// DMD-hybrid: every run gets the always-equipped primary (hidden slot). Pushed
// directly (not via acquireWeapon) to avoid reentrancy, and idempotent so the
// repeated run-start acquires (Cellar dupes, resume, restart) never stack it.
function _equipPrimaryForRun() {
  if (state.weapons.find(w => w.id === 'primary')) return;
  const mod = REGISTRY['primary'];
  if (!mod) return;
  const entry = { id: 'primary', level: 1, inst: {} };
  state.weapons.push(entry);
  try { if (mod.init) mod.init(state, mod.levels[0], entry.inst); }
  catch (e) { console.warn('[weapons] primary init', e); }
}

function _equipForestSpecialsForRun() {
  let meta = null;
  try { meta = getMeta(); } catch (_) { meta = null; }
  const unlocked = (meta && Array.isArray(meta.forestWeapons)) ? meta.forestWeapons : [];
  if (unlocked.length === 0) return;
  for (const id of FOREST_SPECIAL_IDS) {
    if (!unlocked.includes(id)) continue;
    const mod = REGISTRY[id];
    if (!mod) continue;
    if (state.weapons.find(w => w.id === id)) continue;
    const entry = { id, level: 1, inst: {} };
    state.weapons.push(entry);
    const level = mod.levels[0];
    if (mod.init) try { mod.init(state, level, entry.inst); } catch (e) { console.warn('[weapons] forest init', id, e); }
  }
}

const WORLD_BOUND = 200; // projectile cull bound (square half-extent around hero)
const PROJ_HIT_RADIUS = 0.6;
const _projectileQueryBuf = [];
const IMPACT_FX_BUDGET_PER_SEC = 12;
let _impactFxWindow = -1;
let _impactFxCount = 0;

function _allowProjectileImpactFx(p) {
  // A piercing shot gets one authored contact beat, never one burst per body.
  // A small shared per-second budget then keeps maxed multi-shot builds from
  // churning hundreds of transient ember descriptors during dense waves.
  if (p._impactFxShown) return false;
  p._impactFxShown = true;
  const sec = Math.floor((state.time && state.time.game) || 0);
  if (sec !== _impactFxWindow) {
    _impactFxWindow = sec;
    _impactFxCount = 0;
  }
  if (_impactFxCount >= IMPACT_FX_BUDGET_PER_SEC) return false;
  _impactFxCount++;
  return true;
}

export function initWeapons() {
  // Nothing to set up globally — scene/state are already available via `state`.
  // This exists for symmetry with the rest of the bootstrap order in main.js.
}

/** Dispose run-owned weapon visuals before resetState drops their instances. */
export function resetWeapons() {
  for (let i = 0; i < state.weapons.length; i++) {
    const entry = state.weapons[i];
    const mod = REGISTRY[entry.id];
    if (!mod || typeof mod.dispose !== 'function') continue;
    try { mod.dispose(state, entry.inst); }
    catch (e) { console.warn('[weapons] dispose', entry.id, e); }
  }
  resetWebs();
  _impactFxWindow = -1;
  _impactFxCount = 0;
}

export function acquireWeapon(id) {
  const mod = REGISTRY[id];
  if (!mod) {
    console.warn('[weapons] unknown weapon id:', id);
    return;
  }
  const existing = state.weapons.find(w => w.id === id);
  if (existing) {
    if (existing.level >= mod.maxLevel) return;
    existing.level += 1;
    const level = mod.levels[existing.level - 1];
    if (mod.refresh) mod.refresh(state, level, existing.inst);
    _announceEligibleEvolutions();   // hitting maxLevel may unlock the evo
    return;
  }
  const entry = { id, level: 1, inst: {} };
  state.weapons.push(entry);
  const level = mod.levels[0];
  if (mod.init) mod.init(state, level, entry.inst);
  // PHASE 4 P4J — telemetry weapon_take (first acquire only; level-ups stay
  // implicit since they fire on the early-return branch above).
  try { telemetryEvent('weapon_take', { id }); } catch (_) {}
  // FE-C1B: the first weapon acquired this run is the starter (see
  // main.js _startRun / _restartRun). Use this lifecycle moment to also
  // auto-equip any Forest special weapons the player has unlocked.
  // `_equipForestSpecialsForRun()` is internally idempotent (per-id
  // membership check), so subsequent acquires this run (Cellar duplicates
  // = level-ups, which hit the early-return branch above; level-up cards,
  // which hit either branch) are no-ops here.
  _equipForestSpecialsForRun();
  _equipPrimaryForRun();   // DMD-hybrid: always-on primary, every run + every path
}

export function tickWeapons(dt) {
  // 1) Run each weapon's tick
  for (const entry of state.weapons) {
    const mod = REGISTRY[entry.id];
    if (!mod) continue;
    const level = mod.levels[entry.level - 1];
    if (mod.tick) mod.tick(state, dt, level, entry.inst);
  }
  // 1b) Active ability — count down its cooldown, fire on a queued RMB/Q press.
  //     Single chokepoint: tickWeapons runs in every combat mode.
  tickActive(dt);
  if (consumeActiveCast()) castActive();
  // 2) Update all live projectiles (spawned by weapons above)
  tickProjectiles(dt);
  // 3) Chain-lightning arc fade is owned by src/chainFx.js (A4 refactor) —
  //    main.js ticks the shared arc list once per frame after all spawners.
  // 4) Update sticky webs (decay + visual)
  tickWebs(dt);
}

function tickProjectiles(dt) {
  const list = state.projectiles.active;
  const scene = state.scene;
  const hero = state.hero.pos;

  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    // Move
    p.mesh.position.x += p.vel.x * dt;
    p.mesh.position.z += p.vel.z * dt;
    p.ttl -= dt;

    // Out-of-bounds / expired
    const dx = p.mesh.position.x - hero.x;
    const dz = p.mesh.position.z - hero.z;
    if (p.ttl <= 0 || Math.abs(dx) > WORLD_BOUND || Math.abs(dz) > WORLD_BOUND) {
      disposeProjectile(p, scene);
      const last = list.length - 1;
      if (i !== last) list[i] = list[last];
      list.pop();
      continue;
    }

    // Collide vs enemies
    let candidates = null;
    try { candidates = queryRadiusInto(p.mesh.position, PROJ_HIT_RADIUS, _projectileQueryBuf); } catch (_) { candidates = null; }
    if (candidates && candidates.length > 0) {
      let killed = false;
      let didSplit = false;
      for (const enemy of candidates) {
        if (!enemy || !enemy.alive) continue;
        if (p.hit.has(enemy)) continue;
        let hitDmg = p.dmg;
        const control = enemy._combatControl;
        if (p.ownerWeapon === 'primary' && control && control.kind === 'pipes-hook') {
          // Shooting the captive is Pipes' skill-expression loop: each primary
          // hit visibly charges the chain, speeds the swing and strengthens the
          // eventual improvised-projectile collision. Never mutate p.dmg — a
          // piercing shot must keep its normal value for later targets.
          // Five clean shots fully arm the throw; three are enough to ignite
          // the authored charge crest during the base-level hold window.
          control.charge = Math.min(1, (control.charge || 0) + 0.22);
          control.primaryHits = (control.primaryHits || 0) + 1;
          hitDmg *= 1.25;
          state.run.pipesGrapplePrimaryHits = (state.run.pipesGrapplePrimaryHits || 0) + 1;
        }
        damageEnemy(enemy, hitDmg, p.ownerWeapon || 'autoaim');
        // Pooled contact sparks stop authored shots from silently vanishing on
        // impact. Keep ordinary hits below the flash threshold; four short
        // embers are enough to sell contact without strobing a dense volley.
        const ep = enemy.mesh ? enemy.mesh.position : enemy.pos;
        if (ep && _allowProjectileImpactFx(p)) {
          const impactColor = p.ownerWeapon === 'glasswind' ? 0xa8ddff
            : p.ownerWeapon === 'primary' ? 0xffe5a0 : 0x8fffe8;
          try { spawnImpactBurst(ep.x, Math.max(0.45, ep.y || 0.45), ep.z, impactColor, 0.28, 3); } catch (_) {}
        }
        p.hit.add(enemy);

        // Glasswind: on the first hit, fork into 2 perpendicular ice shards that
        // each pierce 1 enemy for 50% damage. Guard with `noSplit` so shards
        // themselves don't recursively split.
        if (p.splitOnHit && !p.noSplit && !didSplit) {
          try { spawnGlasswindShards(p.mesh.position, p.vel, p.dmg); } catch (_) {}
          didSplit = true;
          p.splitOnHit = false;
        }

        p.pierce -= 1;
        if (p.pierce <= 0) {
          disposeProjectile(p, scene);
          const last = list.length - 1;
          if (i !== last) list[i] = list[last];
          list.pop();
          killed = true;
          break;
        }
      }
      if (killed) continue;
    }

    // iter 33u — sync InstancedMesh slot to current proj position.
    syncProjectileVisuals(p);
  }
  flushProjectileVisuals();
}

function disposeProjectile(p, scene) {
  releaseProjectileVisuals(p);
  // Instanced projectiles use detached anchors, while procedural projectiles
  // (Mirror Step and similar) attach real groups to the scene. Always detach
  // the latter on expiry/hit so their meshes cannot accumulate for the run.
  if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
}

/**
 * Returns up to N level-up choices for weapons only.
 * Each choice: { kind:'weapon', id, level: nextLevel }.
 * Passives are handled elsewhere (xp.js).
 */
// Endgame fillers shown when all weapons are maxed — prevents empty level-up modals.
const FILLERS = [
  { kind: 'filler', id: 'heal',     name: 'Field Rations', desc: 'Restore 40 HP', icon: '🍞' },
  { kind: 'filler', id: 'maxhp',    name: 'Iron Resolve',  desc: '+25 Max HP',    icon: '❤️' },
  { kind: 'filler', id: 'speed',    name: 'Swift Boots',   desc: '+10% Move Speed', icon: '👟' },
  { kind: 'filler', id: 'magnet',   name: 'Magnet',        desc: '+60% Pickup Radius', icon: '🧲' },
  { kind: 'filler', id: 'cooldown', name: 'Focus',         desc: '-8% Cooldown',  icon: '⏱️' },
  { kind: 'filler', id: 'damage',   name: 'Sharpened',     desc: '+10% Damage (max 5)', icon: '⚔️' },
  { kind: 'filler', id: 'zoomout',  name: 'Bigger Picture',desc: 'Unlock one more zoom-out step', icon: '🔍' },
  // 'dash' is no longer a draft card — it auto-ranks at DASH.autoRankLevels
  // hero levels. applyFiller keeps its 'dash' case: slotMachine still grants
  // ranks through it.
];

export function weaponChoices(n) {
  const ids = Object.keys(REGISTRY);
  const owned = new Map(state.weapons.map(w => [w.id, w]));
  const pool = [];

  // 1) Evolutions: highest priority. Show as 'evolution' kind.
  for (const baseId of Object.keys(EVOLUTIONS)) {
    if (_isEvolutionEligible(baseId)) {
      const evo = EVOLUTIONS[baseId];
      pool.push({
        kind: 'evolution', id: baseId, level: 'EVO',
        name: evo.name, icon: evo.icon, desc: evo.desc,
      });
    }
  }

  // Draft curation (Iter 1): cap new-weapon offers at WEAPONS.maxSlots owned
  // non-hidden weapons — upgrades of owned weapons are still offered.
  let slotsUsed = 0;
  for (const w of state.weapons) {
    const m = REGISTRY[w.id];
    if (m && !m.hidden) slotsUsed += 1;
  }
  const slotsFull = slotsUsed >= WEAPONS.maxSlots;

  for (const id of ids) {
    const mod = REGISTRY[id];
    // FE-C1B: hidden weapons (Forest specials, slot 5) never appear in the
    // level-up card pool — they're equipped automatically per meta unlock.
    if (mod && mod.hidden) continue;
    // Avatar-gated signature kits: only the owning avatar sees the card. The
    // run.signatureWeapon escape covers shared kits (the three kitten avatars
    // reuse sig_kitty_lucky_paw but carry avatar !== 'kitty').
    if (mod && mod.avatar) {
      const run = state.run || {};
      if (mod.avatar !== run.avatar && id !== run.signatureWeapon) continue;
    }
    // Stage-gated weapons (e.g. cave-only Gloomsigil): only offer the card on
    // a matching stage. Weapons with no `stages` field are offered everywhere
    // (backward compat). Carried weapons still tick on any stage.
    if (mod && Array.isArray(mod.stages)) {
      const stageId = state.run && state.run.stage && state.run.stage.id;
      if (stageId && !mod.stages.includes(stageId)) continue;
    }
    const have = owned.get(id);
    if (have) {
      if (have.level < mod.maxLevel) {
        const card = { kind: 'weapon', id, level: have.level + 1 };
        // 3× draft weight for upgrades of owned weapons (deduped post-shuffle)
        // — runs were ending as piles of level-1 weapons.
        pool.push(card, card, card);
      }
    } else if (!slotsFull) {
      pool.push({ kind: 'weapon', id, level: 1 });
    }
  }

  // Evolution-chasing fillers: paired fillers normally only appear as
  // end-of-pool padding (picks.length < n below), which a 10-min run never
  // reaches — that made filler-gated evolutions unreachable. Once a base
  // weapon is maxed and its evolution still wants filler picks, surface the
  // paired filler in the main draft at 2× weight (same push-then-dedupe
  // trick as the owned-upgrade 3× above).
  for (const baseId of Object.keys(EVOLUTIONS)) {
    const req = EVOLUTIONS[baseId].requires || {};
    if (!req.filler) continue;
    const w = owned.get(baseId);
    const mod = REGISTRY[baseId];
    if (!w || !mod || w.level < mod.maxLevel) continue;
    if (w.inst && w.inst.evolved) continue;
    const have = (state.hero.fillerCounts && state.hero.fillerCounts[req.filler]) || 0;
    if (have >= (req.count || 1)) continue;
    const f = FILLERS.find(x => x.id === req.filler);
    if (!f) continue;
    // Desc ties the filler to its evolution — without it, "Magnet" recurring
    // at 2x weight reads as RNG and the player keeps skipping the evo key.
    const evoName = EVOLUTIONS[baseId].name || 'evolution';
    const card = {
      kind: 'filler', id: f.id, level: 1, name: f.name,
      desc: `${f.desc} — evolves ${evoName}`, icon: f.icon,
    };
    pool.push(card, card);
  }

  // Mix in named passives. Up to 2 of the 3 cards can be passives if the
  // player has open slots / leveling room.
  try {
    const passives = passiveChoices(2);
    for (const p of passives) pool.push(p);
  } catch (_) {}

  // DMD-hybrid: offer the active-ability card(s) not yet maxed. Pushed once so
  // it's one card among the roll (equip on first pick, level up on re-pick).
  try {
    for (const c of activeChoices()) pool.push(c);
  } catch (_) {}

  // Shuffle the full pool (weapons + passives + evolutions).
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }

  // Collapse the 3×-weighted upgrade duplicates (keeps shuffle order) so a
  // single draft never shows the same card twice.
  const seen = new Set();
  const picks = [];
  for (const c of pool) {
    const key = c.kind + ':' + c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(c);
  }

  // Active pity: an empty cast slot past level 3 means the player keeps
  // missing the active card — force it into draft slot 0. Budget of 3 pins,
  // SPACED to every 3rd eligible draft (a consecutive burn-out spent all 3
  // at hero L3-4-5 — exactly the window players tunnel on weapon ranks —
  // then went silent forever). Gated on a real state.run: incrementing a
  // throwaway object would un-cap the pin (the regression the cap fixes).
  const act = state.hero.active;
  if (state.run && (!act || !act.id) && state.hero.level >= 3
      && (state.run._activePityShown || 0) < 3) {
    state.run._activeDrafts = (state.run._activeDrafts || 0) + 1;
    if (state.run._activeDrafts % 3 === 1) {
      const i = picks.findIndex(c => c.kind === 'active' && c.id === 'nova');
      if (i >= 0) {
        if (i > 0) picks.unshift(picks.splice(i, 1)[0]);
        state.run._activePityShown = (state.run._activePityShown || 0) + 1;
      }
    }
  }

  // Always pad with fillers so the modal never has fewer than n cards.
  if (picks.length < n) {
    const zoomMaxed = getMaxZoomNotch() >= getZoomNotchCount() - 1;
    // Rebalance 2026-07 — 'Sharpened' capped at 5 stacks (see applyFiller):
    // stop offering the card once capped, same as a maxed zoomout.
    const dmgMaxed = ((state.hero.fillerCounts && state.hero.fillerCounts.damage) || 0) >= 5;
    const available = FILLERS.filter(f =>
      !(f.id === 'zoomout' && zoomMaxed) && !(f.id === 'damage' && dmgMaxed));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    for (const f of shuffled) {
      if (picks.length >= n) break;
      if (seen.has('filler:' + f.id)) continue;   // evolution-weighted filler may already be drafted
      seen.add('filler:' + f.id);
      picks.push({ kind: 'filler', id: f.id, level: 1, name: f.name, desc: f.desc, icon: f.icon });
    }
  }
  return picks.slice(0, n);
}

// Tracks which evolutions have been announced this run so we don't repeat the banner.
const _announcedEvos = new Set();
export function _resetEvoAnnouncements() {
  _announcedEvos.clear();
  // Active-pity draft counter rides along: state.run is reset field-by-field
  // (state.js resetState), so without this the cap would leak across runs.
  if (state.run) state.run._activePityShown = 0;
}

/** Apply a non-weapon filler choice. Called by xp.js applyLevelUpChoice. */
export function applyFiller(choice) {
  const h = state.hero;
  switch (choice.id) {
    case 'heal':     h.hp = Math.min(h.hp + 40, h.hpMax); break;
    case 'maxhp':    h.hpMax += 25; h.hp += 25; break;
    case 'speed':    h.statMul.moveSpeed *= 1.10; break;
    case 'magnet':   h.statMul.magnet    *= 1.60; break;
    case 'cooldown': h.statMul.cooldown  *= 0.92; break;
    // Rebalance 2026-07 — cap at 5 stacks. Uncapped ×1.10 multiplicative made
    // late trash one-shot regardless of HP tuning. Slot-machine grants funnel
    // through here too, so picks past 5 are a no-op everywhere.
    case 'damage':
      if (((h.fillerCounts && h.fillerCounts.damage) || 0) < 5) h.statMul.dmg *= 1.10;
      break;
    case 'zoomout':  unlockZoomLevel(); break;
    case 'dash':
      h.dashUnlocked = true;
      h.dashLevel = Math.min((h.dashLevel || 0) + 1, 5);
      break;
  }
  // Track the pick for evolution eligibility
  if (h.fillerCounts && choice.id in h.fillerCounts) {
    h.fillerCounts[choice.id] = (h.fillerCounts[choice.id] || 0) + 1;
  }
  // Announce any evolution that just became eligible
  _announceEligibleEvolutions();
}

/** Public hook: callers like enemies.js (mini-boss kill) can poke evolution
 *  eligibility re-check. Idempotent — _announcedEvos guards against re-banner. */
export function checkEvolutionEligibility() { _announceEligibleEvolutions(); }

function _announceEligibleEvolutions() {
  for (const baseId of Object.keys(EVOLUTIONS)) {
    if (_announcedEvos.has(baseId)) continue;
    if (_isEvolutionEligible(baseId)) {
      _announcedEvos.add(baseId);
      const evo = EVOLUTIONS[baseId];
      // Persist this evolution as discovered in the meta Grimoire
      import('../meta.js').then(({ discoverEvolution }) => discoverEvolution(evo.id));
      import('../ui.js').then(({ showBanner }) => {
        showBanner(`★ EVOLUTION READY: ${evo.name.toUpperCase()}`, 3.5, '#ffe14a');
      });
      state.fx.bloomBoost = 1.0;
    }
  }
}

// ── Evolutions ───────────────────────────────────────────────────────────────
// When a weapon is maxed AND the corresponding filler has been picked enough,
// an EVOLUTION choice appears. Picking it stamps `inst.evolved = true` and
// the weapon's tick reads that flag to apply a permanent boost.
export const EVOLUTIONS = {
  orbitals: {
    id: 'toxic_halo',
    requires: { filler: 'magnet', count: 2 },
    name: 'Toxic Halo',
    icon: '☠️',
    desc: 'Orbitals deal 2.5× damage and apply 1s poison DoT to anything they touch',
  },
  chain: {
    id: 'storm',
    requires: { filler: 'cooldown', count: 2 },
    name: 'Storm',
    icon: '🌩️',
    desc: 'Chain fires every 0.3s with +3 chains and 2× damage',
  },
  autoaim: {
    id: 'glasswind',
    requires: { passive: 'echo' },
    name: 'Glasswind',
    icon: '🪟',
    desc: 'Volleys fire 50% more projectiles; bullets split into two ice shards on first hit',
  },
  web: {
    id: 'sanctum',
    requires: { passive: 'steadfast' },
    name: 'Sanctum',
    icon: '✨',
    desc: 'Webs burn enemies inside them; you take 30% less damage while standing in any web',
  },
  // Dash isn't a REGISTRY weapon — eligibility/application has a dedicated
  // branch keyed on the literal id 'dash'. Trigger: dashLevel 4 (hero L13
  // via DASH.autoRankLevels) AND 2 mini-boss kills (~330s — only 3 minibosses
  // spawn per 10-min run, so the old 5-kill gate was unreachable). Kept
  // idempotent via state.hero.dashEvolved.
  dash: {
    id: 'mirror_step',
    requires: { dashLevel: 4, miniBossKills: 2 },
    name: 'Mirror Step',
    icon: '👥',
    desc: 'Dash leaves a magenta ghost twin that fires an orbital burst; dash cooldown −25%',
  },
};

function _isEvolutionEligible(weaponId) {
  const evo = EVOLUTIONS[weaponId];
  if (!evo) return false;
  const req = evo.requires || {};

  // Dash evolution: not a REGISTRY weapon — check run-state directly.
  if (weaponId === 'dash') {
    const h = state.hero;
    if (!h.dashUnlocked) return false;
    if (h.dashEvolved) return false;
    if ((h.dashLevel || 0) < (req.dashLevel || 0)) return false;
    const kills = (state.run && state.run.miniBossKills) || 0;
    if (kills < (req.miniBossKills || 0)) return false;
    return true;
  }

  const owned = state.weapons.find(w => w.id === weaponId);
  if (!owned) return false;
  const mod = REGISTRY[weaponId];
  if (!mod || owned.level < mod.maxLevel) return false;
  if (owned.inst && owned.inst.evolved) return false; // already done

  if (req.filler) {
    const have = (state.hero.fillerCounts && state.hero.fillerCounts[req.filler]) || 0;
    if (have < (req.count || 1)) return false;
  }
  if (req.passive) {
    const passives = state.passives || [];
    const havePassive = passives.find(p => p.id === req.passive);
    if (!havePassive || havePassive.level < (req.passiveLevel || 1)) return false;
  }
  return true;
}

export function applyEvolution(weaponId) {
  if (weaponId === 'dash') {
    const h = state.hero;
    if (h.dashEvolved) return;
    h.dashEvolved = true;
    state.fx.bloomBoost = 1.0;
    state.fx.shake = Math.max(state.fx.shake || 0, 0.5);
    _fireAscensionFx();
    import('../ui.js').then(({ tryAchievement }) => tryAchievement('first_evolution'));
    const evoDef = EVOLUTIONS.dash;
    if (evoDef) try { import('../codex.js').then(({ notifyEvolutionAchieved }) => notifyEvolutionAchieved(evoDef.id)); } catch (_) {}
    return;
  }
  const owned = state.weapons.find(w => w.id === weaponId);
  if (!owned) return;
  if (!owned.inst) owned.inst = {};
  owned.inst.evolved = true;
  state.fx.bloomBoost = 1.0;
  state.fx.shake = Math.max(state.fx.shake || 0, 0.5);
  _fireAscensionFx();
  import('../ui.js').then(({ tryAchievement }) => tryAchievement('first_evolution'));
  const evoDef = EVOLUTIONS[weaponId];
  if (evoDef) try { import('../codex.js').then(({ notifyEvolutionAchieved }) => notifyEvolutionAchieved(evoDef.id)); } catch (_) {}
}

/**
 * Ascension Evolution FX hook (Punch List #1, 2026-05-16). Called from both
 * branches of applyEvolution (regular weapon + dash). Fires the 1.2s burst
 * + 30s rim, plays the SFX bouquet, and stamps the per-run state flag.
 *
 * Dynamic import + try/catch keep the evolution flow defensive: if the FX
 * module fails to load (e.g. test harness without three.js), the evolution
 * itself still applies cleanly.
 */
function _fireAscensionFx() {
  state.run.hasEvolvedThisRun = true;
  // Per-run evolution count (drives the 'evolver' achievement — 3 evolutions in
  // one run). Both the regular-weapon and dash evolution branches funnel here.
  state.run.evolutionsThisRun = (state.run.evolutionsThisRun || 0) + 1;
  // PHASE 4 P4J — telemetry weapon_evolve. Fires from both regular and dash
  // evolution branches (applyEvolution funnels both through here).
  try {
    // Best-effort: stamp the most recently mutated weapon id, falling back
    // to a generic marker so the event still counts even if the lookup misses.
    const owned = state.weapons && state.weapons.find((w) => w && w.inst && w.inst.evolved);
    telemetryEvent('weapon_evolve', { id: owned ? owned.id : null });
  } catch (_) {}
  const heroMesh = state.hero && state.hero.mesh;
  const scene = heroMesh && heroMesh.parent;
  const pos = state.hero && state.hero.pos;
  const stageId = state.run && state.run.stage && state.run.stage.id;
  if (scene && pos) {
    import('../fx/evolveBurst.js').then(({ spawnEvolveBurst }) => {
      try { spawnEvolveBurst(scene, pos, stageId); } catch (_) {}
    }).catch(() => {});
  }
  // SFX bouquet — existing crystalShatter + new evolutionChime (no-op
  // until the audio file lands, per audio.js _play() drop-on-missing-bank).
  import('../audio.js').then(({ sfx }) => {
    try { sfx.crystalShatter && sfx.crystalShatter(); } catch (_) {}
    try { sfx.evolutionChime && sfx.evolutionChime(); } catch (_) {}
  }).catch(() => {});
}
