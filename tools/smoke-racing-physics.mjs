import assert from 'node:assert/strict';
import {
  createKartState,
  stepKart,
  updateRaceProgress,
  rankRaceCars,
  formatRaceTime,
  impactDamage,
  applyKartDamage,
  repairKart,
  driftScoreStep,
} from '../src/racing/physics.js';
import { mapRacingSteerInput, RACING_STEER_SIGN } from '../src/racing/racingSteering.js';

// Shared movement input reports left as -1 and right as +1, while all racing
// vehicle controllers expect the opposite sign. Lock keyboard/stick and crash
// touch steering to the same mapping so modes cannot drift apart again.
assert.equal(RACING_STEER_SIGN, -1, 'racing steering correction changed sign');
assert.equal(mapRacingSteerInput(-1), 1, 'keyboard/stick left still steers right');
assert.equal(mapRacingSteerInput(1), -1, 'keyboard/stick right still steers left');
assert.equal(mapRacingSteerInput(0, { touchLeft: true }), 1, 'touch left still steers right');
assert.equal(mapRacingSteerInput(0, { touchRight: true }), -1, 'touch right still steers left');
assert.equal(mapRacingSteerInput(0, { touchLeft: true, touchRight: true }), 0, 'opposed touch steering must cancel');

function simulate(kart, controls, contact, seconds, hz = 60) {
  const dt = 1 / hz;
  for (let i = 0; i < Math.round(seconds * hz); i++) stepKart(kart, controls, contact, dt);
}

// Gas should produce an arcade-useful road speed without exceeding the cap.
const launch = createKartState();
simulate(launch, { throttle: 1 }, { onRoad: true }, 2.5);
assert.ok(launch.speed > 15, `expected acceleration, got ${launch.speed}`);
assert.ok(launch.speed <= 24.01, `road cap leaked: ${launch.speed}`);
const launch120 = createKartState();
simulate(launch120, { throttle: 1 }, { onRoad: true }, 2.5, 120);
assert.ok(Math.abs(launch.speed - launch120.speed) < 0.08, 'road speed is unstable across 60/120 Hz');
assert.ok(Math.abs(launch.z - launch120.z) < 0.18, 'road distance is unstable across 60/120 Hz');

// A committed slide charges a mini-turbo; releasing drift fires it.
const drifter = createKartState({ vz: 17, speed: 17 });
simulate(drifter, { throttle: 1, steer: 1, drift: true }, { onRoad: true }, 1.25);
assert.ok(drifter.driftCharge >= 0.38, `drift failed to charge: ${drifter.driftCharge}`);
const boostEvent = stepKart(drifter, { throttle: 1, steer: 0, drift: false }, { onRoad: true }, 1 / 60);
assert.equal(boostEvent.boostStarted, true, 'drift release did not start boost');
assert.ok(drifter.boostTime > 0, 'boost duration missing');
assert.equal(boostEvent.perfectDrift, true, 'well-timed tier-three release missed its perfect window');
assert.equal(boostEvent.perfectDriftChain, 1, 'perfect drift did not start a chain');

// Space uses the same slide model as a handbrake, with a quicker breakaway
// and a modest speed scrub instead of the old vertical hop.
const handbrake = createKartState({ vz: 12, speed: 12 });
const beforeHandbrakeSpeed = handbrake.speed;
simulate(handbrake, { throttle: 1, steer: 0.75, drift: true, handbrake: true }, { onRoad: true }, 0.45);
assert.equal(handbrake.drifting, true, 'held handbrake did not initiate a powerslide');
assert.ok(Math.abs(handbrake.lateralSpeed) > 0.5, 'handbrake powerslide produced no lateral breakaway');
assert.ok(handbrake.speed < beforeHandbrakeSpeed + 4, 'handbrake did not scrub forward speed');
assert.ok(boostEvent.boostHeat > 0, 'mini-turbo did not expose its heat cost');

// Holding a drift too long trades the turbo for a speed/heat penalty.
const overcooked = createKartState({ vz: 17, speed: 17 });
simulate(overcooked, { throttle: 1, steer: 1, drift: true }, { onRoad: true }, 1.8);
const overcookedSpeed = overcooked.speed;
const overcookedEvent = stepKart(overcooked, { throttle: 1 }, { onRoad: true }, 1 / 60);
assert.equal(overcookedEvent.driftOvercooked, true, 'overheld drift was not flagged');
assert.equal(overcookedEvent.boostStarted, false, 'overcooked drift still granted a turbo');
assert.ok(overcooked.speed < overcookedSpeed * 0.95, 'overcooked release did not scrub momentum');

