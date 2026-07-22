import RAPIER from './vendor/rapier.mjs';
import {
  CRASH_COLLISION,
  CRASH_FIXED_DT,
  crashInteractionGroups,
  validateCrashCollisionMatrix,
} from './crashConfig.js';

let rapierReady = null;

export async function loadCrashRapier() {
  if (!rapierReady) rapierReady = RAPIER.init({}).then(() => RAPIER);
  return rapierReady;
}

function yawQuaternion(yaw = 0) {
  const half = yaw * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function configureCollider(desc, {
  friction = 1,
  restitution = 0.01,
  collisionGroups = crashInteractionGroups(CRASH_COLLISION.TRAFFIC),
  sensor = false,
  events = true,
  forceThreshold = 350,
} = {}) {
  desc.setFriction(friction);
  desc.setRestitution(restitution);
  desc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max);
  desc.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
  desc.setCollisionGroups(collisionGroups);
  desc.setSensor(sensor);
  if (events) {
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    desc.setContactForceEventThreshold(forceThreshold);
  }
  return desc;
}

function registerCollider(runtime, collider, entity, role) {
  runtime.colliderEntities.set(collider.handle, { entity, role, collider });
  entity.colliders ||= [];
  entity.colliders.push(collider);
  return collider;
}

export function crashVehicleColliderLayout(profile) {
  const lowerHeight = Math.max(0.24, profile.height * 0.34);
  const upperHeight = Math.max(0.22, profile.height - lowerHeight);
  const lower = {
    role: 'lower-chassis', type: 'roundCuboid',
    halfExtents: [profile.width * 0.49, lowerHeight * 0.5, profile.length * 0.48],
    translation: [0, profile.comY ?? profile.centerOfMass?.y ?? -0.1, 0], radius: 0.08,
  };
  const upper = (role, width, height, length, y, z, radius = 0.075) => ({
    role, type: 'roundCuboid',
    halfExtents: [profile.width * width, upperHeight * height, profile.length * length],
    translation: [0, lowerHeight * 0.5 + upperHeight * y, profile.length * z], radius,
  });
  const layouts = {
    pocket: [lower, upper('rally-cabin', 0.42, 0.41, 0.29, 0.34, -0.055, 0.10)],
    muscle: [lower, upper('fastback-cabin', 0.44, 0.34, 0.25, 0.28, -0.035, 0.11), upper('long-hood', 0.42, 0.13, 0.17, 0.06, 0.31, 0.06)],
    iron: [lower, upper('armored-cabin', 0.455, 0.43, 0.33, 0.35, -0.05, 0.07), upper('crash-bar', 0.50, 0.12, 0.08, 0.03, 0.45, 0.04)],
    hatchback: [lower, upper('hatch-cabin', 0.42, 0.43, 0.31, 0.35, -0.07, 0.10)],
    sedan: [lower, upper('sedan-cabin', 0.42, 0.39, 0.28, 0.32, -0.025, 0.10)],
    wagon: [lower, upper('wagon-cabin', 0.43, 0.43, 0.35, 0.35, -0.075, 0.09)],
    pickup: [lower, upper('pickup-cab', 0.43, 0.42, 0.22, 0.35, 0.22, 0.09), upper('pickup-bed', 0.45, 0.17, 0.20, 0.10, -0.30, 0.055)],
    suv: [lower, upper('suv-cabin', 0.44, 0.44, 0.34, 0.36, -0.04, 0.08)],
    van: [lower, upper('van-body', 0.45, 0.47, 0.40, 0.42, -0.015, 0.07)],
    boxTruck: [lower, upper('box-truck-cab', 0.44, 0.45, 0.15, 0.40, 0.32, 0.06), upper('box-truck-cargo', 0.47, 0.48, 0.29, 0.43, -0.18, 0.055)],
    bus: [lower, upper('bus-body', 0.47, 0.48, 0.45, 0.43, 0, 0.07)],
    // The tractor and trailer are connected at their authored fifth-wheel
    // sockets. Keep their lower hulls clear of that socket: overlapping
    // connected colliders make the contact solver fight the joint and can
    // inject unbounded energy into an otherwise settled pileup.
    semi: [
      { ...lower, halfExtents: [profile.width * 0.49, lowerHeight * 0.5, profile.length * 0.42], translation: [0, profile.comY ?? 0, profile.length * 0.045] },
      upper('semi-cab', 0.46, 0.47, 0.22, 0.42, 0.18, 0.08),
      upper('semi-hood', 0.43, 0.16, 0.13, 0.11, 0.39, 0.06),
    ],
    trailer: [
      { ...lower, halfExtents: [profile.width * 0.49, lowerHeight * 0.5, profile.length * 0.40], translation: [0, profile.comY ?? 0, -profile.length * 0.035] },
      upper('trailer-cargo', 0.47, 0.48, 0.43, 0.43, -0.025, 0.055),
    ],
  };
  if (profile.id === 'tanker') {
    return [lower, {
      role: 'tanker-vessel', type: 'cylinder',
      halfHeight: profile.length * 0.39, radius: profile.width * 0.42,
      translation: [0, lowerHeight * 0.55, -profile.length * 0.04],
      rotation: [0.7071068, 0, 0, 0.7071068],
    }];
  }
  return layouts[profile.id] || [lower, upper('generic-cabin', 0.44, 0.45, 0.31, 0.36, -0.06, 0.09)];
}

