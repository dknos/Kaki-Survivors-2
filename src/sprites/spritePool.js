/**
 * Fixed-capacity, zero-hot-allocation atlas sprite pools.
 *
 * V1 retains generic named animations for FX and non-Forest enemy fallback.
 * V2 adds numeric species/state/direction control while preserving one
 * InstancedMesh submission per atlas page (one page in the shipped Forest set,
 * no more than two by schema).
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { createSpritePoolMaterial } from '../rendering/materials/spritePoolMaterial.js';
import { ENEMY_SPRITE_COMPLETION, getAtlas } from './spriteAtlas.js';

const DEFAULT_POOL_CAP = 256;
const STASH_Y = -10000;
const PAGE_NONE = 255;
const DIRECTION_HYSTERESIS = 0.14;
const HIT_DURATION = 0.12;
const SQRT_HALF = Math.SQRT1_2;

export const ENEMY_SPRITE_STATE = Object.freeze({
  MOVE: 0,
  ATTACK: 1,
  DEATH: 2,
  IDLE: 3,
});

export const ENEMY_SPRITE_DIRECTION = Object.freeze({
  TOWARD_CAMERA: 0,
  CAMERA_RIGHT: 1,
  AWAY_FROM_CAMERA: 2,
  CAMERA_LEFT: 3,
});

const _pools = new Map();
const _poolList = [];
const _cameraDirection = new THREE.Vector3();
let _globalLowFx = () => false;
let _towardCameraX = SQRT_HALF;
let _towardCameraZ = SQRT_HALF;
let _cameraRightX = SQRT_HALF;
let _cameraRightZ = -SQRT_HALF;

export function hasSpritePool(atlasId) {
  return _pools.has(atlasId);
}

export function setLowFxProbe(fn) {
  if (typeof fn === 'function') _globalLowFx = fn;
}

function createPage(scene, atlas, page, cap, stashMatrix) {
  const geom = new THREE.PlaneGeometry(1, 1);
  const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  const scaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  const flashAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  const flipAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  const poseArray = new Float32Array(cap * 3);
  for (let index = 0; index < cap; index++) {
    poseArray[index * 3] = 1;
    poseArray[index * 3 + 1] = 1;
  }
  const poseAttr = new THREE.InstancedBufferAttribute(poseArray, 3);
  for (const attribute of [frameAttr, scaleAttr, flashAttr, flipAttr, poseAttr]) {
    attribute.setUsage(THREE.DynamicDrawUsage);
  }
  geom.setAttribute('aFrame', frameAttr);
  geom.setAttribute('aScale', scaleAttr);
  geom.setAttribute('aFlash', flashAttr);
  geom.setAttribute('aFlip', flipAttr);
  geom.setAttribute('aPose', poseAttr);

  const materialAtlas = {
    ...atlas,
    ...page,
    texture: page.texture,
  };
  const material = createSpritePoolMaterial(materialAtlas, {
    alphaTest: atlas.alphaTest,
    cutout: atlas.cutout,
    depthWrite: atlas.depthWrite,
    gutterPixels: atlas.framePadding?.gutterPixels ?? 0,
  });
  const mesh = new THREE.InstancedMesh(geom, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.count = cap;
  mesh.userData.visualRole = 'sprite_pool';
  mesh.userData.atlasId = atlas.id;
  mesh.userData.atlasPage = page.id;
  mesh.userData.poolCapacity = cap;
  if (atlas.bloom) mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  for (let index = 0; index < cap; index++) mesh.setMatrixAt(index, stashMatrix);
  mesh.instanceMatrix.needsUpdate = true;
  return {
    id: page.id,
    atlasPage: page,
    geom,
    material,
    mesh,
    frameAttr,
    scaleAttr,
    flashAttr,
    flipAttr,
    poseAttr,
    activeCount: 0,
    frameDirty: false,
    poseDirty: false,
  };
}

export function ensurePool(scene, atlasId, cap = DEFAULT_POOL_CAP, opts = {}) {
  if (_pools.has(atlasId)) return _pools.get(atlasId);
  const atlas = getAtlas(atlasId);
  if (!atlas) throw new Error(`[spritePool] atlas not loaded: ${atlasId}`);
  if (!Number.isInteger(cap) || cap <= 0 || cap > 65535) {
    throw new RangeError('[spritePool] cap must be an integer from 1 through 65535');
  }

  const stashMatrix = new THREE.Matrix4();
  stashMatrix.setPosition(0, STASH_Y, 0);
  const pages = atlas.pages.map((page) => createPage(scene, atlas, page, cap, stashMatrix));
  const pool = {
    atlasId,
    atlas,
    pages,
    cap,
    bypassWhenLowFx: !!opts.bypassWhenLowFx,
    // First-page aliases preserve the released debugging/test surface.
    mesh: pages[0].mesh,
    geom: pages[0].geom,
    material: pages[0].material,
    frameAttr: pages[0].frameAttr,
    scaleAttr: pages[0].scaleAttr,
    flashAttr: pages[0].flashAttr,
    flipAttr: pages[0].flipAttr,
    poseAttr: pages[0].poseAttr,
    // Shared, fixed-capacity per-slot state. No objects are created in tick.
    sX: new Float32Array(cap),
    sY: new Float32Array(cap),
    sZ: new Float32Array(cap),
    sScale: new Float32Array(cap),
    sFlash: new Float32Array(cap),
    sPoseX: new Float32Array(cap),
    sPoseY: new Float32Array(cap),
    sLean: new Float32Array(cap),
    sFrom: new Uint16Array(cap),
    sTo: new Uint16Array(cap),
    sFps: new Float32Array(cap),
    sLoop: new Uint8Array(cap),
    sElapsed: new Float32Array(cap),
    sAlive: new Uint8Array(cap),
    sBornAt: new Uint32Array(cap),
    sGeneration: new Uint32Array(cap),
    sPage: new Uint8Array(cap),
    sSpecies: new Uint8Array(cap),
    sState: new Uint8Array(cap),
    sDirection: new Uint8Array(cap),
    sMotionKind: new Uint8Array(cap),
    sCompletion: new Uint8Array(cap),
    sFallbackState: new Uint8Array(cap),
    sFlip: new Uint8Array(cap),
    sVx: new Float32Array(cap),
    sVz: new Float32Array(cap),
    sSpeed: new Float32Array(cap),
    sNominalSpeed: new Float32Array(cap),
    sPlaybackRate: new Float32Array(cap),
    sRateMin: new Float32Array(cap),
    sRateMax: new Float32Array(cap),
    sReturnPhase: new Float32Array(cap),
    sHitRemaining: new Float32Array(cap),
    sHitSign: new Int8Array(cap),
    activeCount: 0,
    _writeIdx: 0,
    _spawnTick: 0,
    _stashMatrix: stashMatrix,
    _matrix: new THREE.Matrix4(),
  };
  pool.sPage.fill(PAGE_NONE);
  pool.sPoseX.fill(1);
  pool.sPoseY.fill(1);
  pool.sPlaybackRate.fill(1);
  _pools.set(atlasId, pool);
  _poolList.push(pool);
  return pool;
}

function hashPhase(value) {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function encodeHandle(pool, slot) {
  return pool.sGeneration[slot] * pool.cap + slot;
}

function decodeHandle(pool, handle) {
  if (!Number.isSafeInteger(handle) || handle < 0) return -1;
  const slot = handle % pool.cap;
  const generation = Math.floor(handle / pool.cap);
  if (pool.sAlive[slot] === 0 || pool.sGeneration[slot] !== generation) return -1;
  return slot;
}

function markAllVisualAttributes(page) {
  page.frameAttr.needsUpdate = true;
  page.scaleAttr.needsUpdate = true;
  page.flashAttr.needsUpdate = true;
  page.flipAttr.needsUpdate = true;
  page.poseAttr.needsUpdate = true;
}

function writeMatrix(pool, page, slot) {
  pool._matrix.identity();
  pool._matrix.setPosition(pool.sX[slot], pool.sY[slot], pool.sZ[slot]);
  page.mesh.setMatrixAt(slot, pool._matrix);
  page.mesh.instanceMatrix.needsUpdate = true;
}

function writeVisualAttributes(pool, page, slot) {
  page.scaleAttr.array[slot] = pool.sScale[slot];
  page.flashAttr.array[slot] = pool.sFlash[slot];
  page.flipAttr.array[slot] = pool.sFlip[slot];
  const offset = slot * 3;
  page.poseAttr.array[offset] = pool.sPoseX[slot];
  page.poseAttr.array[offset + 1] = pool.sPoseY[slot];
  page.poseAttr.array[offset + 2] = pool.sLean[slot];
  markAllVisualAttributes(page);
}

function switchPage(pool, slot, pageId) {
  const previousId = pool.sPage[slot];
  if (previousId === pageId) return;
  if (previousId !== PAGE_NONE) {
    const previous = pool.pages[previousId];
    previous.mesh.setMatrixAt(slot, pool._stashMatrix);
    previous.mesh.instanceMatrix.needsUpdate = true;
    previous.activeCount = Math.max(0, previous.activeCount - 1);
    if (previous.activeCount === 0) previous.mesh.visible = false;
  }
  pool.sPage[slot] = pageId;
  const page = pool.pages[pageId];
  page.activeCount += 1;
  page.mesh.visible = true;
  writeMatrix(pool, page, slot);
  writeVisualAttributes(pool, page, slot);
}

function clearPageAttributes(page, slot) {
  page.frameAttr.array[slot] = 0;
  page.scaleAttr.array[slot] = 0;
  page.flashAttr.array[slot] = 0;
  page.flipAttr.array[slot] = 0;
  const offset = slot * 3;
  page.poseAttr.array[offset] = 1;
  page.poseAttr.array[offset + 1] = 1;
  page.poseAttr.array[offset + 2] = 0;
  markAllVisualAttributes(page);
}

function releaseSlotByIndex(pool, slot) {
  if (pool.sAlive[slot] === 0) return false;
  const pageId = pool.sPage[slot];
  if (pageId !== PAGE_NONE) {
    const page = pool.pages[pageId];
    page.mesh.setMatrixAt(slot, pool._stashMatrix);
    page.mesh.instanceMatrix.needsUpdate = true;
    clearPageAttributes(page, slot);
    page.activeCount = Math.max(0, page.activeCount - 1);
    if (page.activeCount === 0) page.mesh.visible = false;
  }
  pool.sAlive[slot] = 0;
  pool.sPage[slot] = PAGE_NONE;
  pool.sElapsed[slot] = 0;
  pool.sFlash[slot] = 0;
  pool.sHitRemaining[slot] = 0;
  pool.sPoseX[slot] = 1;
  pool.sPoseY[slot] = 1;
  pool.sLean[slot] = 0;
  pool.activeCount = Math.max(0, pool.activeCount - 1);
  return true;
}

function leaseSlot(pool) {
  let slot = -1;
  for (let probe = 0; probe < pool.cap; probe++) {
    const index = (pool._writeIdx + probe) % pool.cap;
    if (pool.sAlive[index] === 0) { slot = index; break; }
  }
  if (slot < 0) {
    // Detached death one-shots are expendable under burst pressure; never
    // evict a still-logical looping enemy while a corpse slot is available.
    let oldest = 0xffffffff;
    for (let index = 0; index < pool.cap; index++) {
      if (pool.sLoop[index]) continue;
      if (pool.sBornAt[index] <= oldest) {
        oldest = pool.sBornAt[index];
        slot = index;
      }
    }
    if (slot < 0) {
      oldest = 0xffffffff;
      for (let index = 0; index < pool.cap; index++) {
        if (pool.sBornAt[index] <= oldest) {
          oldest = pool.sBornAt[index];
          slot = index;
        }
      }
    }
    releaseSlotByIndex(pool, slot);
  }
  pool._writeIdx = (slot + 1) % pool.cap;
  let generation = (pool.sGeneration[slot] + 1) >>> 0;
  if (generation === 0) generation = 1;
  pool.sGeneration[slot] = generation;
  pool.sBornAt[slot] = pool._spawnTick++ >>> 0;
  pool.sAlive[slot] = 1;
  pool.activeCount += 1;
  return slot;
}

function initializeSlot(pool, slot, opts) {
  pool.sX[slot] = Number(opts.x) || 0;
  pool.sY[slot] = Number(opts.y) || 0;
  pool.sZ[slot] = Number(opts.z) || 0;
  pool.sScale[slot] = Number.isFinite(opts.scale) ? opts.scale : 1;
  pool.sFlash[slot] = 0;
  pool.sPoseX[slot] = 1;
  pool.sPoseY[slot] = 1;
  pool.sLean[slot] = 0;
  pool.sFlip[slot] = 0;
  pool.sHitRemaining[slot] = 0;
  pool.sHitSign[slot] = ((pool.sBornAt[slot] ^ slot) & 1) ? 1 : -1;
  pool.sReturnPhase[slot] = 0;
}

function animationDuration(pool, slot) {
  const frames = pool.sTo[slot] - pool.sFrom[slot] + 1;
  const fps = pool.sFps[slot];
  return fps > 0 ? frames / fps : 0;
}

function setCurrentFrame(pool, slot) {
  const pageId = pool.sPage[slot];
  if (pageId === PAGE_NONE) return;
  const page = pool.pages[pageId];
  const frames = pool.sTo[slot] - pool.sFrom[slot] + 1;
  const offset = Math.min(frames - 1, Math.floor(pool.sElapsed[slot] * pool.sFps[slot]));
  const frame = pool.sFrom[slot] + Math.max(0, offset);
  if (page.frameAttr.array[slot] !== frame) {
    page.frameAttr.array[slot] = frame;
    page.frameAttr.needsUpdate = true;
  }
}

function setV1Descriptor(pool, slot, animation, restart, randomize) {
  const oldDuration = animationDuration(pool, slot);
  const phase = oldDuration > 0 ? pool.sElapsed[slot] / oldDuration : 0;
  pool.sFrom[slot] = animation.from;
  pool.sTo[slot] = animation.to;
  pool.sFps[slot] = animation.fps;
  pool.sLoop[slot] = animation.loop ? 1 : 0;
  pool.sCompletion[slot] = animation.loop
    ? ENEMY_SPRITE_COMPLETION.loop
    : ENEMY_SPRITE_COMPLETION.release;
  switchPage(pool, slot, 0);
  const duration = animationDuration(pool, slot);
  if (restart) {
    pool.sElapsed[slot] = randomize && animation.loop
      ? hashPhase(pool.sBornAt[slot] ^ pool.sGeneration[slot]) * duration
      : 0;
  } else {
    pool.sElapsed[slot] = Math.min(Math.max(0, phase), 0.999999) * duration;
  }
  setCurrentFrame(pool, slot);
}

function rawDirection(vx, vz) {
  const front = vx * _towardCameraX + vz * _towardCameraZ;
  const right = vx * _cameraRightX + vz * _cameraRightZ;
  if (Math.abs(front) >= Math.abs(right)) {
    return front >= 0 ? ENEMY_SPRITE_DIRECTION.TOWARD_CAMERA : ENEMY_SPRITE_DIRECTION.AWAY_FROM_CAMERA;
  }
  return right >= 0 ? ENEMY_SPRITE_DIRECTION.CAMERA_RIGHT : ENEMY_SPRITE_DIRECTION.CAMERA_LEFT;
}

function directionScore(direction, front, right) {
  if (direction === ENEMY_SPRITE_DIRECTION.TOWARD_CAMERA) return front;
  if (direction === ENEMY_SPRITE_DIRECTION.CAMERA_RIGHT) return right;
  if (direction === ENEMY_SPRITE_DIRECTION.AWAY_FROM_CAMERA) return -front;
  return -right;
}

function hystereticDirection(current, vx, vz) {
  const magnitude = Math.hypot(vx, vz);
  if (magnitude < 0.0001) return current;
  const candidate = rawDirection(vx, vz);
  if (candidate === current) return current;
  const front = vx * _towardCameraX + vz * _towardCameraZ;
  const right = vx * _cameraRightX + vz * _cameraRightZ;
  const candidateScore = directionScore(candidate, front, right);
  const currentScore = directionScore(current, front, right);
  return candidateScore > currentScore + magnitude * DIRECTION_HYSTERESIS ? candidate : current;
}

function descriptorIndex(compiled, speciesId, stateId, directionId) {
  return ((speciesId * compiled.stateCount + stateId) * compiled.directionCount) + directionId;
}

function setV2Descriptor(pool, slot, stateId, directionId, restart) {
  const compiled = pool.atlas.compiled;
  let index = descriptorIndex(compiled, pool.sSpecies[slot], stateId, directionId);
  if (!compiled.valid[index]) {
    stateId = compiled.fallbackState[pool.sSpecies[slot]];
    directionId = compiled.defaultDirection[pool.sSpecies[slot]];
    index = descriptorIndex(compiled, pool.sSpecies[slot], stateId, directionId);
  }
  if (!compiled.valid[index]) return false;
  const oldDuration = animationDuration(pool, slot);
  const oldPhase = oldDuration > 0 ? pool.sElapsed[slot] / oldDuration : 0;
  pool.sState[slot] = stateId;
  pool.sDirection[slot] = directionId;
  pool.sFrom[slot] = compiled.from[index];
  pool.sTo[slot] = compiled.to[index];
  pool.sFps[slot] = compiled.fps[index];
  pool.sLoop[slot] = compiled.loop[index];
  pool.sCompletion[slot] = compiled.completion[index];
  pool.sFallbackState[slot] = compiled.fallbackForState[index];
  pool.sFlip[slot] = compiled.flip[index];
  switchPage(pool, slot, compiled.page[index]);
  const page = pool.pages[pool.sPage[slot]];
  page.flipAttr.array[slot] = pool.sFlip[slot];
  page.flipAttr.needsUpdate = true;
  const duration = animationDuration(pool, slot);
  pool.sElapsed[slot] = restart ? 0 : Math.min(Math.max(0, oldPhase), 0.999999) * duration;
  setCurrentFrame(pool, slot);
  return true;
}

function updatePlaybackRate(pool, slot) {
  const nominal = Math.max(0.0001, pool.sNominalSpeed[slot]);
  const ratio = Math.max(0, pool.sSpeed[slot]) / nominal;
  let rate = 0.35 + ratio * 0.65;
  if (rate < pool.sRateMin[slot]) rate = pool.sRateMin[slot];
  if (rate > pool.sRateMax[slot]) rate = pool.sRateMax[slot];
  pool.sPlaybackRate[slot] = rate;
}

/** Generic v1 spawn; stateful enemies should use spawnEnemySprite for v2. */
export function spawnSprite(atlasId, opts) {
  const pool = _pools.get(atlasId);
  if (!pool || pool.atlas.version !== 1) return -1;
  if (pool.bypassWhenLowFx && _globalLowFx()) return -1;
  const animation = pool.atlas.anims[opts.anim ?? 'default'] ?? pool.atlas.anims.default;
  if (!animation) return -1;
  const slot = leaseSlot(pool);
  initializeSlot(pool, slot, opts);
  setV1Descriptor(pool, slot, animation, true, opts.randomizePhase !== false);
  return encodeHandle(pool, slot);
}

