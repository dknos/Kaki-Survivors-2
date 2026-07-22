export const CRASH_PHASES = Object.freeze({
  LOADING: 'LOADING',
  INTRO: 'INTRO',
  COUNTDOWN: 'COUNTDOWN',
  APPROACH: 'APPROACH',
  LIVE_CRASH: 'LIVE_CRASH',
  SETTLING: 'SETTLING',
  REPLAY: 'REPLAY',
  RESULTS: 'RESULTS',
  DISPOSED: 'DISPOSED',
});

export const CRASH_FIXED_DT = 1 / 90;
export const CRASH_MAX_CATCHUP_STEPS = 6;
export const CRASH_CHAIN_TIMEOUT = 4;
export const CRASH_MAX_RUN_SECONDS = 36;
export const CRASH_POST_IMPACT_TAIL = 1.05;
export const CRASH_REPLAY_HZ = 30;
export const CRASH_REPLAY_SECONDS = 14;
export const CRASH_MODE_ORIGIN = Object.freeze({ x: 720, y: 0, z: -520 });
export const CRASH_SCENARIO_ID = 'pawprint-interchange';
export const CRASH_DEFAULT_SEED = 0x4b414b49;
export const CRASH_RECORD_KEY = 'kks_kaki_catastrophe_records_v1';

export const CRASH_QUALITY = Object.freeze({
  low: Object.freeze({ id: 'low', maxDynamicBodies: 24, maxDetachedDebris: 12, trafficScale: 0.68, shadows: 8, replayDof: false }),
  medium: Object.freeze({ id: 'medium', maxDynamicBodies: 38, maxDetachedDebris: 20, trafficScale: 0.88, shadows: 14, replayDof: false }),
  high: Object.freeze({ id: 'high', maxDynamicBodies: 54, maxDetachedDebris: 28, trafficScale: 1, shadows: 22, replayDof: true }),
});

export const CRASH_COLLISION = Object.freeze({
  PLAYER: 0x0001,
  TRAFFIC: 0x0002,
  ENVIRONMENT: 0x0004,
  DEBRIS: 0x0008,
  SENSOR: 0x0010,
});

// Keep the matrix explicit. A collider is never allowed to fall back to an
// all-bits filter because that makes a missing/incorrect membership impossible
// to diagnose and lets debug sensors enter the solver by accident.
export const CRASH_COLLISION_MATRIX = Object.freeze({
  [CRASH_COLLISION.PLAYER]: CRASH_COLLISION.TRAFFIC | CRASH_COLLISION.ENVIRONMENT | CRASH_COLLISION.DEBRIS | CRASH_COLLISION.SENSOR,
  [CRASH_COLLISION.TRAFFIC]: CRASH_COLLISION.PLAYER | CRASH_COLLISION.TRAFFIC | CRASH_COLLISION.ENVIRONMENT | CRASH_COLLISION.DEBRIS | CRASH_COLLISION.SENSOR,
  [CRASH_COLLISION.ENVIRONMENT]: CRASH_COLLISION.PLAYER | CRASH_COLLISION.TRAFFIC | CRASH_COLLISION.DEBRIS,
  [CRASH_COLLISION.DEBRIS]: CRASH_COLLISION.PLAYER | CRASH_COLLISION.TRAFFIC | CRASH_COLLISION.ENVIRONMENT,
  [CRASH_COLLISION.SENSOR]: CRASH_COLLISION.PLAYER | CRASH_COLLISION.TRAFFIC,
});

