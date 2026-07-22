import * as THREE from 'three';

const LOOK_MATRIX = new THREE.Matrix4();
const ROLL_QUATERNION = new THREE.Quaternion();
const CAMERA_FORWARD = new THREE.Vector3(0, 0, -1);

export function expAlpha(rate, dt) {
  return 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
}
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeAngle(angle) {
  let wrapped = (angle + Math.PI) % (Math.PI * 2);
  if (wrapped < 0) wrapped += Math.PI * 2;
  return wrapped - Math.PI;
}

export function lookQuaternion(position, target, roll = 0, out = new THREE.Quaternion()) {
  LOOK_MATRIX.lookAt(position, target, THREE.Object3D.DEFAULT_UP);
  out.setFromRotationMatrix(LOOK_MATRIX);
  if (roll) {
    ROLL_QUATERNION.setFromAxisAngle(CAMERA_FORWARD, roll);
    out.multiply(ROLL_QUATERNION);
  }
  return out;
}

export function equivalentVerticalFov(position, focus, halfHeight) {
  const distance = Math.max(0.1, position.distanceTo(focus));
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.max(0.1, halfHeight) / distance));
}

export function setPerspectiveFrame(camera, frame, aspect) {
  camera.position.copy(frame.position);
  camera.quaternion.copy(frame.quaternion);
  camera.fov = frame.fov;
  camera.aspect = Math.max(0.1, Number(aspect) || 16 / 9);
  camera.near = frame.near ?? 0.08;
  camera.far = frame.far ?? 800;
  camera.updateProjectionMatrix();
}

export function setOrthographicFrame(camera, frame, aspect) {
  camera.position.copy(frame.position);
  camera.quaternion.copy(frame.quaternion);
  const half = Math.max(1, frame.frustum);
  const useAspect = Math.max(0.1, Number(aspect) || 16 / 9);
  camera.left = -half * useAspect;
  camera.right = half * useAspect;
  camera.top = half;
  camera.bottom = -half;
  camera.near = frame.near ?? 0.1;
  camera.far = frame.far ?? 800;
  camera.updateProjectionMatrix();
}
