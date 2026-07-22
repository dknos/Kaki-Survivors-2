/**
 * Catacomb room identity layer.
 *
 * The pure dungeon generator assigns each chamber an `encounter` grammar;
 * this module turns it into moving, readable, tactical play. Geometry is tiny
 * and shared, raster art is two Grok-generated additive textures, and at most
 * one room ticks at a time. Hazards can hurt enemies too so clever herding is
 * rewarded instead of every obstacle being a one-sided tax.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { ENCOUNTER, TYPE } from './dungeonGen.js';
import { fxTex } from './fxTextures.js';
import { floorDecalGeometry, floorDecalMaterial, applyFloorTier } from './fxLayers.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { damageEnemy, applyVulnerability } from './enemies.js';
import { getAffix } from './enemyAffixes.js';
import { dropGem } from './xp.js';
import { sfx } from './audio.js';
import { spawnHeroTextFloater } from './damageNumbers.js';

const YARN_HIT = 14;
const GHOST_HIT = 16;
const PAW_HIT = 20;
const ENEMY_HAZARD_HIT = 22;
const _loader = new THREE.TextureLoader();
const _yarnGeo = new THREE.SphereGeometry(0.48, 10, 8);
const _wardGeo = new THREE.IcosahedronGeometry(0.56, 1);
const _spikeGeo = new THREE.ConeGeometry(0.26, 1.05, 6).translate(0, 0.525, 0);
const _ropeGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

let _group = null;
let _build = null;
let _seed = 0;
let _activeId = -1;
let _yarnTex = null;
let _specterTex = null;
const _rooms = new Map();
const _costumes = [];

const _variantRoles = Object.freeze([
  { name: 'POUNCEGEIST', color: 0x82ffe0, hp: 0.88, spd: 1.24, dmg: 0.88, affix: 'leaping' },
  { name: 'YARN HEXER', color: 0xff70dc, hp: 0.96, spd: 0.90, dmg: 1.04, ranged: { range: 14, stopAt: 9, cooldown: 2.1, projSpeed: 10, projDmg: 9, projTtl: 2.4, fanAt: 0, fanCount: 3, fanSpread: 0.26 } },
  { name: 'BELL GUARDIAN', color: 0xffd46a, hp: 1.42, spd: 0.78, dmg: 1.12, affix: 'shielded' },
  { name: 'FROSTWHISKER', color: 0x78cfff, hp: 1.04, spd: 0.92, dmg: 1.04, affix: 'frosted' },
  { name: 'CANDLE SNEAK', color: 0xff9a62, hp: 0.72, spd: 1.18, dmg: 0.86, affix: 'swift' },
  { name: 'NINE-LIVES WRAITH', color: 0xd19bff, hp: 1.18, spd: 0.94, dmg: 1.00, affix: 'vampiric' },
  { name: 'STARBOMB FAMILIAR', color: 0xff6688, hp: 0.82, spd: 1.08, dmg: 1.05, affix: 'volatile' },
  { name: 'MOURNFUL MOUSER', color: 0xb5ffe8, hp: 1.10, spd: 1.02, dmg: 1.08, affix: null },
]);

function _getYarnTex() {
  if (!_yarnTex) _yarnTex = fxTex('catacomb_yarn_paw')
    || _loader.load('assets/fx/rings/catacomb_yarn_paw.webp');
  return _yarnTex;
}
function _getSpecterTex() {
  if (!_specterTex) _specterTex = fxTex('catacomb_specter')
    || _loader.load('assets/fx/foes/catacomb_specter.webp');
  return _specterTex;
}

function _decal(size, color = 0xffffff, opacity = 0.5) {
  const m = new THREE.Mesh(
    floorDecalGeometry(size),
    floorDecalMaterial({ map: _getYarnTex(), color, opacity }),
  );
  applyFloorTier(m, 'telegraph');
  return m;
}

function _makeBase(rec) {
  const rune = _decal(Math.min(3.8, rec.radius * 0.54), 0xd79cff, 0.16);
  rune.position.y = 0.025;
  rune.name = `catacombRoomRune:${rec.kind}`;
  rec.group.add(rune);
  rec.baseRune = rune;
}

function _makeYarn(rec, count = 3) {
  rec.yarn = [];
  const orbMat = new THREE.MeshStandardMaterial({
    color: 0xff65c8, emissive: 0xb01872, emissiveIntensity: 1.45,
    roughness: 0.48, metalness: 0.08,
  });
  const ropeMat = new THREE.MeshBasicMaterial({
    map: _getYarnTex(), color: 0xff83d7, transparent: true, opacity: 0.54,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  for (let i = 0; i < count; i++) {
    const root = new THREE.Group();
    const rope = new THREE.Mesh(_ropeGeo, ropeMat.clone());
    rope.position.y = 0.055;
    rope.layers.enable(BLOOM_LAYER);
    rec.group.add(rope);
    const orb = new THREE.Mesh(_yarnGeo, orbMat.clone());
    orb.position.y = 0.58;
    orb.castShadow = true;
    orb.layers.enable(BLOOM_LAYER);
    root.add(orb);
    const halo = _decal(1.8, i % 2 ? 0xffcf69 : 0xff70cc, 0.60);
    halo.position.y = 0.03;
    root.add(halo);
    rec.group.add(root);
    rec.yarn.push({ root, rope, a0: (i / count) * Math.PI * 2, hits: new Set() });
  }
}

function _makeGhosts(rec, count = 4) {
  rec.ghosts = [];
  rec.ghostLane = new THREE.Mesh(
    _ropeGeo,
    new THREE.MeshBasicMaterial({
      color: 0x8fffe5, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  rec.ghostLane.position.y = 0.045;
  rec.ghostLane.scale.set(rec.radius * 2, 0.44, 1);
  applyFloorTier(rec.ghostLane, 'telegraph');
  rec.group.add(rec.ghostLane);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: _getSpecterTex(), color: i % 2 ? 0xa9ffea : 0xd9adff,
      transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.75, 2.75, 1);
    sprite.layers.enable(BLOOM_LAYER);
    rec.group.add(sprite);
    rec.ghosts.push({ sprite, lane: (i - (count - 1) / 2) * 1.45, hits: new Set() });
  }
}

function _makePawfall(rec, count = 5) {
  rec.paws = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.35;
    const radius = i === 0 ? 0 : rec.radius * (0.42 + 0.10 * (i & 1));
    const decal = _decal(2.25, 0xff756d, 0.12);
    decal.position.set(Math.cos(a) * radius, 0.035, Math.sin(a) * radius);
    rec.group.add(decal);
    const spikes = new THREE.Group();
    for (const [x, z] of [[0, 0], [0.42, 0.28], [-0.40, 0.30]]) {
      const spike = new THREE.Mesh(
        _spikeGeo,
        new THREE.MeshStandardMaterial({
          color: 0x6b3f78, emissive: 0x3b0e58, emissiveIntensity: 0.38,
          roughness: 0.7, metalness: 0.25,
        }),
      );
      spike.position.set(x, -1.05, z);
      spikes.add(spike);
    }
    spikes.position.set(decal.position.x, 0, decal.position.z);
    rec.group.add(spikes);
    rec.paws.push({ decal, spikes, hits: new Set() });
  }
}

function _makeRite(rec) {
  rec.rite = { lit: 0, complete: false, nodes: [] };
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
    const decal = _decal(2.35, 0x8dffe1, 0.26);
    decal.position.set(Math.cos(a) * rec.radius * 0.50, 0.04, Math.sin(a) * rec.radius * 0.50);
    rec.group.add(decal);
    rec.rite.nodes.push({ decal, lit: false });
  }
}

function _makeWards(rec) {
  rec.wards = { broken: 0, healAt: 2.5, nodes: [] };
  for (let i = 0; i < 2; i++) {
    const root = new THREE.Group();
    root.position.set((i ? 1 : -1) * rec.radius * 0.43, 0, 0);
    const core = new THREE.Mesh(
      _wardGeo,
      new THREE.MeshStandardMaterial({
        color: 0xffd66f, emissive: 0x8d4e16, emissiveIntensity: 1.1,
        roughness: 0.4, metalness: 0.22,
      }),
    );
    core.position.y = 0.75;
    core.castShadow = true;
    core.layers.enable(BLOOM_LAYER);
    root.add(core);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.065, 7, 22),
      new THREE.MeshBasicMaterial({ color: 0xffe3a0 }),
    );
    ring.position.y = 0.72;
    ring.rotation.x = Math.PI / 2;
    root.add(ring);
    const marker = _decal(1.9, 0xffd36a, 0.55);
    marker.position.y = 0.035;
    root.add(marker);
    rec.group.add(root);
    rec.wards.nodes.push({ root, core, ring, marker, broken: false });
  }
}

function _makeRoomRecord(room) {
  const center = _build.cellToWorld(room.cx, room.cy);
  const group = new THREE.Group();
  group.name = `catacombEncounter:${room.id}:${room.encounter}`;
  group.position.set(center.x, 0, center.z);
  group.visible = false;
  _group.add(group);
  const rec = {
    id: room.id,
    room,
    kind: room.encounter || ENCOUNTER.QUIET,
    group,
    radius: Math.max(4.4, Math.min(room.w, room.h) * _build.CELL * 0.29),
    t: 0,
    ghostCycle: 0,
    active: false,
    mobs: null,
  };
  _makeBase(rec);
  if (rec.kind === ENCOUNTER.YARN_WALTZ) _makeYarn(rec, 3);
  else if (rec.kind === ENCOUNTER.GHOST_GALLERY) _makeGhosts(rec, 4);
  else if (rec.kind === ENCOUNTER.PAW_RITE) _makeRite(rec);
  else if (rec.kind === ENCOUNTER.SPIKE_GARDEN) _makePawfall(rec, 5);
  else if (rec.kind === ENCOUNTER.BELL_GAUNTLET) { _makeWards(rec); _makeGhosts(rec, 3); }
  else if (rec.kind === ENCOUNTER.WARDEN_WALTZ) {
    _makeYarn(rec, 4);
    _makeGhosts(rec, 5);
    _makePawfall(rec, 6);
  }
  return rec;
}

/** Build dormant room mechanics once; only the active room becomes visible. */
export function buildCatacombEncounters(layout, build, parentGroup, seed) {
  disposeCatacombEncounters();
  if (!layout || !build || !parentGroup) return;
  _build = build;
  _seed = seed >>> 0;
  _group = new THREE.Group();
  _group.name = 'catacombRoomMechanics';
  parentGroup.add(_group);
  for (const room of layout.rooms) {
    if (room.type !== TYPE.COMBAT && room.type !== TYPE.ELITE && room.type !== TYPE.BOSS) continue;
    _rooms.set(room.id, _makeRoomRecord(room));
  }
}

