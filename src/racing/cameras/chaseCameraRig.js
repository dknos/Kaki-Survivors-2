import * as THREE from 'three';
import { clamp, expAlpha, lookQuaternion, normalizeAngle } from './cameraRigMath.js';

export class ChaseCameraRig {
  constructor(collision) {
    this.collision = collision;
    this.position = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.desiredQuaternion = new THREE.Quaternion();
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.manualIdle = 0;
    this.initialized = false;
  }

  reset() {
    this.initialized = false;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.manualIdle = 0;
    this.collision?.reset();
  }

  _updateFreelook(dt, input) {
    const dx = Number(input.lookDelta?.x) || 0;
    const dy = Number(input.lookDelta?.y) || 0;
    const sx = Number(input.lookStick?.x) || 0;
    const sy = Number(input.lookStick?.y) || 0;
    const active = Math.abs(dx) + Math.abs(dy) > 0.01 || Math.hypot(sx, sy) > 0.08;
    if (input.recenter) {
      this.orbitYaw = 0;
      this.orbitPitch = 0;
      this.manualIdle = 0;
    } else if (active) {
      this.orbitYaw -= dx * 0.0024 + sx * dt * 1.8;
      this.orbitPitch -= dy * 0.0018 + sy * dt * 1.15;
      this.manualIdle = 0;
    } else {
      this.manualIdle += dt;
      if (this.manualIdle > 1.15) {
        this.orbitYaw *= Math.exp(-2.5 * dt);
        this.orbitPitch *= Math.exp(-2.8 * dt);
      }
    }
    this.orbitYaw = clamp(this.orbitYaw, -Math.PI * 0.82, Math.PI * 0.82);
    this.orbitPitch = clamp(this.orbitPitch, -0.22, 0.46);
  }

  update(dt, context = {}, snap = false) {
    const { vehicle, profile, input = {}, reducedMotion = false, analyzer, aspect = 16 / 9 } = context;
    this._updateFreelook(dt, input);
    const speed = Math.max(0, Number(vehicle.speed) || 0);
    const speedRatio = clamp(speed / Math.max(1, Number(vehicle.maxSpeed) || 30), 0, 1.25);
    const velocityYaw = Math.atan2(vehicle.velocity.x || 0, vehicle.velocity.z || 0);
    const moving = Math.hypot(vehicle.velocity.x || 0, vehicle.velocity.z || 0) > 0.6;
    const slip = clamp(Math.abs(vehicle.lateralSpeed || 0) / 8, 0, 1);
    const driftBlend = profile.chaseDriftVelocityBlend * Math.max(slip, vehicle.drifting ? 0.45 : 0);
    const heading = (vehicle.yaw || 0) + (moving ? normalizeAngle(velocityYaw - (vehicle.yaw || 0)) * driftBlend : 0);
    const orbit = input.lookBack ? Math.PI : this.orbitYaw;
    const viewYaw = heading + orbit;
    const forwardX = Math.sin(viewYaw);
    const forwardZ = Math.cos(viewYaw);
    const distance = clamp(
      profile.chaseDistance + speed * profile.chaseSpeedDistanceMultiplier,
      profile.chaseMinDistance,
      profile.chaseMaxDistance,
    );
    const fov = clamp(
      profile.chaseBaseFov + speedRatio * 10.5 + (vehicle.boosting ? 2.2 : 0),
      profile.chaseBaseFov,
      profile.chaseMaxFov,
    );
    const altitude = Math.max(0, vehicle.position.y - (vehicle.groundHeight || 0));
    const verticalLead = clamp((vehicle.velocity.y || 0) * 0.12, -0.8, 1.5);
    const lead = clamp(speed * 0.12, 0, vehicle.monster ? 4.2 : 3.2);
    this.focus.set(
      vehicle.position.x + Math.sin(heading) * lead,
      vehicle.position.y + profile.chaseLookHeight + verticalLead,
      vehicle.position.z + Math.cos(heading) * lead,
    );
    const height = profile.chaseHeight + clamp(altitude * 0.24, 0, vehicle.monster ? 3.2 : 2.2)
      + Math.sin(this.orbitPitch) * distance;
    this.desiredPosition.set(
      vehicle.position.x - forwardX * distance,
      vehicle.position.y + height,
      vehicle.position.z - forwardZ * distance,
    );
    const resolved = this.collision.resolve(
      this.focus,
      this.desiredPosition,
      profile.chaseCollisionRadius,
      profile.chaseMinDistance,
      dt,
      (x, z) => analyzer.groundHeightAtWorld(x, z, vehicle.groundHeight || 0),
      { fov, aspect },
    );
    const positionRate = vehicle.grounded ? profile.chasePositionDamping : profile.chasePositionDamping * 0.62;
    if (!this.initialized || snap) {
      this.position.copy(resolved);
      lookQuaternion(this.position, this.focus, 0, this.quaternion);
      this.initialized = true;
    } else {
      this.position.lerp(resolved, expAlpha(positionRate, dt));
      // A moving truck can sweep across the already-smoothed camera between
      // boom casts. Escape immediately; damping is for composition, not for
      // allowing a frame from inside opaque cargo geometry.
      if (this.collision.positionBlocker(this.position, profile.chaseCollisionRadius * 0.82)) {
        this.position.copy(resolved);
      }
      const horizonCoupling = 1 - profile.chaseHorizonStability;
      const dynamicRoll = reducedMotion
        ? 0
        : clamp(
            (vehicle.roll || 0) * horizonCoupling * 0.44 - (vehicle.lateralSpeed || 0) * 0.0018,
            -0.045,
            0.045,
          );
      lookQuaternion(this.position, this.focus, dynamicRoll, this.desiredQuaternion);
      const currentViewBlocked = this.collision.foregroundBlocker(this.position, this.focus, 7, this.quaternion, fov, aspect);
      if (currentViewBlocked || this.collision.lifted || this.collision.foregroundBlocked || this.collision.lowerFrustumBlocked) {
        this.quaternion.copy(this.desiredQuaternion);
      } else {
        this.quaternion.slerp(this.desiredQuaternion, expAlpha(profile.chaseRotationDamping, dt));
      }
    }
    return {
      projection: 'perspective',
      position: this.position,
      quaternion: this.quaternion,
      focus: this.focus,
      fov,
      equivalentFov: fov,
      near: 0.1,
      far: 800,
      effects: {
        chromatic: reducedMotion ? 0 : 0.00075 + (vehicle.boosting ? 0.0017 : 0),
        bloom: 0.36 + (vehicle.boosting ? 0.18 : 0) + clamp(altitude / 80, 0, 0.12),
        collision: this.collision.snapshot(),
      },
    };
  }
}
