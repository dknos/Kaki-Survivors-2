import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const MATERIAL_DIR = path.join(ROOT, 'src/rendering/materials');
const MODULE_NAMES = [
  'landscapeMaterials.js',
  'hazardMaterials.js',
  'telegraphMaterials.js',
  'skyDomeMaterials.js',
];

// Resolve browser-native package specifiers through the exact vendored r185
// package. This exercises the real node APIs without adding a second Three.js
// installation or changing the application's native-module architecture.
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-tsl-surfaces-'));
const fixtureMaterials = path.join(fixtureRoot, 'src/rendering/materials');
await fs.mkdir(fixtureMaterials, { recursive: true });
await fs.mkdir(path.join(fixtureRoot, 'node_modules'), { recursive: true });
await fs.symlink(path.join(ROOT, 'vendor/three'), path.join(fixtureRoot, 'node_modules/three'), 'dir');
await Promise.all(MODULE_NAMES.map((name) => (
  fs.copyFile(path.join(MATERIAL_DIR, name), path.join(fixtureMaterials, name))
)));

const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three/build/three.webgpu.js')).href);
const landscape = await import(pathToFileURL(path.join(fixtureMaterials, 'landscapeMaterials.js')).href);
const hazards = await import(pathToFileURL(path.join(fixtureMaterials, 'hazardMaterials.js')).href);
const telegraphs = await import(pathToFileURL(path.join(fixtureMaterials, 'telegraphMaterials.js')).href);
const skies = await import(pathToFileURL(path.join(fixtureMaterials, 'skyDomeMaterials.js')).href);

after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('water and terrain ribbons preserve the released flags and uniform update surface', () => {
  const water = landscape.createWaterMaterial(0x123456, 0xabcdef, 0.72);
  assert.equal(water.isMeshBasicNodeMaterial, true);
  assert.ok(water.outputNode?.isNode);
  assert.equal(water.transparent, true);
  assert.equal(water.depthWrite, false);
  assert.equal(water.depthTest, true);
  assert.equal(water.side, THREE.DoubleSide);
  assert.equal(water.blending, THREE.NormalBlending);
  assert.equal(water.fog, false);
  assert.equal(water.uniforms.uOpacity.value, 0.72);
  assert.equal(water.uniforms.uDeep.value.getHex(), 0x123456);
  assert.equal(water.uniforms.uShallow.value.getHex(), 0xabcdef);
  assert.equal(water.setAnimationTime(4.25), water);
  assert.equal(water.uniforms.uTime.value, 4.25);
  water.setReducedMotion(true);
  assert.equal(water.uniforms.uMotionScale.value, 0);
  water.setMotionScale(0.35);
  assert.equal(water.uniforms.uMotionScale.value, 0.35);

  const abyss = landscape.createTerrainRibbonMaterial({
    kind: 'abyss-fracture',
    colors: { deep: 0x020108, shallow: 0x332255, edge: 0x55ccff },
  });
  const lava = landscape.createTerrainRibbonMaterial({
    kind: 'lava-ravine',
    colors: { deep: 0x220000, shallow: 0xff5500, edge: 0xffcc44 },
  });
  for (const material of [abyss, lava]) {
    assert.equal(material.isMeshBasicNodeMaterial, true);
    assert.ok(material.outputNode?.isNode);
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, true);
    assert.equal(material.depthTest, true);
    assert.equal(material.side, THREE.DoubleSide);
    assert.equal(material.fog, false);
  }
  assert.equal(abyss.uniforms.uAbyss.value, 1);
  assert.equal(abyss.uniforms.uLava.value, 0);
  assert.equal(lava.uniforms.uAbyss.value, 0);
  assert.equal(lava.uniforms.uLava.value, 1);
  assert.throws(
    () => landscape.createTerrainRibbonMaterial(),
    /requires a layout with colors/,
  );
});

