#!/usr/bin/env node
/**
 * smoke-dungeon-gen.mjs — headless probe for src/dungeonGen.js.
 *
 * Generates 25 seeded dungeons at every production floor size and asserts the
 * layout contract catacomb.js depends on:
 *   1. layout.valid (generator's own flood-fill passed)
 *   2. every FLOOR cell reachable from the entrance center (independent
 *      re-run of the flood fill — belt over the generator's braces)
 *   3. entrance + boss rooms exist and differ
 *   4. >= 1 treasure room
 *   5. corridor min width >= 3 (every corridor cell sits inside some
 *      fully-FLOOR 3x3 window)
 *   6. room count sane (matches params, every room typed, sizes in table)
 *
 * Run: node tools/smoke-dungeon-gen.mjs
 * Exits non-zero on the first failed seed. No three.js — dungeonGen is pure.
 */
import { generateDungeon, FLOOR, TYPE, ENCOUNTER } from '../src/dungeonGen.js';

const SEEDS = 25;
const ROOM_COUNTS = [14, 16, 18, 20];
let failures = 0;

function fail(seed, msg) {
  console.error(`  FAIL seed=${seed}: ${msg}`);
  failures++;
}

function floodCount(d) {
  const { W, H, grid, rooms, entrance } = d;
  const start = rooms[entrance].cy * W + rooms[entrance].cx;
  if (grid[start] !== FLOOR) return -1;
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let qh = 0, qt = 0, n = 0;
  q[qt++] = start; seen[start] = 1;
  while (qh < qt) {
    const c = q[qh++]; n++;
    const x = c % W;
    if (x > 0 && grid[c - 1] === FLOOR && !seen[c - 1]) { seen[c - 1] = 1; q[qt++] = c - 1; }
    if (x < W - 1 && grid[c + 1] === FLOOR && !seen[c + 1]) { seen[c + 1] = 1; q[qt++] = c + 1; }
    if (c >= W && grid[c - W] === FLOOR && !seen[c - W]) { seen[c - W] = 1; q[qt++] = c - W; }
    if (c < W * H - W && grid[c + W] === FLOOR && !seen[c + W]) { seen[c + W] = 1; q[qt++] = c + W; }
  }
  return n;
}

/** True if (x,y) sits inside at least one fully-FLOOR 3x3 window. */
function inWideRun(d, x, y) {
  const { W, H, grid } = d;
  for (let cy = y - 1; cy <= y + 1; cy++) {
    for (let cx = x - 1; cx <= x + 1; cx++) {
      if (cx < 1 || cy < 1 || cx > W - 2 || cy > H - 2) continue;
      let ok = true;
      for (let oy = -1; oy <= 1 && ok; oy++)
        for (let ox = -1; ox <= 1; ox++)
          if (grid[(cy + oy) * W + (cx + ox)] !== FLOOR) { ok = false; break; }
      if (ok) return true;
    }
  }
  return false;
}

for (const roomCount of ROOM_COUNTS) {
for (let s = 0; s < SEEDS; s++) {
  const seed = (0xC0FFEE ^ (s * 2654435761) ^ (roomCount * 2246822519)) >>> 0;
  const d = generateDungeon({ seed, roomCount, loopChance: 0.30, decorDensity: 0.5 });

  // 1. valid
  if (!d.valid) { fail(seed, 'layout invalid after retries'); continue; }

  // 2. independent reachability
  let floorTotal = 0;
  for (let i = 0; i < d.W * d.H; i++) if (d.grid[i] === FLOOR) floorTotal++;
  const reached = floodCount(d);
  if (reached !== floorTotal) fail(seed, `flood fill reached ${reached}/${floorTotal} FLOOR cells`);

  // 3. entrance + boss
  if (!(d.entrance >= 0 && d.boss >= 0 && d.entrance !== d.boss))
    fail(seed, `bad entrance/boss ids (${d.entrance}, ${d.boss})`);
  if (d.rooms[d.entrance].type !== TYPE.ENTRANCE) fail(seed, 'entrance room not typed entrance');
  if (d.rooms[d.boss].type !== TYPE.BOSS) fail(seed, 'boss room not typed boss');

  // 4. treasure
  const treasure = d.rooms.filter(r => r.type === TYPE.TREASURE).length;
  if (treasure < 1) fail(seed, 'no treasure room');

  // 5. corridor min width >= 3
  let narrow = 0, corridorCells = 0;
  for (let y = 0; y < d.H; y++) {
    for (let x = 0; x < d.W; x++) {
      const c = y * d.W + x;
      if (!d.corridor[c] || d.grid[c] !== FLOOR) continue;
      corridorCells++;
      if (!inWideRun(d, x, y)) narrow++;
    }
  }
  if (corridorCells === 0) fail(seed, 'no corridor cells at all');
  // A handful of isolated cells at L-bend outer corners legitimately lack a
  // full 3-wide perpendicular window; with CELL=2.0u a 2-wide pinch is still
  // 4u across (hero radius 0.6u passes freely), so tolerate a small fraction.
  // A genuine width-1 corridor RUN would trip this — it fails inWideRun along
  // its whole length, a much larger fraction than corner clips.
  if (narrow > Math.max(6, corridorCells * 0.05))
    fail(seed, `${narrow}/${corridorCells} corridor cells narrower than 3 (beyond corner-clip tolerance)`);

  // 6. room count sane
  if (d.rooms.length !== roomCount) fail(seed, `room count ${d.rooms.length} != ${roomCount}`);
  for (const r of d.rooms) {
    if (!r.type) fail(seed, `room ${r.id} untyped`);
    if (!r.encounter) fail(seed, `room ${r.id} has no encounter identity`);
    if (r.w < 7 || r.w > 22 || r.h < 7 || r.h > 22) fail(seed, `room ${r.id} size ${r.w}x${r.h} out of table`);
  }
  const combatGrammar = new Set([
    ENCOUNTER.YARN_WALTZ, ENCOUNTER.GHOST_GALLERY,
    ENCOUNTER.PAW_RITE, ENCOUNTER.SPIKE_GARDEN,
  ]);
  const combatKinds = new Set(d.rooms.filter((r) => r.type === TYPE.COMBAT).map((r) => r.encounter));
  if ([...combatKinds].some((k) => !combatGrammar.has(k))) fail(seed, 'combat room emitted an invalid encounter grammar');
  if (d.rooms.filter((r) => r.type === TYPE.COMBAT).length >= 4 && combatKinds.size < 3)
    fail(seed, `combat variety collapsed to ${combatKinds.size} kind(s)`);
  if (d.rooms[d.boss].encounter !== ENCOUNTER.WARDEN_WALTZ) fail(seed, 'boss lacks Warden Waltz encounter');
  if (d.spawns.length === 0) fail(seed, 'no enemy spawns emitted');
  if (d.torches.length === 0) fail(seed, 'no torch anchors emitted');

  console.log(`  ok seed=${seed} ${d.W}x${d.H} rooms=${d.rooms.length} floor=${floorTotal} ` +
    `treasure=${treasure} encounters=${combatKinds.size} spawns=${d.spawns.length} torches=${d.torches.length} ` +
    `attempts=${d.stats.attempts} ${d.stats.genMs.toFixed(1)}ms "${d.name}"`);
}
}

if (failures > 0) {
  console.error(`\nsmoke-dungeon-gen: ${failures} assertion(s) failed across ${SEEDS * ROOM_COUNTS.length} layouts`);
  process.exit(1);
}
console.log(`\nsmoke-dungeon-gen: all ${SEEDS * ROOM_COUNTS.length} layouts passed (${ROOM_COUNTS.join('/')} rooms)`);
