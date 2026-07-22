#!/usr/bin/env node
/** Browser integration smoke for transactional, sealed Catacomb progression. */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8813);
const require = createRequire(import.meta.url);
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function mime(p) {
  if (/\.m?js$/.test(p)) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(p)) return 'image/jpeg';
  if (p.endsWith('.hdr')) return 'application/octet-stream';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

// Golden chests can queue a slot result and one or more level-up drafts in
// consecutive browser frames.  Stairs intentionally reject interaction while
// either UI owns pause, so wait until the complete modal chain has settled
// instead of assuming two Space presses close every possible reward outcome.
async function settleRewardModals(page, label, { allowBanked = false } = {}) {
  const deadline = Date.now() + 24000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(async () => {
      const ui = await import('./src/ui.js');
      return {
        slotOpen: ui.isSlotOpen(),
        pendingLevelUp: !!window.kkState.pendingLevelUp,
        pendingLevelCount: window.kkState.pendingLevelCount || 0,
        levelModalVisible: !!document.querySelector('.kk-modal'),
        paused: !!window.kkState.time.paused,
        gameOver: !!window.kkState.gameOver,
        started: !!window.kkState.started,
        gameTime: window.kkState.time.game,
        holdUntil: window.kkState.levelModalHoldUntil || 0,
        hitStop: window.kkState.fx?.hitStop || 0,
      };
    });

    if (last.slotOpen) {
      // Click the owned controls instead of broadcasting Space into global
      // gameplay handlers. A random bonus chest can immediately follow the
      // golden chest, so the outer loop intentionally drains the full chain.
      const action = await page.evaluate(() => {
        const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
        const buttons = [...document.querySelectorAll('button')];
        const skip = buttons.find((b) => visible(b) && /^Skip\b/i.test(b.textContent || ''));
        if (skip) { skip.click(); return 'skip'; }
        const take = buttons.find((b) => visible(b) && /^Take It\b/i.test(b.textContent || ''));
        if (take) { take.click(); return 'take'; }
        return 'wait';
      });
      await page.waitForTimeout(action === 'wait' ? 120 : 80);
      continue;
    }

    if (last.pendingLevelUp || last.levelModalVisible) {
      // Consume the first real draft choice instead of deleting the queued
      // level. This preserves the XP/level accounting the production fix is
      // meant to protect and naturally walks any short cascade to completion.
      const picked = await page.evaluate(async () => {
        const { applyLevelUpChoice } = await import('./src/xp.js');
        const choice = window.kkState.levelUpChoices?.[0];
        if (!choice) return false;
        applyLevelUpChoice(choice);
        return true;
      });
      if (!picked) await page.keyboard.press('Digit1');
      await page.waitForTimeout(80);
      continue;
    }

    if (last.pendingLevelCount > 0) {
      if (allowBanked && !last.pendingLevelUp && !last.levelModalVisible) return last;
      // The level-up chain breaker intentionally banks the remaining drafts
      // for three seconds of unpaused game time after every pair of choices.
      // Leave the simulation running until updateGems re-opens the next real
      // draft instead of mistaking the quiet hold window for completion.
      // Headless Chromium heavily throttles background RAF, so advance only
      // this intentional cooldown to its boundary; updateGems must still own
      // and prove the actual draft re-open on the following browser frame.
      await page.evaluate(async () => {
        window.kkState.time.game = Math.max(
          window.kkState.time.game,
          window.kkState.levelModalHoldUntil || 0,
        );
        // Exercise the same canonical wake-up path the next gameplay frame
        // calls, without waiting on headless Chromium's throttled RAF.
        const { updateGems } = await import('./src/xp.js');
        updateGems(0);
      });
      await page.waitForTimeout(120);
      continue;
    }

    if (last.paused) {
      // With both modal owners gone, any remaining pause belongs to the
      // transient reward chain rather than the not-yet-open stairs choice.
      await page.evaluate(() => { window.kkState.time.paused = false; });
      await page.waitForTimeout(80);
      continue;
    }

    return last;
  }
  throw new Error(`${label} reward modals did not settle: ${JSON.stringify(last)}`);
}

