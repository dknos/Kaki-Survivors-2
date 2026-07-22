import assert from 'node:assert/strict';

import {
  createCrashArticulation,
  createCrashDebrisBody,
  createCrashDynamicVehicle,
  createCrashKinematicVehicle,
  createCrashPhysicsRuntime,
  createCrashStaticCuboid,
  crashVehicleColliderLayout,
  crashPhysicsSnapshot,
  disposeCrashPhysics,
  promoteCrashVehicleBody,
  stepCrashPhysics,
} from '../src/racing/crash/crashPhysics.js';
import {
  CRASH_COLLISION,
  CRASH_COLLIDER_TOLERANCES,
  CRASH_PLAYER_PROFILES,
  CRASH_QUALITY,
  CRASH_TRAFFIC_PROFILES,
  crashDynamicBudgetSaturated,
  validateCrashCollisionMatrix,
} from '../src/racing/crash/crashConfig.js';
import {
  createCrashVehicleController,
  stepCrashVehicleController,
} from '../src/racing/crash/crashVehicleController.js';

let assertions = 0;
function expect(value, message) { assertions += 1; assert.ok(value, message); }
function close(actual, expected, tolerance, message) { assertions += 1; assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }

function addGround(runtime, extent = 160) {
  createCrashStaticCuboid(runtime, { id: 'ground', x: 0, y: -0.25, z: 0, halfWidth: extent, halfHeight: 0.25, halfLength: extent, friction: 1.2, metadata: { events: false } });
}

function pitchOf(body) {
  const q = body.rotation();
  return Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z - q.w * q.x))));
}

function finiteBody(body) {
  const position = body.translation();
  const rotation = body.rotation();
  const linear = body.linvel();
  const angular = body.angvel();
  return [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, linear.x, linear.y, linear.z, angular.x, angular.y, angular.z].every(Number.isFinite);
}

{
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime);
  const prop = { id: 'finite-road-prop', classId: 'barrel', kind: 'debris' };
  createCrashDebrisBody(runtime, prop, { x: 12, y: 1.2, z: -4, mass: 42, angular: { x: 0.4, y: -0.8, z: 0.2 } });
  const car = { id: 'finite-neighbor', classId: 'sedan', kind: 'traffic' };
  createCrashDynamicVehicle(runtime, car, CRASH_TRAFFIC_PROFILES.sedan, { x: -12, y: 1, z: 4 });
  for (let step = 0; step < 720; step++) stepCrashPhysics(runtime);
  const propPosition = prop.body.translation();
  expect([propPosition.x, propPosition.y, propPosition.z].every(Number.isFinite), 'mixed debris and compound vehicles must never poison the world with NaN transforms');
  expect(prop.body.isSleeping(), 'settled lightweight debris must sleep');
  disposeCrashPhysics(runtime);
}

console.log('Kaki Catastrophe Rapier physics smoke');

{
  const matrix = validateCrashCollisionMatrix();
  expect(matrix.valid, `collision matrix must be symmetric and complete: ${matrix.errors.join(', ')}`);
  expect((CRASH_COLLISION.PLAYER & CRASH_COLLISION.TRAFFIC) === 0, 'collision memberships must be independent bits');
}

{
  const signatures = new Set();
  for (const profile of [...Object.values(CRASH_PLAYER_PROFILES), ...Object.values(CRASH_TRAFFIC_PROFILES)]) {
    const layout = crashVehicleColliderLayout(profile);
    const tolerance = CRASH_COLLIDER_TOLERANCES[profile.id];
    expect(tolerance, `${profile.id} must declare an authored collider-alignment tolerance`);
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (const shape of layout) {
      const extents = shape.type === 'cylinder'
        ? [shape.radius, shape.radius, shape.halfHeight]
        : shape.halfExtents.map((extent) => extent + shape.radius);
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], shape.translation[axis] - extents[axis]);
        maximum[axis] = Math.max(maximum[axis], shape.translation[axis] + extents[axis]);
      }
    }
    const dimensions = maximum.map((value, axis) => value - minimum[axis]);
    const center = maximum.map((value, axis) => (value + minimum[axis]) * 0.5);
    close(dimensions[0], profile.width, tolerance.width, `${profile.id} compound hull width must align to its authored silhouette`);
    close(dimensions[1], profile.height, tolerance.height, `${profile.id} compound hull height must align to its authored silhouette`);
    close(dimensions[2], profile.length, tolerance.length, `${profile.id} compound hull length must align to its authored silhouette`);
    expect(Math.abs(center[0]) <= tolerance.width && Math.abs(center[2]) <= tolerance.length,
      `${profile.id} compound hull center drifted outside authored tolerance: ${center.join(',')}`);
    expect(layout.every((shape) => shape.role && !shape.role.startsWith('generic')),
      `${profile.id} fell back to a generic collision box`);
    signatures.add(layout.map((shape) => `${shape.role}:${shape.type}:${shape.translation.join(',')}`).join('|'));
  }
  expect(signatures.size === Object.keys(CRASH_COLLIDER_TOLERANCES).length,
    'every player and traffic class must retain a distinct compound-collider signature');
}

