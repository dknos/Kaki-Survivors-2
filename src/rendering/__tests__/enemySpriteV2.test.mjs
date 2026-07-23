import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-enemy-sprite-v2-'));

for (const directory of [
  'src/sprites',
  'src/rendering/materials',
  'src/rendering',
  'node_modules',
]) {
  await fs.mkdir(path.join(fixtureRoot, directory), { recursive: true });
}
await fs.symlink(path.join(ROOT, 'vendor/three'), path.join(fixtureRoot, 'node_modules/three'), 'dir');
for (const relative of [
  'src/sprites/spriteAtlas.js',
  'src/sprites/spritePool.js',
  'src/rendering/materials/spritePoolMaterial.js',
  'src/rendering/bloomLayers.js',
]) {
  await fs.copyFile(path.join(ROOT, relative), path.join(fixtureRoot, relative));
}

const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three/build/three.module.js')).href);
const atlasApi = await import(pathToFileURL(path.join(fixtureRoot, 'src/sprites/spriteAtlas.js')).href);
const poolApi = await import(pathToFileURL(path.join(fixtureRoot, 'src/sprites/spritePool.js')).href);
const v1 = JSON.parse(await fs.readFile(path.join(ROOT, 'assets/sprites/enemies_v1.json'), 'utf8'));
const v2 = JSON.parse(await fs.readFile(path.join(ROOT, 'assets/sprites/forest_enemies_v2.json'), 'utf8'));

