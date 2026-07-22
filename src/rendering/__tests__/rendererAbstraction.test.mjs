import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRendererService,
  RendererInitializationError,
  RendererOperationCancelledError,
  RendererRecreationError,
} from '../createRenderer.js';
import { createRenderLifecycle } from '../renderLifecycle.js';
import { createRenderPipeline } from '../renderPipeline.js';
import { detectRendererBackend } from '../rendererCapabilities.js';

function fakeCanvas() {
  return {
    width: 640,
    height: 360,
    clientWidth: 640,
    clientHeight: 360,
    getContext() { return {}; },
    toBlob(callback, type) { callback(new Blob(['frame'], { type })); },
  };
}

class FakeRenderer {
  constructor(options, backend = options.forceWebGL ? 'webgl' : 'webgpu') {
    this.options = options;
    this.domElement = options.canvas;
    this.backend = backend === 'webgpu'
      ? { isWebGPUBackend: true, compatibilityMode: false, device: null, parameters: options }
      : { isWebGLBackend: true, parameters: options };
    this.info = {
      autoReset: true,
      render: {
        calls: 99,
        frameCalls: 1,
        drawCalls: 2,
        triangles: 12,
        points: 0,
        lines: 0,
        timestamp: 0,
      },
      memory: { textures: 1, renderTargets: 0, geometries: 1, total: 64 },
      reset: () => { this.resetCount += 1; },
    };
    this.initialized = false;
    this.disposed = false;
    this.renderCount = 0;
    this.resetCount = 0;
    this.pixelRatio = 1;
    this.size = null;
    this.sizeHistory = [];
    this.loop = null;
  }

  async init() {
    await Promise.resolve();
    this.initialized = true;
    return this;
  }

  hasInitialized() { return this.initialized; }
  setPixelRatio(value) { this.pixelRatio = value; }
  getPixelRatio() { return this.pixelRatio; }
  setSize(width, height, updateStyle) {
    this.size = { width, height, updateStyle };
    this.sizeHistory.push(this.size);
  }
  render(scene, camera) { this.lastRender = { scene, camera }; this.renderCount += 1; }
  async setAnimationLoop(callback) { this.loop = callback; }
  getMaxAnisotropy() { return 8; }
  get currentSamples() { return 4; }
  dispose() { this.disposed = true; this.loop = null; }
  onDeviceLost(info) { this.defaultLossInfo = info; }
}

test('auto initializes WebGPU asynchronously and reports the actual backend', async () => {
  const canvas = fakeCanvas();
  const ready = [];
  const service = createRendererService({
    canvas,
    settings: { width: 800, height: 450, dprCap: 1.25, threeRevision: '185' },
    rendererFactory: (options) => new FakeRenderer(options, 'webgpu'),
    onBackendReady: (value) => ready.push(value.backend),
  });

  await service.initialize();
  assert.equal(service.backend, 'webgpu');
  assert.equal(detectRendererBackend(service.renderer), 'webgpu');
  assert.deepEqual(ready, ['webgpu']);
  assert.equal(service.renderer.info.autoReset, false);
  assert.deepEqual(service.renderer.size, { width: 800, height: 450, updateStyle: true });
  assert.equal(service.getDiagnostics().drawCalls, 2);
  assert.equal(service.getDiagnostics().renderCalls, 99);
  assert.equal(service.getDiagnostics().frameRenderCalls, 1);
  await service.dispose();
});

test('forced WebGL passes forceWebGL and keeps the common renderer service', async () => {
  let constructedOptions;
  const service = createRendererService({
    canvas: fakeCanvas(),
    preferredBackend: 'webgl',
    rendererFactory: (options) => {
      constructedOptions = options;
      return new FakeRenderer(options, 'webgl');
    },
  });

  await service.initialize();
  assert.equal(constructedOptions.forceWebGL, true);
  assert.equal(service.backend, 'webgl');
  assert.equal(service.getCapabilities().backend, 'webgl');
  await service.dispose();
});

