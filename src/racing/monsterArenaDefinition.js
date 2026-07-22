/**
 * Monster Smash authored arena gameplay truth.
 *
 * This module intentionally has no DOM or THREE.js dependency.  Arena ground,
 * target placement, respawns, stunt verification, and smoke tests all consume
 * the same deterministic coordinates and analytical height query.
 */

const TAU = Math.PI * 2;

export const MONSTER_SURFACES = Object.freeze({
  packedDirt: Object.freeze({ id: 'packed-dirt', grip: 0.94, drag: 0.07 }),
  looseDirt: Object.freeze({ id: 'loose-dirt', grip: 0.78, drag: 0.2 }),
  rampDirt: Object.freeze({ id: 'ramp-dirt', grip: 1.04, drag: 0.025 }),
  bowlClay: Object.freeze({ id: 'bowl-clay', grip: 0.86, drag: 0.11 }),
  steel: Object.freeze({ id: 'steel-deck', grip: 0.81, drag: 0.04 }),
});

const RAMPS = Object.freeze([
  // Central three-line spine: paired wedges make the visible landing geometry
  // and allow the same stunt line to run in either direction.
  { id: 'spine-south-big', district: 'central-spine', x: 0, z: -23, yaw: 0, width: 14, length: 17, height: 6.6, launch: true, signature: 'CROWN TRANSFER', landing: 'spine-north-downslope' },
  { id: 'spine-north-downslope', district: 'central-spine', x: 0, z: 8, yaw: Math.PI, width: 15, length: 18, height: 6.1, launch: true, signature: 'CROWN TRANSFER', landing: 'spine-south-big' },
  { id: 'spine-south-medium', district: 'central-spine', x: -12, z: -20, yaw: 0.04, width: 8, length: 13, height: 3.8, launch: true, signature: 'CENTER TABLETOP', landing: 'spine-north-medium' },
  { id: 'spine-north-medium', district: 'central-spine', x: -11, z: 3, yaw: Math.PI + 0.04, width: 8, length: 13, height: 3.4, launch: true, signature: 'CENTER TABLETOP', landing: 'spine-south-medium' },
  // Bus/RV spectacle line.
  { id: 'bus-gap-south', district: 'bus-rv-gap', x: 38, z: -25, yaw: 0, width: 11, length: 18, height: 7.2, launch: true, signature: 'BUS GAP', landing: 'bus-gap-north' },
  { id: 'bus-gap-north', district: 'bus-rv-gap', x: 38, z: 12, yaw: Math.PI, width: 12, length: 19, height: 6.4, launch: true, signature: 'BUS GAP', landing: 'bus-gap-south' },
  // Bowl escape and crown/pyramid transfer.
  { id: 'bowl-escape', district: 'demolition-bowl', x: 49, z: 31, yaw: -2.38, width: 8, length: 13, height: 5.1, launch: true, signature: 'BOWL ESCAPE', landing: 'crown-kicker' },
  { id: 'crown-kicker', district: 'crown-jump', x: 14, z: 35, yaw: -1.16, width: 10, length: 15, height: 6.2, launch: true, signature: 'CROWN TRANSFER', landing: 'bowl-escape' },
  // Perimeter experimentation lines.
  { id: 'container-transfer-west', district: 'perimeter-freestyle', x: -65, z: 30, yaw: 1.56, width: 7.5, length: 12, height: 4.5, launch: true, signature: 'ROOFTOP TRANSFER', landing: 'west-quarter' },
  { id: 'west-quarter', district: 'perimeter-freestyle', x: -48, z: 31, yaw: -1.58, width: 8.5, length: 13, height: 4.1, launch: true, signature: 'ROOFTOP TRANSFER', landing: 'container-transfer-west' },
  { id: 'secret-service-kicker', district: 'perimeter-freestyle', x: -70, z: -39, yaw: 0.78, width: 5.5, length: 10, height: 3.8, launch: true, signature: 'SERVICE TUNNEL SECRET', landing: 'secret-yard-landing' },
]);

const BUMPS = Object.freeze([
  { id: 'rhythm-1', x: -23, z: -39, radius: 4.8, height: 1.2 },
  { id: 'rhythm-2', x: -14, z: -40, radius: 4.6, height: 1.45 },
  { id: 'rhythm-3', x: -5, z: -41, radius: 4.4, height: 1.1 },
  { id: 'east-cross-bump', x: 67, z: -5, radius: 6.2, height: 1.8 },
]);

const LANDING_ZONES = Object.freeze([
  { id: 'spine-north-downslope', x: 0, z: 3, radius: 9 },
  { id: 'spine-south-big', x: 0, z: -15, radius: 8 },
  { id: 'spine-north-medium', x: -11, z: -1, radius: 5 },
  { id: 'bus-gap-north', x: 38, z: 10, radius: 4 },
  { id: 'bus-gap-south', x: 38, z: -15, radius: 4 },
  { id: 'crown-kicker', x: 18, z: 34, radius: 4 },
  { id: 'container-transfer-west', x: -59, z: 30, radius: 3 },
  { id: 'secret-yard-landing', x: -58, z: -27, radius: 5 },
]);

