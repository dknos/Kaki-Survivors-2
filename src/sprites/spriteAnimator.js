/**
 * Thin per-entity adapter over the fixed-capacity sprite pools.
 *
 * spritePool handles fire-and-forget FX (one-shot bursts). Mob sprites
 * need a different lifetime: they're tied to an entity that moves and
 * may switch animations (idle → attack → death). This module owns that
 * mapping.
 *
 * The adapter is intentionally outside the 350-enemy hot path (enemies.js
 * calls the numeric APIs directly). It exists for small scripted consumers and
 * preserves the released attachSprite surface without ever respawning a slot
 * for an animation change.
 */
import { getAtlas } from './spriteAtlas.js';
import {
  isSpriteSlotAlive,
  moveSprite,
  releaseEnemySprite,
  setSpriteAnimation,
  spawnSprite,
} from './spritePool.js';

const _handles = new Set();

/**
 * Attach a sprite to an entity.
 *
 * @param {object} ent           the entity (typically an enemy/projectile object)
 * @param {string} atlasId
 * @param {object} [opts]
 * @param {number} [opts.scale=1]
 * @param {string} [opts.anim='idle']  initial anim name (falls back to 'default')
 */
export function attachSprite(ent, atlasId, opts = {}) {
  const atlas = getAtlas(atlasId);
  if (!atlas) return null;
  const handle = {
    ent,
    atlasId,
    scale: opts.scale ?? 1,
    currentAnim: opts.anim ?? 'idle',
    slot: -1, // assigned on first update tick
  };
  handle.slot = spawnSprite(atlasId, {
    x: ent.x ?? ent.position?.x ?? 0,
    y: ent.y ?? ent.position?.y ?? 0,
    z: ent.z ?? ent.position?.z ?? 0,
    scale: handle.scale,
    anim: handle.currentAnim in atlas.anims ? handle.currentAnim : 'default',
  });
  ent.spriteHandle = handle;
  _handles.add(handle);
  return handle;
}

/**
 * Switch the entity's animation. Re-spawn at current position with new anim
 * (the previous slot's anim finishes / dies naturally).
 */
export function setAnim(handle, animName) {
  if (!handle || handle.currentAnim === animName) return;
  const atlas = getAtlas(handle.atlasId);
  if (!atlas || !atlas.anims || !(animName in atlas.anims)) return;
  if (!setSpriteAnimation(handle.atlasId, handle.slot, animName, true)) return;
  handle.currentAnim = animName;
}

/**
 * Detach the sprite. Caller is responsible for calling this when the entity
 * dies. After this call, no further updates affect the slot — it will die
 * naturally when its anim completes (one-shot) or be recycled (loop).
 */
export function detachSprite(handle) {
  if (!handle) return;
  _handles.delete(handle);
  if (handle.slot >= 0) releaseEnemySprite(handle.atlasId, handle.slot);
  handle.slot = -1;
  if (handle.ent) handle.ent.spriteHandle = null;
}

/**
 * Tick every attached sprite — write current entity position into the pool
 * matrix at the handle's slot. Call ONCE per frame from main.js AFTER
 * entity x/y/z have been updated, BEFORE tickSpriteSystem.
 */
export function tickAttachedSprites() {
  for (const h of _handles) {
    const ent = h.ent;
    if (!ent || ent.dead || !isSpriteSlotAlive(h.atlasId, h.slot)) continue;
    moveSprite(
      h.atlasId,
      h.slot,
      ent.x ?? ent.position?.x ?? 0,
      ent.y ?? ent.position?.y ?? 0,
      ent.z ?? ent.position?.z ?? 0,
    );
  }
}

/**
 * Reset the registry (test/teardown helper).
 */
export function _resetSpriteAnimator() {
  for (const handle of _handles) {
    if (handle.slot >= 0) releaseEnemySprite(handle.atlasId, handle.slot);
    if (handle.ent) handle.ent.spriteHandle = null;
  }
  _handles.clear();
}
