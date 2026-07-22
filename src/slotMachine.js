/**
 * Slot machine reward resolver. Three reels of weighted symbols.
 * Outcomes:
 *   - 7-7-7 jackpot: max-level a random owned weapon + full heal + dash-level up
 *   - 3-of-a-kind: apply that powerup 3x (or weapon max-level if owned)
 *   - 2-of-a-kind: apply that powerup 2x
 *   - All different: apply the rarest of the three
 *
 * UI/animation lives in ui.js (showSlotMachine). This module only owns the
 * symbol table + outcome resolution so it's testable / swappable.
 */
import { state } from './state.js';
import { WEAPONS } from './config.js';
import { REGISTRY, acquireWeapon, applyFiller } from './weapons/index.js';

// Each symbol carries enough metadata for resolution + display.
// 'weight' is the per-reel roll weight. Jackpot (7) is rarer.
export const SLOT_SYMBOLS = [
  { id: 'jackpot',  icon: '7️⃣', name: 'Jackpot',     weight: 6, kind: 'jackpot' },
  { id: 'orbitals', icon: '🌀', name: 'Orbitals',    weight: 5, kind: 'weapon' },
  { id: 'autoaim',  icon: '✨', name: 'Magic Miss.', weight: 5, kind: 'weapon' },
  { id: 'chain',    icon: '⚡', name: 'Chain',       weight: 5, kind: 'weapon' },
  { id: 'web',      icon: '🕸', name: 'Web',         weight: 5, kind: 'weapon' },
  { id: 'dash',     icon: '💨', name: 'Dash',        weight: 6, kind: 'filler' },
  { id: 'heal',     icon: '🍞', name: 'Heal',        weight: 8, kind: 'filler' },
  { id: 'maxhp',    icon: '❤️', name: 'Max HP',      weight: 6, kind: 'filler' },
  { id: 'speed',    icon: '👟', name: 'Speed',       weight: 6, kind: 'filler' },
  { id: 'magnet',   icon: '🧲', name: 'Magnet',      weight: 6, kind: 'filler' },
  { id: 'damage',   icon: '⚔️', name: 'Damage',      weight: 6, kind: 'filler' },
  { id: 'cooldown', icon: '⏱️', name: 'Cooldown',    weight: 6, kind: 'filler' },
  { id: 'zoomout',  icon: '🔍', name: 'Zoom',        weight: 5, kind: 'filler' },
];

// Draft-mirror weighting (weaponChoices in weapons/index.js gives owned
// below-max upgrades 3× weight): chests should level the player's build,
// not scatter level-1 weapons. Recomputed per roll — ownership shifts mid-run.
const OWNED_UPGRADE_WEIGHT_MULT = 3;

function _effectiveWeight(s) {
  if (s.kind !== 'weapon') return s.weight;
  const mod = REGISTRY[s.id];
  const owned = state.weapons.find(w => w.id === s.id);
  if (owned && mod && owned.level < mod.maxLevel) return s.weight * OWNED_UPGRADE_WEIGHT_MULT;
  return s.weight;
}

