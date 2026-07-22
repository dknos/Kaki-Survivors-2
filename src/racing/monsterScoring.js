import {
  RACE_TUNING,
  applyKartDamage,
  clamp,
  normalizeAngle,
} from './physics.js';

const TAU = Math.PI * 2;

export const MONSTER_TUNING = Object.freeze({
  ...RACE_TUNING,
  acceleration: 15.0,
  reverseAcceleration: 11.5,
  brake: 27.5,
  coastDrag: 0.54,
  roadGrip: 7.8,
  offroadGrip: 6.4,
  driftGrip: 2.65,
  surfaceResponse: 4.2,
  steerRate: 1.72,
  driftSteerRate: 2.05,
  maxSpeed: 22.5,
  offroadSpeed: 18.5,
  boostSpeed: 30.5,
  boostAcceleration: 27.0,
  gravity: 16.0,
  hopVelocity: 7.6,
  rampVelocity: 11.4,
  rampVerticalScale: 1.12,
  rampLift: 0.85,
  maxRampVelocity: 15.8,
  rampHorizontalRetention: 0.97,
  takeoffPitchScale: 0.74,
  takeoffPitchVelocity: -0.08,
  rampAirControlDelay: 0.22,
  rampAirborneGrace: 0.16,
  suspensionSpring: 52,
  suspensionDamping: 8.2,
  cleanLandingAngle: 0.94,
  perfectLandingAngle: 0.3,
  hardLandingAngle: 1.34,
  perfectLandingSpeed: 15.2,
  hardLandingSpeed: 19.5,
  bottomOutSpeed: 17,
  speedSensitiveSteering: true,
  highSpeedSteerScale: 0.62,
  lowSpeedTorque: 0.32,
  stuntLanding: true,
});

const CYBER_TUNING = Object.freeze({
  ...MONSTER_TUNING,
  acceleration: 14.35,
  steerRate: 1.55,
  driftSteerRate: 1.78,
  maxSpeed: 23.2,
  offroadSpeed: 19.1,
  boostSpeed: 31.2,
  suspensionSpring: 57,
  suspensionDamping: 9.1,
  bottomOutSpeed: 18.5,
  highSpeedSteerScale: 0.52,
  lowSpeedTorque: 0.42,
});

export const MONSTER_VEHICLE_PROFILES = Object.freeze({
  meowster: Object.freeze({
    id: 'meowster',
    name: 'Mighty Meowster',
    traits: Object.freeze(['Forgiving landings', 'Fast air rotation', 'Bouncy suspension', 'Balanced crush power']),
    mass: 2.6,
    collisionRadius: 2.65,
    collisionHeight: 1.68,
    ramMultiplier: 1,
    airPitchRate: 4.4,
    airRollRate: 5.2,
    stability: 0.92,
    bottomOutSpeed: 17,
    contact: Object.freeze({
      wheelbase: 3.24,
      trackWidth: 3.56,
      wheelRadius: 1.05,
      suspensionTravel: 0.78,
      suspensionRest: 0.38,
      contactSpring: 42,
      contactDamping: 8.2,
      pitchResponse: 1.05,
      rollResponse: 1.05,
      maxClimbHeight: 1.82,
    }),
    tuning: MONSTER_TUNING,
  }),
  cyber: Object.freeze({
    id: 'cyber',
    name: 'Cyber Kaki',
    traits: Object.freeze(['Stable at speed', 'Stronger ramming', 'Heavy clean landings', 'Slower air rotation']),
    mass: 3.05,
    collisionRadius: 2.72,
    collisionHeight: 1.78,
    ramMultiplier: 1.18,
    airPitchRate: 3.72,
    airRollRate: 4.35,
    stability: 1.12,
    bottomOutSpeed: 18.5,
    contact: Object.freeze({
      wheelbase: 3.24,
      trackWidth: 3.56,
      wheelRadius: 1.05,
      suspensionTravel: 0.64,
      suspensionRest: 0.31,
      contactSpring: 55,
      contactDamping: 10.5,
      pitchResponse: 0.9,
      rollResponse: 0.9,
      maxClimbHeight: 1.9,
    }),
    tuning: CYBER_TUNING,
  }),
  tipsy: Object.freeze({
    id: 'tipsy',
    name: 'Tipsy Tumbler',
    traits: Object.freeze(['Animated wobble', 'Quick air rotation', 'Strong ramming', 'Lively suspension']),
    mass: 2.85,
    collisionRadius: 2.68,
    collisionHeight: 1.74,
    ramMultiplier: 1.08,
    airPitchRate: 4.65,
    airRollRate: 5.35,
    stability: 0.86,
    bottomOutSpeed: 17.6,
    contact: Object.freeze({
      wheelbase: 3.24,
      trackWidth: 3.56,
      wheelRadius: 1.05,
      suspensionTravel: 0.72,
      suspensionRest: 0.35,
      contactSpring: 47,
      contactDamping: 8.7,
      pitchResponse: 1.08,
      rollResponse: 1.1,
      maxClimbHeight: 1.86,
    }),
    tuning: MONSTER_TUNING,
  }),
});

