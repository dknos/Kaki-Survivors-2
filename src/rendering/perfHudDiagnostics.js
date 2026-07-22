import {
  copyRendererDiagnostics,
  formatRendererDiagnostics,
} from './rendererDiagnostics.js';

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Fill diagnostics that may be unavailable during the first service samples. */
export function normalizePerfHudDiagnostics(diagnostics = {}, fallback = {}) {
  const source = diagnostics || {};
  const sourceResolution = source.resolution || {};
  const fallbackResolution = fallback.resolution || {};
  const diagnosticFps = finiteOr(source.fps, 0);
  return {
    ...source,
    backend: source.backend || fallback.backend || 'unknown',
    threeRevision: source.threeRevision || fallback.threeRevision || 'unknown',
    resolution: {
      width: finiteOr(sourceResolution.width, finiteOr(fallbackResolution.width, 0)),
      height: finiteOr(sourceResolution.height, finiteOr(fallbackResolution.height, 0)),
      cssWidth: finiteOr(sourceResolution.cssWidth, finiteOr(fallbackResolution.cssWidth, 0)),
      cssHeight: finiteOr(sourceResolution.cssHeight, finiteOr(fallbackResolution.cssHeight, 0)),
    },
    dpr: source.dpr == null ? finiteOr(fallback.dpr, null) : finiteOr(source.dpr, null),
    quality: source.quality || fallback.quality || 'unknown',
    fps: diagnosticFps > 0 ? diagnosticFps : finiteOr(fallback.fps, 0),
    cpuFrameTimeMs: source.cpuFrameTimeMs == null
      ? finiteOr(fallback.cpuFrameTimeMs, null)
      : finiteOr(source.cpuFrameTimeMs, null),
    activeScene: source.activeScene || fallback.activeScene || 'unknown',
    activeMode: source.activeMode || fallback.activeMode || 'unknown',
    dynamicResolutionScale: source.dynamicResolutionScale == null
      ? finiteOr(fallback.dynamicResolutionScale, 1)
      : finiteOr(source.dynamicResolutionScale, 1),
  };
}

export function formatPerfHudDiagnostics(snapshot) {
  return formatRendererDiagnostics(snapshot).split('\n');
}

function restoreFocus(activeElement) {
  try { activeElement?.focus?.({ preventScroll: true }); }
  catch (_) {
    try { activeElement?.focus?.(); } catch (_) {}
  }
}

/**
 * Prefer the async Clipboard API, then use the transient-textarea fallback
 * supported by older/insecure browser contexts. Both paths copy the exact
 * rendererDiagnostics report used by bug reports.
 */
export async function copyPerfHudDiagnostics(snapshot, {
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
} = {}) {
  try {
    return await copyRendererDiagnostics(snapshot, clipboard);
  } catch (clipboardError) {
    if (!documentRef?.body
        || typeof documentRef.createElement !== 'function'
        || typeof documentRef.execCommand !== 'function') {
      throw clipboardError;
    }

    const text = formatRendererDiagnostics(snapshot);
    const activeElement = documentRef.activeElement;
    const textarea = documentRef.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none;';
    documentRef.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      if (documentRef.execCommand('copy') !== true) {
        throw new Error('The browser rejected the diagnostics copy operation.');
      }
      return text;
    } finally {
      textarea.remove();
      restoreFocus(activeElement);
    }
  }
}
