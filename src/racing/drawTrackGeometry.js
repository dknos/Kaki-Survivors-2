/**
 * Pure geometry pipeline for Draw Your Track.
 *
 * The editor stores device-independent points in the 0..1 drafting plane. This
 * module cleans that stroke, maps its canonical layout into a chosen world
 * footprint, samples it by arc length, validates road clearance, and describes
 * safe overpasses.
 * Keeping it DOM/Three-free makes the hard generation rules cheap to test.
 */

const EPSILON = 1e-7;

export const TRACK_SIZE_PRESETS = Object.freeze({
  pocket: Object.freeze({
    id: 'pocket', label: 'Pocket', detail: 'Fast laps · tiny chaos',
    width: 88, depth: 62, minLength: 145, maxLength: 285, samples: 160, laps: 4,
  }),
  club: Object.freeze({
    id: 'club', label: 'Club', detail: 'Recommended all-rounder',
    width: 124, depth: 86, minLength: 190, maxLength: 410, samples: 224, laps: 3,
  }),
  grand: Object.freeze({
    id: 'grand', label: 'Grand', detail: 'Long straights · big fields',
    width: 170, depth: 116, minLength: 260, maxLength: 590, samples: 288, laps: 3,
  }),
  epic: Object.freeze({
    id: 'epic', label: 'Epic', detail: 'Endurance-scale spectacle',
    width: 224, depth: 150, minLength: 340, maxLength: 790, samples: 352, laps: 2,
  }),
});

export const TRACK_WIDTH_PRESETS = Object.freeze({
  narrow: Object.freeze({ id: 'narrow', label: 'Narrow', detail: 'Technical and difficult', width: 7.0, cars: 5 }),
  standard: Object.freeze({ id: 'standard', label: 'Standard', detail: 'Recommended', width: 9.2, cars: 7 }),
  wide: Object.freeze({ id: 'wide', label: 'Wide', detail: 'Arcade overtaking', width: 12.0, cars: 9 }),
  extra: Object.freeze({ id: 'extra', label: 'Extra Wide', detail: 'Maximum Kaki mayhem', width: 16.0, cars: 12 }),
});

export const DEFAULT_LAYOUT_TRANSFORM = Object.freeze({
  version: 1,
  occupancy: 0.82,
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
});

export function sanitizeLayoutTransform(input = {}) {
  return {
    version: 1,
    occupancy: clamp(Number(input.occupancy) || DEFAULT_LAYOUT_TRANSFORM.occupancy, 0.48, 1.04),
    scaleX: clamp(Number(input.scaleX) || 1, 0.52, 1.65),
    scaleY: clamp(Number(input.scaleY) || 1, 0.52, 1.65),
    offsetX: clamp(Number(input.offsetX) || 0, -0.32, 0.32),
    offsetY: clamp(Number(input.offsetY) || 0, -0.32, 0.32),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function copyPoint(point) {
  return { x: Number(point.x), y: Number(point.y) };
}

function distanceSq(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

function distance(a, b) {
  return Math.sqrt(distanceSq(a, b));
}

function circularDelta(a, b, count) {
  const direct = Math.abs(a - b);
  return Math.min(direct, count - direct);
}

function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    minX, minY, maxX, maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    centerX: (minX + maxX) * 0.5,
    centerY: (minY + maxY) * 0.5,
  };
}

function canonicalMapper(points, sizeId = 'club') {
  const size = TRACK_SIZE_PRESETS[sizeId] || TRACK_SIZE_PRESETS.club;
  const source = (points || []).filter(finitePoint);
  const bounds = source.length ? boundsOf(source) : {
    width: 1, height: 1, centerX: 0.5, centerY: 0.5,
  };
  // Match the old uniform world fit once, then retain this canonical basis.
  // Subsequent layout transforms therefore change actual metres instead of
  // being normalized away on the next validation pass.
  const metresPerInputUnit = Math.min(
    size.width / Math.max(0.04, bounds.width),
    size.depth / Math.max(0.04, bounds.height),
  );
  return (point) => ({
    x: 0.5 + (point.x - bounds.centerX) * metresPerInputUnit / size.width,
    y: 0.5 + (point.y - bounds.centerY) * metresPerInputUnit / size.depth,
  });
}

export function createCanonicalTrackLayout(rawPoints = [], controlPoints = [], sizeId = 'club') {
  const basis = controlPoints.length ? controlPoints : rawPoints;
  const map = canonicalMapper(basis, sizeId);
  return {
    rawPoints: (rawPoints || []).filter(finitePoint).map(map),
    controlPoints: (controlPoints.length ? controlPoints : rawPoints).filter(finitePoint).map(map),
    layoutTransform: { ...DEFAULT_LAYOUT_TRANSFORM },
  };
}

export function applyLayoutToPoint(point, input = DEFAULT_LAYOUT_TRANSFORM) {
  const layout = sanitizeLayoutTransform(input);
  return {
    x: 0.5 + (point.x - 0.5) * layout.occupancy * layout.scaleX + layout.offsetX,
    y: 0.5 + (point.y - 0.5) * layout.occupancy * layout.scaleY + layout.offsetY,
  };
}

export function invertLayoutPoint(point, input = DEFAULT_LAYOUT_TRANSFORM) {
  const layout = sanitizeLayoutTransform(input);
  return {
    x: 0.5 + (point.x - 0.5 - layout.offsetX) / Math.max(EPSILON, layout.occupancy * layout.scaleX),
    y: 0.5 + (point.y - 0.5 - layout.offsetY) / Math.max(EPSILON, layout.occupancy * layout.scaleY),
  };
}

export function dedupeStroke(points, minDistance = 0.0035) {
  const clean = [];
  const minSq = minDistance * minDistance;
  for (const candidate of points || []) {
    if (!finitePoint(candidate)) continue;
    const point = copyPoint(candidate);
    if (!clean.length || distanceSq(clean[clean.length - 1], point) >= minSq) clean.push(point);
  }
  if (clean.length > 2 && distanceSq(clean[0], clean[clean.length - 1]) < minSq) clean.pop();
  return clean;
}

function pointLineDistanceSq(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPSILON) return distanceSq(point, start);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq, 0, 1);
  const px = start.x + dx * t;
  const py = start.y + dy * t;
  const ox = point.x - px;
  const oy = point.y - py;
  return ox * ox + oy * oy;
}

