/**
 * dungeonGen.js — seeded multi-room dungeon layout generator (pure data).
 *
 * Ported from "Dungeon Forge" by Majid Manzarpour (threejs-procedural-dungeon,
 * pure generator core: scatter → separate → Delaunay → MST+loops → semantics
 * → carve → rasterize+BFS → decorate). The THREE renderer half of the original
 * was NOT ported — see dungeonBuild.js for the game-side mesh builder.
 *
 * MIT License — Copyright (c) 2026 Majid Manzarpour
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 * ── Kitty Kaki fork changes ─────────────────────────────────────────────────
 * Seeds are NOT upstream-compatible: the rng stream is call-order dependent
 * and several draws were added/removed. This fork's output is canonical.
 *   1. WIDE CORRIDORS for horde/kite play: offs() generalized to any width,
 *      corridor width = isCritical ? 5 : 3, and the upstream w=1 treasure-
 *      narrowing branch is DELETED (chokepoints are anti-kiting).
 *   2. Separation PAD 2 → 4 so rooms leave enough wall for 3-5 wide
 *      connections.
 *   3. Room size tables bumped for hordes: small i(7,9), medium i(10,15),
 *      large i(16,22).
 *   4. Doorway-arch pass removed (the game kit carries no arch pieces).
 *   5. THEMES stripped to generator-consumed flags only (params.flags);
 *      palette/lighting/particles were renderer-only and live game-side now.
 *   6. Leaf guard runs at every N (upstream gated it to N>=20; the game's
 *      default roomCount is 14) + a >=1 treasure room guarantee.
 *   7. Enemy spawn density rescaled (area/40, clamp 2..12) — game cells are
 *      2 world units, upstream's area/18 at 1u tiles over-spawns.
 *   8. dungeonName word pools fixed to the crypt flavor (themes are gone).
 *
 * Pure data in/out — ZERO three.js imports; runs in plain node
 * (tools/smoke-dungeon-gen.mjs exercises it headless).
 */

/* ---------------- RNG ---------------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed) {
  const r = mulberry32(seed);
  return {
    f: (a, b) => a + r() * (b - a),
    i: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    raw: r,
    gauss(mu, sig) {
      let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r();
      return mu + sig * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

/* ---------------- constants ---------------- */
export const VOID = 0, FLOOR = 1, WALL = 2, POOL = 3;
export const TYPE = {
  ENTRANCE: 'entrance', COMBAT: 'combat', ELITE: 'elite',
  TREASURE: 'treasure', SHRINE: 'shrine', BOSS: 'boss',
};

// Room-scale encounter grammar. `type` still owns progression semantics;
// `encounter` tells the live Catacomb layer how this chamber should play.
// Keeping this in the pure seeded generator makes room identity replayable in
// tests and prevents the renderer from quietly re-rolling mechanics.
export const ENCOUNTER = Object.freeze({
  QUIET: 'quiet',
  YARN_WALTZ: 'yarn_waltz',
  GHOST_GALLERY: 'ghost_gallery',
  PAW_RITE: 'paw_rite',
  SPIKE_GARDEN: 'spike_garden',
  BELL_GAUNTLET: 'bell_gauntlet',
  WARDEN_WALTZ: 'warden_waltz',
  PAW_CACHE: 'paw_cache',
  MOON_SHRINE: 'moon_shrine',
});

/**
 * Generator-consumed flags (the only part of upstream THEMES the pure core
 * reads). Defaults tuned for the catacomb: coffin/bone dressing + a couple
 * of sunken grate pits per big room. pools.amount stays 0 — wall pockets
 * need a liquid shader the game doesn't ship for the catacomb.
 */
export const DEFAULT_FLAGS = {
  pools: { amount: 0, pits: 2 },
  lakes: false,
  graveyards: true,
  bones: true,
  icicles: false,
  roots: false,
};

/* ---------------- name generator ---------------- */
const NAME_A = ['Sunken', 'Forgotten', 'Silent', 'Hollow', 'Weeping', 'Broken', 'Nameless', 'Grim'];
const NAME_B = ['Halls', 'Vaults', 'Catacombs', 'Depths', 'Ossuary', 'Undercroft', 'Barrows', 'Crypts'];
function dungeonName(rng) {
  const C = ['Mal', 'Vor', 'Ash', 'Ker', 'Ul', 'Dra', 'Noth', 'Zar', 'Bel', 'Mor', 'Gol', 'Ith'];
  const D = ['goth', 'ath', 'ruk', 'esh', 'mir', 'gul', 'dan', 'oth', 'ek', 'ash', 'uzek', 'arim'];
  return 'The ' + rng.pick(NAME_A) + ' ' + rng.pick(NAME_B) + ' of ' + rng.pick(C) + '’' + rng.pick(D);
}

