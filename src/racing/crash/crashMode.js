import * as THREE from 'three';
import { state } from '../../state.js';
import { gamepadState } from '../../gamepad.js';
import { attachRacingCameraManager } from '../cameras/cameraSessionBinding.js';
import { mapRacingSteerInput } from '../racingSteering.js';
import {
  CRASH_DEFAULT_SEED,
  CRASH_FIXED_DT,
  CRASH_MAX_CATCHUP_STEPS,
  CRASH_MAX_RUN_SECONDS,
  CRASH_MODE_ORIGIN,
  CRASH_PHASES,
  CRASH_PLAYER_PROFILES,
  CRASH_POST_IMPACT_TAIL,
  crashQuality,
} from './crashConfig.js';
import {
  createCrashState,
  disposeCrashState,
  transitionCrashState,
  tickCrashState,
} from './crashState.js';
import { PAWPRINT_INTERCHANGE, signalStateAt } from './scenarios/pawprintInterchange.js';
import {
  buildCrashTrafficSchedule,
  sampleCrashLane,
  validateCrashScenario,
} from './crashLanes.js';
import {
  createCrashPhysicsRuntime,
  createCrashDynamicVehicle,
  crashPhysicsSnapshot,
  disposeCrashPhysics,
  removeCrashEntity,
  stepCrashPhysics,
} from './crashPhysics.js';
import {
  attachCrashPlayerProductionModel,
  buildCrashPlayerVisual,
  createCrashAssetLease,
} from './crashAssets.js';
import {
  buildCrashWorld,
  disposeCrashWorld,
  updateCrashSignalVisuals,
  updateCrashWorldAtmosphere,
} from './crashWorld.js';
import { createCrashColliderOverlay } from './crashColliderOverlay.js';
import { resetCrashDamagePresentation } from './crashDamagePresentation.js';
import {
  crashTrafficSnapshot,
  createCrashTraffic,
  disposeCrashTraffic,
  finishCrashTrafficStep,
  prepareCrashTrafficStep,
  stepCrashTrafficDynamics,
  syncCrashTrafficVisuals,
  updateCrashTrafficKinematics,
} from './crashTraffic.js';
import {
  bindCrashWheelVisuals,
  createCrashVehicleController,
  disposeCrashVehicleController,
  stepCrashVehicleController,
  syncCrashWheelVisuals,
} from './crashVehicleController.js';
import { createCrashDamageState } from './crashDamage.js';
import {
  awardCrashSpecial,
  crashChainShouldSettle,
  crashScoreSnapshot,
  createCrashScoreState,
  markCrashLaneBlocked,
} from './crashScoring.js';
import { canTriggerKakiBoom, triggerKakiBoom } from './crashKakiBoom.js';
import { detachBoomWeakenedPart, processCrashCollisionEvents } from './crashCollisionEvents.js';
import { syncCrashBreakables } from './crashBreakables.js';
import { CrashReplayRecorder } from './crashReplayRecorder.js';
import { CrashReplayPlayer } from './crashReplayPlayer.js';
import { CrashReplayCameraDirector } from './crashReplayCameras.js';
import {
  createCrashVfx,
  spawnCrashExplosion,
  spawnCrashImpact,
  spawnCrashSmoke,
  spawnKakiBoomVfx,
  updateCrashVfx,
} from './crashVfx.js';
import {
  createCrashAudio,
  disposeCrashAudio,
  playCrashContact,
  playCrashDetachedAudio,
  playCrashExplosionAudio,
  playCrashGlassAudio,
  playKakiBoomChargeAudio,
  playKakiBoomAudio,
  resetCrashReplayAudio,
  updateCrashAudio,
} from './crashAudio.js';
import {
  createCrashHud,
  disposeCrashHud,
  setCrashHudCallout,
  showCrashResults,
  updateCrashHud,
} from './crashHud.js';
import { readCrashRecord, writeCrashRecord } from './crashRecords.js';

const INTRO_SECONDS = 4.15;
const COUNTDOWN_SECONDS = 3.05;
const TEMP_POSITION = new THREE.Vector3();
const TEMP_QUATERNION = new THREE.Quaternion();
const TEMP_OFFSET = new THREE.Vector3();
const TEMP_EULER = new THREE.Euler();
let activeCrashSession = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function snapshotCrashPostFx(pass) {
  const uniforms = pass?.uniforms;
  if (!uniforms?.fogTint || !uniforms?.fogAmount) return null;
  return {
    fogTint: uniforms.fogTint.value.clone(),
    fogAmount: uniforms.fogAmount.value,
  };
}

function applyCrashPostFx(pass) {
  const uniforms = pass?.uniforms;
  if (!uniforms?.fogTint || !uniforms?.fogAmount) return;
  // The shared Survivors height fog deliberately lifts the lower screen.  A
  // mode-local blue-hour grade keeps wet asphalt black while authored fog,
  // steam, distant rain, scene fog, and lamp pools carry the atmosphere.
  uniforms.fogTint.value.set(0x0a1524);
  uniforms.fogAmount.value = 0.055;
}

function restoreCrashPostFx(pass, snapshot) {
  const uniforms = pass?.uniforms;
  if (!snapshot || !uniforms?.fogTint || !uniforms?.fogAmount) return;
  uniforms.fogTint.value.copy(snapshot.fogTint);
  uniforms.fogAmount.value = snapshot.fogAmount;
}

function qualityForOptions(options = {}) {
  const requested = options.crashQuality || options.quality;
  if (requested) return crashQuality(requested);
  const mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return crashQuality(mobile ? 'low' : 'high');
}

function crashCourse() {
  return {
    id: PAWPRINT_INTERCHANGE.id,
    name: PAWPRINT_INTERCHANGE.name,
    chapter: 'Kaki Municipal Test District',
    tagline: PAWPRINT_INTERCHANGE.subtitle,
    trackWidth: 28,
    accent: 0xffc44f,
  };
}

function cameraSamples(scenario) {
  const samples = [];
  for (const lane of scenario.lanes) {
    for (let index = 0; index < 24; index++) {
      const point = sampleCrashLane(lane, index / 23);
      samples.push({
        x: point.x,
        y: 0,
        z: point.z,
        tangent: new THREE.Vector3(Math.sin(point.yaw), 0, Math.cos(point.yaw)),
        normal: new THREE.Vector3(Math.cos(point.yaw), 0, -Math.sin(point.yaw)),
      });
    }
  }
  return samples;
}

function bodyTransform(entity) {
  const position = entity.body.translation();
  const rotation = entity.body.rotation();
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
  };
}

function restoreDamagePresentation(entity) {
  if (!entity?.visual) return;
  resetCrashDamagePresentation(entity);
  for (const part of entity.visual.parts?.values?.() || []) {
    if (!part) continue;
    part.visible = true;
    part.userData.damageDetached = false;
  }
}

