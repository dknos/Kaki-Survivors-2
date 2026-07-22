import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TrackRepair,
  TrackSpline,
  TrackValidator,
  TRACK_SIZE_PRESETS,
  TRACK_WIDTH_PRESETS,
  DEFAULT_LAYOUT_TRANSFORM,
  createCanonicalTrackLayout,
  minimumTrackRadii,
} from '../src/racing/drawTrackGeometry.js';
import {
  DRAW_TRACK_THEME_ORDER,
  compileDrawTrackCourse,
} from '../src/racing/drawTrackThemes.js';
import {
  TrackCodeCodec,
  TrackGallery,
  TrackSerializer,
} from '../src/racing/drawTrackStorage.js';

function closedStroke(controls, steps = 10) {
  const points = [];
  for (let i = 0; i < controls.length; i++) {
    const start = controls[i];
    const end = controls[(i + 1) % controls.length];
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      points.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
    }
  }
  return points;
}

function validateWithGrid(rawPoints, controlPoints, options = {}) {
  const first = TrackValidator.validate({ rawPoints, controlPoints, closed: true, ...options });
  return TrackValidator.validate({
    rawPoints,
    controlPoints,
    closed: true,
    ...options,
    startFraction: first.suggestedStartFraction,
  });
}

class FakeStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

console.log('Kaki Rally Draw Your Track smoke');

assert.deepEqual(Object.keys(TRACK_SIZE_PRESETS), ['pocket', 'club', 'grand', 'epic']);
assert.deepEqual(Object.keys(TRACK_WIDTH_PRESETS), ['narrow', 'standard', 'wide', 'extra']);
assert.equal(DRAW_TRACK_THEME_ORDER.length, 8, 'initial theme set changed');

const ellipse = Array.from({ length: 160 }, (_, index) => {
  const angle = index / 160 * Math.PI * 2;
  const shake = Math.sin(index * 3.7) * 0.003;
  return { x: 0.5 + Math.cos(angle) * (0.35 + shake), y: 0.5 + Math.sin(angle) * (0.28 - shake) };
});
const smoothEllipse = TrackSpline.clean(ellipse, 0.55);
assert.ok(smoothEllipse.length < ellipse.length * 0.4, 'shaky stroke was not simplified');
for (const sizeId of Object.keys(TRACK_SIZE_PRESETS)) {
  const result = validateWithGrid(ellipse, smoothEllipse, { sizeId, widthId: 'standard' });
  assert.equal(result.valid, true, `${sizeId} ellipse should be raceable: ${result.errors.map((issue) => issue.id).join(', ')}`);
  assert.ok(result.stats.length >= TRACK_SIZE_PRESETS[sizeId].minLength, `${sizeId} footprint did not affect track length`);
}

const open = TrackValidator.validate({
  rawPoints: ellipse.slice(0, 80),
  controlPoints: TrackSpline.clean(ellipse.slice(0, 80), 0.55),
  closed: false,
});
assert.equal(open.valid, false);
assert.ok(open.errors.some((issue) => issue.id === 'open-loop'), 'open loop lacks a precise error');

const roughRectangle = closedStroke([
  { x: 0.16, y: 0.2 }, { x: 0.84, y: 0.2 }, { x: 0.84, y: 0.8 }, { x: 0.16, y: 0.8 },
], 14);
const rectangleLayout = createCanonicalTrackLayout(
  roughRectangle,
  TrackSpline.clean(roughRectangle, 0.25),
  'club',
);
const rectangleResult = validateWithGrid(rectangleLayout.rawPoints, rectangleLayout.controlPoints, {
  sizeId: 'club', widthId: 'standard', layoutTransform: rectangleLayout.layoutTransform,
});
assert.equal(rectangleResult.valid, true, `rough rectangle did not become raceable: ${rectangleResult.errors.map((issue) => issue.id).join(', ')}`);
assert.ok(rectangleResult.issues.some((issue) => issue.id === 'corner-rounded'), 'sharp rectangle corners were not reported as locally rounded');
assert.ok(rectangleResult.stats.tightestRadius >= minimumTrackRadii(TRACK_WIDTH_PRESETS.standard.width).required * 0.94, 'generated rectangle radius is not mesh/vehicle safe');

