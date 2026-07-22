/**
 * Gamepad: XInput-style support via the Web Gamepad API.
 *
 * Exports:
 *   - initGamepad()        wires connect/disconnect listeners. Call once at boot.
 *   - pollGamepad()        sample the active pad. Call once per frame BEFORE input.
 *   - gamepadState         live snapshot { lx, ly, rx, ry, buttons{...}, connected, name }
 *
 * Notes:
 *   - Sticks use radial deadzone meta.optControllerDeadzone (default 0.18) with
 *     smooth rescale; triggers use a fixed 0.05.
 *   - Buttons expose .pressed (held) and .justPressed (this frame edge).
 *   - Right stick aims (top-down: x→x, y→z). Left stick moves.
 *   - First connected pad wins. Disconnect falls back to the next available.
 */

import { getMeta } from './meta.js';

// Iter 10a: stick deadzone is now configurable via meta.optControllerDeadzone
// (0.0..0.30 surfaced in Options ▸ Controls). Trigger threshold stays hard-
// coded — players don't usually customise it and it's already permissive.
const STICK_DEAD_DEFAULT = 0.18;
const TRIGGER_DEAD = 0.05;

function _stickDead() {
  try {
    const v = Number(getMeta().optControllerDeadzone);
    if (Number.isFinite(v) && v >= 0 && v <= 0.5) return v;
  } catch (_) {}
  return STICK_DEAD_DEFAULT;
}

// Standard XInput button indices (Gamepad API "standard" mapping).
const BTN = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5,
  lt: 6, rt: 7,
  back: 8, start: 9,
  ls: 10, rs: 11,
  dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15,
};
const BUTTON_KEYS = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt',
  'start', 'back', 'ls', 'rs', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight',
];

function makeButtonState() {
  return {
    a: false, b: false, x: false, y: false,
    lb: false, rb: false,
    lt: 0, rt: 0,
    start: false, back: false, ls: false, rs: false,
    dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false,
  };
}

// Public live state. Consumers may read fields any time, but values are only
// guaranteed fresh immediately after pollGamepad().
export const gamepadState = {
  lx: 0, ly: 0,
  rx: 0, ry: 0,
  buttons: makeButtonState(),
  // Edge-trigger map: true only on the frame the button transitioned to pressed.
  justPressed: makeButtonState(),
  connected: false,
  name: '',
  index: -1,
};

// Previous-frame button bits, used to derive justPressed edges.
const _prev = makeButtonState();
const _cur = makeButtonState();
// [lx, ly, rx, ry], reused on every poll. Returning fresh two-element arrays
// from the deadzone helper created two garbage objects per connected frame.
const _stickOut = new Float64Array(4);
let _initialized = false;

/** Apply radial deadzone + smooth rescale so output starts at 0 just past the dead band. */
function _deadzoneStickInto(x, y, dead, offset) {
  const mag = Math.hypot(x, y);
  if (mag < dead) {
    _stickOut[offset] = 0;
    _stickOut[offset + 1] = 0;
    return;
  }
  // Rescale [dead..1] → [0..1] so motion past the deadzone is smooth.
  const scaled = (mag - dead) / (1 - dead);
  const clamped = Math.min(1, scaled);
  _stickOut[offset] = (x / mag) * clamped;
  _stickOut[offset + 1] = (y / mag) * clamped;
}

function _deadzoneTrigger(v) {
  if (v < TRIGGER_DEAD) return 0;
  return Math.min(1, (v - TRIGGER_DEAD) / (1 - TRIGGER_DEAD));
}

function _readDigital(buttons, idx) {
  return !!(buttons[idx] && buttons[idx].pressed);
}

function _readAnalog(buttons, idx) {
  const btn = buttons[idx];
  if (!btn) return 0;
  return typeof btn.value === 'number' ? btn.value : (btn.pressed ? 1 : 0);
}

function _pickActivePad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected) return p;
  }
  return null;
}

