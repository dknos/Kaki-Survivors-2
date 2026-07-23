#!/usr/bin/env node
/** Validate v2 frame bounds, coverage, and non-trivial locomotion silhouettes. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NORMALIZED_SIZE = 64;
const ALPHA_THRESHOLD = 72;
const MIN_ADJACENT_DIFFERENCE = 0.006;
const MIN_MEAN_DIFFERENCE = 0.018;
const EXPECTED_SPECIES = Object.freeze([
  'ant', 'beetle', 'ladybug', 'grasshopper', 'cockroach', 'mantis',
  'wasp', 'bee', 'butterfly', 'caterpillar', 'spider',
]);
const GROUNDED_SPECIES = new Set([
  'ant', 'beetle', 'ladybug', 'grasshopper', 'cockroach', 'mantis',
  'caterpillar', 'spider',
]);
const MEDIAN_LUMINANCE_LIMITS = Object.freeze({
  ant: [45, 110],
  beetle: [52, 150],
  cockroach: [42, 160],
  spider: [42, 150],
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function frameAlphaPoints(png, page, frameIndex, alphaThreshold = ALPHA_THRESHOLD) {
  const col = frameIndex % page.cols;
  const row = Math.floor(frameIndex / page.cols);
  const startX = col * page.frameWidth;
  const startY = row * page.frameHeight;
  const points = [];
  for (let y = 0; y < page.frameHeight; y++) {
    for (let x = 0; x < page.frameWidth; x++) {
      const offset = ((startY + y) * png.width + startX + x) * 4;
      if (png.data[offset + 3] >= alphaThreshold) points.push([x, y]);
    }
  }
  return points;
}

function frameVisualMetrics(png, page, frameIndex) {
  const col = frameIndex % page.cols;
  const row = Math.floor(frameIndex / page.cols);
  const startX = col * page.frameWidth;
  const startY = row * page.frameHeight;
  const luminance = [];
  let bottom = -1;
  for (let y = 0; y < page.frameHeight; y++) {
    for (let x = 0; x < page.frameWidth; x++) {
      const offset = ((startY + y) * png.width + startX + x) * 4;
      if (png.data[offset + 3] < 128) continue;
      luminance.push(
        png.data[offset] * 0.2126
        + png.data[offset + 1] * 0.7152
        + png.data[offset + 2] * 0.0722,
      );
      bottom = Math.max(bottom, y);
    }
  }
  luminance.sort((a, b) => a - b);
  return {
    bottom,
    medianLuminance: luminance.length
      ? luminance[Math.floor((luminance.length - 1) * 0.5)]
      : 0,
  };
}

function frameFacingMetrics(png, page, frameIndex) {
  const col = frameIndex % page.cols;
  const row = Math.floor(frameIndex / page.cols);
  const startX = col * page.frameWidth;
  const startY = row * page.frameHeight;
  let opaqueCount = 0;
  let opaqueX = 0;
  let opaqueY = 0;
  let markerCount = 0;
  let markerX = 0;
  let markerY = 0;
  for (let y = 0; y < page.frameHeight; y++) {
    for (let x = 0; x < page.frameWidth; x++) {
      const offset = ((startY + y) * png.width + startX + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      if (png.data[offset + 3] < 128) continue;
      opaqueCount++;
      opaqueX += x;
      opaqueY += y;
      // Spider's authored saturated-red eyes/face plate provide an objective
      // forward marker after the baker's restrained color grade.
      if (red > 70 && red > green * 1.75 && red > blue * 1.45) {
        markerCount++;
        markerX += x;
        markerY += y;
      }
    }
  }
  assert(opaqueCount > 0 && markerCount >= 8,
    `Frame ${frameIndex}: missing opaque body or Spider face marker`);
  const body = [opaqueX / opaqueCount, opaqueY / opaqueCount];
  const marker = [markerX / markerCount, markerY / markerCount];
  return {
    frame: frameIndex,
    markerPixels: markerCount,
    body: body.map((value) => Number(value.toFixed(3))),
    marker: marker.map((value) => Number(value.toFixed(3))),
    delta: [
      Number((marker[0] - body[0]).toFixed(3)),
      Number((marker[1] - body[1]).toFixed(3)),
    ],
  };
}

/**
 * Canonicalize translation, whole-sprite rotation, and independent X/Y scale.
 * A generic root bob/lean/squash therefore produces ~zero difference, while
 * changed limbs, wings, body waves, and asymmetric compression remain visible.
 */