/** Spawn a v2 enemy by numeric species/state without allocating per-slot data. */
export function spawnEnemySprite(atlasId, opts) {
  const pool = _pools.get(atlasId);
  const compiled = pool?.atlas?.compiled;
  if (!pool || !compiled || (pool.bypassWhenLowFx && _globalLowFx())) return -1;
  const speciesId = opts.speciesId;
  if (!Number.isInteger(speciesId) || !compiled.speciesValid[speciesId]) return -1;
  const slot = leaseSlot(pool);
  initializeSlot(pool, slot, opts);
  pool.sSpecies[slot] = speciesId;
  pool.sMotionKind[slot] = compiled.motionKind[speciesId];
  pool.sNominalSpeed[slot] = Number.isFinite(opts.nominalSpeed)
    ? Math.max(0.0001, opts.nominalSpeed)
    : compiled.nominalSpeed[speciesId];
  pool.sRateMin[slot] = compiled.rateMin[speciesId];
  pool.sRateMax[slot] = compiled.rateMax[speciesId];
  pool.sVx[slot] = Number(opts.vx) || 0;
  pool.sVz[slot] = Number(opts.vz) || 0;
  pool.sSpeed[slot] = Number.isFinite(opts.speed) ? Math.max(0, opts.speed) : Math.hypot(pool.sVx[slot], pool.sVz[slot]);
  updatePlaybackRate(pool, slot);
  const moving = Math.abs(pool.sVx[slot]) + Math.abs(pool.sVz[slot]) > 0.0001;
  const direction = Number.isInteger(opts.directionId)
    ? opts.directionId
    : (moving ? rawDirection(pool.sVx[slot], pool.sVz[slot]) : compiled.defaultDirection[speciesId]);
  const state = Number.isInteger(opts.stateId) ? opts.stateId : compiled.fallbackState[speciesId];
  if (!setV2Descriptor(pool, slot, state, direction, true)) {
    releaseSlotByIndex(pool, slot);
    return -1;
  }
  if (pool.sLoop[slot]) {
    const hasSeed = Number.isFinite(opts.seed);
    const seed = hasSeed
      ? opts.seed >>> 0
      : (pool.sBornAt[slot] ^ pool.sGeneration[slot]);
    const explicitPhase = Number.isFinite(opts.phase) ? opts.phase - Math.floor(opts.phase) : null;
    const phase = explicitPhase ?? hashPhase(seed ^ Math.imul(speciesId + 1, 0x9e3779b1));
    pool.sElapsed[slot] = phase * animationDuration(pool, slot);
    setCurrentFrame(pool, slot);
  }
  return encodeHandle(pool, slot);
}

