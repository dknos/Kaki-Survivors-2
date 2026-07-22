/**
 * Reusable full-screen story cutscene player.
 *
 * A full-bleed generated-art backdrop (same pattern as endRunSummary
 * _ensureBackdrop) + a typewriter dialogue box + skip. Used for the once-per-
 * install objective intros (Forest Grove Trials or the five-shard route) and
 * the PORTAL cutscene used when a shard stage's fifth shard awakens its gate.
 *
 * KEY DESIGN: the cutscene is SELF-DRIVEN (setInterval typewriter + setTimeout
 * auto-advance), NOT ticked from the game loop. It sets `state.time.paused =
 * true` on show, so a loop-driven cutscene would deadlock (the tick gate
 * freezes on `paused`). Wall-clock timers keep running while the game is
 * frozen underneath. Restores the prior paused value on finish.
 *
 * Skip: Enter / Space / click advances (finishing the current line's
 * typewriter instantly if mid-type, else jumping to the next line). Escape
 * ends the whole cutscene. Capture-phase + stopImmediatePropagation so the
 * cutscene wins over any lower-z key handler (mirrors endRunSummary).
 *
 * Headless/QA: window.__kkCutsceneActive (bool) + window.__kkSkipCutscene()
 * (finish immediately) — the typewriter/auto-advance timers crawl under the
 * headless throttle, so tests skip-to-done instead of waiting.
 *
 * Public API:
 *   playCutscene({ image, title, lines, accent, onDone })
 *   isCutscenePlaying()
 *   skipCutscene()
 */
import { state } from './state.js';

const EL_ID = 'kk-cutscene';
const TYPE_MS = 28;        // ms per character (typewriter speed)
const AUTO_HOLD_MS = 1700; // pause after a line finishes before auto-advancing
const FADE_MS = 460;

let _el = null;
let _lineEl = null;
let _hintEl = null;
let _active = null;        // { lines, idx, fullText, typedLen, typing, onDone, done }
let _prevPaused = false;
let _keyHandler = null;
let _clickHandler = null;
let _typeTimer = null;
let _holdTimer = null;
let _sfx = null;

function _warmSfx() {
  if (!_sfx) { import('./audio.js').then((m) => { _sfx = m.sfx; }).catch(() => {}); }
}

export function isCutscenePlaying() { return !!_active; }

export function playCutscene(opts) {
  const { image = null, title = '', lines = [], accent = '#c87bff', onDone = null } = opts || {};
  if (typeof document === 'undefined') { if (onDone) { try { onDone(); } catch (_) {} } return; }
  // One cutscene at a time. If one is already playing, we STILL run the new
  // caller's onDone immediately — otherwise a dropped continuation (e.g. the
  // portal cutscene's onDone opens the portal) would soft-lock the run.
  if (_active) { if (onDone) { try { onDone(); } catch (_) {} } return; }
  _warmSfx();

  _prevPaused = !!(state.time && state.time.paused);
  if (state.time) state.time.paused = true;

  // ── Backdrop ────────────────────────────────────────────────────────────
  const el = document.createElement('div');
  el.id = EL_ID;
  const bg = image
    ? `linear-gradient(rgba(4,2,10,0.30), rgba(4,2,10,0.30)), #05030a url('${image}') center center / cover no-repeat`
    : '#05030a';
  el.style.cssText = `
    position: fixed; inset: 0; z-index: 136; pointer-events: auto;
    background: ${bg};
    opacity: 0; transition: opacity ${FADE_MS}ms ease-out;
    display: flex; flex-direction: column; justify-content: flex-end;
  `;

  // Vignette + bottom scrim so the dialogue box always reads over busy art.
  const scrim = document.createElement('div');
  scrim.style.cssText = `
    position: absolute; inset: 0; pointer-events: none;
    background:
      radial-gradient(ellipse at center, rgba(0,0,0,0.04) 30%, rgba(0,0,0,0.5) 100%),
      linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 26%,
                      rgba(0,0,0,0) 46%, rgba(0,0,0,0.86) 100%);
  `;
  el.appendChild(scrim);

  // ── Title ─────────────────────────────────────────────────────────────
  if (title) {
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = `
      position: absolute; top: 8%; left: 50%; transform: translateX(-50%);
      max-width: 92vw; box-sizing: border-box; text-align: center; white-space: normal;
      font-family: 'Cinzel Decorative', 'Cinzel', serif; font-weight: 900;
      font-size: clamp(30px, 7vw, 76px); letter-spacing: 0.14em;
      color: ${accent};
      text-shadow: 0 4px 24px rgba(0,0,0,0.85), 0 0 44px ${accent}88;
    `;
    el.appendChild(t);
  }

  // ── Dialogue box ─────────────────────────────────────────────────────────
  const box = document.createElement('div');
  box.style.cssText = `
    position: relative; margin: 0 auto 8vh; max-width: min(760px, 92vw);
    box-sizing: border-box; width: 100%;
    padding: 20px 28px 16px; text-align: center;
    background: linear-gradient(180deg, rgba(26,16,42,0.82), rgba(12,6,22,0.9));
    border: 1px solid ${accent}88; border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.6), 0 0 26px ${accent}33;
  `;
  const line = document.createElement('div');
  line.style.cssText = `
    min-height: 2.6em; max-width: 100%; box-sizing: border-box;
    white-space: normal; word-break: break-word;
    font-family: 'Cinzel', Georgia, serif; font-weight: 600;
    font-size: clamp(15px, 2.4vw, 21px); line-height: 1.45; letter-spacing: 0.03em;
    color: #f0e6ff; text-shadow: 0 2px 10px rgba(0,0,0,0.8);
  `;
  box.appendChild(line);

  const hint = document.createElement('div');
  hint.textContent = '▶  ENTER / CLICK';
  hint.style.cssText = `
    margin-top: 10px; font-family: 'Cinzel', serif; font-size: 10px;
    letter-spacing: 0.28em; color: ${accent}; opacity: 0.7;
  `;
  box.appendChild(hint);
  el.appendChild(box);

  document.body.appendChild(el);
  _el = el; _lineEl = line; _hintEl = hint;
  _active = { lines: Array.isArray(lines) ? lines : [], idx: -1, fullText: '', typedLen: 0, typing: false, onDone, done: false };

  // Skip / advance handlers (capture phase — win over lower-z handlers).
  _keyHandler = (e) => {
    if (!e) return;
    const k = e.code || e.key;
    if (k === 'Escape' || e.key === 'Escape') {
      e.preventDefault();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      _finish();
    } else if (k === 'Enter' || k === 'Space' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      _advance();
    }
  };
  try { window.addEventListener('keydown', _keyHandler, true); } catch (_) {}
  _clickHandler = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } _advance(); };
  try { el.addEventListener('click', _clickHandler); } catch (_) {}

  try { window.__kkCutsceneActive = true; window.__kkSkipCutscene = skipCutscene; } catch (_) {}

  // Fade in, then start the first line next frame.
  requestAnimationFrame(() => { if (_el) _el.style.opacity = '1'; _nextLine(); });
}

