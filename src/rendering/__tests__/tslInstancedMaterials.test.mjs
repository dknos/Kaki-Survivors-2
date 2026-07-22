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
  'atmosphereParticleMaterial.js',
  'trialsParticleMaterial.js',
  'spritePoolMaterial.js',
];
const PRODUCTION_PATHS = Object.freeze({
  atmosphere: path.join(ROOT, 'src/env.js'),
  sprites: path.join(ROOT, 'src/sprites/spritePool.js'),
  trials: path.join(ROOT, 'src/racing/trialsMode.js'),
});

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-tsl-instanced-'));
const fixtureMaterials = path.join(fixtureRoot, 'src/rendering/materials');
await fs.mkdir(fixtureMaterials, { recursive: true });
await fs.mkdir(path.join(fixtureRoot, 'node_modules'), { recursive: true });
await fs.symlink(path.join(ROOT, 'vendor/three'), path.join(fixtureRoot, 'node_modules/three'), 'dir');
await Promise.all(MODULE_NAMES.map((name) => (
  fs.copyFile(path.join(MATERIAL_DIR, name), path.join(fixtureMaterials, name))
)));

const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three/build/three.webgpu.js')).href);
const atmosphere = await import(
  pathToFileURL(path.join(fixtureMaterials, 'atmosphereParticleMaterial.js')).href
);
const trials = await import(
  pathToFileURL(path.join(fixtureMaterials, 'trialsParticleMaterial.js')).href
);
const sprites = await import(
  pathToFileURL(path.join(fixtureMaterials, 'spritePoolMaterial.js')).href
);

after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function dataTexture(r = 255, g = 255, b = 255, a = 255) {
  const value = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  value.needsUpdate = true;
  return value;
}

test('atmosphere adapter preserves CPU arrays while using portable instanced quads', () => {
  const source = new THREE.BufferGeometry();
  const positionArray = new Float32Array([
    -1, 2, -3,
    4, 5, 6,
  ]);
  const sizeArray = new Float32Array([1.2, 2.4]);
  const alphaArray = new Float32Array([0.3, 0.8]);
  source.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  source.setAttribute('aSize', new THREE.BufferAttribute(sizeArray, 1));
  source.setAttribute('aAlpha', new THREE.BufferAttribute(alphaArray, 1));
  source.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  let sourceDisposals = 0;
  source.addEventListener('dispose', () => { sourceDisposals += 1; });

  const geometry = atmosphere.createAtmosphereParticleGeometry(source);
  assert.equal(geometry.isInstancedBufferGeometry, true);
  assert.equal(geometry.instanceCount, 2);
  assert.equal(geometry.getAttribute('position').count, 4);
  assert.equal(geometry.getAttribute('uv').count, 4);
  assert.equal(geometry.getAttribute('aPosition').isInstancedBufferAttribute, true);
  assert.equal(geometry.getAttribute('aSize').isInstancedBufferAttribute, true);
  assert.equal(geometry.getAttribute('aAlpha').isInstancedBufferAttribute, true);
  assert.equal(geometry.getAttribute('aPosition').array, positionArray);
  assert.equal(geometry.getAttribute('aSize').array, sizeArray);
  assert.equal(geometry.getAttribute('aAlpha').array, alphaArray);
  assert.equal(geometry.boundingSphere.radius, 1e6);
  assert.deepEqual(geometry.userData.sourceAttributeContract, {
    position: 'aPosition',
    size: 'aSize',
    alpha: 'aAlpha',
  });
  assert.equal(sourceDisposals, 1);
  assert.equal(geometry.userData.sourceGeometryDisposed, true);
  assert.equal(geometry.atmosphereAttributes.position, geometry.getAttribute('aPosition'));
  assert.equal(geometry.atmosphereAttributes.size, geometry.getAttribute('aSize'));
  assert.equal(geometry.atmosphereAttributes.alpha, geometry.getAttribute('aAlpha'));
  geometry.atmosphereAttributes.position.needsUpdate = true;
  geometry.atmosphereAttributes.alpha.needsUpdate = true;
  assert.equal(geometry.atmosphereAttributes.position.version, 1);
  assert.equal(geometry.atmosphereAttributes.alpha.version, 1);

  const retainedSource = new THREE.BufferGeometry();
  retainedSource.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  retainedSource.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(1), 1));
  retainedSource.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(1), 1));
  let retainedDisposals = 0;
  retainedSource.addEventListener('dispose', () => { retainedDisposals += 1; });
  const retainedGeometry = atmosphere.createAtmosphereParticleGeometry(
    retainedSource,
    { disposeSource: false },
  );
  assert.equal(retainedDisposals, 0);
  assert.equal(retainedGeometry.userData.sourceGeometryDisposed, false);

  assert.throws(
    () => atmosphere.createAtmosphereParticleGeometry(new THREE.BufferGeometry()),
    /requires a position BufferAttribute/,
  );
});