function setPlayerPose(session, pose = session.scenario.playerSpawn, speed = 0) {
  const body = session.player?.body;
  if (!body) return;
  const half = (pose.yaw || 0) * 0.5;
  body.setTranslation({ x: pose.x, y: pose.y, z: pose.z }, true);
  body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
  body.setLinvel({ x: Math.sin(pose.yaw || 0) * speed, y: 0, z: Math.cos(pose.yaw || 0) * speed }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  session.player.previousTransform = bodyTransform(session.player);
  session.player.currentTransform = bodyTransform(session.player);
  session.player.damage = createCrashDamageState();
  session.player.detachedMask = 0;
  session.player.drivingAssistSuppressed = false;
  session.player.drivingAssistBlend = 1;
  restoreDamagePresentation(session.player);
  session.cameraManager?.onVehicleRespawned?.();
}

function transition(session, phase, reason = '') {
  const changed = transitionCrashState(session.crashState, phase, session.liveTime, reason);
  if (!changed) return false;
  if ([CRASH_PHASES.APPROACH, CRASH_PHASES.LIVE_CRASH, CRASH_PHASES.SETTLING].includes(phase)) session.phase = 'racing';
  else if ([CRASH_PHASES.REPLAY, CRASH_PHASES.RESULTS].includes(phase)) session.phase = 'finished';
  else session.phase = phase.toLowerCase();
  if (phase === CRASH_PHASES.COUNTDOWN) {
    session.countdown = COUNTDOWN_SECONDS;
    setPlayerPose(session);
  } else if (phase === CRASH_PHASES.APPROACH) {
    session.liveTime = 0;
    session.score = createCrashScoreState(0);
    session.scoreSnapshot = crashScoreSnapshot(session.score, 0);
    session.replayRecorder.reset();
    session.knownPromotions.clear();
    session.player.body.wakeUp();
    setCrashHudCallout(session.hud, 'GO · BREAK THE FLOW');
  } else if (phase === CRASH_PHASES.SETTLING) {
    session.settlingQuiet = 0;
  }
  return true;
}

function createPlayer(session, hero) {
  const base = CRASH_PLAYER_PROFILES[session.vehicleId] || CRASH_PLAYER_PROFILES.muscle;
  const profile = { ...base };
  const visual = buildCrashPlayerVisual({
    profile,
    hero,
    owned: session.owned,
    decalTexture: session.assetLease.textures.decalAtlas,
  });
  visual.root.name = 'kaki-catastrophe-player';
  session.root.add(visual.root);
  const entity = {
    id: 'player',
    classId: 'player',
    kind: 'player',
    active: true,
    dynamic: true,
    visual,
    playerProfile: profile,
    profile,
    damage: createCrashDamageState(),
    detachedMask: 0,
  };
  createCrashDynamicVehicle(session.physics, entity, profile, session.scenario.playerSpawn, { group: 1, ccd: true });
  entity.playerProfile = profile;
  createCrashVehicleController(session.physics, entity, profile);
  const authoredFleet = session.assetLease.models.crashVehicleKitV2;
  if (!authoredFleet || !attachCrashPlayerProductionModel(visual, authoredFleet, profile, session.owned)) {
    throw new Error(`Missing authored Catastrophe player vehicle: ${profile.id}`);
  }
  bindCrashWheelVisuals(entity);
  if (entity.wheelVisualBindings.some((wheel) => !wheel)) {
    throw new Error(`Authored Catastrophe player ${profile.id} is missing an ordered wheel socket`);
  }
  entity.previousTransform = bodyTransform(entity);
  entity.currentTransform = bodyTransform(entity);
  return entity;
}

function createIntroCamera(session) {
  const camera = new THREE.PerspectiveCamera(53, session.cameraHost?.getAspect?.() || 16 / 9, 0.1, 900);
  camera.name = 'KakiCatastropheIntroCamera';
  return camera;
}

function updateIntroCamera(session) {
  const camera = session.introCamera;
  const aspect = session.cameraHost?.getAspect?.() || camera.aspect || 16 / 9;
  const raw = clamp(session.crashState.elapsed / INTRO_SECONDS, 0, 1);
  const eased = raw * raw * (3 - 2 * raw);
  const center = TEMP_POSITION.set(session.root.position.x, session.root.position.y + 1.2, session.root.position.z);
  if (session.reduceMotion) {
    camera.position.set(center.x + 39, center.y + 35, center.z - 42);
  } else {
    const angle = -2.25 + eased * 2.9;
    const radius = 91 - eased * 37;
    camera.position.set(center.x + Math.sin(angle) * radius, center.y + 35 - eased * 18, center.z + Math.cos(angle) * radius);
  }
  const targetZ = raw > 0.68 ? -17 : 0;
  camera.lookAt(center.x - 1.5, center.y + 1.1, center.z + targetZ);
  camera.aspect = Math.max(0.1, aspect);
  camera.fov = 53 - eased * 5;
  camera.updateProjectionMatrix();
  return {
    camera,
    mode: 'intro',
    effects: { chromatic: 0.00045, bloom: session.reducedFlashing ? 0.27 : 0.35 },
    frame: { projection: 'perspective', position: camera.position, fov: camera.fov },
  };
}

function replayEntityList(session) {
  return [
    session.player,
    ...session.traffic.entities,
    ...session.worldView.breakables,
    ...session.worldView.debrisProps,
    ...session.debrisEntities,
  ].filter((entity) => entity?.visual?.root);
}

function refreshEntityIndex(session) {
  for (const entity of replayEntityList(session)) {
    if (!session.entityById.has(entity.id)) session.entityById.set(entity.id, entity);
    if (entity.dynamic && !session.knownPromotions.has(entity.id) && entity !== session.player && !entity.parked && entity.kind === 'traffic') {
      session.knownPromotions.add(entity.id);
      session.replayRecorder.recordEvent({
        type: 'vehicle-promoted',
        time: session.liveTime,
        subjectId: entity.id,
        reason: entity.promotionReason || 'active-radius',
      });
    }
  }
}

function replaySample(entity) {
  const root = entity.visual?.root;
  const body = entity.body;
  if (!root || !body) return null;
  const velocity = body.linvel();
  const angular = body.angvel();
  return {
    id: entity.id,
    position: root.position,
    quaternion: root.quaternion,
    linearVelocity: velocity,
    angularVelocity: angular,
    active: entity.active !== false && root.visible !== false,
    damage: entity.damage?.severity || 0,
    damageZones: entity.damage?.zones || null,
    glass: entity.damage?.glass || 'intact',
    detachedMask: entity.detachedMask || 0,
    wheelState: entity.wheelVisualBindings?.map((wheel) => wheel ? {
      visible: wheel.visible !== false,
      position: wheel.position,
      quaternion: wheel.quaternion,
    } : null) || null,
  };
}

function recordFrame(session) {
  refreshEntityIndex(session);
  session.replayRecorder.record(
    session.liveTime,
    replayEntityList(session).map(replaySample).filter(Boolean),
    { ...session.controls, boom: session.boomTriggeredFrame },
  );
  session.boomTriggeredFrame = false;
}

function syncDetachedDebrisVisuals(session) {
  for (const entity of session.debrisEntities) {
    const root = entity.visual?.root;
    const body = entity.body;
    if (!root || !body || entity.removed) continue;
    const position = body.translation();
    const rotation = body.rotation();
    root.position.set(position.x, position.y, position.z);
    root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    root.visible = entity.active !== false;
  }
}

function syncPlayerVisual(session, alpha = 1) {
  const entity = session.player;
  if (!entity?.body) return;
  const previous = entity.previousTransform || bodyTransform(entity);
  const current = entity.currentTransform || previous;
  TEMP_POSITION.set(previous.position.x, previous.position.y, previous.position.z).lerp(
    new THREE.Vector3(current.position.x, current.position.y, current.position.z),
    clamp(alpha, 0, 1),
  );
  TEMP_QUATERNION.set(previous.rotation.x, previous.rotation.y, previous.rotation.z, previous.rotation.w).slerp(
    new THREE.Quaternion(current.rotation.x, current.rotation.y, current.rotation.z, current.rotation.w),
    clamp(alpha, 0, 1),
  );
  TEMP_OFFSET.set(0, -(entity.playerProfile.visualOffsetY || entity.playerProfile.height * 0.56), 0).applyQuaternion(TEMP_QUATERNION);
  entity.visual.root.position.copy(TEMP_POSITION).add(TEMP_OFFSET);
  entity.visual.root.quaternion.copy(TEMP_QUATERNION);
  syncCrashWheelVisuals(entity);
  const velocity = entity.body.linvel();
  const rotation = entity.body.rotation();
  TEMP_EULER.setFromQuaternion(TEMP_QUATERNION, 'YXZ');
  const mirror = session.playerPhysics;
  mirror.x = entity.visual.root.position.x;
  mirror.y = entity.visual.root.position.y;
  mirror.z = entity.visual.root.position.z;
  mirror.vx = velocity.x;
  mirror.vy = velocity.y;
  mirror.vz = velocity.z;
  mirror.yaw = Math.atan2(2 * (rotation.w * rotation.y + rotation.x * rotation.z), 1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z));
  mirror.bodyPitch = TEMP_EULER.x;
  mirror.bodyRoll = TEMP_EULER.z;
  mirror.speed = Math.hypot(velocity.x, velocity.z);
  mirror.grounded = entity.cameraState?.grounded !== false;
  mirror.groundedWheelCount = entity.cameraState?.groundedWheels || 0;
  mirror.groundHeight = 0;
  mirror.lateralSpeed = velocity.x * Math.cos(mirror.yaw) - velocity.z * Math.sin(mirror.yaw);
  mirror.impactStrength = Math.max(0, (mirror.impactStrength || 0) * 0.86);
  session.playerSpeed = mirror.speed;
  state.hero?.pos?.set?.(session.root.position.x + mirror.x, session.root.position.y + mirror.y, session.root.position.z + mirror.z);
}

