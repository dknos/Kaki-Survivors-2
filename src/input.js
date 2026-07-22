/**
 * Input: keyboard (WASD + arrow keys) and touch joystick (left half of screen).
 * Writes into state.input.moveVec each frame via sampleInput().
 */
import * as THREE from 'three';
import { state } from './state.js';
import { initGamepad, pollGamepad, gamepadState, gamepadHasActivity } from './gamepad.js';
import { getMeta } from './meta.js';
import { bh } from './bullethell/bhState.js';
import { getRendererCanvas } from './rendering/rendererAccess.js';

// ── Active input device tracking ─────────────────────────────────────────────
// Other systems (HUD prompts, etc.) read input.activeDevice to swap key/button
// glyphs. Flips on whichever device produced input most recently.
export const input = {
  activeDevice: 'kbm',   // 'kbm' or 'gamepad'
};
let _kbmActivityThisFrame = false;

// Zoom is a discrete ladder gated by the "Bigger Picture" powerup.
// Notch 0 = most zoomed in (start of every run). Each unlock opens one more
// notch outward. Wheel/pinch only moves within unlocked range.
const ZOOM_NOTCHES = [3.0, 2.2, 1.6, 1.2, 0.9, 0.65];
let _zoomNotch = 0;
let _maxUnlocked = 0;    // index of farthest-out notch the player has earned
let _pinchStartDist = 0;
let _pinchStartNotch = 0;

// ── Manual aim: cursor → world XZ via ortho-camera ray (cheap, no Raycaster) ──
const _mouse = { clientX: 0, clientY: 0, hasMoved: false };
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _aimWorldOut = { x: 0, z: 0 };
const _aimDirOut = { x: 0, z: 1 };
const _fallbackRect = { left: 0, top: 0, width: 1, height: 1 };
let _canvasRect = null;
let _canvasRectEl = null;
let _canvasRectDirty = true;
export function getMouseClient() { return _mouse; }

// ── Primary-fire input (DMD-hybrid hold-to-fire) ──
// _primaryHeld = LMB currently down. _lastAimMoveAt = last cursor-move time, so
// isManualAiming() knows whether the player is actively aiming with the mouse
// vs idle (auto-target nearest). Set by handlers in initInput().
let _primaryHeld = false;
let _lastAimMoveAt = 0;

// Pipes' signature grapple is a HOLD/RELEASE action rather than the generic
// edge-triggered active cast. Keep physical sources separate so releasing one
// device cannot cancel another that is still held. RMB is contextual: Pipes
// grapples in survivor combat, while every other hero keeps RMB = Active.
let _secondaryMouseHeld = false;
let _secondaryTouchHeld = false;
let _secondaryPadHeld = false;

function _pipesGrappleContext() {
  const mode = state.mode;
  return !!(state.started
    && state.run && state.run.avatar === 'pipes'
    && (mode === 'run' || mode === 'catacomb'));
}

/** True while Pipes' grapple control is physically held in live combat. */
export function isSecondaryActionHeld() {
  if (!_pipesGrappleContext()) return false;
  if (state.time.paused || state.pendingLevelUp || state.gameOver) return false;
  return _secondaryMouseHeld || _secondaryTouchHeld || _secondaryPadHeld;
}

/** Drop held state on lifecycle/modal edges so a grapple cannot stick. */
export function clearSecondaryAction() {
  _secondaryMouseHeld = false;
  _secondaryTouchHeld = false;
  _secondaryPadHeld = false;
}

// ── Touch action buttons (DMD-hybrid mobile) ──
// _touchDashHeld: dash button currently pressed (folded into isDashPressed).
// _touchBtns: { dash, active } DOM refs, updated each frame for cooldown
// dimming + hide-while-paused. _lastStickTapAt: double-tap-to-jump timing.
let _touchDashHeld = false;
let _touchBtns = null;
let _lastStickTapAt = 0;
let _dialogScanAt = 0;
let _dialogOpen = false;
let _interactionGate = -1;
const _touchPaint = {
  dashLive: null, dashReady: null,
  activeShow: null, activeReady: null, activeKind: null,
  pauseLive: null,
};

/** Is the game in live combat (not paused, no modal up)? Touch buttons hide
 *  otherwise so a tap can't leak a queued cast through a paused frame. */
