#!/usr/bin/env node
/**
 * Settings -> Dev -> Unlock All Levels browser smoke.
 *
 * Exercises the shipped controls and chapter cards, not internal shortcuts:
 *   1. Clean campaign profile renders 1/6 chapters unlocked (Forest only).
 *   2. Settings -> Dev -> Unlock All Levels renders 6/6 without changing any
 *      campaign unlock flag.
 *   3. Kaki Land can be selected while the preview bypass is active.
 *   4. Turning the same toggle off restores 1/6 locks and safely selects Forest.
 *
 * Run: node tools/smoke-dev-stage-unlock.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8831);
const BOOT_TIMEOUT_MS = 60000;
const UI_TIMEOUT_MS = 15000;
const PLAY_PATH = '/home/nemoclaw/node_modules/playwright';
const PLAYWRIGHT_EXEC = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

function mime(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.wav')) return 'audio/wav';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(String(req.url || '/').split('?')[0]); }
  catch (_) { res.writeHead(400); res.end('bad request'); return; }
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': mime(full), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function allFalse(record) {
  return Object.values(record).every((value) => value === false);
}

async function menuSnapshot(page) {
  return page.evaluate(async () => {
    const metaApi = await import('./src/meta.js');
    const { STAGES } = await import('./src/config.js');
    const meta = metaApi.getMeta();
    const campaignFlagNames = [...new Set(STAGES.map((stage) => stage.unlock).filter(Boolean))];
    const campaignFlags = Object.fromEntries(campaignFlagNames.map((key) => [key, !!meta[key]]));
    let persisted = {};
    try { persisted = JSON.parse(localStorage.getItem('kk-survivors-meta-v2') || '{}'); }
    catch (_) { persisted = {}; }

    const cards = [...document.querySelectorAll('.kkv2-chap')].map((card) => ({
      id: card.dataset.stage || '',
      locked: card.classList.contains('is-locked'),
      selected: card.classList.contains('is-selected'),
    }));
    return {
      stageIds: STAGES.map((stage) => stage.id),
      cards,
      unlockedIds: cards.filter((card) => !card.locked).map((card) => card.id),
      lockedIds: cards.filter((card) => card.locked).map((card) => card.id),
      selectedCardIds: cards.filter((card) => card.selected).map((card) => card.id),
      railCount: (document.querySelector('.kkv2-rail-count')?.textContent || '').trim(),
      selectedStage: meta.selectedStage,
      resolvedStage: metaApi.selectedStage(STAGES).id,
      override: !!meta.optDevUnlockAllLevels,
      campaignFlags,
      persistedOverride: !!persisted.optDevUnlockAllLevels,
      persistedCampaignFlags: Object.fromEntries(
        campaignFlagNames.map((key) => [key, !!persisted[key]]),
      ),
    };
  });
}

function assertBaseline(snapshot, label) {
  assert.deepEqual(snapshot.stageIds, ['forest', 'twilight', 'cinder', 'void', 'cave', 'kakiland'], `${label}: unexpected stage config`);
  assert.equal(snapshot.cards.length, 6, `${label}: expected six chapter cards`);
  assert.deepEqual(snapshot.unlockedIds, ['forest'], `${label}: Forest should be the only unlocked chapter`);
  assert.deepEqual(snapshot.lockedIds, ['twilight', 'cinder', 'void', 'cave', 'kakiland'], `${label}: five campaign chapters should be locked`);
  assert.match(snapshot.railCount, /^6 chapters\s*·\s*1 unlocked$/i, `${label}: rail count should read 1 unlocked`);
  assert.equal(snapshot.override, false, `${label}: developer override should be false`);
  assert.equal(snapshot.persistedOverride, false, `${label}: persisted developer override should be false`);
  assert.ok(allFalse(snapshot.campaignFlags), `${label}: campaign flags changed: ${JSON.stringify(snapshot.campaignFlags)}`);
  assert.ok(allFalse(snapshot.persistedCampaignFlags), `${label}: persisted campaign flags changed: ${JSON.stringify(snapshot.persistedCampaignFlags)}`);
}

async function openDevSettings(page) {
  await page.locator('button.kkv2-iconbtn[aria-label="Settings"]').click();
  const dialog = page.getByRole('dialog', { name: 'Options', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: UI_TIMEOUT_MS });
  const devTab = dialog.getByRole('tab', { name: 'Dev', exact: true });
  await devTab.click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => {
      const dialogEl = document.querySelector('[role="dialog"][aria-label="Options"]');
      return !!dialogEl && [...dialogEl.querySelectorAll('span')]
        .some((el) => el.textContent?.trim() === 'Unlock All Levels');
    }, null, { timeout: UI_TIMEOUT_MS });
  }, 'Dev tab did not expose Unlock All Levels');
  return dialog;
}

async function main() {
  if (!fs.existsSync(PLAY_PATH)) throw new Error(`Playwright not found at ${PLAY_PATH}; smoke never installs dependencies`);
  if (!fs.existsSync(PLAYWRIGHT_EXEC)) throw new Error(`Chromium not found at ${PLAYWRIGHT_EXEC}`);

  let browser;
  const failures = [];
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
    console.log(`[smoke-dev-stage-unlock] server http://127.0.0.1:${PORT}`);

    const { chromium } = require(PLAY_PATH);
    browser = await chromium.launch({
      executablePath: PLAYWRIGHT_EXEC,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // Avoid unrelated first-run overlays while keeping a fresh, isolated meta save.
    await page.addInitScript(() => {
      localStorage.removeItem('kk-survivors-meta-v1');
      localStorage.removeItem('kk-survivors-meta-v2');
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
    });

    await page.goto(`http://127.0.0.1:${PORT}/index.html?smoke=dev-stage-unlock`, {
      waitUntil: 'load', timeout: BOOT_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => !!window.kkState && typeof window.kkStartRun === 'function' && document.querySelectorAll('.kkv2-chap').length === 6,
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );

    // Deterministic clean campaign setup. The transitions below use only the
    // actual Settings toggle and chapter-card click targets.
    await page.evaluate(async () => {
      const metaApi = await import('./src/meta.js');
      const { STAGES } = await import('./src/config.js');
      const menu = await import('./src/menuV2.js');
      metaApi.resetMeta();
      for (const key of new Set(STAGES.map((stage) => stage.unlock).filter(Boolean))) {
        metaApi.setOption(key, false);
      }
      metaApi.setOption('optDevUnlockAllLevels', false);
      metaApi.setOption('selectedStage', 'forest');
      if (menu.isMenuV2Open()) menu.refreshMenuV2();
      else menu.showMenuV2();
    });
    await page.waitForFunction(() => document.querySelectorAll('.kkv2-chap.is-locked').length === 5, null, { timeout: UI_TIMEOUT_MS });

    const baseline = await menuSnapshot(page);
    assertBaseline(baseline, 'baseline');
    assert.deepEqual(baseline.selectedCardIds, ['forest'], 'baseline: Forest card should be selected');
    assert.equal(baseline.selectedStage, 'forest', 'baseline: meta selectedStage should be Forest');
    assert.equal(baseline.resolvedStage, 'forest', 'baseline: selectedStage() should resolve Forest');
    console.log('[smoke-dev-stage-unlock] baseline OK:', baseline.railCount);

    // Actual Settings -> Dev -> Unlock All Levels click.
    let dialog = await openDevSettings(page);
    let toggle = dialog.getByRole('button', { name: 'Progression', exact: true });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'toggle should begin off');
    await toggle.click();
    await page.waitForFunction(async () => {
      const { getMeta } = await import('./src/meta.js');
      return getMeta().optDevUnlockAllLevels === true
        && document.querySelectorAll('.kkv2-chap').length === 6
        && document.querySelectorAll('.kkv2-chap.is-locked').length === 0;
    }, null, { timeout: UI_TIMEOUT_MS });

    const enabled = await menuSnapshot(page);
    assert.equal(enabled.override, true, 'enabled: developer override should be true');
    assert.equal(enabled.persistedOverride, true, 'enabled: developer override should persist');
    assert.deepEqual(enabled.unlockedIds, enabled.stageIds, 'enabled: all six cards should be unlocked');
    assert.deepEqual(enabled.lockedIds, [], 'enabled: no chapter card should remain locked');
    assert.match(enabled.railCount, /^6 chapters\s*·\s*6 unlocked$/i, 'enabled: rail count should read 6 unlocked');
    assert.ok(allFalse(enabled.campaignFlags), `enabled: campaign flags mutated: ${JSON.stringify(enabled.campaignFlags)}`);
    assert.deepEqual(enabled.campaignFlags, baseline.campaignFlags, 'enabled: campaign flags must exactly match baseline');
    assert.deepEqual(enabled.persistedCampaignFlags, baseline.persistedCampaignFlags, 'enabled: persisted campaign flags must exactly match baseline');
    console.log('[smoke-dev-stage-unlock] toggle on OK:', enabled.railCount, enabled.campaignFlags);

    // Close Settings and use the actual newly-unlocked final-chapter card.
    await dialog.locator('button[aria-label="Close options"]').click();
    await dialog.waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS });
    await page.locator('.kkv2-chap[data-stage="kakiland"]').click();
    await page.waitForFunction(async () => {
      const { getMeta } = await import('./src/meta.js');
      return getMeta().selectedStage === 'kakiland'
        && document.querySelector('.kkv2-chap[data-stage="kakiland"]')?.classList.contains('is-selected');
    }, null, { timeout: UI_TIMEOUT_MS });
    const kakiSelected = await menuSnapshot(page);
    assert.equal(kakiSelected.selectedStage, 'kakiland', 'enabled: clicking Kaki Land should update meta selection');
    assert.deepEqual(kakiSelected.selectedCardIds, ['kakiland'], 'enabled: Kaki Land should be the selected card');
    assert.equal(kakiSelected.resolvedStage, 'kakiland', 'enabled: selectedStage() should resolve Kaki Land');
    console.log('[smoke-dev-stage-unlock] Kaki Land selection OK');

    // Reopen the actual Dev tab and turn the same toggle off.
    dialog = await openDevSettings(page);
    toggle = dialog.getByRole('button', { name: 'Unlocked', exact: true });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'toggle should reflect its enabled state after reopening Settings');
    await toggle.click();
    await page.waitForFunction(async () => {
      const { getMeta } = await import('./src/meta.js');
      return getMeta().optDevUnlockAllLevels === false
        && getMeta().selectedStage === 'forest'
        && document.querySelectorAll('.kkv2-chap.is-locked').length === 5
        && document.querySelector('.kkv2-chap[data-stage="forest"]')?.classList.contains('is-selected');
    }, null, { timeout: UI_TIMEOUT_MS });

    const restored = await menuSnapshot(page);
    assertBaseline(restored, 'restored');
    assert.deepEqual(restored.campaignFlags, baseline.campaignFlags, 'restored: campaign flags must exactly match baseline');
    assert.deepEqual(restored.persistedCampaignFlags, baseline.persistedCampaignFlags, 'restored: persisted campaign flags must exactly match baseline');
    assert.equal(restored.selectedStage, 'forest', 'restored: locked Kaki Land selection should fall back to Forest');
    assert.equal(restored.resolvedStage, 'forest', 'restored: selectedStage() should resolve Forest');
    assert.deepEqual(restored.selectedCardIds, ['forest'], 'restored: Forest card should be selected');
    console.log('[smoke-dev-stage-unlock] toggle off OK:', restored.railCount, 'selection=' + restored.selectedStage);

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
    await context.close();
  } catch (error) {
    failures.push(error && error.stack ? error.stack : String(error));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  if (failures.length) {
    console.error('\n[smoke-dev-stage-unlock] FAIL');
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log('\n[smoke-dev-stage-unlock] PASS — 1/6 -> 6/6 -> 1/6, campaign flags preserved, Kaki Land selection restored to Forest');
}

main().catch((error) => {
  console.error('[smoke-dev-stage-unlock] FATAL', error);
  process.exit(2);
});
