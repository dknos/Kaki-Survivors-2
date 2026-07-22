#!/usr/bin/env node
/** Real-browser smoke for Kaki Rally camera switching and render handoff. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8897);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const SHOTS = Object.freeze({
  isometric: '/tmp/kks-camera-isometric.png',
  chase: '/tmp/kks-camera-chase.png',
  fpv: '/tmp/kks-camera-fpv.png',
  monster: '/tmp/kks-camera-monster-fpv.png',
  trialsSideView: '/tmp/kks-camera-trials-side-view.png',
  trialsTouch: '/tmp/kks-camera-trials-touch.png',
  drawFpv: '/tmp/kks-camera-draw-fpv.png',
});
const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
  const file = path.resolve(ROOT, '.' + relative);
  const within = path.relative(ROOT, file);
  if (within.startsWith('..') || path.isAbsolute(within)) return response.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end('not found');
    response.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
    response.end(data);
  });
});

async function cameraState(page) {
  return page.evaluate(() => {
    const snapshot = window.__kkRacing?.snapshot?.();
    const manager = window.kkState?.racing?.cameraManager;
    const active = manager?.activeCamera;
    const box = document.querySelector('.kkr-camera-cycle')?.getBoundingClientRect();
    return {
      camera: snapshot?.camera,
      activeMatchesRenderer: !!active && window.kkState.camera === active,
      position: active?.position?.toArray?.() || [],
      quaternion: active?.quaternion?.toArray?.() || [],
      hudMode: document.querySelector('.kkr-hud, .kkt-hud')?.dataset.cameraMode,
      buttonText: document.querySelector('.kkr-camera-cycle strong')?.textContent,
      buttonBox: box?.toJSON?.() || null,
      stageBox: document.querySelector('#kk-stage')?.getBoundingClientRect()?.toJSON?.() || null,
      listHidden: document.querySelector('.kkr-camera-list')?.hidden,
    };
  });
}

async function probeCircuitSteering(page, key) {
  await page.evaluate(() => {
    const kart = window.kkState?.racing?.cars?.[0]?.physics;
    if (!kart) throw new Error('player kart missing for steering probe');
    Object.assign(kart, {
      yaw: 0,
      vx: 0,
      vz: 14,
      speed: 14,
      angularVelocity: 0,
      grounded: true,
      drifting: false,
    });
  });
  await page.keyboard.down(key);
  await page.waitForTimeout(280);
  await page.keyboard.up(key);
  return page.evaluate(() => window.kkState.racing.cars[0].physics.yaw);
}

function assertCamera(state, mode, projection) {
  assert(state.camera?.mode === mode, 'expected ' + mode + ', got ' + state.camera?.mode);
  assert(state.camera?.projection === projection, 'expected ' + projection + ', got ' + state.camera?.projection);
  assert(state.activeMatchesRenderer, 'camera manager and renderer disagree on the active camera');
  assert(state.hudMode === mode, 'HUD did not reflect active camera mode');
  assert(state.position.length === 3 && state.position.every(Number.isFinite), 'camera position is invalid');
  assert(state.quaternion.length === 4 && state.quaternion.every(Number.isFinite), 'camera rotation is invalid');
  assert(Math.hypot(...state.position) > 100, 'camera flashed to world origin');
}

async function waitMode(page, mode) {
  try {
    await page.waitForFunction((expected) => {
      const camera = window.__kkRacing?.snapshot?.()?.camera;
      return camera?.mode === expected && camera.transitioning === false;
    }, mode, { timeout: 30000 });
  } catch (error) {
    const current = await cameraState(page);
    throw new Error('timed out waiting for ' + mode + ': ' + JSON.stringify(current), { cause: error });
  }
  return cameraState(page);
}

async function returnToMenu(page) {
  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('#kk-racing-hud'));
}

let browser;
try {
  assert(fs.existsSync(PLAYWRIGHT), 'Playwright missing at ' + PLAYWRIGHT);
  assert(fs.existsSync(CHROMIUM), 'Chromium missing at ' + CHROMIUM);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  const { chromium } = require(PLAYWRIGHT);
  browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route(/fonts\.googleapis\.com/, (route) => route.fulfill({
    status: 200, contentType: 'text/css', body: '',
  }));
  await context.route(/fonts\.gstatic\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], consoleErrors: [], localFailures: [] };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().startsWith(ORIGIN) && response.status() >= 400) {
      diagnostics.localFailures.push(response.status() + ' ' + response.url());
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
    localStorage.setItem('kks_racing_camera_mode_v1', 'isometric');
  });
  await page.goto(ORIGIN + '/index.html?qa=1&cameraSmoke=1&renderer=webgl', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof window.kkStartRacing === 'function', null, { timeout: 90000 });

  await page.evaluate(() => window.kkStartRacing('forest', { mode: 'circuit', carCount: 4 }));
  await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.camera?.mode === 'isometric', null, { timeout: 90000 });
  await page.evaluate(() => window.__kkRacing.skipCountdown());
  await page.waitForTimeout(450);
  const leftYaw = await probeCircuitSteering(page, 'a');
  const rightYaw = await probeCircuitSteering(page, 'd');
  assert(leftYaw > 0.02, 'A/left produced the old right-steer yaw: ' + leftYaw);
  assert(rightYaw < -0.02, 'D/right produced the old left-steer yaw: ' + rightYaw);
  assertCamera(await cameraState(page), 'isometric', 'orthographic');
  const zoomBefore = (await cameraState(page)).camera.zoom;
  await page.evaluate(() => {
    const canvas = window.kkState?.racing?.cameraManager?.input?.canvas;
    canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction((before) => window.__kkRacing?.snapshot?.()?.camera?.zoom < before, zoomBefore);
  const zoomedIn = (await cameraState(page)).camera.zoom;
  assert(zoomedIn >= 0.72 && zoomedIn < zoomBefore, 'wheel-up did not zoom the camera in');
  await page.keyboard.press('Minus');
  await page.waitForFunction((before) => window.__kkRacing?.snapshot?.()?.camera?.zoom > before, zoomedIn);
  await page.screenshot({ path: SHOTS.isometric });

  await page.click('.kkr-camera-cycle');
  assertCamera(await waitMode(page, 'chase'), 'chase', 'perspective');
  await page.evaluate(() => window.__kkRacing.showState('drift'));
  await page.waitForTimeout(220);
  const chase = await cameraState(page);
  assert(chase.camera?.collision?.candidates > 0, 'Chase collision boom has no scenery candidates');
  await page.screenshot({ path: SHOTS.chase });

  await page.click('.kkr-camera-cycle');
  const fpv = await waitMode(page, 'driver_fpv');
  assertCamera(fpv, 'driver_fpv', 'perspective');
  assert(fpv.camera.visionStage, 'FPV did not publish its one-stage-ahead vision state');
  assert(fpv.camera.lookAheadMeters >= 10, 'FPV look-ahead distance is invalid');
  await page.keyboard.down('b');
  await page.waitForTimeout(80);
  await page.keyboard.up('b');
  await page.keyboard.press('v');
  await page.screenshot({ path: SHOTS.fpv });

  await page.keyboard.press('c');
  await page.waitForTimeout(120);
  assertCamera(await cameraState(page), 'driver_fpv', 'perspective');
  await page.click('.kkr-camera-cycle');
  assertCamera(await waitMode(page, 'isometric'), 'isometric', 'orthographic');
  await page.click('.kkr-camera-cycle');
  assertCamera(await waitMode(page, 'chase'), 'chase', 'perspective');
  await page.dispatchEvent('.kkr-camera-cycle', 'pointerdown', {
    pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
  });
  await page.waitForFunction(() => document.querySelector('.kkr-camera-list')?.hidden === false, null, { timeout: 30000 });
  assert((await cameraState(page)).listHidden === false, 'camera long-press did not open the mode list');
  await page.dispatchEvent('.kkr-camera-cycle', 'pointerup', {
    pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0,
  });
  await page.dispatchEvent('[data-camera-mode="isometric"]', 'click');
  assertCamera(await waitMode(page, 'isometric'), 'isometric', 'orthographic');

  await returnToMenu(page);
  await page.evaluate(() => window.kkStartRacing('kakiland', {
    mode: 'monster', monsterVehicle: 'cyber', monsterArena: 'crown-chaos-coliseum',
  }));
  await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.raceMode === 'monster', null, { timeout: 90000 });
  await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.phase === 'countdown', null, { timeout: 30000 });
  assertCamera(await cameraState(page), 'isometric', 'orthographic');
  assert(await page.evaluate(() => window.kkState?.racing?.cars?.[0]?.visual?.root?.visible === true),
    'Monster truck is hidden in isometric during countdown');
  await page.evaluate(() => window.__kkRacing.setCameraMode('chase'));
  assertCamera(await waitMode(page, 'chase'), 'chase', 'perspective');
  assert(await page.evaluate(() => window.kkState?.racing?.cars?.[0]?.visual?.root?.visible === true),
    'Monster truck is hidden in chase during countdown');
  try {
    await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.phase === 'racing', null, { timeout: 12000 });
  } catch (error) {
    const stalled = await page.evaluate(() => ({
      snapshot: window.__kkRacing?.snapshot?.(),
      countdown: window.kkState?.racing?.countdown,
      rootVisible: window.kkState?.racing?.cars?.[0]?.visual?.root?.visible,
    }));
    throw new Error('Monster countdown stalled: ' + JSON.stringify(stalled), { cause: error });
  }
  await page.evaluate(() => {
    window.__kkRacing.setCameraMode('driver_fpv');
    window.__kkRacing.showMonsterJump();
  });
  await page.waitForTimeout(400);
  const monster = await cameraState(page);
  assertCamera(monster, 'driver_fpv', 'perspective');
  assert(monster.camera.available.length === 3, 'Monster Smash should expose all three cameras');
  await page.screenshot({ path: SHOTS.monster });
  await page.evaluate(() => window.__kkRacing.setCameraMode('isometric'));
  const monsterIso = await waitMode(page, 'isometric');
  assertCamera(monsterIso, 'isometric', 'orthographic');
  assert(await page.evaluate(() => window.kkState?.racing?.cars?.[0]?.visual?.root?.visible === true),
    'Monster truck stayed hidden after leaving Driver FPV for isometric');
  await page.evaluate(() => window.__kkRacing.setCameraMode('chase'));
  const monsterChase = await waitMode(page, 'chase');
  assertCamera(monsterChase, 'chase', 'perspective');
  assert(await page.evaluate(() => window.kkState?.racing?.cars?.[0]?.visual?.root?.visible === true),
    'Monster truck stayed hidden after leaving Driver FPV for chase');

  await returnToMenu(page);
  await page.evaluate(() => window.kkStartRacing('forest', {
    mode: 'trials', trialsTrackId: 'meadow', trialsVehicle: 'buggy',
  }));
  await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.raceMode === 'trials', null, { timeout: 90000 });
  await page.evaluate(() => window.__kkRacing.skipCountdown());
  let trials = await cameraState(page);
  assert(trials.camera.available.join(',') === 'isometric,chase', 'Trials camera availability is wrong');
  assertCamera(trials, 'isometric', 'orthographic');
  assert(trials.buttonText === 'SIDE VIEW', 'Trials did not expose the dedicated side-view camera label');
  await page.screenshot({ path: SHOTS.trialsSideView });
  const refusedFpv = await page.evaluate(() => window.__kkRacing.setCameraMode('driver_fpv'));
  assert(refusedFpv === false, 'Trials incorrectly accepted Driver FPV');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.click('.kkr-camera-cycle');
  trials = await waitMode(page, 'chase');
  assertCamera(trials, 'chase', 'perspective');
  assert(trials.buttonBox && trials.stageBox, 'touch camera button is not rendered');
  assert(trials.buttonBox.left >= trials.stageBox.left - 1 && trials.buttonBox.right <= trials.stageBox.right + 1, 'touch camera button escaped the stage');
  await page.screenshot({ path: SHOTS.trialsTouch });

  await returnToMenu(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.kkStartRacing('forest', {
    mode: 'draw',
    carCount: 4,
    customCourse: {
      id: 'forest',
      customTrackId: 'camera-smoke-loop',
      isDrawTrack: true,
      name: 'Camera Smoke Loop',
      tagline: 'Deterministic browser camera QA circuit',
      laps: 1,
      trackWidth: 10,
      drawSizeId: 'grand',
      drawWidthId: 'standard',
      drawDirection: 'forward',
      drawStats: { length: 310, personality: 'FLOWING QA LOOP' },
      points: [
        [-46, -18], [-24, -42], [12, -44], [45, -20], [48, 18],
        [20, 44], [-18, 43], [-46, 17],
      ],
      rampFractions: [0.18],
      boostFractions: [0.5],
      repairFractions: [0.82],
    },
    customTrack: { id: 'camera-smoke-loop', name: 'Camera Smoke Loop', widthId: 'standard' },
  }));
  try {
    await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.raceMode === 'draw', null, { timeout: 90000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      mode: window.kkState?.mode,
      started: window.kkState?.started,
      hasRacing: !!window.kkState?.racing,
      snapshot: window.__kkRacing?.snapshot?.() || null,
    }));
    throw new Error('custom circuit did not start: ' + JSON.stringify({ state, diagnostics }), { cause: error });
  }
  await page.evaluate(() => {
    window.__kkRacing.skipCountdown();
    window.__kkRacing.setCameraMode('driver_fpv');
  });
  await page.waitForFunction(() => {
    const snapshot = window.__kkRacing?.snapshot?.();
    return snapshot?.raceMode === 'draw'
      && snapshot?.camera?.mode === 'driver_fpv'
      && snapshot?.camera?.projection === 'perspective'
      && !!snapshot?.camera?.visionStage;
  }, null, { timeout: 30000 });
  const draw = await cameraState(page);
  assertCamera(draw, 'driver_fpv', 'perspective');
  assert(draw.camera.available.join(',') === 'isometric,chase,driver_fpv', 'custom circuit lost a racing camera mode');
  assert(draw.camera.lookAheadMeters >= 10, 'custom circuit did not bind FPV racing vision');
  await page.screenshot({ path: SHOTS.drawFpv });

  assert(diagnostics.pageErrors.length === 0, 'page errors: ' + diagnostics.pageErrors.join(' | '));
  assert(diagnostics.localFailures.length === 0, 'local failures: ' + diagnostics.localFailures.join(' | '));
  const productionErrors = diagnostics.consoleErrors.filter((message) => !/favicon|autoplay|AudioContext|Failed to load resource: net::ERR_(?:TIMED_OUT|ABORTED)/i.test(message));
  assert(productionErrors.length === 0, 'console errors: ' + productionErrors.join(' | '));
  for (const file of Object.values(SHOTS)) {
    assert(fs.statSync(file).size > 10000, 'screenshot is unexpectedly small: ' + file);
  }
  console.log('Kaki Rally camera browser smoke passed');
  console.log(Object.values(SHOTS).join('\n'));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
