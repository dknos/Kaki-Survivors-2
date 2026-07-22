import assert from 'node:assert/strict';
import { createKartState, stepKart } from '../src/racing/physics.js';
import {
  createMonsterScoreState,
  getMonsterVehicleProfile,
  stepMonsterStunts,
} from '../src/racing/monsterScoring.js';
import {
  createMonsterVehicleContact,
  initializeMonsterVehiclePhysics,
  sampleMonsterSupportPlane,
  stepMonsterContactPatches,
} from '../src/racing/monsterVehiclePhysics.js';
import {
  applyMonsterTargetDamage,
  MONSTER_TARGET_CLASSES,
} from '../src/racing/monsterDestructionRules.js';

const meowster = getMonsterVehicleProfile('meowster');
const cyber = getMonsterVehicleProfile('cyber');
const flatGround = (x, z) => ({
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  surface: 'packed-dirt',
  surfaceGrip: 1,
  surfaceDrag: 0,
  x,
  z,
});

const flatKart = initializeMonsterVehiclePhysics(createKartState(), meowster);
const flatSupport = sampleMonsterSupportPlane(flatKart, flatGround, null, meowster);
assert.equal(flatSupport.wheels.length, 4, 'monster support did not sample four tires');
assert.equal(flatSupport.height, 0, 'flat four-tire support moved the chassis vertically');
assert.ok(Math.abs(flatSupport.pitch) < 1e-9 && Math.abs(flatSupport.roll) < 1e-9,
  'flat support produced phantom chassis attitude');

const rampLipGround = (x, z) => z <= 0 ? {
  height: 6 + z * 0.5,
  normal: { x: 0, y: 1 / Math.hypot(1, 0.5), z: -0.5 / Math.hypot(1, 0.5) },
  surface: 'ramp-dirt',
  surfaceGrip: 1.04,
  surfaceDrag: 0.025,
  featureId: 'test-ramp',
} : flatGround(x, z);
const lipKart = initializeMonsterVehiclePhysics(createKartState({ y: 5.2, vz: 14, speed: 14 }), meowster);
const lipSupport = sampleMonsterSupportPlane(lipKart, rampLipGround, null, meowster);
const lipFront = lipSupport.wheels.filter((wheel) => wheel.axle === 1);
assert.ok(lipFront.every((wheel) => wheel.support.syntheticRampDeparture && wheel.support.unsupported),
  'front tires grabbed the floor below the ramp before rear-axle takeoff');
assert.ok(lipSupport.pitch > 0.35, `ramp departure support pitched down at the lip: ${lipSupport.pitch}`);
assert.ok(lipSupport.fittedHeight > 5.5, `ramp departure support collapsed toward the arena floor: ${lipSupport.fittedHeight}`);

const twistedGround = (x, z) => ({
  ...flatGround(x, z),
  height: x < 0 && z > 0 ? 1 : 0,
});
const twistedSupport = sampleMonsterSupportPlane(flatKart, twistedGround, null, meowster);
assert.ok(twistedSupport.pitch > 0.1, 'raised front tire did not pitch the support plane');
assert.ok(Math.abs(twistedSupport.roll) > 0.1, 'raised left tire did not roll the support plane');

const sedan = {
  id: 'roof-car',
  kind: 'sedan',
  stats: MONSTER_TARGET_CLASSES.sedan,
  active: true,
  destroyed: false,
  respawnProgress: 1,
  x: 0,
  z: 1.62,
  yaw: 0,
  ground: 0,
  baseY: 0,
  top: MONSTER_TARGET_CLASSES.sedan.height,
  state: 'intact',
};
const roofContact = createMonsterVehicleContact(
  { onRoad: true, sampleGround: flatGround },
  flatKart,
  { targets: [sedan] },
  meowster,
);
assert.equal(roofContact.wheelSupport.wheels.filter((wheel) => wheel.support.targetId === sedan.id).length, 2,
  'broad front tires did not recognize a centered sedan roof');

function settleSuspension(profile, hz) {
  const kart = initializeMonsterVehiclePhysics(createKartState({ y: roofContact.groundHeight }), profile);
  const contact = createMonsterVehicleContact(
    { onRoad: true, sampleGround: flatGround },
    kart,
    { targets: [sedan] },
    profile,
  );
  for (let index = 0; index < hz; index += 1) stepMonsterContactPatches(kart, contact, profile, 1 / hz, {});
  return kart;
}
const settled60 = settleSuspension(meowster, 60);
const settled120 = settleSuspension(meowster, 120);
assert.ok(Math.abs(settled60.suspensionCompression - settled120.suspensionCompression) < 0.018,
  'contact-patch suspension drifted between 60 and 120 Hz');
