const BACKEND_LABELS = Object.freeze({
  webgpu: 'WebGPU',
  webgl: 'WebGL 2',
  webgl2: 'WebGL 2',
});

function cleanDiagnosticText(value, maxLength = 240) {
  if (value == null) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeRecoveryPresentation({ backend = 'unknown', recoveryState = null } = {}) {
  const normalizedBackend = cleanDiagnosticText(backend, 32).toLowerCase() || 'unknown';
  const lastLoss = recoveryState && typeof recoveryState === 'object'
    && recoveryState.lastLoss && typeof recoveryState.lastLoss === 'object'
    ? recoveryState.lastLoss
    : null;
  const reason = cleanDiagnosticText(
    lastLoss?.reason
      || lastLoss?.message
      || recoveryState?.recoveryError
      || '',
  );
  const progressSaved = typeof lastLoss?.progressSaved === 'boolean'
    ? lastLoss.progressSaved
    : null;

  let progressTitle = 'Progress save not confirmed';
  let progressDetail = 'No emergency save result was reported. The active run is not resumable after recovery.';
  if (progressSaved === true) {
    progressTitle = 'Persistent progression saved';
    progressDetail = 'Unlocks, settings, challenges, and other persistent progression were saved. The active run is not resumable.';
  } else if (progressSaved === false) {
    progressTitle = 'Emergency save was not completed';
    progressDetail = 'Persistent progression could not be confirmed saved. The active run is not resumable.';
  }

  return Object.freeze({
    backend: normalizedBackend,
    backendLabel: BACKEND_LABELS[normalizedBackend] || 'Unknown renderer',
    reason,
    progressSaved,
    progressTitle,
    progressDetail,
    canRetry: recoveryState?.canRetry !== false,
    canSwitchToWebGL: recoveryState?.canSwitchToWebGL === true
      && normalizedBackend !== 'webgl'
      && normalizedBackend !== 'webgl2',
  });
}

export function rendererBackendUrl(currentHref, backend = 'webgl') {
  const url = new URL(currentHref);
  url.searchParams.set('renderer', backend);
  return url.href;
}
