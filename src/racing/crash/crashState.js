import { CRASH_PHASES } from './crashConfig.js';

const PHASE_GRAPH = Object.freeze({
  [CRASH_PHASES.LOADING]: Object.freeze([CRASH_PHASES.INTRO, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.INTRO]: Object.freeze([CRASH_PHASES.COUNTDOWN, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.COUNTDOWN]: Object.freeze([CRASH_PHASES.APPROACH, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.APPROACH]: Object.freeze([CRASH_PHASES.LIVE_CRASH, CRASH_PHASES.SETTLING, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.LIVE_CRASH]: Object.freeze([CRASH_PHASES.SETTLING, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.SETTLING]: Object.freeze([CRASH_PHASES.REPLAY, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.REPLAY]: Object.freeze([CRASH_PHASES.RESULTS, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.RESULTS]: Object.freeze([CRASH_PHASES.COUNTDOWN, CRASH_PHASES.REPLAY, CRASH_PHASES.DISPOSED]),
  [CRASH_PHASES.DISPOSED]: Object.freeze([]),
});

export function createCrashState(now = 0) {
  return {
    phase: CRASH_PHASES.LOADING,
    enteredAt: Number(now) || 0,
    elapsed: 0,
    serial: 0,
    reason: 'created',
    history: [{ phase: CRASH_PHASES.LOADING, at: Number(now) || 0, reason: 'created' }],
  };
}

export function canTransitionCrashState(state, next) {
  return !!state && (PHASE_GRAPH[state.phase] || []).includes(next);
}

export function transitionCrashState(state, next, at = state?.enteredAt || 0, reason = '') {
  if (!state || !Object.values(CRASH_PHASES).includes(next)) throw new Error(`Unknown crash phase: ${next}`);
  if (state.phase === next) return false;
  if (!canTransitionCrashState(state, next)) throw new Error(`Invalid crash transition ${state.phase} -> ${next}`);
  state.phase = next;
  state.enteredAt = Number(at) || 0;
  state.elapsed = 0;
  state.serial += 1;
  state.reason = String(reason || 'runtime');
  state.history.push({ phase: next, at: state.enteredAt, reason: state.reason });
  return true;
}

export function tickCrashState(state, dt) {
  if (!state || state.phase === CRASH_PHASES.DISPOSED) return 0;
  const safe = Math.max(0, Number(dt) || 0);
  state.elapsed += safe;
  return state.elapsed;
}

export function disposeCrashState(state, at = 0) {
  if (!state || state.phase === CRASH_PHASES.DISPOSED) return false;
  return transitionCrashState(state, CRASH_PHASES.DISPOSED, at, 'dispose');
}

export function crashPhaseGraph() {
  return PHASE_GRAPH;
}
