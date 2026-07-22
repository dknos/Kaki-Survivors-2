import assert from 'node:assert/strict';
import { createKartState, stepKart } from '../src/racing/physics.js';
import {
  MONSTER_TUNING,
  getMonsterVehicleProfile,
  awardMonsterSmash,
  createMonsterScoreState,
  resolveMonsterSmashes,
  stepMonsterChaos,
  stepMonsterStunts,
} from '../src/racing/monsterScoring.js';

const run = createMonsterScoreState();
assert.equal(awardMonsterSmash(run, 3.7), 0, 'parking-speed contact should not crush a car');
const first = awardMonsterSmash(run, 12);
const second = awardMonsterSmash(run, 15, 'bonus-stack');
assert.ok(first > 0, 'a committed monster-truck hit earned no points');
assert.ok(second > first, 'bonus stack and live combo did not increase the award');
assert.equal(run.smashed, 2);
assert.ok(run.combo > 1, 'rapid smashes did not chain a combo');

stepMonsterStunts(run, createKartState(), {}, {}, 4.1);
assert.equal(run.combo, 1, 'expired smash combo did not reset');

const airRun = createMonsterScoreState();
const airborne = createKartState({ grounded: false, stuntPitch: 0, stuntPitchVelocity: 0, stuntRoll: 0, stuntRollVelocity: 0 });
stepMonsterStunts(airRun, airborne, { throttle: 1, steer: 1 }, {}, 0.5);
assert.ok(airborne.stuntPitch < 0, 'W/S air pitch did not rotate the monster truck');
assert.ok(airborne.stuntRoll < 0, 'A/D air roll did not rotate the monster truck');
assert.equal(airRun.totalAirTime, 0.5);
const reverseAirRun = createMonsterScoreState();
const reverseAirborne = createKartState({ grounded: false, stuntPitch: 0, stuntPitchVelocity: 0, stuntRoll: 0, stuntRollVelocity: 0 });
stepMonsterStunts(reverseAirRun, reverseAirborne, { throttle: -1, steer: -1 }, {}, 0.5);
assert.ok(reverseAirborne.stuntPitch > 0, 'reverse W/S input did not pitch the truck in the opposite direction');
assert.ok(reverseAirborne.stuntRoll > 0, 'reverse A/D input did not roll the truck in the opposite direction');

function stuntAtRate(hz) {
  const rateRun = createMonsterScoreState();
  const rateKart = createKartState({ grounded: false });
  for (let i = 0; i < hz; i++) stepMonsterStunts(rateRun, rateKart, { throttle: 1, steer: 1 }, {}, 1 / hz);
  return { pitch: rateKart.stuntPitch, roll: rateKart.stuntRoll, airTime: rateRun.totalAirTime };
}
const stunt60 = stuntAtRate(60);
const stunt120 = stuntAtRate(120);
assert.ok(Math.abs(stunt60.pitch - stunt120.pitch) < 0.02, 'monster air control is unstable across 60/120 Hz');
assert.ok(Math.abs(stunt60.roll - stunt120.roll) < 0.02, 'monster barrel-roll control is unstable across 60/120 Hz');
assert.ok(Math.abs(stunt60.airTime - 1) < 1e-9, 'monster air-time total drifted at 60 Hz');

const trickRun = createMonsterScoreState();
trickRun.currentAirTime = 1.15;
const cleanFlip = createKartState({ grounded: true, stuntPitch: Math.PI * 2, stuntPitchVelocity: 0 });
const cleanResult = stepMonsterStunts(trickRun, cleanFlip, {}, { landed: true, landingSpeed: 9 }, 1 / 60);
assert.equal(cleanResult.turns, 1, 'full rotation was not recognized as a backflip');
assert.equal(cleanResult.clean, true, 'upright backflip landing was not clean');
assert.equal(cleanResult.perfect, true, 'upright backflip landing missed the perfect grade');
assert.ok(cleanResult.points >= 900, 'backflip score is too small to reward stunt play');
assert.equal(trickRun.bestTrick, 'BACKFLIP');
assert.equal(trickRun.flips, 1, 'banked flip was not tracked');
assert.equal(trickRun.perfectLandings, 1, 'perfect landing was not tracked');

const directionalRun = createMonsterScoreState();
directionalRun.currentAirTime = 1.2;
const frontflip = createKartState({ grounded: true, stuntPitch: -Math.PI * 2 });
const frontflipResult = stepMonsterStunts(directionalRun, frontflip, {}, { landed: true, landingSpeed: 9 }, 1 / 60);
assert.equal(frontflipResult.label, 'FRONTFLIP', 'frontflip direction was collapsed into a generic backflip');
const leftRollRun = createMonsterScoreState();
leftRollRun.currentAirTime = 1.2;
const leftRoll = createKartState({ grounded: true, stuntRoll: Math.PI * 2 });
assert.equal(stepMonsterStunts(leftRollRun, leftRoll, {}, { landed: true, landingSpeed: 9 }, 1 / 60).label, 'LEFT ROLL',
  'barrel-roll direction was not recognized');
const corkRun = createMonsterScoreState();
corkRun.currentAirTime = 1.35;
const cork = createKartState({ grounded: true, stuntPitch: -Math.PI * 2, stuntRoll: Math.PI * 2 });
assert.equal(stepMonsterStunts(corkRun, cork, {}, { landed: true, landingSpeed: 10 }, 1 / 60).label, 'CORKSCREW',
  'combined pitch and roll did not compose a corkscrew');

