const RECOVERY_STATES = Object.freeze({
  READY: 'ready',
  LOST: 'lost',
  RECOVERING: 'recovering',
  FAILED: 'failed',
  DISPOSED: 'disposed',
});

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Unknown renderer recovery error');
}
/**
 * Hooks the public r185 `renderer.onDeviceLost` callback. This covers WebGPU
 * device loss and WebGL 2 context loss without reaching into backend internals.
 */
export function createDeviceRecoveryController({
  renderer = null,
  pause = null,
  resume = null,
  saveState = null,
  recreateRenderer = null,
  onDeviceLost = null,
  onStateChange = null,
  autoRecover = false,
} = {}) {
  let activeRenderer = null;
  let previousHandler = null;
  let installedHandler = null;
  let state = RECOVERY_STATES.READY;
  let lossCount = 0;
  let lastLoss = null;
  let recoveryPromise = null;
  let disposed = false;

  const emit = (extra = {}) => {
    const snapshot = controller.getState(extra);
    if (typeof onStateChange === 'function') {
      try { onStateChange(snapshot); } catch (_) {}
    }
    return snapshot;
  };

  const detachRenderer = () => {
    if (activeRenderer && activeRenderer.onDeviceLost === installedHandler) {
      activeRenderer.onDeviceLost = previousHandler;
    }
    activeRenderer = null;
    previousHandler = null;
    installedHandler = null;
  };

  const handleLoss = async (info = {}) => {
    if (disposed || state === RECOVERY_STATES.LOST || state === RECOVERY_STATES.RECOVERING) return;
    lossCount += 1;
    state = RECOVERY_STATES.LOST;
    lastLoss = {
      api: info.api || 'unknown',
      message: info.message || 'The graphics device was lost.',
      reason: info.reason || null,
      time: Date.now(),
      progressSaved: null,
    };

    if (typeof pause === 'function') {
      try { await pause('device-lost'); } catch (_) {}
    }
    if (typeof saveState === 'function') {
      try {
        await saveState(lastLoss);
        lastLoss.progressSaved = true;
      } catch (_) {
        lastLoss.progressSaved = false;
      }
    }

    emit();
    if (typeof onDeviceLost === 'function') {
      try { await onDeviceLost(controller.getState(), info); } catch (_) {}
    }
    if (autoRecover && typeof recreateRenderer === 'function') {
      try { await controller.recover(); } catch (_) {}
    }
  };

  const attachRenderer = (nextRenderer) => {
    detachRenderer();
    if (!nextRenderer) return;
    activeRenderer = nextRenderer;
    previousHandler = typeof nextRenderer.onDeviceLost === 'function'
      ? nextRenderer.onDeviceLost
      : null;
    installedHandler = function rendererDeviceLost(info) {
      // Preserve Three.js' default callback so `_isDeviceLost` is updated.
      if (previousHandler) {
        try { previousHandler.call(nextRenderer, info); } catch (_) {}
      }
      void handleLoss(info);
    };
    nextRenderer.onDeviceLost = installedHandler;
  };

  const controller = {
    attachRenderer(nextRenderer) {
      if (disposed) throw new Error('Cannot attach a renderer to a disposed recovery controller.');
      attachRenderer(nextRenderer);
      return this;
    },

    async recover(options = {}) {
      if (disposed) throw new Error('Cannot recover a disposed renderer.');
      if (typeof recreateRenderer !== 'function') {
        throw new Error('Renderer recreation is not configured.');
      }
      if (recoveryPromise) return recoveryPromise;

      state = RECOVERY_STATES.RECOVERING;
      emit();
      recoveryPromise = (async () => {
        try {
          const replacement = await recreateRenderer({
            preferredBackend: options.preferredBackend,
            loss: lastLoss,
          });
          const replacementRenderer = replacement && replacement.renderer
            ? replacement.renderer
            : replacement;
          if (replacementRenderer) attachRenderer(replacementRenderer);
          state = RECOVERY_STATES.READY;
          if (typeof resume === 'function') await resume();
          emit({ recovered: true });
          return replacement;
        } catch (error) {
          state = RECOVERY_STATES.FAILED;
          emit({ recoveryError: errorMessage(error) });
          throw error;
        } finally {
          recoveryPromise = null;
        }
      })();
      return recoveryPromise;
    },

    getState(extra = {}) {
      return Object.freeze({
        state,
        lossCount,
        lastLoss: lastLoss ? { ...lastLoss } : null,
        canRetry: !disposed && typeof recreateRenderer === 'function',
        canSwitchToWebGL: !disposed && typeof recreateRenderer === 'function',
        ...extra,
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      state = RECOVERY_STATES.DISPOSED;
      detachRenderer();
      emit();
    },
  };

  if (renderer) attachRenderer(renderer);
  return controller;
}

export { RECOVERY_STATES };
