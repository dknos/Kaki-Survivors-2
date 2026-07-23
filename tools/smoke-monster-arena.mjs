import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKartState, stepKart } from '../src/racing/physics.js';
import {
  CROWN_CHAOS_ARENA,
  PILEUP_PYRAMID_ARENA,
  findMonsterRampTakeoff,
  landingZoneAt,
  queryMonsterArenaGround,
  validateMonsterArenaDefinition,
} from '../src/racing/monsterArenaDefinition.js';
import {
  MONSTER_TUNING,
  awardMonsterEvent,
  awardMonsterRow,
  breakMonsterChain,
  createMonsterScoreState,
  getMonsterVehicleProfile,
  stepMonsterChaos,
} from '../src/racing/monsterScoring.js';
import {
  MONSTER_TARGET_CLASSES,
  applyMonsterTargetDamage,
  canRepopulateMonsterTarget,
  evaluateMonsterTargetImpact,
  monsterChainDamage,
  monsterOrientedMotionSweep,
  monsterSupportStatus,
} from '../src/racing/monsterDestructionRules.js';
import {
  MONSTER_FREESTYLE_SECONDS,
  MONSTER_ROUND_SECONDS,
  createMonsterRoundDefinitions,
  createMonsterRoundState,
  currentMonsterRound,
  monsterRoundRank,
} from '../src/racing/monsterRounds.js';
import { createMonsterSpotlight, stepMonsterSpotlight } from '../src/racing/monsterSpotlights.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arena = CROWN_CHAOS_ARENA;
const validation = validateMonsterArenaDefinition(arena);
assert.deepEqual(validation.errors, [], `invalid authored arena: ${validation.errors.join(', ')}`);
assert.equal(validation.ok, true);
assert.equal(arena.districts.length, 6);
assert.ok(arena.ramps.length >= 10);
assert.ok(arena.targets.length >= 30);
assert.ok(arena.spawnPoints.length >= arena.districts.length);

const pileupValidation = validateMonsterArenaDefinition(PILEUP_PYRAMID_ARENA);
assert.deepEqual(pileupValidation.errors, [], `invalid pyramid arena: ${pileupValidation.errors.join(', ')}`);
assert.equal(PILEUP_PYRAMID_ARENA.targets.length, 122, 'timed pyramid yard target budget changed unexpectedly');
assert.equal(new Set(PILEUP_PYRAMID_ARENA.targets.map((target) => target.structureId).filter(Boolean)).size, 2);
assert.ok(PILEUP_PYRAMID_ARENA.bounds.maxX - PILEUP_PYRAMID_ARENA.bounds.minX >= 250, 'expanded arena is not materially wider');
const dominoTargets = PILEUP_PYRAMID_ARENA.targets.filter((target) => target.dominoGroup);
assert.equal(dominoTargets.length, 78, 'grand perimeter lost domino vehicles');
assert.equal(new Set(dominoTargets.map((target) => target.dominoGroup)).size, 4, 'domino perimeter should have four readable runs');
assert.equal(PILEUP_PYRAMID_ARENA.targets.filter((target) => target.explosive && target.kind !== 'haybale').length, 11, 'hot-car count changed unexpectedly');
assert.equal(PILEUP_PYRAMID_ARENA.targets.filter((target) => target.kind === 'haybale').length, 8, 'flaming bale tunnel is incomplete');
assert.equal(PILEUP_PYRAMID_ARENA.targets.filter((target) => target.kind === 'stuntman').length, 5, 'stunt team line is incomplete');
const timedRounds = createMonsterRoundDefinitions(PILEUP_PYRAMID_ARENA);
assert.equal(MONSTER_ROUND_SECONDS, 30);
assert.equal(timedRounds.length, 5, 'arena must run exactly five timed rounds');
assert.deepEqual(timedRounds.map((round) => round.targetIds.length), [9, 23, 25, 39, 54], 'round obstacle counts must escalate');
for (const round of timedRounds) {
  assert.equal('pickup' in round, false, `${round.name} still contains a clock extension`);
  assert.ok(round.targetIds.every((id) => PILEUP_PYRAMID_ARENA.targets.some((target) => target.id === id)), `${round.name} references a missing target`);
}
const speedrun = createMonsterRoundState(PILEUP_PYRAMID_ARENA, 'smashdown');
assert.equal(speedrun.timeRemaining, Infinity, 'Smashdown must have unlimited time');
assert.equal(speedrun.elapsedTime, 0, 'Smashdown run clock did not start at zero');
assert.deepEqual(speedrun.roundTimes, [], 'Smashdown carried stale level splits');
assert.equal(monsterRoundRank(74.999), 'S', 'sub-75-second clear did not earn S rank');
assert.equal(monsterRoundRank(90), 'A', '90-second clear did not earn A rank');
assert.equal(monsterRoundRank(110), 'B', '110-second clear did not earn B rank');
assert.equal(monsterRoundRank(130), 'C', '130-second clear did not earn C rank');
assert.equal(monsterRoundRank(145), 'D', 'completed slow run did not earn D rank');
assert.equal(monsterRoundRank(30, false), 'DNF', 'timed-out run received a completion rank');
const freeRideRounds = createMonsterRoundState(PILEUP_PYRAMID_ARENA, 'free-ride');
assert.equal(freeRideRounds.rounds.length, 1, 'Free Ride exposed timed round filtering');
assert.equal(freeRideRounds.timeRemaining, Infinity, 'Free Ride unexpectedly has a clock');
assert.equal(currentMonsterRound(freeRideRounds).targetIds.length, PILEUP_PYRAMID_ARENA.targets.length,
  'Free Ride did not activate the complete arena');