export function moveSprite(atlasId, handle, x, y, z) {
  const pool = _pools.get(atlasId);
  if (!pool) return false;
  const slot = decodeHandle(pool, handle);
  if (slot < 0) return false;
  pool.sX[slot] = x;
  pool.sY[slot] = y;
  pool.sZ[slot] = z;
  writeMatrix(pool, pool.pages[pool.sPage[slot]], slot);
  return true;
}

export const setEnemySpritePosition = moveSprite;

export function setEnemySpriteMotion(atlasId, handle, vx, vz, speed) {
  const pool = _pools.get(atlasId);
  if (!pool || !pool.atlas.compiled) return false;
  const slot = decodeHandle(pool, handle);
  if (slot < 0) return false;
  pool.sVx[slot] = Number(vx) || 0;
  pool.sVz[slot] = Number(vz) || 0;
  pool.sSpeed[slot] = Number.isFinite(speed) ? Math.max(0, speed) : Math.hypot(pool.sVx[slot], pool.sVz[slot]);
  updatePlaybackRate(pool, slot);
  if (Math.abs(pool.sVx[slot]) + Math.abs(pool.sVz[slot]) > 0.0001) {
    const nextDirection = hystereticDirection(pool.sDirection[slot], pool.sVx[slot], pool.sVz[slot]);
    if (nextDirection !== pool.sDirection[slot]) {
      setV2Descriptor(pool, slot, pool.sState[slot], nextDirection, false);
    }
  }
  return true;
}