function _applyRole(enemy, role) {
  enemy.hp *= role.hp;
  enemy.hpMax *= role.hp;
  enemy.spd *= role.spd;
  enemy.dmg *= role.dmg;
  enemy.xp = Math.max(2, Math.ceil((enemy.xp || 1) * 1.75));
  if (role.ranged) {
    const base = enemy.ranged || {};
    enemy.ranged = { ...base, ...role.ranged };
    enemy.rangedCD = 0.8 + Math.random() * 0.8;
  }
  if (role.affix && !(enemy.affixes || []).includes(role.affix)) {
    const affix = getAffix(role.affix);
    if (affix) {
      if (!enemy.affixes) enemy.affixes = [];
      enemy.affixes.push(role.affix);
      try { affix.apply(enemy); } catch (_) {}
    }
  }
  enemy.displayName = role.name;
  enemy._dungeonRole = role.name;
}

/** Add a pooled-looking spectral identity to a normal dungeon enemy. */
export function decorateCatacombEnemy(enemy, roomId, spawnIndex = 0, forcedRole = null) {
  if (!enemy || !_group) return enemy;
  const boss = !!enemy._isDungeonBoss;
  const index = Math.abs(((_seed ^ Math.imul(roomId + 1, 2654435761) ^ Math.imul(spawnIndex + 3, 2246822519)) >>> 0)) % _variantRoles.length;
  const role = boss
    ? { name: 'CRYPT WARDEN', color: 0xffd36f, hp: 1, spd: 1, dmg: 1 }
    : (_variantRoles.find((r) => r.name === forcedRole) || _variantRoles[index]);
  if (!boss) _applyRole(enemy, role);
  else enemy.xp = Math.max(30, Math.ceil((enemy.xp || 10) * 2));

  const material = new THREE.SpriteMaterial({
    map: _getSpecterTex(), color: role.color,
    transparent: true, opacity: boss ? 0.58 : 0.42,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  const scale = boss ? 4.6 : 2.45;
  sprite.scale.set(scale, scale, 1);
  sprite.layers.enable(BLOOM_LAYER);
  sprite.name = `dungeonEnemyRole:${role.name}`;
  _group.add(sprite);
  _costumes.push({ enemy, sprite, baseOpacity: material.opacity, phase: index * 0.73 });
  return enemy;
}

export function activateCatacombEncounter(roomId, mobs) {
  const rec = _rooms.get(roomId);
  if (!rec) return;
  if (_activeId >= 0 && _activeId !== roomId) completeCatacombEncounter(_activeId);
  _activeId = roomId;
  rec.active = true;
  rec.group.visible = true;
  rec.t = 0;
  rec.ghostCycle = 0;
  rec.mobs = mobs || null;
  if (rec.yarn) for (const y of rec.yarn) y.hits.clear();
  if (rec.ghosts) for (const g of rec.ghosts) g.hits.clear();
  if (rec.paws) for (const p of rec.paws) p.hits.clear();
}

export function completeCatacombEncounter(roomId) {
  const rec = _rooms.get(roomId);
  if (!rec) return;
  rec.active = false;
  rec.group.visible = false;
  rec.mobs = null;
  if (_activeId === roomId) _activeId = -1;
}

function _damagePoint(rec, x, z, radius, heroDmg, hits, source = 'telegraph') {
  const wx = rec.group.position.x + x;
  const wz = rec.group.position.z + z;
  const rr = radius * radius;
  const h = state.hero.pos;
  const hdx = h.x - wx, hdz = h.z - wz;
  if (!hits.has('hero') && hdx * hdx + hdz * hdz <= rr) {
    hits.add('hero');
    try { heroTakeDamage(heroDmg, source); } catch (_) {}
  }
  if (!rec.mobs) return;
  for (const e of rec.mobs) {
    if (!e || !e.alive || !e.mesh || hits.has(e)) continue;
    const dx = e.mesh.position.x - wx, dz = e.mesh.position.z - wz;
    if (dx * dx + dz * dz > rr) continue;
    hits.add(e);
    try { damageEnemy(e, ENEMY_HAZARD_HIT, 'catacombRoom'); } catch (_) {}
  }
}

function _pointSegmentD2(px, pz, bx, bz) {
  const l2 = bx * bx + bz * bz;
  if (l2 < 1e-6) return px * px + pz * pz;
  const t = Math.max(0, Math.min(1, (px * bx + pz * bz) / l2));
  const dx = px - bx * t, dz = pz - bz * t;
  return dx * dx + dz * dz;
}

function _damageRope(rec, bx, bz, hits) {
  const h = state.hero.pos;
  const px = h.x - rec.group.position.x, pz = h.z - rec.group.position.z;
  if (!hits.has('hero') && _pointSegmentD2(px, pz, bx, bz) <= 0.62 * 0.62) {
    hits.add('hero');
    try { heroTakeDamage(YARN_HIT, 'telegraph'); } catch (_) {}
  }
  if (!rec.mobs) return;
  for (const e of rec.mobs) {
    if (!e || !e.alive || !e.mesh || hits.has(e)) continue;
    const ex = e.mesh.position.x - rec.group.position.x;
    const ez = e.mesh.position.z - rec.group.position.z;
    if (_pointSegmentD2(ex, ez, bx, bz) > 0.62 * 0.62) continue;
    hits.add(e);
    try { damageEnemy(e, ENEMY_HAZARD_HIT, 'catacombRoom'); } catch (_) {}
  }
}

function _tickYarn(rec, dt, boss = false) {
  const cycle = boss ? 5.6 : 6.6;
  const t = rec.t % cycle;
  const prevT = (rec.t - dt + cycle) % cycle;
  if (t < prevT) for (const y of rec.yarn) y.hits.clear();
  const tell = t < 1.0;
  const live = t >= 1.0 && t < (boss ? 4.9 : 4.7);
  const spin = (boss ? 0.76 : 0.58) * Math.max(0, t - 0.55);
  for (let i = 0; i < rec.yarn.length; i++) {
    const y = rec.yarn[i];
    const a = y.a0 + spin * (i & 1 ? -1 : 1);
    const radius = rec.radius * (0.46 + (i % 2) * 0.22);
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    y.root.position.set(x, 0, z);
    y.root.rotation.y -= dt * (i & 1 ? 2.2 : -2.6);
    y.root.scale.setScalar(tell ? 0.70 + 0.25 * Math.sin(t * 24) : 1);
    y.root.visible = t < (boss ? 5.1 : 5.0);
    const len = Math.hypot(x, z);
    y.rope.position.set(x * 0.5, 0.055, z * 0.5);
    y.rope.scale.set(len, tell ? 0.24 : 0.42, 1);
    y.rope.rotation.y = -Math.atan2(z, x);
    y.rope.material.opacity = tell ? 0.22 + 0.20 * Math.sin(t * 20) : (live ? 0.66 : 0.08);
    if (live) {
      _damagePoint(rec, x, z, 1.08, YARN_HIT, y.hits);
      _damageRope(rec, x, z, y.hits);
    }
  }
}

function _tickGhosts(rec, dt, boss = false) {
  const cycle = boss ? 5.2 : 6.4;
  const delay = boss ? 1.3 : 0;
  if (rec.t < delay) {
    rec.ghostLane.visible = false;
    for (const g of rec.ghosts) g.sprite.visible = false;
    return;
  }
  const local = rec.t - delay;
  const t = local % cycle;
  const prev = (local - dt + cycle) % cycle;
  if (t < prev) {
    rec.ghostCycle++;
    for (const g of rec.ghosts) g.hits.clear();
  }
  const tell = t < 1.0;
  const sweep = t >= 1.0 && t < (boss ? 4.3 : 4.5);
  const p = sweep ? (t - 1.0) / ((boss ? 4.3 : 4.5) - 1.0) : 0;
  rec.ghostLane.visible = tell || sweep;
  rec.ghostLane.material.opacity = tell ? 0.12 + 0.16 * Math.sin(t * 24) : (sweep ? 0.20 : 0);
  rec.ghostLane.rotation.y = rec.ghostCycle & 1 ? Math.PI / 2 : 0;
  for (let i = 0; i < rec.ghosts.length; i++) {
    const g = rec.ghosts[i];
    g.sprite.visible = tell || sweep;
    g.sprite.material.opacity = tell ? 0.16 + 0.24 * t : (sweep ? 0.72 : 0);
    const across = -rec.radius + p * rec.radius * 2;
    const bob = 1.35 + 0.20 * Math.sin(state.time.real * 7 + i);
    const x = rec.ghostCycle & 1 ? g.lane : across;
    const z = rec.ghostCycle & 1 ? across : g.lane;
    g.sprite.position.set(x, bob, z);
    if (sweep) _damagePoint(rec, x, z, 1.0, GHOST_HIT, g.hits);
  }
}

function _tickPawfall(rec, dt, boss = false) {
  const cycle = boss ? 4.6 : 5.8;
  const delay = boss ? 2.4 : 0;
  if (rec.t < delay) return;
  const localCycle = rec.t - delay;
  const t = localCycle % cycle;
  const prev = (localCycle - dt + cycle) % cycle;
  if (t < prev) for (const p of rec.paws) p.hits.clear();
  const tell = t < 1.15;
  const strike = t >= 1.15 && t < 1.48;
  const retract = t >= 1.48 && t < 1.85;
  for (let i = 0; i < rec.paws.length; i++) {
    const p = rec.paws[i];
    const stagger = boss ? (i % 2) * 0.16 : 0;
    const localT = Math.max(0, t - stagger);
    p.decal.material.opacity = tell
      ? 0.18 + 0.62 * Math.min(1, localT / 1.15) * (0.75 + 0.25 * Math.sin(localT * 22 + i))
      : (strike ? 0.90 : 0.12);
    let y = -1.05;
    if (strike) y = 0;
    else if (retract) y = -1.05 * Math.min(1, (t - 1.48) / 0.37);
    for (const spike of p.spikes.children) spike.position.y = y;
    if (strike) _damagePoint(rec, p.decal.position.x, p.decal.position.z, 1.12, PAW_HIT, p.hits);
  }
}

function _tickRite(rec) {
  const rite = rec.rite;
  if (!rite || rite.complete) return;
  const h = state.hero.pos;
  const hx = h.x - rec.group.position.x, hz = h.z - rec.group.position.z;
  for (const node of rite.nodes) {
    if (node.lit) continue;
    const dx = hx - node.decal.position.x, dz = hz - node.decal.position.z;
    if (dx * dx + dz * dz > 1.35 * 1.35) continue;
    node.lit = true;
    rite.lit++;
    node.decal.material.color.setHex(0xffd66d);
    node.decal.material.opacity = 0.92;
    node.decal.scale.setScalar(1.22);
    try { sfx.pickup?.(); } catch (_) {}
    try { spawnHeroTextFloater(`PAW RUNE ${rite.lit}/3`); } catch (_) {}
  }
  if (rite.lit < rite.nodes.length) return;
  rite.complete = true;
  if (rec.mobs) for (const e of rec.mobs) {
    if (!e || !e.alive) continue;
    try { applyVulnerability(e, 1.25, 90); damageEnemy(e, Math.max(16, e.hpMax * 0.10), 'catacombRite'); } catch (_) {}
  }
  state.hero.hp = Math.min(state.hero.hpMax, state.hero.hp + 8);
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
  try { sfx.evolutionChime?.(); } catch (_) {}
  try { spawnHeroTextFloater('MOON RITE — FOES EXPOSED'); } catch (_) {}
}

function _breakWard(rec, node) {
  node.broken = true;
  node.root.visible = false;
  rec.wards.broken++;
  if (rec.mobs) for (const e of rec.mobs) {
    if (!e || !e.alive) continue;
    try { damageEnemy(e, Math.max(18, e.hpMax * 0.08), 'catacombWard'); } catch (_) {}
  }
  try {
    const p = new THREE.Vector3(
      rec.group.position.x + node.root.position.x, 0.3,
      rec.group.position.z + node.root.position.z,
    );
    dropGem(p, 12);
  } catch (_) {}
  state.fx.shake = Math.max(state.fx.shake || 0, 0.38);
  try { sfx.crystalShatter?.(); } catch (_) {}
  try { spawnHeroTextFloater(`BELL WARD ${rec.wards.broken}/2 BROKEN`); } catch (_) {}
}

function _tickWards(rec, dt) {
  const wards = rec.wards;
  if (!wards) return;
  const h = state.hero.pos;
  const dashing = state.time.real < state.hero.dashUntil;
  for (let i = 0; i < wards.nodes.length; i++) {
    const node = wards.nodes[i];
    if (node.broken) continue;
    node.root.rotation.y += dt * (i ? -0.9 : 0.9);
    node.core.position.y = 0.72 + 0.10 * Math.sin(state.time.real * 3.6 + i);
    node.marker.material.opacity = 0.38 + 0.24 * Math.sin(state.time.real * 4.8 + i);
    const wx = rec.group.position.x + node.root.position.x;
    const wz = rec.group.position.z + node.root.position.z;
    const dx = h.x - wx, dz = h.z - wz;
    if (dashing && dx * dx + dz * dz < 1.35 * 1.35) _breakWard(rec, node);
  }
  wards.healAt -= dt;
  if (wards.healAt > 0 || wards.broken >= wards.nodes.length) return;
  wards.healAt = 3.0;
  if (rec.mobs) for (const e of rec.mobs) {
    if (!e || !e.alive) continue;
    e.hp = Math.min(e.hpMax, e.hp + e.hpMax * 0.025 * (wards.nodes.length - wards.broken));
  }
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.18);
}

function _tickCostumes(dt) {
  for (let i = _costumes.length - 1; i >= 0; i--) {
    const c = _costumes[i];
    const e = c.enemy;
    if (!e || !e.alive || !e.mesh) {
      if (c.sprite.parent) c.sprite.parent.remove(c.sprite);
      c.sprite.material.dispose();
      _costumes.splice(i, 1);
      continue;
    }
    const p = e.mesh.position;
    c.sprite.position.set(p.x, (p.y || 0) + 1.35 + 0.13 * Math.sin(state.time.real * 4.5 + c.phase), p.z);
    c.sprite.material.opacity = c.baseOpacity * (0.78 + 0.22 * Math.sin(state.time.real * 3.3 + c.phase));
  }
}

export function tickCatacombEncounters(dt) {
  if (!_group || state.mode !== 'catacomb') return;
  _tickCostumes(dt);
  const rec = _rooms.get(_activeId);
  if (!rec || !rec.active) return;
  rec.t += dt;
  rec.baseRune.rotation.y += dt * 0.18;
  rec.baseRune.material.opacity = 0.12 + 0.08 * Math.sin(state.time.real * 2.2);
  if (rec.kind === ENCOUNTER.YARN_WALTZ) _tickYarn(rec, dt);
  else if (rec.kind === ENCOUNTER.GHOST_GALLERY) _tickGhosts(rec, dt);
  else if (rec.kind === ENCOUNTER.PAW_RITE) _tickRite(rec);
  else if (rec.kind === ENCOUNTER.SPIKE_GARDEN) _tickPawfall(rec, dt);
  else if (rec.kind === ENCOUNTER.BELL_GAUNTLET) { _tickWards(rec, dt); _tickGhosts(rec, dt); }
  else if (rec.kind === ENCOUNTER.WARDEN_WALTZ) {
    _tickYarn(rec, dt, true);
    _tickGhosts(rec, dt, true);
    _tickPawfall(rec, dt, true);
  }
}

export function catacombEncounterLabel(roomId) {
  const rec = _rooms.get(roomId);
  if (!rec) return '';
  if (rec.kind === ENCOUNTER.YARN_WALTZ) return 'YARN WALTZ • DODGE THE SWEEPERS';
  if (rec.kind === ENCOUNTER.GHOST_GALLERY) return 'GHOST GALLERY • CROSS BETWEEN PROCESSIONS';
  if (rec.kind === ENCOUNTER.PAW_RITE) return rec.rite?.complete
    ? 'MOON RITE COMPLETE • FOES EXPOSED'
    : `LIGHT THE PAW RUNES ${rec.rite?.lit || 0}/3`;
  if (rec.kind === ENCOUNTER.SPIKE_GARDEN) return 'PAW-SPIKE GARDEN • WATCH THE GLOW';
  if (rec.kind === ENCOUNTER.BELL_GAUNTLET) return `DASH-SMASH BELL WARDS ${rec.wards?.broken || 0}/2`;
  if (rec.kind === ENCOUNTER.WARDEN_WALTZ) return 'WARDEN WALTZ • YARN + GHOSTS + PAW-SPIKES';
  return '';
}

export function debugCatacombEncounters() {
  return {
    built: !!_group,
    activeRoomId: _activeId,
    costumes: _costumes.length,
    rooms: Array.from(_rooms.values()).map((r) => ({
      id: r.id, kind: r.kind, active: r.active,
      rite: r.rite ? { lit: r.rite.lit, complete: r.rite.complete } : null,
      wards: r.wards ? { broken: r.wards.broken, total: r.wards.nodes.length } : null,
      yarn: r.yarn?.length || 0,
      ghosts: r.ghosts?.length || 0,
      paws: r.paws?.length || 0,
    })),
  };
}

export function disposeCatacombEncounters() {
  for (const c of _costumes) {
    if (c.sprite.parent) c.sprite.parent.remove(c.sprite);
    c.sprite.material.dispose();
  }
  _costumes.length = 0;
  if (_group) {
    _group.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) try { m.dispose(); } catch (_) {}
    });
    if (_group.parent) _group.parent.remove(_group);
    _group.clear();
  }
  _rooms.clear();
  _group = null;
  _build = null;
  _activeId = -1;
}
