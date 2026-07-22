#!/usr/bin/env node
/**
 * Browser integration smoke for the Forest portal-trial progression.
 *
 * Contract:
 *   - the six non-Glade room portals are the only way to start a trial;
 *   - each room can be completed once, without duplicate encounter spawns;
 *   - the fixed Moonroot Boss Gate stays locked until every trial clears;
 *   - Forest no longer owns the random shard-pickup portal objective;
 *   - Forest trial hooks are inert outside a normal Forest overworld run.
 *
 * No production shortcuts are used for progression: the smoke activates the
 * real portal records and kills the real room-owned enemies through
 * enemies.killEnemy(), so the same death hook as normal combat must advance
 * each room.
 *
 * Run: node tools/smoke-forest-portal-trials.mjs
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8815);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const require = createRequire(import.meta.url);
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BOOT_TIMEOUT = 90_000;
const STEP_TIMEOUT = 15_000;
const TAIL_ONLY = process.env.TAIL_ONLY === '1';

function mime(p) {
  if (/\.m?js$/.test(p)) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(p)) return 'image/jpeg';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.woff2')) return 'font/woff2';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.ogg')) return 'audio/ogg';
  if (p.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function statusOf(rec) {
  return String(rec && rec.status || '').toUpperCase();
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const trials = await import('./src/forestSealedDoors.js');
    const api = trials.getForestTrialProgress();
    const debug = trials._debugForestPortalTrials();
    const run = window.kkState.run.forestPortalTrials;
    return {
      api: JSON.parse(JSON.stringify(api)),
      debug: JSON.parse(JSON.stringify(debug)),
      run: JSON.parse(JSON.stringify(run)),
      mode: window.kkState.mode,
      currentRoom: window.kkState.run.currentRoom,
      forestTrialActive: !!window.kkState.run.forestTrialActive,
    };
  });
}

async function setHero(page, x, z) {
  await page.evaluate(({ x, z }) => {
    const s = window.kkState;
    s.hero.pos.set(x, 0, z);
    s.hero.vel.set(0, 0, 0);
    if (s.hero.mesh) {
      s.hero.mesh.position.x = x;
      s.hero.mesh.position.z = z;
    }
  }, { x, z });
}

async function usePortal(page, kind, roomId) {
  return page.evaluate(async ({ kind, roomId }) => {
    const portals = await import('./src/forestPortals.js');
    const s = window.kkState;
    const portal = portals.getForestPortals().find((p) => kind === 'outbound'
      ? p.kind === 'outbound' && p.destRoomId === roomId
      : p.kind === 'return' && p.roomId === roomId);
    if (!portal) return { found: false, moved: false };

    // Test isolation: portal cooldown is presentation/anti-bounce, not trial
    // progression. Clear it so a same-room idempotency probe needn't sleep 6s.
    portal.cooldownUntil = 0;
    portal.localStepGuard = 0;
    s.hero.pos.set(portal.x, 0, portal.z);
    s.hero.vel.set(0, 0, 0);
    if (s.hero.mesh) {
      s.hero.mesh.position.x = portal.x;
      s.hero.mesh.position.z = portal.z;
    }
    s.input.interactPressed = false;
    portals.tickForestPortals(0, s);
    const before = { x: s.hero.pos.x, z: s.hero.pos.z };
    s.input.interactPressed = true;
    portals.tickForestPortals(1 / 60, s);
    s.input.interactPressed = false;
    const after = { x: s.hero.pos.x, z: s.hero.pos.z };
    return {
      found: true,
      id: portal.id,
      sealed: !!portal._sealed,
      moved: Math.hypot(after.x - before.x, after.z - before.z) > 1,
      before,
      after,
    };
  }, { kind, roomId });
}

async function settlePortalTransition(page, kind, roomId) {
  return page.evaluate(async ({ kind, roomId }) => {
    const rooms = await import('./src/forestRooms.js');
    const portals = await import('./src/forestPortals.js');
    const trials = await import('./src/forestSealedDoors.js');
    const s = window.kkState;
    const transfer = s.run._forestPortalTransfer;
    const detected = rooms.detectRoom(s.hero.pos.x, s.hero.pos.z);
    const expected = kind === 'outbound' ? roomId : 'glade';
    if (!transfer && detected === expected && s.run.currentRoom === expected) {
      return { ok: true, detected, roomState: s.run.roomState, alreadySettled: true };
    }
    const valid = !!(transfer && detected === expected
      && transfer.to === expected
      && transfer.kind === kind
      && transfer.from === s.run.currentRoom);
    if (!valid) {
      return { ok: false, detected, expected, currentRoom: s.run.currentRoom, transfer };
    }
    s.run.currentRoom = detected;
    s.run.roomState = 'TRANSITIONING';
    s.run._forestPortalTransfer = null;
    trials.onRoomEnter(detected, {
      viaPortal: true,
      kind: transfer.kind,
      portalId: transfer.portalId,
      from: transfer.from,
    });
    s.run.roomState = detected === 'glade'
      ? 'ARENA'
      : (s.run.forestTrialActive ? 'PORTAL_TRIAL' : 'IN_ROOM');
    portals.tickForestPortals(0, s);
    return { ok: true, detected, roomState: s.run.roomState };
  }, { kind, roomId });
}

async function waitForRoom(page, roomId) {
  try {
    await page.waitForFunction((id) => window.kkState.run.currentRoom === id, roomId, {
      timeout: STEP_TIMEOUT,
    });
  } catch (_) {
    const detail = await page.evaluate(async () => {
      const { detectRoom } = await import('./src/forestRooms.js');
      const s = window.kkState;
      return {
        currentRoom: s.run.currentRoom,
        hero: { x: s.hero.pos.x, z: s.hero.pos.z },
        detected: detectRoom(s.hero.pos.x, s.hero.pos.z),
        transfer: s.run._forestPortalTransfer,
        roomState: s.run.roomState,
        paused: s.time.paused,
        pendingLevelUp: s.pendingLevelUp,
      };
    });
    throw new Error(`waitForRoom(${roomId}) timed out: ${JSON.stringify(detail)}`);
  }
}

async function taggedTrialCount(page, roomId) {
  return page.evaluate((id) => window.kkState.enemies.active.filter((e) => e && e.alive && (
    e._roomBossId === id
    || e._forestTrialRoom === id
    || e._forestTrialRoomId === id
    || e._portalTrialRoomId === id
    || e._trialRoomId === id
  )).length, roomId);
}

async function assertDuplicateEnterIsIdempotent(page, roomId) {
  const result = await page.evaluate(async (id) => {
    const trials = await import('./src/forestSealedDoors.js');
    const s = window.kkState;
    const count = () => s.enemies.active.filter((e) => e && e.alive && (
      e._roomBossId === id
      || e._forestTrialRoom === id
      || e._forestTrialRoomId === id
      || e._portalTrialRoomId === id
      || e._trialRoomId === id
    )).length;
    const before = JSON.parse(JSON.stringify(s.run.forestPortalTrials));
    const beforeCount = count();
    trials.onRoomEnter(id);
    trials.onRoomEnter(id);
    return {
      before,
      after: JSON.parse(JSON.stringify(s.run.forestPortalTrials)),
      beforeCount,
      afterCount: count(),
    };
  }, roomId);
  assert(result.afterCount === result.beforeCount,
    `${roomId}: duplicate room-enter spawned ${result.afterCount - result.beforeCount} extra trial enemies`);
  assert(result.after.cleared === result.before.cleared,
    `${roomId}: duplicate room-enter changed clear count`);
  assert(statusOf(result.after.rooms[roomId]) === statusOf(result.before.rooms[roomId]),
    `${roomId}: duplicate room-enter changed trial status`);
}

async function clearTrialRoom(page, roomId) {
  let last = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    last = await snapshot(page);
    const rec = last.run.rooms[roomId];
    if (statusOf(rec) === 'CLEARED') return last;

    await page.evaluate(async (id) => {
      const { FOREST_ROOMS } = await import('./src/forestRooms.js');
      const enemies = await import('./src/enemies.js');
      const trials = await import('./src/forestSealedDoors.js');
      const s = window.kkState;
      const room = FOREST_ROOMS[id];
      const candidates = s.enemies.active.slice().filter((e) => {
        if (!e || !e.alive || !e.mesh) return false;
        const tagged = e._roomBossId === id
          || e._forestTrialRoom === id
          || e._forestTrialRoomId === id
          || e._portalTrialRoomId === id
          || e._trialRoomId === id;
        const p = e.mesh.position;
        const inside = room && p.x >= room.bounds.minX && p.x <= room.bounds.maxX
          && p.z >= room.bounds.minZ && p.z <= room.bounds.maxZ;
        return tagged || inside;
      });
      for (const e of candidates) enemies.killEnemy(e);
      // Drive the same production tick directly so SwiftShader's low render
      // FPS does not turn each authored 0.9s intermission into tens of seconds.
      trials.tickForestSealedDoors(s, 0);
      const rec = s.run.forestPortalTrials.rooms[id];
      if (rec && rec.phase === 'INTERMISSION') {
        s.time.game = Math.max(s.time.game, Number(rec.nextWaveAt) || 0) + 0.01;
        trials.tickForestSealedDoors(s, 0);
      }
    }, roomId);
    await page.waitForTimeout(80);
  }
  throw new Error(`${roomId}: trial did not clear; last=${JSON.stringify(last && last.run.rooms[roomId])}`);
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
    // Font CDNs are outside this gameplay contract. Stub them so a networkless
    // CI runner cannot fail after all six real portal trials have completed.
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

    await page.goto(`${ORIGIN}/index.html?smoke=forest-portal-trials`, {
      waitUntil: 'load', timeout: BOOT_TIMEOUT,
    });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, {
      timeout: BOOT_TIMEOUT,
    });
    await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      const meta = await import('./src/meta.js');
      meta.setOption('selectedStage', 'forest');
      meta.setOption('optMusic', false);
      meta.setOption('optAutoFirePrimary', false);
      window.kkState.replaySeed = {
        seed: 'forest-portal-trials-v1', stage: 'forest', character: 'kitty', mode: 'normal',
      };
      window.kkState.weapons.length = 0;
      await window.kkStartRun();
    });
    await page.waitForFunction(() => window.kkState.started
      && window.kkState.mode === 'run'
      && window.kkState.run.stage.id === 'forest'
      && window.kkState.run.forestPortalTrials, null, { timeout: BOOT_TIMEOUT });
    console.log('smoke-forest-portal-trials: Forest booted');
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const s = window.kkState;
      s.hero.hpMax = 1e9;
      s.hero.hp = 1e9;
      s.hero.xpNext = 1e9;
      // Puzzle overlays are orthogonal to the room-combat progression and can
      // capture input after a portal transfer, so mark them solved for this QA.
      s.run.forestPuzzlesSolved = {
        flow_weaver: true,
        harmonic_alignment: true,
        prism_lock: true,
        mossroot_pulse: true,
      };
    });

    const initial = await snapshot(page);
    assert(initial.api && initial.debug, 'Forest trial public/debug API is missing');
    assert(initial.run.total === 6, `Forest trial total=${initial.run.total}, expected 6`);
    assert(initial.run.cleared === 0, `Forest trials started at ${initial.run.cleared}/6`);
    assert(initial.run.bossUnlocked === false, 'boss portal started unlocked');
    assert(initial.run.activeRoom == null, `initial active room=${initial.run.activeRoom}`);
    const roomIds = Object.keys(initial.run.rooms).sort();
    assert(roomIds.length === initial.run.total, `trial room registry has ${roomIds.length}/${initial.run.total} rooms`);
    assert(roomIds.every((id) => statusOf(initial.run.rooms[id]) === 'AVAILABLE'),
      `initial room states are not all AVAILABLE: ${JSON.stringify(initial.run.rooms)}`);
    console.log(`smoke-forest-portal-trials: topology ready (${roomIds.length} rooms)`);

    const topology = await page.evaluate(async () => {
      const portals = await import('./src/forestPortals.js');
      const p = portals.getForestPortals();
      return {
        outbound: p.filter((x) => x.kind === 'outbound').map((x) => x.destRoomId).sort(),
        returns: p.filter((x) => x.kind === 'return').map((x) => x.roomId).sort(),
      };
    });
    assert(JSON.stringify(topology.outbound) === JSON.stringify(roomIds),
      `outbound portal topology=${JSON.stringify(topology.outbound)}, trials=${JSON.stringify(roomIds)}`);
    assert(JSON.stringify(topology.returns) === JSON.stringify(roomIds),
      `return portal topology=${JSON.stringify(topology.returns)}, trials=${JSON.stringify(roomIds)}`);

    // Every environmental hazard center must stay outside the 5u safety
    // envelope around side-room entry/return anchors. This catches the exact
    // low-HP departure-frame regression where a falling branch resolved before
    // portal activation could grant arrival i-frames.
    const hazardSafety = await page.evaluate(async () => {
      const hazards = await import('./src/forestEnvHazards.js');
      const snap = hazards._debugForestEnvHazardPlacements();
      const all = [
        ...snap.mushroomRings.map((p) => ({ ...p, kind: 'mushroom' })),
        ...snap.tarPits.map((p) => ({ ...p, kind: 'tar' })),
        ...snap.branchTriggers.map((p) => ({ ...p, kind: 'branch' })),
      ];
      let min = Infinity;
      let nearest = null;
      for (const h of all) for (const a of snap.travelAnchors) {
        const d = Math.hypot(h.x - a.x, h.z - a.z);
        if (d < min) { min = d; nearest = { hazard: h, anchor: a }; }
      }
      return { radius: snap.portalKeepoutRadius, min, nearest, hazards: all.length, anchors: snap.travelAnchors.length };
    });
    assert(hazardSafety.hazards > 0 && hazardSafety.anchors === roomIds.length * 2,
      `hazard safety registry incomplete: ${JSON.stringify(hazardSafety)}`);
    assert(hazardSafety.min + 1e-3 >= hazardSafety.radius,
      `Forest hazard inside portal keepout: ${JSON.stringify(hazardSafety)}`);
    console.log(`smoke-forest-portal-trials: ${hazardSafety.hazards} hazards clear ${hazardSafety.anchors} travel anchors (min ${hazardSafety.min.toFixed(2)}u)`);

    const forestObjective = await page.evaluate(async () => {
      const shards = await import('./src/portalShards.js');
      const map = shards._debugPortalShardMap();
      return {
        locations: map.locations.length,
        randomPortal: !!map.portal,
        portalShards: window.kkState.run.portalShards,
      };
    });
    assert(forestObjective.locations === 0 && !forestObjective.randomPortal,
      `Forest still spawned random shard objective: ${JSON.stringify(forestObjective)}`);
    assert(forestObjective.portalShards === 0, `Forest shard counter=${forestObjective.portalShards}`);

    // The gate communicates the lock and rejects direct calls, not just the
    // proximity input path. The second check is the transactional recheck that
    // prevents another caller from bypassing the room requirement.
    const lockedGate = await page.evaluate(async () => {
      const catacomb = await import('./src/catacomb.js');
      const s = window.kkState;
      const gate = catacomb.FOREST_BOSS_GATE_POS;
      s.hero.pos.set(gate.x, 0, gate.z);
      if (s.hero.mesh) { s.hero.mesh.position.x = gate.x; s.hero.mesh.position.z = gate.z; }
      s.input.interactPressed = false;
      catacomb.tickCatacombEntrance(1 / 60);
      const prompt = document.getElementById('kk-catacomb-prompt');
      const entered = await catacomb.enterCatacomb({ x: gate.x, y: 0, z: gate.z });
      return {
        entered,
        mode: s.mode,
        promptVisible: !!prompt && prompt.style.display !== 'none',
        prompt: prompt && prompt.textContent,
      };
    });
    assert(!lockedGate.entered && lockedGate.mode === 'run', 'locked boss portal allowed Catacomb entry');
    assert(lockedGate.promptVisible, 'locked boss portal has no proximity prompt');
    assert(/LOCK|CLEAR|TRIAL|ROOM|0\s*\/\s*6/i.test(lockedGate.prompt || ''),
      `locked boss portal prompt is unclear: ${JSON.stringify(lockedGate.prompt)}`);
    console.log('smoke-forest-portal-trials: locked gate rejected entry');

    // The old time-based finale must not bypass the new exploration gate.
    const noTimedBypass = await page.evaluate(async () => {
      const director = await import('./src/spawnDirector.js');
      const s = window.kkState;
      const before = s.time.game;
      s.time.game = 605;
      director.tickSpawnDirector(1 / 60);
      const liveFinalBosses = s.enemies.active.filter((e) => e && e.alive && e.isFinalBoss).length;
      const unrelatedBossEncounters = s.enemies.active.filter((e) => e && e.alive
        && !e._forestTrialRoom && (e.isMiniBoss || e.isNemesis)).length;
      s.time.game = before;
      director.tickSpawnDirector(0);
      return {
        liveFinalBosses,
        unrelatedBossEncounters,
        bossUnlocked: s.run.forestPortalTrials.bossUnlocked,
      };
    });
    assert(noTimedBypass.liveFinalBosses === 0 && !noTimedBypass.bossUnlocked,
      `time-based finale bypassed locked Forest trials: ${JSON.stringify(noTimedBypass)}`);
    assert(noTimedBypass.unrelatedBossEncounters === 0,
      `legacy timed encounter leaked into Forest portal route: ${JSON.stringify(noTimedBypass)}`);
    await page.evaluate(async () => {
      const s = window.kkState;
      // The artificial schedule jump is not allowed to leave a tutorial or
      // first-boss presentation pause behind; neither belongs to this smoke.
      if (window.__kkCutsceneActive && window.__kkSkipCutscene) window.__kkSkipCutscene();
      s.time.paused = false;
    });
    await page.waitForTimeout(120);
    console.log('smoke-forest-portal-trials: timed bypass and setup cleanup passed');

    // Ownership guards: neither a non-Forest stage nor Catacomb mode may
    // mutate the Forest trial state even if a caller invokes the room hook.
    const ownerGuards = await page.evaluate(async (id) => {
      const trials = await import('./src/forestSealedDoors.js');
      const s = window.kkState;
      const originalStage = s.run.stage;
      const originalMode = s.mode;
      const baseline = JSON.stringify(s.run.forestPortalTrials);
      s.run.stage = { ...originalStage, id: 'twilight' };
      trials.onRoomEnter(id);
      const nonForest = JSON.stringify(s.run.forestPortalTrials) === baseline;
      s.run.stage = originalStage;
      s.mode = 'catacomb';
      trials.onRoomEnter(id);
      const catacomb = JSON.stringify(s.run.forestPortalTrials) === baseline;
      s.mode = originalMode;
      return { nonForest, catacomb };
    }, roomIds[0]);
    assert(ownerGuards.nonForest, 'non-Forest room hook mutated Forest trials');
    assert(ownerGuards.catacomb, 'Catacomb-owned mode mutated Forest trials');
    console.log('smoke-forest-portal-trials: ownership guards passed');

    // Walking/warping into a side room is not a valid claim. A real outbound
    // portal transfer must mint the one-shot trial-entry intent.
    const probeRoom = roomIds[0];
    const probeCenter = await page.evaluate(async (id) => {
      const { FOREST_ROOMS } = await import('./src/forestRooms.js');
      return FOREST_ROOMS[id].center;
    }, probeRoom);
    await setHero(page, probeCenter.x, probeCenter.z);
    await page.waitForTimeout(800);
    let probe = await snapshot(page);
    assert(probe.currentRoom === 'glade'
      && statusOf(probe.run.rooms[probeRoom]) === 'AVAILABLE'
      && probe.run.activeRoom == null,
    `walking into ${probeRoom} escaped containment or started a portal trial`);
    await setHero(page, 0, 0);
    await waitForRoom(page, 'glade');
    console.log('smoke-forest-portal-trials: portal-only containment passed');

    let previousCleared = 0;
    if (TAIL_ONLY) {
      await page.evaluate(async (ids) => {
        const portals = await import('./src/forestPortals.js');
        const enemies = await import('./src/enemies.js');
        const s = window.kkState;
        for (const e of s.enemies.active.slice()) {
          if (!e) continue;
          e.alive = false;
          try { s.enemies.spatial.remove(e); } catch (_) {}
          try { enemies.releaseEnemyVisual(e); } catch (_) {}
        }
        s.enemies.active.length = 0;
        const trial = s.run.forestPortalTrials;
        for (const id of ids) {
          Object.assign(trial.rooms[id], {
            status: 'CLEARED', phase: 'CLEARED', wave: trial.rooms[id].waves, live: 0,
          });
          s.run._sealedRooms[id] = {
            bossId: 'tail-only', alive: false, wave: trial.rooms[id].waves,
          };
        }
        for (const p of portals.getForestPortals()) if (p.kind === 'return') p._sealed = false;
        trial.cleared = trial.total;
        trial.bossUnlocked = true;
        trial.activeRoom = null;
        s.run.forestTrialActive = false;
        s.run.currentRoom = 'glade';
        s.run.roomState = 'ARENA';
        s.run._forestPortalTransfer = null;
        s.time.paused = false;
      }, roomIds);
      previousCleared = roomIds.length;
      console.log('smoke-forest-portal-trials: TAIL_ONLY seeded completed trials');
    } else {
      for (let i = 0; i < roomIds.length; i++) {
      const roomId = roomIds[i];
      console.log(`smoke-forest-portal-trials: entering ${roomId}`);
      const transfer = await usePortal(page, 'outbound', roomId);
      assert(transfer.found && transfer.moved, `${roomId}: outbound portal did not transfer hero`);
      if (i === 0) {
        // One full rAF/main-loop integration proves the transfer token reaches
        // the room coordinator. Remaining rooms settle the exact same token
        // synchronously to keep SwiftShader CI under a practical runtime.
        await waitForRoom(page, roomId);
      } else {
        const settled = await settlePortalTransition(page, 'outbound', roomId);
        assert(settled.ok, `${roomId}: invalid outbound transfer ${JSON.stringify(settled)}`);
      }
      await page.waitForFunction((id) => {
        const rec = window.kkState.run.forestPortalTrials.rooms[id];
        return rec && ['PREPARING', 'ACTIVE'].includes(String(rec.status).toUpperCase());
      }, roomId, { timeout: STEP_TIMEOUT });
      let live = await snapshot(page);
      assert(live.run.activeRoom === roomId, `${roomId}: activeRoom=${live.run.activeRoom}`);
      assert(Object.entries(live.run.rooms).filter(([, rec]) =>
        ['PREPARING', 'ACTIVE'].includes(statusOf(rec))).length === 1,
      `${roomId}: more than one trial active`);
      assert(await taggedTrialCount(page, roomId) > 0 || Number(live.run.rooms[roomId].live) > 0,
        `${roomId}: trial activated without owned enemies`);
      await assertDuplicateEnterIsIdempotent(page, roomId);

      live = await clearTrialRoom(page, roomId);
      assert(statusOf(live.run.rooms[roomId]) === 'CLEARED', `${roomId}: did not reach CLEARED`);
      assert(live.run.cleared === previousCleared + 1,
        `${roomId}: clear count ${live.run.cleared}, expected ${previousCleared + 1}`);
      assert(i === roomIds.length - 1 ? live.run.bossUnlocked : !live.run.bossUnlocked,
        `${roomId}: boss portal unlock timing is wrong`);
      assert(live.forestTrialActive,
        `${roomId}: normal spawning resumed before the hero left the cleared chamber`);
      previousCleared = live.run.cleared;
      console.log(`smoke-forest-portal-trials: cleared ${roomId} (${previousCleared}/${roomIds.length})`);

      const returned = await usePortal(page, 'return', roomId);
      assert(returned.found && !returned.sealed && returned.moved,
        `${roomId}: cleared room return portal remained sealed`);
      const returnSettled = await settlePortalTransition(page, 'return', roomId);
      assert(returnSettled.ok, `${roomId}: invalid return transfer ${JSON.stringify(returnSettled)}`);
      assert(!(await page.evaluate(() => window.kkState.run.forestTrialActive)),
        `${roomId}: trial spawn pause survived the return to the Glade`);

      // Exercise one actual duplicate portal visit. Either a completed portal
      // is disabled, or it remains a sightseeing route; both are valid, but it
      // must never spawn/credit another encounter.
      if (i === 0) {
        const beforeCount = await taggedTrialCount(page, roomId);
        const revisit = await usePortal(page, 'outbound', roomId);
        if (revisit.moved) {
          const revisitSettled = await settlePortalTransition(page, 'outbound', roomId);
          assert(revisitSettled.ok, `${roomId}: invalid repeat transfer ${JSON.stringify(revisitSettled)}`);
          await page.waitForTimeout(120);
        } else {
          await page.waitForTimeout(250);
        }
        const revisited = await snapshot(page);
        assert(statusOf(revisited.run.rooms[roomId]) === 'CLEARED'
          && revisited.run.cleared === previousCleared,
        `${roomId}: repeat visit changed completed progression`);
        assert(await taggedTrialCount(page, roomId) === beforeCount,
          `${roomId}: repeat visit spawned a duplicate encounter`);
        if (revisit.moved) {
          const returnAgain = await usePortal(page, 'return', roomId);
          assert(returnAgain.found && returnAgain.moved, `${roomId}: repeat visit could not return`);
          const repeatReturnSettled = await settlePortalTransition(page, 'return', roomId);
          assert(repeatReturnSettled.ok,
            `${roomId}: invalid repeat return ${JSON.stringify(repeatReturnSettled)}`);
        }
      }
      }
    }

    const unlocked = await snapshot(page);
    assert(unlocked.run.cleared === unlocked.run.total && unlocked.run.total === roomIds.length,
      `all-clear progress=${unlocked.run.cleared}/${unlocked.run.total}`);
    assert(unlocked.run.bossUnlocked && unlocked.run.activeRoom == null,
      `all-clear did not unlock boss portal: ${JSON.stringify(unlocked.run)}`);
    assert(Object.values(unlocked.run.rooms).every((rec) => statusOf(rec) === 'CLEARED'),
      'boss portal unlocked before every room was CLEARED');
    console.log('smoke-forest-portal-trials: boss gate unlocked; entering Catacomb');

    // Enter through the real proximity/input path after unlock.
    const gateEntry = await page.evaluate(async () => {
      const catacomb = await import('./src/catacomb.js');
      const s = window.kkState;
      const gate = catacomb.FOREST_BOSS_GATE_POS;
      s.hero.pos.set(gate.x, 0, gate.z);
      s.hero.vel.set(0, 0, 0);
      if (s.hero.mesh) { s.hero.mesh.position.x = gate.x; s.hero.mesh.position.z = gate.z; }
      s.input.interactPressed = true;
      catacomb.tickCatacombEntrance(1 / 60);
      s.input.interactPressed = false;
      const entered = await catacomb.enterCatacomb({ x: gate.x, y: 0, z: gate.z });
      return {
        entered,
        mode: s.mode,
        phase: s.run.dungeonPhase,
        paused: s.time.paused,
        gameOver: s.gameOver,
        pendingLevelUp: s.pendingLevelUp,
        lockdownActive: s.run.lockdownActive,
        currentRoom: s.run.currentRoom,
        sealedRoom: s.run._sealedRooms && s.run._sealedRooms[s.run.currentRoom],
        liveBossEncounters: s.enemies.active.filter((e) => e && e.alive
          && (e.isFinalBoss || e.isMiniBoss || e.isNemesis)).length,
      };
    });
    assert(gateEntry.entered && gateEntry.mode === 'catacomb',
      `unlocked Boss Gate entry failed: ${JSON.stringify(gateEntry)}`);
    const entered = await page.evaluate(async () => {
      const trials = await import('./src/forestSealedDoors.js');
      const s = window.kkState;
      const forestRoot = s.scene.getObjectByName('__forestPortals');
      const portalPrompt = document.getElementById('kk-forest-portal-prompt');
      const sealedPrompt = document.getElementById('kk-sealed-prompt');
      const minimap = document.getElementById('kk-portal-minimap');
      return {
        phase: s.run.dungeonPhase,
        progress: trials.getForestTrialProgress(),
        forestHidden: !forestRoot || forestRoot.visible === false,
        portalPromptHidden: !portalPrompt || portalPrompt.style.display === 'none',
        sealedPromptHidden: !sealedPrompt || sealedPrompt.style.opacity === '0',
        minimapHidden: !minimap || minimap.style.display === 'none',
      };
    });
    assert(entered.phase === 'ACTIVE', `unlocked boss portal entered with phase=${entered.phase}`);
    assert(entered.progress.bossUnlocked && entered.progress.cleared === entered.progress.total,
      'Catacomb entry corrupted Forest trial completion');
    assert(entered.forestHidden && entered.portalPromptHidden
      && entered.sealedPromptHidden && entered.minimapHidden,
    `Forest UI/scene leaked into Catacomb: ${JSON.stringify(entered)}`);
    assert(errors.length === 0, errors.join(' | '));

    console.log(TAIL_ONLY
      ? 'smoke-forest-portal-trials: PASS — Boss Gate tail unlocked and entered Catacomb'
      : `smoke-forest-portal-trials: PASS — ${roomIds.length} entered/cleared once, boss gate unlocked, Catacomb entered`);
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(`smoke-forest-portal-trials: FAIL — ${e.message}`);
  process.exitCode = 1;
});
