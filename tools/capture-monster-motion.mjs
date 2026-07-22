#!/usr/bin/env node
/** Motion-first Monster Arena QA: frame sequences plus one browser video. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('/home/nemoclaw/node_modules/playwright');
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const PORT = Number(process.env.PORT || 8896);
const OUTPUT = process.env.MONSTER_MOTION_DIR || '/tmp/kks-monster-motion';
const VIDEO_DIR = path.join(OUTPUT, 'video-source');
fs.mkdirSync(VIDEO_DIR, { recursive: true });

function mime(file) {
  if (/\.m?js$/.test(file)) return 'application/javascript';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.glb')) return 'model/gltf-binary';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.png')) return 'image/png';
  if (/\.jpe?g$/.test(file)) return 'image/jpeg';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

const server = process.env.MONSTER_BASE_URL ? null : http.createServer((request, response) => {
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

const baseUrl = process.env.MONSTER_BASE_URL || `http://127.0.0.1:${PORT}`;

async function frames(page, label, count, interval = 80) {
  const directory = path.join(OUTPUT, label);
  fs.mkdirSync(directory, { recursive: true });
  const states = [];
  for (let index = 0; index < count; index += 1) {
    await page.screenshot({
      path: path.join(directory, `${String(index).padStart(3, '0')}.jpg`),
      type: 'jpeg',
      quality: 68,
    });
    states.push(await page.evaluate(() => window.__kkRacing?.snapshot?.()));
    await page.waitForTimeout(interval);
  }
  return states;
}

async function startArena(page, arena, vehicle = 'meowster') {
  await page.evaluate(({ arena, vehicle }) => window.kkStartRacing('forest', {
    mode: 'monster',
    monsterArena: arena,
    monsterVehicle: vehicle,
    monsterEvent: 'free-ride',
  }), { arena, vehicle });
  await page.waitForFunction(({ arena, vehicle }) => {
    const snapshot = window.__kkRacing?.snapshot?.();
    return snapshot?.arenaId === arena && snapshot.monster?.vehicleId === vehicle && snapshot.monster.modelAttached;
  }, { arena, vehicle }, { timeout: 90000 });
  await page.evaluate(() => window.__kkRacing.skipCountdown());
  await page.waitForTimeout(500);
}

async function main() {
  if (server) await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
  });
  await page.goto(`${baseUrl}/index.html?qa=1&motion=1`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof window.kkStartRacing === 'function');
  await startArena(page, 'crown-chaos-coliseum', 'meowster');

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  const steering = await frames(page, '01-steering-suspension', 10, 75);
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');

  await page.evaluate(() => window.__kkRacing.warpToMonsterTarget(0));
  const crush = await frames(page, '02-two-axle-crush', 12, 75);

  await page.evaluate(() => window.__kkRacing.showMonsterJump());
  const jump = await frames(page, '03-takeoff-flight-landing', 18, 75);
  await page.keyboard.press('KeyR');
  const recovery = await frames(page, '04-recovery', 7, 75);

  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing);
  await startArena(page, 'pileup-pyramid-yard', 'cyber');
  await page.evaluate(() => window.__kkRacing.collapseMonsterStructure('car-pyramid'));
  const collapse = await frames(page, '05-pyramid-collapse', 18, 85);

  const report = {
    steeringGroundContactCounts: [...new Set(steering.map((state) => state?.monster?.vehicleContact?.grounded))],
    crushDestroyed: Math.max(...crush.map((state) => state?.monster?.destruction?.destroyed || 0)),
    jumpAirborneFrames: jump.filter((state) => state?.airborne).length,
    jumpPredictorFrames: jump.filter((state) => state?.monster?.landingPredictorVisible).length,
    recoveryFrames: recovery.length,
    collapseImpacts: Math.max(...collapse.map((state) => state?.monster?.destruction?.collapseImpacts || 0)),
    errors,
  };
  if (report.jumpAirborneFrames < 3) throw new Error('motion capture did not retain a readable airborne sequence');
  if (report.collapseImpacts < 1) throw new Error('motion capture did not observe a structural collapse impact');
  if (errors.length) throw new Error(`browser errors during motion capture: ${errors.join(' | ')}`);

  await context.close();
  await browser.close();
  const video = fs.readdirSync(VIDEO_DIR)
    .filter((file) => file.endsWith('.webm'))
    .sort((a, b) => fs.statSync(path.join(VIDEO_DIR, b)).mtimeMs - fs.statSync(path.join(VIDEO_DIR, a)).mtimeMs)[0];
  if (video) fs.renameSync(path.join(VIDEO_DIR, video), path.join(OUTPUT, 'monster-arena-motion.webm'));
  fs.writeFileSync(path.join(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', output: OUTPUT, video: path.join(OUTPUT, 'monster-arena-motion.webm'), ...report }, null, 2));
  if (server) await new Promise((resolve) => server.close(resolve));
}

main().catch(async (error) => {
  console.error(`[capture-monster-motion] FAIL: ${error.stack || error.message}`);
  if (server) server.close();
  process.exitCode = 1;
});
