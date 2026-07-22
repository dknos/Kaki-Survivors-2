import {
  assertRequestedBackend,
  detectRendererBackend,
  getRendererCapabilities,
} from './rendererCapabilities.js';
import {
  RENDERER_BACKENDS,
  normalizeBackendPreference,
  normalizeRendererSettings,
} from './rendererSettings.js';
import { createRendererDiagnostics } from './rendererDiagnostics.js';
import { createDeviceRecoveryController } from './deviceRecovery.js';
import { createRenderPipeline } from './renderPipeline.js';
import { createRenderLifecycle } from './renderLifecycle.js';
import { createQualityManager } from './qualityManager.js';

export class RendererInitializationError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'RendererInitializationError';
    this.code = options.code || 'RENDERER_INITIALIZATION_FAILED';
    this.preference = options.preference || RENDERER_BACKENDS.AUTO;
    this.actualBackend = options.actualBackend || null;
  }
}

export class RendererOperationCancelledError extends Error {
  constructor(message = 'Renderer operation was superseded by a newer lifecycle transition.') {
    super(message);
    this.name = 'RendererOperationCancelledError';
    this.code = 'RENDERER_OPERATION_CANCELLED';
  }
}

export class RendererRecreationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RendererRecreationError';
    this.code = options.code || 'RENDERER_RECREATION_FAILED';
    this.reloadRequired = options.reloadRequired === true;
    this.fromBackend = options.fromBackend || null;
    this.targetBackend = options.targetBackend || null;
  }
}

async function loadWebGPUModule() {
  return import('three/webgpu');
}

function rendererOptions(canvas, settings, preference) {
  const options = {
    ...settings.rendererOptions,
    canvas,
    antialias: settings.antialias,
    alpha: settings.alpha,
    depth: settings.depth,
    stencil: settings.stencil,
    powerPreference: settings.powerPreference,
    forceWebGL: preference === RENDERER_BACKENDS.WEBGL,
  };

  // Do not forward undefined optional values. Some browser GPU dictionaries
  // distinguish a missing member from a present `undefined` member.
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) delete options[key];
  }
  return options;
}

async function safeDisposeRenderer(renderer) {
  if (!renderer || typeof renderer.dispose !== 'function') return;
  // r185 WebGPURenderer.dispose() calls its async setAnimationLoop(null). If
  // init() rejected, that method attempts init() again and its rejection is no
  // longer observable by the caller. An uninitialized renderer has no managed
  // GPU resources yet, so avoid that unsafe path.
  if (renderer.isWebGPURenderer === true && typeof renderer.hasInitialized === 'function') {
    try {
      if (renderer.hasInitialized() === false) return;
    } catch (_) {
      return;
    }
  }
  try { await renderer.dispose(); } catch (_) {}
}

function safeCallback(callback, value) {
  if (typeof callback !== 'function') return Promise.resolve();
  try { return Promise.resolve(callback(value)); } catch (error) { return Promise.reject(error); }
}

function defaultCaptureFrame({ canvas, mimeType = 'image/png', quality }) {
  if (canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  if (canvas && typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas frame capture produced an empty blob.'));
      }, mimeType, quality);
    });
  }
  throw new Error('This canvas does not support asynchronous frame capture.');
}

/**
 * Creates the renderer service without loading Three.js until `initialize()`.
 * Tests and staged integration can inject `rendererFactory` or
 * `WebGPURendererClass`; production resolves the pinned `three/webgpu` import.
 */