test('atmosphere material retains texture tint, hard alpha cutoff, and update surfaces', () => {
  const map = dataTexture(200, 180, 140, 220);
  const material = atmosphere.createAtmosphereParticleMaterial({
    map,
    color: 0x9bcf6a,
    blending: THREE.AdditiveBlending,
  });
  assert.equal(material.isPointsNodeMaterial, true);
  assert.ok(material.positionNode?.isNode);
  assert.ok(material.sizeNode?.isNode);
  assert.ok(material.outputNode?.isNode);
  assert.equal(material.sizeAttenuation, false);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.depthTest, true);
  assert.equal(material.alphaToCoverage, false);
  assert.equal(material.blending, THREE.AdditiveBlending);
  assert.equal(material.fog, false);
  assert.equal(material.userData.primitiveTopology, 'instanced-quad');
  assert.equal(material.userData.releasedPointSizeConstant, 300);
  assert.equal(material.uniforms.uMap.value, map);
  assert.equal(material.uniforms.uColor.value.getHex(), 0x9bcf6a);
  assert.equal(material.uniforms.uAlphaScale.value, 1);

  const replacement = dataTexture(80, 100, 255);
  assert.equal(material.setMap(replacement), material);
  assert.equal(material.uniforms.uMap.value, replacement);
  material.setColor(0xff8844).setAlphaScale(0.6);
  assert.equal(material.uniforms.uColor.value.getHex(), 0xff8844);
  assert.equal(material.uniforms.uAlphaScale.value, 0.6);
  assert.throws(() => material.setAlphaScale(-1), /alpha scale/);

  let materialDisposals = 0;
  let mapDisposals = 0;
  material.addEventListener('dispose', () => { materialDisposals += 1; });
  replacement.addEventListener('dispose', () => { mapDisposals += 1; });
  material.dispose();
  assert.equal(materialDisposals, 1);
  assert.equal(mapDisposals, 0, 'shared particle texture remains owned by particleTex cache');
});

test('Trials particles multiply the released instanceAlpha without losing basic-material behavior', () => {
  const material = trials.createTrialsParticleMaterial();
  assert.equal(material.isMeshBasicNodeMaterial, true);
  assert.ok(material.opacityNode?.isNode);
  assert.equal(material.color.getHex(), 0xffffff);
  assert.equal(material.vertexColors, true);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.depthTest, true);
  assert.equal(material.blending, THREE.NormalBlending);
  assert.equal(material.fog, true);
  assert.equal(material.userData.instanceAlphaAttribute, 'instanceAlpha');
  assert.equal(material.setPoolOpacity(0.42), material);
  assert.equal(material.uniforms.uOpacity.value, 0.42);
  assert.throws(() => material.setPoolOpacity(1.1), /in \[0, 1\]/);

  const geometry = new THREE.IcosahedronGeometry(0.34, 0);
  geometry.setAttribute(
    'instanceAlpha',
    new THREE.InstancedBufferAttribute(new Float32Array([0.25, 0.75]), 1),
  );
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array([1, 0.5, 0.2, 0.3, 0.8, 1]),
    3,
  );
  assert.equal(mesh.material, material);
  assert.equal(mesh.geometry.getAttribute('instanceAlpha').count, 2);
});

