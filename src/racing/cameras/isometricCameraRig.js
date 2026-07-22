import * as THREE from 'three';
import { clamp, equivalentVerticalFov, expAlpha, lookQuaternion } from './cameraRigMath.js';

const STANDARD = Object.freeze({ offset: 22, height: 34, frustum: 16.5, lookAtBase: 0.72 });
const MONSTER = Object.freeze({ offset: 27, height: 41, frustum: 20.5, lookAtBase: 1.2 });

export class IsometricCameraRig {
  constructor() {
    this.position = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.desiredFocus = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.initialized = false;
  }

  reset() {
    this.initialized = false;
  }

  update(dt, context = {}, snap = false) {
    const { vehicle, session, reducedMotion = false } = context;
    const fx = session?.cameraFx || { shake: 0, roll: 0, punch: 0, phase: 0 };
    const speed = Math.max(0, Number(vehicle.speed) || 0);
    const speedRatio = clamp(speed / Math.max(1, vehicle.maxSpeed || 30), 0, 1.2);
    const air = clamp((vehicle.position.y - (vehicle.groundHeight || 0)) / (vehicle.monster ? 14 : 10), 0, 1.25);
    const shake = reducedMotion ? 0 : fx.shake * (vehicle.monster ? 0.82 : 0.62);
    const shakeX = Math.sin(fx.phase * 1.17) * shake;
    const shakeY = Math.sin(fx.phase * 1.91 + 1.2) * shake * 0.62;
    const shakeZ = Math.cos(fx.phase * 1.43 + 0.4) * shake;
    let frustum;
    let damping;
    let roll;

    if (vehicle.trials) {
      // Trials is deliberately a 2.5D side-scroller: keep the lens close to the
      // rider's height so jumps read against the painted horizon rather than a
      // top-down track. Chase remains available as an optional camera mode.
      const depth = vehicle.profileId === 'pocket_pouncer' ? 38 : 41;
      const height = 2.85 + speedRatio * 0.42 + clamp(air * 0.12, 0, 0.42);
      const lookAhead = clamp((vehicle.velocity.x || 0) * 0.27, -3, 9.5);
      this.focus.set(
        vehicle.position.x + lookAhead + shakeX * 0.35,
        vehicle.position.y - vehicle.rideHeight * 0.38 + 1.35 + shakeY * 0.28,
        vehicle.position.z,
      );
      this.desiredPosition.set(
        vehicle.position.x + lookAhead + shakeX,
        vehicle.position.y - vehicle.rideHeight * 0.38 + height + shakeY,
        vehicle.position.z + depth + shakeZ,
      );
      frustum = 10.8 + speedRatio * 1.25 + clamp(air * 0.18, 0, 1.2) - fx.punch * 0.55;
      damping = vehicle.grounded ? 10.8 : 6.6;
      roll = reducedMotion ? 0 : fx.roll + clamp((vehicle.pitchVelocity || 0) * 0.0022, -0.018, 0.018);
    } else {
      const base = vehicle.monster ? MONSTER : STANDARD;
      const velocityLength = Math.hypot(vehicle.velocity.x || 0, vehicle.velocity.z || 0);
      const leadX = velocityLength > 0.4 ? vehicle.velocity.x / velocityLength : Math.sin(vehicle.yaw || 0);
      const leadZ = velocityLength > 0.4 ? vehicle.velocity.z / velocityLength : Math.cos(vehicle.yaw || 0);
      const cameraLead = clamp(speed * 0.2, 0, vehicle.monster ? 5.2 : 5.4);
      const cameraLift = vehicle.monster ? 0.62 : 0.25;
      const targetX = vehicle.position.x + leadX * cameraLead;
      const targetY = vehicle.position.y * cameraLift;
      const targetZ = vehicle.position.z + leadZ * cameraLead;
      const offset = base.offset + speedRatio * (vehicle.monster ? 3.6 : 3.1);
      const height = base.height + speedRatio * (vehicle.monster ? 4.2 : 3.4) + air * (vehicle.monster ? 4.4 : 3.2);
      this.desiredPosition.set(targetX + offset + shakeX, height + shakeY, targetZ + offset + shakeZ);
      this.focus.set(
        targetX + shakeX * 0.28,
        base.lookAtBase + targetY + speedRatio * 0.28 + shakeY * 0.2,
        targetZ + shakeZ * 0.28,
      );
      frustum = (base.frustum + speedRatio * (vehicle.monster ? 2.2 : 1.65) + air * 1.6 - fx.punch * 0.72)
        * (session?.qaFrustumScale || 1);
      damping = vehicle.grounded ? 11.2 : 7.3;
      roll = reducedMotion ? 0 : fx.roll + clamp(-(vehicle.lateralSpeed || 0) * 0.0014, -0.018, 0.018);
    }

    if (!this.initialized || snap) {
      this.position.copy(this.desiredPosition);
      this.initialized = true;
    } else {
      this.position.lerp(this.desiredPosition, expAlpha(damping, dt));
    }
    lookQuaternion(this.position, this.focus, roll, this.quaternion);
    frustum = Math.max(4, frustum);
    return {
      projection: 'orthographic',
      position: this.position,
      quaternion: this.quaternion,
      focus: this.focus,
      frustum,
      equivalentFov: equivalentVerticalFov(this.position, this.focus, frustum),
      near: 0.1,
      far: 800,
      effects: {
        chromatic: reducedMotion ? 0 : 0.0008 + (vehicle.boosting ? 0.0014 : 0) + fx.shake * 0.00075,
        bloom: 0.34 + (vehicle.boosting ? 0.16 : 0) + clamp(vehicle.position.y / 20, 0, 0.12),
        shake: reducedMotion ? 0 : fx.shake,
      },
    };
  }
}
