/** Versioned, bounded Monster Arena personal records and route traces. */

export const MONSTER_RECORDS_VERSION = 1;
export const MONSTER_RECORDS_KEY = `kks_monster_records_v${MONSTER_RECORDS_VERSION}`;
const MAX_ROUTE_POINTS = 360;
const MAX_COORDINATE = 256;

function _finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function _safePoint(point) {
  const x = _finite(point?.x, NaN);
  const z = _finite(point?.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > MAX_COORDINATE || Math.abs(z) > MAX_COORDINATE) return null;
  return { x: Math.round(x * 20) / 20, z: Math.round(z * 20) / 20 };
}

function _safeRoute(route) {
  if (!Array.isArray(route)) return [];
  return route.slice(0, MAX_ROUTE_POINTS).map(_safePoint).filter(Boolean);
}

function _emptyStore() {
  return { version: MONSTER_RECORDS_VERSION, arenas: {} };
}

export function readMonsterRecords(storage = globalThis?.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(MONSTER_RECORDS_KEY) || 'null');
    if (parsed?.version !== MONSTER_RECORDS_VERSION || !parsed.arenas || typeof parsed.arenas !== 'object') {
      return _emptyStore();
    }
    return parsed;
  } catch (_) {
    return _emptyStore();
  }
}

function _recordKey(arenaId, eventMode, vehicleId) {
  return `${arenaId || 'arena'}::${eventMode || 'smashdown'}::${vehicleId || 'meowster'}`;
}

export function createMonsterRecordRun({ arenaId, eventMode, vehicleId, storage = globalThis?.localStorage } = {}) {
  const store = readMonsterRecords(storage);
  const key = _recordKey(arenaId, eventMode, vehicleId);
  const previous = store.arenas[key] || {};
  return {
    key,
    arenaId: arenaId || '',
    eventMode: eventMode || 'smashdown',
    vehicleId: vehicleId || 'meowster',
    storage,
    store,
    elapsed: 0,
    sampleClock: 0,
    route: [],
    previousRoute: _safeRoute(previous.route),
    previous: {
      score: Math.max(0, _finite(previous.score)),
      wreckChain: Math.max(1, _finite(previous.wreckChain, 1)),
      airTime: Math.max(0, _finite(previous.airTime)),
      trick: typeof previous.trick === 'string' ? previous.trick.slice(0, 64) : '',
      trickPoints: Math.max(0, _finite(previous.trickPoints)),
      completionTime: Math.max(0, _finite(previous.completionTime)),
    },
    saved: false,
  };
}

export function stepMonsterRecordRun(run, kart, dt) {
  if (!run || !kart || !(dt > 0)) return false;
  run.elapsed += dt;
  run.sampleClock += dt;
  if (run.sampleClock < 0.24 || run.route.length >= MAX_ROUTE_POINTS) return false;
  run.sampleClock %= 0.24;
  const point = _safePoint(kart);
  if (!point) return false;
  const previous = run.route.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.z - previous.z) < 0.85) return false;
  run.route.push(point);
  return true;
}

export function finishMonsterRecordRun(run, metrics = {}) {
  if (!run || run.saved) return { saved: false, improved: [] };
  const previous = run.store.arenas[run.key] || {};
  const previousCompletion = Math.max(0, _finite(previous.completionTime));
  const candidateCompletion = Math.max(0, _finite(metrics.completionTime));
  const next = {
    score: Math.max(_finite(previous.score), _finite(metrics.score)),
    wreckChain: Math.max(1, _finite(previous.wreckChain, 1), _finite(metrics.wreckChain, 1)),
    airTime: Math.max(_finite(previous.airTime), _finite(metrics.airTime)),
    trickPoints: Math.max(_finite(previous.trickPoints), _finite(metrics.trickPoints)),
    trick: _finite(metrics.trickPoints) >= _finite(previous.trickPoints)
      ? String(metrics.trick || '').slice(0, 64)
      : String(previous.trick || '').slice(0, 64),
    completionTime: candidateCompletion > 0 && (!previousCompletion || candidateCompletion < previousCompletion)
      ? candidateCompletion
      : previousCompletion,
    route: _safeRoute(previous.route),
  };
  const improved = [];
  for (const field of ['score', 'wreckChain', 'airTime', 'trickPoints']) {
    if (_finite(next[field]) > _finite(previous[field]) + 0.001) improved.push(field);
  }
  if (next.completionTime > 0 && (!previousCompletion || next.completionTime < previousCompletion - 0.001)) {
    improved.push('completionTime');
  }
  const routeEligible = run.route.length >= 8
    && (run.eventMode === 'free-ride' || run.eventMode === 'freestyle')
    && (_finite(metrics.score) >= _finite(previous.score) || !next.route.length);
  if (routeEligible) {
    next.route = _safeRoute(run.route);
    improved.push('route');
  }
  run.store.arenas[run.key] = next;
  let saved = false;
  try {
    run.storage?.setItem?.(MONSTER_RECORDS_KEY, JSON.stringify(run.store));
    saved = true;
  } catch (_) {}
  run.saved = true;
  return { saved, improved, record: next };
}

export function monsterRecordSnapshot(run) {
  return run ? {
    version: MONSTER_RECORDS_VERSION,
    previousRoutePoints: run.previousRoute.length,
    currentRoutePoints: run.route.length,
    previous: { ...run.previous },
    saved: !!run.saved,
  } : null;
}
