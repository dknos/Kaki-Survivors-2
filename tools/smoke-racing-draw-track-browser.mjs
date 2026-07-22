#!/usr/bin/env node
/** Real-browser draw -> overpass build -> race smoke for Draw Your Track. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8895);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PLAYWRIGHT = '/home/nemoclaw/node_modules/playwright';
const CHROMIUM = '/home/nemoclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const SCOPE = process.env.DRAW_SMOKE_SCOPE || 'all';
const require = createRequire(import.meta.url);
const SHOTS = {
  menu: '/tmp/kks-draw-track-menu.png',
  closure: '/tmp/kks-draw-track-closure.png',
  editor: '/tmp/kks-draw-track-editor.png',
  overLimit: '/tmp/kks-draw-track-over-limit.png',
  start: '/tmp/kks-draw-track-start-finish.png',
  race: '/tmp/kks-draw-track-race.png',
  bridge: '/tmp/kks-draw-track-overpass.png',
  touch: '/tmp/kks-draw-track-touch.png',
};

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
  if (file.endsWith('.mp3')) return 'audio/mpeg';
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

function watch(page, diagnostics) {
  page.on('pageerror', (error) => diagnostics.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const source = message.location()?.url;
      diagnostics.consoleErrors.push(source ? `${message.text()} @ ${source}` : message.text());
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(ORIGIN)) diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
  });
}

async function boot(page) {
  await page.addInitScript(() => {
    localStorage.setItem('kks_introSeen', '1');
    localStorage.setItem('kks_forestTrialsIntroSeen_v1', '1');
  });
  await page.goto(`${ORIGIN}/index.html?qa=1&drawSmoke=1`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof window.kkStartRacing === 'function' && !!document.querySelector('.kkv2-navitem[data-nav="racing"]'), null, { timeout: 90000 });
}

async function openEditor(page) {
  await page.click('.kkv2-navitem[data-nav="racing"]');
  await page.waitForSelector('.kkv2-race-overlay');
  await page.waitForSelector('.kkv2-race-card-draw svg .kkv2-draw-line');
  await page.click('.kkv2-race-card[data-mode="draw"]');
  await page.click('.kkv2-overlay-confirm');
  await page.waitForSelector('.kdt-editor');
  await page.waitForSelector('.kdt-canvas');
}

async function drawFigureEight(page, pointerType = 'mouse') {
  const box = await page.locator('.kdt-canvas').boundingBox();
  assert(box && box.width > 300 && box.height > 180, 'drawing canvas is not usefully sized');
  const points = Array.from({ length: 181 }, (_, index) => {
    const angle = index / 180 * Math.PI * 2;
    return {
      x: box.x + box.width * (0.5 + Math.sin(angle) * 0.33),
      y: box.y + box.height * (0.5 + Math.sin(angle) * Math.cos(angle) * 0.29),
    };
  });
  await page.evaluate(({ points, pointerType }) => {
      const canvas = document.querySelector('.kdt-canvas');
      const fire = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType, isPrimary: true,
        clientX: point.x, clientY: point.y, button: 0, buttons,
      }));
      fire('pointerdown', points[0], 1);
      for (const point of points.slice(1)) fire('pointermove', point, 1);
      fire('pointerup', points.at(-1), 0);
    }, { points, pointerType });
}

async function dispatchStroke(page, points, { pointerType = 'mouse', pointerId = 17, release = true } = {}) {
  await page.evaluate(({ points, pointerType, pointerId, release }) => {
    const canvas = document.querySelector('.kdt-canvas');
    const fire = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType, isPrimary: true,
      clientX: point.x, clientY: point.y, button: 0, buttons,
    }));
    fire('pointerdown', points[0], 1);
    for (const point of points.slice(1)) fire('pointermove', point, 1);
    if (release) fire('pointerup', points.at(-1), 0);
  }, { points, pointerType, pointerId, release });
}

function linePoints(from, to, count = 24) {
  return Array.from({ length: count }, (_, index) => {
    const t = index / Math.max(1, count - 1);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}

async function drawResumableRectangle(page) {
  const box = await page.locator('.kdt-canvas').boundingBox();
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  const start = at(0.24, 0.22);
  const topRight = at(0.78, 0.22);
  const bottomRight = at(0.78, 0.76);
  const endpoint = at(0.24, 0.76);
  const openPoints = [
    ...linePoints(start, topRight),
    ...linePoints(topRight, bottomRight).slice(1),
    ...linePoints(bottomRight, endpoint).slice(1),
  ];
  await dispatchStroke(page, openPoints, { pointerId: 21 });
  const openState = await page.evaluate(() => ({
    closed: window.__kdtEditor?.closed,
    count: window.__kdtEditor?.draft.rawStroke.length,
    status: document.querySelector('[data-role="status"]')?.textContent,
  }));
  assert(openState.closed === false && openState.count > 30, 'far release did not preserve an editable open path');

  await dispatchStroke(page, [at(0.52, 0.48), at(0.61, 0.43)], { pointerId: 22 });
  const afterUnrelatedClick = await page.evaluate(() => window.__kdtEditor?.draft.rawStroke.length);
  assert(afterUnrelatedClick === openState.count, 'unrelated click inserted a discontinuous jump');

  const liveEndpoints = await page.evaluate(() => {
    const ui = window.__kdtEditor; const rect = ui.canvas.getBoundingClientRect();
    const start = ui.normalizedToScreen(ui.draft.rawStroke[0]);
    const end = ui.normalizedToScreen(ui.draft.rawStroke.at(-1));
    return {
      start: { x: rect.left + start.x, y: rect.top + start.y },
      end: { x: rect.left + end.x, y: rect.top + end.y },
    };
  });
  const closePoint = { x: liveEndpoints.start.x, y: liveEndpoints.start.y + 52 };
  const resumePoints = linePoints(liveEndpoints.end, closePoint, 30);
  await dispatchStroke(page, resumePoints, { pointerId: 23, release: false });
  const magnetic = await page.evaluate(() => ({
    status: document.querySelector('[data-role="status"]')?.textContent,
    magnetic: window.__kdtEditor?.closureState?.magnetic,
    distance: window.__kdtEditor?.closureState?.distance,
  }));
  assert(magnetic.magnetic && /release to close/i.test(magnetic.status), `52 px mouse closure did not enter magnetic state: ${JSON.stringify(magnetic)}`);
  await page.screenshot({ path: SHOTS.closure });
  await page.evaluate(({ closePoint }) => {
    document.querySelector('.kdt-canvas').dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 23, pointerType: 'mouse', isPrimary: true,
      clientX: closePoint.x, clientY: closePoint.y, button: 0, buttons: 0,
    }));
  }, { closePoint });
  await page.waitForTimeout(250);
  const closedState = await page.evaluate(() => ({
    closed: window.__kdtEditor?.closed,
    valid: window.__kdtEditor?.validation?.valid,
    errors: window.__kdtEditor?.validation?.errors?.map((issue) => [issue.id, issue.message]),
    rawCount: window.__kdtEditor?.draft?.rawStroke?.length,
    controlCount: window.__kdtEditor?.draft?.controlPoints?.length,
    length: window.__kdtEditor?.validation?.stats?.length,
  }));
  assert(closedState.closed && closedState.valid, `magnetically closed rectangle was not raceable: ${JSON.stringify(closedState)}`);
  return { box, start };
}

async function desktop(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  watch(page, diagnostics);
  await boot(page);
  await page.click('.kkv2-navitem[data-nav="racing"]');
  await page.waitForSelector('.kkv2-race-card-draw');
  const card = await page.locator('.kkv2-race-card-draw').innerText();
  assert(card.includes('DRAW IT. BUILD IT. RACE IT.'), 'mode card lost its core promise');
  assert(card.includes('MOUSE + TOUCH + PAD'), 'mode card does not advertise its input support');
  await page.screenshot({ path: SHOTS.menu });
  await page.click('.kkv2-race-card[data-mode="draw"]');
  await page.click('.kkv2-overlay-confirm');
  await page.waitForSelector('.kdt-editor');
  await drawResumableRectangle(page);
  const roundedRectangle = await page.evaluate(() => ({
    valid: window.__kdtEditor?.validation?.valid,
    cornerRounded: window.__kdtEditor?.validation?.issues?.some((issue) => issue.id === 'corner-rounded'),
    tightest: window.__kdtEditor?.validation?.stats?.tightestRadius,
    required: window.__kdtEditor?.validation?.radii?.required,
  }));
  assert(roundedRectangle.valid && roundedRectangle.cornerRounded, `rough rectangle was not rounded into a raceable track: ${JSON.stringify(roundedRectangle)}`);

  const beforeDeform = await page.evaluate(() => {
    const ui = window.__kdtEditor;
    const sample = ui.validation.normalizedSamples[Math.floor(ui.validation.normalizedSamples.length * 0.16)];
    const local = ui.normalizedToScreen(sample);
    const rect = ui.canvas.getBoundingClientRect();
    return {
      point: { x: rect.left + local.x, y: rect.top + local.y },
      raw: JSON.stringify(ui.draft.rawStroke),
      length: ui.validation.stats.length,
      history: ui.history.length,
    };
  });
  await dispatchStroke(page, [beforeDeform.point, { x: beforeDeform.point.x, y: beforeDeform.point.y + 18 }], { pointerId: 31 });
  const afterDeform = await page.evaluate(() => ({
    raw: JSON.stringify(window.__kdtEditor.draft.rawStroke),
    length: window.__kdtEditor.validation.stats.length,
    history: window.__kdtEditor.history.length,
  }));
  assert(afterDeform.raw !== beforeDeform.raw && Math.abs(afterDeform.length - beforeDeform.length) > 0.5, 'dragging a closed road section did not deform the route');
  assert(afterDeform.history === beforeDeform.history + 1, 'one deformation gesture did not create exactly one undo entry');
  await page.click('[data-action="undo"]');
  const undoDeform = await page.evaluate(() => JSON.stringify(window.__kdtEditor.draft.rawStroke));
  assert(undoDeform === beforeDeform.raw, 'Undo did not restore the exact pre-deformation stroke');
  await page.click('[data-action="redo"]');
  const redoDeform = await page.evaluate(() => JSON.stringify(window.__kdtEditor.draft.rawStroke));
  assert(redoDeform === afterDeform.raw, 'Redo did not restore the deformation exactly');

  const beforeStretch = await page.evaluate(() => {
    const ui = window.__kdtEditor;
    const handle = ui.selectionHandles().e;
    const local = ui.normalizedToScreen(handle);
    const rect = ui.canvas.getBoundingClientRect();
    return { point: { x: rect.left + local.x, y: rect.top + local.y }, layout: { ...ui.draft.layoutTransform }, length: ui.validation.stats.length, history: ui.history.length };
  });
  await dispatchStroke(page, [beforeStretch.point, { x: beforeStretch.point.x + 54, y: beforeStretch.point.y }], { pointerId: 32 });
  const stretched = await page.evaluate(() => ({ layout: { ...window.__kdtEditor.draft.layoutTransform }, length: window.__kdtEditor.validation.stats.length, history: window.__kdtEditor.history.length }));
  assert(stretched.layout.scaleX > beforeStretch.layout.scaleX + 0.04 && stretched.length > beforeStretch.length + 4, 'horizontal stretch handle did not materially change world dimensions');
  assert(stretched.history === beforeStretch.history + 1, 'stretch gesture did not create exactly one undo entry');
  await page.click('[data-action="undo"]');
  const undoLayout = await page.evaluate(() => window.__kdtEditor.draft.layoutTransform);
  assert(Math.abs(undoLayout.scaleX - beforeStretch.layout.scaleX) < 1e-9 && Math.abs(undoLayout.offsetX - beforeStretch.layout.offsetX) < 1e-9, 'Undo did not restore the exact pre-stretch transform');
  await page.click('[data-action="redo"]');
  await page.screenshot({ path: SHOTS.editor });

  const beforeStart = await page.evaluate(() => {
    const ui = window.__kdtEditor;
    const marker = ui.startMarkerPoint();
    const samples = ui._baseSamples();
    const target = samples[Math.round(samples.length * 0.32) % samples.length];
    const rect = ui.canvas.getBoundingClientRect();
    const from = ui.normalizedToScreen(marker);
    const to = ui.normalizedToScreen(target);
    return {
      from: { x: rect.left + from.x, y: rect.top + from.y },
      to: { x: rect.left + to.x, y: rect.top + to.y },
      fraction: ui.draft.startFraction,
      history: ui.history.length,
    };
  });
  await dispatchStroke(page, [beforeStart.from, beforeStart.to], { pointerId: 33 });
  const movedStart = await page.evaluate(() => ({
    fraction: window.__kdtEditor.draft.startFraction,
    gridError: window.__kdtEditor.validation.errors.some((issue) => issue.id.startsWith('grid-')),
    history: window.__kdtEditor.history.length,
  }));
  assert(Math.abs(movedStart.fraction - beforeStart.fraction) > 0.03 && !movedStart.gridError, 'dragged start / finish did not snap to a different safe straight');
  assert(movedStart.history === beforeStart.history + 1, 'start-line drag did not create exactly one undo entry');
  await page.click('[data-action="undo"]');
  const undoStart = await page.evaluate(() => window.__kdtEditor.draft.startFraction);
  assert(Math.abs(undoStart - beforeStart.fraction) < 1e-9, 'Undo did not restore the exact pre-drag start line');
  await page.click('[data-action="redo"]');
  const redoStart = await page.evaluate(() => window.__kdtEditor.draft.startFraction);
  assert(Math.abs(redoStart - movedStart.fraction) < 1e-9, 'Redo did not restore the moved start line exactly');
  await page.screenshot({ path: SHOTS.start });

  const overLimit = await page.evaluate(() => {
    const ui = window.__kdtEditor;
    const handle = ui.selectionHandles().se;
    const bounds = points => {
      const xs = points.map((point) => point.x); const ys = points.map((point) => point.y);
      return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    const box = bounds(ui._baseSamples());
    ui.beginLayoutTransform('se', handle);
    ui.updateLayoutTransform({ x: handle.x + box.width * 0.58, y: handle.y + box.height * 0.58 });
    ui.endLayoutTransform();
    return {
      length: ui.validation.stats.length,
      max: ui.validation.size.maxLength,
      message: document.querySelector('[data-role="length-message"]').textContent,
      raw: JSON.stringify(ui.draft.rawStroke),
      layout: JSON.stringify(ui.draft.layoutTransform),
    };
  });
  assert(overLimit.length > overLimit.max && /over/i.test(overLimit.message), `length budget did not expose over-limit recovery: ${JSON.stringify(overLimit)}`);
  await page.click('[data-action="repair"]');
  await page.screenshot({ path: SHOTS.overLimit });
  await page.click('[data-action="apply-repair"]');
  const recovered = await page.evaluate(() => ({
    valid: window.__kdtEditor.validation.valid,
    length: window.__kdtEditor.validation.stats.length,
    max: window.__kdtEditor.validation.size.maxLength,
    errors: window.__kdtEditor.validation.errors.map((issue) => issue.id),
  }));
  assert(recovered.valid && recovered.length < overLimit.length && !recovered.errors.includes('extreme-length'), `Make Raceable did not recover the over-limit layout: ${JSON.stringify(recovered)}`);
  await page.click('[data-action="undo"]');
  const undoRepair = await page.evaluate(() => ({
    raw: JSON.stringify(window.__kdtEditor.draft.rawStroke),
    layout: JSON.stringify(window.__kdtEditor.draft.layoutTransform),
  }));
  assert(undoRepair.raw === overLimit.raw && undoRepair.layout === overLimit.layout, 'Undo did not restore the exact pre-repair track');
  await page.click('[data-action="redo"]');
  const redoRepair = await page.evaluate(() => ({
    valid: window.__kdtEditor.validation.valid,
    length: window.__kdtEditor.validation.stats.length,
  }));
  assert(redoRepair.valid && Math.abs(redoRepair.length - recovered.length) < 1e-6, 'Redo did not restore the raceable repair exactly');

  await page.click('[data-action="clear"]');
  await page.click('[data-action="clear"]');
  const cleared = await page.evaluate(() => ({ count: window.__kdtEditor.draft.rawStroke.length, closed: window.__kdtEditor.closed }));
  assert(cleared.count === 0 && !cleared.closed, `Clear did not reset the transformed draft: ${JSON.stringify(cleared)}`);
  await page.click('[data-size="grand"]');
  await drawFigureEight(page);
  await page.waitForTimeout(250);
  const figureState = await page.evaluate(() => ({
    closed: window.__kdtEditor?.closed,
    valid: window.__kdtEditor?.validation?.valid,
    errors: window.__kdtEditor?.validation?.errors?.map((issue) => issue.id),
    rawCount: window.__kdtEditor?.draft?.rawStroke?.length,
    controlCount: window.__kdtEditor?.draft?.controlPoints?.length,
    status: document.querySelector('[data-role="status"]')?.textContent,
  }));
  assert(figureState.closed && figureState.valid, `figure eight did not become buildable: ${JSON.stringify(figureState)}`);
  const editor = await page.evaluate(() => ({
    status: document.querySelector('[data-role="status"]')?.textContent,
    length: document.querySelector('[data-stat="length"]')?.textContent,
    personality: document.querySelector('[data-stat="personality"]')?.textContent,
    overpassMarkers: [...document.querySelectorAll('[data-role="status"]')].some((node) => /OVERPASS/.test(node.textContent)),
    canvas: document.querySelector('.kdt-canvas')?.getBoundingClientRect().toJSON(),
    root: document.querySelector('.kdt-editor')?.getBoundingClientRect().toJSON(),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(/race ready/i.test(editor.status), `figure eight is not buildable: ${editor.status}`);
  assert(/OVERPASS/.test(editor.status), 'safe crossing was not communicated as an overpass');
  assert(/m$/.test(editor.length), 'live length metric is missing');
  assert(editor.canvas.width > editor.root.width * 0.45, 'edge rails leave too little drafting space');
  assert(editor.scrollWidth === 1440, 'editor causes horizontal page overflow');
  await page.click('.kdt-build');
  await page.waitForSelector('.kdt-build-reveal:not([hidden])');
  await page.evaluate(() => document.querySelector('[data-action="skip-build"]')?.click());
  await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.raceMode === 'draw', null, { timeout: 90000 });
  await page.evaluate(() => window.__kkRacing.skipCountdown());
  await page.waitForTimeout(1000);
  const race = await page.evaluate(() => {
    const session = window.kkState.racing;
    const elevations = session.samples.map((sample) => sample.y || 0);
    return {
      snapshot: window.__kkRacing.snapshot(),
      maxElevation: Math.max(...elevations),
      minElevation: Math.min(...elevations),
      bridgeRails: session.root.getObjectsByProperty('name', 'draw-track-bridge-guardrails').length,
      bridgeSupports: session.root.getObjectsByProperty('name', 'draw-track-bridge-supports').length,
      bridgeDecks: session.root.getObjectsByProperty('name', 'draw-track-bridge-decks').length,
      bridgeFascias: session.root.getObjectsByProperty('name', 'draw-track-bridge-fascias').length,
      bridgePortalPosts: session.root.getObjectsByProperty('name', 'draw-track-bridge-portal-posts').length,
      bridgePortalBeams: session.root.getObjectsByProperty('name', 'draw-track-bridge-portal-beams').length,
      bridgeMarkerLights: session.root.getObjectsByProperty('name', 'draw-track-bridge-marker-lights').length,
      underFraction: session.course.overpasses[0]?.underFraction,
      sceneryPrimaryCount: session.environment?.sceneryLayout?.primary?.length,
      sceneryDressingCount: session.environment?.sceneryLayout?.dressing?.length,
      sceneryClear: [...(session.environment?.sceneryLayout?.primary || []), ...(session.environment?.sceneryLayout?.dressing || [])]
        .every((site) => site.edgeClearance + 1e-5 >= site.requiredClearance),
      aiPoints: session.aiPath.length,
      checkpoints: session.checkpoints.length,
      hudCount: document.querySelectorAll('#kk-racing-hud').length,
    };
  });
  assert(race.snapshot.customTrackId, 'runtime lost the custom track identity');
  assert(race.snapshot.overpasses === 1, `runtime expected one overpass, got ${race.snapshot.overpasses}`);
  assert(race.maxElevation > 4.5 && race.minElevation === 0, 'overpass elevation profile is missing or blocks the underpass');
  assert(race.bridgeRails === 1 && race.bridgeSupports === 1, 'guarded overpass kit was not built');
  assert(race.bridgeDecks === 1 && race.bridgeFascias === 1, 'bridge deck or structural fascia was not built');
  assert(race.bridgePortalPosts === 1 && race.bridgePortalBeams === 1, 'illuminated overpass portal frames were not built');
  assert(race.bridgeMarkerLights === 1, 'overpass approach and underpass marker lights were not built');
  assert(Number.isFinite(race.underFraction), 'runtime bridge lost lower-route crossing metadata');
  assert(race.sceneryPrimaryCount > 12 && race.sceneryDressingCount > 12, 'track clearance removed too much scenery');
  assert(race.sceneryClear, 'trackside scenery overlaps a different branch of the road');
  assert(race.aiPoints >= 200 && race.checkpoints >= 8, 'AI/checkpoint routes are incomplete');
  assert(race.hudCount === 1, 'draw race mounted duplicate HUDs');

  const elevationContact = await page.evaluate(async () => {
    const session = window.kkState.racing;
    const index = session.samples.reduce((best, sample, at) => sample.y > session.samples[best].y ? at : best, 0);
    const sample = session.samples[index];
    const kart = session.cars[0].physics;
    Object.assign(kart, {
      x: sample.x, z: sample.z, y: sample.y, groundHeight: sample.y, nearestIndex: index,
      yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
      vx: 0, vy: 0, vz: 0, speed: 0, grounded: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    return { y: kart.y, groundHeight: kart.groundHeight, nearestIndex: kart.nearestIndex, target: sample.y };
  });
  assert(elevationContact.y > 4 && elevationContact.groundHeight > 4, 'visible bridge and driving collision height disagree');
  await page.screenshot({ path: SHOTS.race });
  await page.evaluate(() => window.__kkRacing.setCameraMode('chase'));
  await page.waitForTimeout(650);
  await page.screenshot({ path: SHOTS.bridge });

  await page.evaluate(() => document.querySelector('[data-action="save-track"]')?.click());
  const savedCount = await page.evaluate(() => JSON.parse(localStorage.getItem('kks_draw_tracks_v1') || '{}').tracks?.length || 0);
  assert(savedCount === 1, 'post-race Save did not persist the drawn track');
  await page.evaluate(() => document.querySelector('[data-action="reverse"]')?.click());
  await page.waitForFunction(() => window.kkState.racing?.raceMode === 'draw' && window.kkState.racing.course.drawDirection === 'reverse', null, { timeout: 45000 });
  const reversed = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(reversed.overpasses === 1, 'reverse layout lost its overpass');
  await context.close();
}

async function touch(browser, diagnostics) {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  watch(page, diagnostics);
  await boot(page);
  await openEditor(page);
  const touchBox = await page.locator('.kdt-canvas').boundingBox();
  const touchAt = (x, y) => ({ x: touchBox.x + touchBox.width * x, y: touchBox.y + touchBox.height * y });
  const touchStart = touchAt(0.22, 0.18);
  const touchClose = { x: touchStart.x, y: touchStart.y + 70 };
  const touchRectangle = [
    ...linePoints(touchStart, touchAt(0.78, 0.18), 22),
    ...linePoints(touchAt(0.78, 0.18), touchAt(0.78, 0.78), 20).slice(1),
    ...linePoints(touchAt(0.78, 0.78), touchAt(0.22, 0.78), 22).slice(1),
    ...linePoints(touchAt(0.22, 0.78), touchClose, 18).slice(1),
  ];
  await dispatchStroke(page, touchRectangle, { pointerType: 'touch', pointerId: 41, release: false });
  const touchMagnet = await page.evaluate(() => ({
    magnetic: window.__kdtEditor?.closureState?.magnetic,
    distance: window.__kdtEditor?.closureState?.distance,
    status: document.querySelector('[data-role="status"]')?.textContent,
  }));
  assert(touchMagnet.magnetic && touchMagnet.distance >= 68 && /release to close/i.test(touchMagnet.status), `approximately 70 px touch closure did not snap: ${JSON.stringify(touchMagnet)}`);
  await page.evaluate(({ touchClose }) => document.querySelector('.kdt-canvas').dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true, pointerId: 41, pointerType: 'touch', isPrimary: true,
    clientX: touchClose.x, clientY: touchClose.y, button: 0, buttons: 0,
  })), { touchClose });
  await page.waitForTimeout(250);
  const touchClosed = await page.evaluate(() => ({
    closed: window.__kdtEditor?.closed,
    valid: window.__kdtEditor?.validation?.valid,
    errors: window.__kdtEditor?.validation?.errors?.map((issue) => [issue.id, issue.message]),
    length: window.__kdtEditor?.validation?.stats?.length,
    rawCount: window.__kdtEditor?.draft?.rawStroke?.length,
  }));
  assert(touchClosed.closed && touchClosed.valid, `touch rectangle closed but was not raceable: ${JSON.stringify(touchClosed)}`);
  const touchEdit = await page.evaluate(() => {
    const ui = window.__kdtEditor;
    const point = ui.validation.normalizedSamples[Math.floor(ui.validation.normalizedSamples.length * 0.2)];
    const local = ui.normalizedToScreen(point); const rect = ui.canvas.getBoundingClientRect();
    return { point: { x: rect.left + local.x, y: rect.top + local.y }, raw: JSON.stringify(ui.draft.rawStroke) };
  });
  await dispatchStroke(page, [touchEdit.point, { x: touchEdit.point.x + 24, y: touchEdit.point.y + 12 }], { pointerType: 'touch', pointerId: 42 });
  assert(await page.evaluate((raw) => JSON.stringify(window.__kdtEditor.draft.rawStroke) !== raw, touchEdit.raw), 'touch drag did not reshape a closed road section');
  await page.click('[data-action="clear"]');
  await page.click('[data-action="clear"]');
  await page.click('[data-action="options"]');
  if (process.env.DRAW_SMOKE_DEBUG) {
    console.log(`SETUP ${JSON.stringify(await page.evaluate(() => {
      const inspector = document.querySelector('.kdt-inspector');
      const target = document.querySelector('[data-size="grand"]');
      return {
        rootClass: document.querySelector('.kdt-editor').className,
        inspector: inspector.getBoundingClientRect().toJSON(),
        target: target.getBoundingClientRect().toJSON(),
        opacity: getComputedStyle(inspector).opacity,
        pointerEvents: getComputedStyle(inspector).pointerEvents,
        scrollWidth: inspector.scrollWidth,
      };
    }))}`);
  }
  await page.click('[data-size="grand"]');
  await page.click('[data-action="options"]');
  await drawFigureEight(page, 'touch');
  await page.waitForSelector('.kdt-build:not([disabled])', { timeout: 15000 });
  const touchLayout = await page.evaluate(() => {
    const root = document.querySelector('.kdt-editor').getBoundingClientRect();
    const canvas = document.querySelector('.kdt-canvas').getBoundingClientRect();
    const build = document.querySelector('.kdt-build').getBoundingClientRect();
    const tools = document.querySelector('.kdt-tools').getBoundingClientRect();
    return {
      root: root.toJSON(), canvas: canvas.toJSON(), build: build.toJSON(), tools: tools.toJSON(),
      status: document.querySelector('[data-role="status"]').textContent,
      overflow: document.documentElement.scrollWidth > innerWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert(/race ready/i.test(touchLayout.status), 'one-finger touch stroke did not produce a valid track');
  assert(!touchLayout.overflow, 'touch editor has horizontal overflow');
  assert(touchLayout.tools.left >= -0.5 && touchLayout.canvas.left >= 50, 'touch controls were scrolled outside the editor');
  assert(touchLayout.build.height >= 44, 'touch Build Track target is too small');
  assert(touchLayout.canvas.width > 500, 'touch drafting surface is too narrow');
  await page.screenshot({ path: SHOTS.touch });
  if (process.env.DRAW_SMOKE_DEBUG) console.log(JSON.stringify(touchLayout));
  await page.click('.kdt-build');
  await page.waitForSelector('.kdt-build-reveal:not([hidden])');
  await page.evaluate(() => document.querySelector('[data-action="skip-build"]')?.click());
  await page.waitForFunction(() => window.__kkRacing?.snapshot?.()?.raceMode === 'draw', null, { timeout: 90000 });
  const touchRace = await page.evaluate(() => window.__kkRacing.snapshot());
  assert(touchRace.customTrackId && touchRace.overpasses === 1, 'touch-built track did not enter the same playable runtime');
  await context.close();
}

let browser;
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
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const diagnostics = { errors: [], consoleErrors: [], badResponses: [] };
  if (SCOPE !== 'touch') await desktop(browser, diagnostics);
  if (SCOPE !== 'desktop') await touch(browser, diagnostics);
  const ignore = (message) => /favicon|autoplay|AudioContext|net::ERR_ABORTED/i.test(message)
    || (/net::ERR_TIMED_OUT/i.test(message) && /fonts\.(googleapis|gstatic)\.com/i.test(message));
  diagnostics.errors = diagnostics.errors.filter((message) => !ignore(message));
  diagnostics.consoleErrors = diagnostics.consoleErrors.filter((message) => !ignore(message));
  assert(diagnostics.errors.length === 0, `page errors: ${diagnostics.errors.join(' | ')}`);
  assert(diagnostics.consoleErrors.length === 0, `console errors: ${diagnostics.consoleErrors.join(' | ')}`);
  assert(diagnostics.badResponses.length === 0, `bad local responses: ${diagnostics.badResponses.join(' | ')}`);
  const expectedShots = SCOPE === 'touch' ? [SHOTS.touch]
    : SCOPE === 'desktop' ? [SHOTS.menu, SHOTS.closure, SHOTS.editor, SHOTS.overLimit, SHOTS.start, SHOTS.race, SHOTS.bridge]
      : Object.values(SHOTS);
  for (const file of expectedShots) assert(fs.statSync(file).size > 10_000, `screenshot is unexpectedly small: ${file}`);
  console.log('Kaki Rally Draw Your Track browser smoke passed');
  console.log(Object.values(SHOTS).join('\n'));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
