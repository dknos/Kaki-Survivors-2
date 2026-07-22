/**
 * Small renderer adapter for self-contained menu previews.
 *
 * The caller injects the same Three.js namespace it uses to construct its
 * scene. This is deliberate: preview code must never import a second,
 * incompatible Three.js build while the production import map moves from the
 * classic build to `three.webgpu.js`.
 */

import {
  RENDERER_BACKENDS,
  normalizeBackendPreference,
  readBackendPreference,
} from './rendererSettings.js';

function isFunction(value) {
  return typeof value === 'function';
}

function callHandled(callback, value) {
  if (!isFunction(callback)) return;
  try {
    const result = callback(value);
    if (result && isFunction(result.then)) Promise.resolve(result).catch(() => {});
  } catch (_) {}
}

function removeNode(node) {
  if (!node) return;
  try {
    if (isFunction(node.remove)) node.remove();
    else if (node.parentNode) node.parentNode.removeChild(node);
  } catch (_) {}
}

function createStatusNode(mount, text, kind) {
  const documentRef = mount?.ownerDocument || globalThis.document;
  if (!mount || !documentRef || !isFunction(documentRef.createElement)) return null;

  const node = documentRef.createElement('div');
  node.className = `kk-preview-renderer-status kk-preview-renderer-${kind}`;
  node.textContent = text;
  node.setAttribute?.('role', kind === 'error' ? 'alert' : 'status');
  node.setAttribute?.('aria-live', kind === 'error' ? 'assertive' : 'polite');
  if (node.style) {
    node.style.cssText = [
      'position:absolute',
      'inset:0',
      'z-index:4',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:18px',
      'box-sizing:border-box',
      'pointer-events:none',
      'text-align:center',
      'font:600 13px/1.4 system-ui,sans-serif',
      'letter-spacing:.05em',
      'color:rgba(245,239,225,.82)',
      'text-shadow:0 2px 8px rgba(0,0,0,.9)',
    ].join(';');
  }
  mount.appendChild(node);
  return node;
}

function rendererBackend(renderer, ready) {
  if (!ready) return 'pending';
  if (renderer?.backend?.isWebGPUBackend === true) return 'webgpu';
  if (renderer?.backend?.isWebGLBackend === true) return 'webgl2';
  return 'unknown';
}

/**
 * Construct a renderer synchronously while gating rendering on asynchronous
 * WebGPURenderer initialization.
 *
 * `ready` always resolves to a boolean; it never rejects. This makes the
 * adapter safe for synchronous UI factories whose callers do not await boot.
 */
