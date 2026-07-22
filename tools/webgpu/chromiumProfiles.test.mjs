import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveChromiumArgs, SOFTWARE_WEBGL_ARGS, SOFTWARE_WEBGPU_ARGS } from './chromiumProfiles.mjs';

test('required WebGPU uses Vulkan SwiftShader instead of the WebGL-only profile', () => {
  const args = resolveChromiumArgs('webgpu');
  assert.deepEqual(args, [...SOFTWARE_WEBGPU_ARGS]);
  assert.ok(args.includes('--use-vulkan=swiftshader'));
  assert.ok(args.includes('--use-angle=vulkan'));
  assert.ok(!args.includes('--use-gl=swiftshader'));
});

test('auto and forced WebGL retain the software WebGL 2 profile', () => {
  assert.deepEqual(resolveChromiumArgs('auto'), [...SOFTWARE_WEBGL_ARGS]);
  assert.deepEqual(resolveChromiumArgs('webgl'), [...SOFTWARE_WEBGL_ARGS]);
});

test('explicit JSON and shell-style overrides remain authoritative', () => {
  assert.deepEqual(resolveChromiumArgs('webgpu', '["--foo","--bar=baz"]'), ['--foo', '--bar=baz']);
  assert.deepEqual(resolveChromiumArgs('webgpu', '--foo --bar=baz'), ['--foo', '--bar=baz']);
});