const freestyleRounds = createMonsterRoundState(PILEUP_PYRAMID_ARENA, 'freestyle');
assert.equal(freestyleRounds.timeRemaining, MONSTER_FREESTYLE_SECONDS, 'Freestyle is not a two-minute score attack');

const spotlightScore = createMonsterScoreState();
const spotlightArena = { targets: PILEUP_PYRAMID_ARENA.targets, destroyed: 0, dominoImpacts: 0 };
const spotlight = createMonsterSpotlight(spotlightArena, timedRounds[0], spotlightScore, 0, 0);
assert.equal(spotlight.id, 'chain-five', 'opening Spotlight is not achievable from its active targets');
spotlightScore.wreckChain = 5;
assert.equal(stepMonsterSpotlight(spotlight, spotlightArena, spotlightScore, 1 / 60).completed, true,
  'achieved Spotlight did not complete exactly once');
assert.equal(stepMonsterSpotlight(spotlight, spotlightArena, spotlightScore, 1 / 60).completed, false,
  'Spotlight completion repeated across frames');
for (const target of dominoTargets) {
  assert.ok(target.dominoStartPitch < -1.4, `${target.id} is not standing visibly on end`);
  if (target.dominoNextId) assert.ok(PILEUP_PYRAMID_ARENA.targets.some((entry) => entry.id === target.dominoNextId), `${target.id} has no next domino`);
}
for (const target of PILEUP_PYRAMID_ARENA.targets.filter((entry) => entry.stackLevel > 0)) {
  assert.equal(target.supportIds.length, 2, `${target.id} is not carried by two lower vehicles`);
  assert.ok(target.stackBaseY > 0, `${target.id} is not physically elevated`);
}

const targetIds = new Set(arena.targets.map((target) => target.id));
assert.equal(targetIds.size, arena.targets.length, 'destructible target ids must be unique');
for (const required of ['sedan', 'wagon', 'pickup', 'van', 'limousine', 'bus', 'rv', 'derby', 'crown']) {
  assert.ok(arena.targets.some((target) => target.kind === required), `arena is missing ${required} destruction gameplay`);
}
assert.ok(arena.targets.filter((target) => target.ai).length >= 3, 'demolition bowl needs active derby traffic');

