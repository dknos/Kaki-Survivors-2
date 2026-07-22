#!/usr/bin/env node
/** Real-browser lifecycle, physics, accessibility, replay, and cleanup smoke for Kaki Catastrophe. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8894);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const SHOTS = Object.freeze({
  menu: '/tmp/kks-crash-menu.png',
  approach: '/tmp/kks-crash-approach.png',
  fpv: '/tmp/kks-crash-fpv.png',
  impact: '/tmp/kks-crash-first-impact.png',
  pileup: '/tmp/kks-crash-pileup.png',
  replay: '/tmp/kks-crash-replay.png',
  final: '/tmp/kks-crash-final-wreckage.png',
  results: '/tmp/kks-crash-results.png',
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
  if (file.endsWith('.wasm')) return 'application/wasm';
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

function watch(page, diagnostics) {
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(ORIGIN)) diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    if (request.url().startsWith(ORIGIN)) diagnostics.requests.push(request.url());
  });
}

async function capture(page, file) {
  await page.screenshot({ path: file });
  assert(fs.statSync(file).size > 12_000, `screenshot is unexpectedly small: ${file}`);
}

async function boot(page) {
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
  });
  await page.goto(`${ORIGIN}/index.html?qa=crash`, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForFunction(
    () => typeof window.kkStartRacing === 'function' && !!document.querySelector('.kkv2-navitem[data-nav="racing"]'),
    null,
    { timeout: 90_000 },
  );
}

async function openCrashFromMenu(page, { vehicle = 'iron', quality = 'high' } = {}) {
  await page.click('.kkv2-navitem[data-nav="racing"]');
  await page.waitForSelector('.kkv2-race-overlay');
  const cardText = await page.locator('.kkv2-race-card[data-mode="crash"]').innerText();
  assert(cardText.includes('06 · KAKI CATASTROPHE'), 'menu card title is missing');
  assert(cardText.includes('CAUSE THE CHAIN REACTION'), 'menu card promise is missing');
  assert(cardText.includes('SOLO · CRASH SCORE ATTACK'), 'menu card discipline label is missing');
  await page.click('.kkv2-race-card[data-mode="crash"]');
  await page.waitForSelector('.kkv2-crash-setup:not([hidden])');
  await page.click(`[data-crash-vehicle="${vehicle}"]`);
  await page.click(`[data-crash-quality="${quality}"]`);
  await capture(page, SHOTS.menu);
  await page.click('.kkv2-overlay-confirm');
  await page.waitForSelector('.kkc-hud', { timeout: 90_000 });
  await page.waitForFunction(() => {
    const snapshot = window.__kkRacing?.snapshot?.();
    return snapshot?.mode === 'crash' && snapshot.worldReady && snapshot.assetsReady;
  }, null, { timeout: 90_000 });
}

let browser;
const diagnostics = { pageErrors: [], consoleErrors: [], badResponses: [], requests: [] };
try {
  assert(fs.existsSync(PLAYWRIGHT), `Playwright missing at ${PLAYWRIGHT}`);
  assert(fs.existsSync(CHROMIUM), `Chromium missing at ${CHROMIUM}`);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route(/fonts\.googleapis\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(/fonts\.gstatic\.com/, (route) => route.fulfill({ status: 204, body: '' }));
  const page = await context.newPage();
  watch(page, diagnostics);
  await boot(page);
  await openCrashFromMenu(page);

  const ready = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(ready.vehicle === 'iron' && ready.quality === 'high', `setup selection did not reach runtime: ${JSON.stringify(ready)}`);
  assert(ready.physics?.version === '0.19.3', `browser is not running pinned Rapier 0.19.3: ${ready.physics?.version}`);
  assert(ready.physics?.physicalBodies >= 12, `expected player plus physical parked proxies, got ${ready.physics?.physicalBodies}`);
  assert(ready.assetError === '', `crash asset lease failed: ${ready.assetError}`);
  assert(ready.camera?.mode === 'chase', `Catastrophe must default to chase, got ${ready.camera?.mode}`);
  assert(ready.replayMemoryBytes > 500_000 && ready.replayMemoryBytes < 8_000_000, `unexpected replay memory: ${ready.replayMemoryBytes}`);
  await page.waitForFunction(() => document.querySelector('[data-crash-qa-metrics]')?.textContent?.includes('90HZ'));

  await page.evaluate(() => window.__kkCrash.skipIntro());
  try {
    await page.waitForFunction(() => ['APPROACH', 'LIVE_CRASH'].includes(window.__kkCrash.snapshot().phase), null, { timeout: 15_000 });
  } catch (error) {
    const stuck = await page.evaluate(() => ({ snapshot: window.__kkCrash?.snapshot?.(), started: window.kkState?.started, mode: window.kkState?.mode }));
    throw new Error(`Catastrophe did not enter approach: ${JSON.stringify(stuck)}`, { cause: error });
  }
  await page.keyboard.down('a');
  await page.waitForFunction(() => window.kkState.racing?.controls?.steer > 0.5);
  await page.keyboard.up('a');
  await page.keyboard.down('d');
  await page.waitForFunction(() => window.kkState.racing?.controls?.steer < -0.5);
  await page.keyboard.up('d');

  await page.keyboard.down('w');
  await page.waitForFunction(() => window.kkState.racing?.controls?.throttle > 0.9);
  await page.keyboard.up('w');
  const launch = await page.evaluate(() => {
    const session = window.kkState.racing;
    let peakPitch = 0;
    let peakSpeed = 0;
    let minimumFrontContacts = 2;
    let wheelsFinite = true;
    for (let step = 0; step < 175; step++) {
      window.__kkCrash.driveFixedSteps(1, { throttle: 1, steer: 0 });
      const q = session.player.body.rotation();
      const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z - q.w * q.x))));
      peakPitch = Math.max(peakPitch, Math.abs(pitch));
      peakSpeed = Math.max(peakSpeed, session.player.cameraState.speed);
      minimumFrontContacts = Math.min(minimumFrontContacts,
        Number(session.player.vehicleController.wheelIsInContact(0)) + Number(session.player.vehicleController.wheelIsInContact(1)));
      wheelsFinite &&= session.player.wheelVisualBindings.every((wheel) => wheel
        && [...wheel.position.toArray(), ...wheel.quaternion.toArray()].every(Number.isFinite));
    }
    return {
      peakPitch,
      peakSpeed,
      minimumFrontContacts,
      wheelsFinite,
      position: session.player.body.translation(),
      speed: session.player.cameraState.speed,
      colliderViolations: window.__kkCrash.snapshot().traffic.colliderViolations,
    };
  });
  assert(launch.peakPitch < 0.12, `ordinary flat launch pitched ${launch.peakPitch} rad`);
  assert(launch.wheelsFinite, 'ordinary flat launch produced a non-finite wheel mesh transform');
  assert(launch.colliderViolations.length === 0, `visible traffic without colliders: ${launch.colliderViolations.join(', ')}`);
  assert(launch.position.z > -89 && launch.position.z < -55 && launch.peakSpeed > 8, `ordinary controls did not drive from spawn toward the paw gateway: ${JSON.stringify(launch)}`);
  assert((await page.evaluate(() => window.__kkCrash.snapshot().score.vehicles)) === 0, 'approach capture occurred after the first impact');
  await page.evaluate(() => window.__kkCrash.setPaused(true));
  await capture(page, SHOTS.approach);
  assert((await page.evaluate(() => window.__kkCrash.snapshot().score.vehicles)) === 0, 'paused approach capture was contaminated by a background collision');

  assert(await page.evaluate(() => window.__kkRacing.setCameraMode('driver_fpv')), 'FPV camera was rejected');
  await page.waitForFunction(() => {
    const session = window.kkState.racing;
    return window.__kkCrash.snapshot().camera?.mode === 'driver_fpv'
      && session.cameraManager.lastEffects?.cameraMode === 'driver_fpv'
      && session.cameraManager.activeCamera === session.cameraManager.perspectiveCamera;
  });
  await capture(page, SHOTS.fpv);
  const fpvComposition = await page.evaluate(() => {
    const session = window.kkState.racing;
    const camera = session.cameraManager.activeCamera;
    camera.updateMatrixWorld(true);
    session.player.visual.root.updateMatrixWorld(true);
    const project = (name) => {
      let object = null;
      session.player.visual.root.traverse((entry) => { if (!object && entry.name.startsWith(name)) object = entry; });
      return object ? object.getWorldPosition(object.position.clone()).project(camera).toArray() : null;
    };
    const cameraOrigin = camera.getWorldPosition(camera.position.clone());
    const cameraForward = camera.getWorldDirection(camera.position.clone()).normalize();
    const raycaster = session.cameraManager.collision.raycaster;
    raycaster.set(cameraOrigin, cameraForward);
    raycaster.near = 0.04;
    raycaster.far = 4.0;
    const sightlineHits = raycaster.intersectObject(session.player.visual.root, true)
      .filter((hit) => hit.object.visible)
      .map((hit) => ({
        name: hit.object.name,
        role: hit.object.userData?.role || '',
        distance: hit.distance,
      }));
    const probe = (point) => {
      if (!point) return [];
      raycaster.setFromCamera({ x: point[0], y: point[1] }, camera);
      raycaster.near = 0.04;
      raycaster.far = 5.0;
      return raycaster.intersectObject(session.player.visual.root, true)
        .filter((hit) => hit.object.visible)
        .slice(0, 8)
        .map((hit) => ({ name: hit.object.name, role: hit.object.userData?.role || '', distance: hit.distance }));
    };
    const visibility = {};
    session.player.visual.root.traverse((entry) => {
      if (entry.name.startsWith('cockpit-canopy')) visibility.canopy = entry.visible;
      if (entry.name.includes('body-shell')) visibility.bodyShell = entry.visible;
      if (entry.name.startsWith('cockpit-floor')) visibility.floor = entry.visible;
      if (entry.name.startsWith('cockpit-left-sill')) visibility.leftSill = entry.visible;
      if (entry.name.startsWith('cockpit-right-sill')) visibility.rightSill = entry.visible;
    });
    let eyeSocket = null;
    let canopy = null;
    let steeringObject = null;
    session.player.visual.root.traverse((entry) => {
      if (!eyeSocket && entry.name.startsWith('driver-eye-socket')) eyeSocket = entry;
      if (!canopy && entry.name.startsWith('cockpit-canopy')) canopy = entry;
      if (!steeringObject && entry.name.startsWith('steering-wheel')) steeringObject = entry;
    });
    const eyeSocketWorld = eyeSocket?.getWorldPosition(eyeSocket.position.clone()) || null;
    const worldPosition = (object) => object?.getWorldPosition(object.position.clone()).toArray() || null;
    return {
      steering: project('steering-wheel'),
      dashboard: project('dashboard'),
      windshieldTop: project('windshield-frame-top'),
      sightlineHits,
      steeringProbe: probe(project('steering-wheel')),
      dashboardProbe: probe(project('dashboard')),
      eyeSocketDistance: eyeSocketWorld ? camera.position.distanceTo(eyeSocketWorld) : null,
      worldPositions: {
        camera: camera.position.toArray(),
        visualRoot: worldPosition(session.player.visual.root),
        eyeSocket: eyeSocketWorld?.toArray() || null,
        canopy: worldPosition(canopy),
        steering: worldPosition(steeringObject),
        profileEye: { ...session.cameraManager.profile.fpvEyePosition },
      },
      visibility,
    };
  });
  assert(fpvComposition.eyeSocketDistance != null && fpvComposition.eyeSocketDistance < 0.06,
    `FPV camera did not resolve to the fitted authored eye socket: ${JSON.stringify(fpvComposition)}`);
  assert(fpvComposition.steering && Math.abs(fpvComposition.steering[0]) < 0.36
    && fpvComposition.steering[1] > -0.72 && fpvComposition.steering[1] < 0.38,
  `FPV eye is not aligned with the authored steering socket: ${JSON.stringify(fpvComposition)}`);
  assert(fpvComposition.dashboard?.[1] < 0.12 && fpvComposition.windshieldTop?.[1] > 0.22,
    `FPV dashboard/windshield framing is not drivable: ${JSON.stringify(fpvComposition)}`);
  assert(fpvComposition.visibility.bodyShell === true && fpvComposition.visibility.canopy === true,
    `FPV must retain the authored body and cockpit roof: ${JSON.stringify(fpvComposition)}`);
  assert(fpvComposition.visibility.floor === true && fpvComposition.visibility.leftSill === true
    && fpvComposition.visibility.rightSill === true,
  `FPV cabin aperture is missing its authored tub/sills: ${JSON.stringify(fpvComposition)}`);
  const firstOpaqueHit = fpvComposition.sightlineHits.find((hit) => hit.role !== 'glass');
  assert(!firstOpaqueHit || firstOpaqueHit.role === 'cockpit' || firstOpaqueHit.distance >= 2.4,
    `opaque bodywork is the first FPV forward sightline blocker: ${JSON.stringify(fpvComposition)}`);
  assert(await page.evaluate(() => window.__kkRacing.setCameraMode('chase')), 'chase camera was rejected after FPV');
  await page.waitForFunction(() => window.__kkCrash.snapshot().camera?.mode === 'chase');
  await page.evaluate(() => window.__kkCrash.setPaused(false));

  const drivenImpact = await page.evaluate(() => {
    const session = window.kkState.racing;
    let impactStep = -1;
    let closestToBlocker = Infinity;
    const samples = [];
    const queueTarget = session.entityById.get('traffic-05');
    for (let step = 0; step < 2800; step++) {
      const position = session.player.body.translation();
      const velocity = session.player.body.linvel();
      const blockerError = -3.3 - position.z;
      closestToBlocker = Math.min(closestToBlocker, Math.abs(blockerError));
      let throttle = 0;
      let steer = 0;
      let brake = session.trafficClock < 6.7;
      if (!brake) throttle = 1;
      window.__kkCrash.driveFixedSteps(1, {
        throttle,
        steer,
        brake,
        handbrake: false,
      });
      if (step % 140 === 0) {
        const targetPosition = queueTarget?.body?.translation?.();
        samples.push({
          step,
          clock: session.trafficClock,
          x: position.x,
          z: position.z,
          speed: Math.hypot(velocity.x, velocity.z),
          targetX: targetPosition?.x,
          targetZ: targetPosition?.z,
          throttle,
          steer,
          brake,
        });
      }
      if (session.score.participants.size > 0) { impactStep = step; break; }
    }
    return {
      impactStep,
      maneuver: 'ordinary-controls-signal-timed-crossing',
      targetId: queueTarget?.id || '',
      closestToBlocker,
      samples,
      snapshot: window.__kkCrash.snapshot(),
      position: session.player.body.translation(),
      velocity: session.player.body.linvel(),
      traffic: session.traffic.entities.filter((entity) => entity.active && entity.body).map((entity) => ({ id: entity.id, classId: entity.classId, dynamic: entity.dynamic, position: entity.body.translation(), promotion: entity.promotionState })),
    };
  });
  assert(drivenImpact.impactStep >= 0, `ordinary drive did not produce an impact: ${JSON.stringify(drivenImpact)}`);
  const impact = await page.evaluate(() => window.__kkCrash.snapshot());
  assert(impact.score.largestImpact?.value > 0, 'largest impact was not ranked');
  assert(impact.replayMemoryBytes === ready.replayMemoryBytes, 'replay recorder allocated after first impact');
  await page.evaluate(() => window.__kkCrash.setPaused(true));
  await capture(page, SHOTS.impact);
  await page.evaluate(() => window.__kkCrash.setPaused(false));

  const piled = await page.evaluate(() => {
    const session = window.kkState.racing;
    let targetId = '';
    for (let step = 0; step < 900 && ['APPROACH', 'LIVE_CRASH'].includes(window.__kkCrash.snapshot().phase); step++) {
      const position = session.player.body.translation();
      const rotation = session.player.body.rotation();
      const yaw = Math.atan2(2 * (rotation.w * rotation.y + rotation.x * rotation.z), 1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z));
      let target = targetId ? session.entityById.get(targetId) : null;
      if (!target?.active || !target.body || target.crashed || session.score.participants.has(target.id)) target = null;
      if (!target) {
        const forwardX = Math.sin(yaw);
        const forwardZ = Math.cos(yaw);
        target = session.traffic.entities
          .filter((entity) => entity.active && entity.body && !entity.crashed && !session.score.participants.has(entity.id))
          .map((entity) => {
            const at = entity.body.translation();
            const dx = at.x - position.x;
            const dz = at.z - position.z;
            const distance = Math.hypot(dx, dz);
            const ahead = distance > 0.01 ? (dx * forwardX + dz * forwardZ) / distance : 1;
            return { entity, at, distance, score: distance + (ahead < -0.1 ? 18 : 0) };
          })
          .filter((entry) => entry.distance < 48 && Math.abs(entry.at.x) < 48 && Math.abs(entry.at.z) < 48)
          .sort((a, b) => a.score - b.score)[0]?.entity || null;
        targetId = target?.id || '';
      }
      let steer = 0;
      let throttle = 0.64;
      let handbrake = false;
      if (target?.body) {
        const targetPosition = target.body.translation();
        const desiredYaw = Math.atan2(targetPosition.x - position.x, targetPosition.z - position.z);
        const yawError = Math.atan2(Math.sin(desiredYaw - yaw), Math.cos(desiredYaw - yaw));
        steer = Math.max(-1, Math.min(1, yawError * 1.65));
        throttle = Math.abs(yawError) > 1.25 ? 0.42 : 0.86;
        handbrake = Math.abs(yawError) > 1.55 && session.player.cameraState.speed > 7;
      }
      window.__kkCrash.driveFixedSteps(1, {
        throttle,
        steer,
        brake: false,
        handbrake,
      });
      if (session.score.participants.size >= 5) break;
    }
    return { ...window.__kkCrash.snapshot(), qaTargetId: targetId };
  });
  assert(piled.score.vehicles >= 4, `naturally driven chain reaction involved only ${piled.score.vehicles} traffic vehicles`);
  assert(piled.traffic.dynamic <= 54, `high-tier major-body cap was exceeded: ${piled.traffic.dynamic}`);
  assert(piled.traffic.colliderViolations.length === 0, `pileup exposed ghost traffic: ${piled.traffic.colliderViolations.join(', ')}`);
  assert(piled.physics.physicalBodies <= 125, `physical bodies plus capped breakable debris exceeded the stress budget: ${piled.physics.physicalBodies}`);
  await page.evaluate(() => window.__kkCrash.setPaused(true));
  // `driveFixedSteps` intentionally batches physics without rendering. Yield
  // two real frames before visual QA so camera collision sees the final wreck
  // transforms under the same fixed/render interleave as normal gameplay.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const chaseForeground = await page.evaluate(() => {
    const session = window.kkState.racing;
    const camera = session.cameraManager.activeCamera;
    const raycaster = session.cameraManager.collision.raycaster;
    const playerRoot = session.player.visual.root;
    const trafficRoots = new Map(session.traffic.entities.map((entity) => [entity.visual?.root, `${entity.id}:${entity.classId}`]).filter(([root]) => root));
    const debrisRoots = new Map(session.debrisEntities.map((entity) => [entity.visual?.root, `${entity.id}:${entity.sourceEntityId || 'unknown'}`]).filter(([root]) => root));
    const ownerOf = (object) => {
      let cursor = object;
      while (cursor) {
        if (cursor === playerRoot) return 'player';
        if (trafficRoots.has(cursor)) return trafficRoots.get(cursor);
        if (debrisRoots.has(cursor)) return `debris:${debrisRoots.get(cursor)}`;
        cursor = cursor.parent;
      }
      return 'world';
    };
    const ignored = /(road|ground|surface|shadow|decal|atmosphere|haze|fog|lane|crosswalk|marking)/i;
    const ignoredRoles = new Set(['ground-shadow', 'atmosphere', 'decal-panel', 'primary-road', 'road-marking', 'road-wear', 'lane-reflector', 'sidewalk', 'gutter', 'curb', 'drain']);
    const isIgnored = (object) => {
      for (let cursor = object; cursor && cursor !== session.root; cursor = cursor.parent) {
        if (ignoredRoles.has(cursor.userData?.role) || ignored.test(cursor.name || '')) return true;
      }
      return false;
    };
    const intrusions = [];
    let firstHitDetail = null;
    let nearestPlayer = Infinity;
    let nearestNonPlayer = Infinity;
    for (const y of [-0.94, -0.78, -0.58, -0.34]) {
      for (const x of [-0.75, -0.38, 0, 0.38, 0.75]) {
        raycaster.setFromCamera({ x, y }, camera);
        raycaster.near = 0.1;
        raycaster.far = 7;
        const hit = raycaster.intersectObject(session.root, true).find((entry) => {
          const role = entry.object.userData?.role || '';
          if (!entry.object.visible) return false;
          if (['ground-shadow', 'atmosphere', 'decal-panel'].includes(role)) return false;
          return !isIgnored(entry.object);
        });
        if (!hit) continue;
        if (!firstHitDetail) {
          const path = [];
          for (let cursor = hit.object; cursor && cursor !== session.root; cursor = cursor.parent) path.push(cursor.name || cursor.type);
          firstHitDetail = {
            path,
            candidateIncluded: session.cameraManager.collision.candidates.includes(hit.object),
            worldPosition: hit.object.getWorldPosition(hit.point.clone()).toArray(),
            userData: hit.object.userData,
          };
        }
        const owner = ownerOf(hit.object);
        if (owner === 'player') nearestPlayer = Math.min(nearestPlayer, hit.distance);
        else nearestNonPlayer = Math.min(nearestNonPlayer, hit.distance);
        if (owner !== 'player' || hit.distance < 3) {
          intrusions.push({ x, y, distance: hit.distance, name: hit.object.name, role: hit.object.userData?.role || '', owner });
        }
      }
    }
    const collisionProbe = session.cameraManager.collision.foregroundBlocker(camera.position, session.cameraManager.rigs.chase.focus, 7, camera.quaternion, camera.fov, camera.aspect);
    return {
      intrusions,
      firstHitDetail,
      collisionProbe: collisionProbe ? { name: collisionProbe.object?.name, distance: collisionProbe.distance } : null,
      nearestPlayer: Number.isFinite(nearestPlayer) ? nearestPlayer : null,
      nearestNonPlayer: Number.isFinite(nearestNonPlayer) ? nearestNonPlayer : null,
      collision: session.cameraManager.collision.snapshot(),
    };
  });
  assert(chaseForeground.intrusions.length === 0,
    `chase camera accepted a near foreground obstruction: ${JSON.stringify(chaseForeground)}`);
  await capture(page, SHOTS.pileup);
  await page.evaluate(() => window.__kkCrash.setPaused(false));

  const settled = await page.evaluate(() => {
    let maximumLinearSpeed = 0;
    let maximumAngularSpeed = 0;
    for (let step = 0; step < 4000 && window.__kkCrash.snapshot().phase !== 'REPLAY'; step++) {
      window.__kkCrash.driveFixedSteps(1, { throttle: 0, brake: true });
      for (const entity of window.kkState.racing.physics.dynamicEntities) {
        if (!entity.body || (entity.kind !== 'traffic' && entity.kind !== 'player')) continue;
        const linear = entity.body.linvel();
        const angular = entity.body.angvel();
        maximumLinearSpeed = Math.max(maximumLinearSpeed, Math.hypot(linear.x, linear.y, linear.z));
        maximumAngularSpeed = Math.max(maximumAngularSpeed, Math.hypot(angular.x, angular.y, angular.z));
      }
    }
    const snapshot = window.__kkCrash.snapshot();
    return {
      ...snapshot,
      stability: {
        maximumLinearSpeed,
        maximumAngularSpeed,
        fastest: [...window.kkState.racing.physics.dynamicEntities]
          .filter((entity) => entity.body)
          .map((entity) => {
            const velocity = entity.body.linvel();
            return { id: entity.id, classId: entity.classId, speed: Math.hypot(velocity.x, velocity.y, velocity.z), position: entity.body.translation() };
          })
          .sort((a, b) => b.speed - a.speed)
          .slice(0, 8),
      },
    };
  });
  assert(settled.phase === 'REPLAY', `real braking/settling did not start replay: ${JSON.stringify(settled)}`);
  assert(settled.stability.maximumLinearSpeed < 80, `pileup produced an explosive vehicle speed: ${JSON.stringify(settled.stability)}`);
  assert(settled.stability.maximumAngularSpeed < 55, `pileup produced an explosive vehicle rotation: ${JSON.stringify(settled.stability)}`);
  const replay = await page.evaluate(() => window.__kkCrash.snapshot());
  assert(replay.replay.active && replay.replay.end > replay.replay.start, 'recorded replay did not start');
  assert(Number.isFinite(replay.replay.highlightTime), 'replay did not identify its highest-value impact');
  const replayStateMatch = await page.evaluate(() => {
    const session = window.kkState.racing;
    const player = session.replayPlayer;
    const originalTime = player.time;
    const maxComponentError = (actual, expected) => actual.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - expected[index])), 0);
    const quaternionError = (actual, expected) => Math.min(
      maxComponentError(actual, expected),
      maxComponentError(actual, expected.map((value) => -value)),
    );
    player.seek(player.clip.end);
    let checked = 0;
    let wheelChecked = 0;
    let detachedChecked = 0;
    let maximumPositionError = 0;
    let maximumQuaternionError = 0;
    let maximumWheelError = 0;
    let maximumMorphError = 0;
    const visibilityMismatches = [];
    const detachedMismatches = [];
    const detachedBits = {
      'front-bumper': 1 << 0, 'rear-bumper': 1 << 1, hood: 1 << 2, trunk: 1 << 3,
      'left-door': 1 << 4, 'right-door': 1 << 5,
      'left-front-wheel': 1 << 6, 'right-front-wheel': 1 << 7,
      'left-rear-wheel': 1 << 8, 'right-rear-wheel': 1 << 9,
      'left-mirror': 1 << 10, 'right-mirror': 1 << 11,
    };
    for (const id of player.clip.objectIds) {
      const expected = player.clip.sample(id, player.clip.end);
      const entity = session.entityById.get(id);
      const root = entity?.visual?.root;
      if (!expected || !root) continue;
      checked += 1;
      maximumPositionError = Math.max(maximumPositionError, maxComponentError(root.position.toArray(), expected.position));
      maximumQuaternionError = Math.max(maximumQuaternionError, quaternionError(root.quaternion.toArray(), expected.quaternion));
      if (root.visible !== expected.active) visibilityMismatches.push(id);
      for (let index = 0; index < (expected.wheelState?.length || 0); index++) {
        const expectedWheel = expected.wheelState[index];
        const wheel = entity.wheelVisualBindings?.[index];
        if (!expectedWheel || !wheel) continue;
        wheelChecked += 1;
        maximumWheelError = Math.max(
          maximumWheelError,
          maxComponentError(wheel.position.toArray(), expectedWheel.position),
          quaternionError(wheel.quaternion.toArray(), expectedWheel.quaternion),
        );
        if (wheel.visible !== expectedWheel.visible) visibilityMismatches.push(`${id}:wheel-${index}`);
      }
      for (const mesh of entity.visual?.damageMeshes || []) {
        for (const [name, index] of Object.entries(mesh.morphTargetDictionary || {})) {
          const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const zone = ['front', 'rear', 'left', 'right'].find((candidate) => normalized === `damage${candidate}` || normalized === `${candidate}damage` || normalized === `crush${candidate}`);
          if (zone) maximumMorphError = Math.max(maximumMorphError, Math.abs((mesh.morphTargetInfluences[index] || 0) - (expected.damageZones?.[zone] || 0)));
        }
      }
      for (const [part, bit] of Object.entries(detachedBits)) {
        if (!(expected.detachedMask & bit)) continue;
        detachedChecked += 1;
        const source = entity.visual?.parts?.get?.(part) || root.getObjectByName(part);
        if (source?.visible !== false) detachedMismatches.push(`${id}:${part}`);
      }
    }
    player.seek(originalTime);
    return {
      checked,
      wheelChecked,
      detachedChecked,
      maximumPositionError,
      maximumQuaternionError,
      maximumWheelError,
      maximumMorphError,
      visibilityMismatches,
      detachedMismatches,
    };
  });
  assert(replayStateMatch.checked > 0 && replayStateMatch.wheelChecked === 4, `replay terminal-state audit did not inspect the player wheels: ${JSON.stringify(replayStateMatch)}`);
  assert(replayStateMatch.maximumPositionError < 0.002 && replayStateMatch.maximumQuaternionError < 0.002, `replay chassis transforms diverged from the recorded event: ${JSON.stringify(replayStateMatch)}`);
  assert(replayStateMatch.maximumWheelError < 0.003, `replay wheel state diverged from the recorded event: ${JSON.stringify(replayStateMatch)}`);
  assert(replayStateMatch.maximumMorphError < 0.012, `replay directional damage diverged from the recorded event: ${JSON.stringify(replayStateMatch)}`);
  assert(replayStateMatch.visibilityMismatches.length === 0 && replayStateMatch.detachedMismatches.length === 0, `replay visibility/detached state diverged from the recorded event: ${JSON.stringify(replayStateMatch)}`);
  await page.click('[data-replay-speed="0.25"]');
  await page.waitForFunction(() => window.__kkCrash.snapshot().replay.speed === 0.25);
  const slowStart = await page.evaluate(() => window.__kkCrash.snapshot().replay.time);
  await page.waitForFunction((start) => window.__kkCrash.snapshot().replay.time > start + 0.02, slowStart, { timeout: 10_000 });
  await page.click('[data-replay-speed="1"]');
  await page.waitForFunction(() => window.__kkCrash.snapshot().replay.speed === 1);
  await page.click('[data-replay-speed="0.25"]');
  await page.waitForFunction(() => window.__kkCrash.snapshot().replay.speed === 0.25);
  await capture(page, SHOTS.replay);
  const replayComposition = await page.evaluate(() => {
    const session = window.kkState.racing;
    const camera = session.replayCamera.camera;
    camera.updateMatrixWorld(true);
    const samples = ['player', ...session.score.participants].map((id) => {
      const entity = session.entityById.get(id);
      if (!entity?.visual?.root?.visible) return null;
      const world = entity.visual.root.getWorldPosition(entity.visual.root.position.clone());
      const ndc = world.clone().project(camera);
      return { id, world: world.toArray(), ndc: ndc.toArray() };
    }).filter(Boolean);
    return {
      shot: session.replayPlayer.lastShot?.family,
      camera: camera.position.toArray(),
      focus: session.replayCamera.lastFrame?.frame?.focus?.toArray?.() || [],
      visibleParticipants: samples.length,
      centeredParticipants: samples.filter((sample) => Math.abs(sample.ndc[0]) < 0.68 && Math.abs(sample.ndc[1]) < 0.62 && sample.ndc[2] > -1 && sample.ndc[2] < 1).length,
      obstruction: session.replayCamera.lastCandidate?.obstruction || 0,
      blockedRays: session.replayCamera.lastCandidate?.blockedRays || 0,
    };
  });
  assert(replayComposition.centeredParticipants >= 2, `replay wide shot failed to frame the pileup: ${JSON.stringify(replayComposition)}`);
  assert(replayComposition.obstruction === 0 && replayComposition.blockedRays === 0, `replay accepted an obstructed camera: ${JSON.stringify(replayComposition)}`);
  assert(await page.evaluate(() => window.__kkCrash.seekReplayShot('wreck_orbit')), 'replay has no final wreckage shot');
  await page.waitForFunction(() => {
    const session = window.kkState.racing;
    return session.replayPlayer.lastShot?.family === 'wreck_orbit'
      && session.replayCamera.lastFrame?.effects?.replayShot === 'wreck_orbit';
  });
  await page.evaluate(() => window.__kkCrash.setPaused(true));
  await capture(page, SHOTS.final);
  const finalComposition = await page.evaluate(() => {
    const session = window.kkState.racing;
    const camera = session.replayCamera.camera;
    camera.updateMatrixWorld(true);
    const centeredParticipants = ['player', ...session.score.participants].filter((id) => {
      const root = session.entityById.get(id)?.visual?.root;
      if (!root?.visible) return false;
      const ndc = root.getWorldPosition(root.position.clone()).project(camera);
      return Math.abs(ndc.x) < 0.76 && Math.abs(ndc.y) < 0.68 && ndc.z > -1 && ndc.z < 1;
    }).length;
    return {
      centeredParticipants,
      obstruction: session.replayCamera.lastCandidate?.obstruction || 0,
      blockedRays: session.replayCamera.lastCandidate?.blockedRays || 0,
      cameraClearance: session.replayCamera.lastCandidate?.cameraClearance ?? 0,
      cameraIntrusions: session.replayCamera.lastCandidate?.cameraIntrusions || 0,
      cameraIntrusionNames: session.replayCamera.lastCandidate?.cameraIntrusionNames || [],
    };
  });
  assert(finalComposition.centeredParticipants >= 2, `final wreckage shot did not frame cause and aftermath: ${JSON.stringify(finalComposition)}`);
  assert(finalComposition.obstruction === 0 && finalComposition.blockedRays === 0
    && finalComposition.cameraIntrusions === 0 && finalComposition.cameraClearance >= 0.72,
  `final wreckage camera clipped or accepted an obstruction: ${JSON.stringify(finalComposition)}`);
  await page.evaluate(() => window.__kkCrash.setPaused(false));
  await page.click('[data-action="skip-replay"]');
  await page.waitForFunction(() => window.__kkCrash.snapshot().phase === 'RESULTS', null, { timeout: 8_000 });
  const results = await page.evaluate(() => window.__kkCrash.snapshot());
  assert(results.result?.medal && results.result.score > 0, 'results did not expose score and medal');
  assert(results.result.vehicles >= 3, `results lost pileup participants: ${results.result.vehicles}`);
  const damagePersistence = await page.evaluate(() => {
    const damaged = window.kkState.racing.traffic.entities.find((entity) => entity.damage?.severity > 0.08);
    return damaged ? {
      severity: damaged.damage.severity,
      productionVisible: !!damaged.visual.productionModel?.visible,
      authoredDamageVisible: damaged.visual.damageMeshes?.some((mesh) => mesh.visible && mesh.userData.role === 'authored-damage-surface'),
      fallbackVisible: damaged.visual.fallbackMeshes?.some((mesh) => mesh.visible),
    } : null;
  });
  assert(damagePersistence?.severity > 0.08 && damagePersistence.productionVisible && damagePersistence.authoredDamageVisible && !damagePersistence.fallbackVisible, `authored directional damage did not persist into results: ${JSON.stringify(damagePersistence)}`);
  await capture(page, SHOTS.results);

  await page.evaluate(() => {
    window.kkState._optReduceMotion = true;
    window.kkState._optReducedFlashing = true;
  });
  await page.waitForFunction(() => {
    const hud = document.querySelector('.kkc-hud');
    return hud?.dataset.reduceMotion === 'true' && hud?.dataset.reducedFlashing === 'true';
  });
  await page.click('[data-action="replay-again"]');
  await page.waitForFunction(() => window.__kkCrash.snapshot().phase === 'REPLAY');
  await page.waitForFunction(() => {
    const session = window.kkState.racing;
    const frame = session?.replayCamera?.lastFrame;
    const gentlePlan = session?.replayPlayer?.plan?.every((shot) => shot.speed === 1 && !['target_pov', 'wreck_orbit'].includes(shot.family));
    return gentlePlan && frame?.effects?.chromatic === 0 && frame?.effects?.depthOfField === 0 && frame?.effects?.bloom <= 0.3;
  });
  await page.click('[data-action="skip-replay"]');
  await page.waitForFunction(() => window.__kkCrash.snapshot().phase === 'RESULTS');

  const modeAssetRequests = () => diagnostics.requests.filter((url) => /(kaki-rally-decal-atlas|kaki-catastrophe-vehicles-v2|pawprint-moonpaw-environment-v2|sky_twilight)/.test(url)).length;
  const requestsBeforeRetries = modeAssetRequests();
  const canvasCount = await page.locator('canvas').count();
  for (let retry = 0; retry < 5; retry += 1) {
    if (retry === 0) await page.click('[data-action="retry"]');
    else await page.evaluate(() => window.__kkCrash.restart());
    await page.waitForFunction(() => {
      const snapshot = window.__kkCrash?.snapshot?.();
      return snapshot?.mode === 'crash' && snapshot.worldReady && snapshot.assetsReady && snapshot.assetError === '';
    }, null, { timeout: 30_000 });
    const lifecycle = await page.evaluate(() => ({
      hud: document.querySelectorAll('.kkc-hud').length,
      roots: window.kkState.scene.getObjectsByProperty('name', 'kaki-catastrophe-pawprint-interchange').length,
      canvases: document.querySelectorAll('canvas').length,
      snapshot: window.__kkCrash.snapshot(),
    }));
    assert(lifecycle.hud === 1 && lifecycle.roots === 1, `retry ${retry + 1} duplicated HUD/world roots: ${JSON.stringify(lifecycle)}`);
    assert(lifecycle.canvases === canvasCount, `retry ${retry + 1} leaked a canvas`);
    assert(lifecycle.snapshot.listeners === 2, `retry ${retry + 1} did not own exactly one key listener pair`);
    assert(lifecycle.snapshot.physics.bodies <= 40, `retry ${retry + 1} retained wreck bodies: ${lifecycle.snapshot.physics.bodies}`);
  }
  assert(modeAssetRequests() === requestsBeforeRetries, `retry re-requested mode assets: ${requestsBeforeRetries} -> ${modeAssetRequests()}`);

  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('.kkc-hud'));
  assert(!await page.evaluate(() => !!window.__kkCrash), 'QA bridge leaked after exit');
  assert(diagnostics.pageErrors.length === 0, `page errors: ${diagnostics.pageErrors.join(' | ')}`);
  assert(diagnostics.consoleErrors.length === 0, `console errors: ${diagnostics.consoleErrors.join(' | ')}`);
  assert(diagnostics.badResponses.length === 0, `asset/network failures: ${diagnostics.badResponses.join(' | ')}`);
  console.log(`Kaki Catastrophe browser smoke passed: ${piled.physics.bodies} Rapier bodies, ${piled.traffic.dynamic} major dynamic vehicles, ${piled.score.vehicles} scored participants, ${replayComposition.centeredParticipants} replay-framed participants. Screenshots: ${Object.values(SHOTS).join(', ')}`);
} catch (error) {
  if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length || diagnostics.badResponses.length) {
    console.error(`Browser diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  }
  console.error(`Kaki Catastrophe browser smoke failed: ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