function compoundVehicleColliders(runtime, entity, profile, group) {
  const { world } = runtime;
  const common = {
    friction: profile.friction || 1,
    restitution: profile.restitution ?? 0.01,
    collisionGroups: crashInteractionGroups(group),
  };
  for (const shape of crashVehicleColliderLayout(profile)) {
    let desc;
    if (shape.type === 'cylinder') {
      desc = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius)
        .setRotation({ x: shape.rotation[0], y: shape.rotation[1], z: shape.rotation[2], w: shape.rotation[3] });
    } else {
      const [x, y, z] = shape.halfExtents;
      desc = RAPIER.ColliderDesc.roundCuboid(x, y, z, shape.radius);
    }
    desc.setTranslation(shape.translation[0], shape.translation[1], shape.translation[2]).setMass(0);
    registerCollider(runtime, world.createCollider(configureCollider(desc, common), entity.body), entity, shape.role);
  }
}

export async function createCrashPhysicsRuntime({ gravity = -9.81, fixedDt = CRASH_FIXED_DT } = {}) {
  await loadCrashRapier();
  const matrix = validateCrashCollisionMatrix();
  if (!matrix.valid) throw new Error(`Invalid crash collision matrix: ${matrix.errors.join(', ')}`);
  const world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
  world.timestep = fixedDt;
  world.integrationParameters.maxCcdSubsteps = 8;
  world.integrationParameters.maxVelocityIterations = 8;
  world.integrationParameters.maxVelocityFrictionIterations = 8;
  const runtime = {
    RAPIER,
    world,
    fixedDt,
    eventQueue: new RAPIER.EventQueue(true),
    colliderEntities: new Map(),
    bodyEntities: new Map(),
    physicalEntities: new Set(),
    dynamicEntities: new Set(),
    kinematicEntities: new Set(),
    joints: new Set(),
    controllers: new Set(),
    collisionEvents: [],
    contactEvents: [],
    disposed: false,
    stepCount: 0,
  };
  return runtime;
}

