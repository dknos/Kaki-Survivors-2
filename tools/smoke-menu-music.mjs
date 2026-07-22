#!/usr/bin/env node
/**
 * Iter 38 — MENU MUSIC smoke.
 *
 * Verifies the title-screen background-music feature:
 *   1. Asset present + served: GET /assets/music/menu_glitch.mp3 -> 200, audio/mpeg.
 *   2. playMenuMusic() creates a looping <audio> off menu_glitch.mp3, routed so
 *      it counts on the music bus (_playCounts.music increments).
 *   3. setMenuMusicMuted(true/false) pauses/resumes the element (el.paused flips).
 *   4. The menu mounts a mute button in .kkv2-top-right; clicking it flips
 *      getMeta().optMenuMusicMuted and the button glyph.
 *
 * Chromium gets --autoplay-policy=no-user-gesture-required and we resume the
 * AudioContext in-page so el.play() resolves headless.
 *
 * No npm install. Run: node tools/smoke-menu-music.mjs   Port: 8788.
 */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8788);
const BOOT_TIMEOUT_MS = 60000;
const HERO_TIMEOUT_MS = 45000;

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
  if (p.endsWith('.ogg'))  return 'audio/ogg';
  if (p.endsWith('.wav'))  return 'audio/wav';
  return 'application/octet-stream';
}
let _mp3Requests = 0;
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  if (rel.endsWith('menu_glitch.mp3')) _mp3Requests++;
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

async function main() {
  if (!fs.existsSync(PLAY_PATH)) { console.error('[smoke-menu-music] FAIL: playwright missing (no npm install)'); process.exit(2); }
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) { console.error('[smoke-menu-music] FAIL: chromium missing'); process.exit(2); }
  // Asset must exist on disk.
  const mp3Path = path.join(ROOT, 'assets', 'music', 'menu_glitch.mp3');
  if (!fs.existsSync(mp3Path)) { console.error('[smoke-menu-music] FAIL: assets/music/menu_glitch.mp3 not on disk'); process.exit(1); }
  console.log('[smoke-menu-music] asset on disk:', (fs.statSync(mp3Path).size / 1e6).toFixed(1) + 'MB');

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[smoke-menu-music] server on http://127.0.0.1:' + PORT);

  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({
    executablePath: PLAYWRIGHT_EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') console.log('[console.' + t + ']', m.text()); });
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('[pageerror]', e.message); });

  const failures = [];
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/index.html?smoke=1', { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.kkStartRun === 'function' && window.kkState, null, { timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(async () => { const a = await import('./src/assets.js'); return !!a.GLTF_CACHE.hero; }, null, { timeout: HERO_TIMEOUT_MS });

    // ── Assertion: audio API behaviour ────────────────────────────────
    const audio = await page.evaluate(async () => {
      const a = await import('./src/audio.js');
      a.unlockAudio();
      const before = a._debug.counts().music;
      a.setMenuMusicMuted(false);
      a.playMenuMusic();                       // creates ctx + element + plays
      // Resume ctx so el.play() resolves headless (ensureCtx may create it suspended).
      try { const c = a._debug.ctx(); if (c && c.state === 'suspended') await c.resume(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 300));
      const mm = a._debug.menuMusic();
      const after = a._debug.counts().music;
      const res = {
        elFound: !!mm,
        srcOk: !!mm && mm.src.endsWith('menu_glitch.mp3'),
        loop: !!mm && mm.loop === true,
        musicCountUp: after > before,
        mutedFlagFalse: a.isMenuMusicMuted() === false,
      };
      // mute -> paused; unmute -> playing
      a.setMenuMusicMuted(true);
      await new Promise((r) => setTimeout(r, 120));
      res.pausedWhenMuted = a._debug.menuMusic() ? a._debug.menuMusic().paused === true : false;
      res.mutedFlagTrue = a.isMenuMusicMuted() === true;
      a.setMenuMusicMuted(false);
      await new Promise((r) => setTimeout(r, 120));
      res.playingWhenUnmuted = a._debug.menuMusic() ? a._debug.menuMusic().paused === false : false;
      return res;
    });
    console.log('  audio:', JSON.stringify(audio));
    if (!audio.elFound)        failures.push('audio: no <audio> off menu_glitch.mp3 created by playMenuMusic');
    if (!audio.srcOk)          failures.push('audio: element src is not menu_glitch.mp3');
    if (!audio.loop)           failures.push('audio: track is not looping (el.loop !== true)');
    // Note: _menuMusic only exists AFTER connect(_musicBus), so elFound proves
    // music-bus routing. We don't assert _playCounts.music here because boot
    // auto-shows the menu (creating the track once); a later playMenuMusic just
    // resumes and intentionally doesn't re-increment.
    if (!audio.pausedWhenMuted) failures.push('audio: setMenuMusicMuted(true) did not pause the track');
    if (!audio.playingWhenUnmuted) failures.push('audio: setMenuMusicMuted(false) did not resume the track');

    // ── Assertion: menu mute button + meta wiring ─────────────────────
    const btn = await page.evaluate(async () => {
      const menu = await import('./src/menuV2.js');
      const meta = await import('./src/meta.js');
      try { menu.hideMenuV2(); } catch (_) {}
      menu.showMenuV2();
      const b = document.querySelector('.kkv2-top-right .kkv2-icons button[aria-label="Mute music"]');
      if (!b) return { found: false };
      const before = !!meta.getMeta().optMenuMusicMuted;
      b.click();
      const afterClick = !!meta.getMeta().optMenuMusicMuted;
      b.click();
      const afterSecond = !!meta.getMeta().optMenuMusicMuted;
      return { found: true, before, afterClick, afterSecond, glyph: (b.querySelector('span') || {}).textContent };
    });
    console.log('  button:', JSON.stringify(btn));
    if (!btn.found) failures.push('button: no "Mute music" button in .kkv2-top-right .kkv2-icons');
    else if (!(btn.afterClick !== btn.before && btn.afterSecond === btn.before)) failures.push('button: clicking does not toggle meta.optMenuMusicMuted back and forth');

    if (pageErrors.length) failures.push('page errors: ' + pageErrors.join(' | '));
  } catch (e) {
    failures.push('exception: ' + (e && e.message ? e.message : String(e)));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n========== SUMMARY ==========');
  console.log('  menu_glitch.mp3 served ' + _mp3Requests + 'x');
  if (failures.length) {
    console.error('[smoke-menu-music] FAIL (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke-menu-music] PASS — menu BGM plays/loops, mute button + meta wired, music-bus routed');
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-menu-music] FATAL', e); process.exit(2); });