async function openDepthChoiceAtExit(page, label) {
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    last = await page.evaluate(() => {
      const snap = window.__kkCatacombDebugModule._debugCatacombState();
      window.kkState.hero.pos.set(snap.exit.x, 0, snap.exit.z);
      window.kkState.hero.vel.set(0, 0, 0);
      window.kkState.input.interactPressed = true;
      window.__kkCatacombDebugModule.tickCatacomb(1 / 60);
      window.kkState.input.interactPressed = false;
      const after = window.__kkCatacombDebugModule._debugCatacombState();
      const modal = document.getElementById('kk-catacomb-depth-choice');
      return {
        open: after.choiceOpen,
        paused: window.kkState.time.paused,
        depth: after.floorDepth,
        phase: after.phase,
        modalVisible: !!modal && modal.style.display === 'flex',
        deeperLabel: modal && modal.querySelector('[data-action="deeper"]')?.textContent,
      };
    });
    if (last.open && last.modalVisible) return last;
    // The stairs may have just vacuumed a jackpot fan and opened one or more
    // real level-up drafts. Resolve those, then interact again as a player does.
    await settleRewardModals(page, `${label} stairs`);
  }
  throw new Error(`${label} depth choice did not open: ${JSON.stringify(last)}`);
}

async function claimGoldenReward(page, label) {
  const deadline = Date.now() + 24000;
  let last = null;
  while (Date.now() < deadline) {
    // A quiet banked draft count is intentionally allowed here: production
    // chest ownership blocks a visible draft/modal, not the chain-breaker rest.
    await settleRewardModals(page, `${label} pre-claim`, { allowBanked: true });
    await page.waitForTimeout(140);
    last = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
    if (!last.rewardPending) {
      await settleRewardModals(page, label, { allowBanked: true });
      return last;
    }
    // A jackpot gem may have opened another level-up on the frame before the
    // chest pickup pass. Loop until drafts finish and the waiting chest gets
    // its own clean frame.
  }
  throw new Error(`${label} reward pickup stalled: ${JSON.stringify(last)}`);
}