const hairpinStroke = closedStroke([
  { x: 0.14, y: 0.2 }, { x: 0.82, y: 0.2 }, { x: 0.82, y: 0.42 }, { x: 0.38, y: 0.42 },
  { x: 0.38, y: 0.73 }, { x: 0.84, y: 0.73 }, { x: 0.84, y: 0.84 }, { x: 0.15, y: 0.84 },
], 12);
const hairpinLayout = createCanonicalTrackLayout(hairpinStroke, TrackSpline.clean(hairpinStroke, 0.12), 'grand');
const hairpinResult = validateWithGrid(hairpinLayout.rawPoints, hairpinLayout.controlPoints, {
  sizeId: 'grand', widthId: 'narrow', layoutTransform: hairpinLayout.layoutTransform,
});
assert.equal(hairpinResult.valid, true, `authored hairpin did not become raceable: ${hairpinResult.errors.map((issue) => issue.id).join(', ')}`);
assert.ok(hairpinResult.stats.cornerCount >= 6 && hairpinResult.stats.maximumCurvature > 0.12, 'hairpin silhouette was flattened into a generic oval');

const stretchedLayout = { ...hairpinLayout.layoutTransform, scaleX: 1.18 };
const stretchedHairpin = validateWithGrid(hairpinLayout.rawPoints, hairpinLayout.controlPoints, {
  sizeId: 'grand', widthId: 'narrow', layoutTransform: stretchedLayout,
});
assert.ok(stretchedHairpin.stats.length > hairpinResult.stats.length + 25, 'explicit horizontal stretch did not change world length');
const originalWorldWidth = Math.max(...hairpinResult.samples.map((point) => point.x)) - Math.min(...hairpinResult.samples.map((point) => point.x));
const stretchedWorldWidth = Math.max(...stretchedHairpin.samples.map((point) => point.x)) - Math.min(...stretchedHairpin.samples.map((point) => point.x));
assert.ok(stretchedWorldWidth > originalWorldWidth * 1.12, 'layout scale was silently normalized away');

const overLimitLayout = { ...hairpinLayout.layoutTransform, scaleX: 1.25 };
const overLimit = validateWithGrid(hairpinLayout.rawPoints, hairpinLayout.controlPoints, {
  sizeId: 'grand', widthId: 'narrow', layoutTransform: overLimitLayout,
});
assert.ok(overLimit.stats.length > TRACK_SIZE_PRESETS.grand.maxLength, 'over-limit fixture is not actually over budget');
assert.equal(overLimit.valid, true, 'mildly over-limit track should remain editable and raceable');
assert.ok(overLimit.issues.some((issue) => issue.id === 'too-long' && issue.severity === 'warning'), 'over-limit budget lacks an actionable warning');
const lengthRepair = TrackRepair.proposeDetailed(hairpinLayout.rawPoints, {
  smoothing: 0.12, sizeId: 'grand', widthId: 'narrow', layoutTransform: overLimitLayout, validation: overLimit,
});
const repairedLength = validateWithGrid(lengthRepair.points, TrackSpline.clean(lengthRepair.points, 0.12), {
  sizeId: 'grand', widthId: 'narrow', layoutTransform: lengthRepair.layoutTransform,
});
assert.ok(repairedLength.stats.length < overLimit.stats.length && repairedLength.stats.length <= TRACK_SIZE_PRESETS.grand.maxLength * 1.03, 'Make Raceable did not recover the length budget');