function _target(id, kind, x, z, yaw = 0, extra = {}) {
  return Object.freeze({ id, kind, x, z, yaw, ...extra });
}

const TARGETS = [];

// First-run teaching line: the centered car demonstrates crushing while two
// open side choices lead directly into the central launch spine.
TARGETS.push(
  _target('starter-left', 'sedan', -6, -37, 0, { rowId: 'starter-row', district: 'central-spine', colorIndex: 4 }),
  _target('starter-center', 'wagon', 0, -37, 0, { rowId: 'starter-row', district: 'central-spine', colorIndex: 1 }),
  _target('starter-right', 'pickup', 6, -37, 0, { rowId: 'starter-row', district: 'central-spine', colorIndex: 2 }),
);

// Crusher Alley: three bidirectional lanes with believable full-size spacing.
for (let lane = 0; lane < 3; lane += 1) {
  for (let slot = 0; slot < 4; slot += 1) {
    const kinds = ['sedan', 'wagon', 'pickup', 'sedan'];
    TARGETS.push(_target(
      `crusher-${lane}-${slot}`,
      kinds[(lane + slot) % kinds.length],
      -54 + lane * 6.3,
      -18 + slot * 9.3,
      slot % 2 ? 0.045 : -0.045,
      { rowId: `crusher-lane-${lane}`, district: 'crusher-alley', colorIndex: lane * 4 + slot },
    ));
  }
}

// The bus/RV gap establishes vehicle scale and offers roof-crush alternatives.
TARGETS.push(
  _target('bus-gap-bus-a', 'bus', 31.5, -2, Math.PI / 2, { district: 'bus-rv-gap', signature: 'BUS GAP' }),
  _target('bus-gap-bus-b', 'bus', 44.5, -2, Math.PI / 2, { district: 'bus-rv-gap', signature: 'BUS GAP' }),
  _target('bus-gap-rv', 'rv', 38, 2.4, Math.PI / 2, { district: 'bus-rv-gap', signature: 'RV ROOFTOP' }),
  _target('bus-gap-limo', 'limousine', 38, -7, Math.PI / 2, { district: 'bus-rv-gap' }),
  _target('bus-gap-van', 'van', 26.5, 7, -0.16, { district: 'bus-rv-gap' }),
);

// Deterministic derby traffic.  These remain normal crush targets when hurt or overturned.
TARGETS.push(
  _target('derby-red', 'derby', 48, 35, 1.3, { district: 'demolition-bowl', ai: true, aiPhase: 0.1, colorIndex: 1 }),
  _target('derby-cyan', 'derby', 38, 27, -1.4, { district: 'demolition-bowl', ai: true, aiPhase: 2.2, colorIndex: 5 }),
  _target('derby-gold', 'derby', 52, 23, 2.7, { district: 'demolition-bowl', ai: true, aiPhase: 4.4, colorIndex: 2 }),
  _target('bowl-wreck-a', 'sedan', 42, 37, 0.5, { district: 'demolition-bowl', initialDamage: 0.46 }),
  _target('bowl-wreck-b', 'wagon', 55, 29, -0.7, { district: 'demolition-bowl', initialDamage: 0.34 }),
);

// Crown pyramid supports climbing, base destruction, and the clear-over line.
TARGETS.push(
  _target('crown-base-left', 'pickup', 4.4, 31.5, Math.PI / 2, { district: 'crown-jump', stackId: 'crown', stackLevel: 0 }),
  _target('crown-base-right', 'pickup', 10.2, 31.5, Math.PI / 2, { district: 'crown-jump', stackId: 'crown', stackLevel: 0 }),
  _target('crown-mid-left', 'sedan', 5.8, 31.5, Math.PI / 2, { district: 'crown-jump', stackId: 'crown', stackLevel: 1 }),
  _target('crown-mid-right', 'wagon', 8.8, 31.5, Math.PI / 2, { district: 'crown-jump', stackId: 'crown', stackLevel: 1 }),
  _target('crown-gold', 'crown', 7.3, 31.5, Math.PI / 2, { district: 'crown-jump', stackId: 'crown', stackLevel: 2, signature: 'CROWN CRUSH' }),
);

// Perimeter freestyle targets and rooftop/container transfer dressing.
TARGETS.push(
  _target('west-container-van', 'van', -58, 40, Math.PI / 2, { district: 'perimeter-freestyle' }),
  _target('west-rooftop-rv', 'rv', -57, 24, Math.PI / 2, { district: 'perimeter-freestyle', signature: 'RV ROOFTOP' }),
  _target('north-limo', 'limousine', -18, 51, Math.PI / 2, { district: 'perimeter-freestyle' }),
  _target('north-bus', 'bus', 12, 53, Math.PI / 2, { district: 'perimeter-freestyle' }),
  _target('east-van', 'van', 70, 8, 0, { district: 'perimeter-freestyle' }),
  _target('secret-gold-car', 'crown', -50, -22, 0.8, { district: 'perimeter-freestyle', signature: 'SERVICE TUNNEL SECRET' }),
);