export function setEnemySpriteState(atlasId, handle, stateId, restart = true) {
  const pool = _pools.get(atlasId);
  if (!pool || !pool.atlas.compiled || !Number.isInteger(stateId)) return false;
  const slot = decodeHandle(pool, handle);
  if (slot < 0) return false;
  if (pool.sState[slot] === stateId && !restart) return true;
  if (pool.sLoop[slot] && stateId !== pool.sState[slot]) {
    const duration = animationDuration(pool, slot);
    pool.sReturnPhase[slot] = duration > 0 ? pool.sElapsed[slot] / duration : 0;
  }
  return setV2Descriptor(pool, slot, stateId, pool.sDirection[slot], !!restart);
}

export function setSpriteAnimation(atlasId, handle, animationName, restart = true) {
  const pool = _pools.get(atlasId);
  if (!pool || pool.atlas.version !== 1) return false;
  const slot = decodeHandle(pool, handle);
  const animation = pool.atlas.anims[animationName] ?? null;
  if (slot < 0 || !animation) return false;
  setV1Descriptor(pool, slot, animation, !!restart, false);
  return true;
}

export function triggerEnemySpriteHit(atlasId, handle) {
  const pool = _pools.get(atlasId);
  if (!pool) return false;
  const slot = decodeHandle(pool, handle);
  if (slot < 0) return false;
  pool.sHitRemaining[slot] = HIT_DURATION;
  return true;
}

