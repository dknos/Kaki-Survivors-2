export function kakiBoomFalloff(distance, radius = 22) {
  const t = Math.max(0, Math.min(1, 1 - Math.max(0, Number(distance) || 0) / Math.max(0.001, radius)));
  return t * t * (3 - 2 * t);
}

export function kakiBoomImpulse({ distance = 0, mass = 1200, charge = 1, radius = 22, vertical = false } = {}) {
  const safeMass = Math.max(80, Number(mass) || 1200);
  const c = Math.max(0, Math.min(1, Number(charge) || 0));
  const falloff = kakiBoomFalloff(distance, radius);
  const massResponse = Math.pow(1450 / (safeMass + 520), 0.28);
  const baseDeltaV = (2.4 + c * 5.1) * falloff * massResponse;
  const maxDeltaV = vertical ? 3.65 : safeMass > 7000 ? 5.25 : 7.8;
  const deltaV = Math.min(maxDeltaV, baseDeltaV);
  return { falloff, deltaV, impulse: deltaV * safeMass };
}

export function canTriggerKakiBoom(scoreState) {
  return !!scoreState && !scoreState.boomUsed && scoreState.boomCharge >= 0.999;
}

export function consumeKakiBoom(scoreState) {
  if (!canTriggerKakiBoom(scoreState)) return false;
  scoreState.boomUsed = true;
  scoreState.boomCharge = 0;
  return true;
}

export function triggerKakiBoom({ scoreState, entities = [], origin, recorder = null, time = 0, onTarget = null } = {}) {
  if (!consumeKakiBoom(scoreState) || !origin) return { triggered: false, affected: [] };
  const affected = [];
  for (const entity of entities) {
    const body = entity?.body;
    if (!body || entity.kind === 'environment') continue;
    const position = body.translation();
    const dx = position.x - origin.x;
    const dz = position.z - origin.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 22) continue;
    const mass = Math.max(1, body.mass());
    const horizontal = kakiBoomImpulse({ distance, mass, charge: 1, radius: 22 });
    const vertical = kakiBoomImpulse({ distance, mass, charge: 1, radius: 18, vertical: true });
    const inv = distance > 0.05 ? 1 / distance : 1;
    const impulse = {
      x: dx * inv * horizontal.impulse,
      y: vertical.impulse * 0.62,
      z: dz * inv * horizontal.impulse,
    };
    body.wakeUp?.();
    body.applyImpulse(impulse, true);
    body.applyTorqueImpulse({
      x: -dz * inv * Math.min(mass * 1.35, horizontal.impulse * 0.14),
      y: (entity.id.length % 2 ? 1 : -1) * Math.min(mass * 0.72, horizontal.impulse * 0.08),
      z: dx * inv * Math.min(mass * 1.35, horizontal.impulse * 0.14),
    }, true);
    entity.crashed = true;
    affected.push({ id: entity.id, distance, impulse: horizontal.impulse, deltaV: horizontal.deltaV });
    onTarget?.(entity, horizontal);
  }
  recorder?.recordEvent({ type: 'kakiBoom', time, subjectId: 'player', point: { ...origin }, value: affected.length * 1200, affected: affected.map((entry) => entry.id) });
  return { triggered: true, affected };
}