function _gameInteractive() {
  const started = !!state.started;
  const paused = !!(state.time && state.time.paused);
  const pending = !!state.pendingLevelUp;
  // A run/modal state edge invalidates the DOM sample immediately. Without
  // this, a dialog found on the menu could keep mobile actions hidden for the
  // remainder of the 100ms cache window after Embark or a draft closes.
  const gate = (started ? 1 : 0) | (paused ? 2 : 0) | (pending ? 4 : 0);
  if (gate !== _interactionGate) {
    _interactionGate = gate;
    _dialogScanAt = 0;
  }
  if (!started || paused || pending) return false;
  // Hub scenes use contextual prompts; combat touch chrome there is misleading
  // and can leak actions into interactions. Bullet Hell is a combat mode too:
  // its active slot becomes the Paw Bomb button below.
  if (state.mode !== 'run' && state.mode !== 'catacomb' && state.mode !== 'bullethell') return false;
  // The touch controls own a rAF so they can hide while gameplay is paused.
  // A full DOM query on every one of those frames needlessly forced selector
  // work; dialog state can be sampled at 10 Hz without affecting input safety.
  const now = performance.now();
  if (now >= _dialogScanAt) {
    _dialogScanAt = now + 100;
    try { _dialogOpen = !!document.querySelector('[role="dialog"]'); }
    catch (_) { _dialogOpen = false; }
  }
  if (_dialogOpen) return false;
  return true;
}

/** Per-frame: show/hide + cooldown-dim the touch buttons. Driven by its own
 *  rAF (runs even while game logic is paused, so buttons hide promptly). */
function _updateTouchButtons() {
  if (!_touchBtns) return;
  const live = _gameInteractive();
  if (!live) {
    _touchDashHeld = false;
    _activeCastQueued = false;
    clearSecondaryAction();
  }  // drop leaked input
  const d = _touchBtns.dash;
  if (d) {
    const ready = (state.hero.dashCD || 0) <= 0;
    if (_touchPaint.dashLive !== live) {
      _touchPaint.dashLive = live;
      d.style.display = live ? 'flex' : 'none';
    }
    if (_touchPaint.dashReady !== ready) {
      _touchPaint.dashReady = ready;
      d.style.opacity = ready ? '1' : '0.4';
      d.style.filter  = ready ? 'none' : 'grayscale(1)';
    }
  }
  const a = _touchBtns.active;
  if (a) {
    const act = state.hero.active;
    const bombMode = state.mode === 'bullethell';
    const grappleMode = !bombMode && _pipesGrappleContext();
    const grapple = state.run && state.run.pipesGrapple;
    const has = bombMode || grappleMode || !!(act && act.id);
    const show = live && has;
    const ready = bombMode
      ? !!(bh.stats && bh.stats.bombCharges > 0)
      : grappleMode
        ? !!(!grapple || (grapple.cooldown || 0) <= 0 || grapple.phase !== 'idle')
        : !!(act && (act.cd || 0) <= 0);
    const kind = bombMode ? 'bomb' : (grappleMode ? 'grapple' : 'active');
    if (_touchPaint.activeKind !== kind) {
      _touchPaint.activeKind = kind;
      a.textContent = '';
      a.setAttribute('aria-label', bombMode ? 'Paw bomb' : (grappleMode ? 'Hold to grapple' : 'Active ability'));
      const base = 'radial-gradient(circle at 50% 35%, rgba(40,52,44,0.92), rgba(10,16,13,0.95))';
      a.style.background = bombMode
        ? `url('assets/fx/bullethell/paw_bomb_icon.webp') center/62% no-repeat, ${base}`
        : grappleMode
          ? `url('assets/fx/pipes-grapple-emblem-grok-v1.webp') center/74% no-repeat, ${base}`
          : `url('assets/icons/nova.webp') center/62% no-repeat, ${base}`;
    }
    if (_touchPaint.activeShow !== show) {
      _touchPaint.activeShow = show;
      a.style.display = show ? 'flex' : 'none';
    }
    if (_touchPaint.activeReady !== !!ready) {
      _touchPaint.activeReady = !!ready;
      a.style.opacity = ready ? '1' : '0.4';
      a.style.filter  = ready ? 'none' : 'grayscale(1)';
    }
  }
  const p = _touchBtns.pause;
  if (p) {
    // Pause/Options gear: visible during live gameplay (hidden once a modal is
    // up — Options has its own close). No cooldown dim.
    if (_touchPaint.pauseLive !== live) {
      _touchPaint.pauseLive = live;
      p.style.display = live ? 'flex' : 'none';
      p.style.opacity = '0.9';
      p.style.filter  = 'none';
    }
  }
}

