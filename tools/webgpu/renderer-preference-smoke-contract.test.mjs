import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const smoke = fs.readFileSync(
  path.join(ROOT, 'tools/webgpu/smoke-renderer-preference.mjs'),
  'utf8',
);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('renderer preference smoke covers saved fallback and explicit WebGPU precedence', () => {
  assert.match(smoke, /id: 'saved-webgl-no-query'[\s\S]{0,220}queryBackend: null/);
  assert.match(smoke, /id: 'query-webgpu-overrides-saved-webgl'[\s\S]{0,220}queryBackend: 'webgpu'/);
  assert.match(smoke, /optRenderer: 'webgl'/);
  assert.match(smoke, /requestedBackend === definition\.expectedRequested/);
  assert.match(smoke, /actualBackend === definition\.expectedActual/);
});

test('WebGPU precedence case requires the shared Vulkan SwiftShader profile', () => {
  assert.match(smoke, /resolveChromiumArgs\(/);
  for (const flag of [
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--use-vulkan=swiftshader',
  ]) {
    assert.match(smoke, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(smoke, /webgpuDevice/);
});

test('production Display inspection checks the complete selector and override hint', () => {
  assert.match(smoke, /Renderer · Advanced/);
  assert.match(smoke, /Apply & Reload/);
  assert.ok(smoke.includes('/URL override active \\(webgpu\\)/i'));
  assert.match(smoke, /\['auto', 'webgpu', 'webgl'\]/);
});

test('smoke keeps production hardening and has an explicit npm entrypoint', () => {
  assert.match(smoke, /unhandledrejection/);
  assert.match(smoke, /pageerror/);
  assert.match(smoke, /production-local request failures/);
  assert.equal(
    pkg.scripts['test:renderer:preference'],
    'node tools/webgpu/smoke-renderer-preference.mjs --output docs/webgpu/RENDERER_PREFERENCE_SMOKE.json',
  );
});