export function playEnemySpriteDeath(atlasId, handle, deathStateId = ENEMY_SPRITE_STATE.DEATH) {
  return setEnemySpriteState(atlasId, handle, deathStateId, true);
}

export function releaseEnemySprite(atlasId, handle) {
  const pool = _pools.get(atlasId);
  if (!pool) return false;
  const slot = decodeHandle(pool, handle);
  return slot >= 0 ? releaseSlotByIndex(pool, slot) : false;
}

export const killSprite = releaseEnemySprite;

export function releaseAllSprites(atlasId) {
  const pool = _pools.get(atlasId);
  if (!pool) return 0;
  let released = 0;
  for (let slot = 0; slot < pool.cap; slot++) {
    if (releaseSlotByIndex(pool, slot)) released++;
  }
  return released;
}

export function setSpriteFlash(atlasId, handle, amount) {
  const pool = _pools.get(atlasId);
  if (!pool) return false;
  const slot = decodeHandle(pool, handle);
  if (slot < 0) return false;
  const value = Math.max(0, Math.min(1, Number(amount) || 0));
  pool.sFlash[slot] = value;
  const page = pool.pages[pool.sPage[slot]];
  page.flashAttr.array[slot] = value;
  page.flashAttr.needsUpdate = true;
  return true;
}