/* ---------------- Delaunay (Bowyer–Watson) ---------------- */
function delaunay(pts) {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];
  const P = pts.map((p, i) => ({ x: p.x + ((i * 0.618033) % 1) * 1e-3, y: p.y + ((i * 0.414213) % 1) * 1e-3, i }));
  let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
  for (const p of P) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  const dm = Math.max(maxX - minX, maxY - minY, 1), mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const s1 = { x: mx - 30 * dm, y: my - dm, i: -1 }, s2 = { x: mx, y: my + 30 * dm, i: -2 }, s3 = { x: mx + 30 * dm, y: my - dm, i: -3 };
  const mkTri = (a, b, c) => {
    const t = [a, b, c];
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) { t.ccx = 0; t.ccy = 0; t.r2 = Infinity; return t; }
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    t.ccx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    t.ccy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    t.r2 = (a.x - t.ccx) * (a.x - t.ccx) + (a.y - t.ccy) * (a.y - t.ccy);
    return t;
  };
  let tris = [mkTri(s1, s2, s3)];
  for (const p of P) {
    const bad = [], edges = [];
    for (const t of tris) { if ((p.x - t.ccx) * (p.x - t.ccx) + (p.y - t.ccy) * (p.y - t.ccy) < t.r2) bad.push(t); }
    for (const t of bad) for (let e = 0; e < 3; e++) edges.push([t[e], t[(e + 1) % 3]]);
    const poly = [];
    for (let i = 0; i < edges.length; i++) {
      let shared = false;
      for (let j = 0; j < edges.length; j++) {
        if (i === j) continue;
        const a = edges[i], b = edges[j];
        if ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0])) { shared = true; break; }
      }
      if (!shared) poly.push(edges[i]);
    }
    tris = tris.filter(t => !bad.includes(t));
    for (const e of poly) tris.push(mkTri(e[0], e[1], p));
  }
  tris = tris.filter(t => t[0].i >= 0 && t[1].i >= 0 && t[2].i >= 0);
  const seen = new Set(), out = [];
  for (const t of tris) for (let e = 0; e < 3; e++) {
    const a = t[e].i, b = t[(e + 1) % 3].i, lo = Math.min(a, b), hi = Math.max(a, b), k = lo * 4096 + hi;
    if (!seen.has(k)) { seen.add(k); out.push([lo, hi]); }
  }
  return out;
}

/* ---------------- generator ---------------- */
/**
 * @param {object} params
 * @param {number}  params.seed         u32 seed (required for determinism;
 *                                      defaults to a Date.now-derived seed)
 * @param {number} [params.roomCount]   default 14 — first-playable size
 * @param {number} [params.loopChance]  default 0.30 (kite loops for hordes)
 * @param {number} [params.decorDensity] default 0.5
 * @param {object} [params.flags]       generator flags, see DEFAULT_FLAGS
 */
export function generateDungeon(params = {}) {
  const p = {
    seed: (params.seed == null ? Date.now() : params.seed) >>> 0,
    roomCount: params.roomCount || 14,
    loopChance: params.loopChance == null ? 0.30 : params.loopChance,
    decorDensity: params.decorDensity == null ? 0.5 : params.decorDensity,
    flags: params.flags || DEFAULT_FLAGS,
  };
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let attempt = 0, seed = p.seed >>> 0, d = null;
  while (attempt < 5) {
    d = tryGenerate(seed, p);
    if (d.valid) break;
    seed = (Math.imul(seed, 9301) + 49297) >>> 0; attempt++;
  }
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  d.stats.genMs = t1 - t0;
  d.stats.attempts = attempt + 1;
  return d;
}

