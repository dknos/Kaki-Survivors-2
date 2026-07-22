import assert from 'node:assert/strict';

import {
  CRASH_PHASES,
  CRASH_QUALITY,
} from '../src/racing/crash/crashConfig.js';
import {
  canTransitionCrashState,
  createCrashState,
  disposeCrashState,
  transitionCrashState,
} from '../src/racing/crash/crashState.js';
import {
  buildCrashTrafficSchedule,
  scheduleFingerprint,
  validateCrashScenario,
} from '../src/racing/crash/crashLanes.js';
import { PAWPRINT_INTERCHANGE } from '../src/racing/crash/scenarios/pawprintInterchange.js';
import {
  crashChainShouldSettle,
  crashScoreSnapshot,
  createCrashScoreState,
  scoreCrashImpact,
} from '../src/racing/crash/crashScoring.js';
import {
  kakiBoomFalloff,
  kakiBoomImpulse,
  triggerKakiBoom,
} from '../src/racing/crash/crashKakiBoom.js';
import {
  applyCrashDamage,
  createCrashDamageState,
  selectDamageZone,
} from '../src/racing/crash/crashDamage.js';
import { CrashReplayRecorder } from '../src/racing/crash/crashReplayRecorder.js';
import {
  buildReplayShotPlan,
  rankReplayHighlights,
  replayShotAt,
  replayWindowForHighlights,
  scoreReplayCameraCandidate,
  selectLargestReplayImpact,
} from '../src/racing/crash/crashReplayDirector.js';
import { readCrashRecord, writeCrashRecord } from '../src/racing/crash/crashRecords.js';

let assertions = 0;
function expect(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }

console.log('Kaki Catastrophe deterministic systems smoke');

const machine = createCrashState(0);
for (const phase of [
  CRASH_PHASES.INTRO,
  CRASH_PHASES.COUNTDOWN,
  CRASH_PHASES.APPROACH,
  CRASH_PHASES.LIVE_CRASH,
  CRASH_PHASES.SETTLING,
  CRASH_PHASES.REPLAY,
  CRASH_PHASES.RESULTS,
  CRASH_PHASES.REPLAY,
  CRASH_PHASES.RESULTS,
]) {
  expect(canTransitionCrashState(machine, phase), `${machine.phase} must allow ${phase}`);
  transitionCrashState(machine, phase, machine.serial + 1, 'smoke');
}
assertions += 1;
assert.throws(() => transitionCrashState(machine, CRASH_PHASES.LIVE_CRASH), /Invalid crash transition/);
expect(disposeCrashState(machine, 99), 'first state disposal must succeed');
equal(disposeCrashState(machine, 100), false, 'state disposal must be idempotent');

const scheduleA = buildCrashTrafficSchedule(0x12345678, 1, PAWPRINT_INTERCHANGE);
const scheduleB = buildCrashTrafficSchedule(0x12345678, 1, PAWPRINT_INTERCHANGE);
const scheduleC = buildCrashTrafficSchedule(0x12345679, 1, PAWPRINT_INTERCHANGE);
equal(scheduleFingerprint(scheduleA), scheduleFingerprint(scheduleB), 'same seed must produce the same schedule');
expect(scheduleFingerprint(scheduleA) !== scheduleFingerprint(scheduleC), 'different seeds must change the schedule');
expect(scheduleA.length >= 52, 'high-density schedule must include a dense flow plus authored targets');
for (const id of ['route-bus', 'jackknife-semi', 'energy-tanker', 'late-box']) expect(scheduleA.some((entry) => entry.id === id), `${id} must be present`);
const scenarioValidation = validateCrashScenario(PAWPRINT_INTERCHANGE);
expect(scenarioValidation.valid, scenarioValidation.errors.join('; '));
expect(PAWPRINT_INTERCHANGE.lanes.length >= 12, 'the junction must expose four multi-lane approaches and turns');

const score = createCrashScoreState(0);
let scored = scoreCrashImpact(score, { aId: 'player', bId: 'traffic-1', aClass: 'player', bClass: 'sedan', impulse: 1400, relativeSpeed: 3.1 }, 1);
equal(scored.qualified, false, 'sub-threshold relative speed must not score');
scored = scoreCrashImpact(score, { aId: 'player', bId: 'traffic-1', aClass: 'player', bClass: 'sedan', impulse: 4300, relativeSpeed: 14 }, 1.1);
expect(scored.qualified && scored.awarded > 850, 'a meaningful first impact must score and add a participant');
const firstTotal = score.score;
scored = scoreCrashImpact(score, { aId: 'player', bId: 'traffic-1', aClass: 'player', bClass: 'sedan', impulse: 6000, relativeSpeed: 16 }, 1.25);
equal(scored.reason, 'cooldown', 'the same vibrating pair must be cooled down');
equal(score.score, firstTotal, 'cooldown contact must not farm score');
scored = scoreCrashImpact(score, { aId: 'traffic-1', bId: 'traffic-2', aClass: 'sedan', bClass: 'bus', impulse: 9200, relativeSpeed: 17 }, 1.8);
expect(scored.qualified && score.participants.size === 2, 'a new pair must extend the physical chain');
scored = scoreCrashImpact(score, { aId: 'traffic-2', bId: 'loose-bumper', aClass: 'bus', bClass: 'debris', aParticipant: true, bParticipant: false, impulse: 5200, relativeSpeed: 12 }, 1.8);
expect(scored.qualified && score.participants.size === 2, 'cosmetic debris impacts may score but must not inflate vehicles involved');
expect(Math.abs(crashScoreSnapshot(score, 20).chainDuration - 0.7) < 1e-9, 'quiet and replay-tail time must not inflate chain duration');
equal(crashChainShouldSettle(score, 5.79), false, 'chain must remain live inside the four-second secondary-impact window');
equal(crashChainShouldSettle(score, 5.81), true, 'chain must settle after the quiet timeout');