for (const ramp of arena.ramps) {
  const baseLocalZ = -ramp.length * 0.5 + 0.15;
  const lipLocalZ = ramp.length * 0.5 - 0.25;
  const point = (localZ) => ({
    x: ramp.x + localZ * Math.sin(ramp.yaw || 0),
    z: ramp.z + localZ * Math.cos(ramp.yaw || 0),
  });
  const basePoint = point(baseLocalZ);
  const lipPoint = point(lipLocalZ);
  const base = queryMonsterArenaGround(basePoint.x, basePoint.z, arena);
  const lip = queryMonsterArenaGround(lipPoint.x, lipPoint.z, arena);
  assert.equal(lip.featureId, ramp.id, `${ramp.id} lip is not backed by collision terrain`);
  assert.ok(lip.height > base.height + Math.min(1.5, ramp.height * 0.35), `${ramp.id} has no meaningful launch slope`);
  assert.equal(lip.takeoff, true, `${ramp.id} visible lip is not a launch contact`);
  assert.ok(lip.takeoffSlope > 0, `${ramp.id} launch has no slope-derived vertical velocity`);
}

for (const zone of arena.landingZones) {
  assert.equal(landingZoneAt(zone.x, zone.z, arena), zone.id, `${zone.id} landing query is ambiguous`);
  for (const target of arena.targets) {
    assert.ok(
      Math.hypot(zone.x - target.x, zone.z - target.z) >= zone.radius + 2.8,
      `${zone.id} is obstructed by ${target.id}`,
    );
  }
}

const bowlCenter = queryMonsterArenaGround(arena.bowl.x - 8, arena.bowl.z, arena);
const bowlRim = queryMonsterArenaGround(arena.bowl.x + arena.bowl.outerRadius + 2, arena.bowl.z, arena);
assert.ok(bowlCenter.height < bowlRim.height - 3, 'demolition bowl collision is visually flat');

const flat = queryMonsterArenaGround(0, -52, arena);
assert.equal(flat.featureId, 'arena-floor');
assert.equal(flat.surface, 'packed-dirt');
assert.ok(Math.abs(flat.normal.x) < 1e-9 && Math.abs(flat.normal.z) < 1e-9 && flat.normal.y === 1, 'flat arena normal is tilted');
const southRamp = arena.ramps.find((ramp) => ramp.id === 'spine-south-big');
const northRamp = arena.ramps.find((ramp) => ramp.id === 'spine-north-downslope');
const rampMidpoint = (ramp) => queryMonsterArenaGround(ramp.x, ramp.z, arena);
const southMid = rampMidpoint(southRamp);
const northMid = rampMidpoint(northRamp);
assert.ok(southMid.height > 2.35 && southMid.normal.y < 0.98, 'central ramp has no visible analytical slope');
assert.ok(southMid.pitch * northMid.pitch < 0, 'paired bidirectional ramps do not expose opposite downslope normals');
const bowlWall = queryMonsterArenaGround(arena.bowl.x + (arena.bowl.floorRadius + arena.bowl.outerRadius) * 0.5, arena.bowl.z, arena);
assert.equal(bowlWall.featureId, arena.bowl.id);
assert.ok(bowlWall.normal.x < -0.05 && bowlWall.normal.y < 1, 'bowl bank normal does not point back into the bowl');
const berm = queryMonsterArenaGround(arena.bounds.softX + 5, 0, arena);
assert.equal(berm.featureId, 'stadium-berm');
assert.ok(berm.height > 0 && berm.normal.x < 0, 'boundary berm does not visibly redirect the truck inward');

