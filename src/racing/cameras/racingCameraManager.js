import * as THREE from 'three';
import {
  RacingCameraMode,
  RACING_CAMERA_LABELS,
  availableCameraModes,
  cycleCameraMode,
  normalizeCameraMode,
} from './cameraModes.js';
import { RacingCameraInput } from './cameraInput.js';
import { TrackVisionAnalyzer } from './trackVisionAnalyzer.js';
import { ChaseCameraCollision } from './chaseCameraCollision.js';
import { IsometricCameraRig } from './isometricCameraRig.js';
import { ChaseCameraRig } from './chaseCameraRig.js';
import { DriverFpvCameraRig } from './driverFpvCameraRig.js';
import { setOrthographicFrame, setPerspectiveFrame } from './cameraRigMath.js';

const PREFERENCE_KEY = 'kks_racing_camera_mode_v1';
const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.42;

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function readPreference() {
  try {
    return normalizeCameraMode(localStorage.getItem(PREFERENCE_KEY));
  } catch (_) {
    return RacingCameraMode.ISOMETRIC;
  }
}

function savePreference(mode) {
  try { localStorage.setItem(PREFERENCE_KEY, mode); } catch (_) {}
}

/** Lifecycle owner for all Kaki Rally camera rigs and transitions. */
export class RacingCameraManager {
  constructor({ host = {}, hudRoot = null, transitionDuration = 0.3 } = {}) {
    this.host = host || {};
    this.orthographicCamera = this.host.orthographicCamera || new THREE.OrthographicCamera(-16, 16, 9, -9, 0.1, 800);
    this.perspectiveCamera = new THREE.PerspectiveCamera(72, 16 / 9, 0.055, 800);
    this.perspectiveCamera.name = 'KakiRacingPerspectiveCamera';
    this.activeCamera = this.orthographicCamera;
    this.transitionDuration = Math.max(0, Number(transitionDuration) || 0.3);
    this.vehicleBinding = null;
    this.trackBinding = null;
    this.profile = null;
    this.mode = RacingCameraMode.ISOMETRIC;
    this.modes = [RacingCameraMode.ISOMETRIC];
    this.transition = null;
    this.forceSnap = true;
    this.disposed = false;
    this.paused = false;
    this.lastReducedMotion = false;
    this.lastFrame = null;
    this.lastEffects = { chromatic: 0.0008, bloom: 0.34 };
    this.lastVehiclePosition = new THREE.Vector3();
    this.hasVehiclePosition = false;
    this.lastPhase = '';
    this.zoom = 1;
    this.analyzer = new TrackVisionAnalyzer();
    this.collision = new ChaseCameraCollision();
    this.rigs = {
      [RacingCameraMode.ISOMETRIC]: new IsometricCameraRig(),
      [RacingCameraMode.CHASE]: new ChaseCameraRig(this.collision),
      [RacingCameraMode.DRIVER_FPV]: new DriverFpvCameraRig(),
    };
    this.input = new RacingCameraInput({ canvas: this.host.canvas, hudRoot });
    this.hudRoot = hudRoot;
    this.hiddenInterior = new Map();
    this._transitionPosition = new THREE.Vector3();
    this._transitionQuaternion = new THREE.Quaternion();
  }

  bindVehicle(vehicle) {
    this._restoreInteriorVisibility();
    this.vehicleBinding = vehicle || null;
    this.profile = vehicle?.profile || null;
    this.modes = availableCameraModes(this.profile);
    this.input.setAvailability(this.modes);
    this.hasVehiclePosition = false;
    this.collision.bind(this.trackBinding?.root, [vehicle?.visual?.root].filter(Boolean));
    this.onVehicleChanged();
    return this;
  }

  bindTrack(trackRuntime) {
    this.trackBinding = trackRuntime || {};
    this.analyzer.bindTrack(this.trackBinding);
    this.collision.bind(this.trackBinding.root, [this.vehicleBinding?.visual?.root].filter(Boolean));
    this.onTrackChanged();
    return this;
  }

  initialize(preferredMode = readPreference()) {
    const selected = this.modes.includes(preferredMode) ? preferredMode : (this.modes[0] || RacingCameraMode.ISOMETRIC);
    this.mode = selected;
    this.forceSnap = true;
    this._applyInteriorVisibility(selected === RacingCameraMode.DRIVER_FPV);
    this._updateHud();
    return this;
  }