function controlsForSession(session) {
  const move = state.input?.moveVec || { x: 0, y: 0 };
  const touch = session.hud?.touch || {};
  const analogThrottle = gamepadState.connected ? (Number(gamepadState.buttons?.rt) || 0) - (Number(gamepadState.buttons?.lt) || 0) : 0;
  const keyboardThrottle = -Number(move.y || 0);
  const throttle = Math.abs(analogThrottle) > Math.abs(keyboardThrottle) ? analogThrottle : keyboardThrottle;
  const steer = mapRacingSteerInput(move.x, {
    touchLeft: !!touch.left,
    touchRight: !!touch.right,
  });
  const active = [CRASH_PHASES.APPROACH, CRASH_PHASES.LIVE_CRASH].includes(session.crashState.phase);
  return {
    throttle: active ? clamp(throttle + (touch.gas ? 1 : 0) - (touch.brake ? 1 : 0), -1, 1) : 0,
    steer: active ? clamp(steer, -1, 1) : 0,
    brake: !active || !!touch.brake,
    handbrake: active && (session.handbrakeHeld || !!gamepadState.buttons?.a),
  };
}

function signalVisuals(session) {
  const northSouth = signalStateAt(session.trafficClock, 'NS', session.scenario);
  const eastWest = signalStateAt(session.trafficClock, 'EW', session.scenario);
  updateCrashSignalVisuals(session.worldView, [northSouth, northSouth, eastWest, eastWest]);
}

function calloutForEntity(entity) {
  if (entity?.classId === 'bus') return 'BUS INVOLVED';
  if (entity?.classId === 'tanker') return 'TANKER CRITICAL';
  if (entity?.classId === 'semi' || entity?.classId === 'trailer') return 'ARTICULATED FREIGHT';
  return '';
}

function onQualifyingImpact(session, event, a, b) {
  session.settlingQuiet = 0;
  if (session.crashState.phase === CRASH_PHASES.APPROACH) transition(session, CRASH_PHASES.LIVE_CRASH, 'initial-impact');
  const strength = clamp(event.impulse / 9000, 0.25, 1.8);
  spawnCrashImpact(session.vfx, event, strength);
  playCrashContact(session.audio, { ...event, aClass: a.classId, bClass: b.classId }, session.liveTime);
  session.playerPhysics.impactStrength = Math.max(session.playerPhysics.impactStrength || 0, clamp(strength / 1.4, 0, 1));
  if (a === session.player || b === session.player) session.player.drivingAssistSuppressed = true;
  if (!session.reduceMotion && strength > 1.15) session.hitStop = Math.max(session.hitStop, 0.024);
  const special = calloutForEntity(a) || calloutForEntity(b);
  const snapshot = crashScoreSnapshot(session.score, session.liveTime);
  setCrashHudCallout(session.hud, special || `CHAIN ${snapshot.chain}`, special.includes('CRITICAL') ? 'danger' : '');
  if (session.score.boomUsed && !session.boomContinuationAwarded) {
    session.boomContinuationAwarded = true;
    awardCrashSpecial(session.score, 'boom-continuation', 1800, session.liveTime, { subjectId: event.subjectId });
    session.replayRecorder.recordEvent({ type: 'boom-continuation', time: session.liveTime, subjectId: event.subjectId, point: event.point, value: 1800 });
  }
}

function volatileExplosion(session, entity, contact) {
  if (!entity?.body || entity.exploded) return;
  entity.exploded = true;
  const center = entity.body.translation();
  const point = { x: center.x, y: center.y, z: center.z };
  session.replayRecorder.recordEvent({ type: 'explosion', time: session.liveTime, subjectId: entity.id, point, value: 9000 });
  awardCrashSpecial(session.score, 'energy-burst', 5200, session.liveTime, { subjectId: entity.id });
  spawnCrashExplosion(session.vfx, point, session.reducedFlashing ? 0.72 : 1.15);
  playCrashExplosionAudio();
  for (const target of session.physics.dynamicEntities) {
    if (!target.body || target === entity) continue;
    const position = target.body.translation();
    const dx = position.x - center.x;
    const dz = position.z - center.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 15 || distance < 0.05) continue;
    const mass = Math.max(1, target.body.mass());
    const falloff = Math.pow(1 - distance / 15, 1.6);
    const deltaV = Math.min(mass > 7000 ? 2.8 : 4.7, 5.2 * falloff);
    target.body.applyImpulse({ x: dx / distance * mass * deltaV, y: mass * Math.min(2.2, deltaV * 0.4), z: dz / distance * mass * deltaV }, true);
    target.body.wakeUp();
    target.crashed = true;
  }
  session.settlingQuiet = 0;
  setCrashHudCallout(session.hud, 'ENERGY TANKER BURST', 'danger');
}