// Launch from the authored south lip and land on the paired visible downslope.
const lipLocalZ = southRamp.length * 0.5 - 0.7;
const launchX = southRamp.x + lipLocalZ * Math.sin(southRamp.yaw);
const launchZ = southRamp.z + lipLocalZ * Math.cos(southRamp.yaw);
const launchGround = queryMonsterArenaGround(launchX, launchZ, arena);
const jumpKart = createKartState({
  x: launchX,
  z: launchZ,
  y: launchGround.height,
  yaw: southRamp.yaw,
  vx: Math.sin(southRamp.yaw) * 18,
  vz: Math.cos(southRamp.yaw) * 18,
  speed: 18,
  grounded: true,
});
let launched = false;
let authoredLanding = null;
for (let i = 0; i < 360; i += 1) {
  const ground = queryMonsterArenaGround(jumpKart.x, jumpKart.z, arena);
  const along = jumpKart.vx * Math.sin(southRamp.yaw) + jumpKart.vz * Math.cos(southRamp.yaw);
  const event = stepKart(jumpKart, { throttle: 1 }, {
    onRoad: true,
    groundHeight: ground.height,
    groundPitch: ground.pitch,
    groundRoll: ground.roll,
    groundNormal: ground.normal,
    surfaceGrip: ground.surfaceGrip,
    surfaceDrag: ground.surfaceDrag,
    ramp: ground.takeoff && along > 5.5,
    rampVelocity: along * Math.sin(Math.atan(ground.takeoffSlope)),
    preserveRampSpeed: ground.takeoff && along > 5.5,
    rampDirection: { x: Math.sin(southRamp.yaw), z: Math.cos(southRamp.yaw) },
    takeoffSlope: ground.takeoffSlope,
    suspensionRebound: 0,
    sampleGround: (x, z) => queryMonsterArenaGround(x, z, arena),
  }, 1 / 120, MONSTER_TUNING);
  launched ||= event.jumped;
  if (event.landed) {
    authoredLanding = { event, ground: queryMonsterArenaGround(jumpKart.x, jumpKart.z, arena) };
    break;
  }
}
assert.equal(launched, true, 'visible central ramp did not launch the truck');
assert.ok(authoredLanding, 'central launch never returned to authored terrain');
assert.equal(authoredLanding.ground.featureId, southRamp.landing, 'central jump missed its visible paired downslope');
assert.equal(authoredLanding.event.cleanLanding, true, 'upright downslope landing was not graded cleanly');

const elevatedGround = (x, z) => ({ height: x > 0 ? 3 : 2, pitch: 0, roll: 0, normal: { x: 0, y: 1, z: 0 } });
const terrainKart = createKartState({ x: 1, z: 0, y: 8, vy: -2, grounded: false });
let terrainLanding = null;
for (let i = 0; i < 180; i += 1) {
  const event = stepKart(terrainKart, {}, {
    onRoad: true,
    groundHeight: 3,
    sampleGround: elevatedGround,
  }, 1 / 60, getMonsterVehicleProfile('meowster').tuning);
  if (event.landed) { terrainLanding = event; break; }
}
assert.ok(terrainLanding, 'shared kart physics never landed on elevated arena terrain');
assert.equal(terrainKart.y, 3, 'arena landing snapped through elevated ground');

const run = createMonsterScoreState();
run.chaos = 50;
const boostKart = createKartState({ grounded: true });
for (let i = 0; i < 30; i += 1) stepMonsterChaos(run, boostKart, { boost: true }, 1 / 60);
assert.ok(run.chaos < 50 && run.chaosSpent > 0, 'earned Zoomies is not a consumable boost resource');
assert.ok(boostKart.boostTime > 0, 'Zoomies did not drive the shared boost state');

