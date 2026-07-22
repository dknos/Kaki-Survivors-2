const DEFERRED_MODES = Object.freeze({
  crash: Object.freeze({
    status: 'deferred',
    reason: 'renderer-migration',
    label: 'DEFERRED FOR THIS WEBGPU PREVIEW',
    detail: 'Kaki Catastrophe remains available in the original WebGL release.',
  }),
});

const AVAILABLE = Object.freeze({ status: 'available' });

export function getRacingModeAvailability(mode) {
  return DEFERRED_MODES[String(mode || '')] || AVAILABLE;
}

export function canLaunchRacingMode(mode) {
  return getRacingModeAvailability(mode).status === 'available';
}
