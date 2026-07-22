import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { RACE_COURSES, RACE_COURSE_ORDER, RACE_MODES, getCourseDefinition } from '../src/racing/tracks.js';
import {
  CROWN_CHAOS_ARENA,
  MONSTER_ARENA_ORDER,
  PILEUP_PYRAMID_ARENA,
  validateMonsterArenaDefinition,
} from '../src/racing/monsterArenaDefinition.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(RACE_COURSE_ORDER.length, 6, 'all six campaign chapters need a course');
assert.equal(new Set(RACE_COURSE_ORDER).size, 6, 'course order contains duplicates');

for (const id of RACE_COURSE_ORDER) {
  const course = RACE_COURSES[id];
  assert.ok(course, `missing course definition: ${id}`);
  assert.ok(course.points.length >= 8, `${id} needs enough spline controls for varied turns`);
  assert.ok(course.rampFractions.length >= 2, `${id} needs multiple jumps`);
  assert.ok(course.boostFractions.length >= 2, `${id} needs multiple boost decisions`);
  assert.ok(course.trackWidth >= 7 && course.trackWidth <= 11, `${id} track width is not driveable`);
  assert.ok(existsSync(resolve(repoRoot, course.groundTexture)), `${id} ground texture is missing`);
  assert.ok(existsSync(resolve(repoRoot, course.chapterArt)), `${id} chapter art is missing`);
  for (const fraction of [...course.rampFractions, ...course.boostFractions]) {
    assert.ok(fraction >= 0 && fraction < 1, `${id} feature fraction out of bounds: ${fraction}`);
  }
  let polygonLength = 0;
  for (let i = 0; i < course.points.length; i++) {
    const a = course.points[i];
    const b = course.points[(i + 1) % course.points.length];
    polygonLength += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  assert.ok(polygonLength > 220, `${id} course is too short: ${polygonLength.toFixed(1)}`);
}

assert.match(RACE_COURSES.kakiland.groundTexture, /vertex/i, 'Kaki Land should use its Vertex terrain base');
assert.match(RACE_COURSES.kakiland.detailTexture, /grok/i, 'Kaki Land should layer its Grok terrain detail');
assert.ok(existsSync(resolve(repoRoot, RACE_COURSES.kakiland.detailTexture)), 'Kaki Land Grok detail is missing');

assert.equal(RACE_MODES.stock.carCount, 12, 'stock race should default to a full hero pack');
assert.equal(RACE_MODES.stock.maxCars, 16, 'desktop stock grid ceiling changed unexpectedly');
const stock = getCourseDefinition('forest', 'stock');
assert.equal(stock.mode, 'stock');
assert.equal(stock.laps, 8);
assert.ok(stock.trackWidth >= 14, 'stock oval needs multiple racing lanes');
assert.equal(stock.rampFractions.length, 0, 'stock oval should not hide launch ramps in the pack');
assert.ok(stock.repairFractions.length, 'stock oval is missing a pit repair bay');
assert.ok(stock.points.length >= 12, 'stock oval spline is too coarse');
const drift = getCourseDefinition('twilight', 'drift');
assert.equal(drift.mode, 'drift');
assert.match(drift.name, /Drift Attack/);

assert.equal(RACE_MODES.monster.objective, 'smashScore');
assert.equal(RACE_MODES.monster.vehicle, 'monster');
assert.equal(RACE_MODES.monster.carCount, 1);
assert.equal(RACE_MODES.monster.duration, 120);
const monster = getCourseDefinition('kakiland', 'monster');
assert.equal(monster.mode, 'monster');
assert.equal(monster.laps, 99, 'score arena should not end on a lap gate');
assert.equal(monster.name, 'Crown Chaos Coliseum', 'Monster Smash should route every chapter card to the authored stadium');
assert.equal(monster.arenaId, CROWN_CHAOS_ARENA.id, 'menu course and arena gameplay truth disagree');
assert.equal(monster.rampFractions.length, 0, 'authored arena ramps must not be duplicated as spline fractions');
assert.ok(CROWN_CHAOS_ARENA.ramps.length >= 10, 'arena needs multiple visible freestyle lines');
assert.equal(CROWN_CHAOS_ARENA.districts.length, 6, 'arena district count changed unexpectedly');
assert.ok(CROWN_CHAOS_ARENA.targets.length >= 30, 'arena lacks a convincing full-size destructible field');
assert.equal(validateMonsterArenaDefinition().ok, true, 'arena authored coordinates violate safety invariants');
const pileup = getCourseDefinition('forest', 'monster', { monsterArena: PILEUP_PYRAMID_ARENA.id });
assert.equal(MONSTER_ARENA_ORDER.length, 2, 'Monster Smash should expose both destruction arenas');
assert.equal(pileup.name, 'Pileup Pyramid Yard');
assert.equal(pileup.arenaId, PILEUP_PYRAMID_ARENA.id, 'selected pyramid arena was replaced by Crown Chaos');
assert.equal(validateMonsterArenaDefinition(PILEUP_PYRAMID_ARENA).ok, true, 'pyramid yard coordinates violate safety invariants');
assert.equal(new Set(PILEUP_PYRAMID_ARENA.targets.map((target) => target.structureId).filter(Boolean)).size, 2, 'pyramid yard needs distinct car and bus structures');
for (const target of PILEUP_PYRAMID_ARENA.targets.filter((entry) => entry.stackLevel > 0)) {
  assert.equal(target.supportIds.length, 2, `${target.id} must rest on two named vehicles`);
  assert.equal(target.requiredSupports, 2, `${target.id} should fall after either support corner is removed`);
}
assert.ok(existsSync(resolve(repoRoot, monster.arenaArt)), 'Monster Smash key art is missing');
assert.ok(existsSync(resolve(repoRoot, monster.truckDecal)), 'Kitty monster-truck decal is missing');
assert.ok(existsSync(resolve(repoRoot, 'assets/racing/models/cyber-kaki-body-v1.glb')), 'Cyber Kaki runtime model is missing');

console.log('Kaki Rally six-course smoke passed');