/** Resolve the auto-fire-primary accessibility toggle. Unset resolves by device:
 *  ON for coarse pointer (touch), OFF for mouse — so the primary fires on its own
 *  on phones (auto-aim) but is hold-to-fire on PC. */
function _resolveAutoFirePrimary() {
  let v;
  try { v = getMeta().optAutoFirePrimary; } catch (_) { v = undefined; }
  if (v === undefined || v === null) return isCoarsePointer();
  return !!v;
}

/** True while the player is firing the primary: LMB held (PC), right
 *  trigger / right-stick deflected (gamepad), or the auto-fire toggle. */
export function isPrimaryFiring() {
  if (_primaryHeld) return true;
  if (gamepadState.connected) {
    const rt = gamepadState.buttons && gamepadState.buttons.rt;
    if (rt && rt > 0.3) return true;
    if (Math.hypot(gamepadState.rx, gamepadState.ry) > 0.3) return true;
  }
  return _resolveAutoFirePrimary();
}

/** True when the player is actively aiming (mouse moved recently or right-stick
 *  deflected) — primary aims at the cursor/stick; otherwise auto-targets nearest. */
export function isManualAiming() {
  if (gamepadState.connected && Math.hypot(gamepadState.rx, gamepadState.ry) > 0.3) return true;
  // While LMB is held the cursor IS the aim point (even if still); otherwise
  // treat a recent move as active aiming. Idle => caller auto-targets nearest.
  if (_mouse.hasMoved && (_primaryHeld || (performance.now() - _lastAimMoveAt) < 1500)) return true;
  return false;
}

/**
 * Project the current mouse position onto the y=0 plane in world coords.
 * Returns {x, z}. Falls back to hero forward 10u if camera not yet ready or
 * the cursor never moved this session.
 */
export function getAimWorldPos(out = _aimWorldOut) {
  const cam = state.camera;
  const heroPos = state.hero.pos;
  if (!cam || !_mouse.hasMoved) {
    const f = state.hero.facing;
    out.x = heroPos.x + (f.x || 0) * 10;
    out.z = heroPos.z + (f.z || 1) * 10;
    return out;
  }
  // NDC must be relative to the canvas rect, not the window — with the 16:9
  // letterbox the canvas is a centred box offset from the viewport by the
  // black bars, so window-relative coords would skew aim on ultrawide/portrait.
  const dom = getRendererCanvas(state);
  if (dom && (_canvasRectDirty || _canvasRectEl !== dom || !_canvasRect)) {
    _canvasRect = dom.getBoundingClientRect();
    _canvasRectEl = dom;
    _canvasRectDirty = false;
  }
  if (!dom) {
    _fallbackRect.width = Math.max(1, window.innerWidth);
    _fallbackRect.height = Math.max(1, window.innerHeight);
  }
  const rect = (dom && _canvasRect) ? _canvasRect : _fallbackRect;
  const ndcX =  ((_mouse.clientX - rect.left) / rect.width)  * 2 - 1;
  const ndcY = -((_mouse.clientY - rect.top)  / rect.height) * 2 + 1;
  _p1.set(ndcX, ndcY, -1).unproject(cam);
  _p2.set(ndcX, ndcY,  1).unproject(cam);
  const dx = _p2.x - _p1.x, dy = _p2.y - _p1.y, dz = _p2.z - _p1.z;
  if (Math.abs(dy) < 1e-6) {
    out.x = heroPos.x;
    out.z = heroPos.z;
    return out;
  }
  const t = -_p1.y / dy;
  out.x = _p1.x + dx * t;
  out.z = _p1.z + dz * t;
  return out;
}