{
  const runtime = await createCrashPhysicsRuntime();
  expect(
    Math.abs(runtime.fixedDt - (1 / 90)) < 1e-12
      && Math.abs(runtime.world.timestep - (1 / 90)) < 1e-6,
    'crash world must use a fixed 1/90 second timestep',
  );
  expect(runtime.RAPIER.version() === '0.19.3', `Rapier must stay pinned at 0.19.3, found ${runtime.RAPIER.version()}`);
  addGround(runtime);
  const sedan = { id: 'settling-sedan', classId: 'sedan', kind: 'traffic' };
  createCrashDynamicVehicle(runtime, sedan, CRASH_TRAFFIC_PROFILES.sedan, { x: 0, y: 3, z: 0 });
  for (let step = 0; step < 720; step++) stepCrashPhysics(runtime);
  close(sedan.body.mass(), 1320, 0.5, 'compound collider mass must match the sedan class');
  expect(sedan.body.isSleeping(), 'an undisturbed wreck must sleep after settling');
  const snapshot = crashPhysicsSnapshot(runtime);
  expect(snapshot.sleeping === 1 && snapshot.active === 0, 'settled body accounting must separate sleeping bodies');
  expect(disposeCrashPhysics(runtime), 'first physics cleanup must succeed');
  expect(!disposeCrashPhysics(runtime), 'physics cleanup must be idempotent');
}

{
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime);
  const compact = { id: 'head-compact', classId: 'sedan', kind: 'traffic' };
  const bus = { id: 'head-bus', classId: 'bus', kind: 'traffic' };
  createCrashDynamicVehicle(runtime, compact, CRASH_TRAFFIC_PROFILES.sedan, { x: 0, y: 1, z: -15, yaw: 0, speed: 24 });
  createCrashDynamicVehicle(runtime, bus, CRASH_TRAFFIC_PROFILES.bus, { x: 0, y: 2, z: 2, yaw: 0, speed: 0 });
  let largestImpulse = 0;
  for (let step = 0; step < 240; step++) {
    const events = stepCrashPhysics(runtime);
    for (const contact of events.contacts) largestImpulse = Math.max(largestImpulse, contact.impulse);
  }
  close(bus.body.mass(), 10800, 1, 'bus mass must remain physically distinct');
  expect(largestImpulse > 10000, 'head-on traffic contact must emit a qualifying contact-force event');
  expect(bus.body.translation().z < 3.2, 'a compact must not toss a bus like a toy');
  expect(Math.abs(bus.body.translation().z - 2) < Math.abs(compact.body.translation().z + 15), 'relative mass must dominate displacement');
  disposeCrashPhysics(runtime);
}

{
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime);
  const striker = { id: 'side-striker', classId: 'sedan', kind: 'traffic' };
  const victim = { id: 'side-victim', classId: 'sedan', kind: 'traffic' };
  createCrashDynamicVehicle(runtime, striker, CRASH_TRAFFIC_PROFILES.sedan, { x: -14, y: 1, z: 1, yaw: Math.PI / 2, speed: 25 });
  createCrashDynamicVehicle(runtime, victim, CRASH_TRAFFIC_PROFILES.sedan, { x: 0, y: 1, z: 0, yaw: 0, speed: 0 });
  let peakYaw = 0;
  for (let step = 0; step < 200; step++) {
    stepCrashPhysics(runtime);
    peakYaw = Math.max(peakYaw, Math.abs(victim.body.angvel().y));
  }
  expect(peakYaw > 0.25, 'a fast side impact must rotate the victim');
  expect(Math.abs(victim.body.translation().x) > 1.5, 'a side impact must redirect the victim laterally');
  disposeCrashPhysics(runtime);
}

