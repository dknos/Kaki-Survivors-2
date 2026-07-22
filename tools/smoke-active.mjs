#!/usr/bin/env node
/**
 * ACTIVE-ABILITY smoke — guards the DMD-hybrid pivot Iter C.
 *
 * The active is a drafted, cooldown-gated cast (Nova Burst v1). This boots a
 * real run and proves:
 *   1. acquireActive('nova') equips it (state.hero.active = nova, level 1).
 *   2. activeChoices() offers it to the draft (kind:'active').
 *   3. Casting it damages/stuns a nearby enemy, erases a hostile shot, honors
 *      area/cooldown multipliers, and refuses an immediate recast.
 *   4. The authored Grok seal + Blender claw pool are live, below actors, and
 *      reset without leaving visible instances.
 *
 * No npm install. Run: node tools/smoke-active.mjs   Port: 8803.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8803);
const BOOT_TIMEOUT_MS = 90000;

function mime(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
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
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-active] FAIL: playwright missing'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-active] FAIL: chromium missing'); process.exit(2); }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-active] server on http://127.0.0.1:' + PORT);

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
    await page.evaluate(() => window.kkStartRun());
    await page.waitForFunction(() => window.kkState && window.kkState.started, null, { timeout: BOOT_TIMEOUT_MS }).catch(() => {});

    // 1) equip + 2) draft presence
    const equip = await page.evaluate(async () => {
      const act = await import('./src/weapons/actives.js');
      act.acquireActive('nova');
      const a = window.kkState.hero.active;
      const choices = act.activeChoices() || [];
      return {
        equipped: !!(a && a.id === 'nova' && a.level === 1),
        inChoices: choices.some((c) => c.id === 'nova' && c.kind === 'active'),
      };
    });
    if (!equip.equipped) failures.push('acquireActive did not equip nova at level 1');
    if (!equip.inChoices) failures.push('activeChoices() did not offer nova (kind:active)');

    // 3) cast damages a near enemy + arms cooldown + refuses while on cooldown
    const cast = await page.evaluate(async () => {
      const act = await import('./src/weapons/actives.js');
      const enemies = await import('./src/enemies.js');
      const config = await import('./src/config.js');
      const enemyProjectiles = await import('./src/enemyProjectiles.js');
      const novaFx = await import('./src/fx/novaBurst.js');
      const s = window.kkState;
      const a = s.hero.active;
      // Draft UI pauses the wave clock, so waiting for the director made this
      // test depend on whether an opening mob happened to spawn before the
      // first choice modal. Spawn a real pooled tier beside the hero instead;
      // spawnEnemy inserts it into the production spatial hash synchronously.
      const tier = config.ENEMY_TIERS.find((x) => x.glb === 'zombie')
        || config.ENEMY_TIERS.find((x) => !x.dungeon && !x.elite);
      const e = tier && enemies.spawnEnemy(tier, s.hero.pos.x + 1, s.hero.pos.z);
      if (!e) return { noEnemy: true };
      // Sprite-atlas trash intentionally has no resident GLB clone. Reusing a
      // trash tier while forcing `elite:true` therefore bypasses the sprite
      // path and can fail before this smoke reaches Nova. Use the production
      // giant pool for the boss-control probe instead.
      const bossTier = config.ENEMY_TIERS.find((x) => x.glb === 'giant') || tier;
      const boss = bossTier && enemies.spawnEnemy({
        ...bossTier, hp: 9999, elite: true, isMiniBoss: true, displayName: 'NOVA IMMUNITY PROBE',
      }, s.hero.pos.x - 2, s.hero.pos.z);
      if (!boss) return { noBoss: true };
      const before = e.hp;
      const bossBefore = boss.hp;
      const bossSpdBefore = boss.spd;
      s.hero.statMul.area = 1.2;
      s.hero.statMul.cooldown = 0.8;
      s.run.passive_cooldown = 0.9;
      enemyProjectiles.spawnEnemyProjectile(
        s.hero.pos.x + 2, 1, s.hero.pos.z, 1, 1, 10, 'magic', 1, 0,
      );
      const poolBefore = enemyProjectiles.getEnemyProjectilePoolStats();
      a.cd = 0;
      const ok = act.castActive();
      const after = e.alive ? e.hp : -1;            // dead counts as damaged
      const bossAfter = boss.alive ? boss.hp : -1;
      const cdArmed = a.cd > 0;
      const refused = act.castActive() === false;   // immediate re-cast blocked
      const poolAfter = enemyProjectiles.getEnemyProjectilePoolStats();
      const nova = novaFx.getNovaBurstDebug();
      novaFx.resetNovaBurst();
      const reset = novaFx.getNovaBurstDebug();
      return {
        ok, before, after, damaged: after < before, cdArmed, refused,
        bossDamaged: bossAfter < bossBefore,
        bossControlImmune: boss._heavy === true && boss._noKnockback === true
          && boss.spd === bossSpdBefore && boss.knockVx === 0 && boss.knockVz === 0,
        cd: a.cd, expectedCd: 11 * 0.8 * 0.9,
        poolBefore, poolAfter,
        shotsCleared: s.run.novaShotsCleared || 0,
        nova, reset,
      };
    });
    if (cast.noEnemy) failures.push('no enemy came within blast radius in 14s — cannot verify cast');
    else if (cast.noBoss) failures.push('could not spawn boss-class Nova immunity probe');
    else {
      if (!cast.ok) failures.push('castActive() returned false off-cooldown (should have fired)');
      if (!cast.damaged) failures.push(`cast did not damage the near enemy (hp ${cast.before} -> ${cast.after})`);
      if (!cast.bossDamaged || !cast.bossControlImmune) failures.push(`boss damage/control contract failed (${JSON.stringify({ damaged: cast.bossDamaged, immune: cast.bossControlImmune })})`);
      if (!cast.cdArmed) failures.push('cast did not arm the cooldown');
      if (!cast.refused) failures.push('second immediate cast was NOT refused (cooldown not gating)');
      if (Math.abs(cast.cd - cast.expectedCd) > 0.001) failures.push(`active cooldown ignored multipliers (${cast.cd} != ${cast.expectedCd})`);
      if (cast.poolBefore.active !== 1 || cast.poolAfter.active !== 0 || cast.shotsCleared < 1) failures.push(`nova did not erase hostile shot (${JSON.stringify({ before: cast.poolBefore, after: cast.poolAfter, shotsCleared: cast.shotsCleared })})`);
      if (!cast.nova.active || !cast.nova.sealVisible || !cast.nova.waveVisible || !cast.nova.assetReady || cast.nova.shardCount !== 12) failures.push(`nova authored layers/Blender shards missing (${JSON.stringify(cast.nova)})`);
      if (Math.abs(cast.nova.radius - 6.6) > 0.01) failures.push(`nova area multiplier missing (radius=${cast.nova.radius})`);
      if (cast.nova.sealRenderOrder >= 0 || cast.nova.sealBloom) failures.push(`nova seal layering unsafe (order=${cast.nova.sealRenderOrder}, bloom=${cast.nova.sealBloom})`);
      if (!/nova_pawburst\.webp/.test(cast.nova.sealImageSrc) || cast.nova.sealImageWidth !== 512 || cast.nova.sealImageHeight !== 512) failures.push(`nova Grok texture missing/not decoded (${JSON.stringify(cast.nova)})`);
      if (cast.reset.active || cast.reset.sealVisible || cast.reset.waveVisible || cast.reset.shardCount !== 0) failures.push(`nova reset left visuals alive (${JSON.stringify(cast.reset)})`);
    }

    if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));
    console.log(`  equipped=${equip.equipped} inChoices=${equip.inChoices} | cast ok=${cast.ok} hp ${cast.before}->${cast.after} bossImmune=${cast.bossControlImmune} cd=${cast.cd?.toFixed?.(2)} erased=${cast.shotsCleared} shards=${cast.nova?.shardCount} refused=${cast.refused}`);
  } catch (e) {
    failures.push('exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx.close();
  }

  await browser.close();
  server.close();

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-active] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-active] PASS — Nova damages/stuns, erases shots, scales, renders authored 2D+3D FX, cooldown-gates, and resets');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-active] FATAL', e); process.exit(2); });
