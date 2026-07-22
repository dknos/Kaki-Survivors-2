/**
 * Owns the single WebGPURenderer animation-loop registration.
 *
 * Pausing gates frame delivery without registering another callback. Stopping
 * is the only operation that removes the renderer loop. That distinction keeps
 * visibility/menu pauses cheap while still allowing deterministic teardown.
 */
export function createRenderLifecycle({
  renderer,
  onFrameError = null,
  onPause = null,
  onResume = null,
} = {}) {
  if (!renderer || typeof renderer.setAnimationLoop !== 'function') {
    throw new TypeError('createRenderLifecycle requires a renderer with setAnimationLoop().');
  }

  let frameHandler = null;
  let installed = false;
  let paused = true;
  let disposed = false;
  let pauseReason = null;
  let transition = Promise.resolve();

  const reportFrameError = (error) => {
    if (typeof onFrameError === 'function') {
      try { onFrameError(error); } catch (_) {}
    } else {
      console.error('[renderer] Animation frame failed.', error);
    }
  };

  const dispatchFrame = (...args) => {
    if (disposed || paused || typeof frameHandler !== 'function') return;
    try {
      const result = frameHandler(...args);
      if (result && typeof result.catch === 'function') result.catch(reportFrameError);
    } catch (error) {
      reportFrameError(error);
    }
  };

  const serialize = (operation) => {
    transition = transition.then(operation, operation);
    return transition;
  };

  async function installLoop() {
    if (disposed) throw new Error('Cannot start a disposed render lifecycle.');
    if (installed) return;
    await renderer.setAnimationLoop(dispatchFrame);
    if (disposed) {
      await renderer.setAnimationLoop(null);
      return;
    }
    installed = true;
  }

  return {
    setFrameHandler(callback) {
      if (callback != null && typeof callback !== 'function') {
        throw new TypeError('Animation frame handler must be a function or null.');
      }
      frameHandler = callback;
      return this;
    },

    async start(callback = frameHandler) {
      if (callback != null) this.setFrameHandler(callback);
      if (typeof frameHandler !== 'function') {
        throw new Error('Cannot start the render lifecycle without a frame handler.');
      }
      paused = false;
      pauseReason = null;
      await serialize(installLoop);
      return this;
    },

    pause(reason = 'paused') {
      if (disposed || paused) return false;
      paused = true;
      pauseReason = reason;
      if (typeof onPause === 'function') {
        try { onPause(reason); } catch (_) {}
      }
      return true;
    },

    async resume() {
      if (disposed) throw new Error('Cannot resume a disposed render lifecycle.');
      if (!installed) await serialize(installLoop);
      const changed = paused;
      paused = false;
      pauseReason = null;
      if (changed && typeof onResume === 'function') {
        try { onResume(); } catch (_) {}
      }
      return changed;
    },

    async stop(reason = 'stopped') {
      if (disposed) return;
      paused = true;
      pauseReason = reason;
      await serialize(async () => {
        if (!installed) return;
        await renderer.setAnimationLoop(null);
        installed = false;
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      paused = true;
      pauseReason = 'disposed';
      frameHandler = null;
      await serialize(async () => {
        if (installed) await renderer.setAnimationLoop(null);
        installed = false;
      });
    },

    getState() {
      return Object.freeze({ installed, paused, disposed, pauseReason });
    },
  };
}