export function isSpriteSlotAlive(atlasId, handle) {
  const pool = _pools.get(atlasId);
  return !!pool && decodeHandle(pool, handle) >= 0;
}

function updateCameraAxes(camera) {
  if (!camera?.getWorldDirection) return;
  camera.getWorldDirection(_cameraDirection);
  const length = Math.hypot(_cameraDirection.x, _cameraDirection.z);
  if (length < 0.000001) return;
  const forwardX = _cameraDirection.x / length;
  const forwardZ = _cameraDirection.z / length;
  _towardCameraX = -forwardX;
  _towardCameraZ = -forwardZ;
  _cameraRightX = -forwardZ;
  _cameraRightZ = forwardX;
}

function completeOneShot(pool, slot) {
  if (pool.sCompletion[slot] === ENEMY_SPRITE_COMPLETION.release) {
    releaseSlotByIndex(pool, slot);
    return;
  }
  if (pool.sCompletion[slot] === ENEMY_SPRITE_COMPLETION.fallback && pool.atlas.compiled) {
    const fallback = pool.sFallbackState[slot];
    setV2Descriptor(pool, slot, fallback, pool.sDirection[slot], true);
    if (pool.sLoop[slot]) {
      pool.sElapsed[slot] = Math.min(0.999999, Math.max(0, pool.sReturnPhase[slot])) * animationDuration(pool, slot);
      setCurrentFrame(pool, slot);
    }
    return;
  }
  releaseSlotByIndex(pool, slot);
}