const figureEight = Array.from({ length: 180 }, (_, index) => {
  const angle = index / 180 * Math.PI * 2;
  return { x: 0.5 + Math.sin(angle) * 0.36, y: 0.5 + Math.sin(angle) * Math.cos(angle) * 0.31 };
});
const figureEightInitial = TrackValidator.validate({
  rawPoints: figureEight,
  controlPoints: TrackSpline.clean(figureEight, 0.55),
  closed: true,
  sizeId: 'grand',
  widthId: 'standard',
  allowOverpasses: true,
});
assert.ok(figureEightInitial.errors.some((issue) => issue.id === 'grid-crossing'), 'grid at a crossing was not rejected');
const figureEightResult = validateWithGrid(figureEight, TrackSpline.clean(figureEight, 0.55), {
  sizeId: 'grand', widthId: 'standard', allowOverpasses: true,
});
assert.equal(figureEightResult.valid, true, 'a well-spaced figure eight should generate safely');
assert.equal(figureEightResult.overpasses.length, 1, 'figure eight did not become one overpass');
assert.ok(figureEightResult.overpasses[0].approachLength > 40, 'overpass ramps are too abrupt');
assert.ok(Number.isFinite(figureEightResult.overpasses[0].underFraction), 'overpass did not retain the lower crossing branch');
assert.ok(Math.abs(figureEightResult.overpasses[0].fraction - figureEightResult.overpasses[0].underFraction) > 0.2, 'upper and lower crossing branches collapsed onto the same route progress');
assert.ok(!figureEightResult.errors.some((issue) => issue.id === 'grid-crossing'), 'automatic grid placement stayed inside the bridge approach');

const figureEightCourse = compileDrawTrackCourse({
  id: 'kdt-overpass-smoke',
  name: 'Kaki Skyway Test',
  themeId: 'industrial',
  sizeId: 'grand',
  widthId: 'standard',
  seed: 818181,
  rawStroke: figureEight,
  controlPoints: TrackSpline.clean(figureEight, 0.55),
  layoutTransform: DEFAULT_LAYOUT_TRANSFORM,
  modifiers: {},
}, figureEightResult);
assert.equal(figureEightCourse.overpasses.length, 1, 'compiled course lost the safe crossing');
assert.ok(Number.isFinite(figureEightCourse.overpasses[0].underFraction), 'compiled bridge lost underpass route metadata');
assert.ok(figureEightCourse.overpasses[0].angle >= 0.52, 'compiled bridge retained an unsafe crossing angle');

const catControls = [
  [0.18, 0.62], [0.16, 0.44], [0.23, 0.25], [0.30, 0.16], [0.33, 0.31],
  [0.50, 0.22], [0.67, 0.31], [0.70, 0.16], [0.78, 0.25], [0.84, 0.44],
  [0.82, 0.62], [0.68, 0.78], [0.50, 0.84], [0.32, 0.78],
].map(([x, y]) => ({ x, y }));
const catStroke = closedStroke(catControls);
const rawCatResult = validateWithGrid(catStroke, TrackSpline.clean(catStroke, 0.55), { sizeId: 'grand', widthId: 'standard' });
assert.equal(rawCatResult.valid, false, 'sharp cat ears should request repair rather than fold the mesh');
const repairedCat = TrackRepair.propose(catStroke, { smoothing: 0.55, sizeId: 'grand', widthId: 'standard' });
const catResult = validateWithGrid(repairedCat, repairedCat, { sizeId: 'grand', widthId: 'standard' });
assert.equal(catResult.valid, true, `cat-shaped track repair failed: ${catResult.errors.map((issue) => issue.id).join(', ')}`);
assert.ok(catResult.stats.cornerCount >= 4, 'cat repair oversmoothed the silhouette into an oval');