equal(kakiBoomFalloff(0), 1, 'Boom must be strongest at its origin');
equal(kakiBoomFalloff(22), 0, 'Boom must reach zero at its radius');
const compactPulse = kakiBoomImpulse({ distance: 4, mass: 1100, charge: 1 });
const busPulse = kakiBoomImpulse({ distance: 4, mass: 10800, charge: 1 });
expect(compactPulse.deltaV > busPulse.deltaV, 'mass falloff must move a compact more than a bus');
expect(busPulse.deltaV <= 5.25, 'heavy vehicles must have a strict launch cap');
const boomState = createCrashScoreState();
boomState.boomCharge = 1;
const applied = [];
const makeBody = (id, mass, x) => ({
  id, kind: 'traffic', crashed: false,
  body: {
    translation: () => ({ x, y: 0.7, z: 0 }), mass: () => mass,
    wakeUp() {}, applyImpulse(value) { applied.push([id, value]); }, applyTorqueImpulse() {},
  },
});
const boomResult = triggerKakiBoom({ scoreState: boomState, origin: { x: 0, y: 0, z: 0 }, entities: [makeBody('compact', 1100, 3), makeBody('bus', 10800, 7), makeBody('far', 1200, 24)] });
expect(boomResult.triggered, 'a full Boom meter must fire');
equal(boomResult.affected.length, 2, 'Boom must ignore bodies beyond its physical radius');
equal(triggerKakiBoom({ scoreState: boomState, origin: { x: 0, y: 0, z: 0 }, entities: [] }).triggered, false, 'Boom must be single-use');

equal(selectDamageZone({ x: 0.1, z: 2 }, { width: 2, length: 4 }), 'front', 'positive longitudinal impacts must damage the front');
equal(selectDamageZone({ x: -1, z: 0.1 }, { width: 2, length: 4 }), 'left', 'negative lateral impacts must damage the left side');
const damage = createCrashDamageState();
for (let index = 0; index < 4; index++) applyCrashDamage(damage, { zone: 'front', impulse: 12000, relativeSpeed: 22, side: -0.2 });
expect(damage.zones.front > damage.zones.rear, 'damage must remain directional');
expect(damage.detached.has('front-bumper'), 'severe repeated front force must release the bumper');
expect(['cracked', 'shattered'].includes(damage.glass), 'progressive damage must change glass state');
const roadImpactDamage = createCrashDamageState();
applyCrashDamage(roadImpactDamage, { zone: 'left', impulse: 1800, relativeSpeed: 18, side: -0.8 });
expect(roadImpactDamage.severity > 0.08, 'a qualifying road-speed impact must create visible authored damage');
const parkingTapDamage = createCrashDamageState();
applyCrashDamage(parkingTapDamage, { zone: 'rear', impulse: 900, relativeSpeed: 2.2, side: 0.1 });
equal(parkingTapDamage.severity, 0, 'a parking-speed tap must not trigger crush-zone damage');