export function getMonsterVehicleProfile(id = 'meowster') {
  return MONSTER_VEHICLE_PROFILES[id] || MONSTER_VEHICLE_PROFILES.meowster;
}

export function createMonsterScoreState(duration = 120) {
  return {
    duration,
    score: 0,
    combo: 1,
    comboTime: 0,
    wreckChain: 1,
    bestWreckChain: 1,
    chaos: 0,
    chaosSpent: 0,
    boostTime: 0,
    smashed: 0,
    damaged: 0,
    derbyKnockouts: 0,
    totalTargets: 0,
    currentAirTime: 0,
    totalAirTime: 0,
    bestAirTime: 0,
    bestTrick: 'FIND A RAMP',
    bestTrickPoints: 0,
    flips: 0,
    barrelRolls: 0,
    perfectLandings: 0,
    cleanLandings: 0,
    classCrushes: {},
    completedRows: {},
    signatures: {},
    lastCategory: '',
    repeatCount: 0,
    lastEvent: '',
    lastEventLabel: '',
    lastEventPoints: 0,
    lastEventTier: 'small',
    lastEventTime: 0,
    pendingLine: null,
    pendingTrick: null,
    airStartX: 0,
    airStartZ: 0,
    airMaxHeight: 0,
    groundTrickTimers: { wheelie: 0, stoppie: 0, bicycle: 0, donut: 0 },
    groundTrickLatch: '',
    groundTrickCooldown: 0,
    lastDistrict: '',
  };
}

export function breakMonsterChain(run, label = '') {
  if (!run) return;
  run.combo = 1;
  run.wreckChain = 1;
  run.comboTime = 0;
  run.repeatCount = 0;
  run.lastCategory = '';
  if (label) {
    run.lastEvent = label;
    run.lastEventLabel = label;
    run.lastEventPoints = 0;
    run.lastEventTier = 'break';
    run.lastEventTime = 1.1;
  }
}

export function awardMonsterEvent(run, basePoints, label, category = 'destruction', options = {}) {
  if (!run || !(basePoints > 0)) return 0;
  const repeated = run.comboTime > 0 && run.lastCategory === category;
  run.repeatCount = repeated ? run.repeatCount + 1 : 0;
  const repeatScale = repeated ? Math.max(0.38, 1 - run.repeatCount * 0.19) : 1;
  const variedGain = run.comboTime > 0 ? (repeated ? 0.24 : 0.72) : 0;
  run.combo = run.comboTime > 0 ? clamp(run.combo + variedGain + (options.comboGain || 0), 1, 8) : 1;
  run.wreckChain = run.combo;
  run.bestWreckChain = Math.max(run.bestWreckChain, run.wreckChain);
  const points = Math.round(basePoints * repeatScale * run.combo);
  run.score += points;
  run.comboTime = options.chainTime || 3.8;
  run.chaos = clamp(run.chaos + (options.chaos ?? Math.min(26, basePoints / 24)), 0, 100);
  run.lastCategory = category;
  run.lastEventLabel = label;
  run.lastEventPoints = points;
  run.lastEvent = `${label} +${points.toLocaleString()}`;
  run.lastEventTier = options.tier || (basePoints >= 850 ? 'signature' : basePoints >= 430 ? 'major' : 'small');
  run.lastEventTime = options.eventTime || (run.lastEventTier === 'signature' ? 2 : 1.35);
  if (points > run.bestTrickPoints && category !== 'destruction') {
    run.bestTrickPoints = points;
    run.bestTrick = label;
  }
  return points;
}

