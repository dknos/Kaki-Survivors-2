import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canLaunchRacingMode,
  getRacingModeAvailability,
} from '../src/racing/racingModeAvailability.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const menuSource = await readFile(path.join(repoRoot, 'src/menuV2.js'), 'utf8');

assert.equal(canLaunchRacingMode('crash'), false, 'Catastrophe must not launch in the renderer migration build');
assert.equal(getRacingModeAvailability('crash').reason, 'renderer-migration');
assert.match(getRacingModeAvailability('crash').detail, /original WebGL release/i);

for (const mode of ['draw', 'circuit', 'drift', 'stock', 'monster', 'trials']) {
  assert.equal(canLaunchRacingMode(mode), true, `${mode} was accidentally deferred with Catastrophe`);
}

assert.match(
  menuSource,
  /data-mode="crash"[^>]*data-deferred-reason="\$\{crashAvailability\.reason\}"[^>]*disabled[^>]*aria-disabled="true"/,
  'Catastrophe menu choice is not visibly and semantically disabled',
);
assert.match(menuSource, /if \(!canLaunchRacingMode\(card\?\.dataset\?\.mode\)\) return;/, 'card selection lacks a deferred-mode guard');
assert.match(menuSource, /const start = \(\) => \{\s*if \(!canLaunchRacingMode\(selectedMode\)\) return;/, 'race start lacks a deferred-mode guard');

for (const relativePath of [
  'src/racing/crash/crashMode.js',
  'src/racing/crash/crashConfig.js',
  'tools/smoke-racing-crash.mjs',
  'tools/validate-kaki-catastrophe-assets.mjs',
]) {
  assert.equal(existsSync(path.join(repoRoot, relativePath)), true, `${relativePath} must remain preserved`);
}

console.log('Renderer-migration racing availability smoke passed');