export function isDashPressed() {
  // Repeating presses while held are fine — hero.js gates on its own cooldown.
  // Gamepad: A button (XInput south) also triggers dash.
  if (_keys['ShiftLeft'] || _keys['ShiftRight']) return true;
  if (gamepadState.connected && gamepadState.buttons.a) return true;
  if (_touchDashHeld) return true;   // touch dash button (DMD-hybrid mobile)
  return false;
}

/** Held Space state for driving modes that use a real handbrake/powerslide. */
export function isHandbrakePressed() {
  return !!_keys.Space;
}

// Edge-triggered: returns true exactly once per keydown of Space (jump).
let _jumpQueued = false;
export function consumeJump() {
  if (_jumpQueued) { _jumpQueued = false; return true; }
  return false;
}
export function _internalQueueJump() { _jumpQueued = true; }

// Edge-triggered active-ability cast (RMB / Q on PC; touch button in Iter D).
// Consumed once per press by the weapon tick (weapons/index.js tickWeapons).
let _activeCastQueued = false;
export function consumeActiveCast() {
  if (_activeCastQueued) { _activeCastQueued = false; return true; }
  return false;
}
export function _internalQueueActiveCast() { _activeCastQueued = true; }

// Edge-triggered gamepad action queues. Other systems consume these once.
let _padInteractQueued = false;
let _padPauseQueued = false;
let _padLevelUpConfirmQueued = false;
export function consumePadInteract() {
  if (_padInteractQueued) { _padInteractQueued = false; return true; }
  return false;
}
export function consumePadPause() {
  if (_padPauseQueued) { _padPauseQueued = false; return true; }
  return false;
}
export function consumePadLevelUpConfirm() {
  if (_padLevelUpConfirmQueued) { _padLevelUpConfirmQueued = false; return true; }
  return false;
}

/**
 * Normalized world-space aim direction {x, z} for top-down weapons/hero code.
 * - If the right stick is deflected past 0.3, returns the stick direction.
 * - Otherwise falls back to the mouse-projected aim point relative to hero.
 * - z is used (not y) because the game is top-down on the XZ plane.
 */
export function getAimDirection(out = _aimDirOut) {
  if (gamepadState.connected) {
    const rx = gamepadState.rx, ry = gamepadState.ry;
    const mag = Math.hypot(rx, ry);
    if (mag > 0.3) {
      out.x = rx / mag;
      out.z = ry / mag;
      return out;
    }
  }
  const heroPos = state.hero && state.hero.pos;
  if (!heroPos) {
    const f = (state.hero && state.hero.facing) || { x: 0, z: 1 };
    out.x = f.x || 0;
    out.z = f.z || 1;
    return out;
  }
  const aim = getAimWorldPos();
  const dx = aim.x - heroPos.x;
  const dz = aim.z - heroPos.z;
  const m = Math.hypot(dx, dz);
  if (m < 1e-4) {
    const f = state.hero.facing;
    out.x = f.x || 0;
    out.z = f.z || 1;
    return out;
  }
  out.x = dx / m;
  out.z = dz / m;
  return out;
}

export function getZoom() { return ZOOM_NOTCHES[_zoomNotch]; }
export function getZoomNotch() { return _zoomNotch; }
export function getMaxZoomNotch() { return _maxUnlocked; }
export function getZoomNotchCount() { return ZOOM_NOTCHES.length; }
export function unlockZoomLevel() {
  if (_maxUnlocked < ZOOM_NOTCHES.length - 1) _maxUnlocked++;
}
export function resetZoom() { _zoomNotch = 0; _maxUnlocked = 0; }

const _keys = Object.create(null);
const _touch = {
  active: false,
  id: -1,
  originX: 0,
  originY: 0,
  curX: 0,
  curY: 0,
};
const TOUCH_MAX_RADIUS = 60;

let _initialized = false;

// Coarse pointer (phone/tablet) detection. `?touch=1` forces the path so the
// headless smoke test can exercise the touch branch (matchMedia coarse stays
// false under Playwright even with hasTouch).
let _coarse = null;
function isCoarsePointer() {
  if (_coarse !== null) return _coarse;
  try {
    _coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
      || (navigator.maxTouchPoints > 0)
      || ('ontouchstart' in window)
      || /[?&]touch=1/.test(location.search);
  } catch (_) { _coarse = false; }
  return _coarse;
}