test('sprite pool material retains atlas, billboard, cutout, and per-instance flash contracts', () => {
  const map = dataTexture();
  const atlas = {
    texture: map,
    cols: 8,
    rows: 4,
    frameWidth: 32,
    frameHeight: 64,
    anchor: [0.5, 1],
    billboard: 'cylinder',
    alphaTest: 0.55,
    blendMode: 'normal',
    framePadding: { gutterPixels: 3 },
  };
  const cutout = sprites.createSpritePoolMaterial(atlas);
  assert.equal(cutout.isMeshBasicNodeMaterial, true);
  assert.ok(cutout.vertexNode?.isNode);
  assert.ok(cutout.outputNode?.isNode);
  assert.equal(cutout.transparent, false);
  assert.equal(cutout.depthWrite, true);
  assert.equal(cutout.depthTest, true);
  assert.equal(cutout.blending, THREE.NormalBlending);
  assert.equal(cutout.fog, false);
  assert.equal(cutout.uniforms.uMap.value, map);
  assert.equal(cutout.uniforms.uCols.value, 8);
  assert.equal(cutout.uniforms.uRows.value, 4);
  assert.equal(cutout.uniforms.uAspect.value, 0.5);
  assert.equal(cutout.uniforms.uBillboard.value, 1);
  assert.deepEqual(cutout.uniforms.uAnchor.value.toArray(), [0.5, 1]);
  assert.equal(cutout.uniforms.uAlphaTest.value, 0.55);
  assert.deepEqual(cutout.uniforms.uUvInset.value.toArray(), [3 / 32, 3 / 64]);
  assert.deepEqual(cutout.uniforms.uUvScale.value.toArray(), [26 / 32, 58 / 64]);
  assert.deepEqual(cutout.userData.instanceAttributeContract, [
    'aFrame', 'aScale', 'aFlash', 'aFlip', 'aPose',
  ]);
  assert.equal(cutout.userData.translationOnlyInstanceMatrices, true);

  cutout
    .setBillboardMode('none')
    .setAnchor([0.25, 0.8])
    .setAtlasLayout({ cols: 6, rows: 3, aspect: 0.75 })
    .setAlphaThreshold(0.7);
  assert.equal(cutout.uniforms.uBillboard.value, 2);
  assert.deepEqual(cutout.uniforms.uAnchor.value.toArray(), [0.25, 0.8]);
  assert.equal(cutout.uniforms.uCols.value, 6);
  assert.equal(cutout.uniforms.uRows.value, 3);
  assert.equal(cutout.uniforms.uAspect.value, 0.75);
  assert.equal(cutout.uniforms.uAlphaTest.value, 0.7);
  cutout.setAlphaThreshold(0.1);
  assert.equal(cutout.uniforms.uAlphaTest.value, 0.1);

  const renderedEnemyCutout = sprites.createSpritePoolMaterial({
    ...atlas,
    alphaTest: 0.5,
    cutout: true,
    depthWrite: true,
  });
  assert.equal(renderedEnemyCutout.transparent, false);
  assert.equal(renderedEnemyCutout.depthWrite, true);
  assert.equal(renderedEnemyCutout.userData.cutout, true);

  const blended = sprites.createSpritePoolMaterial({
    ...atlas,
    billboard: 'screen',
    alphaTest: undefined,
    blendMode: 'additive',
  });
  assert.equal(blended.transparent, true);
  assert.equal(blended.depthWrite, false);
  assert.equal(blended.blending, THREE.AdditiveBlending);
  assert.equal(blended.uniforms.uAlphaTest.value, 0.01);
  assert.equal(blended.uniforms.uBillboard.value, 0);

  let materialDisposals = 0;
  let mapDisposals = 0;
  cutout.addEventListener('dispose', () => { materialDisposals += 1; });
  map.addEventListener('dispose', () => { mapDisposals += 1; });
  cutout.dispose();
  assert.equal(materialDisposals, 1);
  assert.equal(mapDisposals, 0, 'atlas texture remains owned by disposeAtlases');
});