const provisionalRun = createMonsterScoreState();
const provisionalKart = createKartState({ grounded: false, y: 8, x: 14, z: 0, stuntPitch: Math.PI * 2 });
stepMonsterStunts(provisionalRun, provisionalKart, {}, { jumped: true }, 0.35);
assert.ok(provisionalRun.pendingTrick?.label, 'airborne trick did not expose a compact provisional label');
assert.equal(provisionalRun.score, 0, 'provisional airborne points banked before a landing');

// The big truck gets a broader clean window than a kart without making roof landings safe.
const forgivingRun = createMonsterScoreState();
forgivingRun.currentAirTime = 0.7;
const forgivingKart = createKartState({ grounded: true, stuntPitch: 0.9 });
const forgivingResult = stepMonsterStunts(forgivingRun, forgivingKart, {}, { landed: true, landingSpeed: 14 }, 1 / 60);
assert.equal(forgivingResult.clean, true, 'heavy truck clean-landing window is too strict');
assert.equal(forgivingKart.integrity, 100, 'forgiving clean landing damaged the truck');

// Monster tuning feeds the shared pure suspension/landing contract.
const rampTruck = createKartState({ vz: 12, speed: 12, stuntPitch: 0 });
const truckJump = stepKart(rampTruck, { throttle: 1 }, { onRoad: true, ramp: true }, 1 / 60, MONSTER_TUNING);
assert.equal(truckJump.jumped, true, 'monster ramp did not launch');
let truckLanding = null;
for (let i = 0; i < 240; i++) {
  const event = stepKart(rampTruck, { throttle: 1 }, { onRoad: true }, 1 / 60, MONSTER_TUNING);
  if (event.landed) { truckLanding = event; break; }
}
assert.equal(truckLanding?.perfectLanding, true, 'upright monster ramp landing was not rewarded');
assert.ok(rampTruck.suspensionCompression > 0.15, 'monster suspension did not visibly load on landing');

const roughRun = createMonsterScoreState();
roughRun.currentAirTime = 0.8;
roughRun.combo = 4;
roughRun.comboTime = 2;
const roughKart = createKartState({ grounded: true, stuntPitch: Math.PI, stuntPitchVelocity: 0 });
const roughResult = stepMonsterStunts(roughRun, roughKart, {}, { landed: true, landingSpeed: 16 }, 1 / 60);
assert.equal(roughResult.clean, false, 'upside-down landing was incorrectly clean');
assert.equal(roughResult.points, 0, 'failed airborne package banked despite the crash');
assert.ok(roughKart.integrity < 100, 'rough landing did not damage the truck');
assert.equal(roughRun.combo, 1, 'rough landing did not break the combo');

const smashRun = createMonsterScoreState();
const target = { x: 0, z: 0, y: 0.54, kind: 'junk-car', destroyed: false, crushVelocity: 0 };
const arena = { targets: [target], destroyed: 0 };
const truck = createKartState({ x: 0, z: 0, previousX: -4, previousZ: 0, vx: 14, speed: 14, grounded: true });
const events = resolveMonsterSmashes(arena, smashRun, truck);
assert.equal(events.length, 1, 'swept truck collision missed the crush target');
assert.equal(target.destroyed, true);
assert.equal(arena.destroyed, 1);
assert.equal(truck.grounded, false, 'crushing a car should kick the truck upward');
assert.ok(truck.vx > 13, 'smash discarded too much monster-truck momentum');
assert.ok(events[0].impactStrength > 0.5, 'smash did not expose a strong impact pulse');
assert.equal(truck.pendingImpactStrength, events[0].impactStrength, 'smash impact was not queued for shared feedback');

const meowster = getMonsterVehicleProfile('meowster');
const cyber = getMonsterVehicleProfile('cyber');
const tipsy = getMonsterVehicleProfile('tipsy');
assert.ok(cyber.mass > meowster.mass && cyber.ramMultiplier > meowster.ramMultiplier, 'Cyber Kaki lacks its honest heavy-ramming tradeoff');
assert.ok(cyber.airRollRate < meowster.airRollRate, 'Cyber Kaki should rotate more slowly in air');
assert.equal(tipsy.name, 'Tipsy Tumbler');
assert.ok(tipsy.airRollRate > meowster.airRollRate && tipsy.ramMultiplier > meowster.ramMultiplier,
  'Tipsy Tumbler lacks its quick-rotation/strong-ram tradeoff');
const chaosRun = createMonsterScoreState();
chaosRun.chaos = 40;
const chaosKart = createKartState({ grounded: true });
const chaosEvent = stepMonsterChaos(chaosRun, chaosKart, { boost: true }, 0.5);
assert.equal(chaosEvent.boosting, true, 'Shift did not spend earned Zoomies');
assert.ok(chaosRun.chaos < 40 && chaosRun.chaosSpent > 0, 'Zoomies boost did not debit the meter');
assert.ok(chaosKart.boostTime > 0, 'Zoomies spend did not feed shared vehicle boost physics');

const wheelieRun = createMonsterScoreState();
const wheelieKart = createKartState({ grounded: true, speed: 8, longitudinalWeightTransfer: -0.8 });
wheelieKart.wheelContacts = {
  leftFront: { axle: 'front', compression: 0.08 },
  rightFront: { axle: 'front', compression: 0.08 },
  leftRear: { axle: 'rear', compression: 0.72 },
  rightRear: { axle: 'rear', compression: 0.72 },
};
for (let index = 0; index < 48; index += 1) {
  stepMonsterStunts(wheelieRun, wheelieKart, { throttle: 1 }, {}, 1 / 60);
  wheelieKart.longitudinalWeightTransfer = -0.8;
}
assert.ok(wheelieRun.score > 0 && wheelieRun.lastEventLabel.includes('WHEELIE'),
  'sustained rear-tire load did not recognize a wheelie');

console.log('Kaki Rally Monster Smash smoke passed');