export function initGamepad() {
  if (_initialized) return;
  _initialized = true;
  if (typeof window === 'undefined') return;

  window.addEventListener('gamepadconnected', (e) => {
    const gp = e.gamepad;
    // Adopt only if we don't already have one wired up.
    if (!gamepadState.connected) {
      gamepadState.connected = true;
      gamepadState.name = gp.id || '';
      gamepadState.index = gp.index;
      console.log(`[gamepad] connected: ${gp.id} (index ${gp.index}, mapping=${gp.mapping})`);
    }
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad && e.gamepad.index === gamepadState.index) {
      gamepadState.connected = false;
      gamepadState.name = '';
      gamepadState.index = -1;
      gamepadState.lx = gamepadState.ly = gamepadState.rx = gamepadState.ry = 0;
      const b = gamepadState.buttons; const j = gamepadState.justPressed;
      for (const k in b) { b[k] = (typeof b[k] === 'number') ? 0 : false; }
      for (const k in j) { j[k] = (typeof j[k] === 'number') ? 0 : false; }
      console.log(`[gamepad] disconnected: ${e.gamepad.id}`);
    }
  });
}

export function pollGamepad() {
  // Clear justPressed edges every frame regardless of pad presence.
  const j = gamepadState.justPressed;
  for (let i = 0; i < BUTTON_KEYS.length; i++) {
    const k = BUTTON_KEYS[i];
    j[k] = (typeof j[k] === 'number') ? 0 : false;
  }

  const pad = _pickActivePad();
  if (!pad) {
    if (gamepadState.connected) {
      gamepadState.connected = false;
      gamepadState.name = '';
      gamepadState.index = -1;
    }
    return;
  }

  // (Re)latch identity if Chrome reports a pad without firing connect.
  if (!gamepadState.connected) {
    gamepadState.connected = true;
    gamepadState.name = pad.id || '';
    gamepadState.index = pad.index;
  }

  const axes = pad.axes || [];
  const dead = _stickDead();
  _deadzoneStickInto(axes[0] || 0, axes[1] || 0, dead, 0);
  _deadzoneStickInto(axes[2] || 0, axes[3] || 0, dead, 2);
  gamepadState.lx = _stickOut[0]; gamepadState.ly = _stickOut[1];
  gamepadState.rx = _stickOut[2]; gamepadState.ry = _stickOut[3];

  const buttons = pad.buttons || [];
  const b = gamepadState.buttons;

  // Sample into a persistent object; this path runs once per connected frame.
  _cur.a = _readDigital(buttons, BTN.a);
  _cur.b = _readDigital(buttons, BTN.b);
  _cur.x = _readDigital(buttons, BTN.x);
  _cur.y = _readDigital(buttons, BTN.y);
  _cur.lb = _readDigital(buttons, BTN.lb);
  _cur.rb = _readDigital(buttons, BTN.rb);
  _cur.lt = _deadzoneTrigger(_readAnalog(buttons, BTN.lt));
  _cur.rt = _deadzoneTrigger(_readAnalog(buttons, BTN.rt));
  _cur.start = _readDigital(buttons, BTN.start);
  _cur.back = _readDigital(buttons, BTN.back);
  _cur.ls = _readDigital(buttons, BTN.ls);
  _cur.rs = _readDigital(buttons, BTN.rs);
  _cur.dpadUp = _readDigital(buttons, BTN.dpadUp);
  _cur.dpadDown = _readDigital(buttons, BTN.dpadDown);
  _cur.dpadLeft = _readDigital(buttons, BTN.dpadLeft);
  _cur.dpadRight = _readDigital(buttons, BTN.dpadRight);

  // Derive edges, write into public state, snapshot for next frame.
  for (let i = 0; i < BUTTON_KEYS.length; i++) {
    const k = BUTTON_KEYS[i];
    const v = _cur[k];
    if (typeof v === 'number') {
      // Triggers: justPressed fires when crossing 0.5 from below.
      const wasOn = (_prev[k] || 0) >= 0.5;
      const isOn = v >= 0.5;
      j[k] = !wasOn && isOn ? 1 : 0;
      b[k] = v;
      _prev[k] = v;
    } else {
      j[k] = !_prev[k] && v;
      b[k] = v;
      _prev[k] = v;
    }
  }
}

/**
 * Returns true if any stick is meaningfully deflected or any button is held.
 * Used to detect "gamepad was the most recent input device this frame".
 */
export function gamepadHasActivity() {
  if (!gamepadState.connected) return false;
  if (Math.hypot(gamepadState.lx, gamepadState.ly) > 0.05) return true;
  if (Math.hypot(gamepadState.rx, gamepadState.ry) > 0.05) return true;
  const b = gamepadState.buttons;
  for (let i = 0; i < BUTTON_KEYS.length; i++) {
    const k = BUTTON_KEYS[i];
    const v = b[k];
    if (typeof v === 'number' ? v > 0.05 : v) return true;
  }
  return false;
}
