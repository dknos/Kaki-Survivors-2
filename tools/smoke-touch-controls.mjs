#!/usr/bin/env node
/**
 * TOUCH CONTROLS smoke — guards the DMD-hybrid pivot Iter D (mobile).
 *
 * Forces the coarse-pointer path (?touch=1) and proves the new touch scheme:
 *   1. Dash + Active buttons exist on <body>; the old Jump button is gone.
 *   2. Buttons are hidden before a run starts (and the active button stays
 *      hidden until an active is drafted) — so a tap can't leak through.
 *   3. Pressing the Dash button makes the hero dash (dashCD/dashUntil arm) and
 *      isDashPressed() reflects press/release.
 *   4. Pressing the Active button casts the equipped active (cd arms) — the
 *      full button -> queue -> tickWeapons -> castActive chain.
 *   5. On a NON-touch context the buttons are not created at all.
 *
 * No npm install. Run: node tools/smoke-touch-controls.mjs   Port: 8804.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8804);
const BOOT_TIMEOUT_MS = 90000;

function mime(p) {
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css'))  return 'text/css';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.glb'))  return 'model/gltf-binary';
  if (p.endsWith('.png'))  return 'image/png';
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
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-touch] FAIL: playwright missing'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-touch] FAIL: chromium missing'); process.exit(2); }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-touch] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const failures = [];

  // ── Touch context ──
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1&touch=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });

    // 1) buttons exist, jump gone, hidden pre-start
    const pre = await page.evaluate(() => {
      const d = document.getElementById('kk-touch-dash');
      const a = document.getElementById('kk-touch-active');
      return {
        dash: !!d, active: !!a,
        jumpGone: !document.getElementById('kk-touch-jump'),
        dashHiddenPreStart: d ? getComputedStyle(d).display === 'none' : false,
      };
    });
    if (!pre.dash) failures.push('dash touch button not created on coarse pointer');
    if (!pre.active) failures.push('active touch button not created on coarse pointer');
    if (!pre.jumpGone) failures.push('old jump button still present (should be removed on touch)');
    if (!pre.dashHiddenPreStart) failures.push('dash button visible before run start (should be hidden)');

    // start a run
    await page.evaluate(async () => {
      localStorage.setItem('kks_introSeen', '1');
      // This smoke owns the action buttons, not Forest onboarding. Suppress
      // the real Grove Gates dialog so it does not correctly hide inputs.
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      await window.kkStartRun();
    });
    await page.waitForFunction(() => window.kkState && window.kkState.started, null, { timeout: BOOT_TIMEOUT_MS }).catch(() => {});

    // 2) visibility: dash shows once live; active hidden until drafted, shows after
    const vis = await page.evaluate(async () => {
      const d = document.getElementById('kk-touch-dash');
      const a = document.getElementById('kk-touch-active');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      const beforeDraft = getComputedStyle(a).display;
      const act = await import('./src/weapons/actives.js');
      act.acquireActive('nova');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      return { dashDisp: getComputedStyle(d).display, activeBefore: beforeDraft, activeAfter: getComputedStyle(a).display };
    });
    if (vis.dashDisp !== 'flex') failures.push(`dash button not shown in live run (display=${vis.dashDisp})`);
    if (vis.activeBefore !== 'none') failures.push(`active button shown before drafting (display=${vis.activeBefore})`);
    if (vis.activeAfter !== 'flex') failures.push(`active button not shown after drafting (display=${vis.activeAfter})`);

    // 3) dash button -> hero dashes + isDashPressed reflects press/release
    const dash = await page.evaluate(async () => {
      const inp = await import('./src/input.js');
      const s = window.kkState;
      s.hero.dashCD = 0; s.hero.dashUntil = 0;
      const d = document.getElementById('kk-touch-dash');
      d.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
      const heldNow = inp.isDashPressed();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      const dashed = (s.hero.dashCD > 0) || (s.hero.dashUntil > s.time.real);
      d.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      const releasedNow = inp.isDashPressed();
      return { heldNow, dashed, releasedNow };
    });
    if (!dash.heldNow) failures.push('isDashPressed() false while dash button held');
    if (!dash.dashed) failures.push('dash button press did not make the hero dash');
    if (dash.releasedNow) failures.push('isDashPressed() still true after dash button release');

    // 4) active button -> cast (cd arms) end-to-end through tickWeapons
    const cast = await page.evaluate(async () => {
      const s = window.kkState;
      s.hero.active.cd = 0;
      const a = document.getElementById('kk-touch-active');
      a.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      return { cast: s.hero.active.cd > 0 };
    });
    if (!cast.cast) failures.push('active button press did not cast (cooldown not armed via tickWeapons)');

    // 5) Cast-leak-through guard (blind spot #1): a tap while PAUSED (modal up)
    //    must not fire on unpause. The rAF updater clears the queue while !live.
    const leak = await page.evaluate(async () => {
      const act = await import('./src/weapons/actives.js');
      const s = window.kkState;
      act.acquireActive('nova');
      s.hero.active.cd = 0;                       // ready to fire
      s.time.paused = true;                       // simulate a modal/pause
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a = document.getElementById('kk-touch-active');
      a.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true })); // tap during pause
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))); // rAF clears the queue
      s.time.paused = false;                      // unpause
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))); // tickWeapons runs
      return { castOnUnpause: s.hero.active.cd > 0 };
    });
    if (leak.castOnUnpause) failures.push('cast LEAKED through a paused frame (tap during pause fired on unpause)');

    // 6) Pause/Options button (mobile ESC equivalent) opens the options panel.
    const pause = await page.evaluate(async () => {
      const ui = await import('./src/ui.js');
      const btn = document.getElementById('kk-touch-pause');
      if (!btn) return { found: false };
      const visBefore = getComputedStyle(btn).display;
      btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
      const opened = ui.isOptionsOpen ? ui.isOptionsOpen() : false;
      try { ui.hideOptions(); } catch (_) {}
      return { found: true, visBefore, opened };
    });
    if (!pause.found) failures.push('pause/options touch button not created');
    else {
      if (pause.visBefore !== 'flex') failures.push(`pause button not visible during gameplay (display=${pause.visBefore})`);
      if (!pause.opened) failures.push('pause button did not open the options panel');
    }

    if (pageErrors.length) failures.push('touch ctx page errors: ' + pageErrors.join(' | '));
    console.log(`  exist: dash=${pre.dash} active=${pre.active} jumpGone=${pre.jumpGone} | vis: dash=${vis.dashDisp} active ${vis.activeBefore}->${vis.activeAfter} | dash.dashed=${dash.dashed} | active.cast=${cast.cast} | leakBlocked=${!leak.castOnUnpause} | pauseOpens=${pause.opened}`);
  } catch (e) {
    failures.push('touch ctx exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx.close();
  }

  // ── Non-touch context: buttons must NOT be created ──
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page2 = await ctx2.newPage();
  try {
    await page2.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page2.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });
    const desktop = await page2.evaluate(() => ({
      noDash: !document.getElementById('kk-touch-dash'),
      noActive: !document.getElementById('kk-touch-active'),
    }));
    if (!desktop.noDash || !desktop.noActive) failures.push('touch buttons created on a non-coarse (desktop) context');
  } catch (e) {
    failures.push('desktop ctx exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await ctx2.close();
  }

  await browser.close();
  server.close();

  console.log('\n========== SUMMARY ==========');
  if (failures.length) {
    console.error('[smoke-touch] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-touch] PASS — dash + active touch buttons work, hide correctly, jump retired, desktop unaffected');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-touch] FATAL', e); process.exit(2); });
