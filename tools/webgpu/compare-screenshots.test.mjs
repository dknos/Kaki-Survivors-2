import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRgba, createAmplifiedDiff, parseArgs } from './compare-screenshots.mjs';

test('identical pixels produce zero-distance metrics', () => {
  const pixels = Uint8Array.from([
    0, 10, 20, 255,
    200, 150, 100, 64,
  ]);
  const result = compareRgba(pixels, pixels, 2, 1, { threshold: 0 });
  assert.equal(result.normalizedRmse, 0);
  assert.equal(result.mae, 0);
  assert.equal(result.normalizedMae, 0);
  assert.equal(result.averageRgbDelta, 0);
  assert.equal(result.changedPixelFraction, 0);
  assert.equal(result.histogramDistance, 0);
});

test('metrics and changed-pixel threshold have deterministic definitions', () => {
  const baseline = Uint8Array.from([
    0, 0, 0, 255,
    10, 20, 30, 255,
  ]);
  const candidate = Uint8Array.from([
    0, 0, 0, 0,
    20, 10, 30, 0,
  ]);
  const result = compareRgba(baseline, candidate, 2, 1, { threshold: 9 });

  assert.ok(Math.abs(result.normalizedRmse - (Math.sqrt(200 / 6) / 255)) < 1e-15);
  assert.ok(Math.abs(result.mae - (20 / 6)) < 1e-15);
  assert.ok(Math.abs(result.normalizedMae - (20 / 6 / 255)) < 1e-15);
  assert.ok(Math.abs(result.averageRgbDelta - (Math.sqrt(200) / 2)) < 1e-15);
  assert.equal(result.changedPixels, 1);
  assert.equal(result.changedPixelFraction, 0.5);
  assert.ok(Math.abs(result.histogramDistance - (1 / 3)) < 1e-15);

  const atBoundary = compareRgba(baseline, candidate, 2, 1, { threshold: 10 });
  assert.equal(atBoundary.changedPixels, 0, 'threshold is strictly greater-than');
});

test('amplified diff encodes absolute RGB differences with opaque alpha', () => {
  const baseline = Uint8Array.from([10, 20, 30, 1]);
  const candidate = Uint8Array.from([20, 10, 100, 2]);
  const diff = createAmplifiedDiff(baseline, candidate, 1, 1, 3);
  assert.deepEqual([...diff.data], [30, 30, 210, 255]);
});

test('argument parsing validates comparison controls', () => {
  assert.deepEqual(
    parseArgs(['--threshold=12', '--amplify', '6', '--max-rmse', '0.1', '--diff', 'out.png', 'a.png', 'b.png']),
    {
      threshold: 12,
      amplify: 6,
      diffPath: 'out.png',
      maxRmse: 0.1,
      json: false,
      paths: ['a.png', 'b.png'],
    },
  );
  assert.throws(() => parseArgs(['--threshold', '256', 'a.png', 'b.png']), /between 0 and 255/);
  assert.throws(() => parseArgs(['a.png']), /exactly two/);
});
