/**
 * Monster-only four-contact-patch suspension and support solver.
 *
 * The shared Rally integrator still owns inexpensive horizontal movement, but
 * Monster Smash no longer asks one chassis point to describe a four-wheel
 * truck.  This module samples terrain/wreck support at every tire, integrates
 * four bounded spring/damper states, and exposes deterministic contact truth to
 * destruction, presentation, audio, and browser QA.
 */
import { clamp } from './physics.js';

export const MONSTER_WHEEL_LAYOUT = Object.freeze([
  Object.freeze({ id: 'leftRear', side: -1, axle: -1, sideName: 'left', axleName: 'rear' }),
  Object.freeze({ id: 'leftFront', side: -1, axle: 1, sideName: 'left', axleName: 'front' }),
  Object.freeze({ id: 'rightRear', side: 1, axle: -1, sideName: 'right', axleName: 'rear' }),
  Object.freeze({ id: 'rightFront', side: 1, axle: 1, sideName: 'right', axleName: 'front' }),
]);

const DEFAULT_CONTACT = Object.freeze({
  wheelbase: 3.24,
  trackWidth: 3.56,
  wheelRadius: 1.05,
  suspensionTravel: 0.74,
  suspensionRest: 0.34,
  contactSpring: 46,
  contactDamping: 9.2,
  pitchResponse: 1,
  rollResponse: 1,
  maxClimbHeight: 1.82,
});

function _finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function _contactProfile(profile = {}) {
  return {
    ...DEFAULT_CONTACT,
    ...(profile.contact || {}),
  };
}

function _wheelLocal(layout, contactProfile) {
  return {
    x: layout.side * contactProfile.trackWidth * 0.5,
    z: layout.axle * contactProfile.wheelbase * 0.5,
  };
}

function _worldPoint(centerX, centerZ, yaw, localX, localZ) {
  const sin = Math.sin(yaw || 0);
  const cos = Math.cos(yaw || 0);
  return {
    x: centerX + localX * cos + localZ * sin,
    z: centerZ - localX * sin + localZ * cos,
  };
}

function _targetLocal(target, x, z) {
  const yaw = _finite(target?.yaw);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const dx = x - _finite(target?.x);
  const dz = z - _finite(target?.z);
  return {
    x: dx * cos - dz * sin,
    z: dx * sin + dz * cos,
  };
}

function _targetSupportsTire(target, x, z, kart, contactProfile) {
  if (!target || target.active === false || _finite(target.respawnProgress, 1) < 0.9) return null;
  if (target.stackState === 'falling') return null;
  if (target.kind === 'stuntman') return null;
  if (target.dominoGroup && target.dominoState === 'standing') return null;
  const stats = target.stats;
  if (!stats) return null;
  const local = _targetLocal(target, x, z);
  // Include the broad monster-tire contact patch rather than treating each
  // tire like an infinitesimal ray.  The inner tread of a centered truck must
  // be able to press a normal-width sedan roof.
  const pad = Math.max(0.42, contactProfile.wheelRadius * 0.64);
  const dominoLength = target.dominoGroup
    ? stats.height * 0.35 + stats.length * 0.5 * Math.abs(Math.cos(_finite(target.pitch)))
    : stats.length * 0.5;
  if (Math.abs(local.x) > stats.width * 0.5 + pad || Math.abs(local.z) > dominoLength + pad) return null;

  const top = _finite(target.top, _finite(target.baseY) + stats.height);
  const terrain = _finite(target.ground, _finite(target.baseY));
  const rise = top - terrain;
  const verticalGap = top - _finite(kart?.y);
  const reachableFromGround = !!kart?.grounded
    && verticalGap >= -contactProfile.suspensionTravel * 0.55
    && verticalGap <= contactProfile.maxClimbHeight + contactProfile.suspensionTravel * 0.22;
  // Airborne tires only acquire a wreck roof while descending through a
  // plausible contact band.  A broad "truck is somewhere above it" test lets
  // tall stacked cars teleport a rising truck onto an unrelated roof.
  const reachableInAir = !kart?.grounded
    && _finite(kart?.vy) <= 0.5
    && verticalGap <= contactProfile.wheelRadius * 0.32
    && verticalGap >= -(contactProfile.wheelRadius + contactProfile.suspensionTravel + 0.85);
  const driveableWreck = !!target.destroyed || _finite(target.crush) >= 0.3 || rise <= contactProfile.maxClimbHeight;
  if (!driveableWreck || (!reachableFromGround && !reachableInAir)) return null;
  return {
    height: top,
    targetId: target.id || '',
    targetKind: target.kind || 'sedan',
    targetState: target.state || 'intact',
    target,
  };
}

