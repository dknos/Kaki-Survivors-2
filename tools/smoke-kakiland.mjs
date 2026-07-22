#!/usr/bin/env node
/**
 * Kaki Land progression smoke.
 *
 * Verifies the actual player route: menu-selected Kaki Land → all three trial
 * portals → main gate unlock → final-boss victory. Run from WSL where the
 * repository's bundled Playwright/Chromium are available.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8788);
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const TIMEOUT = 60000;
const EXPECTED_CAMERA_HALF = 15.5;
const EXPECTED_KAKI_SIGNATURES = Object.freeze({
  'kaki-ember': ['quake'],
  'kaki-tide': ['engulf'],
  'kaki-bloom': ['sonic'],
  'kaki-main': ['quake', 'engulf', 'sonic'],
});
const EXPECTED_KAKI_BOSS_ASSETS = Object.freeze({
  'kaki-ember': { glb: 'kaki_ember_warden', draws: 3, bloom: 1 },
  'kaki-tide': { glb: 'kaki_tideborn_wyrm', draws: 3, bloom: 1 },
  'kaki-bloom': { glb: 'kaki_bloom_colossus', draws: 3, bloom: 1 },
  'kaki-main': { glb: 'kaki_sovereign', draws: 6, bloom: 3 },
});
const EXPECTED_ESCALATED_PATTERNS = Object.freeze({
  'kaki-ember': ['quake', 'sonic'],
  'kaki-tide': ['engulf', 'sonic'],
  'kaki-bloom': ['sonic', 'quake'],
});
const EXPECTED_TRIAL_ADDS = Object.freeze({
  'kaki-ember': ['kaki_sparkmite', 'kaki_sparkmite', 'kaki_sparkmite'],
  'kaki-tide': ['kaki_tidesprite', 'kaki_tidesprite', 'kaki_tidesprite', 'kaki_tidesprite'],
  'kaki-bloom': ['kaki_bloomling', 'kaki_bloomling', 'kaki_bloomling'],
});

async function driveWardPhase(page, portalId, expectedAdds, expectedPhase, screenshotPath = null) {
  await page.evaluate(async (id) => {
    const s = window.kkState;
    // Adds should be free to demonstrate their real behavior without ending
    // the smoke through incidental player death.
    s.hero.hpMax = Math.max(s.hero.hpMax, 99999);
    s.hero.hp = s.hero.hpMax;
    const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && !enemy._kakiEncounterAdd);
    if (!boss) throw new Error(`boss ${id} missing before ward trigger`);
    const { damageEnemy } = await import('/src/enemies.js');
    damageEnemy(boss, boss.hpMax * 4, 'smoke_ward_gate');
  }, portalId);

  await page.waitForFunction(({ id, count }) => {
    const s = window.kkState;
    const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && !enemy._kakiEncounterAdd);
    const adds = s.enemies.active.filter((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && enemy._kakiEncounterAdd);
    return !!(boss && boss._encounterInvulnerable && adds.length === count);
  }, { id: portalId, count: expectedAdds.length }, { timeout: TIMEOUT });

  const ward = await page.evaluate(async (id) => {
    const s = window.kkState;
    const encounter = await import('/src/kakiLandBossEncounters.js');
    const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && !enemy._kakiEncounterAdd);
    const adds = s.enemies.active.filter((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && enemy._kakiEncounterAdd);
    const root = s.scene.getObjectByName('kakiLand_bossEncounterWard');
    const sigil = s.scene.getObjectByName('kakiLand_threefoldCrownSigil');
    const bossBars = document.getElementById('kk-forest-bossbars');
    return {
      debug: encounter.getKakiLandBossEncounterDebugState(),
      bossHpRatio: boss.hp / boss.hpMax,
      addIds: adds.map((enemy) => enemy.glbKey).sort(),
      addRoles: adds.map((enemy) => enemy._kakiEncounterRole).sort(),
      bloomlingWardHits: adds.filter((enemy) => enemy.glbKey === 'kaki_bloomling').map((enemy) => enemy._shieldHp),
      visualVisible: !!(root && root.visible),
      sigilMapped: !!(sigil && sigil.material && sigil.material.map),
      bossBarKaki: !!(bossBars && bossBars.classList.contains('kk-bb-kaki')),
      bossBarText: bossBars ? bossBars.textContent : '',
    };
  }, portalId);

  if (ward.addIds.join(',') !== [...expectedAdds].sort().join(',')
    || !ward.debug.shielded
    || ward.debug.addsAlive !== expectedAdds.length
    || !ward.visualVisible
    || !ward.sigilMapped) {
    die(`ward phase invalid for ${portalId}: ${JSON.stringify(ward)}`);
  }

  if (screenshotPath) {
    await page.evaluate((id) => {
      const s = window.kkState;
      for (const add of s.enemies.active) {
        if (!add || !add.alive || add.kakiLandPortalId !== id || !add._kakiEncounterAdd) continue;
        add.hpMax = 99999;
        add.hp = 99999;
      }
    }, portalId);
    // Let the camera intro clear so the actual encounter HUD + arena read.
    await page.waitForTimeout(1700);
    await page.waitForFunction(() => {
      const bars = document.getElementById('kk-forest-bossbars');
      return !!(bars && bars.classList.contains('kk-bb-kaki') && /WARD/.test(bars.textContent));
    }, null, { timeout: TIMEOUT });
    await page.screenshot({ path: screenshotPath, fullPage: false });
  }

  await page.evaluate(async (id) => {
    const s = window.kkState;
    const { killEnemy } = await import('/src/enemies.js');
    const adds = s.enemies.active.filter((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && enemy._kakiEncounterAdd);
    for (const add of [...adds]) killEnemy(add);
  }, portalId);
  await page.waitForFunction(({ id, phase }) => {
    const s = window.kkState;
    const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && !enemy._kakiEncounterAdd);
    return !!(boss && !boss._encounterInvulnerable && boss._kakiEncounterPhase === phase);
  }, { id: portalId, phase: expectedPhase }, { timeout: TIMEOUT });

  return page.evaluate((id) => {
    const s = window.kkState;
    const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id && !enemy._kakiEncounterAdd);
    return {
      phase: boss._kakiEncounterPhase,
      label: boss._kakiEncounterPhaseLabel,
      patterns: [...(boss._kakiPatternIds || [])],
      intervalMul: boss._kakiIntervalMul,
    };
  }, portalId);
}

function mime(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function die(message) {
  throw new Error(message);
}

async function waitForBoss(page, portalId, timeout = TIMEOUT) {
  await page.waitForFunction((id) => {
    const s = window.kkState;
    return !!(s && s.enemies && s.enemies.active && s.enemies.active.some((enemy) =>
      enemy && enemy.alive && enemy.kakiLandPortalId === id));
  }, portalId, { timeout });
}

async function enterPortal(page, portalId, x, z) {
  await page.evaluate(({ x, z }) => {
    const s = window.kkState;
    s.hero.pos.set(x, 0, z);
    if (s.hero.mesh) s.hero.mesh.position.set(x, 0, z);
  }, { x, z });
  // Headless WebGL advances the game clock much more slowly than wall time.
  // Re-send the real interaction edge until the controller's short cooldown
  // expires, just as a player would after reading a locked-gate message.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await page.keyboard.press('e');
    try {
      await waitForBoss(page, portalId, 1400);
      return;
    } catch (_) {
      await page.waitForTimeout(180);
    }
  }
  const debug = await page.evaluate(async () => {
    const mod = await import('/src/kakiLandPortals.js');
    const s = window.kkState;
    return { portal: mod.getKakiLandPortalDebugState(), time: s.time.game, hero: { x: s.hero.pos.x, z: s.hero.pos.z } };
  });
  die(`portal ${portalId} did not spawn a boss: ${JSON.stringify(debug)}`);
}

async function killPortalBoss(page, portalId) {
  return page.evaluate(async (id) => {
    const s = window.kkState;
    const enemy = s.enemies.active.find((item) => item && item.alive && item.kakiLandPortalId === id);
    if (!enemy) return { ok: false, reason: 'tagged boss not found' };
    const { killEnemy } = await import('/src/enemies.js');
    killEnemy(enemy);
    return { ok: true, isFinal: !!enemy.isFinalBoss };
  }, portalId);
}

async function main() {
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(CHROMIUM)) {
    die('Playwright/Chromium not available at the documented WSL locations.');
  }
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.error('[pageerror]', error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('[console.error]', message.text());
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=1`, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: TIMEOUT });
    await page.evaluate(() => {
      const s = window.kkState;
      // Keep object identity, not only a hex value: Kaki must replace the
      // scene background while active and return Town to this exact shared
      // background object on exit.
      window.__kkKakiSmokeBaseline = {
        background: s.scene.background,
      };
    });

    // Kaki Land is the last, locked campaign card until Cave is cleared.
    await page.waitForFunction(() => !!document.querySelector('.kkv2-rail-list .kkv2-chap[data-stage="kakiland"]'), null, { timeout: TIMEOUT });
    const lockedMenuCard = await page.evaluate(() => {
      const list = document.querySelector('.kkv2-rail-list');
      const card = list && list.querySelector('.kkv2-chap[data-stage="kakiland"]');
      if (!list || !card) return { exists: false };
      return {
        exists: true,
        last: list.lastElementChild === card,
        locked: card.classList.contains('is-locked'),
        finalBadge: card.textContent.includes('FINAL CHAPTER'),
      };
    });
    if (!lockedMenuCard.exists || !lockedMenuCard.last || !lockedMenuCard.locked || !lockedMenuCard.finalBadge) {
      die('Kaki Land final-gate menu assertion failed: ' + JSON.stringify(lockedMenuCard));
    }
    await page.locator('.kkv2-chap[data-stage="kakiland"]').evaluate((card) => {
      card.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    await page.waitForFunction(() => {
      const list = document.querySelector('.kkv2-rail-list');
      const card = list && list.querySelector('.kkv2-chap[data-stage="kakiland"]');
      if (!list || !card) return false;
      const rail = list.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      return rect.left >= rail.left && rect.right <= rail.right;
    }, null, { timeout: 3000 });
    // A stale selectedStage value must never bypass the final gate. Then seed
    // the current Cinder-finale flag, clear Void to unlock Cave, and clear Cave
    // to unlock Kaki Land. This mirrors the live campaign chain without relying
    // on retired progression state.
    const gate = await page.evaluate(async () => {
      const meta = await import('/src/meta.js');
      const config = await import('/src/config.js');
      meta.resetMeta();
      // Keep the deterministic map capture unobscured by the one-time story
      // card; the player-facing intro is covered by the normal first run.
      localStorage.setItem('kks_kakiLandIntroSeen_v1', '1');
      meta.setOption('selectedStage', 'kakiland');
      const rejected = meta.selectedStage(config.STAGES).id;
      meta.setOption('unlockedVoid', true);
      const voidResult = meta.commitRunResults({
        timeSurvived: 60,
        kills: 10,
        dmgDealt: 0,
        level: 1,
        victory: true,
        stageId: 'void',
      });
      const afterVoid = meta.getMeta();
      const kakiBeforeCave = !!afterVoid.unlockedKakiLand;
      const caveResult = meta.commitRunResults({
        timeSurvived: 60,
        kills: 10,
        dmgDealt: 0,
        level: 1,
        victory: true,
        stageId: 'cave',
      });
      const earned = meta.getMeta();
      meta.setOption('optEndless', true);
      meta.setOption('optBossRush', true);
      const accepted = meta.selectedStage(config.STAGES).id;
      const menu = await import('/src/menuV2.js');
      menu.hideMenuV2();
      menu.showMenuV2();
      return {
        rejected,
        accepted,
        kakiBeforeCave,
        chain: {
          void: !!earned.unlockedVoid,
          cave: !!earned.unlockedCave,
          kaki: !!earned.unlockedKakiLand,
        },
        results: {
          voidUnlockedCave: !!voidResult.unlockedCave,
          caveUnlockedKaki: !!caveResult.unlockedKakiLand,
        },
      };
    });
    if (gate.rejected === 'kakiland'
      || gate.accepted !== 'kakiland'
      || gate.kakiBeforeCave
      || !gate.chain.void
      || !gate.chain.cave
      || !gate.chain.kaki
      || !gate.results.voidUnlockedCave
      || !gate.results.caveUnlockedKaki) {
      die('Kaki Land selected-stage gate failed: ' + JSON.stringify(gate));
    }
    await page.waitForFunction(() => {
      const card = document.querySelector('.kkv2-rail-list .kkv2-chap[data-stage="kakiland"]');
      return !!(card && !card.classList.contains('is-locked') && card.classList.contains('is-selected'));
    }, null, { timeout: TIMEOUT });
    await page.locator('.kkv2-rail-list .kkv2-chap[data-stage="kakiland"]').evaluate((card) => {
      card.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    // this covers both menu discovery and the click → run-start handoff.
    await page.locator('.kkv2-rail-list .kkv2-chap[data-stage="kakiland"]').click();
    await page.waitForFunction(() => document.querySelector('.kkv2-chap[data-stage="kakiland"]')?.classList.contains('is-selected'), null, { timeout: TIMEOUT });
    // The production start gate must notice the stage mismatch even though it
    // still has a starter weapon from the boot-time forest default.
    await page.evaluate(() => window.kkStartRun());
    await page.waitForFunction(() => {
      const s = window.kkState;
      return !!(s && s.mode === 'run' && s.run && s.run.stage && s.run.stage.id === 'kakiland');
    }, null, { timeout: TIMEOUT });
    await page.waitForTimeout(1100);
    // Boss rewards should not interrupt this deterministic route with a
    // level-up picker midway through the three portal assertions.
    await page.evaluate(() => { window.kkState.hero.xpNext = 999999; });

    const initial = await page.evaluate(async () => {
      const s = window.kkState;
      const stage = s.scene.getObjectByName('kakiLandStage');
      const main = stage && stage.userData.portalById.get('kaki-main');
      const ground = s.envGroup && s.envGroup.userData.ground;
      const portalShards = await import('/src/portalShards.js');
      const shardDebug = portalShards._debugPortalShardMap();
      const isRendered = (element) => !!(element
        && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden'
        && element.getClientRects().length);
      const genericHud = document.getElementById('kk-portal-hud');
      const genericMinimap = document.getElementById('kk-portal-minimap');
      const destructibles = await import('/src/destructibles.js');
      return {
        stage: s.run.stage.id,
        stageMounted: !!stage,
        portalCount: stage && stage.userData.portalById ? stage.userData.portalById.size : 0,
        mainLocked: !!(main && !main.userData.unlocked),
        visibleMainLocks: main && main.userData.locks ? main.userData.locks.filter((lock) => lock.visible).length : 0,
        groundHidden: !!(ground && !ground.visible),
        terrainTexturesReady: !!(stage && stage.userData.terrainTexturesReady),
        cloudStyle: stage && stage.userData.cloudStyle,
        endlessDisabled: !s.modes.endless,
        bossRushDisabled: !s.modes.bossRush,
        cameraHalf: s.camera && s.camera.top,
        cameraFocusError: (() => {
          const elements = s.camera.matrixWorld.elements;
          const dx = -elements[8];
          const dy = -elements[9];
          const dz = -elements[10];
          const t = -s.camera.position.y / (dy || -0.00001);
          const x = s.camera.position.x + dx * t;
          const z = s.camera.position.z + dz * t;
          return Math.hypot(x - s.hero.pos.x, z - s.hero.pos.z);
        })(),
        portalShardHudAbsent: !isRendered(genericHud),
        portalShardMinimapAbsent: !isRendered(genericMinimap),
        genericShardLocations: shardDebug.locations.length,
        genericPortal: shardDebug.portal,
        portalShardCount: s.run.portalShards || 0,
        genericEnemyCount: s.enemies.active.filter((enemy) => enemy && enemy.alive && !enemy.kakiLandPortalId).length,
        destructibleCount: destructibles._debugDestructibles().alive,
        totemCount: s.totems.list.length,
        pylonCount: s.pylons.list.length,
        bellCount: s.bells.list.length,
      };
    });
    if (initial.stage !== 'kakiland'
      || !initial.stageMounted
      || initial.portalCount !== 4
      || !initial.mainLocked
      || initial.visibleMainLocks !== 3
      || !initial.groundHidden
      || !initial.terrainTexturesReady
      || initial.cloudStyle !== 'painted-sky-clouds'
      || !initial.endlessDisabled
      || !initial.bossRushDisabled
      || Math.abs(initial.cameraHalf - EXPECTED_CAMERA_HALF) > 0.01
      || initial.cameraFocusError > 0.5
      || !initial.portalShardHudAbsent
      || !initial.portalShardMinimapAbsent
      || initial.genericShardLocations !== 0
      || initial.genericPortal !== null
      || initial.portalShardCount !== 0
      || initial.genericEnemyCount !== 0
      || initial.destructibleCount !== 0
      || initial.totemCount !== 0
      || initial.pylonCount !== 0
      || initial.bellCount !== 0) {
      die('initial map assertion failed: ' + JSON.stringify(initial));
    }
    const shot = path.join('/tmp', 'kks-kakiland.png');
    await page.screenshot({ path: shot, fullPage: false });

    // Main portal must reject an early interaction.
    await page.evaluate(() => {
      const s = window.kkState;
      s.hero.pos.set(0, 0, 0);
      if (s.hero.mesh) s.hero.mesh.position.set(0, 0, 0);
    });
    await page.keyboard.press('e');
    await page.waitForTimeout(350);
    const premature = await page.evaluate(() => window.kkState.enemies.active.some((enemy) => enemy && enemy.kakiLandPortalId === 'kaki-main'));
    if (premature) die('main portal spawned before all three trials cleared');

    const trials = [
      { id: 'kaki-ember', key: 'ember', x: -50, z: -48 },
      { id: 'kaki-tide', key: 'tide', x: 0, z: 58 },
      { id: 'kaki-bloom', key: 'bloom', x: 52, z: -12 },
    ];
    for (let index = 0; index < trials.length; index++) {
      const trial = trials[index];
      await enterPortal(page, trial.id, trial.x, trial.z);
      const signature = await page.evaluate(async (id) => {
        const { KAKI_LAND_BOSS_PROFILES } = await import('/src/bossTelegraphs.js');
        const encounters = await import('/src/kakiLandBossEncounters.js');
        const s = window.kkState;
        const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === id);
        const profile = KAKI_LAND_BOSS_PROFILES[id];
        let drawables = 0;
        let bloomMeshes = 0;
        if (boss && boss.mesh) boss.mesh.traverse((obj) => {
          if (!obj.isMesh) return;
          drawables++;
          if (obj.layers && (obj.layers.mask & (1 << 1))) bloomMeshes++;
        });
        return {
          displayName: boss && boss.displayName,
          glbKey: boss && boss.glbKey,
          patternId: boss && boss.kakiLandPatternId,
          patterns: profile ? [...profile.patterns] : null,
          firstTellSec: profile && profile.firstTellSec,
          intervalSec: profile && profile.intervalSec,
          drawables,
          bloomMeshes,
          encounter: encounters.getKakiLandBossEncounterDebugState(),
        };
      }, trial.id);
      const expectedPatterns = EXPECTED_KAKI_SIGNATURES[trial.id];
      const expectedAsset = EXPECTED_KAKI_BOSS_ASSETS[trial.id];
      if (!signature.displayName
        || signature.glbKey !== expectedAsset.glb
        || signature.drawables !== expectedAsset.draws
        || signature.bloomMeshes !== expectedAsset.bloom
        || signature.patterns?.join(',') !== expectedPatterns.join(',')
        || !(signature.firstTellSec > 0)
        || !(signature.intervalSec > 0)
        || signature.encounter.phaseCount !== 2
        || signature.encounter.intermissionCount !== 1) {
        die('unique Kaki boss signature assertion failed for ' + trial.id + ': ' + JSON.stringify(signature));
      }
      if (index === 0) {
        await page.waitForTimeout(120);
        await page.screenshot({ path: '/tmp/kks-kakiland-ember-boss.png', fullPage: false });
      }
      const escalated = await driveWardPhase(
        page,
        trial.id,
        EXPECTED_TRIAL_ADDS[trial.id],
        1,
        index === 0 ? '/tmp/kks-kakiland-ember-ward.png' : null,
      );
      if (escalated.patterns.join(',') !== EXPECTED_ESCALATED_PATTERNS[trial.id].join(',')
        || !(escalated.intervalMul < 1)) {
        die('trial phase escalation failed for ' + trial.id + ': ' + JSON.stringify(escalated));
      }
      const killed = await killPortalBoss(page, trial.id);
      if (!killed.ok || killed.isFinal) die('trial boss kill failed for ' + trial.id);
      await page.waitForFunction(({ id, key, remainingLocks }) => {
        const s = window.kkState;
        const stage = s.scene.getObjectByName('kakiLandStage');
        const portal = stage && stage.userData.portalById.get(id);
        const main = stage && stage.userData.portalById.get('kaki-main');
        const locks = main && main.userData.locks ? main.userData.locks.filter((lock) => lock.visible).length : -1;
        return !!(s.run.kakiLand.trials[key] && portal && portal.userData.completed && locks === remainingLocks);
      }, { id: trial.id, key: trial.key, remainingLocks: trials.length - index - 1 }, { timeout: TIMEOUT });
      await page.waitForTimeout(800); // portal interaction cooldown
    }

    const unlocked = await page.evaluate(() => {
      const s = window.kkState;
      const stage = s.scene.getObjectByName('kakiLandStage');
      const main = stage.userData.portalById.get('kaki-main');
      return {
        unlocked: s.run.kakiLand.mainPortalUnlocked,
        visual: main.userData.unlocked,
        visibleLocks: main.userData.locks.filter((lock) => lock.visible).length,
      };
    });
    if (!unlocked.unlocked || !unlocked.visual || unlocked.visibleLocks !== 0) die('main portal did not unlock: ' + JSON.stringify(unlocked));

    await enterPortal(page, 'kaki-main', 0, 0);
    const finalSignature = await page.evaluate(async () => {
      const { KAKI_LAND_BOSS_PROFILES } = await import('/src/bossTelegraphs.js');
      const encounters = await import('/src/kakiLandBossEncounters.js');
      const s = window.kkState;
      const boss = s.enemies.active.find((enemy) => enemy && enemy.alive && enemy.kakiLandPortalId === 'kaki-main');
      let drawables = 0;
      let bloomMeshes = 0;
      if (boss && boss.mesh) boss.mesh.traverse((obj) => {
        if (!obj.isMesh) return;
        drawables++;
        if (obj.layers && (obj.layers.mask & (1 << 1))) bloomMeshes++;
      });
      return {
        displayName: boss && boss.displayName,
        glbKey: boss && boss.glbKey,
        patternId: boss && boss.kakiLandPatternId,
        patterns: [...KAKI_LAND_BOSS_PROFILES['kaki-main'].patterns],
        drawables,
        bloomMeshes,
        encounter: encounters.getKakiLandBossEncounterDebugState(),
      };
    });
    const expectedFinalAsset = EXPECTED_KAKI_BOSS_ASSETS['kaki-main'];
    if (!finalSignature.displayName
      || finalSignature.glbKey !== expectedFinalAsset.glb
      || finalSignature.drawables !== expectedFinalAsset.draws
      || finalSignature.bloomMeshes !== expectedFinalAsset.bloom
      || finalSignature.patternId !== 'cycle'
      || finalSignature.patterns.join(',') !== EXPECTED_KAKI_SIGNATURES['kaki-main'].join(',')
      || finalSignature.encounter.phaseCount !== 3
      || finalSignature.encounter.intermissionCount !== 2) {
      die('Kaki Sovereign signature assertion failed: ' + JSON.stringify(finalSignature));
    }
    const crownOne = await driveWardPhase(
      page,
      'kaki-main',
      ['kaki_sparkmite', 'kaki_tidesprite', 'kaki_bloomling'],
      1,
    );
    if (crownOne.patterns.join(',') !== 'engulf,quake') {
      die('Sovereign phase two failed: ' + JSON.stringify(crownOne));
    }
    const crownTwo = await driveWardPhase(
      page,
      'kaki-main',
      ['kaki_sparkmite', 'kaki_sparkmite', 'kaki_tidesprite', 'kaki_tidesprite', 'kaki_bloomling', 'kaki_bloomling'],
      2,
      '/tmp/kks-kakiland-sovereign-ward.png',
    );
    if (crownTwo.patterns.join(',') !== 'sonic,engulf,quake' || !(crownTwo.intervalMul < crownOne.intervalMul)) {
      die('Sovereign final phase failed: ' + JSON.stringify(crownTwo));
    }
    const finalKilled = await killPortalBoss(page, 'kaki-main');
    if (!finalKilled.ok || !finalKilled.isFinal) die('final Kaki Sovereign did not spawn as a final boss');
    await page.waitForFunction(() => !!window.kkState.victory, null, { timeout: TIMEOUT });

    // A boss clear must terminate as an explicit victory and mount the
    // celebratory crew screen after the short in-world hop. This guards the
    // historical regression where a win only fell through the generic death
    // modal and read as if the hero had died.
    await page.waitForFunction(() => !!document.querySelector('.kk-victory-screen .kk-victory-shell'), null, { timeout: TIMEOUT });
    await page.waitForTimeout(220);
    const victoryUi = await page.evaluate(() => {
      const s = window.kkState;
      const screen = document.querySelector('.kk-death.kk-victory-screen');
      const shell = screen && screen.querySelector('.kk-victory-shell');
      const title = shell && shell.querySelector('.kk-death-title');
      const primary = shell && shell.querySelector('.kk-victory-primary');
      const details = shell && shell.querySelector('.kk-victory-details');
      return {
        gameOver: !!s.gameOver,
        victory: !!s.victory,
        outcome: s.run && s.run.outcome,
        heroHp: s.hero && s.hero.hp,
        screen: !!screen,
        shell: !!shell,
        title: title && title.textContent,
        primary: primary && primary.textContent,
        details: !!details,
        background: screen ? getComputedStyle(screen).backgroundImage : '',
      };
    });
    if (!victoryUi.gameOver
      || !victoryUi.victory
      || victoryUi.outcome?.kind !== 'victory'
      || victoryUi.outcome?.stageId !== 'kakiland'
      || !(victoryUi.heroHp > 0)
      || !victoryUi.screen
      || !victoryUi.shell
      || victoryUi.title !== 'THE CREW DID IT!'
      || !victoryUi.primary?.includes('Celebrate in Town')
      || !victoryUi.details
      || !victoryUi.background.includes('victory_crew_hangout_20260716.webp')) {
      die('dedicated victory screen assertion failed: ' + JSON.stringify(victoryUi));
    }
    const victoryShot = '/tmp/kks-kakiland-victory.png';
    await page.screenshot({ path: victoryShot, fullPage: false });

    // Town uses the same scene. Ensure a Kaki selection cannot leave the
    // floating islands or hidden shared ground overlapping its plaza, then
    // ensure the preserved map reappears when the player heads back out.
    await page.waitForFunction(() => {
      const map = window.kkState && window.kkState.scene.getObjectByName('kakiLandStage');
      return !!(map && map.userData.skyTexture);
    }, null, { timeout: TIMEOUT });
    const kakiSkyWasActive = await page.evaluate(() => {
      const map = window.kkState.scene.getObjectByName('kakiLandStage');
      window.__kakiSmokeSky = map && map.userData.skyTexture;
      return !!window.__kakiSmokeSky;
    });
    await page.evaluate(() => window.kkReturnToTown());
    await page.waitForFunction(() => window.kkState && window.kkState.mode === 'town', null, { timeout: TIMEOUT });
    await page.waitForTimeout(120);
    const townState = await page.evaluate(async () => {
      const s = window.kkState;
      const map = s.scene.getObjectByName('kakiLandStage');
      const portals = await import('/src/kakiLandPortals.js');
      const [{ getZoom }, { WORLD }] = await Promise.all([
        import('/src/input.js'),
        import('/src/config.js'),
      ]);
      const banner = document.getElementById('kk-stage-rule-banner');
      const hud = document.querySelector('.kk-hud');
      const baseline = window.__kkKakiSmokeBaseline;
      const expectedCameraTop = WORLD.cameraDistance / getZoom();
      return {
        mapVisible: !!(map && map.visible),
        groundVisible: !!(s.envGroup.userData.ground && s.envGroup.userData.ground.visible),
        portalControllerLoaded: portals.getKakiLandPortalDebugState().loaded,
        backgroundRestored: !!(baseline && s.scene.background === baseline.background),
        skyStillOwnedByMap: !!(map && map.userData.skyTexture),
        sceneStillUsesKakiSky: !!(window.__kakiSmokeSky && s.scene.background === window.__kakiSmokeSky),
        combatHudVisible: !!(hud && getComputedStyle(hud).display !== 'none'),
        cameraTop: s.camera.top,
        expectedCameraTop,
        cameraRestored: Math.abs(s.camera.top - expectedCameraTop) < 0.01,
        bannerOpacity: banner ? getComputedStyle(banner).opacity : '0',
      };
    });
    if (!kakiSkyWasActive
      || townState.mapVisible
      || !townState.groundVisible
      || townState.portalControllerLoaded
      || !townState.backgroundRestored
      || townState.skyStillOwnedByMap
      || townState.sceneStillUsesKakiSky
      || townState.combatHudVisible
      || !townState.cameraRestored
      || Number(townState.bannerOpacity) > 0.01) {
      die('Kaki map, sky, HUD, or camera leaked into town: ' + JSON.stringify(townState));
    }
    await page.evaluate(() => window.kkStartRun());
    await page.waitForFunction(() => {
      const s = window.kkState;
      const map = s.scene.getObjectByName('kakiLandStage');
      return s.mode === 'run' && !!(map && map.visible) && !!(s.envGroup.userData.ground && !s.envGroup.userData.ground.visible);
    }, null, { timeout: TIMEOUT });
    await page.waitForTimeout(100);
    const restartState = await page.evaluate(async () => {
      const portals = await import('/src/kakiLandPortals.js');
      return {
        roots: [...window.kkState.scene.children].filter((child) => child.name === 'kakiLandStage').length,
        portalControllerLoaded: portals.getKakiLandPortalDebugState().loaded,
        cameraHalf: window.kkState.camera.top,
      };
    });
    if (restartState.roots !== 1
      || !restartState.portalControllerLoaded
      || Math.abs(restartState.cameraHalf - EXPECTED_CAMERA_HALF) > 0.01) {
      die('Kaki restart lifecycle failed: ' + JSON.stringify(restartState));
    }

    const bytes = fs.statSync(shot).size;
    if (bytes < 8000) die('Kaki Land screenshot unexpectedly small: ' + bytes + ' bytes');
    for (const visualShot of ['/tmp/kks-kakiland-ember-ward.png', '/tmp/kks-kakiland-sovereign-ward.png']) {
      if (!fs.existsSync(visualShot) || fs.statSync(visualShot).size < 8000) {
        die('Kaki encounter screenshot missing or unexpectedly small: ' + visualShot);
      }
    }
    if (!fs.existsSync(victoryShot) || fs.statSync(victoryShot).size < 20_000) {
      die('victory screen screenshot missing or unexpectedly small: ' + victoryShot);
    }
    if (pageErrors.length) die('page errors: ' + pageErrors.join(' | '));
    console.log('[smoke-kakiland] PASS — 3 phased trials + 2 Sovereign wards → final-boss victory');
    console.log('[smoke-kakiland] screenshot: ' + shot + ' (' + bytes + ' bytes)');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error('[smoke-kakiland] FAIL:', error && (error.stack || error.message || error));
  try { server.close(); } catch (_) {}
  process.exit(1);
});