function simplifyOpen(points, epsilon) {
  if (points.length <= 2) return points.map(copyPoint);
  const first = points[0];
  const last = points[points.length - 1];
  let furthest = -1;
  let maxDistanceSq = epsilon * epsilon;
  for (let index = 1; index < points.length - 1; index++) {
    const d2 = pointLineDistanceSq(points[index], first, last);
    if (d2 > maxDistanceSq) {
      furthest = index;
      maxDistanceSq = d2;
    }
  }
  if (furthest < 0) return [copyPoint(first), copyPoint(last)];
  const left = simplifyOpen(points.slice(0, furthest + 1), epsilon);
  const right = simplifyOpen(points.slice(furthest), epsilon);
  return [...left.slice(0, -1), ...right];
}

export function simplifyClosed(points, epsilon = 0.004) {
  if ((points?.length || 0) < 6) return (points || []).map(copyPoint);
  // Cut the ring at the point furthest from point zero so RDP never simplifies
  // across the closure seam and accidentally turns a loop into a chord.
  let split = 1;
  let furthest = 0;
  for (let i = 1; i < points.length; i++) {
    const d2 = distanceSq(points[0], points[i]);
    if (d2 > furthest) { furthest = d2; split = i; }
  }
  const firstArc = simplifyOpen(points.slice(0, split + 1), epsilon);
  const secondArc = simplifyOpen([...points.slice(split), points[0]], epsilon);
  const merged = [...firstArc.slice(0, -1), ...secondArc.slice(0, -1)];
  return merged.length >= 6 ? dedupeStroke(merged, epsilon * 0.35) : points.map(copyPoint);
}

function removeHooks(points) {
  let result = points.map(copyPoint);
  for (let pass = 0; pass < 3 && result.length > 8; pass++) {
    const keep = [];
    const count = result.length;
    for (let index = 0; index < count; index++) {
      const previous = result[(index - 1 + count) % count];
      const point = result[index];
      const next = result[(index + 1) % count];
      const a = distance(previous, point);
      const b = distance(point, next);
      const chord = distance(previous, next);
      const tinySpike = a + b > EPSILON && chord / (a + b) < 0.18 && Math.min(a, b) < 0.022;
      if (!tinySpike) keep.push(point);
    }
    if (keep.length === result.length || keep.length < 6) break;
    result = keep;
  }
  return result;
}

function cornerWeight(previous, point, next) {
  const ax = point.x - previous.x;
  const ay = point.y - previous.y;
  const bx = next.x - point.x;
  const by = next.y - point.y;
  const al = Math.hypot(ax, ay) || 1;
  const bl = Math.hypot(bx, by) || 1;
  const turn = Math.acos(clamp((ax * bx + ay * by) / (al * bl), -1, 1));
  // Preserve authored corners: a large change of heading receives less pull.
  return 1 - clamp((turn - 0.25) / 1.45, 0, 0.78);
}

export function smoothClosedStroke(points, strength = 0.55) {
  const safeStrength = clamp(Number(strength) || 0, 0, 1);
  let current = removeHooks(dedupeStroke(points));
  if (current.length < 6) return current;
  current = simplifyClosed(current, 0.002 + safeStrength * 0.0045);
  const passes = 1 + Math.round(safeStrength * 3);
  for (let pass = 0; pass < passes; pass++) {
    const next = [];
    for (let index = 0; index < current.length; index++) {
      const previous = current[(index - 1 + current.length) % current.length];
      const point = current[index];
      const following = current[(index + 1) % current.length];
      const pull = (0.09 + safeStrength * 0.16) * cornerWeight(previous, point, following);
      next.push({
        x: point.x * (1 - pull) + (previous.x + following.x) * 0.5 * pull,
        y: point.y * (1 - pull) + (previous.y + following.y) * 0.5 * pull,
      });
    }
    current = next;
  }
  return simplifyClosed(current, 0.0018 + safeStrength * 0.0025);
}

function catmullPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
      + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
      + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
      + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
      + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function arcResample(polyline, count) {
  if (polyline.length < 2 || count < 2) return polyline.map(copyPoint);
  const cumulative = new Float64Array(polyline.length + 1);
  let total = 0;
  for (let i = 1; i <= polyline.length; i++) {
    total += distance(polyline[i - 1], polyline[i % polyline.length]);
    cumulative[i] = total;
  }
  if (total < EPSILON) return Array.from({ length: count }, () => copyPoint(polyline[0]));
  const output = [];
  let segment = 0;
  for (let i = 0; i < count; i++) {
    const target = total * i / count;
    while (segment < polyline.length - 1 && cumulative[segment + 1] < target) segment++;
    const start = polyline[segment];
    const end = polyline[(segment + 1) % polyline.length];
    const span = Math.max(EPSILON, cumulative[segment + 1] - cumulative[segment]);
    const t = clamp((target - cumulative[segment]) / span, 0, 1);
    output.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
  }
  return output;
}

