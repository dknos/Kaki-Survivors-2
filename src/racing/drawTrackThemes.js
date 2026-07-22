/** Theme presets and runtime-course compilation for Draw Your Track. */
import { RACE_COURSES } from './tracks.js';
import { TRACK_SIZE_PRESETS, TRACK_WIDTH_PRESETS } from './drawTrackGeometry.js';

export const DRAW_TRACK_THEMES = Object.freeze({
  countryside: Object.freeze({
    id: 'countryside', name: 'Kaki Countryside', short: 'COUNTRYSIDE', courseId: 'forest',
    icon: '🌾', road: 0x67513e, shoulder: 0x4b5f36, ground: 0x6f8a4d, curb: 0xffe2a4, accent: 0xffa85e,
    detail: 'Fern banks, hay bales, timber signs and golden rally light.',
  }),
  forest: Object.freeze({
    id: 'forest', name: 'Forest Rally', short: 'FOREST', courseId: 'twilight',
    icon: '🌲', road: 0x3e4645, shoulder: 0x294438, ground: 0x355b45, curb: 0xd8f2bd, accent: 0x79e8b2,
    detail: 'Deep trees, wet stone, lantern gates and mossy barriers.',
  }),
  desert: Object.freeze({
    id: 'desert', name: 'Desert Dust', short: 'DESERT', courseId: 'cinder',
    icon: '☀', road: 0x594537, shoulder: 0x9a5f38, ground: 0xb67643, curb: 0xffd07a, accent: 0xff7a3d,
    detail: 'Sun-baked dirt, sandstone markers and enormous dust plumes.',
  }),
  snow: Object.freeze({
    id: 'snow', name: 'Snowy Mountain', short: 'SNOW', courseId: 'cave',
    icon: '❄', road: 0x4c5561, shoulder: 0x9cabb7, ground: 0xcbd8df, curb: 0xf7fbff, accent: 0x77dfff,
    detail: 'Icy shoulders, quarry cliffs, snow flags and cold blue light.',
  }),
  neon: Object.freeze({
    id: 'neon', name: 'Neon Night', short: 'NEON', courseId: 'void',
    icon: '✦', road: 0x242234, shoulder: 0x30244c, ground: 0x18132b, curb: 0x7aeaff, accent: 0xff66c7,
    detail: 'Glowing rails, synth-night haze and ultraviolet grandstands.',
  }),
  coastal: Object.freeze({
    id: 'coastal', name: 'Coastal Run', short: 'COAST', courseId: 'kakiland',
    icon: '≈', road: 0xd1b889, shoulder: 0x79a868, ground: 0x7dc2a3, curb: 0xffffff, accent: 0x35cfe0,
    detail: 'Bright boardwalk colors, sea-glass signs and breezy overlooks.',
  }),
  industrial: Object.freeze({
    id: 'industrial', name: 'Industrial Wreckyard', short: 'WRECKYARD', courseId: 'cave',
    icon: '⚙', road: 0x35383d, shoulder: 0x544b43, ground: 0x62594e, curb: 0xffc857, accent: 0xff6d45,
    detail: 'Containers, work lights, concrete walls and scrapyard clutter.',
  }),
  dirt: Object.freeze({
    id: 'dirt', name: 'Monster Smash Dirt Arena', short: 'DIRT ARENA', courseId: 'cinder',
    icon: '✹', road: 0x6a4931, shoulder: 0x8c5a32, ground: 0x754428, curb: 0xffe066, accent: 0xff4f8b,
    detail: 'Chunky dirt, tire stacks, launch paint and demolition-show energy.',
  }),
});

export const DRAW_TRACK_THEME_ORDER = Object.freeze(Object.keys(DRAW_TRACK_THEMES));

const NAME_FIRST = Object.freeze([
  'Mao Mao', 'Crooked Whisker', 'Kaki Thunder', 'Nine Lives', 'Big Pipes',
  'Clawhammer', 'Wobbly Tail', 'Purring Comet', 'Orange Paw', 'Turbo Tuna',
]);
const NAME_LAST = Object.freeze([
  'Motor Loop', 'Circuit', 'Ring', 'Raceway', 'International',
  'Speedway', 'Grand Prix', 'Rally Park', 'Skyway', 'Scramble',
]);

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || 'kaki')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createDrawTrackId(seed = Date.now()) {
  const value = (Number(seed) || Date.now()) >>> 0;
  return `kdt-${value.toString(36)}-${Math.floor((value * 2654435761) >>> 0).toString(36).slice(0, 4)}`;
}

export function proceduralTrackName(seed, stats = null) {
  const hash = hashString(`${seed}:${Math.round(stats?.length || 0)}:${stats?.cornerCount || 0}`);
  return `${NAME_FIRST[hash % NAME_FIRST.length]} ${NAME_LAST[(hash >>> 8) % NAME_LAST.length]}`;
}

