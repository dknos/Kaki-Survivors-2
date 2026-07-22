#!/usr/bin/env node
/**
 * Compare two same-size PNG screenshots without browser or native dependencies.
 * RGB is compared in sRGB byte space; alpha is intentionally ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const MAX_RGB_DELTA = Math.sqrt(3 * 255 * 255);

function usage(stream = process.stdout) {
  stream.write(`Usage: node tools/webgpu/compare-screenshots.mjs [options] <baseline.png> <candidate.png>

Compare two same-size PNGs in 8-bit sRGB space. Alpha is ignored.

Options:
  --threshold <0..255>  A pixel is changed when any RGB channel differs by
                        more than this many byte values (default: 8).
  --diff <path>         Write an amplified absolute RGB-difference PNG.
  --amplify <number>    Difference-image multiplier (default: 4).
  --max-rmse <0..1>     Exit 1 when normalized RMSE exceeds this limit.
  --json                 Print machine-readable JSON.
  -h, --help             Print this help.

Exit status is 0 for a valid comparison, 1 only when --max-rmse is exceeded,
and 2 for invalid arguments, unreadable PNGs, or mismatched dimensions.
`);
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function finiteNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${option} must be a finite number`);
  return parsed;
}

export function parseArgs(argv) {
  const config = {
    threshold: 8,
    amplify: 4,
    diffPath: '',
    maxRmse: null,
    json: false,
    paths: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...config, help: true };
    if (arg === '--json') config.json = true;
    else if (arg === '--threshold') config.threshold = finiteNumber(optionValue(argv, i++, arg), arg);
    else if (arg.startsWith('--threshold=')) config.threshold = finiteNumber(arg.slice(12), '--threshold');
    else if (arg === '--diff') config.diffPath = optionValue(argv, i++, arg);
    else if (arg.startsWith('--diff=')) config.diffPath = arg.slice(7);
    else if (arg === '--amplify') config.amplify = finiteNumber(optionValue(argv, i++, arg), arg);
    else if (arg.startsWith('--amplify=')) config.amplify = finiteNumber(arg.slice(10), '--amplify');
    else if (arg === '--max-rmse') config.maxRmse = finiteNumber(optionValue(argv, i++, arg), arg);
    else if (arg.startsWith('--max-rmse=')) config.maxRmse = finiteNumber(arg.slice(11), '--max-rmse');
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else config.paths.push(arg);
  }

  if (config.paths.length !== 2) throw new Error('Expected exactly two PNG paths');
  if (config.threshold < 0 || config.threshold > 255) throw new Error('--threshold must be between 0 and 255');
  if (config.amplify <= 0) throw new Error('--amplify must be greater than 0');
  if (config.maxRmse != null && (config.maxRmse < 0 || config.maxRmse > 1)) {
    throw new Error('--max-rmse must be between 0 and 1');
  }
  if (config.diffPath === '') config.diffPath = null;
  return config;
}

function assertPixelData(data, width, height, label) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`${label} dimensions must be positive integers`);
  }
  const expectedLength = width * height * 4;
  if (!data || data.length !== expectedLength) {
    throw new Error(`${label} pixel data has ${data?.length ?? 0} bytes; expected ${expectedLength}`);
  }
}

/**
 * Return spatial and histogram metrics for two equal-size RGBA byte arrays.
 * A changed pixel uses max(abs(R), abs(G), abs(B)) > threshold.
 */
export function compareRgba(baseline, candidate, width, height, { threshold = 8 } = {}) {
  assertPixelData(baseline, width, height, 'Baseline');
  assertPixelData(candidate, width, height, 'Candidate');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new Error('threshold must be between 0 and 255');
  }

  const pixels = width * height;
  const histogramBaseline = Array.from({ length: 3 }, () => new Uint32Array(256));
  const histogramCandidate = Array.from({ length: 3 }, () => new Uint32Array(256));
  let squaredError = 0;
  let absoluteError = 0;
  let rgbDelta = 0;
  let changedPixels = 0;

  for (let offset = 0; offset < baseline.length; offset += 4) {
    let pixelSquaredError = 0;
    let maxChannelDelta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const a = baseline[offset + channel];
      const b = candidate[offset + channel];
      const delta = Math.abs(a - b);
      absoluteError += delta;
      squaredError += delta * delta;
      pixelSquaredError += delta * delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      histogramBaseline[channel][a]++;
      histogramCandidate[channel][b]++;
    }
    rgbDelta += Math.sqrt(pixelSquaredError);
    if (maxChannelDelta > threshold) changedPixels++;
  }

  // Average the total-variation distance of the R, G, and B histograms.
  let histogramAbsoluteDifference = 0;
  for (let channel = 0; channel < 3; channel++) {
    for (let value = 0; value < 256; value++) {
      histogramAbsoluteDifference += Math.abs(
        histogramBaseline[channel][value] - histogramCandidate[channel][value],
      );
    }
  }

  const channelSamples = pixels * 3;
  const mae = absoluteError / channelSamples;
  const averageRgbDelta = rgbDelta / pixels;
  return {
    width,
    height,
    pixels,
    threshold,
    normalizedRmse: Math.sqrt(squaredError / channelSamples) / 255,
    mae,
    normalizedMae: mae / 255,
    averageRgbDelta,
    normalizedAverageRgbDelta: averageRgbDelta / MAX_RGB_DELTA,
    changedPixels,
    changedPixelFraction: changedPixels / pixels,
    histogramDistance: histogramAbsoluteDifference / (pixels * 6),
  };
}

