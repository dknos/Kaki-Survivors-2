#!/usr/bin/env node
/**
 * BULLET HELL browser smoke.
 *
 * Covers the mode's complete high-risk loop rather than treating it as a menu
 * destination: entry, compact HUD, real foe art + bullets, reward pickup,
 * wave-five boss, repeated-entry texture reuse, and clean exits to both Menu
 * and Town. A second small landscape viewport guards the compact text layout.
 *
 * No npm install. Playwright + Chromium use the shared workspace cache.
 * Run: node tools/smoke-bullethell.mjs   Port: 8811 by default.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8811);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 25_000;

const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

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

function messageOf(e) {
  return e && e.message ? e.message : String(e);
}

async function waitForBoot(page) {
  await page.goto(`${ORIGIN}/index.html?smoke=1`, {
    waitUntil: 'load',
    timeout: BOOT_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => typeof window.kkStartBulletHell === 'function'
      && typeof window.kkReturnToMenu === 'function'
      && window.kkState && window.kkState.scene,
    null,
    { timeout: BOOT_TIMEOUT_MS },
  );
  await page.evaluate(async () => {
    try { await document.fonts.ready; } catch (_) {}
    localStorage.setItem('kks_introSeen', '1');
    try {
      const meta = await import('./src/meta.js');
      meta.setOption('optAutoFirePrimary', false);
      meta.setOption('optMusic', false);
    } catch (_) {}
  });
}

async function compactAudit(page, mobile = false) {
  return page.evaluate(({ mobile }) => {
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden'
        && Number(cs.opacity || 1) > 0 && r.width > 0 && r.height > 0;
    };
    const maxFont = (root) => {
      if (!root) return 0;
      let out = 0;
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (visible(el)) out = Math.max(out, parseFloat(getComputedStyle(el).fontSize) || 0);
      }
      return out;
    };
    const hud = document.querySelector('#kk-bh-hud');
    const notice = document.querySelector('#kk-bh-notice');
    const hr = hud && hud.getBoundingClientRect();
    const nr = notice && notice.getBoundingClientRect();
    const labels = [...document.querySelectorAll('.kk-bh-reward-label')]
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent.trim(),
          font: parseFloat(getComputedStyle(el).fontSize) || 0,
          width: r.width,
          height: r.height,
        };
      });
    return {
      mobile,
      vw: innerWidth,
      vh: innerHeight,
      hudCount: document.querySelectorAll('#kk-bh-hud').length,
      flashCount: document.querySelectorAll('#kk-bh-flash').length,
      noticeCount: document.querySelectorAll('#kk-bh-notice').length,
      hud: hr ? { width: hr.width, height: hr.height, maxFont: maxFont(hud) } : null,
      notice: nr && visible(notice)
        ? { width: nr.width, height: nr.height, font: parseFloat(getComputedStyle(notice).fontSize) || 0, text: notice.textContent.trim() }
        : null,
      labels,
      survivorsHidden: {
        xp: (() => { const e = document.querySelector('.kk-xp-fill'); return !e || getComputedStyle(e.parentElement).display === 'none'; })(),
        level: (() => { const e = document.querySelector('.kk-level'); return !e || getComputedStyle(e).display === 'none'; })(),
        time: (() => { const e = document.querySelector('.kk-time'); return !e || getComputedStyle(e).display === 'none'; })(),
        kills: (() => { const e = document.querySelector('.kk-kills'); return !e || getComputedStyle(e).display === 'none'; })(),
        dash: (() => { const e = document.querySelector('#kk-dash-readout'); return !e || getComputedStyle(e).display === 'none'; })(),
      },
    };
  }, { mobile });
}

function assertCompact(a, failures, label) {
  if (a.hudCount !== 1 || a.flashCount !== 1 || a.noticeCount !== 1) {
    failures.push(`${label}: owned DOM count invalid (hud=${a.hudCount}, flash=${a.flashCount}, notice=${a.noticeCount})`);
  }
  if (!a.hud) {
    failures.push(`${label}: #kk-bh-hud has no layout box`);
  } else {
    const maxHeight = a.mobile ? Math.max(62, a.vh * 0.16) : Math.max(92, a.vh * 0.16);
    const maxFont = a.mobile ? 17 : 19;
    if (a.hud.height > maxHeight) failures.push(`${label}: HUD too tall (${a.hud.height.toFixed(1)}px > ${maxHeight.toFixed(1)}px)`);
    if (a.hud.width > a.vw * 0.82) failures.push(`${label}: HUD too wide (${a.hud.width.toFixed(1)}px / ${a.vw}px)`);
    if (a.hud.maxFont > maxFont) failures.push(`${label}: HUD text too large (${a.hud.maxFont.toFixed(1)}px > ${maxFont}px)`);
  }
  if (a.notice) {
    const maxFont = a.mobile ? 19 : 25;
    if (a.notice.width > a.vw * 0.82) failures.push(`${label}: notice too wide (${a.notice.width.toFixed(1)}px / ${a.vw}px)`);
    if (a.notice.height > a.vh * 0.19) failures.push(`${label}: notice too tall (${a.notice.height.toFixed(1)}px / ${a.vh}px)`);
    if (a.notice.font > maxFont) failures.push(`${label}: notice text too large (${a.notice.font.toFixed(1)}px > ${maxFont}px)`);
  }
  for (const [key, hidden] of Object.entries(a.survivorsHidden)) {
    if (!hidden) failures.push(`${label}: survivors ${key} HUD leaked into Bullet Hell`);
  }
}

function instrumentPage(page, telemetry) {
  page.on('pageerror', (e) => telemetry.pageErrors.push(messageOf(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') telemetry.consoleErrors.push(msg.text());
  });
  page.on('request', (req) => {
    if (/\/assets\/fx\/foes\/foe_[^/?]+\.webp(?:[?#]|$)/.test(req.url())) {
      telemetry.foeRequests.push(req.url());
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.startsWith(ORIGIN) && (/\/src\//.test(url) || /\/assets\/fx\/(?:arena|foes)\//.test(url))) {
      telemetry.requestFailures.push(`${url}: ${req.failure()?.errorText || 'failed'}`);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 400 && url.startsWith(ORIGIN)
      && (/\/src\//.test(url) || /\/assets\/fx\/(?:arena|foes)\//.test(url))) {
      telemetry.responseErrors.push(`${res.status()} ${url}`);
    }
  });
}

async function exitAudit(page) {
  return page.evaluate(async () => {
    const { bh } = await import('./src/bullethell/bhState.js');
    const s = window.kkState;
    const hooks = ['__kkBhWarp', '__kkBhFoes', '__kkBhScreen', '__kkBhSetWave', '__kkBhKillAll'];
    let remoteAnchors = 0;
    s.scene.traverse((o) => {
      if (o.userData && o.userData.kkBulletHell) remoteAnchors++;
    });
    const original = window.__kkBhSmokeOriginal;
    const ground = s.envGroup && s.envGroup.userData && s.envGroup.userData.ground;
    return {
      mode: s.mode,
      active: bh.active,
      hud: document.querySelectorAll('#kk-bh-hud').length,
      flash: document.querySelectorAll('#kk-bh-flash').length,
      notice: document.querySelectorAll('#kk-bh-notice').length,
      rewardLabels: document.querySelectorAll('.kk-bh-reward-label').length,
      envY: s.envGroup ? s.envGroup.position.y : null,
      envVisible: s.envGroup ? s.envGroup.visible : null,
      groundVisible: ground ? ground.visible : null,
      bgRestored: !original || s.scene.background === original.bg,
      fogRestored: !original || s.scene.fog === original.fog,
      heroX: s.hero.pos.x,
      heroZ: s.hero.pos.z,
      remoteAnchors,
      staleHooks: hooks.filter((k) => typeof window[k] !== 'undefined'),
    };
  });
}

function assertExit(a, failures, label, expectedMode) {
  if (a.mode !== expectedMode) failures.push(`${label}: mode=${a.mode}, expected ${expectedMode}`);
  if (a.active) failures.push(`${label}: bh.active stayed true`);
  if (a.hud || a.flash || a.notice || a.rewardLabels) {
    failures.push(`${label}: owned DOM leaked (hud=${a.hud}, flash=${a.flash}, notice=${a.notice}, labels=${a.rewardLabels})`);
  }
  if (a.envY !== null && Math.abs(a.envY) > 1e-6) failures.push(`${label}: envGroup remained parked at y=${a.envY}`);
  if (a.envVisible === false) failures.push(`${label}: overworld environment remained hidden`);
  if (a.groundVisible === false) failures.push(`${label}: overworld ground remained hidden`);
  if (!a.bgRestored || !a.fogRestored) failures.push(`${label}: scene background/fog not restored`);
  if (a.remoteAnchors > 0) failures.push(`${label}: ${a.remoteAnchors} visible scene objects remain near Bullet Hell arena`);
  if (a.staleHooks.length) failures.push(`${label}: stale QA hooks remain (${a.staleHooks.join(', ')})`);
}

async function runDesktop(browser, failures, telemetry) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.route(/fonts\.(?:googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  instrumentPage(page, telemetry);

  try {
    await waitForBoot(page);
    const requestsBeforeFirstEntry = telemetry.foeRequests.length;
    await page.evaluate(async () => {
      const s = window.kkState;
      window.__kkBhSmokeOriginal = { bg: s.scene.background, fog: s.scene.fog };
      await Promise.all([
        window.kkStartBulletHell(),
        window.kkStartBulletHell(),
        window.kkStartBulletHell(),
      ]);
      // Keep timing deterministic while real patterns are allowed to run.
      s.hero.hpMax = 99_999;
      s.hero.hp = 99_999;
    });
    await page.waitForFunction(
      () => window.kkState.mode === 'bullethell' && window.__kkBh?.active
        && document.querySelectorAll('#kk-bh-hud').length === 1,
      null,
      { timeout: STEP_TIMEOUT_MS },
    );

    const entry = await page.evaluate(() => {
      const s = window.kkState;
      const ground = s.envGroup && s.envGroup.userData && s.envGroup.userData.ground;
      return {
        mode: s.mode,
        active: !!window.__kkBh?.active,
        hero: [s.hero.pos.x, s.hero.pos.z],
        envY: s.envGroup ? s.envGroup.position.y : null,
        envVisible: s.envGroup ? s.envGroup.visible : null,
        groundVisible: ground ? ground.visible : null,
      };
    });
    if (entry.mode !== 'bullethell' || !entry.active) failures.push(`entry invalid: ${JSON.stringify(entry)}`);
    if (Math.hypot(entry.hero[0] - 480, entry.hero[1] - 480) > 0.01) failures.push(`entry hero not centered: [${entry.hero}]`);
    if (entry.envVisible !== null && entry.envVisible !== false) failures.push(`entry overworld environment remained renderable`);

    const desktopLayout = await compactAudit(page, false);
    assertCompact(desktopLayout, failures, 'desktop entry');
    await page.screenshot({ path: '/tmp/kks-bullethell-intro.png', fullPage: false });

    await page.waitForFunction(
      () => window.__kkBh?.wave === 1 && window.__kkBhFoes?.().length > 0,
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    const combat = await page.evaluate(async () => {
      const foes = window.__kkBhFoes();
      const b = await import('./src/bullethell/bullets.js');
      // SwiftShader can render below one gameplay frame/sec. Force one real
      // archetype fire callback so this checks the production pattern path
      // without turning the smoke into a frame-rate benchmark.
      if (b.liveBulletCount() < 1 && foes[0]) foes[0].def.fire(foes[0]);
      const peakBullets = b.liveBulletCount();
      let heroTriangles = 0;
      window.kkState.hero.mesh?.traverse?.((node) => {
        if (!node.isMesh || !node.geometry) return;
        const geometry = node.geometry;
        const elements = geometry.index?.count || geometry.attributes?.position?.count || 0;
        const instances = node.isInstancedMesh ? node.count : 1;
        heroTriangles += Math.floor(elements / 3) * instances;
      });
      const render = window.__kkRendererService?.getDiagnostics?.() || null;
      return {
        wave: window.__kkBh.wave,
        foes: foes.length,
        bullets: peakBullets,
        heroTriangles,
        render: render ? { drawCalls: render.drawCalls, triangles: render.triangles } : null,
        sprites: foes.filter((f) => f.isSprite).map((f) => {
          const image = f.bodyMat && f.bodyMat.map && f.bodyMat.map.image;
          return {
            type: f.type,
            width: image ? (image.naturalWidth || image.videoWidth || image.width || 0) : 0,
            height: image ? (image.naturalHeight || image.videoHeight || image.height || 0) : 0,
          };
        }),
      };
    });
    if (combat.wave !== 1 || combat.foes < 1 || combat.bullets < 1) failures.push(`wave-one combat missing: ${JSON.stringify(combat)}`);
    if (combat.heroTriangles < 1 || combat.heroTriangles > 50_000) {
      failures.push(`runtime hero exceeded the Bullet Hell geometry budget: ${JSON.stringify(combat)}`);
    }
    if (!combat.sprites.length || combat.sprites.some((s) => s.width < 1 || s.height < 1)) {
      failures.push(`wave-one generated foe art unavailable: ${JSON.stringify(combat.sprites)}`);
    }
    await page.screenshot({ path: '/tmp/kks-bullethell-wave1.png', fullPage: false });

    const beforeReward = await page.evaluate(() => ({
      stats: { ...window.__kkBh.stats },
      hp: window.kkState.hero.hp,
      hpMax: window.kkState.hero.hpMax,
      taken: window.__kkBh.taken.length,
    }));
    await page.evaluate(() => window.__kkBhKillAll());
    await page.waitForFunction(
      () => window.__kkBh?.itemPending?.choices?.length === 1
        && document.querySelectorAll('.kk-bh-reward-label').length === 1,
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    const rewardLayout = await compactAudit(page, false);
    if (rewardLayout.labels.length !== 1 || !rewardLayout.labels[0].text) {
      failures.push(`reward label missing/empty: ${JSON.stringify(rewardLayout.labels)}`);
    }
    if (rewardLayout.labels.some((l) => l.font > 16 || l.width > rewardLayout.vw * 0.32)) {
      failures.push(`reward label not compact: ${JSON.stringify(rewardLayout.labels)}`);
    }
    await page.screenshot({ path: '/tmp/kks-bullethell-reward.png', fullPage: false });

    const rewardDef = await page.evaluate(() => {
      const choice = window.__kkBh.itemPending.choices[0];
      const p = choice.mesh.position;
      const out = { id: choice.def.id, name: choice.def.name, x: p.x, z: p.z };
      window.__kkBhWarp(p.x - 480, p.z - 480);
      return out;
    });
    await page.waitForFunction(
      (n) => window.__kkBh?.taken?.length === n + 1 && !window.__kkBh.itemPending,
      beforeReward.taken,
      { timeout: STEP_TIMEOUT_MS },
    );
    const afterReward = await page.evaluate(() => ({
      stats: { ...window.__kkBh.stats },
      hp: window.kkState.hero.hp,
      hpMax: window.kkState.hero.hpMax,
      taken: window.__kkBh.taken.map((d) => d.id),
      labels: document.querySelectorAll('.kk-bh-reward-label').length,
    }));
    const statChanged = Object.keys(beforeReward.stats).some((k) => afterReward.stats[k] !== beforeReward.stats[k]);
    const heroChanged = afterReward.hp !== beforeReward.hp || afterReward.hpMax !== beforeReward.hpMax;
    if (afterReward.taken.at(-1) !== rewardDef.id || (!statChanged && !heroChanged) || afterReward.labels !== 0) {
      failures.push(`reward pickup invalid (${rewardDef.id}): ${JSON.stringify({ beforeReward, afterReward })}`);
    }

    await page.evaluate(() => {
      window.kkState.hero.hpMax = 99_999;
      window.kkState.hero.hp = 99_999;
      window.__kkBhWarp(0, 16);
      window.__kkBhSetWave(5);
    });
    await page.waitForFunction(
      () => window.__kkBh?.wave === 5 && window.__kkBh?.boss && window.__kkBhFoes?.().some((f) => f.type === 'boss'),
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    const boss = await page.evaluate(async () => {
      const b = await import('./src/bullethell/bullets.js');
      const f = window.__kkBhFoes().find((x) => x.type === 'boss');
      if (b.liveBulletCount() < 1 && f) f.def.fire(f);
      const peakBullets = b.liveBulletCount();
      return {
        wave: window.__kkBh.wave,
        name: window.__kkBh.bossName,
        bossLinked: window.__kkBh.boss === f,
        hp: f && f.hp,
        hpMax: f && f.hpMax,
        bullets: peakBullets,
        spriteName: f && f.spriteName,
        hudText: document.querySelector('#kk-bh-hud')?.textContent || '',
      };
    });
    if (boss.wave !== 5 || !boss.name || !boss.bossLinked || boss.hp <= 0 || boss.hpMax <= 0 || boss.bullets < 1) {
      failures.push(`wave-five boss invalid: ${JSON.stringify(boss)}`);
    }
    if (!boss.hudText.includes(boss.name)) failures.push(`boss name absent from HUD: ${JSON.stringify(boss)}`);
    if (boss.spriteName !== 'foe_boss_velvet') failures.push(`wave-five boss used wrong sprite: ${boss.spriteName}`);
    await page.screenshot({ path: '/tmp/kks-bullethell-boss5.png', fullPage: false });

    await page.evaluate(() => window.__kkBhKillAll());
    await page.waitForFunction(
      () => window.__kkBh?.itemPending?.choices?.length === 3
        && document.querySelectorAll('.kk-bh-reward-label').length === 3,
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    const bossRewardLayout = await compactAudit(page, false);
    // Three choices exist, but only the nearest compact detail card is visible;
    // showing all three at once overlaps the projected pedestals.
    if (bossRewardLayout.labels.length !== 1
        || bossRewardLayout.labels.some((l) => !l.text || l.font > 16 || l.width > 150)) {
      failures.push(`boss reward labels invalid: ${JSON.stringify(bossRewardLayout.labels)}`);
    }
    await page.screenshot({ path: '/tmp/kks-bullethell-boss-reward.png', fullPage: false });
    await page.evaluate(async () => {
      const items = await import('./src/bullethell/items.js');
      items.disposeItems(window.kkState.scene);
    });

    const bossFamilies = await page.evaluate(async () => {
      const { bh } = await import('./src/bullethell/bhState.js');
      const { fireBossPattern, BOSS_PATTERN_KEYS } = await import('./src/bullethell/bossPatterns.js');
      const { BOSS_SPRITE_NAMES } = await import('./src/bullethell/foes.js');
      const bullets = await import('./src/bullethell/bullets.js');
      const counts = [];
      for (let level = 0; level < 4; level++) {
        bullets.clearAllBullets();
        bh.level = level;
        const f = {
          x: 480, z: 480, phaseIdx: 0, alt: 0, phase: 0, dir: 1,
          gapT: undefined, burst: 0, burstGap: 0, burstFn: null,
        };
        fireBossPattern(f);
        if (bullets.liveBulletCount() < 1 && f.burstFn) f.burstFn(f);
        counts.push(bullets.liveBulletCount());
      }
      bullets.clearAllBullets();
      return { keys: BOSS_PATTERN_KEYS, sprites: BOSS_SPRITE_NAMES, counts };
    });
    if (new Set(bossFamilies.keys).size !== 4 || new Set(bossFamilies.sprites).size !== 4
        || bossFamilies.counts.some((n) => n < 1)) {
      failures.push(`boss families are not distinct/active: ${JSON.stringify(bossFamilies)}`);
    }

    // Let every first-entry image request settle before measuring the re-entry delta.
    await page.waitForTimeout(500);
    const firstEntryFoeRequests = telemetry.foeRequests.length - requestsBeforeFirstEntry;
    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => window.kkState.mode === 'menu', null, { timeout: STEP_TIMEOUT_MS });
    const menuExit = await exitAudit(page);
    assertExit(menuExit, failures, 'menu exit', 'menu');
    if (Math.hypot(menuExit.heroX, menuExit.heroZ) > 0.01) failures.push(`menu exit hero not reset: (${menuExit.heroX},${menuExit.heroZ})`);

    const requestsBeforeSecondEntry = telemetry.foeRequests.length;
    await page.evaluate(async () => window.kkStartBulletHell());
    await page.waitForFunction(
      () => window.kkState.mode === 'bullethell' && window.__kkBh?.active
        && document.querySelectorAll('#kk-bh-hud').length === 1,
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    await page.waitForTimeout(750);
    const secondEntryFoeRequests = telemetry.foeRequests.length - requestsBeforeSecondEntry;
    if (firstEntryFoeRequests > 0 && secondEntryFoeRequests !== 0) {
      failures.push(`foe textures requested again on re-entry (${firstEntryFoeRequests} first, ${secondEntryFoeRequests} second)`);
    }
    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => window.kkState.mode === 'menu', null, { timeout: STEP_TIMEOUT_MS });

    // Direct active-mode path exercises the same shared Return-to-Town handler
    // exposed by the death screen. It must dispose Bullet Hell before building town.
    await page.evaluate(async () => window.kkStartBulletHell());
    await page.waitForFunction(
      () => window.kkState.mode === 'bullethell' && document.querySelector('#kk-bh-hud'),
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    await page.evaluate(async () => window.kkReturnToTown());
    await page.waitForFunction(() => window.kkState.mode === 'town', null, { timeout: BOOT_TIMEOUT_MS });
    const townExit = await exitAudit(page);
    assertExit(townExit, failures, 'town exit', 'town');
    const townVisible = await page.evaluate(() => {
      const t = window.kkState.scene.getObjectByName('townGroup');
      return !!(t && t.visible);
    });
    if (!townVisible) failures.push('town exit: townGroup is not visible');
    await page.screenshot({ path: '/tmp/kks-bullethell-town-exit.png', fullPage: false });

    console.log(`  desktop: wave=${combat.wave} foes=${combat.foes} bullets=${combat.bullets} sprites=${combat.sprites.length}`);
    console.log(`  reward: ${rewardDef.name} (${rewardDef.id}) labels=${rewardLayout.labels.length}->${afterReward.labels}`);
    console.log(`  boss: wave=${boss.wave} ${boss.name} hp=${Math.round(boss.hp)}/${Math.round(boss.hpMax)} bullets=${boss.bullets}`);
    console.log(`  lifecycle: first foe requests=${firstEntryFoeRequests}, re-entry=${secondEntryFoeRequests}, menu remote=${menuExit.remoteAnchors}, town remote=${townExit.remoteAnchors}`);
  } finally {
    await ctx.close();
  }
}

async function runMobile(browser, failures, telemetry) {
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.route(/fonts\.(?:googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  instrumentPage(page, telemetry);
  try {
    await waitForBoot(page);
    await page.evaluate(async () => {
      window.kkState.run._bhCampaign = {
        maxWave: 5,
        unlockFlag: '__kkBhSmokeNever',
        label: 'Snow-Crowned Moon Gate',
      };
      await window.kkStartBulletHell();
      window.kkState.hero.hpMax = 99_999;
      window.kkState.hero.hp = 99_999;
    });
    await page.waitForFunction(
      () => window.kkState.mode === 'bullethell' && window.__kkBh?.campaign
        && document.querySelector('#kk-bh-hud') && document.querySelector('#kk-bh-notice'),
      null,
      { timeout: STEP_TIMEOUT_MS },
    );
    const mobileLayout = await compactAudit(page, true);
    assertCompact(mobileLayout, failures, 'mobile campaign');
    const hudText = await page.locator('#kk-bh-hud').innerText();
    if (!/SNOW-CROWNED MOON GATE/i.test(hudText)) failures.push(`mobile campaign objective absent from HUD: ${hudText}`);
    await page.evaluate(() => { window.__kkBh.stats.bombCharges = 1; });
    await page.waitForFunction(() => {
      const b = document.querySelector('#kk-touch-active');
      return b && getComputedStyle(b).display !== 'none' && Number(getComputedStyle(b).opacity) > 0.9;
    }, null, { timeout: STEP_TIMEOUT_MS });
    await page.screenshot({ path: '/tmp/kks-bullethell-mobile.png', fullPage: false });
    await page.locator('#kk-touch-active').tap();
    await page.waitForFunction(() => window.__kkBh?.stats?.bombCharges === 0, null, { timeout: STEP_TIMEOUT_MS });
    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => window.kkState.mode === 'menu', null, { timeout: STEP_TIMEOUT_MS });
    const mobileExit = await exitAudit(page);
    assertExit(mobileExit, failures, 'mobile menu exit', 'menu');
    console.log(`  mobile: ${mobileLayout.vw}x${mobileLayout.vh} HUD=${mobileLayout.hud?.width.toFixed(0)}x${mobileLayout.hud?.height.toFixed(0)} maxFont=${mobileLayout.hud?.maxFont.toFixed(1)}px`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) {
    console.error('[smoke-bullethell] FAIL: playwright missing at ' + PLAY_PATH);
    process.exit(2);
  }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) {
    console.error('[smoke-bullethell] FAIL: chromium missing at ' + PLAYWRIGHT_EXEC);
    process.exit(2);
  }

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log('[smoke-bullethell] server on ' + ORIGIN);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader',
      '--enable-webgl', '--ignore-gpu-blocklist',
    ],
  });
  const failures = [];
  const telemetry = {
    pageErrors: [], consoleErrors: [], requestFailures: [], responseErrors: [], foeRequests: [],
  };

  try {
    await runDesktop(browser, failures, telemetry);
    await runMobile(browser, failures, telemetry);
  } catch (e) {
    failures.push('exception: ' + (e && e.stack ? e.stack : messageOf(e)));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  for (const e of telemetry.pageErrors) failures.push('page error: ' + e);
  for (const e of telemetry.consoleErrors) failures.push('console error: ' + e);
  for (const e of telemetry.requestFailures) failures.push('request failure: ' + e);
  for (const e of telemetry.responseErrors) failures.push('HTTP error: ' + e);

  console.log('\n========== BULLET HELL SUMMARY ==========');
  if (failures.length) {
    console.error(`[smoke-bullethell] FAIL (${failures.length}):`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-bullethell] PASS — combat, compact HUD, rewards, boss, texture reuse, and lifecycle are clean');
  console.log('  screenshots: /tmp/kks-bullethell-{intro,wave1,reward,boss5,boss-reward,town-exit,mobile}.png');
}

main().catch((e) => {
  console.error('[smoke-bullethell] FATAL:', e && (e.stack || e.message || e));
  try { server.close(); } catch (_) {}
  process.exit(2);
});