export function initInput() {
  if (_initialized) return;
  _initialized = true;

  // ── Gamepad (Web Gamepad API, XInput-standard mapping) ──
  initGamepad();
  window.addEventListener('resize', () => { _canvasRectDirty = true; }, { passive: true });

  // ── Keyboard ──
  window.addEventListener('keydown', (e) => {
    _keys[e.code] = true;
    _kbmActivityThisFrame = true;
    // Edge-trigger jump on Space — main.js gates by state.started before consuming
    if (e.code === 'Space' && !e.repeat) _jumpQueued = true;
    // Edge-trigger active-ability cast on Q.
    if (e.code === 'KeyQ' && !e.repeat) _activeCastQueued = true;
  });
  window.addEventListener('keyup', (e) => {
    _keys[e.code] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in _keys) _keys[k] = false;
    _activeCastQueued = false;
    clearSecondaryAction();
  });

  // ── Mouse position (for manual aim mode) ──
  window.addEventListener('mousemove', (e) => {
    _mouse.clientX = e.clientX;
    _mouse.clientY = e.clientY;
    _mouse.hasMoved = true;
    _lastAimMoveAt = performance.now();
    _kbmActivityThisFrame = true;
  }, { passive: true });
  // LMB = hold-to-fire primary. Ignore presses that start on UI chrome (menu
  // buttons, dialogs) so clicking the HUD/options never starts firing; mouseup
  // anywhere clears the hold so it can't get stuck after a drag-off.
  window.addEventListener('mousedown', (e) => {
    _kbmActivityThisFrame = true;
    const onUi = e.target && e.target.closest && e.target.closest('button, [role="dialog"], [role="button"], input, a');
    if (onUi) return;
    if (e.button === 0) _primaryHeld = true;            // LMB hold = fire primary
    else if (e.button === 2) {
      if (_pipesGrappleContext()) _secondaryMouseHeld = true;
      else _activeCastQueued = true;                    // non-Pipes RMB = active
    }
  }, { passive: true });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) _primaryHeld = false;
    if (e.button === 2) _secondaryMouseHeld = false;
  }, { passive: true });
  window.addEventListener('blur', () => { _primaryHeld = false; clearSecondaryAction(); });
  // RMB is the active-ability trigger — suppress the browser context menu over
  // the play area so it doesn't pop. (Menus/dialogs keep their default menu.)
  window.addEventListener('contextmenu', (e) => {
    const onUi = e.target && e.target.closest && e.target.closest('button, [role="dialog"], [role="button"], input, a');
    if (!onUi) e.preventDefault();
  });

  // ── Touch joystick (left half of screen) ──
  const onTouchStart = (e) => {
    if (_touch.active) return;
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.5) {
        // Double-tap the move stick = jump (no dedicated button on touch).
        const now = performance.now();
        if (now - _lastStickTapAt < 280) _jumpQueued = true;
        _lastStickTapAt = now;
        _touch.active = true;
        _touch.id = t.identifier;
        _touch.originX = t.clientX;
        _touch.originY = t.clientY;
        _touch.curX = t.clientX;
        _touch.curY = t.clientY;
        break;
      }
    }
  };
  const onTouchMove = (e) => {
    if (!_touch.active) return;
    for (const t of e.changedTouches) {
      if (t.identifier === _touch.id) {
        _touch.curX = t.clientX;
        _touch.curY = t.clientY;
        e.preventDefault();
        break;
      }
    }
  };
  const onTouchEnd = (e) => {
    if (!_touch.active) return;
    for (const t of e.changedTouches) {
      if (t.identifier === _touch.id) {
        _touch.active = false;
        _touch.id = -1;
        break;
      }
    }
  };

  window.addEventListener('touchstart', onTouchStart, { passive: false });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: false });
  window.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // ── Mouse wheel zoom (steps one notch per click, clamped to unlocks) ──
  let _wheelCD = 0;
  window.addEventListener('wheel', (e) => {
    // Don't hijack the wheel for camera zoom when the pointer is over an open
    // modal — let its overflow-y:auto scroll. The game is paused while any
    // dialog is open, so zoom-while-dialog is meaningless anyway.
    if (e.target && e.target.closest && e.target.closest('[role="dialog"]')) return;
    e.preventDefault();
    const now = performance.now();
    if (now < _wheelCD) return;        // throttle: one notch per ~120ms
    _wheelCD = now + 120;
    if (e.deltaY > 0) {
      // scroll down = zoom OUT (advance notch up to unlocked cap)
      _zoomNotch = Math.min(_maxUnlocked, _zoomNotch + 1);
    } else {
      // scroll up = zoom IN (back toward notch 0)
      _zoomNotch = Math.max(0, _zoomNotch - 1);
    }
  }, { passive: false });

  // ── Pinch zoom (two-finger touch) — maps ratio to notch index ──
  window.addEventListener('touchstart', (e) => {
    // Ignore touches that began on an action button — a thumb on dash/active
    // plus a thumb on the stick is NOT a pinch (blind-spot: zoom would jitter).
    if (e.target && e.target.closest && e.target.closest('[data-kk-touch-btn]')) return;
    if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      _pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      _pinchStartNotch = _zoomNotch;
    }
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && _pinchStartDist > 0) {
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = dist / _pinchStartDist;
      // pinch open (ratio > 1) = zoom in toward 0; pinch close = zoom out toward _maxUnlocked
      // map a 50% range to one notch step
      let delta = 0;
      if (ratio > 1.7) delta = -2;
      else if (ratio > 1.3) delta = -1;
      else if (ratio < 0.6) delta = 2;
      else if (ratio < 0.77) delta = 1;
      const target = _pinchStartNotch + delta;
      _zoomNotch = Math.max(0, Math.min(_maxUnlocked, target));
      e.preventDefault();
    }
  }, { passive: false });
  window.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) _pinchStartDist = 0;
  });

  // ── Touch action buttons (coarse pointer only): DASH + ACTIVE ──
  // The DMD-hybrid mobile scheme. Movement = left-half stick (above); the
  // primary auto-fires at the nearest enemy (optAutoFirePrimary defaults ON
  // for touch). Jump is reachable by double-tapping the move stick (see
  // onTouchStart), so the bottom-right corner is freed for the two combat
  // verbs the player taps. Buttons mount on <body> (outside #kk-stage) so the
  // letterbox doesn't clip them; they self-hide while paused / a modal is up.
  if (isCoarsePointer()) {
    const mkBtn = (id, glyph, label, css) => {
      const b = document.createElement('div');
      b.id = id;
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
      b.setAttribute('data-kk-touch-btn', '1');
      b.style.cssText = `position: fixed; z-index: 90; ${css}
        border-radius: 50%; display: none; align-items: center; justify-content: center;
        background: radial-gradient(circle at 50% 35%, rgba(40,52,44,0.92), rgba(10,16,13,0.95));
        border: 2px solid rgba(255,210,127,0.5); color: #ffd27f; line-height: 1;
        user-select: none; touch-action: none;
        transition: transform 0.09s ease, opacity 0.12s ease, filter 0.12s ease;`;
      document.body.appendChild(b);
      return b;
    };
    const dashBtn   = mkBtn('kk-touch-dash',   '»', 'Dash',
      'right: 16px; bottom: 12px; width: 68px; height: 68px; font-size: 34px;');
    const activeBtn = mkBtn('kk-touch-active', '✸', 'Active ability',
      'right: 24px; bottom: 91px; width: 54px; height: 54px; font-size: 25px;');
    // Pause / Options — mobile has no ESC key. The telemetry card moved into
    // the bottom command deck. Top-left keeps it clear of right-side unlock
    // toasts while still leaving the whole combat center untouched.
    const pauseBtn = mkBtn('kk-touch-pause', '⏸', 'Options',
      'left: 12px; top: 12px; width: 42px; height: 42px; font-size: 19px;');
    // Font-independent pause mark (headless/minimal Android fonts can render
    // the Unicode pause emoji as a tofu square).
    pauseBtn.textContent = '';
    pauseBtn.style.background = `
      linear-gradient(#ffd27f,#ffd27f) 39% 50% / 5px 18px no-repeat,
      linear-gradient(#ffd27f,#ffd27f) 61% 50% / 5px 18px no-repeat,
      radial-gradient(circle at 50% 35%, rgba(40,52,44,0.92), rgba(10,16,13,0.95))`;
    const press = (btn, fn) => {
      const onStart = (e) => { e.preventDefault(); e.stopPropagation(); fn(true);  btn.style.transform = 'scale(0.9)'; };
      const onEnd   = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } fn(false); btn.style.transform = ''; };
      btn.addEventListener('touchstart',  onStart, { passive: false });
      btn.addEventListener('touchend',    onEnd,   { passive: false });
      btn.addEventListener('touchcancel', onEnd,   { passive: false });
    };
    press(dashBtn,   (down) => { _touchDashHeld = down; });
    press(activeBtn, (down) => {
      if (_pipesGrappleContext()) _secondaryTouchHeld = down;
      else if (down) _activeCastQueued = true;
    });
    // Reuse the ESC handler (main.js) — opens Options in a run, closes whatever
    // is open. Options has its own close button, so the gear only needs to open.
    press(pauseBtn,  (down) => { if (down) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })); });
    _touchBtns = { dash: dashBtn, active: activeBtn, pause: pauseBtn };
    // Own rAF so visibility/cooldown dimming updates even while the game logic
    // is paused (modal open) — that's exactly when buttons must hide.
    const tick = () => { try { _updateTouchButtons(); } catch (_) {} requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}