test('production instanced paths use TSL factories and retain update/dispose ownership', async () => {
  const sources = Object.fromEntries(await Promise.all(
    Object.entries(PRODUCTION_PATHS).map(async ([name, file]) => [name, await fs.readFile(file, 'utf8')]),
  ));
  const combined = Object.values(sources).join('\n');

  assert.doesNotMatch(
    combined,
    /\bShaderMaterial\b|\bonBeforeCompile\b|customProgramCacheKey|vertexShader\s*:|fragmentShader\s*:/,
  );
  assert.match(sources.atmosphere, /createAtmosphereParticleGeometry\(sourceGeometry\)/);
  assert.match(sources.atmosphere, /createAtmosphereParticleMaterial\(\{/);
  assert.match(sources.atmosphere, /new THREE\.Mesh\(geometry, material\)/);
  assert.doesNotMatch(
    sources.atmosphere,
    /geometry\.attributes\.(?:position|aAlpha)/,
    'all atmosphere CPU writes use the adapter attribute contract',
  );
  assert.match(sources.atmosphere, /geometry\.atmosphereAttributes\.position\.array/);
  assert.match(sources.atmosphere, /geometry\.atmosphereAttributes\.alpha\.array/);
  assert.match(sources.atmosphere, /atmosphereAttributes\.position\.needsUpdate = true/g);
  assert.match(sources.atmosphere, /atmosphereAttributes\.alpha\.needsUpdate = true/g);
  assert.match(sources.atmosphere, /particles\.frustumCulled = false/);
  assert.match(sources.atmosphere, /shared-particle-texture-cache/);

  assert.match(sources.sprites, /createSpritePoolMaterial\(materialAtlas, \{/);
  assert.match(sources.sprites, /new THREE\.InstancedMesh\(geom, material, cap\)/);
  assert.match(sources.sprites, /mesh\.count = cap/);
  assert.match(sources.sprites, /frameAttr\.needsUpdate = true/);
  assert.match(sources.sprites, /scaleAttr\.needsUpdate = true/);
  assert.match(sources.sprites, /flashAttr\.needsUpdate = true/);
  assert.match(sources.sprites, /flipAttr\.needsUpdate = true/);
  assert.match(sources.sprites, /poseAttr\.needsUpdate = true/);
  assert.match(
    sources.sprites,
    /if \(page\.mesh\.parent\) page\.mesh\.parent\.remove\(page\.mesh\);[\s\S]*page\.geom\.dispose\(\);[\s\S]*page\.material\.dispose\(\);[\s\S]*_pools\.clear\(\);/,
  );
  assert.doesNotMatch(sources.sprites, /atlas\.texture\.dispose|pool\.atlas\.texture\.dispose/);

  assert.match(sources.trials, /createTrialsParticleMaterial\(\{/);
  assert.match(sources.trials, /session\.owned\.materials\.add\(material\)/);
  assert.match(sources.trials, /geometry\.setAttribute\('instanceAlpha', alphaAttribute\)/);
  assert.match(sources.trials, /alphaAttribute\.needsUpdate = true/);
  assert.match(sources.trials, /session\.particleMesh\?\.dispose\?\.\(\)/);
  assert.match(sources.trials, /session\.owned\?\.materials[\s\S]*material\.dispose\(\)/);
  assert.match(sources.trials, /session\.owned\?\.geometries[\s\S]*geometry\.dispose\(\)/);
});

test('instanced material source is node-only and records exact released equations', async () => {
  const sources = Object.fromEntries(await Promise.all(MODULE_NAMES.map(async (name) => [
    name,
    await fs.readFile(path.join(MATERIAL_DIR, name), 'utf8'),
  ])));
  const all = Object.values(sources).join('\n');
  assert.doesNotMatch(all, /\bShaderMaterial\b|\bonBeforeCompile\b|vertexShader\s*:|fragmentShader\s*:/);
  assert.match(all, /from 'three\/webgpu'/);
  assert.match(all, /from 'three\/tsl'/);

  const atmosphereSource = sources['atmosphereParticleMaterial.js'];
  assert.match(atmosphereSource, /aSize\s*\.mul\(300\)/);
  assert.match(atmosphereSource, /\.div\(max\(0\.1, viewDepth\)\)/);
  assert.match(atmosphereSource, /\.div\(screenDPR\)/);
  assert.match(atmosphereSource, /alpha\.lessThan\(0\.01\)\.discard\(\)/);
  assert.match(atmosphereSource, /new InstancedBufferGeometry\(\)/);

  const trialsSource = sources['trialsParticleMaterial.js'];
  assert.match(trialsSource, /attribute\('instanceAlpha', 'float'\)/);
  assert.match(trialsSource, /material\.opacityNode = instanceAlpha\.mul\(uOpacity\)/);

  const spriteSource = sources['spritePoolMaterial.js'];
  assert.match(spriteSource, /mod\(aFrame, uCols\)/);
  assert.match(spriteSource, /uRows\.sub\(1\)\.sub\(row\)/);
  assert.match(spriteSource, /float\(0\.5\)\.sub\(uAnchor\.y\)/);
  assert.match(spriteSource, /max\(0\.000001, horizontalCameraOffset\.length\(\)\)/);
  assert.match(spriteSource, /cross\(vec3\(0, 1, 0\), horizontalCameraDirection\)/);
  assert.match(spriteSource, /float\(uBillboard\.equal\(int\(2\)\)\)/);
  assert.match(spriteSource, /mix\(billboardClip, noBillboardClip, isNone\)/);
  assert.match(spriteSource, /material\.maskNode = sampled\.a\.greaterThanEqual\(uAlphaTest\)/);
  assert.match(spriteSource, /aFlash\.clamp\(0, 1\)/);
  assert.match(spriteSource, /aFlip\.clamp\(0, 1\)/);
  assert.match(spriteSource, /anchoredCorner\.x\.mul\(aPose\.x\)/);
  assert.match(spriteSource, /\.mul\(uUvScale\)\.add\(uUvInset\)/);
  assert.match(spriteSource, /material\.outputNode = vec4\(flashedRgb, sampled\.a\)/);

  for (const source of Object.values(sources)) {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier === 'three/webgpu' || specifier === 'three/tsl',
        `unexpected instanced material dependency: ${specifier}`,
      );
    }
  }
});