after(async () => {
  poolApi.disposeSpritePools();
  atlasApi.disposeAtlases();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function texture() {
  const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  map.needsUpdate = true;
  return map;
}

function resetV2(capacity = 8) {
  poolApi.disposeSpritePools();
  atlasApi.disposeAtlases();
  atlasApi._registerAtlasForTests('forest-test', v2, texture());
  const scene = new THREE.Scene();
  poolApi.ensurePool(scene, 'forest-test', capacity);
  return scene;
}

function spawn(speciesId = 0, extras = {}) {
  return poolApi.spawnEnemySprite('forest-test', {
    speciesId,
    stateId: poolApi.ENEMY_SPRITE_STATE.MOVE,
    x: 0,
    y: 0.06,
    z: 0,
    scale: 1.5,
    vx: 1,
    vz: 1,
    speed: v2.species[speciesId].nominalSpeed,
    nominalSpeed: v2.species[speciesId].nominalSpeed,
    seed: 100 + speciesId,
    ...extras,
  });
}

test('v1 remains valid while v2 rejects bad ranges and compiles numeric hot tables', () => {
  assert.equal(atlasApi.validateAtlasSchema('enemies_v1.json', v1), true);
  assert.equal(atlasApi.validateAtlasSchema('forest_enemies_v2.json', v2), true);
  const compiled = atlasApi.compileEnemyAtlasV2(v2);
  assert.equal(compiled.speciesCapacity, 11);
  assert.equal(compiled.stateCount, 3);
  assert.equal(compiled.directionCount, 4);
  assert.equal(compiled.speciesByName.get('mantis'), 5);
  assert.equal(compiled.speciesByName.get('spider'), 10);
  assert.equal(compiled.valid[compiled.index(9, 2, 3)], 1);
  assert.equal(compiled.valid[compiled.index(10, 0, 0)], 1);
  assert.equal(compiled.valid[compiled.index(10, 1, 3)], 1);
  const spider = v2.species[10];
  assert.equal(spider.name, 'spider');
  assert.equal(spider.authoring, 'source-animation-clips');
  for (const state of spider.states) {
    assert.deepEqual(state.directions.map((direction) => direction.id), [0, 1, 2, 3]);
    assert.equal(state.directions[3].mirror, true);
    assert.equal(state.directions[3].sourceDirection, 1);
  }
  const invalid = structuredClone(v2);
  invalid.species[0].states[0].directions[0].to = invalid.pages[0].frameCount;
  assert.throws(
    () => atlasApi.validateAtlasSchema('invalid-v2.json', invalid),
    /frame range out of bounds/,
  );
  const badPageTotal = structuredClone(v2);
  badPageTotal.frameCount--;
  assert.throws(
    () => atlasApi.validateAtlasSchema('bad-page-total.json', badPageTotal),
    /must equal page total/,
  );
  const missingMipFlag = structuredClone(v2);
  delete missingMipFlag.texture.generateMipmaps;
  assert.throws(
    () => atlasApi.validateAtlasSchema('missing-mip-flag.json', missingMipFlag),
    /generateMipmaps must be boolean/,
  );
});

test('enemy sprite v2 state, direction, phase, recycling, and reset contracts', () => {
  resetV2(8);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.set(10, 10, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  poolApi.tickSpriteSystem(0, camera);

  // State changes retain the encoded handle and physical slot.
  const stateHandle = spawn(5, { phase: 0.37 });
  const initial = poolApi.getSpriteSlotSnapshot('forest-test', stateHandle);
  assert.equal(poolApi.setEnemySpriteState(
    'forest-test', stateHandle, poolApi.ENEMY_SPRITE_STATE.ATTACK, true,
  ), true);
  const attacking = poolApi.getSpriteSlotSnapshot('forest-test', stateHandle);
  assert.equal(attacking.handle, stateHandle);
  assert.equal(attacking.slot, initial.slot);
  assert.equal(attacking.stateId, poolApi.ENEMY_SPRITE_STATE.ATTACK);
  assert.equal(poolApi.getSpritePoolStats('forest-test').activeCount, 1);

  // Attack is a one-shot and returns to the preserved locomotion phase.
  poolApi.tickSpriteSystem(0.21, camera);
  const returned = poolApi.getSpriteSlotSnapshot('forest-test', stateHandle);
  assert.equal(returned.stateId, poolApi.ENEMY_SPRITE_STATE.MOVE);
  assert.ok(returned.elapsed > 0);

  // Hit response changes pose without creating a second slot.
  assert.equal(poolApi.triggerEnemySpriteHit('forest-test', stateHandle), true);
  poolApi.tickSpriteSystem(0.04, camera);
  const hit = poolApi.getSpriteSlotSnapshot('forest-test', stateHandle);
  assert.equal(hit.slot, initial.slot);
  assert.notDeepEqual(hit.pose, [1, 1, 0]);
  assert.equal(poolApi.getSpritePoolStats('forest-test').activeCount, 1);

  // Four camera-relative directions, hysteresis, stationary retention, mirror.
  const h = Math.SQRT1_2;
  const directions = [
    [h, h, 0],
    [h, -h, 1],
    [-h, -h, 2],
    [-h, h, 3],
  ];
  for (const [vx, vz, expected] of directions) {
    poolApi.setEnemySpriteMotion('forest-test', stateHandle, vx, vz, 2);
    assert.equal(poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).directionId, expected);
  }
  assert.equal(poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).flip, true);
  poolApi.setEnemySpriteMotion('forest-test', stateHandle, 0, 0, 0);
  assert.equal(poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).directionId, 3);
  poolApi.setEnemySpriteMotion('forest-test', stateHandle, h, h, 2);
  assert.equal(poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).directionId, 0);
  poolApi.setEnemySpriteMotion('forest-test', stateHandle, 0.99, -0.071, 2);
  assert.equal(
    poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).directionId,
    0,
    'small boundary movement stays in the previous facing sector',
  );
  poolApi.setEnemySpriteMotion('forest-test', stateHandle, h, -h, 2);
  assert.equal(poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).directionId, 1);

  // Playback speed clamps at per-species authored bounds.
  const rateLimits = v2.species[5].playbackRate;
  poolApi.setEnemySpriteMotion('forest-test', stateHandle, 0, 0, 0);
  assert.ok(Math.abs(
    poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).playbackRate - rateLimits.min,
  ) < 1e-5);
  poolApi.setEnemySpriteMotion('forest-test', stateHandle, 100, 0, 100);
  assert.ok(Math.abs(
    poolApi.getSpriteSlotSnapshot('forest-test', stateHandle).playbackRate - rateLimits.max,
  ) < 1e-5);

  // Loop-to-death releases exactly after the non-looping range completes.
  assert.equal(poolApi.playEnemySpriteDeath('forest-test', stateHandle), true);
  poolApi.tickSpriteSystem(0.1, camera);
  assert.equal(poolApi.isSpriteSlotAlive('forest-test', stateHandle), true);
  poolApi.tickSpriteSystem(0.08, camera);
  assert.equal(poolApi.isSpriteSlotAlive('forest-test', stateHandle), false);
  assert.equal(poolApi.getSpritePoolStats('forest-test').activeCount, 0);

  // Loop phases vary but replay deterministically after a clean runtime reset.
  const phaseSequence = [];
  for (let index = 0; index < 4; index++) {
    const handle = spawn(0, { seed: 900 + index });
    phaseSequence.push(poolApi.getSpriteSlotSnapshot('forest-test', handle).elapsed);
  }
  assert.ok(new Set(phaseSequence).size > 1);
  resetV2(8);
  poolApi.tickSpriteSystem(0, camera);
  const replay = [];
  for (let index = 0; index < 4; index++) {
    const handle = spawn(0, { seed: 900 + index });
    replay.push(poolApi.getSpriteSlotSnapshot('forest-test', handle).elapsed);
  }
  assert.deepEqual(replay, phaseSequence);

  // Repeated transitions stay in one slot and never orphan a looping instance.
  const transitionHandle = spawn(6);
  const transitionSlot = poolApi.getSpriteSlotSnapshot('forest-test', transitionHandle).slot;
  const baselineActive = poolApi.getSpritePoolStats('forest-test').activeCount;
  for (let index = 0; index < 40; index++) {
    poolApi.setEnemySpriteState('forest-test', transitionHandle, poolApi.ENEMY_SPRITE_STATE.ATTACK, true);
    poolApi.tickSpriteSystem(0.18, camera);
    assert.equal(poolApi.getSpriteSlotSnapshot('forest-test', transitionHandle).slot, transitionSlot);
  }
  assert.equal(poolApi.getSpritePoolStats('forest-test').activeCount, baselineActive);

  // Immediate retirement invalidates a handle without waiting for a one-shot.
  assert.equal(poolApi.releaseEnemySprite('forest-test', transitionHandle), true);
  assert.equal(poolApi.isSpriteSlotAlive('forest-test', transitionHandle), false);

  // Capacity pressure recycles deterministically and stale handles cannot write.
  resetV2(2);
  poolApi.tickSpriteSystem(0, camera);
  const oldest = spawn(0);
  const newest = spawn(1);
  const recycled = spawn(2);
  assert.equal(poolApi.getSpritePoolStats('forest-test').activeCount, 2);
  assert.equal(poolApi.isSpriteSlotAlive('forest-test', oldest), false);
  assert.equal(poolApi.isSpriteSlotAlive('forest-test', newest), true);
  assert.equal(poolApi.isSpriteSlotAlive('forest-test', recycled), true);
  assert.equal(poolApi.setSpriteFlash('forest-test', oldest, 1), false);

  // Slot reuse clears state, hit pose and flash data.
  resetV2(1);
  poolApi.tickSpriteSystem(0, camera);
  const dirty = spawn(0);
  poolApi.setSpriteFlash('forest-test', dirty, 0.85);
  poolApi.triggerEnemySpriteHit('forest-test', dirty);
  poolApi.setEnemySpriteState('forest-test', dirty, poolApi.ENEMY_SPRITE_STATE.ATTACK, true);
  poolApi.releaseEnemySprite('forest-test', dirty);
  const clean = spawn(0, { phase: 0 });
  const cleanState = poolApi.getSpriteSlotSnapshot('forest-test', clean);
  assert.equal(cleanState.stateId, poolApi.ENEMY_SPRITE_STATE.MOVE);
  assert.equal(cleanState.flash, 0);
  assert.deepEqual(cleanState.pose, [1, 1, 0]);
  assert.equal(poolApi.getSpritePoolStats('forest-test').activePages, 1);
});

