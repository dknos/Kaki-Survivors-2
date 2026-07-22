import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(testDir, '..', '..', 'enemyTells.js');
const source = readFileSync(sourcePath, 'utf8');

test('enemy tell pools submit only their compact live prefixes', () => {
  execFileSync(process.execPath, ['--check', sourcePath], { stdio: 'pipe' });

  assert.match(source, /function _commitCompactPool\(inst, used, updateColor = false\)/);
  assert.match(source, /inst\.count = used;\s*if \(used === 0\) return;/);
  assert.match(source, /if \(updateColor && inst\.instanceColor\) inst\.instanceColor\.needsUpdate = true/);

  assert.match(source, /const inst = new THREE\.InstancedMesh\(ringGeo, mat, ELITE_RING_CAP\)[\s\S]*?inst\.count = 0/);
  assert.match(source, /_rangedTells\.count = 0/);
  assert.match(source, /_threatDots\.count = 0/);
  assert.match(source, /_leapMarkers\.count = 0/);

  for (const call of [
    '_commitCompactPool(_ringsElite, eliteSlot, true)',
    '_commitCompactPool(_ringsVolatile, volSlot, true)',
    '_commitCompactPool(_ringsFrosted, frostSlot, true)',
    '_commitCompactPool(_ringsShielded, shldSlot, true)',
    '_commitCompactPool(_ringsMini, miniSlot, true)',
    '_commitCompactPool(_ringsFinal, finalSlot, true)',
    '_commitCompactPool(_rangedTells, tellSlot)',
    '_commitCompactPool(_threatDots, dotSlot, true)',
  ]) {
    assert.ok(source.includes(call), call);
  }
});

test('enemy tell hot path no longer allocates buckets or uploads hidden capacity', () => {
  const updateBody = source.match(
    /export function updateEnemyTells\([^)]*\) \{[\s\S]*?\n\}\n\n\/\/ ─+\n\/\/ Reset/,
  )?.[0] || '';
  assert.ok(updateBody, 'updateEnemyTells body');
  assert.doesNotMatch(updateBody, /familyBuckets|for \(const \[inst, used\]/);
  assert.doesNotMatch(updateBody, /for \(let i = used; i < ELITE_RING_CAP/);
  assert.doesNotMatch(updateBody, /for \(let i = tellSlot; i < RANGED_TELL_CAP/);
  assert.doesNotMatch(updateBody, /for \(let i = dotSlot; i < THREAT_DOT_CAP/);
});

test('sparse leap markers retain high-water ordering and return to zero draws', () => {
  assert.match(source, /function _leapHighWaterCount\(\)/);
  assert.match(source, /if \(_leapSlots\[i\]\.used\) return i \+ 1/);
  assert.match(source, /if \(_leapMarkers\.count <= slot\) _leapMarkers\.count = slot \+ 1/);
  assert.match(source, /const nextCount = _leapHighWaterCount\(\);\s*_leapMarkers\.count = nextCount/);
  assert.doesNotMatch(source, /_leapMarkers\.setColorAt\(slot/);

  const resetBody = source.match(/export function resetEnemyTells\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(resetBody, 'resetEnemyTells body');
  assert.match(resetBody, /_ringsElite\.count = 0/);
  assert.match(resetBody, /_ringsFinal\.count = 0/);
  assert.match(resetBody, /_rangedTells\.count = 0/);
  assert.match(resetBody, /_threatDots\.count = 0/);
  assert.match(resetBody, /_leapMarkers\.count = 0/);
  assert.doesNotMatch(resetBody, /instanceMatrix\.needsUpdate/);
});
