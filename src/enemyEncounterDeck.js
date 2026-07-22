/**
 * Deterministic, stage-authored encounter beats for the overworld director.
 *
 * This module deliberately owns no spawning. It only answers two cheap
 * questions for spawnDirector:
 *   1. Is this tier native to the current biome?
 *   2. What weight should it have during the current encounter card?
 *
 * Cards are derived from (stage, run seed, time slot), so replay seeds produce
 * the same themed beats without consuming dailyRng's shared spawn stream.
 */

// The normal horde lands every 45s. Open each card nine seconds beforehand so
// top-up spawns preview its silhouette, then let the horde deliver the payoff.
const FIRST_CARD_AT_SEC = 36;
const CARD_INTERVAL_SEC = 45;
const CARD_DURATION_SEC = 18;

const STANDARD_FOCUS_MUL = 4.25;
const STANDARD_BACKGROUND_MUL = 0.42;
const HORDE_FOCUS_MUL = 6.5;
const HORDE_BACKGROUND_MUL = 0.18;

function _set(ids) { return new Set(ids); }

// Natural overworld rosters only. Timed mini/final bosses keep their explicit
// choices in spawnDirector and therefore remain outside this filter contract.
const _allowedByStage = Object.freeze({
  forest: _set([
    'zombie', 'goblin', 'slime', 'spider', 'wolf', 'wizard',
    'clockwork_mouse', 'yarn_wisp', 'giant', 'dragon_evo',
    'ant', 'beetle', 'ladybug', 'grasshopper', 'butterfly', 'bee',
    'cockroach', 'wasp', 'caterpillar', 'mantis',
  ]),
  twilight: _set([
    'zombie', 'goblin', 'skeleton', 'slime', 'spider', 'wolf', 'wizard',
    'ghost', 'clockwork_mouse', 'yarn_wisp', 'giant', 'dragon_evo',
  ]),
  cinder: _set([
    'zombie', 'goblin', 'skeleton', 'orc', 'demon', 'robot', 'mech',
    'slime', 'wizard', 'ghost', 'giant', 'dragon', 'dragon_evo',
  ]),
  void: _set([
    'zombie', 'skeleton', 'demon', 'robot', 'mech', 'xeno', 'slime',
    'wizard', 'ghost', 'clockwork_mouse', 'yarn_wisp', 'giant',
    'dragon_evo',
  ]),
  cave: _set([
    'zombie', 'goblin', 'skeleton', 'orc', 'slime', 'spider', 'wolf',
    'wizard', 'ghost', 'clockwork_mouse', 'yarn_wisp', 'giant',
    'dragon', 'dragon_evo',
  ]),
});

function _card(id, label, minD, focusIds) {
  return Object.freeze({
    id,
    label,
    minD,
    focus: _set(focusIds),
    focusIds: Object.freeze(focusIds.slice()),
  });
}