function _nextLine() {
  const a = _active; if (!a) return;
  a.idx++;
  if (a.idx >= a.lines.length) { _finish(); return; }
  _typeLine(String(a.lines[a.idx] || ''));
}

function _typeLine(text) {
  const a = _active; if (!a || !_lineEl) return;
  _clearTimers();
  a.fullText = text; a.typedLen = 0; a.typing = true;
  _lineEl.textContent = '';
  if (_hintEl) _hintEl.style.opacity = '0';
  _typeTimer = setInterval(() => {
    if (!_active || !_lineEl) { _clearTimers(); return; }
    a.typedLen++;
    _lineEl.textContent = text.slice(0, a.typedLen);
    if ((a.typedLen & 3) === 0 && _sfx && _sfx.uiTick) { try { _sfx.uiTick(); } catch (_) {} }
    if (a.typedLen >= text.length) {
      _clearTimers();
      a.typing = false;
      if (_hintEl) _hintEl.style.opacity = '0.7';
      _holdTimer = setTimeout(() => { _nextLine(); }, AUTO_HOLD_MS);
    }
  }, TYPE_MS);
}

function _advance() {
  const a = _active; if (!a) return;
  if (a.typing) {
    // Finish the current line instantly.
    _clearTimers();
    a.typedLen = a.fullText.length;
    if (_lineEl) _lineEl.textContent = a.fullText;
    a.typing = false;
    if (_hintEl) _hintEl.style.opacity = '0.7';
    _holdTimer = setTimeout(() => { _nextLine(); }, AUTO_HOLD_MS);
  } else {
    _clearTimers();
    _nextLine();
  }
}

function _clearTimers() {
  if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null; }
  if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
}

function _finish() {
  const a = _active; if (!a || a.done) return;
  a.done = true;
  _clearTimers();
  const onDone = a.onDone;
  if (_keyHandler) { try { window.removeEventListener('keydown', _keyHandler, true); } catch (_) {} _keyHandler = null; }
  if (_el && _clickHandler) { try { _el.removeEventListener('click', _clickHandler); } catch (_) {} }
  _clickHandler = null;
  if (state.time) state.time.paused = _prevPaused;
  try { window.__kkCutsceneActive = false; } catch (_) {}
  const el = _el;
  _el = null; _lineEl = null; _hintEl = null; _active = null;
  if (el) {
    el.style.opacity = '0';
    setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {} }, FADE_MS + 40);
  }
  if (onDone) { try { onDone(); } catch (e) { console.warn('[cutscene.onDone]', e); } }
}

export function skipCutscene() { _finish(); }