export function createPreviewRendererAdapter({
  THREE,
  mount = null,
  rendererOptions = {},
  preferredBackend = null,
  configureRenderer = null,
  canvasClassName = '',
  canvasStyle = '',
  loadingText = 'Preparing 3D preview…',
  errorText = '3D preview unavailable. The rest of the menu is still usable.',
  onReady = null,
  onError = null,
} = {}) {
  if (!THREE || typeof THREE !== 'object') {
    throw new TypeError('createPreviewRendererAdapter requires the caller\'s Three.js namespace.');
  }

  const RendererClass = isFunction(THREE.WebGPURenderer) ? THREE.WebGPURenderer : null;
  if (!RendererClass) {
    throw new TypeError('The injected Three.js namespace must export WebGPURenderer.');
  }

  const activeServicePreference = globalThis.__kkRendererService
    ?.getDiagnostics?.()
    ?.requestedBackend;
  const requestedBackend = normalizeBackendPreference(
    preferredBackend
      ?? (rendererOptions.forceWebGL === true
        ? RENDERER_BACKENDS.WEBGL
        : readBackendPreference(
          globalThis.location?.search || '',
          activeServicePreference,
        )),
  );
  const resolvedRendererOptions = {
    ...rendererOptions,
    forceWebGL: requestedBackend === RENDERER_BACKENDS.WEBGL,
  };
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const renderer = new RendererClass(resolvedRendererOptions);
  const canvas = renderer.domElement || null;

  try {
    if (isFunction(configureRenderer)) configureRenderer(renderer);
  } catch (error) {
    // WebGPURenderer has not been initialized yet, so r185's dispose() would
    // start initialization as a side effect. The constructor has acquired no
    // backend resources at this point.
    throw error;
  }

  if (canvas) {
    if (canvasClassName) canvas.className = canvasClassName;
    if (canvasStyle && canvas.style) canvas.style.cssText = canvasStyle;
    mount?.appendChild?.(canvas);
  }

  let state = 'initializing';
  let initialized = false;
  let initSettled = false;
  let destroyed = false;
  let lastError = null;
  let initDurationMs = null;
  let renderAttempts = 0;
  let renderedFrames = 0;
  let blockedFrames = 0;
  let errorCount = 0;
  let statusNode = createStatusNode(mount, loadingText, 'loading');
  let cleanupPromise = null;
  let resolveDisposed;
  const disposedPromise = new Promise((resolve) => { resolveDisposed = resolve; });

  function showError(error, phase) {
    lastError = error instanceof Error ? error : new Error(String(error));
    errorCount += 1;
    if (destroyed) return;
    state = 'failed';
    removeNode(statusNode);
    statusNode = createStatusNode(mount, errorText, 'error');
    callHandled(onError, { error: lastError, phase, adapter });
  }

  function beginCleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      // r185 WebGPURenderer.dispose() attempts to initialize an uninitialized
      // renderer. Skip that unsafe path after a failed init; no GPU resources
      // were acquired. A renderer destroyed during init is cleaned once init
      // settles successfully.
      if (initialized) {
        try { await renderer.dispose?.(); } catch (_) {}
      }
    })().catch(() => {}).finally(() => resolveDisposed());
    return cleanupPromise;
  }

  const adapter = {
    renderer,
    canvas,
    rendererType: 'webgpu-renderer',

    get state() { return state; },
    get backend() { return rendererBackend(renderer, initialized); },
    get isReady() { return state === 'ready' && !destroyed; },

    ready: null,

    resize(width, height, updateStyle = false) {
      if (destroyed || state === 'failed' || !isFunction(renderer.setSize)) return false;
      renderer.setSize(width, height, updateStyle);
      return true;
    },

    render(scene, camera) {
      renderAttempts += 1;
      if (destroyed || state !== 'ready') {
        blockedFrames += 1;
        return false;
      }
      try {
        const result = renderer.render(scene, camera);
        renderedFrames += 1;
        if (result && isFunction(result.then)) {
          Promise.resolve(result).catch((error) => showError(error, 'render'));
        }
        return true;
      } catch (error) {
        showError(error, 'render');
        return false;
      }
    },

    getDiagnostics() {
      return Object.freeze({
        state,
        backend: rendererBackend(renderer, initialized),
        requestedBackend,
        rendererType: 'webgpu-renderer',
        initialized,
        destroyed,
        initDurationMs,
        renderAttempts,
        renderedFrames,
        blockedFrames,
        errorCount,
        lastError: lastError?.message || null,
      });
    },

    whenDisposed() {
      return disposedPromise;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      state = 'destroyed';
      removeNode(statusNode);
      statusNode = null;
      removeNode(canvas);
      if (initSettled) beginCleanup();
    },
  };

  adapter.ready = (async () => {
    try {
      if (!isFunction(renderer.init)) {
        throw new Error('WebGPURenderer did not provide the required asynchronous init() method.');
      }
      await renderer.init();
      initialized = true;
      initDurationMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - startedAt);
      if (destroyed) return false;
      state = 'ready';
      removeNode(statusNode);
      statusNode = null;
      callHandled(onReady, {
        renderer,
        backend: rendererBackend(renderer, initialized),
        adapter,
      });
      return true;
    } catch (error) {
      showError(error, 'initialize');
      return false;
    } finally {
      initSettled = true;
      if (destroyed) beginCleanup();
    }
  })();
  // The async initializer handles all failures and resolves false. Keep a
  // terminal catch anyway so future callback changes cannot create an
  // unhandled rejection in synchronous menu callers.
  adapter.ready.catch(() => {});

  return adapter;
}
