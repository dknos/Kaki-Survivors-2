/**
 * Shared authored exploration data for non-Forest overworlds.
 *
 * StageLife consumes the discovery profiles; destructibles consumes the same
 * anchors plus mechanic/pond keepouts. Keeping one source of truth prevents a
 * seeded breakable from spawning through a bell, ballista, teleport pad, pond,
 * or vault doorway.
 */

export const AMBIENT_TEXTURES = Object.freeze({
  forest: 'assets/textures/ambient_butterfly_256.webp',
  twilight: 'assets/textures/ambient_moon_moth_256.webp',
  cinder: 'assets/textures/ambient_ember_moth_256.webp',
  void: 'assets/textures/ambient_star_kitten_256.webp',
  cave: 'assets/textures/ambient_glowbat_256.webp',
});

export const DISCOVERY_PROFILES = Object.freeze({
  twilight: Object.freeze({
    id: 'moon-bell', kind: 'bell', label: 'MOON BELL', trigger: 'touch',
    color: 0xc6b7ff, accent: 0x8de7ff, rewardColor: 0xd8c7ff,
    placements: Object.freeze([
      Object.freeze([-30, -3]), Object.freeze([3, 34]),
      Object.freeze([-74, 55]), Object.freeze([71, -63]),
      Object.freeze([-64, -42]), Object.freeze([57, 62]),
    ]),
  }),
  cinder: Object.freeze({
    id: 'forgeheart', kind: 'forgeheart', label: 'FORGEHEART', trigger: 'dash',
    color: 0xff7a32, accent: 0xffd24a, rewardColor: 0xff9a45,
    placements: Object.freeze([
      Object.freeze([-29, 13]), Object.freeze([29, 41]),
      Object.freeze([18, -46]), Object.freeze([57, -6]),
      Object.freeze([-31, 38]), Object.freeze([42, 17]),
    ]),
  }),
  void: Object.freeze({
    id: 'star-kitten', kind: 'star', label: 'STAR KITTEN', trigger: 'touch',
    color: 0x77dce8, accent: 0xc39af4, rewardColor: 0x8ff6ff,
    placements: Object.freeze([
      Object.freeze([0, 82]), Object.freeze([78, 61]),
      Object.freeze([86, -52]), Object.freeze([0, -88]),
      Object.freeze([-82, -58]), Object.freeze([-88, 48]),
    ]),
  }),
  cave: Object.freeze({
    id: 'echo-crystal', kind: 'echo', label: 'ECHO CRYSTAL', trigger: 'interact',
    color: 0x82dfcf, accent: 0xc7a9e8, rewardColor: 0x8be0d0,
    placements: Object.freeze([
      Object.freeze([-58, 44]), Object.freeze([64, -48]),
      Object.freeze([74, 66]), Object.freeze([-68, -55]),
      Object.freeze([-74, 61]), Object.freeze([68, -69]),
    ]),
  }),
});

const MECHANIC_KEEPOUTS = Object.freeze({
  twilight: Object.freeze([
    // Blood/light fountains.
    { x: 25.11, z: 6.11, r: 5 }, { x: 24.38, z: -1.22, r: 5 },
    { x: -8.98, z: 31.32, r: 5 }, { x: -1.07, z: 30.17, r: 5 },
    { x: -37.21, z: -4.26, r: 5 }, { x: -37.12, z: 4.30, r: 5 },
    // Moonwater ponds.
    { x: -10, z: -6, r: 7 }, { x: 14, z: 14, r: 6 }, { x: -25, z: 18, r: 5 },
    { x: 58, z: -36, r: 9 }, { x: -64, z: -42, r: 8 }, { x: 57, z: 62, r: 7 },
  ]),
  cinder: Object.freeze([
    // Repairable ballistas.
    { x: -19.52, z: 18.13, r: 6 }, { x: 21.19, z: 33.39, r: 6 },
    { x: 10.75, z: -38.25, r: 6 }, { x: 48.50, z: -8.74, r: 6 },
    { x: -22.89, z: 31.44, r: 6 }, { x: 33.12, z: 8.32, r: 6 },
    // Catapult slow-zone centers.
    { x: 44.49, z: 2.65, r: 5 }, { x: 8.34, z: 25.26, r: 5 },
    { x: -40.00, z: 16.40, r: 5 }, { x: 3.69, z: -32.90, r: 5 },
  ]),
  void: Object.freeze([
    { x: 16.94, z: 29.24, r: 5 }, { x: 2.33, z: 27.78, r: 5 },
    { x: -26.8, z: 17.66, r: 5 }, { x: 44.21, z: -1.75, r: 5 },
    { x: 29.94, z: -33.91, r: 5 }, { x: 3.37, z: -26.2, r: 5 },
  ]),
  cave: Object.freeze([
    // Grotto pools plus the sealed vault precinct.
    { x: -10, z: -6, r: 7 }, { x: 12, z: 11, r: 6 }, { x: 21, z: -12, r: 5 },
    { x: -58, z: 44, r: 9 }, { x: 64, z: -48, r: 9 }, { x: 74, z: 66, r: 7 },
    { x: 17, z: 17, r: 9 },
  ]),
});

