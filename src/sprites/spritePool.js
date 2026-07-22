/**
 * spritePool.js — pre-pooled InstancedMesh of PlaneGeometry per atlas.
 *
 * One TSL node material per atlas. Each instance carries:
 *   - per-instance world transform (instanceMatrix)
 *   - per-instance frame index   (aFrame InstancedBufferAttribute)
 *   - per-instance world scale   (aScale InstancedBufferAttribute, single float)
 *
 * The node graph reads `aFrame` + atlas (cols, rows) → uv offset. It also
 * handles billboard rotation (screen | cylinder | none) so
 * we don't pay per-frame rotation update from JS.
 *
 * Fragment samples sub-region with NearestFilter for pixel crunch.
 *
 * Perf contract (docs/SPRITES_VISUAL_STYLE.md):
 *   - Zero per-spawn allocation. Pool of N instances. Recycle oldest-first.
 *   - One draw call per atlas while that atlas owns a live slot.
 *   - lowFx kill-switch: if atlas.bypassWhenLowFx + state.run.lowFx, no spawn.
 *
 * Lifetime model — every spawned sprite has finite life (anim duration or
 * explicit ttl). Dead instances are written to a hidden "stash" position
 * (far below the world) and the slot is reused.
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { createSpritePoolMaterial } from '../rendering/materials/spritePoolMaterial.js';
import { getAtlas } from './spriteAtlas.js';

const DEFAULT_POOL_CAP = 256;
const STASH_Y = -10000; // off-screen parking for dead instances

const _pools = new Map(); // atlasId → poolRecord

let _globalLowFx = () => false; // optional hook set by main.js

/** Cheap readiness probe for systems with an optional non-sprite fallback. */
export function hasSpritePool(atlasId) {
  return _pools.has(atlasId);
}

export function setLowFxProbe(fn) {
  if (typeof fn === 'function') _globalLowFx = fn;
}

/**
 * Initialize the pool for a loaded atlas. Idempotent — re-calling returns
 * the existing pool. Must be called AFTER loadAtlas(id) resolves AND after
 * the scene is constructed.
 *
 * @param {THREE.Scene} scene
 * @param {string}      atlasId
 * @param {number}      [cap=DEFAULT_POOL_CAP]
 * @param {object}      [opts]
 * @param {boolean}     [opts.bypassWhenLowFx=false]
 */
export function ensurePool(scene, atlasId, cap = DEFAULT_POOL_CAP, opts = {}) {
  if (_pools.has(atlasId)) return _pools.get(atlasId);
  const atlas = getAtlas(atlasId);
  if (!atlas) throw new Error(`[spritePool] atlas not loaded: ${atlasId}`);

  const geom = new THREE.PlaneGeometry(1, 1);
  // Per-instance frame index (float32, one per instance).
  const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  frameAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aFrame', frameAttr);
  // Per-instance scalar scale (world units height; width derived from aspect).
  const scaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  scaleAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aScale', scaleAttr);
  // Per-instance hit-flash amount (0 = normal, 1 = full white). Drives the FS
  // white-mix so a billboard mob flashes on hit at parity with the 3D enemies'
  // emissive flash (src/enemies.js flashMats path). Default 0 → fully inert for
  // FX atlases that never call setSpriteFlash.
  const flashAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  flashAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aFlash', flashAttr);

  // Cutout mode (alphaTest ≥ 0.5): opaque billboards that WRITE depth so a
  // dense persistent horde sorts via the depth buffer instead of alpha-blend
  // painter's-order (which produces halos + sprites vanishing behind others).
  // Transient FX atlases omit alphaTest and stay in blended depthWrite:false.
  const alphaTest = typeof atlas.alphaTest === 'number' ? atlas.alphaTest : 0.01;
  const material = createSpritePoolMaterial(atlas, { alphaTest });

  const mesh = new THREE.InstancedMesh(geom, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Offscreen stash matrices do not suppress an InstancedMesh submission.
  // Empty pools stay invisible until a slot is leased, saving one draw per
  // atlas in every pass without changing active sprite ordering or capacity.
  mesh.visible = false;
  mesh.frustumCulled = false; // billboards span unpredictable bounds
  mesh.count = cap;
  mesh.userData.visualRole = 'sprite_pool';
  mesh.userData.atlasId = atlasId;
  mesh.userData.poolCapacity = cap;
  if (atlas.bloom) mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);

  // Stash every slot off-screen on init so unused slots don't render at origin.
  const stashMatrix = new THREE.Matrix4();
  stashMatrix.setPosition(0, STASH_Y, 0);
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, stashMatrix);
  mesh.instanceMatrix.needsUpdate = true;

  const pool = {
    atlasId,
    atlas,
    mesh,
    geom,
    material,
    cap,
    frameAttr,
    scaleAttr,
    flashAttr,
    bypassWhenLowFx: !!opts.bypassWhenLowFx,
    // Per-slot state — flat arrays for cache-friendly tick.
    sX:     new Float32Array(cap),
    sY:     new Float32Array(cap),
    sZ:     new Float32Array(cap),
    sScale: new Float32Array(cap),
    sFrom:  new Uint16Array(cap),
    sTo:    new Uint16Array(cap),
    sFps:   new Float32Array(cap),
    sLoop:  new Uint8Array(cap),
    sElapsed: new Float32Array(cap), // seconds since spawn
    sAlive: new Uint8Array(cap),     // 0 = stashed, 1 = active
    sBornAt: new Float32Array(cap),  // frame counter at birth (for oldest-first recycle)
    activeCount: 0,
    _writeIdx: 0,                    // round-robin head for recycle
    _spawnTick: 0,
    _stashMatrix: stashMatrix.clone(),
    _matrix: new THREE.Matrix4(),
  };
  _pools.set(atlasId, pool);
  return pool;
}