// Ordered by minD. That lets _eligibleCardCount remain allocation-free.
const _decks = Object.freeze({
  forest: Object.freeze([
    _card('garden_march', 'Garden March', 0.0,
      ['ant', 'beetle', 'ladybug', 'zombie']),
    _card('wingbeat_bloom', 'Wingbeat Bloom', 0.8,
      ['butterfly', 'bee', 'wasp']),
    _card('underbrush_rush', 'Underbrush Rush', 1.0,
      ['grasshopper', 'cockroach', 'spider', 'wolf']),
    _card('runaway_toys', 'Runaway Toys', 1.4,
      ['clockwork_mouse', 'yarn_wisp', 'wizard']),
    _card('old_growth', 'Old Growth', 2.5,
      ['caterpillar', 'mantis', 'slime', 'giant']),
  ]),
  twilight: Object.freeze([
    _card('duskcap_drift', 'Duskcap Drift', 0.0,
      ['zombie', 'goblin', 'slime']),
    _card('witching_hour', 'Witching Hour', 0.8,
      ['wizard', 'yarn_wisp', 'ghost']),
    _card('restless_lanterns', 'Restless Lanterns', 0.9,
      ['skeleton', 'ghost', 'yarn_wisp']),
    _card('moonfang_hunt', 'Moonfang Hunt', 1.2,
      ['spider', 'wolf', 'clockwork_mouse']),
    _card('eclipse_omen', 'Eclipse Omen', 4.0,
      ['ghost', 'giant', 'dragon_evo']),
  ]),
  cinder: Object.freeze([
    _card('ashling_scramble', 'Ashling Scramble', 0.0,
      ['zombie', 'goblin', 'demon']),
    _card('ember_coven', 'Ember Coven', 0.8,
      ['wizard', 'demon', 'ghost']),
    _card('slag_tide', 'Slag Tide', 1.5,
      ['slime', 'orc', 'demon']),
    _card('furnace_guard', 'Furnace Guard', 1.8,
      ['orc', 'robot', 'mech']),
    _card('dragon_roost', 'Dragon Roost', 2.2,
      ['demon', 'dragon', 'dragon_evo']),
  ]),
  void: Object.freeze([
    _card('grave_static', 'Grave Static', 0.0,
      ['zombie', 'skeleton', 'ghost']),
    _card('arcane_echo', 'Arcane Echo', 0.8,
      ['wizard', 'yarn_wisp', 'ghost']),
    _card('machine_wake', 'Machine Wake', 1.4,
      ['clockwork_mouse', 'robot', 'mech']),
    _card('breach_brood', 'Breach Brood', 1.5,
      ['slime', 'demon', 'xeno']),
    _card('eclipse_host', 'Eclipse Host', 4.0,
      ['ghost', 'xeno', 'dragon_evo']),
  ]),
  cave: Object.freeze([
    _card('fungal_scurry', 'Fungal Scurry', 0.0,
      ['zombie', 'goblin', 'slime']),
    _card('glowmoss_magic', 'Glowmoss Magic', 0.8,
      ['wizard', 'yarn_wisp', 'slime']),
    _card('bone_seam', 'Bone Seam', 0.9,
      ['skeleton', 'ghost']),
    _card('web_tunnels', 'Web Tunnels', 1.2,
      ['spider', 'wolf', 'clockwork_mouse']),
    _card('stonebreakers', 'Stonebreakers', 1.8,
      ['orc', 'giant', 'dragon']),
  ]),
});

let _activeCard = null;
let _lastCard = null;
let _activeStageId = '';
let _activeSeed = 0;
let _trackedSlot = -2;
let _trackedActive = false;

// Stable object identity makes this safe for a dev HUD to poll without making
// garbage. Treat the returned object as read-only.
const _debug = Object.seal({
  stageId: '',
  seed: 0,
  slot: -1,
  active: false,
  cardId: null,
  cardLabel: '',
  focusIds: null,
  startsAt: 0,
  endsAt: 0,
  nextBeatAt: FIRST_CARD_AT_SEC,
  remainingSec: FIRST_CARD_AT_SEC,
  eligibleCards: 0,
  poolSize: 0,
  totalPicks: 0,
  focusPicks: 0,
  lastTierId: '',
});

