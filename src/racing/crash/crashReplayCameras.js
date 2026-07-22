import * as THREE from 'three';
import { scoreReplayCameraCandidate } from './crashReplayDirector.js';

const POSITION = new THREE.Vector3();
const TARGET = new THREE.Vector3();
const DESIRED = new THREE.Vector3();
const FORWARD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const RELATIVE = new THREE.Vector3();
const RAY_DIRECTION = new THREE.Vector3();
const IMPACT_WORLD = new THREE.Vector3();
const PILEUP_WORLD = new THREE.Vector3();
const CAMERA_BOX = new THREE.Box3();

const PLACEMENT_VARIANTS = Object.freeze([
  Object.freeze({ azimuthDelta: 0, heightDelta: 0, distanceScale: 1 }),
  Object.freeze({ azimuthDelta: 0.5, heightDelta: 1.1, distanceScale: 1.04 }),
  Object.freeze({ azimuthDelta: -0.5, heightDelta: 1.1, distanceScale: 1.04 }),
  Object.freeze({ azimuthDelta: 1.0, heightDelta: 2.2, distanceScale: 1.1 }),
  Object.freeze({ azimuthDelta: -1.0, heightDelta: 2.2, distanceScale: 1.1 }),
  Object.freeze({ azimuthDelta: 1.48, heightDelta: 4.2, distanceScale: 1.16 }),
  Object.freeze({ azimuthDelta: -1.48, heightDelta: 4.2, distanceScale: 1.16 }),
  Object.freeze({ azimuthDelta: 0.82, heightDelta: 16, distanceScale: 1.18 }),
  Object.freeze({ azimuthDelta: -0.62, heightDelta: 24, distanceScale: 1.34 }),
  Object.freeze({ azimuthDelta: 0.62, heightDelta: 32, distanceScale: 1.48 }),
]);

function subjectSample(session, player, shot, time) {
  const id = shot?.subjectId || 'player';
  return player?.clip?.sample(id, time) || player?.clip?.sample('player', time) || null;
}

function worldPoint(session, point, out = new THREE.Vector3()) {
  out.set(point?.x || 0, point?.y || 0, point?.z || 0).add(session.root.position);
  return out;
}

function densePileupFocus(session, player, time, fallback, out = new THREE.Vector3()) {
  const ids = ['player', ...(session.score?.participants || [])];
  const positions = [];
  for (const id of ids) {
    const sample = player?.clip?.sample?.(id, time);
    if (!sample?.active) continue;
    positions.push(worldPoint(session, {
      x: sample.position[0],
      y: sample.position[1],
      z: sample.position[2],
    }));
  }
  if (!positions.length) return out.copy(fallback);
  if (positions.length === 1) return out.copy(positions[0]);

  // Replay-wide shots follow the densest wreck cluster, not merely the raw
  // contact point. This keeps later traffic joins in frame when the original
  // victim has been pushed away from the actual pileup.
  let best = null;
  let bestDistance = Infinity;
  const radiusSq = 24 * 24;
  for (const anchor of positions) {
    const neighbours = positions.filter((position) => {
      const dx = position.x - anchor.x;
      const dz = position.z - anchor.z;
      return dx * dx + dz * dz <= radiusSq;
    });
    const fallbackDistance = anchor.distanceToSquared(fallback);
    if (!best || neighbours.length > best.length || (neighbours.length === best.length && fallbackDistance < bestDistance)) {
      best = neighbours;
      bestDistance = fallbackDistance;
    }
  }
  out.set(0, 0, 0);
  for (const position of best) out.add(position);
  out.multiplyScalar(1 / Math.max(1, best.length));
  out.y = Math.max(session.root.position.y + 0.85, out.y * 0.35 + fallback.y * 0.65);
  return out;
}

