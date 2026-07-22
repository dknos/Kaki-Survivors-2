/**
 * Authored height-field courses for Kaki Trials.
 *
 * The data and sampling helpers are deliberately renderer-free. Heights are
 * cubic Hermite curves between ordered control points; gaps always sample as
 * `null`, giving the physics a real edge to launch from.
 */

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const TRACKS = {
  meadow: {
    id: 'meadow',
    name: 'Mochi Meadow Motor Mews',
    subtitle: 'A sunny roll through picnic hills and kitten-sized kickers.',
    difficulty: 1,
    difficultyLabel: 'Warm-Up',
    colors: { sky: 0xbcecff, haze: 0xf8dff0, ground: 0x86c96d, dirt: 0xb9875e, accent: 0xff7faf, shadow: 0x4f7750 },
    length: 780,
    finish: 760,
    spawn: { x: 8 },
    heightPoints: [
      { x: 0, y: 3, slope: 0 }, { x: 45, y: 3.6 }, { x: 86, y: 7.2 },
      { x: 124, y: 4.1 }, { x: 162, y: 8.2 }, { x: 198, y: 14.2, slope: 0.42 },
      { x: 216, y: 5.4, slope: -0.08 }, { x: 258, y: 3.8 }, { x: 302, y: 8.6 },
      { x: 344, y: 5.1 }, { x: 384, y: 11.8 }, { x: 420, y: 15.4, slope: 0.34 },
      { x: 440, y: 6.2, slope: -0.05 }, { x: 482, y: 4.5 }, { x: 526, y: 9.6 },
      { x: 568, y: 5.5 }, { x: 610, y: 12.8 }, { x: 646, y: 8.2 },
      { x: 688, y: 11.1 }, { x: 728, y: 5.4 }, { x: 780, y: 4, slope: 0 },
    ],
    gaps: [
      { start: 198, end: 216, label: 'Picnic Brook' },
      { start: 420, end: 440, label: 'Buttercup Hop' },
    ],
    checkpoints: [
      { id: 'meadow-1', x: 170, label: 'Daisy Bell' },
      { id: 'meadow-2', x: 360, label: 'Mochi Gate' },
      { id: 'meadow-3', x: 560, label: 'Sunbeam Arch' },
    ],
    medals: { S: 55, A: 68, B: 86 },
    obstacles: [
      { id: 'meadow-hay-1', kind: 'hay-bale', x: 112, width: 2.6, height: 1.8 },
      { id: 'meadow-crate-1', kind: 'wood-crate', x: 278, width: 1.7, height: 1.7 },
      { id: 'meadow-hay-2', kind: 'hay-bale', x: 352, width: 2.6, height: 1.8 },
      { id: 'meadow-cart-1', kind: 'toy-car', x: 516, width: 3.3, height: 1.5 },
      { id: 'meadow-crate-2', kind: 'wood-crate', x: 704, width: 1.7, height: 1.7 },
    ],
  },
  quarry: {
    id: 'quarry',
    name: 'Purrble Quarry Climb',
    subtitle: 'Heavy stone rollers, ore carts, and brave limestone leaps.',
    difficulty: 2,
    difficultyLabel: 'Rowdy',
    colors: { sky: 0xc8deea, haze: 0xe6cdb9, ground: 0x77766f, dirt: 0x98735b, accent: 0x65e0c1, shadow: 0x343b42 },
    length: 990,
    finish: 965,
    spawn: { x: 8 },
    heightPoints: [
      { x: 0, y: 5, slope: 0 }, { x: 38, y: 5.5 }, { x: 78, y: 12 },
      { x: 118, y: 7 }, { x: 154, y: 17.5, slope: 0.5 }, { x: 180, y: 7, slope: -0.08 },
      { x: 222, y: 4.5 }, { x: 266, y: 14 }, { x: 305, y: 19 },
      { x: 344, y: 9 }, { x: 386, y: 15 }, { x: 418, y: 23, slope: 0.58 },
      { x: 454, y: 8, slope: -0.1 }, { x: 496, y: 5.5 }, { x: 540, y: 16 },
      { x: 580, y: 10 }, { x: 620, y: 22 }, { x: 660, y: 14 },
      { x: 702, y: 24 }, { x: 738, y: 30, slope: 0.44 }, { x: 780, y: 11, slope: -0.1 },
      { x: 822, y: 7 }, { x: 862, y: 19 }, { x: 902, y: 12 },
      { x: 942, y: 8 }, { x: 990, y: 7, slope: 0 },
    ],
    gaps: [
      { start: 154, end: 180, label: 'Pebble Pit' },
      { start: 418, end: 454, label: 'Crusher Chasm' },
      { start: 738, end: 780, label: 'Forecat Drop' },
    ],
    checkpoints: [
      { id: 'quarry-1', x: 132, label: 'Glowmoss Lamp' },
      { id: 'quarry-2', x: 372, label: 'Cartworks' },
      { id: 'quarry-3', x: 602, label: 'Echo Crane' },
      { id: 'quarry-4', x: 848, label: 'Top Paw' },
    ],
    medals: { S: 75, A: 92, B: 118 },
    obstacles: [
      { id: 'quarry-barrels-1', kind: 'barrel-stack', x: 96, width: 2.4, height: 2.6 },
      { id: 'quarry-cart-1', kind: 'ore-cart', x: 286, width: 3.8, height: 2.1 },
      { id: 'quarry-rocks-1', kind: 'rock-stack', x: 568, width: 3.2, height: 2.8 },
      { id: 'quarry-barrels-2', kind: 'barrel-stack', x: 686, width: 2.4, height: 2.6 },
      { id: 'quarry-cart-2', kind: 'ore-cart', x: 838, width: 3.8, height: 2.1 },
      { id: 'quarry-rocks-2', kind: 'rock-stack', x: 924, width: 3.2, height: 2.8 },
    ],
  },
  crown: {
    id: 'crown',
    name: 'Kaki Crown Cloudway',
    subtitle: 'Pastel sky islands, royal gaps, and one glorious victory flight.',
    difficulty: 3,
    difficultyLabel: 'Crown Challenge',
    colors: { sky: 0x91dfff, haze: 0xffd8ef, ground: 0xb4df7b, dirt: 0xe6bc8c, accent: 0xff66b7, shadow: 0x7064a1 },
    length: 1190,
    finish: 1160,
    spawn: { x: 8 },
    heightPoints: [
      { x: 0, y: 18, slope: 0 }, { x: 42, y: 19 }, { x: 82, y: 27 },
      { x: 116, y: 34, slope: 0.48 }, { x: 146, y: 20, slope: -0.08 },
      { x: 188, y: 16 }, { x: 226, y: 30 }, { x: 264, y: 21 },
      { x: 302, y: 36, slope: 0.56 }, { x: 340, y: 18, slope: -0.12 },
      { x: 384, y: 14 }, { x: 426, y: 29 }, { x: 468, y: 20 },
      { x: 512, y: 38 }, { x: 548, y: 44, slope: 0.52 }, { x: 598, y: 20, slope: -0.1 },
      { x: 642, y: 16 }, { x: 682, y: 32 }, { x: 720, y: 24 },
      { x: 760, y: 39 }, { x: 800, y: 31 }, { x: 832, y: 43, slope: 0.46 },
      { x: 878, y: 19, slope: -0.08 }, { x: 920, y: 15 }, { x: 960, y: 30 },
      { x: 1000, y: 42, slope: 0.62 }, { x: 1062, y: 20, slope: -0.12 },
      { x: 1102, y: 16 }, { x: 1138, y: 25 }, { x: 1190, y: 20, slope: 0 },
    ],
    gaps: [
      { start: 116, end: 146, label: 'Ribbon Rift' },
      { start: 302, end: 340, label: 'Tea-Cup Skyhop' },
      { start: 548, end: 598, label: 'Rainbow Reach' },
      { start: 832, end: 878, label: 'Royal Air' },
      { start: 1000, end: 1062, label: 'Crownmaker' },
    ],
    checkpoints: [
      { id: 'crown-1', x: 174, label: 'Cloudbell' },
      { id: 'crown-2', x: 408, label: 'Macaron Arch' },
      { id: 'crown-3', x: 664, label: 'Rainbow Paw' },
      { id: 'crown-4', x: 934, label: 'Royal Ribbon' },
      { id: 'crown-5', x: 1100, label: 'Crown Gate' },
    ],
    medals: { S: 96, A: 120, B: 154 },
    obstacles: [
      { id: 'crown-crate-1', kind: 'candy-crate', x: 68, width: 1.8, height: 1.8 },
      { id: 'crown-car-1', kind: 'toy-car', x: 244, width: 3.3, height: 1.5 },
      { id: 'crown-stack-1', kind: 'crown-stack', x: 454, width: 2.8, height: 3.4 },
      { id: 'crown-crate-2', kind: 'candy-crate', x: 704, width: 1.8, height: 1.8 },
      { id: 'crown-car-2', kind: 'toy-car', x: 944, width: 3.3, height: 1.5 },
      { id: 'crown-stack-2', kind: 'crown-stack', x: 1122, width: 2.8, height: 3.4 },
    ],
  },
};

