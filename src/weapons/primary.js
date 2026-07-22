/**
 * PRIMARY — the always-equipped, player-aimed, hold-to-fire attack.
 *
 * The DMD-hybrid pivot's active centerpiece (see kitty_kaki_survivors_project
 * memo). Unlike the auto weapons (orbitals/web/chain… which fire on their own
 * cooldown at the nearest enemy), the primary only fires while the player is
 * actively firing — LMB held on PC, or auto-fire while moving on mobile (the
 * `optAutoFirePrimary` accessibility toggle, default ON for touch / OFF for
 * mouse) — and it aims where the player points:
 *   • manual aim (mouse cursor / gamepad right-stick) when actively aiming,
 *   • nearest enemy as the auto-aim fallback when idle.
 *
 * It re-uses autoAim's shared InstancedMesh projectile pool + collision path
 * (spawnAutoAimProjectile, owner tag 'primary'), so it adds zero draw calls.
 *
 * Per-archetype flavor: each archetype gets a distinct fan/range/pierce
 * profile (kitty = 3-claw cone, sniper = slow hard-hitting pierce, …). The
 * shared `levels[]` is the base scaling; the profile applies multipliers.
 * Avatars inherit their archetype's profile (kitty + sote are both the kitty
 * 'Claw Bolt' for free). The slot is `hidden:true` so it never enters the
 * level-up draft; it auto-ranks from hero level (see _rankRow) and scales
 * with global passives (statMul.dmg/cooldown).
 */
import { state } from '../state.js';
import { queryRadiusInto } from '../enemies.js';
import { sfx } from '../audio.js';
import { spawnHeroTextFloater } from '../damageNumbers.js';
import { spawnAutoAimProjectile } from './autoAim.js';
import { spawnPrimaryMuzzle } from '../fx.js';
import { getAimDirection, isPrimaryFiring, isManualAiming } from '../input.js';

// Same hero-relative cap autoAim uses — never auto-target off-screen enemies.
const SEARCH_RADIUS = 18;
const _targetQueryBuf = [];
const _aimDir = { x: 0, z: 1 };
const _shotDir = { x: 0, z: 1 };
const ICE_OPTS = Object.freeze({ ice: true });