/**
 * Spawn one sprite. Returns slot index or -1 if low-fx bypass.
 *
 * @param {string} atlasId
 * @param {object} opts
 * @param {number} opts.x  world x
 * @param {number} opts.y  world y
 * @param {number} opts.z  world z
 * @param {number} [opts.scale=1]   world-units height multiplier
 * @param {string} [opts.anim='default']
 */
export function spawnSprite(atlasId, opts) {
  const pool = _pools.get(atlasId);
  if (!pool) return -1;
  if (pool.bypassWhenLowFx && _globalLowFx()) return -1;

  const anim = pool.atlas.anims[opts.anim ?? 'default'] ?? pool.atlas.anims.default;
  if (!anim) return -1;

  // Find slot: prefer a stashed (dead) slot, else recycle oldest by birth tick.
  let slot = -1;
  for (let probe = 0; probe < pool.cap; probe++) {
    const i = (pool._writeIdx + probe) % pool.cap;
    if (pool.sAlive[i] === 0) { slot = i; break; }
  }
  if (slot === -1) {
    // All alive — evict oldest.
    let oldestTick = Infinity;
    for (let i = 0; i < pool.cap; i++) {
      if (pool.sBornAt[i] < oldestTick) { oldestTick = pool.sBornAt[i]; slot = i; }
    }
  }
  pool._writeIdx = (slot + 1) % pool.cap;

  const scale = opts.scale ?? 1;
  pool.sX[slot] = opts.x;
  pool.sY[slot] = opts.y;
  pool.sZ[slot] = opts.z;
  pool.sScale[slot] = scale;
  pool.sFrom[slot] = anim.from;
  pool.sTo[slot]   = anim.to;
  pool.sFps[slot]  = anim.fps;
  pool.sLoop[slot] = anim.loop ? 1 : 0;
  pool.sElapsed[slot] = 0;
  if (pool.sAlive[slot] === 0) pool.activeCount += 1;
  pool.sAlive[slot] = 1;
  pool.mesh.visible = true;
  pool.sBornAt[slot] = pool._spawnTick++;

  // Initial matrix + frame write (the tick loop will refresh after movement,
  // but having a valid one immediately means the first frame renders correctly).
  pool._matrix.identity();
  pool._matrix.setPosition(opts.x, opts.y, opts.z);
  pool.mesh.setMatrixAt(slot, pool._matrix);
  pool.frameAttr.array[slot] = anim.from;
  pool.scaleAttr.array[slot] = scale;
  // Clear any stale flash — the evict-oldest recycle path can hand back a slot
  // that was mid-flash (0.85) when its previous occupant was reused. The
  // edge-triggered caller won't re-zero it (no transition fires on a fresh
  // entity), so reset here unconditionally.
  pool.flashAttr.array[slot] = 0;
  pool.mesh.instanceMatrix.needsUpdate = true;
  pool.frameAttr.needsUpdate = true;
  pool.scaleAttr.needsUpdate = true;
  pool.flashAttr.needsUpdate = true;
  return slot;
}