function frameVectors(sample) {
  const velocity = sample?.linearVelocity || [0, 0, 1];
  const speed = Math.hypot(velocity[0], velocity[2]);
  if (speed > 0.35) FORWARD.set(velocity[0] / speed, 0, velocity[2] / speed);
  else {
    const q = new THREE.Quaternion().fromArray(sample?.quaternion || [0, 0, 0, 1]);
    FORWARD.set(0, 0, 1).applyQuaternion(q).setY(0).normalize();
  }
  RIGHT.set(FORWARD.z, 0, -FORWARD.x);
  return { forward: FORWARD, right: RIGHT, speed };
}

function belongsTo(object, root) {
  for (let current = object; current; current = current.parent) if (current === root) return true;
  return false;
}

function hierarchyVisible(object, stop) {
  for (let current = object; current && current !== stop; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

function cameraClearance(root, position) {
  let minimum = Infinity;
  let intrusions = 0;
  const intrusionNames = [];
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry || !hierarchyVisible(object, root)) return;
    const role = object.userData?.role;
    if (role === 'ground-shadow' || role === 'atmosphere' || role === 'debug') return;
    object.geometry.computeBoundingBox?.();
    if (!object.geometry.boundingBox) return;
    CAMERA_BOX.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
    // Thin authored road surfaces below the lens are not camera intrusions;
    // walls, props and vehicle silhouettes remain eligible.
    if (CAMERA_BOX.max.y < position.y - 0.34 && CAMERA_BOX.max.y - CAMERA_BOX.min.y < 0.55) return;
    const distance = CAMERA_BOX.distanceToPoint(position);
    minimum = Math.min(minimum, distance);
    if (distance < 0.72) {
      intrusions += 1;
      if (intrusionNames.length < 8) intrusionNames.push(object.name || object.parent?.name || 'unnamed-mesh');
    }
  });
  return { minimum: Number.isFinite(minimum) ? minimum : 999, intrusions, intrusionNames };
}

function placedPosition(base, target, placement, out = new THREE.Vector3()) {
  RELATIVE.subVectors(base, target);
  const height = RELATIVE.y;
  RELATIVE.y = 0;
  RELATIVE.multiplyScalar(placement.distanceScale).applyAxisAngle(THREE.Object3D.DEFAULT_UP, placement.azimuthDelta);
  out.copy(target).add(RELATIVE);
  out.y = target.y + height + placement.heightDelta;
  return out;
}

export class CrashReplayCameraDirector {
  constructor(session) {
    this.session = session;
    this.camera = new THREE.PerspectiveCamera(58, session.cameraHost?.getAspect?.() || 16 / 9, 0.08, 900);
    this.camera.name = 'KakiCatastropheReplayCamera';
    this.initialized = false;
    this.shot = null;
    this.orbitPhase = 0;
    this.lastFrame = null;
    this.raycaster = new THREE.Raycaster();
    this.placement = PLACEMENT_VARIANTS[0];
    this.previousCandidate = null;
    this.lastCandidate = null;
    this.placementAge = Infinity;
  }

  reset() {
    this.initialized = false;
    this.shot = null;
    this.orbitPhase = 0;
    this.placement = PLACEMENT_VARIANTS[0];
    this.previousCandidate = null;
    this.lastCandidate = null;
    this.placementAge = Infinity;
  }

