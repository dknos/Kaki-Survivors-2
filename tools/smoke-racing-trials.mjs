import assert from 'node:assert/strict';
import {
  TRIALS_TRACKS,
  TRIALS_TRACK_ORDER,
  getTrialsTrack,
  sampleTrialsGround,
} from '../src/racing/trialsTracks.js';
import {
  TRIALS_CONTROL_SCHEMA,
  TRIALS_VEHICLE_PROFILES,
  awardTrialsDestruction,
  createTrialsResult,
  createTrialsScoreState,
  createTrialsState,
  getTrialsProfile,
  rankTrialsMedal,
  resetTrialsState,
  stepTrials,
  stepTrialsScore,
} from '../src/racing/trialsPhysics.js';

function placeOnGround(state, track, profile, x, speed = 0) {
  const ground = sampleTrialsGround(track, x);
  assert.ok(ground, `test placement ${x} must be on terrain`);
  state.x = x;
  state.y = ground.height + profile.rideHeight;
  state.vx = speed * Math.cos(ground.angle);
  state.vy = speed * Math.sin(ground.angle);
  state.pitch = ground.angle;
  state.pitchVelocity = 0;
  state.grounded = true;
  state.wheelContact = { front: true, rear: true };
  return state;
}

function simulate(state, controls, seconds, hz = 60, track = state.trackId, profile = state.profileId) {
  const dt = 1 / hz;
  const events = [];
  for (let i = 0; i < Math.round(seconds * hz); i++) events.push(stepTrials(state, controls, dt, track, profile));
  return events;
}

function normalizeAngle(angle) {
  const tau = Math.PI * 2;
  let wrapped = (angle + Math.PI) % tau;
  if (wrapped < 0) wrapped += tau;
  return wrapped - Math.PI;
}

function traverseGap(track, profile, gap) {
  const lipX = gap.start - 0.02;
  const landing = sampleTrialsGround(track, gap.end + 0.01);
  assert.ok(landing, `${track.id}/${gap.label} has no landing terrain`);
  const state = placeOnGround(
    createTrialsState(track, profile),
    track,
    profile,
    lipX,
    profile.turboMaxSpeed,
  );
  let finalEvent = null;
  for (let i = 0; i < 6 * 240; i++) {
    // A small deterministic PD controller models a player actively matching
    // the landing pitch instead of relying on a lucky fixed lean input.
    const pitchError = normalizeAngle(landing.angle - state.pitch);
    const lean = Math.max(-1, Math.min(1, pitchError * 0.8 - state.pitchVelocity * 0.2));
    const event = stepTrials(state, { throttle: 1, turbo: true, lean }, 1 / 240, track, profile);
    if (event.landed || event.crash) {
      finalEvent = event;
      break;
    }
  }
  return { state, event: finalEvent };
}

