function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positive(value, fallback) {
  return Math.max(0, finite(value, fallback));
}

function vector3(value, fallback) {
  const source = value && typeof value === 'object' ? value : fallback;
  return Object.freeze({
    x: finite(source.x, fallback.x),
    y: finite(source.y, fallback.y),
    z: finite(source.z, fallback.z),
  });
}

function range(value, fallback) {
  const source = Array.isArray(value) && value.length >= 2 ? value : fallback;
  const low = finite(source[0], fallback[0]);
  const high = finite(source[1], fallback[1]);
  return Object.freeze([Math.min(low, high), Math.max(low, high)]);
}

function interiorRules(value = {}) {
  return Object.freeze({
    hideRoles: Object.freeze([...(value.hideRoles || ['driver', 'cockpit-canopy'])]),
    hideNames: Object.freeze([...(value.hideNames || [])]),
    hideVehicleExterior: value.hideVehicleExterior === true,
    showHood: value.showHood !== false,
  });
}

/** Immutable, validated camera tuning shared by every rig for one vehicle. */
export class RacingCameraProfile {
  constructor(options = {}) {
    this.id = String(options.id || 'rally');
    this.isometricAvailable = options.isometricAvailable !== false;
    this.driverFpvAvailable = options.driverFpvAvailable !== false;
    this.chaseAvailable = options.chaseAvailable !== false;

    this.fpvEyePosition = vector3(options.fpvEyePosition, { x: 0, y: 1.62, z: -0.2 });
    this.fpvBaselineForward = vector3(options.fpvBaselineForward, { x: 0, y: 0, z: 1 });
    this.fpvBaseFov = positive(options.fpvBaseFov, 78);
    this.fpvMaxFov = Math.max(this.fpvBaseFov, positive(options.fpvMaxFov, 88));
    this.fpvSeatHeightRange = range(options.fpvSeatHeightRange, [1.45, 1.85]);
    this.fpvMaxYawDegrees = positive(options.fpvMaxYawDegrees, 46);
    this.fpvMaxPitchDegrees = positive(options.fpvMaxPitchDegrees, 12);
    this.fpvFreelookYawDegrees = positive(options.fpvFreelookYawDegrees, 105);
    this.fpvFreelookPitchDegrees = positive(options.fpvFreelookPitchDegrees, 34);
    this.fpvInteriorVisibility = interiorRules(options.fpvInteriorVisibility);
    this.fpvHorizonStability = Math.min(1, positive(options.fpvHorizonStability, 0.8));
    const groundedPitchCoupling = (1 - this.fpvHorizonStability) * 0.34;
    const groundedRollCoupling = (1 - this.fpvHorizonStability) * 0.42;
    this.fpvGroundedPitchCoupling = positive(options.fpvGroundedPitchCoupling, groundedPitchCoupling);
    this.fpvAirbornePitchCoupling = positive(options.fpvAirbornePitchCoupling, groundedPitchCoupling);
    this.fpvImpactPitchCoupling = positive(options.fpvImpactPitchCoupling, groundedPitchCoupling);
    this.fpvGroundedRollCoupling = positive(options.fpvGroundedRollCoupling, groundedRollCoupling);
    this.fpvAirborneRollCoupling = positive(options.fpvAirborneRollCoupling, groundedRollCoupling);
    this.fpvImpactRollCoupling = positive(options.fpvImpactRollCoupling, groundedRollCoupling);
    this.fpvSuspensionMotion = Math.min(1, positive(options.fpvSuspensionMotion, 0.18));
    this.fpvCollisionMotion = Math.min(1, positive(options.fpvCollisionMotion, 0.16));
    this.fpvPositionDamping = positive(options.fpvPositionDamping, 15);
    this.fpvRotationDamping = positive(options.fpvRotationDamping, 10);

    this.chaseDistance = positive(options.chaseDistance, 8.5);
    this.chaseHeight = positive(options.chaseHeight, 3.8);
    this.chaseLookHeight = positive(options.chaseLookHeight, 1.1);
    this.chaseMinDistance = positive(options.chaseMinDistance, 2);
    this.chaseMaxDistance = Math.max(this.chaseMinDistance, positive(options.chaseMaxDistance, 12));
    this.chaseSpeedDistanceMultiplier = positive(options.chaseSpeedDistanceMultiplier, 0.12);
    this.chaseBaseFov = positive(options.chaseBaseFov, 72);
    this.chaseMaxFov = Math.max(this.chaseBaseFov, positive(options.chaseMaxFov, 86));
    this.chasePositionDamping = positive(options.chasePositionDamping, 8);
    this.chaseRotationDamping = positive(options.chaseRotationDamping, 10);
    this.chaseCollisionRadius = positive(options.chaseCollisionRadius, 0.48);
    this.chaseDriftVelocityBlend = Math.min(1, positive(options.chaseDriftVelocityBlend, 0.32));
    this.chaseHorizonStability = Math.min(1, positive(options.chaseHorizonStability, 0.88));

    this.transitionLift = positive(options.transitionLift, 1.15);
    Object.freeze(this);
  }
}