export function awardMonsterSmash(run, impactSpeed, kind = 'junk-car') {
  const speed = Math.max(0, Number(impactSpeed) || 0);
  if (speed < 3.8) return 0;
  const base = kind === 'bonus-stack' ? 620 : kind === 'barrel' ? 165 : 300;
  run.smashed += 1;
  return awardMonsterEvent(
    run,
    base + Math.min(300, speed * 15),
    kind === 'bonus-stack' ? 'STACK ATTACK' : 'CAR CRUSH',
    'destruction',
    { comboGain: kind === 'bonus-stack' ? 0.28 : 0.08 },
  );
}

export function awardMonsterTargetHit(run, target, impact = {}) {
  const state = impact.state || target?.state || 'dented';
  const kind = target?.kind || 'sedan';
  const base = Math.max(80, Number(impact.basePoints) || 260);
  if (state === 'dented') {
    run.damaged += 1;
    return awardMonsterEvent(run, base * 0.28, 'METAL MUNCHED', 'impact', { chaos: 5, tier: 'small' });
  }
  run.smashed += 1;
  run.classCrushes[kind] = (run.classCrushes[kind] || 0) + 1;
  if (kind === 'derby') run.derbyKnockouts += 1;
  const vertical = (impact.verticalSpeed || 0) > 5;
  const label = target?.signature
    || (kind === 'rv' && vertical ? 'RV ROOFTOP' : kind === 'bus' ? 'BUS BUSTER' : kind === 'derby' ? 'DERBY KNOCKOUT' : kind === 'crown' ? 'CROWN CRUSH' : vertical ? 'ROOF STOMP' : 'CAR CRUSH');
  return awardMonsterEvent(run, base + (impact.speed || 0) * 14 + (impact.verticalSpeed || 0) * 22, label, 'destruction', {
    comboGain: kind === 'bus' || kind === 'rv' || kind === 'crown' ? 0.45 : 0.16,
    chaos: kind === 'bus' || kind === 'rv' ? 22 : 12,
    tier: kind === 'crown' || target?.signature ? 'signature' : kind === 'bus' || kind === 'rv' ? 'major' : 'small',
  });
}

export function awardMonsterRow(run, rowId, count) {
  if (!run || !rowId || run.completedRows[rowId]) return 0;
  run.completedRows[rowId] = true;
  return awardMonsterEvent(run, 720 + Math.max(0, count - 3) * 120, 'CARPET CRUSH', 'row', { chaos: 24, tier: 'signature', comboGain: 0.7 });
}

export function awardMonsterSignature(run, id, label, points = 950) {
  if (!run || !id) return 0;
  run.signatures[id] = (run.signatures[id] || 0) + 1;
  return awardMonsterEvent(run, points, label, 'signature', { chaos: 28, tier: 'signature', comboGain: 0.85, eventTime: 2.15 });
}

/** Zoomies are stored internally as `chaos` for save/snapshot compatibility. */
export function stepMonsterChaos(run, kart, controls, dt) {
  if (!run || !kart || !(dt > 0)) return { boosting: false, spent: 0, power: 1 };
  const wantsBoost = !!controls?.boost;
  if (!wantsBoost || run.chaos <= 0.05 || !kart.grounded && run.chaos < 4) {
    run.boostTime = Math.max(0, run.boostTime - dt);
    return { boosting: false, spent: 0, power: 1 + run.chaos / 100 * 0.08 };
  }
  const spent = Math.min(run.chaos, dt * (kart.grounded ? 24 : 17));
  run.chaos -= spent;
  run.chaosSpent += spent;
  run.boostTime = 0.14;
  kart.boostTime = Math.max(kart.boostTime || 0, 0.14);
  kart.boostLevel = Math.max(kart.boostLevel || 0, run.chaos > 65 ? 3 : 2);
  // Zoomies use an earned meter instead of the drift-overheat minigame.
  kart.boostHeat = Math.max(0, (kart.boostHeat || 0) - dt * 0.35);
  kart.overheated = false;
  return { boosting: true, spent, power: 1.16 + run.chaos / 100 * 0.18 };
}

