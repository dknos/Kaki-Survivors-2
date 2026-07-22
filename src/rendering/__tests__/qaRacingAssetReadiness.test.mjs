import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canLaunchRacingMode,
  getRacingModeAvailability,
} from '../../racing/racingModeAvailability.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('non-Catastrophe racing QA awaits its production asset lease before reporting ready', () => {
  const source = read('src/qa/qaScenes.js');
  const setup = between(source, 'async function setupRacing', 'async function setupPostfx');
  const orderedSteps = [
    "await window.kkStartRacing('forest', options)",
    "await waitUntil(() => state.started && state.mode === 'racing' && state.racing, kind)",
    "if (kind !== 'catastrophe' && state.racing.assetLease?.ready)",
    'await state.racing.assetLease.ready',
    'await nextFrames(2)',
    'qa.details.assetsReady = true',
    'makeHeroSafe()',
  ].map((needle) => ({ needle, index: setup.indexOf(needle) }));

  for (const step of orderedSteps) {
    assert.notEqual(step.index, -1, `setupRacing is missing: ${step.needle}`);
  }
  for (let index = 1; index < orderedSteps.length; index += 1) {
    assert.ok(
      orderedSteps[index].index > orderedSteps[index - 1].index,
      `${orderedSteps[index].needle} must follow ${orderedSteps[index - 1].needle}`,
    );
  }
  assert.equal(
    (setup.match(/qa\.details\.assetsReady\s*=\s*true/g) || []).length,
    1,
    'assetsReady must only be marked by the guarded post-lease path',
  );

  const routing = between(source, 'async function setupScene', '/** Start the selected scene once.');
  for (const selector of [
    'rally-heavy',
    'rally-first-person',
    'rally-chase',
    'monster-smash',
    'draw-track',
    'trials',
  ]) {
    assert.match(routing, new RegExp(`['"]${selector}['"]`), `${selector} left racing QA routing`);
  }
});

test('Catastrophe stays preserved but deferred outside active renderer QA suites', () => {
  assert.equal(canLaunchRacingMode('crash'), false);
  assert.equal(getRacingModeAvailability('crash').status, 'deferred');

  const baseline = read('tools/webgpu/baseline.mjs');
  assert.match(
    baseline,
    /\{ id: 'kaki-catastrophe', label: 'Kaki Catastrophe', selector: 'catastrophe', deferred: true \}/,
  );
  assert.match(baseline, /if \(!row\.deferred\) requestedIds\.add\(row\.id\)/);
  const activeModes = between(
    baseline,
    'modes: Object.freeze([',
    ']),\n  town:',
  );
  assert.doesNotMatch(activeModes, /catastrophe/i);
  for (const activeId of [
    'bullet-hell',
    'kaki-rally',
    'first-person-camera',
    'chase-camera',
    'draw-track',
    'monster-smash',
    'kaki-trials',
  ]) {
    assert.match(activeModes, new RegExp(`['"]${activeId}['"]`));
  }
});