export const RACING_CAMERA_PROFILES = Object.freeze({
  rally: new RacingCameraProfile({
    id: 'rally',
    fpvInteriorVisibility: { hideVehicleExterior: true, showHood: false },
  }),
  meowster: new RacingCameraProfile({
    id: 'meowster',
    fpvEyePosition: { x: 0, y: 3.24, z: -0.38 },
    fpvBaseFov: 76,
    fpvMaxFov: 87,
    fpvSeatHeightRange: [2.95, 3.55],
    fpvMaxYawDegrees: 50,
    fpvHorizonStability: 0.72,
    fpvSuspensionMotion: 0.24,
    fpvCollisionMotion: 0.2,
    fpvInteriorVisibility: {
      hideNames: ['MeowsterCab_CyanGlass', 'MeowsterCatEarSilhouette'],
      hideVehicleExterior: true,
      showHood: false,
    },
    chaseDistance: 10.5,
    chaseHeight: 5.4,
    chaseLookHeight: 2,
    chaseMinDistance: 3.1,
    chaseMaxDistance: 15.5,
    chaseSpeedDistanceMultiplier: 0.16,
    chaseBaseFov: 70,
    chaseMaxFov: 86,
    chaseCollisionRadius: 0.7,
    transitionLift: 2.25,
  }),
  cyber: new RacingCameraProfile({
    id: 'cyber',
    fpvEyePosition: { x: 0, y: 3.38, z: -0.18 },
    fpvBaseFov: 75,
    fpvMaxFov: 85,
    fpvSeatHeightRange: [3.05, 3.65],
    fpvMaxYawDegrees: 46,
    fpvHorizonStability: 0.78,
    fpvSuspensionMotion: 0.17,
    fpvCollisionMotion: 0.14,
    fpvInteriorVisibility: {
      hideNames: ['CyberCatEar_L', 'CyberCatEar_R'],
      hideVehicleExterior: true,
      showHood: false,
    },
    chaseDistance: 11.3,
    chaseHeight: 5.7,
    chaseLookHeight: 2.12,
    chaseMinDistance: 3.3,
    chaseMaxDistance: 16,
    chaseSpeedDistanceMultiplier: 0.14,
    chaseBaseFov: 69,
    chaseMaxFov: 84,
    chasePositionDamping: 7.2,
    chaseCollisionRadius: 0.74,
    transitionLift: 2.4,
  }),
  trials_monster: new RacingCameraProfile({
    id: 'trials_monster',
    driverFpvAvailable: false,
    chaseDistance: 10.2,
    chaseHeight: 4.9,
    chaseLookHeight: 1.85,
    chaseMinDistance: 3,
    chaseMaxDistance: 14,
    chaseBaseFov: 71,
    chaseMaxFov: 84,
    chaseCollisionRadius: 0.68,
    transitionLift: 2,
  }),
  pocket_pouncer: new RacingCameraProfile({
    id: 'pocket_pouncer',
    driverFpvAvailable: false,
    chaseDistance: 7.2,
    chaseHeight: 3,
    chaseLookHeight: 1,
    chaseMinDistance: 2.2,
    chaseMaxDistance: 10.4,
    chaseSpeedDistanceMultiplier: 0.1,
    chaseBaseFov: 73,
    chaseMaxFov: 87,
    chaseCollisionRadius: 0.42,
    transitionLift: 1.2,
  }),
  crash_car: new RacingCameraProfile({
    id: 'crash_car',
    isometricAvailable: false,
    driverFpvAvailable: true,
    fpvEyePosition: { x: -0.43, y: 1.14, z: -0.43 },
    fpvBaseFov: 73,
    fpvMaxFov: 82,
    fpvSeatHeightRange: [1.02, 1.30],
    fpvMaxYawDegrees: 12,
    fpvFreelookYawDegrees: 112,
    fpvHorizonStability: 0.9,
    fpvAirbornePitchCoupling: 0.7,
    fpvImpactPitchCoupling: 0.38,
    fpvAirborneRollCoupling: 0.58,
    fpvImpactRollCoupling: 0.32,
    fpvSuspensionMotion: 0.12,
    fpvCollisionMotion: 0.13,
    fpvInteriorVisibility: {
      hideRoles: ['driver'],
      hideVehicleExterior: false,
      showHood: true,
    },
    chaseDistance: 6.3,
    chaseHeight: 2.18,
    chaseLookHeight: 0.80,
    chaseMinDistance: 1.9,
    chaseMaxDistance: 9.3,
    chaseSpeedDistanceMultiplier: 0.085,
    chaseBaseFov: 68,
    chaseMaxFov: 80,
    chasePositionDamping: 9.4,
    chaseRotationDamping: 11.5,
    chaseCollisionRadius: 0.5,
    chaseDriftVelocityBlend: 0.38,
    chaseHorizonStability: 0.94,
    transitionLift: 1.05,
  }),
  crash_pocket: new RacingCameraProfile({
    id: 'crash_pocket',
    isometricAvailable: false,
    fpvEyePosition: { x: -0.39, y: 1.08, z: -0.38 },
    fpvBaseFov: 72,
    fpvMaxFov: 81,
    fpvSeatHeightRange: [1.02, 1.14],
    fpvMaxYawDegrees: 12,
    fpvHorizonStability: 0.9,
    fpvAirbornePitchCoupling: 0.7,
    fpvImpactPitchCoupling: 0.38,
    fpvAirborneRollCoupling: 0.58,
    fpvImpactRollCoupling: 0.32,
    fpvSuspensionMotion: 0.12,
    fpvCollisionMotion: 0.13,
    fpvInteriorVisibility: { hideRoles: ['driver'], showHood: true },
    chaseDistance: 5.85,
    chaseHeight: 2.02,
    chaseLookHeight: 0.74,
    chaseMinDistance: 1.8,
    chaseMaxDistance: 8.8,
    chaseSpeedDistanceMultiplier: 0.085,
    chaseBaseFov: 69,
    chaseMaxFov: 81,
    chasePositionDamping: 9.4,
    chaseRotationDamping: 11.5,
    chaseCollisionRadius: 0.46,
    chaseDriftVelocityBlend: 0.38,
    chaseHorizonStability: 0.94,
    transitionLift: 1.0,
  }),
  crash_iron: new RacingCameraProfile({
    id: 'crash_iron',
    isometricAvailable: false,
    fpvEyePosition: { x: -0.45, y: 1.25, z: -0.46 },
    fpvBaseFov: 72,
    fpvMaxFov: 81,
    fpvSeatHeightRange: [1.17, 1.32],
    fpvMaxYawDegrees: 12,
    fpvHorizonStability: 0.9,
    fpvAirbornePitchCoupling: 0.7,
    fpvImpactPitchCoupling: 0.38,
    fpvAirborneRollCoupling: 0.58,
    fpvImpactRollCoupling: 0.32,
    fpvSuspensionMotion: 0.12,
    fpvCollisionMotion: 0.13,
    fpvInteriorVisibility: { hideRoles: ['driver'], showHood: true },
    chaseDistance: 6.7,
    chaseHeight: 2.32,
    chaseLookHeight: 0.86,
    chaseMinDistance: 2.0,
    chaseMaxDistance: 9.8,
    chaseSpeedDistanceMultiplier: 0.085,
    chaseBaseFov: 68,
    chaseMaxFov: 79,
    chasePositionDamping: 9.4,
    chaseRotationDamping: 11.5,
    chaseCollisionRadius: 0.54,
    chaseDriftVelocityBlend: 0.38,
    chaseHorizonStability: 0.94,
    transitionLift: 1.1,
  }),
});

export function cameraProfileForSession(session = {}) {
  if (session.raceMode === 'crash') {
    if (session.vehicleId === 'pocket') return RACING_CAMERA_PROFILES.crash_pocket;
    if (session.vehicleId === 'iron') return RACING_CAMERA_PROFILES.crash_iron;
    return RACING_CAMERA_PROFILES.crash_car;
  }
  if (session.raceMode === 'trials') {
    return session.vehicle?.id === 'buggy'
      ? RACING_CAMERA_PROFILES.pocket_pouncer
      : RACING_CAMERA_PROFILES.trials_monster;
  }
  if (session.raceMode === 'monster') {
    return session.monsterVehicleId === 'cyber'
      ? RACING_CAMERA_PROFILES.cyber
      : RACING_CAMERA_PROFILES.meowster;
  }
  return RACING_CAMERA_PROFILES.rally;
}