// All three courses are complete, immutable, increasingly difficult height fields.
assert.deepEqual(TRIALS_TRACK_ORDER, ['meadow', 'quarry', 'crown']);
assert.equal(new Set(TRIALS_TRACK_ORDER).size, 3);
let previousDifficulty = 0;
for (const id of TRIALS_TRACK_ORDER) {
  const track = TRIALS_TRACKS[id];
  assert.equal(getTrialsTrack(id), track);
  assert.ok(Object.isFrozen(track) && Object.isFrozen(track.heightPoints), `${id} data must be immutable`);
  assert.ok(track.name && track.subtitle && track.difficultyLabel, `${id} is missing cozy presentation copy`);
  assert.ok(track.difficulty > previousDifficulty, `${id} difficulty did not rise`);
  previousDifficulty = track.difficulty;
  assert.ok(track.length > 700 && track.finish > 0 && track.finish < track.length, `${id} is not a long finishable run`);
  assert.ok(Object.keys(track.colors).length >= 6, `${id} palette is incomplete`);
  assert.ok(track.heightPoints.length >= 20, `${id} terrain is under-authored`);
  for (let i = 1; i < track.heightPoints.length; i++) {
    assert.ok(track.heightPoints[i].x > track.heightPoints[i - 1].x, `${id} height controls are unordered`);
  }
  assert.equal(track.heightPoints[0].x, 0);
  assert.equal(track.heightPoints.at(-1).x, track.length);
  assert.ok(track.gaps.length >= 2, `${id} needs real launch gaps`);
  for (const gap of track.gaps) {
    assert.equal(sampleTrialsGround(track, (gap.start + gap.end) * 0.5), null, `${id} gap has phantom ground`);
    assert.ok(sampleTrialsGround(track, gap.start - 0.01), `${id} launch lip is missing`);
    assert.ok(sampleTrialsGround(track, gap.end + 0.01), `${id} landing lip is missing`);
  }
  let lastCheckpoint = 0;
  for (const checkpoint of track.checkpoints) {
    assert.ok(checkpoint.x > lastCheckpoint && checkpoint.x < track.finish, `${id} checkpoint order is invalid`);
    assert.ok(sampleTrialsGround(track, checkpoint.x), `${id} checkpoint sits in empty sky`);
    lastCheckpoint = checkpoint.x;
  }
  assert.ok(track.medals.S < track.medals.A && track.medals.A < track.medals.B, `${id} medal thresholds are reversed`);
  assert.ok(track.obstacles.length >= 5, `${id} needs crushable props`);
  for (const obstacle of track.obstacles) {
    assert.ok(sampleTrialsGround(track, obstacle.x), `${obstacle.id} sits in a gap`);
    assert.ok(obstacle.kind && obstacle.width > 0 && obstacle.height > 0, `${obstacle.id} is incomplete`);
  }
}

// Both vehicle personalities share one input schema but not one feel.
const monster = getTrialsProfile('monster');
const buggy = getTrialsProfile('buggy');
assert.ok(Object.isFrozen(TRIALS_VEHICLE_PROFILES) && Object.isFrozen(monster));
assert.equal(monster.controls, TRIALS_CONTROL_SCHEMA);
assert.equal(buggy.controls, TRIALS_CONTROL_SCHEMA);

const reverseRun = createTrialsState('meadow', 'monster');
const reverseStartX = reverseRun.x;
simulate(reverseRun, { throttle: -1 }, 1.0);
assert.ok(reverseRun.x < reverseStartX - 1, 'negative throttle should produce useful reverse travel');
assert.ok(reverseRun.vx < -1, 'reverse should accelerate beyond a near-zero brake equilibrium');
assert.ok(monster.mass > buggy.mass * 2 && monster.crushPower > buggy.crushPower, 'monster truck lost its heavy crusher identity');
assert.ok(buggy.acceleration > monster.acceleration && buggy.airLeanTorque > monster.airLeanTorque, 'buggy lost its agile identity');

// Acceleration follows rolling terrain and fixed substeps keep common refresh rates close.
const rateRuns = [30, 60, 120].map((hz) => {
  const state = createTrialsState('meadow', 'buggy');
  simulate(state, { throttle: 1 }, 3, hz);
  const ground = sampleTrialsGround('meadow', state.x);
  assert.ok(state.x > 45, `${hz} Hz run did not accelerate: ${state.x}`);
  assert.ok(Number.isFinite(state.x + state.y + state.vx + state.vy + state.pitch), `${hz} Hz run exploded numerically`);
  assert.ok(ground && state.grounded, `${hz} Hz warm-up unexpectedly left the terrain`);
  assert.ok(Math.abs(state.y - (ground.height + buggy.rideHeight)) <= buggy.suspensionTravel + 0.15, `${hz} Hz suspension lost terrain`);
  return state;
});
assert.ok(Math.max(...rateRuns.map((state) => state.x)) - Math.min(...rateRuns.map((state) => state.x)) < 0.08, '30/60/120 Hz distance diverged');