function onBreakable(session, entity) {
  if (entity.kind === 'breakable-structure') {
    awardCrashSpecial(session.score, 'structure', 0, session.liveTime, { subjectId: entity.id });
    setCrashHudCallout(session.hud, 'CANOPY COLLAPSE');
  } else {
    awardCrashSpecial(session.score, `break-${entity.id}`, 420, session.liveTime, { subjectId: entity.id });
  }
}

function detectCrashSpecials(session) {
  for (const entity of session.traffic.entities) {
    if (!entity.dynamic || !entity.body || !entity.crashed) continue;
    const position = entity.body.translation();
    const rotation = entity.body.rotation();
    const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
    if (upY < 0.32 && !entity.rolloverAwarded) {
      entity.rolloverAwarded = true;
      awardCrashSpecial(session.score, 'rollover', 0, session.liveTime, { subjectId: entity.id });
      session.replayRecorder.recordEvent({ type: 'rollover', time: session.liveTime, subjectId: entity.id, point: { ...position } });
      setCrashHudCallout(session.hud, 'ROLLOVER');
    }
    if (position.y > (entity.profile?.height || 1.5) * 1.38 && !entity.airborneAwarded) {
      entity.airborneAwarded = true;
      awardCrashSpecial(session.score, 'airborne', 0, session.liveTime, { subjectId: entity.id });
      session.replayRecorder.recordEvent({ type: 'airborne', time: session.liveTime, subjectId: entity.id, point: { ...position } });
    }
    if (entity.trailer?.body && !entity.jackknifeAwarded) {
      const a = entity.body.rotation();
      const b = entity.trailer.body.rotation();
      const yawA = Math.atan2(2 * (a.w * a.y + a.x * a.z), 1 - 2 * (a.y * a.y + a.z * a.z));
      const yawB = Math.atan2(2 * (b.w * b.y + b.x * b.z), 1 - 2 * (b.y * b.y + b.z * b.z));
      const difference = Math.abs(Math.atan2(Math.sin(yawA - yawB), Math.cos(yawA - yawB)));
      if (difference > 0.64) {
        entity.jackknifeAwarded = true;
        awardCrashSpecial(session.score, 'jackknife', 0, session.liveTime, { subjectId: entity.id });
        session.replayRecorder.recordEvent({ type: 'jackknife', time: session.liveTime, subjectId: entity.id, point: { ...position } });
        setCrashHudCallout(session.hud, 'JACKKNIFE');
      }
    }
    if (Math.hypot(position.x, position.z) < 23) {
      for (const lane of session.scenario.lanes) {
        const crossing = sampleCrashLane(lane, 0.5);
        if (Math.hypot(position.x - crossing.x, position.z - crossing.z) < 7.2) markCrashLaneBlocked(session.score, lane.id, session.liveTime);
      }
    }
  }
}

function triggerBoom(session) {
  if (!canTriggerKakiBoom(session.score)) return false;
  const origin = session.player.body.translation();
  const result = triggerKakiBoom({
    scoreState: session.score,
    entities: [...session.physics.dynamicEntities],
    origin: { x: origin.x, y: origin.y, z: origin.z },
    recorder: session.replayRecorder,
    time: session.liveTime,
    onTarget(entity) {
      if (entity.damage?.severity > 0.5) entity.damage.smoke = Math.max(entity.damage.smoke, 0.48);
      detachBoomWeakenedPart(session, entity, origin, session.liveTime);
    },
  });
  if (!result.triggered) return false;
  session.boomTriggeredFrame = true;
  session.settlingQuiet = 0;
  spawnKakiBoomVfx(session.vfx, origin);
  playKakiBoomAudio();
  setCrashHudCallout(session.hud, `KAKI BOOM · ${result.affected.length} WRECKS`, 'danger');
  return true;
}

function armBoom(session) {
  if (!canTriggerKakiBoom(session.score) || session.boomAnticipation > 0) return false;
  session.boomAnticipation = session.reduceMotion ? 0.08 : 0.16;
  playKakiBoomChargeAudio();
  setCrashHudCallout(session.hud, 'KAKI BOOM · HOLD TIGHT', 'danger');
  return true;
}

function fixedStep(session, dt) {
  const phase = session.crashState.phase;
  if ([CRASH_PHASES.REPLAY, CRASH_PHASES.RESULTS, CRASH_PHASES.DISPOSED, CRASH_PHASES.LOADING].includes(phase)) return;
  session.trafficClock += dt;
  const playerPosition = session.player.body.translation();
  const playerVelocity = session.player.body.linvel();
  updateCrashTrafficKinematics(session.traffic, session.trafficClock, {
    position: playerPosition,
    velocity: playerVelocity,
  }, dt);
  refreshEntityIndex(session);
  prepareCrashTrafficStep(session.traffic);
  session.player.previousTransform = session.player.currentTransform || bodyTransform(session.player);
  stepCrashTrafficDynamics(session.traffic, dt, session.trafficClock);
  if ([CRASH_PHASES.INTRO, CRASH_PHASES.COUNTDOWN].includes(phase)) {
    const spawn = session.scenario.playerSpawn;
    session.player.body.setLinvel({ x: 0, y: session.player.body.linvel().y, z: 0 }, true);
    session.player.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (Math.hypot(playerPosition.x - spawn.x, playerPosition.z - spawn.z) > 0.6) setPlayerPose(session);
  }
  stepCrashVehicleController(session.physics, session.player, session.controls, dt);
  const physicsEvents = stepCrashPhysics(session.physics);
  session.player.currentTransform = bodyTransform(session.player);
  finishCrashTrafficStep(session.traffic);
  syncCrashTrafficVisuals(session.traffic, 1);
  syncPlayerVisual(session, 1);
  syncDetachedDebrisVisuals(session);
  syncCrashBreakables(session.worldView);
  if ([CRASH_PHASES.APPROACH, CRASH_PHASES.LIVE_CRASH, CRASH_PHASES.SETTLING].includes(phase)) {
    session.liveTime += dt;
    processCrashCollisionEvents(session, physicsEvents, session.liveTime);
    session.specialClock += dt;
    if (session.specialClock >= 0.22) {
      session.specialClock = 0;
      detectCrashSpecials(session);
    }
    for (const debris of session.debrisEntities) {
      if (debris.removed || session.liveTime - debris.detachedAt < 7.5) continue;
      debris.active = false;
      if (debris.visual?.root) debris.visual.root.visible = false;
      removeCrashEntity(session.physics, debris);
    }
    recordFrame(session);
  }
  session.colliderOverlay?.update(physicsEvents.contacts);
}

function startReplay(session) {
  if (session.crashState.phase !== CRASH_PHASES.SETTLING) return false;
  recordFrame(session);
  session.replayHidden.length = 0;
  for (const entity of session.traffic.entities) {
    if (entity.dynamic || !entity.visual?.root?.visible) continue;
    session.replayHidden.push(entity);
    entity.visual.root.visible = false;
  }
  const started = session.replayPlayer.start();
  resetCrashReplayAudio(session.audio);
  session.replayCamera.reset();
  transition(session, CRASH_PHASES.REPLAY, 'recorded-tail-complete');
  session.replaySnapshot = session.replayPlayer.snapshot();
  setCrashHudCallout(session.hud, 'DIRECTOR CUT · LARGEST IMPACT');
  return started;
}

