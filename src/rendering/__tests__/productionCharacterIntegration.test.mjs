import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function functionBody(source, name, next = '\nexport function ') {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = source.indexOf(next, start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

test('production character surfaces contain no WebGL shader injection', () => {
  for (const file of ['src/assets.js', 'src/enemies.js', 'src/hero.js', 'src/town.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /onBeforeCompile|\.vertexShader|\.fragmentShader/, file);
  }
  const assets = read('src/assets.js');
  assert.match(assets, /prepareCharacterMaterialRoot/);
  assert.match(assets, /applyCharacterRimLight/);
  assert.match(assets, /attachCharacterDamageFlash/);
  assert.match(assets, /attachCharacterCreatureAnimation/);
});

test('pooled enemy construction follows collapse, ownership, style, rim, flash, creature order', () => {
  const body = functionBody(read('src/enemies.js'), '_makePooledMesh', '\nexport function prewarmPools');
  const steps = [
    'cloneCached(glbKey)',
    'collapseStaticMeshes(mesh)',
    'upgradeMaterials(mesh, 0.55, rough, { rim: false })',
    'if (_tier && _tier.family === \'bug\')',
    'if (glbKey === \'ghost\')',
    'applyRimLight(mesh)',
    'applyDamageFlash(mesh',
    'applyCreatureVertexAnim(mesh, tier.procAnim',
  ].map((needle) => body.indexOf(needle));
  assert.equal(steps.every((index) => index >= 0), true, `missing step: ${steps}`);
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index] > steps[index - 1], `step ${index} is out of order`);
  }
  assert.match(body, /clips\.length === 0 \? collapseStaticMeshes/);
  assert.match(body, /clips\.length === 0[\s\S]*applyCreatureVertexAnim/);
  assert.doesNotMatch(body, /\.material\s*=\s*[^;]*\.clone\(|flashMats|vertAnimMats/);
  assert.match(read('src/config.js'), /glb: 'kaki_bloomling'[\s\S]{0,240}procAnim: 'hover'/);
});

test('enemy hot loop updates numeric controller state without material mutation loops', () => {
  const source = read('src/enemies.js');
  const update = functionBody(source, 'updateEnemies');
  assert.match(update, /creatureAnimationController\?\.updateTime\(e\._animPhase\)/);
  assert.match(update, /flashController\.setFlashing\(isFlashing\)/);
  assert.doesNotMatch(update, /origEmissive|emissive\.setHex|_vertAnimShader|flashMats/);
  assert.match(source, /resetMaterialControllers\(mesh, \{ creatureTime: 0, creatureAmplitude: 1 \}\)/);
  assert.match(source, /damageFlashController\?\.setAmount\(0\)/);
});

test('hero and Town tint owned materials before attaching node graphs', () => {
  const hero = functionBody(read('src/hero.js'), 'initHero', '\n/**\n * Re-create');
  const heroOrder = [
    'upgradeMaterials(mesh, 0.55, 0.92, { rim: false })',
    'material.color.multiply(_tint)',
    'applyRimLight(mesh)',
    'applyDamageFlash(mesh',
  ].map((needle) => hero.indexOf(needle));
  assert.equal(heroOrder.every((index) => index >= 0), true);
  assert.deepEqual([...heroOrder].sort((a, b) => a - b), heroOrder);
  assert.doesNotMatch(hero, /o\.material\s*=\s*o\.material\.clone|flashMats/);
  assert.match(read('src/hero.js'), /flashController\.setFlashing\(flashing\)/);
  assert.match(read('src/hero.js'), /disposeUpgradedMaterials\(_innerMesh\)/);

  const town = functionBody(read('src/town.js'), '_makeHeroNpc', '\n// Roll which townsfolk');
  const townOrder = [
    'upgradeMaterials(fig, 0.55, 0.92, { rim: false })',
    'material.color.multiply(t)',
    'applyRimLight(fig)',
  ].map((needle) => town.indexOf(needle));
  assert.deepEqual([...townOrder].sort((a, b) => a - b), townOrder);
  assert.doesNotMatch(town, /o\.material\s*=.*\.clone/);
});

test('cache geometry is never disposed by collapse and Nemesis exclusions survive', () => {
  const assets = functionBody(read('src/assets.js'), 'collapseStaticMeshes');
  assert.doesNotMatch(assets, /o\.geometry\.dispose/);
  assert.match(assets, /only the temporary clones made above belong/);

  const enemies = read('src/enemies.js');
  assert.match(enemies, /object\.layers\.mask & \(1 << BLOOM_LAYER\)/);
  assert.match(enemies, /!\/ruby\|yarn\/i\.test\(material\.name \|\| ''\)/);
  const spawnDirector = read('src/spawnDirector.js');
  assert.match(spawnDirector, /damageFlashController = null/);
  assert.match(spawnDirector, /creatureAnimationController = null/);
});