export function resampleClosedSpline(points, count = 224) {
  const controls = dedupeStroke(points, 0.0001);
  if (controls.length < 4) return arcResample(controls, Math.min(count, Math.max(2, controls.length)));
  const dense = [];
  const steps = clamp(Math.ceil(count / controls.length) + 4, 7, 18);
  for (let i = 0; i < controls.length; i++) {
    const p0 = controls[(i - 1 + controls.length) % controls.length];
    const p1 = controls[i];
    const p2 = controls[(i + 1) % controls.length];
    const p3 = controls[(i + 2) % controls.length];
    for (let step = 0; step < steps; step++) dense.push(catmullPoint(p0, p1, p2, p3, step / steps));
  }
  return arcResample(dense, count);
}

function rotatePoints(points, fraction = 0, reverse = false, mirror = false) {
  let result = points.map((point) => ({ x: mirror ? 1 - point.x : point.x, y: point.y }));
  if (reverse) result.reverse();
  if (!result.length) return result;
  const offset = ((Math.round(clamp(fraction, 0, 0.999999) * result.length) % result.length) + result.length) % result.length;
  if (offset) result = [...result.slice(offset), ...result.slice(0, offset)];
  return result;
}

export function fitTrackToWorld(points, sizeId = 'club', options = {}) {
  const preset = TRACK_SIZE_PRESETS[sizeId] || TRACK_SIZE_PRESETS.club;
  const rotated = rotatePoints(points, options.startFraction, options.reverse, options.mirror);
  if (!rotated.length) return { points: [], normalized: [], scale: 1, bounds: null };
  if (options.layoutTransform) {
    const layout = sanitizeLayoutTransform(options.layoutTransform);
    const normalized = rotated.map((point) => applyLayoutToPoint(point, layout));
    const world = normalized.map((point) => ({
      x: (point.x - 0.5) * preset.width,
      y: (0.5 - point.y) * preset.depth,
    }));
    return {
      points: world,
      normalized,
      scale: layout.occupancy,
      bounds: boundsOf(normalized),
      layoutTransform: layout,
    };
  }
  // Legacy callers and KDT1 data retain the original fit-on-every-pass path.
  // New editor drafts are canonicalized once and always supply layoutTransform.
  const bounds = boundsOf(rotated);
  const usableWidth = preset.width * 0.82;
  const usableDepth = preset.depth * 0.82;
  const scale = Math.min(
    usableWidth / Math.max(0.04, bounds.width),
    usableDepth / Math.max(0.04, bounds.height),
  );
  const world = rotated.map((point) => ({
    x: (point.x - bounds.centerX) * scale,
    y: (bounds.centerY - point.y) * scale,
  }));
  return { points: world, normalized: rotated, scale, bounds };
}

function segmentIntersection(a, b, c, d) {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const denominator = rX * sY - rY * sX;
  if (Math.abs(denominator) < EPSILON) return null;
  const qX = c.x - a.x;
  const qY = c.y - a.y;
  const t = (qX * sY - qY * sX) / denominator;
  const u = (qX * rY - qY * rX) / denominator;
  if (t <= 0.002 || t >= 0.998 || u <= 0.002 || u >= 0.998) return null;
  return { t, u, x: a.x + rX * t, y: a.y + rY * t };
}

function segmentDistance(a, b, c, d) {
  if (segmentIntersection(a, b, c, d)) return 0;
  return Math.sqrt(Math.min(
    pointLineDistanceSq(a, c, d),
    pointLineDistanceSq(b, c, d),
    pointLineDistanceSq(c, a, b),
    pointLineDistanceSq(d, a, b),
  ));
}

function crossingAngle(a, b, c, d) {
  const ax = b.x - a.x;
  const ay = b.y - a.y;
  const bx = d.x - c.x;
  const by = d.y - c.y;
  const al = Math.hypot(ax, ay) || 1;
  const bl = Math.hypot(bx, by) || 1;
  const dot = Math.abs((ax * bx + ay * by) / (al * bl));
  return Math.acos(clamp(dot, -1, 1));
}

function localTurn(samples, index, radius = 5) {
  let sum = 0;
  const count = samples.length;
  for (let offset = -radius; offset <= radius; offset++) {
    const at = (index + offset + count) % count;
    const previous = samples[(at - 1 + count) % count];
    const point = samples[at];
    const next = samples[(at + 1) % count];
    const ax = point.x - previous.x;
    const ay = point.y - previous.y;
    const bx = next.x - point.x;
    const by = next.y - point.y;
    const al = Math.hypot(ax, ay) || 1;
    const bl = Math.hypot(bx, by) || 1;
    sum += Math.acos(clamp((ax * bx + ay * by) / (al * bl), -1, 1));
  }
  return sum;
}

function detectCrossings(samples, trackWidth, length, allowOverpasses) {
  const intersections = [];
  const count = samples.length;
  const meanStep = length / Math.max(1, count);
  const bridgeHeight = 4.7 + trackWidth * 0.12;
  // Cosine ramps peak at height*pi/(2*approach). Size the approach for a
  // browser-physics-safe ~19% maximum grade, including extra-wide roads.
  const approachLength = Math.max(32, bridgeHeight * Math.PI / (2 * 0.19), trackWidth * 2.8);
  const approachSamples = Math.ceil(approachLength / Math.max(0.1, meanStep));
  for (let i = 0; i < count; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % count];
    for (let j = i + 4; j < count; j++) {
      if (circularDelta(i, j, count) <= 3) continue;
      const c = samples[j];
      const d = samples[(j + 1) % count];
      const hit = segmentIntersection(a, b, c, d);
      if (!hit) continue;
      const angle = crossingAngle(a, b, c, d);
      const separation = circularDelta(i, j, count);
      const enoughApproach = separation > approachSamples * 2.25
        && (count - separation) > approachSamples * 2.25;
      const farFromGridI = circularDelta(i, 0, count) > approachSamples * 1.15;
      const farFromGridJ = circularDelta(j, 0, count) > approachSamples * 1.15;
      const bridgeable = !!allowOverpasses && angle >= 0.52 && enoughApproach
        && (farFromGridI || farFromGridJ) && intersections.length < 3;
      let overIndex = null;
      if (bridgeable) {
        const iTurn = localTurn(samples, i);
        const jTurn = localTurn(samples, j);
        if (!farFromGridI) overIndex = j;
        else if (!farFromGridJ) overIndex = i;
        else overIndex = iTurn <= jTurn ? i : j;
      }
      const underIndex = overIndex == null ? null : (overIndex === i ? j : i);
      const overHit = overIndex === i ? hit.t : hit.u;
      const underHit = underIndex === i ? hit.t : hit.u;
      intersections.push({
        id: `crossing-${i}-${j}`,
        segmentA: i,
        segmentB: j,
        overIndex,
        underIndex,
        point: { x: hit.x, y: hit.y },
        angle,
        bridgeable,
        height: bridgeHeight,
        approachLength,
        fraction: overIndex == null ? null : ((overIndex + overHit) / count) % 1,
        underFraction: underIndex == null ? null : ((underIndex + underHit) / count) % 1,
      });
    }
  }
  return intersections;
}

