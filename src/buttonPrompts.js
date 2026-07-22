/**
 * Context-sensitive button prompts.
 *
 * Looks up the active input device (keyboard/mouse vs gamepad) and produces a
 * glyph + tint for a semantic action ('interact', 'dash', 'confirm', etc).
 * Other modules call `formatPrompt(action, label)` to get an HTML snippet
 * featuring a styled pill, and register live elements via `bindPrompt(el, action, label)`
 * so that flipping the active device refreshes them in place.
 *
 * The input layer (`src/input.js`) and gamepad poller (`src/gamepad.js`) are
 * not modified here — we only READ from `input.activeDevice` (and the
 * `window.__activeInputDevice` mirror, if any other layer sets it). The active
 * device is sampled lazily on each call; a hook (`onDeviceChange`) should be
 * pumped by whoever flips the device so live prompts update immediately.
 */

import { input } from './input.js';

// ── Mapping table ───────────────────────────────────────────────────────────
// kbm = keyboard glyph (single char where possible — fits a 28px pill).
// pad = Xbox-style face/system button labels.
// tint = a tasteful colored border/glow for the pad glyph so face-button
//        colors are readable at a glance; kbm uses a neutral amber.
const KBM_TINT = '#f4e6c4';
const MAP = {
  interact:     { kbm: 'E',    pad: 'B',   padTint: '#5dbe5d' /* xbox-ish green hue for B */ },
  dash:         { kbm: '␣' /* ␣ */, pad: 'A', padTint: '#5dbe5d' },
  grapple:      { kbm: 'RMB',  pad: 'LT',  padTint: '#72e8ff' },
  active:       { kbm: 'Q',    pad: 'RB',  padTint: '#ffcf8a' },
  pause:        { kbm: 'P',    pad: '≡' /* ≡ start */, padTint: '#cccccc' },
  confirm:      { kbm: '⏎' /* ⏎ */, pad: 'A', padTint: '#5dbe5d' },
  cancel:       { kbm: 'Esc',  pad: 'B',   padTint: '#cf4f4f' },
  menu:         { kbm: 'Tab',  pad: '≡', padTint: '#cccccc' },
  levelUpPick:  { kbm: '⏎', pad: 'A', padTint: '#5dbe5d' },
};

const KBM_FALLBACK = { kbm: '?', pad: '?', padTint: KBM_TINT };

// Coarse pointer (phone/tablet). `?touch=1` forces it for the headless smoke
// test. Mirrors the helper in input.js.
let _coarse = null;
function isCoarsePointer() {
  if (_coarse !== null) return _coarse;
  try {
    _coarse = (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches)
      || (navigator.maxTouchPoints > 0)
      || ('ontouchstart' in window)
      || /[?&]touch=1/.test(location.search);
  } catch (_) { _coarse = false; }
  return _coarse;
}

// ── Device detection ────────────────────────────────────────────────────────
/**
 * Returns 'kbm' or 'gamepad' based on the active device. Prefers
 * `window.__activeInputDevice` if set (lets other layers force a mode),
 * otherwise falls back to `input.activeDevice` from the input module.
 */
export function getActiveDevice() {
  const w = typeof window !== 'undefined' ? window.__activeInputDevice : null;
  if (w === 'gamepad' || w === 'kbm') return w;
  return (input && input.activeDevice === 'gamepad') ? 'gamepad' : 'kbm';
}

/**
 * getPrompt(action) → { glyph, color, device }
 * Returns the glyph string and a recommended tint color for the action,
 * given the currently active input device.
 */
export function getPrompt(action) {
  const entry = MAP[action] || KBM_FALLBACK;
  const device = getActiveDevice();
  if (device === 'gamepad') {
    return { glyph: entry.pad, color: entry.padTint, device };
  }
  // Contextual interact prompts are tappable on coarse pointers; advertising
  // a keyboard E on phones was truthful internally but wrong for the player.
  if (action === 'interact' && isCoarsePointer()) {
    return { glyph: 'TAP', color: '#7df0c4', device: 'touch' };
  }
  return { glyph: entry.kbm, color: KBM_TINT, device };
}