export function rollReel() {
  let total = 0;
  for (const s of SLOT_SYMBOLS) total += _effectiveWeight(s);
  let r = Math.random() * total;
  for (const s of SLOT_SYMBOLS) {
    r -= _effectiveWeight(s);
    if (r <= 0) return s;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

function _slotsUsed() {
  let used = 0;
  for (const w of state.weapons) {
    const m = REGISTRY[w.id];
    if (m && !m.hidden) used += 1;
  }
  return used;
}

/**
 * acquireWeapon silently no-ops at maxLevel and never checks the maxSlots
 * cap, so a weapon reward must re-route when the rolled id can't honestly
 * take it: owned-at-max OR unowned-at-cap → lowest-level owned non-hidden
 * below-max weapon. Deterministic pick so the modal preview and
 * applyOutcome always agree. Returns null when nothing is upgradeable.
 */
export function resolveWeaponTarget(id) {
  const mod = REGISTRY[id];
  const owned = state.weapons.find(w => w.id === id);
  if (owned && mod && owned.level < mod.maxLevel) return id;
  if (!owned && _slotsUsed() < WEAPONS.maxSlots) return id;
  let best = null;
  for (const w of state.weapons) {
    const m = REGISTRY[w.id];
    if (!m || m.hidden || w.level >= m.maxLevel) continue;
    if (!best || w.level < best.level) best = w;
  }
  return best ? best.id : null;
}

/**
 * Display-only projection for ui.js ("ORBITALS +1 → Lv N"). Returns null
 * when the reward will fall through to a filler (every weapon maxed).
 */
export function previewWeaponGrant(symbolId, count) {
  const target = resolveWeaponTarget(symbolId);
  if (!target) return null;
  const mod = REGISTRY[target];
  const owned = state.weapons.find(w => w.id === target);
  const max = mod && mod.maxLevel ? mod.maxLevel : 8;
  const from = owned ? owned.level : 0;
  return {
    id: target,
    name: (mod && mod.name) || target,
    isNew: !owned,
    redirected: target !== symbolId,
    toLevel: Math.min(max, from + count),
    // Reps that actually land on this target — applyOutcome re-routes
    // overflow per rep, so a TRIPLE on a 7/8 weapon is really +1 here.
    effReps: owned ? Math.min(count, max - from) : count,
  };
}

export function rollThreeReels() {
  return [rollReel(), rollReel(), rollReel()];
}

/**
 * Resolve final reels into an outcome.
 * Returns: { tier: 'jackpot'|'triple'|'double'|'single', symbol, count, label }
 */
export function resolveOutcome(reels) {
  const a = reels[0], b = reels[1], c = reels[2];
  const allSame = a.id === b.id && b.id === c.id;
  if (allSame && a.id === 'jackpot') {
    return { tier: 'jackpot', symbol: a, count: 3, label: '777 JACKPOT!' };
  }
  if (allSame) {
    return { tier: 'triple', symbol: a, count: 3, label: 'TRIPLE!' };
  }
  // Two of a kind?
  if (a.id === b.id) return { tier: 'double', symbol: a, count: 2, label: 'PAIR' };
  if (b.id === c.id) return { tier: 'double', symbol: b, count: 2, label: 'PAIR' };
  if (a.id === c.id) return { tier: 'double', symbol: a, count: 2, label: 'PAIR' };
  // All different — pick rarest (lowest weight)
  const sorted = [a, b, c].sort((x, y) => x.weight - y.weight);
  return { tier: 'single', symbol: sorted[0], count: 1, label: 'PICK' };
}

/**
 * Apply outcome rewards to state.
 * Idempotent: callers should call once per slot resolve.
 */
export function applyOutcome(outcome) {
  const s = outcome.symbol;

  // Jackpot — super combo
  if (outcome.tier === 'jackpot') {
    import('./ui.js').then(({ tryAchievement, trySecret }) => {
      tryAchievement('first_jackpot');
      import('./meta.js').then(({ bumpLifetime }) => {
        const total = bumpLifetime('jackpots', 1);
        if (total >= 3) trySecret('triple_jackpot');
      });
    });
    // 1) Max level a random owned upgradeable weapon. Hidden slots (the
    // auto-ranked primary, forest specials) are excluded — their entry.level
    // is meaningless and a jackpot landing there silently wasted the
    // headline reward. Falls back to a redirect when everything is maxed.
    const owned = state.weapons.filter(w => {
      const m = REGISTRY[w.id];
      return m && !m.hidden && w.level < (m.maxLevel || 8);
    });
    if (owned.length > 0) {
      const pick = owned[Math.floor(Math.random() * owned.length)];
      const mod = REGISTRY[pick.id];
      while (pick.level < (mod && mod.maxLevel ? mod.maxLevel : 8)) {
        acquireWeapon(pick.id);
      }
    } else {
      // Nothing upgradeable (early jackpot where only hidden slots exist, or
      // everything maxed) — grant a new level-1 weapon instead. Sig kits are
      // avatar-locked and never jackpot-grantable.
      const ids = Object.keys(REGISTRY).filter(id => {
        const m = REGISTRY[id];
        return m && !m.hidden && !id.startsWith('sig_')
          && !state.weapons.find(w => w.id === id);
      });
      if (ids.length) acquireWeapon(ids[Math.floor(Math.random() * ids.length)]);
    }
    // 2) Full heal + max HP bump
    state.hero.hp = state.hero.hpMax;
    applyFiller({ id: 'maxhp' });
    // 3) Dash unlock + bump
    applyFiller({ id: 'dash' });
    // 4) Generic damage buff
    applyFiller({ id: 'damage' });
    applyFiller({ id: 'damage' });
    return;
  }

  // Triple: apply 3x. For weapons that's effectively a fast-track upgrade.
  // Double: apply 2x. Single: apply 1x.
  const reps = outcome.count;

  if (s.kind === 'weapon') {
    // Re-resolve per rep: a triple can max the target mid-way; overflow
    // re-routes to the next upgradeable weapon instead of no-opping.
    for (let i = 0; i < reps; i++) {
      const target = resolveWeaponTarget(s.id);
      if (target) acquireWeapon(target);
      else applyFiller({ id: 'damage' });
    }
    return;
  }

  if (s.kind === 'filler') {
    for (let i = 0; i < reps; i++) applyFiller({ id: s.id });
    return;
  }

  // Jackpot symbol but not triple — fall back to a generic damage buff
  applyFiller({ id: 'damage' });
}
