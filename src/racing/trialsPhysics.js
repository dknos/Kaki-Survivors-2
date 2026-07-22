/**
 * Deterministic, renderer-free 2D handling and scoring for Kaki Trials.
 * `stepTrials` mutates one run state and returns presentation events for only
 * that call. It internally uses <= 1/240 s substeps, so 30/60/120 Hz callers
 * converge on the same handling.
 */
import {
  getTrialsCheckpoint,
  getTrialsTrack,
  sampleTrialsGround,
} from './trialsTracks.js';

export { sampleTrialsGround } from './trialsTracks.js';

const TAU = Math.PI * 2;
const MAX_SUBSTEP = 1 / 240;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle) {
  let wrapped = (angle + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Both vehicles intentionally consume the exact same control contract. */
export const TRIALS_CONTROL_SCHEMA = Object.freeze({
  throttle: 'number[-1..1]',
  brake: 'number[0..1]',
  lean: 'number[-1..1]',
  turbo: 'boolean',
});

export const TRIALS_VEHICLE_PROFILES = deepFreeze({
  monster: {
    id: 'monster', name: 'Mighty Meowster', kind: 'monster-truck', controls: TRIALS_CONTROL_SCHEMA,
    mass: 2.7, crushPower: 1.65, rideHeight: 1.72, suspensionTravel: 0.72,
    suspensionSpring: 54, suspensionDamping: 10.8, landingImpulse: 0.035,
    acceleration: 15.8, reverseAcceleration: 8, brakePower: 25, coastDrag: 0.34,
    maxSpeed: 25.5, reverseSpeed: 7, turboAcceleration: 13.5, turboMaxSpeed: 31,
    gravity: 23, groundSnap: 0.32, minTakeoffSpeed: 7,
    groundLeanAngle: 0.2, balanceSpring: 17, balanceDamping: 7.4,
    airLeanTorque: 7.2, airPitchDamping: 0.2, airDrag: 0.035,
    turboHeatRate: 0.26, turboCoolRate: 0.15, turboRecoveryHeat: 0.34,
    perfectAngle: 0.25, cleanAngle: 0.68, crashAngle: 1.34,
    perfectImpact: 19, cleanImpact: 30, crashImpact: 45,
  },
  buggy: {
    id: 'buggy', name: 'Pocket Rally Pouncer', kind: 'rally-buggy', controls: TRIALS_CONTROL_SCHEMA,
    mass: 1.05, crushPower: 0.72, rideHeight: 1.02, suspensionTravel: 0.48,
    suspensionSpring: 68, suspensionDamping: 11.8, landingImpulse: 0.026,
    acceleration: 21, reverseAcceleration: 10, brakePower: 29, coastDrag: 0.29,
    maxSpeed: 29, reverseSpeed: 8.5, turboAcceleration: 15.5, turboMaxSpeed: 35,
    gravity: 23, groundSnap: 0.25, minTakeoffSpeed: 6,
    groundLeanAngle: 0.27, balanceSpring: 23, balanceDamping: 7.8,
    airLeanTorque: 11.8, airPitchDamping: 0.14, airDrag: 0.028,
    turboHeatRate: 0.3, turboCoolRate: 0.18, turboRecoveryHeat: 0.3,
    perfectAngle: 0.21, cleanAngle: 0.58, crashAngle: 1.16,
    perfectImpact: 18, cleanImpact: 27, crashImpact: 40,
  },
});

export function getTrialsProfile(profile = 'monster') {
  if (profile && typeof profile === 'object' && Number.isFinite(profile.maxSpeed)) return profile;
  return TRIALS_VEHICLE_PROFILES[profile] || TRIALS_VEHICLE_PROFILES.monster;
}

function spawnValues(track, profile, checkpointIndex) {
  const checkpoint = getTrialsCheckpoint(track, checkpointIndex);
  const ground = sampleTrialsGround(track, checkpoint.x) || sampleTrialsGround(track, track.spawn.x);
  return {
    checkpoint,
    ground,
    x: checkpoint.x,
    y: (ground?.height || 0) + profile.rideHeight,
    pitch: ground?.angle || 0,
  };
}

/** Create a complete mutable run state at spawn or `overrides.checkpointIndex`. */
export function createTrialsState(track = 'meadow', profile = 'monster', overrides = {}) {
  const course = getTrialsTrack(track);
  const vehicle = getTrialsProfile(profile);
  const checkpointIndex = clamp(Math.trunc(overrides.checkpointIndex ?? -1), -1, course.checkpoints.length - 1);
  const spawn = spawnValues(course, vehicle, checkpointIndex);
  const state = {
    trackId: course.id,
    profileId: vehicle.id,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    pitch: spawn.pitch,
    pitchVelocity: 0,
    grounded: true,
    wheelContact: { front: true, rear: true },
    suspensionCompression: 0,
    suspensionVelocity: 0,
    turboHeat: 0,
    turboOverheated: false,
    turboRecovery: 1,
    turboRecoveryTime: 0,
    turboActive: false,
    airborneTime: 0,
    totalAirTime: 0,
    airStartPitch: spawn.pitch,
    airRotation: 0,
    flipsThisAir: 0,
    totalFlips: 0,
    lastLanding: null,
    perfectLandings: 0,
    cleanLandings: 0,
    roughLandings: 0,
    crashes: 0,
    crashed: false,
    crashState: 'none',
    crashReason: null,
    crashTime: 0,
    checkpointIndex,
    checkpointId: spawn.checkpoint.id,
    checkpointX: spawn.checkpoint.x,
    cleanSections: 0,
    sectionFaults: 0,
    destroyedCount: 0,
    styleCounter: 0,
    elapsedTime: 0,
    maxX: spawn.x,
    finished: false,
    finishTime: null,
    restarts: 0,
    ...overrides,
  };
  state.wheelContact = { front: !!state.wheelContact?.front, rear: !!state.wheelContact?.rear };
  return state;
}

/**
 * Reset physical state at the last checkpoint. By default run time and earned
 * style/destruction counters survive, which makes a restart cost time without
 * erasing the fun parts. Pass `{ preserveRun: false }` for a fresh run.
 */
export function resetTrialsState(state, options = {}) {
  if (!state) return null;
  const course = getTrialsTrack(options.track || state.trackId);
  const vehicle = getTrialsProfile(options.profile || state.profileId);
  const checkpointIndex = clamp(
    Math.trunc(options.checkpointIndex ?? state.checkpointIndex ?? -1),
    -1,
    course.checkpoints.length - 1,
  );
  const preserve = options.preserveRun !== false;
  const kept = preserve ? {
    elapsedTime: state.elapsedTime,
    totalAirTime: state.totalAirTime,
    totalFlips: state.totalFlips,
    perfectLandings: state.perfectLandings,
    cleanLandings: state.cleanLandings,
    roughLandings: state.roughLandings,
    crashes: state.crashes,
    cleanSections: state.cleanSections,
    sectionFaults: state.sectionFaults,
    destroyedCount: state.destroyedCount,
    styleCounter: state.styleCounter,
    maxX: Math.max(state.maxX || 0, getTrialsCheckpoint(course, checkpointIndex).x),
    restarts: (state.restarts || 0) + 1,
  } : { restarts: 0 };
  const fresh = createTrialsState(course, vehicle, { checkpointIndex, ...kept });
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, fresh);
  return state;
}

function createEvents() {
  return {
    turboStart: false, turboOverheat: false, turboCool: false,
    turboStarted: false, turboOverheated: false, turboCooled: false,
    takeoff: false, jumped: false,
    landing: null, landed: false, landingQuality: null, landingSpeed: 0, airTime: 0,
    flips: 0, flipCount: 0,
    crash: false, crashed: false, crashReason: null,
    checkpoint: null, checkpoints: [], cleanSection: false,
    finish: false, finished: false,
  };
}

function normalizedControls(controls) {
  const throttle = clamp(Number(controls?.throttle) || 0, -1, 1);
  return {
    throttle,
    // Reverse and braking are distinct inputs. Callers can map one physical
    // brake key contextually, but folding negative throttle into brake here
    // makes the two forces cancel and prevents the vehicle from reversing.
    brake: clamp(Number(controls?.brake) || 0, 0, 1),
    lean: clamp(Number(controls?.lean) || 0, -1, 1),
    turbo: !!controls?.turbo,
  };
}

function stepTurbo(state, controls, profile, dt, events) {
  const wasActive = state.turboActive;
  const wasOverheated = state.turboOverheated;
  state.turboActive = controls.turbo && controls.throttle > 0.05 && !state.turboOverheated && !state.crashed;
  if (state.turboActive) {
    state.turboHeat = clamp(state.turboHeat + profile.turboHeatRate * dt, 0, 1);
    state.turboRecoveryTime = 0;
    if (!wasActive) events.turboStart = events.turboStarted = true;
    if (state.turboHeat >= 1 - 1e-9) {
      state.turboHeat = 1;
      state.turboOverheated = true;
      state.turboActive = false;
      events.turboOverheat = events.turboOverheated = true;
    }
  } else {
    state.turboHeat = clamp(state.turboHeat - profile.turboCoolRate * dt, 0, 1);
    if (state.turboOverheated) {
      state.turboRecoveryTime += dt;
      if (state.turboHeat <= profile.turboRecoveryHeat) {
        state.turboOverheated = false;
        state.turboRecoveryTime = 0;
        events.turboCool = events.turboCooled = true;
      }
    }
  }
  state.turboRecovery = state.turboOverheated
    ? clamp((1 - state.turboHeat) / Math.max(0.01, 1 - profile.turboRecoveryHeat), 0, 1)
    : 1;
  if (wasOverheated && !state.turboOverheated) state.turboActive = false;
}

function beginAir(state, events) {
  if (!state.grounded) return;
  state.grounded = false;
  state.wheelContact.front = false;
  state.wheelContact.rear = false;
  state.airborneTime = 0;
  state.airStartPitch = state.pitch;
  state.airRotation = 0;
  state.flipsThisAir = 0;
  events.takeoff = events.jumped = true;
}

function markCrash(state, reason, events) {
  if (state.crashed) return;
  state.crashed = true;
  state.crashState = reason === 'gap' ? 'fallen' : 'tumbled';
  state.crashReason = reason;
  state.crashTime = 0;
  state.crashes += 1;
  state.sectionFaults += 1;
  state.turboActive = false;
  state.wheelContact.front = false;
  state.wheelContact.rear = false;
  events.crash = events.crashed = true;
  events.crashReason = reason;
}

function land(state, ground, profile, events) {
  const sin = Math.sin(ground.angle);
  const cos = Math.cos(ground.angle);
  const tangentSpeed = state.vx * cos + state.vy * sin;
  const impactSpeed = Math.max(0, -(state.vx * -sin + state.vy * cos));
  const angleError = Math.abs(normalizeAngle(state.pitch - ground.angle));
  let quality = 'crash';
  if (angleError <= profile.perfectAngle && impactSpeed <= profile.perfectImpact) quality = 'perfect';
  else if (angleError <= profile.cleanAngle && impactSpeed <= profile.cleanImpact) quality = 'clean';
  else if (angleError <= profile.crashAngle && impactSpeed <= profile.crashImpact) quality = 'rough';

  events.landing = events.landingQuality = quality;
  events.landed = true;
  events.landingSpeed = impactSpeed;
  events.airTime = state.airborneTime;
  events.flipCount = state.flipsThisAir;
  state.lastLanding = quality;
  state.grounded = quality !== 'crash';
  state.y = ground.height + profile.rideHeight;
  if (quality === 'perfect') state.perfectLandings += 1;
  else if (quality === 'clean') state.cleanLandings += 1;
  else if (quality === 'rough') { state.roughLandings += 1; state.sectionFaults += 1; }

  if (quality === 'crash') {
    state.vx = tangentSpeed * cos * 0.28;
    state.vy = Math.max(1.8, impactSpeed * 0.1);
    state.pitchVelocity *= -0.2;
    markCrash(state, 'landing', events);
    return;
  }
  const retention = quality === 'perfect' ? 1.01 : quality === 'clean' ? 0.95 : 0.7;
  const speed = clamp(tangentSpeed * retention, -profile.reverseSpeed, profile.turboMaxSpeed);
  state.vx = speed * cos;
  state.vy = speed * sin;
  state.suspensionCompression = clamp(impactSpeed * profile.landingImpulse, 0, profile.suspensionTravel);
  state.suspensionVelocity = clamp(impactSpeed * 0.2, 0, 7);
  state.wheelContact.front = angleError < profile.cleanAngle;
  state.wheelContact.rear = angleError < profile.cleanAngle;
  state.airborneTime = 0;
  state.airRotation = 0;
  state.flipsThisAir = 0;
}

function stepGrounded(state, controls, track, profile, dt, events) {
  const ground = sampleTrialsGround(track, state.x);
  if (!ground) {
    beginAir(state, events);
    return stepAirborne(state, controls, track, profile, dt, events);
  }
  const sin = Math.sin(ground.angle);
  const cos = Math.cos(ground.angle);
  let speed = state.vx * cos + state.vy * sin;
  let acceleration = -profile.gravity * sin;
  if (controls.throttle > 0) {
    const cap = state.turboActive ? profile.turboMaxSpeed : profile.maxSpeed;
    acceleration += controls.throttle * profile.acceleration * clamp(1 - Math.max(0, speed) / (cap * 1.18), 0.18, 1);
  } else if (controls.throttle < 0 && speed < 0.8) {
    acceleration += controls.throttle * profile.reverseAcceleration;
  }
  if (controls.brake > 0 && Math.abs(speed) > 0.05) acceleration -= Math.sign(speed) * profile.brakePower * controls.brake;
  if (state.turboActive) acceleration += profile.turboAcceleration;
  speed += acceleration * dt;
  speed *= Math.exp(-profile.coastDrag * (Math.abs(controls.throttle) < 0.05 ? 1.55 : 0.55) * dt);
  const speedCap = state.turboActive ? profile.turboMaxSpeed : profile.maxSpeed;
  speed = clamp(speed, -profile.reverseSpeed, speedCap);

  const continuousTarget = state.pitch + normalizeAngle(
    ground.angle + controls.lean * profile.groundLeanAngle - acceleration * 0.003 - state.pitch,
  );
  state.pitchVelocity += ((continuousTarget - state.pitch) * profile.balanceSpring
    - state.pitchVelocity * profile.balanceDamping) * dt;
  state.pitch += state.pitchVelocity * dt;
  state.suspensionVelocity += (-state.suspensionCompression * profile.suspensionSpring
    - state.suspensionVelocity * profile.suspensionDamping) * dt;
  state.suspensionCompression = clamp(
    state.suspensionCompression + state.suspensionVelocity * dt,
    -profile.suspensionTravel * 0.28,
    profile.suspensionTravel,
  );

  state.vx = speed * cos;
  state.vy = speed * sin - state.suspensionVelocity;
  const nextX = state.x + state.vx * dt;
  const predictedY = state.y + state.vy * dt - profile.gravity * dt * dt * 0.5;
  const nextGround = sampleTrialsGround(track, nextX);
  if (!nextGround || (speed > profile.minTakeoffSpeed
    && predictedY - (nextGround.height + profile.rideHeight) > profile.groundSnap)) {
    beginAir(state, events);
    state.x = nextX;
    state.y = predictedY;
    state.vy -= profile.gravity * dt;
    return;
  }
  state.x = nextX;
  state.y = nextGround.height + profile.rideHeight - state.suspensionCompression;
  const nextCos = Math.cos(nextGround.angle);
  const nextSin = Math.sin(nextGround.angle);
  state.vx = speed * nextCos;
  state.vy = speed * nextSin - state.suspensionVelocity;
  const contactError = normalizeAngle(state.pitch - nextGround.angle);
  state.wheelContact.front = contactError < 0.58;
  state.wheelContact.rear = contactError > -0.58;
}

function stepAirborne(state, controls, track, profile, dt, events) {
  const previousPitch = state.pitch;
  state.pitchVelocity += controls.lean * profile.airLeanTorque * dt;
  state.pitchVelocity *= Math.exp(-profile.airPitchDamping * dt);
  state.pitch += state.pitchVelocity * dt;
  state.airRotation += state.pitch - previousPitch;
  const completedFlips = Math.floor((Math.abs(state.airRotation) + 0.08) / TAU);
  if (completedFlips > state.flipsThisAir) {
    const gained = completedFlips - state.flipsThisAir;
    state.flipsThisAir = completedFlips;
    state.totalFlips += gained;
    events.flips += gained;
    events.flipCount = state.flipsThisAir;
  }
  state.airborneTime += dt;
  state.totalAirTime += dt;
  state.vx *= Math.exp(-profile.airDrag * dt);
  state.vy -= profile.gravity * dt;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  const ground = sampleTrialsGround(track, state.x);
  if (ground) {
    const targetY = ground.height + profile.rideHeight;
    const surfaceVelocityY = state.vx * ground.slope;
    if (state.y <= targetY && state.vy <= surfaceVelocityY + 1.5) land(state, ground, profile, events);
  }
  const rescueHeight = Math.min(...track.heightPoints.map((point) => point.y)) - 18;
  if (!state.crashed && state.y < rescueHeight) markCrash(state, 'gap', events);
}

function stepCrashed(state, track, profile, dt) {
  state.crashTime += dt;
  state.vx *= Math.exp(-1.8 * dt);
  state.vy -= profile.gravity * dt;
  state.pitchVelocity *= Math.exp(-0.55 * dt);
  state.pitch += state.pitchVelocity * dt;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  const ground = sampleTrialsGround(track, state.x);
  if (ground && state.y <= ground.height + profile.rideHeight) {
    state.y = ground.height + profile.rideHeight;
    state.vy = 0;
    state.vx *= Math.exp(-7 * dt);
  }
}

function updateCourseProgress(state, previousX, track, events) {
  state.maxX = Math.max(state.maxX || state.x, state.x);
  while (state.checkpointIndex + 1 < track.checkpoints.length) {
    const next = track.checkpoints[state.checkpointIndex + 1];
    if (!(previousX < next.x && state.x >= next.x)) break;
    const clean = state.sectionFaults === 0;
    state.checkpointIndex += 1;
    state.checkpointId = next.id;
    state.checkpointX = next.x;
    if (clean) state.cleanSections += 1;
    state.sectionFaults = 0;
    const checkpointEvent = { ...next, index: state.checkpointIndex, clean };
    events.checkpoint = checkpointEvent;
    events.checkpoints.push(checkpointEvent);
    events.cleanSection ||= clean;
  }
  if (!state.finished && previousX < track.finish && state.x >= track.finish) {
    state.finished = true;
    state.finishTime = state.elapsedTime;
    state.turboActive = false;
    events.finish = events.finished = true;
  }
}

/** Advance one run and return one-call events; `dt` is seconds. */
export function stepTrials(state, controls = {}, dt = 1 / 60, track = state?.trackId, profile = state?.profileId) {
  const events = createEvents();
  if (!state || !(dt > 0) || state.finished) return events;
  const course = getTrialsTrack(track);
  const vehicle = getTrialsProfile(profile);
  const input = normalizedControls(controls);
  const safeDt = Math.min(Number(dt) || 0, 0.5);
  const steps = Math.max(1, Math.ceil(safeDt / MAX_SUBSTEP));
  const subDt = safeDt / steps;
  for (let i = 0; i < steps; i++) {
    const previousX = state.x;
    state.elapsedTime += subDt;
    stepTurbo(state, input, vehicle, subDt, events);
    if (state.crashed) stepCrashed(state, course, vehicle, subDt);
    else if (state.grounded) stepGrounded(state, input, course, vehicle, subDt, events);
    else stepAirborne(state, input, course, vehicle, subDt, events);
    updateCourseProgress(state, previousX, course, events);
    if (state.finished) break;
  }
  return events;
}

const OBSTACLE_RULES = deepFreeze({
  'hay-bale': { resistance: 4.2, points: 100, combo: 0.25, label: 'HAY-CHA!' },
  'wood-crate': { resistance: 5, points: 150, combo: 0.35, label: 'CRATE ESCAPE' },
  'candy-crate': { resistance: 5, points: 175, combo: 0.35, label: 'SUGAR SPLASH' },
  'toy-car': { resistance: 7.5, points: 260, combo: 0.55, label: 'TINY CAR CRUSH' },
  'barrel-stack': { resistance: 8.5, points: 300, combo: 0.6, label: 'BARREL PURRST' },
  'ore-cart': { resistance: 12, points: 430, combo: 0.75, label: 'CARTWHEEL' },
  'rock-stack': { resistance: 15, points: 520, combo: 0.9, label: 'ROCK-A-BYE' },
  'crown-stack': { resistance: 13, points: 650, combo: 1, label: 'CROWN DOWN' },
});

export const TRIALS_OBSTACLE_RULES = OBSTACLE_RULES;

export function createTrialsScoreState(overrides = {}) {
  return {
    score: 0,
    styleScore: 0,
    combo: 1,
    comboTime: 0,
    bestCombo: 1,
    flips: 0,
    totalAirTime: 0,
    perfectLandings: 0,
    cleanLandings: 0,
    destruction: 0,
    checkpoints: 0,
    cleanSections: 0,
    rawTime: 0,
    lastEvent: '',
    lastPoints: 0,
    destroyedObstacleIds: [],
    ...overrides,
  };
}

function awardStyle(score, basePoints, label, comboGain = 0.4) {
  if (!score || !(basePoints > 0)) return 0;
  score.combo = score.comboTime > 0 ? clamp(score.combo + comboGain, 1, 8) : 1;
  score.bestCombo = Math.max(score.bestCombo, score.combo);
  const points = Math.round(basePoints * score.combo);
  score.score += points;
  score.styleScore += points;
  score.comboTime = 4;
  score.lastEvent = label;
  score.lastPoints = points;
  return points;
}

/** Consume one `stepTrials` event packet and update the style run. */
export function stepTrialsScore(score, state, events = {}, dt = 1 / 60) {
  if (!score || !state) return 0;
  score.comboTime = Math.max(0, score.comboTime - Math.max(0, Number(dt) || 0));
  if (score.comboTime <= 0) score.combo = 1;
  score.rawTime = Number.isFinite(state.finishTime) ? state.finishTime : state.elapsedTime;
  let earned = 0;
  for (let i = 0; i < (events.flips || 0); i++) {
    score.flips += 1;
    earned += awardStyle(score, 520 + score.flips * 25, score.flips > 1 ? 'FLIP CHAIN' : 'FULL FLIP', 0.75);
  }
  if (events.landed) {
    score.totalAirTime += events.airTime || 0;
    if ((events.airTime || 0) >= 0.22) earned += awardStyle(score, (events.airTime || 0) * 115, 'BIG AIR', 0.25);
    if (events.landingQuality === 'perfect') {
      score.perfectLandings += 1;
      earned += awardStyle(score, 360, 'PURRFECT LANDING', 0.65);
    } else if (events.landingQuality === 'clean') {
      score.cleanLandings += 1;
      earned += awardStyle(score, 170, 'CLEAN PAWS', 0.35);
    } else if (events.landingQuality === 'rough') {
      score.combo = 1;
      score.comboTime = 0;
    }
  }
  for (const checkpoint of events.checkpoints || (events.checkpoint ? [events.checkpoint] : [])) {
    score.checkpoints += 1;
    earned += awardStyle(score, 120, 'CHECKPOINT', 0.2);
    if (checkpoint.clean) {
      score.cleanSections += 1;
      earned += awardStyle(score, 320, 'CLEAN SECTION', 0.55);
    }
  }
  if (events.crash) {
    score.combo = 1;
    score.comboTime = 0;
    score.lastEvent = 'TUMBLE!';
    score.lastPoints = 0;
  }
  state.styleCounter = score.styleScore;
  return earned;
}

/**
 * Score a swept obstacle hit. The returned object tells the runtime whether to
 * hide/crush the prop; immutable authored obstacle data is never modified.
 */
export function awardTrialsDestruction(score, state, obstacle, impactSpeed, profile = state?.profileId) {
  const vehicle = getTrialsProfile(profile);
  const rule = OBSTACLE_RULES[obstacle?.kind] || OBSTACLE_RULES['wood-crate'];
  const speed = Math.max(0, Number(impactSpeed) || 0);
  const effectiveImpact = speed * vehicle.crushPower * (0.78 + vehicle.mass * 0.19);
  const id = obstacle?.id || `${obstacle?.kind || 'prop'}@${obstacle?.x || 0}`;
  if (!score || !state || score.destroyedObstacleIds.includes(id) || effectiveImpact < rule.resistance) {
    return { destroyed: false, points: 0, effectiveImpact, requiredImpact: rule.resistance, kind: obstacle?.kind || 'wood-crate' };
  }
  score.destroyedObstacleIds.push(id);
  score.destruction += 1;
  state.destroyedCount += 1;
  const forceBonus = Math.min(rule.points, Math.max(0, effectiveImpact - rule.resistance) * 18);
  const points = awardStyle(score, rule.points + forceBonus, rule.label, rule.combo);
  state.styleCounter = score.styleScore;
  return { destroyed: true, points, effectiveImpact, requiredImpact: rule.resistance, kind: obstacle.kind, label: rule.label };
}

export function rankTrialsMedal(track, effectiveTime) {
  const medals = getTrialsTrack(track).medals;
  const time = Math.max(0, Number(effectiveTime) || 0);
  if (time <= medals.S) return 'S';
  if (time <= medals.A) return 'A';
  if (time <= medals.B) return 'B';
  return null;
}

/** Convert style into a capped time credit while retaining the raw clock. */
export function createTrialsResult(track, scoreOrRawTime, styleScore = 0) {
  const course = getTrialsTrack(track);
  const rawTime = Math.max(0, typeof scoreOrRawTime === 'object'
    ? Number(scoreOrRawTime.rawTime) || 0
    : Number(scoreOrRawTime) || 0);
  const style = Math.max(0, typeof scoreOrRawTime === 'object'
    ? Number(scoreOrRawTime.styleScore) || 0
    : Number(styleScore) || 0);
  const styleTimeBonus = Math.min(rawTime * 0.28, style / 900);
  const effectiveTime = Math.max(0, rawTime - styleTimeBonus);
  const medal = rankTrialsMedal(course, effectiveTime);
  return {
    trackId: course.id,
    rawTime,
    styleScore: Math.round(style),
    styleTimeBonus,
    effectiveTime,
    medal,
    rank: medal || 'C',
    thresholds: course.medals,
  };
}