export function createCrashStaticCuboid(runtime, {
  id = 'environment', x = 0, y = 0, z = 0,
  halfWidth = 1, halfHeight = 1, halfLength = 1,
  yaw = 0, pitch = 0, roll = 0,
  friction = 1.1, restitution = 0.005,
  group = CRASH_COLLISION.ENVIRONMENT,
  sensor = false,
  metadata = {},
} = {}) {
  const quaternion = new RAPIER.Quaternion();
  const sy = Math.sin(yaw * 0.5); const cy = Math.cos(yaw * 0.5);
  const sx = Math.sin(pitch * 0.5); const cx = Math.cos(pitch * 0.5);
  const sz = Math.sin(roll * 0.5); const cz = Math.cos(roll * 0.5);
  quaternion.x = sx * cy * cz + cx * sy * sz;
  quaternion.y = cx * sy * cz - sx * cy * sz;
  quaternion.z = cx * cy * sz + sx * sy * cz;
  quaternion.w = cx * cy * cz - sx * sy * sz;
  const entity = { id, classId: metadata.classId || 'environment', kind: metadata.kind || 'environment', static: true, metadata, colliders: [] };
  const desc = configureCollider(
    RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight, halfLength)
      .setTranslation(x, y, z)
      .setRotation(quaternion),
    {
      friction,
      restitution,
      sensor,
      collisionGroups: crashInteractionGroups(group),
      events: metadata.events !== false,
      forceThreshold: metadata.forceThreshold || 350,
    },
  );
  const collider = runtime.world.createCollider(desc);
  registerCollider(runtime, collider, entity, metadata.role || 'environment');
  return entity;
}

export function createCrashStaticTrimesh(runtime, {
  id = 'authored-environment',
  vertices,
  indices,
  friction = 1.15,
  restitution = 0.002,
  group = CRASH_COLLISION.ENVIRONMENT,
  metadata = {},
} = {}) {
  const vertexArray = vertices instanceof Float32Array ? vertices : new Float32Array(vertices || []);
  const indexArray = indices instanceof Uint32Array ? indices : new Uint32Array(indices || []);
  if (vertexArray.length < 9 || indexArray.length < 3 || vertexArray.length % 3 || indexArray.length % 3) {
    throw new Error(`Invalid authored trimesh ${id}: ${vertexArray.length / 3} vertices, ${indexArray.length / 3} triangles`);
  }
  const entity = {
    id,
    classId: metadata.classId || 'environment',
    kind: metadata.kind || 'environment',
    static: true,
    metadata,
    colliders: [],
  };
  const desc = configureCollider(RAPIER.ColliderDesc.trimesh(vertexArray, indexArray), {
    friction,
    restitution,
    collisionGroups: crashInteractionGroups(group),
    events: metadata.events !== false,
    forceThreshold: metadata.forceThreshold || 350,
  });
  const collider = runtime.world.createCollider(desc);
  registerCollider(runtime, collider, entity, metadata.role || 'authored-trimesh');
  return entity;
}

function vehicleInertia(profile) {
  if (profile.inertia) return profile.inertia;
  const mass = Math.max(1, Number(profile.mass) || 1);
  const width = Math.max(0.1, Number(profile.width) || 1);
  const height = Math.max(0.1, Number(profile.height) || 1);
  const length = Math.max(0.1, Number(profile.length) || 1);
  return {
    x: mass * (height * height + length * length) / 12 * 0.88,
    y: mass * (width * width + length * length) / 12 * 0.92,
    z: mass * (width * width + height * height) / 12 * 0.82,
  };
}

function vehicleCenterOfMass(profile) {
  return profile.centerOfMass || { x: 0, y: Number(profile.comY) || 0, z: 0 };
}

function vehicleBodyDesc(profile, pose, options, type) {
  const yaw = Number(pose.yaw) || 0;
  const desc = type === 'kinematic'
    ? RAPIER.RigidBodyDesc.kinematicPositionBased()
    : RAPIER.RigidBodyDesc.dynamic();
  desc
    .setTranslation(Number(pose.x) || 0, Number(pose.y) || profile.height * 0.58, Number(pose.z) || 0)
    .setRotation(yawQuaternion(yaw))
    .setLinvel(Number(pose.vx) || Math.sin(yaw) * (Number(pose.speed) || 0), Number(pose.vy) || 0, Number(pose.vz) || Math.cos(yaw) * (Number(pose.speed) || 0))
    .setLinearDamping(options.linearDamping ?? 0.24)
    .setAngularDamping(options.angularDamping ?? profile.angularDamping ?? 1.7)
    .setCanSleep(true)
    .setCcdEnabled(options.ccd !== false)
    .setSoftCcdPrediction(options.softCcdPrediction ?? 0.75)
    .setAdditionalMassProperties(
      Math.max(1, Number(profile.mass) || 1),
      vehicleCenterOfMass(profile),
      vehicleInertia(profile),
      { x: 0, y: 0, z: 0, w: 1 },
    )
    .setAdditionalSolverIterations(profile.mass > 5000 ? 4 : 2);
  return desc;
}