test('required WebGPU rejects and disposes an automatic WebGL fallback', async () => {
  let fallbackRenderer;
  let failure;
  const service = createRendererService({
    canvas: fakeCanvas(),
    preferredBackend: 'webgpu',
    rendererFactory: (options) => {
      fallbackRenderer = new FakeRenderer(options, 'webgl');
      return fallbackRenderer;
    },
    onBackendFailure: (event) => { failure = event; },
  });

  await assert.rejects(service.initialize(), (error) => {
    assert.ok(error instanceof RendererInitializationError);
    assert.equal(error.code, 'REQUIRED_WEBGPU_UNAVAILABLE');
    return true;
  });
  assert.equal(fallbackRenderer.disposed, true);
  assert.equal(failure.canSwitchToWebGL, true);
  assert.equal(service.state, 'failed');
});

test('render, pause, resize, quality, and asynchronous capture share one service', async () => {
  const scene = { name: 'scene' };
  const camera = { name: 'camera' };
  const service = createRendererService({
    canvas: fakeCanvas(),
    settings: { scene, camera, quality: 'high' },
    rendererFactory: (options) => new FakeRenderer(options),
  });
  await service.initialize();

  assert.equal(service.render(), true);
  assert.equal(service.renderer.renderCount, 1);
  assert.equal(service.getDiagnostics().cpuFrameTimeMs, null);
  assert.equal(typeof service.getDiagnostics().renderSubmissionTimeMs, 'number');
  service.pause('menu');
  assert.equal(service.render(), false);
  await service.resume();
  assert.equal(service.render(), true);
  assert.equal(service.renderer.renderCount, 2);

  assert.deepEqual(service.resize(1024, 576), { width: 1024, height: 576, pixelRatio: 1 });
  assert.equal(service.setQuality('low').quality, 'low');
  const blob = await service.captureFrame();
  assert.equal(blob.type, 'image/png');
  assert.equal(service.renderer.renderCount, 3);
  await service.dispose();
});

test('a rejected postfx topology change leaves quality and DPR unchanged', async () => {
  const applied = [];
  const service = createRendererService({
    canvas: fakeCanvas(),
    settings: {
      quality: 'high',
      applyQualityToPostfx: (state) => {
        applied.push(state.quality);
        if (state.quality === 'low') {
          const error = new Error('pipeline rebuild required');
          error.code = 'POST_PIPELINE_REBUILD_REQUIRED';
          throw error;
        }
      },
    },
    rendererFactory: (options) => new FakeRenderer(options),
  });
  await service.initialize();
  const before = service.getDiagnostics();
  const beforePixelRatio = service.renderer.pixelRatio;
  const beforeSizeHistory = service.renderer.sizeHistory.length;

  assert.throws(() => service.setQuality('low'), (error) => {
    assert.equal(error.code, 'POST_PIPELINE_REBUILD_REQUIRED');
    return true;
  });
  assert.equal(service.getDiagnostics().quality, before.quality);
  assert.equal(service.getDiagnostics().quality, 'high');
  assert.equal(service.renderer.pixelRatio, beforePixelRatio);
  assert.equal(service.renderer.sizeHistory.length, beforeSizeHistory);
  assert.deepEqual(applied, ['high', 'low']);
  await service.dispose();
});

