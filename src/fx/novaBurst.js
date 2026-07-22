/**
 * Player Nova Burst presentation.
 *
 * One reusable two-layer ground seal (kept below opaque actors) plus a single
 * InstancedMesh of Blender-authored crystal claws. Nova cannot overlap itself
 * because its shortest cooldown is seven seconds, so a single descriptor is a
 * truthful fixed pool and avoids hidden per-cast scene allocations.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { fxTex } from '../fxTextures.js';
import { GLTF_CACHE } from '../assets.js';
import { applyFloorTier } from '../fxLayers.js';

const LIFE = 0.82;
const SHARD_COUNT = 12;

let _scene = null;
let _seal = null;
let _wave = null;
let _sealMat = null;
let _waveMat = null;
let _shardInst = null;
let _active = null;

const _loader = new THREE.TextureLoader();
let _sealDirect = null;
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();
const _tumble = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function _getSealTexture() {
  const authored = fxTex('aoe_nova_pawburst');
  if (authored) return authored;
  if (!_sealDirect) {
    _sealDirect = _loader.load(new URL('../../assets/fx/aoe/nova_pawburst.webp', import.meta.url).href);
    _sealDirect.colorSpace = THREE.SRGBColorSpace;
    _sealDirect.minFilter = THREE.LinearMipmapLinearFilter;
    _sealDirect.magFilter = THREE.LinearFilter;
  }
  return _sealDirect;
}

export function initNovaBurst(scene) {
  if (_seal || !scene) return;
  _scene = scene;
  const geo = new THREE.PlaneGeometry(1, 1);
  _sealMat = new THREE.MeshBasicMaterial({
    map: _getSealTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    alphaTest: 0.025,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  _seal = new THREE.Mesh(geo, _sealMat);
  _seal.visible = false;
  _seal.userData.visualRole = 'active_nova';
  _seal.userData.gameplayPurpose = 'damage-radius';
  _seal.userData.asset = 'nova_pawburst';
  applyFloorTier(_seal, 'player_field', { bloom: false });

  _waveMat = new THREE.MeshBasicMaterial({
    map: fxTex('aoe_shockwave') || _getSealTexture(),
    color: 0xbffcff,
    transparent: true,
    opacity: 0,
    alphaTest: 0.015,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  _wave = new THREE.Mesh(geo, _waveMat);
  _wave.visible = false;
  _wave.userData.visualRole = 'active_nova';
  _wave.userData.gameplayPurpose = 'expanding-shockwave';
  applyFloorTier(_wave, 'player_field', { bloom: false });
  scene.add(_seal, _wave);
}

function _ensureShardPool() {
  if (_shardInst || !_scene) return !!_shardInst;
  const gltf = GLTF_CACHE.fx_nova_claw;
  if (!gltf || !gltf.scene) return false;
  let source = null;
  gltf.scene.updateWorldMatrix(true, true);
  gltf.scene.traverse((o) => { if (!source && o.isMesh && o.geometry) source = o; });
  if (!source) return false;
  const geo = source.geometry.clone();
  geo.applyMatrix4(source.matrixWorld);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd9ffff,
    emissive: 0x45bfc8,
    emissiveIntensity: 0.75,
    roughness: 0.34,
    metalness: 0.12,
    depthTest: true,
    depthWrite: true,
  });
  _shardInst = new THREE.InstancedMesh(geo, mat, SHARD_COUNT);
  _shardInst.count = 0;
  _shardInst.frustumCulled = false;
  _shardInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _shardInst.castShadow = false;
  _shardInst.receiveShadow = false;
  _shardInst.userData.visualRole = 'active_nova';
  _shardInst.userData.asset = 'nova_claw_shard.glb';
  _shardInst.userData.gameplayPurpose = 'outward-blast-fragments';
  _scene.add(_shardInst);
  return true;
}

/** Start/restart the single player-Nova visual lease. */
export function spawnNovaBurst(x, z, radius, level = 1) {
  if (!_seal) initNovaBurst(state.scene || _scene);
  if (!_seal) return false;
  _ensureShardPool();
  _active = {
    x, z, radius,
    level,
    t: 0,
    rot: ((state.time && state.time.real) || 0) * 0.7,
    reduceMotion: !!state._optReduceMotion,
    reducedFlash: !!state._optReducedFlashing,
  };
  _seal.visible = true;
  _wave.visible = true;
  if (_shardInst) _shardInst.count = _active.reduceMotion ? 6 : SHARD_COUNT;
  return true;
}

