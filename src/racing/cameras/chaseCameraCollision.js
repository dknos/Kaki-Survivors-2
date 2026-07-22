import * as THREE from 'three';
import { expAlpha } from './cameraRigMath.js';

const IGNORE_NAME = /(ground|surface|basin|shoulder|sky|haze|backdrop|tire-wear|edge-paint|shadow|particle|decal|finish-line|track-art|crowd|audience|spectator|flag|confetti)/i;
const IGNORE_ROLE = new Set([
  'driver', 'ground-shadow', 'boost-flame', 'decal-panel',
  'primary-road', 'road-marking', 'road-wear', 'lane-reflector',
  'sidewalk', 'gutter', 'curb', 'drain', 'atmosphere',
]);
const BOOM_OFFSETS = Object.freeze([
  Object.freeze([0, 0, false]),
  Object.freeze([1, 0.22, false]),
  Object.freeze([-1, 0.22, false]),
  Object.freeze([0, 0.85, false]),
  Object.freeze([0, -1.8, true]),
  Object.freeze([0.82, -1.35, true]),
  Object.freeze([-0.82, -1.35, true]),
]);
const FOREGROUND_X = Object.freeze([-0.75, -0.38, 0, 0.38, 0.75]);
const FOREGROUND_Y = Object.freeze([-0.94, -0.78, -0.58, -0.34]);

function hasExcludedAncestor(object, excluded) {
  const explicitBlocker = object.userData?.cameraBlocker === true;
  let cursor = object;
  while (cursor) {
    if (excluded.has(cursor)) return true;
    if (!explicitBlocker && cursor.userData?.cameraIgnore) return true;
    if (IGNORE_ROLE.has(cursor.userData?.role)) return true;
    cursor = cursor.parent;
  }
  return false;
}

function hierarchyVisible(object, stop) {
  const hiddenCollisionProxy = object.userData?.cameraBlocker === true && object.visible === false;
  let cursor = object;
  while (cursor && cursor !== stop) {
    if (!cursor.visible && !(hiddenCollisionProxy && cursor === object)) return false;
    cursor = cursor.parent;
  }
  return true;
}

function materialCanBlock(material) {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((entry) => entry && entry.visible !== false && (!entry.transparent || entry.opacity > 0.25));
}

/** Three-ray retracting boom that keeps the Chase camera out of scenery. */
export class ChaseCameraCollision {
  constructor() {
    this.raycaster = new THREE.Raycaster();
    this.root = null;
    this.excluded = new Set();
    this.candidates = [];
    this.candidateBounds = [];
    this.refreshClock = 0;
    this.resolvedDistance = null;
    this.blocked = false;
    this.lastHitName = '';
    this.lifted = false;
    this.lowerFrustumBlocked = false;
    this.foregroundBlocked = false;
    this.foregroundObject = '';
    this.contained = false;
    this.containingObject = '';
    this._direction = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._resolved = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._candidatePoint = new THREE.Vector3();
    this._frustumForward = new THREE.Vector3();
    this._frustumRight = new THREE.Vector3();
    this._frustumUp = new THREE.Vector3();
    this._frustumDirection = new THREE.Vector3();
    this._foregroundCandidates = [];
    this._boomCandidates = [];
    this._queryCenter = new THREE.Vector3();
    this._hits = [];
    this._boundsReady = false;
    this._raycasts = 0;
    this._activeBounds = 0;
    this._testRight = new THREE.Vector3();
    this._testUp = new THREE.Vector3();
    this._liftedDesired = new THREE.Vector3();
    this._solutions = Array.from({ length: 4 }, () => ({
      direction: new THREE.Vector3(),
      distance: 0,
      permitted: 0,
      hitName: '',
      ratio: 1,
      lowerFrustumBlocked: false,
      foreground: null,
      blocker: null,
      lift: 0,
    }));
  }

  bind(root, excludedRoots = []) {
    this.root = root || null;
    this.excluded = new Set(excludedRoots.filter(Boolean));
    this.refresh();
    this.reset();
  }

  reset() {
    this.resolvedDistance = null;
    this.blocked = false;
    this.lastHitName = '';
    this.lifted = false;
    this.lowerFrustumBlocked = false;
    this.foregroundBlocked = false;
    this.foregroundObject = '';
    this.contained = false;
    this.containingObject = '';
  }

  _firstValidHit() {
    for (let i = 0; i < this._hits.length; i++) {
      const hit = this._hits[i];
      if (hierarchyVisible(hit.object, this.root) && !hasExcludedAncestor(hit.object, this.excluded)) return hit;
    }
    return null;
  }

