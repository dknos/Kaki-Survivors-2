import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AVATARS, HERO } from '../../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNTIME_DIR = path.join(ROOT, 'assets/breakroom/runtime-avatars');
const REPORT_PATH = path.join(RUNTIME_DIR, 'AVATAR_OPTIMIZATION.json');

function glbJson(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', `${file} is not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.toString('ascii', 16, 20), 'JSON', `${file} has no JSON chunk`);
  return JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trim());
}

function triangleCount(file) {
  const json = glbJson(file);
  let triangles = 0;
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const accessor = primitive.indices ?? primitive.attributes?.POSITION;
      const count = json.accessors?.[accessor]?.count || 0;
      const mode = primitive.mode ?? 4;
      triangles += mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
    }
  }
  return triangles;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('every selectable hero resolves to a bounded runtime avatar asset', () => {
  const configured = [HERO.glb, ...AVATARS.filter((avatar) => avatar.glb).map((avatar) => avatar.glb)];
  assert.equal(configured.length, 13);
  assert.equal(new Set(configured).size, configured.length);

  let totalTriangles = 0;
  let totalBytes = 0;
  for (const relative of configured) {
    assert.match(relative, /^runtime-avatars\/[a-z0-9-]+\.glb$/);
    const file = path.join(ROOT, 'assets/breakroom', relative);
    assert.ok(fs.existsSync(file), `missing runtime avatar ${relative}`);
    const triangles = triangleCount(file);
    const bytes = fs.statSync(file).size;
    assert.ok(triangles > 0 && triangles <= 48_000, `${relative} has ${triangles} triangles`);
    assert.ok(bytes < 1_000_000, `${relative} is ${(bytes / 1_000_000).toFixed(2)} MB`);
    totalTriangles += triangles;
    totalBytes += bytes;
  }
  assert.ok(totalTriangles <= 520_000, `runtime roster has ${totalTriangles} triangles`);
  assert.ok(totalBytes <= 7_200_000, `runtime roster is ${totalBytes} bytes`);
});

test('runtime avatar report matches checked-in sources and generated outputs', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generator, 'tools/optimize-runtime-avatars.py');
  assert.equal(report.assets.length, 13);

  for (const entry of report.assets) {
    const source = path.join(ROOT, entry.source);
    const output = path.join(ROOT, entry.output);
    assert.ok(fs.existsSync(source), `missing authored source ${entry.source}`);
    assert.ok(fs.existsSync(output), `missing generated output ${entry.output}`);
    assert.equal(sha256(source), entry.sourceSha256, `${entry.source} source hash drifted`);
    assert.equal(sha256(output), entry.outputSha256, `${entry.output} output hash drifted`);
    assert.equal(triangleCount(output), entry.runtimeTriangles);
    assert.ok(entry.runtimeTriangles <= entry.targetTriangles);
  }
});
