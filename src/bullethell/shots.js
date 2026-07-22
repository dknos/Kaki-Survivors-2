/**
 * Player shots for bullet-hell mode. Hold-to-fire: LMB / RT / auto-fire
 * toggle (isPrimaryFiring in input.js) gates emission; aim comes from
 * getAimDirection when the mouse is live, else hero facing. Pooled
 * InstancedMesh like bullets.js — one draw call.
 */
import * as THREE from 'three';
import { recordDps } from '../dpsWindow.js';
import { state } from '../state.js';
import { isPrimaryFiring, isManualAiming, getAimDirection } from '../input.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { spawnDamageNumber } from '../damageNumbers.js';
import { sfx } from '../audio.js';
import { bh } from './bhState.js';
import { damageFoe, nearestFoe } from './foes.js';

const MAX_SHOTS = 160;
const SHOT_Y = 1.1;
const _color = new THREE.Color(0xaef7ff);
const _critColor = new THREE.Color(0xfff3a0);

let _mesh = null;
let _shotTex = null;
const _slots = [];
const _free = [];
let _cooldown = 0;
let _volleyCount = 0;   // fire-SFX throttle: zap every 2nd volley
const _m4 = new THREE.Matrix4();
const _quatFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _sc = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _dmgPos = new THREE.Vector3();

export function initShots(scene) {
  if (!_shotTex) {
    _shotTex = new THREE.TextureLoader().load('assets/fx/bullethell/paw_shot.webp');
    _shotTex.colorSpace = THREE.SRGBColorSpace;
  }
  const geo = new THREE.PlaneGeometry(0.7, 1.7);   // paw-comet silhouette
  const mat = new THREE.MeshBasicMaterial({
    map: _shotTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _mesh = new THREE.InstancedMesh(geo, mat, MAX_SHOTS);
  _mesh.userData.kkBulletHell = true;
  _mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHOTS * 3), 3);
  _mesh.count = 0;
  _mesh.visible = false;
  _mesh.frustumCulled = false;
  _mesh.layers.enable(BLOOM_LAYER);
  _slots.length = 0; _free.length = 0;
  for (let i = 0; i < MAX_SHOTS; i++) { _slots.push(null); _free.push(i); _hideSlot(i); }
  _mesh.instanceMatrix.needsUpdate = true;
  _cooldown = 0;
  _volleyCount = 0;
  scene.add(_mesh);
}

function _hideSlot(i) {
  _m4.compose(_pos.set(0, -100, 0), _quatFlat, _sc.set(0.001, 0.001, 0.001));
  _mesh.setMatrixAt(i, _m4);
}

function _releaseSlot(i) {
  if (!_slots[i]) return false;
  _slots[i] = null;
  _free.push(i);
  _hideSlot(i);
  if (_free.length === MAX_SHOTS) {
    _mesh.count = 0;
    _mesh.visible = false;
  }
  return true;
}

function _fireVolley() {
  const s = bh.stats;
  const h = state.hero.pos;
  let dx, dz;
  if (isManualAiming()) {
    const d = getAimDirection();
    dx = d.x; dz = d.z;
  } else {
    // Auto-target the nearest foe (matches survivors primary.js). The old
    // fallback fired down the hero's MOVEMENT vector, so gamepad-RT / touch /
    // idle-mouse players shot empty space while kiting. Fall back to facing
    // only when the field is empty.
    const f = nearestFoe(h.x, h.z);
    if (f) { dx = f.x - h.x; dz = f.z - h.z; }
    else { dx = state.hero.facing.x; dz = state.hero.facing.z; }
  }
  const len = Math.hypot(dx, dz) || 1;
  const base = Math.atan2(dz / len, dx / len);
  // Fire report: row-pitched procedural zap, every 2nd volley so a maxed
  // fire-rate build chatters instead of machine-gunning the bus. The row
  // deepens as fire rate stacks — upgrades are audible.
  _volleyCount++;
  if (_volleyCount % 2 === 0 && sfx && sfx.weaponPrimary) {
    sfx.weaponPrimary({ row: Math.min(8, 1 + Math.floor(s.fireRate - 4)) });
  }
  const n = s.shotCount;
  const spread = n > 1 ? 0.16 * (n - 1) : 0;
  let allocatedAny = false;
  for (let i = 0; i < n; i++) {
    if (_free.length === 0) break;
    if (_free.length === MAX_SHOTS) {
      _mesh.count = MAX_SHOTS;
      _mesh.visible = true;
    }
    const a = base + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
    const crit = s.critChance > 0 && Math.random() < s.critChance;
    const slot = _free.pop();
    _slots[slot] = {
      x: h.x, z: h.z,
      vx: Math.cos(a) * s.shotSpeed, vz: Math.sin(a) * s.shotSpeed,
      ttl: s.shotRange / s.shotSpeed,
      dmg: crit ? s.dmg * 3 : s.dmg,
      crit,
      pierceLeft: s.pierce,
      hit: new Set(),        // foes already hit (pierce shouldn't double-tap)
    };
    _mesh.setColorAt(slot, crit ? _critColor : _color);
    allocatedAny = true;
  }
  if (allocatedAny && _mesh.instanceColor) _mesh.instanceColor.needsUpdate = true;
}

