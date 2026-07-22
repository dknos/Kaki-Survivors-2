/** Pure Monster Arena destruction thresholds and collision truth. */
import { landingZoneAt } from './monsterArenaDefinition.js';

export const MONSTER_TARGET_CLASSES = Object.freeze({
  sedan: Object.freeze({ width: 2.25, length: 4.15, height: 1.5, wheel: 0.36, mass: 1, health: 42, minHit: 20, score: 310 }),
  wagon: Object.freeze({ width: 2.3, length: 4.65, height: 1.7, wheel: 0.38, mass: 1.15, health: 51, minHit: 23, score: 360 }),
  pickup: Object.freeze({ width: 2.42, length: 4.9, height: 1.78, wheel: 0.43, mass: 1.35, health: 62, minHit: 26, score: 430 }),
  van: Object.freeze({ width: 2.5, length: 5.15, height: 2.25, wheel: 0.42, mass: 1.65, health: 76, minHit: 30, score: 520 }),
  limousine: Object.freeze({ width: 2.32, length: 7.25, height: 1.65, wheel: 0.39, mass: 1.8, health: 92, minHit: 34, score: 650 }),
  bus: Object.freeze({ width: 2.85, length: 10.6, height: 3.25, wheel: 0.52, mass: 3.6, health: 158, minHit: 46, score: 1050 }),
  rv: Object.freeze({ width: 2.78, length: 7.65, height: 3.15, wheel: 0.5, mass: 3, health: 132, minHit: 42, score: 920 }),
  derby: Object.freeze({ width: 2.35, length: 4.35, height: 1.42, wheel: 0.4, mass: 1.35, health: 82, minHit: 28, score: 720 }),
  crown: Object.freeze({ width: 2.45, length: 4.55, height: 1.7, wheel: 0.43, mass: 2.15, health: 126, minHit: 38, score: 1180 }),
  haybale: Object.freeze({ width: 2.7, length: 2.7, height: 2.05, wheel: 0.08, mass: 0.72, health: 34, minHit: 17, score: 390 }),
  stuntman: Object.freeze({ width: 1.05, length: 1.05, height: 3.4, wheel: 0.05, mass: 0.45, health: 24, minHit: 14, score: 520 }),
});

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function monsterMotionSweep(target, kart) {
  const ax = Number(kart?.previousX ?? kart?.x) || 0;
  const az = Number(kart?.previousZ ?? kart?.z) || 0;
  const bx = Number(kart?.x) || 0;
  const bz = Number(kart?.z) || 0;
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  const targetX = Number(target?.x) || 0;
  const targetZ = Number(target?.z) || 0;
  const t = lengthSq > 1e-6
    ? _clamp(((targetX - ax) * abx + (targetZ - az) * abz) / lengthSq, 0, 1)
    : 0;
  return {
    distance: Math.hypot(targetX - (ax + abx * t), targetZ - (az + abz * t)),
    t,
  };
}

function _segmentAabbSweep(ax, az, bx, bz, halfWidth, halfLength) {
  const dx = bx - ax;
  const dz = bz - az;
  let enter = 0;
  let exit = 1;
  let normalX = 0;
  let normalZ = 0;
  const clip = (start, delta, half, axis) => {
    if (Math.abs(delta) < 1e-8) return Math.abs(start) <= half;
    let near = (-half - start) / delta;
    let far = (half - start) / delta;
    let nearNormal = delta > 0 ? -1 : 1;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
      nearNormal *= -1;
    }
    if (near > enter) {
      enter = near;
      normalX = axis === 'x' ? nearNormal : 0;
      normalZ = axis === 'z' ? nearNormal : 0;
    }
    exit = Math.min(exit, far);
    return enter <= exit;
  };
  const hit = clip(ax, dx, halfWidth, 'x') && clip(az, dz, halfLength, 'z')
    && exit >= 0 && enter <= 1;
  return { hit, t: _clamp(enter, 0, 1), normalX, normalZ };
}

