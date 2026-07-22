/**
 * Bullet-hell foes. Deliberately NOT state.enemies — the survivors spawn
 * director, xp gems, and weapon target loops never see these. Simple glowing
 * primitives whose job is to be pattern emitters; the bullets are the enemy.
 *
 * Every archetype fires through a WINDUP (emissive ramp + scale swell,
 * 0.4-0.6s) so volleys are readable, and every spawn is telegraphed by a
 * glowing ground rune ring before the foe materializes. Kills pay out:
 * explosion + sfx + hitstop + nearby-bullet cancel.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { takeDamage as heroTakeDamage } from '../hero.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { sfx, setMusicTier } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';
import { floorDecalMaterial } from '../fxLayers.js';
import { spawnImpactBurst, burstExplosion } from '../vfxBurst.js';
import { spawnAoeNova } from '../fx/aoeNova.js';
import { bh, ARENA_CX, ARENA_CZ, ARENA_R } from './bhState.js';
import { notifyBh } from './announcer.js';
import { fireBossPattern } from './bossPatterns.js';
import {
  spawnBullet, patternRing, patternRingWithGap, patternDoubleRing,
  patternAimedFan, patternSpiralStep, patternBulletWall, patternEdgeRain,
  cancelBulletsNear,
} from './bullets.js';

const CONTACT_R = 1.2;
const CONTACT_DMG = 18;

// Per-biome boss materialize nova (texName, tint) indexed by bh.level. Order
// mirrors the LEVELS table in index.js: astral → molten → frost → gilded.
const BOSS_NOVA = [
  ['aoe_void',  0xc79bff],
  ['aoe_fire',  0xff8a3a],
  ['aoe_frost', 0x9adcff],
  ['aoe_holy',  0xffd86b],
];
const BOSS_TINT = [0xc79bff, 0xff7a3a, 0x9adcff, 0xffd86b];
export const BOSS_SPRITE_NAMES = ['foe_boss_velvet', 'foe_boss_cinder', 'foe_boss_frost', 'foe_boss_gold'];

// Generated creature art per archetype (assets/fx/foes/foe_*.webp). Regular
// emitters are bright-on-black additive energy beings; the four larger bosses
// ship with true alpha and use NormalBlending so their cat details stay intact.
// A sprite that has not loaded still falls back to its primitive geometry.
const FOE_SPRITE = {
  drifter: 'foe_drifter', spinner: 'foe_spinner', gunner: 'foe_gunner',
  sniper: 'foe_sniper', rimcaster: 'foe_rimcaster', wallmaker: 'foe_wallmaker',
  turret: 'foe_turret', splitter: 'foe_splitter', charger: 'foe_charger',
  weaver: 'foe_weaver', bomber: 'foe_bomber', warden: 'foe_warden',
};
const _foeTex = new Map();   // sprite name -> THREE.Texture (only successful loads)
const _foeLoading = new Set();
function _loadFoeSprite(name, loader) {
  if (_foeTex.has(name) || _foeLoading.has(name)) return;
  _foeLoading.add(name);
  loader.load(`assets/fx/foes/${name}.webp`,
    (tex) => { tex.colorSpace = THREE.SRGBColorSpace; _foeTex.set(name, tex); _foeLoading.delete(name); },
    undefined,
    () => { _foeLoading.delete(name); /* absent → primitive fallback */ });
}

export function preloadBossSprite(level) {
  const idx = Math.max(0, Math.min(3, level | 0));
  _loadFoeSprite(BOSS_SPRITE_NAMES[idx], new THREE.TextureLoader());
}

function _preloadFoeSprites() {
  const L = new THREE.TextureLoader();
  for (const name of new Set(Object.values(FOE_SPRITE))) _loadFoeSprite(name, L);
  // Boss sprites are 512² alpha art (~1 MiB decoded each). Keep only the
  // current biome warm; later bosses load on biome transition, four waves
  // before they can appear, instead of adding ~4 MiB to every short attempt.
  _loadFoeSprite(BOSS_SPRITE_NAMES[Math.max(0, Math.min(3, bh.level | 0))], L);
}

const _foes = [];
const _pending = [];    // spawn telegraphs: {type,x,z,hpScale,opts,t,dur,ring}
const _chainFx = [];    // scheduled boss-death explosion chain: {x,z,t,color}
let _group = null;
let _runeTex = null;    // cached rune-ring texture, shared by spawn telegraphs

