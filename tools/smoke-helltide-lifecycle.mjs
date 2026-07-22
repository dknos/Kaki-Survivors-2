#!/usr/bin/env node
/** Helltide queue, owned-visual cleanup, prompt-churn, and projectile-cap smoke. */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8937);
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
function assert(ok, message) { if (!ok) throw new Error(message); }

async function main() {
  if (!fs.existsSync(PLAY_PATH) || !fs.existsSync(CHROME)) throw new Error('Playwright/Chromium cache missing');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.addInitScript(() => {
      localStorage.setItem('kk_helltide_queued', 'true');
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
    });
    await page.goto(`http://127.0.0.1:${PORT}/?smoke=helltide-lifecycle`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => window.kkStartRun && window.kkState, null, { timeout: 90_000 });

    const boot = await page.evaluate(() => ({
      queued: localStorage.getItem('kk_helltide_queued'),
      nextAt: window.kkState.run.helltideNextAt || 0,
    }));
    assert(boot.queued === 'true' && boot.nextAt === 0,
      `boot consumed/rearmed the queued Helltide: ${JSON.stringify(boot)}`);

    await page.evaluate(async () => {
      const meta = await import('./src/meta.js');
      meta.setOption('selectedStage', 'forest');
      meta.setOption('optMusic', false);
      window.kkState.weapons.length = 0;
      await window.kkStartRun();
      window.kkState.hero.hp = window.kkState.hero.hpMax = 1e9;
      window.kkState.hero.iFramesUntil = 1e9;
    });
    await page.waitForFunction(() => window.kkState.mode === 'run', null, { timeout: 90_000 });
    const scheduled = await page.evaluate(() => ({
      queued: localStorage.getItem('kk_helltide_queued'),
      now: window.kkState.time.game,
      nextAt: window.kkState.run.helltideNextAt,
    }));
    const delay = scheduled.nextAt - scheduled.now;
    assert(scheduled.queued === null && delay >= 25 && delay <= 35,
      `queued Helltide was not scheduled at ~30s: ${JSON.stringify(scheduled)}`);

    const spawned = await page.evaluate(async () => {
      const h = await import('./src/helltide.js');
      h.triggerHelltide();
      const s = window.kkState;
      s.run.helltideEmbersBanked = 20;
      h._debugSpawnTorturedGift(s.hero.pos.x + 3.4, s.hero.pos.z);
      const threat = h._debugSpawnHelltideSubevent('threat');
      const altar = h._debugSpawnHelltideSubevent('altar');
      return { threat, altar, count: h.helltideSubeventCount() };
    });
    assert(spawned.count >= 3 && spawned.threat?.visualName === 'helltide:ThreatTell'
      && spawned.altar?.visualName === 'helltide:EmberAltar', `subevent visuals missing: ${JSON.stringify(spawned)}`);
    await page.waitForTimeout(300);

    const promptChurn = await page.evaluate(async () => {
      const prompt = document.getElementById('kk-helltide-gift-prompt');
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(prompt, { attributes: true, childList: true, characterData: true, subtree: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      observer.disconnect();
      return { mutations, visible: getComputedStyle(prompt).display !== 'none', text: prompt.textContent };
    });
    assert(promptChurn.visible && /NEED 30 MORE/.test(promptChurn.text || '') && promptChurn.mutations <= 2,
      `Tortured Gift prompt churned while unchanged: ${JSON.stringify(promptChurn)}`);

    const pausedPrompt = await page.evaluate(async () => {
      window.kkState.time.paused = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const display = getComputedStyle(document.getElementById('kk-helltide-gift-prompt')).display;
      window.kkState.time.paused = false;
      return display;
    });
    assert(pausedPrompt === 'none', `Tortured Gift prompt remained visible under pause UI: ${pausedPrompt}`);

    const cleaned = await page.evaluate(async () => {
      const h = await import('./src/helltide.js');
      h.endHelltide(false);
      return {
        count: h.helltideSubeventCount(),
        gift: !!window.kkState.scene.getObjectByName('helltide:TorturedGift'),
        threat: !!window.kkState.scene.getObjectByName('helltide:ThreatTell'),
        altar: !!window.kkState.scene.getObjectByName('helltide:EmberAltar'),
        prompt: getComputedStyle(document.getElementById('kk-helltide-gift-prompt')).display,
      };
    });
    assert(cleaned.count === 0 && !cleaned.gift && !cleaned.threat && !cleaned.altar && cleaned.prompt === 'none',
      `Helltide teardown leaked owned visuals: ${JSON.stringify(cleaned)}`);

    const pool = await page.evaluate(async () => {
      const auto = await import('./src/weapons/autoAim.js');
      const s = window.kkState;
      for (const p of s.projectiles.active) auto.releaseProjectileVisuals(p);
      s.projectiles.active.length = 0;
      const level = { speed: 0, ttl: 999, pierce: 999 };
      let accepted = 0, rejected = 0;
      for (let i = 0; i < 300; i++) {
        const p = auto.spawnAutoAimProjectile(s.hero.pos, { x: 1, z: 0 }, level, 1);
        if (p) accepted++; else rejected++;
      }
      return {
        accepted, rejected,
        active: s.projectiles.active.length,
        invisible: s.projectiles.active.filter((p) => p._slot == null || p._slot < 0).length,
      };
    });
    assert(pool.accepted === 256 && pool.rejected === 44 && pool.active === 256 && pool.invisible === 0,
      `projectile pool created invisible damaging shots: ${JSON.stringify(pool)}`);
    assert(errors.length === 0, errors.join(' | '));
    console.log(`smoke-helltide-lifecycle: PASS — queued ${delay.toFixed(1)}s, prompt mutations ${promptChurn.mutations}, pause hidden, visuals disposed, projectile pool ${pool.accepted}/${pool.rejected}`);
    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(`smoke-helltide-lifecycle: FAIL — ${e && (e.stack || e.message)}`);
  process.exitCode = 1;
  try { server.close(); } catch (_) {}
});
