#!/usr/bin/env node
/**
 * Authored biome smoke: boots every survivors stage in a fresh browser context
 * and verifies the landscape hierarchy, interaction-owned visuals, and a sane
 * render-call ceiling. Run: node tools/smoke-stage-landscapes.mjs
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8812);
const TIMEOUT = 90000;
const ALL_STAGES = ['forest', 'twilight', 'cinder', 'void', 'cave'];
const STAGES = process.env.STAGES
  ? process.env.STAGES.split(',').map((s) => s.trim()).filter((s) => ALL_STAGES.includes(s))
  : ALL_STAGES;

function mime(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function checkStage(stage, p) {
  const failures = [];
  if (p.stage !== stage) failures.push(`resolved stage=${p.stage}`);
  if (p.pageErrors.length) failures.push(`page errors: ${p.pageErrors.join(' | ')}`);
  if (p.consoleErrors.length) failures.push(`console errors: ${p.consoleErrors.join(' | ')}`);
  if (p.httpErrors.length) failures.push(`HTTP errors: ${p.httpErrors.join(' | ')}`);
  const callCeiling = stage === 'forest' ? 440 : 320;
  if (!(p.calls > 0 && p.calls <= callCeiling)) failures.push(`render calls=${p.calls} (expected 1..${callCeiling})`);
  if (!(p.triangles > 0 && p.triangles <= 1600000)) failures.push(`triangles=${p.triangles} (expected 1..1600000)`);
  if (!p.minimapVisible || p.minimapDraws < 1) failures.push(`minimap visible=${p.minimapVisible} draws=${p.minimapDraws}`);
  const expectedMarkers = stage === 'forest' ? 0 : (stage === 'cinder' ? 2 : 3);
  if (p.minimapMarkers !== expectedMarkers) failures.push(`minimap shard markers=${p.minimapMarkers} (expected ${expectedMarkers})`);
  const expectedProfile = stage === 'forest' ? 'forest-rooms' : 'open-arena';
  if (p.minimapProfile !== expectedProfile) failures.push(`minimap profile=${p.minimapProfile} (expected ${expectedProfile})`);
  if (!p.terrainCut || !p.terrainCrossing) failures.push(`terrain cut/crossing missing (${p.terrainCut}/${p.terrainCrossing})`);
  if (!p.bridgeAsset) failures.push('Blender bridge asset missing');
  if (!p.bridgeSafe || !p.terrainActiveOffBridge) failures.push(`terrain semantics bridgeSafe=${p.bridgeSafe} offBridge=${p.terrainActiveOffBridge}`);
  if (!p.terrainRuntimeActive || !p.bridgeRuntimeSafe) failures.push(`runtime terrain active=${p.terrainRuntimeActive} bridgeSafe=${p.bridgeRuntimeSafe}`);
  if (!p.terrainBelowActors) failures.push('terrain cut rises into actor layer');
  if (!p.stageLife) failures.push('seeded lived-in environment overlay missing');
  if (p.stageLifeGrowth < 140 || p.stageLifePaws < 20 || p.stageLifeAmbient < 14) {
    failures.push(`stage life density growth=${p.stageLifeGrowth} paws=${p.stageLifePaws} ambient=${p.stageLifeAmbient}`);
  }
  const expectedLifeBatches = stage === 'forest' ? 6 : 5;
  if (p.stageLifeBatches !== expectedLifeBatches) failures.push(`stage life draw batches=${p.stageLifeBatches} (expected ${expectedLifeBatches})`);
  if (!p.groundDetail) failures.push('authored stage ground albedo missing');
  if (!p.ambientSprite) failures.push('stage-specific Grok-authored ambient sprite missing');
  if (!p.ambientDecoded || !p.ambientAlphaConfig) failures.push(`ambient sprite decode/alpha invalid decoded=${p.ambientDecoded} alpha=${p.ambientAlphaConfig}`);
  if (!p.progressionGrowth) failures.push(`${stage === 'forest' ? 'Grove Trial' : 'Portal Shard'} progress does not visibly grow the environment`);
  if (!p.stageLifeDeterministic) failures.push('same environment seed did not replay identical placement');
  if (stage !== 'forest' && p.outerLandmarks < 10) failures.push(`outer authored landmarks=${p.outerLandmarks} (<10 beyond 70u)`);

  if (stage === 'forest') {
    if (!p.forestTrialContract || p.forestTrialContract.total !== 6
        || p.forestTrialContract.cleared !== 0 || p.forestTrialContract.bossUnlocked) {
      failures.push(`Forest trial contract=${JSON.stringify(p.forestTrialContract)}`);
    }
    if (p.minimapBossPortal !== 'locked') failures.push(`Forest Boss Gate starts ${p.minimapBossPortal || 'unreported'}`);
    if (!p.arenaDecor) failures.push('forest arena decor missing');
    if (!p.landscape) failures.push('Forest district landscape missing');
    if (p.landscapeInstanced < 5) failures.push(`Forest district batches=${p.landscapeInstanced} (<5)`);
    if (!p.route) failures.push('Forest moss navigation routes missing');
    if (p.stageLifeGrowth < 300 || p.stageLifePaws < 70) {
      failures.push(`Forest room-wide life density growth=${p.stageLifeGrowth} paws=${p.stageLifePaws}`);
    }
    if (p.stageLifeYarn !== 7 || p.debugYarn !== 7) {
      failures.push(`Forest lost-yarn caches=${p.stageLifeYarn}/${p.debugYarn} (expected 7)`);
    }
    if (!p.yarnInteractive) failures.push('Forest Lost Yarn did not collect on hero proximity');
    if (p.destructibleCount < 30 || p.destructibleRooms !== 7 || p.destructiblePurpose !== 'dash-smash-secret') {
      failures.push(`Forest destructibles count=${p.destructibleCount} rooms=${p.destructibleRooms} purpose=${p.destructiblePurpose}`);
    }
    return failures;
  }

  if (!p.landscape) failures.push(`${stage} landscape root missing`);
  if (!p.route) failures.push(`${stage} textured navigation route missing`);
  if (p.landscapeInstanced < 4) failures.push(`${stage} landscape batches=${p.landscapeInstanced} (<4)`);
  if (!p.purposes.length) failures.push(`${stage} purpose metadata missing`);
  const expectedDiscovery = {
    twilight: ['moon-bell', 'touch'],
    cinder: ['forgeheart', 'dash'],
    void: ['star-kitten', 'touch'],
    cave: ['echo-crystal', 'interact'],
  }[stage];
  if (p.stageLifeDiscoveries !== 6 || p.debugDiscoveries !== 6) {
    failures.push(`${stage} discoveries=${p.stageLifeDiscoveries}/${p.debugDiscoveries} (expected 6)`);
  }
  if (!expectedDiscovery || p.discoveryKind !== expectedDiscovery[0] || p.discoveryTrigger !== expectedDiscovery[1]) {
    failures.push(`${stage} discovery profile=${p.discoveryKind}/${p.discoveryTrigger}`);
  }
  if (!p.discoveryInteractive || !p.discoverySynergy) {
    failures.push(`${stage} discovery interaction/synergy failed found=${p.discoveryFoundAfter} synergy=${p.discoverySynergyDetail}`);
  }
  if (!p.discoveryNegativeGate || !p.discoveryCompletion || !p.discoveryReroll) {
    failures.push(`${stage} discovery gate/completion failed negative=${p.discoveryNegativeGate} complete=${p.discoveryCompletion} reroll=${p.discoveryReroll}`);
  }
  if (p.minDiscoveryGrowthClearance < 1.30) failures.push(`${stage} growth obscures discovery at ${p.minDiscoveryGrowthClearance.toFixed(2)}u`);
  if (p.minGrowthCoreClearance < 0.24) failures.push(`${stage} growth intersects a mechanic core by ${p.minGrowthCoreClearance.toFixed(2)}u`);
  if (stage === 'cave' && (!p.mobileDiscovery || !p.caveVaultSynergy)) {
    failures.push(`cave mobile/vault discovery synergy failed mobile=${p.mobileDiscovery} vault=${p.caveVaultSynergy}`);
  }
  if (stage === 'cinder' && !p.allBallistasActivated) failures.push('Cinder discoveries did not awaken six unique ballistas');
  if (stage === 'void' && !p.voidOverchargeApplied) failures.push('Void Star-Kitten charge did not shorten the next pad cooldown');
  if (p.destructibleCount < 24 || p.destructiblePurpose !== 'dash-smash-secret') {
    failures.push(`${stage} authored secrets count=${p.destructibleCount} purpose=${p.destructiblePurpose}`);
  }
  const expectedSecret = { twilight: 'moon-urn', cinder: 'ember-ore', void: 'star-crystal', cave: 'spore-pod' }[stage];
  if (p.destructibleKind !== expectedSecret) failures.push(`${stage} secret kind=${p.destructibleKind} expected=${expectedSecret}`);
  if (!p.destructibleDeterministic || p.minSecretKeepoutClearance < 1.15) {
    failures.push(`${stage} secret placement deterministic=${p.destructibleDeterministic} keepout=${p.minSecretKeepoutClearance.toFixed(2)}u`);
  }
  if (!p.destructibleInteractive || !p.destructibleIdempotent || !p.destructibleModeGate) {
    failures.push(`${stage} secret interaction failed interactive=${p.destructibleInteractive} idempotent=${p.destructibleIdempotent} modeGate=${p.destructibleModeGate}`);
  }

  if (stage === 'twilight') {
    if (p.water < 3) failures.push(`twilight water=${p.water} (<3)`);
    if (!p.interactiveOwner) failures.push('interactive Twilight fountains missing');
    if (p.minPropClearance < 3.5) failures.push(`fountain prop clearance=${p.minPropClearance.toFixed(2)}u`);
  } else if (stage === 'cinder') {
    if (!p.interactiveOwner) failures.push('interactive Cinder ballistas missing');
    if (p.facingDot < 0.999) failures.push(`ballista center-facing dot=${p.facingDot}`);
    if (p.minPropClearance < 4.8) failures.push(`ballista prop clearance=${p.minPropClearance.toFixed(2)}u`);
    if (p.minShelfClearance < 9.5) failures.push(`ballista shelf-center clearance=${p.minShelfClearance.toFixed(2)}u`);
    if (p.fakeFloorTell) failures.push('retired decorative crater still rendered');
  } else if (stage === 'void') {
    if (!p.interactiveOwner) failures.push('interactive Void pads missing');
    if (!p.realHazard) failures.push('authoritative Void chasms missing');
    if (p.minPropClearance < 3.8) failures.push(`Void pad prop clearance=${p.minPropClearance.toFixed(2)}u`);
    if (p.fakeFloorTell) failures.push('retired fake tile gap still rendered');
  } else if (stage === 'cave') {
    if (p.water < 3) failures.push(`cave water=${p.water} (<3)`);
    if (!p.interactiveOwner) failures.push('kill-gated Cave vault missing');
    if (p.fakeFloorTell) failures.push('retired cave floor/sigil/glowmoss still rendered');
  }
  return failures;
}

async function probe(page, stage, errors) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=landscape-${stage}`, {
    waitUntil: 'load', timeout: TIMEOUT,
  });
  await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: TIMEOUT });
  await page.evaluate(async (id) => {
    const meta = await import('./src/meta.js');
    // The public settings gate is intentional; this all-stage authoring smoke
    // needs the explicit developer unlock before selecting later campaigns.
    meta.setOption('optDevUnlockAllLevels', true);
    meta.setOption('selectedStage', id);
    localStorage.setItem('kks_introSeen', '1');
    if (id === 'forest') localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
    // Force the same stage re-resolution seam used by the focused stage
    // smokes; a pre-populated starter kit otherwise skips applyMetaUpgrades.
    window.kkState.weapons.length = 0;
    await window.kkStartRun();
  }, stage);
  await page.waitForFunction((id) => {
    const s = window.kkState;
    return !!(s && s.started && s.run && s.run.stage && s.run.stage.id === id);
  }, stage, { timeout: TIMEOUT });
  await page.waitForTimeout(2200);
  if (process.env.SHOTS) {
    if (process.env.FOCUS_BOSS_GATE && stage === 'forest') {
      await page.evaluate(async () => {
        const { FOREST_BOSS_GATE_POS } = await import('./src/catacomb.js');
        window.kkState.hero.pos.set(FOREST_BOSS_GATE_POS.x, 0, FOREST_BOSS_GATE_POS.z - 3.5);
        window.kkState.hero.vel.set(0, 0, 0);
      });
      await page.waitForTimeout(4500);
    } else if (process.env.FOCUS_BRIDGE) {
      await page.evaluate(async (id) => {
        const { getStageTerrainLayout } = await import('./src/stageTerrainLayout.js');
        const bridge = getStageTerrainLayout(id)?.bridges?.[0];
        if (bridge) {
          window.kkState.hero.pos.set(bridge.x, 0, bridge.z - 2.8);
          window.kkState.hero.vel.set(0, 0, 0);
        }
      }, stage);
      await page.waitForTimeout(900);
    } else if (process.env.FOCUS_YARN) {
      await page.evaluate(async () => {
        const mod = await import('./src/stageLife.js');
        const first = mod._debugStageLife().firstYarn;
        if (!first) return;
        window.kkState.hero.pos.set(first.x - 2.5, 0, first.z - 1.5);
        window.kkState.hero.vel.set(0, 0, 0);
      });
      await page.waitForTimeout(900);
    } else if (process.env.FOCUS_DISCOVERY) {
      await page.evaluate(async () => {
        const mod = await import('./src/stageLife.js');
        const first = mod._debugStageLife().firstDiscovery;
        if (!first) return;
        window.kkState.hero.pos.set(first.x - 2.8, 0, first.z - 1.4);
        window.kkState.hero.vel.set(0, 0, 0);
      });
      await page.waitForTimeout(900);
    } else if (process.env.FOCUS_LIFE) {
      await page.evaluate(async (id) => {
        const THREE = await import('three');
        const mesh = window.kkState.scene.getObjectByName(`stageLife_${id}_growth`);
        if (!mesh || mesh.count < 1) return;
        const matrix = new THREE.Matrix4();
        const pos = new THREE.Vector3();
        mesh.getMatrixAt(Math.max(0, mesh.count - 1), matrix);
        pos.setFromMatrixPosition(matrix);
        window.kkState.hero.pos.set(pos.x, 0, pos.z);
        window.kkState.hero.vel.set(0, 0, 0);
      }, stage);
      await page.waitForTimeout(900);
    }
    const suffix = process.env.FOCUS_BOSS_GATE
      ? '-boss-gate'
      : process.env.FOCUS_BRIDGE
      ? '-bridge'
      : (process.env.FOCUS_YARN
          ? '-yarn'
          : (process.env.FOCUS_DISCOVERY ? '-discovery' : (process.env.FOCUS_LIFE ? '-life' : '')));
    await page.screenshot({ path: `/tmp/kks-landscape-${stage}${suffix}.png`, fullPage: false });
  }

  const result = await page.evaluate(async (id) => {
    const THREE = await import('three');
    const s = window.kkState;
    const scene = s.scene;
    // Freeze the canonical boot-frame render budget before interaction probes
    // teleport the hero among outer landmarks (which changes frustum results).
    const canonicalCalls = s.renderer && s.renderer.info ? s.renderer.info.render.drawCalls : 0;
    const canonicalTriangles = s.renderer && s.renderer.info ? s.renderer.info.render.triangles : 0;
    const root = scene.getObjectByName(`__stageLandscape_${id}`);
    const stageLife = scene.getObjectByName('__stageLife');
    const stageLifeCounts = stageLife && stageLife.userData && stageLife.userData.counts || {};
    const lifeAmbient = scene.getObjectByName(`stageLife_${id}_ambient`);
    const ground = s.envGroup && s.envGroup.userData && s.envGroup.userData.ground;
    const groundImage = ground && ground.material && ground.material.map && ground.material.map.image;
    const groundSrc = groundImage && (groundImage.currentSrc || groundImage.src) || '';
    const ambientImage = lifeAmbient && lifeAmbient.material && lifeAmbient.material.map && lifeAmbient.material.map.image;
    const ambientSrc = ambientImage && (ambientImage.currentSrc || ambientImage.src) || '';
    let instanced = 0;
    let landscapeInstanced = 0;
    const purposes = new Set();
    let route = false;
    let water = 0;
    let terrainCut = false;
    let terrainCrossing = false;
    let terrainBelowActors = true;
    let bridgeAsset = false;
    let outerLandmarks = 0;
    const matrixWorld = new THREE.Matrix4();
    const worldPos = new THREE.Vector3();
    scene.traverse((o) => {
      if (o.isInstancedMesh) instanced++;
      if (o.userData && o.userData.landscapePurpose) purposes.add(o.userData.landscapePurpose);
      if (o.userData && o.userData.landscapePurpose === 'navigation-route' && o.material && o.material.map) route = true;
      if (o.userData && o.userData.landscapePurpose === 'water-landmark') water += o.count || 1;
      if (o.userData && o.userData.landscapePurpose === 'terrain-cut') {
        terrainCut = true;
        const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (pos) for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.001) terrainBelowActors = false;
      }
      if (o.userData && o.userData.landscapePurpose === 'terrain-crossing') {
        terrainCrossing = true;
        if (o.name.includes('kk_bridge_')) bridgeAsset = true;
      }
      if (root && o.isInstancedMesh && root.getObjectById(o.id)) {
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, matrixWorld);
          worldPos.setFromMatrixPosition(matrixWorld);
          if (Math.hypot(worldPos.x, worldPos.z) > 70) outerLandmarks++;
        }
      }
    });
    if (root) root.traverse((o) => { if (o.isInstancedMesh) landscapeInstanced++; });

    let interactiveOwner = false;
    let realHazard = false;
    let fakeFloorTell = false;
    let facingDot = 1;
    let minPropClearance = Infinity;
    let minShelfClearance = Infinity;
    async function measureClearance(modulePath, excludeNames = []) {
      if (!root) return;
      const mod = await import(modulePath);
      const anchors = (mod._debugHotspots && mod._debugHotspots()) || [];
      const matrix = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      root.traverse((o) => {
        if (!o.isInstancedMesh || excludeNames.some((name) => o.name.includes(name))) return;
        const purpose = o.userData && o.userData.landscapePurpose;
        if (purpose === 'water-landmark' || purpose === 'waterside-vegetation') return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, matrix);
          pos.setFromMatrixPosition(matrix);
          for (const h of anchors) minPropClearance = Math.min(minPropClearance, Math.hypot(pos.x - h.x, pos.z - h.z));
        }
      });
    }
    if (id === 'twilight') {
      interactiveOwner = !!scene.getObjectByName('__twilightFountains');
      await measureClearance('./src/twilightFountains.js');
    }
    if (id === 'cinder') {
      interactiveOwner = !!scene.getObjectByName('__cinderBallistas');
      const arena = scene.getObjectByName('__arenaDecor');
      const counts = arena && arena.userData && arena.userData.counts;
      fakeFloorTell = !!(counts && (counts.craters || counts.ballistaPlaceholders || counts.embers));
      const mod = await import('./src/cinderBallistas.js');
      const hs = mod._debugHotspots() || [];
      facingDot = hs.reduce((min, h) => {
        const r = Math.max(0.001, Math.hypot(h.x, h.z));
        const dot = Math.cos(h.facing) * (-h.x / r) + (-Math.sin(h.facing)) * (-h.z / r);
        return Math.min(min, dot);
      }, 1);
      await measureClearance('./src/cinderBallistas.js');
      const shelf = root && root.getObjectByName('cinder_basalt_shelves');
      if (shelf) {
        const matrix = new THREE.Matrix4();
        const pos = new THREE.Vector3();
        for (let i = 0; i < shelf.count; i++) {
          shelf.getMatrixAt(i, matrix);
          pos.setFromMatrixPosition(matrix);
          for (const h of hs) minShelfClearance = Math.min(minShelfClearance, Math.hypot(pos.x - h.x, pos.z - h.z));
        }
      }
    }
    if (id === 'void') {
      interactiveOwner = !!scene.getObjectByName('__voidTeleportPads');
      realHazard = !!(s.run && Array.isArray(s.run.voidChasms) && s.run.voidChasms.length >= 10);
      const arena = scene.getObjectByName('__arenaDecor');
      const counts = arena && arena.userData && arena.userData.counts;
      fakeFloorTell = !!(counts && (counts.tileGaps || counts.padPlaceholders || counts.stars || counts.pillars));
      await measureClearance('./src/voidTeleportPads.js', ['arches']);
    }
    if (id === 'cave') {
      interactiveOwner = !!scene.getObjectByName('caveStage_vaultGroup');
      fakeFloorTell = ['caveStage_floorAccent', 'caveStage_sigilFloor', 'caveStage_glowmoss']
        .some((name) => !!scene.getObjectByName(name));
    }
    const terrainMod = await import('./src/stageTerrainLayout.js');
    const layout = terrainMod.getStageTerrainLayout(id);
    const bridge = layout && layout.bridges[0];
    const bridgeSample = bridge ? terrainMod.sampleStageTerrain(id, bridge.x, bridge.z) : null;
    let offSample = null;
    if (bridge) {
      const c = Math.cos(bridge.yaw || 0), s = Math.sin(bridge.yaw || 0);
      const offset = bridge.halfWidth + 1.1;
      offSample = terrainMod.sampleStageTerrain(id, bridge.x + c * offset, bridge.z - s * offset);
    }
    let terrainRuntimeActive = false;
    let bridgeRuntimeSafe = false;
    if (bridge && offSample) {
      const hazards = await import('./src/stageHazards.js');
      const c = Math.cos(bridge.yaw || 0), sn = Math.sin(bridge.yaw || 0);
      const offset = bridge.halfWidth + 1.1;
      const ox = bridge.x + c * offset, oz = bridge.z - sn * offset;
      s.hero.pos.set(ox, 0, oz);
      s.hero.hp = s.hero.hpMax = 1000;
      s.hero.iFramesUntil = 0;
      s.hero.hazardSlow = 1;
      const hpBefore = s.hero.hp;
      hazards.tickStageHazards(0.51);
      terrainRuntimeActive = layout.effect === 'damage'
        ? s.hero.hp < hpBefore
        : s.hero.hazardSlow < 0.999;
      s.hero.pos.set(bridge.x, 0, bridge.z);
      s.hero.iFramesUntil = 0;
      s.hero.hazardSlow = 1;
      const bridgeHp = s.hero.hp;
      hazards.tickStageHazards(0.51);
      bridgeRuntimeSafe = s.hero.hp === bridgeHp && s.hero.hazardSlow >= 0.999;
    }
    const lifeMod = await import('./src/stageLife.js');
    const lifeBefore = lifeMod._debugStageLife().growthVisible;
    const forestTrialContract = id === 'forest' && s.run.forestPortalTrials
      ? {
          total: s.run.forestPortalTrials.total,
          cleared: s.run.forestPortalTrials.cleared,
          bossUnlocked: !!s.run.forestPortalTrials.bossUnlocked,
        }
      : null;
    // One canonical progression step must enrich the environment. Forest's
    // step is a cleared portal trial; other stages retain one collected shard.
    if (id === 'forest' && s.run.forestPortalTrials) {
      const firstRoom = Object.keys(s.run.forestPortalTrials.rooms || {})[0];
      if (firstRoom) s.run.forestPortalTrials.rooms[firstRoom].status = 'CLEARED';
      s.run.forestPortalTrials.cleared = 1;
    }
    s.run.portalShards = 1;
    lifeMod.tickStageLife(0.06);
    const lifeAfter = lifeMod._debugStageLife().growthVisible;
    if (id === 'forest' && s.run.forestPortalTrials) {
      const firstRoom = Object.keys(s.run.forestPortalTrials.rooms || {})[0];
      if (firstRoom) s.run.forestPortalTrials.rooms[firstRoom].status = 'AVAILABLE';
      s.run.forestPortalTrials.cleared = 0;
    }
    s.run.portalShards = 0;
    lifeMod.tickStageLife(0.06);
    function lifeHash() {
      const lifeRoot = scene.getObjectByName('__stageLife');
      const mesh = lifeRoot && lifeRoot.getObjectByName(`stageLife_${id}_growth`);
      const total = lifeRoot && lifeRoot.userData && lifeRoot.userData.counts && lifeRoot.userData.counts.growth || 0;
      if (!mesh || !total) return 0;
      const matrix = new THREE.Matrix4();
      let hash = 2166136261 >>> 0;
      for (let i = 0; i < total; i++) {
        mesh.getMatrixAt(i, matrix);
        for (let j = 0; j < 16; j++) {
          hash ^= Math.round(matrix.elements[j] * 1000);
          hash = Math.imul(hash, 16777619) >>> 0;
        }
      }
      return hash >>> 0;
    }
    lifeMod.loadStageLife(id, scene);
    const lifeHashA = lifeHash();
    lifeMod.loadStageLife(id, scene);
    const lifeHashB = lifeHash();
    const lifeDebug = lifeMod._debugStageLife();
    const explorationData = await import('./src/stageExplorationLayout.js');
    let minDiscoveryGrowthClearance = Infinity;
    let minGrowthCoreClearance = Infinity;
    if (id !== 'forest') {
      const growth = scene.getObjectByName(`stageLife_${id}_growth`);
      const matrix = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      if (growth) {
        for (let i = 0; i < growth.count; i++) {
          growth.getMatrixAt(i, matrix);
          pos.setFromMatrixPosition(matrix);
          for (const p of explorationData.DISCOVERY_PROFILES[id].placements) {
            minDiscoveryGrowthClearance = Math.min(minDiscoveryGrowthClearance, Math.hypot(pos.x - p[0], pos.z - p[1]));
          }
          for (const p of explorationData.getStageGrowthCoreKeepouts(id)) {
            minGrowthCoreClearance = Math.min(minGrowthCoreClearance, Math.hypot(pos.x - p.x, pos.z - p.z) - p.r);
          }
        }
      }
    }
    let yarnInteractive = id !== 'forest';
    if (id === 'forest' && lifeDebug.firstYarn) {
      const heroBeforeYarn = s.hero.pos.clone();
      s.hero.pos.set(lifeDebug.firstYarn.x, 0, lifeDebug.firstYarn.z);
      lifeMod.tickStageLife(0.06);
      yarnInteractive = lifeMod._debugStageLife().yarnFound === lifeDebug.yarnFound + 1;
      s.hero.pos.copy(heroBeforeYarn);
    }
    let discoveryInteractive = id === 'forest';
    let discoverySynergy = id === 'forest';
    let discoveryNegativeGate = true;
    let discoveryCompletion = id === 'forest';
    let discoveryReroll = id === 'forest';
    let mobileDiscovery = id !== 'cave';
    let caveVaultSynergy = id !== 'cave';
    let allBallistasActivated = id !== 'cinder';
    let voidOverchargeApplied = id !== 'void';
    let discoveryFoundAfter = id === 'forest' ? 1 : 0;
    let discoverySynergyDetail = id === 'forest' ? 'forest-yarn' : '';
    if (id !== 'forest' && lifeDebug.firstDiscovery) {
      const heroBeforeDiscovery = s.hero.pos.clone();
      s.hero.pos.set(lifeDebug.firstDiscovery.x, 0, lifeDebug.firstDiscovery.z);
      if (id === 'cinder' || id === 'cave') {
        s.hero.dashUntil = 0;
        s.input.interactPressed = false;
        lifeMod.tickStageLife(0.016);
        discoveryNegativeGate = lifeMod._debugStageLife().discoveryFound === lifeDebug.discoveryFound;
      }
      if (id === 'cinder') s.hero.dashUntil = s.time.real + 1;
      if (id === 'cave') s.input.interactPressed = true;
      lifeMod.tickStageLife(0.016);
      s.input.interactPressed = false;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const afterDiscovery = lifeMod._debugStageLife();
      discoveryFoundAfter = afterDiscovery.discoveryFound;
      discoveryInteractive = afterDiscovery.discoveryFound === lifeDebug.discoveryFound + 1;
      if (id === 'twilight') {
        discoverySynergy = !!(s.run.fountainSpeedBuff && s.run.fountainSpeedBuff.mul >= 1.28);
        discoverySynergyDetail = JSON.stringify(s.run.fountainSpeedBuff || null);
      } else if (id === 'cinder') {
        const cinderMod = await import('./src/cinderBallistas.js');
        discoverySynergy = cinderMod._debugBallistas().some((b) => b.activated);
        discoverySynergyDetail = cinderMod._debugBallistas().map((b) => b.state).join(',');
      } else if (id === 'void') {
        const voidMod = await import('./src/voidTeleportPads.js');
        discoverySynergy = voidMod._debugStarCharges() >= 1;
        discoverySynergyDetail = `charges=${voidMod._debugStarCharges()}`;
      } else if (id === 'cave') {
        discoverySynergy = s.run.caveEchoCredits === 8;
        discoverySynergyDetail = String(s.run.caveEchoCredits);
      }

      const rerollsBeforeCompletion = s.hero.rerolls || 0;
      const placements = explorationData.DISCOVERY_PROFILES[id].placements;
      for (let i = 1; i < placements.length; i++) {
        const p = placements[i];
        s.hero.pos.set(p[0], 0, p[1]);
        if (id === 'cinder') s.hero.dashUntil = s.time.real + 1 + i * 0.01;
        if (id === 'cave') {
          if (i === 1) {
            history.replaceState({}, '', `${location.pathname}?smoke=landscape-${id}&touch=1`);
            s.input.interactPressed = false;
          } else {
            history.replaceState({}, '', `${location.pathname}?smoke=landscape-${id}`);
            s.input.interactPressed = true;
          }
        }
        const before = lifeMod._debugStageLife().discoveryFound;
        lifeMod.tickStageLife(0.016);
        s.input.interactPressed = false;
        if (id === 'cave' && i === 1) {
          mobileDiscovery = lifeMod._debugStageLife().discoveryFound === before + 1;
        }
      }
      history.replaceState({}, '', `${location.pathname}?smoke=landscape-${id}`);
      const completedDiscovery = lifeMod._debugStageLife();
      discoveryCompletion = completedDiscovery.discoveryFound === placements.length;
      discoveryReroll = (s.hero.rerolls || 0) === rerollsBeforeCompletion + 1;
      if (id === 'cinder') {
        const cinderMod = await import('./src/cinderBallistas.js');
        allBallistasActivated = cinderMod._debugBallistas().filter((b) => b.activated).length === placements.length;
      }
      if (id === 'cave') {
        s.run.kills = 32;
        const vaultMod = await import('./src/stages/cave/caveVault.js');
        vaultMod.tickCaveVault(0.016);
        caveVaultSynergy = vaultMod.getCaveVaultState().opened && s.run.caveEchoCredits === 48;
      }
      if (id === 'void') {
        const voidMod = await import('./src/voidTeleportPads.js');
        const pads = voidMod._debugPads();
        const chargesBefore = voidMod._debugStarCharges();
        for (const pad of pads) { pad.cooldownUntil = 0; pad.localStepGuard = 0; }
        if (pads.length >= 2) {
          s.hero.pos.set(pads[0].x, 0, pads[0].z);
          voidMod.tickVoidTeleportPads(0.016, s);
          voidOverchargeApplied = voidMod._debugStarCharges() === chargesBefore - 1
            && pads[0].cooldownUntil - s.time.game <= 1.01;
        }
      }
      s.hero.pos.copy(heroBeforeDiscovery);
    }
    const destructibleMod = await import('./src/destructibles.js');
    const destructibleDebug = destructibleMod._debugDestructibles();
    destructibleMod.resetDestructibles();
    const destructibleReplay = destructibleMod._debugDestructibles();
    const destructibleDeterministic = destructibleDebug.placementHash === destructibleReplay.placementHash;
    const explorationLayout = await import('./src/stageExplorationLayout.js');
    const keepouts = explorationLayout.getStageExplorationKeepouts(id);
    let minSecretKeepoutClearance = Infinity;
    for (const secret of destructibleReplay.locations || []) {
      for (const keepout of keepouts) {
        minSecretKeepoutClearance = Math.min(
          minSecretKeepoutClearance,
          Math.hypot(secret.x - keepout.x, secret.z - keepout.z) - keepout.r,
        );
      }
    }
    let destructibleInteractive = id === 'forest';
    let destructibleIdempotent = id === 'forest';
    let destructibleModeGate = id === 'forest';
    if (id !== 'forest' && destructibleReplay.locations.length >= 6) {
      const secretRoot = scene.getObjectByName('__dashSmashSecrets');
      const first = destructibleReplay.locations[0];
      s.mode = 'catacomb';
      destructibleMod.syncDestructiblesVisibility();
      destructibleModeGate = destructibleMod.smashLogsInRadius(first.x, first.z, 0.7) === 0
        && !!secretRoot && secretRoot.visible === false;
      s.mode = 'run';
      destructibleMod.syncDestructiblesVisibility();
      let broken = 0;
      for (const secret of destructibleReplay.locations.slice(0, 6)) {
        broken += destructibleMod.smashLogsInRadius(secret.x, secret.z, 0.7);
      }
      destructibleInteractive = broken === 6
        && s.run.stageSecretsBroken === 6
        && destructibleMod._debugDestructibles().alive === destructibleReplay.alive - 6;
      destructibleIdempotent = destructibleMod.smashLogsInRadius(first.x, first.z, 0.7) === 0;
    }
    const map = document.getElementById('kk-portal-minimap');
    return {
      stage: s.run.stage.id,
      calls: canonicalCalls,
      triangles: canonicalTriangles,
      arenaDecor: !!scene.getObjectByName('__arenaDecor'),
      landscape: !!root,
      instanced,
      landscapeInstanced,
      purposes: [...purposes],
      route,
      water,
      interactiveOwner,
      realHazard,
      fakeFloorTell,
      facingDot,
      minPropClearance,
      minShelfClearance,
      terrainCut,
      terrainCrossing,
      terrainBelowActors,
      bridgeAsset,
      bridgeSafe: !!(bridgeSample && bridgeSample.inside && bridgeSample.safe && !bridgeSample.active),
      terrainActiveOffBridge: !!(offSample && offSample.active),
      terrainRuntimeActive,
      bridgeRuntimeSafe,
      outerLandmarks,
      stageLife: !!stageLife,
      stageLifeGrowth: stageLifeCounts.growth || 0,
      stageLifePaws: stageLifeCounts.paws || 0,
      stageLifeAmbient: stageLifeCounts.ambient || 0,
      stageLifeYarn: stageLifeCounts.yarn || 0,
      stageLifeDiscoveries: stageLifeCounts.discoveries || 0,
      stageLifeBatches: stageLifeCounts.drawBatches || 0,
      debugYarn: lifeDebug.yarn || 0,
      debugDiscoveries: lifeDebug.discoveries || 0,
      discoveryKind: lifeDebug.discoveryKind || '',
      discoveryTrigger: lifeDebug.discoveryTrigger || '',
      discoveryInteractive,
      discoverySynergy,
      discoveryNegativeGate,
      discoveryCompletion,
      discoveryReroll,
      mobileDiscovery,
      caveVaultSynergy,
      allBallistasActivated,
      voidOverchargeApplied,
      minDiscoveryGrowthClearance,
      minGrowthCoreClearance,
      discoveryFoundAfter,
      discoverySynergyDetail,
      yarnInteractive,
      destructibleCount: destructibleDebug.count || 0,
      destructibleRooms: destructibleDebug.roomCount || 0,
      destructiblePurpose: destructibleDebug.purpose || '',
      destructibleKind: destructibleDebug.secretKind || '',
      destructibleDeterministic,
      minSecretKeepoutClearance,
      destructibleInteractive,
      destructibleIdempotent,
      destructibleModeGate,
      groundDetail: id === 'forest'
        ? groundSrc.includes('ground_detail_forest_512.webp')
        : groundSrc.includes(`ground_detail_${id}_512.webp`),
      ambientSprite: ambientSrc.includes({
        forest: 'ambient_butterfly_256.webp',
        twilight: 'ambient_moon_moth_256.webp',
        cinder: 'ambient_ember_moth_256.webp',
        void: 'ambient_star_kitten_256.webp',
        cave: 'ambient_glowbat_256.webp',
      }[id]),
      ambientDecoded: !!(ambientImage && ambientImage.complete && ambientImage.naturalWidth === 256 && ambientImage.naturalHeight === 256),
      ambientAlphaConfig: !!(lifeAmbient && lifeAmbient.material
        && lifeAmbient.material.transparent
        && lifeAmbient.material.alphaTest > 0
        && lifeAmbient.material.depthWrite === false),
      progressionGrowth: lifeAfter > lifeBefore,
      forestTrialContract,
      stageLifeDeterministic: lifeHashA !== 0 && lifeHashA === lifeHashB,
      minimapVisible: !!map && map.style.display === 'block',
      minimapDraws: map ? Number(map.dataset.drawCount || 0) : 0,
      minimapMarkers: map ? Number(map.dataset.shardMarkers || 0) : 0,
      minimapBossPortal: map ? map.dataset.bossPortal : '',
      minimapProfile: map ? map.dataset.profile : '',
    };
  }, stage);
  return { ...result, ...errors };
}

async function main() {
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(CHROME)) {
    console.error('[smoke-stage-landscapes] Playwright/Chromium missing');
    process.exit(2);
  }
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const failures = [];
  try {
    for (const stage of STAGES) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
        status: 200, contentType: 'text/css', body: '',
      }));
      await ctx.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
      const page = await ctx.newPage();
      const errors = { pageErrors: [], consoleErrors: [], httpErrors: [] };
      page.on('pageerror', (e) => errors.pageErrors.push(e.message));
      page.on('console', (m) => {
        const text = m.text();
        const externalResourceNoise = /Failed to load resource: net::ERR_(?:TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/.test(text);
        if (m.type() === 'error' && !externalResourceNoise) errors.consoleErrors.push(text);
      });
      page.on('response', (r) => { if (r.status() >= 400) errors.httpErrors.push(`${r.status()} ${r.url()}`); });
      try {
        const p = await probe(page, stage, errors);
        const stageFailures = checkStage(stage, p);
        failures.push(...stageFailures.map((f) => `${stage}: ${f}`));
        console.log(`${stage.padEnd(8)} calls=${String(p.calls).padStart(3)} tris=${String(Math.round(p.triangles / 1000)).padStart(4)}k instanced=${String(p.instanced).padStart(3)} water=${p.water} landscape=${p.landscape} owner=${p.interactiveOwner} ${stageFailures.length ? 'FAIL' : 'PASS'}`);
      } catch (e) {
        failures.push(`${stage}: ${e && e.message ? e.message : String(e)}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) {
    console.error('\n[smoke-stage-landscapes] FAIL');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  const label = STAGES.length === ALL_STAGES.length ? 'all five stages' : STAGES.join(', ');
  console.log(`\n[smoke-stage-landscapes] PASS — ${label} boot cleanly with authored, batched landscapes`);
}

main().catch((e) => { console.error('[smoke-stage-landscapes] FATAL', e); process.exit(2); });