  /** Update blocker world bounds once, then reuse them for every probe ray. */
  _syncCandidateBounds(force = false) {
    if (this._boundsReady && !force) return;
    this._boundsReady = true;
    this._activeBounds = 0;
    for (let i = 0; i < this.candidateBounds.length; i++) {
      const record = this.candidateBounds[i];
      const object = record.object;
      record.active = false;
      if (!hierarchyVisible(object, this.root) || hasExcludedAncestor(object, this.excluded)) continue;
      const geometry = object.geometry;
      if (!geometry) continue;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere;
      if (!sphere) continue;
      object.updateWorldMatrix?.(true, false);
      const elements = object.matrixWorld.elements;
      const scaleX = Math.hypot(elements[0], elements[1], elements[2]);
      const scaleY = Math.hypot(elements[4], elements[5], elements[6]);
      const scaleZ = Math.hypot(elements[8], elements[9], elements[10]);
      record.maximumScale = Math.max(scaleX, scaleY, scaleZ);
      record.minimumScale = Math.max(0.0001, Math.min(scaleX, scaleY, scaleZ));
      record.radius = sphere.radius * record.maximumScale;
      record.center.copy(sphere.center).applyMatrix4(object.matrixWorld);
      record.active = Number.isFinite(record.radius);
      if (record.active) this._activeBounds += 1;
    }
  }

