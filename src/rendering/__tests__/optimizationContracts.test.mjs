import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('retired compatibility modules and hot-loop no-ops stay removed', () => {
  for (const relativePath of [
    'src/arenaProps.js',
    'src/postfx.js',
    'src/rendering/legacyRendererService.js',
    'src/rendering/__tests__/legacyRendererService.test.mjs',
    'src/stages/cave/caveGlowmoss.js',
    'src/stages/cave/caveSigilFloor.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }

  const main = read('src/main.js');
  assert.doesNotMatch(main, /arenaProps|tickArenaProps|spawnArenaProps|resetArenaProps/);
  assert.doesNotMatch(main, /updatePickupRing|perfMark\('pickupRing'/);
  assert.doesNotMatch(read('src/fx.js'), /export function updatePickupRing/);
  assert.doesNotMatch(read('src/buttonPrompts.js'), /mountLegend|setLegendVisible|kk-prompt-legend/);
  assert.doesNotMatch(read('src/ui.js'), /mountPromptLegend/);
  const previewAdapter = read('src/rendering/previewRendererAdapter.js');
  assert.doesNotMatch(previewAdapter, /WebGLRenderer|isWebGLRenderer|forceContextLoss/);
  assert.match(previewAdapter, /THREE\.WebGPURenderer/);
  for (const relativePath of [
    'src/qa/qaScenes.js',
    'src/rendering/rendererAccess.js',
    'src/rendering/rendererCapabilities.js',
  ]) {
    assert.doesNotMatch(read(relativePath), /isWebGLRenderer|getContext\s*\(/, relativePath);
  }
  assert.equal(Object.hasOwn(JSON.parse(read('package.json')), 'main'), false);
});

test('fixed-count projectile banks skip empty draws and upload only dirty variants', () => {
  const source = read('src/weapons/autoAim.js');
  assert.match(source, /im\.visible = false/);
  assert.match(source, /_projLiveN \+= 1/);
  assert.match(source, /_projLiveI \+= 1/);
  assert.match(source, /if \(_projLiveN === 0\)[\s\S]*?halo\.visible = false/);
  assert.match(source, /if \(_projLiveI === 0\)[\s\S]*?halo\.visible = false/);
  assert.match(source, /if \(_projDirtyN\)[\s\S]*?haloN\.instanceMatrix\.needsUpdate = true/);
  assert.match(source, /if \(_projDirtyI\)[\s\S]*?haloI\.instanceMatrix\.needsUpdate = true/);
  assert.doesNotMatch(source, /let _projDirty =/);
});

test('dissolve and sprite pools submit only while they own live slots', () => {
  const dissolve = read('src/fx/dissolveBurst.js');
  assert.match(dissolve, /let _activeSlotCount = 0/);
  assert.match(dissolve, /_inst\.visible = false/);
  assert.match(dissolve, /visualRole = 'dissolve_burst_pool'/);
  assert.match(dissolve, /if \(written > 0\) _inst\.visible = true/);
  assert.match(dissolve, /if \(_activeSlotCount === 0\) _inst\.visible = false/);
  assert.match(dissolve, /if \(_activeSlotCount === 0\) \{[\s\S]*?return;/);

  const sprites = read('src/sprites/spritePool.js');
  assert.match(sprites, /mesh\.visible = false/);
  assert.match(sprites, /visualRole = 'sprite_pool'/);
  assert.match(sprites, /activeCount: 0/);
  assert.match(sprites, /page\.mesh\.visible = true/);
  assert.match(sprites, /if \(page\.activeCount === 0\) page\.mesh\.visible = false/);
  assert.match(sprites, /if \(pool\.activeCount === 0\) \{[\s\S]*?continue;/);
});

test('stage hazard pools submit only their authored roster prefix', () => {
  const source = read('src/stageHazards.js');
  assert.match(source, /inst\.count = 0/);
  assert.match(source, /_pollenInst\.count = pollenSubmitted/);
  assert.match(source, /_lavaInst\.count = lavaSubmitted/);
  assert.match(source, /_voidChasmInst\.count = _voidChasms\.length/);
  assert.match(source, /if \(_pollenInst\) _pollenInst\.count = 0/);
  assert.match(source, /if \(_lavaInst\) _lavaInst\.count = 0/);
  assert.match(source, /if \(_voidChasmInst\) _voidChasmInst\.count = 0/);
});

test('forest sigil arcs hide both fixed-capacity meshes while idle', () => {
  const source = read('src/forestSigilArc.js');
  assert.match(source, /let _activeArcCount = 0/);
  assert.match(source, /let _activeTrailCount = 0/);
  assert.match(source, /new THREE\.InstancedMesh\(geo, mat, MAX_ARC\);\s*mesh\.visible = false/);
  assert.match(source, /new THREE\.InstancedMesh\(geo, mat, TRAIL_TOTAL\);\s*mesh\.visible = false/);
  assert.match(source, /_activeArcCount \+= 1;\s*_starMesh\.visible = true/);
  assert.match(source, /_activeTrailCount \+= 1;[\s\S]*?_trailMesh\.visible = true/);
  assert.match(source, /if \(_activeArcCount === 0\) _starMesh\.visible = false/);
  assert.match(source, /if \(_activeTrailCount === 0\) _trailMesh\.visible = false/);
});

test('forest branch hazard pools submit only while a branch is active', () => {
  const source = read('src/forestEnvHazards.js');
  assert.match(source, /_branchBoxMesh = new THREE\.InstancedMesh[\s\S]*?_branchBoxMesh\.visible = false/);
  assert.match(source, /_branchRingMesh = teleRune\.mesh;\s*_branchRingMesh\.visible = false/);
  assert.match(source, /_branchCount\+\+;\s*_branchBoxMesh\.visible = true;\s*_branchRingMesh\.visible = true/);
  assert.match(source, /if \(_branchCount === 0\) \{\s*_branchBoxMesh\.visible = false;\s*_branchRingMesh\.visible = false/);
});

test('transient boss-tell materials are released on resolve, interruption, and reset', () => {
  const source = read('src/bossTelegraphs.js');
  const main = read('src/main.js');
  assert.match(source, /function _releaseTellMesh\(mesh\)[\s\S]*?material\?\.dispose\?\.\(\)/);
  assert.match(source, /for \(const r of _activeRings\) \{\s*_releaseTellMesh\(r\.mesh\)/);
  assert.match(source, /if \(boss\._tellRing\) \{\s*_releaseTellMesh\(boss\._tellRing\)/);
  assert.match(source, /if \(boss\._quakeMeshes\) \{[\s\S]*?_releaseTellMesh\(m\)/);
  assert.match(source, /if \(k >= 1\) \{\s*_releaseTellMesh\(r\.mesh\)/);
  assert.doesNotMatch(source, /boss\._(?:engulfInner|sonicInner)\.parent\.remove/);
  assert.match(main, /import \{ disposeBossTelegraphs,[^\n]+from '\.\/bossTelegraphs\.js'/);
  assert.match(main, /function _teardownActiveRun\(\)[\s\S]*?disposeBossTelegraphs\(e\);[\s\S]*?releaseEnemyVisual\(e\)/);
  assert.doesNotMatch(main, /if \(e\._tellRing\)[\s\S]{0,200}?e\._tellRing = null/);
});

test('boss motes and velocity veils skip sparse pool work while idle', () => {
  const boss = read('src/bossTelegraphs.js');
  assert.match(boss, /let _moteLiveCount = 0/);
  assert.match(boss, /_moteInst\.count = 0;\s*_moteInst\.visible = false/);
  assert.match(boss, /if \(!_moteInst \|\| _moteLiveCount === 0\) return/);
  assert.match(boss, /_moteLiveCount \+= 1/);
  assert.match(boss, /_moteLiveCount -= 1/);
  assert.doesNotMatch(boss, /updateBossTelegraphs\(dt\)[\s\S]{0,250}_ensureMoteInst\(\)/);

  const ribbon = read('src/fx/ribbonTrail.js');
  assert.match(ribbon, /let _activeSlotCount = 0/);
  assert.match(ribbon, /let _activeVeilCount = 0/);
  assert.match(ribbon, /if \(!_inst \|\| \(_activeVeilCount === 0 && _activeSlotCount === 0\)\) return/);
  assert.match(ribbon, /if \(!d\.used\) _activeVeilCount \+= 1/);
  assert.match(ribbon, /_activeSlotCount -= 1/);
  assert.match(ribbon, /_inst\.count = 0;\s*_inst\.visible = false/);
});

test('Bullet Hell sparse projectile pools submit and scan only while live', () => {
  const bullets = read('src/bullethell/bullets.js');
  assert.match(bullets, /_mesh\.count = 0;\s*_mesh\.visible = false/);
  assert.match(bullets, /if \(_free\.length === MAX_BULLETS\) \{\s*_mesh\.count = MAX_BULLETS/);
  assert.match(bullets, /function _releaseSlot\(i\)[\s\S]*?_free\.push\(i\)/);
  assert.match(bullets, /if \(!_mesh \|\| _free\.length === MAX_BULLETS\) return/);
  assert.doesNotMatch(bullets, /_slots\[i\] = null; _free\.push\(i\)/);

  const shots = read('src/bullethell/shots.js');
  assert.match(shots, /_mesh\.count = 0;\s*_mesh\.visible = false/);
  assert.match(shots, /if \(_free\.length === MAX_SHOTS\) \{\s*_mesh\.count = MAX_SHOTS/);
  assert.match(shots, /let allocatedAny = false/);
  assert.match(shots, /if \(_free\.length === MAX_SHOTS\) return/);
  assert.doesNotMatch(shots, /_slots\[i\] = null; _free\.push\(i\)/);
});

test('migration-era GLSL sprite smoke expectations were replaced by TSL contracts', () => {
  const foundationSmoke = read('tools/smoke-sprite-fx.mjs');
  const flashSmoke = read('tools/smoke-sprite-flash.mjs');
  assert.doesNotMatch(foundationSmoke, /new ShaderMaterial|\b_VS\b|\b_FS\b/);
  assert.match(foundationSmoke, /MeshBasicNodeMaterial/);
  assert.match(flashSmoke, /attribute\\\('aFlash'/);
  assert.match(flashSmoke, /material\\\.outputNode/);
});

test('frame-budget smokes use r185 per-frame drawCalls instead of cumulative render calls', () => {
  for (const relative of [
    'tools/smoke-forest-combat-visuals.mjs',
    'tools/smoke-forest-crystals.mjs',
    'tools/smoke-stage-landscapes.mjs',
    'tools/smoke-forest-density.mjs',
  ]) {
    const source = read(relative);
    assert.match(source, /info\.render\.drawCalls/);
    assert.doesNotMatch(source, /info\.render\.calls/);
  }
});
