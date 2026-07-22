/**
 * Town hub speech bubbles — Palace / Club Penguin style.
 *
 * Local-only today: press T (or /) in town to open a chat input; the message
 * appears as a paper bubble over the hero's head for ~5s with fade. When
 * the multiplayer layer lands, remote players push bubbles via the same
 * `pushBubble(playerId, text)` API and the renderer just works.
 *
 * Bubbles are screen-space DOM nodes positioned each frame by projecting
 * the speaker's world position through the active camera. Each speaker
 * gets one bubble; new messages append into the same container so a chain
 * of recent lines stays visible.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { getRendererCanvas } from './rendering/rendererAccess.js';

const BUBBLE_TTL = 5.0;     // seconds per line
const BUBBLE_MAX_LINES = 3;
const BUBBLE_MAX_CHARS = 120;

// playerId → { container, lines: [{el, dieAt, text}] }
const _speakers = new Map();
// Non-'self' speakers (town NPCs today; remote players later) register a
// world-space anchor here so tickBubbles can position their bubbles. The
// anchor is read live each frame, so passing a mutating { pos } object lets a
// wandering NPC's bubble track it for free. `y` is head height (default 1.9).
const _anchors = new Map();   // playerId → { pos: {x,z}, y?: number }
let _input = null;
let _inputOpen = false;

const _v3 = new THREE.Vector3();
const _screen = { x: 0, y: 0 };
let _canvasRect = null;
let _canvasRectSource = null;
let _canvasRectDirty = true;
let _rectListenerBound = false;
const _fallbackRect = { left: 0, top: 0, width: 0, height: 0 };

/**
 * Register (or clear, with anchor=null) a world-space anchor for a non-'self'
 * speaker. Lets town NPCs — and future networked remotes — render bubbles via
 * the same pushBubble pipeline as the local hero.
 */
export function setSpeakerAnchor(playerId, anchor) {
  if (anchor) _anchors.set(playerId, anchor);
  else _anchors.delete(playerId);
}

/** Remove one speaker's bubbles, or every bubble when no id is supplied. */
export function clearBubbles(playerId) {
  const ids = playerId === undefined ? [..._speakers.keys()] : [playerId];
  for (const id of ids) {
    const rec = _speakers.get(id);
    if (!rec) continue;
    if (rec.container && rec.container.parentNode) rec.container.parentNode.removeChild(rec.container);
    _speakers.delete(id);
  }
}

function _getCanvasRect() {
  if (!_rectListenerBound) {
    _rectListenerBound = true;
    window.addEventListener('resize', () => { _canvasRectDirty = true; }, { passive: true });
  }
  const dom = getRendererCanvas(state);
  if (!dom) {
    _fallbackRect.width = window.innerWidth;
    _fallbackRect.height = window.innerHeight;
    return _fallbackRect;
  }
  if (_canvasRectDirty || _canvasRectSource !== dom || !_canvasRect) {
    _canvasRect = dom.getBoundingClientRect();
    _canvasRectSource = dom;
    _canvasRectDirty = false;
  }
  return _canvasRect;
}

function _projectToScreen(worldX, worldY, worldZ, out) {
  const cam = state.camera;
  if (!cam) return false;
  _v3.set(worldX, worldY, worldZ);
  _v3.project(cam);
  // Map against the canvas rect (16:9 letterbox stage) + bar offset — these
  // bubbles are viewport-fixed on <body>, so raw window coords would drift
  // into the black bars on ultrawide/portrait.
  const rect = _getCanvasRect();
  out.x = rect.left + (_v3.x * 0.5 + 0.5) * rect.width;
  out.y = rect.top  + (-_v3.y * 0.5 + 0.5) * rect.height;
  return true;
}

