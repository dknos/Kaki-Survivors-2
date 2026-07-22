import * as THREE from 'three';
import { queryMonsterArenaGround } from '../monsterArenaDefinition.js';
import { sampleTrialsGround } from '../trialsTracks.js';
import { RacingCameraManager } from './racingCameraManager.js';
import { RacingCameraProfile, cameraProfileForSession } from './racingCameraProfile.js';

function fittedCrashCameraProfile(session, baseProfile) {
  if (session.raceMode !== 'crash') return baseProfile;
  const root = session.player?.visual?.root;
  if (!root?.traverse) return baseProfile;
  let socket = null;
  root.traverse((object) => {
    if (!socket && object.name.startsWith('driver-eye-socket')) socket = object;
  });
  if (!socket) return baseProfile;
  root.updateMatrixWorld(true);
  const world = socket.getWorldPosition(new THREE.Vector3());
  const local = root.worldToLocal(world.clone());
  return new RacingCameraProfile({
    ...baseProfile,
    fpvEyePosition: { x: local.x, y: local.y, z: local.z },
    fpvSeatHeightRange: [local.y - 0.08, local.y + 0.08],
  });
}

function circuitVehicleBinding(session, profile) {
  const cameraState = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    pitchVelocity: 0,
    speed: 0,
    maxSpeed: 30,
    grounded: true,
    groundHeight: 0,
    nearestIndex: 0,
    lateralSpeed: 0,
    longitudinalWeightTransfer: 0,
    suspensionOffset: 0,
    impactStrength: 0,
    drifting: false,
    boosting: false,
    monster: session.raceMode === 'monster',
    trials: false,
    profileId: profile.id,
    rideHeight: 0,
  };
  const car = session.cars[0];
  return {
    profile,
    visual: car.visual,
    getCameraState() {
      const physics = car.physics;
      const offset = session.root.position;
      cameraState.position.set(offset.x + physics.x, offset.y + physics.y, offset.z + physics.z);
      cameraState.velocity.set(physics.vx || 0, physics.vy || 0, physics.vz || 0);
      cameraState.yaw = physics.yaw || 0;
      cameraState.pitch = car.visual?.bodyPivot?.rotation?.x || physics.bodyPitch || physics.stuntPitch || 0;
      cameraState.roll = car.visual?.bodyPivot?.rotation?.z || physics.bodyRoll || physics.stuntRoll || 0;
      cameraState.speed = Math.max(0, Number(physics.speed) || 0);
      cameraState.maxSpeed = session.raceMode === 'monster'
        ? (session.monsterVehicleProfile?.tuning?.boostSpeed || 31)
        : session.raceMode === 'crash'
          ? (session.player?.playerProfile?.maxSpeed || 34)
        : 31;
      cameraState.grounded = physics.grounded !== false;
      cameraState.groundHeight = offset.y + (Number(physics.groundHeight) || 0);
      cameraState.nearestIndex = Number(physics.nearestIndex) || 0;
      cameraState.lateralSpeed = Number(physics.lateralSpeed) || 0;
      cameraState.longitudinalWeightTransfer = Number(physics.longitudinalWeightTransfer) || 0;
      cameraState.suspensionOffset = Number(physics.suspensionOffset) || 0;
      cameraState.impactStrength = Number(physics.impactStrength) || 0;
      cameraState.drifting = !!physics.drifting;
      cameraState.boosting = (physics.boostTime || 0) > 0;
      return cameraState;
    },
  };
}
function trialsVehicleBinding(session, profile) {
  const cameraState = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    yaw: Math.PI / 2,
    pitch: 0,
    roll: 0,
    pitchVelocity: 0,
    speed: 0,
    maxSpeed: session.vehicle.turboMaxSpeed,
    grounded: true,
    groundHeight: 0,
    nearestIndex: 0,
    lateralSpeed: 0,
    longitudinalWeightTransfer: 0,
    suspensionOffset: 0,
    impactStrength: 0,
    drifting: false,
    boosting: false,
    monster: session.vehicle.id === 'monster',
    trials: true,
    profileId: profile.id,
    rideHeight: session.vehicle.rideHeight,
  };
  return {
    profile,
    visual: session.visual,
    getCameraState() {
      const physics = session.physics;
      const offset = session.root.position;
      cameraState.position.set(offset.x + physics.x, offset.y + physics.y, offset.z);
      cameraState.velocity.set(physics.vx || 0, physics.vy || 0, 0);
      cameraState.yaw = (physics.vx || 0) < -0.3 ? -Math.PI / 2 : Math.PI / 2;
      cameraState.pitch = Number(physics.pitch) || 0;
      cameraState.pitchVelocity = Number(physics.pitchVelocity) || 0;
      cameraState.speed = Math.abs(Number(physics.vx) || 0);
      cameraState.grounded = physics.grounded !== false;
      const ground = sampleTrialsGround(session.track, physics.x);
      cameraState.groundHeight = offset.y + (ground?.height || 0);
      cameraState.impactStrength = Math.min(1, Math.abs(Number(physics.landingImpact) || 0) / 30);
      cameraState.boosting = !!physics.turboActive;
      return cameraState;
    },
  };
}

function trackBinding(session) {
  const offset = session.root.position;
  if (session.raceMode === 'trials') {
    return {
      mode: 'trials',
      samples: [],
      root: session.root,
      session,
      worldOffset: offset,
      loop: false,
      groundHeightAt(x) {
        const sample = sampleTrialsGround(session.track, x - offset.x);
        return offset.y + (sample?.height || 0);
      },
    };
  }
  return {
    mode: session.raceMode,
    samples: session.samples,
    root: session.root,
    session,
    worldOffset: offset,
    loop: session.raceMode !== 'crash',
    trackWidth: session.course?.trackWidth || 10,
    groundHeightAt: session.raceMode === 'crash'
      ? () => offset.y
      : session.raceMode === 'monster'
      ? (x, z) => offset.y + (queryMonsterArenaGround(
          x - offset.x,
          z - offset.z,
          session.monsterArenaDefinition,
        )?.height || 0)
      : null,
  };
}

export function attachRacingCameraManager(session, host = {}) {
  const profile = fittedCrashCameraProfile(session, cameraProfileForSession(session));
  const manager = new RacingCameraManager({
    host,
    hudRoot: session.hud?.root || null,
    transitionDuration: Number(host.transitionDuration) || 0.3,
  });
  const vehicle = session.raceMode === 'trials'
    ? trialsVehicleBinding(session, profile)
    : circuitVehicleBinding(session, profile);
  manager.bindTrack(trackBinding(session));
  manager.bindVehicle(vehicle);
  manager.initialize(session.raceMode === 'crash' ? 'chase' : undefined);
  session.cameraHost = host;
  session.cameraManager = manager;
  return manager;
}
