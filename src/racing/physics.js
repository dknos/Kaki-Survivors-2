/**
 * Pure arcade-kart physics used by Kaki Rally.
 *
 * Keeping this module free of DOM/Three.js dependencies makes the handling,
 * lap accounting, and ranking cheap to smoke-test in Node.
 */

export const RACE_TUNING = Object.freeze({
  acceleration: 19.5,
  reverseAcceleration: 10.0,
  brake: 26.0,
  coastDrag: 0.68,
  roadGrip: 9.8,
  offroadGrip: 5.4,
  driftGrip: 2.35,
  airGrip: 0.36,
  gripResponse: 7.5,
  surfaceResponse: 6.0,
  steerRate: 2.15,
  driftSteerRate: 2.75,
  maxSpeed: 24.0,
  reverseSpeed: 8.0,
  offroadSpeed: 11.5,
  boostSpeed: 31.0,
  boostAcceleration: 25.0,
  gravity: 23.0,
  hopVelocity: 7.4,
  rampVelocity: 10.4,
  draftAcceleration: 7.5,
  suspensionSpring: 74,
  suspensionDamping: 11.5,
  airPitchControl: 8.5,
  airRollControl: 10.5,
  cleanLandingAngle: 0.68,
  perfectLandingAngle: 0.22,
  hardLandingAngle: 1.18,
  perfectLandingSpeed: 12.5,
  hardLandingSpeed: 16.5,
  boostHeatRate: 0.18,
  boostCoolingRate: 0.15,
  overheatCoolingRate: 0.27,
  overheatRecovery: 0.38,
});