function createCrashVehicleBody(runtime, entity, profile, pose = {}, options = {}, type = 'dynamic') {
  const group = options.group || CRASH_COLLISION.TRAFFIC;
  const desc = vehicleBodyDesc(profile, pose, options, type);
  entity.body = runtime.world.createRigidBody(desc);
  entity.profile = profile;
  entity.classId ||= profile.id;
  entity.kind ||= 'vehicle';
  entity.dynamic = type === 'dynamic';
  entity.bodyType = type;
  entity.collisionGroup = group;
  entity.colliders = [];
  compoundVehicleColliders(runtime, entity, profile, group);
  entity.body.recomputeMassPropertiesFromColliders();
  runtime.bodyEntities.set(entity.body.handle, entity);
  runtime.physicalEntities.add(entity);
  if (type === 'dynamic') runtime.dynamicEntities.add(entity);
  else runtime.kinematicEntities.add(entity);
  return entity;
}

export function createCrashDynamicVehicle(runtime, entity, profile, pose = {}, options = {}) {
  return createCrashVehicleBody(runtime, entity, profile, pose, options, 'dynamic');
}

export function createCrashKinematicVehicle(runtime, entity, profile, pose = {}, options = {}) {
  const created = createCrashVehicleBody(runtime, entity, profile, pose, { ...options, ccd: false }, 'kinematic');
  const yaw = Number(pose.yaw) || 0;
  created.kinematicLinearVelocity = {
    x: Number(pose.vx) || Math.sin(yaw) * (Number(pose.speed) || 0),
    y: Number(pose.vy) || 0,
    z: Number(pose.vz) || Math.cos(yaw) * (Number(pose.speed) || 0),
  };
  created.kinematicAngularVelocity = { x: 0, y: Number(pose.angularY) || 0, z: 0 };
  return created;
}

function exactBodyState(entity, linearVelocity, angularVelocity) {
  const position = entity.body.translation();
  const rotation = entity.body.rotation();
  const linear = linearVelocity || entity.kinematicLinearVelocity || entity.body.linvel();
  const angular = angularVelocity || entity.kinematicAngularVelocity || entity.body.angvel();
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    linear: { x: linear.x, y: linear.y, z: linear.z },
    angular: { x: angular.x, y: angular.y, z: angular.z },
  };
}

export function promoteCrashVehicleBody(runtime, entity, velocities = {}) {
  if (!runtime || !entity?.body || entity.body.isDynamic()) return false;
  const state = exactBodyState(entity, velocities.linearVelocity, velocities.angularVelocity);
  entity.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  entity.body.setTranslation(state.position, true);
  entity.body.setRotation(state.rotation, true);
  entity.body.setLinvel(state.linear, true);
  entity.body.setAngvel(state.angular, true);
  entity.body.enableCcd(true);
  entity.body.setSoftCcdPrediction(0.75);
  entity.body.recomputeMassPropertiesFromColliders();
  entity.dynamic = true;
  entity.bodyType = 'dynamic';
  runtime.kinematicEntities.delete(entity);
  runtime.dynamicEntities.add(entity);
  return state;
}

export function demoteCrashVehicleBody(runtime, entity, velocities = {}) {
  if (!runtime || !entity?.body || !entity.body.isDynamic()) return false;
  const state = exactBodyState(entity, velocities.linearVelocity, velocities.angularVelocity);
  entity.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
  entity.body.setTranslation(state.position, false);
  entity.body.setRotation(state.rotation, false);
  entity.body.setLinvel(state.linear, false);
  entity.body.setAngvel(state.angular, false);
  entity.kinematicLinearVelocity = state.linear;
  entity.kinematicAngularVelocity = state.angular;
  entity.dynamic = false;
  entity.bodyType = 'kinematic';
  runtime.dynamicEntities.delete(entity);
  runtime.kinematicEntities.add(entity);
  return state;
}