function finishResults(session) {
  if (session.crashState.phase !== CRASH_PHASES.REPLAY) return;
  transition(session, CRASH_PHASES.RESULTS, 'replay-complete');
  const score = crashScoreSnapshot(session.score, session.liveTime);
  const stored = writeCrashRecord({
    ...score,
    vehicleId: session.vehicleId,
    junctionId: session.scenario.id,
    largestImpact: score.largestImpact?.value || 0,
    at: Date.now(),
  });
  session.record = stored.record;
  session.result = {
    ...score,
    ...stored,
    highlightTime: session.replayPlayer.highlight?.time || 0,
  };
  showCrashResults(session, session.result);
}

function replayEvent(session, event) {
  if (event.type === 'explosion') {
    spawnCrashExplosion(session.vfx, event.point, 1.05);
    playCrashExplosionAudio();
  } else if (event.type === 'kakiBoom') {
    spawnKakiBoomVfx(session.vfx, event.point);
    playKakiBoomAudio();
  } else if (event.type === 'impact') {
    spawnCrashImpact(session.vfx, event, clamp(event.impulse / 9000, 0.3, 1.6));
    playCrashContact(session.audio, event, event.time);
  } else if (event.type === 'damage' && event.glassChanged) playCrashGlassAudio(session.audio, event.time);
  else if (event.type === 'part-detached') playCrashDetachedAudio(session.audio, event.time);
  else if (event.point) spawnCrashImpact(session.vfx, event, 0.72);
}

function replayAgain(session) {
  if (session.crashState.phase !== CRASH_PHASES.RESULTS || !session.replayPlayer.replayAgain()) return false;
  transition(session, CRASH_PHASES.REPLAY, 'replay-again');
  session.replayCamera.reset();
  resetCrashReplayAudio(session.audio);
  return true;
}

