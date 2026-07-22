#!/usr/bin/env node
/**
 * FOREST DENSITY visual/regression smoke.
 *
 * Walks a fixed eastward transect through the expanded Wildwood, measures
 * local purposeful environment anchors, captures comparable screenshots,
 * proves the visible tree line is also a physical boundary, and repeats the
 * traversal to catch chunk/resource growth.
 *
 * No production hooks and no npm install. Playwright + Chromium use the
 * shared workspace cache.
 *
 * Run: node tools/smoke-forest-density.mjs   Port: 8812 by default.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8812);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BOOT_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 25_000;
const LOCAL_RADIUS = 32;
const MIN_ANCHORS = 18;
const MIN_LAYERS = 2;
const MAX_CALLS = 470;
const MAX_TRIANGLES = 1_600_000;
const BASE_PROBES = [0, 48, 80, 112, 152, 180];

function mime(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
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
  const full = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function msg(e) {
  return e && e.message ? e.message : String(e);
}

async function installDensityProbe(page) {
  await page.evaluate(() => {
    window.__kkForestDensityProbe = async (x, z, radius) => {
      const THREE = await import('three');
      const s = window.kkState;
      const scene = s.scene;
      const radius2 = radius * radius;
      const rootNames = [
        '__arenaDecor', '__stageLandscape_forest', '__stageLife',
        '__forestLandmarks', '__forestCoffins',
        '__forestNeutrals', '__forestEnvHazards', '__forestEmitters',
        '__forestAmber', '__forestPortals', '__dashSmashSecrets',
        '__puzzlePrismLock',
      ];
      scene.updateMatrixWorld(true);

      const instanceMatrix = new THREE.Matrix4();
      const worldMatrix = new THREE.Matrix4();
      const worldPos = new THREE.Vector3();
      const worldScale = new THREE.Vector3();
      const acceptanceAnchors = new Set();
      const allAnchors = new Set();
      const silhouetteAnchors = new Set();
      const layers = new Set();
      const roots = new Set();
      const purposeCounts = {};
      const rootCounts = {};
      let components = 0;
      let ambientFollowers = 0;

      const silhouettePurposes = new Set([
        'wildwood-canopy', 'wildwood-understory', 'wildwood-ground-break',
        'distant-landmark', 'district-story', 'story-landmark',
        'navigation-landmark', 'biome-silhouette', 'terrain-break',
      ]);

      const bucket = (p) => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
      const purposeOf = (o, rootName) => {
        const u = o.userData || {};
        if (u.landscapePurpose) return u.landscapePurpose;
        if (u.roomId) return `room-decor:${u.roomId}`;
        if (u.landmarkKind) return 'interactive-landmark';
        if (u.coffinKind) return 'interactive-coffin';
        if (u.neutralKind) return 'ambient-neutral';
        if (u.envHazardKind) return 'environment-hazard';
        if (rootName === '__forestPortals') return 'navigation-portal';
        if (rootName.startsWith('__puzzle')) return 'interactive-puzzle';
        return rootName.replace(/^__/, '');
      };
      const record = (p, purpose, rootName) => {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz > radius2) return;
        components++;
        roots.add(rootName);
        layers.add(purpose);
        purposeCounts[purpose] = (purposeCounts[purpose] || 0) + 1;
        rootCounts[rootName] = (rootCounts[rootName] || 0) + 1;
        const key = bucket(p);
        allAnchors.add(key);
        // The butterfly/mote pool follows the player. Report it, but never let
        // it make an otherwise empty patch pass the static density gate.
        if (purpose === 'ambient-life') ambientFollowers++;
        else acceptanceAnchors.add(key);
        if (silhouettePurposes.has(purpose)) silhouetteAnchors.add(key);
      };

      for (const rootName of rootNames) {
        const root = scene.getObjectByName(rootName);
        if (!root || !root.visible) continue;
        root.traverseVisible((o) => {
          // The dedicated landscape root is also a child of __arenaDecor.
          // Count it through its explicit owner entry only, never twice.
          if (rootName === '__arenaDecor') {
            let p = o;
            while (p && p !== root) {
              if (p.name === '__stageLandscape_forest') return;
              p = p.parent;
            }
          }
          const purpose = purposeOf(o, rootName);
          if (o.isInstancedMesh) {
            for (let i = 0; i < o.count; i++) {
              o.getMatrixAt(i, instanceMatrix);
              worldMatrix.copy(o.matrixWorld).multiply(instanceMatrix);
              worldScale.setFromMatrixScale(worldMatrix);
              // Pooled systems zero-scale unused slots.
              if (Math.max(worldScale.x, worldScale.y, worldScale.z) < 0.02) continue;
              worldPos.setFromMatrixPosition(worldMatrix);
              record(worldPos, purpose, rootName);
            }
            return;
          }
          if (!o.isMesh) return;
          if (!o.geometry.boundingSphere) {
            try { o.geometry.computeBoundingSphere(); } catch (_) {}
          }
          // Roads, water, and creek ribbons are measured as terrain below;
          // their origin is not a meaningful local prop anchor.
          if (o.geometry.boundingSphere && o.geometry.boundingSphere.radius > 16) return;
          o.getWorldPosition(worldPos);
          record(worldPos, purpose, rootName);
        });
      }

      const ground = s.envGroup && s.envGroup.userData && s.envGroup.userData.ground;
      const image = ground && ground.material && ground.material.map && ground.material.map.image;
      const imageWidth = image ? (image.naturalWidth || image.videoWidth || image.width || 0) : 0;
      const imageHeight = image ? (image.naturalHeight || image.videoHeight || image.height || 0) : 0;
      const imageSrc = image && (image.currentSrc || image.src) || '';
      const gw = ground && ground.geometry && ground.geometry.parameters && ground.geometry.parameters.width || 0;
      const gh = ground && ground.geometry && ground.geometry.parameters && ground.geometry.parameters.height || 0;
      const groundCovers = !!(ground && ground.visible && Math.abs(x) <= gw * 0.5 && Math.abs(z) <= gh * 0.5);

      const { sampleStageTerrain } = await import('./src/stageTerrainLayout.js');
      const terrain = sampleStageTerrain('forest', x, z);
      const { detectRoom } = await import('./src/forestRooms.js');

      const heroProjected = new THREE.Vector3(s.hero.pos.x, 1, s.hero.pos.z).project(s.camera);
      return {
        x, z, radius,
        actualX: s.hero.pos.x,
        actualZ: s.hero.pos.z,
        detectedRoom: detectRoom(x, z),
        currentRoom: s.run.currentRoom,
        components,
        uniqueAnchors: acceptanceAnchors.size,
        allAnchors: allAnchors.size,
        silhouetteAnchors: silhouetteAnchors.size,
        ambientFollowers,
        layers: [...layers].sort(),
        roots: [...roots].sort(),
        purposeCounts,
        rootCounts,
        ground: {
          exists: !!ground,
          visible: !!(ground && ground.visible),
          covers: groundCovers,
          imageWidth,
          imageHeight,
          imageSrc,
          width: gw,
          height: gh,
        },
        terrain: {
          kind: terrain.kind,
          inside: terrain.inside,
          safe: terrain.safe,
          active: terrain.active,
        },
        heroNdc: { x: heroProjected.x, y: heroProjected.y },
        render: {
          calls: s.renderer.info.render.drawCalls,
          triangles: s.renderer.info.render.triangles,
        },
      };
    };

    window.__kkForestResourceSnapshot = () => {
      const s = window.kkState;
      let objects = 0;
      let environmentObjects = 0;
      let environmentCapacity = 0;
      s.scene.traverse((o) => {
        objects++;
        if (o.name === '__arenaDecor' || o.parent?.name === '__arenaDecor'
          || /^__(?:stageLife|forest|dashSmashSecrets|puzzle)/.test(o.name || '')) {
          environmentObjects++;
        }
        if (o.isInstancedMesh && (/forest|stageLife|wildwood/i.test(o.name || '')
          || o.userData?.landscapePurpose || o.userData?.roomId)) {
          environmentCapacity += o.instanceMatrix?.count || o.count || 0;
        }
      });
      return {
        objects,
        environmentObjects,
        environmentCapacity,
        geometries: s.renderer.info.memory.geometries,
        textures: s.renderer.info.memory.textures,
      };
    };
  });
}

async function prepareForest(page) {
  await page.goto(`${ORIGIN}/index.html?smoke=forest-density`, {
    waitUntil: 'load',
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => typeof window.kkStartRun === 'function' && window.kkState,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
  await page.evaluate(async () => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
    const meta = await import('./src/meta.js');
    meta.setOption('selectedStage', 'forest');
    meta.setOption('optMusic', false);
    meta.setOption('optAutoFirePrimary', false);
    const s = window.kkState;
    s.replaySeed = {
      seed: 'forest-density-east-v1',
      stage: 'forest',
      character: 'kitty',
      mode: 'normal',
    };
    s.weapons.length = 0;
    if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
    await window.kkStartRun();
  });
  await page.waitForFunction(
    () => window.kkState?.started === true
      && window.kkState.mode === 'run'
      && window.kkState.run?.stage?.id === 'forest'
      && document.querySelector('#kk-forest-hud'),
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
  await page.waitForTimeout(2200);
  await page.evaluate(async () => {
    const s = window.kkState;
    s.hero.hpMax = 1e9;
    s.hero.hp = 1e9;
    // Keep this an environment test: no room-boss/puzzle overlays and no normal
    // wave top-ups changing screenshots between eastward probes.
    s.run.forestPuzzlesSolved = {
      flow_weaver: true,
      harmonic_alignment: true,
      prism_lock: true,
      mossroot_pulse: true,
    };
    for (const id of ['saphollow', 'crystalchoir', 'amberlabyrinth', 'bramblemaze', 'mossroot', 'glowfen']) {
      s.run._sealedRooms[id] = { bossId: `density-${id}`, alive: false };
    }
    s.run.lockdownActive = true;
    // This smoke intentionally camera-probes the decorative Wildwood between
    // authored rooms. Normal Forest now contains players to portal rooms, so
    // use the existing special-objective exemption for this render-only scan;
    // the dedicated portal-trial smoke owns normal-run containment coverage.
    s.modes.bossRush = true;
    try {
      const enemies = await import('./src/enemies.js');
      for (const e of s.enemies.active) {
        e.alive = false;
        try { enemies.releaseEnemyVisual(e); } catch (_) {}
      }
      s.enemies.active.length = 0;
      if (s.enemies.spatial?.clear) s.enemies.spatial.clear();
    } catch (_) {}
  });
  await installDensityProbe(page);
}

async function warpAndFreeze(page, x, z = 0, settleMs = 850) {
  await page.evaluate(({ x, z }) => {
    const s = window.kkState;
    s.time.paused = false;
    s.hero.pos.set(x, 0, z);
    s.hero.vel.set(0, 0, 0);
  }, { x, z });
  await page.waitForTimeout(settleMs);
  await page.evaluate(({ x, z }) => {
    const s = window.kkState;
    // Snap after room visibility has settled so every screenshot has the same
    // projection even at SwiftShader's low frame rate.
    s.camera.position.set(x + 40, 60, z + 40);
    s.camera.lookAt(x, 0, z);
    s.camera.updateMatrixWorld(true);
    s.time.paused = true;
  }, { x, z });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-forest-density] FAIL: playwright missing at ' + PLAY_PATH);
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-forest-density] FAIL: chromium missing at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log('[smoke-forest-density] server on ' + ORIGIN);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
      '--enable-webgl', '--ignore-gpu-blocklist',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const failures = [];
  const pageErrors = [];
  const consoleErrors = [];
  const localRequestErrors = [];

  page.on('pageerror', (e) => pageErrors.push(msg(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', (req) => {
    if (req.url().startsWith(ORIGIN)) {
      const errorText = req.failure()?.errorText || 'failed';
      // Chromium cancels redundant in-flight preloads while the menu swaps to
      // the awaited stage tier. HTTP >=400, decode console errors, and page
      // errors remain fatal below; transport-level cancellation alone is not.
      if (errorText === 'net::ERR_ABORTED') return;
      localRequestErrors.push(`${errorText} ${req.url()}`);
    }
  });
  page.on('response', (res) => {
    if (res.url().startsWith(ORIGIN) && res.status() >= 400) {
      localRequestErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  const rows = [];
  try {
    await prepareForest(page);
    const eastProbe = await page.evaluate(async () => {
      const { FOREST_WORLD_BOUNDS } = await import('./src/forestRooms.js');
      return FOREST_WORLD_BOUNDS.maxX - FOREST_WORLD_BOUNDS.inset;
    });
    const probes = [...BASE_PROBES, eastProbe];

    for (const x of probes) {
      await warpAndFreeze(page, x);
      const row = await page.evaluate(
        ({ x, radius }) => window.__kkForestDensityProbe(x, 0, radius),
        { x, radius: LOCAL_RADIUS },
      );
      rows.push(row);
      const suffix = String(x).padStart(3, '0');
      await page.screenshot({
        path: `/tmp/kks-forest-density-east-x${suffix}.png`,
        fullPage: false,
      });

      if (Math.abs(row.actualX - x) > 0.15 || Math.abs(row.actualZ) > 0.15) {
        failures.push(`x=${x}: hero warp settled at (${row.actualX.toFixed(2)},${row.actualZ.toFixed(2)})`);
      }
      if (Math.abs(row.heroNdc.x) > 0.18 || Math.abs(row.heroNdc.y) > 0.25) {
        failures.push(`x=${x}: hero not camera-centered (ndc=${row.heroNdc.x.toFixed(3)},${row.heroNdc.y.toFixed(3)})`);
      }
      if (row.uniqueAnchors < MIN_ANCHORS) {
        failures.push(`x=${x}: local anchors=${row.uniqueAnchors} (<${MIN_ANCHORS})`);
      }
      if (row.layers.length < MIN_LAYERS) {
        failures.push(`x=${x}: environment layers=${row.layers.length} (<${MIN_LAYERS}) [${row.layers}]`);
      }
      if (x >= 48 && row.silhouetteAnchors < 6) {
        failures.push(`x=${x}: silhouette anchors=${row.silhouetteAnchors} (<6)`);
      }
      if (!row.ground.exists || !row.ground.visible || !row.ground.covers) {
        failures.push(`x=${x}: ground missing/hidden/out-of-bounds ${JSON.stringify(row.ground)}`);
      }
      if (row.ground.imageWidth < 1 || row.ground.imageHeight < 1) {
        failures.push(`x=${x}: ground texture not decoded (${row.ground.imageWidth}x${row.ground.imageHeight})`);
      }
      if (!/ground_detail_forest_512\.webp(?:[?#]|$)/.test(row.ground.imageSrc)) {
        failures.push(`x=${x}: wrong Forest ground albedo (${row.ground.imageSrc || 'none'})`);
      }
      if (row.render.calls > MAX_CALLS) {
        failures.push(`x=${x}: render calls=${row.render.calls} (>${MAX_CALLS})`);
      }
      if (row.render.triangles > MAX_TRIANGLES) {
        failures.push(`x=${x}: triangles=${row.render.triangles} (>${MAX_TRIANGLES})`);
      }
      console.log(
        `  x=${String(x).padStart(3)} anchors=${String(row.uniqueAnchors).padStart(3)}`
        + ` silhouette=${String(row.silhouetteAnchors).padStart(3)}`
        + ` layers=${String(row.layers.length).padStart(2)} roots=${String(row.roots.length).padStart(2)}`
        + ` calls=${String(row.render.calls).padStart(3)} tris=${(row.render.triangles / 1e6).toFixed(3)}M`
        + ` room=${row.detectedRoom || 'wildwood'}`,
      );
    }

    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      const hi = Math.max(a.uniqueAnchors, b.uniqueAnchors);
      const lo = Math.min(a.uniqueAnchors, b.uniqueAnchors);
      const drop = hi > 0 ? 1 - lo / hi : 0;
      if (drop > 0.75) {
        failures.push(`density cliff x=${a.x}->${b.x}: ${a.uniqueAnchors}->${b.uniqueAnchors} (${(drop * 100).toFixed(1)}%)`);
      }
    }

    // Probe the runtime movement clamp beyond the authored east edge.
    await page.evaluate(() => {
      const s = window.kkState;
      s.time.paused = false;
      s.hero.pos.set(999, 0, 0);
      s.hero.vel.set(45, 0, 0);
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const boundary = await page.evaluate(async () => {
      const { FOREST_WORLD_BOUNDS } = await import('./src/forestRooms.js');
      const s = window.kkState;
      return {
        x: s.hero.pos.x,
        z: s.hero.pos.z,
        vx: s.hero.vel.x,
        vz: s.hero.vel.z,
        expectedX: FOREST_WORLD_BOUNDS.maxX - FOREST_WORLD_BOUNDS.inset,
      };
    });
    if (Math.abs(boundary.x - boundary.expectedX) > 0.01 || Math.abs(boundary.z) > 0.01) {
      failures.push(`boundary clamp failed: ${JSON.stringify(boundary)}`);
    }
    if (Math.hypot(boundary.vx, boundary.vz) > 0.01) {
      failures.push(`boundary clamp retained velocity: (${boundary.vx},${boundary.vz})`);
    }

    // Repeating the full span must reuse the same chunks/resources.
    await warpAndFreeze(page, 0, 0, 350);
    const plateauBefore = await page.evaluate(() => window.__kkForestResourceSnapshot());
    for (const x of [eastProbe, 0, eastProbe]) await warpAndFreeze(page, x, 0, 350);
    const plateauAfter = await page.evaluate(() => window.__kkForestResourceSnapshot());
    if (plateauAfter.objects !== plateauBefore.objects) {
      failures.push(`scene object count grew during traversal: ${plateauBefore.objects}->${plateauAfter.objects}`);
    }
    if (plateauAfter.environmentObjects !== plateauBefore.environmentObjects
      || plateauAfter.environmentCapacity !== plateauBefore.environmentCapacity) {
      failures.push(`environment allocation changed: ${JSON.stringify(plateauBefore)} -> ${JSON.stringify(plateauAfter)}`);
    }
    if (plateauAfter.geometries > plateauBefore.geometries + 1
      || plateauAfter.textures > plateauBefore.textures) {
      failures.push(`renderer memory grew during traversal: ${JSON.stringify(plateauBefore)} -> ${JSON.stringify(plateauAfter)}`);
    }
    console.log(`  boundary: requested=999 clamped=${boundary.x.toFixed(1)} velocity=${Math.hypot(boundary.vx, boundary.vz).toFixed(2)}`);
    console.log(`  plateau: objects=${plateauBefore.objects}->${plateauAfter.objects} env=${plateauBefore.environmentObjects}->${plateauAfter.environmentObjects} geometries=${plateauBefore.geometries}->${plateauAfter.geometries} textures=${plateauBefore.textures}->${plateauAfter.textures}`);

    for (const e of pageErrors) failures.push('page error: ' + e);
    for (const e of consoleErrors) failures.push('console error: ' + e);
    for (const e of localRequestErrors) failures.push('local request error: ' + e);
  } catch (e) {
    failures.push('exception: ' + msg(e));
  } finally {
    await ctx.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n========== FOREST DENSITY SUMMARY ==========');
  if (failures.length) {
    console.error(`[smoke-forest-density] FAIL (${failures.length}):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-forest-density] PASS — east Wildwood stays dense, bounded, and allocation-stable');
  console.log('  screenshots: /tmp/kks-forest-density-east-x{000,048,080,112,152,180,<runtime-east>}.png');
}

main().catch((e) => {
  console.error('[smoke-forest-density] FATAL:', e && (e.stack || e.message || e));
  try { server.close(); } catch (_) {}
  process.exit(2);
});
