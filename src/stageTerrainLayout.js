/**
 * Shared authored terrain cuts and their safe crossings.
 *
 * Rendering, gameplay hazards, shard placement, and the minimap all consume
 * this data. That single source of truth is deliberate: a visible creek/rift
 * must always have gameplay behavior, and every visible bridge must always be
 * a genuinely safe crossing.
 */

export const FIELD_MAP_RADIUS = 105;

export const STAGE_TERRAIN_LAYOUTS = Object.freeze({
  forest: Object.freeze({
    kind: 'creek',
    effect: 'slow',
    slowMul: 0.86,
    width: 5.8,
    points: Object.freeze([
      Object.freeze({ x: -43, z: 21 }),
      Object.freeze({ x: -25, z: 24 }),
      Object.freeze({ x: -7, z: 23 }),
      Object.freeze({ x: 12, z: 26 }),
      Object.freeze({ x: 42, z: 22 }),
    ]),
    bridges: Object.freeze([
      Object.freeze({ x: -7, z: 23.3, yaw: 0, halfWidth: 1.58, halfLength: 4.15, asset: 'kk_bridge_wood' }),
      Object.freeze({ x: 31, z: 23.6, yaw: 0, halfWidth: 1.58, halfLength: 4.15, asset: 'kk_bridge_wood' }),
    ]),
    colors: Object.freeze({ deep: 0x123c44, shallow: 0x6eb0a1, edge: 0xbce9d4 }),
  }),
  twilight: Object.freeze({
    kind: 'moonwater',
    effect: 'slow',
    slowMul: 0.80,
    width: 6.8,
    points: Object.freeze([
      Object.freeze({ x: -62, z: 16 }),
      Object.freeze({ x: -32, z: 18 }),
      Object.freeze({ x: 0, z: 15 }),
      Object.freeze({ x: 34, z: 19 }),
      Object.freeze({ x: 62, z: 16 }),
    ]),
    bridges: Object.freeze([
      Object.freeze({ x: 0, z: 15.4, yaw: 0, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
      Object.freeze({ x: -45, z: 17.0, yaw: 0, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
    ]),
    colors: Object.freeze({ deep: 0x071827, shallow: 0x516f96, edge: 0xc6b7ff }),
  }),
  cinder: Object.freeze({
    kind: 'lava-ravine',
    effect: 'damage',
    damagePerSec: 3,
    width: 7.6,
    points: Object.freeze([
      Object.freeze({ x: -66, z: -17 }),
      Object.freeze({ x: -36, z: -14 }),
      Object.freeze({ x: 0, z: -15 }),
      Object.freeze({ x: 35, z: -12 }),
      Object.freeze({ x: 66, z: -16 }),
    ]),
    bridges: Object.freeze([
      Object.freeze({ x: 0, z: -14.8, yaw: 0, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
      Object.freeze({ x: 62, z: -15.4, yaw: 0, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
    ]),
    colors: Object.freeze({ deep: 0x210506, shallow: 0xc33113, edge: 0xffb13b }),
  }),
  void: Object.freeze({
    kind: 'abyss-fracture',
    effect: 'damage',
    damagePerSec: 5,
    width: 7.4,
    points: Object.freeze([
      Object.freeze({ x: -65, z: 13 }),
      Object.freeze({ x: -34, z: 10 }),
      Object.freeze({ x: 0, z: 12 }),
      Object.freeze({ x: 34, z: 9 }),
      Object.freeze({ x: 66, z: 13 }),
    ]),
    bridges: Object.freeze([
      Object.freeze({ x: 0, z: 11.7, yaw: 0, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
      Object.freeze({ x: -49, z: 11.7, yaw: 0, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
    ]),
    colors: Object.freeze({ deep: 0x020107, shallow: 0x17102d, edge: 0x4cdcf2 }),
  }),
  cave: Object.freeze({
    kind: 'grotto-ravine',
    effect: 'slow',
    slowMul: 0.78,
    width: 6.2,
    points: Object.freeze([
      Object.freeze({ x: -12, z: -12 }),
      Object.freeze({ x: -2, z: -2 }),
      Object.freeze({ x: 10, z: 10 }),
      Object.freeze({ x: 23, z: 23 }),
      Object.freeze({ x: 36, z: 36 }),
    ]),
    bridges: Object.freeze([
      Object.freeze({ x: 9.5, z: 9.5, yaw: -Math.PI / 4, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
      Object.freeze({ x: 28, z: 28, yaw: -Math.PI / 4, halfWidth: 1.68, halfLength: 4.15, asset: 'kk_bridge_stone' }),
    ]),
    colors: Object.freeze({ deep: 0x06191d, shallow: 0x2b6562, edge: 0x8be0d0 }),
  }),
});

export function getStageTerrainLayout(stageId) {
  return STAGE_TERRAIN_LAYOUTS[stageId] || null;
}

function _pointSegmentDistanceSq(px, pz, a, b) {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const wx = px - a.x;
  const wz = pz - a.z;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 1e-8 ? (wx * vx + wz * vz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (a.x + vx * t);
  const dz = pz - (a.z + vz * t);
  return dx * dx + dz * dz;
}

export function isPointOnTerrainBridge(stageId, x, z, padding = 0) {
  const layout = getStageTerrainLayout(stageId);
  if (!layout) return false;
  for (const bridge of layout.bridges) {
    const dx = x - bridge.x;
    const dz = z - bridge.z;
    const c = Math.cos(bridge.yaw || 0);
    const s = Math.sin(bridge.yaw || 0);
    const localX = dx * c - dz * s;
    const localZ = dx * s + dz * c;
    if (Math.abs(localX) <= bridge.halfWidth + padding
      && Math.abs(localZ) <= bridge.halfLength + padding) return true;
  }
  return false;
}

export function isPointInTerrainCut(stageId, x, z, padding = 0) {
  const layout = getStageTerrainLayout(stageId);
  if (!layout || layout.points.length < 2) return false;
  const radius = layout.width * 0.5 + padding;
  const radius2 = radius * radius;
  for (let i = 1; i < layout.points.length; i++) {
    if (_pointSegmentDistanceSq(x, z, layout.points[i - 1], layout.points[i]) <= radius2) return true;
  }
  return false;
}

/** Allocation-free consumers can pass an output object to reuse. */
export function sampleStageTerrain(stageId, x, z, out = null) {
  const result = out || {};
  const layout = getStageTerrainLayout(stageId);
  const inCut = !!(layout && isPointInTerrainCut(stageId, x, z));
  const onBridge = !!(inCut && isPointOnTerrainBridge(stageId, x, z));
  result.inside = inCut;
  result.safe = onBridge;
  result.active = inCut && !onBridge;
  result.kind = layout ? layout.kind : null;
  result.effect = layout ? layout.effect : null;
  result.slowMul = layout && layout.slowMul ? layout.slowMul : 1;
  result.damagePerSec = layout && layout.damagePerSec ? layout.damagePerSec : 0;
  return result;
}