function _finish() {
  _active = null;
  if (_seal) _seal.visible = false;
  if (_wave) _wave.visible = false;
  if (_sealMat) _sealMat.opacity = 0;
  if (_waveMat) _waveMat.opacity = 0;
  if (_shardInst) {
    _shardInst.count = 0;
    _shardInst.instanceMatrix.needsUpdate = true;
  }
}

export function updateNovaBurst(dt) {
  if (!_active) return;
  const a = _active;
  a.t += dt;
  const k = Math.min(1, a.t / LIFE);
  if (k >= 1) { _finish(); return; }
  const ease = 1 - Math.pow(1 - k, 3);
  const appear = Math.min(1, k * 9);
  const fade = k < 0.56 ? 1 : 1 - (k - 0.56) / 0.44;
  const flashMul = a.reducedFlash ? 0.62 : 1;

  _pos.set(a.x, 0.072, a.z);
  _yaw.setFromAxisAngle(_up, a.rot - k * 0.30);
  _seal.quaternion.copy(_yaw).multiply(_flat);
  _seal.position.copy(_pos);
  const sealSize = a.radius * 2 * (0.28 + ease * 0.72);
  _seal.scale.set(sealSize, sealSize, 1);
  _sealMat.opacity = 0.84 * appear * fade * flashMul;

  _pos.y = 0.078;
  _yaw.setFromAxisAngle(_up, -a.rot + k * 0.44);
  _wave.quaternion.copy(_yaw).multiply(_flat);
  _wave.position.copy(_pos);
  const waveSize = a.radius * 2 * (0.22 + ease * 0.94);
  _wave.scale.set(waveSize, waveSize, 1);
  _waveMat.opacity = 0.34 * appear * fade * fade * flashMul;

  if (!_shardInst) return;
  const count = a.reduceMotion ? 6 : SHARD_COUNT;
  _shardInst.count = count;
  const shardFade = Math.min(1, appear * 1.4) * Math.min(1, (1 - k) * 4.5);
  for (let i = 0; i < count; i++) {
    const ang = a.rot + (i / count) * Math.PI * 2;
    const dist = a.radius * (0.10 + ease * 0.91);
    const lift = a.reduceMotion ? 0.20 : 0.18 + Math.sin(k * Math.PI) * (0.85 + a.level * 0.08);
    _pos.set(a.x + Math.cos(ang) * dist, lift, a.z + Math.sin(ang) * dist);
    _yaw.setFromAxisAngle(_up, -ang);
    const tumble = a.reduceMotion ? 0 : k * Math.PI * (1.3 + (i % 3) * 0.22) * (i % 2 ? 1 : -1);
    _euler.set(tumble * 0.18, 0, tumble);
    _tumble.setFromEuler(_euler);
    _quat.copy(_yaw).multiply(_tumble);
    const size = (0.48 + a.level * 0.035) * shardFade;
    _m4.compose(_pos, _quat, _scale.set(size, size, size));
    _shardInst.setMatrixAt(i, _m4);
  }
  _shardInst.instanceMatrix.needsUpdate = true;
}

export function resetNovaBurst() { _finish(); }

export function getNovaBurstDebug() {
  const image = _sealMat && _sealMat.map && _sealMat.map.image;
  return {
    active: !!_active,
    radius: _active ? _active.radius : 0,
    sealVisible: !!(_seal && _seal.visible),
    waveVisible: !!(_wave && _wave.visible),
    shardCount: _shardInst ? _shardInst.count : 0,
    assetReady: !!_shardInst,
    sealRenderOrder: _seal ? _seal.renderOrder : null,
    sealBloom: !!(_seal && _seal.layers.isEnabled(1)),
    sealImageWidth: image ? (image.naturalWidth || image.width || 0) : 0,
    sealImageHeight: image ? (image.naturalHeight || image.height || 0) : 0,
    sealImageSrc: image ? (image.currentSrc || image.src || '') : '',
  };
}