function trackMetrics(samples, trackWidth) {
  const count = samples.length;
  let length = 0;
  let curvatureSum = 0;
  let maximumCurvature = 0;
  let tightestRadius = Infinity;
  let straightRun = 0;
  let longestStraight = 0;
  let bestStraightCenter = 0;
  let cornerCount = 0;
  let inCorner = false;
  const radii = new Float64Array(count);
  const turns = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const previous = samples[(i - 1 + count) % count];
    const point = samples[i];
    const next = samples[(i + 1) % count];
    const aLength = distance(previous, point);
    const bLength = distance(point, next);
    length += bLength;
    const ax = (point.x - previous.x) / Math.max(EPSILON, aLength);
    const ay = (point.y - previous.y) / Math.max(EPSILON, aLength);
    const bx = (next.x - point.x) / Math.max(EPSILON, bLength);
    const by = (next.y - point.y) / Math.max(EPSILON, bLength);
    const angle = Math.acos(clamp(ax * bx + ay * by, -1, 1));
    const radius = angle < 0.0005 ? 9999 : ((aLength + bLength) * 0.5) / (2 * Math.sin(angle * 0.5));
    turns[i] = angle;
    radii[i] = radius;
    curvatureSum += 1 / Math.max(0.1, radius);
    maximumCurvature = Math.max(maximumCurvature, 1 / Math.max(0.1, radius));
    tightestRadius = Math.min(tightestRadius, radius);
    const corner = angle > 0.022;
    if (corner && !inCorner) cornerCount++;
    inCorner = corner;
    if (angle < 0.012) {
      straightRun += bLength;
      if (straightRun > longestStraight) {
        longestStraight = straightRun;
        bestStraightCenter = (i - Math.round(straightRun / Math.max(0.1, bLength) * 0.5) + count) % count;
      }
    } else {
      straightRun = 0;
    }
  }
  const averageCurvature = curvatureSum / Math.max(1, count);
  const turnPenalty = clamp(averageCurvature * 48 + maximumCurvature * 7, 0, 0.42);
  const averageSpeed = 20.5 * (1 - turnPenalty) * clamp(trackWidth / 9.2, 0.86, 1.1);
  const estimatedLapTime = length / Math.max(8, averageSpeed);
  const topSpeedPotential = clamp(38 + longestStraight / Math.max(1, length) * 230 - maximumCurvature * 60, 5, 100);
  const overtakingPotential = clamp(trackWidth / 16 * 62 + longestStraight / Math.max(1, length) * 120, 8, 100);
  const difficultyScore = clamp(
    1 + maximumCurvature * 13 + averageCurvature * 34 + (9.2 / trackWidth - 0.65) * 1.1,
    1, 5,
  );
  const difficulty = difficultyScore >= 4.35 ? 'Wild'
    : difficultyScore >= 3.5 ? 'Hard'
      : difficultyScore >= 2.65 ? 'Technical'
        : difficultyScore >= 1.8 ? 'Lively' : 'Friendly';
  let personality = 'High-Speed Circuit';
  if (length < 190) personality = 'Tiny Chaos Loop';
  else if (trackWidth >= 14) personality = 'Overtake Festival';
  else if (maximumCurvature > 0.2) personality = 'Hairpin Hell';
  else if (averageCurvature > 0.055) personality = 'Technical Twister';
  else if (longestStraight / length > 0.26) personality = 'Kaki Nürburgring';
  else if (difficultyScore > 4.2) personality = 'Absolute Nonsense';
  return {
    length,
    estimatedLapTime,
    cornerCount: Math.max(2, cornerCount),
    tightestRadius,
    longestStraight,
    averageCurvature,
    maximumCurvature,
    overtakingPotential,
    topSpeedPotential,
    difficultyScore,
    difficulty,
    personality,
    startSample: bestStraightCenter,
    radii,
    turns,
  };
}

export function minimumTrackRadii(trackWidth = TRACK_WIDTH_PRESETS.standard.width) {
  const halfRoad = Math.max(0, Number(trackWidth) || TRACK_WIDTH_PRESETS.standard.width) * 0.5;
  const meshInnerEdge = halfRoad + 0.62;
  const vehicleDriveability = 4.75;
  return {
    meshInnerEdge,
    vehicleDriveability,
    artisticSmoothing: 0,
    required: Math.max(meshInnerEdge, vehicleDriveability),
  };
}

