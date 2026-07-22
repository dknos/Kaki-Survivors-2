#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  MONSTER_RECORDS_KEY,
  createMonsterRecordRun,
  finishMonsterRecordRun,
  readMonsterRecords,
  stepMonsterRecordRun,
} from '../src/racing/monsterRecords.js';

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
};

values.set(MONSTER_RECORDS_KEY, '{broken');
assert.deepEqual(readMonsterRecords(storage).arenas, {}, 'malformed record storage did not fail closed');

const run = createMonsterRecordRun({
  arenaId: 'crown-chaos-coliseum',
  eventMode: 'free-ride',
  vehicleId: 'meowster',
  storage,
});
for (let index = 0; index < 20; index += 1) {
  stepMonsterRecordRun(run, { x: index * 1.2, z: index * -0.9 }, 0.25);
}
stepMonsterRecordRun(run, { x: 9999, z: 0 }, 0.25);
const result = finishMonsterRecordRun(run, {
  score: 12400,
  wreckChain: 6.2,
  airTime: 2.8,
  trick: 'DOUBLE BACKFLIP',
  trickPoints: 4200,
  completionTime: 74.4,
});
assert.equal(result.saved, true, 'record run was not persisted');
assert(result.improved.includes('route'), 'eligible Free Ride route was not persisted');

const reloaded = createMonsterRecordRun({
  arenaId: 'crown-chaos-coliseum',
  eventMode: 'free-ride',
  vehicleId: 'meowster',
  storage,
});
assert.equal(reloaded.previous.score, 12400, 'best score did not survive reload');
assert.equal(reloaded.previous.completionTime, 74.4, 'best completion time did not survive reload');
assert.equal(reloaded.previousRoute.length, 20, 'bounded route trace did not survive reload');
assert(reloaded.previousRoute.every((point) => Math.abs(point.x) <= 256 && Math.abs(point.z) <= 256),
  'unsafe route coordinate survived validation');

const worse = finishMonsterRecordRun(reloaded, { score: 10, wreckChain: 1, trickPoints: 2 });
assert.equal(worse.record.score, 12400, 'worse run overwrote a personal best');
assert.equal(worse.record.trick, 'DOUBLE BACKFLIP', 'worse stunt overwrote the best stunt label');
assert.equal(worse.record.completionTime, 74.4, 'missing completion time erased the speedrun record');

console.log('Monster personal records and route persistence passed');
