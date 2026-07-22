export function breakCrashProp(session, entity, contact, time) {
  if (!entity || entity.broken || entity.kind?.startsWith?.('breakable') !== true) return false;
  if ((contact?.impulse || 0) < (entity.breakThreshold || 1500)) return false;
  entity.broken = true;
  entity.body?.setBodyType?.(session.physics.RAPIER.RigidBodyType.Dynamic, true);
  const direction = contact?.direction || { x: 1, y: 0.2, z: 0 };
  const magnitude = Math.min(5200, (contact.impulse || 0) * 0.48);
  entity.body?.applyImpulse?.({
    x: direction.x * magnitude,
    y: Math.abs(direction.y) * magnitude + magnitude * 0.14,
    z: direction.z * magnitude,
  }, true);
  entity.body?.applyTorqueImpulse?.({ x: magnitude * 0.28, y: magnitude * 0.08, z: -magnitude * 0.22 }, true);
  session.replayRecorder?.recordEvent({
    type: entity.kind === 'breakable-structure' ? 'structure-collapse' : 'break',
    time,
    subjectId: entity.id,
    point: contact?.point,
    impulse: contact?.impulse || 0,
  });
  return true;
}

export function syncCrashBreakables(worldView) {
  for (const entity of worldView?.breakables || []) {
    if (!entity.broken || !entity.body || !entity.visual?.root) continue;
    const position = entity.body.translation();
    const rotation = entity.body.rotation();
    if (entity.visualBodyCentered) {
      entity.visual.root.position.set(position.x, position.y, position.z);
    } else if (entity.kind === 'breakable') {
      entity.visual.root.position.set(position.x, position.y - 2.9, position.z);
    } else {
      entity.visual.root.position.set(position.x, position.y, position.z);
    }
    entity.visual.root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  }
}