/** Highest driveable support at one tire footprint. */
export function sampleMonsterWheelSupport(terrainSampler, destruction, x, z, kart, profile = {}) {
  const contactProfile = _contactProfile(profile);
  const terrain = terrainSampler?.(x, z) || {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    surface: 'packed-dirt',
    surfaceGrip: 1,
    surfaceDrag: 0,
  };
  let result = {
    ...terrain,
    height: _finite(terrain.height),
    terrainHeight: _finite(terrain.height),
    targetId: '',
    targetKind: '',
    targetState: '',
    target: null,
  };
  for (const target of destruction?.targets || []) {
    const support = _targetSupportsTire(target, x, z, kart, contactProfile);
    if (!support || support.height <= result.height + 0.035) continue;
    result = {
      ...result,
      ...support,
      surface: 'wreck-metal',
      surfaceGrip: target.destroyed ? 0.78 : 0.7,
      surfaceDrag: target.destroyed ? 0.12 : 0.2,
      normal: { x: 0, y: 1, z: 0 },
    };
  }
  return result;
}

function _bridgeRampDeparture(samples, kart, contactProfile, yaw) {
  if (!kart?.grounded) return;
  const frontSamples = samples.filter((sample) => sample.axle === 1);
  const rearSamples = samples.filter((sample) => sample.axle === -1);
  const meanHeight = (axle) => axle.reduce((sum, sample) => sum + sample.support.height, 0) / axle.length;
  const frontHeight = meanHeight(frontSamples);
  const rearHeight = meanHeight(rearSamples);
  const rearHigh = rearHeight > frontHeight;
  const highSamples = rearHigh ? rearSamples : frontSamples;
  const lowSamples = rearHigh ? frontSamples : rearSamples;
  const heightDrop = Math.abs(frontHeight - rearHeight);
  if (heightDrop <= contactProfile.maxClimbHeight * 1.12) return;
  const rampSamples = highSamples.filter((sample) => sample.support.surface === 'ramp-dirt');
  if (!rampSamples.length) return;
  const forwardX = Math.sin(yaw || 0);
  const forwardZ = Math.cos(yaw || 0);
  const forwardSpeed = _finite(kart.vx) * forwardX + _finite(kart.vz) * forwardZ;
  // Only bridge the axle that has actually rolled beyond a ramp edge. A tall
  // wall approached from below must remain a wall, not become a synthetic
  // driveable plane.
  if ((rearHigh && forwardSpeed <= 2) || (!rearHigh && forwardSpeed >= -2)) return;
  const ramp = rampSamples.reduce((best, sample) => (
    sample.support.height > best.support.height ? sample : best
  ), rampSamples[0]).support;
  const normal = ramp.normal || { x: 0, y: 1, z: 0 };
  const slopeAlong = clamp(
    -(_finite(normal.x) * forwardX + _finite(normal.z) * forwardZ) / Math.max(0.12, _finite(normal.y, 1)),
    -1,
    1,
  );
  const highHeight = rearHigh ? rearHeight : frontHeight;
  const predictedLowHeight = highHeight + slopeAlong * contactProfile.wheelbase * (rearHigh ? 1 : -1);
  for (const sample of lowSamples) {
    sample.support = {
      ...sample.support,
      height: predictedLowHeight,
      surface: ramp.surface,
      surfaceGrip: ramp.surfaceGrip,
      surfaceDrag: ramp.surfaceDrag,
      normal: ramp.normal,
      featureId: ramp.featureId,
      unsupported: true,
      syntheticRampDeparture: true,
    };
  }
}

/**
 * Fit a cheap chassis support plane through four real tire samples.  Airborne
 * trucks use the earliest tire-contact height; grounded trucks use the fitted
 * center plane and let their individual springs absorb the remaining twist.
 */
