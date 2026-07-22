#!/usr/bin/env node
/** Real-browser Crown Chaos Coliseum visual, lifecycle, and stress smoke. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 8893);
const TIMEOUT = 90000;
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const SHOTS = Object.freeze({
  menu: '/tmp/kks-monster-menu-1280x720.png',
  spawn: '/tmp/kks-monster-spawn-1280x720.png',
  exterior: '/tmp/kks-monster-exterior-1280x720.png',
  crusher: '/tmp/kks-monster-crusher-impact-1920x1080.png',
  busy: '/tmp/kks-monster-busy-1920x1080.png',
  bowl: '/tmp/kks-monster-bowl-1920x1080.png',
  air: '/tmp/kks-monster-air-1920x1080.png',
  bus: '/tmp/kks-monster-bus-gap-1920x1080.png',
  ultrawide: '/tmp/kks-monster-ultrawide-2560x1080.png',
  reduced: '/tmp/kks-monster-reduced-motion-1920x1080.png',
  contrast: '/tmp/kks-monster-high-contrast-1920x1080.png',
  finish: '/tmp/kks-monster-finish-1920x1080.png',
  compactHud: '/tmp/kks-monster-hud-571x349.png',
  compactFinish: '/tmp/kks-monster-finish-571x349.png',
  mobile: '/tmp/kks-monster-touch-844x390.png',
  compactTouch: '/tmp/kks-monster-touch-571x349.png',
  pyramid: '/tmp/kks-monster-pyramid-yard-1920x1080.png',
  busPyramid: '/tmp/kks-monster-bus-pyramid-1920x1080.png',
  pyramidCollapse: '/tmp/kks-monster-pyramid-collapse-1920x1080.png',
  dominoPerimeter: '/tmp/kks-monster-domino-perimeter-1920x1080.png',
  dominoExplosion: '/tmp/kks-monster-domino-explosion-1920x1080.png',
});

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function watchPage(page, diagnostics) {
  page.on('pageerror', (error) => diagnostics.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(`http://127.0.0.1:${PORT}/`)) {
      diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
    }
  });
}

async function prime(page) {
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?qa=1&smoke=1`, {
    waitUntil: 'load', timeout: TIMEOUT,
  });
  await page.waitForFunction(
    () => typeof window.kkStartRacing === 'function' && !!document.querySelector('.kkv2-navitem[data-nav="racing"]'),
    null,
    { timeout: TIMEOUT },
  );
}

async function waitArena(page, vehicle, needsModel = false) {
  await page.waitForFunction((expected) => {
    const snapshot = window.__kkRacing?.snapshot?.();
    return snapshot?.raceMode === 'monster'
      && snapshot.monster?.vehicleId === expected
      && (!['cyber', 'tipsy'].includes(expected) || snapshot.monster.modelAttached)
      && snapshot.monster?.destruction?.trafficModelsAttached
      && snapshot.monster?.destruction?.productionVfxAtlas
      && snapshot.monster?.arena?.productionEnvironmentAttached
      && snapshot.monster?.arena?.audienceBanks === 1;
  }, vehicle, { timeout: needsModel ? TIMEOUT : 45000 });
  await page.evaluate(() => window.__kkRacing?.skipCountdown?.());
  await page.waitForTimeout(650);
}

async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === 'none' || element.getClientRects().length === 0) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const overlaps = (a, b) => !!(a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y);
    const stage = rect('#kk-stage');
    const selectors = [
      '.kkr-topbar', '.kkr-position', '.kkr-course', '.kkr-lap', '.kkr-timer', '.kkr-mode-status',
      '.kkr-drift', '.kkr-speed', '.kkr-health', '.kkr-menu', '.kkr-finish-card',
    ];
    const panels = Object.fromEntries(selectors.map((selector) => [selector, rect(selector)]));
    const inside = Object.fromEntries(Object.entries(panels).map(([selector, box]) => [selector, !box || !!stage
      && box.x >= stage.x - 2 && box.right <= stage.right + 2 && box.y >= stage.y - 2 && box.bottom <= stage.bottom + 2]));
    const essentialSelectors = [
      '.kkr-position', '.kkr-course', '.kkr-lap', '.kkr-timer', '.kkr-mode-status',
      '.kkr-drift', '.kkr-speed', '.kkr-health', '.kkr-menu',
    ];
    const hudOverlaps = [];
    for (let index = 0; index < essentialSelectors.length; index += 1) {
      for (let other = index + 1; other < essentialSelectors.length; other += 1) {
        const first = essentialSelectors[index];
        const second = essentialSelectors[other];
        if (overlaps(panels[first], panels[second])) hudOverlaps.push(`${first} x ${second}`);
      }
    }
    const textSelectors = [
      '.kkr-position strong', '.kkr-position .kkr-label', '.kkr-course h1', '.kkr-lap strong',
      '.kkr-lap .kkr-label', '.kkr-timer', '.kkr-mode-status', '.kkr-drift > span',
      '.kkr-health > span', '.kkr-menu',
    ];
    const textOverflow = textSelectors.filter((selector) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === 'none' || element.getClientRects().length === 0) return false;
      return element.scrollWidth > element.clientWidth + 1;
    });
    const touch = rect('.kkr-touch');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stage,
      panels,
      inside,
      mapDisplay: getComputedStyle(document.querySelector('.kkr-map')).display,
      controlsOpacity: Number(getComputedStyle(document.querySelector('.kkr-controls')).opacity),
      touch,
      hudOverlaps,
      textOverflow,
      calloutFontSize: parseFloat(getComputedStyle(document.querySelector('.kkr-callout')).fontSize),
      topbarMenuOverlap: overlaps(panels['.kkr-topbar'], panels['.kkr-menu']),
      touchChaosOverlap: overlaps(touch, panels['.kkr-drift']),
      touchHealthOverlap: overlaps(touch, panels['.kkr-health']),
      touchSpeedOverlap: overlaps(touch, panels['.kkr-speed']),
      hudCount: document.querySelectorAll('#kk-racing-hud').length,
      arenaCount: (() => {
        const id = window.kkState?.racing?.monsterArenaDefinition?.id;
        return id ? window.kkState.racing.root?.getObjectsByProperty?.('name', `${id}-authored-arena`)?.length || 0 : 0;
      })(),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

async function capture(page, file) {
  await page.screenshot({ path: file, fullPage: false });
  assert(fs.statSync(file).size > 15_000, `screenshot is unexpectedly small: ${file}`);
}

async function desktopRun(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  watchPage(page, diagnostics);
  await prime(page);

  await page.click('.kkv2-navitem[data-nav="racing"]');
  await page.waitForSelector('.kkv2-race-overlay');
  await page.click('.kkv2-race-card[data-mode="monster"]');
  await page.waitForSelector('.kkv2-monster-setup:not([hidden])');
  await page.waitForTimeout(400);
  const menuTraits = await page.locator('.kkv2-monster-setup').innerText();
  assert(menuTraits.includes('MIGHTY MEOWSTER') && menuTraits.includes('CYBER KAKI') && menuTraits.includes('TIPSY TUMBLER'), 'three-vehicle Monster garage is not visible');
  const garageLayout = await page.evaluate(() => {
    const garage = document.querySelector('.kkv2-monster-garage');
    const buttons = [...garage.querySelectorAll('[data-monster-vehicle]')];
    const rects = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { id: button.dataset.monsterVehicle, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    return {
      columns: getComputedStyle(garage).gridTemplateColumns.split(' ').length,
      rects,
      tipsyVisible: buttons.find((button) => button.dataset.monsterVehicle === 'tipsy')?.getClientRects().length > 0,
      overlay: {
        scrollTop: document.querySelector('.kkv2-race-overlay').scrollTop,
        clientHeight: document.querySelector('.kkv2-race-overlay').clientHeight,
        scrollHeight: document.querySelector('.kkv2-race-overlay').scrollHeight,
      },
      viewportHeight: innerHeight,
    };
  });
  assert(garageLayout.columns === 4, `Monster garage is not a four-column lineup: ${JSON.stringify(garageLayout)}`);
  assert(garageLayout.tipsyVisible && garageLayout.rects.every((rect) => Math.abs(rect.top - garageLayout.rects[0].top) < 2),
    `Monster truck buttons wrapped into a stray row: ${JSON.stringify(garageLayout)}`);
  assert(garageLayout.overlay.scrollTop > 400 && garageLayout.rects.every((rect) => rect.top >= 0 && rect.bottom <= garageLayout.viewportHeight),
    `Monster garage did not scroll into the visible setup area: ${JSON.stringify(garageLayout)}`);
  assert(garageLayout.rects.every((rect, index) => index === 0 || rect.left >= garageLayout.rects[index - 1].right - 1),
    `Monster truck buttons overlap: ${JSON.stringify(garageLayout)}`);
  assert(menuTraits.includes('CROWN CHAOS COLISEUM') && menuTraits.includes('PILEUP PYRAMID YARD'), 'both destruction arenas are not visible');
  assert(menuTraits.includes('122 CRUSHABLES') && menuTraits.includes('78 DOMINO CARS') && menuTraits.includes('11 HOT CARS'), 'five-round Pyramid Yard counts are stale in the setup menu');
  await page.click('[data-monster-arena="crown-chaos-coliseum"]');
  await capture(page, SHOTS.menu);
  if (process.env.KKS_MONSTER_MENU_ONLY === '1') {
    await context.close();
    return { garageLayout };
  }
  await page.click('.kkv2-overlay-confirm');
  await waitArena(page, 'cyber', true);
  const spawn = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(spawn.monster.modelAttached, 'Cyber Kaki GLB did not replace its procedural fallback');
  assert(spawn.monster.destruction.trafficModelsAttached, 'traffic GLB did not replace the procedural target shells');
  assert(spawn.monster.destruction.trafficModelClasses === 9, `expected nine modeled traffic classes, got ${spawn.monster.destruction.trafficModelClasses}`);
  assert(spawn.monster.totalTargets === 36, `expected 36 targets, got ${spawn.monster.totalTargets}`);
  assert(spawn.monster.arena.districts === 6, 'arena snapshot lost its six authored districts');
  assert(spawn.monster.arena.hasExterior, 'arena snapshot lost its authored exterior world');
  assert(spawn.monster.arena.productionEnvironmentAttached, 'production arena environment kit did not replace its fallbacks');
  assert(spawn.monster.arena.productionEnvironmentMeshes >= 18, 'production arena environment kit is incomplete');
  assert(spawn.monster.arena.audienceBanks === 1, 'optimized 3D audience bank did not populate the camera-facing grandstand');
  assert(spawn.monster.arena.groundDecals >= 8 && spawn.monster.arena.crowdCards >= 150, 'arena floor/crowd dressing did not attach');
  assert(spawn.monster.destruction.productionVfxAtlas, 'production Monster VFX atlas did not attach');
  assert(
    ['arenaTrafficKit', 'monsterEnvironmentKit', 'monsterAudienceBank', 'monsterArenaDirtColor', 'monsterArenaVfx'].every((id) => spawn.assets.ids.includes(id)),
    'Monster lease omitted production traffic, audience, environment, floor, or VFX assets',
  );
  assert(spawn.assets.error === '', `rally asset lease failed: ${spawn.assets.error}`);
  const productionAssets = await page.evaluate(() => ({
    backgroundMatches: window.kkState.scene.background === window.kkState.racing.assetLease.textures.monsterArenaBackdrop,
    backdropLoaded: !!window.kkState.racing.assetLease.textures.monsterArenaBackdrop?.image,
  }));
  assert(productionAssets.backgroundMatches && productionAssets.backdropLoaded, 'Grok exterior did not replace the flat Monster scene background');

  await page.keyboard.down('KeyA');
  await page.waitForTimeout(90);
  const leftSteer = await page.evaluate(() => window.kkState.racing.cars[0].frameControls?.steer || 0);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(90);
  const rightSteer = await page.evaluate(() => window.kkState.racing.cars[0].frameControls?.steer || 0);
  await page.keyboard.up('KeyD');
  assert(leftSteer > 0.9 && rightSteer < -0.9, `Monster A/D steering is mirrored: A=${leftSteer}, D=${rightSteer}`);
  await capture(page, SHOTS.spawn);
  await page.evaluate(() => window.__kkRacing.warpToMonsterDistrict('perimeter-freestyle'));
  await page.waitForTimeout(450);
  await capture(page, SHOTS.exterior);

  await page.setViewportSize({ width: 571, height: 349 });
  await page.evaluate(() => {
    window.kkState.racing.raceTime = 7;
    window.kkState.racing.goFlash = 0;
    window.kkState.racing.smashFlash = 0;
    window.kkState.racing.monsterScore.lastEventTime = 0;
  });
  await page.waitForTimeout(120);
  const compactHudLayout = await layoutSnapshot(page);
  assert(Object.values(compactHudLayout.inside).every(Boolean), '571x349 gameplay HUD escaped the stage safe area');
  assert(compactHudLayout.scrollWidth === compactHudLayout.viewport.width, '571x349 gameplay viewport has horizontal overflow');
  assert(compactHudLayout.hudOverlaps.length === 0, `571x349 gameplay HUD overlaps: ${compactHudLayout.hudOverlaps.join(', ')}`);
  assert(compactHudLayout.textOverflow.length === 0, `571x349 gameplay text clips: ${compactHudLayout.textOverflow.join(', ')}`);
  assert(compactHudLayout.panels['.kkr-topbar'].height <= 46, `571x349 topbar is still oversized: ${compactHudLayout.panels['.kkr-topbar'].height}`);
  assert(!compactHudLayout.touch, 'fine-pointer 571x349 window incorrectly shows touch controls');
  assert(compactHudLayout.calloutFontSize <= 52, `571x349 callout is still oversized: ${compactHudLayout.calloutFontSize}px`);
  await capture(page, SHOTS.compactHud);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
  const sixteenTenLayout = await layoutSnapshot(page);
  assert(Object.values(sixteenTenLayout.inside).every(Boolean), '16:10 Monster HUD escaped the stage safe area');
  assert(!sixteenTenLayout.topbarMenuOverlap, '16:10 Menu overlaps the Monster scoreboard');
  assert(sixteenTenLayout.scrollWidth === sixteenTenLayout.viewport.width, '16:10 viewport has horizontal overflow');

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(100);
  const laptopLayout = await layoutSnapshot(page);
  assert(Object.values(laptopLayout.inside).every(Boolean), 'laptop Monster HUD escaped the stage safe area');
  assert(!laptopLayout.topbarMenuOverlap, 'laptop Menu overlaps the Monster scoreboard');
  assert(laptopLayout.scrollWidth === laptopLayout.viewport.width, 'laptop viewport has horizontal overflow');

  await page.setViewportSize({ width: 1920, height: 1080 });
  const crusherTarget = await page.evaluate(() => {
    window.__kkRacing.setMonsterRound(2);
    const target = window.kkState.racing.monsterArena.targets.find((entry) => entry.district === 'crusher-alley' && entry.kind === 'sedan');
    window.__kkRacing.warpToMonsterTarget(target.index);
    return target.id;
  });
  await page.waitForFunction((id) => {
    const target = window.kkState?.racing?.monsterArena?.targets?.find((entry) => entry.id === id);
    return !!target?.destroyed;
  }, crusherTarget, { timeout: 5000 });
  await page.evaluate(() => {
    const kart = window.kkState.racing.cars[0].physics;
    kart.vx = 0;
    kart.vz = 0;
    kart.speed = 0;
  });
  await page.waitForTimeout(180);
  const crusher = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(crusher.monster.destruction.destroyed >= 1, 'real Crusher Alley impact did not persist a wreck');
  await capture(page, SHOTS.crusher);

  await page.evaluate(() => {
    window.__kkRacing.showMonsterBusyState();
    window.kkState.racing.raceTime = 14;
  });
  await page.waitForTimeout(1600);
  const busy = await page.evaluate(() => window.__kkRacing.snapshot());
  const busyInventory = await page.evaluate(() => {
    const root = window.kkState?.racing?.root;
    const summarize = (object) => {
      const result = { meshes: 0, instanced: 0, castShadow: 0, materials: 0 };
      const materialIds = new Set();
      object?.traverse?.((child) => {
        if (!child.isMesh) return;
        result.meshes += 1;
        result.instanced += child.isInstancedMesh ? 1 : 0;
        result.castShadow += child.castShadow ? 1 : 0;
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          if (material?.uuid) materialIds.add(material.uuid);
        }
      });
      result.materials = materialIds.size;
      return result;
    };
    return {
      total: summarize(root),
      children: root?.children?.map((child) => ({ name: child.name || child.type, ...summarize(child) })) || [],
    };
  });
  const busyLayout = await layoutSnapshot(page);
  assert(busy.performance.drawCalls > 0 && busy.performance.drawCalls < 400, `busy draw-call budget exceeded: ${busy.performance.drawCalls}`);
  assert(busy.performance.triangles > 0 && busy.performance.triangles < 3_000_000, `busy triangle budget exceeded: ${busy.performance.triangles}`);
  assert(busy.performance.fps >= 24, `busy headless frame rate too low: ${busy.performance.fps}`);
  assert(busy.monster.destruction.debrisCap === 108 && busy.monster.destruction.smokeCap === 72, 'pooled effect caps changed unexpectedly');
  assert(busy.monster.destruction.derbyActive === 3, 'busy stress state does not retain all three active derby opponents');
  assert(Object.values(busyLayout.inside).every(Boolean), 'desktop Monster HUD escaped the stage safe area');
  assert(!busyLayout.topbarMenuOverlap, 'desktop Menu overlaps the Monster scoreboard');
  assert(busyLayout.mapDisplay === 'none', 'old racetrack minimap remains visible in Monster Arena');
  assert(busyLayout.controlsOpacity <= 0.21, 'opening controls did not fade');
  await capture(page, SHOTS.busy);

  await page.evaluate(() => {
    window.__kkRacing.setMonsterRound(2);
    window.__kkRacing.warpToMonsterDistrict('demolition-bowl');
  });
  await page.waitForTimeout(500);
  await capture(page, SHOTS.bowl);
  await page.evaluate(() => {
    const session = window.kkState.racing;
    const ramp = session.monsterArenaDefinition.ramps.find((entry) => entry.id === 'spine-south-big');
    const kart = session.cars[0].physics;
    const localZ = 3;
    kart.x = ramp.x + Math.sin(ramp.yaw) * localZ;
    kart.z = ramp.z + Math.cos(ramp.yaw) * localZ;
    kart.previousX = kart.x;
    kart.previousZ = kart.z;
    kart.y = kart.previousY = 4.5;
    kart.yaw = ramp.yaw;
    kart.vx = Math.sin(ramp.yaw) * 18;
    kart.vz = Math.cos(ramp.yaw) * 18;
    kart.vy = 0;
    kart.speed = 18;
    kart.grounded = true;
    kart.rampCooldown = 0;
    kart.airborneGrace = 0;
    kart.stuntPitch = 0;
    kart.stuntPitchVelocity = 0;
  });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => {
    const kart = window.kkState?.racing?.cars?.[0]?.physics;
    return kart && !kart.grounded && kart.airTime >= 0.06 && kart.vy > 4;
  }, null, { timeout: 12000 });
  const air = await page.evaluate(() => {
    const snapshot = window.__kkRacing.snapshot();
    const kart = window.kkState.racing.cars[0].physics;
    return {
      snapshot,
      y: kart.y,
      vy: kart.vy,
      pitch: kart.stuntPitch,
      airTime: kart.airTime,
      groundedWheels: kart.groundedWheelCount,
    };
  });
  await page.keyboard.up('KeyW');
  assert(air.snapshot.airborne && air.airTime > 0.05,
    `real authored ramp did not retain an airborne arc: ${JSON.stringify(air)}`);
  assert(air.y > 6.6 && air.vy > 4, `real ramp launch remained gravity-heavy: ${JSON.stringify(air)}`);
  assert(air.pitch < -0.12 && air.pitch > -0.9, `real ramp launch nose-planted or over-rotated: ${JSON.stringify(air)}`);
  assert(air.groundedWheels === 0, 'front tires re-grabbed the floor below the ramp lip');
  await capture(page, SHOTS.air);

  await page.evaluate(() => {
    window.kkState.racing.monsterRounds.timeRemaining = Infinity;
    window.__kkRacing.showMonsterJump('bus-gap-south');
  });
  await page.waitForTimeout(170);
  const busJump = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(busJump.airborne, 'Bus/RV gap QA trajectory is not airborne');
  await capture(page, SHOTS.bus);

  await page.setViewportSize({ width: 2560, height: 1080 });
  await page.evaluate(() => window.__kkRacing.warpToMonsterDistrict('bus-rv-gap'));
  await page.waitForTimeout(550);
  const ultrawideLayout = await layoutSnapshot(page);
  assert(ultrawideLayout.stage.width <= 1922, '32:9 viewport lost the aspect-capped letterbox stage');
  assert(Object.values(ultrawideLayout.inside).every(Boolean), 'ultrawide Monster HUD escaped the stage');
  assert(!ultrawideLayout.topbarMenuOverlap, 'ultrawide Menu overlaps the Monster scoreboard');
  await capture(page, SHOTS.ultrawide);

  await page.setViewportSize({ width: 3840, height: 1080 });
  await page.waitForTimeout(100);
  const superUltrawideLayout = await layoutSnapshot(page);
  assert(superUltrawideLayout.stage.width <= 1922, '32:9 viewport lost the aspect-capped letterbox stage');
  assert(Object.values(superUltrawideLayout.inside).every(Boolean), '32:9 Monster HUD escaped the letterboxed stage');
  assert(!superUltrawideLayout.topbarMenuOverlap, '32:9 Menu overlaps the Monster scoreboard');

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.__kkRacing.showMonsterJump());
  await page.waitForTimeout(120);
  const reducedAnimation = await page.$eval('.kkr-callout', (element) => getComputedStyle(element).animationName);
  assert(reducedAnimation === 'none', 'reduced-motion media state still animates arena callouts');
  await capture(page, SHOTS.reduced);

  await page.emulateMedia({ reducedMotion: 'no-preference', contrast: 'more' });
  const highContrast = await page.evaluate(() => ({
    active: matchMedia('(prefers-contrast: more)').matches,
    border: getComputedStyle(document.querySelector('.kkr-position')).borderTopColor,
  }));
  assert(highContrast.active && /rgba?\(/.test(highContrast.border), 'high-contrast Monster HUD media state did not activate');
  await capture(page, SHOTS.contrast);
  await page.emulateMedia({ contrast: 'no-preference' });

  const unlimitedClock = await page.evaluate(() => window.__kkRacing.snapshot().monster.roundTime);
  assert(unlimitedClock === Infinity, `Smashdown clock is not unlimited: ${unlimitedClock}`);
  await page.evaluate(() => window.kkState.racing.monsterRounds.roundElapsed = 31);
  await capture(page, SHOTS.finish);
  await page.setViewportSize({ width: 571, height: 349 });
  await page.waitForTimeout(120);
  const compactFinishLayout = await layoutSnapshot(page);
  assert(compactFinishLayout.inside['.kkr-finish-card'], '571x349 results card escaped the stage');
  assert(compactFinishLayout.scrollWidth === compactFinishLayout.viewport.width, '571x349 results viewport has horizontal overflow');
  await capture(page, SHOTS.compactFinish);
  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('#kk-racing-hud'));
  const cacheAfterExit = await page.evaluate(() => document.body.dataset.racingCacheAfterExit);
  assert(cacheAfterExit === '0', `asset cache leaked after exit: ${cacheAfterExit}`);

  await context.close();
  return { spawn, busy, busyInventory, busyLayout, compactHudLayout, sixteenTenLayout, laptopLayout, ultrawideLayout, superUltrawideLayout, compactFinishLayout };
}

async function pyramidRun(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  watchPage(page, diagnostics);
  await prime(page);
  await page.evaluate(() => window.kkStartRacing('forest', {
    mode: 'monster',
    monsterVehicle: 'tipsy',
    monsterArena: 'pileup-pyramid-yard',
  }));
  await waitArena(page, 'tipsy', true);
  const tipsyAnimationStart = await page.evaluate(() => window.__kkRacing.snapshot().monster.modelAnimation);
  await page.waitForTimeout(500);
  const tipsyAnimationStopped = await page.evaluate(() => window.__kkRacing.snapshot().monster.modelAnimation);
  assert(tipsyAnimationStart.actions > 0, 'Tipsy Tumbler loaded without its authored animation clip');
  assert(tipsyAnimationStart.roadSpeedSynced, 'Tipsy Tumbler animation is not tied to road speed');
  assert(Math.abs(tipsyAnimationStopped.time - tipsyAnimationStart.time) < 0.002,
    `Tipsy tires moved while parked: ${JSON.stringify({ tipsyAnimationStart, tipsyAnimationStopped })}`);
  await page.keyboard.down('w');
  await page.waitForTimeout(650);
  await page.keyboard.up('w');
  const tipsyAnimationMoving = await page.evaluate(() => window.__kkRacing.snapshot().monster.modelAnimation);
  assert(Math.abs(tipsyAnimationMoving.time - tipsyAnimationStopped.time) > 0.01,
    `Tipsy tires did not animate while driving: ${JSON.stringify({ tipsyAnimationStopped, tipsyAnimationMoving })}`);
  const tipsyMaterials = await page.evaluate(() => window.__kkRacing.snapshot().monster.modelMaterials);
  assert(tipsyMaterials?.materials >= 8 && tipsyMaterials.textured >= 6,
    `Tipsy Tumbler paint textures did not reach Three.js materials: ${JSON.stringify(tipsyMaterials)}`);
  await page.evaluate(() => window.__kkRacing.setMonsterRound(3));
  await page.evaluate(() => window.__kkRacing.warpToMonsterDistrict('bus-pyramid'));
  await page.waitForTimeout(500);
  await capture(page, SHOTS.busPyramid);
  if (process.env.KKS_MONSTER_TIPSY_ONLY === '1') {
    const tipsy = await page.evaluate(() => window.__kkRacing.snapshot());
    await page.evaluate(() => window.kkReturnToMenu());
    await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('#kk-racing-hud'));
    await context.close();
    return { tipsy };
  }
  await page.evaluate(() => {
    window.__kkRacing.setMonsterRound(2);
    window.__kkRacing.warpToMonsterDistrict('car-pyramid');
  });
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(before.arenaId === 'pileup-pyramid-yard', `wrong second arena loaded: ${before.arenaId}`);
  assert(before.courseName === 'Pileup Pyramid Yard', `second arena HUD has wrong name: ${before.courseName}`);
  assert(before.monster.totalTargets === 122, `grand pyramid yard should have 122 destructibles, got ${before.monster.totalTargets}`);
  assert(before.monster.round === 2 && before.monster.roundTargets === 23, 'five-round state did not activate Bale Breaker');
  assert(before.monster.arena.districts === 6, 'grand pyramid yard lost its six authored districts');
  assert(before.monster.destruction.structures === 2, 'car and bus support structures were not built');
  assert(before.monster.destruction.trafficModelsAttached, 'stacked vehicles did not receive production traffic models');
  assert(before.monster.destruction.dominoStanding === 78, 'domino perimeter did not begin with all cars standing');
  assert(before.monster.destruction.hotCars === 13 && before.monster.destruction.burningCars === 13, 'hot cars and flaming bales are not visibly armed at spawn');
  await capture(page, SHOTS.pyramid);

  const cornerId = await page.evaluate(() => {
    const target = window.kkState.racing.monsterArena.targets
      .find((entry) => entry.structureId === 'car-pyramid' && entry.stackLevel === 0);
    window.__kkRacing.warpToMonsterTarget(target.index);
    return target.id;
  });
  assert(/^car-pyramid-0-/.test(cornerId), `real ram did not target a bottom corner: ${cornerId}`);
  await page.waitForFunction((id) => {
    const target = window.kkState.racing.monsterArena.targets.find((entry) => entry.id === id);
    return !!target?.destroyed;
  }, cornerId, { timeout: 5000 });
  await page.waitForFunction(() => {
    const destruction = window.__kkRacing?.snapshot?.()?.monster?.destruction;
    return destruction?.collapseCount >= 1 && (destruction.falling + destruction.settled) >= 1;
  }, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const destruction = window.__kkRacing?.snapshot?.()?.monster?.destruction;
    return destruction?.destroyed > 1 && destruction?.collapseImpacts > 1;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(350);
  const after = await page.evaluate(() => ({
    snapshot: window.__kkRacing.snapshot(),
    targets: window.kkState.racing.monsterArena.targets
      .filter((target) => target.structureId === 'car-pyramid')
      .map((target) => ({ id: target.id, level: target.stackLevel, state: target.state, stackState: target.stackState, baseY: target.baseY })),
  }));
  assert(after.snapshot.monster.destruction.collapseCount === 1, 'one broken car corner did not register exactly one structural collapse');
  assert(after.snapshot.monster.destruction.collapseImpacts > 0, 'falling stack produced no impact contacts');
  assert(after.snapshot.monster.destruction.destroyed > 1, `corner failure did not cascade damage into the stacked cars: ${JSON.stringify(after)}`);
  assert(after.targets.some((target) => target.level > 0 && ['falling', 'settled'].includes(target.stackState)), 'upper car tiers remained suspended after support loss');
  await capture(page, SHOTS.pyramidCollapse);

  await page.evaluate(() => window.__kkRacing.setMonsterRound(4));
  await page.evaluate(() => window.__kkRacing.warpToMonsterDistrict('domino-perimeter'));
  await page.waitForTimeout(500);
  await capture(page, SHOTS.dominoPerimeter);
  const firstDominoId = await page.evaluate(() => {
    const target = window.kkState.racing.monsterArena.targets.find((entry) => entry.id === 'domino-north-0');
    window.__kkRacing.warpToMonsterTarget(target.index);
    return target.id;
  });
  await page.waitForFunction((id) => {
    const target = window.kkState.racing.monsterArena.targets.find((entry) => entry.id === id);
    return target?.dominoState === 'falling' || target?.dominoState === 'fallen';
  }, firstDominoId, { timeout: 5000 });
  try {
    await page.waitForFunction(() => {
      const destruction = window.__kkRacing?.snapshot?.()?.monster?.destruction;
      return destruction?.dominoImpacts >= 6
        && (destruction?.dominoFallen + destruction?.dominoFalling) >= 6
        && destruction?.explosions >= 1;
    }, null, { timeout: 30000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      destruction: window.__kkRacing?.snapshot?.()?.monster?.destruction,
      north: window.kkState.racing.monsterArena.targets
        .filter((target) => target.dominoGroup === 'domino-north')
        .map((target) => ({ id: target.id, state: target.state, domino: target.dominoState, pitch: target.pitch, fuse: target.explosionFuse, exploded: target.exploded })),
    }));
    console.error(`[domino-debug] ${JSON.stringify(debug)}`);
    throw error;
  }
  await page.waitForTimeout(180);
  const dominoAfter = await page.evaluate(() => ({
    snapshot: window.__kkRacing.snapshot(),
    calloutFontSize: parseFloat(getComputedStyle(document.querySelector('.kkr-callout')).fontSize),
    firePools: ['arena-hot-car-flame-outer', 'arena-hot-car-flame-inner', 'arena-pooled-hot-car-explosions']
      .map((name) => !!window.kkState.racing.root.getObjectByName(name)),
  }));
  assert(dominoAfter.snapshot.monster.destruction.dominoRuns >= 1, 'real ram did not register a domino run');
  assert(dominoAfter.snapshot.monster.destruction.explosions >= 1, 'burning perimeter car did not explode');
  assert(dominoAfter.snapshot.monster.destruction.burningCars < dominoAfter.snapshot.monster.destruction.hotCars, 'exploded hot car kept rendering as armed');
  assert(dominoAfter.firePools.every(Boolean), 'hot-car fire or explosion VFX pool is missing');
  assert(dominoAfter.calloutFontSize <= 18, `Monster points flash is still too large: ${dominoAfter.calloutFontSize}px`);
  await capture(page, SHOTS.dominoExplosion);

  // A perpendicular ram must tip a standing car across the run instead of
  // replaying the old hard-coded next/previous animation.
  await page.evaluate(() => {
    window.__kkRacing.setMonsterRound(4);
    const session = window.kkState.racing;
    session.monsterRounds.timeRemaining = 120;
    const target = session.monsterArena.targets.find((entry) => entry.id === 'domino-north-10');
    const kart = session.cars[0].physics;
    kart.x = target.dominoPivotX;
    kart.z = target.dominoPivotZ - 4;
    kart.previousX = kart.x;
    kart.previousZ = kart.z;
    kart.y = kart.previousY = target.ground;
    kart.yaw = 0;
    kart.vx = 0;
    kart.vz = 24;
    kart.vy = 0;
    kart.speed = 24;
    kart.grounded = true;
  });
  await page.waitForFunction(() => {
    const target = window.kkState.racing.monsterArena.targets.find((entry) => entry.id === 'domino-north-10');
    return target?.dominoState === 'falling';
  }, null, { timeout: 15000 });
  const sideImpact = await page.evaluate(() => {
    const target = window.kkState.racing.monsterArena.targets.find((entry) => entry.id === 'domino-north-10');
    return {
      fallX: target.dominoFallX,
      fallZ: target.dominoFallZ,
      vx: target.vx,
      vz: target.vz,
      vy: target.vy,
    };
  });
  assert(sideImpact.fallZ > 0.8 && Math.abs(sideImpact.fallX) < 0.35,
    `perpendicular domino ram ignored its impact vector: ${JSON.stringify(sideImpact)}`);
  assert(sideImpact.vz > 0.8 && sideImpact.vy > 0.25,
    `hard-hit domino car received no directional flight impulse: ${JSON.stringify(sideImpact)}`);
  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('#kk-racing-hud'));
  await context.close();
  return { pyramid: after.snapshot, domino: dominoAfter.snapshot, sideImpact };
}

async function lifecycleRun(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  watchPage(page, diagnostics);
  await prime(page);
  await page.evaluate(() => window.kkStartRacing('kakiland', { mode: 'monster', monsterVehicle: 'cyber' }));
  await waitArena(page, 'cyber', true);
  const firstRoot = await page.evaluate(() => window.kkState.racing.root.uuid);
  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('#kk-racing-hud'));
  await page.evaluate(() => window.kkStartRacing('kakiland', { mode: 'monster', monsterVehicle: 'cyber' }));
  await page.waitForFunction((uuid) => window.kkState?.racing?.root?.uuid && window.kkState.racing.root.uuid !== uuid, firstRoot, { timeout: 20000 });
  await waitArena(page, 'cyber', true);
  const restarted = await layoutSnapshot(page);
  assert(restarted.hudCount === 1 && restarted.arenaCount === 1, `restart duplicated lifecycle objects: ${JSON.stringify(restarted)}`);
  assert(!restarted.topbarMenuOverlap, 'restart Menu overlaps the Monster scoreboard');
  assert(restarted.textOverflow.length === 0, `restart HUD text clips: ${restarted.textOverflow.join(', ')}`);
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
    } else {
      await page.waitForSelector('.kkr-finish:not([hidden])', { timeout: 15000 });
    }
  }
  const completedRun = await page.evaluate(() => ({
    snapshot: window.__kkRacing.snapshot(),
    result: document.querySelector('.kkr-finish-pos')?.textContent || '',
    best: JSON.parse(localStorage.getItem('kks_rally_best_v1') || '{}')[`monster-speedrun-v1:${window.kkState.racing.monsterArenaDefinition.id}`] || 0,
  }));
  assert(completedRun.snapshot.monster.roundTimes.length === 5, 'five-level clear did not record five splits');
  assert(completedRun.snapshot.monster.roundTimes.every((time) => time > 0),
    `level splits were not recorded: ${JSON.stringify(completedRun.snapshot.monster.roundTimes)}`);
  assert(completedRun.snapshot.monster.rank === 'S' && completedRun.result.startsWith('S · '),
    `fast five-level clear was not ranked by completion time: ${JSON.stringify(completedRun)}`);
  assert(completedRun.best > 0 && Math.abs(completedRun.best - completedRun.snapshot.monster.runTime) < 0.1,
    'five-level completion time was not stored as the lower-is-better personal best');
  await page.evaluate(() => window.kkReturnToMenu());
  await page.waitForFunction(() => !window.kkState?.racing && !document.querySelector('#kk-racing-hud'));
  const cacheAfterExit = await page.evaluate(() => document.body.dataset.racingCacheAfterExit);
  assert(cacheAfterExit === '0', `restart path leaked rally assets: ${cacheAfterExit}`);
  await context.close();
  return restarted;
}

async function touchRun(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  watchPage(page, diagnostics);
  await prime(page);
  await page.evaluate(() => window.kkStartRacing('forest', { mode: 'monster', monsterVehicle: 'meowster' }));
  await waitArena(page, 'meowster');
  const layout = await layoutSnapshot(page);
  assert(layout.touch && layout.touch.width >= 120, 'touch Monster controls are not visible/reachable');
  assert(!layout.touchChaosOverlap && !layout.touchHealthOverlap && !layout.touchSpeedOverlap, 'touch controls cover essential Monster instruments');
  assert(Object.values(layout.inside).every(Boolean), 'narrow Monster HUD escaped the stage safe area');
  assert(!layout.topbarMenuOverlap, 'touch Menu overlaps the Monster scoreboard');
  assert(layout.scrollWidth === layout.viewport.width, 'narrow viewport has horizontal overflow');
  await capture(page, SHOTS.mobile);
  await page.setViewportSize({ width: 571, height: 349 });
  await page.waitForTimeout(120);
  const compactLayout = await layoutSnapshot(page);
  assert(compactLayout.touch && compactLayout.touch.width >= 120, '571x349 touch controls are not visible/reachable');
  assert(!compactLayout.touchChaosOverlap && !compactLayout.touchHealthOverlap && !compactLayout.touchSpeedOverlap, '571x349 touch controls cover essential Monster instruments');
  assert(Object.values(compactLayout.inside).every(Boolean), '571x349 touch HUD escaped the stage safe area');
  assert(compactLayout.scrollWidth === compactLayout.viewport.width, '571x349 touch viewport has horizontal overflow');
  assert(compactLayout.hudOverlaps.length === 0, `571x349 touch HUD overlaps: ${compactLayout.hudOverlaps.join(', ')}`);
  assert(compactLayout.textOverflow.length === 0, `571x349 touch text clips: ${compactLayout.textOverflow.join(', ')}`);
  assert(compactLayout.panels['.kkr-topbar'].height <= 46, `571x349 touch topbar is still oversized: ${compactLayout.panels['.kkr-topbar'].height}`);
  assert(compactLayout.calloutFontSize <= 52, `571x349 touch callout is still oversized: ${compactLayout.calloutFontSize}px`);
  await capture(page, SHOTS.compactTouch);
  const snapshot = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(snapshot.monster.vehicleId === 'meowster', 'Mighty Meowster selection did not reach gameplay');
  await context.close();
  return { snapshot, layout, compactLayout };
}

async function exteriorOnlyRun(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  watchPage(page, diagnostics);
  await prime(page);
  await page.evaluate(() => window.kkStartRacing('kakiland', { mode: 'monster', monsterVehicle: 'cyber' }));
  await waitArena(page, 'cyber', true);
  await page.evaluate(() => window.__kkRacing.warpToMonsterDistrict('perimeter-freestyle'));
  await page.waitForTimeout(450);
  await capture(page, SHOTS.exterior);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const raycaster = new THREE.Raycaster();
    const rayHits = [[10, 10], [200, 40], [640, 10], [1100, 40]].map(([x, y]) => {
      raycaster.setFromCamera(new THREE.Vector2(x / 640 - 1, 1 - y / 360), window.kkState.camera);
      const hit = raycaster.intersectObject(window.kkState.racing.root, true)[0];
      const mappedUv = hit?.uv?.clone();
      if (mappedUv && hit.object.material?.map) hit.object.material.map.transformUv(mappedUv);
      return {
        x,
        y,
        name: hit?.object?.name || '',
        distance: hit?.distance || 0,
        uv: hit?.uv ? [hit.uv.x, hit.uv.y] : null,
        mappedUv: mappedUv ? [mappedUv.x, mappedUv.y] : null,
      };
    });
    return {
    snapshot: window.__kkRacing.snapshot(),
    backgroundMatches: window.kkState.scene.background === window.kkState.racing.assetLease.textures.monsterArenaBackdrop,
    backdropWalls: window.kkState.racing.monsterArenaView.exterior.backdrop.children.map((mesh) => {
      mesh.geometry.computeBoundingBox();
      const { min, max } = mesh.geometry.boundingBox;
      const projected = [
        [min.x, min.y, min.z], [max.x, min.y, min.z], [min.x, max.y, min.z], [max.x, max.y, min.z],
      ].map(([x, y, z]) => min.clone().set(x, y, z).applyMatrix4(mesh.matrixWorld).project(window.kkState.camera));
      return {
        name: mesh.name,
        ndc: {
          minX: Math.min(...projected.map((point) => point.x)),
          maxX: Math.max(...projected.map((point) => point.x)),
          minY: Math.min(...projected.map((point) => point.y)),
          maxY: Math.max(...projected.map((point) => point.y)),
          minZ: Math.min(...projected.map((point) => point.z)),
          maxZ: Math.max(...projected.map((point) => point.z)),
        },
        mapped: !!mesh.material.map?.image,
      };
    }),
      rayHits,
    };
  });
  await context.close();
  return result;
}

async function main() {
  assert(fs.existsSync(PLAYWRIGHT), `Playwright missing: ${PLAYWRIGHT}`);
  assert(fs.existsSync(CHROMIUM), `Chromium missing: ${CHROMIUM}`);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const diagnostics = { errors: [], consoleErrors: [], badResponses: [] };
  try {
    if (process.env.KKS_MONSTER_CAPTURE_ONLY === '1') {
      const exterior = await exteriorOnlyRun(browser, diagnostics);
      assert(exterior.backgroundMatches, 'capture-only run lost the production exterior background');
      assert(diagnostics.errors.length === 0 && diagnostics.badResponses.length === 0, `capture-only diagnostics failed: ${JSON.stringify(diagnostics)}`);
      console.log(JSON.stringify({ status: 'PASS', captureOnly: true, exterior, screenshot: SHOTS.exterior }, null, 2));
      return;
    }
    if (process.env.KKS_MONSTER_MENU_ONLY === '1') {
      const result = await desktopRun(browser, diagnostics);
      assert(diagnostics.errors.length === 0 && diagnostics.badResponses.length === 0,
        `garage diagnostics failed: ${JSON.stringify(diagnostics)}`);
      console.log(JSON.stringify({ status: 'PASS', garage: result.garageLayout, screenshot: SHOTS.menu }, null, 2));
      return;
    }
    if (process.env.KKS_MONSTER_TIPSY_ONLY === '1') {
      const result = await pyramidRun(browser, diagnostics);
      assert(diagnostics.errors.length === 0 && diagnostics.badResponses.length === 0,
        `Tipsy diagnostics failed: ${JSON.stringify(diagnostics)}`);
      console.log(JSON.stringify({ status: 'PASS', tipsy: result.tipsy.monster, screenshot: SHOTS.busPyramid }, null, 2));
      return;
    }
    if (process.env.KKS_MONSTER_PYRAMID_ONLY === '1') {
      const pyramid = await pyramidRun(browser, diagnostics);
      assert(diagnostics.errors.length === 0 && diagnostics.badResponses.length === 0, `pyramid diagnostics failed: ${JSON.stringify(diagnostics)}`);
      console.log(JSON.stringify({
        status: 'PASS',
        pyramid: pyramid.pyramid.monster.destruction,
        domino: pyramid.domino.monster.destruction,
        sideImpact: pyramid.sideImpact,
        screenshots: SHOTS,
      }, null, 2));
      return;
    }
    const desktop = await desktopRun(browser, diagnostics);
    const pyramid = await pyramidRun(browser, diagnostics);
    const lifecycle = await lifecycleRun(browser, diagnostics);
    const touch = await touchRun(browser, diagnostics);
    assert(diagnostics.errors.length === 0, `page errors: ${diagnostics.errors.join(' | ')}`);
    assert(diagnostics.badResponses.length === 0, `local HTTP failures: ${diagnostics.badResponses.join(' | ')}`);
    const productionErrors = diagnostics.consoleErrors.filter((message) => !/favicon|Failed to load resource.*fonts\.gstatic/i.test(message));
    assert(productionErrors.length === 0, `console errors: ${productionErrors.join(' | ')}`);
    console.log(JSON.stringify({
      status: 'PASS',
      busyPerformance: desktop.busy.performance,
      busyInventory: desktop.busyInventory,
      activeCaps: desktop.busy.monster.destruction,
      desktopStage: desktop.busyLayout.stage,
      sixteenTenStage: desktop.sixteenTenLayout.stage,
      laptopStage: desktop.laptopLayout.stage,
      ultrawideStage: desktop.ultrawideLayout.stage,
      superUltrawideStage: desktop.superUltrawideLayout.stage,
      compactHud: desktop.compactHudLayout,
      compactFinishStage: desktop.compactFinishLayout.stage,
      touchStage: touch.layout.stage,
      compactTouch: touch.compactLayout,
      restartLayout: lifecycle,
      pyramidCollapse: pyramid.pyramid.monster.destruction,
      dominoChain: pyramid.domino.monster.destruction,
      dominoSideImpact: pyramid.sideImpact,
      screenshots: SHOTS,
    }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`[smoke-monster-arena-visual] FAIL: ${error.stack || error.message}`);
  try { server.close(); } catch (_) {}
  process.exitCode = 1;
});