test('Twilight fog and Void chasm retain hazard semantics without instance tint', () => {
  const fog = hazards.createTwilightFogMaterial({ heroX: 3, heroZ: -4 });
  assert.equal(fog.isMeshBasicNodeMaterial, true);
  assert.ok(fog.outputNode?.isNode);
  assert.equal(fog.transparent, true);
  assert.equal(fog.depthWrite, false);
  assert.equal(fog.depthTest, true);
  assert.equal(fog.side, THREE.FrontSide);
  assert.equal(fog.blending, THREE.NormalBlending);
  assert.equal(fog.fog, false);
  assert.deepEqual(fog.uniforms.uHero.value.toArray(), [3, -4]);
  fog.setHeroPosition(new THREE.Vector2(8, 9));
  assert.deepEqual(fog.uniforms.uHero.value.toArray(), [8, 9]);

  const chasm = hazards.createVoidChasmMaterial();
  assert.equal(chasm.isMeshBasicNodeMaterial, true);
  assert.ok(chasm.outputNode?.isNode);
  assert.equal(chasm.transparent, true);
  assert.equal(chasm.depthWrite, false);
  assert.equal(chasm.depthTest, true);
  assert.equal(chasm.side, THREE.FrontSide);
  assert.equal(chasm.blending, THREE.NormalBlending);
  assert.equal(chasm.fog, false);
  assert.equal(chasm.userData.ignoresInstanceColor, true);

  // The pool still carries cyan colors. A custom outputNode bypasses
  // MeshBasicNodeMaterial.setupDiffuseColor(), where r185 otherwise applies
  // instanceColor unconditionally.
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(), chasm, 1);
  pool.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 1]), 3);
  assert.equal(pool.material.outputNode, chasm.outputNode);
  assert.equal(pool.material.colorNode, null);
});

test('Forest gate veil retains compatibility fields and accessibility uniforms', () => {
  const veil = telegraphs.createForestGateVeilMaterial(0x80eeff);
  assert.equal(veil.isMeshBasicNodeMaterial, true);
  assert.ok(veil.outputNode?.isNode);
  assert.equal(veil.name, 'ForestTrialGateVeilNodeMaterial');
  assert.equal(veil.transparent, true);
  assert.equal(veil.depthWrite, false);
  assert.equal(veil.depthTest, true);
  assert.equal(veil.side, THREE.DoubleSide);
  assert.equal(veil.blending, THREE.NormalBlending);
  assert.equal(veil.fog, false);
  assert.equal(veil.color, veil.uniforms.uColor.value);
  assert.equal(veil.opacity, 0.5);
  veil.color.setHex(0xff8844);
  assert.equal(veil.uniforms.uColor.value.getHex(), 0xff8844);
  veil.setVeilOpacity(0.31);
  assert.equal(veil.opacity, 0.31);
  assert.equal(veil.uniforms.uOpacity.value, 0.31);
  veil.setReducedMotion(true);
  assert.equal(veil.uniforms.uMotionScale.value, 0);
  assert.equal(veil.userData.selectiveBloom, false);
});

test('Forest and Cave sky domes use dynamic TSL inputs with released render flags', () => {
  const current = new THREE.DataTexture(new Uint8Array([255, 128, 64, 255]), 1, 1);
  const next = new THREE.DataTexture(new Uint8Array([64, 128, 255, 255]), 1, 1);
  current.needsUpdate = true;
  next.needsUpdate = true;

  const forest = skies.createForestSkyDomeMaterial(current, next);
  const cave = skies.createCaveSkyDomeMaterial(0x1a1820, 0x4a4a52);
  for (const material of [forest, cave]) {
    assert.equal(material.isMeshBasicNodeMaterial, true);
    assert.ok(material.outputNode?.isNode);
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, false);
    assert.equal(material.depthTest, true);
    assert.equal(material.side, THREE.BackSide);
    assert.equal(material.blending, THREE.NormalBlending);
    assert.equal(material.fog, false);
    assert.equal(material.toneMapped, false);
  }

  assert.equal(forest.uniforms.u_current.value, current);
  assert.equal(forest.uniforms.u_next.value, next);
  forest.uniforms.u_current.value = next;
  assert.equal(forest.uniforms.u_current.value, next);
  forest.setBlend(0.4).setReducedMotion(true);
  assert.equal(forest.uniforms.u_blend.value, 0.4);
  assert.equal(forest.uniforms.uMotionScale.value, 0);
  assert.equal(cave.uniforms.uLo.value.getHex(), 0x1a1820);
  assert.equal(cave.uniforms.uHi.value.getHex(), 0x4a4a52);
  assert.throws(
    () => skies.createForestSkyDomeMaterial(null, next),
    /requires two Three\.js textures/,
  );
});