export function sampleMonsterSupportPlane(kart, terrainSampler, destruction, profile = {}, position = null) {
  const contactProfile = _contactProfile(profile);
  const centerX = _finite(position?.x, _finite(kart?.x));
  const centerZ = _finite(position?.z, _finite(kart?.z));
  const yaw = _finite(position?.yaw, _finite(kart?.yaw));
  const samples = MONSTER_WHEEL_LAYOUT.map((layout) => {
    const local = _wheelLocal(layout, contactProfile);
    const world = _worldPoint(centerX, centerZ, yaw, local.x, local.z);
    const support = sampleMonsterWheelSupport(terrainSampler, destruction, world.x, world.z, kart, profile);
    return {
      ...layout,
      localX: local.x,
      localZ: local.z,
      worldX: world.x,
      worldZ: world.z,
      support,
    };
  });
  _bridgeRampDeparture(samples, kart, contactProfile, yaw);
  const front = (samples[1].support.height + samples[3].support.height) * 0.5;
  const rear = (samples[0].support.height + samples[2].support.height) * 0.5;
  const left = (samples[0].support.height + samples[1].support.height) * 0.5;
  const right = (samples[2].support.height + samples[3].support.height) * 0.5;
  const pitch = Math.atan2(front - rear, contactProfile.wheelbase);
  const roll = -Math.atan2(right - left, contactProfile.trackWidth);
  const fittedHeight = samples.reduce((total, sample) => total + sample.support.height, 0) / samples.length;
  let landingHeight = -Infinity;
  for (const sample of samples) {
    // Support pitch/roll are analytical terrain angles; the visible chassis
    // uses their sign-inverse in THREE coordinates. Remove those visible wheel
    // offsets to recover one consistent chassis-root contact height.
    sample.rootContactHeight = sample.support.height
      - sample.localZ * Math.sin(pitch)
      + sample.localX * Math.sin(roll);
    landingHeight = Math.max(landingHeight, sample.rootContactHeight);
  }
  const representative = samples.reduce((best, sample) => (
    sample.support.height > best.support.height ? sample : best
  ), samples[0]);
  const height = kart?.grounded ? fittedHeight : landingHeight;
  const nx = Math.sin(roll);
  const nz = -Math.sin(pitch);
  const ny = Math.max(0.08, Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)));
  return {
    height,
    fittedHeight,
    landingHeight,
    pitch,
    roll,
    normal: { x: nx, y: ny, z: nz },
    surface: representative.support.surface,
    surfaceGrip: samples.reduce((sum, sample) => sum + _finite(sample.support.surfaceGrip, 1), 0) / samples.length,
    surfaceDrag: samples.reduce((sum, sample) => sum + _finite(sample.support.surfaceDrag), 0) / samples.length,
    wheels: samples,
  };
}

/** Add four-wheel support truth to the normal Monster Arena contact object. */
export function createMonsterVehicleContact(baseContact, kart, destruction, profile = {}) {
  const terrainSampler = baseContact?.sampleGround;
  const support = sampleMonsterSupportPlane(kart, terrainSampler, destruction, profile);
  return {
    ...baseContact,
    groundHeight: support.height,
    groundPitch: support.pitch,
    groundRoll: support.roll,
    groundNormal: support.normal,
    surface: support.surface || baseContact?.surface,
    surfaceGrip: support.surfaceGrip,
    surfaceDrag: support.surfaceDrag,
    wheelSupport: support,
    sampleGround(x, z) {
      const next = sampleMonsterSupportPlane(kart, terrainSampler, destruction, profile, { x, z, yaw: kart?.yaw });
      return {
        height: next.height,
        pitch: next.pitch,
        roll: next.roll,
        normal: next.normal,
        surface: next.surface,
        surfaceGrip: next.surfaceGrip,
        surfaceDrag: next.surfaceDrag,
        wheelSupport: next,
      };
    },
  };
}

function _newWheelState(layout, contactProfile) {
  return {
    id: layout.id,
    side: layout.sideName,
    axle: layout.axleName,
    grounded: false,
    entered: false,
    targetId: '',
    targetKind: '',
    height: 0,
    compression: 0,
    velocity: 0,
    load: 0,
    visualOffset: -contactProfile.suspensionTravel * 0.26,
    impactSpeed: 0,
  };
}