export const CROWN_CHAOS_ARENA = Object.freeze({
  id: 'crown-chaos-coliseum',
  name: 'Crown Chaos Coliseum',
  subtitle: 'Smash cars. Earn Zoomies. Boost. Land flat.',
  seed: 0xc20c01,
  bounds: Object.freeze({ minX: -88, maxX: 88, minZ: -68, maxZ: 68, softX: 78, softZ: 59 }),
  cameraBounds: Object.freeze({ minX: -82, maxX: 82, minZ: -62, maxZ: 62 }),
  bowl: Object.freeze({ id: 'demolition-bowl', x: 46, z: 29, floorRadius: 10, outerRadius: 23, depth: 3.8 }),
  districts: Object.freeze([
    Object.freeze({ id: 'central-spine', name: 'Central Launch Spine', x: -4, z: -7, radius: 29 }),
    Object.freeze({ id: 'crusher-alley', name: 'Crusher Alley', x: -47, z: -4, radius: 25 }),
    Object.freeze({ id: 'bus-rv-gap', name: 'Bus & RV Gap', x: 38, z: -7, radius: 24 }),
    Object.freeze({ id: 'demolition-bowl', name: 'Demolition Bowl', x: 46, z: 29, radius: 25 }),
    Object.freeze({ id: 'crown-jump', name: 'Car Pyramid / Crown Jump', x: 8, z: 35, radius: 20 }),
    Object.freeze({ id: 'perimeter-freestyle', name: 'Perimeter Freestyle', x: -54, z: 31, radius: 31 }),
  ]),
  spawnPoints: Object.freeze([
    Object.freeze({ id: 'main', x: 0, z: -47, yaw: 0, radius: 7 }),
    Object.freeze({ id: 'crusher', x: -47, z: -35, yaw: 0, radius: 6 }),
    Object.freeze({ id: 'bus-gap', x: 38, z: -48, yaw: 0, radius: 6 }),
    Object.freeze({ id: 'bowl', x: 67, z: 42, yaw: -2.2, radius: 6 }),
    Object.freeze({ id: 'crown', x: -4, z: 36, yaw: Math.PI / 2, radius: 6 }),
    Object.freeze({ id: 'freestyle', x: -68, z: 13, yaw: 0.55, radius: 6 }),
  ]),
  ramps: RAMPS,
  bumps: BUMPS,
  landingZones: LANDING_ZONES,
  targets: Object.freeze(TARGETS),
});

// Pileup Pyramid Yard keeps its literal vehicle tiers, then surrounds them
// with four bumper-spaced runs of cars standing on end.  Each domino names the
// next member in its run so the runtime can propagate a visible, timed fall
// instead of faking the entire perimeter with one radial damage pulse.
const PYRAMID_TARGETS = [];
const carPyramidRows = [];
const carKinds = ['pickup', 'wagon', 'sedan', 'wagon', 'pickup'];
const PYRAMID_YAW = Math.PI * 0.75;
const _pyramidRowPoint = (centerX, centerZ, offset) => ({
  x: centerX + Math.sin(PYRAMID_YAW) * offset,
  z: centerZ + Math.cos(PYRAMID_YAW) * offset,
});
for (let level = 0; level < 5; level += 1) {
  const count = 5 - level;
  const row = [];
  for (let slot = 0; slot < count; slot += 1) {
    const id = `car-pyramid-${level}-${slot}`;
    const point = _pyramidRowPoint(-42, 7, (slot - (count - 1) * 0.5) * 4.7);
    row.push(id);
    PYRAMID_TARGETS.push(_target(
      id,
      level === 4 ? 'crown' : carKinds[(slot + level) % carKinds.length],
      point.x,
      point.z,
      PYRAMID_YAW,
      {
        district: 'car-pyramid',
        rowId: `car-pyramid-tier-${level}`,
        stackId: 'car-pyramid',
        structureId: 'car-pyramid',
        stackLevel: level,
        stackBaseY: level * 1.84,
        supportIds: level > 0 ? [carPyramidRows[level - 1][slot], carPyramidRows[level - 1][slot + 1]] : [],
        requiredSupports: level > 0 ? 2 : 0,
        noRespawn: true,
        signature: level === 4 ? 'CAR PYRAMID COLLAPSE' : '',
        colorIndex: slot + level * 5,
      },
    ));
  }
  carPyramidRows.push(row);
}

const busPyramidRows = [];
for (let level = 0; level < 3; level += 1) {
  const count = 3 - level;
  const row = [];
  for (let slot = 0; slot < count; slot += 1) {
    const id = `bus-pyramid-${level}-${slot}`;
    const point = _pyramidRowPoint(43, 10, (slot - (count - 1) * 0.5) * 10.4);
    row.push(id);
    PYRAMID_TARGETS.push(_target(
      id,
      'bus',
      point.x,
      point.z,
      PYRAMID_YAW,
      {
        district: 'bus-pyramid',
        rowId: `bus-pyramid-tier-${level}`,
        stackId: 'bus-pyramid',
        structureId: 'bus-pyramid',
        stackLevel: level,
        stackBaseY: level * 3.34,
        supportIds: level > 0 ? [busPyramidRows[level - 1][slot], busPyramidRows[level - 1][slot + 1]] : [],
        requiredSupports: level > 0 ? 2 : 0,
        noRespawn: true,
        signature: level === 2 ? 'BUS PYRAMID COLLAPSE' : '',
        colorIndex: 30 + slot + level * 3,
      },
    ));
  }
  busPyramidRows.push(row);
}