/** Swept oriented footprint collision used by full-size traffic obstacles. */
export function monsterOrientedMotionSweep(target, kart, padding = 0) {
  const stats = target?.stats || MONSTER_TARGET_CLASSES[target?.kind] || MONSTER_TARGET_CLASSES.sedan;
  const yaw = Number(target?.yaw) || 0;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const toLocal = (x, z) => {
    const dx = (Number(x) || 0) - (Number(target?.x) || 0);
    const dz = (Number(z) || 0) - (Number(target?.z) || 0);
    return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
  };
  const start = toLocal(kart?.previousX ?? kart?.x, kart?.previousZ ?? kart?.z);
  const end = toLocal(kart?.x, kart?.z);
  const halfWidth = stats.width * 0.5 + Math.max(0, Number(padding) || 0);
  // Cars in the domino perimeter stand on their rear bumpers. Their ground
  // footprint grows from body thickness to full vehicle length as they fall,
  // which keeps the collision volume aligned with the visible obstacle.
  const dominoLength = target?.dominoGroup
    ? Math.max(
      stats.height * 0.42,
      Number(target.dominoHorizontalRadius) || 0,
      stats.length * 0.5 * Math.sin(Math.max(0, Number(target.dominoTilt) || 0)),
    )
    : stats.length * 0.5;
  const halfLength = dominoLength + Math.max(0, Number(padding) || 0);
  const sweptHalfWidth = target?.dominoGroup ? Math.max(halfWidth, halfLength * 0.72) : halfWidth;
  const result = _segmentAabbSweep(start.x, start.z, end.x, end.z, sweptHalfWidth, halfLength);
  let localNormalX = result.normalX;
  let localNormalZ = result.normalZ;
  if (result.hit && localNormalX === 0 && localNormalZ === 0) {
    const moveX = end.x - start.x;
    const moveZ = end.z - start.z;
    if (Math.hypot(moveX, moveZ) > 1e-6) {
      if (Math.abs(moveX) > Math.abs(moveZ)) localNormalX = -Math.sign(moveX);
      else localNormalZ = -Math.sign(moveZ);
    } else {
      const widthDepth = halfWidth - Math.abs(start.x);
      const lengthDepth = halfLength - Math.abs(start.z);
      if (widthDepth < lengthDepth) localNormalX = Math.sign(start.x || 1);
      else localNormalZ = Math.sign(start.z || 1);
    }
  }
  return {
    ...result,
    distance: result.hit ? 0 : monsterMotionSweep(target, kart).distance,
    normal: {
      x: localNormalX * cos + localNormalZ * sin,
      z: -localNormalX * sin + localNormalZ * cos,
    },
  };
}

/** Report whether every required member beneath a stacked obstacle still carries it. */
export function monsterSupportStatus(target, targets = []) {
  const supportIds = Array.isArray(target?.supportIds) ? target.supportIds : [];
  if (!supportIds.length) return { structural: false, supported: true, required: 0, active: [], lost: [] };
  const byId = targets instanceof Map ? targets : new Map(targets.map((entry) => [entry.id, entry]));
  const active = [];
  const lost = [];
  for (const id of supportIds) {
    const support = byId.get(id);
    const displaced = support && Math.hypot(
      (Number(support.x) || 0) - (Number(support.spawnX ?? support.x) || 0),
      (Number(support.z) || 0) - (Number(support.spawnZ ?? support.z) || 0),
    ) > Math.max(1.15, Number(support.stats?.width) * 0.52 || 1.15);
    const available = !!support && !support.destroyed && !displaced
      && !['falling', 'settled'].includes(support.stackState);
    (available ? active : lost).push(id);
  }
  const required = Math.max(1, Math.min(supportIds.length, Number(target?.requiredSupports) || supportIds.length));
  return { structural: true, supported: active.length >= required, required, active, lost };
}