export function normalizeSilhouette(points, size = NORMALIZED_SIZE) {
  assert(points.length >= 8, `Silhouette has only ${points.length} opaque samples`);
  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of points) { meanX += x; meanY += y; }
  meanX /= points.length;
  meanY /= points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  // Principal-axis alignment removes whole-model lean/rotation.
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const cosine = Math.cos(-angle);
  const sine = Math.sin(-angle);
  const rotated = new Float32Array(points.length * 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < points.length; index++) {
    const dx = points[index][0] - meanX;
    const dy = points[index][1] - meanY;
    const x = dx * cosine - dy * sine;
    const y = dx * sine + dy * cosine;
    rotated[index * 2] = x;
    rotated[index * 2 + 1] = y;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const rangeX = Math.max(1e-6, maxX - minX);
  const rangeY = Math.max(1e-6, maxY - minY);
  const mask = new Uint8Array(size * size);
  const inset = 2;
  const span = size - inset * 2 - 1;
  for (let index = 0; index < points.length; index++) {
    const x = inset + Math.round(((rotated[index * 2] - minX) / rangeX) * span);
    const y = inset + Math.round(((rotated[index * 2 + 1] - minY) / rangeY) * span);
    mask[y * size + x] = 1;
    // Closing a single raster gap makes the metric insensitive to whether a
    // downsampled edge landed just left/right of a normalized pixel center.
    if (x + 1 < size) mask[y * size + x + 1] = 1;
    if (y + 1 < size) mask[(y + 1) * size + x] = 1;
  }
  return mask;
}

export function silhouetteDifference(a, b) {
  assert(a.length === b.length, 'Normalized silhouette sizes differ');
  let union = 0;
  let xor = 0;
  for (let index = 0; index < a.length; index++) {
    if (a[index] || b[index]) union++;
    if (a[index] !== b[index]) xor++;
  }
  return union > 0 ? xor / union : 0;
}