  _candidateMetrics(position, target, shot, sample, family, placement, fov = 56) {
    const distance = Math.max(0.01, position.distanceTo(target));
    this.session.root.updateMatrixWorld(true);
    const causalRoots = new Set();
    const causalIds = new Set(['player', shot.subjectId, ...(this.session.score?.participants || [])]);
    for (const id of causalIds) {
      const root = this.session.entityById?.get?.(id)?.visual?.root;
      if (root) causalRoots.add(root);
    }
    for (const entity of this.session.debrisEntities || []) {
      if (!causalIds.has(entity.sourceEntityId)) continue;
      if (entity.visual?.root) causalRoots.add(entity.visual.root);
    }
    const viewDirection = RAY_DIRECTION.subVectors(target, position).normalize().clone();
    const screenRight = new THREE.Vector3(viewDirection.z, 0, -viewDirection.x).normalize();
    const aimPoints = [
      target.clone(),
      target.clone().addScaledVector(screenRight, 3.2),
      target.clone().addScaledVector(screenRight, -3.2),
      target.clone().add(new THREE.Vector3(0, 2.4, 0)),
      target.clone().add(new THREE.Vector3(0, -0.55, 0)),
      target.clone().addScaledVector(screenRight, 2.4).add(new THREE.Vector3(0, 1.7, 0)),
      target.clone().addScaledVector(screenRight, -2.4).add(new THREE.Vector3(0, 1.7, 0)),
    ];
    let blockedRays = 0;
    let obstruction = 0;
    for (const aim of aimPoints) {
      const rayDistance = Math.max(0.01, position.distanceTo(aim));
      const rayDirection = aim.sub(position).normalize();
      this.raycaster.set(position, rayDirection);
      this.raycaster.near = 0.08;
      this.raycaster.far = rayDistance;
      const hit = this.raycaster.intersectObject(this.session.root, true).find((entry) => {
        const role = entry.object.userData?.role;
        if (!entry.object.visible || role === 'ground-shadow' || role === 'atmosphere') return false;
        if ([...causalRoots].some((root) => belongsTo(entry.object, root))) return false;
        return entry.distance < rayDistance - 1.35;
      });
      if (!hit) continue;
      blockedRays += 1;
      obstruction = Math.max(obstruction, 1 - Math.min(1, hit.distance / rayDistance));
    }
    let framed = 0;
    const participantIds = ['player', ...(this.session.score?.participants || [])];
    const screenUp = new THREE.Vector3().crossVectors(viewDirection, screenRight).normalize();
    const tangentY = Math.tan(THREE.MathUtils.degToRad(Math.max(20, Number(fov) || 56) * 0.5));
    const tangentX = tangentY * Math.max(0.1, this.session.cameraHost?.getAspect?.() || this.camera.aspect || 16 / 9);
    for (const id of participantIds.slice(0, 18)) {
      const participant = this.session.replayPlayer?.clip?.sample?.(id, this.session.replayPlayer.time);
      if (!participant?.active) continue;
      const participantWorld = worldPoint(this.session, { x: participant.position[0], y: participant.position[1], z: participant.position[2] }, new THREE.Vector3());
      const toParticipant = participantWorld.sub(position);
      const depth = toParticipant.dot(viewDirection);
      if (depth <= 0.2 || depth >= 80) continue;
      const projectedX = toParticipant.dot(screenRight) / Math.max(0.01, depth * tangentX);
      const projectedY = toParticipant.dot(screenUp) / Math.max(0.01, depth * tangentY);
      if (Math.abs(projectedX) < 0.68 && Math.abs(projectedY) < 0.62) framed += 1;
    }
    const velocity = sample?.linearVelocity || [0, 0, 0];
    const speed = Math.hypot(velocity[0], velocity[2]);
    const velocityAlignment = speed > 0.5
      ? Math.abs(viewDirection.x * velocity[0] / speed + viewDirection.z * velocity[2] / speed)
      : 0.5;
    const idealDistance = ['overhead', 'long_lens'].includes(family) ? 36 : family === 'crane' ? 24 : 14;
    const azimuth = Math.atan2(position.x - target.x, position.z - target.z);
    const clearance = cameraClearance(this.session.root, position);
    return {
      family,
      placement,
      position: position.clone(),
      lineOfSight: blockedRays || clearance.intrusions ? 0 : 1,
      obstruction,
      blockedRays,
      cameraClearance: clearance.minimum,
      cameraIntrusions: clearance.intrusions,
      cameraIntrusionNames: clearance.intrusionNames,
      groundPenalty: position.y < this.session.root.position.y + 0.65 ? 1 : 0,
      coverage: Math.max(0, Math.min(1, 1 - (distance - 7) / 48)),
      twoSubjectFraming: Math.min(1, framed / 2),
      centeredParticipants: framed,
      velocityAlignment,
      distanceFitness: Math.max(0, 1 - Math.abs(distance - idealDistance) / Math.max(idealDistance, 1)),
      continuity: this.previousCandidate ? Math.max(0, 1 - Math.abs(azimuth - this.previousCandidate.azimuth) / Math.PI) : 0.5,
      azimuth,
    };
  }