/** Initialize/reset the Monster-only fields on a shared kart state. */
export function initializeMonsterVehiclePhysics(kart, profile = {}) {
  if (!kart) return kart;
  const contactProfile = _contactProfile(profile);
  kart.wheelbase = contactProfile.wheelbase;
  kart.trackWidth = contactProfile.trackWidth;
  kart.wheelRadius = contactProfile.wheelRadius;
  kart.wheelContacts = Object.fromEntries(MONSTER_WHEEL_LAYOUT.map((layout) => [
    layout.id,
    _newWheelState(layout, contactProfile),
  ]));
  kart.groundedWheelCount = 4;
  kart.contactPitch = -_finite(kart.groundPitch);
  kart.contactRoll = -_finite(kart.groundRoll);
  kart.bottomedOut = false;
  kart.wheelRpm = 0;
  kart.wheelSlip = 0;
  kart.gear = 1;
  kart.engineLoad = 0;
  kart.immobilizedTime = 0;
  kart.recoveryCooldown = 0;
  return kart;
}

function _mean(states, predicate, field) {
  const filtered = states.filter(predicate);
  if (!filtered.length) return 0;
  return filtered.reduce((sum, state) => sum + _finite(state[field]), 0) / filtered.length;
}

/**
 * Advance four bounded spring/damper patches after the shared integrator step.
 * Mutates only Monster-specific kart state plus the existing aggregate
 * suspension fields consumed by presentation.
 */