// Emitter cooldowns divide by the per-wave emit-rate mod.
function _cd(sec) { return sec / ((bh.mods && bh.mods.emitRateMul) || 1); }

// Archetypes. tint doubles as the body emissive so the foe's color matches
// the bullets it fires (same color language as bullets.js).
//
// Contract per def:
//   windup   — pre-fire telegraph seconds (emissive ramp + scale swell)
//   cooldown — rest window between volleys (rhythm = readability)
//   move(f, dt)  — optional movement
//   fire(f)      — called ONCE when the windup completes; may start a burst
//                  by setting f.burst / f.burstGap / f.burstFn
const TYPES = {
  drifter: {   // slow approach, periodic ring (doubleRing past wave 10)
    hp: 30, r: 1.0, tint: 0xff5e8a, geo: () => new THREE.IcosahedronGeometry(0.9, 0),
    windup: 0.45, cooldown: 2.2,
    move(f, dt) { _seekHero(f, 2.2, dt); },
    fire(f) {
      if (bh.wave >= 11) patternDoubleRing(f.x, f.z, 12, 6.5, f.phase);
      else patternRing(f.x, f.z, 14, 6.5, f.phase);
      f.phase += 0.35;
    },
  },
  spinner: {   // orbits arena center; DISCRETE spiral volleys with rest windows
    hp: 45, r: 1.0, tint: 0xb98aff, geo: () => new THREE.OctahedronGeometry(1.0, 0),
    windup: 0.4, cooldown: 1.7,
    move(f, dt) {
      f.orbitA += dt * 0.35 * f.dir;
      f.x = ARENA_CX + Math.cos(f.orbitA) * f.orbitR;
      f.z = ARENA_CZ + Math.sin(f.orbitA) * f.orbitR;
    },
    fire(f) {
      f.burst = 8; f.burstGap = 0.09;
      f.burstFn = (g) => { patternSpiralStep(g.x, g.z, g.phase, 3, 5.5); g.phase += 0.42 * g.dir; };
    },
  },
  gunner: {    // keeps distance, bursts of aimed fans
    hp: 35, r: 0.9, tint: 0xffc24a, geo: () => new THREE.ConeGeometry(0.7, 1.6, 6),
    windup: 0.5, cooldown: 2.4,
    move(f, dt) { _keepRange(f, 12, 3.2, dt); },
    fire(f) {
      f.burst = 3; f.burstGap = 0.28;
      f.burstFn = (g) => patternAimedFan(g.x, g.z, 3, 10, 0.45);
    },
  },
  sniper: {    // hangs back, RED LINE telegraph, then one very fast bullet
    hp: 28, r: 0.9, tint: 0xff4a4a, geo: () => new THREE.TetrahedronGeometry(1.0, 0),
    windup: 0.6, cooldown: 2.8, lineTele: true,
    move(f, dt) { _keepRange(f, 16, 2.6, dt); },
    fire(f) {
      // Fire along the LOCKED telegraph angle (captured at windup start) —
      // the red line is a promise, not a tracking beam.
      const a = f.aimA || 0;
      spawnBullet(f.x, f.z, Math.cos(a) * 20, Math.sin(a) * 20, 'snipe');
    },
  },
  rimcaster: { // hugs the rim, calls edge rain down over the whole arena
    hp: 40, r: 1.0, tint: 0x7fd8ff, geo: () => new THREE.DodecahedronGeometry(0.9, 0),
    windup: 0.55, cooldown: 3.2,
    move(f, dt) {
      f.orbitA += dt * 0.22 * f.dir;
      f.x = ARENA_CX + Math.cos(f.orbitA) * (ARENA_R - 3);
      f.z = ARENA_CZ + Math.sin(f.orbitA) * (ARENA_R - 3);
    },
    fire() { patternEdgeRain(10, 5.5); },
  },
  wallmaker: { // stationary near the rim; sweeps a bullet wall with a moving gap
    hp: 60, r: 1.2, tint: 0xb98aff, geo: () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
    windup: 0.6, cooldown: 4.0,
    fire(f) {
      // Wall travels from the foe's side across the arena; gap drifts per shot.
      const a = Math.atan2(ARENA_CZ - f.z, ARENA_CX - f.x);
      f.gapT = (f.gapT === undefined ? Math.random() : f.gapT + 0.27) % 1;
      patternBulletWall(a, 5.2, f.gapT, 5.0);
    },
  },
  turret: {    // stationary anchor — alternates gap-rings and REVERSING spirals
    hp: 120, r: 1.4, tint: 0x7fd8ff, geo: () => new THREE.TorusKnotGeometry(0.8, 0.28, 48, 8),
    windup: 0.5, cooldown: 2.0,
    move(f, dt) { if (f.mesh) f.mesh.rotation.y += dt * 1.4; },
    fire(f) {
      f.alt = (f.alt || 0) + 1;
      if (f.alt % 2 === 1) {
        // Three pulsed rings with a safe lane pointed NEAR the hero (dodge read).
        const h = state.hero.pos;
        const gap = Math.atan2(h.z - f.z, h.x - f.x) + (Math.random() - 0.5) * 0.9;
        f.burst = 3; f.burstGap = 0.24;
        f.burstFn = (g) => { patternRingWithGap(g.x, g.z, 18, 5.4, gap, 0.9, g.phase, 'rain'); g.phase += 0.17; };
      } else {
        // Reversing spiral: direction flips each volley.
        f.dir *= -1;
        f.burst = 10; f.burstGap = 0.08;
        f.burstFn = (g) => { patternSpiralStep(g.x, g.z, g.phase, 4, 4.8, 'rain'); g.phase += 0.31 * g.dir; };
      }
    },
  },
  // ── Track-B archetypes (enter waves 12-19, then the remix pool) ───────────
  splitter: {  // ring emitter that FRACTURES into 2 fast minis on death (no re-split)
    hp: 44, r: 1.1, tint: 0xff5ea0, geo: () => new THREE.OctahedronGeometry(1.05, 0),
    windup: 0.45, cooldown: 2.4, split: 2,
    move(f, dt) { _seekHero(f, f.noSplit ? 3.8 : 1.9, dt); },   // minis are quicker
    fire(f) {
      if (f.noSplit) patternAimedFan(f.x, f.z, 3, 8.5, 0.4);    // minis spit a tight fan
      else { patternRing(f.x, f.z, 12, 6.0, f.phase); f.phase += 0.3; }
    },
  },
  charger: {   // holds at range, RED-LINE telegraph, then DASHES along the locked line
    hp: 40, r: 1.1, tint: 0xff8a3a, geo: () => new THREE.ConeGeometry(0.85, 1.9, 4),
    windup: 0.7, cooldown: 2.6, lineTele: true,
    move(f, dt) {
      if (f.dashT > 0) { f.dashT -= dt; f.x += f.dashVX * dt; f.z += f.dashVZ * dt; }
      else _keepRange(f, 12, 2.6, dt);
    },
    fire(f) {
      // Launch along the LOCKED telegraph angle — the red line was the promise.
      const a = f.aimA || 0;
      f.dashVX = Math.cos(a) * 30; f.dashVZ = Math.sin(a) * 30; f.dashT = 0.55;
      patternAimedFan(f.x, f.z, 3, 9, 0.5);    // a spray on launch so it isn't a pure body-check
    },
  },
  weaver: {    // orbits, laces the arena with a REVERSING double spiral
    hp: 42, r: 1.0, tint: 0x9adcff, geo: () => new THREE.IcosahedronGeometry(1.0, 1),
    windup: 0.4, cooldown: 1.6,
    move(f, dt) {
      f.orbitA += dt * 0.4 * f.dir;
      f.x = ARENA_CX + Math.cos(f.orbitA) * f.orbitR;
      f.z = ARENA_CZ + Math.sin(f.orbitA) * f.orbitR;
    },
    fire(f) {
      f.dir *= -1;                             // whole weave reverses each volley
      f.burst = 14; f.burstGap = 0.06;
      f.burstFn = (g) => {
        patternSpiralStep(g.x, g.z, g.phase, 2, 5.2, 'spiral');
        patternSpiralStep(g.x, g.z, g.phase + Math.PI, 2, 5.2, 'spiral');
        g.phase += 0.34 * g.dir;
      };
    },
  },
  bomber: {    // lobs a delayed-detonation SEED where the hero stands — blossoms outward
    hp: 44, r: 1.1, tint: 0xffc24a, geo: () => new THREE.ConeGeometry(0.8, 1.5, 8),
    windup: 0.55, cooldown: 3.4,
    move(f, dt) { _keepRange(f, 13, 2.2, dt); },
    fire(f) {
      const h = state.hero.pos;
      // Two nested rings planted at the hero's CURRENT cell, frozen dim (the
      // "seed"), then they blossom outward after the delay — walk off the seed.
      patternRing(h.x, h.z, 10, 4.6, Math.random() * Math.PI * 2, 'aimed',  { delay: 1.0 });
      patternRing(h.x, h.z, 14, 7.2, Math.random() * Math.PI * 2, 'spiral', { delay: 1.15 });
    },
  },
  warden: {    // slow tanky anchor behind a shield bubble; sweeps double rings
    hp: 70, r: 1.4, tint: 0xffd06a, geo: () => new THREE.DodecahedronGeometry(1.2, 0),
    windup: 0.6, cooldown: 3.0, shield: 120,
    move(f, dt) { _seekHero(f, 1.1, dt); },     // creeps in — can't be ignored forever
    fire(f) {
      f.burst = 2; f.burstGap = 0.5;
      f.burstFn = (g) => { patternDoubleRing(g.x, g.z, 16, 5.6, g.phase); g.phase += 0.3; };
    },
  },
  boss: {      // every-5th-wave centerpiece — phases swap pattern sets at hp thresholds
    boss: true,
    hp: 900, r: 2.2, tint: 0xff5e8a, geo: () => new THREE.TorusKnotGeometry(1.6, 0.5, 64, 10),
    windup: 0.5, cooldown: 1.5,
    move(f, dt) {
      const level = Math.max(0, Math.min(3, bh.level | 0));
      const speeds = [0.17, 0.11, 0.20, 0.15];
      const radii = [9.0, 7.5, 10.5, 9.5];
      f.orbitA += dt * speeds[level] * f.dir;
      f.x = ARENA_CX + Math.cos(f.orbitA) * radii[level];
      f.z = ARENA_CZ + Math.sin(f.orbitA) * radii[level];
      if (f.mesh) f.mesh.rotation.y += dt * 0.9;
    },
    fire: fireBossPattern,
  },
};

