import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const bulletSource = fs.readFileSync(path.join(ROOT, 'src/bullethell/index.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('Bullet Hell applies run metadata without installing hidden stage scenery', () => {
  const restart = between('async function _restartBulletHell()', '// Bullet-hell mode entry');
  const start = between('const _startBulletHell = async () =>', 'window.kkStartBulletHell =');

  assert.match(restart, /applyMetaUpgrades\(\{ installStageScene: false \}\)/);
  assert.match(start, /applyMetaUpgrades\(\{ installStageScene: false \}\)/);
  assert.doesNotMatch(start, /preloadStage\(/);
});

test('normal Survivors entry still preloads before installing stage scenery', () => {
  const startRun = between('const _startRun = async () =>', 'window.kkStartRun =');
  const preload = startRun.indexOf('await preloadStage(_stageId)');
  const apply = startRun.indexOf('applyMetaUpgrades()');

  assert.ok(preload >= 0, 'Survivors entry must preload its selected stage');
  assert.ok(apply > preload, 'Survivors entry must install stage scenery only after preload');
  assert.match(
    source,
    /function applyMetaUpgrades\(\{ installStageScene = true \} = \{\}\)/,
  );
  assert.match(source, /if \(installStageScene && stage && state\.scene\)/);
});

test('Bullet Hell removes the overworld from rendering and restores its exact state', () => {
  assert.match(bulletSource, /_savedEnvState = envGroup \? \{/);
  assert.match(bulletSource, /if \(envGroup\) envGroup\.visible = false;/);
  assert.match(bulletSource, /saved\.group\.position\.y = saved\.y;/);
  assert.match(bulletSource, /saved\.group\.visible = saved\.visible;/);
  assert.doesNotMatch(bulletSource, /state\.envGroup\.position\.y = -200/);
});