function curvatureLimitedSamples(samples, minimumRadius, passes = 180) {
  let output = samples.map(copyPoint);
  if (output.length < 8) return { samples: output, changed: false, originalTightest: Infinity };
  const initial = trackMetrics(output, TRACK_WIDTH_PRESETS.standard.width);
  const originalTightest = initial.tightestRadius;
  let changed = false;
  for (let pass = 0; pass < passes; pass++) {
    const metrics = trackMetrics(output, TRACK_WIDTH_PRESETS.standard.width);
    if (metrics.tightestRadius >= minimumRadius * 0.985) break;
    const next = output.map(copyPoint);
    let passChanged = false;
    for (let index = 0; index < output.length; index++) {
      const radius = metrics.radii[index];
      if (!(radius < minimumRadius * 1.08)) continue;
      const previous = output[(index - 1 + output.length) % output.length];
      const point = output[index];
      const following = output[(index + 1) % output.length];
      const deficit = clamp((minimumRadius * 1.08 - radius) / minimumRadius, 0, 1);
      const pull = 0.14 + deficit * 0.4;
      next[index] = {
        x: point.x * (1 - pull) + (previous.x + following.x) * 0.5 * pull,
        y: point.y * (1 - pull) + (previous.y + following.y) * 0.5 * pull,
      };
      passChanged = true;
    }
    if (!passChanged) break;
    changed = true;
    // Curvature flow bunches samples around the edge of a repaired corner.
    // Re-establish equal arc spacing each pass so a tiny leftover segment
    // cannot masquerade as a new impossible corner beside the fillet.
    output = arcResample(next, next.length);
  }
  return { samples: output, changed, originalTightest };
}

function worldSamplesToNormalized(samples, size) {
  return samples.map((point) => ({
    x: 0.5 + point.x / size.width,
    y: 0.5 - point.y / size.depth,
  }));
}

