import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const SOURCE_DIR = path.join(ROOT, 'src/rendering/materials');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-character-pipeline-'));
const fixtureDir = path.join(fixtureRoot, 'src/rendering/materials');
await fs.mkdir(fixtureDir, { recursive: true });
await fs.mkdir(path.join(fixtureRoot, 'node_modules'), { recursive: true });
await fs.symlink(path.join(ROOT, 'vendor/three'), path.join(fixtureRoot, 'node_modules/three'), 'dir');
for (const name of [
  'characterMaterialPipeline.js',
  'materialOwnership.js',
  'rimLightMaterial.js',
  'damageFlashMaterial.js',
  'creatureAnimationMaterial.js',
]) {
  await fs.copyFile(path.join(SOURCE_DIR, name), path.join(fixtureDir, name));
}

const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three/build/three.webgpu.js')).href);
const pipeline = await import(pathToFileURL(path.join(fixtureDir, 'characterMaterialPipeline.js')).href);

after(async () => fs.rm(fixtureRoot, { recursive: true, force: true }));

function createRoot(material = new THREE.MeshStandardMaterial({ color: 0x557799 })) {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  return root;
}

test('ownership happens once before rim, flash, and creature controllers compose', () => {
  const source = new THREE.MeshPhysicalMaterial({
    color: 0x345678,
    clearcoat: 0.7,
    roughness: 0.2,
  });
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  source.map = texture;
  let cloneCalls = 0;
  const clone = source.clone.bind(source);
  source.clone = () => { cloneCalls += 1; return clone(); };
  const root = createRoot(source);

  const state = pipeline.prepareCharacterMaterialRoot(root, {
    constructors: THREE,
    roughness: 0.92,
  });
  pipeline.prepareCharacterMaterialRoot(root, { constructors: THREE, roughness: 0.88 });
  assert.equal(cloneCalls, 1);
  assert.equal(state.ownership.clonedCount, 1);
  assert.notEqual(root.children[0].material, source);
  assert.equal(root.children[0].material.isMeshPhysicalMaterial, true);
  assert.equal(root.children[0].material.map, texture);

  pipeline.applyCharacterRimLight(root);
  const nodeMaterial = root.children[0].material;
  assert.equal(nodeMaterial.isMeshPhysicalNodeMaterial, true);
  assert.equal(nodeMaterial.clearcoat, 0.7);
  assert.equal(nodeMaterial.map, texture);

  const flash = pipeline.attachCharacterDamageFlash(root, { color: 0xff3344, intensity: 2.4 });
  const creature = pipeline.attachCharacterCreatureAnimation(root, { kind: 'hover' });
  assert.ok(flash);
  assert.ok(creature);
  assert.equal(root.children[0].material, nodeMaterial);
  flash.setAmount(1);
  creature.updateTime(4.5);
  assert.equal(flash.values.amount, 1);
  assert.equal(creature.values.time, 4.5);
  pipeline.resetCharacterMaterialControllers(root);
  assert.equal(flash.values.amount, 0);
  assert.equal(creature.values.time, 0);
  assert.equal(creature.values.amplitude, 1);
});

test('separate cached clones own independent node materials while sharing textures', () => {
  const texture = new THREE.DataTexture(new Uint8Array([80, 160, 220, 255]), 1, 1);
  const cached = new THREE.MeshStandardMaterial({ map: texture, emissive: 0x112233 });
  const first = createRoot(cached);
  const second = createRoot(cached);
  for (const root of [first, second]) {
    pipeline.prepareCharacterMaterialRoot(root, { constructors: THREE });
    pipeline.applyCharacterRimLight(root);
    pipeline.attachCharacterDamageFlash(root);
  }
  assert.notEqual(first.children[0].material, second.children[0].material);
  assert.notEqual(first.children[0].material, cached);
  assert.equal(first.children[0].material.map, texture);
  assert.equal(second.children[0].material.map, texture);
  pipeline.getCharacterMaterialPipelineState(first).damageFlashController.setAmount(1);
  assert.equal(pipeline.getCharacterMaterialPipelineState(second).damageFlashController.values.amount, 0);
  assert.equal(cached.emissive.getHex(), 0x112233);
});

test('skinned and morph geometry skip creature deformation without partial mutation', () => {
  const skinned = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial(),
  );
  const root = new THREE.Group();
  root.add(skinned);
  pipeline.prepareCharacterMaterialRoot(root, { constructors: THREE });
  pipeline.applyCharacterRimLight(root);
  const before = skinned.material.positionNode;
  assert.equal(pipeline.isCreatureAnimationEligible(root), false);
  assert.equal(pipeline.attachCharacterCreatureAnimation(root, { kind: 'crawl' }), null);
  assert.equal(skinned.material.positionNode, before);

  const morph = createRoot();
  morph.children[0].geometry.morphAttributes.position = [
    morph.children[0].geometry.attributes.position.clone(),
  ];
  pipeline.prepareCharacterMaterialRoot(morph, { constructors: THREE });
  pipeline.applyCharacterRimLight(morph);
  assert.equal(pipeline.isCreatureAnimationEligible(morph), false);
  assert.equal(pipeline.attachCharacterCreatureAnimation(morph, { kind: 'hover' }), null);
});

test('filters preserve excluded emissive objects and disposal releases only owned materials', () => {
  const sharedTexture = new THREE.DataTexture(new Uint8Array([255, 80, 80, 255]), 1, 1);
  let textureDisposals = 0;
  sharedTexture.addEventListener('dispose', () => { textureDisposals += 1; });
  const bodySource = new THREE.MeshStandardMaterial({ name: 'body', emissive: 0x111111, map: sharedTexture });
  const rubySource = new THREE.MeshStandardMaterial({ name: 'ruby_core', emissive: 0xff0000 });
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), bodySource);
  const ruby = new THREE.Mesh(new THREE.BoxGeometry(), rubySource);
  ruby.layers.enable(1);
  root.add(body, ruby);
  pipeline.prepareCharacterMaterialRoot(root, { constructors: THREE });
  pipeline.applyCharacterRimLight(root);
  const flash = pipeline.attachCharacterDamageFlash(root, {
    filterObject: (object) => (object.layers.mask & (1 << 1)) === 0,
    filterMaterial: (material) => !/ruby|yarn/i.test(material.name || ''),
  });
  assert.equal(flash.objects.includes(body), true);
  assert.equal(flash.objects.includes(ruby), false);
  assert.equal(flash.materials.includes(ruby.material), false);

  let bodyDisposals = 0;
  let rubyDisposals = 0;
  body.material.addEventListener('dispose', () => { bodyDisposals += 1; });
  ruby.material.addEventListener('dispose', () => { rubyDisposals += 1; });
  assert.equal(pipeline.disposeCharacterMaterialRoot(root), 2);
  assert.equal(bodyDisposals, 1);
  assert.equal(rubyDisposals, 1);
  assert.equal(pipeline.getCharacterMaterialPipelineState(root), null);
  assert.equal(textureDisposals, 0);
  assert.equal(bodySource.map, sharedTexture);
});