function tryGenerate(seed, params) {
  const rng = makeRng(seed);
  const N = params.roomCount;
  const FLAGS = params.flags;

  /* -- 1. scatter -- */
  const R = Math.sqrt(N) * 4.6;
  const rooms = [];
  const large = [];
  for (let i = 0; i < N; i++) {
    const t = rng.raw();
    let w, h, arch;
    // Fork: size tables bumped for horde play (upstream 5-7 / 8-12 / 13-18).
    if (t < 0.45) { arch = 's'; w = rng.i(7, 9); h = rng.i(7, 9); }
    else if (t < 0.85) { arch = 'm'; w = rng.i(10, 15); h = rng.i(10, 15); }
    else { arch = 'l'; w = rng.i(16, 22); h = rng.i(16, 22); large.push(i); }
    const st = rng.raw();
    const shape = st < 0.60 ? 'rect' : (st < 0.82 ? 'ellipse' : 'oct');
    const ang = rng.f(0, Math.PI * 2), rad = R * Math.sqrt(rng.raw());
    rooms.push({
      id: i, cx: Math.cos(ang) * rad, cy: Math.sin(ang) * rad, w, h, arch, shape,
      sx0: Math.cos(ang) * rad, sy0: Math.sin(ang) * rad,
      type: TYPE.COMBAT, depth: 0, difficulty: 0.2, degree: 0,
    });
  }
  while (large.length < 2) {
    const j = rng.i(0, N - 1);
    if (rooms[j].arch !== 'l') { rooms[j].arch = 'l'; rooms[j].w = rng.i(16, 22); rooms[j].h = rng.i(16, 22); rooms[j].shape = 'rect'; large.push(j); }
  }

  /* -- 2. separate -- */
  // Fork: PAD 2 → 4 so 3-5 wide corridors keep a wall between rooms.
  const PAD = 4;
  {
    const CX = new Float64Array(N), CY = new Float64Array(N), HW = new Float64Array(N), HH = new Float64Array(N);
    for (let i = 0; i < N; i++) { CX[i] = rooms[i].cx; CY[i] = rooms[i].cy; HW[i] = rooms[i].w / 2 + PAD / 2; HH[i] = rooms[i].h / 2 + PAD / 2; }
    for (let iter = 0; iter < 300; iter++) {
      let moved = false;
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const ox = HW[i] + HW[j] - Math.abs(CX[i] - CX[j]);
        if (ox <= 0) continue;
        const oy = HH[i] + HH[j] - Math.abs(CY[i] - CY[j]);
        if (oy <= 0) continue;
        moved = true;
        if (ox < oy) { const s = CX[i] <= CX[j] ? -1 : 1; CX[i] += s * ox / 2; CX[j] -= s * ox / 2; }
        else { const s = CY[i] <= CY[j] ? -1 : 1; CY[i] += s * oy / 2; CY[j] -= s * oy / 2; }
      }
      if (!moved) break;
    }
    for (let i = 0; i < N; i++) { rooms[i].cx = Math.round(CX[i]); rooms[i].cy = Math.round(CY[i]); }
  }

  /* -- 3. graph: Delaunay -> MST -> loops -- */
  const centers = rooms.map(r => ({ x: r.cx, y: r.cy }));
  let delEdges = delaunay(centers);
  if (delEdges.length === 0) { delEdges = []; for (let i = 0; i < N - 1; i++) delEdges.push([i, i + 1]); }
  const elen = e => Math.hypot(centers[e[0]].x - centers[e[1]].x, centers[e[0]].y - centers[e[1]].y);

  const adj = Array.from({ length: N }, () => []);
  delEdges.forEach((e, idx) => { const w = elen(e); adj[e[0]].push({ b: e[1], w, idx }); adj[e[1]].push({ b: e[0], w, idx }); });
  const inT = new Uint8Array(N); inT[0] = 1; let inCount = 1;
  const mstIdx = new Set();
  while (inCount < N) {
    let best = null;
    for (let a = 0; a < N; a++) if (inT[a]) for (const e of adj[a]) if (!inT[e.b] && (!best || e.w < best.w)) best = e;
    if (!best) break;
    inT[best.b] = 1; inCount++; mstIdx.add(best.idx);
  }
  if (inCount < N) return { valid: false, stats: {} };

  let mstLenSum = 0; for (const i of mstIdx) mstLenSum += elen(delEdges[i]);
  const mstMean = mstLenSum / Math.max(1, mstIdx.size);

  const edges = [];
  delEdges.forEach((e, idx) => {
    if (mstIdx.has(idx)) edges.push({ a: e[0], b: e[1], isLoop: false, isCritical: false });
    else if (elen(e) < mstMean * 2.2 && rng.chance(params.loopChance))
      edges.push({ a: e[0], b: e[1], isLoop: true, isCritical: false });
  });
  for (const e of edges) { rooms[e.a].degree++; rooms[e.b].degree++; }

  /* leaf guard: dungeons need dead ends — prune loop edges until >=3 leaves.
     Fork: runs at every N (upstream gated N>=20; the game defaults to 14). */
  {
    let leafCount = 0;
    for (let i = 0; i < N; i++) if (rooms[i].degree === 1) leafCount++;
    while (leafCount < 3) {
      let bi = -1, bs = -1;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i]; if (!e.isLoop) continue;
        const s = (rooms[e.a].degree === 2 ? 1 : 0) + (rooms[e.b].degree === 2 ? 1 : 0);
        const L = Math.hypot(centers[e.a].x - centers[e.b].x, centers[e.a].y - centers[e.b].y);
        const score = s * 10000 + L;
        if (score > bs) { bs = score; bi = i; }
      }
      if (bi < 0) break;
      const e = edges[bi];
      if (--rooms[e.a].degree === 1) leafCount++;
      if (--rooms[e.b].degree === 1) leafCount++;
      edges.splice(bi, 1);
    }
  }

  /* -- 4. semantics before carving -- */
  const gAdj = Array.from({ length: N }, () => []);
  edges.forEach((e, i) => { gAdj[e.a].push({ b: e.b, i }); gAdj[e.b].push({ b: e.a, i }); });

  let boss = 0; for (let i = 1; i < N; i++) if (rooms[i].w * rooms[i].h > rooms[boss].w * rooms[boss].h) boss = i;

  const distFrom = src => {
    const D = new Int32Array(N).fill(-1); D[src] = 0; const q = [src];
    for (let h = 0; h < q.length; h++) { const a = q[h]; for (const e of gAdj[a]) if (D[e.b] < 0) { D[e.b] = D[a] + 1; q.push(e.b); } }
    return D;
  };
  const dB = distFrom(boss);
  let entrance = -1, bestD = -1;
  for (let i = 0; i < N; i++) if (i !== boss && rooms[i].degree === 1 && dB[i] > bestD) { bestD = dB[i]; entrance = i; }
  if (entrance < 0) { for (let i = 0; i < N; i++) if (i !== boss && dB[i] > bestD) { bestD = dB[i]; entrance = i; } }

  const dE = distFrom(entrance);
  let maxDepth = 1; for (let i = 0; i < N; i++) if (dE[i] > maxDepth) maxDepth = dE[i];
  rooms.forEach((r, i) => { r.depth = Math.max(0, dE[i]); r.difficulty = Math.min(1, 0.15 + 0.85 * (r.depth / maxDepth)); });
  rooms[entrance].type = TYPE.ENTRANCE; rooms[entrance].difficulty = 0;
  rooms[boss].type = TYPE.BOSS; rooms[boss].difficulty = 1;

  const par = new Int32Array(N).fill(-1), pe = new Int32Array(N).fill(-1);
  {
    const q = [entrance], vis = new Uint8Array(N); vis[entrance] = 1;
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (const e of gAdj[a]) if (!vis[e.b]) { vis[e.b] = 1; par[e.b] = a; pe[e.b] = e.i; q.push(e.b); }
    }
  }
  const critRooms = new Set(); let critLen = 0;
  for (let c = boss; c !== -1; c = par[c]) { critRooms.add(c); if (pe[c] >= 0) { edges[pe[c]].isCritical = true; critLen++; } if (c === entrance) break; }

  const leaves = [];
  for (let i = 0; i < N; i++) if (i !== entrance && i !== boss && rooms[i].degree === 1) leaves.push(i);
  leaves.sort((a, b) => rooms[b].depth - rooms[a].depth);
  leaves.slice(0, 4).forEach(i => { rooms[i].type = TYPE.TREASURE; });

  /* Fork: >=1 treasure room guarantee — at small N the only non-entrance
     leaf can be the boss, leaving zero treasure. Fall back to the deepest
     off-critical combat room (then any deepest combat room). */
  {
    let haveTreasure = false;
    for (const r of rooms) if (r.type === TYPE.TREASURE) { haveTreasure = true; break; }
    if (!haveTreasure) {
      let bi = -1, bd = -1;
      for (let i = 0; i < N; i++) {
        const r = rooms[i];
        if (r.type === TYPE.COMBAT && !critRooms.has(i) && r.depth > bd) { bd = r.depth; bi = i; }
      }
      if (bi < 0) for (let i = 0; i < N; i++) {
        const r = rooms[i];
        if (r.type === TYPE.COMBAT && r.depth > bd) { bd = r.depth; bi = i; }
      }
      if (bi >= 0) rooms[bi].type = TYPE.TREASURE;
    }
  }

  const shrineC = [];
  for (let i = 0; i < N; i++) {
    const r = rooms[i];
    if (r.type === TYPE.COMBAT && !critRooms.has(i) && r.depth > maxDepth * 0.3 && r.depth < maxDepth * 0.85) shrineC.push(i);
  }
  for (let k = 0; k < 2 && shrineC.length > 0; k++) {
    const j = shrineC.splice(rng.i(0, shrineC.length - 1), 1)[0]; rooms[j].type = TYPE.SHRINE;
  }
  const eliteC = [];
  for (const i of critRooms) {
    const r = rooms[i];
    if (r.type === TYPE.COMBAT && r.depth >= maxDepth * 0.55 && r.depth <= maxDepth * 0.85) eliteC.push(i);
  }
  eliteC.sort((a, b) => rooms[a].depth - rooms[b].depth);
  for (let k = 0; k < Math.min(2, eliteC.length); k++) rooms[eliteC[eliteC.length - 1 - k]].type = TYPE.ELITE;

  /* -- 4.4 room encounter identity ---------------------------------------
   * Combat mechanics deliberately cycle through a shuffled seed offset. A
   * 14-room floor therefore contains several distinct fights even when its
   * topology is unusually linear, while the same seed remains canonical. */
  {
    const combatGrammar = [
      ENCOUNTER.YARN_WALTZ,
      ENCOUNTER.GHOST_GALLERY,
      ENCOUNTER.PAW_RITE,
      ENCOUNTER.SPIKE_GARDEN,
    ];
    const offset = rng.i(0, combatGrammar.length - 1);
    const combatRooms = rooms
      .filter((r) => r.type === TYPE.COMBAT)
      .sort((a, b) => (a.depth - b.depth) || (a.id - b.id));
    for (let i = 0; i < combatRooms.length; i++) {
      combatRooms[i].encounter = combatGrammar[(i + offset) % combatGrammar.length];
    }
    for (const r of rooms) {
      if (r.encounter) continue;
      if (r.type === TYPE.ELITE) r.encounter = ENCOUNTER.BELL_GAUNTLET;
      else if (r.type === TYPE.BOSS) r.encounter = ENCOUNTER.WARDEN_WALTZ;
      else if (r.type === TYPE.TREASURE) r.encounter = ENCOUNTER.PAW_CACHE;
      else if (r.type === TYPE.SHRINE) r.encounter = ENCOUNTER.MOON_SHRINE;
      else r.encounter = ENCOUNTER.QUIET;
    }
  }

  /* -- 4.5 flag-driven room mutations (generation-aware) -- */
  if (FLAGS.lakes) {
    const lc = [];
    for (let i = 0; i < N; i++) {
      const r = rooms[i];
      if ((r.type === TYPE.COMBAT || r.type === TYPE.ELITE) && Math.min(r.w, r.h) >= 9) lc.push(i);
    }
    for (let k = 0; k < 2 && lc.length > 0; k++) rooms[lc.splice(rng.i(0, lc.length - 1), 1)[0]].lake = true;
  }
  if (FLAGS.graveyards) {
    const gc = [];
    for (let i = 0; i < N; i++) {
      const r = rooms[i];
      if (r.type === TYPE.COMBAT && r.shape !== 'ellipse' && Math.min(r.w, r.h) >= 8) gc.push(i);
    }
    for (let k = 0; k < 3 && gc.length > 0; k++) rooms[gc.splice(rng.i(0, gc.length - 1), 1)[0]].grave = true;
  }

  /* -- 5. carve + rasterize -- */
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const r of rooms) {
    minX = Math.min(minX, r.cx - Math.ceil(r.w / 2)); maxX = Math.max(maxX, r.cx + Math.ceil(r.w / 2));
    minY = Math.min(minY, r.cy - Math.ceil(r.h / 2)); maxY = Math.max(maxY, r.cy + Math.ceil(r.h / 2));
  }
  const PADG = 5, offX = PADG - minX, offY = PADG - minY;
  const W = (maxX - minX) + PADG * 2 + 1, H = (maxY - minY) + PADG * 2 + 1;
  for (const r of rooms) { r.cx += offX; r.cy += offY; r.sx0 += offX; r.sy0 += offY; }

  const grid = new Uint8Array(W * H);
  const roomId = new Int16Array(W * H).fill(-1);
  const corridor = new Uint8Array(W * H);
  const idx = (x, y) => y * W + x;
  const inB = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  for (const r of rooms) {
    const rx = r.w / 2, ry = r.h / 2, sh = r.shape, ch = Math.min(rx, ry) * 0.55;
    const irx2 = 1 / (rx * rx), iry2 = 1 / (ry * ry);
    const y0 = Math.max(0, Math.floor(r.cy - ry)), y1 = Math.min(H - 1, Math.ceil(r.cy + ry));
    const x0 = Math.max(0, Math.floor(r.cx - rx)), x1 = Math.min(W - 1, Math.ceil(r.cx + rx));
    for (let y = y0; y <= y1; y++) {
      const dy = y - r.cy, ady = Math.abs(dy), row = y * W;
      if (ady > ry) continue;
      for (let x = x0; x <= x1; x++) {
        const dx = x - r.cx, adx = Math.abs(dx);
        if (adx > rx) continue;
        let ok = true;
        if (sh === 'ellipse') ok = dx * dx * irx2 + dy * dy * iry2 <= 1.0;
        else if (sh === 'oct') ok = adx <= rx - ch || ady <= ry - ch || (adx - (rx - ch)) + (ady - (ry - ch)) <= ch;
        if (ok) { const c = row + x; grid[c] = FLOOR; roomId[c] = r.id; }
      }
    }
  }

  const stamp = (x, y) => { if (inB(x, y) && grid[idx(x, y)] !== FLOOR) { grid[idx(x, y)] = FLOOR; corridor[idx(x, y)] = 1; } };
  // Fork: centered offsets for any width (upstream hardcoded w 1/2/3).
  const offs = w => Array.from({ length: w }, (_, k) => k - (w >> 1));
  const hLine = (x0, x1, y, w) => { const o = offs(w); for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (const k of o) stamp(x, y + k); };
  const vLine = (y0, y1, x, w) => { const o = offs(w); for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (const k of o) stamp(x + k, y); };

  for (const e of edges) {
    const A = rooms[e.a], B = rooms[e.b];
    // Fork: WIDE CORRIDORS — 5 on the critical path, 3 everywhere else.
    // (Upstream's w=1 treasure-narrowing branch deleted: anti-kiting.)
    const w = e.isCritical ? 5 : 3;
    const dx = Math.abs(A.cx - B.cx), dy = Math.abs(A.cy - B.cy);
    const ovX = Math.min(A.cx + A.w / 2, B.cx + B.w / 2) - Math.max(A.cx - A.w / 2, B.cx - B.w / 2);
    const ovY = Math.min(A.cy + A.h / 2, B.cy + B.h / 2) - Math.max(A.cy - A.h / 2, B.cy - B.h / 2);
    if (ovX >= w + 2 && dy > 0) { const x = Math.round((Math.max(A.cx - A.w / 2, B.cx - B.w / 2) + Math.min(A.cx + A.w / 2, B.cx + B.w / 2)) / 2); vLine(A.cy, B.cy, x, w); }
    else if (ovY >= w + 2 && dx > 0) { const y = Math.round((Math.max(A.cy - A.h / 2, B.cy - B.h / 2) + Math.min(A.cy + A.h / 2, B.cy + B.h / 2)) / 2); hLine(A.cx, B.cx, y, w); }
    else if (rng.chance(0.5)) { hLine(A.cx, B.cx, A.cy, w); vLine(A.cy, B.cy, B.cx, w); }
    else { vLine(A.cy, B.cy, A.cx, w); hLine(A.cx, B.cx, B.cy, w); }
  }

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (grid[row + x] !== FLOOR) continue;
      const ya = Math.max(0, y - 1), yb = Math.min(H - 1, y + 1);
      const xa = Math.max(0, x - 1), xb = Math.min(W - 1, x + 1);
      for (let ny = ya; ny <= yb; ny++) {
        const nrow = ny * W;
        for (let nx = xa; nx <= xb; nx++) {
          const ni = nrow + nx;
          if (grid[ni] === VOID) grid[ni] = WALL;
        }
      }
    }
  }

  const doorway = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (!corridor[c]) continue;
      if ((x < W - 1 && roomId[c + 1] >= 0) || (x > 0 && roomId[c - 1] >= 0) ||
          (y < H - 1 && roomId[c + W] >= 0) || (y > 0 && roomId[c - W] >= 0)) doorway[c] = 1;
    }
  }

  /* -- 5.5 flag carving: liquid pockets + interior pits --
     (Doorway-arch grouping removed in this fork — no arch assets.) */
  const pools = [];
  if (FLAGS.pools && FLAGS.pools.amount > 0) {
    const nearDoorC = (x, y, d) => {
      for (let oy = -d; oy <= d; oy++) for (let ox = -d; ox <= d; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && doorway[idx(nx, ny)]) return true;
      } return false;
    };
    const cand = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const c = idx(x, y);
      if (grid[c] !== WALL || nearDoorC(x, y, 2)) continue;
      let nf = 0;
      if (grid[c + 1] === FLOOR) nf++; if (grid[c - 1] === FLOOR) nf++;
      if (grid[c + W] === FLOOR) nf++; if (grid[c - W] === FLOOR) nf++;
      if (nf === 1) cand.push({ x, y });
    }
    for (let i = cand.length - 1; i > 0; i--) { const j = rng.i(0, i); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
    const target = Math.round(cand.length * FLAGS.pools.amount);
    for (const s of cand) {
      if (pools.length >= target) break;
      let close = false;
      for (const p of pools) if (Math.max(Math.abs(p.x - s.x), Math.abs(p.y - s.y)) < 3) { close = true; break; }
      if (close) continue;
      grid[idx(s.x, s.y)] = POOL; pools.push({ x: s.x, y: s.y });
    }
    for (const p of pools)
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const nx = p.x + ox, ny = p.y + oy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && grid[idx(nx, ny)] === VOID) grid[idx(nx, ny)] = WALL;
      }
  }

  /* Interior pits: single floor cells sunk (rendered as grates game-side).
     Carved before BFS validation, so connectivity is still guaranteed;
     interior-only + spacing >= 4 means a room can never be split. */
  if (FLAGS.pools && FLAGS.pools.pits) {
    for (const r of rooms) {
      if ((r.type !== TYPE.COMBAT && r.type !== TYPE.ELITE) || r.lake || r.grave) continue;
      let n = Math.min(FLAGS.pools.pits, Math.floor(r.w * r.h / 45) + 1), guard = 0;
      while (n > 0 && guard++ < 40) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 2, Math.ceil(r.cx + r.w / 2) - 2);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 2, Math.ceil(r.cy + r.h / 2) - 2);
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] !== r.id || grid[c] !== FLOOR || doorway[c]) continue;
        let ok = true;
        for (let oy = -1; oy <= 1 && ok; oy++) for (let ox = -1; ox <= 1; ox++)
          if (grid[idx(x + ox, y + oy)] !== FLOOR) { ok = false; break; }
        if (ok) for (const p of pools) if (Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 4) { ok = false; break; }
        if (!ok) continue;
        grid[c] = POOL; pools.push({ x, y }); n--;
      }
    }
  }

  /* Frozen lakes: interior floor cells of lake rooms stay walkable (FLOOR
     for BFS) but are flagged so rendering can swap tiles. */
  const lakeMask = new Uint8Array(W * H);
  const lakeCells = [];
  for (const r of rooms) {
    if (!r.lake) continue;
    for (let y = Math.floor(r.cy - r.h / 2) + 2; y <= Math.ceil(r.cy + r.h / 2) - 2; y++)
      for (let x = Math.floor(r.cx - r.w / 2) + 2; x <= Math.ceil(r.cx + r.w / 2) - 2; x++) {
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] !== r.id || grid[c] !== FLOOR || doorway[c]) continue;
        let solid = false;
        for (let oy = -1; oy <= 1 && !solid; oy++) for (let ox = -1; ox <= 1; ox++)
          if (grid[idx(x + ox, y + oy)] !== FLOOR) { solid = true; break; }
        if (!solid) { lakeMask[c] = 1; lakeCells.push({ x, y }); }
      }
  }

  /* -- 6. BFS field + validation -- */
  const bfs = new Int16Array(W * H).fill(-1);
  const ei = idx(rooms[entrance].cx, rooms[entrance].cy);
  const total = W * H;
  let floorTotal = 0; for (let i = 0; i < total; i++) if (grid[i] === FLOOR) floorTotal++;
  let reach = 0, maxBfs = 0;
  if (grid[ei] === FLOOR) {
    const q = new Int32Array(floorTotal); let qh = 0, qt = 0;
    q[qt++] = ei; bfs[ei] = 0; reach = 1;
    while (qh < qt) {
      const c = q[qh++], x = c % W, b = bfs[c] + 1;
      let n;
      if (x > 0 && grid[n = c - 1] === FLOOR && bfs[n] < 0) { bfs[n] = b; q[qt++] = n; reach++; }
      if (x < W - 1 && grid[n = c + 1] === FLOOR && bfs[n] < 0) { bfs[n] = b; q[qt++] = n; reach++; }
      if (c >= W && grid[n = c - W] === FLOOR && bfs[n] < 0) { bfs[n] = b; q[qt++] = n; reach++; }
      if (c < total - W && grid[n = c + W] === FLOOR && bfs[n] < 0) { bfs[n] = b; q[qt++] = n; reach++; }
    }
    maxBfs = bfs[q[qt - 1]];  /* FIFO: last enqueued cell is farthest */
  }
  const valid = reach === floorTotal && floorTotal > 0;

  /* -- 7. decoration (pure data) -- */
  const props = [], spawns = [];
  const occ = new Uint8Array(W * H);
  const nearDoor = (x, y, d) => {
    for (let oy = -d; oy <= d; oy++) for (let ox = -d; ox <= d; ox++)
      if (inB(x + ox, y + oy) && doorway[idx(x + ox, y + oy)]) return true;
    return false;
  };
  const interior = (x, y) => {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++)
      if (!inB(x + ox, y + oy) || grid[idx(x + ox, y + oy)] !== FLOOR) return false;
    return true;
  };
  const put = (kind, x, y, rot, scale, rid) => { props.push({ kind, x, y, rot: rot || 0, scale: scale || 1, roomId: rid }); occ[idx(x, y)] = 1; };

  for (const r of rooms) {
    const cix = idx(r.cx, r.cy);
    if (r.type === TYPE.ENTRANCE) put('ring', r.cx, r.cy, 0, 1, r.id);
    if (r.type === TYPE.BOSS) {
      put('bossCrystal', r.cx, r.cy, rng.f(0, 6.28), 1, r.id);
      const rr = Math.max(2.5, Math.min(r.w, r.h) / 2 - 2), a0 = rng.f(0, 1);
      for (let k = 0; k < 6; k++) {
        const a = a0 + k * Math.PI / 3;
        const bx = Math.round(r.cx + Math.cos(a) * rr), by = Math.round(r.cy + Math.sin(a) * rr);
        if (inB(bx, by) && grid[idx(bx, by)] === FLOOR && !occ[idx(bx, by)] && !nearDoor(bx, by, 1)) put('brazier', bx, by, 0, 1, r.id);
      }
    }
    if (r.type === TYPE.TREASURE && grid[cix] === FLOOR) put('chest', r.cx, r.cy, rng.i(0, 3) * Math.PI / 2, 1, r.id);
    if (r.type === TYPE.SHRINE && grid[cix] === FLOOR) put('shrineCrystal', r.cx, r.cy, rng.f(0, 6.28), 1, r.id);

    if ((r.type === TYPE.COMBAT || r.type === TYPE.ELITE) && Math.min(r.w, r.h) >= 10 && r.shape !== 'ellipse' && !r.grave && !r.lake) {
      const step = Math.min(r.w, r.h) >= 14 ? 4 : 3;
      for (let y = Math.ceil(r.cy - r.h / 2) + 2; y <= r.cy + r.h / 2 - 2; y++)
        for (let x = Math.ceil(r.cx - r.w / 2) + 2; x <= r.cx + r.w / 2 - 2; x++) {
          if (((x - r.cx) % step) !== 0 || ((y - r.cy) % step) !== 0) continue;
          if (x === r.cx && y === r.cy) continue;
          if (interior(x, y) && !occ[idx(x, y)] && !nearDoor(x, y, 2)) put('pillar', x, y, 0, rng.f(0.94, 1.06), r.id);
        }
    }
    if (r.grave) {
      for (let y = Math.ceil(r.cy - r.h / 2) + 2; y <= r.cy + r.h / 2 - 2; y += 2)
        for (let x = Math.ceil(r.cx - r.w / 2) + 2; x <= r.cx + r.w / 2 - 2; x += 2) {
          if (Math.abs(x - r.cx) <= 1 && Math.abs(y - r.cy) <= 1) continue;
          if (interior(x, y) && !occ[idx(x, y)] && !nearDoor(x, y, 2) && rng.chance(0.8))
            put('grave', x, y, rng.f(-0.3, 0.3), rng.f(0.85, 1.15), r.id);
        }
      if (Math.min(r.w, r.h) >= 10 && grid[cix] === FLOOR && !occ[cix])
        put('sarco', r.cx, r.cy, rng.chance(0.5) ? 0 : Math.PI / 2, 1, r.id);
      let cd = 4;
      while (cd-- > 0) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 1, Math.ceil(r.cx + r.w / 2) - 1);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 1, Math.ceil(r.cy + r.h / 2) - 1);
        if (inB(x, y) && roomId[idx(x, y)] === r.id && grid[idx(x, y)] === FLOOR && !occ[idx(x, y)])
          put('candle', x, y, 0, rng.f(0.85, 1.2), r.id);
      }
    }
    if (r.type === TYPE.COMBAT || r.type === TYPE.ELITE || r.type === TYPE.BOSS) {
      let area = 0;
      for (let y = Math.floor(r.cy - r.h / 2); y <= Math.ceil(r.cy + r.h / 2); y++)
        for (let x = Math.floor(r.cx - r.w / 2); x <= Math.ceil(r.cx + r.w / 2); x++)
          if (inB(x, y) && roomId[idx(x, y)] === r.id) area++;
      // Fork: density rescaled for 2u game cells + hard 2..12 clamp (perf:
      // catacomb caps concurrent skinned skeletons; overflow goes static).
      let count = Math.max(2, Math.min(12, Math.round((area / 40) * (0.5 + r.difficulty))));
      if (r.type === TYPE.ELITE) count = Math.max(2, Math.round(count * 0.6));
      if (r.type === TYPE.BOSS) count = rng.i(2, 3);
      const tier = r.type === TYPE.ELITE ? 3 : Math.max(1, Math.ceil(r.difficulty * 3));
      let guard = 0;
      while (count > 0 && guard++ < 220) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 1, Math.ceil(r.cx + r.w / 2) - 1);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 1, Math.ceil(r.cy + r.h / 2) - 1);
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] === r.id && grid[c] === FLOOR && !occ[c] && !doorway[c] && !lakeMask[c]) {
          spawns.push({ x, y, tier, roomId: r.id }); occ[c] = 1; count--;
        }
      }
    }
  }
  const torchCand = [];
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (grid[c] !== WALL) continue;
      if (x < W - 1 && grid[c + 1] === FLOOR) torchCand.push({ x, y, dx: 1, dy: 0 });
      else if (x > 0 && grid[c - 1] === FLOOR) torchCand.push({ x, y, dx: -1, dy: 0 });
      else if (y < H - 1 && grid[c + W] === FLOOR) torchCand.push({ x, y, dx: 0, dy: 1 });
      else if (y > 0 && grid[c - W] === FLOOR) torchCand.push({ x, y, dx: 0, dy: -1 });
    }
  }
  for (let i = torchCand.length - 1; i > 0; i--) { const j = rng.i(0, i); const t = torchCand[i]; torchCand[i] = torchCand[j]; torchCand[j] = t; }
  const torches = [];
  for (const c of torchCand) {
    let ok = true;
    for (const t of torches) if (Math.max(Math.abs(t.x - c.x), Math.abs(t.y - c.y)) < 4) { ok = false; break; }
    if (ok) torches.push(c);
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (grid[c] !== FLOOR || occ[c] || doorway[c] || lakeMask[c]) continue;
      const rid = roomId[c];
      const diff = rid >= 0 ? rooms[rid].difficulty : 0.5;
      let p = params.decorDensity * 0.045 * (1.25 - 0.6 * diff);
      if (corridor[c]) p *= 0.45;
      if (rng.chance(p)) props.push({ kind: 'debris', x, y, rot: rng.f(0, 6.28), scale: rng.f(0.6, 1.35), roomId: rid, v: rng.i(0, 2) });
    }
  }

  /* -- 7.5 flag prop sweeps -- */
  const floorDir = (x, y) => {
    const c = idx(x, y);
    if (x < W - 1 && grid[c + 1] === FLOOR) return [1, 0];
    if (x > 0 && grid[c - 1] === FLOOR) return [-1, 0];
    if (y < H - 1 && grid[c + W] === FLOOR) return [0, 1];
    if (y > 0 && grid[c - W] === FLOOR) return [0, -1];
    return null;
  };
  if (FLAGS.icicles) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (grid[idx(x, y)] !== WALL) continue;
      const d = floorDir(x, y);
      if (d && rng.chance(0.06 + 0.08 * params.decorDensity))
        props.push({ kind: 'icicle', x, y, dx: d[0], dy: d[1], rot: rng.f(0, 6.28), scale: rng.f(0.7, 1.3) });
    }
    for (const lc of lakeCells)
      if (rng.chance(0.05)) props.push({ kind: 'shardIce', x: lc.x, y: lc.y, rot: rng.f(0, 6.28), scale: rng.f(0.6, 1.2) });
  }
  if (FLAGS.roots) {
    const sites = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      if (grid[idx(x, y)] !== WALL) continue;
      const d = floorDir(x, y);
      if (d && roomId[idx(x + d[0], y + d[1])] >= 0) sites.push({ x, y, dx: d[0], dy: d[1] });
    }
    for (let i = sites.length - 1; i > 0; i--) { const j = rng.i(0, i); const t = sites[i]; sites[i] = sites[j]; sites[j] = t; }
    const breaches = [];
    for (const s of sites) {
      if (breaches.length >= 5) break;
      let close = false;
      for (const b of breaches) if (Math.max(Math.abs(b.x - s.x), Math.abs(b.y - s.y)) < 7) { close = true; break; }
      if (!close) breaches.push(s);
    }
    const mossMask = new Uint8Array(W * H);
    for (const b of breaches) {
      props.push({ kind: 'roots', x: b.x, y: b.y, dx: b.dx, dy: b.dy, rot: 0, scale: rng.f(0.9, 1.2) });
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const nx = b.x + ox, ny = b.y + oy;
        if (!inB(nx, ny)) continue;
        const c = idx(nx, ny);
        if (grid[c] === FLOOR && !mossMask[c] && rng.chance(0.75)) {
          mossMask[c] = 1; props.push({ kind: 'moss', x: nx, y: ny, rot: rng.f(0, 6.28), scale: rng.f(0.7, 1.4) });
        }
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = idx(x, y);
      if (grid[c] !== FLOOR || mossMask[c] || lakeMask[c]) continue;
      let nw = 0;
      if (x < W - 1 && grid[c + 1] === WALL) nw++; if (x > 0 && grid[c - 1] === WALL) nw++;
      if (y < H - 1 && grid[c + W] === WALL) nw++; if (y > 0 && grid[c - W] === WALL) nw++;
      if (nw > 0 && rng.chance(0.12 * params.decorDensity)) {
        mossMask[c] = 1; props.push({ kind: 'moss', x, y, rot: rng.f(0, 6.28), scale: rng.f(0.6, 1.3) });
      }
    }
  }
  if (FLAGS.bones) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = idx(x, y);
      if (grid[c] !== FLOOR || occ[c] || doorway[c] || corridor[c]) continue;
      const rid = roomId[c];
      if (rid >= 0 && rooms[rid].depth > 1 && rng.chance(0.018 + 0.02 * params.decorDensity))
        props.push({ kind: 'bones', x, y, rot: rng.f(0, 6.28), scale: rng.f(0.8, 1.2), roomId: rid });
    }
  }
  for (const r of rooms) {
    if (r.type !== TYPE.ELITE && r.type !== TYPE.BOSS) continue;
    const cand = [];
    for (let y = Math.floor(r.cy - r.h / 2) - 1; y <= Math.ceil(r.cy + r.h / 2) + 1; y++)
      for (let x = Math.floor(r.cx - r.w / 2) - 1; x <= Math.ceil(r.cx + r.w / 2) + 1; x++) {
        if (!inB(x, y) || grid[idx(x, y)] !== WALL) continue;
        const d = floorDir(x, y);
        if (d && roomId[idx(x + d[0], y + d[1])] === r.id) cand.push({ x, y, dx: d[0], dy: d[1] });
      }
    for (let i = cand.length - 1; i > 0; i--) { const j = rng.i(0, i); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
    const placed = [];
    for (const s of cand) {
      if (placed.length >= (r.type === TYPE.BOSS ? 4 : 2)) break;
      let close = false;
      for (const p of placed) if (Math.max(Math.abs(p.x - s.x), Math.abs(p.y - s.y)) < 4) { close = true; break; }
      if (!close) { placed.push(s); props.push({ kind: 'banner', x: s.x, y: s.y, dx: s.dx, dy: s.dy, rot: 0, scale: 1 }); }
    }
  }

  const loops = edges.filter(e => e.isLoop).length;
  return {
    valid, params, seed, name: dungeonName(rng),
    W, H, grid, roomId, corridor, doorway, bfs, maxBfs,
    rooms, edges, entrance, boss, maxDepth,
    props, spawns, torches, pools, lakeCells, lakeMask,
    stats: { rooms: N, edges: edges.length, loops, critLen, floorTiles: floorTotal, reach, genMs: 0, attempts: 1 },
  };
}
