import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RALLY_ASSET_MANIFEST,
  RALLY_COURSE_ASSETS,
  TRIALS_COURSE_ASSETS,
  rallyAssetIds,
  trialsAssetIds,
} from '../src/racing/racingManifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RUNTIME_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RUNTIME_TOTAL_BYTES = 20 * 1024 * 1024;
// Repository archive includes both Monster Smash and Catastrophe authored GLBs.
// Runtime working-set limits below remain mode-scoped at 20 MiB.
const MAX_MANIFEST_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_EDGE = 4096;

const failures = [];
let assertions = 0;

function expect(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

async function check(name, callback) {
  try {
    await callback();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertLocalUrl(id, url) {
  expect(typeof url === 'string' && url.length > 0, `${id} has an empty URL`);
  expect(!/^[a-z][a-z\d+.-]*:/i.test(url), `${id} uses a network or scheme URL: ${url}`);
  expect(!url.startsWith('//'), `${id} uses a protocol-relative URL: ${url}`);
  expect(!path.isAbsolute(url) && !url.startsWith('/') && !url.startsWith('\\'), `${id} uses an absolute URL: ${url}`);
  expect(!url.includes('\\'), `${id} must use browser-safe forward slashes: ${url}`);
  expect(!/(^|\/)\.\.(\/|$)/.test(url), `${id} escapes the repository root: ${url}`);
  expect(!/[?#]/.test(url), `${id} should not hide cache/query state in the manifest: ${url}`);
  const resolved = path.resolve(REPO_ROOT, ...url.split('/'));
  expect(isContained(REPO_ROOT, resolved), `${id} resolves outside the repository: ${resolved}`);
  return resolved;
}

function parsePng(buffer, label) {
  expect(buffer.length >= 24, `${label} is too small to be a PNG`);
  expect(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label} has an invalid PNG signature`);
  expect(buffer.toString('ascii', 12, 16) === 'IHDR', `${label} is missing PNG IHDR`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
}

function parseJpeg(buffer, label) {
  expect(buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8, `${label} has an invalid JPEG signature`);
  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        format: 'jpeg',
      };
    }
    offset += segmentLength;
  }
  throw new Error(`${label} has no readable JPEG size frame`);
}

function parseWebp(buffer, label) {
  expect(buffer.length >= 30, `${label} is too small to be a WebP image`);
  expect(buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP', `${label} has an invalid WebP signature`);
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
      format: 'webp',
    };
  }
  if (chunk === 'VP8L') {
    expect(buffer[20] === 0x2f, `${label} has an invalid VP8L signature`);
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      format: 'webp',
    };
  }
  if (chunk === 'VP8 ') {
    const signature = Buffer.from([0x9d, 0x01, 0x2a]);
    const frame = buffer.indexOf(signature, 20);
    expect(frame >= 0 && frame + 7 <= buffer.length, `${label} has no readable VP8 frame header`);
    return {
      width: buffer.readUInt16LE(frame + 3) & 0x3fff,
      height: buffer.readUInt16LE(frame + 5) & 0x3fff,
      format: 'webp',
    };
  }
  throw new Error(`${label} uses unsupported WebP chunk ${JSON.stringify(chunk)}`);
}

function parseImage(buffer, url) {
  const extension = path.extname(url).toLowerCase();
  if (extension === '.png') return parsePng(buffer, url);
  if (extension === '.jpg' || extension === '.jpeg') return parseJpeg(buffer, url);
  if (extension === '.webp') return parseWebp(buffer, url);
  throw new Error(`${url} has an unsupported runtime image extension`);
}

function parseModel(buffer, url) {
  expect(path.extname(url).toLowerCase() === '.glb', `${url} must be a binary glTF`);
  expect(buffer.length >= 20, `${url} is too small to be a GLB`);
  expect(buffer.toString('ascii', 0, 4) === 'glTF', `${url} has an invalid GLB signature`);
  expect(buffer.readUInt32LE(4) === 2, `${url} is not glTF 2.0`);
  expect(buffer.readUInt32LE(8) === buffer.length, `${url} GLB length header does not match its file size`);
  return { format: 'glb' };
}

function validateDimensions(info, label) {
  expect(Number.isInteger(info.width) && info.width > 0, `${label} has invalid width ${info.width}`);
  expect(Number.isInteger(info.height) && info.height > 0, `${label} has invalid height ${info.height}`);
  expect(info.width <= MAX_IMAGE_EDGE && info.height <= MAX_IMAGE_EDGE, `${label} exceeds ${MAX_IMAGE_EDGE}px runtime edge budget (${info.width}x${info.height})`);
}

console.log('Kaki Rally local asset validation');

const runtimeInfo = new Map();
let runtimeTotalBytes = 0;

await check('manifest URLs are local, unique, present, decodable, and budgeted', async () => {
  const seenUrls = new Map();
  for (const [id, spec] of Object.entries(RALLY_ASSET_MANIFEST)) {
    expect(spec && typeof spec === 'object', `${id} has no manifest specification`);
    const resolved = assertLocalUrl(id, spec.url);
    const normalized = spec.url.toLowerCase();
    expect(!seenUrls.has(normalized), `${id} duplicates ${seenUrls.get(normalized)} at ${spec.url}`);
    seenUrls.set(normalized, id);

    const fileStat = await stat(resolved);
    expect(fileStat.isFile(), `${id} does not resolve to a file: ${spec.url}`);
    expect(fileStat.size > 0, `${id} is empty: ${spec.url}`);
    expect(fileStat.size <= MAX_RUNTIME_FILE_BYTES, `${id} exceeds the ${MAX_RUNTIME_FILE_BYTES} byte per-file runtime budget`);
    runtimeTotalBytes += fileStat.size;

    const buffer = await readFile(resolved);
    const asset = spec.kind === 'model' ? parseModel(buffer, spec.url) : parseImage(buffer, spec.url);
    if (spec.kind !== 'model') validateDimensions(asset, id);
    runtimeInfo.set(id, { ...asset, bytes: fileStat.size, url: spec.url });
  }
  expect(runtimeTotalBytes <= MAX_MANIFEST_TOTAL_BYTES, `manifest archive total ${runtimeTotalBytes} bytes exceeds ${MAX_MANIFEST_TOTAL_BYTES} byte repository budget`);
  const workingSets = [];
  for (const courseId of Object.keys(RALLY_COURSE_ASSETS)) {
    for (const mode of ['circuit', 'monster', 'crash']) {
      if (mode === 'monster') {
        for (const vehicle of ['meowster', 'cyber', 'tipsy']) {
          workingSets.push([`${mode}/${courseId}/${vehicle}`, rallyAssetIds(courseId, mode, vehicle)]);
        }
      } else {
        workingSets.push([`${mode}/${courseId}`, rallyAssetIds(courseId, mode)]);
      }
    }
  }
  for (const courseId of Object.keys(TRIALS_COURSE_ASSETS)) workingSets.push([`trials/${courseId}`, trialsAssetIds(courseId)]);
  for (const [label, ids] of workingSets) {
    const bytes = [...new Set(ids)].reduce((sum, id) => sum + (runtimeInfo.get(id)?.bytes || 0), 0);
    expect(bytes <= MAX_RUNTIME_TOTAL_BYTES, `${label} working set ${bytes} bytes exceeds ${MAX_RUNTIME_TOTAL_BYTES} byte runtime budget`);
  }
});

await check('course mappings reference only defined manifest entries', async () => {
  for (const [family, mapping] of [['rally', RALLY_COURSE_ASSETS], ['trials', TRIALS_COURSE_ASSETS]]) {
    for (const [courseId, ids] of Object.entries(mapping)) {
      expect(Array.isArray(ids) && ids.length > 0, `${family}/${courseId} has no assets`);
      expect(new Set(ids).size === ids.length, `${family}/${courseId} repeats a manifest id`);
      for (const id of ids) expect(RALLY_ASSET_MANIFEST[id], `${family}/${courseId} references undefined ${id}`);
    }
  }
});

await check('generated decal source, runtime derivative, and provenance agree', async () => {
  const sourceUrl = 'assets/source/imagegen/kaki-rally-decal-atlas-imagegen-v1.png';
  const runtimeUrl = 'assets/racing/kaki-rally-decal-atlas-imagegen-v1.webp';
  expect(RALLY_ASSET_MANIFEST.decalAtlas?.url === runtimeUrl, 'manifest decalAtlas does not select the generated runtime derivative');

  const sourcePath = assertLocalUrl('decalAtlasSource', sourceUrl);
  const sourceStat = await stat(sourcePath);
  expect(sourceStat.isFile() && sourceStat.size > 0, 'generated decal source is missing or empty');
  expect(sourceStat.size <= 12 * 1024 * 1024, 'generated decal source exceeds the 12 MiB archival budget');
  const sourceInfo = parseImage(await readFile(sourcePath), sourceUrl);
  validateDimensions(sourceInfo, 'decalAtlasSource');

  const runtime = runtimeInfo.get('decalAtlas');
  expect(runtime, 'runtime decal atlas was not validated');
  expect(runtime.width === 1024 && runtime.height === 1024, `runtime decal atlas must be 1024x1024, found ${runtime.width}x${runtime.height}`);
  expect(sourceInfo.width >= runtime.width && sourceInfo.height >= runtime.height, 'archival decal source is smaller than the runtime derivative');
  expect(runtime.bytes < sourceStat.size, 'runtime decal derivative is not smaller than its archival source');

});

if (failures.length) {
  console.error(`\nRally asset validation failed: ${failures.length} check(s), ${assertions} assertions.`);
  process.exitCode = 1;
} else {
  console.log(`\nRally asset validation passed: ${runtimeInfo.size} local assets, ${(runtimeTotalBytes / 1024 / 1024).toFixed(2)} MiB, ${assertions} assertions.`);
}
