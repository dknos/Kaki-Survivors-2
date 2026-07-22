#!/usr/bin/env node
/**
 * Cave stage skeleton smoke (P4A cohort 1 of N, 2026-05-18).
 *
 * Phase 1 ONLY for cohort 1 — proves the cave stage is selectable, mounts
 * the placeholder decor group, and runs without errors. Layered cohorts
 * (P4A-c2 … P4A-cN) will add phase 2 (rooms), phase 3 (boss), phase 4
 * (reaper / final wave) — see docs/STAGE_AUTHORING.md §7 for the cadence.
 *
 * Phase 1 assertions:
 *   - window.kkStartRun is registered (boot completed)
 *   - state.run.stage.id === 'cave'
 *   - scene.getObjectByName('caveStage') is non-null (decor builder ran)
 *   - 0 page errors
 *   - rAF alive (fps > FPS_LIVENESS_FLOOR — same liveness gate as
 *     smoke-forest-v2; headless-Chromium swiftshader can't approach 30fps,
 *     so this is a "loop alive" probe not a perf gate)
 *
 * Boot path:
 *   1. Goto /index.html?smoke=1
 *   2. Wait for window.kkStartRun
 *   3. Set meta.unlockedCave = true (menu gating — selectedStage()
 *      resolver itself doesn't gate, but menuV2's _stageUnlocked does;
 *      smoke pokes the flag so the next cohort's UI-driven smoke doesn't
 *      have to special-case the gate)
 *   4. setOption('selectedStage', 'cave')
 *   5. window.kkStartRun()
 *   6. Wait for kkState.run + kkState.mode === 'run'
 *   7. Settle, then probe
 *
 * Run: node tools/smoke-cave-v2.mjs
 * NO npm install. Playwright is expected at /home/nemoclaw/node_modules.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '..');
// Avoid port collisions with the other smokes (forest-v2=8773, ram-diet=8776, amber=8771).
const PORT = Number(process.env.PORT || 8778);
const BOOT_TIMEOUT_MS = 60000;
const PHASE_SETTLE_MS = 3000;
const FPS_WINDOW_MS = 2000;
const FPS_LIVENESS_FLOOR = 0.5;

// ── Static server (lifted from smoke-forest-v2 / smoke-ram-diet) ──────────
function mime(p) {
  if (p.endsWith('.js'))   return 'application/javascript';
  if (p.endsWith('.mjs'))  return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.svg'))  return 'image/svg+xml';
  if (p.endsWith('.mp3'))  return 'audio/mpeg';
  if (p.endsWith('.wav'))  return 'audio/wav';
  if (p.endsWith('.ogg'))  return 'audio/ogg';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function measureFps(page) {
  return await page.evaluate(async (windowMs) => {
    return await new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function tick() {
        frames++;
        if (performance.now() - t0 >= windowMs) {
          resolve(frames / (windowMs / 1000));
        } else {
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    });
  }, FPS_WINDOW_MS);
}

async function main() {
  const t0 = Date.now();

  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-cave] FAIL: playwright not installed at ' + PLAY_PATH);
    console.error('[smoke-cave] Per CLAUDE.md, smoke tools NEVER run npm install.');
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-cave] FAIL: chromium binary not found at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }
  console.log('[smoke-cave] playwright check: OK');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-cave] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.log('[console.error]', msg.text());
    }
  });
  page.on('pageerror', (e) => {
    pageErrors.push(e.message);
    console.error('[pageerror]', e.message);
  });

  let exitCode = 0;
  try {
    const url = 'http://127.0.0.1:' + PORT + '/index.html?smoke=1';
    await page.goto(url, { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    console.log('[smoke-cave] page loaded; waiting for kkStartRun');

    await page.waitForFunction(
      () => typeof window.kkStartRun === 'function',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Pin run to Cave BEFORE start. Two pokes:
    //   (a) meta.unlockedCave = true so any menu render path treats cave as
    //       selectable (defense in depth — the resolver itself doesn't gate,
    //       but a future UI-driven smoke would).
    //   (b) setOption('selectedStage', 'cave') — same call shape as
    //       smoke-forest-v2 / smoke-ram-diet.
    await page.evaluate(async () => {
      try {
        const mod = await import('./src/meta.js');
        const m = (mod.getMeta && mod.getMeta()) || null;
        if (m) m.unlockedCave = true;
        if (mod.setOption) mod.setOption('selectedStage', 'cave');
        else if (m) m.selectedStage = 'cave';
      } catch (e) {
        console.warn('[smoke-cave] meta poke failed:', e && e.message);
      }
    });

    // Clear state.weapons before kkStartRun. Production user-flow reaches
    // start() via kkReturnToMenu → menuV2 stage pick → Embark, by which
    // point _teardownActiveRun has wiped weapons via resetState. On the
    // straight boot → kkStartRun path the boot-time acquireWeapon (main.js
    // line ~441) leaves state.weapons.length = 1, so the gate at start()
    // line ~526 (`if (state.weapons.length === 0)`) skips the second
    // applyMetaUpgrades — meaning the boot-time stage selection (forest by
    // default) sticks even after setOption('selectedStage','cave'). Wiping
    // weapons here forces the re-apply path and matches the production
    // menu→Embark control flow.
    await page.evaluate(() => {
      try {
        const s = window.kkState;
        if (s && s.weapons && typeof s.weapons.length !== 'undefined') {
          s.weapons.length = 0;
        }
      } catch (e) {
        console.warn('[smoke-cave] weapons-clear failed:', e && e.message);
      }
    });

    // Start the run. start() is async (awaits preloadStage); we poll for
    // state.run + state.mode === 'run'.
    await page.evaluate(() => {
      if (typeof window.kkPerfForceOn === 'function') window.kkPerfForceOn();
      window.kkStartRun();
    });

    await page.waitForFunction(
      () => !!window.kkState && !!window.kkState.run && window.kkState.mode === 'run',
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
    console.log('[smoke-cave] kkState live; settling ' + PHASE_SETTLE_MS + 'ms for phase 1');

    await new Promise((r) => setTimeout(r, PHASE_SETTLE_MS));

    // FPS liveness probe — rAF alive ≠ perf gate (see smoke-forest-v2 header
    // for the rationale; headless swiftshader can't do 30fps).
    const fps1 = await measureFps(page);

    // Phase 1 probe — assert cave wired up.
    const p1 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s) return { ok: false, reason: 'kkState missing' };
      const stageId = s.run && s.run.stage && s.run.stage.id;
      if (stageId !== 'cave') {
        return { ok: false, reason: 'state.run.stage.id=' + stageId + ' (expected cave)', stageId };
      }
      if (!s.scene || typeof s.scene.getObjectByName !== 'function') {
        return { ok: false, reason: 'scene.getObjectByName unavailable', stageId };
      }
      const caveGroup = s.scene.getObjectByName('caveStage');
      if (!caveGroup) {
        return { ok: false, reason: 'scene.getObjectByName("caveStage") returned null — buildCaveStage did not run', stageId };
      }
      // Count children so future cohorts can extend the probe (e.g.
      // assert >= 3 stalactite landmarks at c2).
      const childCount = caveGroup.children ? caveGroup.children.length : 0;
      const envGroupOk = !!s.envGroup;
      return {
        ok: true,
        reason: 'stage=cave, caveStage group present with ' + childCount + ' child(ren), envGroup=' + envGroupOk,
        stageId, childCount, envGroupOk,
      };
    });

    let p1Pass = p1.ok;
    let p1Reason = p1.reason;
    if (p1Pass && fps1 <= FPS_LIVENESS_FLOOR) {
      p1Pass = false;
      p1Reason += '; rAF DEAD (fps=' + fps1.toFixed(2) + ')';
    }

    const status = p1Pass ? 'PASS' : 'FAIL';
    console.log('phase 1 (skeleton): ' + status + ' — ' + p1Reason
                + '  [fps=' + fps1.toFixed(1) + ']');

    // ── Phase 2 (P4A cohort 2) — Stalactite cluster landed ──────────────
    // Probes caveStage.userData.stalactiteCount, set in src/stages/cave/
    // caveStage.js after buildStalactiteCluster returns. Cohort 2 author-
    // anchors 6 clusters × 4-5 stalactites = 24-30 instances; threshold
    // ≥6 is the conservative gate so future cohort tweaks (e.g. dropping
    // an interior cluster for room overlap) don't trip this.
    const p2 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const caveGroup = s.scene.getObjectByName('caveStage');
      if (!caveGroup) return { ok: false, reason: 'caveStage group missing' };
      const n = (caveGroup.userData && caveGroup.userData.stalactiteCount) | 0;
      if (n < 6) {
        return { ok: false, reason: 'stalactiteCount=' + n + ' (expected >=6)' };
      }
      // Confirm the cluster group itself is mounted under caveStage and
      // contains two InstancedMesh children (bodies + tips).
      const stalGroup = caveGroup.getObjectByName('caveStage_stalactites');
      if (!stalGroup) {
        return { ok: false, reason: 'caveStage_stalactites group missing', count: n };
      }
      const bodies = stalGroup.getObjectByName('caveStage_stalactiteBodies');
      const tips   = stalGroup.getObjectByName('caveStage_stalactiteTips');
      if (!bodies || !tips) {
        return { ok: false, reason: 'stalactite bodies/tips InstancedMesh missing', count: n };
      }
      // Tips must be bloom-tagged for the slot-3 moss glow per the style doc.
      const tipsBloom = tips.layers && typeof tips.layers.mask === 'number'
        ? (tips.layers.mask & (1 << 1)) !== 0
        : false;
      return {
        ok: true,
        reason: 'stalactiteCount=' + n + ', bodies+tips present, tips bloom=' + tipsBloom,
        count: n, tipsBloom,
      };
    });
    console.log('phase 2 (stalactites): ' + (p2.ok ? 'PASS' : 'FAIL') + ' — ' + p2.reason);

    // ── Phase 3 (P4A cohort 2) — env.js cave wire-up ─────────────────────
    // Asserts the cave entry exists in ATMOS_SPECS (via the cluster object
    // on envGroup.userData.atmosClusters.cave) AND that the lighting +
    // fog colors came from the cave branch of applyStageTint (not the
    // forest-baseline fallthrough). Direct object probe — no screenshot
    // path, deterministic under headless swiftshader.
    const p3 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s) return { ok: false, reason: 'kkState missing' };
      const env = s.envGroup;
      if (!env || !env.userData) return { ok: false, reason: 'envGroup missing' };
      // (a) ATMOS_SPECS cave cluster exists + is the active one.
      const clusters = env.userData.atmosClusters;
      if (!clusters || !clusters.cave) {
        return { ok: false, reason: 'envGroup.userData.atmosClusters.cave missing — ATMOS_SPECS cave entry not registered' };
      }
      if (!clusters.cave.visible) {
        return { ok: false, reason: 'atmos cave cluster present but not visible (active stage mismatch?)' };
      }
      // (b) Fog color matches CAVE_PALETTE.shadow (0x1a1820). applyStageTint
      // already pipes stage.fogColor through, so this validates the cave
      // STAGES entry → fog plumbing too.
      const fogHex = (s.scene && s.scene.fog && s.scene.fog.color)
        ? s.scene.fog.color.getHex() : -1;
      if (fogHex !== 0x1a1820) {
        return { ok: false, reason: 'scene.fog.color=0x' + fogHex.toString(16) + ' (expected 0x1a1820)' };
      }
      // (c) Lighting deltas — cave arm sets hemi.intensity=0.18 (vs forest
      // baseline 0.28). Probe hemi via envGroup userData stash.
      const hemi = env.userData.hemi;
      if (!hemi) return { ok: false, reason: 'envGroup.userData.hemi missing' };
      if (hemi.intensity > 0.22) {
        // Forest baseline is 0.28; cave should drop to 0.18. Threshold 0.22
        // catches "fell through to forest baseline" without rejecting small
        // future tweaks to the cave value.
        return { ok: false, reason: 'hemi.intensity=' + hemi.intensity + ' (expected <=0.22 for cave)' };
      }
      return {
        ok: true,
        reason: 'atmos cave active, fog=0x' + fogHex.toString(16) + ', hemi.intensity=' + hemi.intensity.toFixed(3),
        fogHex, hemiIntensity: hemi.intensity,
      };
    });
    console.log('phase 3 (env cave branch): ' + (p3.ok ? 'PASS' : 'FAIL') + ' — ' + p3.reason);

    // ── Phase 4 — Authored grotto + clean ground ownership ────────────────
    // The former pulsing glowmoss discs, permanent center sigil, and 80x80
    // floor overlay were removed because they read like fake AoEs and hid the
    // PBR floor. Assert their absence and the replacement water landmark.
    const p4 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const caveGroup = s.scene.getObjectByName('caveStage');
      if (!caveGroup) return { ok: false, reason: 'caveStage group missing' };
      for (const oldName of ['caveStage_floorAccent', 'caveStage_sigilFloor', 'caveStage_glowmoss']) {
        if (caveGroup.getObjectByName(oldName)) return { ok: false, reason: oldName + ' should be absent' };
      }
      const landscape = caveGroup.getObjectByName('__stageLandscape_cave');
      if (!landscape) return { ok: false, reason: '__stageLandscape_cave missing' };
      const water = landscape.getObjectByName('caveStage_grottoWater');
      if (!water || !water.isInstancedMesh || water.count < 3) {
        return { ok: false, reason: 'grotto water missing/not instanced (count=' + (water && water.count) + ')' };
      }
      if (water.renderOrder >= 0 || water.material.depthWrite !== false) {
        return { ok: false, reason: 'water layering unsafe (renderOrder=' + water.renderOrder + ', depthWrite=' + water.material.depthWrite + ')' };
      }
      const waterBloom = (water.layers.mask & (1 << 1)) !== 0;
      if (waterBloom) return { ok: false, reason: 'ambient grotto water must not be bloom-tagged' };

      const env = s.envGroup;
      if (!env || !env.userData) return { ok: false, reason: 'envGroup missing' };
      const packs = env.userData.groundPacks;
      if (!packs) return { ok: false, reason: 'envGroup.userData.groundPacks missing' };
      const cavePack = packs.cave;
      if (!cavePack || !cavePack.diff) {
        return { ok: false, reason: 'groundPacks.cave.diff missing' };
      }
      const t = packs.twilight && packs.twilight.diff;
      const f = packs.forest   && packs.forest.diff;
      if (cavePack.diff === t || cavePack.diff === f) {
        return { ok: false, reason: 'cave pack diff aliased to forest/twilight texture' };
      }
      return {
        ok: true,
        reason: '3 instanced non-bloom water pools, fake AoEs absent, authored cave ground active',
      };
    });
    console.log('phase 4 (grotto + ground ownership): ' + (p4.ok ? 'PASS' : 'FAIL') + ' — ' + p4.reason);

    // ── Phase 5 (P4A cohort 4) — Ceiling drip particle system ────────────
    // Three assertions:
    //   (a) caveStage.userData.dripPoolSize >= 20 — guards against the
    //       buildCeilingDrips builder silently no-op'ing (e.g. parent null
    //       guard short-circuit). Cohort 4 pre-allocates 24 slots.
    //   (b) InstancedMesh `caveStage_ceilingDrips` mounted + bloom-tagged
    //       so the slot-3 streak pops under the same chrome as the
    //       cohort-2 tips and cohort-3 patches.
    //   (c) After a 2s settle the dynamic drip-spawn module reports
    //       totalSpawned >= 1. We use a counter (not a snapshot of an
    //       in-flight slot) because at 0.5/s + 0.3-0.6s flight times the
    //       "catch one mid-air" probe is a flake per cohort-4 advisor.
    // For (c), import the module dynamically and call the spawn-counter
    // accessor — same pattern smoke-cave uses for `meta.js` import.
    await new Promise((r) => setTimeout(r, 2200));   // settle for spawn dispatcher
    const p5 = await page.evaluate(async () => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const caveGroup = s.scene.getObjectByName('caveStage');
      if (!caveGroup) return { ok: false, reason: 'caveStage group missing' };
      // (a) Pool size
      const poolSize = (caveGroup.userData && caveGroup.userData.dripPoolSize) | 0;
      if (poolSize < 20) {
        return { ok: false, reason: 'dripPoolSize=' + poolSize + ' (expected >=20)' };
      }
      // (b) InstancedMesh + bloom
      const dripGroup = caveGroup.getObjectByName('caveStage_ceilingDrips_group');
      if (!dripGroup) {
        return { ok: false, reason: 'caveStage_ceilingDrips_group missing', poolSize };
      }
      const dripInst = dripGroup.getObjectByName('caveStage_ceilingDrips');
      if (!dripInst) {
        return { ok: false, reason: 'ceilingDrips InstancedMesh missing', poolSize };
      }
      const dripBloom = dripInst.layers && typeof dripInst.layers.mask === 'number'
        ? (dripInst.layers.mask & (1 << 1)) !== 0
        : false;
      if (!dripBloom) {
        return { ok: false, reason: 'ceilingDrips InstancedMesh not bloom-tagged', poolSize };
      }
      const dripMat = dripInst.material;
      if (!dripMat || dripMat.blending !== 2) {
        // THREE.AdditiveBlending === 2. Verify the additive recipe survived.
        return { ok: false, reason: 'ceilingDrips material blending=' + (dripMat && dripMat.blending) + ' (expected 2 / AdditiveBlending)', poolSize };
      }
      // Slot-3 color sanity (CAVE_PALETTE.moss = 0x7fffe4)
      const colHex = (dripMat.color && dripMat.color.getHex) ? dripMat.color.getHex() : -1;
      if (colHex !== 0x7fffe4) {
        return { ok: false, reason: 'ceilingDrips color=0x' + colHex.toString(16) + ' (expected 0x7fffe4)', poolSize };
      }
      // (c) Total-spawned counter via module accessor
      let totalSpawned = -1;
      try {
        const mod = await import('./src/stages/cave/caveCeilingDrips.js');
        if (mod && typeof mod.tickCeilingDrips === 'function') mod.tickCeilingDrips(2.2);
        if (mod && typeof mod.getCeilingDripTotalSpawned === 'function') {
          totalSpawned = mod.getCeilingDripTotalSpawned() | 0;
        }
      } catch (e) {
        return { ok: false, reason: 'caveCeilingDrips import failed: ' + (e && e.message), poolSize };
      }
      if (totalSpawned < 1) {
        return { ok: false, reason: 'totalSpawned=' + totalSpawned + ' (expected >=1 after 2.2s settle)', poolSize };
      }
      return {
        ok: true,
        reason: 'dripPoolSize=' + poolSize + ', bloom=' + dripBloom
              + ', additive blending + slot-3 color, totalSpawned=' + totalSpawned,
        poolSize, totalSpawned,
      };
    });
    console.log('phase 5 (ceiling drips): ' + (p5.ok ? 'PASS' : 'FAIL') + ' — ' + p5.reason);

    // ── Phase 6 (P4A cohort 5) — Gloomshrimp neutrals ────────────────────
    // Four assertions:
    //   (a) caveStage.userData.gloomshrimpCount >= 10 — guards against the
    //       buildGloomshrimp builder silently no-op'ing. Cohort 5 spawns 12.
    //   (b) InstancedMesh `caveStage_gloomshrimp` mounted under
    //       `caveStage_gloomshrimpGroup` and bloom-tagged (slot-3 emissive
    //       pops under the same chrome as cohort-2/3/4).
    //   (c) Material emissive is slot-3 moss (0x7fffe4).
    //   (d) Instance 0's translation changes across a 700ms gap — proves
    //       tickGloomshrimp is actually wired into the frame loop (the whole
    //       tickCave → tickGloomshrimp chain), not just built once.
    const p6before = await page.evaluate(async () => {
      const mod = await import('./src/stages/cave/caveGloomshrimp.js');
      if (mod && typeof mod.tickGloomshrimp === 'function') mod.tickGloomshrimp(0.1);
      const s = window.kkState;
      const cg = s && s.scene && s.scene.getObjectByName('caveStage');
      const g = cg && cg.getObjectByName('caveStage_gloomshrimpGroup');
      const inst = g && g.getObjectByName('caveStage_gloomshrimp');
      if (!inst) return null;
      const a = inst.instanceMatrix.array;
      return { x: a[12], y: a[13], z: a[14] };
    });
    await new Promise((r) => setTimeout(r, 700));   // let the school drift
    const p6 = await page.evaluate(async (before) => {
      const mod = await import('./src/stages/cave/caveGloomshrimp.js');
      if (mod && typeof mod.tickGloomshrimp === 'function') mod.tickGloomshrimp(0.7);
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      const n = (cg.userData && cg.userData.gloomshrimpCount) | 0;
      if (n < 10) return { ok: false, reason: 'gloomshrimpCount=' + n + ' (expected >=10)' };
      const g = cg.getObjectByName('caveStage_gloomshrimpGroup');
      if (!g) return { ok: false, reason: 'caveStage_gloomshrimpGroup missing', count: n };
      const inst = g.getObjectByName('caveStage_gloomshrimp');
      if (!inst) return { ok: false, reason: 'gloomshrimp InstancedMesh missing', count: n };
      const bloom = inst.layers && typeof inst.layers.mask === 'number'
        ? (inst.layers.mask & (1 << 1)) !== 0
        : false;
      if (!bloom) return { ok: false, reason: 'gloomshrimp InstancedMesh not bloom-tagged', count: n };
      const mat = inst.material;
      const emHex = (mat && mat.emissive && mat.emissive.getHex) ? mat.emissive.getHex() : -1;
      if (emHex !== 0x7fffe4) {
        return { ok: false, reason: 'gloomshrimp emissive=0x' + emHex.toString(16) + ' (expected 0x7fffe4 slot-3 moss)', count: n };
      }
      let moved = -1;
      if (before) {
        const a = inst.instanceMatrix.array;
        const dx = a[12] - before.x, dy = a[13] - before.y, dz = a[14] - before.z;
        moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      if (!(moved > 0.02)) {
        return { ok: false, reason: 'instance 0 did not move (moved=' + moved + ') — tickGloomshrimp not running', count: n };
      }
      return {
        ok: true,
        reason: 'gloomshrimpCount=' + n + ', bloom=' + bloom
              + ', slot-3 emissive, moved=' + moved.toFixed(3) + 'u/0.7s',
        count: n, moved,
      };
    }, p6before);
    console.log('phase 6 (gloomshrimp): ' + (p6.ok ? 'PASS' : 'FAIL') + ' — ' + p6.reason);

    // ── Phase 7 (P4A cohort 6) — Cave achievements ───────────────────────
    // Three assertions:
    //   (a) All 5 cave_* defs are registered into the shared achievement
    //       registry (window.__kkAchievements.list() — exposed by
    //       forestAchievements.js) — proves loadCaveAchievements ran.
    //   (b) isUnlocked('cave_enter') === true — proves tickCaveAchievements
    //       is frame-wired through tickCave on the live cave run (the whole
    //       chain), not just registered.
    //   (c) Funnel + per-run idempotency: unlocking a not-yet-fired id
    //       (cave_clear) returns a def the first time + reads back unlocked,
    //       and a second unlock in the same run is a no-op (null).
    const p7 = await page.evaluate(async () => {
      const mod = await import('./src/caveAchievements.js');
      if (mod && typeof mod.tickCaveAchievements === 'function') mod.tickCaveAchievements();
      const A = window.__kkAchievements;
      if (!A || typeof A.list !== 'function') {
        return { ok: false, reason: 'window.__kkAchievements probe missing' };
      }
      const ids = new Set(A.list().map((d) => d.id));
      const want = ['cave_enter', 'cave_gloomshrimp', 'cave_time_10min', 'cave_clear', 'cave_flawless_3min'];
      const missing = want.filter((id) => !ids.has(id));
      if (missing.length) {
        return { ok: false, reason: 'cave defs not registered: ' + missing.join(',') };
      }
      // (b) frame-wired unlock
      if (!A.isUnlocked('cave_enter')) {
        return { ok: false, reason: 'cave_enter not unlocked — tickCaveAchievements not frame-wired' };
      }
      // (c) funnel + idempotency on a fresh id
      const first = A.unlock('cave_clear');
      const unlockedAfter = A.isUnlocked('cave_clear');
      const second = A.unlock('cave_clear');
      if (!first) return { ok: false, reason: 'unlock(cave_clear) returned falsy on first call' };
      if (!unlockedAfter) return { ok: false, reason: 'cave_clear not marked unlocked after unlock()' };
      if (second) return { ok: false, reason: 'unlock(cave_clear) re-fired in same run (expected null) — dedup broken' };
      return {
        ok: true,
        reason: 'registered ' + want.length + ' cave defs, cave_enter auto-unlocked, funnel idempotent',
      };
    });
    console.log('phase 7 (cave achievements): ' + (p7.ok ? 'PASS' : 'FAIL') + ' — ' + p7.reason);

    // ── Phase 8 (P4A cohort 7) — Gloomsigil cave-gated weapon ────────────
    // Stage-gate is the key regression risk: a cave weapon must NOT leak into
    // forest/twilight/cinder/void level-up offers. We test the gate directly
    // by flipping state.run.stage and draining the offer pool (weaponChoices
    // with a large n returns all eligible weapon cards before fillers):
    //   (a) REGISTRY.gloomsigil exists with stages: ['cave'].
    //   (b) On a forest stage, gloomsigil is filtered OUT of the offers.
    //   (c) On the cave stage, gloomsigil IS offered.
    //   (d) descriptions.js has a gloomsigil entry (static-source check).
    const p8 = await page.evaluate(async () => {
      let mod;
      try { mod = await import('./src/weapons/index.js'); }
      catch (e) { return { ok: false, reason: 'weapons/index import failed: ' + (e && e.message) }; }
      const REG = mod.REGISTRY;
      if (!REG || !REG.gloomsigil) return { ok: false, reason: 'gloomsigil not in REGISTRY' };
      const stages = REG.gloomsigil.stages;
      if (!Array.isArray(stages) || !stages.includes('cave') || stages.length !== 1) {
        return { ok: false, reason: 'gloomsigil.stages != ["cave"] (got ' + JSON.stringify(stages) + ')' };
      }
      const s = window.kkState;
      if (!s || !s.run) return { ok: false, reason: 'kkState.run missing' };
      if (typeof mod.weaponChoices !== 'function') return { ok: false, reason: 'weaponChoices not exported' };
      const bak = s.run.stage;
      let forestN = -1, caveN = -1;
      try {
        s.run.stage = { id: 'forest' };
        forestN = mod.weaponChoices(50).filter((c) => c && c.id === 'gloomsigil').length;
        s.run.stage = { id: 'cave' };
        caveN = mod.weaponChoices(50).filter((c) => c && c.id === 'gloomsigil').length;
      } finally {
        s.run.stage = bak;
      }
      if (forestN !== 0) return { ok: false, reason: 'gloomsigil leaked into forest offers (n=' + forestN + ')' };
      if (caveN < 1) return { ok: false, reason: 'gloomsigil not offered on cave (n=' + caveN + ')' };
      return { ok: true, reason: 'stages=[cave], forest offers=0, cave offers=' + caveN };
    });
    console.log('phase 8 (gloomsigil gate): ' + (p8.ok ? 'PASS' : 'FAIL') + ' — ' + p8.reason);

    // ── Phase 9 (P4A cohort 8) — Echo Bolt cave-gated weapon ─────────────
    // Same stage-gate regression test as phase 8, for the 2nd cave weapon.
    // Closes the "2 cave weapons" acceptance item. Asserts REGISTRY presence,
    // stages==['cave'], forest offers=0 (no leak), cave offers>=1.
    const p9 = await page.evaluate(async () => {
      let mod;
      try { mod = await import('./src/weapons/index.js'); }
      catch (e) { return { ok: false, reason: 'weapons/index import failed: ' + (e && e.message) }; }
      const REG = mod.REGISTRY;
      if (!REG || !REG.echobolt) return { ok: false, reason: 'echobolt not in REGISTRY' };
      const stages = REG.echobolt.stages;
      if (!Array.isArray(stages) || !stages.includes('cave') || stages.length !== 1) {
        return { ok: false, reason: 'echobolt.stages != ["cave"] (got ' + JSON.stringify(stages) + ')' };
      }
      const s = window.kkState;
      if (!s || !s.run) return { ok: false, reason: 'kkState.run missing' };
      const bak = s.run.stage;
      let forestN = -1, caveN = -1;
      try {
        s.run.stage = { id: 'forest' };
        forestN = mod.weaponChoices(50).filter((c) => c && c.id === 'echobolt').length;
        s.run.stage = { id: 'cave' };
        caveN = mod.weaponChoices(50).filter((c) => c && c.id === 'echobolt').length;
      } finally {
        s.run.stage = bak;
      }
      if (forestN !== 0) return { ok: false, reason: 'echobolt leaked into forest offers (n=' + forestN + ')' };
      if (caveN < 1) return { ok: false, reason: 'echobolt not offered on cave (n=' + caveN + ')' };
      return { ok: true, reason: 'stages=[cave], forest offers=0, cave offers=' + caveN };
    });
    console.log('phase 9 (echobolt gate): ' + (p9.ok ? 'PASS' : 'FAIL') + ' — ' + p9.reason);

    // ── Phase 10 (P4A cohort 9) — Perimeter stalagmite formations ─────────
    // Five assertions:
    //   (a) caveStage.userData.stalagmiteCount >= 24 — guards the builder
    //       silently no-op'ing. Cohort 9 author-places 8×4 = 32.
    //   (b) InstancedMesh `caveStage_stalagmites` mounted under its group.
    //   (c) Material is STONE-TEXTURED: map + normalMap both truthy. This is
    //       the "stone wall textures" acceptance proof (not flat placeholder).
    //   (d) Material color === CAVE_PALETTE.stone (0x4a4a52). The diffuse PNG
    //       is palette-locked grayscale; default-white would render a gray
    //       photograph instead of wet stone (silent ugly-fail per advisor).
    //   (e) Placement invariants from the instance matrices: every instance
    //       sits at r >= 27 (clear of the r<=26 decor footprint → perimeter)
    //       AND its center-Y stays low enough that the tip (≈2×centerY) clears
    //       the iso sightline (occlusion guard: centerY <= 3.0 → tip <= ~6).
    const p10 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      const n = (cg.userData && cg.userData.stalagmiteCount) | 0;
      if (n < 24) return { ok: false, reason: 'stalagmiteCount=' + n + ' (expected >=24)' };
      const grp = cg.getObjectByName('caveStage_stalagmites_grp');
      if (!grp) return { ok: false, reason: 'caveStage_stalagmites_grp missing', count: n };
      const inst = grp.getObjectByName('caveStage_stalagmites');
      if (!inst) return { ok: false, reason: 'stalagmites InstancedMesh missing', count: n };
      const mat = inst.material;
      if (!mat || !mat.map || !mat.normalMap) {
        return { ok: false, reason: 'stalagmite material not stone-textured (map/normalMap missing)', count: n };
      }
      const colHex = (mat.color && mat.color.getHex) ? mat.color.getHex() : -1;
      if (colHex !== 0x4a4a52) {
        return { ok: false, reason: 'stalagmite color=0x' + colHex.toString(16) + ' (expected 0x4a4a52 slot-2 stone)', count: n };
      }
      // Placement invariants from the instance matrices (translation = last col).
      const a = inst.instanceMatrix.array;
      let minR = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const off = i * 16;
        const x = a[off + 12], y = a[off + 13], z = a[off + 14];
        const r = Math.sqrt(x * x + z * z);
        if (r < minR) minR = r;
        if (y > maxY) maxY = y;
      }
      if (!(minR >= 27)) {
        return { ok: false, reason: 'a stalagmite is inside the decor footprint (minR=' + minR.toFixed(1) + ', expected >=27)', count: n };
      }
      if (!(maxY <= 3.0)) {
        return { ok: false, reason: 'stalagmite too tall (maxCenterY=' + maxY.toFixed(2) + ' → tip>~6, occlusion risk)', count: n };
      }
      return {
        ok: true,
        reason: 'stalagmiteCount=' + n + ', stone-textured (map+normalMap), color=0x4a4a52, minR='
              + minR.toFixed(1) + ', maxCenterY=' + maxY.toFixed(2),
        count: n, minR, maxY,
      };
    });
    console.log('phase 10 (stalagmites): ' + (p10.ok ? 'PASS' : 'FAIL') + ' — ' + p10.reason);

    // ── Phase 11 (P4A cohort 10) — Perimeter glowmoss mushrooms ───────────
    // Six assertions (the perimeter + no-slot-3-leak ones are the pickup-
    // confusion guards — see caveMushrooms.js header):
    //   (a) caveStage.userData.mushroomCount >= 24 — guards a no-op builder.
    //   (b) Both InstancedMeshes mounted (stalks + caps).
    //   (c) Stalk material color === CAVE_PALETTE.stone (0x4a4a52) — NO slot-3
    //       leak into the stalk; the silhouette is what disambiguates a
    //       mushroom from a glowing pickup.
    //   (d) Cap emissive === slot-3 moss (0x7fffe4) + cap bloom-tagged.
    //   (e) Every instance r >= 27 (perimeter — if this ever fails a tweak has
    //       put emissive flora back in the pickup band).
    //   (f) Cap center-Y <= 0.9 (undergrowth, not a competing silhouette).
    const p11 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      const n = (cg.userData && cg.userData.mushroomCount) | 0;
      if (n < 24) return { ok: false, reason: 'mushroomCount=' + n + ' (expected >=24)' };
      const grp = cg.getObjectByName('caveStage_mushrooms_grp');
      if (!grp) return { ok: false, reason: 'caveStage_mushrooms_grp missing', count: n };
      const stalk = grp.getObjectByName('caveStage_mushroomStalks');
      const cap   = grp.getObjectByName('caveStage_mushroomCaps');
      if (!stalk || !cap) return { ok: false, reason: 'mushroom stalk/cap InstancedMesh missing', count: n };
      // (c) Stalk is slot-2 stone, NOT slot-3 (no pickup-glow leak).
      const stalkHex = (stalk.material && stalk.material.color && stalk.material.color.getHex)
        ? stalk.material.color.getHex() : -1;
      if (stalkHex !== 0x4a4a52) {
        return { ok: false, reason: 'stalk color=0x' + stalkHex.toString(16) + ' (expected 0x4a4a52 slot-2 stone, no slot-3 leak)', count: n };
      }
      // (d) Cap emissive slot-3 + bloom.
      const capEm = (cap.material && cap.material.emissive && cap.material.emissive.getHex)
        ? cap.material.emissive.getHex() : -1;
      if (capEm !== 0x7fffe4) {
        return { ok: false, reason: 'cap emissive=0x' + capEm.toString(16) + ' (expected 0x7fffe4 slot-3 moss)', count: n };
      }
      const capBloom = cap.layers && typeof cap.layers.mask === 'number'
        ? (cap.layers.mask & (1 << 1)) !== 0 : false;
      if (!capBloom) return { ok: false, reason: 'mushroom caps not bloom-tagged', count: n };
      // (e) + (f) Placement invariants from the stalk + cap matrices.
      const sa = stalk.instanceMatrix.array;
      const ca = cap.instanceMatrix.array;
      let minR = Infinity, maxCapY = -Infinity;
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        const r = Math.sqrt(sa[o + 12] * sa[o + 12] + sa[o + 14] * sa[o + 14]);
        if (r < minR) minR = r;
        if (ca[o + 13] > maxCapY) maxCapY = ca[o + 13];
      }
      if (!(minR >= 27)) {
        return { ok: false, reason: 'a mushroom is inside the pickup band (minR=' + minR.toFixed(1) + ', expected >=27)', count: n };
      }
      if (!(maxCapY <= 0.9)) {
        return { ok: false, reason: 'mushroom cap too tall (maxCapY=' + maxCapY.toFixed(2) + ', expected <=0.9 undergrowth)', count: n };
      }
      return {
        ok: true,
        reason: 'mushroomCount=' + n + ', stalk slot-2 / cap slot-3+bloom, minR='
              + minR.toFixed(1) + ', maxCapY=' + maxCapY.toFixed(2),
        count: n, minR, maxCapY,
      };
    });
    console.log('phase 11 (mushrooms): ' + (p11.ok ? 'PASS' : 'FAIL') + ' — ' + p11.reason);

    // ── Phase 12 — Asset-backed vault precinct, no permanent fake tell ───
    const p12 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      if (cg.getObjectByName('caveStage_sigilFloor')) {
        return { ok: false, reason: 'permanent center sigil should be absent' };
      }
      const landscape = cg.getObjectByName('__stageLandscape_cave');
      if (!landscape) return { ok: false, reason: 'cave landscape missing' };
      const arch = landscape.getObjectByName('caveStage_vaultArch');
      const rubble = landscape.getObjectByName('caveStage_vaultRubble');
      const path = landscape.getObjectByName('caveStage_vaultPath');
      if (!arch || !arch.isInstancedMesh || arch.count < 1) return { ok: false, reason: 'asset-backed vault arch missing' };
      if (!rubble || !rubble.isInstancedMesh || rubble.count < 6) return { ok: false, reason: 'instanced vault rubble missing' };
      if (!path || !path.material || !path.material.map) return { ok: false, reason: 'textured vault route missing' };
      const counts = landscape.userData && landscape.userData.counts;
      if (!counts || counts.arches < 1 || counts.rubble < 6 || counts.steppingStones < 4) {
        return { ok: false, reason: 'landscape count metadata incomplete: ' + JSON.stringify(counts) };
      }
      return { ok: true, reason: 'instanced arch/rubble + textured vault route + stepping-stone crossing; center sigil absent' };
    });
    console.log('phase 12 (vault precinct): ' + (p12.ok ? 'PASS' : 'FAIL') + ' — ' + p12.reason);

    // ── Phase 13 (CC7) — Cave visual self-check ───────────────────────────
    // The cave's first RENDER-level gate (cohorts 1-12 were object-probe only,
    // so every texture-scale / occlusion / palette call shipped blind). Two
    // checks:
    //   (a) Force one render to the canvas back buffer + readPixels a small
    //       center cross → assert the cave is NOT a black/empty frame
    //       (maxLum > 2). readPixels-after-our-own-render reads the back buffer
    //       in the SAME task, so it's valid regardless of preserveDrawingBuffer;
    //       it bypasses the bloom composer, but the raw scene is exactly what
    //       proves geometry actually rasterized. The authored stone ground and
    //       vault route make a real render clear this, while an empty frame is 0.
    //   (b) Save a viewport screenshot (_thumb_cave_visual.png) so a human can
    //       eyeball the cave without launching, + a non-trivial byte-size floor
    //       so a totally failed capture fails. NOT a perf/brightness gate
    //       (headless swiftshader can't be held to either).
    const caveShot = path.join(__dirname, '_thumb_cave_visual.png');
    await page.screenshot({ path: caveShot, fullPage: false });
    const caveShotBytes = (() => { try { return fs.statSync(caveShot).size; } catch (_) { return -1; } })();
    const pv = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.renderer || !s.scene || !s.camera) {
        return { ok: false, reason: 'renderer/scene/camera missing on kkState' };
      }
      const r = s.renderer;
      try { r.setRenderTarget(null); r.render(s.scene, s.camera); }
      catch (e) { return { ok: false, reason: 'render threw: ' + (e && e.message) }; }
      let gl;
      try { gl = r.getContext(); } catch (_) { return { ok: false, reason: 'getContext threw' }; }
      const cv = r.domElement;
      const w = cv.width | 0, h = cv.height | 0;
      if (w < 2 || h < 2) return { ok: false, reason: 'canvas too small ' + w + 'x' + h };
      const pts = [[0.5, 0.5], [0.42, 0.5], [0.58, 0.5], [0.5, 0.42], [0.5, 0.58]];
      const buf = new Uint8Array(4);
      let maxLum = 0;
      for (const [fx, fy] of pts) {
        const x = Math.min(w - 1, Math.max(0, Math.floor(w * fx)));
        const y = Math.min(h - 1, Math.max(0, Math.floor(h * fy)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const lum = 0.2126 * buf[0] + 0.7152 * buf[1] + 0.0722 * buf[2];
        if (lum > maxLum) maxLum = lum;
      }
      return { ok: true, maxLum, w, h };
    });
    let p13Pass, p13Reason;
    if (!pv.ok) { p13Pass = false; p13Reason = pv.reason; }
    else if (!(pv.maxLum > 2)) { p13Pass = false; p13Reason = 'center render is black (maxLum=' + pv.maxLum.toFixed(1) + ') — empty/failed cave render'; }
    else if (!(caveShotBytes > 8000)) { p13Pass = false; p13Reason = 'screenshot too small (' + caveShotBytes + 'B) — capture failed'; }
    else { p13Pass = true; p13Reason = 'cave renders (center maxLum=' + pv.maxLum.toFixed(1) + ', shot=' + caveShotBytes + 'B @ ' + pv.w + 'x' + pv.h + ')'; }
    console.log('phase 13 (cave visual): ' + (p13Pass ? 'PASS' : 'FAIL') + ' — ' + p13Reason);
    console.log('  cave screenshot: ' + caveShot + ' (' + caveShotBytes + 'B)');

    // ── Phase 14 (P4A cohort 12) — Cave ceiling / sky-dome ────────────────
    // Backdrop dome (mirrors forestSkyDome) — occlusion-safe by construction:
    //   (a) userData.skyDome true (builder ran).
    //   (b) mesh mounted, side = BackSide (1), renderOrder -100, depthWrite off
    //       — the recipe that makes it a non-occluding backdrop.
    //   (c) large sphere (radius >= 100) wrapping the arena.
    //   (d) palette-pure gradient uniforms: uLo = shadow (0x1a1820, fog-matched
    //       horizon), uHi = stone (0x4a4a52, vault).
    // The CC7 render gate (phase 13 above) already re-confirmed the cave still
    // renders non-black WITH this dome present (maxLum check).
    const p14 = await page.evaluate(() => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      if (!(cg.userData && cg.userData.skyDome)) {
        return { ok: false, reason: 'userData.skyDome falsy — builder no-op' };
      }
      const grp = cg.getObjectByName('caveStage_skyDome_grp');
      if (!grp) return { ok: false, reason: 'caveStage_skyDome_grp missing' };
      const mesh = grp.getObjectByName('caveStage_skyDome');
      if (!mesh) return { ok: false, reason: 'skyDome mesh missing' };
      // BackSide === 1; the backdrop recipe.
      if (mesh.material.side !== 1) {
        return { ok: false, reason: 'dome side=' + mesh.material.side + ' (expected 1 / BackSide)' };
      }
      if (mesh.renderOrder !== -100) {
        return { ok: false, reason: 'dome renderOrder=' + mesh.renderOrder + ' (expected -100 backdrop)' };
      }
      if (mesh.material.depthWrite !== false) {
        return { ok: false, reason: 'dome depthWrite not false (would occlude)' };
      }
      const rad = mesh.geometry && mesh.geometry.parameters && mesh.geometry.parameters.radius;
      if (!(rad >= 100)) {
        return { ok: false, reason: 'dome radius=' + rad + ' (expected >=100 to wrap arena)' };
      }
      // Palette-pure gradient uniforms.
      const u = mesh.material.uniforms || {};
      const lo = u.uLo && u.uLo.value && u.uLo.value.getHex ? u.uLo.value.getHex() : -1;
      const hi = u.uHi && u.uHi.value && u.uHi.value.getHex ? u.uHi.value.getHex() : -1;
      if (lo !== 0x1a1820) return { ok: false, reason: 'dome uLo=0x' + lo.toString(16) + ' (expected 0x1a1820 shadow/fog)' };
      if (hi !== 0x4a4a52) return { ok: false, reason: 'dome uHi=0x' + hi.toString(16) + ' (expected 0x4a4a52 stone vault)' };
      return { ok: true, reason: 'dome BackSide + renderOrder -100 + depthWrite off, r=' + rad + ', gradient shadow→stone' };
    });
    console.log('phase 14 (sky dome): ' + (p14.ok ? 'PASS' : 'FAIL') + ' — ' + p14.reason);

    // ── Phase 15 (P4A cohort 13) — Cave-in environmental hazard ───────────
    // The cave's signature telegraphed threat. Four assertions:
    //   (a) caveStage.userData.caveHazardCount >= 1 — builder pooled the rings.
    //   (b) a hazardRing mesh exists, uses a CanvasTexture map (rune art — NOT
    //       a bare RingGeometry), tinted slot-4 sigil (0xc87bff), pinned to the
    //       telegraph floor tier (renderOrder -3) and bloom-tagged. This is the
    //       FX-quality-bar guard: a flat RingGeometry+MeshBasicMaterial would
    //       have no .map and would fail here.
    //   (c) The dispatcher fires when its clock passes the first-fire threshold.
    //       Headless swiftshader runs ~4fps with clamped dt, so game-clock
    //       crawls and a wall-clock settle can't reach FIRST_DELAY — so we drive
    //       the dispatcher deterministically: import the module + call
    //       tickCaveHazard with a big dt (pushes _clock past threshold, hero is
    //       live in the run) and assert getCaveHazardTotalSpawned() >= 1.
    //       Counter-based (not catching a boulder mid-air) per the cohort-4
    //       drip-probe precedent. Real players at 30-60fps hit it in ~4s.
    const p15 = await page.evaluate(async () => {
      const s = window.kkState;
      if (!s || !s.scene) return { ok: false, reason: 'kkState/scene missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      const cnt = (cg.userData && cg.userData.caveHazardCount) | 0;
      if (cnt < 1) return { ok: false, reason: 'caveHazardCount=' + cnt + ' (expected >=1) — builder no-op' };
      const ring = cg.getObjectByName('caveStage_hazardRing');
      if (!ring) return { ok: false, reason: 'caveStage_hazardRing missing', cnt };
      const mat = ring.material;
      if (!mat || !mat.map || !mat.map.isTexture) {
        return { ok: false, reason: 'hazard ring has no CanvasTexture map (flat-ring anti-pattern?)', cnt };
      }
      const col = (mat.color && mat.color.getHex) ? mat.color.getHex() : -1;
      if (col !== 0xc87bff) return { ok: false, reason: 'hazard ring color=0x' + col.toString(16) + ' (expected 0xc87bff sigil)', cnt };
      if (ring.renderOrder !== -3) return { ok: false, reason: 'hazard ring renderOrder=' + ring.renderOrder + ' (expected -3 telegraph tier)', cnt };
      const bloom = ring.layers && typeof ring.layers.mask === 'number' ? (ring.layers.mask & (1 << 1)) !== 0 : false;
      if (!bloom) return { ok: false, reason: 'hazard ring not bloom-tagged', cnt };
      let total = -1;
      try {
        const mod = await import('./src/stages/cave/caveHazard.js');
        // Drive the dispatcher past FIRST_DELAY deterministically (headless fps
        // can't accumulate it in a settle). The hero is live in the run, so the
        // dispatcher arms a cave-in volley → totalSpawned increments.
        if (mod && typeof mod.tickCaveHazard === 'function') mod.tickCaveHazard(6);
        if (mod && typeof mod.getCaveHazardTotalSpawned === 'function') total = mod.getCaveHazardTotalSpawned() | 0;
      } catch (e) {
        return { ok: false, reason: 'caveHazard import failed: ' + (e && e.message), cnt };
      }
      if (total < 1) return { ok: false, reason: 'totalSpawned=' + total + ' (dispatcher did not arm — hero dead or no free slot?)', cnt };
      return { ok: true, reason: 'caveHazardCount=' + cnt + ', rune-tex sigil ring, renderOrder -3 + bloom, totalSpawned=' + total };
    });
    console.log('phase 15 (cave-in hazard): ' + (p15.ok ? 'PASS' : 'FAIL') + ' — ' + p15.reason);

    // ── Phase 16 (P4A cohort 14) — Cave boss identity (names) ─────────────
    // The cave reuses forest telegraph mechanics but announces its own named
    // wardens. Assert (in the live cave run):
    //   (a) CAVE_MINI_BOSS_NAMES has 3 entries + CAVE_FINAL_BOSS_NAME exists.
    //   (b) nameForMiniBoss(0) returns the CAVE name (stage-aware resolver fired
    //       on the cave run) AND it differs from the forest MINI_BOSS_NAMES[0]
    //       — proves the gate switched and there's no identity overlap.
    //   (c) nameForFinalBoss() returns CAVE_FINAL_BOSS_NAME, distinct from the
    //       forest FINAL_BOSS_NAME (THE NIGHTMARE).
    const p16 = await page.evaluate(async () => {
      const s = window.kkState;
      if (!s || !s.run || !s.run.stage || s.run.stage.id !== 'cave') {
        return { ok: false, reason: 'not on cave run (stage=' + (s && s.run && s.run.stage && s.run.stage.id) + ')' };
      }
      let mod;
      try { mod = await import('./src/bossTelegraphs.js'); }
      catch (e) { return { ok: false, reason: 'bossTelegraphs import failed: ' + (e && e.message) }; }
      const caveMini = mod.CAVE_MINI_BOSS_NAMES;
      const caveFinal = mod.CAVE_FINAL_BOSS_NAME;
      if (!Array.isArray(caveMini) || caveMini.length < 3) {
        return { ok: false, reason: 'CAVE_MINI_BOSS_NAMES length=' + (caveMini && caveMini.length) + ' (expected >=3)' };
      }
      if (!caveFinal || !caveFinal.name) return { ok: false, reason: 'CAVE_FINAL_BOSS_NAME missing' };
      if (typeof mod.nameForMiniBoss !== 'function' || typeof mod.nameForFinalBoss !== 'function') {
        return { ok: false, reason: 'name accessors missing' };
      }
      const mini0 = mod.nameForMiniBoss(0);
      const forestMini0 = mod.MINI_BOSS_NAMES[0];
      if (!mini0 || mini0.name !== caveMini[0].name) {
        return { ok: false, reason: 'nameForMiniBoss(0)=' + (mini0 && mini0.name) + ' (expected cave ' + caveMini[0].name + ' — stage gate not firing)' };
      }
      if (mini0.name === forestMini0.name) {
        return { ok: false, reason: 'cave miniboss name === forest name (no identity separation)' };
      }
      const fin = mod.nameForFinalBoss();
      if (!fin || fin.name !== caveFinal.name) {
        return { ok: false, reason: 'nameForFinalBoss()=' + (fin && fin.name) + ' (expected ' + caveFinal.name + ')' };
      }
      if (fin.name === mod.FINAL_BOSS_NAME.name) {
        return { ok: false, reason: 'cave final name === forest final (THE NIGHTMARE) — gate not firing' };
      }
      return { ok: true, reason: 'cave bosses: ' + caveMini[0].name + ' / ' + caveMini[1].name + ' / ' + caveMini[2].name + ' + ' + caveFinal.name + ' (distinct from forest)' };
    });
    console.log('phase 16 (cave boss names): ' + (p16.ok ? 'PASS' : 'FAIL') + ' — ' + p16.reason);

    // ── Phase 17 (P4A cohort 15) — Cave sealed vault ──────────────────────
    // The cave's "sealed door" beat. Assert:
    //   (a) caveStage.userData.caveVault true (builder ran).
    //   (b) the door mesh is stone-textured (map+normalMap) + slot-2 color, and
    //       the seal is rune-textured (CanvasTexture map) + slot-4 sigil + bloom
    //       (FX guard: a flat untextured ring would have no map and fail).
    //   (c) it OPENS on the clear condition: drive kills past OPEN_KILLS + tick
    //       the module → getCaveVaultState() reports opened + rewardDropped.
    const p17 = await page.evaluate(async () => {
      const s = window.kkState;
      if (!s || !s.scene || !s.run) return { ok: false, reason: 'kkState/scene/run missing' };
      const cg = s.scene.getObjectByName('caveStage');
      if (!cg) return { ok: false, reason: 'caveStage group missing' };
      if (!(cg.userData && cg.userData.caveVault)) return { ok: false, reason: 'userData.caveVault falsy — builder no-op' };
      const door = cg.getObjectByName('caveStage_vaultDoor');
      if (!door) return { ok: false, reason: 'vault door mesh missing' };
      const dm = door.material;
      if (!dm || !dm.map || !dm.normalMap) return { ok: false, reason: 'vault door not stone-textured (map+normalMap)' };
      const dcol = (dm.color && dm.color.getHex) ? dm.color.getHex() : -1;
      if (dcol !== 0x4a4a52) return { ok: false, reason: 'vault door color=0x' + dcol.toString(16) + ' (expected 0x4a4a52 stone)' };
      const seal = cg.getObjectByName('caveStage_vaultSeal');
      if (!seal) return { ok: false, reason: 'vault seal mesh missing' };
      const sm = seal.material;
      if (!sm || !sm.map || !sm.map.isTexture) return { ok: false, reason: 'vault seal has no rune CanvasTexture map (flat-ring anti-pattern?)' };
      const scol = (sm.color && sm.color.getHex) ? sm.color.getHex() : -1;
      if (scol !== 0xc87bff) return { ok: false, reason: 'vault seal color=0x' + scol.toString(16) + ' (expected 0xc87bff sigil)' };
      const sbloom = seal.layers && typeof seal.layers.mask === 'number' ? (seal.layers.mask & (1 << 1)) !== 0 : false;
      if (!sbloom) return { ok: false, reason: 'vault seal not bloom-tagged' };
      // (c) Drive the open condition deterministically.
      let st = null;
      try {
        const mod = await import('./src/stages/cave/caveVault.js');
        s.run.kills = 999;                          // horde "cleared"
        if (typeof mod.tickCaveVault === 'function') { mod.tickCaveVault(0.1); mod.tickCaveVault(2.0); }
        if (typeof mod.getCaveVaultState === 'function') st = mod.getCaveVaultState();
      } catch (e) {
        return { ok: false, reason: 'caveVault import/drive failed: ' + (e && e.message) };
      }
      if (!st || !st.opened) return { ok: false, reason: 'vault did not open at kills>=OPEN_KILLS (state=' + JSON.stringify(st) + ')' };
      if (!st.rewardDropped) return { ok: false, reason: 'vault opened but reward not dropped (state=' + JSON.stringify(st) + ')' };
      return { ok: true, reason: 'stone-textured door + rune sigil seal (bloom), opens at kills>=80 + reward dropped' };
    });
    console.log('phase 17 (cave sealed vault): ' + (p17.ok ? 'PASS' : 'FAIL') + ' — ' + p17.reason);

    // ── Summary ───────────────────────────────────────────────────────────
    const runtimeSec = ((Date.now() - t0) / 1000).toFixed(1);

    console.log('\n========== SMOKE SUMMARY ==========');
    console.log('phase 1 (skeleton):              ' + (p1Pass ? 'PASS' : 'FAIL'));
    console.log('phase 2 (stalactites):           ' + (p2.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 3 (env cave branch):       ' + (p3.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 4 (grotto + ground):        ' + (p4.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 5 (ceiling drips):         ' + (p5.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 6 (gloomshrimp):           ' + (p6.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 7 (cave achievements):     ' + (p7.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 8 (gloomsigil gate):       ' + (p8.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 9 (echobolt gate):         ' + (p9.ok  ? 'PASS' : 'FAIL'));
    console.log('phase 10 (stalagmites):          ' + (p10.ok ? 'PASS' : 'FAIL'));
    console.log('phase 11 (mushrooms):            ' + (p11.ok ? 'PASS' : 'FAIL'));
    console.log('phase 12 (vault precinct):       ' + (p12.ok ? 'PASS' : 'FAIL'));
    console.log('phase 13 (cave visual):          ' + (p13Pass ? 'PASS' : 'FAIL'));
    console.log('phase 14 (sky dome):             ' + (p14.ok ? 'PASS' : 'FAIL'));
    console.log('phase 15 (cave-in hazard):       ' + (p15.ok ? 'PASS' : 'FAIL'));
    console.log('phase 16 (cave boss names):      ' + (p16.ok ? 'PASS' : 'FAIL'));
    console.log('phase 17 (cave sealed vault):    ' + (p17.ok ? 'PASS' : 'FAIL'));
    console.log('runtime: ' + runtimeSec + 's');
    console.log('console.errors:  ' + consoleErrors.length);
    for (const e of consoleErrors) console.log('  - ' + e);
    console.log('pageerrors:      ' + pageErrors.length);
    for (const e of pageErrors) console.log('  - ' + e);

    const hardFail = !p1Pass || !p2.ok || !p3.ok || !p4.ok || !p5.ok || !p6.ok || !p7.ok || !p8.ok || !p9.ok || !p10.ok || !p11.ok || !p12.ok || !p13Pass || !p14.ok || !p15.ok || !p16.ok || !p17.ok || pageErrors.length > 0;
    if (hardFail) {
      console.error('[smoke-cave] FAIL — phases='
                    + (p1Pass?1:0) + (p2.ok?1:0) + (p3.ok?1:0) + (p4.ok?1:0) + (p5.ok?1:0) + (p6.ok?1:0) + (p7.ok?1:0) + (p8.ok?1:0) + (p9.ok?1:0) + (p10.ok?1:0) + (p11.ok?1:0) + (p12.ok?1:0) + (p13Pass?1:0) + (p14.ok?1:0) + (p15.ok?1:0) + (p16.ok?1:0) + (p17.ok?1:0)
                    + ' pageerrors=' + pageErrors.length);
      exitCode = 1;
    } else {
      console.log('[smoke-cave] OK — cohort 15 phases 1..17 passed (cave-in hazard + named bosses + sealed vault)');
      console.log('[smoke-cave] cave combat layer complete — awaiting user feedback for tint/pattern depth');
    }
  } catch (e) {
    console.error('[smoke-cave] EXCEPTION:', e && (e.stack || e.message || e));
    exitCode = exitCode || 1;
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[smoke-cave] FAIL (main):', e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