  _choosePlacement(base, target, shot, sample, family, fov) {
    const candidates = PLACEMENT_VARIANTS.map((placement) => {
      const position = placedPosition(base, target, placement, new THREE.Vector3());
      const candidate = this._candidateMetrics(position, target, shot, sample, family, placement, fov);
      candidate.score = scoreReplayCameraCandidate(candidate, this.previousCandidate);
      return candidate;
    });
    const clear = candidates.filter((candidate) => candidate.lineOfSight === 1
      && candidate.groundPenalty === 0
      && candidate.cameraIntrusions === 0
      && candidate.cameraClearance >= 0.72);
    const selected = (clear.length ? clear : candidates).sort((a, b) => b.score - a.score)[0];
    this.previousCandidate = selected;
    this.lastCandidate = selected;
    return selected.placement;
  }

  update(dt, replayState, reducedMotion = false) {
    const player = this.session.replayPlayer;
    const shot = replayState?.shot || player?.lastShot;
    if (!shot || !player?.clip) return null;
    const changed = this.shot !== shot;
    this.shot = shot;
    const sample = subjectSample(this.session, player, shot, player.time);
    if (!sample) return null;
    worldPoint(this.session, { x: sample.position[0], y: sample.position[1], z: sample.position[2] }, POSITION);
    const impact = shot.focus || player.highlight?.point || { x: sample.position[0], y: sample.position[1], z: sample.position[2] };
    worldPoint(this.session, impact, IMPACT_WORLD);
    densePileupFocus(this.session, player, player.time, IMPACT_WORLD, PILEUP_WORLD);
    TARGET.copy(IMPACT_WORLD);
    const { forward, right, speed } = frameVectors(sample);
    const family = shot.family;
    this.placementAge += Math.max(0, dt);
    let fov = 56;
    if (family === 'rear_chase') {
      DESIRED.copy(POSITION).addScaledVector(forward, -8.6).addScaledVector(right, 1.1).add(new THREE.Vector3(0, 3.1, 0));
      TARGET.copy(POSITION).addScaledVector(forward, 4.2).add(new THREE.Vector3(0, 1.05, 0));
      TARGET.lerp(PILEUP_WORLD, 0.48);
      fov = 70 + Math.min(6, speed * 0.2);
    } else if (family === 'front_pursuit') {
      DESIRED.copy(POSITION).addScaledVector(forward, 8.4).addScaledVector(right, -1.4).add(new THREE.Vector3(0, 2.45, 0));
      TARGET.copy(POSITION).add(new THREE.Vector3(0, 1, 0));
      fov = 58;
    } else if (family === 'target_pov') {
      DESIRED.copy(POSITION).add(new THREE.Vector3(0, 1.55, 0)).addScaledVector(forward, -0.2);
      TARGET.copy(IMPACT_WORLD).add(new THREE.Vector3(0, 0.8, 0));
      fov = 68;
    } else if (family === 'roadside') {
      DESIRED.copy(IMPACT_WORLD).addScaledVector(right, 14).addScaledVector(forward, -5).add(new THREE.Vector3(0, 2.1, 0));
      TARGET.copy(IMPACT_WORLD).add(new THREE.Vector3(0, 1.15, 0));
      fov = 48;
    } else if (family === 'crane') {
      TARGET.lerpVectors(IMPACT_WORLD, PILEUP_WORLD, 0.72);
      DESIRED.copy(TARGET).add(new THREE.Vector3(14, 16, -17));
      TARGET.y += 1.1;
      fov = 50;
    } else if (family === 'overhead') {
      // A slight traffic-map rake avoids the vertical lookAt/up-vector
      // singularity and keeps the pileup centered with readable lane context.
      TARGET.copy(PILEUP_WORLD);
      DESIRED.copy(TARGET).add(new THREE.Vector3(8.5, 34, 11.5));
      TARGET.y += 0.7;
      fov = 54;
    } else if (family === 'wheel_track') {
      DESIRED.copy(POSITION).addScaledVector(right, 2.6).addScaledVector(forward, -2.3).add(new THREE.Vector3(0, 0.52, 0));
      TARGET.copy(POSITION).addScaledVector(forward, 1.5).add(new THREE.Vector3(0, 0.72, 0));
      fov = 70;
    } else if (family === 'long_lens') {
      DESIRED.copy(IMPACT_WORLD).addScaledVector(forward, -36).add(new THREE.Vector3(0, 3.2, 0));
      TARGET.copy(IMPACT_WORLD).add(new THREE.Vector3(0, 1.2, 0));
      fov = 32;
    } else {
      this.orbitPhase += dt * (reducedMotion ? 0.16 : 0.38);
      const radius = 11.5;
      TARGET.copy(PILEUP_WORLD);
      DESIRED.copy(TARGET).add(new THREE.Vector3(Math.sin(this.orbitPhase) * radius, 3.2, Math.cos(this.orbitPhase) * radius));
      TARGET.y += 0.9;
      fov = 52;
    }
    if (changed || !this.placement || (family === 'wreck_orbit' && this.placementAge >= 0.22)) {
      this.placement = this._choosePlacement(DESIRED, TARGET, shot, sample, family, fov);
      this.placementAge = 0;
    }
    placedPosition(DESIRED, TARGET, this.placement, DESIRED);
    const ground = this.session.root.position.y + 0.45;
    DESIRED.y = Math.max(ground, DESIRED.y);
    const cut = changed && !reducedMotion;
    if (!this.initialized || cut) {
      this.camera.position.copy(DESIRED);
      this.initialized = true;
    } else {
      const rate = reducedMotion ? 3.2 : 7.5;
      this.camera.position.lerp(DESIRED, 1 - Math.exp(-rate * Math.max(0, dt)));
    }
    this.camera.fov += (fov - this.camera.fov) * (changed ? 1 : 1 - Math.exp(-6 * Math.max(0, dt)));
    this.camera.aspect = Math.max(0.1, this.session.cameraHost?.getAspect?.() || this.camera.aspect || 16 / 9);
    this.camera.lookAt(TARGET);
    this.camera.updateProjectionMatrix();
    this.lastFrame = {
      camera: this.camera,
      mode: 'replay',
      effects: {
        chromatic: reducedMotion ? 0 : (replayState.speed <= 0.25 ? 0.00125 : 0.00075),
        bloom: this.session.reducedFlashing ? 0.3 : (replayState.speed <= 0.25 ? 0.46 : 0.36),
        replayShot: family,
        replaySpeed: replayState.speed,
        depthOfField: this.session.quality.replayDof && !reducedMotion ? 0.12 : 0,
        replayObstruction: this.lastCandidate?.obstruction || 0,
        replayBlockedRays: this.lastCandidate?.blockedRays || 0,
        replayCameraClearance: this.lastCandidate?.cameraClearance ?? 999,
        replayCameraIntrusions: this.lastCandidate?.cameraIntrusions || 0,
      },
      frame: { projection: 'perspective', position: this.camera.position, focus: TARGET, fov: this.camera.fov },
    };
    return this.lastFrame;
  }

  resize(aspect) {
    this.camera.aspect = Math.max(0.1, Number(aspect) || 16 / 9);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.initialized = false;
    this.lastFrame = null;
  }
}