function _hashString(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _mix32(v) {
  v = (v ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 0x7feb352d) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0;
  v = Math.imul(v, 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

function _normaliseSeed(seed) {
  return Number.isFinite(seed) ? seed >>> 0 : _hashString(String(seed || 0));
}

function _eligibleCardCount(deck, difficulty) {
  let count = 0;
  while (count < deck.length && deck[count].minD <= difficulty) count++;
  return count;
}

function _pickCard(deck, stageId, seed, slot, eligibleCount) {
  // Rotate through each currently unlocked deck before rolling a new offset.
  // This feels authored while remaining stateless and exactly replayable.
  const cycle = Math.floor(slot / eligibleCount);
  const salt = _mix32(seed ^ _hashString(stageId) ^ Math.imul(cycle + 1, 0x9e3779b1));
  return deck[(salt + slot) % eligibleCount];
}

export function resetEnemyEncounterDeck() {
  _activeCard = null;
  _lastCard = null;
  _activeStageId = '';
  _activeSeed = 0;
  _trackedSlot = -2;
  _trackedActive = false;
  _debug.stageId = '';
  _debug.seed = 0;
  _debug.slot = -1;
  _debug.active = false;
  _debug.cardId = null;
  _debug.cardLabel = '';
  _debug.focusIds = null;
  _debug.startsAt = 0;
  _debug.endsAt = 0;
  _debug.nextBeatAt = FIRST_CARD_AT_SEC;
  _debug.remainingSec = FIRST_CARD_AT_SEC;
  _debug.eligibleCards = 0;
  _debug.poolSize = 0;
  _debug.totalPicks = 0;
  _debug.focusPicks = 0;
  _debug.lastTierId = '';
}

/** Advance the deterministic encounter schedule. Call once per director slice. */
export function syncEnemyEncounterDeck(stageId, seed, timeSec, difficulty) {
  const id = stageId || '';
  const runSeed = _normaliseSeed(seed);
  const t = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  const D = Math.max(0, Number.isFinite(difficulty) ? difficulty : 0);
  const deck = _decks[id];

  if (_activeStageId !== id || _activeSeed !== runSeed) {
    _activeStageId = id;
    _activeSeed = runSeed;
    _trackedSlot = -2;
    _trackedActive = false;
    _lastCard = null;
    _debug.totalPicks = 0;
    _debug.focusPicks = 0;
    _debug.lastTierId = '';
  }

  _debug.stageId = id;
  _debug.seed = runSeed;

  if (!deck || t < FIRST_CARD_AT_SEC) {
    _activeCard = null;
    _debug.slot = -1;
    _debug.active = false;
    _debug.cardId = null;
    _debug.cardLabel = '';
    _debug.focusIds = null;
    _debug.startsAt = 0;
    _debug.endsAt = 0;
    _debug.nextBeatAt = FIRST_CARD_AT_SEC;
    _debug.remainingSec = Math.max(0, FIRST_CARD_AT_SEC - t);
    _debug.eligibleCards = deck ? _eligibleCardCount(deck, D) : 0;
    return _debug;
  }

  const elapsed = t - FIRST_CARD_AT_SEC;
  const slot = Math.floor(elapsed / CARD_INTERVAL_SEC);
  const startsAt = FIRST_CARD_AT_SEC + slot * CARD_INTERVAL_SEC;
  const endsAt = startsAt + CARD_DURATION_SEC;
  const isActive = t < endsAt;
  const eligibleCount = _eligibleCardCount(deck, D);
  // Keep the selected card stable for its full 18-second window. Difficulty
  // can cross a card's minD halfway through the beat; re-rolling at that edge
  // would make the visual theme abruptly change without a new time slot.
  const sameActiveSlot = _trackedSlot === slot && _trackedActive && _activeCard;
  let card = isActive && eligibleCount > 0
    ? (sameActiveSlot || _pickCard(deck, id, runSeed, slot, eligibleCount))
    : null;
  if (!sameActiveSlot && card && card === _lastCard && eligibleCount > 1) {
    card = deck[(deck.indexOf(card) + 1) % eligibleCount];
  }

  if (_trackedSlot !== slot || _trackedActive !== isActive || _activeCard !== card) {
    _debug.totalPicks = 0;
    _debug.focusPicks = 0;
    _debug.lastTierId = '';
    _trackedSlot = slot;
    _trackedActive = isActive;
  }
  _activeCard = card;
  if (card) _lastCard = card;

  _debug.slot = slot;
  _debug.active = !!card;
  _debug.cardId = card ? card.id : null;
  _debug.cardLabel = card ? card.label : '';
  _debug.focusIds = card ? card.focusIds : null;
  _debug.startsAt = startsAt;
  _debug.endsAt = card ? endsAt : 0;
  _debug.nextBeatAt = card ? endsAt : startsAt + CARD_INTERVAL_SEC;
  _debug.remainingSec = Math.max(0, _debug.nextBeatAt - t);
  _debug.eligibleCards = eligibleCount;
  return _debug;
}

/** Strict biome gate for ordinary top-up and horde tiers. */
export function isEnemyTierAllowedForStage(stageId, tier) {
  if (!tier || tier.dungeon || !(tier.weight > 0)) return false;
  const allowed = _allowedByStage[stageId];
  if (allowed) return allowed.has(tier.glb);
  // Defensive fallback for future stages: core roster only. Forest bugs are
  // stage-lazy-loaded, so allowing them in an unknown biome can spawn nulls.
  return tier.family !== 'bug';
}

/** Effective pick weight; does not allocate or consume any random values. */
export function enemyEncounterTierWeight(tier, horde = false) {
  const base = tier && tier.weight > 0 ? tier.weight : 0;
  if (base === 0 || !_activeCard) return base;
  const focused = _activeCard.focus.has(tier.glb);
  if (horde) return base * (focused ? HORDE_FOCUS_MUL : HORDE_BACKGROUND_MUL);
  return base * (focused ? STANDARD_FOCUS_MUL : STANDARD_BACKGROUND_MUL);
}

export function noteEnemyEncounterPoolSize(size) {
  _debug.poolSize = Math.max(0, size | 0);
}

export function noteEnemyEncounterPick(tier) {
  if (!tier) return;
  _debug.totalPicks++;
  _debug.lastTierId = tier.glb || '';
  if (_activeCard && _activeCard.focus.has(tier.glb)) _debug.focusPicks++;
}

export function getEnemyEncounterDebugState() { return _debug; }
