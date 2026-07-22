import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  MODE_SEQUENCE,
  classifyRequestFailure,
  collectLifecycleAttribution,
  createLaunchEvidence,
  startServer,
  validateBrowserSignals,
  validateLifecycleSnapshot,
} from './smoke-mode-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function healthySnapshot() {
  return {
    serviceState: 'ready',
    backend: 'webgpu',
    rendererIsWebGPURenderer: true,
    backendFlags: { webgpu: true, webgl: false, deviceReady: true, webgl2: null },
    identity: { serviceStable: true, rendererStable: true, canvasStable: true },
    loop: {
      before: { frameCount: 20 },
      after: {
        running: true,
        owner: 'renderer.setAnimationLoop',
        startCount: 1,
        frameCount: 28,
        duplicateTimestampCount: 0,
      },
      frameAdvance: 8,
    },
    canvas: {
      mainCanvasCount: 1,
      directStageCanvasCount: 1,
      fullStageCanvasCount: 1,
      rendererOwnsMainCanvas: true,
    },
    renderInfo: { drawCalls: 4, triangles: 120 },
    runtimeErrors: { errors: [], rejections: [] },
    game: {
      mode: 'menu',
      started: false,
      hasRacingSession: false,
      raceMode: null,
      bulletHellActive: false,
    },
    dom: {
      racingHudCount: 0,
      bulletHellHudCount: 0,
      bulletHellFlashCount: 0,
      bulletHellNoticeCount: 0,
    },
    scene: { racingRootCount: 0, racingOwnedObjectCount: 0, bulletHellObjectCount: 0 },
    menu: { present: true, visible: true },
  };
}

