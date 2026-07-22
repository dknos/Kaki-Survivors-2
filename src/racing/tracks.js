/** Chapter-to-racetrack art direction and spline control points. */
import { getMonsterArenaDefinition } from './monsterArenaDefinition.js';

const COMMON = {
  laps: 3,
  trackWidth: 8.4,
  samples: 192,
  // Narrow dirt chords cut across two corners. They save real distance but use
  // loose-surface grip, so entering without speed or a charged drift is slower.
  shortcutFractions: [[0.18, 0.27], [0.62, 0.7]],
  kartColors: [
    0xff5d8f, 0x55d8ff, 0xffc857, 0x8ee36b,
    0xa985ff, 0xff7b54, 0x4ce0bb, 0xf3f0e8,
    0x4f78ff, 0xe65ac4, 0xb7df45, 0xff934f,
    0x6ad6ff, 0xdb4b55, 0xd7a6ff, 0x72ee8e,
  ],
};

export const RACE_MODES = Object.freeze({
  circuit: Object.freeze({ id: 'circuit', name: 'Off-Road GP', objective: 'laps', vehicle: 'kart', courseKind: 'circuit', carCount: 8, minCars: 2, maxCars: 12 }),
  drift: Object.freeze({ id: 'drift', name: 'Drift Attack', objective: 'driftScore', vehicle: 'kart', courseKind: 'circuit', carCount: 6, minCars: 2, maxCars: 8, duration: 90 }),
  stock: Object.freeze({ id: 'stock', name: 'Kaki Stock Cup', objective: 'laps', vehicle: 'kart', courseKind: 'oval', carCount: 12, minCars: 2, maxCars: 16 }),
  draw: Object.freeze({ id: 'draw', name: 'Draw Your Track', objective: 'laps', vehicle: 'kart', courseKind: 'drawn-circuit', carCount: 7, minCars: 2, maxCars: 12 }),
  monster: Object.freeze({ id: 'monster', name: 'Monster Smash', objective: 'smashScore', vehicle: 'monster', courseKind: 'stunt-arena', carCount: 1, minCars: 1, maxCars: 1, duration: 120 }),
  trials: Object.freeze({ id: 'trials', name: 'Kaki Trials', objective: 'trialsTime', vehicle: 'trials', courseKind: 'side-trials', carCount: 1, minCars: 1, maxCars: 1 }),
  crash: Object.freeze({ id: 'crash', name: 'Kaki Catastrophe', objective: 'crashScore', vehicle: 'crash-car', courseKind: 'crash-junction', carCount: 1, minCars: 1, maxCars: 1, duration: 36 }),
});

const STOCK_POINTS = Object.freeze([
  [-58, -28], [-43, -43], [-20, -51], [14, -51], [42, -43], [58, -26],
  [64, 0], [58, 26], [42, 43], [14, 51], [-20, 51], [-43, 43], [-58, 28], [-64, 0],
]);

const STOCK_NAMES = Object.freeze({
  forest: 'Borrowed Post Bowl', twilight: 'Nobody\'s Turn', cinder: 'Kiln-Shift Oval',
  void: 'Quiet Toll Ring', cave: 'Glass Mile Motor Yard', kakiland: 'Chalkline Speedway',
});

