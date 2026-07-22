/**
 * Totem of Swarm — combat-state destructibles.
 *
 * Three totems spawn at semi-random arena positions when a run begins.
 * Each ticks on a 4s cycle, spawning one weak enemy near itself. They
 * exist in state.enemies.active (with isTotem flag) so the existing
 * weapon-damage pipeline hits them for free; movement + contact damage
 * are gated in enemies.js for isTotem entries.
 *
 * Kill rewards: 1 chest + 1 Ember bonus. After a totem dies, the next
 * one auto-respawns at a new position 30s later.
 *
 * Visual: stone obelisk + glowing red crown ring + slow self-rotation.
 */
import * as THREE from 'three';
import { overworldTime } from './runClock.js';
import { state } from './state.js';
import { grantEmbers } from './meta.js';

const TOTEM_HP = 200;
const SPAWN_CYCLE = 4.0;     // sec between mob spawns
const SPAWN_RADIUS = 5.0;    // mob spawns within this radius of totem
const RESPAWN_DELAY = 30.0;
const DIST_FROM_HERO_MIN = 22;   // never spawn too close to start
const DIST_FROM_HERO_MAX = 42;

let _scene = null;
let _warmTotem = null;

function _pickTotemPos() {
  // Pick a position 22-42u from hero. Try a few times to avoid stacking.
  const hp = state.hero.pos;
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = DIST_FROM_HERO_MIN + Math.random() * (DIST_FROM_HERO_MAX - DIST_FROM_HERO_MIN);
    const x = hp.x + Math.cos(a) * r;
    const z = hp.z + Math.sin(a) * r;
    let tooClose = false;
    for (const t of state.totems.list) {
      if (!t.alive) continue;
      const dx = t.mesh.position.x - x;
      const dz = t.mesh.position.z - z;
      if (dx * dx + dz * dz < 100) { tooClose = true; break; }
    }
    if (!tooClose) return { x, z };
  }
  // Fallback ring position
  const a = Math.random() * Math.PI * 2;
  return { x: hp.x + Math.cos(a) * 30, z: hp.z + Math.sin(a) * 30 };
}

function _makeTotemMesh() {
  const g = new THREE.Group();
  // Stepped base (wide → narrow) — stable silhouette
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.5, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x4a4138, roughness: 0.95 }),
  );
  base.position.y = 0.25;
  base.castShadow = true; base.receiveShadow = true;
  g.add(base);
  // Obelisk shaft
  const shaft = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 2.4, 1.0),
    new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.92 }),
  );
  shaft.position.y = 1.7;
  shaft.castShadow = true; shaft.receiveShadow = true;
  g.add(shaft);
  // Engraved rune face (front) — emissive sigil
  const rune = new THREE.Mesh(
    new THREE.PlaneGeometry(0.65, 0.65),
    new THREE.MeshStandardMaterial({
      color: 0xff5522, emissive: 0xff3a14, emissiveIntensity: 1.4,
      roughness: 0.4, side: THREE.DoubleSide,
    }),
  );
  rune.position.set(0, 1.7, 0.51);
  g.add(rune);
  // Crown ring (glowing red torus at the top)
  const crown = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.08, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xff5522, emissive: 0xff5522, emissiveIntensity: 1.6, roughness: 0.4 }),
  );
  crown.rotation.x = Math.PI / 2;
  crown.position.y = 3.0;
  g.add(crown);
  g.userData._crown = crown;
  g.userData._rune = rune;
  // Spike on top
  const spike = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.55, 6),
    new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 }),
  );
  spike.position.y = 3.3;
  spike.castShadow = true;
  g.add(spike);
  // Red point light for atmosphere
  const pl = new THREE.PointLight(0xff5522, 1.2, 8, 2);
  pl.position.y = 2.4;
  g.add(pl);
  return g;
}

/** Prepare the lazily-created Totem material family while the stage loader is up. */
export async function warmTotemVisuals(warm) {
  if (!_scene || typeof warm !== 'function') return false;
  if (!_warmTotem) {
    _warmTotem = _makeTotemMesh();
    _warmTotem.name = 'totem:pipeline-warmup';
    _warmTotem.traverse((object) => { if (object?.isMesh) object.frustumCulled = false; });
  }
  _warmTotem.position.set(0, -10000, 0);
  _scene.add(_warmTotem);
  try {
    await warm();
    return true;
  } finally {
    _warmTotem.removeFromParent();
  }
}