/**
 * Tick every pool. Call once per frame from main.js.
 *
 * @param {number} dt  seconds since last frame
 */
/**
 * Move an active sprite slot to a new world position. Use this for
 * entity-attached sprites (mob billboards) that need to follow their
 * entity. No-op if slot is dead or atlas unknown.
 */
export function moveSprite(atlasId, slot, x, y, z) {
  const pool = _pools.get(atlasId);
  if (!pool || slot < 0 || slot >= pool.cap) return;
  if (pool.sAlive[slot] === 0) return;
  pool.sX[slot] = x;
  pool.sY[slot] = y;
  pool.sZ[slot] = z;
  pool._matrix.identity();
  pool._matrix.setPosition(x, y, z);
  pool.mesh.setMatrixAt(slot, pool._matrix);
  pool.mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Force-stash a sprite slot (e.g. on entity despawn). Slot becomes available
 * for new spawns immediately. Use this to avoid a death-frame ghost lingering.
 */
export function killSprite(atlasId, slot) {
  const pool = _pools.get(atlasId);
  if (!pool || slot < 0 || slot >= pool.cap) return;
  if (pool.sAlive[slot] === 0) return;
  pool.sAlive[slot] = 0;
  pool.activeCount = Math.max(0, pool.activeCount - 1);
  if (pool.activeCount === 0) pool.mesh.visible = false;
  // Clear flash before stashing so the next occupant of this slot (via the
  // stashed-slot spawn branch) doesn't inherit a mid-flash value.
  pool.flashAttr.array[slot] = 0;
  pool.flashAttr.needsUpdate = true;
  pool.mesh.setMatrixAt(slot, pool._stashMatrix);
  pool.mesh.instanceMatrix.needsUpdate = true;
}

/**
 * Set a slot's hit-flash amount (0 = normal … 1 = full white). Drives the
 * fragment shader's white-mix. Intended to be edge-triggered by the caller
 * (one write per flash transition, see src/enemies.js sprite branch). No-op
 * for dead/unknown slots.
 */
export function setSpriteFlash(atlasId, slot, amount) {
  const pool = _pools.get(atlasId);
  if (!pool || slot < 0 || slot >= pool.cap) return;
  if (pool.sAlive[slot] === 0) return;
  pool.flashAttr.array[slot] = amount;
  pool.flashAttr.needsUpdate = true;
}

export function tickSpriteSystem(dt) {
  for (const pool of _pools.values()) {
    if (pool.activeCount === 0) {
      pool.mesh.visible = false;
      continue;
    }
    let frameDirty = false;
    let matDirty = false;
    for (let i = 0; i < pool.cap; i++) {
      if (pool.sAlive[i] === 0) continue;
      const t = (pool.sElapsed[i] += dt);
      const totalFrames = pool.sTo[i] - pool.sFrom[i] + 1;
      const totalDur = totalFrames / pool.sFps[i];

      if (t >= totalDur) {
        if (pool.sLoop[i]) {
          // Continue looping by reducing elapsed by totalDur.
          pool.sElapsed[i] = t - totalDur * Math.floor(t / totalDur);
        } else {
          // Dead — stash off-screen and free the slot.
          pool.mesh.setMatrixAt(i, pool._stashMatrix);
          pool.sAlive[i] = 0;
          pool.activeCount = Math.max(0, pool.activeCount - 1);
          pool.frameAttr.array[i] = 0;
          matDirty = true;
          frameDirty = true;
          continue;
        }
      }
      const f = pool.sFrom[i] + Math.min(
        totalFrames - 1,
        Math.floor((pool.sElapsed[i] / totalDur) * totalFrames),
      );
      if (pool.frameAttr.array[i] !== f) {
        pool.frameAttr.array[i] = f;
        frameDirty = true;
      }
    }
    if (frameDirty) pool.frameAttr.needsUpdate = true;
    if (matDirty)   pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.activeCount === 0) pool.mesh.visible = false;
  }
}

export function disposeSpritePools() {
  for (const pool of _pools.values()) {
    if (pool.mesh.parent) pool.mesh.parent.remove(pool.mesh);
    pool.geom.dispose();
    pool.material.dispose();
  }
  _pools.clear();
}
