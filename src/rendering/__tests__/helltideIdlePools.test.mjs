import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/helltide.js'), 'utf8');

function functionSource(name) {
  const signature = `function ${name}(`;
  const start = SOURCE.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const paramsStart = start + signature.length - 1;
  let paramsDepth = 0;
  let paramsEnd = -1;
  for (let i = paramsStart; i < SOURCE.length; i++) {
    if (SOURCE[i] === '(') paramsDepth += 1;
    else if (SOURCE[i] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  assert.notEqual(paramsEnd, -1, `unterminated parameters for ${name}`);
  const bodyStart = SOURCE.indexOf('{', paramsEnd);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  for (let i = bodyStart; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  assert.fail(`unterminated body for ${name}`);
}

test('Helltide InstancedMesh pools are hidden when constructed empty', () => {
  const emberEnsure = functionSource('_ensureEmberInst');
  const rainEnsure = functionSource('_ensureRainInst');

  assert.match(emberEnsure, /_emberInst = new THREE\.InstancedMesh\(geo, mat, EMBER_CAP\);/);
  assert.match(emberEnsure, /_emberInst\.visible = false;/);
  assert.match(rainEnsure, /_rainInst = new THREE\.InstancedMesh\(geo, mat, EMBER_RAIN_CAP\);/);
  assert.match(rainEnsure, /_rainInst\.visible = false;/);
});

test('authoritative live counters show on first spawn and hide on final release', () => {
  assert.match(SOURCE, /let _activeEmberCount = 0;/);
  assert.match(SOURCE, /let _activeRainCount = 0;/);

  const spawnEmber = functionSource('_spawnEmber');
  assert.match(spawnEmber, /_activeEmberCount \+= 1;/);
  assert.match(spawnEmber, /_emberInst\.visible = true;/);

  const tickEmbers = functionSource('_tickEmbers');
  assert.match(tickEmbers, /_activeEmberCount = Math\.max\(0, _activeEmberCount - 1\);/);
  assert.match(tickEmbers, /if \(_activeEmberCount === 0\) _emberInst\.visible = false;/);

  const spawnRain = functionSource('_spawnRainAround');
  assert.match(spawnRain, /_activeRainCount \+= 1;/);
  assert.match(spawnRain, /_rainInst\.visible = true;/);

  const tickRain = functionSource('_tickRain');
  assert.match(tickRain, /_activeRainCount = Math\.max\(0, _activeRainCount - 1\);/);
  assert.match(tickRain, /if \(_activeRainCount === 0\) _rainInst\.visible = false;/);
});

test('initialization and teardown reset matrices, counters, and visibility', () => {
  const clearEmbers = functionSource('_clearEmberPool');
  assert.match(clearEmbers, /_embers\.length = 0;/);
  assert.match(clearEmbers, /_activeEmberCount = 0;/);
  assert.match(clearEmbers, /_emberInst\.visible = false;/);

  const clearRain = functionSource('_clearRainPool');
  assert.match(clearRain, /_rain\.length = 0;/);
  assert.match(clearRain, /_activeRainCount = 0;/);
  assert.match(clearRain, /_rainInst\.visible = false;/);

  const init = functionSource('initHelltide');
  assert.match(init, /_clearEmberPool\(\);/);
  assert.match(init, /_clearRainPool\(\);/);

  const teardown = functionSource('teardownHelltide');
  assert.match(teardown, /_clearEmberPool\(\);/);
  assert.match(teardown, /_clearRainPool\(\);/);

  const activity = functionSource('hasHelltideActivity');
  assert.match(activity, /_activeEmberCount > 0/);
  assert.match(activity, /_activeRainCount > 0/);
  assert.doesNotMatch(activity, /\.some\(/);
});
