/**
 * Allocation-free rolling DPS window.
 *
 * Fifty 100ms buckets replace the old per-hit [time, damage] tuples. Advancing
 * the ring expires each bucket once, so recording and reading stay bounded
 * even when chain/borgir builds land hundreds of hits per second.
 */
export const DPS_WINDOW_SECONDS = 5;
const BUCKET_SECONDS = 0.1;
const BUCKET_COUNT = Math.ceil(DPS_WINDOW_SECONDS / BUCKET_SECONDS);

export function createDpsWindow() {
  return {
    buckets: new Float64Array(BUCKET_COUNT),
    epoch: -1,
    total: 0,
  };
}

export function resetDpsWindow(win) {
  if (!win) return;
  win.buckets.fill(0);
  win.epoch = -1;
  win.total = 0;
}

function _advance(win, now) {
  const epoch = Math.floor(Math.max(0, now) / BUCKET_SECONDS);
  if (win.epoch < 0 || epoch < win.epoch || epoch - win.epoch >= BUCKET_COUNT) {
    win.buckets.fill(0);
    win.total = 0;
    win.epoch = epoch;
    return;
  }
  for (let e = win.epoch + 1; e <= epoch; e++) {
    const i = e % BUCKET_COUNT;
    win.total -= win.buckets[i];
    win.buckets[i] = 0;
  }
  // Avoid a tiny negative residue after many floating-point add/subtracts.
  if (win.total < 0 && win.total > -1e-9) win.total = 0;
  win.epoch = epoch;
}

export function recordDps(win, now, amount) {
  if (!win || !(amount > 0)) return;
  _advance(win, now);
  const i = win.epoch % BUCKET_COUNT;
  win.buckets[i] += amount;
  win.total += amount;
}

export function readDps(win, now) {
  if (!win) return 0;
  _advance(win, now);
  return win.total / DPS_WINDOW_SECONDS;
}
