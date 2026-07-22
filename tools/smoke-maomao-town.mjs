#!/usr/bin/env node
/** End-to-end MaoMao rescue → care → yarn → outfit smoke. */
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const require = createRequire(import.meta.url);
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function mime(p) {
  if (/\.m?js$/.test(p)) return 'application/javascript';
  if (p.endsWith('.html')) return 'text/html';
  if (p.endsWith('.css')) return 'text/css';
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.ogg')) return 'audio/ogg';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function main() {
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAY_PATH);
  const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Typography is not under test and CI/network sandboxes can stall Google
  // Fonts long enough to emit a console error after every gameplay assertion
  // has already passed. Fulfil the stylesheet locally; system fallbacks still
  // exercise the exact cross-platform glyph path this smoke protects.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/css', body: '',
  }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    const text = m.text();
    const externalResourceNoise = /Failed to load resource: net::ERR_(?:TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|BLOCKED_BY_CLIENT)/.test(text);
    if (m.type() === 'error' && !externalResourceNoise) errors.push(text);
  });
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(`http://127.0.0.1:${PORT}/`)) {
      const reason = request.failure()?.errorText || '';
      // Changing scenes intentionally replaces the menu music element. Chrome
      // reports the cancelled media fetch as ERR_ABORTED even though the next
      // gameplay track and every local asset loaded successfully.
      const cancelledMedia = reason === 'net::ERR_ABORTED'
        && /\.(?:mp3|ogg)(?:\?|$)/i.test(request.url());
      if (!cancelledMedia) errors.push(`local request failed: ${request.url()} ${reason}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().startsWith(`http://127.0.0.1:${PORT}/`) && response.status() >= 400) {
      errors.push(`local HTTP ${response.status()}: ${response.url()}`);
    }
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem('kk-survivors-meta-v2', JSON.stringify({
        version: 1, migrationVersion: 2, runs: 1, selectedAvatar: 'kitty', selectedStage: 'forest',
        daycare: { rescued: false, happiness: 0, careTotal: 0, unlockedOutfits: [], equippedOutfit: null },
      }));
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=1`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof window.kkEnterTown === 'function', null, { timeout: 60000 });
    await page.evaluate(() => window.kkEnterTown());
    await page.waitForFunction(() => window.kkMaoMaoDebug?.().catVisible === true);

    let d = await page.evaluate(() => window.kkMaoMaoDebug());
    assert(d.pet.encounterUnlocked && !d.pet.adopted && d.pet.rescueStep === 0, 'initial encounter state wrong');
    assert(d.footprintVisible && d.purpose === 'virtual-pet-rescue-and-daycare-resident', 'purposeful trail missing');
    await page.screenshot({ path: path.join(__dirname, '_thumb_maomao_rescue.png') });

    // Meet MaoMao.
    await page.evaluate(() => { const d = window.kkMaoMaoDebug(); window.kkState.hero.pos.set(d.catPosition.x, 0, d.catPosition.z); });
    await page.waitForTimeout(150);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.kkMaoMaoDebug().pet.rescueStep === 1);

    // Dash through the yarn.
    await page.evaluate(() => { const s = window.kkState; s.hero.pos.set(-18, 0, 8.2); s.hero.dashUntil = s.time.real + 1; });
    await page.waitForFunction(() => window.kkMaoMaoDebug().pet.rescueStep === 2);

    // Jump the ribbon.
    await page.evaluate(() => { const s = window.kkState; s.hero.pos.set(-15.2, 0.55, 12.2); s.hero.velY = 0; s.hero.grounded = false; });
    await page.waitForFunction(() => window.kkMaoMaoDebug().pet.rescueStep === 3);

    // MaoMao returns to the yard; welcome her once she arrives.
    await page.waitForTimeout(4300);
    await page.evaluate(() => { const d = window.kkMaoMaoDebug(); window.kkState.hero.pos.set(d.catPosition.x, 0, d.catPosition.z); });
    await page.waitForTimeout(150);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.kkMaoMaoDebug().pet.adopted === true);
    await page.waitForSelector('#kk-daycare', { state: 'visible', timeout: 10000 });

    // Platform-safe UI art: every interactive/care/status icon is an inline
    // vector, not a color-emoji codepoint that can degrade into a tofu square
    // on Windows, Linux kiosk builds, or the headless release probe.
    const iconKit = await page.evaluate(() => {
      const care = [...document.querySelectorAll('.kkdc-btn[data-care]')];
      const vitals = [...document.querySelectorAll('.kkdc-vital')];
      const outfits = [...document.querySelectorAll('.kkdc-slot .ico')];
      return {
        careButtons: care.length,
        careVectors: care.filter((el) => el.querySelector('svg.kkdc-icon')).length,
        vitalVectors: vitals.filter((el) => el.querySelector('svg.kkdc-icon')).length,
        outfitSlots: outfits.length,
        outfitVectors: outfits.filter((el) => el.querySelector('svg.kkdc-outfit-icon')).length,
        yarnVector: !!document.querySelector('.kkdc-yarnball svg.kkdc-icon'),
        basketVector: !!document.querySelector('.kkdc-basket svg.kkdc-icon'),
      };
    });
    assert(iconKit.careButtons === 4 && iconKit.careVectors === 4,
      'care actions are not fully vector-backed: ' + JSON.stringify(iconKit));
    assert(iconKit.vitalVectors === 3 && iconKit.yarnVector && iconKit.basketVector,
      'Daycare status/minigame vector kit missing: ' + JSON.stringify(iconKit));
    assert(iconKit.outfitSlots >= 4 && iconKit.outfitVectors === iconKit.outfitSlots,
      'outfit shelf still depends on emoji glyphs: ' + JSON.stringify(iconKit));

    // One rewarded round of care, then complete Yarn Pounce.
    for (const action of ['pet', 'feed', 'groom']) await page.locator(`[data-care="${action}"]`).click();
    await page.locator('[data-care="play"]').click();
    await page.waitForTimeout(100);
    const yarnState = await page.evaluate(() => ({
      className: document.querySelector('.kkdc-yarn')?.className,
      display: getComputedStyle(document.querySelector('.kkdc-yarn')).display,
    }));
    if (yarnState.display === 'none') throw new Error('Yarn Pounce did not open: ' + JSON.stringify(yarnState) + ' errors=' + errors.join(' | '));
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => document.querySelector('.kkdc-yarnball')?.click());
      await page.waitForTimeout(45);
    }
    await page.waitForFunction(() => !document.querySelector('.kkdc-yarn')?.classList.contains('open'));
    await page.screenshot({ path: path.join(__dirname, '_thumb_maomao_daycare.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobile = await page.evaluate(() => {
      const root = document.getElementById('kk-daycare');
      const win = root.querySelector('.kkdc-window');
      return { rootW: root.scrollWidth, winW: win.getBoundingClientRect().width, viewport: innerWidth };
    });
    assert(mobile.rootW <= mobile.viewport + 1 && mobile.winW <= mobile.viewport, 'daycare overflows mobile viewport: ' + JSON.stringify(mobile));
    await page.screenshot({ path: path.join(__dirname, '_thumb_maomao_mobile.png') });
    await page.setViewportSize({ width: 1280, height: 720 });

    const pet = await page.evaluate(() => JSON.parse(localStorage.getItem('kk-survivors-meta-v2')).daycare);
    assert(pet.name === 'MaoMao' && pet.adopted, 'MaoMao adoption did not persist');
    assert(pet.happiness >= 39 && pet.bondXp >= 20, 'care/play progression too low or missing');
    assert(pet.yarnBest === 8 && pet.energy === 2, 'Yarn Pounce state wrong');
    assert(pet.unlockedOutfits.includes('beanie'), 'beanie did not unlock from purposeful care');

    await page.getByText('Cozy Beanie', { exact: true }).click();
    await page.locator('.kkdc-close').click();
    await page.waitForTimeout(250);
    d = await page.evaluate(() => window.kkMaoMaoDebug());
    assert(d.pet.equippedOutfit === 'beanie', 'outfit did not persist to town MaoMao');
    await page.screenshot({ path: path.join(__dirname, '_thumb_maomao_adopted.png') });
    await page.evaluate(() => window.kkStartRun());
    await page.waitForFunction(() => window.kkState.mode === 'run' && !!window.kkState.run.outfitBuff, null, { timeout: 60000 });
    // Drive the production DOM sync directly once; SwiftShader can render at
    // only a few frames per second after the town GLTF scene, and the badge is
    // a state-change write rather than an animation contract.
    await page.evaluate(async () => (await import('/src/ui.js')).updateUI());
    await page.waitForFunction(() => {
      const badge = document.querySelector('.kk-outfit-badge');
      return !!(badge && badge.querySelector('svg.kk-outfit-badge-icon')
        && getComputedStyle(badge).display !== 'none');
    }, null, { timeout: 10000 });
    const support = await page.evaluate(() => ({
      buff: window.kkState.run.outfitBuff,
      move: window.kkState.hero.statMul.moveSpeed,
      badgeVector: !!document.querySelector('.kk-outfit-badge svg.kk-outfit-badge-icon'),
      badgeText: document.querySelector('.kk-outfit-badge')?.textContent.trim(),
    }));
    assert(support.buff.cat === 'MaoMao' && support.buff.id === 'beanie', 'MaoMao support HUD descriptor missing');
    assert(Math.abs(support.move - 1.04) < 0.0001, 'bounded +4% beanie perk did not apply');
    assert(support.badgeVector && support.badgeText === support.buff.label,
      'run support badge is not vector-backed: ' + JSON.stringify(support));
    assert(errors.length === 0, 'page errors: ' + errors.join(' | '));
    console.log('[OK] encounter markers are purposeful and visible');
    console.log('[OK] dash + jump rescue and explicit adoption');
    console.log('[OK] run-paced care, Yarn Pounce, Bond, energy, and outfit unlock');
    console.log('[OK] save persistence and zero page errors');
    console.log('[OK] adopted MaoMao support perk applies to a normal Hunt');
    console.log('ALL CHECKS PASS');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(e => { console.error('FAIL:', e.stack || e); try { server.close(); } catch (_) {} process.exit(1); });
