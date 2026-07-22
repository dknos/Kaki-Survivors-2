const clampAxis = (value) => Math.max(-1, Math.min(1, Number(value) || 0));

// Racing vehicle/controller space reads the shared movement X axis backwards.
// Keep the correction at this boundary so keyboard, gamepad, and touch all
// agree without changing overworld movement or AI steering conventions.
export const RACING_STEER_SIGN = -1;

export function mapRacingSteerInput(axis = 0, { touchLeft = false, touchRight = false } = {}) {
  const combined = clampAxis(
    (Number(axis) || 0)
      + (touchRight ? 1 : 0)
      - (touchLeft ? 1 : 0),
  );
  return clampAxis(combined * RACING_STEER_SIGN);
}