test('mode lifecycle matrix uses production hooks, repeats entries, and excludes Catastrophe', () => {
  assert.deepEqual(MODE_SEQUENCE.map((entry) => entry.id), [
    'bullethell-first',
    'rally-first',
    'monster-smash',
    'trials',
    'draw-track',
    'bullethell-reentry',
    'rally-reentry',
  ]);
  assert.equal(MODE_SEQUENCE.filter((entry) => entry.kind === 'bullethell').length, 2);
  assert.equal(MODE_SEQUENCE.filter((entry) => entry.raceMode === 'circuit').length, 2);
  assert.equal(MODE_SEQUENCE.filter((entry) => entry.raceMode === 'draw').length, 1);
  assert.ok(!MODE_SEQUENCE.some((entry) => entry.raceMode === 'crash' || /catastrophe/i.test(entry.id)));

  const source = fs.readFileSync(path.join(ROOT, 'tools/webgpu/smoke-mode-lifecycle.mjs'), 'utf8');
  assert.match(source, /window\.kkStartBulletHell\(\)/);
  assert.match(source, /window\.kkStartRacing\(definition\.courseId, definition\.options\)/);
  assert.match(source, /window\.kkReturnToMenu\(\)/);
  assert.match(source, /entry\.resourceType !== 'media'/);
  assert.doesNotMatch(source, /kkStartCatastrophe|enterCrashMode\(/);
});

test('healthy menu lifecycle snapshot passes the renderer and cleanup contract', () => {
  assert.deepEqual(validateLifecycleSnapshot(healthySnapshot(), {
    backend: 'webgpu',
    phase: 'menu',
  }), []);

  const webgl = healthySnapshot();
  webgl.backend = 'webgl';
  webgl.backendFlags = { webgpu: false, webgl: true, deviceReady: null, webgl2: true };
  assert.deepEqual(validateLifecycleSnapshot(webgl, {
    backend: 'webgl',
    phase: 'menu',
  }), []);
});

test('lifecycle validation rejects extra canvas, duplicate loop, runtime errors, and mode leaks', () => {
  const snapshot = healthySnapshot();
  snapshot.canvas.fullStageCanvasCount = 2;
  snapshot.loop.after.startCount = 2;
  snapshot.loop.after.duplicateTimestampCount = 1;
  snapshot.runtimeErrors.rejections.push({ message: 'render rejected' });
  snapshot.game.hasRacingSession = true;
  snapshot.game.raceMode = 'circuit';
  snapshot.dom.racingHudCount = 1;
  snapshot.scene.racingRootCount = 1;

  const failures = validateLifecycleSnapshot(snapshot, { backend: 'webgpu', phase: 'menu' });
  assert.ok(failures.some((failure) => /full-stage canvases/.test(failure)));
  assert.ok(failures.some((failure) => /duplicate animation loop\/RAF owner/.test(failure)));
  assert.ok(failures.some((failure) => /duplicate animation loop\/RAF timestamps/.test(failure)));
  assert.ok(failures.some((failure) => /unhandled rejections/.test(failure)));
  assert.ok(failures.some((failure) => /mode state leaked/.test(failure)));
  assert.ok(failures.some((failure) => /mode DOM leaked/.test(failure)));
  assert.ok(failures.some((failure) => /mode scene root leaked/.test(failure)));
});

test('active mode contracts distinguish Bullet Hell and racing ownership', () => {
  const bullet = healthySnapshot();
  Object.assign(bullet.game, { mode: 'bullethell', started: true, bulletHellActive: true });
  bullet.dom.bulletHellHudCount = 1;
  bullet.scene.bulletHellObjectCount = 7;
  assert.deepEqual(validateLifecycleSnapshot(bullet, {
    backend: 'webgpu',
    phase: 'active',
    mode: MODE_SEQUENCE[0],
  }), []);

  const rally = healthySnapshot();
  Object.assign(rally.game, { mode: 'racing', started: true, hasRacingSession: true, raceMode: 'circuit' });
  rally.assets = {
    ids: ['environmentKitV2'],
    error: '',
    cache: [{ id: 'environmentKitV2', loaded: true, refs: 1 }],
  };
  rally.readiness = {
    racingAssetsReady: true,
    postAssetFrames: { frameAdvance: 2 },
  };
  rally.dom.racingHudCount = 1;
  rally.scene.racingRootCount = 1;
  rally.scene.racingOwnedObjectCount = 5;
  assert.deepEqual(validateLifecycleSnapshot(rally, {
    backend: 'webgpu',
    phase: 'active',
    mode: MODE_SEQUENCE[1],
  }), []);
});

test('active racing validation rejects incomplete, errored, or unreferenced asset leases', () => {
  const rally = healthySnapshot();
  Object.assign(rally.game, {
    mode: 'racing',
    started: true,
    hasRacingSession: true,
    raceMode: 'circuit',
  });
  rally.assets = {
    ids: ['environmentKitV2'],
    error: 'model decode failed',
    cache: [{ id: 'environmentKitV2', loaded: false, refs: 0 }],
  };
  rally.readiness = {
    racingAssetsReady: true,
    postAssetFrames: { frameAdvance: 1 },
  };
  rally.dom.racingHudCount = 1;
  rally.scene.racingRootCount = 1;
  rally.scene.racingOwnedObjectCount = 5;

  const failures = validateLifecycleSnapshot(rally, {
    backend: 'webgpu',
    phase: 'active',
    mode: MODE_SEQUENCE[1],
  });
  assert.ok(failures.some((failure) => /rendered 1\/2 frames/.test(failure)));
  assert.ok(failures.some((failure) => /asset snapshot reported an error/.test(failure)));
  assert.ok(failures.some((failure) => /unloaded or unreferenced asset rows/.test(failure)));
});

test('browser signal contract makes page, console/render, and local request failures fatal', () => {
  assert.deepEqual(validateBrowserSignals(), []);
  const failures = validateBrowserSignals({
    pageErrors: [{ message: 'boom' }],
    consoleErrors: [{ text: '[renderer] Animation frame failed' }],
    requestFailures: [{ url: '/asset.glb', error: 'HTTP 404' }],
  });
  assert.equal(failures.length, 3);
});

test('request failure classification only tolerates the exact menu-audio mode-entry cancellation', () => {
  const intentional = {
    requestId: 7,
    url: 'http://127.0.0.1:8080/assets/music/menu_glitch.mp3',
    resourceType: 'media',
    error: 'net::ERR_ABORTED',
    startedPhase: 'menu:before-rally-first',
    failurePhase: 'enter:rally-first',
  };
  assert.deepEqual(classifyRequestFailure(intentional), {
    actionable: false,
    reason: 'menu music media request intentionally cancelled during mode entry',
  });
  assert.equal(classifyRequestFailure({
    ...intentional,
    failurePhase: 'active:monster-smash',
  }).actionable, false, 'delayed WebGPU cancellation delivery');

  for (const failure of [
    { ...intentional, url: 'http://127.0.0.1:8080/assets/racing/models/kaki-rally-environment-kit-v2.glb', resourceType: 'fetch' },
    { ...intentional, url: 'http://127.0.0.1:8080/assets/music/boss_theme.mp3' },
    { ...intentional, resourceType: 'fetch' },
    { ...intentional, startedPhase: 'active:bullethell-first' },
    { ...intentional, failurePhase: 'menu:after-rally-first' },
    { ...intentional, error: 'net::ERR_FAILED' },
  ]) {
    assert.equal(classifyRequestFailure(failure).actionable, true, JSON.stringify(failure));
  }
});

test('lifecycle static server supports cached, sized, and ranged asset responses', async () => {
  const { server, origin } = await startServer(0);
  const assetUrl = new URL('vendor/three/package.json', origin);
  try {
    const full = await fetch(assetUrl);
    const fullBody = await full.arrayBuffer();
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), String(fullBody.byteLength));
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.match(full.headers.get('cache-control') || '', /max-age=3600/);
    assert.match(full.headers.get('etag') || '', /^"[0-9a-f]+-[0-9a-f]+"$/);

    const range = await fetch(assetUrl, { headers: { range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-length'), '10');
    assert.equal(range.headers.get('content-range'), `bytes 0-9/${fullBody.byteLength}`);
    assert.equal((await range.arrayBuffer()).byteLength, 10);

    const head = await fetch(assetUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(fullBody.byteLength));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const invalidRange = await fetch(assetUrl, { headers: { range: 'bytes=999999999-' } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('content-range'), `bytes */${fullBody.byteLength}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('persisted report attribution records source, Three, browser profile, and command', () => {
  const attribution = collectLifecycleAttribution({
    root: ROOT,
    argv: ['node', 'tools/webgpu/smoke-mode-lifecycle.mjs', '--output', 'docs/webgpu/MODE_LIFECYCLE_SMOKE.json'],
    browserExecutable: '/opt/chromium/chrome',
    reportOutput: 'docs/webgpu/MODE_LIFECYCLE_SMOKE.json',
  });
  assert.match(attribution.source.commit || '', /^[0-9a-f]{40}$/);
  assert.equal(attribution.source.repository, ROOT);
  assert.ok(Object.hasOwn(attribution.source, 'branch'));
  assert.equal(typeof attribution.source.dirty, 'boolean');
  assert.ok(Array.isArray(attribution.source.status));
  assert.ok(!attribution.source.status.some((entry) => entry.endsWith('docs/webgpu/MODE_LIFECYCLE_SMOKE.json')));
  assert.equal(attribution.three.packageVersion, '0.185.1');
  assert.equal(attribution.three.revision, '185');
  assert.equal(attribution.harness.reducedMotion, 'no-preference');
  assert.equal(attribution.harness.browserExecutable, '/opt/chromium/chrome');
  assert.match(attribution.harness.commandLine, /MODE_LIFECYCLE_SMOKE\.json/);
  assert.deepEqual(attribution.harness.profiles.map((profile) => profile.name), [
    'software-webgl2',
    'software-webgpu',
  ]);
  assert.ok(attribution.harness.profiles.every((profile) => profile.args.length > 0));

  assert.deepEqual(createLaunchEvidence({
    profile: 'software-webgpu',
    args: ['--use-vulkan=swiftshader'],
    browserVersion: '145.0.0.0',
    browserExecutable: '/opt/chromium/chrome',
  }), {
    launchProfile: 'software-webgpu',
    launchArgs: ['--use-vulkan=swiftshader'],
    browserVersion: '145.0.0.0',
    browserExecutable: '/opt/chromium/chrome',
  });
});

test('package exposes the backend-parametric lifecycle smoke', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['test:renderer:lifecycle'],
    'node tools/webgpu/smoke-mode-lifecycle.mjs --output docs/webgpu/MODE_LIFECYCLE_SMOKE.json',
  );
});
