#!/usr/bin/env node
/**
 * PRIMARY SLOT smoke — guards the DMD-hybrid pivot Iter B.
 *
 * The primary is a NEW always-equipped, player-aimed, hold-to-fire weapon. This
 * boots a real run and proves:
 *   1. 'primary' is auto-equipped at run start (state.weapons contains it).
 *   2. It is hidden from the level-up draft (weaponChoices never offers it).
 *   3. With the auto-fire toggle on and enemies present, it actually fires —
 *      projectiles tagged ownerWeapon='primary' appear in state.projectiles.
 *
 * Headless has no mouse movement, so isManualAiming() is false and the primary
 * auto-targets the nearest enemy (deterministic). No npm install.
 * Run: node tools/smoke-primary.mjs   Port: 8802.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8802);
const BOOT_TIMEOUT_MS = 90000;

function mime(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg'))  return 'image/svg+xml';
  if (p.endsWith('.mp3'))  return 'audio/mpeg';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function main() {
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-primary] FAIL: playwright missing'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-primary] FAIL: chromium missing'); process.exit(2); }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-primary] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const failures = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });

    const mainLoop = await page.evaluate(async () => {
      if (!window.__kkMainLoop?.snapshot) return null;
      const before = window.__kkMainLoop.snapshot();
      await new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ));
      return { before, after: window.__kkMainLoop.snapshot() };
    });
    if (!mainLoop
        || !mainLoop.after.running
        || mainLoop.after.owner !== 'renderer.setAnimationLoop'
        || mainLoop.after.startCount !== 1
        || mainLoop.after.duplicateTimestampCount !== 0
        || mainLoop.after.frameCount <= mainLoop.before.frameCount) {
      failures.push(`main render loop ownership invalid: ${JSON.stringify(mainLoop)}`);
    }

    // Start a real run + force the auto-fire toggle so the primary fires without
    // a synthetic mouse-hold.
    await page.evaluate(async () => {
      const m = await import('./src/meta.js');
      try { m.setOption('optAutoFirePrimary', true); } catch (_) {}
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      // Direct Bullet Hell applies meta before any Survivors-stage preload.
      // Returning and then starting Forest must still build authored accents;
      // this guards against cold-asset negative caching in arenaDecor.
      await window.kkStartBulletHell();
      if (window.kkState.mode !== 'bullethell') throw new Error('Bullet Hell prelude failed');
      window.kkReturnToMenu();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // Exercise the Embark single-flight guard: rapid double activation must
      // not duplicate starter/primary weapon initialization.
      await Promise.all([window.kkStartRun(), window.kkStartRun()]);
    });

    // 1) Primary equipped once the run's weapons are populated.
    await page.waitForFunction(
      () => window.kkState && window.kkState.started &&
            Array.isArray(window.kkState.weapons) &&
            window.kkState.weapons.some((w) => w.id === 'primary'),
      null, { timeout: BOOT_TIMEOUT_MS },
    ).catch(() => {});
    const equip = await page.evaluate(() => {
      const s = window.kkState;
      const accentKeys = [];
      if (s && s.scene) {
        s.scene.traverse((o) => {
          if (o.userData && o.userData.kkForestAccent) accentKeys.push(o.userData.kkForestAccent);
        });
      }
      return {
        started: !!(s && s.started),
        hasPrimary: !!(s && s.weapons && s.weapons.some((w) => w.id === 'primary')),
        count: (s && s.weapons && s.weapons.filter((w) => w.id === 'primary').length) || 0,
        forestAccentCount: new Set(accentKeys).size,
      };
    });
    if (!equip.started) failures.push('run did not start (state.started false)');
    if (!equip.hasPrimary) failures.push('primary NOT auto-equipped at run start');
    if (equip.count > 1) failures.push(`primary equipped ${equip.count}x — should be exactly 1 (idempotency leak)`);
    if (equip.forestAccentCount !== 15) failures.push(`authored Forest decor loaded ${equip.forestAccentCount}/15 accent kits`);

    // 2) Hidden from the draft pool.
    const inDraft = await page.evaluate(async () => {
      const w = await import('./src/weapons/index.js');
      let offered = false;
      for (let i = 0; i < 12; i++) {
        const choices = w.weaponChoices(3) || [];
        if (choices.some((c) => c.id === 'primary')) { offered = true; break; }
      }
      return offered;
    });
    if (inDraft) failures.push('primary appeared in the level-up draft (should be hidden:true)');

    // 3) It fires: observe the gameplay RAF boundary rather than polling a
    // transient projectile list on a wall-clock interval. A software renderer
    // can spend several seconds compiling a newly-visible pipeline; the old
    // timer loop checked its deadline before taking the post-render sample and
    // could therefore miss a shot that was created during that long frame.
    const fired = await page.evaluate(async () => {
      const s = window.kkState;
      const projectiles = s && s.projectiles && s.projectiles.active;
      const input = await import('./src/input.js');
      const meta = await import('./src/meta.js');
      const startedAt = performance.now();
      const deadline = startedAt + 30000;
      const startFrame = window.__kkMainLoop?.snapshot?.().frameCount || 0;
      let sawEnemy = false, sawProj = false, maxPrimary = 0;
      let observedPrimaryPushes = 0;

      // A close-range hit can be born and consumed inside one gameplay frame.
      // Watch the owned array's push boundary as well as its post-frame state,
      // then restore the native method before the smoke continues teardown.
      const hadOwnPush = !!projectiles && Object.hasOwn(projectiles, 'push');
      const originalPush = projectiles && projectiles.push;
      const observedPush = function (...items) {
        for (const item of items) {
          if (item && item.ownerWeapon === 'primary') observedPrimaryPushes += 1;
        }
        return originalPush.apply(this, items);
      };
      if (projectiles) projectiles.push = observedPush;

      const sample = () => {
        const enemies = (s && s.enemies && s.enemies.active) || [];
        if (enemies.length > 0) sawEnemy = true;
        const projs = (s && s.projectiles && s.projectiles.active) || [];
        const np = projs.filter((p) => p.ownerWeapon === 'primary').length;
        if (np > maxPrimary) maxPrimary = np;
        if (np > 0 || observedPrimaryPushes > 0) sawProj = true;
      };

      const nextObservation = () => new Promise((resolve) => {
        let settled = false;
        let timer = 0;
        let raf = 0;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelAnimationFrame(raf);
          resolve();
        };
        raf = requestAnimationFrame(finish);
        timer = setTimeout(finish, 250);
      });

      sample();
      try {
        while (!sawProj) {
          await nextObservation();
          // Sample first. If a synchronous render/compile crossed the wall
          // deadline, this final read still sees the state produced by it.
          sample();
          const frameCount = window.__kkMainLoop?.snapshot?.().frameCount || startFrame;
          if (performance.now() >= deadline || frameCount - startFrame >= 180) break;
        }
      } finally {
        if (projectiles && projectiles.push === observedPush) {
          if (hadOwnPush) projectiles.push = originalPush;
          else delete projectiles.push;
        }
      }

      const primary = (s && s.weapons || []).find((weapon) => weapon.id === 'primary');
      return {
        sawEnemy,
        sawProj,
        maxPrimary,
        observedPrimaryPushes,
        autoFireOption: meta.getMeta().optAutoFirePrimary,
        inputFiring: input.isPrimaryFiring(),
        primaryCooldown: primary?.inst?.cd ?? null,
        gameTime: s?.time?.game ?? null,
        paused: !!s?.time?.paused,
        pendingLevelUp: !!s?.pendingLevelUp,
        gameOver: !!s?.gameOver,
        framesObserved: (window.__kkMainLoop?.snapshot?.().frameCount || startFrame) - startFrame,
        elapsedMs: performance.now() - startedAt,
      };
    });
    if (!fired.sawEnemy) failures.push(`no enemies spawned during primary observation: ${JSON.stringify(fired)}`);
    else if (!fired.sawProj) failures.push(`primary never fired: ${JSON.stringify(fired)}`);

    // Dense InstancedMesh pools must draw only live descriptors and return to
    // count=0 after expiry; this catches stale trailing-slot ghost visuals.
    const fxCounts = await page.evaluate(async () => {
      const s = window.kkState;
      const fx = await import('./src/fx.js');
      const vfx = await import('./src/vfxBurst.js');
      s._optReduceMotion = false;
      s._optReducedFlashing = false;
      const pools = s.scene.children.filter((o) => o.isInstancedMesh);
      const before = new Map(pools.map((o) => [o, o.count]));
      for (let i = 0; i < 80; i++) fx.spawnKillRing(i, 0);
      for (let i = 0; i < 80; i++) fx.spawnMagnetSpark(i, 1, 0);
      for (let i = 0; i < 30; i++) vfx.spawnImpactBurst(0, 1, 0, 0xffaa00, 1);
      for (let i = 0; i < 60; i++) vfx.spawnDashStreak(0, 0, 1, 0);
      fx.updateFX(0.01);
      vfx.updateVFXBurst(0.01);
      const changed = pools.filter((o) => o.count !== before.get(o));
      const live = changed.map((o) => o.count).sort((a, b) => a - b);
      fx.updateFX(3);
      vfx.updateVFXBurst(3);
      const poofPool = s.scene.children.find((o) => o.userData?.visualRole === 'death_feedback');
      const poofImage = poofPool?.material?.map?.image;
      return {
        live,
        cleared: changed.map((o) => o.count),
        poof: poofPool ? {
          purpose: poofPool.userData.gameplayPurpose,
          assetPath: poofPool.userData.assetPath,
          src: poofImage?.currentSrc || poofImage?.src || '',
          width: poofImage?.naturalWidth || poofImage?.width || 0,
          renderOrder: poofPool.renderOrder,
          layerMask: poofPool.layers.mask,
        } : null,
      };
    });
    // Kill feedback is one authored paw-poof pool now; its redundant paired
    // twinkle was removed, so dense deaths cost one fewer active draw family.
    const expectedFxCounts = [16, 48, 64, 64, 128];
    if (JSON.stringify(fxCounts.live) !== JSON.stringify(expectedFxCounts)) {
      failures.push(`dense FX counts differ: got [${fxCounts.live}], expected [${expectedFxCounts}]`);
    }
    if (fxCounts.cleared.some((n) => n !== 0)) failures.push(`expired FX pools retained live counts: [${fxCounts.cleared}]`);
    if (!fxCounts.poof || fxCounts.poof.purpose !== 'enemy-death-poof'
      || !/kill_paw_poof\.webp/.test(fxCounts.poof.src)
      || fxCounts.poof.width !== 256
      || fxCounts.poof.renderOrder >= 0
      || fxCounts.poof.layerMask !== 1) {
      failures.push(`authored death-poof asset/layer contract failed: ${JSON.stringify(fxCounts.poof)}`);
    }

    // 4) Run teardown releases transient resources and zeroes persistent
    // InstancedMesh weapon pools before resetState truncates logical arrays.
    const teardown = await page.evaluate(async () => {
      const s = window.kkState;
      const weapons = await import('./src/weapons/index.js');
      const xp = await import('./src/xp.js');
      const enemyProjectiles = await import('./src/enemyProjectiles.js');
      const chainFx = await import('./src/chainFx.js');

      weapons.acquireWeapon('orbitals');
      const oldOrbPools = [];
      s.scene.traverse((o) => {
        if (o.isInstancedMesh && o.userData && o.userData.weaponId === 'orbitals') oldOrbPools.push(o);
      });

      xp.dropGem(s.hero.pos, 1);
      const gemCountBefore = s.gems.instMesh ? s.gems.instMesh.count : -1;

      enemyProjectiles.spawnEnemyProjectile(
        s.hero.pos.x + 4, 1, s.hero.pos.z, 1, 1, 10, 'magic', 1, 0,
      );
      const enemyPoolBefore = enemyProjectiles.getEnemyProjectilePoolStats();

      chainFx.spawnChainArc(s.scene, s.hero.pos, { x: s.hero.pos.x + 2, z: s.hero.pos.z + 2 });
      const chainArcsBefore = chainFx._debugActiveArcCount();

      window.kkReturnToMenu();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        oldOrbPoolCount: oldOrbPools.length,
        oldOrbPoolsZeroed: oldOrbPools.every((m) => m.count === 0),
        oldOrbPoolsResident: oldOrbPools.every((m) => m.parent === s.scene),
        gemCountBefore,
        gemCountAfter: s.gems.instMesh ? s.gems.instMesh.count : -1,
        gemsAfter: s.gems.list.length,
        boltsAfter: s.enemyProjectiles.active.length,
        enemyPoolBefore,
        enemyPoolAfter: enemyProjectiles.getEnemyProjectilePoolStats(),
        chainArcsBefore,
        chainArcsAfter: chainFx._debugActiveArcCount(),
        weaponsAfter: s.weapons.length,
      };
    });
    if (teardown.oldOrbPoolCount < 2 || !teardown.oldOrbPoolsZeroed || !teardown.oldOrbPoolsResident) {
      failures.push(`orbital pool teardown invalid (pools=${teardown.oldOrbPoolCount}, zeroed=${teardown.oldOrbPoolsZeroed}, resident=${teardown.oldOrbPoolsResident})`);
    }
    if (teardown.gemCountBefore < 1 || teardown.gemCountAfter !== 0 || teardown.gemsAfter !== 0) failures.push('XP reset left logical or instanced gem slots live');
    if (teardown.boltsAfter !== 0
        || teardown.enemyPoolBefore.draws !== 2
        || teardown.enemyPoolBefore.active !== 1
        || teardown.enemyPoolAfter.active !== 0
        || teardown.enemyPoolAfter.free !== teardown.enemyPoolAfter.capacity
        || teardown.enemyPoolAfter.coreCount !== 0
        || teardown.enemyPoolAfter.haloCount !== 0) {
      failures.push(`enemy projectile pool teardown incomplete (${JSON.stringify({ before: teardown.enemyPoolBefore, after: teardown.enemyPoolAfter })})`);
    }
    if (teardown.chainArcsBefore < 1 || teardown.chainArcsAfter !== 0) failures.push(`chain FX teardown incomplete (${teardown.chainArcsBefore}->${teardown.chainArcsAfter})`);
    if (teardown.weaponsAfter !== 0) failures.push(`weapon list not reset (remaining=${teardown.weaponsAfter})`);

    const restart = await page.evaluate(async () => {
      // The first menu destination wins while its cold assets load; later
      // clicks must join that transition rather than overwriting its mode.
      await Promise.all([
        window.kkStartRun(),
        window.kkStartRun(),
        window.kkEnterTown(),
        window.kkStartBulletHell(),
      ]);
      const entryRaceMode = window.kkState.mode;
      await window.kkRestart();
      const s = window.kkState;
      const ids = s.weapons.map((w) => w.id);
      return {
        started: s.started,
        mode: s.mode,
        entryRaceMode,
        uniqueWeapons: new Set(ids).size === ids.length,
        primaryCount: ids.filter((id) => id === 'primary').length,
        gems: s.gems.list.length,
        bolts: s.enemyProjectiles.active.length,
        projectiles: s.projectiles.active.length,
      };
    });
    if (restart.entryRaceMode !== 'run' || !restart.started || restart.mode !== 'run' || !restart.uniqueWeapons || restart.primaryCount !== 1) {
      failures.push(`restart state invalid: ${JSON.stringify(restart)}`);
    }
    if (restart.gems !== 0 || restart.bolts !== 0 || restart.projectiles !== 0) {
      failures.push(`restart retained transient entities: ${JSON.stringify(restart)}`);
    }

    if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));
    console.log(`  equipped=${equip.hasPrimary} (x${equip.count})  forestAccents=${equip.forestAccentCount}/15  inDraft=${inDraft}  sawEnemy=${fired.sawEnemy}  primaryProjectiles=${fired.maxPrimary}  observedPushes=${fired.observedPrimaryPushes}  frames=${fired.framesObserved}`);
    console.log(`  FX live counts=[${fxCounts.live}] cleared=[${fxCounts.cleared}]`);
    console.log(`  teardown: orbitalPools=${teardown.oldOrbPoolCount} zeroed=${teardown.oldOrbPoolsZeroed} resident=${teardown.oldOrbPoolsResident} gems=${teardown.gemCountBefore}->${teardown.gemCountAfter} boltMatsDisposed=${teardown.disposedMats} chainArcs=${teardown.chainArcsBefore}->${teardown.chainArcsAfter}`);
    console.log(`  restart: entryRace=${restart.entryRaceMode} started=${restart.started} mode=${restart.mode} uniqueWeapons=${restart.uniqueWeapons} primary=${restart.primaryCount}`);
  } catch (e) {
    failures.push('exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-primary] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-primary] PASS — primary, single-flight start, and run-owned teardown contracts are healthy');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-primary] FATAL', e); process.exit(2); });