async function clearSyntheticDraftBacklog(page) {
  // Teleporting through rooms leaves off-screen enemy drops a real traversal
  // would collect while fighting. Chest/modal ownership is already proven;
  // remove only that synthetic queue so this smoke can focus on the two-floor
  // transaction and build/HP preservation.
  return page.evaluate(async () => {
    const ui = await import('./src/ui.js');
    const count = window.kkState.pendingLevelCount || 0;
    ui.hideLevelUpModal();
    window.kkState.pendingLevelUp = false;
    window.kkState.pendingLevelCount = 0;
    window.kkState.levelUpChoices.length = 0;
    window.kkState.time.paused = false;
    return count;
  });
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
      status: 200, contentType: 'text/css', body: '',
    }));
    await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
    page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
    page.on('console', (m) => {
      const text = m.text();
      const externalResourceNoise = /Failed to load resource: net::ERR_(?:TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/.test(text);
      if (m.type() === 'error' && !externalResourceNoise) errors.push(`console: ${text}`);
    });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`http://127.0.0.1:${PORT}/?smoke=dungeon-progression`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__kkTestEnterCatacomb && window.kkState, null, { timeout: 90000 });
    const ownerGuards = await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      const meta = await import('./src/meta.js');
      meta.setOption('selectedStage', 'forest');
      window.kkState.weapons.length = 0;
      // Isolate Forest's encounter guards after its canonical exploration
      // prerequisite. The trial gate is marked complete in test state so a
      // Helltide or Reaper warning—not the prerequisite—owns each rejection.
      window.kkState.run.forestPortalTrials = {
        rooms: {}, cleared: 6, total: 6, bossUnlocked: true,
        bossDefeated: false, activeRoom: null,
      };
      const helltide = await import('./src/helltide.js');
      const triggered = helltide.triggerHelltide();
      const helltideEntry = await window.__kkTestEnterCatacomb();
      helltide.endHelltide(false);
      helltide.teardownHelltide();
      window.kkState.run._reaperWarned = true;
      const reaperEntry = await window.__kkTestEnterCatacomb();
      window.kkState.run._reaperWarned = false;
      return { triggered, helltideEntry, reaperEntry, mode: window.kkState.mode };
    });
    assert(ownerGuards.triggered, 'Helltide test setup did not trigger');
    assert(!ownerGuards.helltideEntry, 'active Helltide did not block Catacomb entry');
    assert(!ownerGuards.reaperEntry, 'Forest Reaper warning did not block Catacomb entry');
    assert(ownerGuards.mode === 'run', 'owner guard changed run mode');
    const finalBossGuard = await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      // The remaining script owns generic Catacomb transaction/progression,
      // not Forest's six-trial prerequisite. Twilight retains the original
      // dungeon entry path and preserves that coverage without bypassing the
      // normal Forest Boss Gate.
      const meta = await import('./src/meta.js');
      const { STAGES } = await import('./src/config.js');
      meta.setOption('selectedStage', 'twilight');
      window.kkState.run.stage = STAGES.find((stage) => stage.id === 'twilight');
      window.kkState.run.environmentSeed = 0xC0FFEE;
      window.kkState.weapons.length = 0;
      const enemies = await import('./src/enemies.js');
      const { ENEMY_TIERS } = await import('./src/config.js');
      const fakeBoss = enemies.spawnEnemy(ENEMY_TIERS.find((t) => !t.dungeon), 30, 30);
      fakeBoss.isFinalBoss = true;
      const entered = await window.__kkTestEnterCatacomb();
      const index = window.kkState.enemies.active.indexOf(fakeBoss);
      if (index >= 0) window.kkState.enemies.active.splice(index, 1);
      window.kkState.enemies.spatial.remove(fakeBoss);
      fakeBoss.alive = false;
      enemies.releaseEnemyVisual(fakeBoss);
      return {
        entered,
        mode: window.kkState.mode,
        banner: document.body.textContent.includes('DEFEAT THE FINAL BOSS BEFORE DESCENDING'),
      };
    });
    assert(!finalBossGuard.entered && finalBossGuard.mode === 'run', 'live final boss did not block Catacomb entry');
    assert(finalBossGuard.banner, 'final-boss entry guard has no player-facing feedback');
    const entered = await page.evaluate(async () => {
      const enemies = await import('./src/enemies.js');
      const { ENEMY_TIERS } = await import('./src/config.js');
      const survivor = enemies.spawnEnemy(ENEMY_TIERS.find((t) => !t.dungeon), 55, 55);
      survivor._smokeOverworld = true;
      return window.__kkTestEnterCatacomb();
    });
    assert(entered, 'transactional Catacomb entry returned false');
    await page.waitForFunction(() => window.kkState.mode === 'catacomb', null, { timeout: 90000 });
    await page.evaluate(async () => {
      window.__kkCatacombDebugModule = await import('./src/catacomb.js');
      window.kkState.hero.xpNext = 1e9;
      window.kkState.hero.iFramesUntil = 1e9;
    });

    let snap = await page.evaluate(async () => (await import('./src/catacomb.js'))._debugCatacombState());
    assert(snap.parkedOverworldEnemies >= 1, `overworld suspension count=${snap.parkedOverworldEnemies}`);
    assert(snap.criticalPath.length >= 2, 'critical path missing');
    assert(snap.mechanics && snap.mechanics.built, 'room-mechanics layer did not build');
    const mechanicKinds = new Set(snap.mechanics.rooms.map((r) => r.kind));
    assert(mechanicKinds.size >= 4, `room-mechanics variety=${mechanicKinds.size}`);
    assert(snap.rooms.every((r) => !!r.encounter), 'generated room missing encounter identity');
    assert(snap.rooms.some((r) => r.status === 'LOCKED'
      && r.doors.some((d) => (d.lockMask & 1) && d.collisionBlocked)), 'future progression gates are not visibly/physically sealed');

    let combatRooms = 0;
    let visualCaptured = false;
    for (let depth = 1; depth < snap.criticalPath.length; depth++) {
      const roomId = snap.criticalPath[depth];
      const room = snap.rooms.find((r) => r.id === roomId);
      assert(room && room.center, `critical room ${roomId} has no center`);
      await page.evaluate(({ x, z }) => {
        window.kkState.hero.pos.set(x, 0, z);
        window.kkState.hero.vel.set(0, 0, 0);
      }, room.center);
      try {
        await page.waitForFunction((id) => {
          const r = window.__kkCatacombDebugModule._debugCatacombState().rooms.find((x) => x.id === id);
          return r && (r.status === 'ACTIVE' || r.status === 'CLEARED');
        }, roomId, { timeout: 12000 });
      } catch (_) {
        const stalled = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
        const target = stalled.rooms.find((r) => r.id === stalled.criticalPath[stalled.criticalProgress + 1]);
        throw new Error(`depth ${depth} room ${roomId} stalled: mode=${stalled.mode} paused=${stalled.paused} pending=${stalled.pendingLevelUp} hero=${JSON.stringify(stalled.hero)} active=${stalled.activeRoomId} progress=${stalled.criticalProgress} target=${JSON.stringify(target)} errors=${errors.join(' | ')}`);
      }
      snap = await page.evaluate(async () => (await import('./src/catacomb.js'))._debugCatacombState());
      const live = snap.rooms.find((r) => r.id === roomId);
      if (live.status === 'ACTIVE') {
        combatRooms++;
        assert(snap.mechanics.activeRoomId === roomId, `mechanics did not activate with room ${roomId}`);
        assert(snap.mechanics.costumes >= live.alive, `spectral role visuals ${snap.mechanics.costumes} < live mobs ${live.alive}`);
        if (process.env.SCREENSHOT && !visualCaptured
            && ['yarn_waltz', 'ghost_gallery', 'bell_gauntlet', 'warden_waltz'].includes(live.encounter)) {
          await page.waitForTimeout(1400);
          await page.screenshot({ path: path.join(ROOT, 'tools/_thumb_catacomb_overhaul.png') });
          visualCaptured = true;
        }
        assert(live.doors.length > 0
          && live.doors.every((d) => (d.lockMask & 2) !== 0 && d.collisionBlocked), `room ${roomId} did not encounter-seal every door`);
        if (roomId === snap.bossRoomId) {
          const boss = await page.evaluate(() => {
            const e = window.kkState.enemies.active.find((x) => x && x.alive && x._isDungeonBoss);
            return e ? { present: true, displayName: e.displayName } : { present: false };
          });
          assert(boss.present && boss.displayName === 'CRYPT WARDEN', 'boss room lacks tagged Crypt Warden');
        } else {
          const roleNames = await page.evaluate(() => window.kkState.enemies.active
            .filter((e) => e && e.alive)
            .map((e) => e._dungeonRole));
          assert(roleNames.length > 0 && roleNames.every(Boolean), `room ${roomId} lacks dungeon-only enemy roles`);
        }
        await page.evaluate(async () => {
          const enemies = await import('./src/enemies.js');
          const boss = window.kkState.enemies.active.find((e) => e && e.alive && e._isDungeonBoss);
          if (boss) {
            // Room traversal uses an enormous xpNext to suppress unrelated
            // drafts. Restore the real curve before Catacomb computes its
            // xpNext-relative jackpot. Also discard remote room-drop gems the
            // teleporting smoke player deliberately never walked through;
            // otherwise that artificial backlog, not the golden reward, owns
            // this handoff test and manufactures a long draft cascade.
            const { xpForLevel } = await import('./src/state.js');
            const { resetXP } = await import('./src/xp.js');
            resetXP();
            window.kkState.hero.xp = 0;
            window.kkState.hero.xpNext = xpForLevel(window.kkState.hero.level);
            enemies.killEnemy(boss);
          }
          for (const e of window.kkState.enemies.active) if (e && e.alive) e.alive = false;
        });
        try {
          await page.waitForFunction((id) => {
            const r = window.__kkCatacombDebugModule._debugCatacombState().rooms.find((x) => x.id === id);
            return r && r.status === 'CLEARED';
          }, roomId, { timeout: 12000 });
        } catch (_) {
          const stalled = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
          throw new Error(`room ${roomId} clear stalled: ${JSON.stringify(stalled.rooms.find((r) => r.id === roomId))} errors=${errors.join(' | ')}`);
        }
      }
      snap = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
      assert(snap.criticalProgress >= depth, `critical depth ${depth} did not advance`);
    }

    assert(combatRooms >= 1, 'critical route contained no combat encounter');
    snap = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
    assert(snap.bossCleared && snap.phase === 'REWARD', 'boss clear did not enter REWARD phase');
    assert(snap.rewardPending, 'golden reward chest is not pending collection');
    const metaReward = await page.evaluate(async () => {
      const { getMeta } = await import('./src/meta.js');
      const meta = getMeta();
      return {
        clears: meta.catacomb?.clears || 0,
        sigils: meta.sigils || 0,
        embers: meta.embers || 0,
        moonbell: meta.daycare?.unlockedOutfits?.includes('moonbell') || false,
      };
    });
    assert(metaReward.clears === 1, `persistent Catacomb clears=${metaReward.clears}`);
    assert(metaReward.sigils >= 3 && metaReward.embers >= 8, `high-value payout missing: ${JSON.stringify(metaReward)}`);
    assert(metaReward.moonbell, 'MaoMao Moonbell Collar was not unlocked');
    const reward = await page.evaluate(() => {
      const chest = window.kkState.scene.getObjectByName('chest:kkd_chest_gold');
      const hud = document.getElementById('kk-dungeon-progress');
      return { chest: !!chest, hud: !!hud && hud.style.display === 'block', text: hud && hud.textContent };
    });
    assert(reward.chest, 'golden dungeon chest asset missing');
    assert(reward.hud && /DEPTH 1 CLEARED/.test(reward.text), 'dungeon completion HUD missing');
    const guardedExit = await page.evaluate(() => window.__kkCatacombDebugModule.exitCatacomb());
    assert(guardedExit === false, 'Catacomb allowed exit before the golden reward was claimed');
    assert(await page.evaluate(() => window.kkState.mode === 'catacomb'), 'reward guard changed mode');
    await page.evaluate(() => {
      const chest = window.kkState.scene.getObjectByName('chest:kkd_chest_gold');
      window.kkState.hero.pos.set(chest.position.x, 0, chest.position.z);
      window.kkState.hero.vel.set(0, 0, 0);
    });
    await claimGoldenReward(page, 'depth-1');
    await clearSyntheticDraftBacklog(page);
    await page.waitForTimeout(120);
    const beforeContinue = await page.evaluate(() => {
      const s = window.kkState;
      // A non-full sentinel makes the health assertion prove that continuing
      // preserves current HP rather than silently healing between floors.
      s.hero.hp = Math.max(1, s.hero.hpMax * 0.637);
      const byId = (a, b) => String(a.id).localeCompare(String(b.id));
      return {
        hp: s.hero.hp,
        hpMax: s.hero.hpMax,
        build: {
          weapons: (s.weapons || []).map((w) => ({
            id: w.id, level: w.level || 0, evolved: w.evolvedId || w.evolved || null,
          })).sort(byId),
          passives: (s.passives || []).map((p) => ({ id: p.id, level: p.level || 0 })).sort(byId),
          active: s.hero.active ? { id: s.hero.active.id, level: s.hero.active.level || 0 } : null,
          dashLevel: s.hero.dashLevel || 0,
        },
      };
    });
    const choice = await openDepthChoiceAtExit(page, 'depth-1');
    assert(choice.open && choice.modalVisible && choice.paused && choice.depth === 1,
      `post-reward depth choice did not open: ${JSON.stringify(choice)}`);
    assert(/DEPTH 2/i.test(choice.deeperLabel || ''), `continue choice label=${choice.deeperLabel}`);

    // Take the new continue path, clear a second generated floor, then cash
    // out through the same choice modal. This proves continuation rebuilds only
    // dungeon-owned state while the overworld cohort stays parked.
    await page.locator('#kk-catacomb-depth-choice [data-action="deeper"]').click();
    await page.waitForFunction(() => {
      const s = window.__kkCatacombDebugModule._debugCatacombState();
      return s.floorDepth === 2 && s.phase === 'ACTIVE' && !s.choiceOpen;
    }, null, { timeout: 12000 });
    const continued = await page.evaluate(() => {
      const s = window.kkState;
      const byId = (a, b) => String(a.id).localeCompare(String(b.id));
      return {
        dungeonDepth: s.run.dungeonDepth,
        dungeonPhase: s.run.dungeonPhase,
        hp: s.hero.hp,
        hpMax: s.hero.hpMax,
        build: {
          weapons: (s.weapons || []).map((w) => ({
            id: w.id, level: w.level || 0, evolved: w.evolvedId || w.evolved || null,
          })).sort(byId),
          passives: (s.passives || []).map((p) => ({ id: p.id, level: p.level || 0 })).sort(byId),
          active: s.hero.active ? { id: s.hero.active.id, level: s.hero.active.level || 0 } : null,
          dashLevel: s.hero.dashLevel || 0,
        },
      };
    });
    assert(continued.dungeonDepth === 2 && continued.dungeonPhase === 'ACTIVE',
      `continued run state=${JSON.stringify(continued)}`);
    assert(Math.abs(continued.hp - beforeContinue.hp) < 1e-6
      && Math.abs(continued.hpMax - beforeContinue.hpMax) < 1e-6,
    `continue changed hero HP: before=${beforeContinue.hp}/${beforeContinue.hpMax} after=${continued.hp}/${continued.hpMax}`);
    assert(JSON.stringify(continued.build) === JSON.stringify(beforeContinue.build),
      `continue changed run build: before=${JSON.stringify(beforeContinue.build)} after=${JSON.stringify(continued.build)}`);
    // Floor-one's jackpot is intentionally worth ~1.8 levels. This smoke owns
    // dungeon progression rather than draft UI, so dismiss/bank that expected
    // modal before driving floor two; otherwise the main loop correctly pauses
    // room clears behind pendingLevelUp and the test reports a false gate stall.
    await page.evaluate(async () => {
      const ui = await import('./src/ui.js');
      ui.hideLevelUpModal();
      window.kkState.pendingLevelUp = false;
      window.kkState.pendingLevelCount = 0;
      window.kkState.hero.xp = 0;
      window.kkState.hero.xpNext = 1e9;
      window.kkState.hero.iFramesUntil = 1e9;
    });
    let deep = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
    assert(deep.parkedOverworldEnemies >= 1, 'deeper floor restored overworld enemies early');
    for (let depth = 1; depth < deep.criticalPath.length; depth++) {
      const roomId = deep.criticalPath[depth];
      const room = deep.rooms.find((r) => r.id === roomId);
      assert(room && room.center, `depth-2 critical room ${roomId} has no center`);
      await page.evaluate(({ x, z }) => {
        window.kkState.hero.pos.set(x, 0, z);
        window.kkState.hero.vel.set(0, 0, 0);
      }, room.center);
      try {
        await page.waitForFunction((id) => {
          const r = window.__kkCatacombDebugModule._debugCatacombState().rooms.find((x) => x.id === id);
          return r && (r.status === 'ACTIVE' || r.status === 'CLEARED');
        }, roomId, { timeout: 12000 });
      } catch (_) {
        const stalled = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
        const target = stalled.rooms.find((r) => r.id === roomId);
        throw new Error(`floor 2 room ${depth}/${stalled.criticalPath.length - 1} id=${roomId} activation stalled: mode=${stalled.mode} phase=${stalled.phase} paused=${stalled.paused} pending=${stalled.pendingLevelUp} hero=${JSON.stringify(stalled.hero)} active=${stalled.activeRoomId} progress=${stalled.criticalProgress} target=${JSON.stringify(target)} errors=${errors.join(' | ')}`);
      }
      deep = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
      const live = deep.rooms.find((r) => r.id === roomId);
      if (live.status === 'ACTIVE') {
        await page.evaluate(async (isBossRoom) => {
          // Floor one already exercises the real killEnemy boss path. On the
          // continuation floor, retire the encounter cohort in-place so this
          // state-machine smoke does not inherit unrelated global boss drops.
          if (isBossRoom) {
            const { xpForLevel } = await import('./src/state.js');
            const { resetXP } = await import('./src/xp.js');
            resetXP();
            window.kkState.hero.xp = 0;
            window.kkState.hero.xpNext = xpForLevel(window.kkState.hero.level);
          }
          for (const e of window.kkState.enemies.active) if (e && e.alive) e.alive = false;
        }, roomId === deep.bossRoomId);
        try {
          await page.waitForFunction((id) => {
            const r = window.__kkCatacombDebugModule._debugCatacombState().rooms.find((x) => x.id === id);
            return r && r.status === 'CLEARED';
          }, roomId, { timeout: 12000 });
        } catch (_) {
          const stalled = await page.evaluate(() => ({
            dungeon: window.__kkCatacombDebugModule._debugCatacombState(),
            gameOver: window.kkState.gameOver,
            hp: window.kkState.hero.hp,
            hpMax: window.kkState.hero.hpMax,
          }));
          const target = stalled.dungeon.rooms.find((r) => r.id === roomId);
          throw new Error(`floor 2 room ${depth}/${stalled.dungeon.criticalPath.length - 1} id=${roomId} clear stalled: gameOver=${stalled.gameOver} hp=${stalled.hp}/${stalled.hpMax} mode=${stalled.dungeon.mode} phase=${stalled.dungeon.phase} paused=${stalled.dungeon.paused} pending=${stalled.dungeon.pendingLevelUp} active=${stalled.dungeon.activeRoomId} progress=${stalled.dungeon.criticalProgress} target=${JSON.stringify(target)} errors=${errors.join(' | ')}`);
        }
      }
      deep = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
      assert(deep.criticalProgress >= depth, `depth-2 room ${depth} did not advance`);
    }
    deep = await page.evaluate(() => window.__kkCatacombDebugModule._debugCatacombState());
    assert(deep.floorDepth === 2 && deep.phase === 'REWARD' && deep.bossCleared && deep.rewardPending,
      `depth-2 boss/reward state invalid: ${JSON.stringify(deep)}`);
    const depthTwoMeta = await page.evaluate(async () => {
      const { getMeta } = await import('./src/meta.js');
      const catacomb = getMeta().catacomb || {};
      return {
        clears: catacomb.clears || 0,
        bestFloor: catacomb.bestFloor || 0,
      };
    });
    assert(depthTwoMeta.clears === metaReward.clears + 1,
      `depth-2 clear tally did not increment: floor1=${metaReward.clears} floor2=${depthTwoMeta.clears}`);
    assert(depthTwoMeta.bestFloor >= 2,
      `Catacomb bestFloor=${depthTwoMeta.bestFloor} after clearing depth 2`);
    await page.evaluate(() => {
      const chest = window.kkState.scene.getObjectByName('chest:kkd_chest_gold');
      window.kkState.hero.pos.set(chest.position.x, 0, chest.position.z);
      window.kkState.hero.vel.set(0, 0, 0);
    });
    await claimGoldenReward(page, 'depth-2');
    await clearSyntheticDraftBacklog(page);
    const leftoverChests = await page.evaluate(() => {
      const names = [];
      window.kkState.scene.traverse((node) => {
        if (node.name && node.name.startsWith('chest:')) names.push(node.name);
      });
      return names;
    });
    assert(leftoverChests.length === 0,
      `another chest remained after the depth-2 golden reward: ${leftoverChests.join(', ')}`);
    const secondChoice = await openDepthChoiceAtExit(page, 'depth-2');
    assert(secondChoice.open && secondChoice.depth === 2 && secondChoice.phase === 'CHOICE',
      `depth-2 cash-out choice missing: ${JSON.stringify(secondChoice)}`);
    await page.locator('#kk-catacomb-depth-choice [data-action="surface"]').click();
    try {
      await page.waitForFunction(() => window.kkState.mode === 'run', null, { timeout: 12000 });
    } catch (_) {
      const stalled = await page.evaluate(async () => ({
        dungeon: window.__kkCatacombDebugModule._debugCatacombState(),
        slotOpen: (await import('./src/ui.js')).isSlotOpen(),
        mode: window.kkState.mode,
        paused: window.kkState.time.paused,
        gameOver: window.kkState.gameOver,
      }));
      throw new Error(`surface choice stalled: ${JSON.stringify(stalled)} errors=${errors.join(' | ')}`);
    }
    const ascent = await page.evaluate(() => {
      const survivor = window.kkState.enemies.active.find((e) => e && e._smokeOverworld);
      const snap = window.__kkCatacombDebugModule._debugCatacombState();
      return {
        mode: window.kkState.mode,
        restored: !!(survivor && survivor.alive && survivor.mesh && survivor.mesh.visible && survivor._spatialKey != null),
        parked: snap.parkedOverworldEnemies,
        rewardGone: !window.kkState.scene.getObjectByName('chest:kkd_chest_gold'),
        pausedWorld: window.kkState.run._overworldPausedTime || 0,
      };
    });
    assert(ascent.mode === 'run', 'rewarded choice ascent failed');
    assert(ascent.restored && ascent.parked === 0, 'overworld enemy cohort was not restored intact');
    assert(ascent.rewardGone, 'golden reward leaked into restored overworld');
    assert(ascent.pausedWorld > 0, 'Catacomb duration advanced overworld schedules');
    assert(errors.length === 0, errors.join(' | '));
    console.log(`smoke-dungeon-progression: PASS — guard, two floors, continue/cash-out choice, claimed rewards, restored overworld`);
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(`smoke-dungeon-progression: FAIL — ${e && (e.stack || e.message)}`);
  process.exitCode = 1;
});