export const RACE_COURSES = Object.freeze({
  forest: {
    ...COMMON,
    id: 'forest',
    name: 'Borrowed Post Switchback',
    chapter: 'Felt Switchback',
    tagline: 'Felt shoulders, repaired signs, and one mailbox facing away.',
    sky: 0x17261e,
    fog: 0x17261e,
    ground: 0x547044,
    road: 0x68503d,
    shoulder: 0x3a4c32,
    curb: 0xffe4a8,
    accent: 0x8ff0a4,
    groundTexture: 'assets/textures/ground_detail_forest_512.webp',
    chapterArt: 'assets/sprites/chapters/chapter_forest_kaki-v1.webp',
    propKind: 'forest',
    rampFractions: [0.18, 0.63],
    boostFractions: [0.38, 0.82],
    points: [
      [-42, -8], [-34, -32], [-9, -44], [18, -39], [41, -20],
      [46, 8], [29, 31], [5, 43], [-24, 37], [-46, 17],
    ],
  },
  twilight: {
    ...COMMON,
    id: 'twilight',
    name: 'Nobody\'s Turn',
    chapter: 'Paper Woods',
    tagline: 'Wet paper bends, lantern gates, and no agreed direction.',
    sky: 0x111b2c,
    fog: 0x111b2c,
    ground: 0x354758,
    road: 0x3d4650,
    shoulder: 0x24303a,
    curb: 0xb6dcff,
    accent: 0x71d7ff,
    groundTexture: 'assets/textures/ground_detail_twilight_512.webp',
    chapterArt: 'assets/sprites/chapters/chapter_twilight.webp',
    propKind: 'twilight',
    rampFractions: [0.29, 0.74],
    boostFractions: [0.08, 0.53, 0.9],
    points: [
      [-45, -25], [-17, -42], [11, -34], [34, -43], [48, -20],
      [31, -2], [45, 23], [20, 43], [-6, 31], [-31, 43],
      [-49, 18], [-29, 1],
    ],
  },
  cinder: {
    ...COMMON,
    id: 'cinder',
    name: 'Kiln-Shift Circuit',
    chapter: 'Ceramic Basin',
    tagline: 'Fired-clay hairpins. The cups are hotter than the brakes.',
    sky: 0x260b08,
    fog: 0x260b08,
    ground: 0x6b3024,
    road: 0x342927,
    shoulder: 0x522117,
    curb: 0xffb04a,
    accent: 0xff6b35,
    groundTexture: 'assets/textures/ground_detail_cinder_512.webp',
    chapterArt: 'assets/sprites/chapters/chapter_cinder.webp',
    propKind: 'cinder',
    rampFractions: [0.12, 0.47, 0.8],
    boostFractions: [0.32, 0.68],
    points: [
      [-46, -29], [-15, -43], [17, -31], [44, -40], [48, -13],
      [22, 1], [43, 24], [18, 42], [-10, 25], [-37, 42],
      [-48, 13], [-22, -3],
    ],
  },
  void: {
    ...COMMON,
    id: 'void',
    name: 'Quiet Toll Run',
    chapter: 'Woolen Drift',
    tagline: 'Violet esses circle a tollbooth that collects only echoes.',
    sky: 0x10091c,
    fog: 0x10091c,
    ground: 0x34284a,
    road: 0x282432,
    shoulder: 0x21182f,
    curb: 0xd2a5ff,
    accent: 0xc76dff,
    groundTexture: 'assets/textures/ground_detail_void_512.webp',
    chapterArt: 'assets/sprites/chapters/chapter_void.webp',
    propKind: 'void',
    rampFractions: [0.23, 0.59],
    boostFractions: [0.03, 0.42, 0.86],
    points: [
      [-48, -10], [-36, -37], [-7, -45], [14, -26], [42, -36],
      [49, -8], [29, 9], [45, 35], [15, 43], [-6, 23],
      [-35, 39], [-49, 14], [-24, 2],
    ],
  },
  cave: {
    ...COMMON,
    id: 'cave',
    name: 'Glass Mile',
    chapter: 'Glass Mile',
    tagline: 'Reflection gates, wet stone, and one survey-length jump.',
    sky: 0x17161e,
    fog: 0x17161e,
    ground: 0x42434b,
    road: 0x4a4646,
    shoulder: 0x303139,
    curb: 0xb7ffdc,
    accent: 0x76efc4,
    groundTexture: 'assets/textures/ground_detail_cave_512.webp',
    chapterArt: 'assets/sprites/chapters/chapter_cave.webp',
    propKind: 'cave',
    rampFractions: [0.16, 0.51, 0.77],
    boostFractions: [0.35, 0.7],
    points: [
      [-52, -20], [-25, -43], [5, -38], [30, -47], [52, -22],
      [35, 2], [50, 28], [22, 45], [-7, 35], [-36, 46],
      [-53, 19], [-34, -2],
    ],
  },
  kakiland: {
    ...COMMON,
    id: 'kakiland',
    name: 'Chalkline Loop',
    chapter: 'Chalk Plateau',
    tagline: 'Three old marks and a finish line that keeps being erased.',
    sky: 0x8bd2f0,
    fog: 0x8bd2f0,
    ground: 0x8fbf67,
    road: 0xe8cf9b,
    shoulder: 0x7aa950,
    curb: 0xffffff,
    accent: 0xff7dc8,
    groundTexture: 'assets/kakiland/kaki-land-turf-vertex-v1.png',
    detailTexture: 'assets/kakiland/kaki-land-turf-grok-v1.webp',
    chapterArt: 'assets/kakiland/kaki-land-key-art-gpt-v2.png',
    propKind: 'kakiland',
    rampFractions: [0.09, 0.34, 0.58, 0.84],
    boostFractions: [0.05, 0.3, 0.54, 0.8],
    points: [
      [-48, -26], [-18, -45], [14, -37], [42, -46], [54, -17],
      [31, 4], [51, 29], [20, 47], [-8, 33], [-36, 48],
      [-54, 18], [-32, -5],
    ],
  },
});