function _appendDominoRun({ id, count, startX, startZ, endX, endZ, hot = [] }) {
  const dx = endX - startX;
  const dz = endZ - startZ;
  const yaw = Math.atan2(dx, dz);
  const kinds = ['sedan', 'wagon', 'pickup', 'sedan', 'van', 'wagon'];
  for (let index = 0; index < count; index += 1) {
    const t = count <= 1 ? 0 : index / (count - 1);
    const targetId = `domino-${id}-${index}`;
    PYRAMID_TARGETS.push(_target(
      targetId,
      kinds[(index + id.length) % kinds.length],
      startX + dx * t,
      startZ + dz * t,
      yaw,
      {
        district: 'domino-perimeter',
        rowId: `domino-${id}`,
        dominoGroup: `domino-${id}`,
        dominoIndex: index,
        dominoNextId: index < count - 1 ? `domino-${id}-${index + 1}` : '',
        dominoPreviousId: index > 0 ? `domino-${id}-${index - 1}` : '',
        dominoStartPitch: -Math.PI * 0.48,
        explosive: hot.includes(index),
        burning: hot.includes(index),
        noRespawn: true,
        colorIndex: 48 + PYRAMID_TARGETS.length,
        signature: hot.includes(index) ? 'HOT CAR CHAIN' : '',
      },
    ));
  }
}

_appendDominoRun({ id: 'north', count: 22, startX: -50, startZ: 73, endX: 50, endZ: 73, hot: [6, 15] });
_appendDominoRun({ id: 'east', count: 17, startX: 104, startZ: 37, endX: 104, endZ: -37, hot: [5, 12] });
_appendDominoRun({ id: 'south', count: 22, startX: 50, startZ: -73, endX: -50, endZ: -73, hot: [7, 16] });
_appendDominoRun({ id: 'west', count: 17, startX: -104, startZ: -37, endX: -104, endZ: 37, hot: [4, 12] });

// A hot-car pinwheel and heavy vehicle gates make the open center useful even
// after the perimeter has fallen. Every obstacle here is still a crush target.
for (let spoke = 0; spoke < 6; spoke += 1) {
  const angle = spoke / 6 * TAU;
  PYRAMID_TARGETS.push(_target(
    `blast-pinwheel-${spoke}`,
    spoke % 3 === 2 ? 'pickup' : 'sedan',
    Math.cos(angle) * 14,
    43 + Math.sin(angle) * 10,
    Math.PI * 0.5 - angle,
    {
      district: 'blast-pit',
      rowId: 'blast-pinwheel',
      explosive: spoke % 2 === 0,
      burning: spoke % 2 === 0,
      colorIndex: 140 + spoke,
      signature: spoke % 2 === 0 ? 'BLAST PIT' : '',
    },
  ));
}
PYRAMID_TARGETS.push(
  _target('west-bus-gate-a', 'bus', -77, -22, 0.18, { district: 'heavy-gauntlet', rowId: 'west-bus-gate', colorIndex: 150 }),
  _target('west-bus-gate-b', 'bus', -68, -18, -0.18, { district: 'heavy-gauntlet', rowId: 'west-bus-gate', colorIndex: 151 }),
  _target('east-rv-gate-a', 'rv', 70, -19, 0.22, { district: 'heavy-gauntlet', rowId: 'east-rv-gate', colorIndex: 152 }),
  _target('east-rv-gate-b', 'rv', 79, -23, -0.22, { district: 'heavy-gauntlet', rowId: 'east-rv-gate', colorIndex: 153 }),
);

// Flaming bale tunnel and breakaway stunt performers. These are real damage
// targets, not scenery, so the truck can tear through the tunnel walls and
// clear the full stunt line as part of a timed round.
for (let side = 0; side < 2; side += 1) {
  for (let slot = 0; slot < 4; slot += 1) {
    PYRAMID_TARGETS.push(_target(
      `fire-bale-${side}-${slot}`,
      'haybale',
      (side ? 1 : -1) * 6.2,
      -8 + slot * 4.1,
      0,
      {
        district: 'launch-lanes',
        rowId: `fire-bale-wall-${side}`,
        explosive: slot === 3,
        burning: true,
        noRespawn: true,
        colorIndex: 166 + side * 4 + slot,
        signature: slot === 3 ? 'FLAMING BALE TUNNEL' : '',
      },
    ));
  }
}
for (let slot = 0; slot < 5; slot += 1) {
  PYRAMID_TARGETS.push(_target(
    `stunt-line-${slot}`,
    'stuntman',
    -14 + slot * 7,
    31 + Math.abs(2 - slot) * 1.6,
    slot % 2 ? 0.18 : -0.18,
    {
      district: 'launch-lanes',
      rowId: 'stuntman-line',
      noRespawn: true,
      colorIndex: 176 + slot,
      signature: slot === 2 ? 'STUNT TEAM WIPEOUT' : '',
    },
  ));
}