function installInput(session) {
  if (typeof window === 'undefined') return;
  session.keyDown = (event) => {
    if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (event.code === 'Space') session.handbrakeHeld = true;
    if ((event.code === 'KeyX' || event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !event.repeat) session.boomQueued = true;
    if (event.code === 'Enter' && session.crashState.phase === CRASH_PHASES.REPLAY && !event.repeat) session.skipReplayQueued = true;
    if (event.code === 'KeyR' && session.crashState.phase === CRASH_PHASES.RESULTS && !event.repeat) restartCrashMode();
  };
  session.keyUp = (event) => { if (event.code === 'Space') session.handbrakeHeld = false; };
  window.addEventListener('keydown', session.keyDown);
  window.addEventListener('keyup', session.keyUp);
}

function mountQa(session) {
  if (typeof window === 'undefined') return;
  const qa = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('qa') : '';
  const actions = {
    skipIntro() {
      if (session.crashState.phase === CRASH_PHASES.INTRO) transition(session, CRASH_PHASES.COUNTDOWN, 'qa-skip-intro');
      if (session.crashState.phase === CRASH_PHASES.COUNTDOWN) session.countdown = 0.01;
      return true;
    },
    driveFixedSteps(steps = 1, controls = {}) {
      if (![CRASH_PHASES.APPROACH, CRASH_PHASES.LIVE_CRASH, CRASH_PHASES.SETTLING].includes(session.crashState.phase)) return false;
      const count = Math.max(1, Math.min(1800, Math.floor(Number(steps) || 1)));
      session.controls = {
        throttle: clamp(controls.throttle ?? 1, -1, 1),
        steer: clamp(controls.steer, -1, 1),
        brake: !!controls.brake,
        handbrake: !!controls.handbrake,
      };
      for (let index = 0; index < count; index++) {
        fixedStep(session, CRASH_FIXED_DT);
        if ([CRASH_PHASES.APPROACH, CRASH_PHASES.LIVE_CRASH].includes(session.crashState.phase)
          && (session.liveTime >= CRASH_MAX_RUN_SECONDS || crashChainShouldSettle(session.score, session.liveTime))) {
          transition(session, CRASH_PHASES.SETTLING, session.liveTime >= CRASH_MAX_RUN_SECONDS ? 'qa-maximum-duration' : 'qa-impact-quiet');
        }
        if (session.crashState.phase === CRASH_PHASES.SETTLING) {
          session.settlingQuiet += CRASH_FIXED_DT;
          if (session.settlingQuiet >= CRASH_POST_IMPACT_TAIL) {
            startReplay(session);
            break;
          }
        }
      }
      return true;
    },
    setPaused(paused = true) { session.qaPaused = !!paused; return session.qaPaused; },
    seekReplayShot(family = 'overhead') {
      if (session.crashState.phase !== CRASH_PHASES.REPLAY) return false;
      const shot = session.replayPlayer.plan.find((entry) => entry.family === family);
      if (!shot) return false;
      const inset = Math.min(0.08, Math.max(0.01, (shot.end - shot.start) * 0.25));
      return session.replayPlayer.seek(shot.start + inset);
    },
    toggleColliders() { return session.colliderOverlay?.setEnabled(!session.colliderOverlay.enabled) || false; },
    restart: () => restartCrashMode(),
    snapshot: () => getCrashSnapshot(),
  };
  window.__kkCrash = actions;
  window.__kkRacing = {
    ...actions,
    setCameraMode: (mode) => session.cameraManager?.setCameraMode(mode, { instant: true }) || false,
    cycleCamera: (direction = 1) => session.cameraManager?.cycleCamera(direction) || false,
  };
  if (qa !== 'crash') return;
  session.qaSkipIntro = true;
  const bridge = document.createElement('div');
  bridge.dataset.crashQaBridge = 'true';
  bridge.style.cssText = 'position:fixed;left:12px;bottom:10px;z-index:2147483647;width:292px;padding:8px;border:1px solid rgba(91,213,226,.55);background:rgba(6,14,18,.88);color:#dffcff;font:9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em;pointer-events:auto';
  const title = document.createElement('div');
  title.textContent = 'CRASH QA · LIVE RUNTIME';
  title.style.cssText = 'color:#ffca55;font-weight:800;letter-spacing:.14em;margin-bottom:5px';
  const metrics = document.createElement('div');
  metrics.dataset.crashQaMetrics = 'true';
  metrics.style.cssText = 'white-space:pre;margin-bottom:6px;color:#8debf5';
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px';
  bridge.append(title, metrics, controls);
  for (const [label, action] of [
    ['INTRO', actions.skipIntro],
    ['PAUSE', () => actions.setPaused(!session.qaPaused)],
    ['COLLIDERS', actions.toggleColliders],
    ['RETRY', actions.restart],
  ]) {
    const item = document.createElement('button');
    item.type = 'button'; item.dataset.qaAction = label.toLowerCase(); item.setAttribute('aria-label', `QA ${label}`); item.textContent = label;
    item.style.cssText = 'border:1px solid rgba(255,202,85,.46);background:#182126;color:#f6e6bb;padding:3px 5px;font:inherit;cursor:pointer';
    item.addEventListener('click', () => action());
    controls.appendChild(item);
  }
  session.hud.root.appendChild(bridge);
  session.qaBridge = bridge;
  session.qaMetrics = metrics;
}

function updateQaMetrics(session) {
  if (!session?.qaMetrics) return;
  const physics = crashPhysicsSnapshot(session.physics);
  const traffic = crashTrafficSnapshot(session.traffic);
  session.qaMetrics.textContent = [
    `PHASE ${session.crashState.phase} · FIXED ${(CRASH_FIXED_DT * 1000).toFixed(2)}MS / 90HZ`,
    `PHYSICAL ${physics.physicalBodies} · DYNAMIC ${traffic.dynamic}/${session.quality.maxDynamicBodies} · KINEMATIC ${traffic.kinematic}`,
    `TRAFFIC ${traffic.active} ACTIVE · ${traffic.crashed} CRASHED · ${traffic.saturated} SATURATED · GHOSTS ${traffic.colliderViolations.length}`,
    `REPLAY ${(session.replayRecorder.memoryBytes() / 1048576).toFixed(2)} MIB · ${session.replayRecorder.frameCount} FRAMES · ${session.replayRecorder.events.length} EVENTS`,
  ].join('\n');
}

export async function enterCrashMode(scene, options = {}) {
  if (!scene || !state.hero?.mesh) throw new Error('Kaki Catastrophe needs a scene and loaded hero');
  if (activeCrashSession) exitCrashMode(scene, activeCrashSession);
  const validation = validateCrashScenario(PAWPRINT_INTERCHANGE);
  if (!validation.valid) throw new Error(`Pawprint Interchange is invalid: ${validation.errors.join('; ')}`);
  const hero = state.hero.mesh;
  const root = new THREE.Group();
  root.name = 'kaki-catastrophe-pawprint-interchange';
  root.position.set(CRASH_MODE_ORIGIN.x, CRASH_MODE_ORIGIN.y, CRASH_MODE_ORIGIN.z);
  scene.add(root);
  const restartOptions = { ...options };
  delete restartOptions._retainedAssetLease;
  const session = {
    scene,
    root,
    raceMode: 'crash',
    modeDef: { id: 'crash', name: 'Kaki Catastrophe', objective: 'crashScore' },
    course: crashCourse(),
    scenario: PAWPRINT_INTERCHANGE,
    samples: cameraSamples(PAWPRINT_INTERCHANGE),
    quality: qualityForOptions(options),
    seed: Number(options.crashSeed ?? options.seed ?? CRASH_DEFAULT_SEED) >>> 0,
    vehicleId: CRASH_PLAYER_PROFILES[options.crashVehicle || options.vehicle] ? (options.crashVehicle || options.vehicle) : 'muscle',
    cameraHost: options.cameraHost || {},
    playerAvatarId: options.playerAvatarId || 'kitty',
    roster: [],
    carCount: 1,
    owned: { geometries: new Set(), materials: new Set(), textures: new Set() },
    savedHero: { parent: hero.parent, position: hero.position.clone(), quaternion: hero.quaternion.clone(), scale: hero.scale.clone(), visible: hero.visible },
    savedBackground: scene.background,
    savedFog: scene.fog,
    savedPostFx: snapshotCrashPostFx(state.postFXPass),
    savedEnvVisible: state.envGroup ? state.envGroup.visible : true,
    crashState: createCrashState(0),
    phase: 'loading',
    countdown: COUNTDOWN_SECONDS,
    liveTime: 0,
    trafficClock: -10,
    accumulator: 0,
    specialClock: 0,
    settlingQuiet: 0,
    hitStop: 0,
    controls: { throttle: 0, steer: 0, brake: true, handbrake: false },
    handbrakeHeld: false,
    boomQueued: false,
    boomAnticipation: 0,
    boomTriggeredFrame: false,
    boomContinuationAwarded: false,
    skipReplayQueued: false,
    reduceMotion: !!state._optReduceMotion,
    reducedFlashing: !!state._optReducedFlashing,
    assetsReady: false,
    assetError: '',
    disposed: false,
    player: null,
    cars: [],
    playerPhysics: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, speed: 0, grounded: true, groundHeight: 0, impactStrength: 0 },
    entityById: new Map(),
    knownPromotions: new Set(),
    debrisEntities: [],
    replayHidden: [],
    record: readCrashRecord(),
    score: createCrashScoreState(0),
    incidentStarted: false,
    qaPaused: false,
    scoreSnapshot: null,
    replaySnapshot: null,
    result: null,
    restartOptions,
  };
  // The render loop observes state.racing while Rapier and mode-local assets
  // initialize asynchronously, so the loading flyover camera must exist before
  // publishing the session.
  session.introCamera = createIntroCamera(session);
  activeCrashSession = session;
  state.racing = session;
  state.mode = 'racing';
  state.gameOver = false;
  state.victory = false;
  scene.background = new THREE.Color(0x061127);
  scene.fog = new THREE.Fog(0x0a1830, 58, 248);
  applyCrashPostFx(state.postFXPass);
  if (state.envGroup) state.envGroup.visible = false;
  session.hud = createCrashHud(session, {
    boom: () => { session.boomQueued = true; },
    skipReplay: () => { session.skipReplayQueued = true; },
    replaySpeed: (speed) => session.replayPlayer?.setSpeed(speed),
    replayAgain: () => replayAgain(session),
    retry: () => restartCrashMode(),
    menu: () => window.kkReturnToMenu?.(),
  });
  installInput(session);
  try {
    session.assetLease = options._retainedAssetLease || createCrashAssetLease(state.renderer);
    const assetsPromise = session.assetLease.ready.then(() => {
      if (!session.disposed) session.assetsReady = true;
    }).catch((error) => {
      if (session.disposed) return;
      session.assetError = error?.message || String(error);
      throw error;
    });
    session.physics = await createCrashPhysicsRuntime();
    if (session.disposed) return session;
    session.worldView = buildCrashWorld({ root, owned: session.owned, physics: session.physics, scenario: session.scenario, assetLease: session.assetLease });
    await Promise.all([assetsPromise, session.worldView.ready]);
    if (session.disposed) return session;
    if (session.assetLease.textures.skyTwilight) scene.background = session.assetLease.textures.skyTwilight;
    if (hero.parent) hero.parent.remove(hero);
    session.player = createPlayer(session, hero);
    session.playerPhysics.x = session.scenario.playerSpawn.x;
    session.playerPhysics.y = session.scenario.playerSpawn.y;
    session.playerPhysics.z = session.scenario.playerSpawn.z;
    session.cars = [{ physics: session.playerPhysics, visual: session.player.visual }];
    const schedule = buildCrashTrafficSchedule(session.seed, session.quality.trafficScale, session.scenario);
    session.traffic = createCrashTraffic({ runtime: session.physics, root, owned: session.owned, assetLease: session.assetLease, scenario: session.scenario, schedule, quality: session.quality });
    session.entityById.set('player', session.player);
    session.replayRecorder = new CrashReplayRecorder({
      seconds: 14,
      hz: 30,
      maxObjects: session.traffic.entities.length + session.quality.maxDetachedDebris + session.worldView.breakables.length + session.worldView.debrisProps.length + 1,
      maxEvents: 960,
    });
    refreshEntityIndex(session);
    session.replayEntities = () => replayEntityList(session);
    session.onQualifyingImpact = (event, a, b) => onQualifyingImpact(session, event, a, b);
    session.onVolatileCritical = (entity, contact) => volatileExplosion(session, entity, contact);
    session.onBreakable = (entity) => onBreakable(session, entity);
    session.onDamageTransition = (_entity, damage, time) => { if (damage.glassChanged) playCrashGlassAudio(session.audio, time); };
    session.onDetachedPart = (_entity, _debris, time) => playCrashDetachedAudio(session.audio, time);
    session.onReplayEvent = (event) => replayEvent(session, event);
    session.replayPlayer = new CrashReplayPlayer(session);
    session.replayCamera = new CrashReplayCameraDirector(session);
    session.vfx = createCrashVfx({ root, owned: session.owned, atlas: session.assetLease.textures.decalAtlas });
    session.colliderOverlay = createCrashColliderOverlay({ root, owned: session.owned, physics: session.physics, traffic: session.traffic, player: session.player });
    session.audio = createCrashAudio();
    const hemi = new THREE.HemisphereLight(0x6688b8, 0x0d0c15, 0.56);
    root.add(hemi);
    const sun = new THREE.DirectionalLight(0x9fc4ff, 0.86);
    sun.position.set(-46, 72, -55);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(session.quality.id === 'low' ? 1024 : 2048, session.quality.id === 'low' ? 1024 : 2048);
    sun.shadow.camera.left = -112; sun.shadow.camera.right = 112; sun.shadow.camera.top = 112; sun.shadow.camera.bottom = -112; sun.shadow.camera.far = 250; sun.shadow.bias = -0.0005;
    root.add(sun, sun.target);
    const stormRim = new THREE.DirectionalLight(0xd944a4, 0.22);
    stormRim.position.set(78, 28, 96);
    stormRim.target.position.set(0, 3, 0);
    root.add(stormRim, stormRim.target);
    const lampLocations = [
      [-18.8, 6.8, -55], [18.8, 6.8, -55], [-18.8, 6.8, 55], [18.8, 6.8, 55],
      [-53.8, 6.8, -20], [-53.8, 6.8, 20], [53.8, 6.8, -20], [53.8, 6.8, 20],
    ];
    const activeLampCount = session.quality.id === 'low' ? 4 : session.quality.id === 'medium' ? 6 : 8;
    for (const [x, y, z] of lampLocations.slice(0, activeLampCount)) {
      const lamp = new THREE.PointLight(0xff8a3d, session.quality.id === 'high' ? 24 : 19, 29, 1.9);
      lamp.position.set(x, y, z);
      root.add(lamp);
    }
    for (const [color, x] of [[0x19cfff, -2.2], [0xff2b9a, 2.2]]) {
      const gatewayGlow = new THREE.PointLight(color, session.quality.id === 'low' ? 14 : 21, 25, 1.9);
      gatewayGlow.position.set(x, 10.5, -39.5);
      root.add(gatewayGlow);
    }
    attachRacingCameraManager(session, session.cameraHost);
    syncPlayerVisual(session, 1);
    syncCrashTrafficVisuals(session.traffic, 1);
    mountQa(session);
    session.worldReady = true;
    return session;
  } catch (error) {
    exitCrashMode(scene, session);
    throw error;
  }
}