function _rotationPrefix(count) {
  return count >= 3 ? 'TRIPLE ' : count === 2 ? 'DOUBLE ' : '';
}

function _composeAirTrick(kart, airTime, distance, height) {
  const pitchTurns = Math.floor((Math.abs(kart.stuntPitch) + Math.PI * 0.45) / TAU);
  const rollTurns = Math.floor((Math.abs(kart.stuntRoll) + Math.PI * 0.45) / TAU);
  const pitchName = (kart.stuntPitch || 0) < 0 ? 'FRONTFLIP' : 'BACKFLIP';
  const rollName = (kart.stuntRoll || 0) < 0 ? 'RIGHT ROLL' : 'LEFT ROLL';
  let label = '';
  if (pitchTurns && rollTurns) {
    const rotations = Math.max(pitchTurns, rollTurns);
    label = `${_rotationPrefix(rotations)}CORKSCREW`;
  } else if (pitchTurns) label = `${_rotationPrefix(pitchTurns)}${pitchName}`;
  else if (rollTurns) label = `${_rotationPrefix(rollTurns)}${rollName}`;
  else if (distance >= 24) label = 'LONG JUMP';
  else if (height >= 8) label = 'HIGH JUMP';
  else if (airTime >= 0.28) label = 'CLEAN AIR';
  return { label, pitchTurns, rollTurns };
}

function _stepGroundTricks(run, kart, controls, dt) {
  run.groundTrickCooldown = Math.max(0, (run.groundTrickCooldown || 0) - dt);
  const contacts = Object.values(kart.wheelContacts || {});
  const frontCompression = contacts.filter((contact) => contact.axle === 'front')
    .reduce((sum, contact) => sum + (contact.compression || 0), 0) * 0.5;
  const rearCompression = contacts.filter((contact) => contact.axle === 'rear')
    .reduce((sum, contact) => sum + (contact.compression || 0), 0) * 0.5;
  const wheelie = kart.grounded && kart.speed > 5
    && kart.longitudinalWeightTransfer < -0.34
    && rearCompression > frontCompression + 0.17;
  const stoppie = kart.grounded && kart.speed > 3.5
    && kart.longitudinalWeightTransfer > 0.32
    && frontCompression > rearCompression + 0.16;
  const bicycle = kart.grounded && kart.speed > 5.5
    && (kart.groundedWheelCount || 4) <= 2
    && Math.abs(kart.contactRoll || 0) > 0.2;
  const donut = kart.grounded && kart.speed > 2.2 && kart.speed < 12.5
    && Math.abs(Number(controls?.steer) || 0) > 0.76
    && Math.abs(Number(controls?.throttle) || 0) > 0.52
    && ((kart.wheelSlip || 0) > 0.2 || Math.abs(kart.lateralSpeed || 0) > 1.8);
  const matches = { wheelie, stoppie, bicycle, donut };
  for (const key of Object.keys(run.groundTrickTimers)) {
    run.groundTrickTimers[key] = matches[key]
      ? run.groundTrickTimers[key] + dt
      : Math.max(0, run.groundTrickTimers[key] - dt * 2.5);
  }
  const winner = Object.entries(run.groundTrickTimers).find(([key, time]) => (
    time >= (key === 'donut' ? 1.1 : key === 'bicycle' ? 0.7 : 0.62)
  ));
  if (!winner || run.groundTrickCooldown > 0 || run.groundTrickLatch === winner[0]) {
    if (!winner) run.groundTrickLatch = '';
    return 0;
  }
  run.groundTrickLatch = winner[0];
  run.groundTrickCooldown = 1.4;
  const labels = {
    wheelie: run.groundTrickTimers.wheelie > 1.15 ? 'SLAP WHEELIE' : 'WHEELIE',
    stoppie: 'STOPPIE',
    bicycle: 'BICYCLE SAVE',
    donut: 'DONUT',
  };
  return awardMonsterEvent(run, winner[0] === 'donut' ? 520 : 430, labels[winner[0]], 'ground-trick', {
    chaos: 10,
    comboGain: 0.32,
    tier: 'major',
  });
}