function chooseSafeStartSample(stats, crossings) {
  if (!stats || !crossings.length) return stats?.startSample || 0;
  const count = stats.turns.length;
  const meanStep = stats.length / Math.max(1, count);
  const gridSamples = Math.max(6, Math.ceil(24 / Math.max(0.1, meanStep)));
  let bestIndex = stats.startSample || 0;
  let bestScore = Infinity;
  for (let i = 0; i < count; i++) {
    const nearCrossing = crossings.some((crossing) => {
      const reserve = Math.ceil((crossing.approachLength + 18) / Math.max(0.1, meanStep));
      return Math.min(
        circularDelta(i, crossing.segmentA, count),
        circularDelta(i, crossing.segmentB, count),
      ) < reserve;
    });
    if (nearCrossing) continue;
    let turnScore = 0;
    for (let offset = -Math.ceil(gridSamples * 0.35); offset <= gridSamples; offset++) {
      const at = (i + offset + count) % count;
      turnScore += stats.turns[at] * (offset < 0 ? 0.55 : 1);
    }
    // Prefer the center of the already-detected longest straight when scores tie.
    const straightBias = circularDelta(i, stats.startSample || 0, count) / Math.max(1, count) * 0.0001;
    const score = turnScore + straightBias;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function issueAt(id, severity, message, sampleIndex, samples, normalizedSamples, extra = {}) {
  const safeIndex = ((sampleIndex || 0) % Math.max(1, samples.length) + samples.length) % Math.max(1, samples.length);
  return {
    id,
    severity,
    message,
    sampleIndex: safeIndex,
    point: samples[safeIndex] ? copyPoint(samples[safeIndex]) : null,
    normalizedPoint: normalizedSamples[safeIndex] ? copyPoint(normalizedSamples[safeIndex]) : null,
    repairable: severity === 'error',
    ...extra,
  };
}

function compactClearanceIssues(samples, normalizedSamples, trackWidth, crossings) {
  const issues = [];
  const count = samples.length;
  const threshold = trackWidth * 1.04;
  let totalLength = 0;
  for (let i = 0; i < count; i++) totalLength += distance(samples[i], samples[(i + 1) % count]);
  const meanStep = totalLength / Math.max(1, count);
  const minimumGap = Math.max(10, Math.ceil(trackWidth * 2.35 / Math.max(0.1, meanStep)));
  const stride = count > 260 ? 3 : 2;
  const nearCrossing = (i, j) => crossings.some((crossing) => {
    const window = Math.max(stride * 2, Math.ceil((crossing.approachLength || trackWidth * 2) / Math.max(0.1, meanStep) * 1.08));
    return (
      circularDelta(i, crossing.segmentA, count) <= window
        && circularDelta(j, crossing.segmentB, count) <= window
    ) || (
      circularDelta(i, crossing.segmentB, count) <= window
        && circularDelta(j, crossing.segmentA, count) <= window
    );
  });
  let lastIssue = -99;
  for (let i = 0; i < count; i += stride) {
    const a = samples[i];
    const b = samples[(i + stride) % count];
    for (let j = i + minimumGap; j < count; j += stride) {
      if (circularDelta(i, j, count) < minimumGap) continue;
      if (nearCrossing(i, j)) continue;
      const c = samples[j];
      const d = samples[(j + stride) % count];
      if (segmentDistance(a, b, c, d) >= threshold) continue;
      if (i - lastIssue < Math.ceil(count * 0.06)) continue;
      issues.push(issueAt(
        `clearance-${i}-${j}`,
        'error',
        'Not enough room between these road sections',
        i,
        samples,
        normalizedSamples,
        { otherSampleIndex: j },
      ));
      lastIssue = i;
      if (issues.length >= 4) return issues;
    }
  }
  return issues;
}

export class TrackSpline {
  static clean(points, smoothing = 0.55) {
    return smoothClosedStroke(points, smoothing);
  }

  static sample(points, count) {
    return resampleClosedSpline(points, count);
  }

  static toWorld(points, sizeId, options) {
    return fitTrackToWorld(points, sizeId, options);
  }
}

export class TrackValidator {
  static validate({
    rawPoints = [],
    controlPoints = [],
    closed = false,
    sizeId = 'club',
    widthId = 'standard',
    startFraction = 0,
    reverse = false,
    mirror = false,
    allowOverpasses = true,
    layoutTransform = null,
  } = {}) {
    const size = TRACK_SIZE_PRESETS[sizeId] || TRACK_SIZE_PRESETS.club;
    const width = TRACK_WIDTH_PRESETS[widthId] || TRACK_WIDTH_PRESETS.standard;
    const source = controlPoints.length ? controlPoints : rawPoints;
    const fitted = fitTrackToWorld(source, size.id, {
      startFraction: 0, reverse, mirror, layoutTransform,
    });
    const initialSamples = resampleClosedSpline(fitted.points, size.samples);
    const initialStats = initialSamples.length >= 4 ? trackMetrics(initialSamples, width.width) : null;
    const dynamicCount = initialStats
      ? clamp(Math.ceil(initialStats.length / 1.28), size.samples, 512)
      : size.samples;
    const authoredSamples = dynamicCount === initialSamples.length
      ? initialSamples
      : resampleClosedSpline(fitted.points, dynamicCount);
    const radii = minimumTrackRadii(width.width);
    const limited = curvatureLimitedSamples(authoredSamples, radii.required);
    let samples = limited.samples;
    if (samples.length) {
      const startOffset = Math.round((((startFraction % 1) + 1) % 1) * samples.length) % samples.length;
      if (startOffset) samples = [...samples.slice(startOffset), ...samples.slice(0, startOffset)];
    }
    const normalizedSamples = layoutTransform
      ? worldSamplesToNormalized(samples, size)
      : resampleClosedSpline(fitted.normalized, samples.length);
    const stats = samples.length >= 4 ? trackMetrics(samples, width.width) : null;
    const crossings = stats ? detectCrossings(samples, width.width, stats.length, allowOverpasses) : [];
    const issues = [];
    const rawBounds = rawPoints.filter(finitePoint).length ? boundsOf(rawPoints.filter(finitePoint)) : null;

    if (!closed) {
      issues.push(issueAt('open-loop', 'error', 'Bring the line back to the starting point', 0, samples, normalizedSamples));
    }
    // Six well-spaced spline controls are sufficient for a closed course.
    // Repairs and compact track codes intentionally discard redundant raw
    // samples, so raw input density must not become a permanent invalid state.
    if (source.length < 6) {
      issues.push(issueAt('too-few-points', 'error', 'Keep drawing — the circuit is too small', 0, samples, normalizedSamples));
    }
    if (rawBounds && Math.max(rawBounds.width, rawBounds.height) < 0.13) {
      issues.push(issueAt('tiny-drawing', 'error', 'Use more of the drafting table', 0, samples, normalizedSamples));
    }
    if (rawPoints.length > 2200) {
      issues.push(issueAt('dense-stroke', 'warning', 'Dense stroke simplified for a smoother road', 0, samples, normalizedSamples));
    }
    if (!samples.length || samples.some((point) => !finitePoint(point))) {
      issues.push(issueAt('invalid-geometry', 'error', 'The road contains invalid geometry', 0, samples, normalizedSamples));
    }
    if (stats) {
      if (stats.length < size.minLength) {
        issues.push(issueAt('too-short', 'error', `Track is ${Math.round(size.minLength - stats.length)} m too short`, 0, samples, normalizedSamples));
      }
      if (stats.length > size.maxLength) {
        const over = Math.round(stats.length - size.maxLength);
        issues.push(issueAt(
          stats.length > size.maxLength * 1.28 ? 'extreme-length' : 'too-long',
          stats.length > size.maxLength * 1.28 ? 'error' : 'warning',
          stats.length > size.maxLength * 1.28
            ? `${over} m over · shorten automatically`
            : `${over} m over the recommended lap length · racing is still allowed`,
          0,
          samples,
          normalizedSamples,
          { over, recommendedMaximum: size.maxLength },
        ));
      } else if (stats.length > size.maxLength * 0.88) {
        issues.push(issueAt(
          'length-near-limit',
          'warning',
          `${Math.round(size.maxLength - stats.length)} m before the recommended limit`,
          0,
          samples,
          normalizedSamples,
        ));
      }
      let tightIndex = -1;
      let tightest = Infinity;
      for (let i = 0; i < stats.radii.length; i++) {
        if (stats.radii[i] < tightest) { tightest = stats.radii[i]; tightIndex = i; }
      }
      if (tightest < radii.required * 0.94) {
        issues.push(issueAt(
          'tight-corner',
          'error',
          `This corner needs a ${radii.required.toFixed(1)} m racing arc`,
          tightIndex,
          samples,
          normalizedSamples,
          { radius: tightest, minimumRadius: radii.required, radii },
        ));
      } else if (limited.changed && limited.originalTightest < radii.required * 0.98) {
        issues.push(issueAt(
          'corner-rounded',
          'info',
          `Sharp corner rounded into a ${tightest.toFixed(1)} m racing arc`,
          tightIndex,
          samples,
          normalizedSamples,
          { radius: tightest, authoredRadius: limited.originalTightest, minimumRadius: radii.required, radii },
        ));
      }
      const worldBounds = boundsOf(samples);
      if (worldBounds.width > size.width * 1.02 || worldBounds.height > size.depth * 1.02) {
        const outsideIndex = samples.reduce((best, point, index) => (
          Math.max(Math.abs(point.x) / size.width, Math.abs(point.y) / size.depth)
            > Math.max(Math.abs(samples[best].x) / size.width, Math.abs(samples[best].y) / size.depth) ? index : best
        ), 0);
        issues.push(issueAt(
          'layout-bounds',
          'error',
          'Part of the track is outside the build area · move or shrink it',
          outsideIndex,
          samples,
          normalizedSamples,
        ));
      }
      const gridWindow = Math.max(6, Math.ceil(18 / Math.max(0.1, stats.length / samples.length)));
      const gridTurn = Array.from(stats.turns.slice(0, gridWindow)).reduce((sum, value) => sum + value, 0);
      if (gridTurn > 1.15) {
        issues.push(issueAt('grid-clearance', 'error', 'Move the start line to a straighter section', 0, samples, normalizedSamples));
      }
      const meanStep = stats.length / Math.max(1, samples.length);
      const gridCrossing = crossings.find((crossing) => {
        const reserve = Math.ceil((crossing.approachLength + 18) / Math.max(0.1, meanStep));
        return Math.min(
          circularDelta(0, crossing.segmentA, samples.length),
          circularDelta(0, crossing.segmentB, samples.length),
        ) < reserve;
      });
      if (gridCrossing) {
        issues.push(issueAt('grid-crossing', 'error', 'Move the start line clear of the overpass approaches', 0, samples, normalizedSamples));
      }
    }

    for (const crossing of crossings) {
      if (crossing.bridgeable) {
        issues.push(issueAt(
          `overpass-${crossing.segmentA}-${crossing.segmentB}`,
          'info',
          'Crossing will become a guarded overpass',
          crossing.overIndex,
          samples,
          normalizedSamples,
          { crossing },
        ));
      } else {
        issues.push(issueAt(
          `intersection-${crossing.segmentA}-${crossing.segmentB}`,
          'error',
          crossing.angle < 0.52 ? 'Track overlaps here at an unsafe angle' : 'Crossing needs longer, gentler bridge approaches',
          crossing.segmentA,
          samples,
          normalizedSamples,
          { crossing },
        ));
      }
    }
    if (stats && issues.filter((issue) => issue.id.startsWith('intersection-')).length === 0) {
      issues.push(...compactClearanceIssues(samples, normalizedSamples, width.width, crossings));
    }

    const errors = issues.filter((issue) => issue.severity === 'error');
    const overpasses = crossings.filter((crossing) => crossing.bridgeable);
    const safeStartSample = stats ? chooseSafeStartSample(stats, crossings) : 0;
    if (stats) stats.startSample = safeStartSample;
    const suggestedStartFraction = stats
      ? ((startFraction + safeStartSample / Math.max(1, samples.length)) % 1 + 1) % 1
      : 0;
    return {
      valid: errors.length === 0,
      errors,
      issues,
      overpasses,
      samples,
      normalizedSamples,
      // The generated, curvature-limited racing line is the runtime source.
      // authoredControlPoints remains available for the editor's faint intent
      // overlay and for localized repairs.
      controlPoints: samples,
      racingControlPoints: samples,
      normalizedControlPoints: normalizedSamples,
      authoredControlPoints: fitted.points,
      authoredNormalizedControlPoints: fitted.normalized,
      stats,
      size,
      width,
      radii,
      sampleCount: samples.length,
      layoutTransform: layoutTransform ? sanitizeLayoutTransform(layoutTransform) : null,
      suggestedStartFraction,
    };
  }
}

function controlIntersections(points) {
  const hits = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 3; j < points.length; j++) {
      if (circularDelta(i, j, points.length) <= 2) continue;
      const hit = segmentIntersection(a, b, points[j], points[(j + 1) % points.length]);
      if (hit) hits.push({ i, j, hit });
    }
  }
  return hits;
}