// Narrow mesh-footprint holes for decorative growth. These are intentionally
// smaller than destructible keepouts: flowers/embers/crystals should still
// frame a mechanic precinct, just never grow through its actual body/disc.
const GROWTH_CORE_KEEPOUTS = Object.freeze({
  twilight: Object.freeze([
    { x: 25.11, z: 6.11, r: 1.45 }, { x: 24.38, z: -1.22, r: 1.45 },
    { x: -8.98, z: 31.32, r: 1.45 }, { x: -1.07, z: 30.17, r: 1.45 },
    { x: -37.21, z: -4.26, r: 1.45 }, { x: -37.12, z: 4.30, r: 1.45 },
  ]),
  cinder: Object.freeze([
    { x: -19.52, z: 18.13, r: 1.65 }, { x: 21.19, z: 33.39, r: 1.65 },
    { x: 10.75, z: -38.25, r: 1.65 }, { x: 48.50, z: -8.74, r: 1.65 },
    { x: -22.89, z: 31.44, r: 1.65 }, { x: 33.12, z: 8.32, r: 1.65 },
  ]),
  void: Object.freeze([
    { x: 16.94, z: 29.24, r: 1.55 }, { x: 2.33, z: 27.78, r: 1.55 },
    { x: -26.8, z: 17.66, r: 1.55 }, { x: 44.21, z: -1.75, r: 1.55 },
    { x: 29.94, z: -33.91, r: 1.55 }, { x: 3.37, z: -26.2, r: 1.55 },
  ]),
});

export function getStageExplorationKeepouts(stageId) {
  const profile = DISCOVERY_PROFILES[stageId];
  const out = [];
  if (profile) {
    for (const p of profile.placements) out.push({ x: p[0], z: p[1], r: 4.2 });
  }
  const mechanics = MECHANIC_KEEPOUTS[stageId] || [];
  for (const p of mechanics) out.push(p);
  return out;
}

export function isPointInStageExplorationKeepout(stageId, x, z, padding = 0) {
  const profile = DISCOVERY_PROFILES[stageId];
  if (profile) {
    const r = 4.2 + padding;
    const r2 = r * r;
    for (const p of profile.placements) {
      const dx = x - p[0], dz = z - p[1];
      if (dx * dx + dz * dz < r2) return true;
    }
  }
  for (const p of (MECHANIC_KEEPOUTS[stageId] || [])) {
    const r = p.r + padding;
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

export function isPointNearStageDiscovery(stageId, x, z, radius = 1.35) {
  const profile = DISCOVERY_PROFILES[stageId];
  if (!profile) return false;
  const r2 = radius * radius;
  for (const p of profile.placements) {
    const dx = x - p[0], dz = z - p[1];
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

export function getStageGrowthCoreKeepouts(stageId) {
  return GROWTH_CORE_KEEPOUTS[stageId] || [];
}

export function isPointInStageGrowthCore(stageId, x, z, padding = 0) {
  for (const p of (GROWTH_CORE_KEEPOUTS[stageId] || [])) {
    const r = p.r + padding;
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
