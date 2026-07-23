import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { createPreviewRendererAdapter } from '../previewRendererAdapter.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeMount() {
  const children = [];
  const documentRef = {
    createElement() {
      return {
        style: {},
        parentNode: null,
        setAttribute(name, value) { this[name] = value; },
        remove() {
          if (this.parentNode) this.parentNode.removeChild(this);
        },
      };
    },
  };
  return {
    children,
    ownerDocument: documentRef,
    appendChild(node) { node.parentNode = this; children.push(node); },
    removeChild(node) {
      const index = children.indexOf(node);
      if (index >= 0) children.splice(index, 1);
      node.parentNode = null;
    },
  };
}

function fakeCanvas() {
  return { className: '', style: {}, parentNode: null };
}

class FakeRendererBase {
  constructor(options) {
    this.options = options;
    this.domElement = fakeCanvas();
    this.renderCount = 0;
    this.disposeCount = 0;
  }
  setSize(width, height, updateStyle) { this.size = { width, height, updateStyle }; }
  render(scene, camera) { this.lastRender = { scene, camera }; this.renderCount += 1; }
  dispose() { this.disposeCount += 1; }
}

test('prefers the injected WebGPURenderer and blocks frames until init resolves', async () => {
  const init = deferred();
  class FakeWebGPURenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      this.isWebGPURenderer = true;
      this.backend = { isWebGPUBackend: true };
    }
    init() { return init.promise; }
  }
  const mount = fakeMount();
  let readyEvent = null;
  const adapter = createPreviewRendererAdapter({
    THREE: { WebGPURenderer: FakeWebGPURenderer },
    mount,
    preferredBackend: 'webgpu',
    rendererOptions: { alpha: true },
    canvasClassName: 'preview-canvas',
    canvasStyle: 'position:absolute',
    onReady: (event) => { readyEvent = event; },
  });

  assert.equal(adapter.rendererType, 'webgpu-renderer');
  assert.equal(adapter.renderer.options.alpha, true);
  assert.equal(adapter.canvas.className, 'preview-canvas');
  assert.equal(adapter.state, 'initializing');
  assert.equal(adapter.render({}, {}), false);
  assert.equal(adapter.renderer.renderCount, 0);
  assert.equal(adapter.resize(800, 450), true);
  assert.deepEqual(adapter.renderer.size, { width: 800, height: 450, updateStyle: false });
  assert.equal(mount.children.some((node) => node.textContent === 'Preparing 3D preview…'), true);

  init.resolve();
  assert.equal(await adapter.ready, true);
  assert.equal(adapter.render({ id: 'scene' }, { id: 'camera' }), true);
  assert.equal(adapter.renderer.renderCount, 1);
  assert.equal(adapter.backend, 'webgpu');
  assert.equal(readyEvent.backend, 'webgpu');
  assert.equal(mount.children.length, 1);
  assert.deepEqual(adapter.getDiagnostics(), {
    state: 'ready',
    backend: 'webgpu',
    requestedBackend: 'webgpu',
    rendererType: 'webgpu-renderer',
    initialized: true,
    destroyed: false,
    initDurationMs: adapter.getDiagnostics().initDurationMs,
    renderAttempts: 2,
    renderedFrames: 1,
    blockedFrames: 1,
    errorCount: 0,
    lastError: null,
  });
  adapter.destroy();
  await adapter.whenDisposed();
});

test('forced WebGL preference reaches every WebGPURenderer preview canvas', async () => {
  class FakeWebGPURenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      this.isWebGPURenderer = true;
      this.backend = { isWebGLBackend: true };
    }
    async init() {}
  }
  const adapter = createPreviewRendererAdapter({
    THREE: { WebGPURenderer: FakeWebGPURenderer },
    preferredBackend: 'webgl',
    rendererOptions: { alpha: true },
  });

  assert.equal(adapter.renderer.options.forceWebGL, true);
  assert.equal(await adapter.ready, true);
  assert.equal(adapter.backend, 'webgl2');
  assert.equal(adapter.getDiagnostics().requestedBackend, 'webgl');
  adapter.destroy();
  await adapter.whenDisposed();
});

test('menu previews inherit the active saved backend when no URL override exists', async () => {
  class FakeWebGPURenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      this.isWebGPURenderer = true;
      this.backend = { isWebGLBackend: true };
    }
    async init() {}
  }

  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousService = globalThis.__kkRendererService;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { search: '?qa=all-materials' },
  });
  globalThis.__kkRendererService = {
    getDiagnostics: () => ({ requestedBackend: 'webgl' }),
  };

  let adapter;
  try {
    adapter = createPreviewRendererAdapter({
      THREE: { WebGPURenderer: FakeWebGPURenderer },
    });
    assert.equal(adapter.renderer.options.forceWebGL, true);
    assert.equal(await adapter.ready, true);
    assert.equal(adapter.getDiagnostics().requestedBackend, 'webgl');
  } finally {
    adapter?.destroy();
    if (adapter) await adapter.whenDisposed();
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
    else delete globalThis.location;
    if (previousService === undefined) delete globalThis.__kkRendererService;
    else globalThis.__kkRendererService = previousService;
  }
});

