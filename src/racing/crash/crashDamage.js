export const DAMAGE_ZONES = Object.freeze(['front', 'rear', 'left', 'right']);

export function selectDamageZone(localPoint, dimensions = {}) {
  const halfWidth = Math.max(0.1, Number(dimensions.width) * 0.5 || 1);
  const halfLength = Math.max(0.1, Number(dimensions.length) * 0.5 || 2);
  const x = (Number(localPoint?.x) || 0) / halfWidth;
  const z = (Number(localPoint?.z) || 0) / halfLength;
  if (Math.abs(z) >= Math.abs(x)) return z >= 0 ? 'front' : 'rear';
  return x >= 0 ? 'right' : 'left';
}

export function createCrashDamageState() {
  return {
    severity: 0,
    zones: { front: 0, rear: 0, left: 0, right: 0 },
    glass: 'intact',
    smoke: 0,
    steeringPull: 0,
    steeringScale: 1,
    powerScale: 1,
    brakeScale: 1,
    axleDamage: { front: 0, rear: 0 },
    detached: new Set(),
  };
}

export function applyCrashDamage(state, { zone = 'front', impulse = 0, relativeSpeed = 0, side = 0 } = {}) {
  if (!state || !DAMAGE_ZONES.includes(zone)) return { changed: false, severity: 0, detached: [] };
  const speed = Math.max(0, Number(relativeSpeed) || 0);
  const energy = Math.max(0, Number(impulse) || 0) * speed;
  // Compound solver impulses are distributed across several contact patches,
  // so impulse alone understated otherwise violent hits. Closing-speed energy
  // restores the visible crush response without making parking taps damaging.
  const amount = Math.min(0.48, energy / 900000 + speed * speed / 1800);
  if (amount < 0.018) return { changed: false, severity: state.severity, detached: [] };
  const before = state.zones[zone];
  const glassBefore = state.glass;
  state.zones[zone] = Math.min(1, before + amount);
  state.severity = Math.min(1, Math.max(...Object.values(state.zones)) * 0.72 + Object.values(state.zones).reduce((a, b) => a + b, 0) * 0.09);
  state.smoke = Math.max(state.smoke, Math.max(0, (state.severity - 0.38) / 0.62));
  state.powerScale = Math.max(0.48, 1 - state.zones.front * 0.42 - state.severity * 0.1);
  state.axleDamage.front = Math.max(state.axleDamage.front, state.zones.front * 0.72, Math.max(state.zones.left, state.zones.right) * 0.28);
  state.axleDamage.rear = Math.max(state.axleDamage.rear, state.zones.rear * 0.66, Math.max(state.zones.left, state.zones.right) * 0.22);
  state.steeringScale = Math.max(0.38, 1 - state.axleDamage.front * 0.56 - state.severity * 0.08);
  state.brakeScale = Math.max(0.52, 1 - Math.max(state.axleDamage.front, state.axleDamage.rear) * 0.34 - state.severity * 0.12);
  state.steeringPull = Math.max(-0.22, Math.min(0.22, state.steeringPull + (zone === 'left' ? 1 : zone === 'right' ? -1 : Number(side) || 0) * amount * 0.26));
  if (state.glass === 'intact' && state.severity >= 0.28) state.glass = 'cracked';
  if (state.glass !== 'shattered' && state.severity >= 0.66) state.glass = 'shattered';
  const detached = [];
  const candidates = zone === 'front' ? ['front-bumper', 'hood']
    : zone === 'rear' ? ['rear-bumper', 'trunk']
      : zone === 'left' ? ['left-door', 'left-mirror'] : ['right-door', 'right-mirror'];
  const threshold = state.zones[zone];
  candidates.forEach((part, index) => {
    if (threshold >= 0.62 + index * 0.17 && !state.detached.has(part)) {
      state.detached.add(part);
      detached.push(part);
    }
  });
  if (state.severity >= 0.82 && Math.max(0, Number(relativeSpeed) || 0) > 14) {
    const wheel = `${zone === 'left' || zone === 'right' ? zone : (side < 0 ? 'left' : 'right')}-${zone === 'rear' ? 'rear' : 'front'}-wheel`;
    if (!state.detached.has(wheel)) {
      state.detached.add(wheel);
      detached.push(wheel);
    }
  }
  return { changed: state.zones[zone] !== before, amount, severity: state.severity, detached, glass: state.glass, glassChanged: state.glass !== glassBefore };
}

export function deformDamageMeshes(meshes, localPoint, localNormal, severity, radius = 1.25, maxDepth = 0.34) {
  const strength = Math.max(0, Math.min(1, Number(severity) || 0));
  if (!strength) return 0;
  let moved = 0;
  for (const mesh of meshes || []) {
    const position = mesh?.geometry?.getAttribute?.('position');
    const originals = mesh?.userData?.baseDamagePositions;
    if (!position?.array || !originals || originals.length !== position.array.length) continue;
    for (let i = 0; i < position.count; i++) {
      const at = i * 3;
      const dx = originals[at] - (localPoint?.x || 0);
      const dy = originals[at + 1] - (localPoint?.y || 0);
      const dz = originals[at + 2] - (localPoint?.z || 0);
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= radius) continue;
      const falloff = Math.pow(1 - distance / radius, 2);
      const depth = Math.min(maxDepth, strength * maxDepth) * falloff;
      const currentX = position.array[at];
      const currentY = position.array[at + 1];
      const currentZ = position.array[at + 2];
      const targetX = currentX - (localNormal?.x || 0) * depth;
      const targetY = currentY - (localNormal?.y || 0) * depth * 0.45;
      const targetZ = currentZ - (localNormal?.z || 0) * depth;
      const displacement = Math.hypot(targetX - originals[at], targetY - originals[at + 1], targetZ - originals[at + 2]);
      const limit = Math.max(0.001, maxDepth * 1.35);
      const clamp = displacement > limit ? limit / displacement : 1;
      position.array[at] = originals[at] + (targetX - originals[at]) * clamp;
      position.array[at + 1] = originals[at + 1] + (targetY - originals[at + 1]) * clamp;
      position.array[at + 2] = originals[at + 2] + (targetZ - originals[at + 2]) * clamp;
      moved += 1;
    }
    if (moved) {
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals?.();
      mesh.geometry.computeBoundingSphere?.();
    }
  }
  return moved;
}