  /**
   * Ray casts cannot report a mesh that already encloses the camera when its
   * material is front-face culled. This bounded local-space test closes that
   * hole for vehicle-sized meshes without treating a district-wide batch AABB
   * as a solid wall.
   */
  positionBlocker(point, radius = 0.1) {
    this._syncCandidateBounds();
    for (let i = 0; i < this.candidateBounds.length; i++) {
      const record = this.candidateBounds[i];
      if (!record.active) continue;
      const object = record.object;
      const geometry = object.geometry;
      if (!geometry) continue;
      const worldRadius = record.radius;
      // Huge joined landmark/building batches are intentionally concave. Their
      // broad bounds are not a valid occupancy test; boom rays still handle them.
      if (!Number.isFinite(worldRadius) || worldRadius > 18) continue;
      const broadRadius = worldRadius + radius;
      if (record.center.distanceToSquared(point) > broadRadius * broadRadius) continue;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox) continue;
      this._probe.copy(point);
      object.worldToLocal(this._probe);
      const localRadius = radius / record.minimumScale;
      const box = geometry.boundingBox;
      if (this._probe.x >= box.min.x - localRadius && this._probe.x <= box.max.x + localRadius
        && this._probe.y >= box.min.y - localRadius && this._probe.y <= box.max.y + localRadius
        && this._probe.z >= box.min.z - localRadius && this._probe.z <= box.max.z + localRadius) {
        return object;
      }
    }
    return null;
  }

  /**
   * Probe the part of the chase view that a center-line spring arm cannot see.
   * Wrecks beside the boom can still fill the lower corners of the image, so
   * cast a compact set of camera-space rays matching that foreground region.
   */
  foregroundBlocker(cameraPoint, focus, far = 7, cameraQuaternion = null, fov = 72, aspect = 16 / 9) {
    if (!this.candidates.length) return null;
    this._syncCandidateBounds();
    if (cameraQuaternion) {
      this._frustumForward.set(0, 0, -1).applyQuaternion(cameraQuaternion).normalize();
      this._frustumRight.set(1, 0, 0).applyQuaternion(cameraQuaternion).normalize();
      this._frustumUp.set(0, 1, 0).applyQuaternion(cameraQuaternion).normalize();
    } else {
      this._frustumForward.copy(focus).sub(cameraPoint);
      const focusDistance = this._frustumForward.length();
      if (focusDistance < 0.01) return null;
      this._frustumForward.multiplyScalar(1 / focusDistance);
      this._frustumRight.crossVectors(this._frustumForward, THREE.Object3D.DEFAULT_UP);
      if (this._frustumRight.lengthSq() < 0.001) this._frustumRight.set(1, 0, 0);
      else this._frustumRight.normalize();
      this._frustumUp.crossVectors(this._frustumRight, this._frustumForward).normalize();
    }
    this._foregroundCandidates.length = 0;
    const probeFar = Math.max(0.1, Math.min(Number(far) || 7, 7));
    for (let i = 0; i < this.candidateBounds.length; i++) {
      const record = this.candidateBounds[i];
      if (!record.active) continue;
      const broadRadius = probeFar + record.radius;
      if (record.center.distanceToSquared(cameraPoint) <= broadRadius * broadRadius) {
        this._foregroundCandidates.push(record.object);
      }
    }
    // This is the common open-track case. Raycaster still traverses every
    // supplied geometry, so avoiding twenty guaranteed misses is material.
    if (!this._foregroundCandidates.length) return null;
    const tangentY = Math.tan(THREE.MathUtils.degToRad(Math.max(20, Number(fov) || 72) * 0.5));
    const tangentX = tangentY * Math.max(0.1, Number(aspect) || 16 / 9);
    for (let yIndex = 0; yIndex < FOREGROUND_Y.length; yIndex++) {
      const y = FOREGROUND_Y[yIndex];
      for (let xIndex = 0; xIndex < FOREGROUND_X.length; xIndex++) {
        const x = FOREGROUND_X[xIndex];
        this._frustumDirection.copy(this._frustumForward)
          .addScaledVector(this._frustumRight, x * tangentX)
          .addScaledVector(this._frustumUp, y * tangentY)
          .normalize();
        this.raycaster.set(cameraPoint, this._frustumDirection);
        this.raycaster.near = 0.1;
        this.raycaster.far = probeFar;
        this._hits.length = 0;
        this._raycasts += 1;
        this.raycaster.intersectObjects(this._foregroundCandidates, false, this._hits);
        const hit = this._firstValidHit();
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Cull the full scene list to blockers near the boom before triangle tests. */
  prepareBoomCandidates(focus, desired) {
    this._syncCandidateBounds();
    this._boomCandidates.length = 0;
    this._queryCenter.copy(focus).add(desired).multiplyScalar(0.5);
    const queryRadius = focus.distanceTo(desired) * 0.5 + 18;
    for (let i = 0; i < this.candidateBounds.length; i++) {
      const record = this.candidateBounds[i];
      if (!record.active) continue;
      const broadRadius = queryRadius + record.radius;
      if (record.center.distanceToSquared(this._queryCenter) <= broadRadius * broadRadius) {
        this._boomCandidates.push(record.object);
      }
    }
  }

  refresh() {
    this.candidates.length = 0;
    this.candidateBounds.length = 0;
    this._boundsReady = false;
    if (!this.root?.traverse) return;
    this.root.traverse((object) => {
      if ((!object.isMesh && !object.isInstancedMesh) || !hierarchyVisible(object, this.root)) return;
      // Raycasting an InstancedMesh checks every instance. Arena dressing uses
      // large audience, fence, prop, and structure batches, which made Chase
      // uniquely CPU-bound. Only explicitly opted-in batches may block it.
      if (object.isInstancedMesh && object.userData?.cameraBlocker !== true) return;
      if (hasExcludedAncestor(object, this.excluded)) return;
      if (object.userData?.cameraIgnore || IGNORE_ROLE.has(object.userData?.role)) return;
      if (IGNORE_NAME.test(object.name || '')) return;
      if (!object.geometry || !materialCanBlock(object.material)) return;
      this.candidates.push(object);
      this.candidateBounds.push({
        object,
        center: new THREE.Vector3(),
        radius: 0,
        minimumScale: 1,
        maximumScale: 1,
        active: false,
      });
    });
    this.refreshClock = 0;
  }

  _testBoom(candidate, result, focus, radius, minimumDistance, projection) {
    const direction = result.direction.copy(candidate).sub(focus);
    const distance = Math.max(0.001, direction.length());
    direction.multiplyScalar(1 / distance);
    const right = this._testRight.crossVectors(direction, THREE.Object3D.DEFAULT_UP);
    if (right.lengthSq() < 0.001) right.set(1, 0, 0);
    else right.normalize();
    const up = this._testUp.crossVectors(right, direction).normalize();
    let permitted = distance;
    let hitName = '';
    let lowerFrustumBlocked = false;
    const side = Math.max(0.08, radius * 0.78);
    for (let i = 0; i < BOOM_OFFSETS.length; i++) {
      if (!this._boomCandidates.length) break;
      const offset = BOOM_OFFSETS[i];
      this._offset.copy(right).multiplyScalar(side * offset[0]).addScaledVector(up, radius * offset[1]);
      this._origin.copy(focus).add(this._offset);
      this.raycaster.set(this._origin, direction);
      this.raycaster.near = 0.18;
      this.raycaster.far = distance;
      this._hits.length = 0;
      this._raycasts += 1;
      this.raycaster.intersectObjects(this._boomCandidates, false, this._hits);
      const hit = this._firstValidHit();
      const clearance = radius * (offset[2] ? 1.65 : 1);
      if (hit && hit.distance - clearance < permitted) {
        permitted = Math.max(minimumDistance, hit.distance - clearance);
        hitName = hit.object?.name || hit.object?.parent?.name || 'scenery';
        if (offset[2]) lowerFrustumBlocked = true;
      }
    }
    const cameraPoint = this._candidatePoint.copy(focus).addScaledVector(direction, permitted);
    result.distance = distance;
    result.permitted = permitted;
    result.hitName = hitName;
    result.ratio = permitted / distance;
    result.lowerFrustumBlocked = lowerFrustumBlocked;
    result.foreground = this.foregroundBlocker(cameraPoint, focus, 7, null, projection.fov, projection.aspect);
    result.blocker = null;
    return result;
  }

  resolve(focus, desired, radius, minimumDistance, dt, groundHeightAt = null, projection = {}) {
    this.refreshClock += Math.max(0, dt);
    if (this.refreshClock > 1.25) this.refresh();
    // Physics-driven traffic can move several fixed steps before rendering.
    // Synchronize each blocker once, then reuse its world-space sphere for all
    // broad phases and containment checks in this frame.
    this._boundsReady = false;
    this._raycasts = 0;
    this._syncCandidateBounds(true);
    this.prepareBoomCandidates(focus, desired);
    let solution = this._testBoom(desired, this._solutions[0], focus, radius, minimumDistance, projection);
    solution.lift = 0;
    this.lifted = false;
    this._candidatePoint.copy(focus).addScaledVector(solution.direction, solution.permitted);
    let blocker = this.positionBlocker(this._candidatePoint, radius * 0.82);
    if (solution.ratio < 0.86 || solution.lowerFrustumBlocked || solution.foreground || blocker) {
      const liftStep = Math.max(2.2, radius * 4.5);
      let clear = null;
      let uncontained = null;
      for (let multiple = 1; multiple <= 3; multiple++) {
        this._liftedDesired.copy(desired);
        this._liftedDesired.y += liftStep * multiple;
        const candidate = this._testBoom(
          this._liftedDesired,
          this._solutions[multiple],
          focus,
          radius,
          minimumDistance,
          projection,
        );
        candidate.lift = liftStep * multiple;
        this._candidatePoint.copy(focus).addScaledVector(candidate.direction, candidate.permitted);
        candidate.blocker = this.positionBlocker(this._candidatePoint, radius * 0.82);
        if (!candidate.lowerFrustumBlocked && !candidate.foreground && !candidate.blocker
          && (!clear || candidate.ratio > clear.ratio
            || (candidate.ratio === clear.ratio && candidate.lift < clear.lift))) {
          clear = candidate;
        }
        if (!candidate.blocker && (!uncontained || candidate.lift > uncontained.lift)) {
          uncontained = candidate;
        }
      }
      const lifted = clear || (blocker ? uncontained : null);
      if (lifted && (blocker || solution.lowerFrustumBlocked || solution.foreground || lifted.ratio > solution.ratio + 0.05)) {
        solution = lifted;
        blocker = lifted.blocker || null;
        this.lifted = true;
      }
    }
    this._direction.copy(solution.direction);
    const desiredDistance = solution.distance;
    const permittedDistance = solution.permitted;
    const hitName = solution.hitName;
    this.blocked = permittedDistance < desiredDistance - 0.02;
    this.lastHitName = hitName;
    this.lowerFrustumBlocked = !!solution.lowerFrustumBlocked;
    this.foregroundBlocked = !!solution.foreground;
    this.foregroundObject = solution.foreground?.object?.name || '';
    if (this.resolvedDistance == null) this.resolvedDistance = permittedDistance;
    const response = this.blocked ? 22 : 6.5;
    this.resolvedDistance += (permittedDistance - this.resolvedDistance) * expAlpha(response, dt);
    this.resolvedDistance = Math.min(desiredDistance, Math.max(minimumDistance, this.resolvedDistance));
    this._resolved.copy(focus).addScaledVector(this._direction, this.resolvedDistance);
    if (typeof groundHeightAt === 'function') {
      const ground = groundHeightAt(this._resolved.x, this._resolved.z);
      if (Number.isFinite(ground)) this._resolved.y = Math.max(this._resolved.y, ground + radius + 0.22);
    }
    blocker = this.positionBlocker(this._resolved, radius * 0.82);
    this.contained = !!blocker;
    this.containingObject = blocker?.name || '';
    return this._resolved;
  }

  snapshot() {
    return {
      blocked: this.blocked,
      distance: this.resolvedDistance,
      hit: this.lastHitName,
      lifted: this.lifted,
      lowerFrustumBlocked: this.lowerFrustumBlocked,
      foregroundBlocked: this.foregroundBlocked,
      foregroundObject: this.foregroundObject,
      contained: this.contained,
      containingObject: this.containingObject,
      candidates: this.candidates.length,
      activeCandidates: this._activeBounds,
      boomCandidates: this._boomCandidates.length,
      foregroundCandidates: this._foregroundCandidates.length,
      raycasts: this._raycasts,
    };
  }
}