function _spawnOne() {
  const pos = _pickTotemPos();
  const mesh = _makeTotemMesh();
  mesh.position.set(pos.x, 0, pos.z);
  _scene.add(mesh);
  // Construct an enemy-shaped object so the damage pipeline hits it for free.
  // Movement/contact are gated in enemies.js by the isTotem flag.
  const totem = {
    mesh,
    glbKey: '__totem__',
    hp: TOTEM_HP,
    hpMax: TOTEM_HP,
    spd: 0, dmg: 0,
    contactCooldown: Infinity,
    elite: false, isFinalBoss: false, isMiniBoss: false,
    isTotem: true,
    faceFlip: false,
    alive: true,
    _spatialKey: null,
    knockVx: 0, knockVz: 0,
    slowMul: 1,
    _dotDps: 0, _dotUntil: 0,
    _flashUntil: 0, _wasFlashing: false,
    procAnim: null, ranged: null, rangedCD: 0,
    _animPhase: 0,
    _baseY: 0, _baseScale: 1,
    spawnCD: SPAWN_CYCLE * 0.7,    // first mob spawns slightly faster
    age: 0,
  };
  state.enemies.spatial.insert(totem);
  state.enemies.active.push(totem);
  state.totems.list.push(totem);
  return totem;
}

function _spawnMobNear(totem) {
  // Pick a weak enemy tier and spawn it adjacent to the totem.
  // Lazy import to avoid circular dependency.
  return import('./enemies.js').then(({ spawnEnemy }) => {
    return import('./config.js').then(({ ENEMY_TIERS }) => {
      // Weak tiers: anything with hp <= 18 (zombie/ant/goblin/skeleton/spider/wolf/ladybug...).
      // !t.dungeon excludes catacomb-only KayKit tiers whose GLBs aren't loaded here.
      const pool = ENEMY_TIERS.filter(t => t.hp <= 18 && !t.elite && !t.dungeon);
      const tier = pool[Math.floor(Math.random() * pool.length)];
      const a = Math.random() * Math.PI * 2;
      const r = 1.5 + Math.random() * (SPAWN_RADIUS - 1.5);
      const x = totem.mesh.position.x + Math.cos(a) * r;
      const z = totem.mesh.position.z + Math.sin(a) * r;
      try { spawnEnemy(tier, x, z); } catch (_) {}
    });
  });
}

/** Called from killEnemy when an isTotem enemy dies. */
export function onTotemKilled(totem) {
  if (!totem) return;
  // Remove mesh from scene (totem is its own custom group, not a pooled mesh)
  if (totem.mesh && totem.mesh.parent) totem.mesh.parent.remove(totem.mesh);
  // Drop a chest + small Ember bonus for the player. The forest stage-gate
  // (slot-machine soft-lock vs forest-v2 rooms) lives inside spawnChest now —
  // one choke point covers every spawner.
  import('./chest.js').then(({ spawnChest }) => spawnChest(totem.mesh.position.x, totem.mesh.position.z));
  try { grantEmbers(1); } catch (_) {}
  // Remove from our list, schedule a respawn 30s out
  const i = state.totems.list.indexOf(totem);
  if (i >= 0) state.totems.list.splice(i, 1);
  state.totems.respawnQueue.push({ at: overworldTime() + RESPAWN_DELAY });
}

export function initTotems(scene) { _scene = scene; }

export function tickTotems(dt) {
  if (!_scene) return;
  // Don't spawn totems before hero has a position OR during non-run modes
  if (state.mode !== 'run') return;
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland') return;
  // First-time-this-run init: seed the target count
  if (!state.totems.initialized) {
    state.totems.initialized = true;
    for (let i = 0; i < state.totems.target; i++) _spawnOne();
  }
  // Handle queued respawns
  for (let i = state.totems.respawnQueue.length - 1; i >= 0; i--) {
    if (overworldTime() >= state.totems.respawnQueue[i].at) {
      _spawnOne();
      state.totems.respawnQueue.splice(i, 1);
    }
  }
  // Tick each alive totem: spawn mobs on cycle + light visual idle
  const t = state.time.real;
  for (const totem of state.totems.list) {
    if (!totem.alive) continue;
    totem.age += dt;
    // Slow self-rotation + crown bob
    if (totem.mesh.userData._crown) {
      totem.mesh.userData._crown.rotation.z += dt * 1.4;
      const pulse = 1 + Math.sin(t * 3.2) * 0.10;
      totem.mesh.userData._crown.scale.set(pulse, pulse, pulse);
    }
    if (totem.mesh.userData._rune) {
      totem.mesh.userData._rune.material.emissiveIntensity = 1.0 + 0.6 * Math.sin(t * 4.1);
    }
    totem.mesh.rotation.y += dt * 0.18;
    // Spawn cycle
    totem.spawnCD -= dt;
    if (totem.spawnCD <= 0) {
      totem.spawnCD = SPAWN_CYCLE;
      _spawnMobNear(totem);
    }
  }
}

export function resetTotems() {
  if (!state.totems) return;
  for (const t of state.totems.list) {
    if (t.mesh && t.mesh.parent) t.mesh.parent.remove(t.mesh);
  }
  state.totems.list.length = 0;
  state.totems.respawnQueue.length = 0;
  state.totems.initialized = false;
}