// Pure swept-impact truth covers thresholds, vertical crush, and one-award state transitions.
const runtimeTarget = (kind, overrides = {}) => {
  const stats = MONSTER_TARGET_CLASSES[kind];
  return {
    id: `fixture-${kind}`,
    kind,
    stats,
    x: 0,
    z: 0,
    top: stats.height,
    health: stats.health,
    maxHealth: stats.health,
    state: 'intact',
    damage: 0,
    destroyed: false,
    hitCooldown: 0,
    respawnProgress: 1,
    ...overrides,
  };
};
const ramKart = { x: 1, z: 0, previousX: -6, previousZ: 0, y: 0, previousY: 0, vx: 9, vz: 0, speed: 9, vy: 0 };
const sedan = runtimeTarget('sedan');
const bus = runtimeTarget('bus');
const sedanImpact = evaluateMonsterTargetImpact(sedan, ramKart, getMonsterVehicleProfile('meowster'));
const busImpact = evaluateMonsterTargetImpact(bus, ramKart, getMonsterVehicleProfile('meowster'));
assert.equal(sedanImpact.qualifies, true, 'committed swept ram did not qualify against a sedan');
assert.equal(busImpact.qualifies, false, 'the same moderate ram incorrectly cleared the bus threshold');
const firstDamage = applyMonsterTargetDamage(sedan, sedanImpact.damageEnergy);
const repeatedDamage = applyMonsterTargetDamage(sedan, sedanImpact.damageEnergy);
assert.equal(firstDamage.newlyDestroyed, true, 'sedan threshold did not produce a wreck');
assert.equal(repeatedDamage.applied, false, 'destroyed target accepted a second scoring impact');

const angledTarget = runtimeTarget('sedan', { yaw: Math.PI / 2 });
const angledSweep = monsterOrientedMotionSweep(angledTarget, { ...ramKart, z: 1.1, previousZ: 1.1 }, 0.2);
assert.equal(angledSweep.hit, true, 'oriented vehicle footprint rejected a valid broadside sweep');
const grazeSweep = monsterOrientedMotionSweep(angledTarget, { ...ramKart, z: 3.5, previousZ: 3.5 }, 0.2);
assert.equal(grazeSweep.hit, false, 'oriented vehicle footprint accepted a distant graze');
const elevatedTier = runtimeTarget('wagon', { baseY: 1.84, bottom: 1.84, top: 3.54, stackLevel: 1 });
const groundRam = evaluateMonsterTargetImpact(elevatedTier, ramKart, getMonsterVehicleProfile('meowster'));
assert.equal(groundRam.qualifies, false, 'ground-level ram hit an elevated pyramid tier through its supports');
const insideStart = evaluateMonsterTargetImpact(runtimeTarget('sedan'), {
  x: 0,
  z: 0.25,
  previousX: 0,
  previousZ: 0,
  y: 0,
  previousY: 0,
  vx: 0,
  vz: 18,
  speed: 18,
  vy: 0,
}, getMonsterVehicleProfile('cyber'));
assert.ok(insideStart.impactSpeed > 17, 'inside-start sweep lost the truck closing speed');
assert.equal(insideStart.qualifies, true, 'inside-start sweep failed a committed obstacle ram');

const supports = new Map([
  ['left', { id: 'left', x: -1, z: 0, spawnX: -1, spawnZ: 0, destroyed: true, stackState: 'grounded', stats: MONSTER_TARGET_CLASSES.sedan }],
  ['right', { id: 'right', x: 1, z: 0, spawnX: 1, spawnZ: 0, destroyed: false, stackState: 'grounded', stats: MONSTER_TARGET_CLASSES.sedan }],
]);
const supportStatus = monsterSupportStatus({ supportIds: ['left', 'right'], requiredSupports: 2 }, supports);
assert.equal(supportStatus.supported, false, 'destroying one bottom corner did not invalidate the upper tier');
assert.deepEqual(supportStatus.lost, ['left']);

const sweptRamp = PILEUP_PYRAMID_ARENA.ramps[0];
const lipZ = sweptRamp.length * 0.5 - 0.9;
const worldAt = (localZ) => ({
  x: sweptRamp.x + localZ * Math.sin(sweptRamp.yaw || 0),
  z: sweptRamp.z + localZ * Math.cos(sweptRamp.yaw || 0),
});
const beforeLip = worldAt(lipZ - 0.7);
const beyondLip = worldAt(lipZ + 0.7);
const sweptTakeoff = findMonsterRampTakeoff({
  ...beyondLip,
  previousX: beforeLip.x,
  previousZ: beforeLip.z,
  vx: Math.sin(sweptRamp.yaw || 0) * 18,
  vz: Math.cos(sweptRamp.yaw || 0) * 18,
  speed: 18,
  grounded: true,
}, PILEUP_PYRAMID_ARENA);
assert.equal(sweptTakeoff?.ramp?.id, sweptRamp.id, 'fast step skipped the visible pyramid-yard ramp lip');
assert.equal(sweptTakeoff?.swept, true, 'ramp contact did not report a swept lip crossing');
assert.ok(sweptTakeoff.takeoffSlope > 0.2, 'pyramid-yard ramp lip has no launch slope');

