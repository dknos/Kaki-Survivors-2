/**
 * Synergies — discoverable build combos that fire a one-shot power spike.
 *
 * A synergy triggers the first time a run owns a specific mix of weapons +
 * named passives (and optionally a specific avatar). On trigger it:
 *   - applies a permanent run buff (verified-safe channels only — see below),
 *   - fires a banner + screen FX + chime (the discovery moment),
 *   - drops a small gold bonus (the "coin bonus").
 *
 * Design notes:
 *   - Buffs write ONLY to channels that are set at run start and never rebuilt
 *     mid-run, so a later passive/weapon pick can't wipe them:
 *       state.hero.statMul.{dmg,area,cooldown,moveSpeed,duration}  (delta idiom
 *         in passives.js means these compose, never reset — verified),
 *       state.run.{passive_critChance,passive_dmgReduction,passive_coinMul},
 *       state.hero.regenPerSec, state.hero.hpMax/hp, state.run.gold.
 *   - Each synergy fires AT MOST once per run (guarded by the module `_active`
 *     Set). resetSynergies() clears it on every fresh-run path.
 *   - No scene / meshes: FX is state.fx flags + showBanner, mirroring how
 *     weapon evolutions announce. So there's no init/teardown to wire.
 *
 * Lifecycle mirrors miniEvents/portalShards: tickSynergies(dt) from the run
 * loop, resetSynergies() next to resetMiniEvents at each run-entry.
 */
import { state } from './state.js';
import { showBanner } from './ui.js';
import { sfx } from './audio.js';

// ── Tunables (balance levers) ────────────────────────────────────────────────
const SYN_POLL_INTERVAL = 0.4;   // sec between eligibility scans (cheap; no need per-frame)
const SYN_GOLD_REWARD   = 60;    // flat gold dropped by every synergy trigger
const SYN_BANNER_SEC    = 3.2;   // banner hold time
const SYN_SHAKE         = 0.45;  // screen-shake magnitude on trigger

// ── Definitions ──────────────────────────────────────────────────────────────
// requires: ALL listed weapons owned (any level) AND ALL listed passives owned
// (level >= 1) AND, if `avatar` is set, state.run.avatar matches.
// apply(s): mutate verified-safe channels only. `tag` is the short buff summary
// shown in the banner; `flavor` is reserved for a future codex entry.
export const SYNERGIES = [
  {
    id: 'sticky_situation', name: 'Sticky Situation', icon: '🕸️', accent: '#8ce66a',
    tag: '+25% AREA · +18% DMG', flavor: 'Webbed prey drowns in spores.',
    requires: { weapons: ['web', 'spore_cloud'] },
    apply(s) { s.hero.statMul.area *= 1.25; s.hero.statMul.dmg *= 1.18; },
  },
  {
    id: 'static_chill', name: 'Static Chill', icon: '❄️', accent: '#6fd8ff',
    tag: '+28% DMG · +10% CRIT', flavor: 'Frozen sparks shatter the swarm.',
    requires: { weapons: ['frostbloom', 'lightning_bug'] },
    apply(s) { s.hero.statMul.dmg *= 1.28; s.run.passive_critChance += 0.10; },
  },
  {
    id: 'fallout_bloom', name: 'Fallout Bloom', icon: '☢️', accent: '#c8ff5a',
    tag: '+22% DMG · +20% AREA', flavor: 'Radioactive spore clouds spread wide.',
    requires: { weapons: ['sig_radcat_fallout', 'spore_cloud'] },
    apply(s) { s.hero.statMul.dmg *= 1.22; s.hero.statMul.area *= 1.20; },
  },
  {
    id: 'nine_lucky_lives', name: 'Nine Lucky Lives', icon: '🍀', accent: '#ffd24a',
    tag: '+50% COIN · +12% CRIT', flavor: 'The lucky paw feeds the hoard.',
    requires: { weapons: ['sig_kitty_lucky_paw'], passives: ['greed'] },
    apply(s) { s.run.passive_coinMul += 0.50; s.run.passive_critChance += 0.12; s.run.gold += 80; },
  },
  {
    id: 'thornstorm', name: 'Thornstorm', icon: '🌹', accent: '#ff6ad0',
    tag: '+22% DMG · −12% COOLDOWN', flavor: 'Thorns ride the lightning.',
    requires: { weapons: ['briar_whip', 'chain'] },
    apply(s) { s.hero.statMul.dmg *= 1.22; s.hero.statMul.cooldown *= 0.88; },
  },
  {
    id: 'power_chord', name: 'Power Chord', icon: '🎸', accent: '#ff5a5a',
    tag: '+20% DMG · +8% MOVE', flavor: 'Turn it up to eleven lives.',
    requires: { weapons: ['sig_rocker_powerchord'], passives: ['berserk'] },
    apply(s) { s.hero.statMul.dmg *= 1.20; s.hero.statMul.moveSpeed *= 1.08; },
  },
  {
    id: 'frostbite_feast', name: 'Frostbite Feast', icon: '🩸', accent: '#8fb8ff',
    tag: '+3.5 REGEN · +15% DMG', flavor: 'Feed on the frozen.',
    requires: { weapons: ['frost_eternal'], passives: ['vampirism'] },
    apply(s) { s.hero.regenPerSec += 3.5; s.hero.statMul.dmg *= 1.15; },
  },
  {
    id: 'catnip_frenzy', name: 'Catnip Frenzy', icon: '🌿', accent: '#ff9a3d',
    tag: '+14% MOVE · +16% DMG', flavor: 'Pure feline chaos.',
    requires: { passives: ['wings', 'berserk'] },
    apply(s) { s.hero.statMul.moveSpeed *= 1.14; s.hero.statMul.dmg *= 1.16; },
  },
  {
    id: 'orbital_cattery', name: 'Orbital Cattery', icon: '🛰️', accent: '#a98bff',
    tag: '+25% AREA · +18% DMG', flavor: 'A ring of watchful kittens.',
    requires: { weapons: ['orbitals', 'sig_space_satellites'] },
    apply(s) { s.hero.statMul.area *= 1.25; s.hero.statMul.dmg *= 1.18; },
  },
  {
    id: 'guardians_vigil', name: "Guardian's Vigil", icon: '🛡️', accent: '#9fb0c4',
    tag: '+18% DMG-REDUCTION · +40 MAX HP', flavor: 'Nine lives, nine shields.',
    requires: { passives: ['armor', 'steadfast'] },
    apply(s) {
      s.run.passive_dmgReduction += 0.18;   // additive; capped at 0.75 downstream
      s.hero.hpMax += 40; s.hero.hp += 40;
    },
  },
];