/** Evaluate one high-speed ram/roof-stomp without mutating gameplay state. */
export function evaluateMonsterTargetImpact(target, kart, profile = {}) {
  const stats = target?.stats || MONSTER_TARGET_CLASSES[target?.kind] || MONSTER_TARGET_CLASSES.sedan;
  const wheelEntries = Object.values(kart?.wheelContacts || {}).filter((contact) => (
    contact?.entered && contact.targetId === target?.id
    && Number(target?.axleHitCooldowns?.[contact.axle] || 0) <= 0
  ));
  const axleNames = [...new Set(wheelEntries.map((contact) => contact.axle).filter(Boolean))];
  const wheelContact = wheelEntries.length > 0;
  const inactive = target?.active === false || !!target?.destroyed
    || Number(target?.respawnProgress ?? 1) < 0.9
    || (Number(target?.hitCooldown) > 0 && !wheelContact);
  const sweep = monsterOrientedMotionSweep(target, kart, (Number(profile.collisionRadius) || 2.65) * 0.48);
  const radius = Math.max(stats.width * 0.53, stats.length * 0.24)
    + (Number(profile.collisionRadius) || 2.65) * 0.54;
  const previousY = Number(kart?.previousY ?? kart?.y) || 0;
  const currentY = Number(kart?.y) || 0;
  const top = Number(target?.top) || stats.height;
  const bottom = Number.isFinite(Number(target?.baseY))
    ? Number(target.baseY)
    : Number.isFinite(Number(target?.bottom)) ? Number(target.bottom) : top - stats.height;
  const verticalContact = wheelContact || ((Number(kart?.vy) || 0) < -1.5
    && Math.max(previousY, currentY) >= top - 0.5
    && Math.min(previousY, currentY) <= top + 2.8);
  const collisionHeight = Math.max(1.2, Number(profile.collisionHeight) || 1.7);
  const kartBottom = Math.min(previousY, currentY) + 0.1;
  const kartTop = Math.max(previousY, currentY) + collisionHeight;
  const horizontalContact = kartTop >= bottom + 0.12 && kartBottom <= top - 0.06;
  const horizontalSpeed = Math.max(0, Number(kart?.speed) || Math.hypot(Number(kart?.vx) || 0, Number(kart?.vz) || 0));
  const normalClosingSpeed = Math.max(0,
    -(Number(kart?.vx) || 0) * sweep.normal.x - (Number(kart?.vz) || 0) * sweep.normal.z);
  const impactSpeed = Math.max(horizontalSpeed * 0.28, normalClosingSpeed);
  const wheelImpactSpeed = wheelEntries.reduce((maximum, contact) => Math.max(
    maximum,
    Number(contact.impactSpeed) || 0,
  ), 0);
  const verticalSpeed = verticalContact
    ? Math.max(wheelImpactSpeed, Math.max(0, -(Number(kart?.vy) || 0)))
    : 0;
  const boostPower = Number(kart?.boostTime) > 0 ? 1.32 : 1;
  const wheelLoad = wheelEntries.reduce((sum, contact) => sum + (Number(contact.load) || 0), 0);
  const tireEnergy = wheelContact
    ? horizontalSpeed * (1.5 + axleNames.length * 0.25) + verticalSpeed * (5.8 + wheelLoad * 0.7)
    : 0;
  const damageEnergy = Math.max(impactSpeed * 4.85 + verticalSpeed * 9.8, tireEnergy)
    * (Number(profile.ramMultiplier) || 1) * boostPower;
  let localContactZ = 0;
  if (wheelEntries.length) {
    const sin = Math.sin(Number(target?.yaw) || 0);
    const cos = Math.cos(Number(target?.yaw) || 0);
    localContactZ = wheelEntries.reduce((sum, contact) => {
      const dx = (Number(contact.x) || Number(kart?.x) || 0) - (Number(target?.x) || 0);
      const dz = (Number(contact.z) || Number(kart?.z) || 0) - (Number(target?.z) || 0);
      return sum + dx * sin + dz * cos;
    }, 0) / wheelEntries.length;
  }
  const axle = axleNames.length > 1 ? 'both' : axleNames[0] || '';
  return {
    qualifies: !inactive && (wheelContact || sweep.hit) && (verticalContact || horizontalContact)
      && damageEnergy >= stats.minHit,
    inactive,
    sweepDistance: sweep.distance,
    sweepT: sweep.t,
    radius,
    verticalContact,
    wheelContact,
    wheelEntries,
    axle,
    crushZone: localContactZ >= 0 ? 'front' : 'rear',
    horizontalContact,
    horizontalSpeed,
    impactSpeed,
    contactNormal: sweep.normal,
    targetBottom: bottom,
    verticalSpeed,
    damageEnergy,
    stats,
  };
}