export const RACE_COURSE_ORDER = Object.freeze([
  'forest', 'twilight', 'cinder', 'void', 'cave', 'kakiland',
]);

export function getCourseDefinition(id, mode = 'circuit', options = {}) {
  const base = RACE_COURSES[id] || RACE_COURSES.forest;
  if (mode === 'draw') {
    const custom = options.customCourse;
    if (!custom || !Array.isArray(custom.points) || custom.points.length < 6) {
      throw new Error('Draw Your Track needs a validated custom course');
    }
    return {
      ...base,
      ...custom,
      // `id` intentionally remains a shipped biome id. Asset leases and the
      // environment profile use it, while customTrackId owns save/record truth.
      id: RACE_COURSES[custom.id] ? custom.id : base.id,
      mode: 'draw',
      points: custom.points.map((point) => [Number(point[0]), Number(point[1])]),
      rampFractions: [...(custom.rampFractions || [])],
      boostFractions: [...(custom.boostFractions || [])],
      repairFractions: [...(custom.repairFractions || [])],
      shortcutFractions: [],
      overpasses: (custom.overpasses || []).map((bridge) => ({ ...bridge })),
    };
  }
  if (mode === 'monster') {
    const arena = getMonsterArenaDefinition(options.monsterArena || options.arenaId);
    return {
      ...base,
      name: arena.name,
      chapter: 'Monster Arena',
      tagline: arena.subtitle,
      arenaId: arena.id,
      laps: 99,
      rampFractions: [],
      boostFractions: [],
      repairFractions: [],
      shortcutFractions: [],
      chapterArt: 'assets/racing/monster-smash-key-art-oekaki-v2.webp',
      arenaArt: 'assets/racing/monster-smash-key-art-oekaki-v2.webp',
      truckDecal: 'assets/racing/kitty-monster-truck-decal-oekaki-v2.webp',
      mode: 'monster',
    };
  }
  if (mode === 'stock') {
    return {
      ...base,
      name: STOCK_NAMES[base.id] || `${base.name} Speedway`,
      tagline: 'High-speed pack racing, drafting, damage, and pit repairs.',
      points: STOCK_POINTS.map((point) => [...point]),
      trackWidth: 14.5,
      samples: 224,
      laps: 8,
      rampFractions: [],
      boostFractions: [],
      repairFractions: [0.88],
      shortcutFractions: [],
      mode: 'stock',
    };
  }
  if (mode === 'drift') {
    return {
      ...base,
      name: `${base.name} Drift Attack`,
      tagline: 'Link slides, hold the combo, and bank the biggest score.',
      laps: 99,
      repairFractions: [0.88],
      mode: 'drift',
    };
  }
  return { ...base, repairFractions: [0.88], mode: 'circuit' };
}

export function nextCourseId(id) {
  const at = RACE_COURSE_ORDER.indexOf(id);
  return RACE_COURSE_ORDER[(at < 0 ? 0 : at + 1) % RACE_COURSE_ORDER.length];
}
