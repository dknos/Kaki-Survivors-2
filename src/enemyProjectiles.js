/**
 * Enemy projectile system — fixed logical pool + two InstancedMesh draws.
 *
 * The old path allocated a Group, three Meshes and three Materials for every
 * bolt (up to 48 live / 144 drawables). Hostile shots now use one authored
 * Grok spectral-cat silhouette, instance-tinted for magic/fire/ice. The
 * painted core stays out of selective bloom; only a restrained halo blooms.
 * Logical descriptors are leased from a fixed pool so dense ranged waves do
 * not create or dispose render objects in the combat hot loop.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { takeDamage as heroTakeDamage } from './hero.js';
import { fxTex } from './fxTextures.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';

const HIT_R = 0.9;
const HIT_R2 = HIT_R * HIT_R;
const WORLD_BOUND = 80;
const MAX_LIVE_BOLTS = 48;

const _palette = Object.freeze({
  magic: { core: 0xf4c8ff, halo: 0xd56bff },
  fire:  { core: 0xffd0a0, halo: 0xff7138 },
  ice:   { core: 0xe5f7ff, halo: 0x72d8ff },
});

const _geo = new THREE.PlaneGeometry(1.55, 1.55);
const _loader = new THREE.TextureLoader();
let _directTex = null;
let _coreInst = null;
let _haloInst = null;
let _scene = null;

const _all = [];
const _free = [];
const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const _flatQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _up = new THREE.Vector3(0, 1, 0);
const _color = new THREE.Color();

function _getTexture() {
  const authored = fxTex('enemy_cat_spirit_bolt');
  if (authored) return authored;
  if (!_directTex) {
    _directTex = _loader.load(new URL('../assets/fx/projectiles/enemy_cat_spirit_bolt.webp', import.meta.url).href);
    _directTex.colorSpace = THREE.SRGBColorSpace;
    _directTex.minFilter = THREE.LinearMipmapLinearFilter;
    _directTex.magFilter = THREE.LinearFilter;
  }
  return _directTex;
}

function _hideAll() {
  if (!_coreInst || !_haloInst) return;
  _coreInst.count = 0;
  _haloInst.count = 0;
  _coreInst.instanceMatrix.needsUpdate = true;
  _haloInst.instanceMatrix.needsUpdate = true;
}

/** Create the persistent GPU and logical pools. Idempotent. */
export function initEnemyProjectileVisuals(scene = state.scene) {
  if (_coreInst || !scene) return;
  _scene = scene;
  const map = _getTexture();
  const coreMat = new THREE.MeshBasicMaterial({
    map,
    color: 0xffffff,
    transparent: true,
    opacity: 0.98,
    alphaTest: 0.055,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const haloMat = new THREE.MeshBasicMaterial({
    map,
    color: 0xffffff,
    transparent: true,
    opacity: 0.20,
    alphaTest: 0.02,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _coreInst = new THREE.InstancedMesh(_geo, coreMat, MAX_LIVE_BOLTS);
  _haloInst = new THREE.InstancedMesh(_geo, haloMat, MAX_LIVE_BOLTS);
  for (const [mesh, part] of [[_coreInst, 'core'], [_haloInst, 'halo']]) {
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.visualRole = 'enemy_projectile';
    mesh.userData.asset = 'enemy_cat_spirit_bolt';
    mesh.userData.part = part;
  }
  _haloInst.layers.enable(BLOOM_LAYER);
  scene.add(_coreInst, _haloInst);

  for (let i = 0; i < MAX_LIVE_BOLTS; i++) {
    const p = {
      // Compatibility position handle for playtest bots and diagnostics. It is
      // not a THREE scene object and is allocated only once with the pool.
      mesh: { position: new THREE.Vector3() },
      vx: 0, vz: 0, ttl: 0, dmg: 0, age: 0, kind: 'magic', _leased: false,
    };
    _all.push(p);
    _free.push(p);
    _coreInst.setColorAt(i, _color.setHex(_palette.magic.core));
    _haloInst.setColorAt(i, _color.setHex(_palette.magic.halo));
  }
  _coreInst.instanceColor.needsUpdate = true;
  _haloInst.instanceColor.needsUpdate = true;
}

function _release(p) {
  if (!p || !p._leased) return;
  p._leased = false;
  p.ttl = 0;
  _free.push(p);
}

function _writeVisual(i, p) {
  const pp = p.mesh.position;
  const pal = _palette[p.kind] || _palette.magic;
  const pulse = 1 + Math.sin(p.age * 15 + i * 0.7) * 0.07;
  const ang = Math.atan2(p.vz, p.vx);
  _yawQuat.setFromAxisAngle(_up, -ang);
  _quat.copy(_yawQuat).multiply(_flatQuat);

  _pos.set(pp.x, pp.y || 0.86, pp.z);
  _m4.compose(_pos, _quat, _scale.set(1.02 * pulse, 1.02 * pulse, 1.02 * pulse));
  _coreInst.setMatrixAt(i, _m4);
  _coreInst.setColorAt(i, _color.setHex(pal.core));

  _pos.y -= 0.025;
  _m4.compose(_pos, _quat, _scale.set(1.18 * pulse, 1.18 * pulse, 1.18 * pulse));
  _haloInst.setMatrixAt(i, _m4);
  _haloInst.setColorAt(i, _color.setHex(pal.halo));
}

function _flushVisuals() {
  if (!_coreInst || !_haloInst) return;
  const list = state.enemyProjectiles.active;
  _coreInst.count = list.length;
  _haloInst.count = list.length;
  for (let i = 0; i < list.length; i++) _writeVisual(i, list[i]);
  _coreInst.instanceMatrix.needsUpdate = true;
  _haloInst.instanceMatrix.needsUpdate = true;
  _coreInst.instanceColor.needsUpdate = true;
  _haloInst.instanceColor.needsUpdate = true;
}

/**
 * Spawn a hostile bolt. `kind` controls tint; optional dirX/dirZ overrides
 * hero aim. Returns false when the fixed pool is full.
 */
export function spawnEnemyProjectile(x, y, z, dmg = 9, speed = 9, ttl = 2.4, kind = 'magic', dirX = null, dirZ = null) {
  if (!_coreInst) initEnemyProjectileVisuals(state.scene || _scene);
  if (!_coreInst || _free.length === 0) return false;
  let dx, dz;
  if (typeof dirX === 'number' && typeof dirZ === 'number' && (dirX !== 0 || dirZ !== 0)) {
    dx = dirX; dz = dirZ;
  } else {
    const hero = state.hero.pos;
    dx = hero.x - x;
    dz = hero.z - z;
  }
  const d = Math.hypot(dx, dz) || 1;
  const p = _free.pop();
  p._leased = true;
  p.mesh.position.set(x, y || 0.86, z);
  p.vx = (dx / d) * speed;
  p.vz = (dz / d) * speed;
  p.ttl = ttl;
  p.dmg = dmg;
  p.age = 0;
  p.kind = _palette[kind] ? kind : 'magic';
  state.enemyProjectiles.active.push(p);
  _flushVisuals();
  return true;
}

function _removeAt(list, i) {
  const p = list[i];
  _release(p);
  const last = list.length - 1;
  if (i !== last) list[i] = list[last];
  list.pop();
}

/** Nova/defensive skills use this to vaporize hostile shots in-world. */
export function clearEnemyProjectilesInRadius(x, z, radius) {
  const list = state.enemyProjectiles.active;
  const r2 = radius * radius;
  let cleared = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const pp = list[i].mesh.position;
    const dx = pp.x - x, dz = pp.z - z;
    if (dx * dx + dz * dz > r2) continue;
    _removeAt(list, i);
    cleared++;
  }
  if (cleared) _flushVisuals();
  return cleared;
}

/** Return every lease; GPU meshes remain resident for the next run. */
export function clearEnemyProjectiles() {
  const list = state.enemyProjectiles.active;
  for (let i = 0; i < list.length; i++) _release(list[i]);
  list.length = 0;
  _hideAll();
}

export function updateEnemyProjectiles(dt) {
  const list = state.enemyProjectiles.active;
  const heroPos = state.hero.pos;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const pp = p.mesh.position;
    pp.x += p.vx * dt;
    pp.z += p.vz * dt;
    p.ttl -= dt;
    p.age += dt;
    const dx = pp.x - heroPos.x;
    const dz = pp.z - heroPos.z;
    const d2 = dx * dx + dz * dz;
    if (p.ttl <= 0 || Math.abs(dx) > WORLD_BOUND || Math.abs(dz) > WORLD_BOUND) {
      _removeAt(list, i);
      continue;
    }
    if (d2 <= HIT_R2) {
      heroTakeDamage(p.dmg, 'projectile');
      _removeAt(list, i);
    }
  }
  _flushVisuals();
}

export function getEnemyProjectilePoolStats() {
  return {
    capacity: MAX_LIVE_BOLTS,
    active: state.enemyProjectiles.active.length,
    free: _free.length,
    draws: _coreInst && _haloInst ? 2 : 0,
    coreCount: _coreInst ? _coreInst.count : 0,
    haloCount: _haloInst ? _haloInst.count : 0,
  };
}