// ── DOM glue ────────────────────────────────────────────────────────────────
// Inject styles once. Pill is 28px round-ish, monospace, dark background.
let _stylesInjected = false;
function ensureStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const css = `
.kk-prompt {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 28px; padding: 0 8px;
  border-radius: 8px; border: 2px solid var(--kk-prompt-color, #f4e6c4);
  background: rgba(0,0,0,0.7); color: #fff;
  font: 600 15px/1 'Consolas','Menlo','Courier New',monospace;
  letter-spacing: 0; vertical-align: middle;
  box-shadow: 0 0 6px var(--kk-prompt-color, #f4e6c4),
              inset 0 1px 0 rgba(255,255,255,0.08);
  margin-right: 6px;
  user-select: none;
}
`;
  const style = document.createElement('style');
  style.id = 'kk-button-prompts-style';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Returns HTML string: `<span class="kk-prompt" ...>GLYPH</span> Label`.
 * Use to swap "Press E …" / "[E] …" strings inline.
 */
export function formatPrompt(action, label) {
  ensureStyles();
  const p = getPrompt(action);
  const labelPart = label ? `<span class="kk-prompt-label">${escapeHtml(label)}</span>` : '';
  return `<span class="kk-prompt" style="--kk-prompt-color:${p.color}">${escapeHtml(p.glyph)}</span>${labelPart}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ── Live prompt registry ────────────────────────────────────────────────────
// Elements register their (element, action, label) so that when the device
// flips, we can rewrite them in place. We avoid MutationObserver — callers
// invoke `refreshAllPrompts()` from their device-flip hook, or call
// `setPromptLabel(el, label)` when the label itself changes.
const _live = new Set(); // entries: { el, action, getLabel }

/**
 * Bind a DOM element to render an action prompt. The element's innerHTML is
 * replaced on bind and on every refresh. `labelOrFn` may be a string or a
 * function returning a string (re-evaluated each refresh).
 */
export function bindPrompt(el, action, labelOrFn) {
  if (!el) return;
  ensureStyles();
  const getLabel = (typeof labelOrFn === 'function') ? labelOrFn : () => labelOrFn;
  const entry = { el, action, getLabel };
  _live.add(entry);
  _renderEntry(entry);
  // Touch: the contextual interact prompt is already shown/hidden by proximity
  // (scene code toggles its display), so making it tappable gives mobile the
  // interact action with no persistent on-screen button — it "fades" when no
  // interactable is in range. Synthesizes the KeyE the scene handlers listen for.
  if (action === 'interact' && isCoarsePointer() && !el.__kkTapBound) {
    el.__kkTapBound = true;
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' }));
    }, { passive: false });
  }
  return entry;
}

/** Update the label for a previously bound element (re-renders immediately). */
export function setPromptLabel(entry, labelOrFn) {
  if (!entry) return;
  entry.getLabel = (typeof labelOrFn === 'function') ? labelOrFn : () => labelOrFn;
  _renderEntry(entry);
}

/** Detach a bound element so it stops auto-refreshing. */
export function unbindPrompt(entry) {
  if (!entry) return;
  _live.delete(entry);
}

function _renderEntry(entry) {
  const label = entry.getLabel();
  entry.el.innerHTML = formatPrompt(entry.action, label);
}

/**
 * Re-render every live prompt. Cheap (Set iteration + innerHTML swap).
 * Call after the active input device changes. Safe to invoke each frame
 * if needed — but the device-flip hook is the intended cadence.
 */
export function refreshAllPrompts() {
  for (const entry of _live) _renderEntry(entry);
}

// ── Device-flip auto-refresh ────────────────────────────────────────────────
// Poll the active device once per animation frame and refresh on change.
// Cheap (one comparison) and avoids depending on internal input-layer hooks.
let _lastDevice = null;
let _pollStarted = false;
function _startDevicePoll() {
  if (_pollStarted) return;
  _pollStarted = true;
  _lastDevice = getActiveDevice();
  const tick = () => {
    const d = getActiveDevice();
    if (d !== _lastDevice) {
      _lastDevice = d;
      refreshAllPrompts();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Auto-start the device poll the moment this module is imported — cheap.
if (typeof window !== 'undefined') _startDevicePoll();