// Heat eventually locks turbo, then produces a single cooled/recovered event.
const hotKart = createKartState({ boostTime: 20, boostLevel: 3 });
let overheatedEvent = null;
let cooledEvent = null;
for (let i = 0; i < 600; i++) {
  const event = stepKart(hotKart, { throttle: 1 }, { onRoad: true }, 1 / 60);
  if (event.overheated) overheatedEvent = event;
  if (event.cooled) { cooledEvent = event; break; }
}
assert.ok(overheatedEvent, 'sustained turbo never overheated');
assert.ok(cooledEvent, 'overheated turbo never recovered');
assert.equal(hotKart.overheated, false, 'cooled turbo remained locked');
const padKart = createKartState();
const padEvent = stepKart(padKart, { throttle: 1 }, { onRoad: true, boostPad: true }, 1 / 60);
assert.equal(padEvent.boostStarted, true, 'boost pad did not fire');
assert.ok(padKart.boostHeat < 0.1, 'one boost pad nearly cooked the turbo');

// An expired high-tier drift boost cannot leak its tier into a later pad.
const staleTierKart = createKartState({ boostTime: 0.01, boostLevel: 3 });
stepKart(staleTierKart, { throttle: 1 }, { onRoad: true }, 1 / 60);
assert.equal(staleTierKart.boostLevel, 0, 'expired boost retained a stale tier');
const freshPadEvent = stepKart(staleTierKart, { throttle: 1 }, { onRoad: true, boostPad: true }, 1 / 60);
assert.equal(freshPadEvent.boostLevel, 2, 'fresh pad reported the wrong boost tier');
assert.equal(staleTierKart.boostLevel, 2, 'fresh pad inherited an expired drift tier');

// Leaving the ribbon should scrub even an over-speed kart down to mud pace.
const offroad = createKartState({ vz: 30, speed: 30 });
simulate(offroad, { throttle: 1 }, { onRoad: false }, 1.5);
assert.ok(offroad.speed <= 11.51, `off-road cap leaked: ${offroad.speed}`);

// Grip and drag are independent surface inputs: grip kills slip, drag kills speed.
const sticky = createKartState({ vx: 8, vz: 14, speed: 16 });
const slippery = createKartState({ vx: 8, vz: 14, speed: 16 });
simulate(sticky, {}, { onRoad: true, surfaceGrip: 1.25, surfaceDrag: 0.2 }, 0.5);
simulate(slippery, {}, { onRoad: true, surfaceGrip: 0.25, surfaceDrag: 0.2 }, 0.5);
assert.ok(Math.abs(sticky.lateralSpeed) < Math.abs(slippery.lateralSpeed) * 0.15, 'surface grip did not progressively catch lateral slip');
const cleanSurface = createKartState({ vz: 18, speed: 18 });
const deepMud = createKartState({ vz: 18, speed: 18 });
simulate(cleanSurface, { throttle: 1 }, { onRoad: true, surfaceGrip: 1, surfaceDrag: 0 }, 0.7);
simulate(deepMud, { throttle: 1 }, { onRoad: true, surfaceGrip: 1, surfaceDrag: 3 }, 0.7);
assert.ok(deepMud.speed < cleanSurface.speed * 0.5, 'surface drag did not independently scrub forward speed');

// Braking cannot unpredictably skip through neutral into reverse in one frame.
const braking = createKartState({ vz: 8, speed: 8 });
stepKart(braking, { throttle: -1 }, { onRoad: true }, 0.5);
assert.ok(braking.vz >= 0, 'brake input crossed directly into reverse');

// Manual hop leaves the ground and cleanly lands under gravity.
const jumper = createKartState({ vz: 10, speed: 10 });
const jumpEvent = stepKart(jumper, { throttle: 1, hop: true }, { onRoad: true }, 1 / 60);
assert.equal(jumpEvent.jumped, true, 'hop did not launch');
assert.equal(jumper.grounded, false, 'hop stayed grounded');
let landingEvent = null;
for (let i = 0; i < 180; i++) {
  const event = stepKart(jumper, { throttle: 1 }, { onRoad: true }, 1 / 60);
  if (event.landed) { landingEvent = event; break; }
}
assert.equal(landingEvent?.landed, true, 'airborne kart never landed');
assert.ok(landingEvent.landingSpeed > 0, 'landing impact speed was not exposed to stunt/damage systems');
assert.equal(jumper.y, 0, 'landing did not clamp to road height');
assert.equal(landingEvent.perfectLanding, true, 'upright hop was not rewarded as a perfect landing');
assert.equal(landingEvent.cleanLanding, true, 'perfect landing should also satisfy the clean contract');
assert.ok(landingEvent.airTime > 0.5, 'landing did not report complete air time');
assert.ok(landingEvent.landingQuality > 0.9, 'upright hop received a poor landing grade');
assert.ok(jumper.suspensionCompression > 0, 'landing did not load the suspension');