function _recordHitPopup(f, dmg, crit) {
  const now = state.time.game;
  if (!Number.isFinite(f._bhPopupAt)) f._bhPopupAt = now;
  f._bhPopupDamage = (f._bhPopupDamage || 0) + dmg;
  f._bhPopupCrit = !!(f._bhPopupCrit || crit);
  // Crits and finishing blows pop immediately; normal fire is coalesced into a
  // compact total roughly three times a second instead of one DOM node per hit.
  if (!crit && f.hp > 0 && now - f._bhPopupAt < 0.32) return;
  spawnDamageNumber(
    _dmgPos.set(f.x, 1.4, f.z),
    Math.round(f._bhPopupDamage),
    f._bhPopupCrit ? 'bhCrit' : 'bh',
  );
  f._bhPopupAt = now;
  f._bhPopupDamage = 0;
  f._bhPopupCrit = false;
}

export function updateShots(dt) {
  if (!_mesh) return;
  // Emission
  _cooldown -= dt;
  if (isPrimaryFiring() && _cooldown <= 0 && !state.gameOver) {
    _fireVolley();
    _cooldown = 1 / bh.stats.fireRate;
  }
  if (_free.length === MAX_SHOTS) return;
  // Motion + foe collision
  const homing = bh.stats.homing;
  for (let i = 0; i < MAX_SHOTS; i++) {
    const p = _slots[i];
    if (!p) continue;
    if (homing > 0) {
      const f = nearestFoe(p.x, p.z, p.hit);
      if (f) {
        const tx = f.x - p.x, tz = f.z - p.z;
        const tl = Math.hypot(tx, tz) || 1;
        const sp = Math.hypot(p.vx, p.vz);
        p.vx += (tx / tl) * sp * homing * dt;
        p.vz += (tz / tl) * sp * homing * dt;
        const vl = Math.hypot(p.vx, p.vz) || 1;
        p.vx = (p.vx / vl) * sp; p.vz = (p.vz / vl) * sp;
      }
    }
    // Substepped move + collide: never advance more than ~0.7u per check so
    // a fast shot can't tunnel through a foe body between frames.
    p.ttl -= dt;
    let dead = p.ttl <= 0;
    const stepLen = Math.hypot(p.vx, p.vz) * dt;
    const nSub = Math.max(1, Math.ceil(stepLen / 0.7));
    for (let s = 0; s < nSub && !dead; s++) {
      p.x += (p.vx * dt) / nSub;
      p.z += (p.vz * dt) / nSub;
      const f = nearestFoe(p.x, p.z, p.hit);
      if (f) {
        const dx = f.x - p.x, dz = f.z - p.z;
        if (dx * dx + dz * dz <= f.r * f.r) {
          damageFoe(f, p.dmg);
          _recordHitPopup(f, p.dmg, p.crit);
          // Feed the shared run tallies so the death screen + DPS readout
          // work in this mode (meta commit is gated in ui.js, so these
          // can't inflate survivors progression).
          if (state.run) {
            state.run.dmgDealt = (state.run.dmgDealt || 0) + p.dmg;
            recordDps(state.run._dpsWin, state.time.game, p.dmg);
          }
          p.hit.add(f);
          if (p.pierceLeft > 0) p.pierceLeft--;
          else dead = true;
        }
      }
    }
    if (dead) {
      _releaseSlot(i);
      continue;
    }
    // Same flat-then-yaw orientation the enemyProjectiles trail uses.
    const yaw = Math.atan2(p.vx, p.vz);
    _e.set(-Math.PI / 2, yaw, 0);
    _q.setFromEuler(_e);
    _m4.compose(_pos.set(p.x, SHOT_Y, p.z), _q, _sc.set(1, 1, 1));
    _mesh.setMatrixAt(i, _m4);
  }
  _mesh.instanceMatrix.needsUpdate = true;
}

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();

export function disposeShots(scene) {
  if (!_mesh) return;
  scene.remove(_mesh);
  _mesh.geometry.dispose();
  _mesh.material.dispose();
  _mesh = null;
  _slots.length = 0; _free.length = 0;
  _cooldown = 0;
  _volleyCount = 0;
}