function removeTinyLoops(points) {
  let result = points.map(copyPoint);
  for (let pass = 0; pass < 3; pass++) {
    const hit = controlIntersections(result).find(({ i, j }) => {
      const gap = circularDelta(i, j, result.length);
      return gap < result.length * 0.24;
    });
    if (!hit) break;
    const { i, j } = hit;
    if (j > i) {
      result = [
        ...result.slice(0, i + 1),
        { x: hit.hit.x, y: hit.hit.y },
        ...result.slice(j + 1),
      ];
    }
    if (result.length < 6) return points.map(copyPoint);
  }
  return result;
}

function separateClosePoints(points, trackWidth, size) {
  const result = points.map(copyPoint);
  const normalizedClearance = trackWidth / Math.max(size.width, size.depth) * 0.82;
  for (let pass = 0; pass < 3; pass++) {
    const pushes = result.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 4; j < result.length; j++) {
        if (circularDelta(i, j, result.length) <= 3) continue;
        let dx = result[i].x - result[j].x;
        let dy = result[i].y - result[j].y;
        let d = Math.hypot(dx, dy);
        if (d >= normalizedClearance) continue;
        if (d < 0.0001) { dx = result[i].x - 0.5 || 1; dy = result[i].y - 0.5; d = Math.hypot(dx, dy) || 1; }
        const force = (normalizedClearance - d) * 0.12;
        dx /= d; dy /= d;
        pushes[i].x += dx * force; pushes[i].y += dy * force;
        pushes[j].x -= dx * force; pushes[j].y -= dy * force;
      }
    }
    for (let i = 0; i < result.length; i++) {
      result[i].x = clamp(result[i].x + pushes[i].x, 0.025, 0.975);
      result[i].y = clamp(result[i].y + pushes[i].y, 0.025, 0.975);
    }
  }
  return result;
}

function relaxClosed(points, passes = 4, pull = 0.28) {
  let result = points.map(copyPoint);
  for (let pass = 0; pass < passes; pass++) {
    result = result.map((point, index) => {
      const previous = result[(index - 1 + result.length) % result.length];
      const next = result[(index + 1) % result.length];
      return {
        x: point.x * (1 - pull) + (previous.x + next.x) * 0.5 * pull,
        y: point.y * (1 - pull) + (previous.y + next.y) * 0.5 * pull,
      };
    });
  }
  return result;
}