test('device-loss hook preserves the renderer default and pauses the service', async () => {
  let reported = null;
  const service = createRendererService({
    canvas: fakeCanvas(),
    rendererFactory: (options) => new FakeRenderer(options),
    onDeviceLost: (event) => { reported = event; },
  });
  await service.initialize();
  const renderer = service.renderer;
  renderer.onDeviceLost({ api: 'WebGPU', message: 'test loss', reason: 'unknown' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(renderer.defaultLossInfo.message, 'test loss');
  assert.equal(service.recovery.getState().state, 'lost');
  assert.equal(service.recovery.getState().lossCount, 1);
  assert.equal(service.render({}, {}), false);
  assert.equal(reported.info.message, 'test loss');
  await service.dispose();
});

test('renderer recreation can switch backends without creating a second loop owner', async () => {
  const renderers = [];
  const replacementCanvas = fakeCanvas();
  const service = createRendererService({
    canvas: fakeCanvas(),
    replaceCanvas: () => replacementCanvas,
    rendererFactory: (options) => {
      const instance = new FakeRenderer(options);
      renderers.push(instance);
      return instance;
    },
  });
  await service.initialize();
  await service.setAnimationLoop(() => {});
  assert.equal(renderers[0].loop instanceof Function, true);

  await service.recreate({ preferredBackend: 'webgl' });
  assert.equal(renderers.length, 2);
  assert.equal(renderers[0].disposed, true);
  assert.equal(renderers[0].loop, null);
  assert.equal(renderers[1].options.forceWebGL, true);
  assert.equal(renderers[1].options.canvas, replacementCanvas);
  assert.equal(service.canvas, replacementCanvas);
  assert.equal(service.backend, 'webgl');
  assert.equal(renderers[1].loop instanceof Function, true);
  await service.dispose();
});

test('cross-backend recreation requires reload when no replacement canvas is supplied', async () => {
  let reloadEvent = null;
  const service = createRendererService({
    canvas: fakeCanvas(),
    rendererFactory: (options) => new FakeRenderer(options),
    onReloadRequired: (event) => { reloadEvent = event; },
  });
  await service.initialize();
  const originalRenderer = service.renderer;

  await assert.rejects(service.recreate({ preferredBackend: 'webgl' }), (error) => {
    assert.ok(error instanceof RendererRecreationError);
    assert.equal(error.code, 'BACKEND_SWITCH_REQUIRES_RELOAD');
    assert.equal(error.reloadRequired, true);
    assert.equal(error.fromBackend, 'webgpu');
    assert.equal(error.targetBackend, 'webgl');
    return true;
  });
  assert.equal(reloadEvent.targetBackend, 'webgl');
  assert.equal(service.state, 'ready');
  assert.equal(service.renderer, originalRenderer);
  assert.equal(originalRenderer.disposed, false);
  await service.dispose();
});

test('dispose cancels an asynchronous renderer creation without publishing a stale renderer', async () => {
  let startFactory;
  let releaseFactory;
  const factoryStarted = new Promise((resolve) => { startFactory = resolve; });
  const factoryGate = new Promise((resolve) => { releaseFactory = resolve; });
  let createdRenderer = null;
  const service = createRendererService({
    canvas: fakeCanvas(),
    settings: { scene: {}, camera: {} },
    rendererFactory: async (options) => {
      startFactory();
      await factoryGate;
      createdRenderer = new FakeRenderer(options);
      return createdRenderer;
    },
  });

  const initializing = service.initialize();
  await factoryStarted;
  const disposing = service.dispose();
  releaseFactory();

  await assert.rejects(initializing, (error) => {
    assert.ok(error instanceof RendererOperationCancelledError);
    assert.equal(error.code, 'RENDERER_OPERATION_CANCELLED');
    return true;
  });
  await disposing;
  assert.equal(service.state, 'disposed');
  assert.equal(service.renderer, null);
  assert.equal(createdRenderer.disposed, true);
});

test('recreate supersedes a pending initialize and only publishes the newer generation', async () => {
  let startFirstFactory;
  let releaseFirstFactory;
  const firstFactoryStarted = new Promise((resolve) => { startFirstFactory = resolve; });
  const firstFactoryGate = new Promise((resolve) => { releaseFirstFactory = resolve; });
  const renderers = [];
  let factoryCalls = 0;
  const service = createRendererService({
    canvas: fakeCanvas(),
    settings: { scene: {}, camera: {} },
    rendererFactory: async (options) => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        startFirstFactory();
        await firstFactoryGate;
      }
      const renderer = new FakeRenderer(options);
      renderers.push(renderer);
      return renderer;
    },
  });

  const firstInitialize = service.initialize();
  await firstFactoryStarted;
  const recreation = service.recreate({ preferredBackend: 'webgl' });
  releaseFirstFactory();

  await assert.rejects(firstInitialize, RendererOperationCancelledError);
  await recreation;
  assert.equal(renderers.length, 2);
  assert.equal(renderers[0].disposed, true);
  assert.equal(renderers[1].disposed, false);
  assert.equal(renderers[1].options.forceWebGL, true);
  assert.equal(service.renderer, renderers[1]);
  assert.equal(service.backend, 'webgl');
  await service.dispose();
});

