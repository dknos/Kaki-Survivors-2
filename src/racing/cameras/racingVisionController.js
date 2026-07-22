import { normalizeVisionAngle } from './trackVisionAnalyzer.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-Math.max(0, rate) * Math.max(0, dt));
}

/** Smoothed virtual head: automatic race vision plus bounded player freelook. */
export class RacingVisionController {
  constructor() {
    this.reset();
  }

  reset() {
    this.autoYaw = 0;
    this.autoPitch = 0;
    this.manualYaw = 0;
    this.manualPitch = 0;
    this.manualIdle = 0;
    this.initialized = false;
    this.lastVision = null;
  }

  update(dt, { vehicle, eye, analyzer, profile, input = {}, reducedMotion = false }) {
    const vision = analyzer.analyze(vehicle, {
      braking: Math.max(0, Number(vehicle.longitudinalWeightTransfer) || 0),
    });
    this.lastVision = vision;
    const dx = vision.target.x - eye.x;
    const dy = vision.target.y - eye.y;
    const dz = vision.target.z - eye.z;
    const horizontal = Math.max(0.001, Math.hypot(dx, dz));
    const worldYaw = Math.atan2(dx, dz);
    const baseline = profile.fpvBaselineForward || { x: 0, y: 0, z: 1 };
    const baselineHorizontal = Math.max(0.001, Math.hypot(baseline.x || 0, baseline.z || 0));
    const baselineYaw = Math.atan2(baseline.x || 0, baseline.z || 0);
    const baselinePitch = Math.atan2(baseline.y || 0, baselineHorizontal);
    const relativeYaw = normalizeVisionAngle(worldYaw - ((vehicle.yaw || 0) + baselineYaw));
    const tightHeadScale = 0.66 + vision.tightness * 0.34;
    const automaticYawLimit = radians(profile.fpvMaxYawDegrees) * tightHeadScale;
    const desiredAutoYaw = clamp(relativeYaw, -automaticYawLimit, automaticYawLimit);
    const desiredAutoPitch = clamp(
      Math.atan2(dy, horizontal) - baselinePitch,
      -radians(profile.fpvMaxPitchDegrees),
      radians(profile.fpvMaxPitchDegrees),
    );

    const deltaX = Number(input.lookDelta?.x) || 0;
    const deltaY = Number(input.lookDelta?.y) || 0;
    const stickX = Number(input.lookStick?.x) || 0;
    const stickY = Number(input.lookStick?.y) || 0;
    const hasManual = Math.abs(deltaX) + Math.abs(deltaY) > 0.01 || Math.hypot(stickX, stickY) > 0.08;
    if (input.recenter) {
      this.manualYaw = 0;
      this.manualPitch = 0;
      this.manualIdle = 0;
    } else if (hasManual) {
      this.manualYaw -= deltaX * 0.00235;
      this.manualPitch -= deltaY * 0.00195;
      this.manualYaw -= stickX * dt * 1.85;
      this.manualPitch -= stickY * dt * 1.32;
      this.manualIdle = 0;
    } else {
      this.manualIdle += dt;
      if (this.manualIdle > 1.1) {
        this.manualYaw = damp(this.manualYaw, 0, 2.6, dt);
        this.manualPitch = damp(this.manualPitch, 0, 2.8, dt);
      }
    }
    this.manualYaw = clamp(
      this.manualYaw,
      -radians(profile.fpvFreelookYawDegrees),
      radians(profile.fpvFreelookYawDegrees),
    );
    this.manualPitch = clamp(
      this.manualPitch,
      -radians(profile.fpvFreelookPitchDegrees),
      radians(profile.fpvFreelookPitchDegrees),
    );

    const speedRatio = clamp((Number(vehicle.speed) || 0) / Math.max(1, Number(vehicle.maxSpeed) || 30), 0, 1.25);
    const yawResponse = profile.fpvRotationDamping * (0.72 + speedRatio * 0.28);
    const pitchResponse = profile.fpvRotationDamping * 0.78;
    if (!this.initialized || reducedMotion) {
      this.autoYaw = desiredAutoYaw;
      this.autoPitch = desiredAutoPitch;
      this.initialized = true;
    } else {
      this.autoYaw = damp(this.autoYaw, desiredAutoYaw, yawResponse, dt);
      this.autoPitch = damp(this.autoPitch, desiredAutoPitch, pitchResponse, dt);
    }

    const lookBackYaw = input.lookBack ? Math.PI : 0;
    const impactStrength = clamp(Number(vehicle.impactStrength) || 0, 0, 1);
    const pitchCoupling = vehicle.grounded === false
      ? profile.fpvAirbornePitchCoupling
      : profile.fpvGroundedPitchCoupling
        + (profile.fpvImpactPitchCoupling - profile.fpvGroundedPitchCoupling) * impactStrength;
    const rollCoupling = vehicle.grounded === false
      ? profile.fpvAirborneRollCoupling
      : profile.fpvGroundedRollCoupling
        + (profile.fpvImpactRollCoupling - profile.fpvGroundedRollCoupling) * impactStrength;
    const bodyPitch = (Number(vehicle.pitch) || 0) * pitchCoupling;
    const bodyRoll = (Number(vehicle.roll) || 0) * rollCoupling;
    const fov = clamp(
      profile.fpvBaseFov + speedRatio * 6.5 + (vehicle.boosting ? 1.8 : 0),
      profile.fpvBaseFov,
      profile.fpvMaxFov,
    );
    return {
      yaw: (vehicle.yaw || 0) + baselineYaw + this.autoYaw + this.manualYaw + lookBackYaw,
      pitch: baselinePitch + this.autoPitch + this.manualPitch + bodyPitch,
      roll: reducedMotion ? 0 : bodyRoll,
      fov,
      vision,
      automaticYaw: this.autoYaw,
      manualYaw: this.manualYaw,
    };
  }
}