export function createAmplifiedDiff(baseline, candidate, width, height, amplify = 4) {
  assertPixelData(baseline, width, height, 'Baseline');
  assertPixelData(candidate, width, height, 'Candidate');
  if (!Number.isFinite(amplify) || amplify <= 0) throw new Error('amplify must be greater than 0');

  const diff = new PNG({ width, height });
  for (let offset = 0; offset < baseline.length; offset += 4) {
    diff.data[offset] = Math.min(255, Math.round(Math.abs(baseline[offset] - candidate[offset]) * amplify));
    diff.data[offset + 1] = Math.min(255, Math.round(Math.abs(baseline[offset + 1] - candidate[offset + 1]) * amplify));
    diff.data[offset + 2] = Math.min(255, Math.round(Math.abs(baseline[offset + 2] - candidate[offset + 2]) * amplify));
    diff.data[offset + 3] = 255;
  }
  return diff;
}

function readPng(filePath, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Cannot read ${label} PNG ${filePath}: ${error.message}`);
  }
  try {
    return PNG.sync.read(bytes);
  } catch (error) {
    throw new Error(`Cannot decode ${label} PNG ${filePath}: ${error.message}`);
  }
}

function metricLine(label, value, detail = '') {
  return `${label.padEnd(29)} ${value}${detail ? ` ${detail}` : ''}`;
}

function humanReport(result) {
  const percent = (value) => `${(value * 100).toFixed(4)}%`;
  return [
    `Compared ${result.width}x${result.height} (${result.pixels.toLocaleString('en-US')} pixels)`,
    metricLine('Normalized RMSE:', result.normalizedRmse.toFixed(8)),
    metricLine('MAE per RGB channel:', result.mae.toFixed(4), '(0..255)'),
    metricLine('Normalized MAE:', result.normalizedMae.toFixed(8)),
    metricLine('Average RGB delta:', result.averageRgbDelta.toFixed(4), `(0..${MAX_RGB_DELTA.toFixed(4)})`),
    metricLine('Normalized average RGB delta:', result.normalizedAverageRgbDelta.toFixed(8)),
    metricLine('Changed-pixel fraction:', percent(result.changedPixelFraction), `(${result.changedPixels.toLocaleString('en-US')}; threshold > ${result.threshold})`),
    metricLine('Histogram distance:', result.histogramDistance.toFixed(8), '(average RGB total variation)'),
    ...(result.diffPath ? [`Diff PNG: ${result.diffPath} (${result.amplify}x)`] : []),
  ].join('\n');
}

export function comparePngFiles(baselinePath, candidatePath, options = {}) {
  const baseline = readPng(baselinePath, 'baseline');
  const candidate = readPng(candidatePath, 'candidate');
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    throw new Error(
      `PNG dimensions differ: baseline is ${baseline.width}x${baseline.height}, `
      + `candidate is ${candidate.width}x${candidate.height}`,
    );
  }

  const result = compareRgba(
    baseline.data,
    candidate.data,
    baseline.width,
    baseline.height,
    options,
  );

  if (options.diffPath) {
    const amplify = options.amplify ?? 4;
    const resolvedDiffPath = path.resolve(options.diffPath);
    fs.mkdirSync(path.dirname(resolvedDiffPath), { recursive: true });
    const diff = createAmplifiedDiff(
      baseline.data,
      candidate.data,
      baseline.width,
      baseline.height,
      amplify,
    );
    fs.writeFileSync(resolvedDiffPath, PNG.sync.write(diff));
    result.diffPath = resolvedDiffPath;
    result.amplify = amplify;
  }
  return result;
}

async function main() {
  try {
    const config = parseArgs(process.argv.slice(2));
    if (config.help) {
      usage();
      return;
    }
    const baselinePath = path.resolve(config.paths[0]);
    const candidatePath = path.resolve(config.paths[1]);
    const result = comparePngFiles(baselinePath, candidatePath, config);
    const report = {
      baseline: baselinePath,
      candidate: candidatePath,
      ...result,
    };
    process.stdout.write(`${config.json ? JSON.stringify(report, null, 2) : humanReport(report)}\n`);
    if (config.maxRmse != null && result.normalizedRmse > config.maxRmse) {
      process.stderr.write(
        `Normalized RMSE ${result.normalizedRmse.toFixed(8)} exceeds --max-rmse ${config.maxRmse}.\n`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`compare-screenshots: ${error.message}\n`);
    process.stderr.write('Run with --help for usage.\n');
    process.exitCode = 2;
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) await main();