// ── Module state ─────────────────────────────────────────────────────────────
const _active = new Set();   // synergy ids already triggered THIS run
let _pollAccum = 0;

// ── Matching ─────────────────────────────────────────────────────────────────
function _owns(weaponId) {
  const list = state.weapons;
  for (let i = 0; i < list.length; i++) if (list[i].id === weaponId) return true;
  return false;
}
function _hasPassive(passiveId) {
  const list = state.passives;
  for (let i = 0; i < list.length; i++) if (list[i].id === passiveId && (list[i].level || 0) >= 1) return true;
  return false;
}
function _satisfied(req) {
  if (req.avatar && (state.run.avatar !== req.avatar)) return false;
  if (req.weapons) for (const w of req.weapons) if (!_owns(w)) return false;
  if (req.passives) for (const p of req.passives) if (!_hasPassive(p)) return false;
  return true;
}

function _trigger(syn) {
  _active.add(syn.id);
  try { syn.apply(state); } catch (e) { console.warn('[synergies] apply', syn.id, e); }
  // Universal coin bonus (nine_lucky_lives adds more inside its apply()).
  state.run.gold = (state.run.gold || 0) + SYN_GOLD_REWARD;
  // Discovery FX — mirror the evolution announce: bloom flash + a little shake.
  state.fx.bloomBoost = 1.0;
  state.fx.shake = Math.max(state.fx.shake || 0, SYN_SHAKE);
  try { showBanner(`${syn.icon} SYNERGY: ${syn.name} — ${syn.tag}`, SYN_BANNER_SEC, syn.accent); } catch (_) {}
  try { sfx.evolutionChime && sfx.evolutionChime(); } catch (_) {}
  try { sfx.coinPickup && sfx.coinPickup(); } catch (_) {}
}

// ── Public API ───────────────────────────────────────────────────────────────
export function tickSynergies(dt) {
  if (state.mode !== 'run') return;
  if (_active.size >= SYNERGIES.length) return;   // all discovered — nothing left to scan
  _pollAccum += dt;
  if (_pollAccum < SYN_POLL_INTERVAL) return;
  _pollAccum = 0;
  for (const syn of SYNERGIES) {
    if (_active.has(syn.id)) continue;
    if (_satisfied(syn.requires)) _trigger(syn);
  }
}

export function resetSynergies() {
  _active.clear();
  _pollAccum = 0;
}

/** True once the given synergy has triggered this run (for a future HUD/codex). */
export function isSynergyActive(id) { return _active.has(id); }
