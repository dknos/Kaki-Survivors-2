export const RacingCameraMode = Object.freeze({
  ISOMETRIC: 'isometric',
  CHASE: 'chase',
  DRIVER_FPV: 'driver_fpv',
});

export const RACING_CAMERA_ORDER = Object.freeze([
  RacingCameraMode.ISOMETRIC,
  RacingCameraMode.CHASE,
  RacingCameraMode.DRIVER_FPV,
]);

export const RACING_CAMERA_LABELS = Object.freeze({
  [RacingCameraMode.ISOMETRIC]: 'ISOMETRIC',
  [RacingCameraMode.CHASE]: 'CHASE',
  [RacingCameraMode.DRIVER_FPV]: 'DRIVER FPV',
});

export function normalizeCameraMode(mode, fallback = RacingCameraMode.ISOMETRIC) {
  return RACING_CAMERA_ORDER.includes(mode) ? mode : fallback;
}
export function availableCameraModes(profile = null) {
  return RACING_CAMERA_ORDER.filter((mode) => {
    if (mode === RacingCameraMode.ISOMETRIC) return profile?.isometricAvailable !== false;
    if (mode === RacingCameraMode.CHASE) return profile?.chaseAvailable !== false;
    if (mode === RacingCameraMode.DRIVER_FPV) return profile?.driverFpvAvailable !== false;
    return true;
  });
}

export function cycleCameraMode(current, direction = 1, modes = RACING_CAMERA_ORDER) {
  const available = modes.length ? modes : [RacingCameraMode.ISOMETRIC];
  const index = Math.max(0, available.indexOf(normalizeCameraMode(current, available[0])));
  const step = direction < 0 ? -1 : 1;
  return available[(index + step + available.length) % available.length];
}