export function stepMonsterStunts(run, kart, controls, events, dt, vehicleProfile = MONSTER_VEHICLE_PROFILES.meowster) {
  if (!run || !kart || !(dt > 0)) {
    return { points: 0, landed: false, clean: false, perfect: false, hard: false, turns: 0, rolls: 0, airTime: 0 };
  }
  run.comboTime = Math.max(0, run.comboTime - dt);
  run.lastEventTime = Math.max(0, run.lastEventTime - dt);
  if (run.comboTime <= 0 && run.combo > 1) breakMonsterChain(run);

  kart.stuntPitch = Number(kart.stuntPitch) || 0;
  kart.stuntPitchVelocity = Number(kart.stuntPitchVelocity) || 0;
  kart.stuntRoll = Number(kart.stuntRoll) || 0;
  kart.stuntRollVelocity = Number(kart.stuntRollVelocity) || 0;
  if (events?.jumped) {
    run.currentAirTime = 0;
    run.airStartX = Number(kart.x) || 0;
    run.airStartZ = Number(kart.z) || 0;
    run.airMaxHeight = Number(kart.y) || 0;
    run.pendingTrick = null;
  }
  if (!kart.grounded) {
    const pitchControl = clamp(Number(controls?.throttle) || 0, -1, 1);
    const rollControl = clamp(Number(controls?.steer) || 0, -1, 1);
    const takeoffAssist = clamp((Number(kart.airControlDelay) || 0) / 0.22, 0, 1);
    // Normal driving inputs only trim the truck in flight. Holding Zoomies is
    // the explicit stunt modifier that unlocks enough authority for flips and
    // rolls, so staying on the gas up a ramp no longer forces a rotation.
    const stuntAuthority = controls?.boost ? 1 : 0.22;
    const pitchAuthority = (1 - takeoffAssist * 0.88) * stuntAuthority;
    kart.stuntPitchVelocity += -pitchControl * (vehicleProfile.airPitchRate || 4.4) * pitchAuthority * dt;
    kart.stuntRollVelocity += -rollControl * (vehicleProfile.airRollRate || 5.2)
      * (controls?.boost ? 1 : 0.3) * dt;
    if (takeoffAssist > 0) {
      const takeoffPitch = Number(kart.takeoffPitch) || 0;
      kart.stuntPitchVelocity += (takeoffPitch - kart.stuntPitch) * 7.5 * takeoffAssist * dt;
    }
    kart.stuntPitchVelocity *= Math.exp(-1.08 * dt * (vehicleProfile.stability || 1));
    kart.stuntRollVelocity *= Math.exp(-0.34 * dt * (vehicleProfile.stability || 1));
    kart.stuntPitchVelocity = clamp(kart.stuntPitchVelocity, -3.7, 3.7);
    kart.stuntRollVelocity = clamp(kart.stuntRollVelocity, -4.6, 4.6);
    kart.stuntPitch += kart.stuntPitchVelocity * dt;
    kart.stuntRoll += kart.stuntRollVelocity * dt;
    run.currentAirTime += dt;
    run.totalAirTime += dt;
    run.airMaxHeight = Math.max(run.airMaxHeight || 0, Number(kart.y) || 0);
    const distance = Math.hypot((Number(kart.x) || 0) - run.airStartX, (Number(kart.z) || 0) - run.airStartZ);
    const provisional = _composeAirTrick(kart, run.currentAirTime, distance, run.airMaxHeight - (kart.groundHeight || 0));
    if (provisional.label) {
      run.pendingTrick = {
        label: provisional.label,
        points: Math.round(run.currentAirTime * 150 + provisional.pitchTurns * 1080 + provisional.rollTurns * 1120),
        pitchTurns: provisional.pitchTurns,
        rollTurns: provisional.rollTurns,
      };
    }
  }

  if (!events?.landed) {
    if (kart.grounded) {
      _stepGroundTricks(run, kart, controls, dt);
      kart.stuntPitch *= Math.exp(-8 * dt);
      kart.stuntPitchVelocity *= Math.exp(-8 * dt);
      kart.stuntRoll *= Math.exp(-8 * dt);
      kart.stuntRollVelocity *= Math.exp(-8 * dt);
    }
    return { points: 0, landed: false, clean: false, perfect: false, hard: false, turns: 0, rolls: 0, airTime: run.currentAirTime };
  }

  const airTime = Math.max(run.currentAirTime, Number(events.airTime) || 0);
  const turns = Math.floor((Math.abs(kart.stuntPitch) + Math.PI * 0.45) / TAU);
  const rolls = Math.floor((Math.abs(kart.stuntRoll) + Math.PI * 0.45) / TAU);
  const pitchAngle = Math.abs(normalizeAngle(kart.stuntPitch));
  const rollAngle = Math.abs(normalizeAngle(kart.stuntRoll));
  const landingAngle = Math.hypot(pitchAngle, rollAngle * 0.88);
  const hasPhysicsGrade = typeof events.landingGrade === 'string' && events.landingGrade.length > 0;
  const perfect = hasPhysicsGrade
    ? !!events.perfectLanding
    : landingAngle < 0.3 && (events.landingSpeed || 0) <= 15.2;
  const clean = hasPhysicsGrade
    ? !!events.cleanLanding
    : landingAngle < 0.94 && (events.landingSpeed || 0) <= 19.5;
  const hardLanding = hasPhysicsGrade ? !!events.hardLanding : (events.landingSpeed || 0) > 19.5;
  const targetStomp = !!events.wheelContacts?.some((contact) => contact.targetId)
    && !['roof', 'left-side', 'right-side', 'belly'].includes(events.landingType);
  const distance = Math.hypot((Number(kart.x) || 0) - run.airStartX, (Number(kart.z) || 0) - run.airStartZ);
  const composed = _composeAirTrick(kart, airTime, distance, run.airMaxHeight - (kart.groundHeight || 0));
  let points = 0;
  if (airTime >= 0.28 && (clean || targetStomp)) {
    const landingBonus = perfect ? 480 : clean ? 280 : 0;
    const base = airTime * 150 + turns * 1080 + rolls * 1120 + landingBonus + (targetStomp ? 420 : 0);
    const label = targetStomp && (turns || rolls)
      ? `${composed.label} → ROOF STOMP`
      : targetStomp ? 'ROOF STOMP'
        : turns || rolls ? composed.label
          : perfect ? 'PERFECT DOWNSLOPE' : composed.label || 'CLEAN AIR';
    points = awardMonsterEvent(run, base, label, turns || rolls ? 'rotation' : 'airtime', {
      comboGain: turns + rolls > 0 ? 0.62 : perfect ? 0.32 : 0.08,
      chaos: Math.min(24, 7 + airTime * 6 + (turns + rolls) * 8),
      tier: turns + rolls >= 2 || perfect && airTime > 1.1 ? 'signature' : turns + rolls || perfect ? 'major' : 'small',
    });
    run.bestAirTime = Math.max(run.bestAirTime, airTime);
    run.flips += turns;
    run.barrelRolls += rolls;
    if (perfect) run.perfectLandings += 1;
    if (clean) run.cleanLandings += 1;
  }
  if (!clean || hardLanding) {
    const severity = Math.max(0, landingAngle - 0.82) * 8.5
      + Math.max(0, (events.landingSpeed || 0) - 16.5) * 0.9
      + (hardLanding ? 2 : 0);
    applyKartDamage(kart, clamp(severity, 0, 30), 'front');
    breakMonsterChain(run, 'ROUGH LANDING');
  }
  kart.stuntPitch = normalizeAngle(kart.stuntPitch);
  kart.stuntRoll = normalizeAngle(kart.stuntRoll);
  kart.stuntPitchVelocity *= perfect ? 0.16 : clean ? 0.26 : -0.18;
  kart.stuntRollVelocity *= perfect ? 0.16 : clean ? 0.26 : -0.18;
  run.currentAirTime = 0;
  run.pendingTrick = null;
  return {
    points,
    landed: true,
    clean,
    perfect,
    hard: hardLanding,
    turns,
    rolls,
    label: composed.label,
    targetStomp,
    airTime,
    landingQuality: Number(events.landingQuality) || (perfect ? 1 : clean ? 0.75 : 0.2),
  };
}