// An authored lip produces a ballistic takeoff and a later terrain landing.
const gapRun = placeOnGround(createTrialsState('meadow', 'monster'), 'meadow', monster, 183, 19);
let sawTakeoff = false;
let gapLanding = null;
for (let i = 0; i < 360; i++) {
  const event = stepTrials(gapRun, { throttle: 1, lean: -0.08 }, 1 / 120);
  sawTakeoff ||= event.takeoff;
  if (sawTakeoff && event.landed) { gapLanding = event; break; }
}
assert.equal(sawTakeoff, true, 'ramp edge failed to preserve launch velocity');
assert.ok(gapLanding, 'launched vehicle never met the landing terrain');
assert.ok(['perfect', 'clean', 'rough'].includes(gapLanding.landingQuality), `gap landing was not recoverable: ${gapLanding.landingQuality}`);

// Every authored gap is traversable by both garage choices at a plausible
// turbo-speed approach. This guards against an impossible late-track restart
// loop when geometry grows faster than the landing-forgiveness envelope.
for (const trackId of TRIALS_TRACK_ORDER) {
  const track = TRIALS_TRACKS[trackId];
  for (const profile of [monster, buggy]) {
    for (const gap of track.gaps) {
      const traversal = traverseGap(track, profile, gap);
      const label = `${track.id}/${profile.id}/${gap.label}`;
      assert.ok(traversal.event?.landed, `${label} never reached landing terrain`);
      assert.notEqual(traversal.event.landingQuality, 'crash', `${label} forces a crash at full turbo`);
      assert.equal(traversal.state.crashed, false, `${label} left the vehicle crashed`);
      assert.ok(traversal.state.x >= gap.end, `${label} landed before clearing the gap`);
    }
  }
}

// Landing bands preserve momentum when aligned and clearly separate rough/crash outcomes.
function forcedLanding(angleError, impactSpeed, profile = buggy) {
  const state = createTrialsState('meadow', profile.id);
  placeOnGround(state, 'meadow', profile, 45, 14);
  const ground = sampleTrialsGround('meadow', state.x);
  state.grounded = false;
  state.y = ground.height + profile.rideHeight + 0.01;
  state.vy = -impactSpeed;
  state.pitch = ground.angle + angleError;
  state.airborneTime = 0.8;
  return { state, event: stepTrials(state, {}, 1 / 60) };
}
const perfect = forcedLanding(0.04, 5);
assert.equal(perfect.event.landingQuality, 'perfect');
assert.ok(perfect.state.vx > 12.5, 'perfect landing discarded forward momentum');
assert.equal(forcedLanding(0.35, 7).event.landingQuality, 'clean');
assert.equal(forcedLanding(0.8, 9).event.landingQuality, 'rough');
const wreck = forcedLanding(Math.PI, 9);
assert.equal(wreck.event.landingQuality, 'crash');
assert.equal(wreck.event.crash, true);
assert.equal(wreck.state.crashed, true);

// Sustained air lean completes a real continuous rotation and reports it once.
const flipper = createTrialsState('meadow', 'buggy');
placeOnGround(flipper, 'meadow', buggy, 238, 10);
flipper.grounded = false;
flipper.y += 28;
flipper.vy = 1;
flipper.airStartPitch = flipper.pitch;
let reportedFlips = 0;
for (let i = 0; i < 240 && !flipper.crashed; i++) {
  reportedFlips += stepTrials(flipper, { lean: 1 }, 1 / 120).flips;
  if (reportedFlips) break;
}
assert.ok(reportedFlips >= 1 && flipper.totalFlips >= 1, 'air lean failed to recognize a full flip');

// Turbo starts, locks out at full heat, then only returns after deep cooling.
const heater = createTrialsState('meadow', 'monster');
let turboStart = false;
let turboOverheat = false;
for (const event of simulate(heater, { throttle: 1, turbo: true }, 4.2, 120)) {
  turboStart ||= event.turboStart;
  turboOverheat ||= event.turboOverheat;
}
assert.equal(turboStart, true);
assert.equal(turboOverheat, true);
assert.equal(heater.turboOverheated, true);
assert.equal(heater.turboActive, false, 'overheated turbo stayed active');
simulate(heater, { throttle: 1, turbo: true }, 1, 120);
assert.equal(heater.turboOverheated, true, 'turbo recovered after token cooling');
let turboCool = false;
for (const event of simulate(heater, {}, 4.5, 120)) turboCool ||= event.turboCool;
assert.equal(turboCool, true);
assert.equal(heater.turboOverheated, false);
assert.ok(heater.turboHeat <= monster.turboRecoveryHeat + 1e-6);