const draft = {
  id: 'kdt-smoke',
  name: 'Nine Lives Test Ring',
  themeId: 'neon',
  sizeId: 'grand',
  widthId: 'wide',
  seed: 123456,
  reverse: true,
  smoothing: 0.61,
  startFraction: 0.15,
  layoutTransform: { ...DEFAULT_LAYOUT_TRANSFORM, occupancy: 0.84, scaleX: 1.17, scaleY: 0.95, offsetX: 0.04, offsetY: -0.03 },
  modifiers: { randomJumps: true, mirror: true },
  rawStroke: ellipse,
  controlPoints: smoothEllipse,
};
const code = TrackCodeCodec.encode(draft);
const decoded = TrackCodeCodec.decode(code);
assert.match(code, /^KDT2-/);
assert.ok(code.length < 240, `track code is unexpectedly long: ${code.length}`);
assert.equal(decoded.themeId, draft.themeId);
assert.equal(decoded.sizeId, draft.sizeId);
assert.equal(decoded.widthId, draft.widthId);
assert.equal(decoded.reverse, true);
assert.equal(decoded.modifiers.randomJumps, true);
assert.equal(decoded.modifiers.mirror, true);
assert.ok(Math.abs(decoded.layoutTransform.occupancy - draft.layoutTransform.occupancy) < 0.001);
assert.ok(Math.abs(decoded.layoutTransform.scaleX - draft.layoutTransform.scaleX) < 0.001);
assert.ok(Math.abs(decoded.layoutTransform.scaleY - draft.layoutTransform.scaleY) < 0.001);
assert.ok(Math.abs(decoded.layoutTransform.offsetX - draft.layoutTransform.offsetX) < 0.001);
assert.ok(Math.abs(decoded.layoutTransform.offsetY - draft.layoutTransform.offsetY) < 0.001);
assert.throws(() => TrackCodeCodec.decode(`${code.slice(0, -2)}aa`), /corrupt|invalid|incomplete/i);
const normalizedDraft = TrackSerializer.deserialize(TrackSerializer.serialize(draft));
assert.equal(normalizedDraft.controlPoints.length, smoothEllipse.length);
const legacyCode = TrackCodeCodec.encodeLegacy({ ...draft, layoutTransform: undefined });
const legacyDecoded = TrackCodeCodec.decode(legacyCode);
assert.match(legacyCode, /^KDT1-/);
assert.deepEqual(legacyDecoded.layoutTransform, DEFAULT_LAYOUT_TRANSFORM, 'KDT1 migration did not receive sane layout defaults');
assert.ok(legacyDecoded.controlPoints.length >= 6, 'KDT1 migration lost the recognizable circuit');

const courseValidation = validateWithGrid(normalizedDraft.rawStroke, normalizedDraft.controlPoints, {
  sizeId: 'grand', widthId: 'wide', layoutTransform: normalizedDraft.layoutTransform,
});
const course = compileDrawTrackCourse(normalizedDraft, courseValidation);
assert.equal(course.mode, 'draw');
assert.equal(course.customTrackId, draft.id);
assert.equal(course.trackWidth, TRACK_WIDTH_PRESETS.wide.width);
assert.ok(course.points.length >= 8);
assert.equal(course.samples, courseValidation.sampleCount, 'dynamic validation sample density did not reach the runtime course');
assert.ok(course.rampFractions.length >= 2);
assert.equal(course.shortcutFractions.length, 0, 'arbitrary geometry must not inherit chapter shortcuts');

const storage = new FakeStorage();
const gallery = new TrackGallery(storage);
gallery.save(draft);
assert.equal(gallery.summary().count, 1);
gallery.toggleFavorite(draft.id);
assert.equal(gallery.get(draft.id).favorite, true);
gallery.recordRace(draft.id, { lapTime: 42.5, result: { position: 1 }, vehicle: 'kitty' });
assert.equal(gallery.get(draft.id).bestLap, 42.5);
const duplicate = gallery.duplicate(draft.id);
assert.notEqual(duplicate.id, draft.id);
assert.equal(gallery.summary().count, 2);
assert.equal(gallery.delete(duplicate.id), true);

const generationSource = await readFile(new URL('../src/racing/drawTrackGeneration.js', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../src/racing/index.js', import.meta.url), 'utf8');
for (const contract of ['TrackMeshBuilder', 'CheckpointGenerator', 'RespawnGenerator', 'AIPathGenerator']) {
  assert.match(generationSource, new RegExp(`export class ${contract}`), `${contract} is not a separate generation responsibility`);
  assert.match(runtimeSource, new RegExp(contract), `${contract} is not integrated into Kaki Rally`);
}
assert.match(runtimeSource, /customCourse:\s*options\.customCourse/, 'runtime does not accept the compiled player course');
assert.match(runtimeSource, /groundHeight:\s*onRoad[\s\S]*roadSample\.y/, 'road collision does not follow overpass elevation');
for (const bridgePart of ['bridge-decks', 'bridge-fascias', 'bridge-portal-posts', 'bridge-portal-beams', 'bridge-marker-lights']) {
  assert.match(generationSource, new RegExp(`draw-track-${bridgePart}`), `procedural ${bridgePart} kit is missing`);
}

console.log('Kaki Rally Draw Your Track smoke passed');
