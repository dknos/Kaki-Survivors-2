/**
 * MaoMao's persistent virtual-pet state.
 *
 * This module is deliberately DOM/THREE-free. meta.js can use the pure
 * normalizer at run-commit time without creating an import cycle, while the
 * town world and daycare overlay share exactly the same progression rules.
 */
import { DAYCARE_OUTFITS } from './config.js';

export const MAOMAO_NAME = 'MaoMao';
export const MAOMAO_MAX_ENERGY = 3;

const CARE_REWARDS = Object.freeze({
  pet:   { happiness: 4, bond: 4 },
  feed:  { happiness: 6, bond: 5, energy: 1 },
  groom: { happiness: 5, bond: 5 },
});

function clampInt(value, lo, hi, fallback = lo) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
}

/**
 * Upgrade the old singleton Momo shape in place. Existing players keep their
 * happiness, outfits, gift date, and adopted cat; fresh/unfinished profiles
 * receive MaoMao's encounter after their first completed Hunt.
 */
export function normalizeMaoMao(meta) {
  const old = (meta && meta.daycare && typeof meta.daycare === 'object') ? meta.daycare : {};
  if (old.version === 2 && old.catId === 'maomao') {
    old.name = MAOMAO_NAME;
    old.happiness = clampInt(old.happiness, 0, 100, 0);
    old.energy = clampInt(old.energy, 0, MAOMAO_MAX_ENERGY, MAOMAO_MAX_ENERGY);
    old.bondXp = Math.max(0, clampInt(old.bondXp, 0, 999999, 0));
    old.careCycle = Math.max(0, clampInt(old.careCycle, 0, 999999, meta?.runs || 0));
    old.rescueStep = clampInt(old.rescueStep, 0, 3, old.adopted ? 3 : 0);
    old.adopted = !!old.adopted;
    old.rescued = old.adopted; // legacy reader compatibility
    old.encounterUnlocked = !!(old.encounterUnlocked || old.adopted || (meta?.runs || 0) > 0);
    old.careClaims = (old.careClaims && typeof old.careClaims === 'object') ? old.careClaims : {};
    old.unlockedOutfits = Array.isArray(old.unlockedOutfits) ? old.unlockedOutfits : [];
    old.equippedOutfit = old.equippedOutfit || null;
    return old;
  }

  const adopted = !!old.rescued;
  const migrated = {
    version: 2,
    catId: 'maomao',
    name: MAOMAO_NAME,
    encounterUnlocked: adopted || (meta?.runs || 0) > 0,
    adopted,
    rescued: adopted,
    rescueStep: adopted ? 3 : 0,
    adoptedAt: adopted ? (old.adoptedAt || Date.now()) : null,
    happiness: clampInt(old.happiness, 0, 100, adopted ? 18 : 0),
    energy: clampInt(old.energy, 0, MAOMAO_MAX_ENERGY, MAOMAO_MAX_ENERGY),
    bondXp: Math.max(0, clampInt(old.bondXp, 0, 999999, (old.careTotal || 0) * 4)),
    careTotal: Math.max(0, clampInt(old.careTotal, 0, 999999, 0)),
    careCycle: Math.max(0, clampInt(old.careCycle, 0, 999999, meta?.runs || 0)),
    careClaims: {},
    unlockedOutfits: Array.isArray(old.unlockedOutfits) ? old.unlockedOutfits.slice() : [],
    equippedOutfit: old.equippedOutfit || null,
    lastGiftDay: old.lastGiftDay || null,
    yarnBest: Math.max(0, clampInt(old.yarnBest, 0, 999999, 0)),
  };
  meta.daycare = migrated;
  return migrated;
}

export function advanceMaoMaoAfterRun(meta) {
  const pet = normalizeMaoMao(meta);
  const encounterNew = !pet.encounterUnlocked && !pet.adopted;
  pet.encounterUnlocked = true;
  pet.careCycle += 1;
  if (pet.adopted) pet.energy = Math.min(MAOMAO_MAX_ENERGY, pet.energy + 1);
  return { encounterNew, careCycle: pet.careCycle };
}

export function setMaoMaoRescueStep(meta, step) {
  const pet = normalizeMaoMao(meta);
  if (!pet.encounterUnlocked || pet.adopted) return pet.rescueStep;
  pet.rescueStep = Math.max(pet.rescueStep, clampInt(step, 0, 3, pet.rescueStep));
  return pet.rescueStep;
}