export function createCrashDebrisBody(runtime, entity, {
  x = 0, y = 1, z = 0, yaw = 0,
  width = 0.45, height = 0.18, length = 0.75,
  mass = 18, velocity = {}, angular = {},
} = {}) {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setRotation(yawQuaternion(yaw))
    .setLinvel(velocity.x || 0, velocity.y || 0, velocity.z || 0)
    // RigidBodyDesc.setAngvel takes one vector (unlike setLinvel's scalar
    // overload). Passing three numbers initializes a NaN quaternion in Rapier.
    .setAngvel({ x: angular.x || 0, y: angular.y || 0, z: angular.z || 0 })
    .setLinearDamping(0.45)
    .setAngularDamping(1.2)
    .setCanSleep(true)
    .setCcdEnabled(Math.hypot(velocity.x || 0, velocity.y || 0, velocity.z || 0) > 16);
  entity.body = runtime.world.createRigidBody(desc);
  entity.classId ||= 'debris';
  entity.kind = 'debris';
  entity.dynamic = true;
  entity.colliders = [];
  const collider = configureCollider(
    RAPIER.ColliderDesc.roundCuboid(width * 0.5, height * 0.5, length * 0.5, Math.min(0.08, height * 0.3)).setMass(mass),
    {
      friction: 0.82,
      restitution: 0.08,
      collisionGroups: crashInteractionGroups(CRASH_COLLISION.DEBRIS),
      forceThreshold: 600,
    },
  );
  registerCollider(runtime, runtime.world.createCollider(collider, entity.body), entity, 'debris');
  runtime.bodyEntities.set(entity.body.handle, entity);
  runtime.physicalEntities.add(entity);
  runtime.dynamicEntities.add(entity);
  return entity;
}

export function createCrashArticulation(runtime, tractor, trailer) {
  if (!tractor?.body || !trailer?.body) return null;
  const jointData = RAPIER.JointData.revolute(
    { x: 0, y: 0.1, z: -tractor.profile.length * 0.44 },
    { x: 0, y: 0.1, z: trailer.profile.length * 0.44 },
    { x: 0, y: 1, z: 0 },
  );
  const joint = runtime.world.createImpulseJoint(jointData, tractor.body, trailer.body, true);
  // These bodies meet at the joint and must never solve contacts against one
  // another. They still collide normally with every other vehicle and prop.
  joint.setContactsEnabled(false);
  runtime.joints.add(joint);
  tractor.trailer = trailer;
  trailer.tractor = tractor;
  return joint;
}

function eventEntity(runtime, handle) {
  return runtime.colliderEntities.get(handle) || null;
}

function contactPoint(runtime, a, b) {
  let point = null;
  runtime.world.contactPair(a.collider, b.collider, (manifold) => {
    if (point || manifold.numSolverContacts() < 1) return;
    const at = manifold.solverContactPoint(0);
    if (at) point = { x: at.x, y: at.y, z: at.z };
  });
  if (point) return point;
  const ap = a.entity.body?.translation?.() || a.collider.translation();
  const bp = b.entity.body?.translation?.() || b.collider.translation();
  return { x: (ap.x + bp.x) * 0.5, y: (ap.y + bp.y) * 0.5, z: (ap.z + bp.z) * 0.5 };
}

function dynamicMass(entity) {
  if (!entity?.body?.isDynamic?.()) return 0;
  const mass = Number(entity.body.mass?.()) || 0;
  return Number.isFinite(mass) ? Math.max(0, mass) : 0;
}

