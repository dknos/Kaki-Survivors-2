#!/usr/bin/env node
/**
 * Compact HUD banner sizing + centre-channel priority smoke.
 *
 * Exercises the shared gameplay notice, boss-intro cinematic, and stage-rule
 * ribbon at compact landscape and portrait viewports. Each channel must remain
 * readable inside the viewport on its own. When deliberately fired together,
 * the boss cinematic owns the centre; without a cinematic, the higher-priority
 * shared notice owns it instead of colliding with the stage-rule ribbon.
 *
 * Run: node tools/smoke-hud-banner-priority.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8953);
const TIMEOUT = 90000;
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const VIEWPORTS = [
  { name: 'compact-landscape', width: 780, height: 360 },
  { name: 'compact-portrait', width: 390, height: 844 },
];
const LONG_NOTICE = 'ALL GROVE TRIALS CLEARED — BOSS GATE AWAKENED';

function mime(file) {
  if (/\.m?js$/.test(file)) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(file)) return 'image/jpeg';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  const within = path.relative(ROOT, full);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (error, data) => {
    if (error) { res.writeHead(404); res.end(`not found: ${rel}`); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

function validateBox(viewport, label, box, failures) {
  assert(box && box.visible, `${viewport.name}/${label}: banner is not visible`, failures);
  if (!box || !box.visible) return;
  const horizontalInset = 4;
  assert(box.left >= horizontalInset - 0.5 && box.right <= viewport.width - horizontalInset + 0.5,
    `${viewport.name}/${label}: outside horizontal safe area ${JSON.stringify(box)}`, failures);
  assert(box.top >= 0 && box.bottom <= viewport.height,
    `${viewport.name}/${label}: outside vertical viewport ${JSON.stringify(box)}`, failures);
  assert(box.width <= viewport.width * 0.92 + 1,
    `${viewport.name}/${label}: width=${box.width}, viewport=${viewport.width}`, failures);
  assert(box.height <= viewport.height * 0.30 + 1,
    `${viewport.name}/${label}: height=${box.height} dominates viewport`, failures);
  assert(box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1,
    `${viewport.name}/${label}: content overflow ${JSON.stringify(box)}`, failures);
  const fontCeiling = label === 'stage' ? 18 : 24;
  assert(box.maxFontPx <= fontCeiling + 0.1,
    `${viewport.name}/${label}: max font=${box.maxFontPx}px (ceiling ${fontCeiling}px)`, failures);
}

function validateNoCollision(viewport, phase, snap, expectedId, failures) {
  const visible = snap.boxes.filter((box) => box.visible);
  assert(visible.length <= 1,
    `${viewport.name}/${phase}: simultaneous centre banners ${JSON.stringify(visible)}`, failures);
  assert(visible.length === 1 && visible[0].id === expectedId,
    `${viewport.name}/${phase}: expected ${expectedId} priority, got ${JSON.stringify(visible)}`, failures);
  assert(snap.overlaps.length === 0,
    `${viewport.name}/${phase}: banner rectangles overlap ${JSON.stringify(snap.overlaps)}`, failures);
}

async function main() {
  const failures = [];
  if (!fs.existsSync(PLAYWRIGHT) || !fs.existsSync(CHROMIUM)) {
    console.error('[smoke-hud-banner-priority] FAIL: Playwright/Chromium missing');
    process.exit(2);
  }
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: VIEWPORTS[0] });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/css', body: '',
  }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({
    status: 204, body: '',
  }));
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const httpErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    const externalResourceNoise = /Failed to load resource: net::ERR_(?:TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/.test(text);
    if (message.type() === 'error' && !externalResourceNoise) consoleErrors.push(text);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });

  const report = [];
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=hud-banner-priority`, {
      waitUntil: 'load', timeout: TIMEOUT,
    });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState,
      null, { timeout: TIMEOUT });
    await page.evaluate(async () => {
      const meta = await import('/src/meta.js');
      meta.setOption('selectedStage', 'forest');
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      window.kkState.weapons.length = 0;
      await window.kkStartRun();
    });
    await page.waitForFunction(() => {
      const s = window.kkState;
      return !!(s && s.started && s.run && s.run.stage && s.run.stage.id === 'forest');
    }, null, { timeout: TIMEOUT });
    await page.waitForTimeout(900);
    // Keep real gameplay ticking: the cinematic/ribbon modules drive their
    // CSS class and opacity lifecycle from the normal frame loop. The hero is
    // made effectively immortal so this remains deterministic without using
    // the pause branch, which intentionally freezes those presentation ticks.
    await page.evaluate(() => {
      window.kkState.time.paused = false;
      window.kkState.hero.hp = 1e9;
      window.kkState.hero.hpMax = 1e9;
    });

    async function resetChannels() {
      await page.evaluate(async () => {
        const ui = await import('/src/ui.js');
        const rules = await import('/src/stageRules.js');
        const boss = await import('/src/bossIntroCinematic.js');
        const evolve = await import('/src/evolveCinematic.js');
        const s = window.kkState;
        if (typeof ui.hideBanner === 'function') ui.hideBanner();
        rules.clearStageRule(s);
        boss.disposeBossIntroCinematic();
        evolve.disposeEvolveCinematic();
        s.run._bossIntroActive = false;
        s.run._evolveCinematicActive = false;
        s.run._cinematicSeen = { miniboss: false, elite: false, roomboss: false, reaper: false };
        boss.loadBossIntroCinematic(s.scene, s, s.camera);
        evolve.loadEvolveCinematic(s.scene, s, s.camera);
      });
      await page.waitForTimeout(80);
    }

    async function snapshot() {
      return page.evaluate(() => {
        // Headless Chromium can sample a newly-created fixed element at the
        // first keyframe when the page is between compositor frames. Finish
        // only CSS presentation animations; the target class/inline opacity
        // still decides whether a channel is meant to be shown or hidden.
        for (const element of document.querySelectorAll(
          '.kk-shared-banner, #kk-boss-intro-banner, #kk-stage-rule-banner',
        )) {
          for (const animation of element.getAnimations()) {
            try { animation.finish(); } catch (_) {}
          }
        }
        const definitions = [
          ['shared', document.querySelector('.kk-shared-banner')],
          ['boss', document.getElementById('kk-boss-intro-banner')],
          ['evolve', document.getElementById('kk-evolve-cin-banner')],
          ['stage', document.getElementById('kk-stage-rule-banner')],
        ];
        const boxes = definitions.map(([id, element]) => {
          if (!element) return { id, exists: false, visible: false };
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          let maxFontPx = Number.parseFloat(style.fontSize) || 0;
          for (const child of element.querySelectorAll('*')) {
            maxFontPx = Math.max(maxFontPx, Number.parseFloat(getComputedStyle(child).fontSize) || 0);
          }
          const opacity = Number.parseFloat(style.opacity || '1');
          const visible = style.display !== 'none'
            && style.visibility !== 'hidden'
            && opacity > 0.05
            && rect.width > 0 && rect.height > 0
            && rect.right > 0 && rect.bottom > 0
            && rect.left < innerWidth && rect.top < innerHeight;
          return {
            id,
            exists: true,
            visible,
            opacity,
            text: element.textContent.trim(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            maxFontPx,
            zIndex: style.zIndex,
            owner: element.dataset.owner || '',
            priority: element.dataset.priority || '',
            className: element.className || '',
            inlineOpacity: element.style.opacity || '',
          };
        });
        const overlaps = [];
        const visible = boxes.filter((box) => box.visible);
        for (let i = 0; i < visible.length; i++) {
          for (let j = i + 1; j < visible.length; j++) {
            const a = visible[i], b = visible[j];
            const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            if (width > 0.5 && height > 0.5) overlaps.push({ a: a.id, b: b.id, width, height });
          }
        }
        return { viewport: { width: innerWidth, height: innerHeight }, boxes, overlaps };
      });
    }

    // A stage/run teardown can happen during the 1.5s camera intro. Disposing
    // that owner must release the shared HUD immediately; otherwise all later
    // notices are rejected by a stale `_bossIntroActive` flag.
    const disposeLifecycle = await page.evaluate(async () => {
      const ui = await import('/src/ui.js');
      const boss = await import('/src/bossIntroCinematic.js');
      const s = window.kkState;
      s.run._cinematicSeen = { miniboss: false, elite: false, roomboss: false, reaper: false };
      boss.triggerBossIntro({
        displayName: 'Teardown Probe',
        position: { x: s.hero.pos.x + 4, y: 0, z: s.hero.pos.z + 4 },
      }, 'roomboss');
      const activeBefore = s.run._bossIntroActive === true;
      boss.disposeBossIntroCinematic();
      const activeAfter = s.run._bossIntroActive === true;
      const sharedAccepted = ui.showBanner('TEARDOWN RELEASED HUD', 1, '#ffd86b', {
        owner: 'qa-dispose', priority: 'important',
      });
      ui.hideBanner('qa-dispose');
      return { activeBefore, activeAfter, sharedAccepted };
    });
    assert(disposeLifecycle.activeBefore && !disposeLifecycle.activeAfter
      && disposeLifecycle.sharedAccepted,
    `boss-intro dispose did not release HUD ownership: ${JSON.stringify(disposeLifecycle)}`, failures);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(100);
      const phases = { viewport };

      // Isolated shared notice: use a real long Forest message rather than a
      // synthetic paragraph so wrapping expectations match live copy.
      await resetChannels();
      phases.sharedAccepted = await page.evaluate(async (text) => {
        const ui = await import('/src/ui.js');
        return ui.showBanner(text, 30, '#ffd86b', {
          owner: 'qa-shared', priority: 'important',
        });
      }, LONG_NOTICE);
      await page.waitForTimeout(320);
      phases.shared = await snapshot();
      validateBox(viewport, 'shared', phases.shared.boxes.find((box) => box.id === 'shared'), failures);
      assert(phases.sharedAccepted === true,
        `${viewport.name}/shared: showBanner did not accept isolated notice`, failures);

      // Isolated boss cinematic: compact layouts must not fall back to the old
      // 32–38px centre text even though this path owns the highest priority.
      await resetChannels();
      await page.evaluate(async () => {
        const boss = await import('/src/bossIntroCinematic.js');
        const s = window.kkState;
        boss.triggerBossIntro({
          displayName: 'Moonroot Grove Guardian',
          position: { x: s.hero.pos.x + 5, y: 0, z: s.hero.pos.z + 5 },
        }, 'roomboss');
      });
      await page.waitForTimeout(280);
      phases.boss = await snapshot();
      validateBox(viewport, 'boss', phases.boss.boxes.find((box) => box.id === 'boss'), failures);

      // Evolution owns the same centre lane and must use the same responsive
      // scale instead of the old fixed 30px banner.
      await resetChannels();
      await page.evaluate(async () => {
        const evolve = await import('/src/evolveCinematic.js');
        const s = window.kkState;
        evolve.triggerEvolveCinematic('chain_storm', {
          x: s.hero.pos.x + 3, y: 0, z: s.hero.pos.z + 3,
        });
      });
      await page.waitForTimeout(260);
      phases.evolve = await snapshot();
      validateBox(viewport, 'evolve', phases.evolve.boxes.find((box) => box.id === 'evolve'), failures);

      // Isolated stage rule remains readable when no more important channel is
      // active, preserving the small contextual ribbon rather than deleting it.
      await resetChannels();
      await page.evaluate(async () => {
        const rules = await import('/src/stageRules.js');
        rules.applyStageRule('forest', window.kkState);
      });
      await page.waitForTimeout(360);
      phases.stage = await snapshot();
      validateBox(viewport, 'stage', phases.stage.boxes.find((box) => box.id === 'stage'), failures);

      // Deliberate three-way collision. Boss cinematic must own centre, clear
      // lower-priority existing notices, and reject a new lower-priority one.
      await resetChannels();
      phases.collision = await page.evaluate(async (text) => {
        const ui = await import('/src/ui.js');
        const rules = await import('/src/stageRules.js');
        const boss = await import('/src/bossIntroCinematic.js');
        const s = window.kkState;
        rules.applyStageRule('forest', s);
        const beforeBoss = ui.showBanner(text, 30, '#ffd86b', {
          owner: 'qa-before-boss', priority: 'important',
        });
        boss.triggerBossIntro({
          displayName: 'Moonroot Grove Guardian',
          position: { x: s.hero.pos.x + 5, y: 0, z: s.hero.pos.z + 5 },
        }, 'roomboss');
        ui.updateUI();
        rules.tickStageRule(s, 0);
        const duringBoss = ui.showBanner('LOW PRIORITY AMBIENT NOTICE', 30, '#ffffff', {
          owner: 'qa-during-boss', priority: 'ambient',
        });
        return { beforeBoss, duringBoss };
      }, LONG_NOTICE);
      await page.waitForTimeout(300);
      phases.allThree = await snapshot();
      assert(phases.collision.beforeBoss === true && phases.collision.duringBoss === false,
        `${viewport.name}/all-three: priority return values ${JSON.stringify(phases.collision)}`, failures);
      validateNoCollision(viewport, 'all-three', phases.allThree, 'boss', failures);

      // Evolution also blocks ambient/shared notices while its one-second
      // reveal owns the lane.
      await resetChannels();
      phases.evolveCollision = await page.evaluate(async () => {
        const ui = await import('/src/ui.js');
        const rules = await import('/src/stageRules.js');
        const evolve = await import('/src/evolveCinematic.js');
        const s = window.kkState;
        rules.applyStageRule('forest', s);
        evolve.triggerEvolveCinematic('chain_storm', {
          x: s.hero.pos.x + 3, y: 0, z: s.hero.pos.z + 3,
        });
        ui.updateUI();
        rules.tickStageRule(s, 0);
        return ui.showBanner('LOW PRIORITY AMBIENT NOTICE', 30, '#ffffff', {
          owner: 'qa-during-evolve', priority: 'ambient',
        });
      });
      await page.waitForTimeout(260);
      phases.evolveOwns = await snapshot();
      assert(phases.evolveCollision === false,
        `${viewport.name}/evolve: ambient notice was accepted`, failures);
      validateNoCollision(viewport, 'evolve-owns', phases.evolveOwns, 'evolve', failures);

      // With no cinematic, an important shared notice owns centre over the
      // ambient stage-rule announcement. The stage ribbon still had an isolated
      // readability assertion above, so hiding it here is intentional priority.
      await resetChannels();
      phases.sharedStageAccepted = await page.evaluate(async (text) => {
        const ui = await import('/src/ui.js');
        const rules = await import('/src/stageRules.js');
        const s = window.kkState;
        rules.applyStageRule('forest', s);
        const accepted = ui.showBanner(text, 30, '#ffd86b', {
          owner: 'qa-important', priority: 'important',
        });
        ui.updateUI();
        rules.tickStageRule(s, 0);
        return accepted;
      }, LONG_NOTICE);
      await page.waitForTimeout(320);
      phases.sharedStage = await snapshot();
      assert(phases.sharedStageAccepted === true,
        `${viewport.name}/shared-stage: important shared notice rejected`, failures);
      validateNoCollision(viewport, 'shared-stage', phases.sharedStage, 'shared', failures);

      report.push(phases);
    }

    // Game over freezes cinematic ticks. A lethal frame during the boss intro
    // must still release the centre channel. Durable unlock/mastery feedback
    // belongs inside the results panel, not in a hidden timed banner beneath it.
    await page.setViewportSize({ width: 780, height: 720 });
    const runEndLifecycle = await page.evaluate(async () => {
      const ui = await import('/src/ui.js');
      const boss = await import('/src/bossIntroCinematic.js');
      const s = window.kkState;
      ui.hideBanner();
      boss.disposeBossIntroCinematic();
      boss.loadBossIntroCinematic(s.scene, s, s.camera);
      s.run._cinematicSeen = { miniboss: false, elite: false, roomboss: false, reaper: false };
      boss.triggerBossIntro({
        displayName: 'Run End Probe',
        position: { x: s.hero.pos.x + 4, y: 0, z: s.hero.pos.z + 4 },
      }, 'roomboss');
      const activeBefore = s.run._bossIntroActive === true;
      s.gameOver = true;
      s.victory = false;
      s.run.kills = Math.max(100, s.run.kills || 0);
      s.run.dmgDealt = Math.max(1000, s.run.dmgDealt || 0);
      ui.showDeathScreen();
      const bossElement = document.getElementById('kk-boss-intro-banner');
      const death = document.querySelector('.kk-death');
      const highlights = document.getElementById('kk-run-highlights');
      const rect = highlights?.getBoundingClientRect();
      return {
        activeBefore,
        activeAfter: s.run._bossIntroActive === true,
        bossVisibleAfter: !!(bossElement && bossElement.classList.contains('kk-bi-show')
          && bossElement.style.opacity !== '0'),
        deathVisible: !!death,
        highlightsInsideResults: !!(death && highlights && death.contains(highlights)),
        highlightCount: highlights?.querySelectorAll('.kk-run-highlight').length || 0,
        highlightText: highlights?.textContent || '',
        highlightInViewport: !!(rect && rect.bottom > 0 && rect.top < innerHeight),
        straySharedBanner: !!document.querySelector('.kk-shared-banner'),
      };
    });
    assert(runEndLifecycle.activeBefore && !runEndLifecycle.activeAfter
      && !runEndLifecycle.bossVisibleAfter && runEndLifecycle.deathVisible
      && runEndLifecycle.highlightsInsideResults && runEndLifecycle.highlightCount > 0
      && /MASTERY/.test(runEndLifecycle.highlightText) && runEndLifecycle.highlightInViewport
      && !runEndLifecycle.straySharedBanner,
    `run-end HUD ownership leaked: ${JSON.stringify(runEndLifecycle)}`, failures);
  } catch (error) {
    failures.push(`exception: ${error && error.stack ? error.stack : String(error)}`);
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }

  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length) failures.push(`console errors: ${consoleErrors.join(' | ')}`);
  if (httpErrors.length) failures.push(`HTTP errors: ${httpErrors.join(' | ')}`);
  console.log(JSON.stringify(report, null, 2));
  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error(`[smoke-hud-banner-priority] FAIL (${failures.length})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('[smoke-hud-banner-priority] PASS — compact banner sizing and centre-channel priority remain collision-free');
}

main().catch((error) => {
  console.error('[smoke-hud-banner-priority] FATAL', error);
  process.exit(2);
});