const roofBus = runtimeTarget('bus');
const stompKart = { x: 0, z: 0, previousX: 0, previousZ: 0, y: roofBus.top, previousY: roofBus.top + 5, vx: 0, vz: 0, speed: 0, vy: -7 };
const roofImpact = evaluateMonsterTargetImpact(roofBus, stompKart, getMonsterVehicleProfile('cyber'));
assert.equal(roofImpact.qualifies, true, 'vertical roof stomp did not use swept Y collision');
assert.equal(roofImpact.verticalContact, true);
const roofDamage = applyMonsterTargetDamage(roofBus, roofImpact.damageEnergy, { vertical: true });
assert.equal(roofDamage.newlyDestroyed, false, 'one moderate roof stomp should not flatten a full-health bus');
assert.equal(roofBus.state, 'dented');
assert.ok(MONSTER_TARGET_CLASSES.bus.health > MONSTER_TARGET_CLASSES.rv.health
  && MONSTER_TARGET_CLASSES.rv.health > MONSTER_TARGET_CLASSES.sedan.health, 'large-target health tiers collapsed');

const looseReaction = monsterChainDamage({ x: 0, z: 0 }, runtimeTarget('sedan', { x: 1, z: 0 }));
const stackReaction = monsterChainDamage({ x: 0, z: 0, stackId: 'crown' }, runtimeTarget('sedan', { x: 1, z: 0, stackId: 'crown' }));
assert.ok(stackReaction.damage > looseReaction.damage * 2, 'stack chain reactions are not materially stronger');
const rowRun = createMonsterScoreState();
assert.ok(awardMonsterRow(rowRun, 'fixture-row', 4) > 0, 'complete crush row earned no named bonus');
assert.equal(awardMonsterRow(rowRun, 'fixture-row', 4), 0, 'complete crush row could score infinitely');

const chainRun = createMonsterScoreState();
awardMonsterEvent(chainRun, 300, 'CAR CRUSH', 'destruction');
awardMonsterEvent(chainRun, 300, 'CLEAN AIR', 'airtime');
assert.ok(chainRun.wreckChain > 1, 'varied events did not grow Wreck Chain');
breakMonsterChain(chainRun, 'ROLLOVER');
assert.equal(chainRun.wreckChain, 1, 'Wreck Chain did not break predictably');
awardMonsterEvent(chainRun, 5000, 'CHAOS CAP', 'signature', { chaos: 500 });
assert.equal(chainRun.chaos, 100, 'Zoomies exceeded its earned-fuel cap');
const drainKart = createKartState({ grounded: true });
for (let i = 0; i < 600; i += 1) stepMonsterChaos(chainRun, drainKart, { boost: true }, 1 / 60);
assert.ok(chainRun.chaos >= 0, 'Zoomies boost underflowed');

const refillTarget = runtimeTarget('sedan', {
  destroyed: true,
  destroyedAge: 23,
  spawnX: -6,
  spawnZ: -37,
});
assert.equal(canRepopulateMonsterTarget(refillTarget, { x: -5, z: -37, vx: 0, vz: 0 }, arena), false, 'target repopulated beside the player');
assert.equal(canRepopulateMonsterTarget(refillTarget, { x: 70, z: 50, vx: 0, vz: 0 }, arena), true, 'safe off-camera target never repopulates');
assert.equal(canRepopulateMonsterTarget(refillTarget, { x: -60, z: -37, vx: 45, vz: 0 }, arena), false, 'target repopulated into the active travel corridor');

