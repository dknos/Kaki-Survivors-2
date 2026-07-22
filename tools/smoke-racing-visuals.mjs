import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RACE_COURSES,
  RACE_COURSE_ORDER,
  RACE_MODES,
} from '../src/racing/tracks.js';
import {
  RALLY_ASSET_MANIFEST,
  RALLY_COURSE_ASSETS,
  TRIALS_COURSE_ASSETS,
  rallyAssetIds,
  trialsAssetIds,
} from '../src/racing/racingManifest.js';
import {
  TRIALS_TRACK_ORDER,
  TRIALS_TRACKS,
} from '../src/racing/trialsTracks.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEHICLE_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'racingVehicles.js'), 'utf8');
const VFX_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'racingVfx.js'), 'utf8');
const RACING_CSS_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'racing.css'), 'utf8');
const TRIALS_MODE_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'trialsMode.js'), 'utf8');
const RACING_INDEX_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'index.js'), 'utf8');
const MAIN_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'main.js'), 'utf8');
const RACING_ENVIRONMENT_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'racingEnvironment.js'), 'utf8');
const MONSTER_ARENA_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'monsterArena.js'), 'utf8');
const CRASH_ASSETS_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'racing', 'crash', 'crashAssets.js'), 'utf8');
const BACKDROP_MATERIAL_SOURCE = await readFile(path.join(REPO_ROOT, 'src', 'rendering', 'materials', 'racingBackdropMaterials.js'), 'utf8');

const failures = [];
let assertions = 0;