export function interactionGroups(membership, filter = 0xffff) {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export function crashInteractionGroups(membership) {
  const filter = CRASH_COLLISION_MATRIX[membership];
  if (filter == null) throw new Error(`Unknown crash collision membership: ${membership}`);
  return interactionGroups(membership, filter);
}

export function validateCrashCollisionMatrix() {
  const errors = [];
  const memberships = Object.values(CRASH_COLLISION);
  for (const a of memberships) {
    const filterA = CRASH_COLLISION_MATRIX[a];
    if (filterA == null) {
      errors.push(`missing filter for ${a}`);
      continue;
    }
    for (const b of memberships) {
      const aAcceptsB = (filterA & b) !== 0;
      const bAcceptsA = ((CRASH_COLLISION_MATRIX[b] || 0) & a) !== 0;
      if (aAcceptsB !== bAcceptsA) errors.push(`asymmetric ${a}<->${b}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

const TRAFFIC_PROFILES = {
  hatchback: { label: 'Hatchback', mass: 1080, width: 1.78, height: 1.45, length: 3.92, comY: -0.2, friction: 0.92, restitution: 0.03, angularDamping: 1.8, value: 0.9 },
  sedan: { label: 'Sedan', mass: 1320, width: 1.86, height: 1.48, length: 4.42, comY: -0.22, friction: 0.96, restitution: 0.025, angularDamping: 1.9, value: 1 },
  wagon: { label: 'Wagon', mass: 1510, width: 1.9, height: 1.62, length: 4.72, comY: -0.18, friction: 0.98, restitution: 0.02, angularDamping: 1.85, value: 1.12 },
  pickup: { label: 'Pickup', mass: 2140, width: 2.02, height: 1.86, length: 5.18, comY: -0.12, friction: 1.02, restitution: 0.015, angularDamping: 1.75, value: 1.35 },
  suv: { label: 'SUV', mass: 1940, width: 1.98, height: 1.88, length: 4.82, comY: -0.05, friction: 1.03, restitution: 0.018, angularDamping: 1.65, value: 1.3 },
  van: { label: 'Van', mass: 2580, width: 2.08, height: 2.32, length: 5.28, comY: 0.02, friction: 1.05, restitution: 0.012, angularDamping: 1.55, value: 1.55 },
  boxTruck: { label: 'Box Truck', mass: 5480, width: 2.42, height: 3.25, length: 7.15, comY: 0.12, friction: 1.1, restitution: 0.008, angularDamping: 1.45, value: 2.5 },
  bus: { label: 'City Bus', mass: 10800, width: 2.58, height: 3.25, length: 10.7, comY: 0.08, friction: 1.12, restitution: 0.006, angularDamping: 1.5, value: 4.2 },
  semi: { label: 'Semi Tractor', mass: 7600, width: 2.52, height: 3.45, length: 6.7, comY: 0.05, friction: 1.12, restitution: 0.006, angularDamping: 1.35, value: 3.4 },
  trailer: { label: 'Semi Trailer', mass: 9800, width: 2.55, height: 3.75, length: 12.2, comY: 0.1, friction: 1.08, restitution: 0.004, angularDamping: 1.3, value: 3.8 },
  tanker: { label: 'Energy Tanker', mass: 11600, width: 2.58, height: 3.55, length: 11.35, comY: 0.16, friction: 1.08, restitution: 0.004, angularDamping: 1.22, value: 5.2, volatile: true },
};

export const CRASH_TRAFFIC_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(TRAFFIC_PROFILES).map(([id, profile]) => [id, Object.freeze({ id, ...profile })]),
));

// Maximum compound-hull-to-authored-silhouette dimensional error in metres.
// Articulated freight deliberately leaves extra longitudinal clearance at the
// fifth wheel; the tanker cylinder deliberately sits inside its rail/ladder
// silhouette. Those exceptions are explicit rather than a shared loose box.
export const CRASH_COLLIDER_TOLERANCES = Object.freeze({
  pocket: Object.freeze({ width: 0.18, height: 0.36, length: 0.35 }),
  muscle: Object.freeze({ width: 0.18, height: 0.30, length: 0.35 }),
  iron: Object.freeze({ width: 0.18, height: 0.42, length: 0.35 }),
  hatchback: Object.freeze({ width: 0.18, height: 0.28, length: 0.35 }),
  sedan: Object.freeze({ width: 0.18, height: 0.24, length: 0.35 }),
  wagon: Object.freeze({ width: 0.18, height: 0.24, length: 0.35 }),
  pickup: Object.freeze({ width: 0.18, height: 0.24, length: 0.35 }),
  suv: Object.freeze({ width: 0.18, height: 0.24, length: 0.35 }),
  van: Object.freeze({ width: 0.18, height: 0.24, length: 0.35 }),
  boxTruck: Object.freeze({ width: 0.20, height: 0.30, length: 0.40 }),
  bus: Object.freeze({ width: 0.20, height: 0.30, length: 0.42 }),
  semi: Object.freeze({ width: 0.20, height: 0.30, length: 0.65 }),
  trailer: Object.freeze({ width: 0.20, height: 0.30, length: 1.70 }),
  tanker: Object.freeze({ width: 0.20, height: 1.35, length: 0.42 }),
});

function wheelSockets({ track, wheelbase, hardPointY }) {
  const halfTrack = track * 0.5;
  const halfWheelbase = wheelbase * 0.5;
  return Object.freeze({
    leftFront: Object.freeze({ x: -halfTrack, y: hardPointY, z: halfWheelbase }),
    rightFront: Object.freeze({ x: halfTrack, y: hardPointY, z: halfWheelbase }),
    leftRear: Object.freeze({ x: -halfTrack, y: hardPointY, z: -halfWheelbase }),
    rightRear: Object.freeze({ x: halfTrack, y: hardPointY, z: -halfWheelbase }),
  });
}

function playerProfile(profile) {
  const suspension = Object.freeze({ ...profile.suspension });
  const sockets = wheelSockets({
    track: profile.track,
    wheelbase: profile.wheelbase,
    hardPointY: suspension.hardPointY,
  });
  return Object.freeze({
    ...profile,
    suspension,
    wheelSockets: sockets,
    centerOfMass: Object.freeze({ ...profile.centerOfMass }),
    inertia: Object.freeze({ ...profile.inertia }),
  });
}

export const CRASH_PLAYER_PROFILES = Object.freeze({
  pocket: playerProfile({
    id: 'pocket', name: 'POCKET POUNCER', tagline: 'Light · agile · fastest launch',
    mass: 1120, width: 1.78, height: 1.42, length: 3.96, maxSpeed: 37,
    friction: 1.08, restitution: 0.018, angularDamping: 0.62,
    wheelbase: 2.46, track: 1.52, wheelRadius: 0.36, visualOffsetY: 0.8,
    engineForce: 10800, brakeForce: 180, steer: 0.52, grip: 1.24,
    driveBias: Object.freeze({ front: 0.5, rear: 0.5 }),
    brakeBias: Object.freeze({ front: 0.61, rear: 0.39 }),
    centerOfMass: { x: 0, y: -0.31, z: -0.04 },
    inertia: { x: 1450, y: 1750, z: 540 },
    suspension: {
      hardPointY: -0.17, restLength: 0.29, travel: 0.18,
      springRate: 36, compressionDamping: 4.8, reboundDamping: 5.8,
      maximumForce: 9200, antiRollStiffness: 6200, antiPitchStiffness: 1850,
      antiPitchDamping: 610, tractionAssist: 0.16,
    },
  }),
  muscle: playerProfile({
    id: 'muscle', name: 'KAKI MUSCLE', tagline: 'Balanced · forceful · forgiving',
    mass: 1680, width: 1.94, height: 1.5, length: 4.55, maxSpeed: 34,
    friction: 1.12, restitution: 0.016, angularDamping: 0.7,
    wheelbase: 2.78, track: 1.66, wheelRadius: 0.39, visualOffsetY: 0.82,
    engineForce: 12800, brakeForce: 245, steer: 0.46, grip: 1.34,
    driveBias: Object.freeze({ front: 0.45, rear: 0.55 }),
    brakeBias: Object.freeze({ front: 0.64, rear: 0.36 }),
    centerOfMass: { x: 0, y: -0.36, z: -0.08 },
    inertia: { x: 2850, y: 3400, z: 950 },
    suspension: {
      hardPointY: -0.18, restLength: 0.3, travel: 0.17,
      springRate: 41, compressionDamping: 5.2, reboundDamping: 6.2,
      maximumForce: 13200, antiRollStiffness: 8900, antiPitchStiffness: 2550,
      antiPitchDamping: 860, tractionAssist: 0.14,
    },
  }),
  iron: playerProfile({
    id: 'iron', name: 'IRON TABBY', tagline: 'Heavy · stable · maximum impact',
    mass: 2380, width: 2.04, height: 1.64, length: 4.82, maxSpeed: 31,
    friction: 1.16, restitution: 0.012, angularDamping: 0.78,
    wheelbase: 2.94, track: 1.76, wheelRadius: 0.42, visualOffsetY: 0.9,
    engineForce: 16500, brakeForce: 330, steer: 0.39, grip: 1.45,
    driveBias: Object.freeze({ front: 0.48, rear: 0.52 }),
    brakeBias: Object.freeze({ front: 0.66, rear: 0.34 }),
    centerOfMass: { x: 0, y: -0.43, z: -0.1 },
    inertia: { x: 4800, y: 5600, z: 1550 },
    suspension: {
      hardPointY: -0.2, restLength: 0.32, travel: 0.19,
      springRate: 48, compressionDamping: 5.8, reboundDamping: 6.9,
      maximumForce: 18400, antiRollStiffness: 12600, antiPitchStiffness: 3500,
      antiPitchDamping: 1180, tractionAssist: 0.12,
    },
  }),
});

export const CRASH_SCORE = Object.freeze({
  minimumRelativeSpeed: 3.2,
  minimumImpulse: 1350,
  pairCooldown: 0.48,
  participantBonus: 850,
  classBonus: 420,
  rolloverBonus: 1900,
  airborneBonus: 1250,
  jackknifeBonus: 3600,
  busBonus: 4200,
  tankerBonus: 7000,
  structureBonus: 3200,
  laneBlockedBonus: 1100,
  gridlockBonus: 8000,
});

export function crashQuality(id = 'high') {
  return CRASH_QUALITY[id] || CRASH_QUALITY.high;
}

export function crashDynamicBudgetSaturated(quality, dynamicCount, required = 1) {
  const cap = Math.max(0, Number(quality?.maxDynamicBodies) || 0);
  return Math.max(0, Number(dynamicCount) || 0) + Math.max(0, Number(required) || 0) > cap;
}

export function crashVehicleProfile(id) {
  return CRASH_TRAFFIC_PROFILES[id] || CRASH_TRAFFIC_PROFILES.sedan;
}