{
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime);
  createCrashStaticCuboid(runtime, { id: 'ccd-wall', x: 0, y: 2, z: 0, halfWidth: 5, halfHeight: 2, halfLength: 0.12 });
  const fast = { id: 'ccd-fast', classId: 'sedan', kind: 'traffic' };
  createCrashDynamicVehicle(runtime, fast, CRASH_TRAFFIC_PROFILES.sedan, { x: 0, y: 1, z: -18, yaw: 0, speed: 95 }, { ccd: true });
  let furthestZ = -Infinity;
  for (let step = 0; step < 60; step++) {
    stepCrashPhysics(runtime);
    furthestZ = Math.max(furthestZ, fast.body.translation().z);
  }
  expect(furthestZ < 1, `CCD vehicle tunneled through a thin wall (furthest z ${furthestZ})`);
  disposeCrashPhysics(runtime);
}

for (const profile of Object.values(CRASH_PLAYER_PROFILES)) {
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime, 300);
  const player = { id: `launch-${profile.id}`, classId: 'player', kind: 'player', playerProfile: profile, damage: {} };
  createCrashDynamicVehicle(runtime, player, profile, { x: 0, y: 1.6, z: 0 }, { ccd: true, group: CRASH_COLLISION.PLAYER });
  const controller = createCrashVehicleController(runtime, player, profile);
  for (let step = 0; step < 120; step++) {
    stepCrashVehicleController(runtime, player, { throttle: 0 }, 1 / 90);
    stepCrashPhysics(runtime);
  }
  let peakSpeed = 0;
  let peakPitch = 0;
  let minimumFrontContacts = 2;
  let wheelStateFinite = true;
  for (let step = 0; step < 450; step++) {
    const state = stepCrashVehicleController(runtime, player, { throttle: 1, steer: step > 330 ? 0.2 : 0 }, 1 / 90);
    stepCrashPhysics(runtime);
    peakSpeed = Math.max(peakSpeed, state.speed);
    peakPitch = Math.max(peakPitch, Math.abs(pitchOf(player.body)));
    minimumFrontContacts = Math.min(minimumFrontContacts, Number(controller.wheelIsInContact(0)) + Number(controller.wheelIsInContact(1)));
    wheelStateFinite &&= state.suspension.every(Number.isFinite)
      && state.wheelRotation.every(Number.isFinite)
      && state.wheelContacts.every((wheel) => !wheel.hardPoint || Object.values(wheel.hardPoint).every(Number.isFinite));
  }
  const minimumSpeed = profile.id === 'pocket' ? 23 : profile.id === 'muscle' ? 19 : 17;
  const frontForce = (controller.wheelEngineForce(0) || 0) + (controller.wheelEngineForce(1) || 0);
  const rearForce = (controller.wheelEngineForce(2) || 0) + (controller.wheelEngineForce(3) || 0);
  expect(controller.numWheels() === 4, `${profile.id} must own four raycast wheels`);
  expect(peakSpeed > minimumSpeed, `${profile.id} must reach the junction at crash speed, found ${peakSpeed}`);
  expect(peakPitch < 0.12, `${profile.id} flat-ground launch pitched ${peakPitch} rad`);
  expect(minimumFrontContacts > 0, `${profile.id} performed a flat-ground wheelie`);
  expect(wheelStateFinite, `${profile.id} produced a non-finite wheel transform input`);
  close(frontForce, profile.engineForce * profile.driveBias.front, 0.05, `${profile.id} front axle must receive its declared share of total engine force`);
  close(rearForce, profile.engineForce * profile.driveBias.rear, 0.05, `${profile.id} rear axle must receive its declared share of total engine force`);
  expect(player.body.translation().y > profile.wheelRadius + 0.28, `${profile.id} suspension must keep its chassis clear of the road`);
  expect(Math.abs(player.body.translation().x) > 0.15, `${profile.id} steering must remain effective after launch`);
  disposeCrashPhysics(runtime);
}

{
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime);
  const profile = CRASH_PLAYER_PROFILES.muscle;
  const player = { id: 'airborne-assist', classId: 'player', kind: 'player', playerProfile: profile, damage: {}, drivingAssistSuppressed: true };
  createCrashDynamicVehicle(runtime, player, profile, { x: 0, y: 8, z: 0, vy: 5 }, { ccd: true, group: CRASH_COLLISION.PLAYER });
  createCrashVehicleController(runtime, player, profile);
  player.body.setAngvel({ x: 0.4, y: 0.2, z: 2.1 }, true);
  let maximumRollRate = 0;
  for (let step = 0; step < 32; step++) {
    const state = stepCrashVehicleController(runtime, player, { throttle: 1 }, 1 / 90);
    stepCrashPhysics(runtime);
    maximumRollRate = Math.max(maximumRollRate, Math.abs(player.body.angvel().z));
    if (step === 31) expect(state.assistance < 0.08, 'driving assistance must blend out while airborne/after a qualifying collision');
  }
  expect(maximumRollRate > 1.2, 'airborne crash rotation must remain physical instead of globally locked');
  disposeCrashPhysics(runtime);
}

