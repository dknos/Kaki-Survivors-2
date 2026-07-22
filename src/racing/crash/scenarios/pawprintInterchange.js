const lane = (id, points, options = {}) => Object.freeze({
  id,
  points: Object.freeze(points.map(([x, z]) => Object.freeze({ x, z }))),
  signalGroup: options.signalGroup || id[0],
  // The authored stop bars sit at the junction throat. The old 0.39 value
  // stopped traffic roughly 34 m from the crossing, so buses and freight
  // could not physically clear the approach during one signal phase.
  stopProgress: options.stopProgress ?? 0.42,
  desiredSpeed: options.desiredSpeed || 15,
  route: options.route || 'straight',
  approach: options.approach || id[0],
  weight: options.weight || 1,
});

export const PAWPRINT_INTERCHANGE = Object.freeze({
  id: 'pawprint-interchange',
  name: 'PAWPRINT INTERCHANGE',
  subtitle: 'Industrial Loop / Signal 06',
  objective: 'Block the junction. Build the chain. Save Kaki Boom for the heavy traffic.',
  bounds: Object.freeze({ minX: -118, maxX: 118, minZ: -118, maxZ: 118 }),
  activeCrashRadius: 76,
  promotionRadius: 83,
  playerSpawn: Object.freeze({ x: -3.3, y: 3.65, z: -92, yaw: 0 }),
  playerLaneId: 'south-north-a',
  ramps: Object.freeze([
    Object.freeze({ id: 'west-ramp', x: -57, z: 18, yaw: Math.PI / 2, width: 5.5, length: 15, rise: 2.3 }),
    Object.freeze({ id: 'east-ramp', x: 57, z: -18, yaw: -Math.PI / 2, width: 5.5, length: 15, rise: 2.3 }),
  ]),
  signals: Object.freeze({
    cycleSeconds: 18,
    amberSeconds: 2,
    allRedSeconds: 1,
    phases: Object.freeze([
      Object.freeze({ group: 'NS', start: 0, end: 8 }),
      Object.freeze({ group: 'EW', start: 10, end: 18 }),
    ]),
  }),
  lanes: Object.freeze([
    lane('south-north-a', [[-3.3, -112], [-3.3, -48], [-3.3, 48], [-3.3, 112]], { signalGroup: 'NS', approach: 'south', desiredSpeed: 17 }),
    lane('south-north-b', [[-7.2, -112], [-7.2, -48], [-7.2, 48], [-7.2, 112]], { signalGroup: 'NS', approach: 'south', desiredSpeed: 15.5 }),
    lane('north-south-a', [[3.3, 112], [3.3, 48], [3.3, -48], [3.3, -112]], { signalGroup: 'NS', approach: 'north', desiredSpeed: 16.5 }),
    lane('north-south-b', [[7.2, 112], [7.2, 48], [7.2, -48], [7.2, -112]], { signalGroup: 'NS', approach: 'north', desiredSpeed: 15 }),
    lane('west-east-a', [[-112, 3.3], [-48, 3.3], [48, 3.3], [112, 3.3]], { signalGroup: 'EW', approach: 'west', desiredSpeed: 16.8 }),
    lane('west-east-b', [[-112, 7.2], [-48, 7.2], [48, 7.2], [112, 7.2]], { signalGroup: 'EW', approach: 'west', desiredSpeed: 15.2 }),
    lane('east-west-a', [[112, -3.3], [48, -3.3], [-48, -3.3], [-112, -3.3]], { signalGroup: 'EW', approach: 'east', desiredSpeed: 16.4 }),
    lane('east-west-b', [[112, -7.2], [48, -7.2], [-48, -7.2], [-112, -7.2]], { signalGroup: 'EW', approach: 'east', desiredSpeed: 15 }),
    lane('south-west-turn', [[-11, -112], [-11, -34], [-16, -10], [-36, -7.2], [-112, -7.2]], { signalGroup: 'NS', approach: 'south', route: 'left', desiredSpeed: 11.5, weight: 0.56 }),
    lane('west-north-turn', [[-112, 11], [-34, 11], [-10, 16], [-7.2, 36], [-7.2, 112]], { signalGroup: 'EW', approach: 'west', route: 'left', desiredSpeed: 11.2, weight: 0.54 }),
    lane('north-east-turn', [[11, 112], [11, 34], [16, 10], [36, 7.2], [112, 7.2]], { signalGroup: 'NS', approach: 'north', route: 'left', desiredSpeed: 11.4, weight: 0.55 }),
    lane('east-south-turn', [[112, -11], [34, -11], [10, -16], [7.2, -36], [7.2, -112]], { signalGroup: 'EW', approach: 'east', route: 'left', desiredSpeed: 11.1, weight: 0.52 }),
  ]),
  parkedRows: Object.freeze([
    Object.freeze({ x: -35, z: 38, yaw: Math.PI / 2, count: 6, spacing: 5.1 }),
    Object.freeze({ x: 34, z: -39, yaw: -Math.PI / 2, count: 5, spacing: 5.2 }),
  ]),
  highValueArrivals: Object.freeze([
    Object.freeze({ id: 'route-bus', time: 5.4, laneId: 'east-west-a', classId: 'bus', desiredSpeed: 14.2 }),
    Object.freeze({ id: 'jackknife-semi', time: 8.8, laneId: 'west-east-b', classId: 'semi', desiredSpeed: 13.1, articulated: true }),
    Object.freeze({ id: 'energy-tanker', time: 12.1, laneId: 'north-south-b', classId: 'tanker', desiredSpeed: 12.4, volatile: true }),
    Object.freeze({ id: 'late-box', time: 16.4, laneId: 'south-north-a', classId: 'boxTruck', desiredSpeed: 13.3 }),
  ]),
});

export function signalStateAt(time, group, scenario = PAWPRINT_INTERCHANGE) {
  const cycle = scenario.signals.cycleSeconds;
  const t = ((Number(time) || 0) % cycle + cycle) % cycle;
  const phase = scenario.signals.phases.find((entry) => entry.group === group);
  if (!phase) return 'red';
  if (t >= phase.start && t < phase.end - scenario.signals.amberSeconds) return 'green';
  if (t >= phase.end - scenario.signals.amberSeconds && t < phase.end) return 'amber';
  return 'red';
}
