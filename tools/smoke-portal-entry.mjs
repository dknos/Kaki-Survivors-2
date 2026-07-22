#!/usr/bin/env node
/** End-to-end browser smoke: collect Twilight shards, open portal, enter Catacomb. */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8814);
const require = createRequire(import.meta.url);
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const CHROME = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const RELEASE_TAG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/main\.js\?v=([^"']+)/)?.[1];

function mime(p) {
  if (/\.m?js$/.test(p)) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(p)) return 'image/jpeg';
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
    const moduleRequests = new Map();
    const isOptionalFontRequest = (url) => /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(url || '');
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('.js')) moduleRequests.set(url.pathname, url.searchParams.get('v'));
    });
    page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = m.location();
      if (isOptionalFontRequest(loc?.url)) return;
      errors.push(`console: ${m.text()}${loc && loc.url ? ` @ ${loc.url}` : ''}`);
    });
    page.on('requestfailed', (r) => {
      const reason = r.failure()?.errorText || 'unknown';
      // Run start and portal entry intentionally cancel obsolete menu/stage
      // streams. Chromium reports those lifecycle cancellations as ERR_ABORTED.
      if (reason === 'net::ERR_ABORTED') return;
      // Google Fonts is cosmetic and intentionally has a local font fallback;
      // an offline CI host must not turn a successful portal traversal red.
      if (isOptionalFontRequest(r.url())) return;
      errors.push(`request failed: ${reason} @ ${r.url()}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !isOptionalFontRequest(r.url())) errors.push(`http ${r.status()}: ${r.url()}`);
    });
    await page.goto(`http://127.0.0.1:${PORT}/?smoke=portal-entry`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.kkStartRun && window.kkState, null, { timeout: 90000 });
    await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.setOption('optDevUnlockAllLevels', true);
      meta.setOption('selectedStage', 'twilight');
      localStorage.setItem('kks_introSeen', '1');
      window.kkState.weapons.length = 0;
      await window.kkStartRun();
      window.kkState.hero.hp = 1e9;
      window.kkState.hero.hpMax = 1e9;
      window.__kkPortalDebug = await import('./src/portalShards.js');
      window.__kkTerrain = await import('./src/stageTerrainLayout.js');
    });
    await page.waitForFunction(() => window.kkState.started && window.kkState.mode === 'run', null, { timeout: 90000 });
    const startedStage = await page.evaluate(() => window.kkState.run.stage.id);
    assert(startedStage === 'twilight', `portal smoke started ${startedStage}, expected twilight`);

    // A Forest portal opened while facing out from any edge/corner must turn
    // inward and remain reachable beyond its full enter radius.
    const boundaryPlacements = await page.evaluate(async () => {
      const rooms = await import('./src/forestRooms.js');
      const b = rooms.FOREST_WORLD_BOUNDS;
      const minX = b.minX + b.inset;
      const maxX = b.maxX - b.inset;
      const minZ = b.minZ + b.inset;
      const maxZ = b.maxZ - b.inset;
      const probes = [
        [maxX, 0, 1, 0], [minX, 0, -1, 0],
        [0, maxZ, 0, 1], [0, minZ, 0, -1],
        [maxX, maxZ, 1, 1], [minX, minZ, -1, -1],
      ];
      return probes.map(([x, z, fx, fz]) => {
        const p = window.__kkPortalDebug._debugPortalPlacement('forest', x, z, fx, fz);
        return {
          ...p,
          playable: rooms.isForestPositionPlayable(p.x, p.z, 2.8),
          terrainActive: window.__kkTerrain.sampleStageTerrain('forest', p.x, p.z).active,
          heroDistance: Math.hypot(p.x - x, p.z - z),
        };
      });
    });
    assert(boundaryPlacements.every((p) => p.playable), 'Forest boundary portal escaped the playable tree line');
    assert(boundaryPlacements.every((p) => !p.terrainActive), 'Forest boundary portal landed in active terrain');
    assert(boundaryPlacements.every((p) => p.heroDistance > 2.2), 'Forest boundary portal opened on top of the hero');

    // Twilight retains the original shard objective after Forest moved to
    // six portal trials. Dungeon-first must retire that duplicate objective
    // instead of leaving a later 5/5 portal in an endless retry state.
    await page.evaluate(() => { window.kkState.run.catacombCleared = true; });
    await page.waitForFunction(() => {
      const snap = window.__kkPortalDebug._debugPortalShardMap();
      return snap.locations.length === 0 && document.getElementById('kk-portal-minimap').style.display === 'none';
    }, null, { timeout: 12000 });
    await page.evaluate(() => {
      window.kkState.run.catacombCleared = false;
      window.__kkPortalDebug.spawnPortalShards();
      window.kkState.hero.pos.set(160, 0, 0);
    });
    const expandedBounds = await page.evaluate(() => window.__kkPortalDebug._debugPortalShardMap().bounds);
    assert(expandedBounds.maxX >= 172, `distant marker bounds clamp at ${expandedBounds.maxX}`);
    await page.evaluate(() => { window.kkState.hero.pos.set(0, 0, 0); });

    // Teleport through every live marker. Once the field shards are gone, the
    // production anti-softlock path surfaces the earned remainder and this
    // loop collects those too; no private collection shortcut is used.
    for (let i = 0; i < 16; i++) {
      const status = await page.evaluate(() => {
        const snap = window.__kkPortalDebug._debugPortalShardMap();
        const stageId = window.kkState.run.stage.id;
        const unsafe = snap.locations.filter((p) => window.__kkTerrain.sampleStageTerrain(stageId, p.x, p.z).active).length;
        if (snap.locations.length) {
          const p = snap.locations[0];
          window.kkState.hero.pos.set(p.x, 0, p.z);
          window.kkState.hero.vel.set(0, 0, 0);
        }
        return {
          live: snap.locations.length,
          portal: snap.portal,
          shards: window.kkState.run.portalShards,
          cutscene: !!window.__kkCutsceneActive,
          unsafe,
        };
      });
      assert(status.unsafe === 0, `${status.unsafe} shard(s) spawned in active terrain`);
      if (status.cutscene || status.portal || status.shards >= 5) break;
      if (status.live) {
        // Wait for a real gameplay frame to consume the teleported-to shard.
        // A fixed 260ms delay raced SwiftShader when a frame took longer than
        // that, moving the hero away before collection and making this smoke
        // nondeterministic on loaded CI/dev machines.
        try {
          await page.waitForFunction((previous) => {
            const snap = window.__kkPortalDebug._debugPortalShardMap();
            return window.kkState.run.portalShards > previous
              || !!snap.portal || !!window.__kkCutsceneActive;
          }, status.shards, { timeout: 5000 });
        } catch (_) {
          // Let the next iteration report the actual gameplay state; the
          // final awakening assertion remains the authoritative failure.
        }
      } else {
        await page.waitForTimeout(700);
      }
    }

    console.log('[portal-smoke] waiting for awakening or portal', await page.evaluate(() => ({
      shards: window.kkState.run.portalShards,
      cutscene: !!window.__kkCutsceneActive,
      map: window.__kkPortalDebug._debugPortalShardMap(),
    })));
    await page.waitForFunction(() => window.__kkCutsceneActive || window.__kkPortalDebug._debugPortalShardMap().portal, null, { timeout: 15000 });
    await page.evaluate(() => { if (window.__kkCutsceneActive) window.__kkSkipCutscene(); });
    console.log('[portal-smoke] awakening reached; waiting for portal mesh');
    await page.waitForFunction(() => !!window.__kkPortalDebug._debugPortalShardMap().portal, null, { timeout: 15000 });
    const ready = await page.evaluate(() => {
      const snap = window.__kkPortalDebug._debugPortalShardMap();
      const map = document.getElementById('kk-portal-minimap');
      return {
        shards: window.kkState.run.portalShards,
        portal: snap.portal,
        mapProfile: map && map.dataset.profile,
      };
    });
    assert(ready.shards === 5, `portal opened at ${ready.shards}/5 shards`);
    assert(ready.portal, 'portal did not open after the awakening cutscene');
    assert(ready.mapProfile === 'open-arena', `unexpected minimap profile ${ready.mapProfile}`);

    await page.waitForTimeout(700); // production 0.4s portal arm beat
    await page.evaluate(({ x, z }) => {
      window.kkState.hero.pos.set(x, 0, z);
      window.kkState.hero.vel.set(0, 0, 0);
    }, ready.portal);
    await page.waitForFunction(() => window.kkState.mode === 'catacomb', null, { timeout: 90000 });
    const entered = await page.evaluate(async () => {
      const snap = window.__kkPortalDebug._debugPortalShardMap();
      const hud = document.getElementById('kk-dungeon-progress');
      const gate = window.kkState.scene.getObjectByName('dungeonSealedDoor');
      const life = window.kkState.scene.getObjectByName('__stageLife');
      const secrets = window.kkState.scene.getObjectByName('__dashSmashSecrets');
      const destructibles = await import('./src/destructibles.js');
      const first = destructibles._debugDestructibles().locations[0];
      return {
        portalGone: !snap.portal,
        phase: window.kkState.run.dungeonPhase,
        hud: !!hud && hud.style.display === 'block',
        gateAsset: gate && gate.userData.assetKey,
        lifeHidden: !!life && life.visible === false,
        secretsHidden: !!secrets && secrets.visible === false,
        smashGated: !first || destructibles.smashLogsInRadius(first.x, first.z, 1) === 0,
      };
    });
    assert(entered.portalGone, 'successful entry left the overworld portal active');
    assert(entered.phase === 'ACTIVE', `dungeon phase is ${entered.phase}`);
    assert(entered.hud, 'dungeon progress HUD is not visible');
    assert(entered.gateAsset === 'kk_dungeon_gate', `sealed door asset is ${entered.gateAsset}`);
    assert(entered.lifeHidden, 'overworld StageLife remained visible in Catacomb');
    assert(entered.secretsHidden, 'overworld dash-smash secrets remained visible in Catacomb');
    assert(entered.smashGated, 'Catacomb dash could consume an overworld secret');
    assert(RELEASE_TAG, 'index.html main module has no release tag');
    for (const name of ['state', 'runClock', 'stageTerrainLayout', 'stageExplorationLayout', 'stageLife', 'destructibles', 'portalShards', 'catacomb', 'dungeonBuild', 'miniEvents', 'helltide']) {
      const requestTag = moduleRequests.get(`/src/${name}.js`);
      assert(requestTag === RELEASE_TAG, `${name}.js cache tag is ${requestTag || 'missing'}, expected ${RELEASE_TAG}`);
    }
    assert(errors.length === 0, errors.join(' | '));
    console.log('smoke-portal-entry: PASS — Twilight 5 shards, awakening, atomic portal entry, authored dungeon gate');
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(`smoke-portal-entry: FAIL — ${e.message}`);
  process.exitCode = 1;
});
