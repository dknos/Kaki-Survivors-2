#!/usr/bin/env node
/** Pure deterministic smoke for stage rosters and themed encounter weighting. */
import { ENEMY_TIERS } from '../src/config.js';
import {
  enemyEncounterTierWeight,
  getEnemyEncounterDebugState,
  isEnemyTierAllowedForStage,
  noteEnemyEncounterPick,
  noteEnemyEncounterPoolSize,
  resetEnemyEncounterDeck,
  syncEnemyEncounterDeck,
} from '../src/enemyEncounterDeck.js';

const failures = [];
const stages = ['forest', 'twilight', 'cinder', 'void', 'cave'];
const tier = (id) => ENEMY_TIERS.find((entry) => entry.glb === id);
const assert = (ok, message) => { if (!ok) failures.push(message); };

// Every authored stage must have a legal opening tier and a useful late pool.
for (const stageId of stages) {
  const native = ENEMY_TIERS.filter((entry) => isEnemyTierAllowedForStage(stageId, entry));
  assert(native.some((entry) => entry.minD <= 0), `${stageId}: no D0 opening tier`);
  assert(native.length >= 10, `${stageId}: roster too narrow (${native.length})`);
  if (stageId !== 'forest') {
    assert(!native.some((entry) => entry.family === 'bug'), `${stageId}: Forest bug leaked`);
  }
}
assert(isEnemyTierAllowedForStage('forest', tier('ant')), 'Forest rejects native ant');
assert(!isEnemyTierAllowedForStage('forest', tier('xeno')), 'Forest accepts Void xeno');
assert(isEnemyTierAllowedForStage('void', tier('xeno')), 'Void rejects native xeno');
assert(!isEnemyTierAllowedForStage('cinder', tier('wolf')), 'Cinder accepts Twilight wolf');
assert(!isEnemyTierAllowedForStage('cave', tier('robot')), 'Cave accepts machine family');
assert(!isEnemyTierAllowedForStage('void', tier('skel_minion')), 'Dungeon tier leaked overworld');

function sequence(stageId, seed) {
  resetEnemyEncounterDeck();
  const out = [];
  for (let slot = 0; slot < 12; slot++) {
    const state = syncEnemyEncounterDeck(stageId, seed, 36 + slot * 45, 10);
    out.push(state.cardId);
    if (slot > 0) assert(out[slot] !== out[slot - 1],
      `${stageId}: repeated card ${out[slot]} in adjacent slots`);
    assert(state.active && state.focusIds && state.focusIds.length,
      `${stageId}: empty card at slot ${slot}`);
    for (const id of state.focusIds || []) {
      assert(isEnemyTierAllowedForStage(stageId, tier(id)),
        `${stageId}: card ${state.cardId} focuses non-native ${id}`);
    }
  }
  return out;
}

const replayA = sequence('forest', 0x1234abcd);
const replayB = sequence('forest', 0x1234abcd);
const replayC = sequence('forest', 0xcafef00d);
assert(JSON.stringify(replayA) === JSON.stringify(replayB), 'same seed did not replay');
assert(JSON.stringify(replayA) !== JSON.stringify(replayC), 'different seeds made same deck');

resetEnemyEncounterDeck();
const stableRef = getEnemyEncounterDebugState();
const first = syncEnemyEncounterDeck('twilight', 77, 36, 0);
const firstCard = first.cardId;
syncEnemyEncounterDeck('twilight', 77, 42, 10);
assert(getEnemyEncounterDebugState().cardId === firstCard,
  'card changed when difficulty crossed a gate mid-beat');
assert(getEnemyEncounterDebugState() === stableRef, 'debug state allocates per poll');

const focusId = getEnemyEncounterDebugState().focusIds[0];
const focusTier = tier(focusId);
const twilightPool = ENEMY_TIERS.filter((entry) =>
  isEnemyTierAllowedForStage('twilight', entry) && !getEnemyEncounterDebugState().focusIds.includes(entry.glb));
const backgroundTier = twilightPool[0];
assert(enemyEncounterTierWeight(focusTier) > focusTier.weight,
  'focused standard weight was not boosted');
assert(enemyEncounterTierWeight(backgroundTier) < backgroundTier.weight,
  'background standard weight was not damped');
assert(enemyEncounterTierWeight(focusTier, true) > enemyEncounterTierWeight(focusTier),
  'horde card was not more focused than top-up card');

noteEnemyEncounterPoolSize(13);
noteEnemyEncounterPick(focusTier);
noteEnemyEncounterPick(backgroundTier);
assert(stableRef.poolSize === 13 && stableRef.totalPicks === 2 && stableRef.focusPicks === 1,
  `debug counters invalid (${JSON.stringify(stableRef)})`);

syncEnemyEncounterDeck('twilight', 77, 55, 10);
assert(!stableRef.active && stableRef.cardId === null, 'quiet window stayed biased');

if (failures.length) {
  console.error(`[smoke-enemy-encounter-deck] FAIL (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log('[smoke-enemy-encounter-deck] PASS');
console.log(JSON.stringify({ forestSeedA: replayA, forestSeedB: replayC }, null, 2));