function _ensureContainer(playerId) {
  let rec = _speakers.get(playerId);
  if (rec) return rec;
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed; left: 0; top: 0; pointer-events: none; z-index: 88;
    transform: translate(-50%, -100%);
    display: flex; flex-direction: column-reverse; align-items: center;
    gap: 4px;
  `;
  document.body.appendChild(container);
  rec = { container, lines: [], screenX: NaN, screenY: NaN };
  _speakers.set(playerId, rec);
  return rec;
}

/**
 * Append a chat line for the given speaker. Local player is 'self'; remote
 * players will use their network ID. Bubbles render in screen-space above
 * the speaker's hero mesh.
 */
export function pushBubble(playerId, text) {
  if (!text) return;
  const clean = String(text).slice(0, BUBBLE_MAX_CHARS).replace(/[‮‏]/g, '');
  if (!clean.trim()) return;
  const rec = _ensureContainer(playerId);
  const el = document.createElement('div');
  el.textContent = clean;
  el.style.cssText = `
    padding: 6px 14px;
    max-width: 280px;
    background: linear-gradient(180deg, rgba(243,232,207,0.96), rgba(217,202,170,0.96));
    border: 1px solid rgba(35,26,20,0.55);
    border-radius: 14px;
    color: #231a14;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    text-align: center;
    box-shadow: 0 4px 14px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.4);
    word-wrap: break-word;
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 0.25s ease, transform 0.25s ease;
  `;
  // Tail (a tiny rotated square below the bubble that fakes a callout point)
  const tail = document.createElement('div');
  tail.style.cssText = `
    width: 10px; height: 10px;
    background: rgba(217,202,170,0.96);
    border-right: 1px solid rgba(35,26,20,0.55);
    border-bottom: 1px solid rgba(35,26,20,0.55);
    transform: rotate(45deg) translateY(-4px);
    margin-top: -6px;
    align-self: center;
  `;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; align-items:center; pointer-events:none;';
  wrap.appendChild(el);
  wrap.appendChild(tail);
  rec.container.appendChild(wrap);
  // Animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  rec.lines.push({ wrap, el, dieAt: state.time.real + BUBBLE_TTL, text: clean });
  // Cap line count — pop oldest beyond the max
  while (rec.lines.length > BUBBLE_MAX_LINES) {
    const old = rec.lines.shift();
    if (old.wrap && old.wrap.parentNode) old.wrap.parentNode.removeChild(old.wrap);
  }
}

/**
 * Per-frame update — re-positions each speaker's container above their hero
 * mesh, fades dying bubbles out, removes them when expired. Call from town
 * tick (and later from any multiplayer-room tick).
 */
export function tickBubbles() {
  const now = state.time.real;
  for (const [playerId, rec] of _speakers) {
    if (rec.lines.length === 0) continue;
    // Position above the speaker.
    // 'self' = local hero. Remote IDs (future) would map to their avatar mesh.
    let speaker = null;
    let headY = 1.9;
    if (playerId === 'self') {
      speaker = state.hero;
    } else {
      const a = _anchors.get(playerId);
      if (a && a.pos) { speaker = a; if (typeof a.y === 'number') headY = a.y; }
    }
    if (!speaker || !speaker.pos) continue;
    if (_projectToScreen(speaker.pos.x, headY, speaker.pos.z, _screen)) {
      const screenX = Math.round(_screen.x);
      const screenY = Math.round(_screen.y);
      if (screenX !== rec.screenX) {
        rec.container.style.left = screenX + 'px';
        rec.screenX = screenX;
      }
      if (screenY !== rec.screenY) {
        rec.container.style.top = screenY + 'px';
        rec.screenY = screenY;
      }
    }
    // Fade + remove
    for (let i = rec.lines.length - 1; i >= 0; i--) {
      const line = rec.lines[i];
      const remaining = line.dieAt - now;
      if (remaining <= 0) {
        if (line.wrap && line.wrap.parentNode) line.wrap.parentNode.removeChild(line.wrap);
        rec.lines.splice(i, 1);
      } else if (remaining < 0.8) {
        const k = remaining / 0.8;
        line.el.style.opacity = String(k);
        line.el.style.transform = `translateY(${(1 - k) * -6}px)`;
      }
    }
  }
}

/** Open the chat input box at the bottom of the screen. */
function _openInput() {
  if (_inputOpen) return;
  _inputOpen = true;
  const wrap = document.createElement('div');
  wrap.id = 'kk-chat-input';
  wrap.style.cssText = `
    position: fixed; left: 50%; bottom: 4%; transform: translateX(-50%);
    z-index: 89; pointer-events: auto;
    background: linear-gradient(180deg, rgba(243,232,207,0.95), rgba(217,202,170,0.95));
    border: 1px solid rgba(35,26,20,0.6); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.4);
    padding: 6px 10px;
    display: flex; align-items: center; gap: 8px;
    min-width: 420px;
  `;
  const tag = document.createElement('span');
  tag.textContent = 'Say:';
  tag.style.cssText = `font-family: 'Cinzel Decorative', serif; font-size: 11px; letter-spacing: 0.24em; color: #5a4838; text-transform: uppercase;`;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = BUBBLE_MAX_CHARS;
  input.placeholder = 'Type and press Enter… (Esc to cancel)';
  input.style.cssText = `
    flex: 1; border: none; outline: none; background: transparent;
    color: #231a14; font: 14px 'Inter', system-ui, sans-serif;
    padding: 6px 4px;
  `;
  wrap.appendChild(tag);
  wrap.appendChild(input);
  document.body.appendChild(wrap);
  _input = wrap;
  setTimeout(() => input.focus(), 0);
  const close = () => {
    if (!_inputOpen) return;
    _inputOpen = false;
    if (_input && _input.parentNode) _input.parentNode.removeChild(_input);
    _input = null;
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close();
    } else if (e.code === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const txt = input.value.trim();
      if (txt) pushBubble('self', txt);
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
}

/**
 * Bind T / slash to open the chat input — only fires in modes where chat
 * makes sense (today: town; later: any hangout room).
 */
export function initChatBindings() {
  window.addEventListener('keydown', (e) => {
    if (_inputOpen) return;
    if (e.code !== 'KeyT' && e.key !== '/') return;
    // Town hub today; later add 'lobby' or whatever the multiplayer room mode is.
    if (state.mode !== 'town') return;
    e.preventDefault();
    _openInput();
  });
}
