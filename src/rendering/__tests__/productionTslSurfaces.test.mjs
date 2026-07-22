import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const PRODUCTION_FILES = Object.freeze({
  landscapes: 'src/stageLandscapes.js',
  hazards: 'src/stageHazards.js',
  portals: 'src/forestPortals.js',
  forestSky: 'src/forestSkyDome.js',
  caveSky: 'src/stages/cave/caveSkyDome.js',
});

async function readProductionSources() {
  return Object.fromEntries(await Promise.all(
    Object.entries(PRODUCTION_FILES).map(async ([name, relativePath]) => [
      name,
      await fs.readFile(path.join(ROOT, relativePath), 'utf8'),
    ]),
  ));
}

test('production surface owners use the TSL factories and contain no WebGL shader hooks', async () => {
  const sources = await readProductionSources();
  const all = Object.values(sources).join('\n');

  assert.doesNotMatch(
    all,
    /\b(?:ShaderMaterial|RawShaderMaterial|vertexShader|fragmentShader|onBeforeCompile)\b/,
  );

  assert.match(sources.landscapes, /from '.\/rendering\/materials\/landscapeMaterials\.js'/);
  assert.match(sources.landscapes, /createWaterMaterial\(palette\.deep, palette\.shallow, palette\.opacity\)/);
  assert.match(sources.landscapes, /createTerrainRibbonMaterial\(layout\)/);

  assert.match(sources.hazards, /from '.\/rendering\/materials\/hazardMaterials\.js'/);
  assert.match(sources.hazards, /createTwilightFogMaterial\(\)/);
  assert.match(sources.hazards, /createVoidChasmMaterial\(\)/);

  assert.match(sources.portals, /from '.\/rendering\/materials\/telegraphMaterials\.js'/);
  assert.match(sources.portals, /createForestGateVeilMaterial\(colorHex\)/);

  assert.match(sources.forestSky, /from '.\/rendering\/materials\/skyDomeMaterials\.js'/);
  assert.match(sources.forestSky, /createForestSkyDomeMaterial\(/);
  assert.match(sources.caveSky, /from '\.\.\/\.\.\/rendering\/materials\/skyDomeMaterials\.js'/);
  assert.match(sources.caveSky, /createCaveSkyDomeMaterial\(/);
});

test('production update and disposal seams retain their material contracts', async () => {
  const sources = await readProductionSources();

  // Landscape animation remains a binding update at draw time. Accessibility
  // changes the motion uniform without replacing the node graph.
  assert.equal((sources.landscapes.match(/mat\.uniforms\.uTime\.value =/g) || []).length, 2);
  assert.equal((sources.landscapes.match(/mat\.uniforms\.uMotionScale\.value =/g) || []).length, 2);
  assert.equal((sources.landscapes.match(/_track\(geo, mat\)/g) || []).length >= 2, true);
  assert.match(sources.landscapes, /for \(const r of _resources\)[\s\S]*r\.dispose/);

  // Twilight retains its hero/radius bindings, including the surge easing;
  // the Void pool still explicitly opts out of instance-colour tinting in its
  // material factory and remains outside selective bloom at this call site.
  assert.match(sources.hazards, /u\.uHero\.value\.set\(heroX, heroZ\)/);
  assert.match(sources.hazards, /u\.uInner\.value \+=/);
  assert.match(sources.hazards, /u\.uOuter\.value \+=/);
  assert.match(
    sources.hazards,
    /_mkInst\(chasmGeo, chasmMat, VOID_CHASM_CAP, false\)/,
  );

  // The gate keeps the legacy color/opacity compatibility surface while the
  // animated bindings and reduced-motion toggle keep the released public
  // uniform update surface.
  assert.match(sources.portals, /gateVeilMat\.uniforms\.uOpacity\.value = opacity/);
  assert.match(sources.portals, /gateVeilMat\.uniforms\.uTime\.value =/);
  assert.match(sources.portals, /gateVeilMat\.uniforms\.uMotionScale\.value =/);
  assert.match(sources.portals, /portal\.beaconMat\.color\.setHex\(/);
  assert.match(sources.portals, /portal\.beaconMat\.dispose\(\)/);

  // Sky phase changes remain texture/uniform swaps, not graph rebuilds, and
  // both owners retain idempotent geometry/material/texture cleanup.
  assert.match(sources.forestSky, /_material\.uniforms\.u_current\.value =/);
  assert.match(sources.forestSky, /_material\.uniforms\.u_next\.value\s+=/);
  assert.match(sources.forestSky, /_material\.uniforms\.u_blend\.value\s+=/);
  assert.match(sources.forestSky, /_material\.uniforms\.uMotionScale\.value =/);
  assert.match(sources.forestSky, /_geometry\.dispose\(\)/);
  assert.match(sources.forestSky, /_material\.dispose\(\)/);
  assert.match(sources.forestSky, /typeof t\.dispose === 'function'/);
  assert.match(sources.caveSky, /if \(!_state\) return false/);
  assert.match(sources.caveSky, /geo && geo\.dispose\(\)/);
  assert.match(sources.caveSky, /mat && mat\.dispose\(\)/);
});

// Exercise the two self-contained production owners against one WebGPU build
// universe. Texture loading is replaced with deterministic one-pixel textures
// so this lifecycle test remains browser- and network-independent.
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-production-surfaces-'));

after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('Forest and Cave production sky owners update and dispose node resources', async () => {
  const fixtureSrc = path.join(fixtureRoot, 'src');
  const fixtureMaterials = path.join(fixtureSrc, 'rendering/materials');
  const fixtureCave = path.join(fixtureSrc, 'stages/cave');
  const fixtureThree = path.join(fixtureRoot, 'node_modules/three');
  await Promise.all([
    fs.mkdir(fixtureMaterials, { recursive: true }),
    fs.mkdir(fixtureCave, { recursive: true }),
    fs.mkdir(fixtureThree, { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(path.join(ROOT, PRODUCTION_FILES.forestSky), path.join(fixtureSrc, 'forestSkyDome.js')),
    fs.copyFile(path.join(ROOT, PRODUCTION_FILES.caveSky), path.join(fixtureCave, 'caveSkyDome.js')),
    fs.copyFile(path.join(ROOT, 'src/stages/cave/cavePalette.js'), path.join(fixtureCave, 'cavePalette.js')),
    fs.copyFile(
      path.join(ROOT, 'src/rendering/materials/skyDomeMaterials.js'),
      path.join(fixtureMaterials, 'skyDomeMaterials.js'),
    ),
    fs.symlink(path.join(ROOT, 'vendor/three/build'), path.join(fixtureThree, 'build'), 'dir'),
  ]);
  await fs.writeFile(
    path.join(fixtureThree, 'package.json'),
    JSON.stringify({
      name: 'three',
      type: 'module',
      exports: {
        '.': './build/three.webgpu.js',
        './webgpu': './build/three.webgpu.js',
        './tsl': './build/three.tsl.js',
      },
    }),
  );
  await fs.writeFile(path.join(fixtureRoot, 'threeBridge.js'), "export * from 'three';\n");

  const THREE = await import(pathToFileURL(path.join(fixtureRoot, 'threeBridge.js')).href);
  const forest = await import(pathToFileURL(path.join(fixtureSrc, 'forestSkyDome.js')).href);
  const cave = await import(pathToFileURL(path.join(fixtureCave, 'caveSkyDome.js')).href);

  const originalLoad = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function loadFixtureTexture(url, onLoad) {
    const texture = new THREE.DataTexture(new Uint8Array([96, 128, 160, 255]), 1, 1);
    texture.name = String(url);
    texture.needsUpdate = true;
    if (onLoad) onLoad(texture);
    return texture;
  };

  try {
    const scene = new THREE.Scene();
    forest.loadForestSkyDome(scene, {});
    assert.equal(scene.children.length, 1);
    const forestMesh = scene.children[0];
    const forestMaterial = forestMesh.material;
    assert.equal(forestMaterial.isMeshBasicNodeMaterial, true);
    assert.equal(forestMaterial.userData.tslMaterialFamily, 'forest-sky-dome');

    forest.tickForestSkyDome({ time: { game: 700 }, _optReduceMotion: false }, 0);
    assert.match(forestMaterial.uniforms.u_current.value.name, /sky_golden\.webp$/);
    assert.equal(forestMaterial.uniforms.u_blend.value, 0);
    forest.tickForestSkyDome({ time: { game: 1300 }, _optReduceMotion: false }, 0.1);
    assert.match(forestMaterial.uniforms.u_next.value.name, /sky_dusk\.webp$/);
    forest.tickForestSkyDome({ time: { game: 1300 }, _optReduceMotion: false }, 1.5);
    assert.equal(forestMaterial.uniforms.u_blend.value, 0.5);
    forest.tickForestSkyDome({ time: { game: 1300 }, _optReduceMotion: true }, 0);
    assert.equal(forestMaterial.uniforms.uMotionScale.value, 0);

    let forestGeometryDisposals = 0;
    let forestMaterialDisposals = 0;
    let forestTextureDisposals = 0;
    forestMesh.geometry.addEventListener('dispose', () => { forestGeometryDisposals += 1; });
    forestMaterial.addEventListener('dispose', () => { forestMaterialDisposals += 1; });
    const forestTextures = new Set([
      forestMaterial.uniforms.u_current.value,
      forestMaterial.uniforms.u_next.value,
    ]);
    // The owner has five textures; count all disposals through the class
    // prototype because only two are exposed by the active bindings.
    const originalTextureDispose = THREE.Texture.prototype.dispose;
    THREE.Texture.prototype.dispose = function disposeFixtureTexture() {
      forestTextureDisposals += 1;
      return originalTextureDispose.call(this);
    };
    try {
      forest.disposeForestSkyDome(scene);
    } finally {
      THREE.Texture.prototype.dispose = originalTextureDispose;
    }
    assert.equal(scene.children.length, 0);
    assert.equal(forestGeometryDisposals, 1);
    assert.equal(forestMaterialDisposals, 1);
    assert.equal(forestTextureDisposals, 5);
    assert.equal(forestTextures.size >= 1, true);
    forest.disposeForestSkyDome(scene);

    const parent = new THREE.Group();
    const built = cave.buildCaveSkyDome(parent);
    assert.equal(built.present, true);
    assert.equal(parent.children.length, 1);
    const caveMesh = built.group.children[0];
    assert.equal(caveMesh.material.isMeshBasicNodeMaterial, true);
    assert.equal(caveMesh.material.userData.tslMaterialFamily, 'cave-sky-dome');
    assert.equal(caveMesh.material.uniforms.uLo.value.getHex(), 0x1a1820);
    assert.equal(caveMesh.material.uniforms.uHi.value.getHex(), 0x4a4a52);
    let caveGeometryDisposals = 0;
    let caveMaterialDisposals = 0;
    caveMesh.geometry.addEventListener('dispose', () => { caveGeometryDisposals += 1; });
    caveMesh.material.addEventListener('dispose', () => { caveMaterialDisposals += 1; });
    assert.equal(cave.disposeCaveSkyDome(), true);
    assert.equal(parent.children.length, 0);
    assert.equal(caveGeometryDisposals, 1);
    assert.equal(caveMaterialDisposals, 1);
    assert.equal(cave.disposeCaveSkyDome(), false);
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});