const recorder = new CrashReplayRecorder({ seconds: 0.3, hz: 10, maxObjects: 2, maxEvents: 16 });
for (let frame = 0; frame < 6; frame++) recorder.record(frame * 0.1, [{
  id: 'player', active: true,
  position: { x: frame, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocity: { x: 10, y: 0, z: 0 }, angularVelocity: { x: 0, y: 0, z: 0 },
  damage: frame / 10,
  damageZones: { front: frame / 10, rear: 0, left: frame / 20, right: 0 },
  glass: frame >= 5 ? 'shattered' : frame >= 3 ? 'cracked' : 'intact',
  detachedMask: frame,
  wheelState: [{
    visible: frame < 5,
    position: { x: -0.8, y: frame / 10, z: 1.2 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  }, null, null, null],
}], { throttle: 1, steer: 0 });
equal(recorder.frameCount, recorder.capacity, 'replay ring buffer must cap its frame count');
expect(Math.abs(recorder.chronologicalFrames()[0].time - 0.3) < 1e-9, 'ring wraparound must retain the newest chronological window');
const interpolated = recorder.sampleObject('player', 0.45);
expect(Math.abs(interpolated.position[0] - 4.5) < 1e-4, 'replay transforms must interpolate between snapshots');
expect(Math.abs(interpolated.damageZones.front - 0.45) < 0.01, 'replay must retain directional damage state');
equal(interpolated.glass, 'shattered', 'replay must retain progressive glass state');
expect(Math.abs(interpolated.wheelState[0].position[1] - 0.45) < 1e-4, 'replay must interpolate ordered wheel transforms');
equal(interpolated.wheelState[0].visible, false, 'replay must retain detached wheel visibility');
recorder.recordEvent({ type: 'damage', time: 0.2, subjectId: 'player' });
recorder.recordEvent({ type: 'impact', time: 0.4, subjectId: 'player' });
const stateClip = recorder.createClip(0.35, 0.5);
equal(stateClip.events.length, 1, 'shot events must remain clipped to the replay window');
equal(stateClip.stateEvents.length, 2, 'presentation events before the replay window must be retained for exact state restoration');
expect(recorder.memoryBytes() > 0 && recorder.memoryBytes() < 100000, 'small replay buffer must use bounded typed-array memory');

const replayEvents = [
  { type: 'impact', time: 2, value: 1000, subjectId: 'sedan', point: { x: 0, y: 1, z: 0 } },
  { type: 'explosion', time: 5, value: 8000, subjectId: 'tanker', point: { x: 4, y: 1, z: 1 } },
  { type: 'new-participant', time: 6.2, value: 850, subjectId: 'bus', point: { x: 2, y: 1, z: 0 } },
];
equal(rankReplayHighlights(replayEvents)[0].type, 'explosion', 'highlight ranking must prefer the major secondary event');
equal(selectLargestReplayImpact(replayEvents)?.type, 'impact', 'replay must separately identify the largest physical impact');
const replayWindow = replayWindowForHighlights(replayEvents, { start: 0, end: 13 });
equal(replayWindow.highlight.type, 'impact', 'replay window must anchor itself on the largest physical impact');
expect(replayWindow.duration >= 8 && replayWindow.duration <= 12, 'director must select an 8-12 second replay window');
const plan = buildReplayShotPlan(replayEvents, replayWindow);
expect(plan.length >= 4, 'director must build motivated multi-shot coverage');
expect(plan.some((shot) => shot.highlight && shot.speed <= 0.25), 'largest impact must receive slow-motion coverage');
expect(replayShotAt(plan, plan[0].start)?.family === 'rear_chase', 'replay must establish the approach');
expect(plan.every((shot, index) => index === 0 || Math.abs(shot.start - plan[index - 1].end) < 1e-9), 'replay shots must be sequential without overlaps or gaps');
expect(scoreReplayCameraCandidate({ family: 'roadside', lineOfSight: 1, coverage: 0.8, twoSubjectFraming: 1 }) > scoreReplayCameraCandidate({ family: 'roadside', lineOfSight: 0.2, obstruction: 1 }), 'shot scoring must reject obstruction');
const reducedPlan = buildReplayShotPlan(replayEvents, replayWindow, { reduceMotion: true });
expect(reducedPlan.every((shot) => shot.speed >= 0.5), 'Reduce Motion must remove aggressive replay slow motion');
expect(reducedPlan.every((shot) => !['target_pov', 'wreck_orbit'].includes(shot.family)), 'Reduce Motion must choose gentler replay camera families');
const shortLatePlan = buildReplayShotPlan([{ type: 'impact', time: 1.8, force: 900000, subjectId: 'bus', point: { x: 0, y: 1, z: 0 } }], { start: 0, end: 2.85 });
expect(shortLatePlan.some((shot) => shot.family === 'overhead'), 'a short late-impact replay must still reserve a readable overhead shot');
expect(shortLatePlan.some((shot) => shot.family === 'wreck_orbit'), 'a short late-impact replay must still end on wreckage');

const values = new Map();
const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
equal(readCrashRecord(storage).score, 0, 'empty record storage must be safe');
expect(writeCrashRecord({ score: 45000, vehicleId: 'iron', vehicles: 18 }, storage).isPersonalBest, 'higher score must become a personal best');
equal(writeCrashRecord({ score: 12000, vehicleId: 'pocket' }, storage).record.score, 45000, 'lower score must not replace the record');

equal(CRASH_QUALITY.low.maxDynamicBodies, 24, 'low quality body cap must remain explicit');
equal(CRASH_QUALITY.medium.maxDynamicBodies, 38, 'medium quality body cap must remain explicit');
equal(CRASH_QUALITY.high.maxDynamicBodies, 54, 'high quality body cap must remain explicit');

console.log(`Kaki Catastrophe systems smoke passed: ${assertions} assertions, ${scheduleA.length} deterministic arrivals.`);