function physicalImpactImpulse(a, b, rawImpulse, relativeSpeed) {
  const massA = dynamicMass(a.entity);
  const massB = dynamicMass(b.entity);
  const effectiveMass = massA > 0 && massB > 0
    ? massA * massB / (massA + massB)
    : Math.max(massA, massB);
  if (!(effectiveMass > 0)) return Math.max(0, rawImpulse);
  // Contact-force events include positional-correction pressure. Damage and
  // scoring consume the physically possible collision impulse instead: the
  // reduced mass times closing speed, with headroom for restitution and
  // compound contact distribution.
  const physicalLimit = effectiveMass * Math.max(0.35, relativeSpeed) * 2.2;
  return Math.min(Math.max(0, rawImpulse), physicalLimit);
}

export function stepCrashPhysics(runtime) {
  if (!runtime || runtime.disposed) return { collisions: [], contacts: [] };
  runtime.collisionEvents.length = 0;
  runtime.contactEvents.length = 0;
  runtime.world.step(runtime.eventQueue);
  runtime.stepCount += 1;
  runtime.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
    const a = eventEntity(runtime, handle1);
    const b = eventEntity(runtime, handle2);
    if (!a || !b) return;
    runtime.collisionEvents.push({ a, b, started, step: runtime.stepCount });
  });
  runtime.eventQueue.drainContactForceEvents((event) => {
    const a = eventEntity(runtime, event.collider1());
    const b = eventEntity(runtime, event.collider2());
    if (!a || !b) return;
    const force = event.totalForceMagnitude();
    const direction = event.maxForceDirection();
    const av = a.entity.body?.linvel?.() || { x: 0, y: 0, z: 0 };
    const bv = b.entity.body?.linvel?.() || { x: 0, y: 0, z: 0 };
    const relativeSpeed = Math.hypot(av.x - bv.x, av.y - bv.y, av.z - bv.z);
    const rawSolverImpulse = force * runtime.fixedDt;
    runtime.contactEvents.push({
      a,
      b,
      force,
      rawSolverImpulse,
      impulse: physicalImpactImpulse(a, b, rawSolverImpulse, relativeSpeed),
      relativeSpeed,
      direction: { x: direction.x, y: direction.y, z: direction.z },
      point: contactPoint(runtime, a, b),
      step: runtime.stepCount,
    });
  });
  return { collisions: runtime.collisionEvents, contacts: runtime.contactEvents };
}

export function removeCrashEntity(runtime, entity) {
  if (!runtime || !entity || entity.removed) return false;
  entity.removed = true;
  for (const collider of entity.colliders || []) runtime.colliderEntities.delete(collider.handle);
  if (entity.body) {
    runtime.bodyEntities.delete(entity.body.handle);
    runtime.physicalEntities.delete(entity);
    runtime.dynamicEntities.delete(entity);
    runtime.kinematicEntities.delete(entity);
    runtime.world.removeRigidBody(entity.body);
    entity.body = null;
  }
  return true;
}

export function crashPhysicsSnapshot(runtime) {
  let sleeping = 0;
  let active = 0;
  for (const entity of runtime?.dynamicEntities || []) {
    if (!entity.body) continue;
    if (entity.body.isSleeping()) sleeping += 1;
    else active += 1;
  }
  return {
    version: RAPIER.version(),
    step: runtime?.stepCount || 0,
    active,
    sleeping,
    bodies: active + sleeping,
    kinematic: runtime?.kinematicEntities?.size || 0,
    physicalBodies: runtime?.physicalEntities?.size || 0,
    colliders: runtime?.colliderEntities?.size || 0,
    joints: runtime?.joints?.size || 0,
  };
}

export function disposeCrashPhysics(runtime) {
  if (!runtime || runtime.disposed) return false;
  runtime.disposed = true;
  for (const controller of runtime.controllers) {
    try { runtime.world.removeVehicleController(controller); } catch (_) {}
  }
  runtime.controllers.clear();
  runtime.joints.clear();
  runtime.physicalEntities.clear();
  runtime.dynamicEntities.clear();
  runtime.kinematicEntities.clear();
  runtime.colliderEntities.clear();
  runtime.bodyEntities.clear();
  try { runtime.eventQueue.free(); } catch (_) {}
  try { runtime.world.free(); } catch (_) {}
  return true;
}

export { RAPIER };