function parseArgs(argv) {
  const config = {
    manifest: path.join(ROOT, 'assets/sprites/forest_enemies_v2.json'),
    report: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--manifest') config.manifest = path.resolve(ROOT, argv[++index]);
    else if (arg === '--report') config.report = path.resolve(ROOT, argv[++index]);
    else if (arg === '--help') {
      console.log('Usage: node tools/enemy-sprite-bake/validate-silhouettes.mjs [--manifest file] [--report file]');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return config;
}

function loadPages(manifestPath, manifest) {
  const directory = path.dirname(manifestPath);
  return manifest.pages.map((page) => {
    const imagePath = path.resolve(directory, page.image);
    assert(fs.existsSync(imagePath), `Missing atlas page ${page.image}`);
    const png = PNG.sync.read(fs.readFileSync(imagePath));
    assert(png.width === page.cols * page.frameWidth,
      `${page.image}: width ${png.width} != ${page.cols}*${page.frameWidth}`);
    assert(png.height === page.rows * page.frameHeight,
      `${page.image}: height ${png.height} != ${page.rows}*${page.frameHeight}`);
    assert(page.frameCount <= page.cols * page.rows, `${page.image}: frameCount exceeds grid`);
    return { ...page, png, imagePath };
  });
}

function pageById(pages, id) {
  const page = pages.find((entry) => entry.id === id);
  assert(page, `Unknown atlas page id ${id}`);
  return page;
}

export function validateForestManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest.version === 2, `Expected v2 manifest, got ${manifest.version}`);
  assert(Array.isArray(manifest.pages) && manifest.pages.length >= 1 && manifest.pages.length <= 2,
    'v2 requires one or two atlas pages');
  assert(Array.isArray(manifest.species)
    && manifest.species.length === EXPECTED_SPECIES.length
    && manifest.species.every((species, index) => species.name === EXPECTED_SPECIES[index] && species.id === index),
  `Expected dense Forest roster ${EXPECTED_SPECIES.join(', ')}`);
  assert(manifest.directionCount >= 4, 'At least four effective directions are required');
  assert(manifest.framePadding?.gutterPixels >= 2, 'At least two gutter pixels are required');
  assert(manifest.texture?.magFilter === 'linear', 'Rendered sprites require linear magnification');
  assert(manifest.texture?.generateMipmaps === true, 'Rendered sprites require mipmaps');
  assert(manifest.memoryEstimate?.colorBytesWithMipmaps <= 32 * 1024 * 1024,
    `Atlas color memory exceeds 32 MiB (${manifest.memoryEstimate?.colorBytesWithMipmaps})`);

  const pages = loadPages(manifestPath, manifest);
  const speciesReport = [];
  for (const species of manifest.species) {
    assert(Number.isInteger(species.id), `${species.name}: missing numeric id`);
    assert(Number.isInteger(species.fallbackState), `${species.name}: missing fallback state`);
    const move = species.states?.find((state) => state.id === 0 && state.name === 'move');
    const attack = species.states?.find((state) => state.id === 1 && state.name === 'attack');
    const death = species.states?.find((state) => state.id === 2 && state.name === 'death');
    assert(move && attack && death, `${species.name}: move/attack/death states are required`);
    assert(move.loop === true && attack.loop === false && death.loop === false,
      `${species.name}: state loop flags are invalid`);
    assert(death.completion === 'release', `${species.name}: death must release its slot`);
    assert(move.directions.length >= 4, `${species.name}: move has fewer than four directions`);

    for (const state of species.states) {
      for (const direction of state.directions) {
        const page = pageById(pages, direction.page);
        assert(direction.from >= 0 && direction.to >= direction.from && direction.to < page.frameCount,
          `${species.name}/${state.name}/dir${direction.id}: range out of bounds`);
        for (let frame = direction.from; frame <= direction.to; frame++) {
          const alpha = frameAlphaPoints(page.png, page, frame);
          assert(alpha.length >= 12, `${species.name}/${state.name}/dir${direction.id}/frame${frame}: empty frame`);
        }
      }
    }

    let facingEvidence = null;
    if (species.name === 'spider') {
      const byId = new Map(move.directions.map((direction) => [direction.id, direction]));
      const toward = byId.get(0);
      const right = byId.get(1);
      const away = byId.get(2);
      const left = byId.get(3);
      assert(toward && right && away && left, 'spider: all four directions are required');
      assert(left.mirror === true && left.sourceDirection === right.id,
        'spider: left must mirror the validated right-facing frames');
      const towardMetrics = frameFacingMetrics(
        pageById(pages, toward.page).png,
        pageById(pages, toward.page),
        toward.from,
      );
      const rightMetrics = frameFacingMetrics(
        pageById(pages, right.page).png,
        pageById(pages, right.page),
        right.from,
      );
      const awayMetrics = frameFacingMetrics(
        pageById(pages, away.page).png,
        pageById(pages, away.page),
        away.from,
      );
      const facingMargin = pageById(pages, right.page).frameWidth * 0.06;
      assert(towardMetrics.delta[1] > facingMargin,
        `spider/toward: face marker is not camera-near (${towardMetrics.delta[1]})`);
      assert(rightMetrics.delta[0] > facingMargin,
        `spider/right: face marker is not screen-right (${rightMetrics.delta[0]})`);
      assert(awayMetrics.delta[1] < -facingMargin,
        `spider/away: face marker is not camera-far (${awayMetrics.delta[1]})`);
      facingEvidence = {
        method: 'authored red face marker relative to opaque-body centroid',
        toward: towardMetrics,
        right: rightMetrics,
        away: awayMetrics,
        left: { mirroredFrom: right.id },
      };
    }

    const directions = [];
    for (const direction of move.directions.filter((entry) => !entry.mirror)) {
      const page = pageById(pages, direction.page);
      const masks = [];
      const visualMetrics = [];
      for (let frame = direction.from; frame <= direction.to; frame++) {
        masks.push(normalizeSilhouette(frameAlphaPoints(page.png, page, frame)));
        visualMetrics.push(frameVisualMetrics(page.png, page, frame));
      }
      if (GROUNDED_SPECIES.has(species.name)) {
        const expectedBottom = page.frameHeight - manifest.framePadding.gutterPixels - 2;
        assert(Math.abs(visualMetrics[0].bottom - expectedBottom) <= 2,
          `${species.name}/dir${direction.id}: grounded baseline ends at ${visualMetrics[0].bottom}, expected ${expectedBottom}`);
      }
      const luminanceLimit = MEDIAN_LUMINANCE_LIMITS[species.name];
      if (luminanceLimit) {
        const median = visualMetrics[0].medianLuminance;
        assert(median >= luminanceLimit[0] && median <= luminanceLimit[1],
          `${species.name}/dir${direction.id}: median luminance ${median.toFixed(1)} outside ${luminanceLimit.join('-')}`);
      }
      const adjacent = [];
      for (let index = 0; index < masks.length; index++) {
        adjacent.push(silhouetteDifference(masks[index], masks[(index + 1) % masks.length]));
      }
      const minimum = Math.min(...adjacent);
      const mean = adjacent.reduce((sum, value) => sum + value, 0) / adjacent.length;
      assert(minimum >= MIN_ADJACENT_DIFFERENCE,
        `${species.name}/dir${direction.id}: adjacent silhouette difference ${minimum.toFixed(4)} is effectively static`);
      assert(mean >= MIN_MEAN_DIFFERENCE,
        `${species.name}/dir${direction.id}: mean silhouette difference ${mean.toFixed(4)} is too weak`);
      directions.push({
        id: direction.id,
        adjacentDifferences: adjacent.map((value) => Number(value.toFixed(6))),
        minimum: Number(minimum.toFixed(6)),
        mean: Number(mean.toFixed(6)),
        baselineBottom: visualMetrics[0].bottom,
        medianLuminance: Number(visualMetrics[0].medianLuminance.toFixed(2)),
      });
    }
    speciesReport.push({
      species: species.name,
      authoring: species.authoring,
      directions,
      ...(facingEvidence ? { facingEvidence } : {}),
    });
  }
  return {
    schemaVersion: 1,
    manifest: path.relative(ROOT, manifestPath).replaceAll(path.sep, '/'),
    thresholds: {
      alpha: ALPHA_THRESHOLD,
      minimumAdjacentDifference: MIN_ADJACENT_DIFFERENCE,
      minimumMeanDifference: MIN_MEAN_DIFFERENCE,
      normalization: 'translation + principal-axis rotation + independent X/Y scale',
    },
    pages: pages.map((page) => ({
      id: page.id,
      image: page.image,
      width: page.png.width,
      height: page.png.height,
      frameCount: page.frameCount,
    })),
    species: speciesReport,
    pass: true,
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const report = validateForestManifest(config.manifest);
  if (config.report) {
    fs.mkdirSync(path.dirname(config.report), { recursive: true });
    fs.writeFileSync(config.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`PASS: ${report.species.length} species, ${report.pages.reduce((sum, page) => sum + page.frameCount, 0)} frames`);
  for (const species of report.species) {
    const minimum = Math.min(...species.directions.map((entry) => entry.minimum));
    const mean = species.directions.reduce((sum, entry) => sum + entry.mean, 0) / species.directions.length;
    console.log(`${species.species.padEnd(12)} min=${minimum.toFixed(4)} mean=${mean.toFixed(4)} ${species.authoring}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`FAIL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
