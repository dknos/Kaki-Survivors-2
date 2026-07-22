#!/usr/bin/env node
/**
 * New-enemy smoke: original Blender toy meshes, fixed pounce, rotating yarn
 * ring, Moonwing fire fan, and the authored Clockwork Stalker Nemesis.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8941);
const TIMEOUT = 90000;

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
  if (within.startsWith('..') || path.isAbsolute(within)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function main() {
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(CHROME)) {
    console.error('[smoke-new-enemies] FAIL: playwright/chromium missing');
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=new-enemies`, { waitUntil: 'load', timeout: TIMEOUT });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: TIMEOUT });
    await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      await window.kkStartRun();
    });
    await page.waitForFunction(() => window.kkState && window.kkState.started, null, { timeout: TIMEOUT });

    const out = await page.evaluate(async () => {
      const enemies = await import('./src/enemies.js');
      const config = await import('./src/config.js');
      const hostile = await import('./src/enemyProjectiles.js');
      const assets = await import('./src/assets.js');
      const s = window.kkState;
      s.time.paused = true;
      hostile.clearEnemyProjectiles();

      // Remove opening-wave noise without drops or death effects.
      for (const e of [...s.enemies.active]) {
        try { s.enemies.spatial.remove(e); } catch (_) {}
        try { enemies.releaseEnemyVisual(e); } catch (_) {}
      }
      s.enemies.active.length = 0;

      const tier = (id) => config.ENEMY_TIERS.find((x) => x.glb === id);
      const hp = s.hero.pos;
      const mouse = enemies.spawnEnemy(tier('clockwork_mouse'), hp.x + 10, hp.z);
      const wisp = enemies.spawnEnemy(tier('yarn_wisp'), hp.x + 12, hp.z);
      const moon = enemies.spawnEnemy(tier('dragon_evo'), hp.x, hp.z + 14);
      const stalker = enemies.spawnNemesis(hp.x - 8, hp.z + 8);
      for (const e of [mouse, wisp, moon]) {
        if (!e) continue;
        e.spd = 0;
        if (e.ranged) e.rangedCD = 999;
      }

      // Guaranteed pounce: arm, show the windup state, then resolve 8u.
      const mouseBefore = mouse ? mouse.mesh.position.clone() : null;
      if (mouse) mouse._leapCD = 0;
      enemies.updateEnemies(0.02);
      const pounceArmed = !!(mouse && mouse._leapWindup > 0 && mouse._leapTargetX !== undefined);
      enemies.updateEnemies(0.62);
      const pounceDistance = mouse && mouseBefore ? mouse.mesh.position.distanceTo(mouseBefore) : 0;

      // Yarn Wisp: exactly five equally distinct headings from one two-draw pool.
      hostile.clearEnemyProjectiles();
      if (wisp) wisp.rangedCD = 0;
      enemies.updateEnemies(0.016);
      const yarnShots = s.enemyProjectiles.active.map((p) => ({
        vx: p.vx, vz: p.vz, kind: p.kind,
      }));
      const yarnHeadings = new Set(yarnShots.map((p) => Math.atan2(p.vz, p.vx).toFixed(2))).size;
      if (wisp) wisp.rangedCD = 999;

      // Moonwing: difficulty-gated five-comet fire fan.
      hostile.clearEnemyProjectiles();
      s.time.game = 600;
      if (moon) moon.rangedCD = 0;
      enemies.updateEnemies(0.016);
      const moonShots = s.enemyProjectiles.active.map((p) => ({
        vx: p.vx, vz: p.vz, kind: p.kind,
      }));
      const moonHeadings = new Set(moonShots.map((p) => Math.atan2(p.vz, p.vx).toFixed(2))).size;
      hostile.clearEnemyProjectiles();

      // Compose a stable in-camera inspection lineup.
      if (mouse) mouse.mesh.position.set(hp.x - 4.0, mouse._baseY || 0, hp.z + 3.5);
      if (wisp) wisp.mesh.position.set(hp.x + 4.0, (wisp._baseY || 0) + 0.3, hp.z + 4.5);
      if (moon) moon.mesh.position.set(hp.x, moon._baseY || 0, hp.z + 8.5);
      if (stalker) {
        stalker.spd = 0;
        stalker.mesh.position.set(hp.x - 7.2, 0, hp.z + 5.5);
      }

      let stalkerDrawables = 0;
      let stalkerBloomMeshes = 0;
      if (stalker) stalker.mesh.traverse((o) => {
        if (!o.isMesh) return;
        stalkerDrawables++;
        if (o.layers && (o.layers.mask & (1 << 1))) stalkerBloomMeshes++;
      });

      return {
        assets: {
          mouse: !!(assets.GLTF_CACHE.clockwork_mouse && assets.GLTF_CACHE.clockwork_mouse.scene),
          wisp: !!(assets.GLTF_CACHE.yarn_wisp && assets.GLTF_CACHE.yarn_wisp.scene),
          moon: !!(assets.GLTF_CACHE.dragon_evo && assets.GLTF_CACHE.dragon_evo.scene),
          stalker: !!(assets.GLTF_CACHE.nemesis_stalker && assets.GLTF_CACHE.nemesis_stalker.scene),
        },
        spawned: { mouse: !!mouse, wisp: !!wisp, moon: !!moon, stalker: !!stalker },
        stalker: stalker ? {
          authoredAsset: stalker.mesh.userData.authoredAsset || null,
          fallback: !!stalker.mesh.userData.fallbackAsset,
          drawables: stalkerDrawables,
          bloomMeshes: stalkerBloomMeshes,
          flashController: typeof stalker.mesh.userData.damageFlashController?.setAmount === 'function',
          flashMaterials: stalker.mesh.userData.damageFlashController?.materials?.length || 0,
        } : null,
        mouseAffixes: mouse ? mouse.affixes : null,
        pounceArmed,
        pounceDistance,
        yarnCount: yarnShots.length,
        yarnHeadings,
        yarnKinds: [...new Set(yarnShots.map((p) => p.kind))],
        moonCount: moonShots.length,
        moonHeadings,
        moonKinds: [...new Set(moonShots.map((p) => p.kind))],
        finaleEligibility: {
          moonwing: tier('dragon_evo')?.finalBossEligible !== false,
          dragon: tier('dragon')?.finalBossEligible !== false,
        },
        projectilePool: hostile.getEnemyProjectilePoolStats(),
        moonAnimated: !!(moon && moon.mesh.userData && moon.mesh.userData.mixer),
      };
    });

    if (!Object.values(out.assets).every(Boolean)) failures.push(`GLTF cache missing: ${JSON.stringify(out.assets)}`);
    if (!Object.values(out.spawned).every(Boolean)) failures.push(`spawn failed: ${JSON.stringify(out.spawned)}`);
    if (!out.stalker || out.stalker.authoredAsset !== 'nemesis_stalker'
      || out.stalker.fallback || out.stalker.drawables !== 3
      || out.stalker.bloomMeshes !== 1 || !out.stalker.flashController
      || out.stalker.flashMaterials < 2) {
      failures.push(`Clockwork Stalker asset contract invalid: ${JSON.stringify(out.stalker)}`);
    }
    if (!out.mouseAffixes || !out.mouseAffixes.includes('leaping')) failures.push(`mouse fixed pounce missing: ${JSON.stringify(out.mouseAffixes)}`);
    if (!out.pounceArmed || out.pounceDistance < 7.7 || out.pounceDistance > 8.2) failures.push(`pounce contract invalid: armed=${out.pounceArmed} distance=${out.pounceDistance}`);
    if (out.yarnCount !== 5 || out.yarnHeadings !== 5 || out.yarnKinds.join(',') !== 'magic') failures.push(`yarn ring invalid: ${JSON.stringify(out)}`);
    if (out.moonCount !== 5 || out.moonHeadings !== 5 || out.moonKinds.join(',') !== 'fire') failures.push(`Moonwing fan invalid: ${JSON.stringify(out)}`);
    if (out.finaleEligibility.moonwing || !out.finaleEligibility.dragon) failures.push(`finale eligibility regressed: ${JSON.stringify(out.finaleEligibility)}`);
    if (out.projectilePool.active !== 0 || out.projectilePool.free !== out.projectilePool.capacity || out.projectilePool.draws !== 2) failures.push(`projectile teardown invalid: ${JSON.stringify(out.projectilePool)}`);
    if (!out.moonAnimated) failures.push('Moonwing did not bind its embedded animation mixer');
    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);

    await page.screenshot({ path: '/tmp/kks-new-enemies.png', fullPage: false });
    // Freeze a real combined volley for visual inspection. Main logic is
    // paused, so all ten sprites remain at their authored spawn points.
    const attackVisual = await page.evaluate(async () => {
      const enemies = await import('./src/enemies.js');
      const hostile = await import('./src/enemyProjectiles.js');
      const s = window.kkState;
      hostile.clearEnemyProjectiles();
      const wisp = s.enemies.active.find((e) => e.alive && e.glbKey === 'yarn_wisp');
      const moon = s.enemies.active.find((e) => e.alive && e.glbKey === 'dragon_evo');
      if (wisp) wisp.rangedCD = 0;
      if (moon) moon.rangedCD = 0;
      s.time.game = 600;
      enemies.updateEnemies(0.016);
      hostile.updateEnemyProjectiles(0.35);
      const core = [...s.scene.children].find((o) => o.userData && o.userData.visualRole === 'enemy_projectile' && o.userData.part === 'core');
      return {
        count: s.enemyProjectiles.active.length,
        coreCount: core ? core.count : 0,
        imageSrc: core && core.material && core.material.map && core.material.map.image
          ? (core.material.map.image.currentSrc || core.material.map.image.src || '') : '',
      };
    });
    if (attackVisual.count !== 10 || attackVisual.coreCount !== 10 || !/enemy_cat_spirit_bolt\.webp/.test(attackVisual.imageSrc)) {
      failures.push(`combined attack visual invalid: ${JSON.stringify(attackVisual)}`);
    }
    await page.evaluate(() => {
      const banner = document.getElementById('kk-boss-intro-banner');
      if (banner) banner.style.display = 'none';
    });
    await page.screenshot({ path: '/tmp/kks-new-enemy-attacks.png', fullPage: false });
    await page.evaluate(async () => {
      const hostile = await import('./src/enemyProjectiles.js');
      hostile.clearEnemyProjectiles();
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    failures.push(`exception: ${e && e.message ? e.message : String(e)}`);
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error(`[smoke-new-enemies] FAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('[smoke-new-enemies] PASS — authored toy enemies and Clockwork Stalker load, read distinctly, and reuse bounded combat pools');
}

main().catch((e) => { console.error('[smoke-new-enemies] FATAL', e); process.exit(2); });
