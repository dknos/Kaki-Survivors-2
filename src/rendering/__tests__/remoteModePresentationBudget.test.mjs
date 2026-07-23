import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('remote arena modes cap oversized buffers without blurring ordinary Monster viewports', () => {
  const bulletHell = read('src/bullethell/index.js');
  const racing = read('src/racing/index.js');

  assert.match(bulletHell, /REMOTE_ARENA_MAX_RENDER_PIXELS = 1920 \* 1080/);
  assert.match(bulletHell, /currentScale \* Math\.sqrt\(REMOTE_ARENA_MAX_RENDER_PIXELS \/ pixels\)/);
  assert.match(bulletHell, /_restoreRemoteArenaResolution\(\)/);
  assert.match(racing, /REMOTE_ARENA_MAX_RENDER_PIXELS = 1920 \* 1080/);
  assert.match(racing, /Math\.min\(currentScale, pixelCapScale\)/);
  assert.doesNotMatch(racing, /Math\.min\(currentScale, 0\.8,/);
  assert.match(racing, /setDynamicResolutionScale\(session\.savedDynamicResolutionScale \|\| 1\)/);
});

test('Monster Smash batches ramp dressing and bounds pooled target geometry', () => {
  const arena = read('src/racing/monsterArena.js');
  const destruction = read('src/racing/monsterDestruction.js');

  for (const name of [
    'arena-ramp-retaining-sides-batch',
    'arena-ramp-tire-scars-batch',
    'arena-ramp-packed-dirt-aprons-batch',
    'arena-ramp-lips-batch',
    'arena-ramp-rail-markers-batch',
    'arena-ramp-lip-markers-batch',
  ]) assert.match(arena, new RegExp(name));
  assert.doesNotMatch(arena, /const groupRamp = new THREE\.Group\(\)/);
  assert.match(destruction, /new THREE\.SphereGeometry\(0\.72, 8, 5,/);
  assert.match(destruction, /new THREE\.CapsuleGeometry\(0\.1, 1\.9, 2, 6\)/);
  assert.match(destruction, /new THREE\.TorusGeometry\(0\.28, 0\.12, 5, 8\)/);
});