function _findNearestEnemy(pos) {
  let candidates = null;
  try { candidates = queryRadiusInto(pos, SEARCH_RADIUS, _targetQueryBuf); } catch (_) { candidates = null; }
  if (!candidates || candidates.length === 0) candidates = state.enemies.active;
  if (!candidates || candidates.length === 0) return null;
  let best = null, bestD2 = Infinity;
  for (const e of candidates) {
    if (!e || !e.alive) continue;
    const ep = e.mesh ? e.mesh.position : e.pos;
    if (!ep) continue;
    const dx = ep.x - pos.x, dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// Per-archetype profiles. `count`/`spread` shape the fan; `speedMul`,
// `pierceBonus`, `cdMul`, `dmgMul` multiply the base level; `ice` picks the
// pale-blue projectile pool for a distinct read. dmgMul is normalized so a
// full volley lands near the same DPS band across archetypes (Iter E re-tunes).
const GENERIC = { name: 'Arc Bolt', count: 1, spread: 0.14, speedMul: 1.0, pierceBonus: 0, cdMul: 1.0, dmgMul: 1.0, ice: false };
const PROFILES = {
  kitty:      { name: 'Claw Bolt',   count: 3, spread: 0.16, speedMul: 0.95, pierceBonus: 0, cdMul: 1.05, dmgMul: 0.72, ice: false },
  sniper:     { name: 'Dead-Eye Shot',count: 1, spread: 0.00, speedMul: 1.40, pierceBonus: 2, cdMul: 1.50, dmgMul: 2.20, ice: true  },
  boom:       { name: 'Spark Lob',   count: 2, spread: 0.12, speedMul: 1.00, pierceBonus: 1, cdMul: 1.10, dmgMul: 1.05, ice: false },
  webspinner: { name: 'Silk Spit',   count: 2, spread: 0.20, speedMul: 0.90, pierceBonus: 0, cdMul: 1.00, dmgMul: 0.92, ice: false },
  phoenix:    { name: 'Ember Dart',  count: 2, spread: 0.10, speedMul: 1.10, pierceBonus: 0, cdMul: 0.95, dmgMul: 0.98, ice: false },
  clockwork:  { name: 'Cog Toss',    count: 1, spread: 0.10, speedMul: 1.00, pierceBonus: 1, cdMul: 0.90, dmgMul: 1.05, ice: false },
};

function _profileFor(archetypeId) {
  return PROFILES[archetypeId] || GENERIC;
}

// Base scaling shared by all archetypes. Held-fire centerpiece, so it out-DPSes
// a single auto weapon by design (Iter E balances against spawn rate).
// Row 1 is the historic single level, untouched — smoke-primary asserts it.
// `count` is an ADDITIVE bonus bolt on top of the per-archetype fan
// (n = prof.count + row.count - 1), so the profile keeps owning the fan shape
// and the mid-run bump reads the same across all archetypes (+1 bolt at rank 5).
// Damage steepens hard at the top: enemy EHP grows ~5-6x by the late ranks
// (rampHp 0.6/D on the compressed curve) — a 3.3x table made TTK on trash
// WORSE as you ranked. Row 8 at 8x base keeps held-fire ahead of the ramp.
const LEVELS = [
  { cooldown: 0.30,  speed: 21,   dmg: 9,  ttl: 0.95, pierce: 1, count: 1 },
  { cooldown: 0.29,  speed: 21.5, dmg: 13, ttl: 0.97, pierce: 1, count: 1 },
  { cooldown: 0.28,  speed: 22,   dmg: 18, ttl: 1.00, pierce: 1, count: 1 },
  { cooldown: 0.27,  speed: 22.5, dmg: 25, ttl: 1.02, pierce: 2, count: 1 },
  { cooldown: 0.26,  speed: 23,   dmg: 34, ttl: 1.05, pierce: 2, count: 2 },
  { cooldown: 0.25,  speed: 23.5, dmg: 46, ttl: 1.07, pierce: 2, count: 2 },
  { cooldown: 0.245, speed: 23.7, dmg: 58, ttl: 1.08, pierce: 2, count: 2 },
  { cooldown: 0.24,  speed: 24,   dmg: 72, ttl: 1.10, pierce: 2, count: 2 },
];

// Auto-rank: the primary's effective row derives from HERO level (1-3 → row 1,
// 4-6 → row 2, … 22+ → row 8), not from the state.weapons entry — that entry
// stays level 1 forever because the slot is hidden from the draft. tickWeapons
// therefore always passes LEVELS[0]; we ignore it and derive here.
// Rebalance 2026-07 — gate /2 → /3: row 8 at hero L15 landed peak DPS mid-run
// while the trash HP mult was still only ~×4-5. Maxing at L22 delays the
// spike without touching the LEVELS rows (no single hit feels weaker).
function _rankRank() {
  const heroLevel = (state.hero && state.hero.level) || 1;
  return Math.min(LEVELS.length, 1 + Math.floor((heroLevel - 1) / 3));
}

// Rank-up callout: rank derives silently from hero level, so without this the
// weapon's growth is invisible (same bolt, same sound, no announcement).
let _lastSeenRank = 1;
function _rankRow() {
  const rank = _rankRank();
  if (rank > _lastSeenRank) {
    _lastSeenRank = rank;
    const prof = _profileFor(state.run && state.run.character);
    try { spawnHeroTextFloater(`${prof.name.toUpperCase()} RANK ${rank}`); } catch (_) {}
  } else if (rank < _lastSeenRank) {
    _lastSeenRank = rank;   // run restart — hero level reset
  }
  return LEVELS[rank - 1];
}

const primary = {
  id: 'primary',
  hidden: true,        // never appears in the level-up draft pool
  maxLevel: 8,         // ranks auto-derive from hero level (see _rankRow)
  levels: LEVELS,

  init(state, level, inst) {
    inst.cd = 0;
    inst.profile = _profileFor(state.run && state.run.character);
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    if (inst.cd > 0) inst.cd -= dt;

    // Gate on the fire input. When not firing, keep cd ready (clamped at 0) so
    // releasing then re-holding fires immediately rather than after a stale CD.
    if (!isPrimaryFiring()) { if (inst.cd < 0) inst.cd = 0; return; }
    if (inst.cd > 0) return;

    if (!inst.profile) inst.profile = _profileFor(state.run && state.run.character);
    const prof = inst.profile;
    const hero = state.hero.pos;
    const row = _rankRow();   // auto-ranked from hero level; `level` arg ignored

    // Aim: player-pointed when actively aiming, nearest enemy otherwise.
    const manual = isManualAiming();
    let dir;
    if (manual) {
      dir = getAimDirection(_aimDir);
    } else {
      const t = _findNearestEnemy(hero);
      if (!t) { inst.cd = 0.08; return; }   // nothing in range — re-check soon
      const tp = t.mesh ? t.mesh.position : t.pos;
      const dx = tp.x - hero.x, dz = tp.z - hero.z;
      const m = Math.hypot(dx, dz) || 1;
      _aimDir.x = dx / m;
      _aimDir.z = dz / m;
      dir = _aimDir;
    }

    const baseAngle = Math.atan2(dir.z, dir.x);
    let dmg = row.dmg * prof.dmgMul * (state.hero.statMul.dmg || 1);
    // Manual-aim reward — aiming yourself beats the auto-target fallback.
    // (Crit applies globally in damageEnemy; no second roll here.)
    if (manual) dmg *= 1.3;
    const n = prof.count + row.count - 1;
    const opts = prof.ice ? ICE_OPTS : null;
    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * prof.spread;
      const a = baseAngle + offset;
      _shotDir.x = Math.cos(a);
      _shotDir.z = Math.sin(a);
      spawnAutoAimProjectile(hero, _shotDir, row, dmg, prof.speedMul, prof.pierceBonus, 'primary', opts);
    }
    try { sfx.weaponPrimary && sfx.weaponPrimary({ row: _lastSeenRank }); } catch (_) {}
    try { spawnPrimaryMuzzle(hero.x, hero.z, baseAngle); } catch (_) {}

    inst.cd = row.cooldown * prof.cdMul
      * (state.hero.statMul.cooldown || 1)
      * (state.run.passive_cooldown || 1);
  },
};

export default primary;
