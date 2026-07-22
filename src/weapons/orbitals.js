/**
 * Cheesy Burgers — pooled orbital weapon.
 *
 * The old visual cloned a small GLB plus three translucent planes for every
 * burger. At gameplay scale that stack read as a gold ball and cost many draw
 * calls. The replacement is a camera-facing, hand-painted burger cutout backed
 * by one InstancedMesh, plus one subtle ground halo InstancedMesh. Collision,
 * damage cadence, poison evolution, and per-enemy hit gates are unchanged.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { damageEnemy, queryRadiusInto } from '../enemies.js';
import { tex } from '../particleTextures.js';
import { fxTex } from '../fxTextures.js';
import { sfx } from '../audio.js';
import { applyFloorTier, floorDecalGeometry, floorDecalMaterial } from '../fxLayers.js';

const ORBITAL_CAP = 8;
const HIT_RADIUS = 1.0;
const BURGER_SIZE = 1.45;
const BURGER_Y = 1.05;
const HALO_SIZE = 1.15;
const _orbitalQueryBuf = [];

let _burgerInst = null;
let _haloInst = null;
let _visualScene = null;
let _burgerBaseTex = null;
let _burgerToxicTex = null;

const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _billboardQuat = new THREE.Quaternion();
// floorDecalGeometry already bakes the -PI/2 rotation into its vertices.
const _floorQuat = new THREE.Quaternion();
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _hiddenMatrix = new THREE.Matrix4().compose(
  new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), _zeroScale,
);
const _haloColor = new THREE.Color();

function _ensureVisuals(scene) {
  if (_burgerInst) {
    if (_visualScene !== scene) {
      scene.add(_burgerInst, _haloInst);
      _visualScene = scene;
    }
    return;
  }

  _burgerBaseTex = fxTex('weapon_burger') || tex('bunCap');
  _burgerToxicTex = fxTex('weapon_burger_toxic') || _burgerBaseTex;
  const burgerGeo = new THREE.PlaneGeometry(BURGER_SIZE, BURGER_SIZE);
  const burgerMat = new THREE.MeshBasicMaterial({
    map: _burgerBaseTex,
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.06,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
  });
  _burgerInst = new THREE.InstancedMesh(burgerGeo, burgerMat, ORBITAL_CAP);
  _burgerInst.count = 0;
  _burgerInst.frustumCulled = false;
  _burgerInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _burgerInst.userData.visualRole = 'player_weapon';
  _burgerInst.userData.weaponId = 'orbitals';

  const haloGeo = floorDecalGeometry(HALO_SIZE);
  const haloMat = floorDecalMaterial({
    map: tex('glowGold'), color: 0xffffff, opacity: 0.22, side: THREE.FrontSide,
  });
  _haloInst = new THREE.InstancedMesh(haloGeo, haloMat, ORBITAL_CAP);
  _haloInst.count = 0;
  _haloInst.frustumCulled = false;
  _haloInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _haloInst.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(ORBITAL_CAP * 3), 3,
  );
  _haloInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  _haloInst.userData.visualRole = 'player_field';
  _haloInst.userData.weaponId = 'orbitals';
  applyFloorTier(_haloInst, 'player_field', { bloom: false });

  for (let i = 0; i < ORBITAL_CAP; i++) {
    _burgerInst.setMatrixAt(i, _hiddenMatrix);
    _haloInst.setMatrixAt(i, _hiddenMatrix);
    _haloInst.setColorAt(i, _haloColor.setHex(0xffd24a));
  }
  _burgerInst.instanceMatrix.needsUpdate = true;
  _haloInst.instanceMatrix.needsUpdate = true;
  _haloInst.instanceColor.needsUpdate = true;
  scene.add(_burgerInst, _haloInst);
  _visualScene = scene;
}

function _setVisualCount(count, evolved) {
  const n = Math.min(ORBITAL_CAP, Math.max(0, count | 0));
  _burgerInst.count = n;
  _haloInst.count = n;
  const burgerTex = evolved ? _burgerToxicTex : _burgerBaseTex;
  if (_burgerInst.material.map !== burgerTex) {
    _burgerInst.material.map = burgerTex;
    _burgerInst.material.needsUpdate = true;
  }
  const color = evolved ? 0x9dff58 : 0xffd24a;
  for (let i = 0; i < n; i++) _haloInst.setColorAt(i, _haloColor.setHex(color));
  _haloInst.instanceColor.needsUpdate = true;
}

function spawnOrbs(level, inst) {
  _ensureVisuals(state.scene);
  inst.orbs = [];
  const count = Math.min(level.count, ORBITAL_CAP);
  for (let i = 0; i < count; i++) {
    inst.orbs.push({
      pos: new THREE.Vector3(state.hero.pos.x, BURGER_Y, state.hero.pos.z),
      angle: (i / count) * Math.PI * 2,
      lastHitTime: new WeakMap(),
    });
  }
  // A refresh can reuse the global pool while old transforms are still in its
  // slots. Hide every slot before raising `.count`; the first weapon tick then
  // writes the fresh orbit positions without a one-frame ghost flash.
  for (let i = 0; i < ORBITAL_CAP; i++) {
    _burgerInst.setMatrixAt(i, _hiddenMatrix);
    _haloInst.setMatrixAt(i, _hiddenMatrix);
  }
  _burgerInst.instanceMatrix.needsUpdate = true;
  _haloInst.instanceMatrix.needsUpdate = true;
  _setVisualCount(count, !!inst.evolved);
}

function disposeOrbs(inst) {
  if (_burgerInst) _burgerInst.count = 0;
  if (_haloInst) _haloInst.count = 0;
  inst.orbs = null;
}

function _writeVisual(i, orb, pulse, haloPulse) {
  if (state.camera) _billboardQuat.copy(state.camera.quaternion);
  else _billboardQuat.identity();

  _scale.setScalar(pulse);
  _mat.compose(orb.pos, _billboardQuat, _scale);
  _burgerInst.setMatrixAt(i, _mat);

  _pos.set(orb.pos.x, 0.065, orb.pos.z);
  _scale.setScalar(haloPulse);
  _mat.compose(_pos, _floorQuat, _scale);
  _haloInst.setMatrixAt(i, _mat);
}

export default {
  id: 'orbitals',
  name: 'Cheesy Burgers',
  desc: 'Sacred cheeseburgers orbit you, smashing what they touch',
  icon: '🍔',
  maxLevel: 8,
  levels: [
    { count: 2, dmg: 8,  radius: 2.5, rotSpeed: 2.4, dmgInterval: 0.5 },
    { count: 3, dmg: 10, radius: 2.6, rotSpeed: 2.6, dmgInterval: 0.45 },
    { count: 3, dmg: 13, radius: 2.8, rotSpeed: 2.8, dmgInterval: 0.4 },
    { count: 4, dmg: 16, radius: 3.0, rotSpeed: 2.9, dmgInterval: 0.4 },
    { count: 4, dmg: 20, radius: 3.2, rotSpeed: 3.0, dmgInterval: 0.35 },
    { count: 5, dmg: 25, radius: 3.4, rotSpeed: 3.0, dmgInterval: 0.3 },
    { count: 5, dmg: 32, radius: 3.6, rotSpeed: 3.2, dmgInterval: 0.3 },
    { count: 6, dmg: 40, radius: 3.8, rotSpeed: 3.4, dmgInterval: 0.25 },
  ],

  init(_state, level, inst) {
    spawnOrbs(level, inst);
  },

  tick(_state, dt, level, inst) {
    if (!inst.orbs) return;
    const hero = state.hero.pos;
    const now = state.time.game;
    const radius = level.radius * (state.hero.statMul.area || 1);
    const dmgMul = state.hero.statMul.dmg || 1;
    const dmg = level.dmg * dmgMul * (inst.evolved ? 2.5 : 1);
    const radiusFinal = radius * (inst.evolved ? 1.15 : 1);

    if (inst.evolved && !inst._tinted) {
      inst._tinted = true;
      _setVisualCount(inst.orbs.length, true);
    }

    const visualPulse = 1 + Math.sin(now * 4.2) * 0.035;
    const haloPulse = 1 + Math.sin(now * 3.1) * 0.10;
    for (let i = 0; i < inst.orbs.length; i++) {
      const orb = inst.orbs[i];
      orb.angle += level.rotSpeed * dt;
      const x = hero.x + Math.cos(orb.angle) * radiusFinal;
      const z = hero.z + Math.sin(orb.angle) * radiusFinal;
      const bob = Math.sin(now * 3.1 + orb.angle * 2) * 0.08;
      orb.pos.set(x, BURGER_Y + bob, z);
      _writeVisual(i, orb, visualPulse, haloPulse);

      const candidates = queryRadiusInto(orb.pos, HIT_RADIUS, _orbitalQueryBuf);
      if (!candidates || candidates.length === 0) continue;
      for (const enemy of candidates) {
        if (!enemy || !enemy.alive) continue;
        const last = orb.lastHitTime.get(enemy) || -Infinity;
        if (now - last < level.dmgInterval) continue;
        const src = inst.evolved ? 'toxic_halo' : 'orbitals';
        damageEnemy(enemy, dmg, src);
        try { sfx.weaponBurger(); } catch (_) {}
        orb.lastHitTime.set(enemy, now);
        if (inst.evolved) {
          enemy._dotDps = dmg * 0.5;
          enemy._dotUntil = now + 1.0;
          enemy._dotSource = src;
        }
      }
    }
    _burgerInst.instanceMatrix.needsUpdate = true;
    _haloInst.instanceMatrix.needsUpdate = true;
  },

  refresh(_state, level, inst) {
    disposeOrbs(inst);
    spawnOrbs(level, inst);
  },

  dispose(_state, inst) {
    disposeOrbs(inst);
  },
};