function _seekHero(f, speed, dt) {
  const h = state.hero.pos;
  const dx = h.x - f.x, dz = h.z - f.z;
  const d = Math.hypot(dx, dz) || 1;
  f.x += (dx / d) * speed * dt;
  f.z += (dz / d) * speed * dt;
}

function _keepRange(f, range, speed, dt) {
  const h = state.hero.pos;
  const dx = h.x - f.x, dz = h.z - f.z;
  const d = Math.hypot(dx, dz) || 1;
  const dir = d > range + 1 ? 1 : (d < range - 1 ? -1 : 0);
  f.x += (dx / d) * speed * dir * dt;
  f.z += (dz / d) * speed * dir * dt;
  // strafe so gunners don't stack on one radius line
  f.x += (-dz / d) * speed * 0.5 * f.dir * dt;
  f.z += (dx / d) * speed * 0.5 * f.dir * dt;
}

export function initFoes(scene) {
  _group = new THREE.Group();
  _group.userData.kkBulletHell = true;
  scene.add(_group);
  _foes.length = 0;
  _pending.length = 0;
  _chainFx.length = 0;
  _preloadFoeSprites();
}

/**
 * Queue a foe spawn. A glowing ground rune telegraphs the position for
 * opts.telegraph seconds (default 0.6) before the foe materializes — spawns
 * never pop into existence next to the hero (index.js also forbids picking
 * spots within 6u of the hero).
 * opts: { telegraph: sec, name: bossDisplayName }
 */