function baseLeanForSlot(pool, slot) {
  const magnitude = Math.hypot(pool.sVx[slot], pool.sVz[slot]);
  if (magnitude < 0.0001) return 0;
  const lateral = (pool.sVx[slot] * _cameraRightX + pool.sVz[slot] * _cameraRightZ) / magnitude;
  const kind = pool.sMotionKind[slot];
  if (kind === 7) return lateral * 0.16;
  if (kind === 8) return lateral * 0.11;
  if (kind === 9) return lateral * 0.065;
  if (kind === 1 || kind === 5) return lateral * 0.025;
  return lateral * 0.015;
}

function updatePose(pool, slot, dt) {
  let scaleX = 1;
  let scaleY = 1;
  let lean = pool.atlas.compiled ? baseLeanForSlot(pool, slot) : 0;
  if (pool.sHitRemaining[slot] > 0) {
    pool.sHitRemaining[slot] = Math.max(0, pool.sHitRemaining[slot] - dt);
    const progress = 1 - pool.sHitRemaining[slot] / HIT_DURATION;
    const pulse = Math.sin(Math.PI * progress);
    scaleX += pulse * 0.12;
    scaleY -= pulse * 0.18;
    lean += pool.sHitSign[slot] * pulse * 0.10;
  }
  if (scaleX === pool.sPoseX[slot] && scaleY === pool.sPoseY[slot] && lean === pool.sLean[slot]) return;
  pool.sPoseX[slot] = scaleX;
  pool.sPoseY[slot] = scaleY;
  pool.sLean[slot] = lean;
  const page = pool.pages[pool.sPage[slot]];
  const offset = slot * 3;
  page.poseAttr.array[offset] = scaleX;
  page.poseAttr.array[offset + 1] = scaleY;
  page.poseAttr.array[offset + 2] = lean;
  page.poseDirty = true;
}

