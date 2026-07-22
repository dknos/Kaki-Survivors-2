#!/usr/bin/env node
/** Browser contract + human-review frame for the authored Forest crystals. */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8821);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const SHOT = '/tmp/kks-moonroot-crystals.png';

function mime(p) {
  if (/\.m?js$/.test(p)) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg')) return 'image/jpeg';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.ogg')) return 'audio/ogg';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403); res.end(); return;
  }
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  const failed = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (req) => {
    const url = req.url();
    const errorText = req.failure()?.errorText || 'failed';
    // Chromium cancels redundant Tier-2 GLB preloads during the menu->run
    // handoff. HTTP failures and every non-abort transport failure remain fatal.
    if (errorText === 'net::ERR_ABORTED') return;
    if (!url.includes('music') && !url.includes('gstatic.com/draco')) failed.push(`${errorText}: ${url}`);
  });
  page.on('response', (res) => {
    if (res.url().startsWith(ORIGIN) && res.status() >= 400) failed.push(`${res.status()}: ${res.url()}`);
  });

  try {
    await page.goto(`${ORIGIN}/index.html?smoke=forest-crystals`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: 90_000 });
    await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      const meta = await import('./src/meta.js');
      meta.setOption('selectedStage', 'forest');
      meta.setOption('optMusic', false);
      const s = window.kkState;
      s.replaySeed = { seed: 'forest-crystal-asset-v1', stage: 'forest', character: 'kitty', mode: 'normal' };
      await window.kkStartRun();
    });
    await page.waitForFunction(() => window.kkState?.mode === 'run' && window.kkState?.run?.stage?.id === 'forest', null, { timeout: 90_000 });
    await page.waitForFunction(() => {
      let found = false;
      window.kkState.scene.traverse((o) => {
        if (o.isInstancedMesh && o.userData?.asset === 'moonroot_crystal_cluster.glb') found = true;
      });
      return found && !!window.kkState.scene.getObjectByName('__forestAmber');
    }, null, { timeout: 30_000 });

    const setup = await page.evaluate(async () => {
      const THREE = await import('three');
      const s = window.kkState;
      s.hero.hpMax = s.hero.hp = 1e9;
      s.run.lockdownActive = true;
      const enemies = await import('./src/enemies.js');
      for (const e of s.enemies.active) {
        e.alive = false;
        try { enemies.releaseEnemyVisual(e); } catch (_) {}
      }
      s.enemies.active.length = 0;
      if (s.enemies.spatial?.clear) s.enemies.spatial.clear();

      const glade = [];
      const allPairs = [];
      const amber = [];
      s.scene.traverse((o) => {
        if (o.isInstancedMesh && o.userData?.asset === 'moonroot_crystal_cluster.glb') {
          allPairs.push(o);
          if (o.userData?.roomId === 'glade') glade.push(o);
        }
        if (o.isMesh && !o.isInstancedMesh && o.userData?.asset === 'moonroot_crystal_cluster.glb'
            && o.userData?.interactive === true) amber.push(o);
      });
      const base = glade.find((o) => o.userData?.assetRole === 'rooted-base');
      const crown = glade.find((o) => o.userData?.assetRole === 'crystal-crown');
      if (!base || !crown) throw new Error('Glade moonroot base/crown pair missing');
      base.updateMatrixWorld(true);
      const local = new THREE.Matrix4();
      const world = new THREE.Matrix4();
      const target = new THREE.Vector3();
      base.getMatrixAt(0, local);
      world.copy(base.matrixWorld).multiply(local);
      target.setFromMatrixPosition(world);
      const hx = target.x + 3.0;
      const hz = target.z + 2.0;
      s.hero.pos.set(hx, 0, hz);
      s.hero.vel.set(0, 0, 0);
      if (s.hero.mesh) s.hero.mesh.position.set(hx, s.hero.mesh.position.y, hz);
      s.camera.position.set(target.x + 15, 23, target.z + 15);
      s.camera.lookAt(target.x, 0.55, target.z);
      s.camera.updateMatrixWorld(true);
      return {
        target: { x: target.x, z: target.z },
        gladeDraws: glade.length,
        roomDraws: allPairs.length,
        amberCount: amber.length,
        baseCount: base.count,
        crownCount: crown.count,
        baseTriangles: (base.geometry.index?.count || base.geometry.attributes.position.count) / 3,
        crownTriangles: (crown.geometry.index?.count || crown.geometry.attributes.position.count) / 3,
        crownEmissive: crown.material.emissive?.getHex?.() || 0,
        crownBloom: !!(crown.layers.mask & 2),
        purpose: crown.userData?.gameplayPurpose || '',
        sourceConcept: crown.userData?.sourceConcept || '',
        amberPurpose: amber[0]?.userData?.gameplayPurpose || '',
      };
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: SHOT });

    const render = await page.evaluate(() => ({
      calls: window.kkState.renderer.info.render.drawCalls,
      triangles: window.kkState.renderer.info.render.triangles,
      assetLoaded: !!window.kkState && (() => {
        let ok = false;
        window.kkState.scene.traverse((o) => { if (o.userData?.asset === 'moonroot_crystal_cluster.glb') ok = true; });
        return ok;
      })(),
    }));

    assert(setup.gladeDraws === 2, `expected exactly two Glade moonroot draws, got ${setup.gladeDraws}`);
    assert(setup.roomDraws === 6, `expected two draws in each of three crystal rooms, got ${setup.roomDraws}`);
    assert(setup.baseCount === setup.crownCount && setup.baseCount >= 24, 'Glade base/crown instance counts diverged');
    assert(setup.baseTriangles >= 250 && setup.crownTriangles >= 150, 'authored geometry unexpectedly regressed to primitives');
    assert(setup.crownEmissive !== 0 && !setup.crownBloom, 'crystal crown must keep readable facets out of clipping bloom');
    assert(setup.purpose === 'forest-cluster-chokepoint', 'Glade asset purpose tag missing');
    assert(setup.sourceConcept.endsWith('forest_moonroot_crystal_concept.jpg'), 'Grok source concept tag missing');
    assert(setup.amberCount >= 18 && setup.amberPurpose === 'shoot-to-detonate-amber-node', 'interactive amber did not adopt moonroot asset');
    assert(render.assetLoaded, 'moonroot asset disappeared before render sample');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    assert(failed.length === 0, `failed requests: ${failed.join(' | ')}`);

    console.log(JSON.stringify({ setup, render, screenshot: SHOT, pageErrors, failed }, null, 2));
    console.log('[smoke-forest-crystals] PASS');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error('[smoke-forest-crystals] FAIL');
  console.error(error.stack || error);
  server.close(() => process.exit(1));
});