export function tickCrashMode(dt) {
  const session = activeCrashSession;
  if (!session || session.disposed) return;
  const safeDt = Math.min(0.1, Math.max(0, Number(dt) || 0));
  session.reduceMotion = !!state._optReduceMotion;
  session.reducedFlashing = !!state._optReducedFlashing;
  session.hud.root.dataset.reduceMotion = session.reduceMotion ? 'true' : 'false';
  session.hud.root.dataset.reducedFlashing = session.reducedFlashing ? 'true' : 'false';
  tickCrashState(session.crashState, safeDt);
  if (session.crashState.phase === CRASH_PHASES.LOADING) {
    if (session.worldReady && session.assetsReady) transition(session, CRASH_PHASES.INTRO, 'runtime-and-assets-ready');
    updateCrashHud(session);
    return;
  }
  if (session.crashState.phase === CRASH_PHASES.INTRO && (session.crashState.elapsed >= INTRO_SECONDS || session.qaSkipIntro)) transition(session, CRASH_PHASES.COUNTDOWN, session.qaSkipIntro ? 'qa-skip-intro' : 'flyover-complete');
  if (session.crashState.phase === CRASH_PHASES.COUNTDOWN) {
    session.countdown = Math.max(0, session.countdown - safeDt);
    if (session.countdown <= 0) transition(session, CRASH_PHASES.APPROACH, 'launch');
  }
  if (session.qaPaused) {
    signalVisuals(session);
    session.scoreSnapshot = crashScoreSnapshot(session.score, session.liveTime);
    updateCrashHud(session);
    updateQaMetrics(session);
    return;
  }
  updateCrashWorldAtmosphere(session.worldView, safeDt);
  session.controls = controlsForSession(session);
  if (session.boomQueued || gamepadState.justPressed?.x) {
    session.boomQueued = false;
    if ([CRASH_PHASES.LIVE_CRASH, CRASH_PHASES.SETTLING].includes(session.crashState.phase)) armBoom(session);
  }
  if (session.boomAnticipation > 0) {
    session.boomAnticipation = Math.max(0, session.boomAnticipation - safeDt);
    if (session.boomAnticipation === 0) triggerBoom(session);
  }
  if (session.hitStop > 0 && !session.reduceMotion) {
    session.hitStop = Math.max(0, session.hitStop - safeDt);
  } else if (![CRASH_PHASES.REPLAY, CRASH_PHASES.RESULTS].includes(session.crashState.phase)) {
    session.accumulator = Math.min(session.accumulator + safeDt, CRASH_FIXED_DT * CRASH_MAX_CATCHUP_STEPS);
    let steps = 0;
    while (session.accumulator >= CRASH_FIXED_DT && steps < CRASH_MAX_CATCHUP_STEPS) {
      fixedStep(session, CRASH_FIXED_DT);
      session.accumulator -= CRASH_FIXED_DT;
      steps += 1;
    }
    const alpha = clamp(session.accumulator / CRASH_FIXED_DT, 0, 1);
    syncCrashTrafficVisuals(session.traffic, alpha);
    syncPlayerVisual(session, alpha);
    syncCrashBreakables(session.worldView);
  }
  signalVisuals(session);
  if ([CRASH_PHASES.APPROACH, CRASH_PHASES.LIVE_CRASH].includes(session.crashState.phase)) {
    if (session.liveTime >= CRASH_MAX_RUN_SECONDS || crashChainShouldSettle(session.score, session.liveTime)) transition(session, CRASH_PHASES.SETTLING, session.liveTime >= CRASH_MAX_RUN_SECONDS ? 'maximum-duration' : 'impact-quiet');
  }
  if (session.crashState.phase === CRASH_PHASES.SETTLING) {
    session.settlingQuiet += safeDt;
    if (session.settlingQuiet >= CRASH_POST_IMPACT_TAIL) startReplay(session);
  }
  if (session.crashState.phase === CRASH_PHASES.REPLAY) {
    if (session.skipReplayQueued || gamepadState.justPressed?.b) {
      session.skipReplayQueued = false;
      session.replayPlayer.skip();
    }
    const replayState = session.replayPlayer.update(safeDt);
    session.replaySnapshot = session.replayPlayer.snapshot();
    if (replayState.finished) finishResults(session);
  }
  session.scoreSnapshot = crashScoreSnapshot(session.score, session.liveTime);
  const replayAudio = session.crashState.phase === CRASH_PHASES.REPLAY
    ? {
      speed: session.replaySnapshot?.speed || 1,
      sample: session.replayPlayer.clip?.sample?.('player', session.replayPlayer.time),
    }
    : null;
  updateCrashAudio(session.audio, session.player, session.controls, replayAudio);
  for (const entity of [session.player, ...session.traffic.entities]) {
    if (entity.damage?.smoke > 0.15 && (session.physics.stepCount + entity.id.length) % 19 === 0) spawnCrashSmoke(session.vfx, entity);
  }
  updateCrashVfx(session.vfx, safeDt);
  updateCrashHud(session);
  updateQaMetrics(session);
}