export function sampleInput() {
  // Refresh gamepad snapshot once per frame BEFORE deriving moveVec.
  pollGamepad();

  let x = 0, y = 0;

  // Keyboard
  if (_keys['KeyW'] || _keys['ArrowUp'])    y -= 1;
  if (_keys['KeyS'] || _keys['ArrowDown'])  y += 1;
  if (_keys['KeyA'] || _keys['ArrowLeft'])  x -= 1;
  if (_keys['KeyD'] || _keys['ArrowRight']) x += 1;

  // Gamepad left stick overrides WASD when pad is connected and deflected.
  // The stick already has deadzone+rescale applied in gamepad.js.
  if (gamepadState.connected) {
    const lx = gamepadState.lx, ly = gamepadState.ly;
    if (Math.hypot(lx, ly) > 1e-3) {
      x = lx; y = ly;
    }
  }

  // Touch joystick overrides if active and has displacement
  if (_touch.active) {
    let dx = _touch.curX - _touch.originX;
    let dy = _touch.curY - _touch.originY;
    const mag = Math.hypot(dx, dy);
    if (mag > 1e-3) {
      const clamped = Math.min(mag, TOUCH_MAX_RADIUS);
      const nx = (dx / mag) * (clamped / TOUCH_MAX_RADIUS);
      const ny = (dy / mag) * (clamped / TOUCH_MAX_RADIUS);
      x = nx;
      y = ny;
    } else {
      x = 0; y = 0;
    }
  } else {
    // Normalize diagonals for keyboard
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag; y /= mag;
    }
  }

  // Final clamp to magnitude <= 1
  const m2 = Math.hypot(x, y);
  if (m2 > 1) { x /= m2; y /= m2; }

  state.input.moveVec.set(x, y);

  // ── Edge-triggered gamepad actions (consumed once by main.js / ui.js) ──
  // B = interact, X = pause, Y = level-up confirm. A is held-checked via
  // isDashPressed(). Start mirrors X for convenience (typical pause button).
  if (gamepadState.connected) {
    const jp = gamepadState.justPressed;
    if (jp.b) _padInteractQueued = true;
    if (jp.x || jp.start) _padPauseQueued = true;
    if (jp.y) _padLevelUpConfirmQueued = true;
    // Pipes: LT is the hold/release grapple. RB is the generic Active for all
    // heroes, giving gamepad parity with Q while RT remains primary fire.
    _secondaryPadHeld = _pipesGrappleContext() && gamepadState.buttons.lt >= 0.5;
    if (jp.rb) _activeCastQueued = true;
  } else {
    _secondaryPadHeld = false;
  }

  // ── Active device tracking ──
  // If kbm produced any event this frame, prefer kbm. Else if the pad shows any
  // activity (stick/button/trigger), flip to gamepad. Sticky between frames.
  if (_kbmActivityThisFrame) {
    input.activeDevice = 'kbm';
  } else if (gamepadHasActivity()) {
    input.activeDevice = 'gamepad';
  }
  _kbmActivityThisFrame = false;
}