test('resize dimensions and updateStyle survive same-backend recreation', async () => {
  const renderers = [];
  const service = createRendererService({
    canvas: fakeCanvas(),
    settings: { width: 640, height: 360, scene: {}, camera: {} },
    rendererFactory: (options) => {
      const renderer = new FakeRenderer(options);
      renderers.push(renderer);
      return renderer;
    },
  });
  await service.initialize();
  service.resize(1111, 777, { updateStyle: false });
  await service.recreate();

  assert.equal(renderers.length, 2);
  assert.deepEqual(renderers[1].sizeHistory, [
    { width: 1111, height: 777, updateStyle: false },
    { width: 1111, height: 777, updateStyle: false },
  ]);
  await service.dispose();
});

test('pipeline camera and scene switches update the exposed r185 scene PassNode', async () => {
  const renderer = new FakeRenderer({ canvas: fakeCanvas() });
  const sceneA = { name: 'scene-a' };
  const sceneB = { name: 'scene-b' };
  const cameraA = { name: 'camera-a' };
  const cameraB = { name: 'camera-b' };
  let rendered = 0;
  const scenePass = { scene: sceneA, camera: cameraA };
  const pipeline = createRenderPipeline({
    renderer,
    scene: sceneA,
    camera: cameraA,
    pipelineFactory: () => ({
      scenePass,
      render() { rendered += 1; },
    }),
  });
  await pipeline.initialize();
  pipeline.render(sceneB, cameraB);

  assert.equal(rendered, 1);
  assert.equal(pipeline.getScene(), sceneB);
  assert.equal(pipeline.getCamera(), cameraB);
  assert.equal(scenePass.scene, sceneB);
  assert.equal(scenePass.camera, cameraB);
  pipeline.dispose();
});

test('pipeline refuses a camera switch when its factory exposes no binding adapter', async () => {
  const renderer = new FakeRenderer({ canvas: fakeCanvas() });
  const cameraA = { name: 'camera-a' };
  const cameraB = { name: 'camera-b' };
  const pipeline = createRenderPipeline({
    renderer,
    scene: {},
    camera: cameraA,
    pipelineFactory: () => ({ render() {} }),
  });
  await pipeline.initialize();
  assert.throws(
    () => pipeline.setCamera(cameraB),
    /Expose setCamera\(\) or the underlying PassNode/,
  );
  assert.equal(pipeline.getCamera(), cameraA);
  pipeline.dispose();
});

test('render lifecycle installs only one loop and gates frames while paused', async () => {
  const renderer = new FakeRenderer({ canvas: fakeCanvas() });
  let frames = 0;
  const lifecycle = createRenderLifecycle({ renderer });
  await lifecycle.start(() => { frames += 1; });
  const installedLoop = renderer.loop;
  await lifecycle.start();
  assert.equal(renderer.loop, installedLoop);

  renderer.loop(1);
  assert.equal(frames, 1);
  lifecycle.pause('hidden');
  renderer.loop(2);
  assert.equal(frames, 1);
  await lifecycle.resume();
  renderer.loop(3);
  assert.equal(frames, 2);
  await lifecycle.dispose();
  assert.equal(renderer.loop, null);
});

test('service animation-loop diagnostics measure the whole synchronous frame', async () => {
  const service = createRendererService({
    canvas: fakeCanvas(),
    settings: { scene: {}, camera: {} },
    rendererFactory: (options) => new FakeRenderer(options),
  });
  await service.initialize();
  await service.setAnimationLoop(() => service.render());

  service.renderer.loop(1);
  const diagnostics = service.getDiagnostics();
  assert.equal(typeof diagnostics.cpuFrameTimeMs, 'number');
  assert.equal(typeof diagnostics.renderSubmissionTimeMs, 'number');
  await service.dispose();
});