const PYRAMID_RAMPS = Object.freeze([
  { id: 'car-pyramid-face', district: 'car-pyramid', x: -42, z: -23, yaw: 0, width: 12, length: 17, height: 6.4, launch: true, signature: 'CAR WALL SHOT', landing: 'car-overrun' },
  { id: 'car-pyramid-return', district: 'car-pyramid', x: -42, z: 38, yaw: Math.PI, width: 10, length: 15, height: 5.4, launch: true, signature: 'CAR WALL RETURN', landing: 'car-runout-south' },
  { id: 'bus-pyramid-face', district: 'bus-pyramid', x: 43, z: -24, yaw: 0, width: 14, length: 19, height: 7.4, launch: true, signature: 'BUS WALL SHOT', landing: 'bus-overrun' },
  { id: 'bus-pyramid-return', district: 'bus-pyramid', x: 43, z: 43, yaw: Math.PI, width: 13, length: 18, height: 6.7, launch: true, signature: 'BUS WALL RETURN', landing: 'bus-runout-south' },
  { id: 'west-fire-kicker', district: 'blast-pit', x: -22, z: 42, yaw: Math.PI / 2, width: 8, length: 14, height: 4.5, launch: true, signature: 'FIRE RING TRANSFER', landing: 'east-fire-runout' },
  { id: 'east-fire-kicker', district: 'blast-pit', x: 22, z: 42, yaw: -Math.PI / 2, width: 8, length: 14, height: 4.5, launch: true, signature: 'FIRE RING TRANSFER', landing: 'west-fire-runout' },
  { id: 'center-sky-kicker', district: 'launch-lanes', x: 0, z: -28, yaw: 0, width: 11, length: 19, height: 7.4, launch: true, signature: 'PYRAMID FLYOVER', landing: 'center-runout' },
  { id: 'west-perimeter-kicker', district: 'domino-perimeter', x: -84, z: -48, yaw: -Math.PI / 2, width: 9, length: 15, height: 5.1, launch: true, signature: 'DOMINO FLYBY', landing: 'west-perimeter-runout' },
  { id: 'east-perimeter-kicker', district: 'domino-perimeter', x: 84, z: 48, yaw: Math.PI / 2, width: 9, length: 15, height: 5.1, launch: true, signature: 'DOMINO FLYBY', landing: 'east-perimeter-runout' },
]);

const PYRAMID_LANDING_ZONES = Object.freeze([
  { id: 'car-overrun', x: -42, z: 31, radius: 4 },
  { id: 'car-runout-south', x: -42, z: -42, radius: 4 },
  { id: 'bus-overrun', x: 43, z: 34, radius: 4 },
  { id: 'bus-runout-south', x: 43, z: -44, radius: 4 },
  { id: 'east-fire-runout', x: 39, z: 42, radius: 4 },
  { id: 'west-fire-runout', x: -39, z: 42, radius: 4 },
  { id: 'center-runout', x: 0, z: 20, radius: 5 },
  { id: 'west-perimeter-runout', x: -101, z: -48, radius: 4 },
  { id: 'east-perimeter-runout', x: 101, z: 48, radius: 4 },
]);

export const PILEUP_PYRAMID_ARENA = Object.freeze({
  id: 'pileup-pyramid-yard',
  name: 'Pileup Pyramid Yard',
  subtitle: 'Topple the perimeter. Detonate hot cars. Drop the stacks.',
  seed: 0x517ac4,
  dressing: 'pyramid-yard',
  boundaryDistrict: 'domino-perimeter',
  bounds: Object.freeze({ minX: -126, maxX: 126, minZ: -94, maxZ: 94, softX: 116, softZ: 84 }),
  cameraBounds: Object.freeze({ minX: -120, maxX: 120, minZ: -88, maxZ: 88 }),
  stadium: Object.freeze({ x: 120, z: 88 }),
  bowl: Object.freeze({ id: 'blast-pit', x: 0, z: 43, floorRadius: 7, outerRadius: 18, depth: 2.4 }),
  districts: Object.freeze([
    Object.freeze({ id: 'launch-lanes', name: 'Launch Lanes', x: 0, z: -30, radius: 34 }),
    Object.freeze({ id: 'car-pyramid', name: 'Five-Tier Car Pyramid', x: -42, z: 7, radius: 29 }),
    Object.freeze({ id: 'bus-pyramid', name: 'Three-Tier Bus Pyramid', x: 43, z: 10, radius: 31 }),
    Object.freeze({ id: 'blast-pit', name: 'Hot Car Blast Pit', x: 0, z: 43, radius: 25 }),
    Object.freeze({ id: 'heavy-gauntlet', name: 'Heavy Gate Gauntlet', x: 0, z: -21, radius: 48 }),
    Object.freeze({ id: 'domino-perimeter', name: 'Grand Domino Perimeter', x: 0, z: 0, radius: 118 }),
  ]),
  spawnPoints: Object.freeze([
    Object.freeze({ id: 'main', x: 0, z: -54, yaw: 0, radius: 7 }),
    Object.freeze({ id: 'car-pyramid', x: -24, z: 18, yaw: -2.25, radius: 6 }),
    Object.freeze({ id: 'bus-pyramid', x: 59, z: 21, yaw: -2.35, radius: 6 }),
    Object.freeze({ id: 'blast-pit', x: -27, z: 47, yaw: Math.PI / 2, radius: 6 }),
    Object.freeze({ id: 'heavy-gauntlet', x: 0, z: -47, yaw: 0, radius: 6 }),
    Object.freeze({ id: 'domino-perimeter', x: 83, z: -54, yaw: 0.55, radius: 6 }),
  ]),
  ramps: PYRAMID_RAMPS,
  bumps: Object.freeze([
    { id: 'rubble-west', district: 'launch-lanes', x: -22, z: -42, radius: 5.2, height: 1.2 },
    { id: 'rubble-east', district: 'launch-lanes', x: 22, z: -42, radius: 5.2, height: 1.2 },
    { id: 'rubble-north-west', district: 'domino-perimeter', x: -76, z: 55, radius: 5.6, height: 1.4 },
    { id: 'rubble-north-east', district: 'domino-perimeter', x: 76, z: 55, radius: 5.6, height: 1.4 },
  ]),
  landingZones: PYRAMID_LANDING_ZONES,
  targets: Object.freeze(PYRAMID_TARGETS),
});