export function tickSpriteSystem(dt, camera = null) {
  updateCameraAxes(camera);
  const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
  for (let poolIndex = 0; poolIndex < _poolList.length; poolIndex++) {
    const pool = _poolList[poolIndex];
    if (pool.activeCount === 0) {
      for (let pageIndex = 0; pageIndex < pool.pages.length; pageIndex++) {
        pool.pages[pageIndex].mesh.visible = false;
      }
      continue;
    }
    for (let pageIndex = 0; pageIndex < pool.pages.length; pageIndex++) {
      const page = pool.pages[pageIndex];
      page.frameDirty = false;
      page.poseDirty = false;
    }
    for (let slot = 0; slot < pool.cap; slot++) {
      if (pool.sAlive[slot] === 0) continue;
      const playbackRate = pool.atlas.compiled && pool.sState[slot] === ENEMY_SPRITE_STATE.MOVE
        ? pool.sPlaybackRate[slot]
        : 1;
      let elapsed = pool.sElapsed[slot] + safeDt * playbackRate;
      const duration = animationDuration(pool, slot);
      if (duration <= 0) {
        releaseSlotByIndex(pool, slot);
        continue;
      }
      if (elapsed >= duration) {
        if (pool.sLoop[slot]) elapsed -= duration * Math.floor(elapsed / duration);
        else {
          completeOneShot(pool, slot);
          if (pool.sAlive[slot] === 0) continue;
          elapsed = pool.sElapsed[slot];
        }
      }
      pool.sElapsed[slot] = elapsed;
      const page = pool.pages[pool.sPage[slot]];
      const frames = pool.sTo[slot] - pool.sFrom[slot] + 1;
      const frame = pool.sFrom[slot] + Math.min(frames - 1, Math.floor(elapsed * pool.sFps[slot]));
      if (page.frameAttr.array[slot] !== frame) {
        page.frameAttr.array[slot] = frame;
        page.frameDirty = true;
      }
      updatePose(pool, slot, safeDt);
    }
    for (let pageIndex = 0; pageIndex < pool.pages.length; pageIndex++) {
      const page = pool.pages[pageIndex];
      if (page.frameDirty) page.frameAttr.needsUpdate = true;
      if (page.poseDirty) page.poseAttr.needsUpdate = true;
      if (page.activeCount === 0) page.mesh.visible = false;
    }
  }
}

export function getSpriteSlotSnapshot(atlasId, handle) {
  const pool = _pools.get(atlasId);
  if (!pool) return null;
  const slot = decodeHandle(pool, handle);
  if (slot < 0) return null;
  return {
    handle,
    slot,
    generation: pool.sGeneration[slot],
    alive: true,
    page: pool.sPage[slot],
    speciesId: pool.sSpecies[slot],
    stateId: pool.sState[slot],
    directionId: pool.sDirection[slot],
    frame: pool.pages[pool.sPage[slot]].frameAttr.array[slot],
    from: pool.sFrom[slot],
    to: pool.sTo[slot],
    elapsed: pool.sElapsed[slot],
    playbackRate: pool.sPlaybackRate[slot],
    flip: !!pool.sFlip[slot],
    flash: pool.sFlash[slot],
    pose: [pool.sPoseX[slot], pool.sPoseY[slot], pool.sLean[slot]],
    position: [pool.sX[slot], pool.sY[slot], pool.sZ[slot]],
  };
}

export function getSpritePoolStats(atlasId) {
  const pool = _pools.get(atlasId);
  if (!pool) return null;
  return {
    atlasId,
    version: pool.atlas.version,
    capacity: pool.cap,
    activeCount: pool.activeCount,
    pageCount: pool.pages.length,
    activePages: pool.pages.reduce((count, page) => count + (page.activeCount > 0 ? 1 : 0), 0),
    pageActiveCounts: pool.pages.map((page) => page.activeCount),
  };
}

export async function warmSpritePools(warm) {
  if (typeof warm !== 'function' || _pools.size === 0) return false;
  const visibility = [];
  try {
    for (const pool of _pools.values()) {
      for (const page of pool.pages) {
        visibility.push([page.mesh, page.mesh.visible]);
        page.mesh.visible = true;
      }
    }
    await warm();
    return true;
  } finally {
    for (const [mesh, visible] of visibility) mesh.visible = visible;
  }
}

export function disposeSpritePools() {
  for (const pool of _pools.values()) {
    for (const page of pool.pages) {
      if (page.mesh.parent) page.mesh.parent.remove(page.mesh);
      page.geom.dispose();
      page.material.dispose();
    }
  }
  _pools.clear();
  _poolList.length = 0;
}