assert.ok(settled60.contactPitch < -0.1, 'front-axle roof load did not lift the visible nose');
const cyberSettled = settleSuspension(cyber, 60);
assert.ok(cyberSettled.suspensionCompression < settled60.suspensionCompression + 0.08,
  'Cyber Kaki does not exhibit its firmer suspension tradeoff');

const launch = initializeMonsterVehiclePhysics(createKartState({ vz: 15, speed: 15 }), meowster);
const launchEvent = stepKart(launch, { throttle: 0 }, {
  onRoad: true,
  ramp: true,
  preserveRampSpeed: true,
  rampDirection: { x: 0, z: 1 },
  takeoffSlope: 0.5,
  suspensionRebound: 0,
}, 1 / 120, meowster.tuning);
assert.equal(launchEvent.jumped, true, 'rear-axle ramp departure did not launch');
assert.ok(launch.vy > 8 && launch.vy < 8.8, `ramp lift is too weak or excessive: ${launch.vy}`);
assert.ok(launch.vz > 14.4, 'ramp launch discarded too much run-up speed');
assert.ok(launch.stuntPitch < -0.25, 'truck left an uphill ramp with its nose pointed down');
assert.ok(launch.airControlDelay > 0.18, 'takeoff attitude has no short stabilization window');
assert.ok(launch.airborneGrace > 0.14, 'rear tires can immediately re-catch the ramp lip after launch');

let apex = launch.y;
let airborneFrames = 0;
let arcLanding = null;
const launchRun = createMonsterScoreState();
for (let index = 0; index < 360; index += 1) {
  const event = stepKart(launch, { throttle: 1 }, { onRoad: true, groundHeight: 0 }, 1 / 120, meowster.tuning);
  stepMonsterStunts(launchRun, launch, { throttle: 1, steer: 0 }, event, 1 / 120, meowster);
  apex = Math.max(apex, launch.y);
  if (!launch.grounded) airborneFrames += 1;
  if (event.landed) { arcLanding = event; break; }
}
assert.ok(apex > 2, `monster ramp arc still feels gravity-heavy: apex ${apex}`);
assert.ok(airborneFrames > 115, `monster ramp airtime is too brief: ${airborneFrames / 120}s`);
assert.ok(arcLanding?.landed, 'longer monster ramp arc never landed');
assert.ok(launch.stuntPitch > -1.2, `ordinary throttle forced an immediate backflip after takeoff: ${launch.stuntPitch}`);

const slopedLanding = createKartState({
  grounded: false,
  y: 0.02,
  vy: -9,
  speed: 12,
  vz: 12,
  stuntPitch: -0.34,
  stuntRoll: 0.16,
  groundPitch: 0.34,
  groundRoll: -0.16,
});
const slopedEvent = stepKart(slopedLanding, {}, {
  onRoad: true,
  groundHeight: 0,
  groundPitch: 0.34,
  groundRoll: -0.16,
}, 1 / 60, meowster.tuning);
assert.equal(slopedEvent.landingType, 'four-wheel', 'landing was graded against world-up instead of the slope');
assert.equal(slopedEvent.cleanLanding, true, 'slope-matched landing was not clean');

function freshTarget(kind) {
  const stats = MONSTER_TARGET_CLASSES[kind];
  return {
    id: `${kind}-stage-test`,
    kind,
    stats,
    active: true,
    destroyed: false,
    respawnProgress: 1,
    maxHealth: stats.health,
    health: stats.health,
    hitCooldown: 0,
    axleHits: { front: 0, rear: 0 },
    axleHitCooldowns: { front: 0, rear: 0 },
    state: 'intact',
  };
}
const stagedSedan = freshTarget('sedan');
const frontPress = applyMonsterTargetDamage(stagedSedan, 999, {
  vertical: true,
  axle: 'front',
  crushZone: 'front',
});
assert.equal(frontPress.newlyDestroyed, false, 'one axle instantly deleted a normal car');
assert.ok(stagedSedan.crushFront > stagedSedan.crushRear, 'front tire press did not create sectional crush');
stagedSedan.hitCooldown = 0;
const rearPress = applyMonsterTargetDamage(stagedSedan, 999, {
  vertical: true,
  axle: 'rear',
  crushZone: 'rear',
  bypassCooldown: true,
});
assert.equal(rearPress.newlyDestroyed, true, 'rear axle did not finish a staged sedan crush');

const stagedBus = freshTarget('bus');
applyMonsterTargetDamage(stagedBus, 999, { vertical: true, axle: 'front', crushZone: 'front' });
stagedBus.hitCooldown = 0;
applyMonsterTargetDamage(stagedBus, 100, {
  vertical: true,
  axle: 'rear',
  crushZone: 'rear',
  bypassCooldown: true,
});
assert.equal(stagedBus.destroyed, false, 'heavy bus failed its multi-hit durability contract');

console.log('Monster four-contact vehicle physics passed');
