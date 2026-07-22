import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLOOM_INTENSITY_KEY,
  BLOOM_LAYER,
  getSelectiveBloomIntensity,
  isSelectiveBloom,
  setSelectiveBloom,
} from '../bloomLayers.js';

function object3d(children = []) {
  let mask = 1;
  const object = {
    userData: {},
    children,
    layers: {
      enable(layer) { mask |= 1 << layer; },
      disable(layer) { mask &= ~(1 << layer); },
      isEnabled(layer) { return (mask & (1 << layer)) !== 0; },
    },
    traverse(visitor) {
      visitor(this);
      for (const child of children) child.traverse(visitor);
    },
  };
  return object;
}

test('semantic membership preserves layer 1 and supports intensity', () => {
  const object = object3d();
  assert.equal(BLOOM_LAYER, 1);
  assert.equal(getSelectiveBloomIntensity(object), 0);
  assert.equal(setSelectiveBloom(object, true, 0.65), 1);
  assert.equal(object.layers.isEnabled(1), true);
  assert.equal(object.userData[BLOOM_INTENSITY_KEY], 0.65);
  assert.equal(getSelectiveBloomIntensity(object), 0.65);
  assert.equal(isSelectiveBloom(object), true);
  assert.equal(setSelectiveBloom(object, false), 1);
  assert.equal(getSelectiveBloomIntensity(object), 0);
});

test('legacy direct layer membership defaults to intensity one', () => {
  const object = object3d();
  object.layers.enable(BLOOM_LAYER);
  assert.equal(getSelectiveBloomIntensity(object), 1);
});

test('recursive membership is explicit and invalid intensities fail', () => {
  const child = object3d();
  const root = object3d([child]);
  assert.equal(setSelectiveBloom(root, true, 1.4, { recursive: true }), 2);
  assert.equal(getSelectiveBloomIntensity(root), 1.4);
  assert.equal(getSelectiveBloomIntensity(child), 1.4);
  assert.throws(() => setSelectiveBloom(root, true, -1), /finite number >= 0/);
});