// Resetting at the latest checkpoint keeps earned run history but repairs the truck.
const resettable = createTrialsState('quarry', 'monster', {
  checkpointIndex: 1, elapsedTime: 42, totalFlips: 3, destroyedCount: 4,
  crashed: true, crashState: 'fallen', crashReason: 'gap', crashes: 1, sectionFaults: 2,
});
resetTrialsState(resettable);
assert.equal(resettable.x, TRIALS_TRACKS.quarry.checkpoints[1].x);
assert.equal(resettable.checkpointIndex, 1);
assert.equal(resettable.elapsedTime, 42);
assert.equal(resettable.totalFlips, 3);
assert.equal(resettable.destroyedCount, 4);
assert.equal(resettable.sectionFaults, 2, 'checkpoint rewind must not erase clean-section faults');
assert.equal(resettable.crashed, false);
assert.equal(resettable.grounded, true);
assert.equal(resettable.restarts, 1);

// Finish and checkpoint events are one-frame gates.
const finisher = placeOnGround(createTrialsState('meadow', 'buggy'), 'meadow', buggy, 755, 22);
finisher.checkpointIndex = TRIALS_TRACKS.meadow.checkpoints.length - 1;
let finishEvent = null;
for (let i = 0; i < 120; i++) {
  const event = stepTrials(finisher, { throttle: 1 }, 1 / 120);
  if (event.finish) { finishEvent = event; break; }
}
assert.ok(finishEvent && finisher.finished && Number.isFinite(finisher.finishTime), 'finish line event did not fire');
assert.equal(stepTrials(finisher, {}, 1 / 60).finish, false, 'finish event repeated');

// Style scoring rewards flips, air, clean sections, and profile-aware destruction.
const scoreState = createTrialsState('quarry', 'monster');
scoreState.elapsedTime = 80;
const score = createTrialsScoreState();
const styleEarned = stepTrialsScore(score, scoreState, {
  flips: 2,
  landed: true,
  landingQuality: 'perfect',
  airTime: 1.7,
  checkpoints: [{ id: 'test', index: 0, clean: true }],
}, 1 / 60);
assert.ok(styleEarned > 1500, `style chain is not worth chasing: ${styleEarned}`);
assert.equal(score.flips, 2);
assert.equal(score.perfectLandings, 1);
assert.equal(score.cleanSections, 1);
const oreCart = TRIALS_TRACKS.quarry.obstacles.find((obstacle) => obstacle.kind === 'ore-cart');
const monsterHit = awardTrialsDestruction(score, scoreState, oreCart, 8, monster);
assert.equal(monsterHit.destroyed, true, 'monster truck could not crush an ore cart');
assert.ok(monsterHit.points > 0);
assert.equal(awardTrialsDestruction(score, scoreState, oreCart, 20, monster).points, 0, 'same prop scored twice');
const buggyScore = createTrialsScoreState();
const buggyState = createTrialsState('quarry', 'buggy');
assert.equal(awardTrialsDestruction(buggyScore, buggyState, oreCart, 8, buggy).destroyed, false, 'light buggy gained monster crush power');

// Medal ranking uses adjusted time while retaining raw time for leaderboards.
assert.equal(rankTrialsMedal('meadow', 54), 'S');
assert.equal(rankTrialsMedal('meadow', 64), 'A');
assert.equal(rankTrialsMedal('meadow', 80), 'B');
assert.equal(rankTrialsMedal('meadow', 100), null);
const result = createTrialsResult('meadow', { rawTime: 60, styleScore: 9000 });
assert.equal(result.rawTime, 60);
assert.ok(result.effectiveTime < result.rawTime);
assert.equal(result.medal, 'S');

console.log('Kaki Rally Trials foundation smoke passed (3 tracks, 2 vehicles, deterministic 240 Hz substeps)');