function cyclicDistance(a, b) {
  const distance = Math.abs(a - b);
  return Math.min(distance, 1 - distance);
}

function safeFeatureFractions(overpasses, count, seed, start = 0.12) {
  const output = [];
  const bridgeFractions = (overpasses || []).map((bridge) => bridge.fraction);
  let cursor = start + ((Number(seed) >>> 4) % 11) / 100;
  for (let attempt = 0; output.length < count && attempt < count * 12; attempt++) {
    const fraction = ((cursor + attempt * 0.17320508) % 0.76) + 0.12;
    const safe = bridgeFractions.every((bridge) => cyclicDistance(fraction, bridge) > 0.11)
      && output.every((existing) => cyclicDistance(existing, fraction) > 0.12);
    if (safe) output.push(fraction);
  }
  return output;
}

export function compileDrawTrackCourse(draft, validation) {
  if (!validation?.valid) throw new Error('Draw Your Track cannot compile an invalid circuit');
  const theme = DRAW_TRACK_THEMES[draft.themeId] || DRAW_TRACK_THEMES.countryside;
  const base = RACE_COURSES[theme.courseId] || RACE_COURSES.forest;
  const size = TRACK_SIZE_PRESETS[draft.sizeId] || TRACK_SIZE_PRESETS.club;
  const roadWidth = TRACK_WIDTH_PRESETS[draft.widthId] || TRACK_WIDTH_PRESETS.standard;
  const seed = (Number(draft.seed) || Date.now()) >>> 0;
  const id = draft.id || createDrawTrackId(seed);
  const modifiers = { ...(draft.modifiers || {}) };
  const overpasses = validation.overpasses.map((bridge, index) => ({
    id: `overpass-${index + 1}`,
    fraction: bridge.fraction,
    height: bridge.height,
    approachLength: bridge.approachLength,
    underFraction: bridge.underFraction,
    angle: bridge.angle,
    point: { x: bridge.point.x, z: bridge.point.y },
  }));
  const jumpCount = modifiers.randomJumps ? (size.id === 'epic' ? 4 : size.id === 'grand' ? 3 : 2) : 0;
  const rampFractions = safeFeatureFractions(overpasses, jumpCount, seed, 0.18);
  const boostFractions = modifiers.boostPads === false
    ? []
    : safeFeatureFractions(overpasses, size.id === 'pocket' ? 2 : 3, seed ^ 0x9e3779b9, 0.08);
  const name = String(draft.name || '').trim().slice(0, 42) || proceduralTrackName(seed, validation.stats);

  return {
    ...base,
    id: theme.courseId,
    customTrackId: id,
    isDrawTrack: true,
    name,
    chapter: theme.name,
    tagline: `${validation.stats.personality} · drawn by you`,
    sky: modifiers.nightRace ? 0x101426 : base.sky,
    fog: modifiers.nightRace ? 0x101426 : base.fog,
    ground: theme.ground,
    road: theme.road,
    shoulder: theme.shoulder,
    curb: theme.curb,
    accent: theme.accent,
    propKind: theme.courseId,
    mode: 'draw',
    trackWidth: roadWidth.width,
    samples: validation.sampleCount || size.samples,
    laps: Number.isFinite(draft.laps) ? Math.max(1, Math.min(9, Math.round(draft.laps))) : size.laps,
    points: (validation.racingControlPoints || validation.controlPoints).map((point) => [point.x, point.y]),
    overpasses,
    rampFractions,
    boostFractions,
    repairFractions: safeFeatureFractions(overpasses, 1, seed ^ 0x51ed270b, 0.83),
    shortcutFractions: [],
    seed,
    drawThemeId: theme.id,
    drawSizeId: size.id,
    drawWidthId: roadWidth.id,
    drawDirection: draft.reverse ? 'reverse' : 'forward',
    drawModifiers: modifiers,
    drawStats: {
      length: validation.stats.length,
      estimatedLapTime: validation.stats.estimatedLapTime,
      corners: validation.stats.cornerCount,
      tightestRadius: validation.stats.tightestRadius,
      longestStraight: validation.stats.longestStraight,
      difficulty: validation.stats.difficulty,
      personality: validation.stats.personality,
      overtakingPotential: validation.stats.overtakingPotential,
    },
    drawDraft: {
      ...draft,
      id,
      name,
      seed,
      rawStroke: (draft.rawStroke || []).map((point) => ({ x: point.x, y: point.y })),
      controlPoints: (draft.controlPoints || []).map((point) => ({ x: point.x, y: point.y })),
    },
  };
}