export function adoptMaoMao(meta) {
  const pet = normalizeMaoMao(meta);
  if (pet.adopted || !pet.encounterUnlocked || pet.rescueStep < 3) return false;
  pet.adopted = true;
  pet.rescued = true;
  pet.adoptedAt = Date.now();
  pet.happiness = Math.max(18, pet.happiness);
  pet.energy = MAOMAO_MAX_ENERGY;
  pet.bondXp = Math.max(4, pet.bondXp);
  return true;
}

function unlockHappinessOutfits(pet) {
  const unlocked = [];
  for (const outfit of DAYCARE_OUTFITS) {
    if (!Number.isFinite(outfit.unlockAt)) continue; // exclusive/event wearables
    if (pet.happiness >= outfit.unlockAt && !pet.unlockedOutfits.includes(outfit.id)) {
      pet.unlockedOutfits.push(outfit.id);
      unlocked.push(outfit);
    }
  }
  return unlocked;
}

/** Full numerical care is available once per action per completed-Hunt cycle. */
export function careForMaoMao(meta, action) {
  const pet = normalizeMaoMao(meta);
  const spec = CARE_REWARDS[action];
  if (!pet.adopted || !spec) return { ok: false, rewarded: false, unlocked: [], pet };

  const rewarded = pet.careClaims[action] !== pet.careCycle;
  if (rewarded) {
    pet.careClaims[action] = pet.careCycle;
    pet.happiness = Math.min(100, pet.happiness + spec.happiness);
    pet.bondXp += spec.bond;
    pet.careTotal += 1;
    if (spec.energy) pet.energy = Math.min(MAOMAO_MAX_ENERGY, pet.energy + spec.energy);
  }
  return { ok: true, rewarded, unlocked: rewarded ? unlockHappinessOutfits(pet) : [], pet };
}

export function canRewardYarnGame(meta) {
  const pet = normalizeMaoMao(meta);
  return !!(pet.adopted && pet.energy > 0 && pet.careClaims.play !== pet.careCycle);
}

export function finishMaoMaoYarnGame(meta, score) {
  const pet = normalizeMaoMao(meta);
  const cleanScore = clampInt(score, 0, 999, 0);
  pet.yarnBest = Math.max(pet.yarnBest || 0, cleanScore);
  const rewarded = canRewardYarnGame(meta);
  if (rewarded) {
    pet.careClaims.play = pet.careCycle;
    pet.energy = Math.max(0, pet.energy - 1);
    pet.happiness = Math.min(100, pet.happiness + 6 + Math.min(4, cleanScore));
    pet.bondXp += 5 + Math.min(4, Math.floor(cleanScore / 2));
    pet.careTotal += 1;
  }
  return { ok: pet.adopted, rewarded, unlocked: rewarded ? unlockHappinessOutfits(pet) : [], pet };
}

export function maoMaoBond(petOrMeta) {
  const pet = petOrMeta?.daycare ? normalizeMaoMao(petOrMeta) : petOrMeta;
  const xp = Math.max(0, pet?.bondXp || 0);
  const ranks = [
    { name: 'Settling In', min: 0, next: 20 },
    { name: 'Neighbor', min: 20, next: 60 },
    { name: 'Friend', min: 60, next: 130 },
    { name: 'Family', min: 130, next: 220 },
    { name: 'Forever Friend', min: 220, next: null },
  ];
  let rank = ranks[0];
  for (const candidate of ranks) if (xp >= candidate.min) rank = candidate;
  const progress = rank.next ? (xp - rank.min) / (rank.next - rank.min) : 1;
  return { ...rank, xp, progress: Math.max(0, Math.min(1, progress)) };
}

export function maoMaoMood(petOrMeta) {
  const pet = petOrMeta?.daycare ? normalizeMaoMao(petOrMeta) : petOrMeta;
  const h = pet?.happiness || 0;
  if (h >= 90) return `${MAOMAO_NAME} has the zoomies!`;
  if (h >= 55) return `${MAOMAO_NAME} is purring very loudly.`;
  if (h >= 25) return `${MAOMAO_NAME} feels safe and cozy.`;
  return `${MAOMAO_NAME} is still getting comfortable.`;
}