  setCameraMode(mode, { instant = false, save = true } = {}) {
    const next = normalizeCameraMode(mode);
    if (!this.modes.includes(next)) return false;
    if (next === this.mode && !this.transition) return true;
    const previous = this.mode;
    this.mode = next;
    this.rigs[next].reset();
    this.input.closeList();
    if (save) savePreference(next);
    const shouldSnap = instant || this.lastReducedMotion || !this.lastFrame;
    if (next === RacingCameraMode.DRIVER_FPV) this._applyInteriorVisibility(true);
    // Monster-truck FPV hides the complete exterior root. Restore it before
    // calculating or rendering the destination frame: waiting for the blend
    // to finish can leave the truck invisible if that frame is delayed by a
    // busy arena, and makes ISO/chase look like a stalled mode switch.
    else this._restoreInteriorVisibility();
    if (shouldSnap) {
      this.transition = null;
      this.forceSnap = true;
    } else {
      const camera = this.activeCamera;
      this.transition = {
        fromMode: previous,
        toMode: next,
        elapsed: 0,
        duration: this.transitionDuration,
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        fov: camera.isPerspectiveCamera
          ? camera.fov
          : (this.lastFrame?.equivalentFov || 40),
        restoreInteriorAtEnd: previous === RacingCameraMode.DRIVER_FPV,
      };
      if (next !== RacingCameraMode.ISOMETRIC) {
        this.perspectiveCamera.position.copy(this.transition.position);
        this.perspectiveCamera.quaternion.copy(this.transition.quaternion);
        this.perspectiveCamera.fov = this.transition.fov;
        this.perspectiveCamera.updateProjectionMatrix();
        this._activate(this.perspectiveCamera);
      }
    }
    this._updateHud();
    return true;
  }

  cycleCamera(direction = 1) {
    return this.setCameraMode(cycleCameraMode(this.mode, direction, this.modes));
  }

  resetCamera({ instant = true } = {}) {
    Object.values(this.rigs).forEach((rig) => rig.reset());
    this.collision.reset();
    this.transition = null;
    this.forceSnap = instant;
    this.hasVehiclePosition = false;
  }

  onVehicleRespawned() {
    this.resetCamera({ instant: true });
  }

  onVehicleChanged() {
    this.resetCamera({ instant: true });
  }

  onTrackChanged() {
    this.analyzer.reset();
    this.resetCamera({ instant: true });
  }

  onRaceStarted() {
    this.rigs[RacingCameraMode.DRIVER_FPV].vision.manualIdle = 0;
  }

  onRaceFinished() {
    this.input.closeList();
  }

  setPaused(paused) {
    this.paused = !!paused;
    if (this.paused) this.input.closeList();
  }

  getCurrentMode() {
    return this.mode;
  }

  _vehicleState() {
    return this.vehicleBinding?.getCameraState?.() || null;
  }

  _activate(camera) {
    if (!camera) return;
    this.activeCamera = camera;
    try { this.host.setActiveCamera?.(camera); } catch (_) {}
  }

  _applyFrame(frame, aspect) {
    if (frame.projection === 'orthographic') {
      setOrthographicFrame(this.orthographicCamera, frame, aspect);
      this._activate(this.orthographicCamera);
    } else {
      setPerspectiveFrame(this.perspectiveCamera, frame, aspect);
      this._activate(this.perspectiveCamera);
    }
  }

  _applyTransition(frame, aspect, dt) {
    const transition = this.transition;
    transition.elapsed += Math.max(0, dt);
    const raw = transition.duration <= 0 ? 1 : transition.elapsed / transition.duration;
    const t = smoothstep(raw);
    this._transitionPosition.lerpVectors(transition.position, frame.position, t);
    this._transitionPosition.y += Math.sin(Math.PI * t) * (this.profile?.transitionLift || 1.15);
    this._transitionQuaternion.slerpQuaternions(transition.quaternion, frame.quaternion, t);
    const destinationFov = frame.equivalentFov || frame.fov || 72;
    this.perspectiveCamera.position.copy(this._transitionPosition);
    this.perspectiveCamera.quaternion.copy(this._transitionQuaternion);
    this.perspectiveCamera.fov = THREE.MathUtils.lerp(transition.fov, destinationFov, t);
    this.perspectiveCamera.aspect = Math.max(0.1, aspect || 16 / 9);
    this.perspectiveCamera.near = Math.min(0.1, frame.near ?? 0.08);
    this.perspectiveCamera.far = frame.far ?? 800;
    this.perspectiveCamera.updateProjectionMatrix();
    this._activate(this.perspectiveCamera);
    if (raw >= 1) {
      if (transition.restoreInteriorAtEnd) this._restoreInteriorVisibility();
      this.transition = null;
      this._applyFrame(frame, aspect);
    }
  }

