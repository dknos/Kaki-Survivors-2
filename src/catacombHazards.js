/**
 * Catacomb Hazards — environmental death traps scattered through the procedural
 * dungeon. Phase-timer machine ported from src/forestEnvHazards.js.
 *
 * Three archetypes, chosen for a stone dungeon + to cover distinct threat kinds:
 *   1. Spike Traps (burst / dodge)  — telegraph → strike → retract. One big hit
 *      per strike; source 'telegraph' so a dash i-frame is a clean, rewarded
 *      dodge (hero.js#_onPerfectDodge, de-duped so it can't spam).
 *   2. Flame Vents (timing gate)    — rhythmic off → sputter → burn cycle. DoT
 *      while the column is lit; cross during the dark phase.
 *   3. Miasma Pools (area denial)   — always-on poison gas. Continuous DoT +
 *      movement slow. Placed off-centre so there's always a walk-around.
 *
 * All three ALSO damage enemies, so the player can herd skeletons onto spikes /
 * through fire — the traps are a tactic, not just a tax.
 *
 * ── Placement invariant (keeps "hard" from becoming "broken") ────────────────
 * Hazards go ONLY on room-interior floor cells (layout.roomId >= 0), never on
 * corridor cells (roomId === -1), never on/adjacent-to a doorway, never
 * wall-adjacent. Corridors stay 100% clean, so the seeded entrance→boss path is
 * ALWAYS trap-free — completability is guaranteed with zero pathfinding. Within
 * a room, hazards take a minority of interior cells with min-spacing, so every
 * hazard has a walk-around and (spike/vent) a timed safe window.
 *
 * ── Slow channel ─────────────────────────────────────────────────────────────
 * Catacomb mode is its OWN tick branch (main.js) and does NOT run
 * tickStageHazards, so nothing else resets state.hero.hazardSlow there. This
 * module owns it in catacomb: reset to 1.0 at the top of every tick, then
 * MIN-stack pool slow. Restored to 1.0 on dispose.
 *
 * ── Damage gating ────────────────────────────────────────────────────────────
 * hero takeDamage() stamps 0.40s i-frames (config HERO.iFramesSec), so
 * continuous DoT (flame/miasma) effectively lands ~2.5x/s — per-tick numbers are
 * sized against that. A spike strike is a single burst, which the i-frame gate
 * handles perfectly (one hit per strike). Enemy DoT is self-gated per hazard.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────
 * buildCatacombHazards() runs once per descent AFTER buildDungeon. World cell
 * positions are seed-stable, and the hazard group is a child of the catacomb
 * container (_group) — a SIBLING of the build's own group — so the dress-later
 * _rebuildDungeon (which disposes only the build's group) leaves hazards intact,
 * exactly like the exit stairs. disposeCatacombHazards() on exit + reset.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { tex } from './particleTextures.js';
import { floorDecalGeometry, floorDecalMaterial, applyFloorTier, FLOOR_TIER } from './fxLayers.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { damageEnemy } from './enemies.js';
import { mulberry32, TYPE } from './dungeonGen.js';

// ── tuning ───────────────────────────────────────────────────────────────────
// Spikes — burst hit, dash-dodgeable.
const SPIKE_R = 1.05;             // strike hit radius (tile is CELL=2u wide)
const SPIKE_DMG = 22;             // hero burst (22% of 100 hpMax)
const SPIKE_ENEMY_DMG = 24;
const SPIKE_IDLE0 = 2.0, SPIKE_IDLE1 = 3.6;
const SPIKE_ARM = 0.75;           // telegraph window
const SPIKE_STRIKE = 0.30;        // spikes up — damage frame
const SPIKE_RETRACT = 0.30;

// Flame vents — rhythmic timing gate.
const VENT_R = 1.15;
const VENT_DMG = 7;               // per landed hero tick (~2.5/s after i-frames)
const VENT_ENEMY_DPS = 14;
const VENT_OFF0 = 2.1;            // dark phase (crossing window)
const VENT_SPUTTER = 0.6;         // telegraph
const VENT_BURN = 1.5;            // lit — DoT
const VENT_SUBTICK = 0.2;

// Miasma pools — always-on area denial.
const POOL_R = 1.7;
const POOL_DMG = 5;               // per landed hero subtick
const POOL_ENEMY_DPS = 8;
const POOL_SLOW = 0.55;           // hero move multiplier while inside
const POOL_SUBTICK = 0.25;

// Dungeon-wide caps (perf).
const MAX_SPIKES = 34, MAX_VENTS = 12, MAX_POOLS = 8;

// ── module state ─────────────────────────────────────────────────────────────
let _group = null;
let _loaded = false;
const _spikes = [];
const _vents = [];
const _pools = [];
let _coneGeo = null;              // shared spike geometry (reused across descents)

function _spikeGeo() {
  if (!_coneGeo) _coneGeo = new THREE.ConeGeometry(0.30, 1.0, 6).translate(0, 0.5, 0);
  return _coneGeo;
}

// ── build / placement ────────────────────────────────────────────────────────
export function buildCatacombHazards(layout, build, parentGroup, seed) {
  disposeCatacombHazards();
  if (!layout || !build || !parentGroup) return;

  const g = new THREE.Group();
  g.name = 'catacombHazards';
  parentGroup.add(g);
  _group = g;

  const rng = mulberry32(((seed >>> 0) ^ 0x00CA7A5E) >>> 0);
  const W = build.W, H = build.H;

  // Doorway cells (+1 ring) → hard-exclude so traps never gate a passage.
  const doorSet = new Set();
  for (const dc of build.doorwayCells) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      doorSet.add((dc.y + oy) * W + (dc.x + ox));
    }
  }

  for (const r of layout.rooms) {
    const isCombat = r.type === TYPE.COMBAT;
    const isElite = r.type === TYPE.ELITE;
    const isBoss = r.type === TYPE.BOSS;
    if (!isCombat && !isElite && !isBoss) continue;

    // Interior candidate cells belonging to THIS room (not corridor/other room).
    const cand = [];
    const hw = r.w >> 1, hh = r.h >> 1;
    const x0 = Math.max(1, r.cx - hw), x1 = Math.min(W - 2, r.cx + hw);
    const y0 = Math.max(1, r.cy - hh), y1 = Math.min(H - 2, r.cy + hh);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (layout.roomId[cy * W + cx] !== r.id) continue;
        if (!build.walkable(cx, cy)) continue;
        if (doorSet.has(cy * W + cx)) continue;
        // Wall-margin: every 4-neighbour walkable → interior cell with a lane.
        if (!build.walkable(cx - 1, cy) || !build.walkable(cx + 1, cy)
          || !build.walkable(cx, cy - 1) || !build.walkable(cx, cy + 1)) continue;
        cand.push(cx | 0);
        cand.push(cy | 0);
      }
    }
    if (cand.length < 8) continue;   // < 4 cells — too small to trap fairly

    // Seeded Fisher-Yates over the (cx,cy) pairs.
    for (let i = (cand.length >> 1) - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const ai = i * 2, aj = j * 2;
      const tx = cand[ai], ty = cand[ai + 1];
      cand[ai] = cand[aj]; cand[ai + 1] = cand[aj + 1];
      cand[aj] = tx; cand[aj + 1] = ty;
    }

    // Budgets scale with room role. Boss = a hazard arena.
    let spikeBudget = isBoss ? 8 : isElite ? 5 : 3;
    let ventBudget = isBoss ? 3 : isElite ? 2 : (r.w >= 12 ? 1 : 0);
    let poolBudget = isBoss ? 2 : isElite ? 1 : (r.w >= 13 && rng() < 0.6 ? 1 : 0);

    const placed = [];   // [cx,cy,...] — min-spacing across all archetypes
    const spacingOk = (cx, cy, mind) => {
      const m2 = mind * mind;
      for (let k = 0; k < placed.length; k += 2) {
        const dx = placed[k] - cx, dy = placed[k + 1] - cy;
        if (dx * dx + dy * dy < m2) return false;
      }
      return true;
    };

    for (let p = 0; p < cand.length; p += 2) {
      const cx = cand[p], cy = cand[p + 1];
      // Pools first (biggest footprint, must sit off-centre for a walk-around).
      if (poolBudget > 0 && _pools.length < MAX_POOLS) {
        const dcx = cx - r.cx, dcy = cy - r.cy;
        if (dcx * dcx + dcy * dcy >= 4 && spacingOk(cx, cy, 4)) {
          _addPool(build, cx, cy); placed.push(cx, cy); poolBudget--; continue;
        }
      }
      if (ventBudget > 0 && _vents.length < MAX_VENTS && spacingOk(cx, cy, 3)) {
        _addVent(build, cx, cy, rng); placed.push(cx, cy); ventBudget--; continue;
      }
      if (spikeBudget > 0 && _spikes.length < MAX_SPIKES && spacingOk(cx, cy, 2)) {
        _addSpike(build, cx, cy, rng); placed.push(cx, cy); spikeBudget--; continue;
      }
      if (spikeBudget <= 0 && ventBudget <= 0 && poolBudget <= 0) break;
    }
  }

  _loaded = (_spikes.length + _vents.length + _pools.length) > 0;
}

// ── builders ─────────────────────────────────────────────────────────────────
function _addSpike(build, cx, cy, rng) {
  const w = build.cellToWorld(cx, cy);
  const x = w.x, z = w.z;                 // read now (cellToWorld reuses one obj)
  const grp = new THREE.Group();
  grp.position.set(x, 0, z);

  const decal = new THREE.Mesh(
    floorDecalGeometry(1.7),
    floorDecalMaterial({ map: tex('glowGold') || tex('glowWhite'), color: 0xffb43a, opacity: 0 }),
  );
  decal.position.y = 0.04;
  applyFloorTier(decal, 'telegraph');     // negative renderOrder → under hero
  grp.add(decal);

  const mat = new THREE.MeshStandardMaterial({
    color: 0x9aa4b0, roughness: 0.4, metalness: 0.75,
    emissive: 0xffb43a, emissiveIntensity: 0,
  });
  const cones = [];
  const offs = [[0, 0], [0.42, 0.30], [-0.40, 0.34]];
  for (const [ox, oz] of offs) {
    const m = new THREE.Mesh(_spikeGeo(), mat);
    m.position.set(ox, -1.1, oz);         // buried at rest
    m.castShadow = true;
    grp.add(m); cones.push(m);
  }

  _group.add(grp);
  _spikes.push({
    x, z, grp, decal, cones, mat,
    phase: 0, t: rng() * (SPIKE_IDLE1),   // desync so a field ripples
    idle: SPIKE_IDLE0 + rng() * (SPIKE_IDLE1 - SPIKE_IDLE0),
    hitSet: new Set(),
  });
}

function _addVent(build, cx, cy, rng) {
  const w = build.cellToWorld(cx, cy);
  const x = w.x, z = w.z;
  const grp = new THREE.Group();
  grp.position.set(x, 0, z);

  // Ground scorch ring — its top-down puddle texture reads correctly flat.
  const decalMat = floorDecalMaterial({
    map: tex('lavaPuddle') || tex('glowGold'), color: 0xff7a24, opacity: 0.14,
  });
  const decal = new THREE.Mesh(floorDecalGeometry(2.0), decalMat);
  decal.position.y = 0.05;
  applyFloorTier(decal, 'telegraph');
  grp.add(decal);

  // Fire column — a fan of upward flame tongues (hot additive), fuller + taller
  // than a single billboard so it reads as fire from the iso angle.
  const colMat = new THREE.MeshBasicMaterial({
    map: tex('emberWarm') || tex('glowGold') || tex('lavaPuddle'),
    color: 0xff5a12, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const col = new THREE.Group();
  for (let k = 0; k < 4; k++) {
    const pw = 1.5 - k * 0.14, ph = 2.7 - k * 0.18;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), colMat);
    pl.position.y = ph * 0.5;
    pl.rotation.y = k * (Math.PI / 4);
    pl.layers.enable(BLOOM_LAYER);
    col.add(pl);
  }
  col.scale.y = 0.2;
  grp.add(col);

  _group.add(grp);
  _vents.push({
    x, z, grp, column: col, colMat, decalMat,
    phase: 0, t: rng() * VENT_OFF0,       // desync
    off: VENT_OFF0 + rng() * 1.2,
    heroTickAt: -1, enemyTickAt: -1,
  });
}

function _addPool(build, cx, cy) {
  const w = build.cellToWorld(cx, cy);
  const x = w.x, z = w.z;
  const grp = new THREE.Group();
  grp.position.set(x, 0, z);

  // Murky base stain — NORMAL blend so it visibly DARKENS the light floor into
  // a sickly puddle (additive-only washed out on the pale stone). No bloom.
  const stain = new THREE.Mesh(
    floorDecalGeometry(POOL_R * 2.3),
    new THREE.MeshBasicMaterial({
      map: tex('cheeseToxic') || tex('glowWhite'), color: 0x1e3a10,
      transparent: true, opacity: 0.72, depthWrite: false,
      blending: THREE.NormalBlending, side: THREE.DoubleSide,
    }),
  );
  stain.position.y = 0.025;
  stain.renderOrder = FLOOR_TIER.telegraph;   // under hero; no bloom (stays dark)
  grp.add(stain);

  // Toxic glow rim on top — additive bright green, pulses.
  const rimMat = floorDecalMaterial({ map: tex('cheeseToxic') || tex('glowWhite'), color: 0x9cff3a, opacity: 0.5 });
  const rim = new THREE.Mesh(floorDecalGeometry(POOL_R * 1.9), rimMat);
  rim.position.y = 0.045;
  applyFloorTier(rim, 'telegraph');
  grp.add(rim);

  const fmap = tex('smokeGray') || tex('glowWhite');
  const fog = [];
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 2.2),
      new THREE.MeshBasicMaterial({
        map: fmap, color: 0x8aff4a, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    f.position.set((Math.random() - 0.5) * 1.0, 0.55 + i * 0.32, (Math.random() - 0.5) * 1.0);
    f.rotation.y = Math.random() * Math.PI;
    f.userData = { base: 0.30 - i * 0.04, spin: (Math.random() - 0.5) * 0.4, ph: Math.random() * 6.28 };
    f.layers.enable(BLOOM_LAYER);
    grp.add(f); fog.push(f);
  }

  _group.add(grp);
  _pools.push({ x, z, grp, fog, rimMat, heroTickAt: -1, enemyTickAt: -1 });
}

// ── per-frame tick ───────────────────────────────────────────────────────────
export function tickCatacombHazards(dt) {
  if (!_loaded || state.mode !== 'catacomb') return;
  const now = state.time.game;
  const h = state.hero.pos;
  const hx = h.x, hz = h.z;

  // This module owns hazardSlow in catacomb (nothing else resets it here).
  state.hero.hazardSlow = 1.0;

  for (let i = 0; i < _spikes.length; i++) _tickSpike(_spikes[i], dt, hx, hz, now);
  for (let i = 0; i < _vents.length; i++) _tickVent(_vents[i], dt, hx, hz, now);
  for (let i = 0; i < _pools.length; i++) _tickPool(_pools[i], dt, hx, hz, now);
}

function _tickSpike(s, dt, hx, hz, now) {
  s.t += dt;
  if (s.phase === 0) {                                  // IDLE
    if (s.decal.material.opacity !== 0) s.decal.material.opacity = 0;
    if (s.t >= s.idle) { s.phase = 1; s.t = 0; }
  } else if (s.phase === 1) {                           // ARM (telegraph)
    const k = s.t / SPIKE_ARM;
    s.decal.material.opacity = 0.25 + 0.55 * k * (0.7 + 0.3 * Math.sin(now * 30));
    s.mat.emissiveIntensity = 0.35 * k;
    for (let c = 0; c < s.cones.length; c++) s.cones[c].position.y = -1.1 + 0.18 * k;
    if (s.t >= SPIKE_ARM) { s.phase = 2; s.t = 0; s.hitSet.clear(); }
  } else if (s.phase === 2) {                           // STRIKE (damage frame)
    for (let c = 0; c < s.cones.length; c++) s.cones[c].position.y = 0;
    s.mat.emissiveIntensity = 0.6;
    s.decal.material.opacity = 0.7;
    _spikeDamage(s, hx, hz);
    if (s.t >= SPIKE_STRIKE) { s.phase = 3; s.t = 0; }
  } else {                                              // RETRACT
    const k = Math.max(0, 1 - s.t / SPIKE_RETRACT);
    for (let c = 0; c < s.cones.length; c++) s.cones[c].position.y = -1.1 + 1.1 * k;
    s.decal.material.opacity = 0.5 * k;
    s.mat.emissiveIntensity = 0.3 * k;
    if (s.t >= SPIKE_RETRACT) {
      s.phase = 0; s.t = 0;
      s.idle = SPIKE_IDLE0 + Math.random() * (SPIKE_IDLE1 - SPIKE_IDLE0);
    }
  }
}

function _spikeDamage(s, hx, hz) {
  const dx = hx - s.x, dz = hz - s.z;
  if (dx * dx + dz * dz <= SPIKE_R * SPIKE_R) {
    try { heroTakeDamage(SPIKE_DMG, 'telegraph'); } catch (_) {}   // i-frames = one hit/strike
  }
  const act = state.enemies.active;
  for (let i = 0; i < act.length; i++) {
    const e = act[i];
    if (!e || !e.alive || !e.mesh) continue;
    const ep = e.mesh.position;
    const ex = ep.x - s.x, ez = ep.z - s.z;
    if (ex * ex + ez * ez > SPIKE_R * SPIKE_R) continue;
    if (s.hitSet.has(e)) continue;
    s.hitSet.add(e);
    try { damageEnemy(e, SPIKE_ENEMY_DMG, 'catacombHazard'); } catch (_) {}
  }
}

function _tickVent(v, dt, hx, hz, now) {
  v.t += dt;
  if (v.phase === 0) {                                  // OFF (crossing window)
    v.colMat.opacity = 0;
    v.decalMat.opacity = 0.10 + 0.05 * Math.sin(now * 3);
    if (v.t >= v.off) { v.phase = 1; v.t = 0; }
  } else if (v.phase === 1) {                           // SPUTTER (telegraph)
    const k = v.t / VENT_SPUTTER;
    v.colMat.opacity = 0.18 * k * (0.5 + 0.5 * Math.sin(now * 42));
    v.column.scale.y = 0.2 + 0.25 * k;
    v.decalMat.opacity = 0.3 + 0.4 * k;
    if (v.t >= VENT_SPUTTER) { v.phase = 2; v.t = 0; v.heroTickAt = -1; v.enemyTickAt = now - 1; }
  } else {                                              // BURN (DoT)
    v.colMat.opacity = 0.85 + 0.15 * Math.sin(now * 22);
    v.column.scale.y = 1.05 + 0.14 * Math.sin(now * 18);
    v.decalMat.opacity = 0.75;
    _ventDamage(v, hx, hz, now);
    if (v.t >= VENT_BURN) { v.phase = 0; v.t = 0; v.off = VENT_OFF0 + Math.random() * 1.2; }
  }
}

function _ventDamage(v, hx, hz, now) {
  const dx = hx - v.x, dz = hz - v.z;
  if (dx * dx + dz * dz <= VENT_R * VENT_R && now - v.heroTickAt >= VENT_SUBTICK) {
    v.heroTickAt = now;
    try { heroTakeDamage(VENT_DMG, 'telegraph'); } catch (_) {}
  }
  if (now - v.enemyTickAt >= VENT_SUBTICK) {
    v.enemyTickAt = now;
    const dmg = VENT_ENEMY_DPS * VENT_SUBTICK;
    const act = state.enemies.active;
    for (let i = 0; i < act.length; i++) {
      const e = act[i];
      if (!e || !e.alive || !e.mesh) continue;
      const ep = e.mesh.position;
      const ex = ep.x - v.x, ez = ep.z - v.z;
      if (ex * ex + ez * ez > VENT_R * VENT_R) continue;
      try { damageEnemy(e, dmg, 'catacombHazard'); } catch (_) {}
    }
  }
}

function _tickPool(p, dt, hx, hz, now) {
  if (p.rimMat) p.rimMat.opacity = 0.4 + 0.18 * Math.sin(now * 2.2);
  for (let i = 0; i < p.fog.length; i++) {
    const f = p.fog[i];
    f.rotation.z += dt * f.userData.spin;
    f.material.opacity = f.userData.base * (0.7 + 0.3 * Math.sin(now * 1.5 + f.userData.ph));
  }
  const dx = hx - p.x, dz = hz - p.z;
  if (dx * dx + dz * dz <= POOL_R * POOL_R) {
    if (POOL_SLOW < state.hero.hazardSlow) state.hero.hazardSlow = POOL_SLOW;   // MIN-stack
    if (now - p.heroTickAt >= POOL_SUBTICK) {
      p.heroTickAt = now;
      try { heroTakeDamage(POOL_DMG); } catch (_) {}   // no source — not a "dodge"
    }
  } else {
    p.heroTickAt = now - POOL_SUBTICK;                 // arm a full-cost first tick on re-entry
  }
  if (now - p.enemyTickAt >= POOL_SUBTICK) {
    p.enemyTickAt = now;
    const dmg = POOL_ENEMY_DPS * POOL_SUBTICK;
    const act = state.enemies.active;
    for (let i = 0; i < act.length; i++) {
      const e = act[i];
      if (!e || !e.alive || !e.mesh) continue;
      const ep = e.mesh.position;
      const ex = ep.x - p.x, ez = ep.z - p.z;
      if (ex * ex + ez * ez > POOL_R * POOL_R) continue;
      try { damageEnemy(e, dmg, 'catacombHazard'); } catch (_) {}
    }
  }
}

// ── teardown ─────────────────────────────────────────────────────────────────
function _disposeGroup(o) {
  o.traverse((n) => {
    if (n.isMesh) {
      if (n.geometry && n.geometry !== _coneGeo) { try { n.geometry.dispose(); } catch (_) {} }
      if (n.material) { try { n.material.dispose(); } catch (_) {} }
    }
  });
  if (o.parent) o.parent.remove(o);
}

export function disposeCatacombHazards() {
  for (let i = 0; i < _spikes.length; i++) _disposeGroup(_spikes[i].grp);
  for (let i = 0; i < _vents.length; i++) _disposeGroup(_vents[i].grp);
  for (let i = 0; i < _pools.length; i++) _disposeGroup(_pools[i].grp);
  _spikes.length = 0;
  _vents.length = 0;
  _pools.length = 0;
  if (_group && _group.parent) _group.parent.remove(_group);
  _group = null;
  _loaded = false;
  if (state.hero) state.hero.hazardSlow = 1.0;   // don't leak slow into run mode
}
