import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRecoveryPresentation,
  rendererBackendUrl,
} from '../recoveryPresentation.js';

test('reports a completed persistent save separately from the non-resumable active run', () => {
  const presentation = normalizeRecoveryPresentation({
    backend: 'webgpu',
    recoveryState: {
      canRetry: true,
      canSwitchToWebGL: true,
      lastLoss: {
        reason: 'device-removed',
        progressSaved: true,
      },
    },
  });

  assert.equal(presentation.backendLabel, 'WebGPU');
  assert.equal(presentation.progressTitle, 'Persistent progression saved');
  assert.match(presentation.progressDetail, /active run is not resumable/i);
  assert.equal(presentation.reason, 'device-removed');
  assert.equal(presentation.canRetry, true);
  assert.equal(presentation.canSwitchToWebGL, true);
});

test('does not overstate save success and sanitizes diagnostic text for display', () => {
  const presentation = normalizeRecoveryPresentation({
    backend: 'webgpu',
    recoveryState: {
      lastLoss: {
        message: 'GPU\n\u0000 reset <img src=x onerror=alert(1)>',
        progressSaved: false,
      },
    },
  });

  assert.equal(presentation.progressTitle, 'Emergency save was not completed');
  assert.match(presentation.progressDetail, /could not be confirmed saved/i);
  assert.equal(presentation.reason, 'GPU reset <img src=x onerror=alert(1)>');
});

test('keeps the legacy no-argument presentation valid', () => {
  const presentation = normalizeRecoveryPresentation();

  assert.equal(presentation.backendLabel, 'Unknown renderer');
  assert.equal(presentation.progressSaved, null);
  assert.match(presentation.progressDetail, /active run is not resumable/i);
  assert.equal(presentation.canRetry, true);
  assert.equal(presentation.canSwitchToWebGL, false);
});

test('does not offer a WebGL switch when WebGL 2 is already active', () => {
  assert.equal(normalizeRecoveryPresentation({ backend: 'webgl' }).canSwitchToWebGL, false);
  assert.equal(normalizeRecoveryPresentation({ backend: 'webgl2' }).canSwitchToWebGL, false);
});

test('backend URL preserves unrelated query parameters and the fragment', () => {
  const href = rendererBackendUrl('https://example.test/game/?qa=postfx&renderer=webgpu#capture');
  const url = new URL(href);

  assert.equal(url.searchParams.get('qa'), 'postfx');
  assert.equal(url.searchParams.get('renderer'), 'webgl');
  assert.equal(url.hash, '#capture');
});