function check(name, callback) {
  try {
    callback();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

function expect(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function exportedFunctionBlock(name, nextName = null) {
  const startToken = `export function ${name}`;
  const start = VEHICLE_SOURCE.indexOf(startToken);
  expect(start >= 0, `missing ${startToken}`);
  if (!nextName) return VEHICLE_SOURCE.slice(start);
  const end = VEHICLE_SOURCE.indexOf(`export function ${nextName}`, start + startToken.length);
  expect(end > start, `could not find the end of ${name}`);
  return VEHICLE_SOURCE.slice(start, end);
}

console.log('Kaki Rally visual source contracts');

check('six rally courses and four isometric modes form 24 complete configurations', () => {
  const expectedCourses = ['forest', 'twilight', 'cinder', 'void', 'cave', 'kakiland'];
  const expectedModes = ['circuit', 'drift', 'stock', 'monster'];
  equal([...RACE_COURSE_ORDER], expectedCourses, 'rally course order changed or is incomplete');
  equal(Object.keys(RALLY_COURSE_ASSETS).sort(), [...expectedCourses].sort(), 'rally asset maps must cover every course');
  equal(expectedModes.filter((id) => !RACE_MODES[id]), [], 'one or more isometric rally modes are missing');

  const configurations = [];
  for (const courseId of expectedCourses) {
    expect(RACE_COURSES[courseId]?.id === courseId, `missing course definition for ${courseId}`);
    for (const modeId of expectedModes) {
      const ids = rallyAssetIds(courseId, modeId);
      expect(ids.length >= 2, `${courseId}/${modeId} has no useful visual asset mapping`);
      for (const id of ids) expect(RALLY_ASSET_MANIFEST[id], `${courseId}/${modeId} references unknown asset ${id}`);
      if (modeId === 'monster') {
        expect(ids.includes('monsterDecal'), `${courseId}/monster is missing its truck decal`);
        expect(ids.includes('monsterKeyArt'), `${courseId}/monster is missing its arena key art`);
        expect(ids.includes('mightyMeowsterBody'), `${courseId}/monster is missing the default Mighty Meowster body`);
        expect(rallyAssetIds(courseId, modeId, 'cyber').includes('cyberKakiBody'), `${courseId}/monster cannot select Cyber Kaki`);
        expect(rallyAssetIds(courseId, modeId, 'tipsy').includes('tipsyTumblerBody'), `${courseId}/monster cannot select Tipsy Tumbler`);
        expect(ids.includes('arenaTrafficKit'), `${courseId}/monster is missing its destructible traffic kit`);
        expect(ids.includes('monsterArenaBackdrop'), `${courseId}/monster is missing its exterior world plate`);
        expect(!ids.includes('environmentKitV2'), `${courseId}/monster still downloads the unused rally environment kit`);
        expect(!ids.some((id) => id.startsWith('ground')), `${courseId}/monster still downloads unused chapter terrain textures`);
      }
      configurations.push(`${courseId}/${modeId}`);
    }
  }
  equal(configurations.length, 24, 'expected exactly 24 isometric rally configurations');
});

check('racing countdown follows wall time through expensive opening frames', () => {
  expect(RACING_INDEX_SOURCE.includes('export function tickRacing(dt, elapsedDt = dt)'),
    'racing tick has no separate elapsed-time input');
  expect(RACING_INDEX_SOURCE.includes('session.countdown -= wallDt'),
    'racing countdown still stretches with the capped physics step');
  expect(MAIN_SOURCE.includes('tickRacing(logicDt, elapsedDt)'),
    'main loop still hides raw elapsed time from the racing countdown');
  expect(RACING_INDEX_SOURCE.includes("phase: raceMode === 'monster' ? 'loading' : 'countdown'"),
    'Monster Smash does not hold countdown until exterior cameras are warm');
  expect(RACING_INDEX_SOURCE.includes("for (const mode of ['isometric', 'chase'])"),
    'Monster Smash does not warm both exterior camera projections');
});

check('three Trials courses and two vehicle classes form six complete configurations', () => {
  const expectedTracks = ['meadow', 'quarry', 'crown'];
  const expectedVehicles = ['monster', 'buggy'];
  equal([...TRIALS_TRACK_ORDER], expectedTracks, 'Trials track order changed or is incomplete');
  equal(Object.keys(TRIALS_COURSE_ASSETS).sort(), [...expectedTracks].sort(), 'Trials asset maps must cover every course');

  const configurations = [];
  for (const trackId of expectedTracks) {
    expect(TRIALS_TRACKS[trackId]?.id === trackId, `missing Trials definition for ${trackId}`);
    const ids = trialsAssetIds(trackId);
    expect(ids.includes('decalAtlas'), `${trackId} does not acquire the shared decal atlas`);
    for (const id of ids) expect(RALLY_ASSET_MANIFEST[id], `${trackId} references unknown asset ${id}`);
    for (const vehicleId of expectedVehicles) configurations.push(`${trackId}/${vehicleId}`);
  }
  equal(configurations.length, 6, 'expected exactly six Trials configurations');
});

check('mode-to-builder routing has a production vehicle for every configuration', () => {
  const expectedBuilders = {
    circuit: 'buildRallyCar',
    drift: 'buildRallyCar',
    stock: 'buildRallyCar',
    monster: 'buildMonsterTruckVisual',
    'monster/cyber': 'buildCyberTruckVisual',
    'trials/monster': 'buildMonsterTruckVisual',
    'trials/buggy': 'buildTrialsBuggy',
    'trials/ghost': 'buildGhostVehicle',
  };
  for (const [route, builder] of Object.entries(expectedBuilders)) {
    expect(
      VEHICLE_SOURCE.includes(`export function ${builder}`),
      `${route} expects missing vehicle builder ${builder}`,
    );
  }
});

check('primary vehicle builders avoid placeholder box primitives', () => {
  expect(!/\bBoxGeometry\b/.test(VEHICLE_SOURCE), 'racingVehicles.js still contains BoxGeometry placeholder bodywork');
  for (const name of ['buildRallyCar', 'buildMonsterTruckVisual', 'buildCyberTruckVisual', 'buildTipsyTumblerVisual', 'buildTrialsBuggy']) {
    expect(VEHICLE_SOURCE.includes(`export function ${name}`), `missing primary builder ${name}`);
  }
  expect(/RoundedBoxGeometry|ExtrudeGeometry|CapsuleGeometry/.test(VEHICLE_SOURCE), 'vehicle bodywork has no authored rounded geometry path');
});

check('Tipsy Tumbler retains animated GLB attachment with a procedural fallback', () => {
  const tipsy = exportedFunctionBlock('buildTipsyTumblerVisual', 'attachTipsyTumblerModel');
  const attach = exportedFunctionBlock('attachTipsyTumblerModel', 'buildTrialsBuggy');
  for (const marker of ['buildMonsterTruckVisual', 'fallbackBodyNodes', 'tipsyModelMount', 'animationMixer']) {
    expect(tipsy.includes(marker), `Tipsy Tumbler fallback is missing ${marker}`);
  }
  expect(/driver\.position\.set\(0,\s*2\.48,\s*-0\.46\)/.test(tipsy), 'Tipsy Kaki is not seated low and rearward in the roof opening');
  expect(/const scale = 4\.48 \/ size\.y/.test(attach), 'Tipsy imported body lost its enlarged visual fit');
  for (const marker of ['gltf.scene.clone(true)', 'new THREE.AnimationMixer(scene)', 'road-synced', 'visual.animationDriveSynced = true', 'visual.modelMaterialStats', 'rotation.y = -Math.PI / 2', 'visual.modelAttached = true']) {
    expect(attach.includes(marker), `Tipsy Tumbler animation attachment is missing ${marker}`);
  }
  expect(attach.includes('/^Object_(6|11|17|22)\\.quaternion$/'), 'Tipsy animation must retain wheel rotations only');
  expect(VEHICLE_SOURCE.includes('export function updateVehicleAnimation'), 'Tipsy wheel animation has no road-speed synchronizer');
});

check('Cyber Kaki keeps a playable fallback and attaches unique damage-ready GLB resources', () => {
  const cyber = exportedFunctionBlock('buildCyberTruckVisual', 'attachCyberTruckModel');
  const attach = exportedFunctionBlock('attachCyberTruckModel', 'buildTrialsBuggy');
  expect(cyber.includes('buildMonsterTruckVisual'), 'Cyber Kaki does not inherit the proven monster animation contract');
  for (const marker of ['fallbackBodyNodes', 'cyberModelMount', 'modelAttached = false', "heroPresentation = 'roof-popout'"]) {
    expect(cyber.includes(marker), `Cyber Kaki fallback contract is missing ${marker}`);
  }
  for (const marker of [
    'gltf.scene.clone(true)',
    'object.geometry = object.geometry.clone()',
    'object.material = object.material.clone()',
    "object.name === 'CyberBody_DamageShell'",
    "object.name.startsWith('DamagePanel_')",
    'visual.modelAttached = true',
  ]) {
    expect(attach.includes(marker), `Cyber Kaki GLB attachment is missing ${marker}`);
  }
});

check('wheel hierarchy preserves semantic order and steering metadata', () => {
  const start = VEHICLE_SOURCE.indexOf('function _makeWheelSet');
  const end = VEHICLE_SOURCE.indexOf('function _makeSpring', start);
  expect(start >= 0 && end > start, 'missing shared wheel-set builder');
  const wheelBlock = VEHICLE_SOURCE.slice(start, end);
  expect(
    /left-rear, left-front, right-rear, right-front/.test(wheelBlock),
    'wheel order contract is not documented next to its implementation',
  );
  expect(
    /side:\s*-1,\s*axle:\s*-1[\s\S]*side:\s*-1,\s*axle:\s*1[\s\S]*side:\s*1,\s*axle:\s*-1[\s\S]*side:\s*1,\s*axle:\s*1/.test(wheelBlock),
    'wheel descriptors do not preserve left-rear, left-front, right-rear, right-front order',
  );
  for (const semantic of [
    "wheel.userData.role = 'wheel'",
    'wheel.userData.basePosition',
    'wheel.userData.steerable',
    "wheel.userData.forwardAxis = '+Z'",
  ]) {
    expect(VEHICLE_SOURCE.includes(semantic), `wheel hierarchy is missing semantic metadata: ${semantic}`);
  }
});

check('builders return the animation and damage API expected by gameplay', () => {
  const rally = exportedFunctionBlock('buildRallyCar', 'buildMonsterTruckVisual');
  const monster = exportedFunctionBlock('buildMonsterTruckVisual', 'buildTrialsBuggy');
  const buggy = exportedFunctionBlock('buildTrialsBuggy', 'buildGhostVehicle');
  const ghost = exportedFunctionBlock('buildGhostVehicle');

  for (const [label, block, fields] of [
    ['rally car', rally, ['root', 'bodyPivot', 'wheels', 'flames', 'driver:', 'shadow', 'damageMeshes', 'damageStamp', 'bumper', 'bumperBaseY', 'animationAnchors']],
    ['monster truck', monster, ['root', 'bodyPivot', 'wheels', 'flames', 'driver:', 'shadow', 'damageMeshes', 'damageStamp', 'bumper', 'bumperBaseY', 'suspension', 'animationAnchors']],
    ['Trials buggy', buggy, ['root', 'bodyPivot', 'wheels', 'flames', 'driver:', 'shadow', 'wheelRadius', 'animationAnchors']],
    ['ghost', ghost, ['root', 'bodyPivot', 'wheels', 'flames:', 'driver:', 'shadow', 'wheelRadius', 'animationAnchors']],
  ]) {
    expect(block.includes('return {'), `${label} does not return a visual contract object`);
    for (const field of fields) expect(block.includes(field), `${label} return contract is missing ${field}`);
  }

  for (const semantic of [
    "root.userData.forwardAxis = '+Z'",
    "bodyPivot.userData.role = 'suspension-body'",
    "userData.role = 'damage-shell'",
    "userData.role = 'damage-bumper'",
    "shadow.userData.role = 'ground-shadow'",
    "anchor.userData.role = 'boost-flame'",
  ]) {
    expect(VEHICLE_SOURCE.includes(semantic), `vehicle source is missing semantic role: ${semantic}`);
  }
});

check('impact VFX observes the reduced-flashing accessibility state', () => {
  expect(/import\s*\{\s*state\s*\}/.test(VFX_SOURCE), 'racing VFX does not import shared accessibility state');
  expect(VFX_SOURCE.includes('state._optReducedFlashing'), 'impact VFX ignores the reduced-flashing option');
  expect(/reduced\s*\?\s*0\.[0-9]+\s*:\s*1/.test(VFX_SOURCE), 'reduced-flashing state does not visibly reduce impact output');
});

check('racing backdrops are world anchored and have no rectangular duplicate', () => {
  expect(
    !/scene\.background\s*=\s*raceMode\s*===\s*['"]monster['"][\s\S]*monsterArenaBackdrop/.test(RACING_INDEX_SOURCE),
    'Monster Smash still glues its illustrated landmarks to the camera viewport',
  );
  expect(!/new THREE\.PlaneGeometry\(620,\s*280\)/.test(MONSTER_ARENA_SOURCE), 'Monster Smash still uses the old rectangular horizon planes');
  expect(/new THREE\.CylinderGeometry\(315,\s*315,\s*88/.test(MONSTER_ARENA_SOURCE), 'Monster Smash has no curved world-space horizon band');
  expect(/createRacingHorizonMaterial/.test(MONSTER_ARENA_SOURCE), 'Monster Smash curved horizon is not using its TSL fade material');
  expect(/surfaceUv[\s\S]*bottomFade[\s\S]*topFade/.test(BACKDROP_MATERIAL_SOURCE), 'curved horizon does not fade both artwork edges into the sky/terrain');
  expect(/mirroredX[\s\S]*fract\(surfaceUv\.x/.test(BACKDROP_MATERIAL_SOURCE), 'non-panoramic horizon art is still stretched across 360 degrees');
  expect(/terrain\.userData\.cameraIgnore = true/.test(MONSTER_ARENA_SOURCE), 'Monster heightfield still enters chase raycasts despite the height query');
  expect(/backdrop\.userData\.cameraIgnore = true/.test(MONSTER_ARENA_SOURCE), 'decorative horizon still enters chase raycasts');
  expect(!/env\.sky\.rotation\.y\s*=/.test(RACING_ENVIRONMENT_SOURCE), 'Rally sky still rotates independently of the world');
  expect(/syncRallySkyToCamera/.test(RACING_ENVIRONMENT_SOURCE), 'Rally sky does not follow camera translation as an infinite-distance backdrop');
});

check('detailed driver shadow proxies preserve hero lifecycle and authored-body attachment', () => {
  expect(/driverShadowProxy[\s\S]*fallbackBodyNodes/.test(VEHICLE_SOURCE), 'authored monster bodies can hide the driver shadow proxy with fallback geometry');
  expect(/child !== visual\.driverShadowProxy/.test(VEHICLE_SOURCE), 'Tipsy authored body can hide the driver shadow proxy');
  expect(/shadowStates:\s*\[\]/.test(RACING_INDEX_SOURCE), 'Rally does not snapshot the persistent hero shadow state');
  expect(/entry\.object\.castShadow = entry\.castShadow/.test(RACING_INDEX_SOURCE), 'Rally does not restore the persistent hero shadow state');
  expect(/shadowStates:\s*\[\]/.test(TRIALS_MODE_SOURCE), 'Trials does not snapshot the persistent hero shadow state');
  expect(/entry\.object\.castShadow = entry\.castShadow/.test(TRIALS_MODE_SOURCE), 'Trials does not restore the persistent hero shadow state');
  expect(/optimizeDriverShadow:\s*false/.test(CRASH_ASSETS_SOURCE), 'deferred Catastrophe accidentally inherits the shared Rally driver-shadow mutation');
});

check('Trials touch controls fit 320/360px portrait with accessible targets', () => {
  expect(
    TRIALS_MODE_SOURCE.includes("root.className = 'kkr-hud kkt-hud'"),
    'Trials HUD must retain the shared root class used by reduced-motion rules',
  );
  expect(
    /class="kkt-touch"\s+aria-label="Trials touch controls"/.test(TRIALS_MODE_SOURCE),
    'Trials touch control group is missing its accessible label',
  );
  for (const groupClass of ['kkt-touch-drive', 'kkt-touch-lean']) {
    expect(TRIALS_MODE_SOURCE.includes(`class="${groupClass}"`), `Trials touch DOM is missing ${groupClass}`);
  }
  const touchActions = [...TRIALS_MODE_SOURCE.matchAll(/data-touch="([^"]+)"/g)].map((match) => match[1]);
  equal(
    [...new Set(touchActions)].sort(),
    ['brake', 'noseDown', 'noseUp', 'restart', 'throttle', 'turbo'],
    'Trials touch DOM must expose exactly six distinct actions',
  );

  const compactStart = RACING_CSS_SOURCE.indexOf('@media (max-width: 400px)');
  const compactEnd = RACING_CSS_SOURCE.indexOf('@media ', compactStart + 1);
  expect(compactStart >= 0 && compactEnd > compactStart, 'missing a bounded <=400px Trials touch layout');
  const compactCss = RACING_CSS_SOURCE.slice(compactStart, compactEnd);
  expect(/\.kkt-touch\s*\{[\s\S]*display:\s*grid;/.test(compactCss), '<=400px Trials controls must use a non-clipping grid');
  expect(/grid-template-areas:[\s\S]*"drive lean"[\s\S]*"turbo restart"/.test(compactCss), 'compact Trials controls must occupy two explicit rows');
  expect((compactCss.match(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/g) || []).length >= 2, 'compact outer and grouped controls must both use two flexible columns');
  for (const edge of ['left', 'right', 'bottom']) {
    expect(compactCss.includes(`env(safe-area-inset-${edge})`), `compact Trials controls ignore the ${edge} safe area`);
  }
  expect(/\.kkt-touch button\s*\{[\s\S]*width:\s*100%;[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*48px;/.test(compactCss), 'compact Trials buttons must fill their cells and preserve a 44px minimum width');
  const compactTargetWidths = [...compactCss.matchAll(/min-width:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
  const compactTargetHeights = [...compactCss.matchAll(/min-height:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
  expect(compactTargetWidths.length >= 3, 'compact generic, turbo, and restart targets need explicit widths');
  expect(compactTargetHeights.length >= 3, 'compact generic, turbo, and restart targets need explicit heights');
  expect(compactTargetWidths.every((width) => width >= 44), 'every compact Trials target must remain at least 44px wide');
  expect(compactTargetHeights.every((height) => height >= 44), 'every compact Trials target must remain at least 44px high');

  const reducedMotionStart = RACING_CSS_SOURCE.indexOf('@media (prefers-reduced-motion: reduce)');
  expect(reducedMotionStart > compactStart, 'reduced-motion rules must follow and override compact interaction transitions');
  const reducedMotionCss = RACING_CSS_SOURCE.slice(reducedMotionStart);
  expect(/\.kkr-hud \*[\s\S]*animation:\s*none\s*!important;/.test(reducedMotionCss), 'compact Trials controls lost the shared reduced-motion animation override');
  expect(/transition-duration:\s*\.001ms\s*!important;/.test(reducedMotionCss), 'compact Trials controls lost the shared reduced-motion transition override');
});

if (failures.length) {
  console.error(`\nKaki Rally visual smoke failed: ${failures.length} check(s), ${assertions} assertions.`);
  process.exitCode = 1;
} else {
  console.log(`\nKaki Rally visual smoke passed: 30 configurations, ${assertions} assertions.`);
}