test('init failure resolves false, reports a friendly fallback, and never renders', async () => {
  class BrokenWebGPURenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      this.isWebGPURenderer = true;
    }
    async init() { throw new Error('adapter unavailable'); }
  }
  const mount = fakeMount();
  let failure = null;
  const adapter = createPreviewRendererAdapter({
    THREE: { WebGPURenderer: BrokenWebGPURenderer },
    mount,
    errorText: 'Preview fallback',
    onError: (event) => { failure = event; },
  });

  assert.equal(await adapter.ready, false);
  assert.equal(adapter.state, 'failed');
  assert.equal(adapter.render({}, {}), false);
  assert.equal(adapter.renderer.renderCount, 0);
  assert.equal(failure.phase, 'initialize');
  assert.equal(adapter.getDiagnostics().lastError, 'adapter unavailable');
  assert.equal(mount.children.some((node) => node.textContent === 'Preview fallback'), true);
  adapter.destroy();
  await adapter.whenDisposed();
  // r185 WebGPURenderer.dispose() is unsafe after init rejection and must not
  // be called, because it would attempt initialization again.
  assert.equal(adapter.renderer.disposeCount, 0);
});

test('destroy during pending init prevents ready callbacks and rendering', async () => {
  const init = deferred();
  class SlowWebGPURenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      this.isWebGPURenderer = true;
      this.backend = { isWebGLBackend: true };
    }
    init() { return init.promise; }
  }
  const mount = fakeMount();
  let readyCalls = 0;
  const adapter = createPreviewRendererAdapter({
    THREE: { WebGPURenderer: SlowWebGPURenderer },
    mount,
    onReady: () => { readyCalls += 1; },
  });

  adapter.destroy();
  assert.equal(adapter.state, 'destroyed');
  assert.equal(adapter.render({}, {}), false);
  init.resolve();
  assert.equal(await adapter.ready, false);
  await adapter.whenDisposed();
  assert.equal(readyCalls, 0);
  assert.equal(adapter.renderer.renderCount, 0);
  assert.equal(adapter.renderer.disposeCount, 1);
  assert.equal(mount.children.length, 0);
});

test('a render exception becomes a handled preview error instead of escaping the RAF', async () => {
  class ThrowingRenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      this.isWebGPURenderer = true;
      this.backend = { isWebGLBackend: true };
    }
    async init() {}
    render() { throw new Error('pipeline failed'); }
  }
  const mount = fakeMount();
  const adapter = createPreviewRendererAdapter({
    THREE: { WebGPURenderer: ThrowingRenderer },
    mount,
    errorText: 'Renderer stopped',
  });

  assert.equal(await adapter.ready, true);
  assert.doesNotThrow(() => assert.equal(adapter.render({}, {}), false));
  assert.equal(adapter.state, 'failed');
  assert.equal(adapter.getDiagnostics().errorCount, 1);
  assert.equal(mount.children.some((node) => node.textContent === 'Renderer stopped'), true);
  adapter.destroy();
  await adapter.whenDisposed();
});

test('configuration failure does not accidentally initialize WebGPURenderer during cleanup', () => {
  let instance = null;
  class ConfiguredWebGPURenderer extends FakeRendererBase {
    constructor(options) {
      super(options);
      instance = this;
      this.isWebGPURenderer = true;
      this.initCount = 0;
    }
    init() { this.initCount += 1; return Promise.resolve(); }
  }

  assert.throws(() => createPreviewRendererAdapter({
    THREE: { WebGPURenderer: ConfiguredWebGPURenderer },
    configureRenderer() { throw new Error('bad preview configuration'); },
  }), /bad preview configuration/);
  assert.equal(instance.initCount, 0);
  assert.equal(instance.disposeCount, 0);
});

test('preview sources use the adapter and contain no direct renderer lifecycle calls', () => {
  for (const file of ['src/charCarousel.js', 'src/menuHeroSplash.js']) {
    const source = fs.readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.match(source, /createPreviewRendererAdapter\(\{[\s\S]*?THREE,/);
    assert.doesNotMatch(source, /new\s+THREE\.(?:WebGLRenderer|WebGPURenderer)\s*\(/);
    assert.doesNotMatch(source, /renderer\.render\s*\(/);
    assert.doesNotMatch(source, /renderer\.(?:dispose|forceContextLoss)\s*\(/);
  }
});
