import * as THREE from 'three';
import {
  CRASH_COLLISION,
  CRASH_TRAFFIC_PROFILES,
  crashDynamicBudgetSaturated,
  crashVehicleProfile,
} from './crashConfig.js';
import { laneById, sampleCrashLane } from './crashLanes.js';
import { signalStateAt } from './scenarios/pawprintInterchange.js';
import {
  buildCrashTrafficVisual,
  attachCrashProductionModel,
} from './crashAssets.js';
import {
  createCrashArticulation,
  createCrashKinematicVehicle,
  demoteCrashVehicleBody,
  promoteCrashVehicleBody,
  removeCrashEntity,
} from './crashPhysics.js';
import { createCrashDamageState } from './crashDamage.js';

const TEMP_POS = new THREE.Vector3();
const TEMP_QUAT = new THREE.Quaternion();
const TEMP_OFFSET = new THREE.Vector3();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeAngle(angle) {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function yawQuaternion(yaw = 0) {
  const half = yaw * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function yawFromQuaternion(rotation) {
  return Math.atan2(
    2 * (rotation.w * rotation.y + rotation.x * rotation.z),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
  );
}

function trafficRideHeight(profile) {
  const lowerHeight = Math.max(0.24, profile.height * 0.34);
  return Math.max(0.34, -(Number(profile.comY) || 0) + lowerHeight * 0.5 + 0.055);
}

function transformState(entity) {
  const position = entity.body?.translation?.() || { x: 0, y: 0, z: 0 };
  const rotation = entity.body?.rotation?.() || { x: 0, y: 0, z: 0, w: 1 };
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
  };
}

function makeEntity(runtime, entry, lane, root, owned, assetLease) {
  const visual = buildCrashTrafficVisual({ classId: entry.classId, colorIndex: entry.colorIndex, owned });
  visual.root.visible = false;
  root.add(visual.root);
  const entity = {
    id: entry.id,
    classId: entry.classId,
    kind: 'traffic',
    entry,
    lane,
    desiredSpeed: entry.desiredSpeed || lane.desiredSpeed,
    kinematicSpeed: entry.desiredSpeed || lane.desiredSpeed,
    progress: 0,
    visual,
    active: false,
    dynamic: false,
    bodyType: 'dormant',
    promotionState: 'dormant',
    crashed: false,
    emergency: false,
    avoidSide: entry.id.charCodeAt(entry.id.length - 1) % 2 ? 1 : -1,
    damage: createCrashDamageState(),
    detachedMask: 0,
    settledFor: 0,
    productionAttached: false,
    previousTransform: null,
    currentTransform: null,
    body: null,
    colliders: [],
  };
  assetLease?.whenReady?.('crashVehicleKitV2').then((gltf) => {
    if (runtime.disposed || entity.removed || entity.productionAttached) return;
    entity.productionAttached = attachCrashProductionModel(visual, gltf, entry.classId, owned, entry.colorIndex);
  }).catch(() => {});
  return entity;
}

function registerEntity(manager, entity) {
  manager.entities.push(entity);
  manager.entityById.set(entity.id, entity);
  return entity;
}

function initialPose(entity, clock) {
  const elapsed = Math.max(0, clock - entity.entry.time);
  const length = sampleCrashLane(entity.lane, 0).laneLength;
  entity.progress = Math.max(0, Math.min(0.98, elapsed * entity.desiredSpeed / length));
  return sampleCrashLane(entity.lane, entity.progress);
}

function trailerPose(tractor, pose) {
  const profile = CRASH_TRAFFIC_PROFILES.trailer;
  const gap = tractor.profile.length * 0.44 + profile.length * 0.44;
  return {
    x: pose.x - Math.sin(pose.yaw) * gap,
    y: trafficRideHeight(profile),
    z: pose.z - Math.cos(pose.yaw) * gap,
    yaw: pose.yaw,
    speed: tractor.desiredSpeed,
  };
}

function exposePhysicalEntity(entity) {
  if (!entity.body || !entity.colliders?.length) throw new Error(`Visible crash traffic ${entity.id} has no collider`);
  entity.active = true;
  entity.visual.root.visible = true;
}

function activateKinematic(manager, entity, pose) {
  if (!entity.body) {
    const profile = crashVehicleProfile(entity.classId);
    createCrashKinematicVehicle(manager.runtime, entity, profile, {
      ...pose,
      y: Number.isFinite(pose.y) ? pose.y : trafficRideHeight(profile),
      speed: entity.desiredSpeed,
    }, { group: CRASH_COLLISION.TRAFFIC });
    manager.kinematicCount += 1;
    entity.previousTransform = transformState(entity);
    entity.currentTransform = transformState(entity);
  }
  entity.bodyType = 'kinematic';
  entity.promotionState = 'kinematic-proxy';
  exposePhysicalEntity(entity);
}

function activateTrailer(manager, tractor, pose) {
  const trailer = tractor.trailer;
  if (!trailer) return null;
  trailer.progress = tractor.progress;
  trailer.desiredSpeed = tractor.desiredSpeed;
  activateKinematic(manager, trailer, trailerPose(tractor, pose));
  return trailer;
}

export function createCrashTraffic({ runtime, root, owned, assetLease, scenario, schedule, quality }) {
  const manager = {
    runtime,
    root,
    owned,
    assetLease,
    scenario,
    schedule,
    quality,
    entities: [],
    entityById: new Map(),
    parked: [],
    trailers: [],
    clock: -10,
    dynamicCount: 0,
    kinematicCount: 0,
    spawnedCount: 0,
    promotedCount: 0,
    demotedCount: 0,
    saturatedProxyCount: 0,
    disposed: false,
  };
  for (const entry of schedule) {
    const lane = laneById(entry.laneId, scenario);
    const entity = registerEntity(manager, makeEntity(runtime, entry, lane, root, owned, assetLease));
    if (entry.articulated || entry.classId === 'semi') {
      const trailerEntry = {
        id: `${entry.id}-trailer`,
        classId: 'trailer',
        colorIndex: entry.colorIndex,
        time: entry.time,
        laneId: entry.laneId,
        desiredSpeed: entry.desiredSpeed || lane.desiredSpeed,
      };
      const trailer = registerEntity(manager, makeEntity(runtime, trailerEntry, lane, root, owned, assetLease));
      entity.trailer = trailer;
      trailer.tractor = entity;
      manager.trailers.push(trailer);
    }
  }
  const parkedClasses = ['sedan', 'hatchback', 'wagon', 'pickup', 'suv', 'van'];
  let parkedIndex = 0;
  for (const row of scenario.parkedRows) {
    const alongX = Math.abs(Math.sin(row.yaw)) > 0.5;
    for (let index = 0; index < row.count; index++) {
      const classId = parkedClasses[parkedIndex % parkedClasses.length];
      const entry = {
        id: `parked-${String(parkedIndex + 1).padStart(2, '0')}`,
        classId,
        colorIndex: parkedIndex + 3,
        time: -Infinity,
        laneId: '',
        desiredSpeed: 0,
      };
      const entity = registerEntity(manager, makeEntity(runtime, entry, scenario.lanes[0], root, owned, assetLease));
      const offset = (index - (row.count - 1) * 0.5) * row.spacing;
      const pose = {
        x: row.x + (alongX ? offset : 0),
        z: row.z + (alongX ? 0 : offset),
        yaw: row.yaw,
      };
      entity.parked = true;
      entity.kinematicSpeed = 0;
      activateKinematic(manager, entity, pose);
      manager.parked.push(entity);
      parkedIndex += 1;
    }
  }
  return manager;
}

function playerMotion(playerState) {
  const position = playerState?.position || playerState || {};
  const velocity = playerState?.velocity || {};
  return {
    position: { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 },
    velocity: { x: Number(velocity.x) || 0, y: Number(velocity.y) || 0, z: Number(velocity.z) || 0 },
  };
}

function closestApproach(aPosition, aVelocity, bPosition, bVelocity, horizon = 3.5) {
  const rx = aPosition.x - bPosition.x;
  const rz = aPosition.z - bPosition.z;
  const vx = aVelocity.x - bVelocity.x;
  const vz = aVelocity.z - bVelocity.z;
  const speedSquared = vx * vx + vz * vz;
  const time = speedSquared > 0.01 ? clamp(-(rx * vx + rz * vz) / speedSquared, 0, horizon) : 0;
  return { time, distance: Math.hypot(rx + vx * time, rz + vz * time) };
}

export function predictCrashTrafficPromotion(manager, entity, playerState) {
  if (!entity?.active || entity.dynamic || !entity.body) return { promote: false, reason: 'ineligible', timeToImpact: Infinity, missDistance: Infinity };
  const motion = playerMotion(playerState);
  const position = entity.body.translation();
  const velocity = entity.kinematicLinearVelocity || entity.body.linvel();
  const profile = entity.profile || crashVehicleProfile(entity.classId);
  const playerRadius = 2.35;
  const vehicleRadius = Math.hypot(profile.width, profile.length) * 0.25;
  const approach = closestApproach(position, velocity, motion.position, motion.velocity, 3.6);
  const currentDistance = Math.hypot(position.x - motion.position.x, position.z - motion.position.z);
  if (approach.time > 0.02 && approach.distance < vehicleRadius + playerRadius + 1.15) {
    return { promote: true, reason: 'player-trajectory', timeToImpact: approach.time, missDistance: approach.distance };
  }
  if (currentDistance < vehicleRadius + playerRadius + 8) {
    return { promote: true, reason: 'player-proximity', timeToImpact: 0, missDistance: currentDistance };
  }
  for (const other of manager.entities) {
    if (other === entity || !other.body || !other.crashed || other.active === false) continue;
    const at = other.body.translation();
    const otherVelocity = other.body.linvel?.() || { x: 0, z: 0 };
    const chainApproach = closestApproach(position, velocity, at, otherVelocity, 2.8);
    if (chainApproach.distance < vehicleRadius + Math.max(3.5, (other.profile?.length || 4) * 0.55)) {
      return { promote: true, reason: 'chain-proximity', timeToImpact: chainApproach.time, missDistance: chainApproach.distance };
    }
  }
  const junctionApproach = closestApproach(position, velocity, { x: 0, z: 0 }, { x: 0, z: 0 }, 3.2);
  if (Math.hypot(position.x, position.z) < 38 || junctionApproach.distance < 31) {
    return { promote: true, reason: 'junction-occupancy', timeToImpact: junctionApproach.time, missDistance: junctionApproach.distance };
  }
  return { promote: false, reason: 'kinematic-range', timeToImpact: approach.time, missDistance: approach.distance };
}

function safeDemotionCandidate(manager, playerState, excluded) {
  const motion = playerMotion(playerState);
  let selected = null;
  let selectedScore = -Infinity;
  for (const entity of manager.entities) {
    if (excluded.has(entity) || !entity.dynamic || !entity.body || entity.crashed || entity.trailer || entity.tractor) continue;
    const position = entity.body.translation();
    const playerDistance = Math.hypot(position.x - motion.position.x, position.z - motion.position.z);
    const junctionDistance = Math.hypot(position.x, position.z);
    if (playerDistance < 58 || junctionDistance < 66) continue;
    const speed = entity.body.linvel();
    const motionValue = Math.hypot(speed.x, speed.y, speed.z);
    if (entity.settledFor < 0.8 && motionValue > 8 && entity.progress < 0.78) continue;
    const score = playerDistance + junctionDistance + entity.settledFor * 80 + entity.progress * 35 - motionValue * 2;
    if (score > selectedScore) { selected = entity; selectedScore = score; }
  }
  return selected;
}

export function demoteCrashTraffic(manager, entity, reason = 'safe-budget-reclaim') {
  if (!manager || !entity?.dynamic || !entity.body || entity.crashed || entity.trailer || entity.tractor) return false;
  const state = demoteCrashVehicleBody(manager.runtime, entity);
  if (!state) return false;
  manager.dynamicCount = Math.max(0, manager.dynamicCount - 1);
  manager.kinematicCount += 1;
  manager.demotedCount += 1;
  entity.promotionState = 'demoted-kinematic';
  entity.demotionReason = reason;
  entity.previousTransform = transformState(entity);
  entity.currentTransform = transformState(entity);
  return true;
}

function reserveDynamicSlots(manager, required, playerState, excluded) {
  while (crashDynamicBudgetSaturated(manager.quality, manager.dynamicCount, required)) {
    const candidate = safeDemotionCandidate(manager, playerState, excluded);
    if (!candidate || !demoteCrashTraffic(manager, candidate)) return false;
    excluded.add(candidate);
  }
  return true;
}

export function promoteCrashTraffic(manager, entity, reason = 'prediction', playerState = null) {
  if (!manager || !entity || entity.dynamic || !entity.active || !entity.body) return false;
  const group = [entity];
  if (entity.trailer?.active && entity.trailer.body && !entity.trailer.dynamic) group.push(entity.trailer);
  const excluded = new Set(group);
  if (!reserveDynamicSlots(manager, group.length, playerState, excluded)) {
    entity.promotionState = 'saturated-physical-proxy';
    entity.promotionReason = reason;
    manager.saturatedProxyCount += 1;
    return false;
  }
  for (const member of group) {
    const promoted = promoteCrashVehicleBody(manager.runtime, member, {
      linearVelocity: member.kinematicLinearVelocity,
      angularVelocity: member.kinematicAngularVelocity,
    });
    if (!promoted) continue;
    member.promotionReason = reason;
    member.promotionState = 'dynamic';
    member.previousTransform = transformState(member);
    member.currentTransform = transformState(member);
    manager.dynamicCount += 1;
    manager.kinematicCount = Math.max(0, manager.kinematicCount - 1);
    manager.promotedCount += 1;
  }
  if (entity.trailer?.dynamic && !entity.articulation) entity.articulation = createCrashArticulation(manager.runtime, entity, entity.trailer);
  return entity.dynamic;
}

function blockingWreck(manager, entity, aheadPose) {
  let closest = null;
  let distance = Infinity;
  for (const other of manager.entities) {
    if (other === entity || !other.body || !other.crashed || other.active === false) continue;
    const at = other.body.translation();
    const d = Math.hypot(at.x - aheadPose.x, at.z - aheadPose.z);
    if (d < distance) { distance = d; closest = other; }
  }
  return distance < 8.5 ? { entity: closest, distance } : null;
}

function laneLeader(manager, entity, length) {
  let leader = null;
  let gap = Infinity;
  for (const other of manager.entities) {
    if (other === entity || other.tractor || !other.active || !other.body || other.lane !== entity.lane) continue;
    const progressGap = (other.progress || 0) - entity.progress;
    if (progressGap <= 0) continue;
    const distance = progressGap * length;
    if (distance < gap) { gap = distance; leader = other; }
  }
  return leader ? { entity: leader, distance: gap } : null;
}

function retireEntity(manager, entity) {
  if (!entity?.body) return;
  if (entity.dynamic) manager.dynamicCount = Math.max(0, manager.dynamicCount - 1);
  else manager.kinematicCount = Math.max(0, manager.kinematicCount - 1);
  removeCrashEntity(manager.runtime, entity);
  entity.active = false;
  entity.bodyType = 'retired';
  entity.promotionState = 'retired';
  entity.visual.root.visible = false;
}

function updateKinematicFollower(manager, entity, dt, clock) {
  const lane = entity.lane;
  const length = sampleCrashLane(lane, 0).laneLength;
  const current = entity.body.translation();
  const currentRotation = entity.body.rotation();
  const currentYaw = yawFromQuaternion(currentRotation);
  const signal = signalStateAt(clock, lane.signalGroup, manager.scenario);
  const stopDistance = (lane.stopProgress - entity.progress) * length;
  const leader = laneLeader(manager, entity, length);
  const profile = entity.profile || crashVehicleProfile(entity.classId);
  const leaderProfile = leader?.entity?.profile || (leader ? crashVehicleProfile(leader.entity.classId) : null);
  const safeGap = leader ? profile.length * 0.48 + leaderProfile.length * 0.48 + Math.max(3.5, entity.kinematicSpeed * 0.8) : Infinity;
  const mustStop = signal !== 'green' && stopDistance > -2 && stopDistance < Math.max(10, entity.kinematicSpeed * 1.5);
  let targetSpeed = entity.desiredSpeed;
  if (mustStop) targetSpeed = Math.max(0, Math.min(targetSpeed, stopDistance * 0.72 - 0.4));
  if (leader && leader.distance < safeGap) targetSpeed = Math.max(0, Math.min(targetSpeed, (leader.distance - profile.length * 0.55) * 0.75));
  const ahead = sampleCrashLane(lane, Math.min(1, entity.progress + Math.max(0.01, entity.kinematicSpeed * 0.5 / length)));
  const wreck = blockingWreck(manager, entity, ahead);
  if (wreck) targetSpeed = wreck.distance < 5 ? 0 : Math.min(targetSpeed, 4.5);
  const acceleration = targetSpeed < entity.kinematicSpeed ? 9 : 3.2;
  entity.kinematicSpeed += clamp(targetSpeed - entity.kinematicSpeed, -acceleration * dt, acceleration * dt);
  entity.progress = Math.min(1.02, entity.progress + Math.max(0, entity.kinematicSpeed) * dt / Math.max(1, length));
  if (entity.progress >= 1) {
    retireEntity(manager, entity);
    if (entity.trailer) retireEntity(manager, entity.trailer);
    return null;
  }
  const sampled = sampleCrashLane(lane, entity.progress);
  const intendedX = current.x + Math.sin(sampled.yaw) * entity.kinematicSpeed * dt;
  const intendedZ = current.z + Math.cos(sampled.yaw) * entity.kinematicSpeed * dt;
  const next = {
    x: intendedX + clamp(sampled.x - intendedX, -2.8 * dt, 2.8 * dt),
    y: trafficRideHeight(profile),
    z: intendedZ + clamp(sampled.z - intendedZ, -2.8 * dt, 2.8 * dt),
    yaw: currentYaw + clamp(normalizeAngle(sampled.yaw - currentYaw), -1.9 * dt, 1.9 * dt),
  };
  entity.kinematicLinearVelocity = { x: (next.x - current.x) / dt, y: (next.y - current.y) / dt, z: (next.z - current.z) / dt };
  entity.kinematicAngularVelocity = { x: 0, y: normalizeAngle(next.yaw - currentYaw) / dt, z: 0 };
  entity.body.setNextKinematicTranslation({ x: next.x, y: next.y, z: next.z });
  entity.body.setNextKinematicRotation(yawQuaternion(next.yaw));
  entity.emergency = !!wreck || (leader && leader.distance < safeGap);
  return next;
}

function updateKinematicTrailer(tractor, next, dt) {
  const trailer = tractor.trailer;
  if (!trailer?.active || trailer.dynamic || !trailer.body || !next) return;
  const pose = trailerPose(tractor, next);
  const current = trailer.body.translation();
  const currentYaw = yawFromQuaternion(trailer.body.rotation());
  trailer.progress = tractor.progress;
  trailer.kinematicLinearVelocity = { x: (pose.x - current.x) / dt, y: (pose.y - current.y) / dt, z: (pose.z - current.z) / dt };
  trailer.kinematicAngularVelocity = { x: 0, y: normalizeAngle(pose.yaw - currentYaw) / dt, z: 0 };
  trailer.body.setNextKinematicTranslation({ x: pose.x, y: pose.y, z: pose.z });
  trailer.body.setNextKinematicRotation(yawQuaternion(pose.yaw));
}

export function updateCrashTrafficKinematics(manager, clock, playerState, dt = manager?.runtime?.fixedDt || 1 / 90) {
  if (!manager || manager.disposed) return;
  manager.clock = clock;
  for (const entity of manager.entities) {
    if (entity.tractor) continue;
    if (!entity.active && !entity.parked && clock >= entity.entry.time) {
      const pose = initialPose(entity, clock);
      activateKinematic(manager, entity, pose);
      activateTrailer(manager, entity, pose);
      manager.spawnedCount += 1;
    }
    if (!entity.active || entity.dynamic || !entity.body) continue;
    const prediction = predictCrashTrafficPromotion(manager, entity, playerState);
    entity.promotionPrediction = prediction;
    if (prediction.promote && promoteCrashTraffic(manager, entity, prediction.reason, playerState)) continue;
    if (entity.parked) continue;
    const next = updateKinematicFollower(manager, entity, dt, clock);
    updateKinematicTrailer(entity, next, dt);
  }
}

export function prepareCrashTrafficStep(manager) {
  for (const entity of manager?.entities || []) {
    if (!entity.body) continue;
    entity.previousTransform = entity.currentTransform || transformState(entity);
  }
}

export function stepCrashTrafficDynamics(manager, dt, clock) {
  if (!manager || manager.disposed) return;
  for (const entity of manager.entities) {
    if (!entity.dynamic || !entity.body || entity.parked || entity.tractor || entity.crashed) continue;
    const lane = entity.lane;
    const length = sampleCrashLane(lane, 0).laneLength;
    const bodyPosition = entity.body.translation();
    const bodyVelocity = entity.body.linvel();
    const currentSpeed = Math.hypot(bodyVelocity.x, bodyVelocity.z);
    entity.progress = Math.min(1.02, entity.progress + currentSpeed * dt / Math.max(1, length));
    const aheadProgress = Math.min(1, entity.progress + Math.max(0.012, currentSpeed * 0.55 / length));
    const ahead = sampleCrashLane(lane, aheadProgress);
    const blocked = blockingWreck(manager, entity, ahead);
    const signal = signalStateAt(clock, lane.signalGroup, manager.scenario);
    const stopDistance = (lane.stopProgress - entity.progress) * length;
    const mustStop = signal !== 'green' && stopDistance > -2 && stopDistance < Math.max(9, currentSpeed * 1.45);
    entity.emergency = !!blocked;
    let targetSpeed = entity.desiredSpeed;
    if (mustStop) targetSpeed = Math.max(0, Math.min(targetSpeed, stopDistance * 0.7 - 0.5));
    if (blocked) targetSpeed = blocked.distance < 4.2 ? 0 : Math.min(targetSpeed, 5.5);
    const forwardX = Math.sin(ahead.yaw);
    const forwardZ = Math.cos(ahead.yaw);
    const lateralX = Math.cos(ahead.yaw);
    const lateralZ = -Math.sin(ahead.yaw);
    const avoid = blocked ? entity.avoidSide * Math.min(2.4, (7.5 - blocked.distance) * 0.45) : 0;
    const targetX = ahead.x + lateralX * avoid;
    const targetZ = ahead.z + lateralZ * avoid;
    const correctionX = clamp((targetX - bodyPosition.x) * 1.2, -4, 4);
    const correctionZ = clamp((targetZ - bodyPosition.z) * 1.2, -4, 4);
    const desiredX = forwardX * Math.max(0, targetSpeed) + correctionX;
    const desiredZ = forwardZ * Math.max(0, targetSpeed) + correctionZ;
    const mass = Math.max(1, entity.body.mass());
    const gain = mustStop || blocked ? 2.4 : 1.25;
    const impulseScale = Math.min(0.22, dt * gain);
    entity.body.applyImpulse({
      x: (desiredX - bodyVelocity.x) * mass * impulseScale,
      y: 0,
      z: (desiredZ - bodyVelocity.z) * mass * impulseScale,
    }, true);
    const rotation = entity.body.rotation();
    const yaw = yawFromQuaternion(rotation);
    const yawError = normalizeAngle(ahead.yaw - yaw);
    const angular = entity.body.angvel();
    entity.body.applyTorqueImpulse({ x: 0, y: (yawError * 0.26 - angular.y * 0.12) * mass, z: 0 }, true);
    if (entity.progress >= 0.995 && Math.hypot(bodyPosition.x, bodyPosition.z) > 104) entity.expired = true;
  }
  for (const entity of manager.entities) {
    if (!entity.expired || !entity.body) continue;
    retireEntity(manager, entity);
    if (entity.trailer) retireEntity(manager, entity.trailer);
  }
}

export function finishCrashTrafficStep(manager) {
  for (const entity of manager?.entities || []) {
    if (!entity.body) continue;
    entity.currentTransform = transformState(entity);
    const velocity = entity.body.linvel();
    const angular = entity.body.angvel();
    const motion = Math.hypot(velocity.x, velocity.y, velocity.z) + Math.hypot(angular.x, angular.y, angular.z) * 0.8;
    entity.settledFor = motion < 0.32 ? entity.settledFor + manager.runtime.fixedDt : 0;
  }
}

export function syncCrashTrafficVisuals(manager, alpha = 1) {
  const t = clamp(alpha, 0, 1);
  for (const entity of manager?.entities || []) {
    if (!entity.visual?.root || !entity.body || !entity.previousTransform || !entity.currentTransform) continue;
    const previous = entity.previousTransform;
    const current = entity.currentTransform;
    TEMP_POS.set(previous.position.x, previous.position.y, previous.position.z).lerp(
      new THREE.Vector3(current.position.x, current.position.y, current.position.z),
      t,
    );
    TEMP_QUAT.set(previous.rotation.x, previous.rotation.y, previous.rotation.z, previous.rotation.w).slerp(
      new THREE.Quaternion(current.rotation.x, current.rotation.y, current.rotation.z, current.rotation.w),
      t,
    );
    const profile = entity.profile || crashVehicleProfile(entity.classId);
    TEMP_OFFSET.set(0, -trafficRideHeight(profile), 0).applyQuaternion(TEMP_QUAT);
    entity.visual.root.position.copy(TEMP_POS).add(TEMP_OFFSET);
    entity.visual.root.quaternion.copy(TEMP_QUAT);
    entity.visual.root.visible = entity.active !== false;
  }
}

export function markCrashTrafficImpact(entity, impulse) {
  if (!entity || entity.kind !== 'traffic') return false;
  if (impulse > 1150) {
    entity.crashed = true;
    entity.promotionState = entity.dynamic ? 'dynamic-crashed' : 'kinematic-contact';
    entity.body?.wakeUp?.();
    if (entity.trailer) entity.trailer.crashed = true;
    if (entity.tractor) entity.tractor.crashed = true;
    return true;
  }
  return false;
}

export function visibleTrafficColliderViolations(manager) {
  const violations = [];
  for (const entity of manager?.entities || []) {
    if (entity.visual?.root?.visible && entity.active !== false && (!entity.body || !entity.colliders?.length)) violations.push(entity.id);
  }
  return violations;
}

export function crashTrafficSnapshot(manager) {
  let active = 0; let sleeping = 0; let dynamic = 0; let kinematic = 0; let crashed = 0; let emergency = 0; let saturated = 0;
  for (const entity of manager?.entities || []) {
    if (entity.active) active += 1;
    if (entity.dynamic) dynamic += 1;
    else if (entity.body && entity.active) kinematic += 1;
    if (entity.body?.isSleeping?.()) sleeping += 1;
    if (entity.crashed) crashed += 1;
    if (entity.emergency) emergency += 1;
    if (entity.promotionState === 'saturated-physical-proxy') saturated += 1;
  }
  const colliderViolations = visibleTrafficColliderViolations(manager);
  return {
    active,
    dynamic,
    kinematic,
    physical: dynamic + kinematic,
    sleeping,
    crashed,
    emergency,
    saturated,
    colliderViolations,
    spawned: manager?.spawnedCount || 0,
    promoted: manager?.promotedCount || 0,
    demoted: manager?.demotedCount || 0,
  };
}

export function disposeCrashTraffic(manager) {
  if (!manager || manager.disposed) return false;
  manager.disposed = true;
  manager.entities.length = 0;
  manager.parked.length = 0;
  manager.trailers.length = 0;
  manager.entityById.clear();
  return true;
}
