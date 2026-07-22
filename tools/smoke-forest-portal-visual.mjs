#!/usr/bin/env node
/**
 * Forest trial-gate visual + travel-fairness regression smoke.
 *
 * Verifies that every Forest portal is backed by the one cached authored GLB,
 * uses a physical 3D arch instead of a giant billboard, and exposes visibly
 * distinct AVAILABLE / SEALED / CLEARED compositions. It also exercises the
 * real E-key path at 1 HP with hostile contact and a projectile armed on the
 * departure frame: portal travel and arrival i-frames must resolve first.
 *
 * Run:
 *   node tools/smoke-forest-portal-visual.mjs
 *   SHOTS=1 node tools/smoke-forest-portal-visual.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8952);
const TIMEOUT = 90000;
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function mime(file) {
  if (/\.m?js$/.test(file)) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(file)) return 'image/jpeg';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (error, data) => {
    if (error) { res.writeHead(404); res.end(`not found: ${rel}`); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function assertLoopOrdering(failures) {
  const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const needle = (text) => source.lastIndexOf(text);
  const points = {
    portal: needle('tickForestPortals(logicDt, state)'),
    room: needle('_tickForestRoomTransition(logicDt)'),
    spawn: needle('tickSpawnDirector(logicDt)'),
    enemies: needle('updateEnemies(logicDt)'),
    projectiles: needle('updateEnemyProjectiles(logicDt)'),
    hazards: needle('tickStageHazards(logicDt)'),
  };
  const present = Object.values(points).every((value) => value >= 0);
  const ordered = present
    && points.portal < points.room
    && points.room < points.spawn
    && points.spawn < points.enemies
    && points.enemies < points.projectiles
    && points.projectiles < points.hazards;
  assert(ordered,
    `Forest fairness ordering regressed: ${JSON.stringify(points)}`,
    failures);
  return points;
}

async function main() {
  const failures = [];
  const ordering = assertLoopOrdering(failures);
  if (!fs.existsSync(PLAYWRIGHT) || !fs.existsSync(CHROMIUM)) {
    console.error('[smoke-forest-portal-visual] FAIL: Playwright/Chromium missing');
    process.exit(2);
  }

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/css', body: '',
  }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({
    status: 204, body: '',
  }));
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const httpErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    const externalResourceNoise = /Failed to load resource: net::ERR_(?:TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/.test(text);
    if (message.type() === 'error' && !externalResourceNoise) consoleErrors.push(text);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });

  let visual = null;
  let fairness = null;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=forest-portal-visual`, {
      waitUntil: 'load', timeout: TIMEOUT,
    });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState,
      null, { timeout: TIMEOUT });
    await page.evaluate(async () => {
      const meta = await import('/src/meta.js');
      meta.setOption('optDevUnlockAllLevels', true);
      meta.setOption('selectedStage', 'forest');
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      window.kkState.weapons.length = 0;
      await window.kkStartRun();
    });
    await page.waitForFunction(async () => {
      const s = window.kkState;
      if (!(s && s.started && s.run && s.run.stage && s.run.stage.id === 'forest')) return false;
      const portals = await import('/src/forestPortals.js');
      return portals.getForestPortals().length === 12;
    }, null, { timeout: TIMEOUT });
    await page.waitForTimeout(1500);

    visual = await page.evaluate(async () => {
      const THREE = await import('three');
      const assets = await import('/src/assets.js');
      const portalsMod = await import('/src/forestPortals.js');
      const sealed = await import('/src/forestSealedDoors.js');
      const s = window.kkState;
      s.time.paused = true;

      const records = portalsMod.getForestPortals();
      const cache = assets.GLTF_CACHE.forest_trial_gate;
      const sourceGeometries = new Set();
      let sourceDrawables = 0;
      if (cache && cache.scene) cache.scene.traverse((object) => {
        if (!object.isMesh) return;
        sourceDrawables++;
        if (object.geometry) sourceGeometries.add(object.geometry);
      });

      const archGeometries = new Set();
      const contract = records.map((portal) => {
        let archDrawables = 0;
        if (portal.gateArch) portal.gateArch.traverse((object) => {
          if (!object.isMesh) return;
          archDrawables++;
          if (object.geometry) archGeometries.add(object.geometry);
        });
        const giantSprites = [];
        if (portal.entGroup) portal.entGroup.traverse((object) => {
          if (!object.isSprite || object.visible === false) return;
          const maxScale = Math.max(Math.abs(object.scale.x), Math.abs(object.scale.y));
          if (maxScale > 2.5) giantSprites.push({ name: object.name, maxScale });
        });
        return {
          id: portal.id,
          key: portal.authoredGateAssetKey || null,
          assetFallback: !!(portal.gateGroup && portal.gateGroup.userData.assetFallback),
          groupName: portal.gateGroup && portal.gateGroup.name,
          archName: portal.gateArch && portal.gateArch.name,
          veilName: portal.gateVeil && portal.gateVeil.name,
          shuttersName: portal.gateShutters && portal.gateShutters.name,
          bloomName: portal.gateBloom && portal.gateBloom.name,
          archDrawables,
          veilIsMesh: !!(portal.gateVeil && portal.gateVeil.isMesh),
          giantSprites,
          legacyBeaconDominant: !!(portal.beaconMesh && portal.beaconMesh.visible !== false
            && portal.beaconMesh.isSprite
            && Math.max(portal.beaconMesh.scale.x, portal.beaconMesh.scale.y) > 2.5),
        };
      });

      const outbound = records.find((portal) => portal.kind === 'outbound');
      const matchingReturn = outbound
        ? records.find((portal) => portal.kind === 'return' && portal.roomId === outbound.destRoomId)
        : null;

      function ownVisibility(portal) {
        const veil = portal.gateVeil;
        if (veil && veil.geometry && !veil.geometry.boundingBox) veil.geometry.computeBoundingBox();
        const box = veil && veil.geometry && veil.geometry.boundingBox;
        const veilWidth = box ? Math.abs(box.max.x - box.min.x) * Math.abs(veil.scale.x || 1) : null;
        let bloomLayerDrawables = 0;
        if (portal.gateBloom) portal.gateBloom.traverse((object) => {
          if (object.isMesh && object.layers && (object.layers.mask & (1 << 1))) bloomLayerDrawables++;
        });
        let archBloomDrawables = 0;
        let archMainDrawables = 0;
        if (portal.gateArch) portal.gateArch.traverse((object) => {
          if (!object.isMesh) return;
          if (object.layers && (object.layers.mask & (1 << 1))) archBloomDrawables++;
          if (object.layers && (object.layers.mask & 1)) archMainDrawables++;
        });
        let shutterShadowDrawables = 0;
        if (portal.gateShutters) portal.gateShutters.traverse((object) => {
          if (object.isMesh && (object.castShadow || object.receiveShadow)) shutterShadowDrawables++;
        });
        return {
          state: portal.gateVisualState || null,
          arch: !!(portal.gateArch && portal.gateArch.visible !== false),
          veil: !!(veil && veil.visible !== false),
          shutters: !!(portal.gateShutters && portal.gateShutters.visible !== false),
          bloom: !!(portal.gateBloom && portal.gateBloom.visible !== false),
          veilIsMesh: !!(veil && veil.isMesh),
          veilIsSprite: !!(veil && veil.isSprite),
          veilWidth,
          veilDepthTest: veil && veil.material ? veil.material.depthTest : null,
          veilDepthWrite: veil && veil.material ? veil.material.depthWrite : null,
          veilTransparent: veil && veil.material ? veil.material.transparent : null,
          veilBlending: veil && veil.material ? veil.material.blending : null,
          veilOpacity: veil && veil.material && veil.material.uniforms?.uOpacity
            ? veil.material.uniforms.uOpacity.value : null,
          veilRenderOrder: veil ? veil.renderOrder : null,
          veilBloom: !!(veil && veil.layers && (veil.layers.mask & (1 << 1))),
          bloomLayer: bloomLayerDrawables > 0,
          bloomLayerDrawables,
          archBloomDrawables,
          archMainDrawables,
          shutterShadowDrawables,
        };
      }

      const states = {};
      if (outbound && typeof portalsMod.setForestPortalGateState === 'function') {
        for (const status of ['AVAILABLE', 'SEALED', 'CLEARED']) {
          portalsMod.setForestPortalGateState(outbound, status);
          states[status] = ownVisibility(outbound);
        }
      }

      // Prove ordinary progression paths drive the same authored state seam.
      const integration = {};
      if (outbound && matchingReturn) {
        const trialRec = s.run.forestPortalTrials.rooms[outbound.destRoomId];
        trialRec.status = 'AVAILABLE';
        portalsMod.tickForestPortals(0.016, s);
        integration.availableOutbound = outbound.gateVisualState || null;

        trialRec.status = 'ACTIVE';
        s.run.currentRoom = outbound.destRoomId;
        sealed.onRoomEnter(outbound.destRoomId);
        integration.sealedReturn = matchingReturn.gateVisualState || null;

        trialRec.status = 'CLEARED';
        sealed.onRoomEnter(outbound.destRoomId);
        s.run.currentRoom = 'glade';
        portalsMod.tickForestPortals(0.016, s);
        integration.clearedOutbound = outbound.gateVisualState || null;
        integration.clearedReturn = matchingReturn.gateVisualState || null;

        // Rebuilt/hot-reloaded return gates initialize AVAILABLE and are not
        // marked sealed. Re-entering an already-cleared room must still
        // restore its persistent moonbloom state.
        portalsMod.setForestPortalGateState(matchingReturn, 'AVAILABLE', true);
        matchingReturn._sealed = false;
        sealed.onRoomEnter(outbound.destRoomId);
        integration.freshClearedReturn = matchingReturn.gateVisualState || null;
      }

      return {
        cache: {
          exists: !!(cache && cache.scene),
          sourceDrawables,
          sourceGeometries: sourceGeometries.size,
          archGeometries: archGeometries.size,
        },
        portalCount: records.length,
        contract,
        states,
        integration,
        setterExported: typeof portalsMod.setForestPortalGateState === 'function',
        threeRevision: THREE.REVISION,
        normalBlending: THREE.NormalBlending,
      };
    });

    assert(visual.cache.exists, 'forest_trial_gate is not present in GLTF_CACHE', failures);
    assert(visual.cache.sourceDrawables >= 1,
      `authored gate cache has no meshes: ${JSON.stringify(visual.cache)}`, failures);
    assert(visual.portalCount === 12, `portal count=${visual.portalCount}, expected 12`, failures);
    assert(visual.setterExported, 'setForestPortalGateState export missing', failures);
    for (const item of visual.contract) {
      assert(item.key === 'forest_trial_gate', `${item.id}: authored asset key=${item.key}`, failures);
      assert(item.assetFallback === false,
        `${item.id}: authored GLB nodes missing; procedural fallback is active`, failures);
      assert(item.groupName === 'forestTrialGate', `${item.id}: gate group=${item.groupName}`, failures);
      assert(item.archName === 'forestTrialGateArch' && item.archDrawables >= 1,
        `${item.id}: physical arch invalid ${JSON.stringify(item)}`, failures);
      assert(item.veilName === 'forestTrialGateVeil' && item.veilIsMesh,
        `${item.id}: physical veil invalid ${JSON.stringify(item)}`, failures);
      assert(item.shuttersName === 'forestTrialGateShutters',
        `${item.id}: shutters missing ${JSON.stringify(item)}`, failures);
      assert(item.bloomName === 'forestTrialGateBloom',
        `${item.id}: cleared bloom missing ${JSON.stringify(item)}`, failures);
      assert(item.giantSprites.length === 0 && !item.legacyBeaconDominant,
        `${item.id}: giant sprite still dominates gate ${JSON.stringify(item)}`, failures);
    }
    assert(visual.cache.archGeometries <= Math.max(4, visual.cache.sourceGeometries + 1),
      `portal clones duplicate authored geometry: ${JSON.stringify(visual.cache)}`, failures);

    const expected = {
      AVAILABLE: { arch: true, veil: true, shutters: false, bloom: false },
      SEALED: { arch: true, veil: false, shutters: true, bloom: false },
      CLEARED: { arch: true, veil: true, shutters: false, bloom: true },
    };
    for (const [status, visibility] of Object.entries(expected)) {
      const actual = visual.states[status];
      assert(actual && actual.state === status,
        `${status}: visual state not published ${JSON.stringify(actual)}`, failures);
      for (const [part, visible] of Object.entries(visibility)) {
        assert(actual && actual[part] === visible,
          `${status}: ${part} visibility=${actual && actual[part]}, expected ${visible}`, failures);
      }
    }
    const available = visual.states.AVAILABLE;
    assert(available && available.veilIsMesh && !available.veilIsSprite,
      `available veil is not physical mesh: ${JSON.stringify(available)}`, failures);
    assert(available && available.veilWidth > 0.4 && available.veilWidth <= 2.35,
      `veil width dominates/vanishes: ${JSON.stringify(available)}`, failures);
    assert(available && available.veilDepthTest === true && available.veilDepthWrite === false
      && available.veilTransparent === true && available.veilRenderOrder <= 3
      && available.veilBlending === visual.normalBlending,
    `veil layering invalid: ${JSON.stringify(available)}`, failures);
    assert(available && !available.veilBloom && available.archMainDrawables >= 1
      && available.archBloomDrawables === 0,
    `arch/veil main-pass isolation invalid: ${JSON.stringify(available)}`, failures);
    assert(visual.states.CLEARED && visual.states.CLEARED.bloomLayer,
      `cleared accent is not on bloom layer: ${JSON.stringify(visual.states.CLEARED)}`, failures);
    assert(visual.states.SEALED && visual.states.SEALED.shutterShadowDrawables === 0,
      `sealed lattice projects oversized state shadows: ${JSON.stringify(visual.states.SEALED)}`, failures);
    assert(visual.integration.availableOutbound === 'AVAILABLE'
      && visual.integration.sealedReturn === 'SEALED'
      && visual.integration.clearedOutbound === 'CLEARED'
      && visual.integration.clearedReturn === 'CLEARED'
      && visual.integration.freshClearedReturn === 'CLEARED',
    `progression did not drive gate states: ${JSON.stringify(visual.integration)}`, failures);

    // Re-prime one AVAILABLE outbound gate and arm both hostile collision paths
    // at its origin. A capture-phase hook unpauses on the physical E keydown so
    // hero.js sees the real edge and no damage frame can sneak in beforehand.
    const armed = await page.evaluate(async () => {
      const enemies = await import('/src/enemies.js');
      const projectiles = await import('/src/enemyProjectiles.js');
      const config = await import('/src/config.js');
      const portalsMod = await import('/src/forestPortals.js');
      const s = window.kkState;
      s.time.paused = true;
      projectiles.clearEnemyProjectiles();
      for (const enemy of [...s.enemies.active]) {
        try { s.enemies.spatial.remove(enemy); } catch (_) {}
        try { enemies.releaseEnemyVisual(enemy); } catch (_) {}
      }
      s.enemies.active.length = 0;

      const portal = portalsMod.getForestPortals().find((item) => item.kind === 'outbound');
      const rec = portal && s.run.forestPortalTrials.rooms[portal.destRoomId];
      if (!portal || !rec) return null;
      rec.status = 'AVAILABLE';
      rec.phase = 'IDLE';
      portal.cooldownUntil = 0;
      portal.localStepGuard = 0;
      if (typeof portalsMod.setForestPortalGateState === 'function') {
        portalsMod.setForestPortalGateState(portal, 'AVAILABLE');
      }
      s.run.currentRoom = 'glade';
      s.run.forestTrialActive = false;
      s.run._forestPortalTransfer = null;
      s.gameOver = false;
      s.pendingLevelUp = false;
      s.hero.hp = 1;
      s.hero.regenPerSec = 0;
      s.hero.iFramesUntil = 0;
      s.hero._dashIFramesUntil = 0;
      s.run.passive_regen = 0;
      s.run.signature_nineLives = null;
      s.run.secondWindAvailable = false;
      s.hero.pos.set(portal.x, 0, portal.z);
      s.hero.vel.set(0, 0, 0);
      if (s.hero.mesh) s.hero.mesh.position.set(portal.x, s.hero.mesh.position.y, portal.z);

      const tier = config.ENEMY_TIERS.find((item) => !item.elite && !item.dungeon);
      const contact = tier ? enemies.spawnEnemy(tier, portal.x, portal.z) : null;
      if (contact) {
        contact.spd = 0;
        contact.dmg = 999;
        contact.contactCooldown = 0;
      }
      const projectile = projectiles.spawnEnemyProjectile(
        portal.x, 0.86, portal.z, 999, 0, 3, 'magic', 1, 0,
      );

      window.__portalFairnessTarget = portal.destRoomId;
      window.__portalFairnessStartGameT = s.time.game;
      window.addEventListener('keydown', (event) => {
        if (event.code === 'KeyE') s.time.paused = false;
      }, { capture: true, once: true });
      return {
        portalId: portal.id,
        targetRoom: portal.destRoomId,
        contactArmed: !!contact,
        projectileArmed: !!projectile,
      };
    });
    assert(armed && armed.contactArmed && armed.projectileArmed,
      `could not arm portal fairness threats: ${JSON.stringify(armed)}`, failures);
    if (armed) {
      await page.keyboard.press('e');
      await page.waitForFunction((targetRoom) => {
        const s = window.kkState;
        return s.run.currentRoom === targetRoom
          && s.hero.hp > 0
          && s.hero.iFramesUntil > s.time.game;
      }, armed.targetRoom, { timeout: 5000 });
      fairness = await page.evaluate(() => {
        const s = window.kkState;
        return {
          hp: s.hero.hp,
          gameOver: s.gameOver,
          room: s.run.currentRoom,
          targetRoom: window.__portalFairnessTarget,
          transferConsumed: s.run._forestPortalTransfer == null,
          iFramesRemaining: s.hero.iFramesUntil - s.time.game,
          movedFromOrigin: s.run.currentRoom !== 'glade',
        };
      });
      assert(fairness.hp > 0 && !fairness.gameOver,
        `hero died on portal activation frame: ${JSON.stringify(fairness)}`, failures);
      assert(fairness.room === fairness.targetRoom && fairness.transferConsumed && fairness.movedFromOrigin,
        `portal transfer did not finish atomically: ${JSON.stringify(fairness)}`, failures);
      assert(fairness.iFramesRemaining > 0,
        `arrival i-frames missing on transfer frame: ${JSON.stringify(fairness)}`, failures);
    }

    if (process.env.SHOTS) {
      // Close, deterministic art-review frames for every physical state. The
      // former post-transfer screenshot caught only the camera's old room and
      // let a selective-bloom blowout pass unnoticed.
      const shotGateId = await page.evaluate(async () => {
        const THREE = await import('three');
        const hostile = await import('/src/enemyProjectiles.js');
        const portalsMod = await import('/src/forestPortals.js');
        const s = window.kkState;
        hostile.clearEnemyProjectiles();
        s.time.paused = true;
        s.gameOver = false;
        const gate = portalsMod.getForestPortals().find((item) => item.kind === 'outbound');
        if (!gate) return null;
        for (const portal of portalsMod.getForestPortals()) {
          if (portal.entGroup) portal.entGroup.visible = portal === gate;
        }
        // Isolate the physical landmark on a lit neutral Forest pad. Hero,
        // trees, and nearby buildings previously hid most of the aperture and
        // made a broken state overlay look acceptable in the review frame.
        for (const root of s.scene.children) {
          if (root === gate.entGroup.parent || root.isCamera || root.isLight) continue;
          let ownsLight = false;
          root.traverse?.((node) => { if (node.isLight) ownsLight = true; });
          if (!ownsLight) root.visible = false;
        }
        if (s.hero.mesh) s.hero.mesh.visible = false;
        const reviewPad = new THREE.Mesh(
          new THREE.PlaneGeometry(16, 16),
          new THREE.MeshStandardMaterial({ color: 0x718b65, roughness: 1 }),
        );
        reviewPad.name = '__forestGateReviewPad';
        reviewPad.rotation.x = -Math.PI / 2;
        reviewPad.position.set(gate.x, -0.015, gate.z);
        reviewPad.receiveShadow = true;
        s.scene.add(reviewPad);
        const camera = s.camera;
        const aspect = innerWidth / innerHeight;
        camera.position.set(gate.x + 6.4, 8.8, gate.z + 6.4);
        camera.lookAt(gate.x, 1.15, gate.z);
        camera.left = -4.5 * aspect;
        camera.right = 4.5 * aspect;
        camera.top = 4.5;
        camera.bottom = -4.5;
        camera.zoom = 1;
        camera.updateProjectionMatrix();
        document.querySelectorAll(
          '#kk-stage-rule-banner,.kk-shared-banner,#kk-boss-intro-banner,#kk-forest-bossbars,#kk-forest-portal-minimap',
        ).forEach((element) => { element.style.display = 'none'; });
        portalsMod.setForestPortalGateState(gate, 'AVAILABLE', true);
        window.__shotGate = gate;
        return gate.id;
      });
      if (shotGateId) {
        await page.waitForTimeout(120);
        await page.screenshot({ path: '/tmp/kks-forest-gate-available.png', fullPage: false });
        for (const status of ['SEALED', 'CLEARED']) {
          await page.evaluate(async (nextState) => {
            const portalsMod = await import('/src/forestPortals.js');
            portalsMod.setForestPortalGateState(window.__shotGate, nextState, true);
          }, status);
          await page.waitForTimeout(120);
          await page.screenshot({
            path: `/tmp/kks-forest-gate-${status.toLowerCase()}.png`,
            fullPage: false,
          });
        }
      }
    }
  } catch (error) {
    failures.push(`exception: ${error && error.stack ? error.stack : String(error)}`);
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }

  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length) failures.push(`console errors: ${consoleErrors.join(' | ')}`);
  if (httpErrors.length) failures.push(`HTTP errors: ${httpErrors.join(' | ')}`);
  console.log(JSON.stringify({ ordering, visual, fairness }, null, 2));
  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error(`[smoke-forest-portal-visual] FAIL (${failures.length})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('[smoke-forest-portal-visual] PASS — authored physical gates, distinct states, restrained layering, and same-frame travel fairness hold');
}

main().catch((error) => {
  console.error('[smoke-forest-portal-visual] FATAL', error);
  process.exit(2);
});