export function stepMonsterContactPatches(kart, contact, profile = {}, dt, events = {}) {
  if (!kart || !(dt > 0)) return { grounded: 0, entered: [], bottomedOut: false };
  const contactProfile = _contactProfile(profile);
  if (!kart.wheelContacts) initializeMonsterVehiclePhysics(kart, profile);
  const support = contact?.wheelSupport || contact?.sampleGround?.(kart.x, kart.z)?.wheelSupport;
  if (!support?.wheels?.length) return { grounded: 0, entered: [], bottomedOut: false };
  const entered = [];
  const landingSpeed = Math.max(0, _finite(events.landingSpeed));
  const states = [];
  for (const sample of support.wheels) {
    const state = kart.wheelContacts[sample.id] || _newWheelState(sample, contactProfile);
    const previousGrounded = !!state.grounded;
    const previousTargetId = state.targetId || '';
    const gap = _finite(kart.y) - _finite(sample.rootContactHeight, support.height);
    const grounded = !!kart.grounded && !sample.support.unsupported
      && gap <= contactProfile.suspensionTravel * 0.78 + 0.16;
    const surfacePush = clamp(-gap / Math.max(0.1, contactProfile.suspensionTravel), -0.42, 0.52);
    const longitudinal = _finite(kart.longitudinalWeightTransfer) * sample.axle * 0.16;
    const lateral = _finite(kart.lateralWeightTransfer) * sample.side * 0.14;
    const targetCompression = grounded
      ? clamp(contactProfile.suspensionRest + surfacePush + longitudinal + lateral, 0.04, 1)
      : 0;
    const springAcceleration = (targetCompression - _finite(state.compression)) * contactProfile.contactSpring
      - _finite(state.velocity) * contactProfile.contactDamping;
    state.velocity = clamp(_finite(state.velocity) + springAcceleration * dt, -5.5, 5.5);
    state.compression = clamp(_finite(state.compression) + state.velocity * dt, 0, 1);
    state.grounded = grounded;
    state.entered = grounded && (!previousGrounded || previousTargetId !== (sample.support.targetId || ''));
    state.targetId = grounded ? sample.support.targetId || '' : '';
    state.targetKind = grounded ? sample.support.targetKind || '' : '';
    state.x = sample.localX;
    state.z = sample.localZ;
    state.worldX = sample.worldX;
    state.worldZ = sample.worldZ;
    state.height = sample.support.height;
    state.surface = sample.support.surface;
    state.load = grounded ? clamp(0.24 + state.compression * 1.18 + Math.max(0, state.velocity) * 0.08, 0, 1.55) : 0;
    state.visualOffset = grounded
      ? (sample.support.height - support.fittedHeight) * 0.42 - (1 - state.compression) * contactProfile.suspensionTravel * 0.17
      : -contactProfile.suspensionTravel * 0.34;
    state.impactSpeed = state.entered
      ? Math.max(landingSpeed * Math.max(0.35, state.load), Math.abs(_finite(kart.vy)) + _finite(kart.speed) * 0.08)
      : 0;
    if (state.entered) entered.push({ ...state });
    kart.wheelContacts[sample.id] = state;
    states.push(state);
  }

  const groundedCount = states.filter((state) => state.grounded).length;
  const frontCompression = _mean(states, (state) => state.axle === 'front', 'compression');
  const rearCompression = _mean(states, (state) => state.axle === 'rear', 'compression');
  const leftCompression = _mean(states, (state) => state.side === 'left', 'compression');
  const rightCompression = _mean(states, (state) => state.side === 'right', 'compression');
  const averageCompression = _mean(states, () => true, 'compression');
  const averageVelocity = _mean(states, () => true, 'velocity');
  kart.groundedWheelCount = groundedCount;
  kart.contactPitch = -support.pitch * contactProfile.pitchResponse
    + _finite(kart.bodyPitch) * (profile.id === 'cyber' ? 0.62 : 0.88)
    + (rearCompression - frontCompression) * 0.12;
  kart.contactRoll = -support.roll * contactProfile.rollResponse
    + _finite(kart.bodyRoll) * (profile.id === 'cyber' ? 0.58 : 0.9)
    + (leftCompression - rightCompression) * 0.11;
  kart.suspensionCompression = averageCompression;
  kart.suspensionVelocity = averageVelocity;
  const bottomedOut = landingSpeed > _finite(profile.bottomOutSpeed, profile.id === 'cyber' ? 18.5 : 17)
    && states.some((state) => state.compression >= 0.9 || state.load >= 1.35);
  kart.bottomedOut = bottomedOut;
  kart.recoveryCooldown = Math.max(0, _finite(kart.recoveryCooldown) - dt);

  const radius = Math.max(0.25, contactProfile.wheelRadius);
  kart.wheelRpm = _finite(kart.speed) / (Math.PI * 2 * radius) * 60;
  kart.wheelSlip = clamp(Math.abs(_finite(kart.lateralSpeed)) / Math.max(2.5, _finite(kart.speed)), 0, 1);
  const speed = _finite(kart.speed);
  kart.gear = speed < 5.5 ? 1 : speed < 10.5 ? 2 : speed < 16.5 ? 3 : speed < 23 ? 4 : 5;
  kart.engineLoad = clamp(Math.abs(_finite(kart.longitudinalWeightTransfer)) * 0.6 + Math.abs(_finite(kart.lateralSpeed)) / 14, 0, 1);
  events.wheelContacts = entered;
  events.bottomedOut = bottomedOut;
  events.groundedWheels = groundedCount;
  if (events.landed) {
    const first = [...states].sort((a, b) => b.height - a.height || b.load - a.load)[0];
    events.landingContact = first?.axle === 'front'
      ? 'front'
      : first?.axle === 'rear' ? 'rear' : 'belly';
  }
  return { grounded: groundedCount, entered, bottomedOut, support };
}

export function monsterContactPatchSnapshot(kart) {
  const contacts = Object.values(kart?.wheelContacts || {});
  return {
    grounded: contacts.filter((contact) => contact.grounded).length,
    wheels: Object.fromEntries(contacts.map((contact) => [contact.id, {
      grounded: !!contact.grounded,
      targetId: contact.targetId || '',
      targetKind: contact.targetKind || '',
      compression: _finite(contact.compression),
      load: _finite(contact.load),
      height: _finite(contact.height),
    }])),
    pitch: _finite(kart?.contactPitch),
    roll: _finite(kart?.contactRoll),
    bottomedOut: !!kart?.bottomedOut,
    wheelRpm: _finite(kart?.wheelRpm),
    wheelSlip: _finite(kart?.wheelSlip),
    gear: Math.max(1, Math.round(_finite(kart?.gear, 1))),
  };
}
