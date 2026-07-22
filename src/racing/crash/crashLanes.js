import { CRASH_DEFAULT_SEED, CRASH_TRAFFIC_PROFILES } from './crashConfig.js';
import { PAWPRINT_INTERCHANGE } from './scenarios/pawprintInterchange.js';

export function createSeededRandom(seed = CRASH_DEFAULT_SEED) {
  let value = (Number(seed) || CRASH_DEFAULT_SEED) >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASS_WEIGHTS = Object.freeze([
  ['hatchback', 16], ['sedan', 27], ['wagon', 12], ['pickup', 11], ['suv', 12],
  ['van', 10], ['boxTruck', 5], ['bus', 3.5], ['semi', 2.2], ['tanker', 1.3],
]);

function weightedPick(random, entries) {
  const total = entries.reduce((sum, entry) => sum + entry[1], 0);
  let cursor = random() * total;
  for (const [value, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  return entries.at(-1)[0];
}

function laneLength(lane) {
  let length = 0;
  for (let i = 1; i < lane.points.length; i++) {
    length += Math.hypot(lane.points[i].x - lane.points[i - 1].x, lane.points[i].z - lane.points[i - 1].z);
  }
  return length;
}

export function sampleCrashLane(lane, progress) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  const total = laneLength(lane);
  let target = total * t;
  for (let i = 1; i < lane.points.length; i++) {
    const a = lane.points[i - 1];
    const b = lane.points[i];
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (target <= segment || i === lane.points.length - 1) {
      const local = segment > 0 ? Math.max(0, Math.min(1, target / segment)) : 0;
      // `target` is a distance along the polyline, so interpolation must stay
      // linear inside each segment. Smoothstep here made body position lag its
      // progress by tens of metres and broke signal, promotion, and TTI truth.
      const x = a.x + (b.x - a.x) * local;
      const z = a.z + (b.z - a.z) * local;
      return { x, z, yaw: Math.atan2(b.x - a.x, b.z - a.z), segment: i - 1, laneLength: total };
    }
    target -= segment;
  }
  const end = lane.points.at(-1);
  return { x: end.x, z: end.z, yaw: 0, segment: lane.points.length - 2, laneLength: total };
}

export function buildCrashTrafficSchedule(seed = CRASH_DEFAULT_SEED, density = 1, scenario = PAWPRINT_INTERCHANGE) {
  const random = createSeededRandom(seed);
  const count = Math.max(24, Math.round(48 * Math.max(0.5, Math.min(1.2, Number(density) || 1))));
  const lanes = scenario.lanes;
  // Keep the authored player approach clear until it reaches the junction.
  // The late scripted freight arrival still uses this lane after the player
  // has had time to enter the incident.
  const randomLanes = lanes.filter((entry) => entry.id !== scenario.playerLaneId);
  const schedule = [];
  const nextByApproach = new Map();
  for (let index = 0; index < count; index++) {
    const laneWeights = (randomLanes.length ? randomLanes : lanes).map((entry) => [entry, entry.weight || 1]);
    const selectedLane = weightedPick(random, laneWeights);
    const approachTime = nextByApproach.get(selectedLane.approach) ?? (-9.2 + random() * 1.5);
    const gap = 1.15 + random() * 1.25;
    nextByApproach.set(selectedLane.approach, approachTime + gap);
    const classId = weightedPick(random, CLASS_WEIGHTS);
    const profile = CRASH_TRAFFIC_PROFILES[classId];
    schedule.push(Object.freeze({
      id: `traffic-${String(index + 1).padStart(2, '0')}`,
      time: Number(approachTime.toFixed(3)),
      laneId: selectedLane.id,
      classId,
      desiredSpeed: Number((selectedLane.desiredSpeed * (0.88 + random() * 0.19) * (profile.mass > 5000 ? 0.86 : 1)).toFixed(3)),
      colorIndex: Math.floor(random() * 12),
      aggression: Number((0.25 + random() * 0.65).toFixed(3)),
      articulated: classId === 'semi',
      volatile: classId === 'tanker',
    }));
  }
  for (const special of scenario.highValueArrivals) {
    const existing = schedule.findIndex((entry) => entry.id === special.id);
    if (existing >= 0) schedule.splice(existing, 1);
    schedule.push(Object.freeze({ ...special, colorIndex: Math.floor(random() * 12), aggression: 0.58 }));
  }
  schedule.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return Object.freeze(schedule);
}

export function laneById(id, scenario = PAWPRINT_INTERCHANGE) {
  return scenario.lanes.find((lane) => lane.id === id) || scenario.lanes[0];
}

export function scheduleFingerprint(schedule) {
  return schedule.map((entry) => `${entry.id}:${entry.time}:${entry.laneId}:${entry.classId}:${entry.desiredSpeed}`).join('|');
}

export function validateCrashScenario(scenario = PAWPRINT_INTERCHANGE) {
  const errors = [];
  if (!scenario?.id || !scenario?.name) errors.push('scenario identity is missing');
  if (!Array.isArray(scenario?.lanes) || scenario.lanes.length < 8) errors.push('at least eight traffic lanes are required');
  const ids = new Set();
  for (const lane of scenario?.lanes || []) {
    if (ids.has(lane.id)) errors.push(`duplicate lane ${lane.id}`);
    ids.add(lane.id);
    if (!Array.isArray(lane.points) || lane.points.length < 2) errors.push(`lane ${lane.id} has insufficient points`);
    if (!(lane.desiredSpeed > 0)) errors.push(`lane ${lane.id} has invalid speed`);
    if (!(lane.stopProgress > 0 && lane.stopProgress < 1)) errors.push(`lane ${lane.id} has invalid stop line`);
  }
  for (const arrival of scenario?.highValueArrivals || []) {
    if (!ids.has(arrival.laneId)) errors.push(`special arrival ${arrival.id} references missing lane ${arrival.laneId}`);
    if (!CRASH_TRAFFIC_PROFILES[arrival.classId]) errors.push(`special arrival ${arrival.id} has unknown class ${arrival.classId}`);
  }
  return { valid: errors.length === 0, errors };
}
