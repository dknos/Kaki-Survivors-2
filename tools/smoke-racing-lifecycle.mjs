import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function source(relativePath) {
  return readFile(path.join(REPO_ROOT, ...relativePath.split('/')), 'utf8');
}

const sources = {
  assets: await source('src/racing/racingAssets.js'),
  rally: await source('src/racing/index.js'),
  rallyEnvironment: await source('src/racing/racingEnvironment.js'),
  monsterArena: await source('src/racing/monsterArena.js'),
  trials: await source('src/racing/trialsMode.js'),
  trialsEnvironment: await source('src/racing/trialsEnvironment.js'),
};

const failures = [];
let assertions = 0;

function expect(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function matches(text, pattern, message) {
  assertions += 1;
  assert.match(text, pattern, message);
}

function check(name, callback) {
  try {
    callback();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

console.log('Kaki Rally lifecycle source contracts');

check('asset leases reference-count shared textures and release idempotently', () => {
  matches(sources.assets, /export function createRallyAssetLease\s*\(/, 'createRallyAssetLease is not exported');
  matches(sources.assets, /entry\.refs\s*\+=\s*1/, 'asset acquisition does not increment its reference count');
  matches(sources.assets, /let released\s*=\s*false/, 'asset leases have no idempotent release guard');
  matches(sources.assets, /release\s*\(\)\s*\{[\s\S]*if\s*\(released\)\s*return;[\s\S]*released\s*=\s*true/, 'asset release is not idempotent');
  matches(sources.assets, /entry\.refs\s*=\s*Math\.max\(0,\s*entry\.refs\s*-\s*1\)/, 'asset release does not decrement references safely');
  matches(sources.assets, /if\s*\(entry\.refs\s*===\s*0\)[\s\S]*entry\.texture\.dispose\(\)[\s\S]*_cache\.delete\(entry\.url\)/, 'last release does not dispose and evict its texture');
  matches(sources.assets, /whenReady\s*\(id\)[\s\S]*entriesById\[id\][\s\S]*return entry\.ready\.then/, 'leases cannot resolve an individual production asset');
});

check('isometric rally acquires/releases assets and restores the hero exactly', () => {
  matches(sources.rally, /import\s*\{[^}]*createRallyAssetLease[^}]*\}\s*from\s*['"]\.\/racingAssets\.js['"]/, 'rally does not import its asset lease factory');
  matches(sources.rally, /session\.assetLease\s*=\s*createRallyAssetLease\s*\(/, 'rally enter does not acquire an asset lease');
  matches(sources.rally, /session\.assetLease\.ready[\s\S]*?\.catch\s*\(/, 'rally enter does not surface asynchronous asset failures');
  matches(
    sources.rally,
    /session\.assetLease\.ready\.then\([\s\S]*for \(const texture of session\.owned\.textures\)[\s\S]*requestTextureUploadIfReady\(texture\)/,
    'rally does not refresh deferred atlas clones after the asset lease resolves',
  );
  matches(sources.rally, /assetLease\.whenReady\(bodyAssetId\)/, 'Monster truck body waits for the entire production lease');
  matches(sources.rally, /assetLease\.whenReady\(['"]arenaTrafficKit['"]\)/, 'Monster traffic kit has no independent readiness path');
  matches(sources.rally, /session\.assetLease\?\.release\(\)/, 'rally exit does not release its asset lease');
  matches(sources.rally, /savedHero\s*=\s*\{[\s\S]*parent:\s*hero\.parent[\s\S]*position:\s*hero\.position\.clone\(\)[\s\S]*quaternion:\s*hero\.quaternion\.clone\(\)[\s\S]*scale:\s*hero\.scale\.clone\(\)[\s\S]*visible:\s*hero\.visible/, 'rally does not capture complete hero presentation state');
  matches(sources.rally, /hero\.visible\s*=\s*session\.savedHero\.visible/, 'rally exit does not restore hero visibility');
  matches(sources.rally, /\(session\.savedHero\.parent\s*\|\|\s*scene\s*\|\|\s*session\.scene\)\?\.add\(hero\)/, 'rally exit does not restore the hero parent');
});

check('isometric environment build, frame update, and disposal are integrated', () => {
  for (const exportName of ['buildRallyEnvironment', 'updateRallyEnvironment', 'disposeRallyEnvironment']) {
    expect(sources.rallyEnvironment.includes(`export function ${exportName}`), `racingEnvironment is missing ${exportName}`);
    expect(sources.rally.includes(exportName), `rally runtime never references ${exportName}`);
  }
  matches(sources.rally, /session\.environment\s*=\s*built\.environment/, 'rally session does not retain its environment handle');
  matches(sources.rally, /updateRallyEnvironment\(session\.environment,/, 'rally tick does not update ambient environment state');
  matches(sources.rally, /disposeRallyEnvironment\(session\.environment\)/, 'rally exit does not call the environment disposer');
});

check('Monster Arena owns an explicit build, update, and idempotent disposal lifecycle', () => {
  for (const exportName of ['buildMonsterArena', 'updateMonsterArena', 'disposeMonsterArena']) {
    expect(sources.monsterArena.includes(`export function ${exportName}`), `monsterArena is missing ${exportName}`);
    expect(sources.rally.includes(exportName), `rally runtime never references ${exportName}`);
  }
  matches(sources.rally, /const\s+monsterArenaView\s*=\s*buildMonsterArena\s*\([\s\S]*session\.monsterArenaView\s*=\s*built\.monsterArenaView/, 'Monster enter does not retain its authored arena lifecycle handle');
  matches(sources.rally, /updateMonsterArena\(session\.monsterArenaView,/, 'Monster tick does not update its arena presentation');
  matches(sources.rally, /disposeMonsterArena\(session\.monsterArenaView\)/, 'Monster exit does not remove the authored arena');
  matches(sources.monsterArena, /if\s*\(!arena\s*\|\|\s*arena\.disposed\)\s*return;[\s\S]*arena\.disposed\s*=\s*true/, 'Monster Arena disposal is not idempotent');
  matches(sources.monsterArena, /arena\.group\?\.parent\?\.remove\(arena\.group\)/, 'Monster Arena disposal leaves its scene root attached');
});

check('isometric exit disposes every owned WebGL resource class', () => {
  for (const [type, singular] of [['textures', 'texture'], ['materials', 'material'], ['geometries', 'geometry']]) {
    matches(
      sources.rally,
      new RegExp(`for \\(const ${singular} of session\\.owned\\?\\.${type} \\|\\| \\[\\]\\) \\{ try \\{ ${singular}\\.dispose\\(\\);`),
      `rally exit does not dispose owned ${type}`,
    );
  }
  matches(sources.rallyEnvironment, /external\?\.delete\(resources\[i\]\)/, 'environment disposal does not remove disposed resources from caller ownership sets');
});

check('Trials acquires the shared lease and integrates its authored environment', () => {
  matches(sources.trials, /createRallyAssetLease/, 'Trials does not reference createRallyAssetLease');
  matches(sources.trials, /trials:\s*true/, 'Trials asset acquisition is not marked as a Trials lease');
  matches(sources.trials, /session\.assetLease\s*=\s*createRallyAssetLease\s*\(/, 'Trials enter does not acquire an asset lease');
  matches(sources.trials, /session\.assetLease\.ready\.catch\s*\(/, 'Trials enter does not surface asynchronous asset failures');
  matches(sources.trials, /session\.assetLease\?\.release\(\)/, 'Trials exit does not release its asset lease');

  for (const exportName of ['buildTrialsEnvironment', 'updateTrialsEnvironment']) {
    expect(sources.trialsEnvironment.includes(`export function ${exportName}`), `trialsEnvironment is missing ${exportName}`);
    expect(sources.trials.includes(exportName), `Trials runtime never references ${exportName}`);
  }
  matches(sources.trials, /buildTrialsEnvironment\(session\)/, 'Trials enter does not build its authored presentation world');
  matches(sources.trials, /updateTrialsEnvironment\(session,\s*session\.visualClock,\s*(?:safeDt|dt)\)/, 'Trials world animation does not update ambient environment state');
  matches(sources.trials, /export function tickTrialsMode[\s\S]*_animateWorld\(session,\s*safeDt\)/, 'Trials tick does not invoke its world animation hook');
});

check('Trials authored backdrop covers the live side-view camera', () => {
  matches(sources.trialsEnvironment, /new THREE\.PlaneGeometry\(16,\s*9\)/, 'Trials backdrop lost its source aspect ratio');
  matches(sources.trialsEnvironment, /Math\.max\(viewHeight,\s*viewWidth\s*\/\s*BACKDROP_ASPECT\)\s*\*\s*BACKDROP_OVERSCAN/, 'Trials backdrop is not sized like a cover image');
  matches(sources.trialsEnvironment, /camera\.getWorldDirection\(TEMP_DIRECTION\)/, 'Trials backdrop is not centered on the camera ray');
  matches(sources.trialsEnvironment, /camera\.getWorldQuaternion\(TEMP_QUATERNION\)/, 'Trials backdrop is not billboarded to the camera');
  matches(sources.trialsEnvironment, /_fitBackdropToCamera\(session,\s*world\)/, 'Trials backdrop cover is not updated with the camera');
});

check('Trials exit and restart preserve state while disposing all owned resources', () => {
  matches(sources.trials, /savedHero:\s*\{[\s\S]*parent:\s*hero\.parent[\s\S]*position:\s*hero\.position\.clone\(\)[\s\S]*quaternion:\s*hero\.quaternion\.clone\(\)[\s\S]*scale:\s*hero\.scale\.clone\(\)[\s\S]*visible:\s*hero\.visible/, 'Trials does not capture complete hero presentation state');
  matches(sources.trials, /hero\.visible\s*=\s*session\.savedHero\.visible/, 'Trials exit does not restore hero visibility');
  matches(sources.trials, /(?:ownerScene|scene)\.background\s*=\s*session\.savedBackground/, 'Trials exit does not restore the prior scene background');
  matches(sources.trials, /(?:ownerScene|scene)\.fog\s*=\s*session\.savedFog/, 'Trials exit does not restore the prior scene fog');
  matches(sources.trials, /state\.envGroup\.visible\s*=\s*session\.savedEnvVisible/, 'Trials exit does not restore base environment visibility');
  for (const [type, singular] of [['textures', 'texture'], ['materials', 'material'], ['geometries', 'geometry']]) {
    matches(
      sources.trials,
      new RegExp(`for \\(const ${singular} of session\\.owned\\?\\.${type} \\|\\| \\[\\]\\) \\{ try \\{ ${singular}\\.dispose\\(\\);`),
      `Trials exit does not dispose owned ${type}`,
    );
  }
  matches(sources.trials, /if\s*\(current\)\s*exitTrialsMode\(ownerScene,\s*current\);[\s\S]*return enterTrialsMode\(ownerScene,\s*nextOptions\);/, 'full Trials restart does not exit before re-entering with preserved options');
  matches(sources.trials, /if\s*\(options\.checkpoint\s*&&\s*current\)\s*return _restartCheckpoint\(current,\s*['"]manual['"]\)/, 'checkpoint restart should not rebuild the full presentation world');
});

if (failures.length) {
  console.error(`\nKaki Rally lifecycle smoke failed: ${failures.length} check(s), ${assertions} assertions.`);
  process.exitCode = 1;
} else {
  console.log(`\nKaki Rally lifecycle smoke passed: ${assertions} assertions.`);
}
