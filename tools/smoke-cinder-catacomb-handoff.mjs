#!/usr/bin/env node
/** End-to-end Cinder regression: Catacomb shard -> five shards -> bounded finale. */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8933);
const REPLAY = process.env.REPLAY === '1';
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
  if (/\.(?:ogg|mp3|wav)$/.test(p)) return 'audio/mpeg';
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
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(CHROME)) throw new Error('Playwright/Chromium cache missing');
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
    page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`http://127.0.0.1:${PORT}/?smoke=cinder-catacomb-handoff`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => window.kkStartRun && window.kkState, null, { timeout: 90_000 });
    await page.evaluate(async (replay) => {
      localStorage.setItem('kks_introSeen', '1');
      const meta = await import('./src/meta.js');
      meta.setOption('optMusic', false);
      meta.setOption('optDevUnlockAllLevels', true);
      meta.setOption('unlockedVoid', replay);
      meta.setOption('selectedStage', 'cinder');
      window.kkState.weapons.length = 0;
      await window.kkStartRun();
      window.kkState.hero.hp = window.kkState.hero.hpMax = 1e9;
      window.kkState.hero.iFramesUntil = 1e9;
      window.__kkPortalDebug = await import('./src/portalShards.js');
    }, REPLAY);
    await page.waitForFunction(() => window.kkState?.mode === 'run' && window.kkState?.run?.stage?.id === 'cinder', null, { timeout: 90_000 });

    // Reproduce the real handoff from the dungeon boss. This used to be
    // erased by the generic "catacomb already cleared" reset before the queue
    // could become the third visible shard.
    await page.evaluate(() => {
      const s = window.kkState;
      s.run.catacombCleared = true;
      s.run._catacombShardGranted = true;
      s.run._shardDrops = [{ x: s.hero.pos.x + 4, z: s.hero.pos.z }];
    });
    await page.waitForFunction(() => {
      const snap = window.__kkPortalDebug._debugPortalShardMap();
      return snap.locations.length >= 3 && window.kkState.run._shardDrops.length === 0;
    }, null, { timeout: 12_000 });
    const drained = await page.evaluate(() => ({
      mode: window.kkState.mode,
      stage: window.kkState.run.stage.id,
      live: window.__kkPortalDebug._debugPortalShardMap().locations.length,
      minimap: getComputedStyle(document.getElementById('kk-portal-minimap')).display,
    }));
    assert(drained.mode === 'run' && drained.stage === 'cinder', `dungeon shard reset the run: ${JSON.stringify(drained)}`);
    assert(drained.live >= 3 && drained.minimap !== 'none', `dungeon shard was not surfaced: ${JSON.stringify(drained)}`);

    // Collect every current shard through the production proximity path. Once
    // no live marker remains, the anti-softlock system surfaces the two elite
    // shards still owed; collect those the same way.
    for (let i = 0; i < 24; i++) {
      const status = await page.evaluate(() => {
        const snap = window.__kkPortalDebug._debugPortalShardMap();
        if (snap.locations.length) {
          const p = snap.locations[0];
          window.kkState.hero.pos.set(p.x, 0, p.z);
          window.kkState.hero.vel.set(0, 0, 0);
        }
        return { live: snap.locations.length, portal: snap.portal, shards: window.kkState.run.portalShards, cutscene: !!window.__kkCutsceneActive };
      });
      if (status.portal || status.cutscene || status.shards >= 5) break;
      await page.waitForTimeout(status.live ? 240 : 420);
    }
    await page.waitForFunction(() => window.__kkCutsceneActive || window.__kkPortalDebug._debugPortalShardMap().portal, null, { timeout: 15_000 });
    await page.evaluate(() => { if (window.__kkCutsceneActive) window.__kkSkipCutscene(); });
    await page.waitForFunction(() => !!window.__kkPortalDebug._debugPortalShardMap().portal, null, { timeout: 15_000 });
    const portal = await page.evaluate(() => window.__kkPortalDebug._debugPortalShardMap().portal);
    assert(portal && await page.evaluate(() => window.kkState.run.portalShards === 5), 'Cinder finale portal did not awaken at 5/5');

    await page.waitForTimeout(700);
    await page.evaluate(({ x, z }) => {
      window.kkState.hero.pos.set(x, 0, z);
      window.kkState.hero.vel.set(0, 0, 0);
    }, portal);
    await page.waitForFunction(() => window.kkState.mode === 'bullethell', null, { timeout: 90_000 });
    const finale = await page.evaluate(async () => {
      const bh = await import('./src/bullethell/index.js');
      const meta = await import('./src/meta.js');
      return {
        mode: window.kkState.mode,
        campaign: bh.getBhCampaign(),
        unlockedVoidBeforeWin: !!meta.getMeta().unlockedVoid,
      };
    });
    assert(finale.campaign?.maxWave === 5 && finale.campaign?.unlockFlag === 'unlockedVoid',
      `Cinder portal did not create bounded chapter finale: ${JSON.stringify(finale)}`);
    assert(finale.unlockedVoidBeforeWin === REPLAY,
      `Void unlock state changed before the bounded finale: replay=${REPLAY} state=${finale.unlockedVoidBeforeWin}`);
    assert(errors.length === 0, errors.join(' | '));
    console.log(`smoke-cinder-catacomb-handoff: PASS — ${REPLAY ? 'replay' : 'first clear'}, dungeon shard drained, 5/5 portal awakened, bounded Void finale entered`);
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(`smoke-cinder-catacomb-handoff: FAIL — ${e && (e.stack || e.message)}`);
  process.exitCode = 1;
  try { server.close(); } catch (_) {}
});
