#!/usr/bin/env node
/**
 * Pipes Rescue Hook regression smoke.
 *
 * Boots real Forest runs and guards the input, combat, rendering, allocation,
 * and teardown contract of Pipes' hold-RMB grapple. Test-only state placement
 * keeps horde/director randomness out of collision assertions; all action edges
 * (RMB, LMB, Q) still enter through production browser input handlers.
 *
 * Run: node tools/smoke-pipes-grapple.mjs   Port: 8953 by default.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8953);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TIMEOUT = 90_000;
const SCREENSHOT = process.env.PIPES_GRAPPLE_SCREENSHOT || '';
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const require = createRequire(import.meta.url);

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
  if (/\.(?:ogg|wav)$/.test(p)) return 'audio/ogg';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); res.end('bad path'); return; }
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end(`not found: ${rel}`); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function describeError(e) {
  return e && (e.stack || e.message) ? (e.stack || e.message) : String(e);
}

async function main() {
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(CHROME)) {
    throw new Error('shared Playwright/Chromium cache is missing');
  }
  if (SCREENSHOT) fs.mkdirSync(path.dirname(path.resolve(SCREENSHOT)), { recursive: true });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
      '--enable-webgl', '--ignore-gpu-blocklist',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const failures = [];
  const browserErrors = [];
  const pendingLocal = new Set();
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const isLocal = (url) => {
    try { return new URL(url).origin === ORIGIN; } catch (_) { return false; }
  };

  page.on('pageerror', (e) => browserErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Google Fonts is optional presentation and unavailable in some CI
    // sandboxes. Local/runtime console errors remain fatal.
    const source = m.location()?.url || '';
    if (m.type() === 'error' && (!source || isLocal(source))) {
      browserErrors.push(`console.error${source ? ` (${source})` : ''}: ${m.text()}`);
    }
  });
  page.on('request', (r) => { if (isLocal(r.url())) pendingLocal.add(r); });
  page.on('requestfinished', (r) => pendingLocal.delete(r));
  page.on('requestfailed', (r) => {
    pendingLocal.delete(r);
    const errorText = r.failure()?.errorText || 'unknown';
    // Mode changes intentionally cancel lazy stage-roster GLBs and replace the
    // optional menu music element. Chromium reports both as ERR_ABORTED: no
    // failed response occurred. HTTP >=400 and every non-abort local request
    // failure remain fatal through this and the response listener below.
    const intentionalLifecycleAbort = errorText.includes('ERR_ABORTED');
    if (isLocal(r.url()) && !intentionalLifecycleAbort) {
      browserErrors.push(`requestfailed: ${r.url()} (${errorText})`);
    }
  });
  page.on('response', (r) => {
    if (isLocal(r.url()) && r.status() >= 400) browserErrors.push(`response ${r.status()}: ${r.url()}`);
  });

  try {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
    });
    await page.goto(`${ORIGIN}/index.html?smoke=pipes-grapple`, {
      waitUntil: 'load', timeout: TIMEOUT,
    });
    await page.waitForFunction(
      () => typeof window.kkStartRun === 'function' && !!window.kkState,
      null, { timeout: TIMEOUT },
    );

    // Install a test-page facade around public module exports. It is not a
    // production hook and deliberately exposes no private implementation.
    await page.evaluate(async () => {
      const grapple = await import('./src/weapons/sig/pipes_grapple.js');
      window.__pipesSmoke = {
        debug: grapple.getPipesGrappleDebug,
        cancel: grapple.cancelPipesGrapple,
      };
    });

    // Negative gate first: a real Kitty RMB may queue the generic active, but
    // it must never create/drive a Pipes hook state or visible grapple root.
    await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.setOption('selectedAvatar', 'kitty');
      meta.setOption('selectedStage', 'forest');
      meta.setOption('optMusic', false);
      meta.setOption('optDaily', false);
      meta.setOption('optWeekly', false);
      meta.setOption('optAutoFirePrimary', false);
      await window.kkStartRun();
    });
    await page.waitForFunction(
      () => window.kkState.mode === 'run' && window.kkState.run.avatar === 'kitty',
      null, { timeout: TIMEOUT },
    );
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(180);
    const kittyGate = await page.evaluate(() => {
      const s = window.kkState;
      const d = window.__pipesSmoke.debug();
      const root = s.scene.getObjectByName('__pipesGrapple');
      return {
        avatar: s.run.avatar,
        eligible: d.eligible,
        phase: d.phase,
        activeVisuals: d.activeVisuals,
        visibleRoot: !!(root && root.visible),
      };
    });
    await page.mouse.up({ button: 'right' });
    check(kittyGate.avatar === 'kitty' && !kittyGate.eligible
      && kittyGate.phase === 'idle' && kittyGate.activeVisuals === 0
      && !kittyGate.visibleRoot,
    `Kitty RMB escaped the Pipes-only gate: ${JSON.stringify(kittyGate)}`);

    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => window.kkState.mode === 'menu' && !window.kkState.started);

    // Unlock, select, and boot the real Pipes starter kit.
    await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.unlockAvatar('pipes', 'smoke');
      meta.setOption('selectedAvatar', 'pipes');
      meta.setOption('selectedStage', 'forest');
      meta.setOption('optAutoFirePrimary', false);
      await window.kkStartRun();
    });
    await page.waitForFunction(
      () => window.kkState.mode === 'run'
        && window.kkState.run.avatar === 'pipes'
        && window.kkState.weapons.some((w) => w.id === 'sig_pipes_arcwrench')
        && window.kkState.weapons.some((w) => w.id === 'primary'),
      null, { timeout: TIMEOUT },
    );

    const setup = await page.evaluate(async () => {
      const enemies = await import('./src/enemies.js');
      const config = await import('./src/config.js');
      const s = window.kkState;
      // Pause director top-ups without pausing input/weapon ticks.
      s.run.lockdownActive = true;
      s.pendingLevelUp = false;
      s.time.paused = false;
      s.gameOver = false;
      s.hero.hp = s.hero.hpMax = 1e9;
      s.hero.iFramesUntil = 1e9;
      s.hero.pos.set(0, 0, 0);
      s.hero.facing.set(1, 0, 0);
      if (s.hero.mesh) s.hero.mesh.position.set(0, s.hero.mesh.position.y, 0);

      for (const e of [...s.enemies.active]) {
        try { s.enemies.spatial.remove(e); } catch (_) {}
        try { enemies.releaseEnemyVisual(e); } catch (_) {}
      }
      s.enemies.active.length = 0;
      try { s.enemies.spatial.clear(); } catch (_) {}

      const base = config.ENEMY_TIERS.find((t) => t.glb === 'zombie')
        || config.ENEMY_TIERS.find((t) => t.glb === 'ant')
        || config.ENEMY_TIERS.find((t) => !t.elite && !t.isMiniBoss && !t.isFinalBoss);
      const tier = { ...base, hp: 50_000, spd: 0, dmg: 0, ranged: null, fixedAffix: null };
      const target = enemies.spawnEnemy(tier, 6, 0);
      if (!target) return { spawned: false };
      target.hp = target.hpMax = 50_000;
      target.spd = 0;
      target.dmg = 0;
      target.ranged = null;
      target.affixes = null;
      target._heavy = false;
      target._noKnockback = false;
      target.knockVx = target.knockVz = 0;
      window.__pipesTarget = target;
      window.__pipesTier = tier;

      const sig = s.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
      const primary = s.weapons.find((w) => w.id === 'primary');
      // Keep the automatic line bolt out of HP/aim evidence; the manual
      // primary remains enabled below. Extend hold only to remove CI timing.
      sig.inst.cd = 999;
      sig.inst.grappleCd = 0;
      sig.inst.grappleTune.maxHold = 6;
      primary.inst.cd = 0;
      s.run.dmgByWeapon = {};
      return {
        spawned: true,
        targetUuid: target.mesh.uuid,
        avatar: s.run.avatar,
        weaponIds: s.weapons.map((w) => w.id),
      };
    });
    check(setup.spawned, `could not spawn a valid grapple target: ${JSON.stringify(setup)}`);

    // Real RMB edge must fly and acquire the deterministic valid mob.
    await page.mouse.down({ button: 'right' });
    await page.waitForFunction(
      () => window.__pipesSmoke.debug().phase === 'orbit',
      null, { timeout: 4_000 },
    ).catch(() => {});
    const orbitA = await page.evaluate(() => {
      const s = window.kkState;
      const d = window.__pipesSmoke.debug();
      const root = s.scene.getObjectByName('__pipesGrapple');
      const chain = root && root.getObjectByName('pipesGrappleChainLinks');
      const hook = root && root.getObjectByName('pipesGrappleHook');
      let roots = 0;
      let fallback = false;
      s.scene.traverse((o) => {
        if (o.name === '__pipesGrapple') roots++;
        if (o.userData && o.userData.fallbackAsset) fallback = true;
      });
      const p = window.__pipesTarget && window.__pipesTarget.mesh.position;
      return {
        debug: { ...d },
        pos: p ? { x: p.x, z: p.z } : null,
        rootCount: roots,
        rootVisible: !!(root && root.visible),
        rootRole: root?.userData?.visualRole || null,
        chainIsInstanced: !!(chain && chain.isInstancedMesh),
        chainCapacity: chain?.instanceMatrix?.count || 0,
        hookVisible: !!(hook && hook.visible),
        fallback,
      };
    });
    await page.waitForTimeout(160);
    const orbitB = await page.evaluate(() => {
      const d = window.__pipesSmoke.debug();
      const p = window.__pipesTarget.mesh.position;
      return { debug: { ...d }, pos: { x: p.x, z: p.z } };
    });
    const orbitMove = orbitA.pos && orbitB.pos
      ? Math.hypot(orbitB.pos.x - orbitA.pos.x, orbitB.pos.z - orbitA.pos.z) : 0;
    check(orbitA.debug.phase === 'orbit' && orbitA.debug.targetUuid === setup.targetUuid,
      `RMB did not acquire the spawned valid mob: ${JSON.stringify(orbitA.debug)}`);
    check(orbitMove > 0.08,
      `captured mob did not orbit (${orbitMove.toFixed(3)}u): ${JSON.stringify(orbitB.debug)}`);
    check(orbitA.rootCount === 1 && orbitA.rootVisible
      && orbitA.rootRole === 'pipes-grapple' && orbitA.chainIsInstanced
      && orbitA.hookVisible && orbitA.debug.chainCount >= 2
      && orbitA.debug.chainCount <= orbitA.debug.poolCapacity
      && orbitA.chainCapacity === orbitA.debug.poolCapacity
      && orbitA.debug.activeVisuals >= 2 && orbitA.debug.activeVisuals <= 3,
    `grapple visual bounds/ownership failed: ${JSON.stringify(orbitA)}`);
    check(!orbitA.fallback,
      'authored Blender grapple hook was not cached; fallback torus rendered instead');

    // The natural orbit was already proven above. Slow it only for this
    // deterministic projectile-contact probe: real LMB still spawns and moves
    // production primary projectiles through the ordinary collision path.
    await page.evaluate(() => {
      const s = window.kkState;
      const sig = s.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
      const primary = s.weapons.find((w) => w.id === 'primary');
      sig.inst.grappleTune.orbitSpeed = 0.18;
      primary.inst.cd = 0;
    });
    const chargeBefore = await page.evaluate(() => window.__pipesSmoke.debug().charge);
    await page.mouse.down({ button: 'left' });
    await page.waitForFunction(
      () => window.kkState.run.pipesGrapplePrimaryHits > 0
        && window.__pipesSmoke.debug().charge > 0,
      null, { timeout: 2_500 },
    ).catch(() => {});
    if (SCREENSHOT) {
      // Capture the first authored charge-crest threshold, not a barely armed
      // cable. Input remains a real held LMB through the production fire path.
      await page.waitForFunction(
        () => window.kkState.run.pipesGrapplePrimaryHits >= 3,
        null, { timeout: 2_000 },
      ).catch(() => {});
    }
    await page.mouse.up({ button: 'left' });
    const chargeAfter = await page.evaluate(() => ({
      charge: window.__pipesSmoke.debug().charge,
      hits: window.kkState.run.pipesGrapplePrimaryHits,
      phase: window.__pipesSmoke.debug().phase,
    }));
    check(chargeAfter.hits > 0 && chargeAfter.charge > chargeBefore,
      `real LMB primary did not charge the captive: ${JSON.stringify({ chargeBefore, chargeAfter })}`);
    if (SCREENSHOT) {
      // The damage-proof test setup uses a huge iframe stamp, whose normal
      // blink animation can hide Pipes on the exact capture frame. Clear only
      // for this optional visual artifact; HP is already enormous.
      await page.evaluate(() => { window.kkState.hero.iFramesUntil = 0; });
      await page.waitForTimeout(80);
      await page.screenshot({ path: path.resolve(SCREENSHOT), fullPage: false });
    }

    // Place real collaterals on the tangent that RMB-up will launch through.
    const victims = await page.evaluate(async () => {
      const enemies = await import('./src/enemies.js');
      const s = window.kkState;
      const sig = s.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
      const inst = sig.inst;
      const p = window.__pipesTarget.mesh.position;
      const dx = -Math.sin(inst.grappleAngle) * inst.grappleOrbitDir;
      const dz =  Math.cos(inst.grappleAngle) * inst.grappleOrbitDir;
      const list = [];
      for (const distance of [1.8, 3.6, 5.4]) {
        const e = enemies.spawnEnemy(window.__pipesTier, p.x + dx * distance, p.z + dz * distance);
        if (!e) continue;
        e.hp = e.hpMax = 50_000;
        e.spd = 0;
        e.dmg = 0;
        e.ranged = null;
        e.affixes = null;
        e.knockVx = e.knockVz = 0;
        list.push({ enemy: e, before: e.hp, uuid: e.mesh.uuid });
      }
      window.__pipesVictims = list;
      s.run.dmgByWeapon.pipes_grapple_throw = 0;
      return { count: list.length, dir: { x: dx, z: dz } };
    });
    check(victims.count >= 2, `could not spawn throw collaterals: ${JSON.stringify(victims)}`);

    await page.mouse.up({ button: 'right' });
    await page.waitForFunction(
      () => window.__pipesSmoke.debug().launchId > 0,
      null, { timeout: 2_000 },
    ).catch(() => {});
    const releaseState = await page.evaluate(() => ({ ...window.__pipesSmoke.debug() }));
    await page.waitForFunction(
      () => (window.kkState.run.dmgByWeapon.pipes_grapple_throw || 0) > 0,
      null, { timeout: 3_000 },
    ).catch(() => {});
    const thrown = await page.evaluate(() => {
      const d = window.__pipesSmoke.debug();
      const rows = (window.__pipesVictims || []).map((v) => ({
        uuid: v.uuid,
        before: v.before,
        after: v.enemy.hp,
        alive: v.enemy.alive,
      }));
      return {
        debug: { ...d },
        damage: window.kkState.run.dmgByWeapon.pipes_grapple_throw || 0,
        victims: rows,
        damagedVictims: rows.filter((v) => v.after < v.before).length,
        targetControl: window.__pipesTarget._combatControl?.kind || null,
      };
    });
    check(releaseState.launchId > 0 && releaseState.lastReleaseSpeed > 0
      && (releaseState.phase === 'thrown' || releaseState.phase === 'idle'),
    `RMB-up did not enter thrown/idle: ${JSON.stringify(releaseState)}`);
    check(thrown.damage > 0 && thrown.damagedVictims > 0 && thrown.debug.throwHits > 0,
      `throw did not damage real collateral with pipes_grapple_throw: ${JSON.stringify(thrown)}`);
    check(thrown.targetControl === null,
      `thrown target retained combat control: ${JSON.stringify(thrown)}`);

    await page.waitForFunction(
      () => window.__pipesSmoke.debug().phase === 'idle',
      null, { timeout: 3_000 },
    ).catch(() => {});

    // Q remains the generic Active trigger for Pipes and cannot relaunch RMB.
    const novaBefore = await page.evaluate(async () => {
      const active = await import('./src/weapons/actives.js');
      active.acquireActive('nova');
      window.kkState.hero.active.cd = 0;
      const d = window.__pipesSmoke.debug();
      return { launchId: d.launchId, phase: d.phase };
    });
    await page.keyboard.press('q');
    await page.waitForFunction(
      () => window.kkState.hero.active && window.kkState.hero.active.cd > 0,
      null, { timeout: 2_000 },
    ).catch(() => {});
    const novaAfter = await page.evaluate(() => {
      const d = window.__pipesSmoke.debug();
      return {
        activeId: window.kkState.hero.active?.id || null,
        activeCd: window.kkState.hero.active?.cd || 0,
        launchId: d.launchId,
        phase: d.phase,
      };
    });
    check(novaAfter.activeId === 'nova' && novaAfter.activeCd > 0
      && novaAfter.launchId === novaBefore.launchId && novaAfter.phase === 'idle',
    `Q did not cast Nova independently of grapple: ${JSON.stringify({ novaBefore, novaAfter })}`);

    // Warm/reuse cycles: public cancel is the intended lifecycle escape hatch.
    // Physical RMB edges still acquire each cycle; the bounded root/pools must
    // plateau rather than adding objects, geometries, textures, or allocations.
    await page.evaluate(async () => {
      const enemies = await import('./src/enemies.js');
      const s = window.kkState;
      for (const e of [...s.enemies.active]) {
        try { s.enemies.spatial.remove(e); } catch (_) {}
        try { enemies.releaseEnemyVisual(e); } catch (_) {}
      }
      s.enemies.active.length = 0;
      try { s.enemies.spatial.clear(); } catch (_) {}
      const e = enemies.spawnEnemy(window.__pipesTier, 6, 0);
      e.hp = e.hpMax = 50_000;
      e.spd = 0; e.dmg = 0; e.ranged = null; e.affixes = null;
      window.__pipesCycleTarget = e;
      s.hero.facing.set(1, 0, 0);
      const sig = s.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
      sig.inst.grappleCd = 0;
      sig.inst.grappleTune.maxHold = 6;
      sig.inst.grappleTune.orbitSpeed = 2.15;
    });
    const snapshot = () => page.evaluate(() => {
      const s = window.kkState;
      const d = window.__pipesSmoke.debug();
      let objects = 0, roots = 0, rootObjects = 0, rootDrawables = 0;
      const rootGeometries = new Set();
      const rootMaterials = new Set();
      const root = s.scene.getObjectByName('__pipesGrapple');
      s.scene.traverse((o) => { objects++; if (o.name === '__pipesGrapple') roots++; });
      if (root) root.traverse((o) => {
        rootObjects++;
        if (o.isMesh || o.isInstancedMesh || o.isSprite) rootDrawables++;
        if (o.geometry?.uuid) rootGeometries.add(o.geometry.uuid);
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const mat of mats) if (mat?.uuid) rootMaterials.add(mat.uuid);
      });
      return {
        objects, roots, rootObjects, rootDrawables,
        rootGeometries: rootGeometries.size,
        rootMaterials: rootMaterials.size,
        geometries: s.renderer.info.memory.geometries,
        textures: s.renderer.info.memory.textures,
        allocationCount: d.allocationCount,
        poolCapacity: d.poolCapacity,
        phase: d.phase,
        activeVisuals: d.activeVisuals,
        rootVisible: !!(root && root.visible),
      };
    });

    // One warm cycle settles lazy renderer bookkeeping before the strict
    // plateau. Allocation assertions below then compare steady state to six
    // additional physical-input cycles, not first-use shader/geometry upload.
    await page.mouse.down({ button: 'right' });
    await page.waitForFunction(
      () => window.__pipesSmoke.debug().phase === 'orbit',
      null, { timeout: 1_500 },
    );
    await page.evaluate(() => window.__pipesSmoke.cancel('smoke-warm-cycle'));
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(900);
    const plateauBefore = await snapshot();
    let cycleFailures = 0;
    for (let i = 0; i < 6; i++) {
      // cancel() is synchronous, but the weapon needs one production tick to
      // observe the preceding physical mouseup and clear grappleWasHeld. Wait
      // for that edge instead of relying on a wall-clock sleep under slow CI.
      const released = await page.waitForFunction(() => {
        const sig = window.kkState.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
        return !!sig && sig.inst.grappleWasHeld === false;
      }, null, { timeout: 2_000 }).then(() => true).catch(() => false);
      if (!released) cycleFailures++;
      await page.evaluate(() => {
        const s = window.kkState;
        const e = window.__pipesCycleTarget;
        e.mesh.position.x = s.hero.pos.x + 6;
        e.mesh.position.z = s.hero.pos.z;
        e.knockVx = e.knockVz = 0;
        e.alive = true;
        try { s.enemies.spatial.move(e); } catch (_) {}
        const sig = s.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
        sig.inst.grappleCd = 0;
      });
      await page.mouse.down({ button: 'right' });
      const acquired = await page.waitForFunction(
        () => window.__pipesSmoke.debug().phase === 'orbit',
        null, { timeout: 2_500 },
      ).then(() => true).catch(() => false);
      if (!acquired) cycleFailures++;
      await page.evaluate(() => window.__pipesSmoke.cancel('smoke-cycle'));
      await page.mouse.up({ button: 'right' });
      const clean = await page.waitForFunction(() => {
        const sig = window.kkState.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
        return window.__pipesSmoke.debug().phase === 'idle'
          && !window.__pipesCycleTarget._combatControl
          && !!sig && sig.inst.grappleWasHeld === false;
      }, null, { timeout: 2_000 }).then(() => true).catch(() => false);
      if (!clean) cycleFailures++;
    }
    await page.waitForTimeout(900);
    const plateauAfter = await snapshot();
    check(cycleFailures === 0, `${cycleFailures} grapple acquire/cancel lifecycle checks failed`);
    check(plateauAfter.roots === 1
      && plateauAfter.rootObjects === plateauBefore.rootObjects
      && plateauAfter.rootDrawables === plateauBefore.rootDrawables
      && plateauAfter.rootGeometries === plateauBefore.rootGeometries
      && plateauAfter.rootMaterials === plateauBefore.rootMaterials
      && plateauAfter.objects === plateauBefore.objects
      && plateauAfter.textures === plateauBefore.textures
      && plateauAfter.allocationCount === plateauBefore.allocationCount
      && plateauAfter.poolCapacity === 28
      && plateauAfter.phase === 'idle' && plateauAfter.activeVisuals === 0
      && !plateauAfter.rootVisible,
    `grapple object/draw allocation plateau regressed: ${JSON.stringify({ plateauBefore, plateauAfter })}`);

    // Acquire once more, then take the real run->Town->Menu lifecycle. Weapon
    // disposal must release enemy control and hide (not duplicate) its pool.
    await page.evaluate(() => {
      const s = window.kkState;
      const e = window.__pipesCycleTarget;
      e.mesh.position.x = s.hero.pos.x + 6;
      e.mesh.position.z = s.hero.pos.z;
      e.knockVx = e.knockVz = 0;
      try { s.enemies.spatial.move(e); } catch (_) {}
      const sig = s.weapons.find((w) => w.id === 'sig_pipes_arcwrench');
      sig.inst.grappleCd = 0;
    });
    await page.mouse.down({ button: 'right' });
    await page.waitForFunction(
      () => window.__pipesSmoke.debug().phase === 'orbit',
      null, { timeout: 2_000 },
    ).catch(() => {});
    const lifecycleWasOrbit = await page.evaluate(() => window.__pipesSmoke.debug().phase === 'orbit');
    await page.mouse.up({ button: 'right' });
    await page.evaluate(() => window.kkReturnToTown());
    await page.waitForFunction(() => window.kkState.mode === 'town', null, { timeout: TIMEOUT });
    // Town lazily paints its resident hero roster. Let those local requests
    // finish before Menu disposal so the harness does not manufacture an
    // ERR_ABORTED by tearing down an in-flight selected-avatar fetch.
    {
      const deadline = Date.now() + 15_000;
      while (pendingLocal.size && Date.now() < deadline) await page.waitForTimeout(100);
    }
    const town = await page.evaluate(() => {
      const d = window.__pipesSmoke.debug();
      let roots = 0;
      window.kkState.scene.traverse((o) => { if (o.name === '__pipesGrapple') roots++; });
      const root = window.kkState.scene.getObjectByName('__pipesGrapple');
      return {
        mode: window.kkState.mode,
        phase: d.phase,
        activeVisuals: d.activeVisuals,
        targetControlled: !!window.__pipesCycleTarget._combatControl,
        roots,
        rootVisible: !!(root && root.visible),
      };
    });
    check(lifecycleWasOrbit, 'final lifecycle probe did not reach orbit before Town transition');
    check(town.mode === 'town' && town.phase === 'idle' && town.activeVisuals === 0
      && !town.targetControlled && town.roots === 1 && !town.rootVisible,
    `run->Town grapple disposal failed: ${JSON.stringify(town)}`);

    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => window.kkState.mode === 'menu' && !window.kkState.started);
    {
      const deadline = Date.now() + 15_000;
      while (pendingLocal.size && Date.now() < deadline) await page.waitForTimeout(100);
    }
    const menu = await page.evaluate(() => {
      const d = window.__pipesSmoke.debug();
      const root = window.kkState.scene.getObjectByName('__pipesGrapple');
      return { mode: window.kkState.mode, phase: d.phase, activeVisuals: d.activeVisuals, visible: !!(root && root.visible) };
    });
    check(menu.mode === 'menu' && menu.phase === 'idle' && menu.activeVisuals === 0 && !menu.visible,
      `Town->Menu grapple lifecycle failed: ${JSON.stringify(menu)}`);

    // Let aborts/errors caused by lifecycle fetches settle before evaluating.
    await page.waitForTimeout(250);
    if (browserErrors.length) failures.push(...browserErrors);

    console.log(JSON.stringify({
      kittyGate,
      setup,
      orbit: {
        phase: orbitA.debug.phase,
        moved: Number(orbitMove.toFixed(3)),
        chainCount: orbitA.debug.chainCount,
        activeVisuals: orbitA.debug.activeVisuals,
        authoredHook: !orbitA.fallback,
      },
      charge: { before: chargeBefore, after: chargeAfter },
      throw: {
        releasePhase: releaseState.phase,
        launchId: releaseState.launchId,
        hits: thrown.debug.throwHits,
        damage: thrown.damage,
        damagedVictims: thrown.damagedVictims,
      },
      nova: novaAfter,
      plateau: { before: plateauBefore, after: plateauAfter, cycleFailures },
      lifecycle: { town, menu },
      screenshot: SCREENSHOT || null,
      browserErrors,
    }, null, 2));

    if (failures.length) {
      console.error(`\n[smoke-pipes-grapple] FAIL (${failures.length})`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\n[smoke-pipes-grapple] PASS — Pipes-only RMB acquires/orbits/charges/throws, Q remains Nova, visuals pool, and lifecycle cleanup plateau');
    }
  } catch (e) {
    console.error(`[smoke-pipes-grapple] FATAL — ${describeError(e)}`);
    process.exitCode = 2;
  } finally {
    try { await page.mouse.up({ button: 'left' }); } catch (_) {}
    try { await page.mouse.up({ button: 'right' }); } catch (_) {}
    await context.close();
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(`[smoke-pipes-grapple] FATAL — ${describeError(e)}`);
  process.exitCode = 2;
  try { server.close(); } catch (_) {}
});
