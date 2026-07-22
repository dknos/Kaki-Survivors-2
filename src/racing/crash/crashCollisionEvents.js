import * as THREE from 'three';
import { applyCrashDamage, selectDamageZone } from './crashDamage.js';
import { applyCrashDamagePresentation } from './crashDamagePresentation.js';
import { awardCrashSpecial, scoreCrashImpact } from './crashScoring.js';
import { createCrashDebrisBody } from './crashPhysics.js';
import { breakCrashProp } from './crashBreakables.js';
import { markCrashTrafficImpact } from './crashTraffic.js';

export const CRASH_DETACHED_PART_BITS = Object.freeze({
  'front-bumper': 1 << 0,
  'rear-bumper': 1 << 1,
  hood: 1 << 2,
  trunk: 1 << 3,
  'left-door': 1 << 4,
  'right-door': 1 << 5,
  'left-front-wheel': 1 << 6,
  'right-front-wheel': 1 << 7,
  'left-rear-wheel': 1 << 8,
  'right-rear-wheel': 1 << 9,
  'left-mirror': 1 << 10,
  'right-mirror': 1 << 11,
});

function inverseRotate(vector, quaternion) {
  const qx = -quaternion.x; const qy = -quaternion.y; const qz = -quaternion.z; const qw = quaternion.w;
  const ix = qw * vector.x + qy * vector.z - qz * vector.y;
  const iy = qw * vector.y + qz * vector.x - qx * vector.z;
  const iz = qw * vector.z + qx * vector.y - qy * vector.x;
  const iw = -qx * vector.x - qy * vector.y - qz * vector.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

function localImpact(entity, point, direction, sign = 1) {
  const position = entity.body.translation();
  const rotation = entity.body.rotation();
  const localPoint = inverseRotate({ x: point.x - position.x, y: point.y - position.y, z: point.z - position.z }, rotation);
  const localNormal = inverseRotate({ x: direction.x * sign, y: direction.y * sign, z: direction.z * sign }, rotation);
  return { localPoint, localNormal };
}

function partFor(entity, name) {
  return entity.visual?.parts?.get?.(name) || entity.visual?.root?.getObjectByName?.(name) || null;
}

function detachPart(session, entity, name, contact, time) {
  const source = partFor(entity, name);
  if (!source || source.userData.damageDetached) return null;
  if (session.debrisEntities.length >= (session.quality?.maxDetachedDebris || 20)) return null;
  source.userData.damageDetached = true;
  source.updateWorldMatrix(true, true);
  const clone = source.clone(true);
  clone.name = `${entity.id}-${name}-detached`;
  const worldPosition = source.getWorldPosition(new THREE.Vector3());
  const worldQuaternion = source.getWorldQuaternion(new THREE.Quaternion());
  session.root.add(clone);
  clone.position.copy(session.root.worldToLocal(worldPosition.clone()));
  const rootWorldQuaternion = session.root.getWorldQuaternion(new THREE.Quaternion()).invert();
  clone.quaternion.copy(rootWorldQuaternion.multiply(worldQuaternion));
  source.visible = false;
  const parentVelocity = entity.body.linvel();
  const direction = contact.direction || { x: 0, y: 0.2, z: 1 };
  const debris = {
    id: clone.name,
    classId: 'debris',
    kind: 'debris',
    visual: { root: clone },
    sourcePart: source,
    sourceEntityId: entity.id,
    active: true,
    detachedAt: time,
    damage: { severity: 0 },
    detachedMask: 0,
  };
  createCrashDebrisBody(session.physics, debris, {
    x: clone.position.x,
    y: clone.position.y,
    z: clone.position.z,
    width: name.includes('door') ? 0.85 : name.includes('wheel') ? 0.48 : 1.2,
    height: name.includes('door') ? 0.12 : name.includes('wheel') ? 0.48 : 0.18,
    length: name.includes('door') ? 1.25 : name.includes('wheel') ? 0.48 : 0.65,
    mass: name.includes('wheel') ? 24 : name.includes('door') ? 31 : 18,
    velocity: {
      x: parentVelocity.x + direction.x * Math.min(5, contact.relativeSpeed * 0.24),
      y: parentVelocity.y + 1.1 + Math.abs(direction.y) * 2,
      z: parentVelocity.z + direction.z * Math.min(5, contact.relativeSpeed * 0.24),
    },
    angular: { x: 3.2, y: entity.id.length % 2 ? 2.3 : -2.3, z: -2.7 },
  });
  session.debrisEntities.push(debris);
  entity.detachedMask |= CRASH_DETACHED_PART_BITS[name] || 0;
  session.replayRecorder.recordEvent({ type: 'part-detached', time, subjectId: entity.id, debrisId: debris.id, part: name, point: contact.point });
  session.onDetachedPart?.(entity, debris, time);
  return debris;
}

export function detachBoomWeakenedPart(session, entity, origin, time) {
  if (!entity?.body || !entity.damage?.zones || entity.damage.severity < 0.48) return null;
  const zone = Object.entries(entity.damage.zones).sort((a, b) => b[1] - a[1])[0]?.[0] || 'front';
  const candidates = zone === 'front' ? ['front-bumper', 'hood']
    : zone === 'rear' ? ['rear-bumper', 'trunk']
      : zone === 'left' ? ['left-door', 'left-mirror'] : ['right-door', 'right-mirror'];
  const position = entity.body.translation();
  const dx = position.x - (origin?.x || 0);
  const dz = position.z - (origin?.z || 0);
  const inverseDistance = 1 / Math.max(0.1, Math.hypot(dx, dz));
  const contact = {
    point: { x: position.x, y: position.y, z: position.z },
    direction: { x: dx * inverseDistance, y: 0.24, z: dz * inverseDistance },
    relativeSpeed: 12,
  };
  for (const name of candidates) {
    const detached = detachPart(session, entity, name, contact, time);
    if (detached) return detached;
  }
  return null;
}

function applyDamageToEntity(session, entity, contact, time, sign) {
  // Detached panels and lightweight road debris carry only replay severity;
  // directional vehicle damage requires the full four-zone state.
  if (!entity?.body || !entity.damage?.zones || !entity.visual) return null;
  const { localPoint, localNormal } = localImpact(entity, contact.point, contact.direction, sign);
  const profile = entity.profile || entity.playerProfile;
  const zone = selectDamageZone(localPoint, profile);
  const transition = applyCrashDamage(entity.damage, {
    zone,
    impulse: contact.impulse,
    relativeSpeed: contact.relativeSpeed,
    side: localPoint.x,
  });
  if (!transition.changed) return null;
  applyCrashDamagePresentation(entity, {
    localPoint,
    localNormal,
    amount: transition.amount,
    severity: transition.severity,
    zones: entity.damage.zones,
    glass: transition.glass,
  });
  for (const part of transition.detached) detachPart(session, entity, part, contact, time);
  session.replayRecorder.recordEvent({
    type: 'damage',
    time,
    subjectId: entity.id,
    zone,
    amount: transition.amount,
    severity: transition.severity,
    glass: transition.glass,
    glassChanged: transition.glassChanged,
    localPoint,
    localNormal,
    zones: { ...entity.damage.zones },
    detached: transition.detached,
  });
  session.onDamageTransition?.(entity, transition, time);
  return { zone, transition, localPoint, localNormal };
}

function resolveEntity(entry) {
  return entry?.entity || null;
}

function isPrimaryCrashEntity(entity, player) {
  return entity === player || entity?.kind === 'traffic' || entity?.kind?.startsWith?.('breakable');
}

function isVehicleParticipant(entity) {
  return entity?.kind === 'traffic';
}

function isCausalEntity(session, entity) {
  if (!entity) return false;
  if (entity === session.player || session.score.participants.has(entity.id)) return true;
  return !!(entity.sourceEntityId && session.score.participants.has(entity.sourceEntityId));
}

export function processCrashCollisionEvents(session, physicsEvents, time) {
  const semantic = [];
  for (const collision of physicsEvents.collisions || []) {
    if (!collision.started) continue;
    const a = resolveEntity(collision.a);
    const b = resolveEntity(collision.b);
    if (!a || !b) continue;
    session.replayRecorder.recordEvent({ type: 'collision-start', time, aId: a.id, bId: b.id });
  }
  for (const contact of physicsEvents.contacts || []) {
    const a = resolveEntity(contact.a);
    const b = resolveEntity(contact.b);
    if (!a || !b || (a.static && b.static)) continue;
    const playerInvolved = a === session.player || b === session.player;
    const trafficInvolved = isVehicleParticipant(a) || isVehicleParticipant(b);
    const incidentStarter = playerInvolved && trafficInvolved;
    const causalContact = playerInvolved || isCausalEntity(session, a) || isCausalEntity(session, b);
    // Traffic remains fully physical before and outside the player's crash,
    // but unrelated contacts cannot silently start or inflate the score chain.
    if ((!session.incidentStarted && !incidentStarter) || (session.incidentStarted && !causalContact)) continue;
    const primaryA = isPrimaryCrashEntity(a, session.player);
    const primaryB = isPrimaryCrashEntity(b, session.player);
    const score = primaryA || primaryB ? scoreCrashImpact(session.score, {
      aId: a.id,
      bId: b.id,
      aClass: a === session.player ? 'player' : a.classId,
      bClass: b === session.player ? 'player' : b.classId,
      aParticipant: isVehicleParticipant(a),
      bParticipant: isVehicleParticipant(b),
      impulse: contact.impulse,
      force: contact.force,
      relativeSpeed: contact.relativeSpeed,
      point: contact.point,
    }, time) : { awarded: 0, qualified: false, reason: 'cosmetic-debris' };
    if (!session.incidentStarted && score.qualified && incidentStarter) session.incidentStarted = true;
    if (!session.incidentStarted) continue;
    markCrashTrafficImpact(a, contact.impulse);
    markCrashTrafficImpact(b, contact.impulse);
    if (score.qualified) {
      const subject = isVehicleParticipant(b) ? b
        : isVehicleParticipant(a) ? a
          : a === session.player ? a
            : b === session.player ? b : a;
      const event = {
        type: 'impact',
        time,
        aId: a.id,
        bId: b.id,
        subjectId: subject.id,
        aClass: a === session.player ? 'player' : a.classId,
        bClass: b === session.player ? 'player' : b.classId,
        impulse: contact.impulse,
        force: contact.force,
        relativeSpeed: contact.relativeSpeed,
        value: score.awarded,
        point: contact.point,
      };
      session.replayRecorder.recordEvent(event);
      semantic.push(event);
      if (score.event.participants.length) {
        score.event.participants.forEach((subjectId) => session.replayRecorder.recordEvent({ type: 'new-participant', time, subjectId, point: contact.point, value: 850 }));
      }
      session.onQualifyingImpact?.(event, a, b);
    }
    const damageA = applyDamageToEntity(session, a, contact, time, -1);
    const damageB = applyDamageToEntity(session, b, contact, time, 1);
    if (breakCrashProp(session, a, contact, time)) session.onBreakable?.(a, contact);
    if (breakCrashProp(session, b, contact, time)) session.onBreakable?.(b, contact);
    for (const support of [a, b]) {
      const structureId = support.metadata?.structureId;
      if (!structureId || contact.impulse < (support.metadata?.forceThreshold || 2400)) continue;
      const structure = session.worldView?.breakables?.find?.((entry) => entry.id === structureId);
      if (structure && breakCrashProp(session, structure, contact, time)) session.onBreakable?.(structure, contact);
    }
    for (const [entity, damage] of [[a, damageA], [b, damageB]]) {
      if (!damage) continue;
      if (entity.classId === 'bus') awardCrashSpecial(session.score, 'bus', 0, time, { subjectId: entity.id });
      if (entity.classId === 'tanker') {
        awardCrashSpecial(session.score, 'tanker', 0, time, { subjectId: entity.id });
        if (entity.damage.severity > 0.72 && !entity.exploded) session.onVolatileCritical?.(entity, contact);
      }
    }
  }
  return semantic;
}

export function detachedBitForPart(name) {
  return CRASH_DETACHED_PART_BITS[name] || 0;
}
