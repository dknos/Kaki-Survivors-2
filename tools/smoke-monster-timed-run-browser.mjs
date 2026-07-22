#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const PORT = Number(process.env.PORT || 8898);

function mime(file) {
  if (/\.m?js$/.test(file)) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(file)) return 'image/jpeg';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  if (file.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

const server = http.createServer((request, response) => {
  let relative = decodeURIComponent(request.url.split('?')[0]);
  if (relative === '/') relative = '/index.html';
  const file = path.resolve(ROOT, `.${relative}`);
  const within = path.relative(ROOT, file);
  if (within.startsWith('..') || path.isAbsolute(within)) return response.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end('not found');
    response.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
    response.end(data);
  });
});

async function main() {
  assert.ok(fs.existsSync(PLAYWRIGHT), `Playwright missing: ${PLAYWRIGHT}`);
  assert.ok(fs.existsSync(CHROMIUM), `Chromium missing: ${CHROMIUM}`);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--disable-gpu-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('kks_introSeen', '1');
      localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
      localStorage.removeItem('kks_rally_best_v1');
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?qa=1&smoke=1`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => typeof window.kkStartRacing === 'function', null, { timeout: 90000 });
    await page.evaluate(() => window.kkStartRacing('forest', {
      mode: 'monster',
      monsterVehicle: 'meowster',
      monsterArena: 'pileup-pyramid-yard',
      monsterEvent: 'smashdown',
    }));
    await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.monster?.round === 1, null, { timeout: 45000 });
    await page.evaluate(() => window.__kkRacing.skipCountdown());
    await page.waitForTimeout(250);

    const opening = await page.evaluate(() => {
      const snapshot = window.__kkRacing.snapshot();
      const overflow = ['.kkr-position strong', '.kkr-lap strong', '.kkr-lap .kkr-label', '.kkr-timer']
        .filter((selector) => {
          const element = document.querySelector(selector);
          return element && element.scrollWidth > element.clientWidth + 1;
        });
      return {
        snapshot,
        totalTime: document.querySelector('.kkr-position strong')?.textContent || '',
        levelClock: document.querySelector('.kkr-lap strong')?.textContent || '',
        targetPrompt: document.querySelector('.kkr-timer')?.textContent || '',
        spotlight: document.querySelector('.kkr-spotlight')?.textContent || '',
        timePickup: !!window.kkState.racing.root.getObjectByName('monster-time-extension'),
        overflow,
      };
    });
    assert.equal(opening.snapshot.monster.round, 1);
    assert.equal(opening.snapshot.monster.roundTime, Infinity,
      `Smashdown level did not start with unlimited time: ${opening.snapshot.monster.roundTime}`);
    assert.ok(opening.snapshot.monster.runTime > 0 && opening.totalTime.startsWith('0:00.'),
      `total speedrun clock is missing: ${JSON.stringify(opening)}`);
    assert.equal(opening.levelClock, '∞', 'unlimited-time indicator is missing');
    assert.ok(opening.targetPrompt.includes('TO CRUSH'), 'clear-all-cars objective is missing');
    assert.equal(opening.spotlight, '', 'Smashdown still exposes a side-objective Spotlight');
    assert.equal(opening.timePickup, false, 'Smashdown still creates a clock-extension pickup');
    assert.deepEqual(opening.overflow, [], `timed HUD clips at 1280x720: ${opening.overflow.join(', ')}`);

    for (let level = 0; level < 5; level += 1) {
      await page.evaluate(() => {
        const session = window.kkState.racing;
        const active = new Set(session.monsterRounds.rounds[session.monsterRounds.index].targetIds);
        for (const target of session.monsterArena.targets) {
          if (active.has(target.id)) target.destroyed = true;
        }
      });
      if (level < 4) {
        await page.waitForFunction((currentLevel) => {
          const session = window.kkState?.racing;
          return session?.phase === 'round-transition' && session.monsterRounds?.index === currentLevel;
        }, level, { timeout: 10000 });
        await page.evaluate(() => { window.kkState.racing.monsterRounds.transitionTime = 0; });
        await page.waitForFunction((nextLevel) => {
          const session = window.kkState?.racing;
          return session?.phase === 'racing' && session.monsterRounds?.index === nextLevel;
        }, level + 1, { timeout: 10000 });
        const reset = await page.evaluate(() => window.__kkRacing.snapshot().monster);
        assert.equal(reset.roundTime, Infinity,
          `level ${level + 2} did not retain unlimited time: ${reset.roundTime}`);
      } else {
        await page.waitForSelector('.kkr-finish:not([hidden])', { timeout: 5000 });
      }
    }

    const complete = await page.evaluate(() => {
      const snapshot = window.__kkRacing.snapshot();
      const key = `monster-speedrun-v1:${snapshot.arenaId}`;
      return {
        snapshot,
        result: document.querySelector('.kkr-finish-pos')?.textContent || '',
        summary: document.querySelector('.kkr-finish-time')?.textContent || '',
        best: JSON.parse(localStorage.getItem('kks_rally_best_v1') || '{}')[key] || 0,
      };
    });
    assert.equal(complete.snapshot.monster.roundTimes.length, 5, 'clear did not record five level splits');
    assert.ok(complete.snapshot.monster.roundTimes.every((time) => time > 0),
      `invalid level splits: ${JSON.stringify(complete.snapshot.monster.roundTimes)}`);
    assert.ok(['S', 'A', 'B', 'C', 'D'].includes(complete.snapshot.monster.rank));
    assert.ok(/^[SABCD] · /.test(complete.result), `results are not completion-time ranked: ${complete.result}`);
    assert.ok(complete.summary.includes('5 / 5 LEVELS'), `results omit five-level completion: ${complete.summary}`);
    assert.ok(complete.best > 0 && Math.abs(complete.best - complete.snapshot.monster.runTime) < 0.1,
      'lower-is-better personal best was not persisted');

    await page.setViewportSize({ width: 571, height: 349 });
    await page.waitForTimeout(100);
    const compactOverflow = await page.evaluate(() => ['.kkr-finish-card', '.kkr-finish-pos', '.kkr-finish-time']
      .filter((selector) => {
        const element = document.querySelector(selector);
        return element && (element.scrollWidth > element.clientWidth + 3 || element.scrollHeight > element.clientHeight + 3);
      }));
    assert.deepEqual(compactOverflow, [], `compact timed results clip: ${compactOverflow.join(', ')}`);
    assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
    console.log(`Monster unlimited Smashdown browser smoke passed: ${complete.snapshot.monster.runTime.toFixed(3)}s, ${complete.snapshot.monster.rank} rank, five splits, PB verified`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`[smoke-monster-timed-run-browser] FAIL: ${error.stack || error}`);
  process.exitCode = 1;
});
