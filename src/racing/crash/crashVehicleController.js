import { CRASH_COLLISION, crashInteractionGroups } from './crashConfig.js';

export const CRASH_WHEEL_ORDER = Object.freeze([
  'left-front-wheel',
  'right-front-wheel',
  'left-rear-wheel',
  'right-rear-wheel',
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function rotateVector(vector, quaternion) {
  const { x, y, z } = vector;
  const qx = quaternion.x; const qy = quaternion.y; const qz = quaternion.z; const qw = quaternion.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

function inverseRotateVector(vector, quaternion) {
  return rotateVector(vector, { x: -quaternion.x, y: -quaternion.y, z: -quaternion.z, w: quaternion.w });
}

function multiplyQuaternion(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function socketFor(profile, name) {
  const key = name.replace(/-wheel$/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return profile.wheelSockets?.[key] || null;
}

function suspensionFor(profile) {
  return profile.suspension || {
    hardPointY: -profile.height * 0.18,
    restLength: profile.height * 0.2,
    travel: profile.height * 0.12,
    springRate: profile.suspensionStiffness || 38,
    compressionDamping: profile.suspensionCompression || 4.8,
    reboundDamping: profile.suspensionRelaxation || 5.7,
    maximumForce: profile.mass * 8,
    antiRollStiffness: profile.mass * 5,
    antiPitchStiffness: profile.mass * 1.5,
    antiPitchDamping: profile.mass * 0.5,
    tractionAssist: 0.12,
  };
}

export function createCrashVehicleController(runtime, entity, profile) {
  if (!runtime?.world || !entity?.body) throw new Error('Crash vehicle controller needs a Rapier chassis');
  const controller = runtime.world.createVehicleController(entity.body);
  controller.indexUpAxis = 1;
  // Rapier 0.19.3 exposes this as a setter-only property (despite its method-
  // shaped name); assigning it is the pinned API contract.
  controller.setIndexForwardAxis = 2;
  const suspension = suspensionFor(profile);
  const radius = profile.wheelRadius || Math.max(0.32, Math.min(0.48, profile.height * 0.26));
  const halfTrack = (profile.track || profile.width * 0.84) * 0.5;
  const halfWheelbase = (profile.wheelbase || profile.length * 0.62) * 0.5;
  const fallback = [
    { x: -halfTrack, y: suspension.hardPointY, z: halfWheelbase },
    { x: halfTrack, y: suspension.hardPointY, z: halfWheelbase },
    { x: -halfTrack, y: suspension.hardPointY, z: -halfWheelbase },
    { x: halfTrack, y: suspension.hardPointY, z: -halfWheelbase },
  ];
  const descriptors = CRASH_WHEEL_ORDER.map((name, index) => socketFor(profile, name) || fallback[index]);
  for (const socket of descriptors) {
    controller.addWheel(
      socket,
      { x: 0, y: -1, z: 0 },
      { x: -1, y: 0, z: 0 },
      suspension.restLength,
      radius,
    );
  }
  for (let index = 0; index < 4; index++) {
    controller.setWheelSuspensionStiffness(index, suspension.springRate);
    controller.setWheelSuspensionCompression(index, suspension.compressionDamping);
    controller.setWheelSuspensionRelaxation(index, suspension.reboundDamping);
    controller.setWheelMaxSuspensionTravel(index, suspension.travel);
    controller.setWheelMaxSuspensionForce(index, suspension.maximumForce);
    controller.setWheelFrictionSlip(index, profile.grip * 82);
    controller.setWheelSideFrictionStiffness(index, profile.grip * 1.15);
  }
  runtime.controllers.add(controller);
  entity.vehicleController = controller;
  entity.wheelRadius = radius;
  entity.suspensionProfile = suspension;
  entity.suspensionRestLength = suspension.restLength;
  bindCrashWheelVisuals(entity);
  entity.drivingAssistBlend = 1;
  return controller;
}

export function bindCrashWheelVisuals(entity) {
  entity.wheelVisualBindings = CRASH_WHEEL_ORDER.map((name) => (
    entity.visual?.parts?.get?.(name)
    || entity.visual?.root?.getObjectByName?.(name)
    || null
  ));
  return entity.wheelVisualBindings;
}

function applyAntiRoll(body, controller, suspension, dt, assist) {
  if (assist <= 0) return;
  for (const [left, right] of [[0, 1], [2, 3]]) {
    if (!controller.wheelIsInContact(left) || !controller.wheelIsInContact(right)) continue;
    const leftLength = controller.wheelSuspensionLength(left);
    const rightLength = controller.wheelSuspensionLength(right);
    const leftPoint = controller.wheelHardPoint(left);
    const rightPoint = controller.wheelHardPoint(right);
    if (![leftLength, rightLength, leftPoint?.x, rightPoint?.x].every(Number.isFinite)) continue;
    const compressionDifference = rightLength - leftLength;
    const force = clamp(
      compressionDifference * suspension.antiRollStiffness * assist,
      -suspension.maximumForce * 0.34,
      suspension.maximumForce * 0.34,
    );
    body.applyImpulseAtPoint({ x: 0, y: force * dt, z: 0 }, leftPoint, true);
    body.applyImpulseAtPoint({ x: 0, y: -force * dt, z: 0 }, rightPoint, true);
  }
}

function applyAntiPitch(body, suspension, dt, assist) {
  if (assist <= 0) return 0;
  const rotation = body.rotation();
  const forward = rotateVector({ x: 0, y: 0, z: 1 }, rotation);
  const pitch = Math.asin(clamp(forward.y, -1, 1));
  const right = rotateVector({ x: 1, y: 0, z: 0 }, rotation);
  const angular = body.angvel();
  const pitchRate = angular.x * right.x + angular.y * right.y + angular.z * right.z;
  const torqueImpulse = clamp(
    (-pitch * suspension.antiPitchStiffness - pitchRate * suspension.antiPitchDamping) * assist * dt,
    -suspension.antiPitchStiffness * dt * 0.24,
    suspension.antiPitchStiffness * dt * 0.24,
  );
  body.applyTorqueImpulse({ x: right.x * torqueImpulse, y: right.y * torqueImpulse, z: right.z * torqueImpulse }, true);
  return pitch;
}

export function stepCrashVehicleController(runtime, entity, controls, dt) {
  const controller = entity?.vehicleController;
  const body = entity?.body;
  const profile = entity?.playerProfile;
  if (!controller || !body || !profile) return null;
  const throttle = clamp(controls?.throttle, -1, 1);
  const steerInput = clamp((Number(controls?.steer) || 0) + (entity.damage?.steeringPull || 0), -1, 1);
  const speed = controller.currentVehicleSpeed();
  const absoluteSpeed = Math.abs(speed);
  const speedRatio = Math.min(1, absoluteSpeed / Math.max(1, profile.maxSpeed));
  const steerAngle = steerInput * profile.steer * (entity.damage?.steeringScale ?? 1) * (1 - speedRatio * 0.52);
  const powerScale = entity.damage?.powerScale ?? 1;
  const brakeScale = entity.damage?.brakeScale ?? 1;
  const wantsBrake = (speed > 1 && throttle < -0.05) || (speed < -1 && throttle > 0.05) || controls?.brake;
  const capped = absoluteSpeed >= profile.maxSpeed && Math.sign(speed) === Math.sign(throttle);
  const groundedBefore = [0, 1, 2, 3].filter((index) => controller.wheelIsInContact(index)).length;
  const frontGrounded = Number(controller.wheelIsInContact(0)) + Number(controller.wheelIsInContact(1));
  const assistanceTarget = !entity.drivingAssistSuppressed && groundedBefore >= 3 ? 1 : 0;
  const assistanceRate = assistanceTarget > entity.drivingAssistBlend ? 2.8 : 9;
  entity.drivingAssistBlend += clamp(assistanceTarget - entity.drivingAssistBlend, -assistanceRate * dt, assistanceRate * dt);
  const tractionScale = 1 - entity.drivingAssistBlend * (profile.suspension?.tractionAssist || 0) * Math.max(0, 2 - frontGrounded) * 0.5;
  const engine = capped || wantsBrake ? 0 : throttle * profile.engineForce * powerScale * tractionScale;
  const driveBias = profile.driveBias || { front: 0.5, rear: 0.5 };
  const brakeBias = profile.brakeBias || { front: 0.6, rear: 0.4 };
  for (let index = 0; index < 4; index++) {
    const front = index < 2;
    const wheelName = CRASH_WHEEL_ORDER[index];
    const detached = entity.damage?.detached?.has?.(wheelName) || false;
    const axleDamage = entity.damage?.axleDamage?.[front ? 'front' : 'rear'] || 0;
    const axleDrive = front ? driveBias.front : driveBias.rear;
    const axleBrake = front ? brakeBias.front : brakeBias.rear;
    controller.setWheelEngineForce(index, detached ? 0 : engine * axleDrive * 0.5 * (1 - axleDamage * 0.38));
    controller.setWheelBrake(index, detached ? 0 : wantsBrake
      ? profile.brakeForce * brakeScale * axleBrake * 0.5
      : controls?.handbrake && !front ? profile.brakeForce * 0.38 : 0);
    controller.setWheelSteering(index, index < 2 && !detached ? steerAngle : 0);
    controller.setWheelFrictionSlip(index, detached ? 1.5 : profile.grip * (1 - axleDamage * 0.42) * (controls?.handbrake && index >= 2 ? 16 : 82));
  }
  controller.updateVehicle(
    dt,
    undefined,
    crashInteractionGroups(CRASH_COLLISION.PLAYER),
  );

  const angular = body.angvel();
  const grounded = [0, 1, 2, 3].filter((index) => controller.wheelIsInContact(index)).length;
  let pitch = 0;
  if (grounded >= 2) {
    const yawDamping = Math.max(0.25, 1 - dt * (2.8 - Math.abs(steerInput) * 1.25));
    body.setAngvel({ x: angular.x * (1 - dt * 2.4), y: angular.y * yawDamping, z: angular.z * (1 - dt * 2.4) }, true);
    const velocity = body.linvel();
    const downforce = Math.min(profile.mass * 3, Math.hypot(velocity.x, velocity.z) ** 2 * profile.mass * 0.0012);
    // `addForce` persists in Rapier until forces are reset; using it every
    // substep accumulated downforce and eventually pinned the chassis to the
    // road. A timestep-scaled impulse is the intended one-step aero load.
    body.applyImpulse({ x: 0, y: -downforce * dt, z: 0 }, true);
    applyAntiRoll(body, controller, entity.suspensionProfile, dt, entity.drivingAssistBlend);
    pitch = applyAntiPitch(body, entity.suspensionProfile, dt, entity.drivingAssistBlend);
  }
  entity.cameraState = {
    speed: absoluteSpeed,
    grounded: grounded > 0,
    groundedWheels: grounded,
    steer: steerAngle,
    pitch,
    assistance: entity.drivingAssistBlend,
    wheelRotation: [0, 1, 2, 3].map((index) => controller.wheelRotation(index) || 0),
    suspension: [0, 1, 2, 3].map((index) => controller.wheelSuspensionLength(index) ?? entity.suspensionRestLength),
    wheelContacts: [0, 1, 2, 3].map((index) => {
      const hardPoint = controller.wheelHardPoint(index);
      const contactPoint = controller.wheelContactPoint(index);
      return {
        hardPoint: hardPoint ? { x: hardPoint.x, y: hardPoint.y, z: hardPoint.z } : null,
        contactPoint: contactPoint ? { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z } : null,
        inContact: controller.wheelIsInContact(index),
      };
    }),
  };
  return entity.cameraState;
}

export function syncCrashWheelVisuals(entity) {
  const wheels = entity?.wheelVisualBindings || [];
  const controller = entity?.vehicleController;
  const root = entity?.visual?.root;
  if (!controller || !root) return;
  for (let index = 0; index < Math.min(4, wheels.length); index++) {
    const wheel = wheels[index];
    const hardPoint = controller.wheelHardPoint(index);
    const length = controller.wheelSuspensionLength(index);
    const direction = controller.wheelDirectionCs(index);
    if (!wheel || !hardPoint || !direction || !Number.isFinite(length)) continue;
    const localHardPoint = inverseRotateVector({
      x: hardPoint.x - root.position.x,
      y: hardPoint.y - root.position.y,
      z: hardPoint.z - root.position.z,
    }, root.quaternion);
    wheel.position.set(
      localHardPoint.x + direction.x * length,
      localHardPoint.y + direction.y * length,
      localHardPoint.z + direction.z * length,
    );
    wheel.userData.crashBaseQuaternion ||= {
      x: wheel.quaternion.x, y: wheel.quaternion.y, z: wheel.quaternion.z, w: wheel.quaternion.w,
    };
    const steerHalf = (controller.wheelSteering(index) || 0) * 0.5;
    const spinHalf = (controller.wheelRotation(index) || 0) * 0.5;
    const steer = { x: 0, y: Math.sin(steerHalf), z: 0, w: Math.cos(steerHalf) };
    const spin = { x: Math.sin(spinHalf), y: 0, z: 0, w: Math.cos(spinHalf) };
    const oriented = multiplyQuaternion(multiplyQuaternion(steer, spin), wheel.userData.crashBaseQuaternion);
    wheel.quaternion.set(oriented.x, oriented.y, oriented.z, oriented.w);
  }
}

export function disposeCrashVehicleController(runtime, entity) {
  const controller = entity?.vehicleController;
  if (!controller || !runtime?.world) return false;
  try { runtime.world.removeVehicleController(controller); } catch (_) {}
  runtime.controllers.delete(controller);
  entity.vehicleController = null;
  return true;
}