export function stepMonsterSignatureStunts(run, kart, contact, events) {
  if (!run || !kart || !contact) return 0;
  let points = 0;
  if (events?.jumped && contact.signature) {
    run.pendingLine = {
      featureId: contact.featureId,
      label: contact.signature,
      expectedLanding: contact.landing,
      startedDistrict: contact.district,
    };
  }
  if (events?.landed && run.pendingLine) {
    const pending = run.pendingLine;
    const verifiedLanding = contact.featureId === pending.expectedLanding
      || contact.landingZone === pending.expectedLanding
      || (pending.label === 'BUS GAP' && contact.district === 'bus-rv-gap');
    if (verifiedLanding && (events.airTime || kart.lastAirTime || 0) >= 0.65 && events.cleanLanding) {
      points = awardMonsterSignature(run, `${pending.featureId}:${pending.expectedLanding}`, pending.label, pending.label === 'BUS GAP' ? 1250 : 980);
    }
    run.pendingLine = null;
  }
  if (run.lastDistrict === 'demolition-bowl' && contact.district !== 'demolition-bowl'
    && !kart.grounded && (run.currentAirTime || 0) > 0.42) {
    run.pendingLine ||= { featureId: 'bowl-escape', label: 'BOWL ESCAPE', expectedLanding: '', startedDistrict: 'demolition-bowl' };
  }
  run.lastDistrict = contact.district;
  return points;
}