const glbPath = resolve(repoRoot, 'assets/racing/models/cyber-kaki-body-v1.glb');
assert.ok(existsSync(glbPath), `missing Cyber Kaki runtime asset: ${glbPath}`);
const glb = readFileSync(glbPath);
assert.equal(glb.subarray(0, 4).toString('ascii'), 'glTF', 'Cyber Kaki asset is not a valid binary glTF');
assert.ok(glb.length < 1_000_000, 'Cyber Kaki body is too heavy for this no-bundler web game');

const meowsterGlbPath = resolve(repoRoot, 'assets/racing/models/mighty-meowster-body-v1.glb');
assert.ok(existsSync(meowsterGlbPath), `missing Mighty Meowster runtime asset: ${meowsterGlbPath}`);
const meowsterGlb = readFileSync(meowsterGlbPath);
assert.equal(meowsterGlb.subarray(0, 4).toString('ascii'), 'glTF', 'Mighty Meowster is not a valid binary glTF');
assert.ok(meowsterGlb.length < 500_000, 'Mighty Meowster body exceeds its compact hero budget');
const trafficPath = resolve(repoRoot, 'assets/racing/models/arena-traffic-kit-runtime-v2.glb');
const exteriorRuntimePath = resolve(repoRoot, 'assets/racing/crown-chaos-exterior-grok-v1.webp');
const groundedExteriorRuntimePath = resolve(repoRoot, 'assets/racing/domino-grand-yard-exterior-grok-v2.webp');
for (const path of [trafficPath, exteriorRuntimePath, groundedExteriorRuntimePath]) {
  assert.ok(existsSync(path), `missing arena production artifact: ${path}`);
}
const trafficGlb = readFileSync(trafficPath);
assert.equal(trafficGlb.subarray(0, 4).toString('ascii'), 'glTF', 'traffic kit is not a valid binary glTF');
assert.ok(trafficGlb.length < 1_250_000, 'runtime traffic kit exceeds its bounded download budget');
const exteriorRuntime = readFileSync(exteriorRuntimePath);
assert.equal(exteriorRuntime.subarray(0, 4).toString('ascii'), 'RIFF', 'arena exterior is not a WebP RIFF asset');
assert.equal(exteriorRuntime.subarray(8, 12).toString('ascii'), 'WEBP', 'arena exterior is not a valid WebP asset');
const groundedExteriorRuntime = readFileSync(groundedExteriorRuntimePath);
assert.equal(groundedExteriorRuntime.subarray(0, 4).toString('ascii'), 'RIFF', 'grounded arena exterior is not a WebP RIFF asset');
assert.equal(groundedExteriorRuntime.subarray(8, 12).toString('ascii'), 'WEBP', 'grounded arena exterior is not a valid WebP asset');
const destructionSource = readFileSync(resolve(repoRoot, 'src/racing/monsterDestruction.js'), 'utf8');
for (const pool of ['arena-destructible-bodies', 'arena-detachable-panels', 'arena-pop-wheels', 'arena-pooled-metal-debris', 'arena-pooled-damage-smoke']) {
  assert.ok(destructionSource.includes(pool), `destruction pool is missing ${pool}`);
}
for (const pool of ['arena-hot-car-flame-outer', 'arena-hot-car-flame-inner', 'arena-pooled-hot-car-explosions']) {
  assert.ok(destructionSource.includes(pool), `hot-car VFX pool is missing ${pool}`);
}
assert.match(destructionSource, /new THREE\.InstancedMesh/, 'target damage does not use pooled instancing');
assert.match(destructionSource, /respawnProgress/, 'off-camera destructible refill has no persistent state');
for (const kind of ['Sedan', 'Wagon', 'Pickup', 'Van', 'Limousine', 'Bus', 'RV', 'Derby', 'Crown']) {
  assert.ok(destructionSource.includes(`ArenaTraffic_${kind}`), `traffic runtime is missing the ${kind} class model`);
}

console.log(`Crown Chaos Coliseum smoke passed (${arena.ramps.length} ramps, ${arena.targets.length} targets, ${validation.ids} authored ids)`);
