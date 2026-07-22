import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../../../vendor/three/build/three.webgpu.js';
import {
  cloneTextureForDeferredUpload,
  requestTextureUploadIfReady,
} from '../textureUpload.js';

function textureFixture(image) {
  let version = 0;
  return {
    image,
    get version() { return version; },
    set needsUpdate(value) {
      if (value === true) version += 1;
    },
  };
}

test('TextureLoader placeholders remain clean until an image exists', () => {
  const texture = textureFixture(null);

  assert.equal(requestTextureUploadIfReady(texture), false);
  assert.equal(texture.version, 0);

  texture.image = { width: 1, height: 1, complete: true };
  assert.equal(requestTextureUploadIfReady(texture), true);
  assert.equal(texture.version, 1);
});

test('missing textures are ignored', () => {
  assert.equal(requestTextureUploadIfReady(null), false);
  assert.equal(requestTextureUploadIfReady(undefined), false);
});

test('an atlas clone stays clean while pending and refreshes after its shared source decodes', () => {
  const rawSource = new THREE.Texture();
  const rawClone = rawSource.clone();
  assert.equal(rawClone.version, 1, 'r185 Texture.clone eagerly marks the clone dirty');
  assert.equal(rawSource.source.version, 1, 'r185 Texture.clone also dirties the shared Source');

  const source = new THREE.Texture();
  const initialSourceVersion = source.source.version;
  const atlasFrame = cloneTextureForDeferredUpload(source);

  assert.equal(source.image, null);
  assert.equal(atlasFrame.image, null);
  assert.equal(atlasFrame.version, 0, 'the unpublished pending clone is not upload-ready');
  assert.equal(source.source.version, initialSourceVersion, 'the shared pending Source stays clean');
  assert.equal(requestTextureUploadIfReady(atlasFrame), false);
  assert.equal(atlasFrame.version, 0);
  assert.equal(source.source.version, initialSourceVersion);

  source.image = { width: 4, height: 4, complete: true };
  source.needsUpdate = true;
  assert.equal(atlasFrame.image, source.image, 'Texture.clone shares the decoded Source image');
  assert.equal(source.source.version, initialSourceVersion + 1);
  assert.equal(requestTextureUploadIfReady(atlasFrame), true);
  assert.equal(atlasFrame.version, 1);
  assert.equal(source.source.version, initialSourceVersion + 2);
});