/** Apply a validated body or tire impact once with optional axle sequencing. */
export function applyMonsterTargetDamage(target, damageEnergy, {
  vertical = false,
  cooldown = 0.24,
  axle = '',
  crushZone = '',
  bypassCooldown = false,
} = {}) {
  if (!target || target.active === false || target.destroyed || Number(target.respawnProgress ?? 1) < 0.9
    || (!bypassCooldown && Number(target.hitCooldown) > 0) || !(damageEnergy > 0)) {
    return { applied: false, stateChanged: false, newlyDestroyed: false };
  }
  const maximum = Math.max(1, Number(target.maxHealth) || Number(target.stats?.health) || 1);
  const previousState = target.state || 'intact';
  target.axleHits ||= { front: 0, rear: 0 };
  target.axleHitCooldowns ||= { front: 0, rear: 0 };
  target.crushFront = Number(target.crushFront) || 0;
  target.crushRear = Number(target.crushRear) || 0;
  if (axle === 'front' || axle === 'both') target.axleHits.front += 1;
  if (axle === 'rear' || axle === 'both') target.axleHits.rear += 1;
  if (axle === 'front' || axle === 'both') target.axleHitCooldowns.front = Math.max(0.18, cooldown);
  if (axle === 'rear' || axle === 'both') target.axleHitCooldowns.rear = Math.max(0.18, cooldown);
  const opposingAxleAlreadyPressed = axle === 'front'
    ? target.axleHits.rear > 0
    : axle === 'rear' ? target.axleHits.front > 0 : axle === 'both';
  const isHeavy = ['bus', 'rv', 'limousine', 'crown'].includes(target.kind);
  const stagedCap = axle && !opposingAxleAlreadyPressed
    ? maximum * (isHeavy ? 0.34 : 0.62)
    : Infinity;
  const appliedEnergy = Math.min(damageEnergy, stagedCap);
  target.maxHealth = maximum;
  target.health = (Number(target.health) || maximum) - appliedEnergy;
  target.damage = _clamp(1 - target.health / maximum, 0, 1);
  const zone = crushZone === 'rear' ? 'rear' : crushZone === 'front' ? 'front' : '';
  if (zone) {
    const key = zone === 'front' ? 'crushFront' : 'crushRear';
    target[key] = _clamp(Math.max(Number(target[key]) || 0, appliedEnergy / maximum * 0.9), 0, 1);
  }
  target.hitCooldown = Math.max(0, Number(cooldown) || 0);
  let newlyDestroyed = false;
  if (target.health <= 0) {
    target.destroyed = true;
    target.state = vertical ? 'crushed' : 'wreck';
    target.crushVelocity = vertical ? 0.65 : 0.28;
    target.destroyedAge = 0;
    newlyDestroyed = true;
  } else if (target.damage >= 0.25) {
    target.state = 'dented';
  }
  return {
    applied: true,
    previousState,
    state: target.state,
    stateChanged: previousState !== target.state,
    newlyDestroyed,
    appliedEnergy,
    axle,
    crushZone: zone,
  };
}

export function monsterChainDamage(source, target) {
  const distance = Math.hypot((Number(target?.x) || 0) - (Number(source?.x) || 0), (Number(target?.z) || 0) - (Number(source?.z) || 0));
  const sameStack = !!source?.stackId && target?.stackId === source.stackId;
  if (distance > (sameStack ? 7.5 : 5.5)) return { damage: 0, distance, sameStack };
  const maximum = Math.max(1, Number(target?.maxHealth) || Number(target?.stats?.health) || 1);
  const damage = maximum * (sameStack ? 0.72 : 0.27) * (1 - distance / (sameStack ? 11 : 8));
  return { damage: Math.max(0, damage), distance, sameStack };
}

/** Off-camera refills also reject the player's projected travel corridor. */
export function canRepopulateMonsterTarget(target, kart, definition) {
  if (!target?.destroyed || !kart || !definition) return false;
  if (target.noRespawn) return false;
  const resetDelay = ['bus', 'rv', 'crown'].includes(target.kind) ? 32 : 22;
  if (Number(target.destroyedAge) < resetDelay) return false;
  const spawnX = Number(target.spawnX) || 0;
  const spawnZ = Number(target.spawnZ) || 0;
  if (Math.hypot((Number(kart.x) || 0) - spawnX, (Number(kart.z) || 0) - spawnZ) <= 36) return false;
  if (landingZoneAt(spawnX, spawnZ, definition)) return false;
  const projected = {
    previousX: Number(kart.x) || 0,
    previousZ: Number(kart.z) || 0,
    x: (Number(kart.x) || 0) + (Number(kart.vx) || 0) * 1.4,
    z: (Number(kart.z) || 0) + (Number(kart.vz) || 0) * 1.4,
  };
  return monsterMotionSweep({ x: spawnX, z: spawnZ }, projected).distance >= 18;
}