for (const quality of Object.values(CRASH_QUALITY)) {
  const runtime = await createCrashPhysicsRuntime({ gravity: 0 });
  const proxy = { id: `saturated-visible-proxy-${quality.id}`, classId: 'bus', kind: 'traffic', active: true, dynamic: false };
  createCrashKinematicVehicle(runtime, proxy, CRASH_TRAFFIC_PROFILES.bus, { x: 0, y: 1.7, z: 0 });
  const manager = {
    runtime,
    quality,
    entities: [proxy],
    dynamicCount: quality.maxDynamicBodies,
    kinematicCount: 1,
    promotedCount: 0,
    demotedCount: 0,
    saturatedProxyCount: 0,
  };
  expect(crashDynamicBudgetSaturated(manager.quality, manager.dynamicCount, 1),
    `${quality.id} dynamic cap must report a late vehicle as saturated`);
  proxy.promotionState = 'saturated-physical-proxy';
  equal(proxy.promotionState, 'saturated-physical-proxy', `${quality.id} late-arriving vehicle must expose saturated proxy state`);
  const striker = { id: `proxy-striker-${quality.id}`, classId: 'sedan', kind: 'traffic' };
  createCrashDynamicVehicle(runtime, striker, CRASH_TRAFFIC_PROFILES.sedan, { x: 0, y: 1, z: -22, speed: 35 }, { ccd: true });
  let contacts = 0;
  let furthest = -Infinity;
  for (let step = 0; step < 160; step++) {
    const at = proxy.body.translation();
    proxy.body.setNextKinematicTranslation({ x: at.x, y: at.y, z: at.z });
    const events = stepCrashPhysics(runtime);
    contacts += events.contacts.length;
    furthest = Math.max(furthest, striker.body.translation().z);
  }
  expect(proxy.colliders.length === 2, `${quality.id} saturated visible proxy must retain its compound collider`);
  expect(contacts > 0, `${quality.id} dynamic vehicle must collide with a late saturated proxy`);
  expect(furthest < 4, `${quality.id} dynamic striker ghosted through its physical proxy (${furthest})`);
  disposeCrashPhysics(runtime);
}

{
  const runtime = await createCrashPhysicsRuntime();
  const entity = { id: 'atomic-promotion', classId: 'sedan', kind: 'traffic' };
  createCrashKinematicVehicle(runtime, entity, CRASH_TRAFFIC_PROFILES.sedan, { x: 4, y: 0.54, z: -8, yaw: 0.2, speed: 15 });
  entity.kinematicLinearVelocity = { x: Math.sin(0.2) * 15, y: 0, z: Math.cos(0.2) * 15 };
  entity.kinematicAngularVelocity = { x: 0, y: 0.12, z: 0 };
  const bodyHandle = entity.body.handle;
  const colliderHandles = entity.colliders.map((collider) => collider.handle);
  const beforePosition = { ...entity.body.translation() };
  const beforeRotation = { ...entity.body.rotation() };
  const promoted = promoteCrashVehicleBody(runtime, entity);
  expect(promoted && entity.body.isDynamic(), 'promotion must change the existing body to dynamic');
  equal(entity.body.handle, bodyHandle, 'promotion must preserve the rigid-body handle atomically');
  expect(entity.colliders.every((collider, index) => collider.handle === colliderHandles[index]), 'promotion must preserve every compound collider handle');
  close(entity.body.translation().x, beforePosition.x, 1e-7, 'promotion must preserve exact x');
  close(entity.body.translation().z, beforePosition.z, 1e-7, 'promotion must preserve exact z');
  close(entity.body.rotation().y, beforeRotation.y, 1e-7, 'promotion must preserve exact rotation');
  close(entity.body.linvel().x, entity.kinematicLinearVelocity.x, 1e-6, 'promotion must copy exact linear velocity');
  close(entity.body.angvel().y, entity.kinematicAngularVelocity.y, 1e-6, 'promotion must copy exact angular velocity');
  disposeCrashPhysics(runtime);
}