export const TRIALS_TRACKS = deepFreeze(TRACKS);
export const TRIALS_TRACK_ORDER = Object.freeze(['meadow', 'quarry', 'crown']);

/** Resolve a track id, falling back to the friendly meadow course. */
export function getTrialsTrack(track = 'meadow') {
  if (track && typeof track === 'object' && Array.isArray(track.heightPoints)) return track;
  return TRIALS_TRACKS[track] || TRIALS_TRACKS.meadow;
}

export function isTrialsGap(track, x) {
  const course = getTrialsTrack(track);
  return course.gaps.some((gap) => x >= gap.start && x <= gap.end);
}

function pointSlope(points, index) {
  const point = points[index];
  if (Number.isFinite(point.slope)) return point.slope;
  const before = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 1)];
  return (after.y - before.y) / Math.max(0.001, after.x - before.x);
}

/**
 * Sample the authored height field. Returns `{ height, slope, angle,
 * segmentIndex }`, or `null` outside the course and inside a real gap.
 */
export function sampleTrialsGround(track, x) {
  const course = getTrialsTrack(track);
  x = Number(x);
  if (!Number.isFinite(x) || x < 0 || x > course.length || isTrialsGap(course, x)) return null;
  const points = course.heightPoints;
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[Math.min(points.length - 1, lo + 1)];
  const width = Math.max(0.001, b.x - a.x);
  const t = Math.max(0, Math.min(1, (x - a.x) / width));
  const t2 = t * t;
  const t3 = t2 * t;
  const m0 = pointSlope(points, lo);
  const m1 = pointSlope(points, Math.min(points.length - 1, lo + 1));
  const height = (2 * t3 - 3 * t2 + 1) * a.y
    + (t3 - 2 * t2 + t) * width * m0
    + (-2 * t3 + 3 * t2) * b.y
    + (t3 - t2) * width * m1;
  const slope = ((6 * t2 - 6 * t) * a.y
    + (3 * t2 - 4 * t + 1) * width * m0
    + (-6 * t2 + 6 * t) * b.y
    + (3 * t2 - 2 * t) * width * m1) / width;
  return { height, slope, angle: Math.atan(slope), segmentIndex: lo };
}

export function getTrialsCheckpoint(track, checkpointIndex = -1) {
  const course = getTrialsTrack(track);
  const index = Math.max(-1, Math.min(course.checkpoints.length - 1, Math.trunc(checkpointIndex)));
  if (index < 0) return { id: 'spawn', x: course.spawn.x, label: 'Start' };
  return course.checkpoints[index];
}