export const MONSTER_ARENA_ORDER = Object.freeze([
  CROWN_CHAOS_ARENA.id,
  PILEUP_PYRAMID_ARENA.id,
]);

export const MONSTER_ARENAS = Object.freeze({
  [CROWN_CHAOS_ARENA.id]: CROWN_CHAOS_ARENA,
  [PILEUP_PYRAMID_ARENA.id]: PILEUP_PYRAMID_ARENA,
});

export function getMonsterArenaDefinition(id = CROWN_CHAOS_ARENA.id) {
  return MONSTER_ARENAS[id] || CROWN_CHAOS_ARENA;
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _smoothstep(value) {
  const t = _clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function _districtAt(definition, x, z) {
  let result = definition.boundaryDistrict || definition.districts.at(-1)?.id || '';
  let best = Infinity;
  for (const district of definition.districts) {
    const distance = Math.hypot(x - district.x, z - district.z) / district.radius;
    if (distance < best) {
      best = distance;
      result = district.id;
    }
  }
  return result;
}

export function arenaLocalPoint(feature, x, z) {
  const dx = x - feature.x;
  const dz = z - feature.z;
  const sin = Math.sin(feature.yaw || 0);
  const cos = Math.cos(feature.yaw || 0);
  return {
    x: dx * cos - dz * sin,
    z: dx * sin + dz * cos,
  };
}

function _rampSample(ramp, x, z) {
  const local = arenaLocalPoint(ramp, x, z);
  const halfWidth = ramp.width * 0.5;
  const halfLength = ramp.length * 0.5;
  if (Math.abs(local.x) > halfWidth || local.z < -halfLength || local.z > halfLength + 0.45) return null;
  const t = _clamp((local.z + halfLength) / ramp.length, 0, 1);
  // Ease into the ramp but preserve a real slope at the lip. Smoothstep made
  // the derivative zero at t=1, so launch velocity disagreed with the visible
  // face and fast trucks could skim off a nearly flat analytical edge.
  const profile = t * t * (2 - t);
  const height = profile * ramp.height;
  const derivative = ((4 * t - 3 * t * t) * ramp.height) / ramp.length;
  const sin = Math.sin(ramp.yaw || 0);
  const cos = Math.cos(ramp.yaw || 0);
  const dhdx = derivative * sin;
  const dhdz = derivative * cos;
  return {
    height,
    dhdx,
    dhdz,
    featureId: ramp.id,
    district: ramp.district,
    surface: MONSTER_SURFACES.rampDirt,
    takeoff: !!ramp.launch && local.z >= halfLength - 0.95 && local.z <= halfLength + 0.4,
    takeoffSlope: Math.max(0.22, derivative),
    signature: ramp.signature || '',
    landing: ramp.landing || '',
    localX: local.x,
    localZ: local.z,
  };
}

function _bowlSample(definition, x, z) {
  const bowl = definition.bowl;
  const dx = x - bowl.x;
  const dz = z - bowl.z;
  const distance = Math.hypot(dx, dz);
  if (distance >= bowl.outerRadius) return null;
  if (distance <= bowl.floorRadius) {
    return { height: -bowl.depth, dhdx: 0, dhdz: 0, surface: MONSTER_SURFACES.bowlClay, district: bowl.id, featureId: bowl.id };
  }
  const t = (distance - bowl.floorRadius) / (bowl.outerRadius - bowl.floorRadius);
  const eased = _smoothstep(t);
  const height = -bowl.depth * (1 - eased);
  const derivative = bowl.depth * 6 * t * (1 - t) / (bowl.outerRadius - bowl.floorRadius);
  return {
    height,
    dhdx: distance > 1e-5 ? derivative * dx / distance : 0,
    dhdz: distance > 1e-5 ? derivative * dz / distance : 0,
    surface: MONSTER_SURFACES.bowlClay,
    district: bowl.id,
    featureId: bowl.id,
  };
}

function _boundarySample(definition, x, z) {
  const { softX, softZ, maxX, maxZ } = definition.bounds;
  const xAmount = _clamp((Math.abs(x) - softX) / Math.max(1, maxX - softX), 0, 1);
  const zAmount = _clamp((Math.abs(z) - softZ) / Math.max(1, maxZ - softZ), 0, 1);
  const amount = Math.max(xAmount, zAmount);
  if (amount <= 0) return null;
  const height = _smoothstep(amount) * 6.4;
  let dhdx = 0;
  let dhdz = 0;
  if (xAmount >= zAmount) dhdx = Math.sign(x || 1) * 6.4 * 6 * xAmount * (1 - xAmount) / (maxX - softX);
  else dhdz = Math.sign(z || 1) * 6.4 * 6 * zAmount * (1 - zAmount) / (maxZ - softZ);
  return { height, dhdx, dhdz, surface: MONSTER_SURFACES.looseDirt, district: definition.boundaryDistrict || definition.districts.at(-1)?.id || '', featureId: 'stadium-berm' };
}

function _bumpSample(bump, x, z, definition) {
  const dx = x - bump.x;
  const dz = z - bump.z;
  const distance = Math.hypot(dx, dz);
  if (distance >= bump.radius) return null;
  const t = distance / bump.radius;
  const height = Math.cos(t * Math.PI * 0.5) ** 2 * bump.height;
  const derivative = -Math.sin(t * Math.PI) * Math.PI * bump.height / (2 * bump.radius);
  return {
    height,
    dhdx: distance > 1e-5 ? derivative * dx / distance : 0,
    dhdz: distance > 1e-5 ? derivative * dz / distance : 0,
    surface: MONSTER_SURFACES.looseDirt,
    district: bump.district || definition?.boundaryDistrict || 'perimeter-freestyle',
    featureId: bump.id,
  };
}

/** Return visible ground height, normal, surface, district, and launch truth. */
export function queryMonsterArenaGround(x, z, definition = CROWN_CHAOS_ARENA) {
  x = Number(x) || 0;
  z = Number(z) || 0;
  let best = {
    height: 0,
    dhdx: 0,
    dhdz: 0,
    surface: MONSTER_SURFACES.packedDirt,
    district: _districtAt(definition, x, z),
    featureId: 'arena-floor',
    takeoff: false,
    signature: '',
    landing: '',
  };
  const bowl = _bowlSample(definition, x, z);
  if (bowl) best = { ...best, ...bowl };
  const boundary = _boundarySample(definition, x, z);
  if (boundary && boundary.height > best.height) best = { ...best, ...boundary };
  for (const bump of definition.bumps) {
    const sample = _bumpSample(bump, x, z, definition);
    if (sample && sample.height > best.height) best = { ...best, ...sample };
  }
  for (const ramp of definition.ramps) {
    const sample = _rampSample(ramp, x, z);
    if (sample && sample.height >= best.height - 0.02) best = { ...best, ...sample };
  }
  const nx = -best.dhdx;
  const ny = 1;
  const nz = -best.dhdz;
  const length = Math.hypot(nx, ny, nz) || 1;
  return {
    height: best.height,
    normal: { x: nx / length, y: ny / length, z: nz / length },
    pitch: Math.atan2(best.dhdz, Math.hypot(1, best.dhdx)),
    roll: -Math.atan2(best.dhdx, Math.hypot(1, best.dhdz)),
    surface: best.surface.id,
    surfaceGrip: best.surface.grip,
    surfaceDrag: best.surface.drag,
    district: best.district,
    featureId: best.featureId,
    takeoff: !!best.takeoff,
    takeoffSlope: best.takeoffSlope || 0,
    signature: best.signature || '',
    landing: best.landing || '',
    insideBounds: x >= definition.bounds.minX && x <= definition.bounds.maxX
      && z >= definition.bounds.minZ && z <= definition.bounds.maxZ,
  };
}

/** Resolve a visible ramp lip even when a fast physics step crosses past it. */
export function findMonsterRampTakeoff(kart, definition = CROWN_CHAOS_ARENA) {
  if (!kart?.grounded || (Number(kart.speed) || 0) <= 6) return null;
  const previousX = Number(kart.previousX ?? kart.x) || 0;
  const previousZ = Number(kart.previousZ ?? kart.z) || 0;
  const currentX = Number(kart.x) || 0;
  const currentZ = Number(kart.z) || 0;
  // A monster truck leaves a ramp when its rear contact patch clears the lip,
  // not when its center of mass reaches an invisible trigger.  Normal rally
  // cars have no wheelbase field and keep the legacy center sample.
  const rearOffset = Math.max(0, Number(kart.wheelbase) || 0) * 0.5;
  const forwardX = Math.sin(Number(kart.yaw) || 0);
  const forwardZ = Math.cos(Number(kart.yaw) || 0);
  const previousRearX = previousX - forwardX * rearOffset;
  const previousRearZ = previousZ - forwardZ * rearOffset;
  const currentRearX = currentX - forwardX * rearOffset;
  const currentRearZ = currentZ - forwardZ * rearOffset;
  for (const ramp of definition.ramps) {
    if (!ramp.launch) continue;
    const start = arenaLocalPoint(ramp, previousRearX, previousRearZ);
    const end = arenaLocalPoint(ramp, currentRearX, currentRearZ);
    const halfLength = ramp.length * 0.5;
    const lipZ = halfLength - 0.9;
    const dz = end.z - start.z;
    const crossedLip = dz > 1e-5 && start.z < lipZ && end.z >= lipZ && end.z <= halfLength + 1.6;
    const sittingOnLip = end.z >= lipZ && end.z <= halfLength + 0.45;
    if (!crossedLip && !sittingOnLip) continue;
    const t = crossedLip ? _clamp((lipZ - start.z) / dz, 0, 1) : 1;
    const crossingX = start.x + (end.x - start.x) * t;
    if (Math.abs(crossingX) > ramp.width * 0.5 + 0.45) continue;
    const rampForwardX = Math.sin(ramp.yaw || 0);
    const rampForwardZ = Math.cos(ramp.yaw || 0);
    const along = (Number(kart.vx) || 0) * rampForwardX + (Number(kart.vz) || 0) * rampForwardZ;
    if (along <= 5.5) continue;
    const lipT = _clamp((lipZ + halfLength) / ramp.length, 0, 1);
    const slope = Math.max(0.22, ((4 * lipT - 3 * lipT * lipT) * ramp.height) / ramp.length);
    return { ramp, along, takeoffSlope: slope, swept: crossedLip };
  }
  return null;
}

export function nearestMonsterRespawn(x, z, definition = CROWN_CHAOS_ARENA) {
  let best = definition.spawnPoints[0];
  let distance = Infinity;
  for (const spawn of definition.spawnPoints) {
    const candidate = Math.hypot((Number(x) || 0) - spawn.x, (Number(z) || 0) - spawn.z);
    if (candidate < distance) {
      distance = candidate;
      best = spawn;
    }
  }
  return best;
}

export function landingZoneAt(x, z, definition = CROWN_CHAOS_ARENA) {
  for (const zone of definition.landingZones) {
    if (Math.hypot(x - zone.x, z - zone.z) <= zone.radius) return zone.id;
  }
  return '';
}

/** Structural validation used by Node smoke tests and the QA bridge. */
export function validateMonsterArenaDefinition(definition = CROWN_CHAOS_ARENA) {
  const errors = [];
  const ids = new Set();
  const register = (id, label) => {
    if (!id) errors.push(`${label} has no id`);
    else if (ids.has(id)) errors.push(`duplicate id: ${id}`);
    else ids.add(id);
  };
  register(definition.id, 'arena');
  for (const ramp of definition.ramps) register(ramp.id, 'ramp');
  const targetIds = new Set(definition.targets.map((target) => target.id));
  for (const target of definition.targets) register(target.id, 'target');
  for (const target of definition.targets) {
    const supportIds = Array.isArray(target.supportIds) ? target.supportIds : [];
    if ((Number(target.requiredSupports) || 0) > supportIds.length) errors.push(`not enough supports declared: ${target.id}`);
    for (const supportId of supportIds) {
      if (!targetIds.has(supportId)) errors.push(`missing support: ${target.id}/${supportId}`);
      if (supportId === target.id) errors.push(`self support: ${target.id}`);
    }
    if (supportIds.length && !(Number(target.stackBaseY) > 0)) errors.push(`stack target has no elevation: ${target.id}`);
    if (target.dominoGroup) {
      for (const [field, direction] of [['dominoNextId', 1], ['dominoPreviousId', -1]]) {
        const linkedId = target[field];
        if (!linkedId) continue;
        const linked = definition.targets.find((entry) => entry.id === linkedId);
        if (!linked) errors.push(`missing domino link: ${target.id}/${linkedId}`);
        else if (linked.dominoGroup !== target.dominoGroup || linked.dominoIndex !== target.dominoIndex + direction) {
          errors.push(`invalid domino order: ${target.id}/${linkedId}`);
        }
      }
    }
  }
  for (const spawn of definition.spawnPoints) {
    register(`spawn:${spawn.id}`, 'spawn');
    if (spawn.x < definition.bounds.minX || spawn.x > definition.bounds.maxX
      || spawn.z < definition.bounds.minZ || spawn.z > definition.bounds.maxZ) errors.push(`spawn outside bounds: ${spawn.id}`);
    for (const target of definition.targets) {
      if (Math.hypot(spawn.x - target.x, spawn.z - target.z) < spawn.radius + 2.8) errors.push(`spawn overlaps target: ${spawn.id}/${target.id}`);
    }
  }
  for (let i = 0; i < definition.landingZones.length; i += 1) {
    const a = definition.landingZones[i];
    for (const target of definition.targets) {
      if (Math.hypot(a.x - target.x, a.z - target.z) < a.radius + 2.8) errors.push(`landing zone obstructed: ${a.id}/${target.id}`);
    }
    for (let j = i + 1; j < definition.landingZones.length; j += 1) {
      const b = definition.landingZones[j];
      // Paired reverse-direction downslope zones may touch, but critical zones
      // should never occupy the same center and produce ambiguous awards.
      if (Math.hypot(a.x - b.x, a.z - b.z) < Math.min(a.radius, b.radius) * 0.28) errors.push(`landing zones overlap critically: ${a.id}/${b.id}`);
    }
  }
  return { ok: errors.length === 0, errors, ids: ids.size };
}

export function normalizedArenaHeading(angle) {
  let result = (angle + Math.PI) % TAU;
  if (result < 0) result += TAU;
  return result - Math.PI;
}
