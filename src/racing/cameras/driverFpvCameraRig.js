import * as THREE from 'three';
import { expAlpha, lookQuaternion } from './cameraRigMath.js';
import { RacingVisionController } from './racingVisionController.js';

export class DriverFpvCameraRig {
  constructor() {
    this.vision = new RacingVisionController();
    this.position = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.lookTarget = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.initialized = false;
    this.lastVision = null;
  }

  reset() {
    this.initialized = false;
    this.vision.reset();
    this.lastVision = null;
  }

  update(dt, context = {}, snap = false) {
    const { vehicle, profile, input = {}, reducedMotion = false, analyzer, session } = context;
    const eye = profile.fpvEyePosition;
    const yaw = vehicle.yaw || 0;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const suspension = (Number(vehicle.suspensionOffset) || 0) * profile.fpvSuspensionMotion;
    const impact = reducedMotion ? 0 : (Number(vehicle.impactStrength) || 0) * profile.fpvCollisionMotion;
    const phase = Number(session?.cameraFx?.phase) || 0;
    this.desiredPosition.set(
      vehicle.position.x + rightX * eye.x + forwardX * eye.z + Math.sin(phase * 1.7) * impact * 0.035,
      vehicle.position.y + eye.y + suspension + Math.sin(phase * 2.3 + 0.8) * impact * 0.045,
      vehicle.position.z + rightZ * eye.x + forwardZ * eye.z + Math.cos(phase * 1.5) * impact * 0.035,
    );
    const visionResult = this.vision.update(dt, {
      vehicle,
      eye: this.desiredPosition,
      analyzer,
      profile,
      input,
      reducedMotion,
    });
    this.lastVision = visionResult.vision;
    if (!this.initialized || snap) {
      this.position.copy(this.desiredPosition);
      this.initialized = true;
    } else {
      const damping = vehicle.grounded ? profile.fpvPositionDamping : profile.fpvPositionDamping * 0.66;
      this.position.lerp(this.desiredPosition, expAlpha(damping, dt));
    }
    const cosPitch = Math.cos(visionResult.pitch);
    this.lookTarget.set(
      this.position.x + Math.sin(visionResult.yaw) * cosPitch,
      this.position.y + Math.sin(visionResult.pitch),
      this.position.z + Math.cos(visionResult.yaw) * cosPitch,
    );
    lookQuaternion(this.position, this.lookTarget, visionResult.roll, this.quaternion);
    return {
      projection: 'perspective',
      position: this.position,
      quaternion: this.quaternion,
      focus: this.lookTarget,
      fov: visionResult.fov,
      equivalentFov: visionResult.fov,
      near: 0.055,
      far: 800,
      vision: visionResult.vision,
      effects: {
        chromatic: reducedMotion ? 0 : 0.00055 + (vehicle.boosting ? 0.00125 : 0) + impact * 0.0004,
        bloom: 0.32 + (vehicle.boosting ? 0.15 : 0),
        visionStage: visionResult.vision?.stage || 'straight',
        lookAheadMeters: visionResult.vision?.lookAheadMeters || 0,
        automaticYaw: visionResult.automaticYaw,
        manualYaw: visionResult.manualYaw,
      },
    };
  }
}
