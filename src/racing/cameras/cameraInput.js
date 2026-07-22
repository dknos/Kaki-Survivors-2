import { gamepadState } from '../../gamepad.js';

export const RACING_CAMERA_ACTIONS = Object.freeze({
  cycleForward: Object.freeze({ touch: 'camera-button' }),
  recenter: Object.freeze({ keyboard: 'KeyV', controller: 'left-stick-click' }),
  lookBack: Object.freeze({ keyboard: 'KeyB', controller: 'left-bumper' }),
  freelook: Object.freeze({ mouse: 'right-drag', controller: 'right-stick', touch: 'right-side-drag' }),
  zoomIn: Object.freeze({ keyboard: 'Equal', mouse: 'wheel-up' }),
  zoomOut: Object.freeze({ keyboard: 'Minus', mouse: 'wheel-down' }),
});

function isTypingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}
/** Central action map for camera input; rigs never know physical keys/buttons. */
export class RacingCameraInput {
  constructor({ canvas = null, hudRoot = null } = {}) {
    this.canvas = canvas;
    this.hudRoot = hudRoot;
    this.cycleQueued = 0;
    this.modeQueued = null;
    this.recenterQueued = false;
    this.lookBackHeld = false;
    this.lookDelta = { x: 0, y: 0 };
    this.zoomSteps = 0;
    this.touchPointer = -1;
    this.touchLastX = 0;
    this.touchLastY = 0;
    this.longPressTimer = null;
    this.longPressOpened = false;
    this.button = hudRoot?.querySelector?.('.kkr-camera-cycle') || null;
    this.list = hudRoot?.querySelector?.('.kkr-camera-list') || null;
    this._listeners = [];
    this._bind();
  }

  _listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    this._listeners.push([target, type, handler, options]);
  }

  _bind() {
    if (typeof window !== 'undefined') {
      this._listen(window, 'keydown', (event) => {
        if (isTypingTarget(event.target)) return;
        if (event.code === 'KeyV' && !event.repeat) {
          this.recenterQueued = true;
        } else if (event.code === 'KeyB') {
          this.lookBackHeld = true;
        } else if ((event.code === 'Equal' || event.code === 'NumpadAdd') && !event.repeat) {
          this.zoomSteps -= 1;
          event.preventDefault();
        } else if ((event.code === 'Minus' || event.code === 'NumpadSubtract') && !event.repeat) {
          this.zoomSteps += 1;
          event.preventDefault();
        }
      });
      this._listen(window, 'keyup', (event) => {
        if (event.code === 'KeyB') this.lookBackHeld = false;
      });
      this._listen(window, 'blur', () => {
        this.lookBackHeld = false;
        this.touchPointer = -1;
        this.lookDelta.x = 0;
        this.lookDelta.y = 0;
      });
      this._listen(window, 'mousemove', (event) => {
        if ((event.buttons & 2) === 0 && document.pointerLockElement !== this.canvas) return;
        this.lookDelta.x += Number(event.movementX) || 0;
        this.lookDelta.y += Number(event.movementY) || 0;
      }, { passive: true });
    }

    if (this.canvas) {
      this._listen(this.canvas, 'pointerdown', (event) => {
        if (event.pointerType !== 'touch' || event.clientX < window.innerWidth * 0.5) return;
        this.touchPointer = event.pointerId;
        this.touchLastX = event.clientX;
        this.touchLastY = event.clientY;
        this.canvas.setPointerCapture?.(event.pointerId);
      }, { passive: true });
      this._listen(this.canvas, 'pointermove', (event) => {
        if (event.pointerId !== this.touchPointer) return;
        this.lookDelta.x += event.clientX - this.touchLastX;
        this.lookDelta.y += event.clientY - this.touchLastY;
        this.touchLastX = event.clientX;
        this.touchLastY = event.clientY;
      }, { passive: true });
      const releaseTouch = (event) => {
        if (event.pointerId === this.touchPointer) this.touchPointer = -1;
      };
      this._listen(this.canvas, 'pointerup', releaseTouch, { passive: true });
      this._listen(this.canvas, 'pointercancel', releaseTouch, { passive: true });
      this._listen(this.canvas, 'wheel', (event) => {
        this.zoomSteps += event.deltaY > 0 ? 1 : -1;
        this.zoomSteps = Math.max(-4, Math.min(4, this.zoomSteps));
        event.preventDefault();
      }, { passive: false });
    }

    if (this.button) {
      this._listen(this.button, 'pointerdown', () => {
        this.longPressOpened = false;
        clearTimeout(this.longPressTimer);
        this.longPressTimer = setTimeout(() => {
          this.longPressOpened = true;
          if (this.list) this.list.hidden = false;
        }, 520);
      });
      const release = () => clearTimeout(this.longPressTimer);
      this._listen(this.button, 'pointerup', release);
      this._listen(this.button, 'pointercancel', release);
      this._listen(this.button, 'click', (event) => {
        event.preventDefault();
        if (this.longPressOpened) {
          this.longPressOpened = false;
          return;
        }
        this.cycleQueued = 1;
      });
    }
    if (this.list) {
      this.list.querySelectorAll('[data-camera-mode]').forEach((button) => {
        this._listen(button, 'click', (event) => {
          event.preventDefault();
          this.modeQueued = button.dataset.cameraMode;
          this.list.hidden = true;
        });
      });
    }
  }

  setAvailability(modes) {
    if (!this.list) return;
    this.list.querySelectorAll('[data-camera-mode]').forEach((button) => {
      button.hidden = !modes.includes(button.dataset.cameraMode);
    });
  }

  closeList() {
    if (this.list) this.list.hidden = true;
  }

  sample() {
    if (gamepadState.justPressed?.ls) this.recenterQueued = true;
    const result = {
      cycle: this.cycleQueued,
      mode: this.modeQueued,
      recenter: this.recenterQueued,
      lookBack: this.lookBackHeld || !!gamepadState.buttons?.lb,
      lookDelta: { x: this.lookDelta.x, y: this.lookDelta.y },
      lookStick: {
        x: gamepadState.connected ? gamepadState.rx : 0,
        y: gamepadState.connected ? gamepadState.ry : 0,
      },
      zoomSteps: this.zoomSteps,
    };
    this.cycleQueued = 0;
    this.modeQueued = null;
    this.recenterQueued = false;
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    this.zoomSteps = 0;
    return result;
  }

  dispose() {
    clearTimeout(this.longPressTimer);
    for (const [target, type, handler, options] of this._listeners) {
      target.removeEventListener(type, handler, options);
    }
    this._listeners.length = 0;
  }
}