function relaxLocalCorner(points, center, passes = 8) {
  if (!finitePoint(center) || points.length < 8) return points.map(copyPoint);
  let nearest = 0;
  let best = Infinity;
  for (let index = 0; index < points.length; index++) {
    const d2 = distanceSq(points[index], center);
    if (d2 < best) { best = d2; nearest = index; }
  }
  const radius = clamp(Math.round(points.length * 0.075), 3, 14);
  let result = points.map(copyPoint);
  for (let pass = 0; pass < passes; pass++) {
    const previousPass = result;
    result = previousPass.map((point, index) => {
      const ringDistance = circularDelta(index, nearest, previousPass.length);
      if (ringDistance > radius) return copyPoint(point);
      const weight = 0.36 * (0.5 + 0.5 * Math.cos(Math.PI * ringDistance / (radius + 1)));
      const previous = previousPass[(index - 1 + previousPass.length) % previousPass.length];
      const next = previousPass[(index + 1) % previousPass.length];
      return {
        x: point.x * (1 - weight) + (previous.x + next.x) * 0.5 * weight,
        y: point.y * (1 - weight) + (previous.y + next.y) * 0.5 * weight,
      };
    });
  }
  return result;
}

export class TrackRepair {
  static propose(points, { smoothing = 0.65, sizeId = 'club', widthId = 'standard' } = {}) {
    return TrackRepair.proposeDetailed(points, { smoothing, sizeId, widthId }).points;
  }

  static proposeDetailed(points, {
    smoothing = 0.65,
    sizeId = 'club',
    widthId = 'standard',
    layoutTransform = DEFAULT_LAYOUT_TRANSFORM,
    validation = null,
  } = {}) {
    const size = TRACK_SIZE_PRESETS[sizeId] || TRACK_SIZE_PRESETS.club;
    const width = TRACK_WIDTH_PRESETS[widthId] || TRACK_WIDTH_PRESETS.standard;
    const actions = [];
    let repaired = dedupeStroke(points, 0.0045);
    const beforeCount = repaired.length;
    repaired = removeHooks(repaired);
    repaired = removeTinyLoops(repaired);
    repaired = separateClosePoints(repaired, width.width, size);
    repaired = smoothClosedStroke(repaired, clamp(smoothing + 0.08, 0, 1));
    if (repaired.length < beforeCount) actions.push('Removed hand jitter and redundant points');

    const cornerIssue = validation?.issues?.find((issue) => issue.id === 'tight-corner' || issue.id === 'corner-rounded');
    if (cornerIssue?.normalizedPoint) {
      const canonical = invertLayoutPoint(cornerIssue.normalizedPoint, layoutTransform);
      repaired = relaxLocalCorner(repaired, canonical, width.id === 'extra' ? 11 : 8);
      actions.push('Rounded only the tightest corner');
    } else if (!validation) {
      // Legacy repair calls have no issue location; retain the proven broad
      // fallback used by old saved cat-shaped circuits.
      repaired = relaxClosed(repaired, width.id === 'extra' ? 5 : 3, 0.24);
    }

    const nextLayout = sanitizeLayoutTransform(layoutTransform);
    const length = validation?.stats?.length || 0;
    if (length > size.maxLength) {
      const factor = clamp(size.maxLength * 0.97 / length, 0.72, 0.98);
      nextLayout.occupancy = clamp(nextLayout.occupancy * factor, 0.48, 1.04);
      actions.push(`Shortened the layout by ${Math.round((1 - factor) * 100)}%`);
    } else if (length > 0 && length < size.minLength) {
      const factor = clamp(size.minLength * 1.03 / length, 1.02, 1.18);
      nextLayout.occupancy = clamp(nextLayout.occupancy * factor, 0.48, 1.04);
      actions.push(`Expanded the layout by ${Math.round((factor - 1) * 100)}%`);
    }
    if (validation?.errors?.some((issue) => issue.id === 'layout-bounds')) {
      const samples = validation.samples || [];
      if (samples.length) {
        const sampleBounds = boundsOf(samples);
        const fit = Math.min(
          size.width * 0.96 / Math.max(1, sampleBounds.width),
          size.depth * 0.96 / Math.max(1, sampleBounds.height),
          1,
        );
        nextLayout.occupancy = clamp(nextLayout.occupancy * fit, 0.48, 1.04);
      }
      nextLayout.offsetX *= 0.18;
      nextLayout.offsetY *= 0.18;
      if (!(length > size.maxLength)) nextLayout.occupancy = clamp(nextLayout.occupancy * 0.92, 0.48, 1.04);
      actions.push('Moved the circuit back inside the build area');
    }
    if (!actions.length) actions.push('Relaxed the roughest local sections');
    return { points: repaired, layoutTransform: nextLayout, actions };
  }
}

export class StrokeSampler {
  constructor({ minDistance = 0.004 } = {}) {
    this.minDistance = minDistance;
    this.points = [];
  }

  reset(points = []) {
    this.points = dedupeStroke(points, this.minDistance);
    return this.points;
  }

  push(point) {
    if (!finitePoint(point)) return false;
    const candidate = copyPoint(point);
    const previous = this.points[this.points.length - 1];
    if (previous && distanceSq(previous, candidate) < this.minDistance * this.minDistance) return false;
    this.points.push(candidate);
    return true;
  }
}

export function analyzeTrack(samples, trackWidth = TRACK_WIDTH_PRESETS.standard.width) {
  return trackMetrics(samples || [], trackWidth);
}

export function nearestSplineFraction(samples, point) {
  if (!samples?.length || !finitePoint(point)) return 0;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d2 = distanceSq(samples[i], point);
    if (d2 < bestDistance) { bestDistance = d2; best = i; }
  }
  return best / samples.length;
}
