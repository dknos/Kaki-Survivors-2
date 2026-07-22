import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../..');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kk-forest-sky-readiness-'));
const fixtureSrc = path.join(fixtureRoot, 'src');
const fixtureMaterials = path.join(fixtureSrc, 'rendering/materials');
const fixtureThree = path.join(fixtureRoot, 'node_modules/three');

await Promise.all([
  fs.mkdir(fixtureMaterials, { recursive: true }),
  fs.mkdir(fixtureThree, { recursive: true }),
]);
await Promise.all([
  fs.copyFile(path.join(ROOT, 'src/forestSkyDome.js'), path.join(fixtureSrc, 'forestSkyDome.js')),
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
const forestSky = await import(pathToFileURL(path.join(fixtureSrc, 'forestSkyDome.js')).href);

after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('Forest sky never marks a null-image TextureLoader result upload-ready', () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  const pending = [];
  THREE.TextureLoader.prototype.load = function deferFixtureImage(url, onLoad) {
    const texture = new THREE.Texture();
    pending.push({ texture, url: String(url), onLoad });
    return texture;
  };

  const scene = new THREE.Scene();
  try {
    forestSky.loadForestSkyDome(scene, {});
    assert.equal(pending.length, 5);
    assert.equal(scene.children.length, 1);

    for (const { texture } of pending) {
      assert.equal(texture.image, null);
      assert.equal(
        texture.version,
        0,
        'WebGPU must keep the backend placeholder until TextureLoader assigns an image',
      );
      assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
      assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping);
      assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
    }

    const material = scene.children[0].material;
    assert.equal(material.uniforms.u_current.value.version, 0);
    assert.equal(material.uniforms.u_next.value.version, 0);

    // Mirror TextureLoader's real completion order: assign the decoded image,
    // mark it dirty, then invoke onLoad. Sky sampling configuration must not
    // produce a second or premature version bump.
    for (const entry of pending) {
      entry.texture.image = { width: 1, height: 1, complete: true };
      entry.texture.needsUpdate = true;
      entry.onLoad?.(entry.texture);
      assert.equal(entry.texture.version, 1);
      assert.equal(entry.texture.image.complete, true);
    }
  } finally {
    forestSky.disposeForestSkyDome(scene);
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});