function _distanceToMotionSegment(target, kart) {
  const ax = Number(kart.previousX ?? kart.x);
  const az = Number(kart.previousZ ?? kart.z);
  const bx = kart.x;
  const bz = kart.z;
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 1e-6
    ? clamp(((target.x - ax) * abx + (target.z - az) * abz) / lengthSq, 0, 1)
    : 0;
  return Math.hypot(target.x - (ax + abx * t), target.z - (az + abz * t));
}

/** Legacy target resolver retained for small smoke fixtures and compatibility. */
export function resolveMonsterSmashes(arena, run, kart) {
  if (!arena || !run || !kart || kart.y > 2.8) return [];
  const events = [];
  for (const target of arena.targets) {
    if (target.destroyed || _distanceToMotionSegment(target, kart) > 2.35) continue;
    const impactSpeed = kart.speed + Math.max(0, -(kart.vy || 0)) * 0.85;
    const points = awardMonsterSmash(run, impactSpeed, target.kind);
    if (!points) continue;
    target.destroyed = true;
    target.crushVelocity = 0.2;
    arena.destroyed += 1;
    kart.vx *= target.kind === 'bonus-stack' ? 0.91 : 0.95;
    kart.vz *= target.kind === 'bonus-stack' ? 0.91 : 0.95;
    const impactStrength = clamp(impactSpeed / 24, 0, 1);
    kart.impactStrength = Math.max(Number(kart.impactStrength) || 0, impactStrength);
    kart.pendingImpactStrength = Math.max(Number(kart.pendingImpactStrength) || 0, impactStrength);
    kart.suspensionVelocity = (Number(kart.suspensionVelocity) || 0) + impactStrength * 1.8;
    if (kart.grounded) {
      kart.grounded = false;
      kart.vy = Math.max(kart.vy || 0, target.kind === 'bonus-stack' ? 4.4 : 2.7);
    }
    events.push({ target, points, impactSpeed, impactStrength });
  }
  return events;
}