const hardLanding = createKartState({
  grounded: false,
  y: 0.05,
  vy: -18,
  vz: 16,
  speed: 16,
  airPitch: 1.35,
  airRoll: 0.2,
  airTime: 0.7,
});
const hardEvent = stepKart(hardLanding, {}, { onRoad: true }, 1 / 60);
assert.equal(hardEvent.hardLanding, true, 'badly pitched heavy landing was not flagged');
assert.ok(hardLanding.speed < 13, 'hard landing did not have a consequential momentum cost');
const airControl = createKartState({ grounded: false, y: 4, vy: 1, stuntPitch: 2.25 });
stepKart(airControl, { airPitch: 1, steer: 1 }, { onRoad: true }, 0.25);
assert.ok(Math.abs(airControl.airPitch) > 0.01 && Math.abs(airControl.airRoll) > 0.01, 'normal air presentation controls did not respond');
assert.equal(airControl.stuntPitch, 2.25, 'normal air control mutated the Monster Smash stuntPitch contract');

// Wrapped indices must cross start/finish without awarding a phantom lap.
const progress = createKartState({ nearestIndex: 190, unwrappedIndex: -2 });
updateRaceProgress(progress, 191, 192);
updateRaceProgress(progress, 0, 192);
assert.equal(progress.completedLaps, 0, 'grid crossing awarded a lap');
for (let i = 1; i < 192; i++) updateRaceProgress(progress, i, 192);
updateRaceProgress(progress, 0, 192);
assert.equal(progress.completedLaps, 1, 'full circuit did not award a lap');

const cars = [
  { id: 'player', gridIndex: 0, physics: createKartState({ unwrappedIndex: 220 }) },
  { id: 'rival', gridIndex: 1, physics: createKartState({ unwrappedIndex: 250 }) },
];
assert.equal(rankRaceCars(cars, 192)[0].id, 'rival', 'ranking ignored continuous progress');
assert.equal(formatRaceTime(65.4329), '1:05.432');

// Pack rubbing is free; a real closing-speed crash causes zoned/mechanical damage.
assert.equal(impactDamage(5.5), 0, 'low-speed rubbing should not damage the chassis');
assert.ok(impactDamage(16) > 15, 'high-speed impact should matter');
const damaged = createKartState();
applyKartDamage(damaged, 48, 'front');
assert.equal(damaged.integrity, 52, 'chassis integrity did not fall');
assert.ok(damaged.engineDamage > 0, 'front impact did not damage the engine');
const healthy = createKartState();
simulate(healthy, { throttle: 1 }, { onRoad: true }, 5);
simulate(damaged, { throttle: 1 }, { onRoad: true }, 5);
assert.ok(damaged.speed < healthy.speed * 0.9, 'engine damage did not reduce performance');
repairKart(damaged, 80);
assert.equal(damaged.integrity, 100, 'pit repair did not clamp at full integrity');
assert.ok(damaged.engineDamage < 0.05, 'pit repair left major engine damage');
const recovering = createKartState({ vz: 10, speed: 10, angularVelocity: 1 });
applyKartDamage(recovering, 21, 'left');
const recoveryEvent = stepKart(recovering, { throttle: 1 }, { onRoad: true }, 1 / 60);
assert.equal(recoveryEvent.impactStrength, 0.5, 'collision impact pulse was not exposed on the next pure step');
assert.ok(recovering.angularVelocity < 0.95, 'collision recovery assist did not tame spin');

// Drift scoring is frame-rate independent and requires genuine lateral slip.
const scoringKart = createKartState({ speed: 18, drifting: true, lateralSpeed: 4.5 });
const oneStepScore = driftScoreStep(scoringKart, 1, 2.5);
let sixtyStepScore = 0;
for (let i = 0; i < 60; i++) sixtyStepScore += driftScoreStep(scoringKart, 1 / 60, 2.5);
assert.ok(oneStepScore > 0, 'a fast slide earned no drift points');
assert.ok(Math.abs(oneStepScore - sixtyStepScore) < 1e-9, 'drift score changes with frame rate');
scoringKart.lateralSpeed = 0;
assert.equal(driftScoreStep(scoringKart, 1, 8), 0, 'straight-line drift-button hold earned points');

console.log('Kaki Rally physics smoke passed');