test('v1 pool still spawns, advances, flashes, moves, and retires', () => {
  poolApi.disposeSpritePools();
  atlasApi.disposeAtlases();
  atlasApi._registerAtlasForTests('v1-test', v1, texture());
  const scene = new THREE.Scene();
  poolApi.ensurePool(scene, 'v1-test', 4);
  const handle = poolApi.spawnSprite('v1-test', {
    x: 1, y: 0.06, z: 2, scale: 1.5, anim: 'ant', phase: 0,
  });
  assert.ok(handle >= 0);
  assert.equal(poolApi.moveSprite('v1-test', handle, 3, 0.06, 4), true);
  assert.equal(poolApi.setSpriteFlash('v1-test', handle, 0.7), true);
  poolApi.tickSpriteSystem(0.2);
  const snapshot = poolApi.getSpriteSlotSnapshot('v1-test', handle);
  assert.ok(Math.abs(snapshot.position[0] - 3) < 1e-5);
  assert.ok(Math.abs(snapshot.position[1] - 0.06) < 1e-5);
  assert.ok(Math.abs(snapshot.position[2] - 4) < 1e-5);
  assert.ok(Math.abs(snapshot.flash - 0.7) < 1e-5);
  assert.equal(poolApi.releaseEnemySprite('v1-test', handle), true);
  assert.equal(poolApi.getSpritePoolStats('v1-test').activeCount, 0);
});