export function updateCrashCamera(dt, options = {}) {
  const session = activeCrashSession;
  if (!session || session.disposed) return null;
  const phase = session.crashState.phase;
  if ([CRASH_PHASES.LOADING, CRASH_PHASES.INTRO].includes(phase)) return updateIntroCamera(session);
  if ([CRASH_PHASES.REPLAY, CRASH_PHASES.RESULTS].includes(phase)) {
    if (phase === CRASH_PHASES.REPLAY) {
      const frame = session.replayCamera.update(dt, { ...session.replayPlayer.snapshot(), shot: session.replayPlayer.lastShot }, !!options.reducedMotion);
      if (frame) return frame;
    }
    return session.replayCamera.lastFrame || updateIntroCamera(session);
  }
  return session.cameraManager?.update(dt, options) || null;
}

export function resizeCrashMode(width, height) {
  const session = activeCrashSession;
  if (!session) return;
  const aspect = height ? Math.max(0.1, Number(width) / Number(height)) : Math.max(0.1, Number(width) || 16 / 9);
  session.cameraManager?.resize(aspect);
  session.replayCamera?.resize(aspect);
  if (session.introCamera) { session.introCamera.aspect = aspect; session.introCamera.updateProjectionMatrix(); }
}

export async function restartCrashMode() {
  const session = activeCrashSession;
  if (!session || session.disposed) return null;
  const { scene, restartOptions } = session;
  // Keep decoded mode-local source assets alive across retry. Physics, visual
  // clones, VFX, UI, cameras, and listeners are still rebuilt from scratch.
  const retainedAssetLease = session.assetLease;
  session.assetLease = null;
  exitCrashMode(scene, session);
  return enterCrashMode(scene, { ...restartOptions, _retainedAssetLease: retainedAssetLease });
}

export function getCrashCameraConfig() {
  const session = activeCrashSession;
  if (!session) return { chromatic: 0, bloom: 0.3 };
  if ([CRASH_PHASES.REPLAY, CRASH_PHASES.RESULTS].includes(session.crashState.phase)) return session.replayCamera?.lastFrame?.effects || { chromatic: 0.0006, bloom: 0.34 };
  return session.cameraManager?.lastEffects || { chromatic: 0.0006, bloom: 0.34 };
}

export function getCrashSnapshot() {
  const session = activeCrashSession;
  if (!session) return null;
  return {
    mode: 'crash',
    phase: session.crashState.phase,
    phaseHistory: session.crashState.history.map((entry) => ({ ...entry })),
    vehicle: session.vehicleId,
    junction: session.scenario.id,
    quality: session.quality.id,
    seed: session.seed,
    score: crashScoreSnapshot(session.score, session.liveTime),
    physics: session.physics ? crashPhysicsSnapshot(session.physics) : null,
    traffic: session.traffic ? crashTrafficSnapshot(session.traffic) : null,
    replay: session.replayPlayer?.snapshot?.() || null,
    replayMemoryBytes: session.replayRecorder?.memoryBytes?.() || 0,
    camera: session.cameraManager?.getSnapshot?.() || null,
    colliderOverlay: session.colliderOverlay?.snapshot?.() || null,
    assetsReady: session.assetsReady,
    assetError: session.assetError,
    worldReady: !!session.worldReady,
    result: session.result,
    listeners: session.keyDown ? 2 : 0,
    disposed: session.disposed,
  };
}

export function exitCrashMode(scene, explicitSession = null) {
  const session = explicitSession || activeCrashSession;
  if (!session || session.disposed) return false;
  session.disposed = true;
  try { disposeCrashState(session.crashState, session.liveTime); } catch (_) {}
  if (typeof window !== 'undefined') {
    if (session.keyDown) window.removeEventListener('keydown', session.keyDown);
    if (session.keyUp) window.removeEventListener('keyup', session.keyUp);
  }
  try { session.cameraManager?.dispose(); } catch (_) {}
  try { session.replayCamera?.dispose(); } catch (_) {}
  try { session.colliderOverlay?.dispose(); } catch (_) {}
  try { disposeCrashAudio(session.audio); } catch (_) {}
  try { disposeCrashVehicleController(session.physics, session.player); } catch (_) {}
  try { disposeCrashTraffic(session.traffic); } catch (_) {}
  try { disposeCrashWorld(session.worldView); } catch (_) {}
  try { disposeCrashPhysics(session.physics); } catch (_) {}
  try { disposeCrashHud(session.hud); } catch (_) {}
  try { session.qaBridge?.remove(); } catch (_) {}
  try { session.root?.parent?.remove(session.root); } catch (_) {}
  for (const texture of session.owned?.textures || []) { try { texture.dispose(); } catch (_) {} }
  for (const material of session.owned?.materials || []) { try { material.dispose(); } catch (_) {} }
  for (const geometry of session.owned?.geometries || []) { try { geometry.dispose(); } catch (_) {} }
  try { session.assetLease?.release(); } catch (_) {}
  const hero = state.hero?.mesh;
  if (hero && session.savedHero) {
    try { hero.parent?.remove(hero); } catch (_) {}
    hero.position.copy(session.savedHero.position);
    hero.quaternion.copy(session.savedHero.quaternion);
    hero.scale.copy(session.savedHero.scale);
    hero.visible = session.savedHero.visible;
    (session.savedHero.parent || scene || session.scene)?.add(hero);
  }
  const ownerScene = scene || session.scene;
  if (ownerScene) { ownerScene.background = session.savedBackground; ownerScene.fog = session.savedFog; }
  restoreCrashPostFx(state.postFXPass, session.savedPostFx);
  if (state.envGroup) state.envGroup.visible = session.savedEnvVisible;
  session.entityById.clear();
  session.debrisEntities.length = 0;
  session.replayHidden.length = 0;
  if (state.racing === session) state.racing = null;
  if (activeCrashSession === session) activeCrashSession = null;
  try { if (window.__kkCrash) delete window.__kkCrash; } catch (_) {}
  try { if (window.__kkRacing) delete window.__kkRacing; } catch (_) {}
  return true;
}
