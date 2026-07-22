import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeBackendPreference,
  readBackendPreference,
  rendererPreferenceReloadUrl,
} from '../rendererSettings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('saved renderer preference is strictly normalized when no URL override exists', () => {
  assert.equal(readBackendPreference('', 'webgpu'), 'webgpu');
  assert.equal(readBackendPreference('?qa=stage-forest', 'webgl'), 'webgl');
  assert.equal(readBackendPreference('', 'not-a-backend'), 'auto');
  assert.equal(normalizeBackendPreference(' WEBGPU '), 'webgpu');
  assert.equal(normalizeBackendPreference('webgl2'), 'auto');
});

test('renderer query parameter always overrides the saved preference', () => {
  assert.equal(readBackendPreference('?renderer=webgpu', 'webgl'), 'webgpu');
  assert.equal(readBackendPreference('?renderer=webgl', 'webgpu'), 'webgl');
  assert.equal(readBackendPreference('?renderer=auto', 'webgl'), 'auto');
  assert.equal(
    readBackendPreference('?renderer=invalid', 'webgl'),
    'auto',
    'an invalid explicit override must not silently fall through to a forced saved backend',
  );
  assert.equal(readBackendPreference('?renderer=&qa=postfx', 'webgpu'), 'auto');
});

test('Apply and Reload URL removes only the temporary renderer override', () => {
  const result = new URL(rendererPreferenceReloadUrl(
    'https://example.test/game/?qa=postfx&renderer=webgpu&rendererDiagnostics=1#capture',
  ));
  assert.equal(result.searchParams.has('renderer'), false);
  assert.equal(result.searchParams.get('qa'), 'postfx');
  assert.equal(result.searchParams.get('rendererDiagnostics'), '1');
  assert.equal(result.hash, '#capture');
});

test('production boot and Display settings are wired to persisted renderer metadata', () => {
  const main = read('src/main.js');
  const meta = read('src/meta.js');
  const ui = read('src/ui.js');

  assert.match(main, /readBackendPreference\([\s\S]{0,160}window\.location\.search,[\s\S]{0,160}getMeta\(\)\.optRenderer/);
  assert.match(meta, /optRenderer:\s*'auto'/);
  assert.match(meta, /key === 'optRenderer'\s*\?\s*normalizeBackendPreference\(val\)/);
  assert.match(ui, /Renderer · Advanced/);
  assert.match(ui, /Apply & Reload/);
  assert.match(ui, /rendererPreferenceReloadUrl\(window\.location\.href\)/);
});