export function spawnFoe(type, x, z, hpScale = 1, opts = null) {
  const def = TYPES[type];
  if (!def || !_group) return null;
  const dur = (opts && opts.telegraph !== undefined) ? opts.telegraph : 0.6;
  if (dur <= 0) return _materializeFoe(type, x, z, hpScale, opts);
  if (!_runeTex) _runeTex = makeRuneRingTexture();
  const size = def.boss ? 7 : 3.2;
  const tint = def.boss ? BOSS_TINT[Math.max(0, Math.min(3, bh.level | 0))] : def.tint;
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    floorDecalMaterial({ map: _runeTex, color: tint, opacity: 0 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.04, z);
  ring.layers.enable(BLOOM_LAYER);
  _group.add(ring);
  _pending.push({ type, x, z, hpScale, opts, t: 0, dur, ring });
  bh.foesAlive = _foes.length + _pending.length;
  return null;
}

function _materializeFoe(type, x, z, hpScale, opts) {
  const def = TYPES[type];
  const level = Math.max(0, Math.min(3, bh.level | 0));
  const tint = def.boss ? BOSS_TINT[level] : def.tint;
  const isMini = !!(opts && opts.noSplit);   // splitter fragment — smaller, faster, no re-split
  // The foe root carries the body (sprite OR primitive), aura, and optional
  // shield. Boss alpha art uses normal blending; regular energy beings remain
  // additive. Both fall back to an emissive primitive on a cold/failed load.
  const sname = def.boss ? BOSS_SPRITE_NAMES[level] : FOE_SPRITE[type];
  const stex = sname ? _foeTex.get(sname) : null;
  const mesh = new THREE.Group();
  mesh.position.set(x, 1.1, z);
  let body, bodyMat;
  const isSprite = !!stex;
  if (isSprite) {
    bodyMat = new THREE.SpriteMaterial({
      map: stex, color: 0xffffff, transparent: true,
      depthWrite: false, blending: def.boss ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    body = new THREE.Sprite(bodyMat);
    // Sprite world size ~ archetype footprint. The art has transparent (black)
    // padding around the creature, so it's scaled a bit larger than the collision
    // radius to give the glowing body real presence.
    const s = def.r * (def.boss ? 5.0 : 4.1);
    body.scale.set(s, s, 1);
  } else {
    bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1a1424, emissive: tint, emissiveIntensity: 1.6, roughness: 0.4,
    });
    body = new THREE.Mesh(def.geo(), bodyMat);
  }
  body.layers.enable(BLOOM_LAYER);
  mesh.add(body);
  if (isMini) mesh.scale.setScalar(0.6);
  mesh.layers.enable(BLOOM_LAYER);
  // Ground-glow aura — a tinted additive disc under the foe so it has presence
  // and telegraphs its footprint. Circular, so the body's Y-spin never shows on
  // it; parented to the mesh so it follows for free. Disposed via traverse.
  const aura = new THREE.Mesh(
    new THREE.CircleGeometry(def.r * 1.9, 28),
    new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.26, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = -1.05;
  aura.layers.enable(BLOOM_LAYER);
  mesh.add(aura);
  // Shielded archetypes (warden) get a translucent bubble parented to the body —
  // opacity is driven by the live shield fraction in updateFoes, hidden on break.
  // Disposed for free by the traverse() in _killFoe / clearAllFoes.
  let shieldMesh = null;
  if (def.shield) {
    shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(def.r * 1.5, 16, 12),
      new THREE.MeshBasicMaterial({
        color: tint, transparent: true, opacity: 0.28,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    shieldMesh.layers.enable(BLOOM_LAYER);
    mesh.add(shieldMesh);
  }
  _group.add(mesh);
  const f = {
    type, def, tint, spriteName: sname, mesh, body, bodyMat, isSprite, x, z, r: isMini ? def.r * 0.6 : def.r,
    hp: def.hp * hpScale, hpMax: def.hp * hpScale, hpScale,
    // Dash state (charger) + split/shield fields (splitter/warden).
    noSplit: isMini, dashT: 0, dashVX: 0, dashVZ: 0,
    shield: def.shield || 0, shieldMesh,
    name: (opts && opts.name) || '',
    // Volley state machine: idle (cooldown) → windup (telegraph) → fire/burst.
    mode: 'idle',
    t1: 1.2 + Math.random() * 0.8,   // first volley delayed — spawn isn't a cheap shot
    windup01: 0,
    burst: 0, burstGap: 0, burstT: 0, burstFn: null,
    aimA: 0, tele: null,
    phase: Math.random() * Math.PI * 2,
    phaseIdx: 0,                      // boss phase index (hp thresholds)
    dir: Math.random() < 0.5 ? -1 : 1,
    orbitA: Math.atan2(z - ARENA_CZ, x - ARENA_CX),
    orbitR: Math.hypot(x - ARENA_CX, z - ARENA_CZ) || 10,
    alt: 0, gapT: undefined,
    hitFlash: 0,
  };
  _foes.push(f);
  bh.foesAlive = _foes.length + _pending.length;
  spawnImpactBurst(x, 1.1, z, tint, 0.5);
  if (def.boss) {
    bh.boss = f;
    bh.bossName = f.name || 'THE NAMELESS';
    if (sfx && sfx.bossSpawn) sfx.bossSpawn();
    setMusicTier(2);
    state.fx.shake = Math.min(1, state.fx.shake + 0.35);
    // Per-biome materialize nova — reads the current biome (bh.level) so the boss
    // tell matches the arena theme: void → fire → frost → holy.
    const nova = BOSS_NOVA[Math.max(0, Math.min(BOSS_NOVA.length - 1, bh.level | 0))];
    spawnAoeNova(x, z, def.r * 5.5, nova[0], nova[1], 1.1);
  }
  return f;
}

export function damageFoe(f, amt) {
  // Shielded foes (warden) soak into the shield first; the breaking hit's
  // overflow carries into hp so a big crit isn't wasted on 1 shield point.
  if (f.shield > 0) {
    f.shield -= amt;
    if (f.shield <= 0) {
      const overflow = -f.shield;
      f.shield = 0;
      if (f.shieldMesh) f.shieldMesh.visible = false;
      spawnImpactBurst(f.x, 1.4, f.z, f.tint, 0.6);   // shield-break pop
      if (sfx && sfx.enemyHurt) sfx.enemyHurt({ gain: 0.2 });
      f.hp -= overflow;
    }
    f.hitFlash = 0.08;
    return;
  }
  f.hp -= amt;
  // Hit feedback: low-gain hurt tick + a spark, throttled by the flash window
  // so a maxed fire-rate build can't machine-gun the ember pool.
  if (f.hitFlash <= 0) {
    if (sfx && sfx.enemyHurt) sfx.enemyHurt({ gain: 0.12 });
    spawnImpactBurst(f.x, 1.1, f.z, f.tint, 0.25);
  }
  f.hitFlash = 0.08;
}

/** Nearest live foe to (x,z), skipping any in `exclude` (a Set). */
export function nearestFoe(x, z, exclude) {
  let best = null, bestD2 = Infinity;
  for (const f of _foes) {
    if (exclude && exclude.has(f)) continue;
    const dx = f.x - x, dz = f.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = f; }
  }
  return best;
}

/** Live + telegraphed-incoming — the wave isn't clear while spawns are queued. */
export function foesAlive() { return _foes.length + _pending.length; }

/** QA/debug only — live foe array (window.__kkBhFoes in index.js). */
export function _debugFoes() { return _foes; }

// ── Snipe line telegraph ──────────────────────────────────────────────────
function _mkLineTele(f, angle, len) {
  const geo = new THREE.PlaneGeometry(0.35, len);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff4a4a, transparent: true, opacity: 0.0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  // Same flat-then-yaw orientation as the vfxBurst dash streak: euler
  // (-PI/2, atan2(dirX, dirZ), 0) in YXZ order lays the plane's long axis
  // along the aim direction. The plane is centered, so offset half its
  // length along the aim so the line starts AT the foe.
  m.rotation.order = 'YXZ';
  m.rotation.set(-Math.PI / 2, Math.atan2(Math.cos(angle), Math.sin(angle)), 0);
  m.position.set(f.x + Math.cos(angle) * len * 0.5, 0.08, f.z + Math.sin(angle) * len * 0.5);
  m.layers.enable(BLOOM_LAYER);
  _group.add(m);
  return m;
}

function _disposeTele(f) {
  if (!f.tele) return;
  _group.remove(f.tele);
  f.tele.geometry.dispose();
  f.tele.material.dispose();
  f.tele = null;
}

export function updateFoes(dt) {
  const h = state.hero.pos;

  // Spawn telegraphs: rune ring fades in + spins, then the foe materializes.
  for (let i = _pending.length - 1; i >= 0; i--) {
    const p = _pending[i];
    p.t += dt;
    const k = Math.min(1, p.t / p.dur);
    p.ring.material.opacity = 0.15 + k * 0.8;
    p.ring.rotation.z += dt * 2.2;
    const s = 0.5 + k * 0.5;
    p.ring.scale.setScalar(s);
    if (p.t >= p.dur) {
      _group.remove(p.ring);
      p.ring.geometry.dispose();
      p.ring.material.dispose();
      _pending.splice(i, 1);
      _materializeFoe(p.type, p.x, p.z, p.hpScale, p.opts);
    }
  }

  // Boss-death explosion chain (scheduled by _killFoe).
  for (let i = _chainFx.length - 1; i >= 0; i--) {
    const c = _chainFx[i];
    c.t -= dt;
    if (c.t <= 0) {
      burstExplosion(c.x, c.z, 4.5, c.color);
      if (sfx && sfx.explosion) sfx.explosion();
      state.fx.shake = Math.min(1, state.fx.shake + 0.2);
      _chainFx.splice(i, 1);
    }
  }

  for (let i = _foes.length - 1; i >= 0; i--) {
    const f = _foes[i];
    if (f.hp <= 0) {
      _killFoe(i);
      continue;
    }

    // Boss phase transitions at hp thresholds — swap pattern sets loudly.
    if (f.def.boss) {
      const frac = f.hp / f.hpMax;
      const ph = frac > 0.66 ? 0 : (frac > 0.33 ? 1 : 2);
      if (ph !== f.phaseIdx) {
        f.phaseIdx = ph;
        f.mode = 'idle'; f.t1 = 1.0; f.burst = 0; f.burstFn = null;
        cancelBulletsNear(f.x, f.z, 7);
        burstExplosion(f.x, f.z, 5, f.tint);
        if (sfx && sfx.bossShockwave) sfx.bossShockwave();
        notifyBh(`Phase ${ph + 1}`, '#ff7272', { priority: 1, duration: 0.95 });
        state.fx.shake = Math.min(1, state.fx.shake + 0.3);
      }
    }

    if (f.def.move) f.def.move(f, dt);

    // Volley state machine: idle → windup (0.4-0.6s telegraph) → fire → burst.
    if (f.mode === 'idle') {
      f.t1 -= dt;
      f.windup01 = 0;
      if (f.t1 <= 0) {
        f.mode = 'windup';
        f.t1 = f.def.windup;
        if (f.def.lineTele) {
          // Lock the aim NOW — the telegraph is a promise the player dodges.
          f.aimA = Math.atan2(h.z - f.z, h.x - f.x);
          f.tele = _mkLineTele(f, f.aimA, ARENA_R * 1.6);
        }
      }
    } else if (f.mode === 'windup') {
      f.t1 -= dt;
      f.windup01 = 1 - Math.max(0, f.t1 / f.def.windup);
      if (f.tele) f.tele.material.opacity = 0.15 + f.windup01 * 0.6;
      if (f.t1 <= 0) {
        _disposeTele(f);
        f.windup01 = 0;
        f.def.fire(f);
        f.mode = f.burst > 0 ? 'burst' : 'idle';
        f.burstT = 0;
        f.t1 = _cd(f.def.cooldown);
      }
    } else if (f.mode === 'burst') {
      f.burstT -= dt;
      if (f.burstT <= 0) {
        if (f.burstFn) f.burstFn(f);
        f.burst--;
        f.burstT = f.burstGap;
        if (f.burst <= 0) {
          f.mode = 'idle';
          f.burstFn = null;
          f.t1 = _cd(f.def.cooldown);
        }
      }
    }

    // Clamp inside arena
    const rx = f.x - ARENA_CX, rz = f.z - ARENA_CZ;
    const d = Math.hypot(rx, rz);
    if (d > ARENA_R - 1) {
      f.x = ARENA_CX + rx * (ARENA_R - 1) / d;
      f.z = ARENA_CZ + rz * (ARENA_R - 1) / d;
    }
    // Contact damage — bumping a foe body hurts (uses full body radius, not
    // the bullet hitbox: touching enemies is always your fault).
    const dx = f.x - h.x, dz = f.z - h.z;
    const cr = Math.max(CONTACT_R, f.r);
    if (dx * dx + dz * dz < cr * cr) heroTakeDamage(CONTACT_DMG * dt * 4, 'contact');
    // Visuals: bob + hit flash + windup telegraph (glow ramp + scale swell).
    if (f.mesh) {
      f.mesh.position.set(f.x, 1.1 + Math.sin(state.time.game * 3 + f.phase) * 0.15, f.z);
      // Base scale preserves the splitter mini's 0.6 shrink; windup swells the
      // body and a hit-flash adds a quick pop — applied to sprite OR primitive.
      const base = f.noSplit ? 0.6 : 1;
      const pop = f.hitFlash > 0 ? 0.12 : 0;
      f.mesh.scale.setScalar(base * (1 + f.windup01 * 0.25 + pop));
      if (f.isSprite) {
        // Additive billboard: windup brightens via opacity (bloom picks it up),
        // hit-flash pushes to full white-hot.
        f.bodyMat.opacity = f.hitFlash > 0 ? 1 : (0.9 + f.windup01 * 0.1);
      } else {
        const windGlow = 1.6 + f.windup01 * 2.4;   // ramps 1.6 → 4.0 across the windup
        f.bodyMat.emissiveIntensity = f.hitFlash > 0 ? 4.0 : windGlow;
      }
      if (f.hitFlash > 0) f.hitFlash -= dt;
      // Shield bubble fades with the remaining shield fraction (hidden on break).
      if (f.shieldMesh && f.shield > 0) {
        f.shieldMesh.material.opacity = 0.12 + (f.shield / (f.def.shield || 1)) * 0.22;
      }
    }
  }
  bh.foesAlive = _foes.length + _pending.length;
}

function _killFoe(i) {
  const f = _foes[i];
  const boss = !!f.def.boss;
  // KILL JUICE: explosion + sfx + hitstop + nearby-bullet cancel. The cancel
  // (2.5u) converts would-be hits into sparks — aggressive play gets paid.
  burstExplosion(f.x, f.z, boss ? 7 : 3.2, f.tint);
  spawnImpactBurst(f.x, 1.1, f.z, f.tint, 0.9);
  if (sfx && sfx.enemyDeath) sfx.enemyDeath();
  if (state.fx.hitStop < (boss ? 0.09 : 0.04)) state.fx.hitStop = boss ? 0.09 : 0.04;
  cancelBulletsNear(f.x, f.z, boss ? 6 : 2.5);
  _disposeTele(f);
  if (f.mesh) {
    _group.remove(f.mesh);
    // Sprites carry a SpriteMaterial (o.isMesh is false) — dispose it too; the
    // shared cached texture (_foeTex) is intentionally left alone.
    f.mesh.traverse(o => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
      else if (o.isSprite) { o.material.dispose(); }
    });
  }
  _foes.splice(i, 1);
  state.fx.shake = Math.min(1, state.fx.shake + (boss ? 0.6 : 0.18));
  // Splitter fracture: birth N fast minis that cannot split again. Materialize
  // directly (no spawn telegraph) so they burst straight out of the corpse.
  // Safe mid-loop: children push to the END of _foes while the reverse loop in
  // updateFoes is walking down from i-1, so they first tick next frame.
  if (f.def.split && !f.noSplit) {
    const childScale = (f.hpScale || 1) * 0.3;
    for (let c = 0; c < f.def.split; c++) {
      const a = (c / f.def.split) * Math.PI * 2 + Math.random() * 0.6;
      _materializeFoe('splitter', f.x + Math.cos(a) * 1.6, f.z + Math.sin(a) * 1.6, childScale, { noSplit: true });
    }
    if (sfx && sfx.enemyHurt) sfx.enemyHurt({ gain: 0.18 });
  }
  if (boss) {
    // Boss death: staggered explosion chain + elite sting, music back to combat.
    if (sfx && sfx.eliteDeath) sfx.eliteDeath();
    for (let c = 0; c < 6; c++) {
      _chainFx.push({
        x: f.x + (Math.random() - 0.5) * 6,
        z: f.z + (Math.random() - 0.5) * 6,
        t: 0.12 + c * 0.15,
        color: f.tint,
      });
    }
    bh.boss = null;
    bh.bossName = '';
    setMusicTier(1);
  }
  // HUD + end-run summary both read state.run.kills.
  if (state.run) state.run.kills = (state.run.kills || 0) + 1;
}

export function clearAllFoes() {
  for (let i = _foes.length - 1; i >= 0; i--) {
    const f = _foes[i];
    _disposeTele(f);
    if (f.mesh) { _group.remove(f.mesh); f.mesh.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } else if (o.isSprite) { o.material.dispose(); } }); }
  }
  for (let i = _pending.length - 1; i >= 0; i--) {
    const p = _pending[i];
    _group.remove(p.ring);
    p.ring.geometry.dispose();
    p.ring.material.dispose();
  }
  _foes.length = 0;
  _pending.length = 0;
  _chainFx.length = 0;
  bh.foesAlive = 0;
  bh.boss = null;
  bh.bossName = '';
}

export function disposeFoes(scene) {
  clearAllFoes();
  if (_group) { scene.remove(_group); _group = null; }
  if (_runeTex) { _runeTex.dispose(); _runeTex = null; }
}