const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeAngle(angle) {
  let wrapped = (angle + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}

function _expApproach(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

function _finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function createKartState(overrides = {}) {
  return {
    x: 0,
    z: 0,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    yaw: 0,
    angularVelocity: 0,
    speed: 0,
    grounded: true,
    drifting: false,
    driftCharge: 0,
    driftTier: 0,
    driftPerfectWindow: false,
    perfectDriftChain: 0,
    perfectDriftChainTime: 0,
    boostTime: 0,
    boostLevel: 0,
    boostHeat: 0,
    overheated: false,
    rampCooldown: 0,
    padCooldown: 0,
    rescueTime: 0,
    nearestIndex: 0,
    unwrappedIndex: 0,
    completedLaps: 0,
    finished: false,
    finishTime: null,
    integrity: 100,
    engineDamage: 0,
    steeringDamage: 0,
    bodyDamage: { front: 0, rear: 0, left: 0, right: 0 },
    lastImpact: 0,
    lateralSpeed: 0,
    slipAngle: 0,
    draftStrength: 0,
    repairTime: 0,
    wrecked: false,
    wreckTime: 0,
    pitLocked: false,
    collisionCooldown: 0,
    impactRecovery: 0,
    impactStrength: 0,
    pendingImpactStrength: 0,
    surfaceGrip: 1,
    surfaceDrag: 0,
    longitudinalWeightTransfer: 0,
    lateralWeightTransfer: 0,
    bodyPitch: 0,
    bodyRoll: 0,
    airPitch: 0,
    airPitchVelocity: 0,
    airRoll: 0,
    airRollVelocity: 0,
    airTime: 0,
    airControlDelay: 0,
    airborneGrace: 0,
    takeoffPitch: 0,
    lastAirTime: 0,
    suspensionOffset: 0,
    suspensionCompression: 0,
    suspensionVelocity: 0,
    landingImpulse: 0,
    landingCooldown: 0,
    landingType: '',
    bottomedOut: false,
    groundHeight: 0,
    groundPitch: 0,
    groundRoll: 0,
    ...overrides,
  };
}

/** Convert closing speed into a forgiving but consequential arcade impact. */
export function impactDamage(impactSpeed) {
  const speed = Math.max(0, Number(impactSpeed) || 0);
  if (speed <= 5.5) return 0;
  return clamp(Math.pow(speed - 5.5, 1.22) * 1.15, 0, 42);
}

/** Apply zoned body and mechanical damage. Direction is local-space hit origin. */
export function applyKartDamage(kart, amount, direction = 'front') {
  const damage = clamp(Number(amount) || 0, 0, 100);
  if (!damage || !kart) return 0;
  kart.integrity = clamp((Number(kart.integrity) || 0) - damage, 0, 100);
  const zone = ['front', 'rear', 'left', 'right'].includes(direction) ? direction : 'front';
  if (!kart.bodyDamage) kart.bodyDamage = { front: 0, rear: 0, left: 0, right: 0 };
  kart.bodyDamage[zone] = clamp((kart.bodyDamage[zone] || 0) + damage / 65, 0, 1);
  if (zone === 'front' || zone === 'rear') {
    kart.engineDamage = clamp((kart.engineDamage || 0) + damage * (zone === 'front' ? 0.007 : 0.004), 0, 0.72);
  } else {
    const sign = zone === 'left' ? -1 : 1;
    kart.steeringDamage = clamp((kart.steeringDamage || 0) + sign * damage * 0.006, -0.48, 0.48);
  }
  kart.lastImpact = damage;
  const strength = clamp(damage / 42, 0, 1);
  kart.impactStrength = Math.max(Number(kart.impactStrength) || 0, strength);
  kart.pendingImpactStrength = Math.max(Number(kart.pendingImpactStrength) || 0, strength);
  kart.impactRecovery = Math.max(Number(kart.impactRecovery) || 0, 0.28 + strength * 0.52);
  kart.wrecked = kart.integrity <= 0.01;
  return damage;
}

export function repairKart(kart, amount) {
  if (!kart) return 0;
  const before = Number(kart.integrity) || 0;
  const repaired = Math.min(Math.max(0, Number(amount) || 0), 100 - before);
  if (!repaired) return 0;
  kart.integrity = before + repaired;
  const ratio = repaired / 100;
  kart.engineDamage = Math.max(0, (kart.engineDamage || 0) - ratio * 0.9);
  kart.steeringDamage *= Math.max(0, 1 - ratio * 1.6);
  for (const zone of ['front', 'rear', 'left', 'right']) {
    if (kart.bodyDamage) kart.bodyDamage[zone] = Math.max(0, (kart.bodyDamage[zone] || 0) - ratio * 1.45);
  }
  kart.wrecked = false;
  return repaired;
}

/** Scored drifting rewards speed, slip and sustained combos, not steering wiggles. */
export function driftScoreStep(kart, dt, comboMultiplier = 1) {
  if (!kart?.drifting || !(dt > 0) || kart.speed < 7.5) return 0;
  const slip = clamp(Math.abs(kart.lateralSpeed || 0) / 8, 0, 1);
  if (slip < 0.08) return 0;
  return dt * kart.speed * (18 + slip * 42) * clamp(comboMultiplier, 1, 8);
}

/**
 * Advance one kart. controls: throttle [-1..1], steer [-1..1], drift, hop,
 * optional airPitch/lean. contact: onRoad, ramp, boostPad, surfaceGrip and
 * surfaceDrag. Returns one-frame presentation events.
 */
export function stepKart(kart, controls = {}, contact = {}, dt, tuning = RACE_TUNING) {
  const events = {
    boostStarted: false,
    boostLevel: 0,
    boostHeat: clamp(Number(kart?.boostHeat) || 0, 0, 1),
    overheated: false,
    cooled: false,
    jumped: false,
    landed: false,
    landingSpeed: 0,
    landingQuality: 0,
    landingGrade: '',
    perfectLanding: false,
    cleanLanding: false,
    hardLanding: false,
    bottomedOut: false,
    landingType: '',
    airTime: Number(kart?.airTime) || 0,
    driftStrength: 0,
    driftTier: 0,
    driftPerfectWindow: false,
    perfectDrift: false,
    perfectDriftChain: 0,
    driftOvercooked: false,
    impactStrength: Number(kart?.pendingImpactStrength) || 0,
  };
  if (!(dt > 0) || !kart) return events;

  let groundHeight = _finiteOr(contact.groundHeight, _finiteOr(kart.groundHeight, 0));
  kart.groundHeight = groundHeight;
  kart.groundPitch = _finiteOr(contact.groundPitch, _finiteOr(kart.groundPitch, 0));
  kart.groundRoll = _finiteOr(contact.groundRoll, _finiteOr(kart.groundRoll, 0));
  if (contact.groundNormal) kart.groundNormal = contact.groundNormal;

  kart.pendingImpactStrength = 0;
  kart.impactStrength = Math.max(events.impactStrength, Number(kart.impactStrength) || 0) * Math.exp(-3.8 * dt);
  kart.impactRecovery = Math.max(0, (Number(kart.impactRecovery) || 0) - dt);
  kart.landingImpulse = (Number(kart.landingImpulse) || 0) * Math.exp(-5.2 * dt);

  if (kart.wrecked) {
    kart.vx *= Math.exp(-5 * dt);
    kart.vz *= Math.exp(-5 * dt);
    kart.speed = Math.hypot(kart.vx, kart.vz);
    kart.yaw = normalizeAngle(kart.yaw + (kart.angularVelocity || 0) * dt);
    kart.angularVelocity *= Math.exp(-3.8 * dt);
    kart.x += kart.vx * dt;
    kart.z += kart.vz * dt;
    return events;
  }

  const throttle = clamp(Number(controls.throttle) || 0, -1, 1);
  const steer = clamp((Number(controls.steer) || 0) + (kart.steeringDamage || 0) * 0.24, -1, 1);
  const onRoad = contact.onRoad !== false;
  const gripTarget = clamp(_finiteOr(contact.surfaceGrip, onRoad ? 1 : 0.58), 0.15, 1.45);
  const dragTarget = clamp(_finiteOr(contact.surfaceDrag, onRoad ? 0 : 2.45), 0, 5);
  kart.surfaceGrip = _expApproach(_finiteOr(kart.surfaceGrip, gripTarget), gripTarget, tuning.surfaceResponse || 6, dt);
  kart.surfaceDrag = _expApproach(_finiteOr(kart.surfaceDrag, dragTarget), dragTarget, tuning.surfaceResponse || 6, dt);
  kart.rampCooldown = Math.max(0, (kart.rampCooldown || 0) - dt);
  kart.airControlDelay = Math.max(0, (kart.airControlDelay || 0) - dt);
  kart.airborneGrace = Math.max(0, (kart.airborneGrace || 0) - dt);
  kart.padCooldown = Math.max(0, (kart.padCooldown || 0) - dt);
  kart.landingCooldown = Math.max(0, (kart.landingCooldown || 0) - dt);
  kart.collisionCooldown = Math.max(0, (kart.collisionCooldown || 0) - dt);
  kart.perfectDriftChainTime = Math.max(0, (kart.perfectDriftChainTime || 0) - dt);
  if (kart.perfectDriftChainTime <= 0 && !kart.drifting) kart.perfectDriftChain = 0;
  kart.boostHeat = clamp(Number(kart.boostHeat) || 0, 0, 1);
  kart.overheated = !!kart.overheated;
  if (kart.overheated) {
    kart.boostTime = 0;
    kart.boostLevel = 0;
  } else {
    kart.boostTime = Math.max(0, (kart.boostTime || 0) - dt);
    if (kart.boostTime <= 0) kart.boostLevel = 0;
  }

  let forwardX = Math.sin(kart.yaw);
  let forwardZ = Math.cos(kart.yaw);
  let rightX = Math.cos(kart.yaw);
  let rightZ = -Math.sin(kart.yaw);
  let forwardSpeed = kart.vx * forwardX + kart.vz * forwardZ;
  let lateralSpeed = kart.vx * rightX + kart.vz * rightZ;
  const startingForwardSpeed = forwardSpeed;
  kart.lateralSpeed = lateralSpeed;
  kart.slipAngle = Math.atan2(lateralSpeed, Math.max(0.1, Math.abs(forwardSpeed)));

  const handbrake = !!controls.handbrake;
  const wantsDrift = !!controls.drift && onRoad && kart.grounded
    && Math.abs(forwardSpeed) > (handbrake ? 4.5 : 7)
    && Math.abs(steer) > (handbrake ? 0.08 : 0.12);
  const releasedDrift = !!kart.drifting && !wantsDrift;
  kart.drifting = wantsDrift;
  let driftReleasePenalty = 1;

  if (wantsDrift) {
    kart.driftCharge = clamp((kart.driftCharge || 0)
      + dt * (0.52 + Math.abs(steer) * 0.86 + Math.abs(lateralSpeed) * 0.035), 0, 2.6);
    kart.driftTier = kart.driftCharge >= 1.52 ? 3 : kart.driftCharge >= 0.88 ? 2 : kart.driftCharge >= 0.38 ? 1 : 0;
    kart.driftPerfectWindow = kart.driftCharge >= 1.52 && kart.driftCharge <= 1.98;
    events.driftStrength = clamp(kart.driftCharge / 1.98, 0, 1);
    events.driftTier = kart.driftTier;
    events.driftPerfectWindow = kart.driftPerfectWindow;
  } else if (releasedDrift) {
    const charge = Number(kart.driftCharge) || 0;
    const overcooked = charge > 2.28;
    const perfect = charge >= 1.52 && charge <= 1.98;
    let level = charge >= 1.52 ? 3 : charge >= 0.88 ? 2 : charge >= 0.38 ? 1 : 0;
    let duration = level === 3 ? 1.28 : level === 2 ? 0.98 : level === 1 ? 0.62 : 0;
    if (overcooked) {
      level = 0;
      duration = 0;
      driftReleasePenalty = 0.9;
      kart.boostHeat = clamp(kart.boostHeat + 0.14, 0, 1);
      kart.perfectDriftChain = 0;
      kart.perfectDriftChainTime = 0;
      events.driftOvercooked = true;
    } else if (perfect) {
      kart.perfectDriftChain = kart.perfectDriftChainTime > 0 ? (kart.perfectDriftChain || 0) + 1 : 1;
      kart.perfectDriftChainTime = 2.25;
      duration += Math.min(0.36, (kart.perfectDriftChain - 1) * 0.09);
      events.perfectDrift = true;
      events.perfectDriftChain = kart.perfectDriftChain;
    }
    if (duration > 0 && !kart.overheated) {
      kart.boostTime = Math.max(kart.boostTime, duration);
      kart.boostLevel = level;
      kart.boostHeat = clamp(kart.boostHeat + level * 0.018, 0, 1);
      events.boostStarted = true;
      events.boostLevel = level;
    }
    events.driftTier = level;
    kart.driftCharge = 0;
    kart.driftTier = 0;
    kart.driftPerfectWindow = false;
  } else if (!controls.drift) {
    kart.driftCharge = Math.max(0, (kart.driftCharge || 0) - dt * 1.7);
    kart.driftTier = 0;
    kart.driftPerfectWindow = false;
  }

  if (contact.boostPad && kart.padCooldown <= 0 && kart.grounded && !kart.overheated) {
    kart.boostTime = Math.max(kart.boostTime, 1.05);
    kart.boostLevel = Math.max(kart.boostLevel || 0, 2);
    kart.boostHeat = clamp(kart.boostHeat + 0.045, 0, 1);
    kart.padCooldown = 0.9;
    events.boostStarted = true;
    events.boostLevel = 2;
  }

  if (kart.overheated) {
    kart.boostHeat = Math.max(0, kart.boostHeat - (tuning.overheatCoolingRate || 0.27) * dt);
    if (kart.boostHeat <= (tuning.overheatRecovery || 0.38)) {
      kart.overheated = false;
      events.cooled = true;
    }
  } else if (kart.boostTime > 0) {
    const levelHeat = 0.82 + Math.max(1, kart.boostLevel || 1) * 0.09;
    kart.boostHeat = clamp(kart.boostHeat + (tuning.boostHeatRate || 0.18) * levelHeat * dt, 0, 1);
    if (kart.boostHeat >= 1) {
      kart.overheated = true;
      kart.boostTime = 0;
      kart.boostLevel = 0;
      events.overheated = true;
    }
  } else {
    const cooling = (tuning.boostCoolingRate || 0.15) * (Math.abs(throttle) < 0.2 ? 1.35 : 1);
    kart.boostHeat = Math.max(0, kart.boostHeat - cooling * dt);
  }
  events.boostHeat = kart.boostHeat;

  const launchFromRamp = !!contact.ramp && kart.grounded && kart.rampCooldown <= 0
    && forwardSpeed > 6;
  const manualHop = !!controls.hop && kart.grounded;
  let rampMomentum = null;
  if (launchFromRamp || manualHop) {
    kart.grounded = false;
    if (launchFromRamp && contact.preserveRampSpeed && contact.rampDirection) {
      const directionX = _finiteOr(contact.rampDirection.x, 0);
      const directionZ = _finiteOr(contact.rampDirection.z, 1);
      const directionLength = Math.hypot(directionX, directionZ) || 1;
      const nx = directionX / directionLength;
      const nz = directionZ / directionLength;
      const slope = Math.max(0, _finiteOr(contact.takeoffSlope, 0));
      const slopeAngle = Math.atan(slope);
      const along = Math.max(0, kart.vx * nx + kart.vz * nz);
      const rebound = Math.max(0, _finiteOr(contact.suspensionRebound, 0));
      const slopeVelocity = Math.max(
        along * Math.sin(slopeAngle) + rebound,
        _finiteOr(contact.rampVelocity, 0),
      );
      kart.vy = clamp(
        slopeVelocity * _finiteOr(tuning.rampVerticalScale, 1)
          + _finiteOr(tuning.rampLift, 0),
        1.2,
        _finiteOr(tuning.maxRampVelocity, 18),
      );
      // Monster ramps should preserve the run-up. Converting the complete
      // approach vector into a mathematically perfect ballistic vector made
      // the truck visibly bog down at the lip and shortened every jump.
      rampMomentum = {
        x: nx,
        z: nz,
        scale: Math.max(Math.cos(slopeAngle), _finiteOr(tuning.rampHorizontalRetention, 0)),
      };
      const takeoffPitch = -slopeAngle * _finiteOr(tuning.takeoffPitchScale, 1);
      kart.takeoffPitch = takeoffPitch;
      kart.airControlDelay = Math.max(0, _finiteOr(tuning.rampAirControlDelay, 0));
      if (tuning.stuntLanding) {
        kart.stuntPitch = takeoffPitch;
        kart.stuntPitchVelocity = _finiteOr(tuning.takeoffPitchVelocity, -0.08);
      }
    } else {
      kart.vy = launchFromRamp
        ? _finiteOr(contact.rampVelocity, tuning.rampVelocity)
        : tuning.hopVelocity;
    }
    kart.rampCooldown = launchFromRamp ? 1.2 : 0.35;
    kart.airborneGrace = launchFromRamp
      ? Math.max(0.04, _finiteOr(tuning.rampAirborneGrace, 0.08))
      : 0.04;
    kart.airTime = 0;
    kart.airPitch = launchFromRamp && tuning.stuntLanding
      ? _finiteOr(kart.takeoffPitch, 0)
      : _finiteOr(kart.bodyPitch, 0);
    kart.airRoll = _finiteOr(kart.bodyRoll, 0);
    events.jumped = true;
  }

  const speedRatio = clamp(Math.abs(forwardSpeed) / tuning.maxSpeed, 0, 1);
  const movingDirection = forwardSpeed < -0.25 ? -1 : 1;
  const steerPower = (tuning.speedSensitiveSteering
    ? (0.42 + Math.min(speedRatio, 0.42) * 1.12)
      * (1 - Math.max(0, speedRatio - 0.38) * (1 - (tuning.highSpeedSteerScale || 0.68)))
    : (0.28 + speedRatio * 0.92)) * movingDirection;
  const steerRate = wantsDrift ? tuning.driftSteerRate : tuning.steerRate;
  const airSteerScale = kart.grounded ? 1 : 0.34;
  const recoveryStrength = clamp((kart.impactRecovery || 0) / 0.8, 0, 1);
  kart.angularVelocity = clamp(Number(kart.angularVelocity) || 0, -1.45, 1.45);
  kart.yaw = normalizeAngle(kart.yaw + (steer * steerRate * steerPower * airSteerScale + kart.angularVelocity) * dt);
  kart.angularVelocity *= Math.exp(-(2.7 + recoveryStrength * 4.2) * dt);

  if (throttle > 0) {
    const torqueLift = 1 + Math.max(0, _finiteOr(tuning.lowSpeedTorque, 0)) * (1 - speedRatio) ** 2;
    forwardSpeed += throttle * tuning.acceleration * torqueLift * (1 - (kart.engineDamage || 0) * 0.56) * dt;
  } else if (throttle < 0) {
    if (forwardSpeed > 0) forwardSpeed = Math.max(0, forwardSpeed + throttle * tuning.brake * dt);
    else forwardSpeed = Math.max(-tuning.reverseSpeed, forwardSpeed + throttle * tuning.reverseAcceleration * dt);
  }

  if (kart.boostTime > 0 && !kart.overheated) forwardSpeed += tuning.boostAcceleration * dt;
  if ((contact.draftStrength || 0) > 0 && onRoad) {
    kart.draftStrength = clamp(contact.draftStrength, 0, 1);
    forwardSpeed += tuning.draftAcceleration * kart.draftStrength * dt;
  } else {
    kart.draftStrength = Math.max(0, (kart.draftStrength || 0) - dt * 2.2);
  }

  const baseGrip = wantsDrift
    ? tuning.driftGrip * (handbrake ? 0.68 : 1)
    : (onRoad ? tuning.roadGrip : (tuning.offroadGrip || tuning.roadGrip * 0.58));
  const progressiveGrip = (0.74 + speedRatio * 0.34) * kart.surfaceGrip;
  const grip = kart.grounded
    ? baseGrip * progressiveGrip * (1 + recoveryStrength * 0.42)
    : tuning.airGrip;
  lateralSpeed *= Math.exp(-grip * dt);
  if (wantsDrift) lateralSpeed += steer * Math.abs(forwardSpeed) * (handbrake ? 0.92 : 0.6) * kart.surfaceGrip * dt;

  let topSpeed = onRoad ? tuning.maxSpeed : tuning.offroadSpeed;
  if (kart.boostTime > 0 && !kart.overheated) {
    topSpeed = tuning.boostSpeed + Math.max(0, (kart.boostLevel || 1) - 1) * 1.5;
  }
  topSpeed *= 1 - (kart.engineDamage || 0) * 0.42;
  const drag = tuning.coastDrag + kart.surfaceDrag + (Math.abs(throttle) < 0.05 ? 0.7 : 0);
  forwardSpeed *= Math.exp(-drag * dt);
  if (handbrake && kart.grounded) forwardSpeed *= Math.exp(-1.15 * dt);
  forwardSpeed *= driftReleasePenalty;
  forwardSpeed = clamp(forwardSpeed, -tuning.reverseSpeed, topSpeed);

  const acceleration = (forwardSpeed - startingForwardSpeed) / dt;
  const longitudinalTarget = clamp(-acceleration / 30, -1, 1);
  const lateralTarget = clamp(-steer * speedRatio * (wantsDrift ? 1 : 0.72) - lateralSpeed / 18, -1, 1);
  kart.longitudinalWeightTransfer = _expApproach(
    _finiteOr(kart.longitudinalWeightTransfer, 0), longitudinalTarget, 8.5, dt,
  );
  kart.lateralWeightTransfer = _expApproach(
    _finiteOr(kart.lateralWeightTransfer, 0), lateralTarget, 7.5, dt,
  );

  forwardX = Math.sin(kart.yaw);
  forwardZ = Math.cos(kart.yaw);
  rightX = Math.cos(kart.yaw);
  rightZ = -Math.sin(kart.yaw);
  kart.vx = forwardX * forwardSpeed + rightX * lateralSpeed;
  kart.vz = forwardZ * forwardSpeed + rightZ * lateralSpeed;
  if (rampMomentum) {
    const along = kart.vx * rampMomentum.x + kart.vz * rampMomentum.z;
    const adjusted = along * rampMomentum.scale;
    kart.vx += rampMomentum.x * (adjusted - along);
    kart.vz += rampMomentum.z * (adjusted - along);
  }
  kart.x += kart.vx * dt;
  kart.z += kart.vz * dt;

  if (typeof contact.sampleGround === 'function') {
    const nextGround = contact.sampleGround(kart.x, kart.z);
    if (nextGround) {
      groundHeight = _finiteOr(nextGround.height, groundHeight);
      kart.groundHeight = groundHeight;
      kart.groundPitch = _finiteOr(nextGround.pitch, kart.groundPitch);
      kart.groundRoll = _finiteOr(nextGround.roll, kart.groundRoll);
      if (nextGround.normal) kart.groundNormal = nextGround.normal;
    }
  }

  const suspensionTarget = kart.grounded ? 0 : -0.12;
  const suspensionSpring = kart.grounded ? (tuning.suspensionSpring || 74) : 24;
  const suspensionDamping = kart.grounded ? (tuning.suspensionDamping || 11.5) : 8;
  kart.suspensionOffset = _finiteOr(kart.suspensionOffset, 0);
  kart.suspensionVelocity = _finiteOr(kart.suspensionVelocity, 0);
  kart.suspensionVelocity += (suspensionTarget - kart.suspensionOffset) * suspensionSpring * dt;
  kart.suspensionVelocity *= Math.exp(-suspensionDamping * dt);
  kart.suspensionOffset = clamp(kart.suspensionOffset + kart.suspensionVelocity * dt, -0.18, 1);
  kart.suspensionCompression = clamp(kart.suspensionOffset, 0, 1);

  if (!kart.grounded) {
    kart.airTime = Math.max(0, (Number(kart.airTime) || 0) + dt);
    const explicitPitch = Number.isFinite(controls.airPitch) ? clamp(controls.airPitch, -1, 1) : null;
    const lean = Number.isFinite(controls.lean) ? clamp(controls.lean, -1, 1) : steer;
    const pitchTarget = explicitPitch === null ? -throttle * 0.12 : -explicitPitch * 0.62;
    const rollTarget = -lean * 0.38;
    kart.airPitch = _finiteOr(kart.airPitch, 0);
    kart.airRoll = _finiteOr(kart.airRoll, 0);
    kart.airPitchVelocity = _finiteOr(kart.airPitchVelocity, 0)
      + (pitchTarget - kart.airPitch) * (tuning.airPitchControl || 8.5) * dt;
    kart.airRollVelocity = _finiteOr(kart.airRollVelocity, 0)
      + (rollTarget - kart.airRoll) * (tuning.airRollControl || 10.5) * dt;
    kart.airPitchVelocity *= Math.exp(-4.5 * dt);
    kart.airRollVelocity *= Math.exp(-5.2 * dt);
    kart.airPitch += kart.airPitchVelocity * dt;
    kart.airRoll += kart.airRollVelocity * dt;
    kart.bodyPitch = kart.airPitch;
    kart.bodyRoll = kart.airRoll;
    events.airTime = kart.airTime;
    kart.vy -= tuning.gravity * dt;
    kart.y += kart.vy * dt;
    if (kart.y <= groundHeight && kart.airborneGrace <= 0) {
      const landingSpeed = Math.max(0, -kart.vy);
      const rawPitch = tuning.stuntLanding
        ? Number(kart.stuntPitch) || 0
        : kart.airPitch;
      const rawRoll = tuning.stuntLanding
        ? Number(kart.stuntRoll) || 0
        : kart.airRoll;
      // THREE's positive X rotation points the nose down, while analytical
      // terrain pitch is positive uphill. Monster stunt attitude therefore
      // lands against the sign-inverted terrain pitch.
      const landingPitch = tuning.stuntLanding
        ? -_finiteOr(kart.groundPitch, 0)
        : _finiteOr(kart.groundPitch, 0);
      const pitchError = normalizeAngle(rawPitch - landingPitch);
      const landingRoll = tuning.stuntLanding
        ? -_finiteOr(kart.groundRoll, 0)
        : _finiteOr(kart.groundRoll, 0);
      const rollError = normalizeAngle(rawRoll - landingRoll);
      const pitch = Math.abs(pitchError);
      const roll = Math.abs(rollError);
      const landingAngle = Math.hypot(pitch, roll * 0.8);
      const angleQuality = 1 - clamp(landingAngle / (tuning.hardLandingAngle || 1.18), 0, 1);
      const speedQuality = 1 - clamp(
        (landingSpeed - (tuning.perfectLandingSpeed || 12.5))
          / Math.max(1, (tuning.hardLandingSpeed || 16.5) - (tuning.perfectLandingSpeed || 12.5)),
        0,
        1,
      );
      const quality = clamp(angleQuality * 0.72 + speedQuality * 0.28, 0, 1);
      const perfect = kart.airTime >= 0.28
        && landingAngle <= (tuning.perfectLandingAngle || 0.22)
        && landingSpeed <= (tuning.perfectLandingSpeed || 12.5);
      const clean = perfect || (landingAngle <= (tuning.cleanLandingAngle || 0.68)
        && landingSpeed <= (tuning.hardLandingSpeed || 16.5));
      const hard = landingAngle > (tuning.hardLandingAngle || 1.18)
        || landingSpeed > (tuning.hardLandingSpeed || 16.5);
      const downslope = clamp(-_finiteOr(kart.groundPitch, 0), 0, 0.7);
      const uphill = clamp(_finiteOr(kart.groundPitch, 0), 0, 0.7);
      const baseRetention = perfect ? 1 : clean ? 0.985 : hard ? 0.78 : 0.9;
      const retention = clamp(baseRetention + downslope * 0.13 - uphill * 0.06, 0.68, 1.02);
      const upDot = Math.cos(pitchError) * Math.cos(rollError);
      const landingType = upDot < -0.28
        ? 'roof'
        : roll > 1.02
          ? (rollError < 0 ? 'left-side' : 'right-side')
          : pitch > 0.62
            ? (pitchError < 0 ? 'rear' : 'front')
            : landingSpeed > _finiteOr(tuning.bottomOutSpeed, 18)
              ? 'belly'
              : 'four-wheel';
      const bottomedOut = landingSpeed > _finiteOr(tuning.bottomOutSpeed, 18)
        && landingType !== 'roof' && landingType !== 'left-side' && landingType !== 'right-side';
      kart.vx *= retention;
      kart.vz *= retention;
      kart.y = groundHeight;
      kart.vy = 0;
      kart.grounded = true;
      kart.lastAirTime = kart.airTime;
      kart.landingImpulse = clamp(landingSpeed / (tuning.hardLandingSpeed || 16.5), 0, 1.35);
      kart.suspensionOffset = clamp(kart.suspensionOffset + landingSpeed * 0.028, -0.18, 1);
      kart.suspensionVelocity += landingSpeed * 0.095;
      kart.suspensionCompression = clamp(kart.suspensionOffset, 0, 1);
      kart.impactStrength = Math.max(kart.impactStrength, clamp(landingSpeed / 18, 0, 1));
      const reportLanding = kart.landingCooldown <= 0;
      kart.landingCooldown = 0.18;
      kart.landingType = landingType;
      kart.bottomedOut = bottomedOut;
      events.landed = reportLanding;
      events.landingSpeed = landingSpeed;
      events.landingQuality = quality;
      events.landingGrade = perfect ? 'perfect' : clean ? 'clean' : hard ? 'hard' : 'rough';
      events.perfectLanding = perfect;
      events.cleanLanding = clean;
      events.hardLanding = hard;
      events.bottomedOut = bottomedOut;
      events.landingType = landingType;
      events.impactStrength = Math.max(events.impactStrength, clamp(landingSpeed / 18, 0, 1));
      events.airTime = kart.airTime;
      kart.airTime = 0;
    }
  } else {
    kart.y = groundHeight;
    kart.airTime = 0;
    kart.airPitch = _expApproach(_finiteOr(kart.airPitch, 0), 0, 8, dt);
    kart.airRoll = _expApproach(_finiteOr(kart.airRoll, 0), 0, 9, dt);
    kart.airPitchVelocity = _finiteOr(kart.airPitchVelocity, 0) * Math.exp(-8 * dt);
    kart.airRollVelocity = _finiteOr(kart.airRollVelocity, 0) * Math.exp(-9 * dt);
    const pitchTarget = kart.longitudinalWeightTransfer * 0.13 - kart.suspensionVelocity * 0.012;
    const rollTarget = kart.lateralWeightTransfer * 0.15;
    kart.bodyPitch = _expApproach(_finiteOr(kart.bodyPitch, 0), pitchTarget, 9, dt);
    kart.bodyRoll = _expApproach(_finiteOr(kart.bodyRoll, 0), rollTarget, 9, dt);
  }

  kart.speed = Math.hypot(kart.vx, kart.vz);
  kart.lateralSpeed = kart.vx * rightX + kart.vz * rightZ;
  kart.slipAngle = Math.atan2(kart.lateralSpeed, Math.max(0.1, Math.abs(forwardSpeed)));
  return events;
}

export function circularIndexDelta(from, to, sampleCount) {
  if (!(sampleCount > 0)) return 0;
  let delta = to - from;
  const half = sampleCount / 2;
  if (delta > half) delta -= sampleCount;
  else if (delta < -half) delta += sampleCount;
  return delta;
}

/** Track a wrapped nearest-sample index as a continuous race distance. */
export function updateRaceProgress(kart, nearestIndex, sampleCount) {
  if (!(sampleCount > 0)) return kart;
  nearestIndex = ((Math.round(nearestIndex) % sampleCount) + sampleCount) % sampleCount;
  const previous = Number.isFinite(kart.nearestIndex) ? kart.nearestIndex : nearestIndex;
  const delta = circularIndexDelta(previous, nearestIndex, sampleCount);
  // A physically impossible leap normally means the brute-force nearest-point
  // query chose the other side of a close hairpin. Ignore it instead of gifting
  // or stealing most of a lap.
  if (Math.abs(delta) <= sampleCount * 0.12) {
    kart.unwrappedIndex = (Number(kart.unwrappedIndex) || 0) + delta;
  }
  kart.nearestIndex = nearestIndex;
  kart.completedLaps = Math.max(0, Math.floor(Math.max(0, kart.unwrappedIndex) / sampleCount));
  return kart;
}

export function raceProgressScore(kart, sampleCount = 1) {
  if (!kart) return -Infinity;
  if (kart.finished) {
    const time = Number.isFinite(kart.finishTime) ? kart.finishTime : 999999;
    return 1e9 - time;
  }
  return (Number(kart.unwrappedIndex) || 0) / Math.max(1, sampleCount);
}

export function rankRaceCars(cars, sampleCount = 1) {
  return [...(cars || [])].sort((a, b) => {
    const scoreDiff = raceProgressScore(b.physics, sampleCount) - raceProgressScore(a.physics, sampleCount);
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    return (a.gridIndex || 0) - (b.gridIndex || 0);
  });
}

export function formatRaceTime(seconds, includeMillis = true) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  if (!includeMillis) return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
