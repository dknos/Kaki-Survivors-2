#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { DAYCARE_OUTFITS } from '../src/config.js';
import {
  adoptMaoMao,
  advanceMaoMaoAfterRun,
  canRewardYarnGame,
  careForMaoMao,
  finishMaoMaoYarnGame,
  maoMaoBond,
  normalizeMaoMao,
  setMaoMaoRescueStep,
} from '../src/maomaoState.js';

let pass = 0;
const ok = (message) => { pass++; console.log('[OK] ' + message); };

// Legacy players keep their rescued cat/progress, only the authored name changes.
{
  const meta = { runs: 12, daycare: { rescued: true, happiness: 73, careTotal: 9,
    unlockedOutfits: ['beanie', 'scarf'], equippedOutfit: 'scarf', lastGiftDay: '2026-07-09' } };
  const pet = normalizeMaoMao(meta);
  assert.equal(pet.name, 'MaoMao');
  assert.equal(pet.adopted, true);
  assert.equal(pet.happiness, 73);
  assert.equal(pet.bondXp, 36);
  assert.deepEqual(pet.unlockedOutfits, ['beanie', 'scarf']);
  assert.equal(pet.equippedOutfit, 'scarf');
  ok('legacy Momo save migrates losslessly to adopted MaoMao');
}

// Fresh profiles get an encounter after a completed Hunt, not auto-adoption.
{
  const meta = { runs: 0, daycare: {} };
  let pet = normalizeMaoMao(meta);
  assert.equal(pet.encounterUnlocked, false);
  const run = advanceMaoMaoAfterRun(meta);
  assert.equal(run.encounterNew, true);
  assert.equal(pet.encounterUnlocked, true);
  assert.equal(pet.adopted, false);
  setMaoMaoRescueStep(meta, 1);
  setMaoMaoRescueStep(meta, 2);
  setMaoMaoRescueStep(meta, 1); // monotonic; old inputs cannot rewind the puzzle
  assert.equal(pet.rescueStep, 2);
  assert.equal(adoptMaoMao(meta), false, 'cannot adopt before jump step');
  setMaoMaoRescueStep(meta, 3);
  assert.equal(adoptMaoMao(meta), true);
  assert.equal(pet.adopted, true);
  assert.equal(pet.happiness, 18);
  ok('Hunt unlock → three-step rescue → explicit adoption');
}

// Care progression rewards once per run cycle; affection animations can repeat.
{
  const meta = { runs: 1, daycare: { rescued: true, happiness: 18, careTotal: 0 } };
  const first = careForMaoMao(meta, 'pet');
  const repeat = careForMaoMao(meta, 'pet');
  assert.equal(first.rewarded, true);
  assert.equal(repeat.rewarded, false);
  assert.equal(meta.daycare.happiness, 22);
  advanceMaoMaoAfterRun(meta);
  const nextRun = careForMaoMao(meta, 'pet');
  assert.equal(nextRun.rewarded, true);
  assert.equal(meta.daycare.happiness, 26);
  assert.ok(meta.daycare.unlockedOutfits.includes('beanie'));
  ok('care is cozy-repeatable but numerical progress refreshes per Hunt');
}

// Yarn Pounce consumes one energy only when it grants that cycle's reward.
{
  const meta = { runs: 1, daycare: { rescued: true, happiness: 50, energy: 2, careTotal: 0 } };
  normalizeMaoMao(meta);
  assert.equal(canRewardYarnGame(meta), true);
  const game = finishMaoMaoYarnGame(meta, 8);
  const practice = finishMaoMaoYarnGame(meta, 8);
  assert.equal(game.rewarded, true);
  assert.equal(practice.rewarded, false);
  assert.equal(meta.daycare.energy, 1);
  assert.equal(meta.daycare.yarnBest, 8);
  assert.ok(meta.daycare.happiness > 50);
  ok('Yarn Pounce reward/energy gate and persistent high score');
}

// No offline decay and bounded perk values.
{
  const meta = { runs: 8, daycare: { rescued: true, happiness: 91, bondXp: 150 } };
  const before = normalizeMaoMao(meta).happiness;
  const after = normalizeMaoMao(meta).happiness;
  assert.equal(after, before);
  assert.equal(maoMaoBond(meta).name, 'Family');
  const crown = DAYCARE_OUTFITS.find(o => o.id === 'crown');
  const beanie = DAYCARE_OUTFITS.find(o => o.id === 'beanie');
  const scarf = DAYCARE_OUTFITS.find(o => o.id === 'scarf');
  const moonbell = DAYCARE_OUTFITS.find(o => o.id === 'moonbell');
  assert.ok(crown.buff.mul <= 1.04);
  assert.ok(beanie.buff.mul <= 1.04);
  assert.ok(scarf.buff.add <= 15);
  assert.equal(moonbell.unlockAt, null);
  assert.ok(moonbell.buff.mul <= 1.08);
  ok('no neglect decay and support perks remain bounded');
}

console.log(`\npass=${pass} fail=0`);
console.log('ALL CHECKS PASS');