test('surface source contract has no WebGL hooks and retains exact released math', async () => {
  const sources = Object.fromEntries(await Promise.all(MODULE_NAMES.map(async (name) => [
    name,
    await fs.readFile(path.join(MATERIAL_DIR, name), 'utf8'),
  ])));
  const all = Object.values(sources).join('\n');

  assert.doesNotMatch(all, /ShaderMaterial|onBeforeCompile|vertexShader\s*:|fragmentShader\s*:/);
  assert.match(all, /from 'three\/webgpu'/);
  assert.match(all, /from 'three\/tsl'/);

  const landscapeSource = sources['landscapeMaterials.js'];
  assert.match(landscapeSource, /world\.x\.mul\(0\.72\)/);
  assert.match(landscapeSource, /world\.z\.mul\(1\.08\)/);
  assert.match(landscapeSource, /smoothstep\(\s*0\.08,\s*0\.48/s);
  assert.match(landscapeSource, /float\(0\.34\).*ripples\.mul\(0\.10\).*edge\.mul\(0\.12\)/s);
  assert.match(landscapeSource, /lavaEnabled\.select\(1\.2, 0\.55\)/);
  assert.match(landscapeSource, /fracture\.mul\(0\.18\)/);
  assert.match(landscapeSource, /vein\.mul\(0\.78\)/);
  assert.match(landscapeSource, /abyssEnabled\.select\(0\.66, 0\.42\)/);

  const hazardSource = sources['hazardMaterials.js'];
  assert.match(hazardSource, /smoothstep\(uInner, uOuter, d\)/);
  assert.match(hazardSource, /k\.mul\(0\.78\)/);
  assert.match(hazardSource, /angle\.mul\(5\).*mul\(0\.065\)/s);
  assert.match(hazardSource, /angle\.mul\(9\).*mul\(0\.035\)/s);
  assert.match(hazardSource, /angle\.mul\(14\).*mul\(0\.020\)/s);
  assert.match(hazardSource, /d\.greaterThan\(1\)\.discard\(\)/);
  assert.match(hazardSource, /rim\.mul\(0\.72\)/);
  assert.match(hazardSource, /material\.outputNode = outputNode/);

  const telegraphSource = sources['telegraphMaterials.js'];
  assert.match(telegraphSource, /vec2\(1\.08, 0\.88\)/);
  assert.match(telegraphSource, /animatedTime\.mul\(1\.9\)/);
  assert.match(telegraphSource, /animatedTime\.mul\(1\.35\)/);
  assert.match(telegraphSource, /pow\(wispA\.mul\(wispB\), 1\.6\)/);
  assert.match(telegraphSource, /alpha\.lessThan\(0\.012\)\.discard\(\)/);

  const skySource = sources['skyDomeMaterials.js'];
  assert.match(skySource, /uBlend\.clamp\(0, 1\)/);
  assert.match(skySource, /smoothstep\(0\.4, 1, uv\(\)\.y\)/);
  assert.match(skySource, /material\.toneMapped = false/);

  for (const source of Object.values(sources)) {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier === 'three/webgpu' || specifier === 'three/tsl',
        `unexpected surface material dependency: ${specifier}`,
      );
    }
  }
});
