import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  analyzeCanvasRgba,
  canvasFrameFailures,
  collectBaselineValidationFailures,
  isToleratedRequestFailure,
  rendererActivityFailures,
} from './baseline-validation.mjs';

const ORIGIN = 'http://127.0.0.1:8787/';

function validFrame() {
  return analyzeCanvasRgba(Uint8Array.from([
    2, 5, 12, 255,
    35, 80, 150, 255,
    180, 130, 70, 255,
    250, 245, 220, 255,
    8, 25, 55, 255,
    70, 160, 90, 255,
    210, 70, 115, 255,
    115, 210, 240, 255,
  ]), 4, 2);
}

function validRuntime() {
  return {
    rendererInfo: { render: { drawCalls: 5, triangles: 120 } },
    diagnostics: {},
    qa: { errors: [] },
    browserErrors: [],
    canvasFrame: validFrame(),
  };
}

test('generic console errors fail while non-actionable warnings remain tolerated', () => {
  const result = {
    runtime: validRuntime(),
    pageErrors: [], requestFailures: [], httpErrors: [],
    console: [
      { type: 'warning', text: 'optional asset warning', location: {} },
      { type: 'error', text: '[renderer] Animation frame failed. Error: pipeline exploded', location: {} },
    ],
  };
  const failures = collectBaselineValidationFailures(result, ORIGIN);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Animation frame failed/);
});

test('missing model and texture warnings fail the hardened capture', () => {
  const result = {
    runtime: validRuntime(),
    pageErrors: [], requestFailures: [], httpErrors: [],
    console: [
      { type: 'warning', text: '[arenaDecor] moonroot crystal kit was not preloaded', location: {} },
      { type: 'warning', text: '[assets] failed: hero model assets/hero.glb', location: {} },
      { type: 'warning', text: '[main] loadForestAmber failed: missing model', location: {} },
      { type: 'warning', text: 'preloaded resource was not used promptly', location: {} },
    ],
  };
  const failures = collectBaselineValidationFailures(result, ORIGIN);
  assert.equal(failures.length, 3);
  for (const failure of failures) assert.match(failure, /^asset warning:/);
});

test('only the exact menu-audio ERR_ABORTED transport case is tolerated', () => {
  const base = {
    runtime: validRuntime(), pageErrors: [], requestFailures: [], httpErrors: [],
  };
  assert.deepEqual(collectBaselineValidationFailures({
    ...base,
    console: [{
      type: 'error',
      text: 'Failed to load resource: net::ERR_ABORTED',
      location: { url: `${ORIGIN}assets/music/menu_glitch.mp3` },
    }],
  }, ORIGIN), []);

  const failures = collectBaselineValidationFailures({
    ...base,
    console: [
      {
        type: 'error',
        text: 'Failed to load resource: net::ERR_ABORTED',
        location: { url: `${ORIGIN}assets/hero.glb` },
      },
      {
        type: 'error',
        text: 'Failed to load resource: the server responded with a status of 404',
        location: { url: `${ORIGIN}missing.glb` },
      },
    ],
  }, ORIGIN);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /console error.*ERR_ABORTED/);
  assert.match(failures[1], /console error.*404/);

  const menuAudioAbort = {
    url: `${ORIGIN}assets/music/menu_glitch.mp3`,
    method: 'GET',
    resourceType: 'media',
    error: 'net::ERR_ABORTED',
  };
  assert.equal(isToleratedRequestFailure(menuAudioAbort, ORIGIN), true);
  assert.equal(isToleratedRequestFailure({
    ...menuAudioAbort,
    url: `${ORIGIN}assets/hero.glb`,
    resourceType: 'fetch',
  }, ORIGIN), false);
  assert.equal(isToleratedRequestFailure({
    ...menuAudioAbort,
    resourceType: 'fetch',
  }, ORIGIN), false);

  const requestFailures = collectBaselineValidationFailures({
    ...base,
    console: [],
    requestFailures: [
      menuAudioAbort,
      {
        url: `${ORIGIN}assets/hero.glb`,
        method: 'GET',
        resourceType: 'fetch',
        error: 'net::ERR_ABORTED',
      },
    ],
  }, ORIGIN);
  assert.deepEqual(requestFailures, [
    `local request failed: GET ${ORIGIN}assets/hero.glb (net::ERR_ABORTED)`,
  ]);
});

test('zero or unavailable renderer activity fails after readiness', () => {
  assert.deepEqual(rendererActivityFailures({
    rendererInfo: { render: { drawCalls: 0, triangles: 0 } },
  }), [
    'renderer recorded zero draw calls after QA readiness',
    'renderer recorded zero triangles after QA readiness',
  ]);
  assert.deepEqual(rendererActivityFailures({}), [
    'renderer draw-call metrics are unavailable after QA readiness',
    'renderer triangle metrics are unavailable after QA readiness',
  ]);
  assert.deepEqual(rendererActivityFailures(validRuntime()), []);
});

test('solid and near-black frames fail while a varied rendered frame passes', () => {
  const solid = new Uint8Array(16 * 16 * 4);
  for (let offset = 0; offset < solid.length; offset += 4) {
    solid[offset] = 24;
    solid[offset + 1] = 24;
    solid[offset + 2] = 24;
    solid[offset + 3] = 255;
  }
  assert.match(canvasFrameFailures(analyzeCanvasRgba(solid, 16, 16)).join(' | '), /effectively blank/);

  const black = new Uint8Array(16 * 16 * 4);
  for (let offset = 3; offset < black.length; offset += 4) black[offset] = 255;
  assert.match(canvasFrameFailures(analyzeCanvasRgba(black, 16, 16)).join(' | '), /effectively black/);
  assert.deepEqual(canvasFrameFailures(validFrame()), []);
});

test('baseline evidence records dirty source state and never resumes dirty captures', () => {
  const source = fs.readFileSync(new URL('./baseline.mjs', import.meta.url), 'utf8');
  assert.match(source, /gitValue\(\['status', '--short', '--untracked-files=all'\]/);
  assert.match(source, /dirty: workingTree\.dirty/);
  assert.match(source, /status: workingTree\.status/);
  assert.match(source, /if \(source\.dirty \|\| previous\.source\?\.dirty !== false\)/);
});