  update(dt, { aspect = 16 / 9, reducedMotion = false, snap = false, paused = false } = {}) {
    if (this.disposed) return null;
    this.setPaused(paused);
    this.lastReducedMotion = !!reducedMotion;
    const vehicle = this._vehicleState();
    if (!vehicle || !this.profile) return null;
    const input = this.paused ? {
      cycle: 0, mode: null, recenter: false, lookBack: false,
      lookDelta: { x: 0, y: 0 }, lookStick: { x: 0, y: 0 }, zoomSteps: 0,
    } : this.input.sample();
    if (input.mode) this.setCameraMode(input.mode);
    else if (input.cycle) this.cycleCamera(input.cycle);
    if (input.zoomSteps) {
      this.zoom = THREE.MathUtils.clamp(this.zoom * Math.pow(1.1, input.zoomSteps), MIN_ZOOM, MAX_ZOOM);
    }

    if (this.hasVehiclePosition && vehicle.position.distanceToSquared(this.lastVehiclePosition) > 24 * 24) {
      this.onVehicleRespawned();
    }
    this.lastVehiclePosition.copy(vehicle.position);
    this.hasVehiclePosition = true;
    const phase = this.trackBinding?.session?.phase || '';
    if (phase !== this.lastPhase) {
      if (phase === 'racing') this.onRaceStarted();
      if (phase === 'finished') this.onRaceFinished();
      this.lastPhase = phase;
    }
    if (this.mode === RacingCameraMode.DRIVER_FPV) this._applyInteriorVisibility(true);
    const frame = this.rigs[this.mode].update(dt, {
      vehicle,
      profile: this.profile,
      input,
      analyzer: this.analyzer,
      session: this.trackBinding?.session,
      reducedMotion: this.lastReducedMotion,
      aspect,
    }, snap || this.forceSnap);
    if (frame.projection === 'orthographic') frame.frustum *= this.zoom;
    else {
      frame.fov = THREE.MathUtils.clamp((frame.fov || 72) * this.zoom, 38, 104);
      if (frame.equivalentFov) frame.equivalentFov = THREE.MathUtils.clamp(frame.equivalentFov * this.zoom, 38, 104);
    }
    this.forceSnap = false;
    if (this.transition && !this.lastReducedMotion) this._applyTransition(frame, aspect, dt);
    else {
      this.transition = null;
      this._applyFrame(frame, aspect);
    }
    this.lastFrame = frame;
    frame.effects.cameraMode = this.mode;
    this.lastEffects = frame.effects;
    return { camera: this.activeCamera, effects: this.lastEffects, frame, mode: this.mode };
  }

  resize(aspect) {
    if (!this.lastFrame) return;
    if (this.activeCamera.isPerspectiveCamera) {
      this.activeCamera.aspect = Math.max(0.1, Number(aspect) || 16 / 9);
      this.activeCamera.updateProjectionMatrix();
    } else {
      setOrthographicFrame(this.orthographicCamera, this.lastFrame, aspect);
    }
  }

  _applyInteriorVisibility(enabled) {
    const root = this.vehicleBinding?.visual?.root;
    const roles = this.profile?.fpvInteriorVisibility?.hideRoles || [];
    const names = this.profile?.fpvInteriorVisibility?.hideNames || [];
    if (!root?.traverse) return;
    if (!enabled) {
      this._restoreInteriorVisibility();
      return;
    }
    if (this.profile?.fpvInteriorVisibility?.hideVehicleExterior) {
      if (!this.hiddenInterior.has(root)) this.hiddenInterior.set(root, root.visible);
      root.visible = false;
      return;
    }
    root.traverse((object) => {
      if (!roles.includes(object.userData?.role) && !names.includes(object.name)) return;
      if (!this.hiddenInterior.has(object)) this.hiddenInterior.set(object, object.visible);
      object.visible = false;
    });
  }

  _restoreInteriorVisibility() {
    for (const [object, visible] of this.hiddenInterior) {
      if (object) object.visible = visible;
    }
    this.hiddenInterior.clear();
  }

  _updateHud() {
    if (!this.hudRoot) return;
    this.hudRoot.dataset.cameraMode = this.mode;
    const label = this.trackBinding?.mode === 'trials' && this.mode === RacingCameraMode.ISOMETRIC
      ? 'SIDE VIEW'
      : RACING_CAMERA_LABELS[this.mode] || this.mode;
    const strong = this.hudRoot.querySelector('.kkr-camera-cycle strong');
    if (strong) strong.textContent = label;
    const button = this.hudRoot.querySelector('.kkr-camera-cycle');
    if (button) button.setAttribute('aria-label', `Camera: ${label}. Activate to cycle; hold for camera list.`);
    this.hudRoot.querySelectorAll('[data-camera-mode]').forEach((entry) => {
      entry.classList.toggle('is-active', entry.dataset.cameraMode === this.mode);
    });
  }

  getSnapshot() {
    return {
      mode: this.mode,
      available: [...this.modes],
      transitioning: !!this.transition,
      transitionProgress: this.transition
        ? Math.min(1, this.transition.elapsed / Math.max(0.001, this.transition.duration))
        : 1,
      projection: this.activeCamera?.isPerspectiveCamera ? 'perspective' : 'orthographic',
      fov: this.activeCamera?.isPerspectiveCamera ? this.activeCamera.fov : this.lastFrame?.equivalentFov,
      visionStage: this.lastEffects?.visionStage || null,
      lookAheadMeters: this.lastEffects?.lookAheadMeters || null,
      collision: this.lastEffects?.collision || null,
      zoom: this.zoom,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._restoreInteriorVisibility();
    this.input.dispose();
    this.transition = null;
    this._activate(this.orthographicCamera);
  }
}