export function createRendererService({
  canvas,
  settings: inputSettings = {},
  preferredBackend = RENDERER_BACKENDS.AUTO,
  onBackendReady = null,
  onBackendFailure = null,
  onDeviceLost = null,
  rendererFactory = null,
  WebGPURendererClass = null,
  moduleLoader = loadWebGPUModule,
  pipelineFactory = null,
  captureFrame: captureFrameAdapter = null,
  contextProvider = null,
  replaceCanvas = null,
  onReloadRequired = null,
} = {}) {
  if (!canvas) throw new TypeError('createRendererService requires a canvas.');

  let activeCanvas = canvas;
  let preference = normalizeBackendPreference(preferredBackend);
  let settings = normalizeRendererSettings(inputSettings);
  let renderer = null;
  let backend = 'unknown';
  let pipeline = null;
  let lifecycle = null;
  let diagnostics = null;
  let qualityManager = null;
  let recovery = null;
  let initializationPromise = null;
  let disposalPromise = null;
  let transition = Promise.resolve();
  let generation = 0;
  let frameHandler = null;
  let serviceState = 'idle';
  let paused = false;
  let disposed = false;
  let lastError = null;

  const mergedContext = () => ({
    rendererState: serviceState,
    requestedBackend: preference,
    quality: qualityManager?.getState().quality ?? settings.quality,
    dynamicResolutionScale: qualityManager?.getState().dynamicResolutionScale
      ?? settings.dynamicResolutionScale,
    deviceLossCount: recovery?.getState().lossCount ?? 0,
    ...(typeof contextProvider === 'function' ? contextProvider() : {}),
  });

  const wrapFrameHandler = (callback) => (...args) => {
    diagnostics?.beginFrame();
    try {
      return callback(...args);
    } finally {
      // Animation-loop handlers are expected to schedule asynchronous work,
      // not await it on the critical path. Measure the synchronous game-frame
      // work submitted before control returns to the browser.
      diagnostics?.endFrame();
    }
  };

  const enqueueTransition = (operation) => {
    const result = transition.then(operation, operation);
    // Keep the serialization chain usable after a rejected operation while
    // returning the original rejection to its caller.
    transition = result.catch(() => {});
    return result;
  };

  const trackInitialization = (promise) => {
    initializationPromise = promise;
    const clear = () => {
      if (initializationPromise === promise) initializationPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  };

  const assertCurrentGeneration = (operationGeneration) => {
    if (disposed || operationGeneration !== generation) {
      throw new RendererOperationCancelledError();
    }
  };

  async function createRendererInstance() {
    const options = rendererOptions(activeCanvas, settings, preference);
    if (typeof rendererFactory === 'function') {
      return rendererFactory(options, { preference, settings });
    }

    let RendererClass = WebGPURendererClass;
    let threeModule = inputSettings.threeModule || null;
    if (!RendererClass) {
      threeModule = await moduleLoader();
      RendererClass = threeModule && threeModule.WebGPURenderer;
    }
    if (typeof RendererClass !== 'function') {
      throw new Error('Pinned three/webgpu did not export WebGPURenderer.');
    }
    return new RendererClass(options);
  }

  async function configureRenderer(nextRenderer) {
    for (const [key, value] of Object.entries(settings.rendererProperties)) {
      nextRenderer[key] = value;
    }
    if (typeof nextRenderer.setPixelRatio === 'function') {
      nextRenderer.setPixelRatio(settings.pixelRatio);
    }
    if (
      settings.width != null
      && settings.height != null
      && typeof nextRenderer.setSize === 'function'
    ) {
      nextRenderer.setSize(settings.width, settings.height, settings.updateStyle);
    }
    if (nextRenderer.info && settings.resetInfoBeforeRender) {
      nextRenderer.info.autoReset = false;
    }
    if (typeof inputSettings.configureRenderer === 'function') {
      await inputSettings.configureRenderer(nextRenderer);
    }
  }

  async function notifyFailure(error) {
    try {
      await safeCallback(onBackendFailure, {
        error,
        preference,
        actualBackend: detectRendererBackend(renderer),
        canSwitchToWebGL: preference === RENDERER_BACKENDS.WEBGPU,
      });
    } catch (callbackError) {
      console.error('[renderer] Backend failure callback failed.', callbackError);
    }
  }

  async function tearDown({ final = false } = {}) {
    if (lifecycle) {
      try { await lifecycle.dispose(); } catch (_) {}
    }
    lifecycle = null;
    frameHandler = final ? null : frameHandler;
    if (pipeline) {
      try { pipeline.dispose(); } catch (_) {}
    }
    pipeline = null;
    qualityManager = null;
    diagnostics = null;
    if (recovery) {
      try {
        if (final) recovery.dispose();
        else recovery.attachRenderer(null);
      } catch (_) {}
    }
    await safeDisposeRenderer(renderer);
    renderer = null;
    backend = 'unknown';
  }

  async function initializeGeneration(operationGeneration) {
    lastError = null;
    try {
      assertCurrentGeneration(operationGeneration);
      renderer = await createRendererInstance();
      assertCurrentGeneration(operationGeneration);
      if (!renderer || typeof renderer.init !== 'function') {
        throw new TypeError('Renderer factory must return a WebGPURenderer-compatible object.');
      }

      if (!recovery) {
        recovery = createDeviceRecoveryController({
          renderer,
          pause: (reason) => service.pause(reason),
          resume: () => service.resume(),
          saveState: inputSettings.saveStateOnDeviceLoss,
          recreateRenderer: ({ preferredBackend: nextPreference }) => service.recreate({
            preferredBackend: nextPreference,
          }),
          onDeviceLost: (recoveryState, info) => {
            diagnostics?.recordDeviceLoss();
            return safeCallback(onDeviceLost, { recoveryState, info, service });
          },
          onStateChange: inputSettings.onRecoveryStateChange,
          autoRecover: settings.autoRecover,
        });
      } else {
        recovery.attachRenderer(renderer);
      }

      await configureRenderer(renderer);
      assertCurrentGeneration(operationGeneration);
      await renderer.init();
      assertCurrentGeneration(operationGeneration);
      backend = assertRequestedBackend(renderer, preference);

      pipeline = createRenderPipeline({
        renderer,
        scene: inputSettings.scene || null,
        camera: inputSettings.camera || null,
        pipelineFactory,
        onBeforeRender: inputSettings.onBeforeRender,
        onAfterRender: inputSettings.onAfterRender,
      });
      await pipeline.initialize();
      assertCurrentGeneration(operationGeneration);

      const canvasWidth = activeCanvas.clientWidth || activeCanvas.width || 1;
      const canvasHeight = activeCanvas.clientHeight || activeCanvas.height || 1;
      qualityManager = createQualityManager({
        renderer,
        initialSettings: {
          ...settings,
          width: settings.width || canvasWidth,
          height: settings.height || canvasHeight,
        },
        applyPostfx: inputSettings.applyQualityToPostfx,
      });
      const initialQuality = qualityManager.resize(
        settings.width || canvasWidth,
        settings.height || canvasHeight,
        { updateStyle: settings.updateStyle },
      );
      pipeline.resize(
        initialQuality.width,
        initialQuality.height,
        initialQuality.pixelRatio,
      );
      await safeCallback(inputSettings.applyQualityToPostfx, qualityManager.getState());
      assertCurrentGeneration(operationGeneration);
      lifecycle = createRenderLifecycle({
        renderer,
        onFrameError: inputSettings.onFrameError,
        onPause: inputSettings.onPause,
        onResume: inputSettings.onResume,
      });
      diagnostics = createRendererDiagnostics({
        renderer,
        threeRevision: inputSettings.threeRevision || null,
        contextProvider: mergedContext,
      });
      if (frameHandler) lifecycle.setFrameHandler(wrapFrameHandler(frameHandler));

      serviceState = 'ready';
      await safeCallback(onBackendReady, { renderer, backend, service });
      assertCurrentGeneration(operationGeneration);
      return service;
    } catch (cause) {
      const superseded = disposed
        || operationGeneration !== generation
        || cause instanceof RendererOperationCancelledError;
      if (superseded) {
        const cancellation = cause instanceof RendererOperationCancelledError
          ? cause
          : new RendererOperationCancelledError();
        await tearDown();
        throw cancellation;
      }

      const actualBackend = detectRendererBackend(renderer);
      const code = preference === RENDERER_BACKENDS.WEBGPU
        && actualBackend === RENDERER_BACKENDS.WEBGL
        ? 'REQUIRED_WEBGPU_UNAVAILABLE'
        : 'RENDERER_INITIALIZATION_FAILED';
      lastError = cause instanceof RendererInitializationError
        ? cause
        : new RendererInitializationError(cause.message || 'Renderer initialization failed.', {
          cause,
          code,
          preference,
          actualBackend,
        });
      serviceState = 'failed';
      await notifyFailure(lastError);
      await tearDown();
      serviceState = 'failed';
      throw lastError;
    }
  }

  const service = {
    get canvas() { return activeCanvas; },
    get renderer() { return renderer; },
    get backend() { return backend; },
    get state() { return serviceState; },
    get pipeline() { return pipeline; },
    get recovery() { return recovery; },

    initialize() {
      if (disposed) return Promise.reject(new Error('Cannot initialize a disposed renderer service.'));
      if (serviceState === 'ready') return Promise.resolve(this);
      if (initializationPromise) return initializationPromise;

      const operationGeneration = ++generation;
      serviceState = 'initializing';
      return trackInitialization(enqueueTransition(
        () => initializeGeneration(operationGeneration),
      ));
    },

    resize(width, height, options = {}) {
      if (!renderer || serviceState !== 'ready') return false;
      const result = qualityManager
        ? qualityManager.resize(width, height, options)
        : { width, height, pixelRatio: settings.pixelRatio };
      if (!qualityManager && typeof renderer.setSize === 'function') {
        renderer.setSize(width, height, options.updateStyle !== false);
      }
      settings = {
        ...settings,
        width: result.width,
        height: result.height,
        updateStyle: options.updateStyle == null
          ? settings.updateStyle
          : options.updateStyle !== false,
      };
      pipeline?.resize(result.width, result.height, result.pixelRatio);
      return result;
    },

    render(scene = pipeline?.getScene(), camera = pipeline?.getCamera()) {
      if (paused || serviceState !== 'ready' || !pipeline) return false;
      if (settings.resetInfoBeforeRender && renderer.info?.reset) renderer.info.reset();
      diagnostics?.beginRenderSubmission();
      try {
        return pipeline.render(scene, camera);
      } finally {
        diagnostics?.endRenderSubmission();
      }
    },

    pause(reason = 'paused') {
      if (paused) return false;
      paused = true;
      lifecycle?.pause(reason);
      return true;
    },

    async resume() {
      if (disposed) throw new Error('Cannot resume a disposed renderer service.');
      const changed = paused;
      paused = false;
      if (frameHandler && lifecycle) await lifecycle.resume();
      return changed;
    },

    async setAnimationLoop(callback) {
      if (callback != null && typeof callback !== 'function') {
        throw new TypeError('Animation loop must be a function or null.');
      }
      frameHandler = callback;
      if (!lifecycle) {
        if (callback == null) return;
        throw new Error('Initialize the renderer before setting its animation loop.');
      }
      if (callback == null) {
        await lifecycle.stop();
        return;
      }
      lifecycle.setFrameHandler(wrapFrameHandler(callback));
      if (!paused) await lifecycle.start();
    },

    getCapabilities(options = {}) {
      return renderer
        ? getRendererCapabilities(renderer, options)
        : { backend: 'unknown', initialized: false };
    },

    getDiagnostics(overrides = {}) {
      if (!diagnostics) {
        return { backend, rendererState: serviceState, lastError: lastError?.message || null };
      }
      return diagnostics.snapshot(overrides);
    },

    setQuality(nextQuality) {
      if (!qualityManager) throw new Error('Initialize the renderer before setting quality.');
      const next = qualityManager.setQuality(nextQuality);
      settings = { ...settings, quality: next.quality, dprCap: next.dprCap };
      pipeline?.resize(next.width, next.height, next.pixelRatio);
      return next;
    },

    setDynamicResolutionScale(scale) {
      if (!qualityManager) throw new Error('Initialize the renderer before setting resolution scale.');
      const next = qualityManager.setDynamicResolutionScale(scale);
      settings = { ...settings, dynamicResolutionScale: next.dynamicResolutionScale };
      pipeline?.resize(next.width, next.height, next.pixelRatio);
      return next;
    },

    async captureFrame(options = {}) {
      if (serviceState !== 'ready' || !renderer || !pipeline) {
        throw new Error('Initialize the renderer before capturing a frame.');
      }
      if (options.render !== false) {
        if (settings.resetInfoBeforeRender && renderer.info?.reset) renderer.info.reset();
        pipeline.render(options.scene || pipeline.getScene(), options.camera || pipeline.getCamera());
      }
      const adapter = captureFrameAdapter || defaultCaptureFrame;
      return adapter({
        canvas: renderer.domElement || activeCanvas,
        renderer,
        pipeline,
        backend,
        mimeType: options.mimeType || settings.captureMimeType,
        quality: options.quality ?? settings.captureQuality,
        options,
      });
    },

    recreate(options = {}) {
      if (disposed) return Promise.reject(new Error('Cannot recreate a disposed renderer service.'));

      const nextPreference = options.preferredBackend
        ? normalizeBackendPreference(options.preferredBackend, preference)
        : preference;
      const explicitTarget = nextPreference === RENDERER_BACKENDS.AUTO
        ? null
        : nextPreference;
      const switchesCanvasContext = explicitTarget != null
        && backend !== 'unknown'
        && explicitTarget !== backend;
      const canvasReplacer = options.replaceCanvas || replaceCanvas;

      if (switchesCanvasContext && typeof canvasReplacer !== 'function') {
        const error = new RendererRecreationError(
          `Switching from ${backend} to ${explicitTarget} requires a page reload `
          + 'or a replacement canvas.',
          {
            code: 'BACKEND_SWITCH_REQUIRES_RELOAD',
            reloadRequired: true,
            fromBackend: backend,
            targetBackend: explicitTarget,
          },
        );
        safeCallback(onReloadRequired, {
          error,
          fromBackend: backend,
          targetBackend: explicitTarget,
          service,
        }).catch((callbackError) => {
          console.error('[renderer] Reload-required callback failed.', callbackError);
        });
        return Promise.reject(error);
      }

      const operationGeneration = ++generation;
      serviceState = 'recreating';
      const operation = enqueueTransition(async () => {
        let toreDown = false;
        try {
          assertCurrentGeneration(operationGeneration);
          let nextCanvas = activeCanvas;
          if (switchesCanvasContext) {
            nextCanvas = await canvasReplacer({
              canvas: activeCanvas,
              fromBackend: backend,
              targetBackend: explicitTarget,
              service,
            });
            assertCurrentGeneration(operationGeneration);
            if (!nextCanvas || typeof nextCanvas.getContext !== 'function') {
              throw new RendererRecreationError(
                'The canvas replacement callback did not return a canvas-like object.',
                { fromBackend: backend, targetBackend: explicitTarget },
              );
            }
            if (nextCanvas === activeCanvas) {
              throw new RendererRecreationError(
                'A backend switch requires a new canvas, not the active canvas.',
                { fromBackend: backend, targetBackend: explicitTarget },
              );
            }
          }

          const lifecycleState = lifecycle?.getState();
          const resumeLoop = !!(
            frameHandler
            && lifecycleState?.installed
            && !lifecycleState.paused
            && !paused
          );
          await tearDown();
          toreDown = true;
          assertCurrentGeneration(operationGeneration);
          preference = nextPreference;
          activeCanvas = nextCanvas;
          await initializeGeneration(operationGeneration);
          assertCurrentGeneration(operationGeneration);
          if (resumeLoop && frameHandler && lifecycle) {
            lifecycle.setFrameHandler(frameHandler);
            await lifecycle.start();
            assertCurrentGeneration(operationGeneration);
          }
          return service;
        } catch (error) {
          // Canvas replacement is preflighted before teardown. If it fails, the
          // existing renderer remains usable and should not be mislabeled failed.
          if (!toreDown && renderer && !disposed && operationGeneration === generation) {
            serviceState = 'ready';
          }
          throw error;
        }
      });
      return trackInitialization(operation);
    },

    dispose() {
      if (disposalPromise) return disposalPromise;
      disposed = true;
      paused = true;
      generation += 1;
      serviceState = 'disposing';
      disposalPromise = enqueueTransition(async () => {
        await tearDown({ final: true });
        serviceState = 'disposed';
      });
      return disposalPromise;
    },
  };

  return service;
}