for (const [classId, targetProfile] of Object.entries(CRASH_TRAFFIC_PROFILES).filter(([id]) => id !== 'trailer')) {
  for (const speed of [15, 25, 35]) {
    const runtime = await createCrashPhysicsRuntime({ gravity: 0 });
    const striker = { id: `matrix-player-${classId}-${speed}`, classId: 'player', kind: 'player' };
    const target = { id: `matrix-${classId}-${speed}`, classId, kind: 'traffic' };
    createCrashDynamicVehicle(runtime, striker, CRASH_PLAYER_PROFILES.muscle, { x: 0, y: 1, z: -24, speed }, { ccd: true, group: CRASH_COLLISION.PLAYER });
    createCrashDynamicVehicle(runtime, target, targetProfile, { x: 0, y: 1, z: 0 }, { ccd: true, group: CRASH_COLLISION.TRAFFIC });
    let contact = false;
    for (let step = 0; step < 220; step++) {
      const events = stepCrashPhysics(runtime);
      contact ||= events.contacts.some((event) => (event.a.entity === striker && event.b.entity === target) || (event.a.entity === target && event.b.entity === striker));
    }
    expect(contact, `collision matrix missed player -> ${classId} at ${speed} m/s`);
    expect(finiteBody(striker.body) && finiteBody(target.body), `${classId} collision at ${speed} m/s produced a non-finite body`);
    disposeCrashPhysics(runtime);
  }
}

for (let seed = 0; seed < 3; seed++) {
  const runtime = await createCrashPhysicsRuntime({ gravity: 0 });
  const profiles = Object.values(CRASH_TRAFFIC_PROFILES).filter((profile) => !['trailer', 'tanker'].includes(profile.id));
  const bodies = [];
  for (let index = 0; index < 8; index++) {
    const angle = seed * 0.19 + index / 8 * Math.PI * 2;
    const profile = profiles[(index + seed) % profiles.length];
    const entity = { id: `pileup-${seed}-${index}`, classId: profile.id, kind: 'traffic' };
    createCrashDynamicVehicle(runtime, entity, profile, {
      x: Math.sin(angle) * 18,
      y: 1,
      z: Math.cos(angle) * 18,
      yaw: angle + Math.PI,
      speed: 18 + (index % 3) * 2,
    }, { ccd: true });
    bodies.push(entity);
  }
  let contactCount = 0;
  let maximumSpeed = 0;
  for (let step = 0; step < 540; step++) {
    const events = stepCrashPhysics(runtime);
    contactCount += events.contacts.length;
    for (const entity of bodies) {
      expect(finiteBody(entity.body), `seed ${seed} produced NaN/Infinity at step ${step}`);
      const velocity = entity.body.linvel();
      maximumSpeed = Math.max(maximumSpeed, Math.hypot(velocity.x, velocity.y, velocity.z));
    }
  }
  expect(contactCount >= 8, `seed ${seed} did not form a physical pileup`);
  expect(maximumSpeed < 85, `seed ${seed} produced an explosive resting contact (${maximumSpeed} m/s)`);
  disposeCrashPhysics(runtime);
}

{
  const runtime = await createCrashPhysicsRuntime();
  addGround(runtime);
  const tractor = { id: 'tractor', classId: 'semi', kind: 'traffic' };
  const trailer = { id: 'trailer', classId: 'trailer', kind: 'traffic' };
  const gap = CRASH_TRAFFIC_PROFILES.semi.length * 0.44 + CRASH_TRAFFIC_PROFILES.trailer.length * 0.44;
  createCrashDynamicVehicle(runtime, tractor, CRASH_TRAFFIC_PROFILES.semi, { x: 0, y: 0.6, z: 0, speed: 13.1 });
  createCrashDynamicVehicle(runtime, trailer, CRASH_TRAFFIC_PROFILES.trailer, { x: 0, y: 0.6, z: -gap, speed: 13.1 });
  const articulation = createCrashArticulation(runtime, tractor, trailer);
  expect(articulation, 'semi and trailer must receive a revolute articulation');
  expect(!articulation.contactsEnabled(), 'connected tractor/trailer colliders must not fight their fifth-wheel joint');
  expect(crashPhysicsSnapshot(runtime).joints === 1, 'articulation must be tracked for jackknife gameplay and cleanup');
  let maximumSpeed = 0;
  for (let step = 0; step < 1800; step++) {
    stepCrashPhysics(runtime);
    expect(finiteBody(tractor.body) && finiteBody(trailer.body), `articulated freight became non-finite at step ${step}`);
    for (const entity of [tractor, trailer]) {
      const velocity = entity.body.linvel();
      maximumSpeed = Math.max(maximumSpeed, Math.hypot(velocity.x, velocity.y, velocity.z));
    }
  }
  expect(maximumSpeed < 20, `articulated freight injected solver energy (${maximumSpeed} m/s)`);
  disposeCrashPhysics(runtime);
}

console.log(`Kaki Catastrophe Rapier physics smoke passed: ${assertions} assertions.`);
