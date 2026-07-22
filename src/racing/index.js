/**
 * Kaki Rally facade — juiced isometric disciplines plus dedicated side-view Trials.
 * Owns its scene root, racers, course HUD, particles, and race progression.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import {
  getActiveRendererCapabilities,
  getRendererDiagnostics,
} from '../rendering/rendererAccess.js';
import { requestTextureUploadIfReady } from '../rendering/textureUpload.js';
import { AVATARS, HERO } from '../config.js';
import { cloneCached } from '../assets.js';
import { consumeJump, isDashPressed, isHandbrakePressed } from '../input.js';
import { gamepadState } from '../gamepad.js';
import {
  sfx,
  updateRacingAudio,
  stopRacingAudio,
  playRacingImpact,
} from '../audio.js';
import {
  createKartState,
  stepKart,
  updateRaceProgress,
  rankRaceCars,
  formatRaceTime,
  normalizeAngle,
  clamp,
  impactDamage,
  applyKartDamage,
  repairKart,
  driftScoreStep,
} from './physics.js';
import { getCourseDefinition, nextCourseId, RACE_MODES } from './tracks.js';
import {
  attachMonsterTrafficModels,
  awardMonsterEvent,
  breakMonsterChain,
  buildCyberTruck,
  buildTipsyTumbler,
  configureMonsterDestructionRound,
  createMonsterScoreState,
  buildMonsterTruck,
  buildMonsterTargets,
  getMonsterVehicleProfile,
  refillMonsterDestruction,
  resolveMonsterDestruction,
  stepMonsterChaos,
  stepMonsterSignatureStunts,
  updateMonsterTargets,
  stepMonsterStunts,
  monsterSnapshot,
} from './monsterSmash.js';
import {
  MONSTER_FREESTYLE_SECONDS,
  activeMonsterRoundDestroyed,
  createMonsterRoundState,
  currentMonsterRound,
  monsterRoundRank,
} from './monsterRounds.js';
import {
  createMonsterSpotlight,
  monsterSpotlightSnapshot,
  stepMonsterSpotlight,
} from './monsterSpotlights.js';
import {
  createMonsterRecordRun,
  finishMonsterRecordRun,
  monsterRecordSnapshot,
  stepMonsterRecordRun,
} from './monsterRecords.js';
import { getMonsterArenaDefinition, queryMonsterArenaGround } from './monsterArenaDefinition.js';
import {
  attachMonsterAudience,
  attachMonsterEnvironmentKit,
  buildMonsterArena,
  createMonsterArenaNavigationSamples,
  disposeMonsterArena,
  monsterArenaContact,
  monsterArenaRenderSnapshot,
  resolveMonsterArenaBounds,
  respawnMonsterKart,
  updateMonsterArena,
} from './monsterArena.js';
import {
  createMonsterVehicleContact,
  initializeMonsterVehiclePhysics,
  monsterContactPatchSnapshot,
  stepMonsterContactPatches,
} from './monsterVehiclePhysics.js';
import {
  enterTrialsMode,
  tickTrialsMode,
  restartTrialsMode,
  exitTrialsMode,
  getTrialsCameraTarget,
  getTrialsCameraConfig,
  getTrialsSnapshot,
} from './trialsMode.js';
import { createRallyAssetLease, getRallyAssetCacheSnapshot } from './racingAssets.js';
import { attachCyberTruckModel, attachMightyMeowsterModel, attachTipsyTumblerModel, buildRallyCar, updateVehicleAnimation } from './racingVehicles.js';
import {
  buildRallyEnvironment,
  disposeRallyEnvironment,
  getRallyLightingProfile,
  syncRallySkyToCamera,
  updateRallyEnvironment,
} from './racingEnvironment.js';
import {
  createRacingVfx,
  spawnRacingDamageSmoke,
  spawnRacingDust,
  spawnRacingImpact,
  spawnRacingSkid,
  updateRacingVfx,
} from './racingVfx.js';
import {
  AIPathGenerator,
  CheckpointGenerator,
  RespawnGenerator,
  TrackMeshBuilder,
} from './drawTrackGeneration.js';
import { TrackCodeCodec, TrackGallery } from './drawTrackStorage.js';
import { attachRacingCameraManager } from './cameras/cameraSessionBinding.js';
import { mapRacingSteerInput } from './racingSteering.js';

export const RACE_CX = 720;
export const RACE_CZ = -520;

const COUNTDOWN_SECONDS = 3.4;
const MINIMAP_W = 220;
const MINIMAP_H = 164;
const _cameraTarget = new THREE.Vector3(RACE_CX, 0, RACE_CZ);
const STANDARD_CAMERA = Object.freeze({ offset: 22, height: 34, frustum: 16.5, lookAtBase: 0.72 });
const MONSTER_CAMERA = Object.freeze({ offset: 27, height: 41, frustum: 20.5, lookAtBase: 1.2 });
const SURFACE_FEEL = Object.freeze({
  forest: Object.freeze({ id: 'mud', grip: 0.84, drag: 0.22 }),
  twilight: Object.freeze({ id: 'wet', grip: 0.76, drag: 0.12 }),
  cinder: Object.freeze({ id: 'basalt', grip: 0.96, drag: 0.05 }),
  void: Object.freeze({ id: 'riftstone', grip: 0.9, drag: 0.08 }),
  cave: Object.freeze({ id: 'quarry', grip: 0.88, drag: 0.11 }),
  kakiland: Object.freeze({ id: 'turf', grip: 1.04, drag: 0.03 }),
});
let _touchDrift = false;
let _touchHandbrake = false;
let _crashModeApi = null;
let _crashModePromise = null;

function _loadCrashMode() {
  if (_crashModeApi) return Promise.resolve(_crashModeApi);
  if (!_crashModePromise) {
    _crashModePromise = import('./crash/crashMode.js').then((module) => {
      _crashModeApi = module;
      return module;
    });
  }
  return _crashModePromise;
}

function _kickCamera(session, strength = 0.3, roll = 0, punch = 0.25) {
  if (!session?.cameraFx || state._optReduceMotion) return;
  session.cameraFx.shake = Math.max(session.cameraFx.shake, clamp(strength, 0, 1.4));
  session.cameraFx.roll += clamp(roll, -0.055, 0.055);
  session.cameraFx.punch = Math.max(session.cameraFx.punch, clamp(punch, 0, 1.35));
}

function _tickCameraFx(session, dt) {
  if (!session?.cameraFx || !(dt > 0)) return;
  const fx = session.cameraFx;
  fx.phase += dt * (23 + fx.shake * 19);
  fx.shake *= Math.exp(-8.4 * dt);
  fx.roll *= Math.exp(-7.2 * dt);
  fx.punch *= Math.exp(-6.8 * dt);
}

function _awardRallyStyle(session, basePoints, label, comboGain = 0.35) {
  if (!session || !(basePoints > 0)) return 0;
  session.styleCombo = session.styleTime > 0
    ? clamp(session.styleCombo + comboGain, 1, 6)
    : 1;
  const points = Math.round(basePoints * session.styleCombo);
  session.styleScore += points;
  session.styleTime = 3.2;
  session.styleEvent = `${label} +${points.toLocaleString()}`;
  session.styleEventTime = 1.45;
  if (session.raceMode === 'drift') session.driftScore += points;
  return points;
}

function _ownedMesh(geometry, material, owned) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.raceOwned = true;
  owned.geometries.add(geometry);
  if (Array.isArray(material)) material.forEach((m) => owned.materials.add(m));
  else owned.materials.add(material);
  return mesh;
}

function _buildSamples(course) {
  const controls = course.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(controls, true, 'centripetal', 0.4);
  const samples = [];
  for (let i = 0; i < course.samples; i++) {
    const u = i / course.samples;
    const point = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u).setY(0).normalize();
    samples.push({
      x: point.x,
      y: 0,
      z: point.z,
      tangent,
      normal: new THREE.Vector3(-tangent.z, 0, tangent.x),
    });
  }
  return TrackMeshBuilder.applyElevation(samples, course);
}

function _indexForFraction(fraction, sampleCount) {
  return Math.round((((fraction % 1) + 1) % 1) * sampleCount) % sampleCount;
}

function _placeAtSample(object, sample, lateral = 0, y = 0) {
  object.position.set(
    sample.x + sample.normal.x * lateral,
    (sample.y || 0) + y,
    sample.z + sample.normal.z * lateral,
  );
  object.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
}

function _roundedPadGeometry(width, length, height, radius = 0.2) {
  const hw = width * 0.5;
  const hl = length * 0.5;
  const r = Math.min(radius, hw * 0.8, hl * 0.8);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hl);
  shape.lineTo(hw - r, -hl);
  shape.quadraticCurveTo(hw, -hl, hw, -hl + r);
  shape.lineTo(hw, hl - r);
  shape.quadraticCurveTo(hw, hl, hw - r, hl);
  shape.lineTo(-hw + r, hl);
  shape.quadraticCurveTo(-hw, hl, -hw, hl - r);
  shape.lineTo(-hw, -hl + r);
  shape.quadraticCurveTo(-hw, -hl, -hw + r, -hl);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: Math.min(0.06, height * 0.22),
    bevelThickness: Math.min(0.05, height * 0.2),
    curveSegments: 4,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height * 0.5, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function _buildFeaturePads(course, samples, root, owned) {
  const rampIndices = course.rampFractions.map((f) => _indexForFraction(f, samples.length));
  const boostIndices = course.boostFractions.map((f) => _indexForFraction(f, samples.length));
  const repairIndices = (course.repairFractions || []).map((f) => _indexForFraction(f, samples.length));
  const rampMat = new THREE.MeshStandardMaterial({
    color: 0x7b5133,
    roughness: 0.82,
    metalness: 0.05,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: course.accent,
    emissive: course.accent,
    emissiveIntensity: 0.62,
  });
  for (const index of rampIndices) {
    const ramp = new THREE.Group();
    const deck = _ownedMesh(_roundedPadGeometry(course.trackWidth * 0.62, 5.1, 0.32, 0.3), rampMat, owned);
    deck.rotation.x = -0.11;
    deck.position.y = 0.38;
    deck.castShadow = true;
    deck.receiveShadow = true;
    ramp.add(deck);
    for (const side of [-1, 1]) {
      const rail = _ownedMesh(new THREE.CapsuleGeometry(0.1, 4.9, 4, 8), railMat, owned);
      rail.position.set(side * course.trackWidth * 0.31, 0.75, 0);
      rail.rotation.x = Math.PI / 2 - 0.11;
      ramp.add(rail);
    }
    _placeAtSample(ramp, samples[index], 0, 0.12);
    root.add(ramp);
  }
  for (const index of boostIndices) {
    const pad = new THREE.Group();
    for (let strip = -2; strip <= 2; strip++) {
      const plate = _ownedMesh(
        _roundedPadGeometry(course.trackWidth * 0.14, 2.7, 0.07, 0.18),
        railMat,
        owned,
      );
      plate.position.set(strip * course.trackWidth * 0.17, 0, 0);
      pad.add(plate);
    }
    _placeAtSample(pad, samples[index], 0, 0.18);
    root.add(pad);
  }
  const repairMat = new THREE.MeshStandardMaterial({
    color: 0x63ffc2,
    emissive: 0x21d895,
    emissiveIntensity: 1.2,
    roughness: 0.38,
  });
  owned.materials.add(repairMat);
  for (const index of repairIndices) {
    const bay = new THREE.Group();
    const plate = _ownedMesh(_roundedPadGeometry(3.2, 6.8, 0.08, 0.32), repairMat, owned);
    bay.add(plate);
    for (const x of [-1.25, 0, 1.25]) {
      const stripe = _ownedMesh(new THREE.CapsuleGeometry(0.15, 5.1, 4, 8), repairMat, owned);
      stripe.position.x = x;
      stripe.rotation.x = Math.PI / 2;
      bay.add(stripe);
    }
    _placeAtSample(bay, samples[index], -(course.trackWidth * 0.36), 0.18);
    root.add(bay);
  }
  return { rampIndices, boostIndices, repairIndices };
}

function _buildShortcuts(course, samples, root, owned) {
  const shortcuts = [];
  const material = new THREE.MeshStandardMaterial({
    color: course.shoulder,
    emissive: course.accent,
    emissiveIntensity: 0.06,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  owned.materials.add(material);
  for (const [from, to] of course.shortcutFractions || []) {
    const startIndex = _indexForFraction(from, samples.length);
    const endIndex = _indexForFraction(to, samples.length);
    const a = samples[startIndex];
    const b = samples[endIndex];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.max(0.001, Math.hypot(dx, dz));
    const nx = -dz / length;
    const nz = dx / length;
    const width = 3.25;
    const positions = new Float32Array([
      a.x + nx * width * 0.5, 0.105, a.z + nz * width * 0.5,
      a.x - nx * width * 0.5, 0.105, a.z - nz * width * 0.5,
      b.x + nx * width * 0.5, 0.105, b.z + nz * width * 0.5,
      b.x - nx * width * 0.5, 0.105, b.z - nz * width * 0.5,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 1, 3, 2]);
    geometry.computeVertexNormals();
    const mesh = _ownedMesh(geometry, material, owned);
    mesh.receiveShadow = true;
    root.add(mesh);
    shortcuts.push({ startIndex, endIndex, ax: a.x, az: a.z, bx: b.x, bz: b.z, width, length });
  }
  return shortcuts;
}

function _buildCourse(course, root, owned, assetLease = null, monsterDefinition = null) {
  if (course.mode === 'monster') {
    const definition = monsterDefinition || getMonsterArenaDefinition(course.arenaId);
    const monsterArenaView = buildMonsterArena({
      root,
      owned,
      assetLease,
      definition,
    });
    return {
      samples: createMonsterArenaNavigationSamples(definition),
      shortcuts: [],
      environment: null,
      monsterArenaView,
      rampIndices: [],
      boostIndices: [],
      repairIndices: [],
    };
  }
  const samples = _buildSamples(course);
  const environment = buildRallyEnvironment({
    root,
    course,
    samples,
    ownedGeometries: owned.geometries,
    ownedMaterials: owned.materials,
    ownedTextures: owned.textures,
    mode: course.mode,
    atlasTexture: assetLease?.textures?.decalAtlas || null,
    assetLease,
    textureResolver: assetLease?.getTextureByUrl?.bind(assetLease) || null,
    anisotropy: Math.min(8, getActiveRendererCapabilities(state).maxAnisotropy || 1),
  });
  const overpassKit = TrackMeshBuilder.buildOverpasses({ root, course, samples, owned });
  const features = _buildFeaturePads(course, samples, root, owned);
  const shortcuts = _buildShortcuts(course, samples, root, owned);
  const checkpoints = course.mode === 'draw'
    ? CheckpointGenerator.generate(samples, course.trackWidth)
    : [];
  const aiPath = course.mode === 'draw'
    ? AIPathGenerator.generate(samples, course.trackWidth)
    : null;
  if (aiPath) {
    const aiValidation = AIPathGenerator.validate(aiPath);
    if (!aiValidation.valid) throw new Error(`Draw Your Track AI validation failed: ${aiValidation.reason}`);
  }
  return { samples, shortcuts, environment, overpassKit, checkpoints, aiPath, ...features };
}

function _tintDriver(driver, color, owned) {
  const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.44);
  driver.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const cloneMaterial = (material) => {
      const cloned = material.clone();
      if (cloned.color) cloned.color.multiply(tint);
      owned.materials.add(cloned);
      return cloned;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  });
}

function _buildKart(color, driver, owned, isPlayer, options = {}) {
  return buildRallyCar({
    color,
    driver,
    owned,
    isPlayer,
    mode: options.mode || 'circuit',
    variant: options.variant || 0,
    decalTexture: options.decalTexture || null,
    decalTile: options.decalTile,
    detailTier: options.detailTier || 'showcase',
  });
}

function _proxyColor(avatar) {
  if (avatar?.tint && avatar.tint !== 0xffffff) return avatar.tint;
  let hash = 0;
  for (const char of avatar?.id || 'kaki') hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.62, 0.58).getHex();
}

function _makeHeroRacerProxy(avatar, owned) {
  const group = new THREE.Group();
  const color = _proxyColor(avatar);
  const suitMat = new THREE.MeshStandardMaterial({ color, roughness: 0.68 });
  const paleMat = new THREE.MeshStandardMaterial({ color: 0xffe7c2, roughness: 0.72 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x17141b, roughness: 0.78 });
  const torso = _ownedMesh(new THREE.CapsuleGeometry(0.62, 0.62, 6, 12), suitMat, owned);
  torso.position.y = 1.08;
  torso.scale.z = 0.72;
  group.add(torso);
  const head = _ownedMesh(new THREE.SphereGeometry(0.83, 10, 7), paleMat, owned);
  head.position.y = 2.35;
  group.add(head);
  for (const side of [-1, 1]) {
    const ear = _ownedMesh(new THREE.ConeGeometry(0.38, 0.82, 6), suitMat, owned);
    ear.position.set(side * 0.52, 3.04, 0);
    ear.rotation.z = side * -0.16;
    group.add(ear);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#17131b';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, 256, 18);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '100px "Segoe UI Emoji", sans-serif';
  ctx.fillText(avatar?.icon || '★', 128, 102);
  ctx.fillStyle = '#fff1d7';
  ctx.font = '900 28px Arial, sans-serif';
  ctx.fillText((avatar?.name || 'KAKI').toUpperCase().slice(0, 12), 128, 202);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  owned.textures.add(texture);
  const badge = _ownedMesh(
    new THREE.PlaneGeometry(1.25, 1.25),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false }),
    owned,
  );
  badge.position.set(0, 2.18, 0.72);
  group.add(badge);
  const visor = _ownedMesh(new THREE.CapsuleGeometry(0.14, 0.9, 4, 10), darkMat, owned);
  visor.rotation.z = Math.PI / 2;
  visor.scale.z = 0.65;
  visor.position.set(0, 2.5, 0.68);
  group.add(visor);
  return group;
}

function _makeRivalDriver(avatar, fallback, owned, fullDetail = false) {
  if (!fullDetail) return _makeHeroRacerProxy(avatar, owned);
  const source = cloneCached(avatar?.glb ? `hero_${avatar.id}` : 'hero') || fallback.clone(true);
  const wrapper = new THREE.Group();
  const box = new THREE.Box3().setFromObject(source);
  const height = Math.max(0.01, box.getSize(new THREE.Vector3()).y);
  source.scale.multiplyScalar((HERO.targetHeight / height) * (HERO.scale || 1) * (avatar?.scaleMul || 1));
  const fitted = new THREE.Box3().setFromObject(source);
  const center = fitted.getCenter(new THREE.Vector3());
  source.position.x -= center.x;
  source.position.z -= center.z;
  source.position.y -= fitted.min.y;
  wrapper.add(source);
  if (!avatar?.glb && avatar?.tint !== 0xffffff) _tintDriver(wrapper, avatar.tint, owned);
  return wrapper;
}

function _createRacers(session, hero) {
  const { course, samples, root, owned } = session;
  const monsterMode = session.modeDef.vehicle === 'monster';
  const monsterDecal = monsterMode ? session.assetLease?.textures?.monsterDecal || null : null;
  const decalAtlas = session.assetLease?.textures?.decalAtlas || null;
  const rivals = session.roster.filter((avatar) => avatar.id !== session.playerAvatarId);
  if (!rivals.length) rivals.push(AVATARS[0]);
  const drivers = [hero];
  for (let i = 1; i < session.carCount; i++) {
    drivers.push(_makeRivalDriver(rivals[(i - 1) % rivals.length], hero, owned, i <= 1));
  }
  const cameraProxyGeometry = session.carCount > 1
    ? new THREE.BoxGeometry(monsterMode ? 5.4 : 3.5, monsterMode ? 5.8 : 3.8, monsterMode ? 8.2 : 5.8)
    : null;
  const cameraProxyMaterial = cameraProxyGeometry
    ? new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
    : null;
  if (cameraProxyGeometry) owned.geometries.add(cameraProxyGeometry);
  if (cameraProxyMaterial) owned.materials.add(cameraProxyMaterial);
  const cars = [];
  for (let i = 0; i < session.carCount; i++) {
    const avatar = i === 0 ? AVATARS.find((entry) => entry.id === session.playerAvatarId) : rivals[(i - 1) % rivals.length];
    const color = course.kartColors[i % course.kartColors.length];
    const renderTier = monsterMode ? 'monster-showcase' : (i <= 1 ? 'showcase' : 'pack');
    const visual = monsterMode
      ? (session.monsterVehicleId === 'cyber'
          ? buildCyberTruck({ driver: drivers[i], owned })
          : session.monsterVehicleId === 'tipsy'
            ? buildTipsyTumbler({ driver: drivers[i], owned })
            : buildMonsterTruck({ color: 0xc76dff, driver: drivers[i], owned, decalTexture: monsterDecal }))
      : _buildKart(color, drivers[i], owned, i === 0, {
          mode: session.raceMode,
          variant: i,
          decalTexture: decalAtlas,
          decalTile: (i * 5 + RACE_MODES[session.raceMode].carCount) % 16,
          detailTier: renderTier,
        });
    const row = Math.floor(i / 2);
    const back = 5 + row * 4;
    const index = monsterMode ? 0 : (samples.length - back) % samples.length;
    const sample = monsterMode ? session.monsterArenaDefinition.spawnPoints[0] : samples[index];
    const gridLane = course.mode === 'stock'
      ? 2.25
      : clamp(course.trackWidth * 0.18, 1.15, 2.35);
    const lateral = monsterMode ? 0 : (i % 2 === 0 ? -1 : 1) * gridLane;
    const x = monsterMode ? sample.x : sample.x + sample.normal.x * lateral;
    const z = monsterMode ? sample.z : sample.z + sample.normal.z * lateral;
    const ground = monsterMode ? queryMonsterArenaGround(x, z, session.monsterArenaDefinition) : null;
    const monsterProfile = session.monsterVehicleProfile;
    const physics = createKartState({
      x,
      z,
      y: monsterMode ? (ground?.height || 0) : (sample.y || 0),
      yaw: monsterMode ? sample.yaw : Math.atan2(sample.tangent.x, sample.tangent.z),
      nearestIndex: index,
      unwrappedIndex: monsterMode ? 0 : -back,
      previousX: x,
      previousZ: z,
      previousY: monsterMode ? (ground?.height || 0) : (sample.y || 0),
      groundHeight: monsterMode ? (ground?.height || 0) : (sample.y || 0),
      groundPitch: monsterMode ? (ground?.pitch || 0) : (sample.groundPitch || 0),
      groundRoll: ground?.roll || 0,
      collisionRadius: monsterMode ? monsterProfile.collisionRadius : 1.05,
      mass: monsterMode ? monsterProfile.mass : 1,
      stuntPitch: 0,
      stuntPitchVelocity: 0,
      stuntRoll: 0,
      stuntRollVelocity: 0,
    });
    if (monsterMode) initializeMonsterVehiclePhysics(physics, monsterProfile);
    if (course.mode === 'draw') CheckpointGenerator.reset(physics);
    visual.root.position.set(x, physics.y, z);
    visual.root.rotation.y = physics.yaw;
    if (i > 0 && cameraProxyGeometry && cameraProxyMaterial) {
      // Render meshes are far too detailed for camera collision (a full-detail
      // rival can contribute dozens of meshes and hundreds of thousands of
      // triangles). Keep one hidden, vehicle-sized proxy authoritative while
      // preserving the complete visible model.
      visual.root.userData.cameraIgnore = true;
      const collisionProxy = new THREE.Mesh(cameraProxyGeometry, cameraProxyMaterial);
      collisionProxy.name = `rival-${i}-camera-collision-proxy`;
      collisionProxy.position.y = monsterMode ? 2.9 : 1.9;
      collisionProxy.visible = false;
      collisionProxy.userData.cameraBlocker = true;
      collisionProxy.userData.presentationOnly = true;
      visual.root.add(collisionProxy);
      visual.cameraCollisionProxy = collisionProxy;
    }
    root.add(visual.root);
    cars.push({
      id: i === 0 ? 'player' : `rival-${i}`,
      name: i === 0 ? 'YOU' : (avatar?.name || `RIVAL ${i}`),
      avatarId: avatar?.id || 'kitty',
      renderTier,
      gridIndex: i,
      physics,
      visual,
      aiSkill: Math.min(0.98, 0.78 + (i % 6) * 0.034),
      aiLane: course.mode === 'stock'
        ? ((i % 3) - 1) * 2.15
        : ((i % 3) - 1) * (course.mode === 'draw' ? clamp(course.trackWidth * 0.095, 0.5, 1.28) : 0.62),
      dustClock: i * 0.04,
      skidClock: i * 0.03,
      smokeClock: i * 0.07,
      suspensionKick: 0,
      frameEvents: { boostStarted: false, boostLevel: 0, jumped: false, landed: false, landingSpeed: 0, driftStrength: 0 },
      frameControls: null,
      frameContact: null,
    });
  }
  return cars;
}

function _makeParticlePool(session) {
  session.racingVfx = createRacingVfx({
    root: session.root,
    owned: session.owned,
    course: session.course,
    capacity: Math.max(144, session.carCount * 16),
    vfxAtlas: session.raceMode === 'monster' ? session.assetLease?.textures?.monsterArenaVfx || null : null,
  });
}

function _spawnDust(session, car, strength = 1, boost = false) {
  spawnRacingDust(session.racingVfx, car, strength, boost);
}

function _spawnDamageSmoke(session, car) {
  spawnRacingDamageSmoke(session.racingVfx, car);
}

function _spawnImpactBurst(session, car, strength = 0.5, kind = 'spark') {
  spawnRacingImpact(session.racingVfx, car, strength, kind);
}

function _tickParticles(session, dt) {
  updateRacingVfx(session.racingVfx, dt);
}

function _nearestSample(samples, x, z, y = 0, preferredIndex = null) {
  let best = 0;
  let bestScore = Infinity;
  let bestDistSq = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const dx = x - samples[i].x;
    const dz = z - samples[i].z;
    const d2 = dx * dx + dz * dz;
    const dy = y - (samples[i].y || 0);
    let progressPenalty = 0;
    if (Number.isFinite(preferredIndex)) {
      let delta = Math.abs(i - preferredIndex);
      delta = Math.min(delta, samples.length - delta);
      progressPenalty = Math.min(18, delta * delta * 0.002);
    }
    const score = d2 + dy * dy * 1.8 + progressPenalty;
    if (score < bestScore) { bestScore = score; bestDistSq = d2; best = i; }
  }
  return { index: best, distance: Math.sqrt(bestDistSq), sample: samples[best] };
}

function _nearIndex(index, targets, count, radius = 3) {
  for (const target of targets) {
    let delta = Math.abs(index - target);
    delta = Math.min(delta, count - delta);
    if (delta <= radius) return true;
  }
  return false;
}

function _activeShortcut(shortcuts, x, z) {
  for (const shortcut of shortcuts || []) {
    const dx = shortcut.bx - shortcut.ax;
    const dz = shortcut.bz - shortcut.az;
    const t = clamp(((x - shortcut.ax) * dx + (z - shortcut.az) * dz) / Math.max(0.001, dx * dx + dz * dz), 0, 1);
    const distance = Math.hypot(x - (shortcut.ax + dx * t), z - (shortcut.az + dz * t));
    if (distance <= shortcut.width * 0.52 && t > 0.025 && t < 0.985) return { ...shortcut, t, distance };
  }
  return null;
}

function _contactFor(session, car) {
  if (session.raceMode === 'monster') {
    const baseContact = monsterArenaContact(session.monsterArenaView, car.physics);
    return createMonsterVehicleContact(
      baseContact,
      car.physics,
      session.monsterArena,
      session.monsterVehicleProfile,
    );
  }
  const nearest = _nearestSample(
    session.samples,
    car.physics.x,
    car.physics.z,
    car.physics.y,
    car.physics.nearestIndex,
  );
  const shortcut = _activeShortcut(session.shortcuts, car.physics.x, car.physics.z);
  const onRoad = nearest.distance <= session.course.trackWidth * 0.66 || !!shortcut;
  const surface = SURFACE_FEEL[session.course.id] || SURFACE_FEEL.forest;
  const roadSample = session.samples[nearest.index];
  return {
    nearest,
    onRoad,
    shortcut,
    groundHeight: onRoad && !shortcut ? (roadSample.y || 0) : 0,
    groundPitch: onRoad && !shortcut ? (roadSample.groundPitch || 0) : 0,
    surface: shortcut ? 'shortcut-dirt' : onRoad ? surface.id : 'loose-dirt',
    surfaceGrip: shortcut ? 0.68 : onRoad ? surface.grip : 0.62,
    surfaceDrag: shortcut ? 0.36 : onRoad ? surface.drag : 0.72,
    ramp: !shortcut && onRoad && _nearIndex(nearest.index, session.rampIndices, session.samples.length, 2),
    boostPad: !shortcut && onRoad && _nearIndex(nearest.index, session.boostIndices, session.samples.length, 2),
    repairBay: onRoad && _nearIndex(nearest.index, session.repairIndices, session.samples.length, 5)
      && nearest.distance > session.course.trackWidth * 0.15,
  };
}

function _draftStrengthFor(session, car) {
  if (session.raceMode !== 'stock' || car.physics.speed < 10) return 0;
  const p = car.physics;
  const fx = Math.sin(p.yaw);
  const fz = Math.cos(p.yaw);
  let best = 0;
  for (const other of session.cars) {
    if (other === car) continue;
    const dx = other.physics.x - p.x;
    const dz = other.physics.z - p.z;
    const ahead = dx * fx + dz * fz;
    if (ahead < 2.2 || ahead > 13) continue;
    const lateral = Math.abs(dx * fz - dz * fx);
    if (lateral > 2.25) continue;
    best = Math.max(best, (1 - (ahead - 2.2) / 10.8) * (1 - lateral / 2.25));
  }
  return clamp(best, 0, 1);
}

function _aiControls(session, car) {
  const p = car.physics;
  const count = session.samples.length;
  const lookAhead = 7 + Math.round(p.speed * 0.42);
  const targetIndex = (p.nearestIndex + lookAhead) % count;
  const target = session.aiPath?.[targetIndex] || session.samples[targetIndex];
  let avoidance = 0;
  const fx = Math.sin(p.yaw);
  const fz = Math.cos(p.yaw);
  for (const other of session.cars) {
    if (other === car) continue;
    const dx = other.physics.x - p.x;
    const dz = other.physics.z - p.z;
    const ahead = dx * fx + dz * fz;
    const lateral = dx * fz - dz * fx;
    if (ahead > 0.5 && ahead < 5.2 && Math.abs(lateral) < 2.2) {
      avoidance += (lateral > 0 ? -1 : lateral < 0 ? 1 : (car.gridIndex % 2 ? 1 : -1));
    }
  }
  const laneScale = session.raceMode === 'stock'
    ? 1.9
    : session.raceMode === 'draw' ? clamp(session.course.trackWidth * 0.095, 0.55, 1.35) : 0.8;
  const lane = car.aiLane + clamp(avoidance, -1, 1) * laneScale;
  const targetX = target.x + target.normal.x * lane;
  const targetZ = target.z + target.normal.z * lane;
  const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
  const delta = normalizeAngle(desiredYaw - p.yaw);
  const playerProgress = session.cars[0].physics.unwrappedIndex;
  const behind = playerProgress - p.unwrappedIndex;
  if (behind > count * 0.17 && p.boostTime <= 0) p.boostTime = 0.18;
  const targetSpeed = Number(target.targetSpeed) || 24;
  const speedError = targetSpeed - p.speed;
  return {
    throttle: Math.abs(delta) > 1.2 ? 0.18 : speedError < -1.5 ? -0.42 : speedError < 0.5 ? 0.42 : car.aiSkill,
    steer: clamp(delta * 1.75, -1, 1),
    drift: Math.abs(delta) > 0.34 && p.speed > 9,
    hop: false,
  };
}

function _impactZone(kart, nx, nz) {
  const forward = nx * Math.sin(kart.yaw) + nz * Math.cos(kart.yaw);
  const right = nx * Math.cos(kart.yaw) - nz * Math.sin(kart.yaw);
  if (Math.abs(forward) >= Math.abs(right)) return forward > 0 ? 'front' : 'rear';
  return right > 0 ? 'right' : 'left';
}

function _resolveKartCollisions(session) {
  const { cars } = session;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i].physics;
      const b = cars[j].physics;
      // Cars sharing an overpass still collide; cars on vertically separated
      // crossing branches do not. Airborne pack collisions remain suppressed.
      if (Math.abs(a.y - b.y) > 1.8 || (!a.grounded && !b.grounded && Math.min(a.y, b.y) > 1.1)) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let dist = Math.hypot(dx, dz);
      const minDist = 2.1;
      if (dist >= minDist) continue;
      if (dist < 0.001) { dx = 1; dz = 0; dist = 1; }
      const nx = dx / dist;
      const nz = dz / dist;
      const closingSpeed = Math.max(0, -((b.vx - a.vx) * nx + (b.vz - a.vz) * nz));
      const push = (minDist - dist) * 0.5;
      a.x -= nx * push; a.z -= nz * push;
      b.x += nx * push; b.z += nz * push;
      const impulse = ((b.vx - a.vx) * nx + (b.vz - a.vz) * nz) * 0.32;
      a.vx += nx * impulse; a.vz += nz * impulse;
      b.vx -= nx * impulse; b.vz -= nz * impulse;
      if (closingSpeed > 5.5 && a.collisionCooldown <= 0 && b.collisionCooldown <= 0) {
        const damage = impactDamage(closingSpeed);
        const tangentialSpeed = (b.vx - a.vx) * -nz + (b.vz - a.vz) * nx;
        const spin = clamp(tangentialSpeed * 0.045, -1.25, 1.25);
        a.angularVelocity = (a.angularVelocity || 0) + spin;
        b.angularVelocity = (b.angularVelocity || 0) - spin;
        applyKartDamage(a, damage, _impactZone(a, nx, nz));
        applyKartDamage(b, damage, _impactZone(b, -nx, -nz));
        a.collisionCooldown = b.collisionCooldown = 0.28;
        if (cars[i].id === 'player' || cars[j].id === 'player') {
          session.crashFlash = Math.max(session.crashFlash, damage / 24);
          session.driftChain = 0;
          session.driftCombo = 1;
          session.driftGap = 1;
          _kickCamera(session, damage / 22, spin * 0.025, damage / 32);
          playRacingImpact({ strength: damage / 28, kind: 'crash' });
          _spawnImpactBurst(session, cars[i].id === 'player' ? cars[i] : cars[j], damage / 24, 'spark');
          try { sfx.hit(); } catch (_) {}
        }
      }
    }
  }
}

function _resolveStockWall(session, car, contact) {
  if (session.raceMode !== 'stock' || !car.physics.grounded) return;
  const limit = session.course.trackWidth * 0.54;
  if (contact.nearest.distance <= limit) return;
  const sample = session.samples[contact.nearest.index];
  const p = car.physics;
  const dx = p.x - sample.x;
  const dz = p.z - sample.z;
  const side = Math.sign(dx * sample.normal.x + dz * sample.normal.z) || 1;
  const nx = sample.normal.x * side;
  const nz = sample.normal.z * side;
  const overshoot = contact.nearest.distance - limit;
  p.x -= nx * overshoot;
  p.z -= nz * overshoot;
  const outwardSpeed = Math.max(0, p.vx * nx + p.vz * nz);
  p.vx -= nx * outwardSpeed * 1.35;
  p.vz -= nz * outwardSpeed * 1.35;
  if (outwardSpeed > 5.5 && p.collisionCooldown <= 0) {
    const damage = impactDamage(outwardSpeed * 1.12);
    applyKartDamage(p, damage, _impactZone(p, nx, nz));
    p.collisionCooldown = 0.35;
    if (car.id === 'player') {
      session.crashFlash = Math.max(session.crashFlash, damage / 20);
      _kickCamera(session, damage / 18, (car.gridIndex % 2 ? 1 : -1) * damage * 0.0015, damage / 30);
      playRacingImpact({ strength: damage / 26, kind: 'crash' });
      _spawnImpactBurst(session, car, damage / 22, 'spark');
      try { sfx.hit(); } catch (_) {}
    }
  }
}

function _rescueIfNeeded(session, car, contact, dt) {
  if (contact.shortcut || contact.nearest.distance < session.course.trackWidth * 2.3) {
    car.physics.rescueTime = 0;
    return;
  }
  car.physics.rescueTime += dt;
  if (car.physics.rescueTime < 0.85) return;
  if (session.raceMode === 'draw') {
    RespawnGenerator.respawn(car.physics, session.samples);
    if (car.id === 'player') {
      session.cameraManager?.onVehicleRespawned();
      session.rescueFlash = 1.1;
      try { sfx.hit(); } catch (_) {}
    }
    return;
  }
  const sample = session.samples[contact.nearest.index];
  car.physics.x = sample.x;
  car.physics.z = sample.z;
  car.physics.y = sample.y || 0;
  car.physics.vx = 0;
  car.physics.vz = 0;
  car.physics.vy = 0;
  car.physics.yaw = Math.atan2(sample.tangent.x, sample.tangent.z);
  car.physics.grounded = true;
  car.physics.rescueTime = 0;
  if (car.id === 'player') {
    session.cameraManager?.onVehicleRespawned();
    session.rescueFlash = 1.1;
    try { sfx.hit(); } catch (_) {}
  }
}

function _syncKartVisual(session, car, dt, controls, events, contact) {
  const p = car.physics;
  const v = car.visual;
  v.root.position.set(p.x, p.y, p.z);
  v.root.rotation.y = p.yaw;
  const leanTarget = v.monster
    ? (p.grounded ? (p.contactRoll ?? p.groundRoll ?? 0) : (p.stuntRoll || 0))
    : -controls.steer * (p.drifting ? 0.17 : 0.07)
      + (p.grounded ? (p.bodyRoll || 0) : (p.airRoll || 0));
  v.bodyPivot.rotation.z += (leanTarget - v.bodyPivot.rotation.z) * Math.min(1, dt * 10);
  const pitchTarget = v.monster
    ? (p.grounded ? (p.contactPitch ?? p.groundPitch ?? 0) : (p.stuntPitch || 0))
    : (p.grounded ? clamp(p.bodyPitch || 0, -0.24, 0.24) : (p.airPitch || -p.vy * 0.012));
  v.bodyPivot.rotation.x += (pitchTarget - v.bodyPivot.rotation.x) * Math.min(1, dt * (v.monster ? 18 : 9));
  car.suspensionKick = Math.max(0, car.suspensionKick - dt * 3.6);
  const compression = clamp(p.suspensionCompression || 0, 0, 1.25);
  const landingBob = -Math.sin(car.suspensionKick * Math.PI) * (v.monster ? 0.34 : 0.16);
  v.bodyPivot.position.y = landingBob - compression * (v.monster ? 0.2 : 0.11);
  const signedRoadSpeed = (Number(p.vx) || 0) * Math.sin(p.yaw)
    + (Number(p.vz) || 0) * Math.cos(p.yaw);
  updateVehicleAnimation(v, signedRoadSpeed, dt);
  for (let i = 0; i < v.wheels.length; i++) {
    const wheel = v.wheels[i];
    const contactId = `${wheel.userData.side}${wheel.userData.axle === 'front' ? 'Front' : 'Rear'}`;
    const wheelContact = p.wheelContacts?.[contactId];
    const basePosition = wheel.userData.basePosition;
    if (v.monster && basePosition) {
      wheel.position.y += ((basePosition.y + (wheelContact?.visualOffset || 0)) - wheel.position.y)
        * Math.min(1, dt * 18);
    }
    const wheelRadians = v.monster && Number.isFinite(p.wheelRpm)
      ? (p.wheelRpm / 60) * Math.PI * 2
      : p.speed * 1.8;
    wheel.rotation.x += wheelRadians * dt;
    const isLeft = wheel.userData.side ? wheel.userData.side === 'left' : i < 2;
    const sideDamage = isLeft ? p.bodyDamage?.left || 0 : p.bodyDamage?.right || 0;
    const steer = wheel.userData.steerable ? controls.steer * (p.drifting ? 0.4 : 0.3) : 0;
    const wobble = Math.sin(session.raceTime * (8 + i)) * sideDamage * 0.18;
    wheel.rotation.y += (steer + wobble - wheel.rotation.y) * Math.min(1, dt * 14);
  }
  for (const spring of v.suspension || []) {
    const contactId = `${spring.userData.side}${spring.userData.axle === 'front' ? 'Front' : 'Rear'}`;
    const wheelContact = p.wheelContacts?.[contactId];
    const baseScale = spring.userData.baseScale;
    if (!wheelContact || !baseScale) continue;
    const springScale = clamp(1 - wheelContact.compression * 0.34, 0.58, 1.08);
    spring.scale.y += (baseScale.y * springScale - spring.scale.y) * Math.min(1, dt * 20);
  }
  const boosting = p.boostTime > 0;
  for (const flame of v.flames) {
    flame.visible = boosting;
    if (boosting) flame.scale.y = 0.7 + Math.random() * 0.7;
  }
  const altitude = Math.max(0, p.y - (p.groundHeight || 0));
  v.shadow.material.opacity = clamp(0.28 - altitude * 0.035, 0.08, 0.28);
  v.shadow.scale.setScalar(1 + altitude * 0.08);

  const zones = p.bodyDamage || { front: 0, rear: 0, left: 0, right: 0 };
  const stamp = `${zones.front.toFixed(2)}:${zones.rear.toFixed(2)}:${zones.left.toFixed(2)}:${zones.right.toFixed(2)}`;
  if (stamp !== v.damageStamp) {
    for (const mesh of v.damageMeshes) {
      const position = mesh.geometry.attributes.position;
      const base = mesh.userData.baseDamagePositions;
      if (!position || !base || base.length !== position.array.length) continue;
      for (let i = 0; i < position.count; i++) {
        const offset = i * 3;
        const bx = base[offset];
        const by = base[offset + 1];
        const bz = base[offset + 2];
        const front = bz > 0 ? zones.front : 0;
        const rear = bz < 0 ? zones.rear : 0;
        const right = bx > 0 ? zones.right : 0;
        const left = bx < 0 ? zones.left : 0;
        position.array[offset] = bx * (1 - (left + right) * 0.16)
          + (left - right) * (0.08 + Math.abs(bz) * 0.04);
        position.array[offset + 1] = by - (front + rear + left + right) * (by > 0 ? 0.1 : 0.035);
        position.array[offset + 2] = bz * (1 - (front + rear) * 0.2)
          + (rear - front) * (0.1 + Math.abs(bx) * 0.035);
      }
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }
    if (v.bumper) {
      v.bumper.rotation.z = (zones.left - zones.right) * 0.22;
      v.bumper.position.y = (v.bumperBaseY ?? 0.57) - zones.rear * 0.22;
    }
    v.damageStamp = stamp;
  }

  car.dustClock -= dt;
  const monsterDust = v.monster && p.grounded && p.speed > 4
    && (Math.abs(controls.throttle || 0) > 0.2 || Math.abs(controls.steer || 0) > 0.3);
  if (car.dustClock <= 0 && p.grounded && p.speed > 5 && (monsterDust || p.drifting || !contact.onRoad)) {
    _spawnDust(session, car, monsterDust ? 1.05 + Math.min(0.35, p.speed / 80) : p.drifting ? 1.15 : 0.85, false);
    car.dustClock = monsterDust ? 0.075 : p.drifting ? 0.055 : 0.11;
  }
  car.skidClock -= dt;
  const monsterSkid = v.monster && p.grounded && p.speed > 10 && Math.abs(controls.steer || 0) > 0.52;
  if (car.skidClock <= 0 && p.grounded && p.speed > 7 && (p.drifting || monsterSkid)) {
    spawnRacingSkid(session.racingVfx, car, monsterSkid ? 0.52 : Math.abs(p.lateralSpeed || 0) / 7);
    car.skidClock = state._optReduceMotion ? 0.16 : monsterSkid ? 0.12 : 0.085;
  }
  if (events.boostStarted) {
    for (let i = 0; i < 4; i++) _spawnDust(session, car, 0.7 + i * 0.12, true);
    if (car.id === 'player') {
      _kickCamera(session, events.perfectDrift ? 0.26 : 0.12, 0, events.perfectDrift ? 0.9 : 0.48);
      if (events.perfectDrift) {
        session.perfectDriftChain += 1;
        _awardRallyStyle(
          session,
          260 + session.perfectDriftChain * 90,
          session.perfectDriftChain > 1 ? `PERFECT DRIFT x${session.perfectDriftChain}` : 'PERFECT DRIFT',
          0.6,
        );
      }
      try { sfx.speedBoostActivate(); } catch (_) {}
    }
  }
  if (events.driftOvercooked && car.id === 'player') {
    session.styleCombo = 1;
    session.perfectDriftChain = 0;
    session.styleEvent = 'DRIFT OVERCOOKED';
    session.styleEventTime = 1.1;
  }
  if (events.overheated && car.id === 'player') {
    session.styleEvent = 'TURBO OVERHEAT! COOL IT';
    session.styleEventTime = 1.4;
    _kickCamera(session, 0.18, 0.015, 0.2);
  }
  if (events.jumped && car.id === 'player') {
    try { sfx.weaponDash(); } catch (_) {}
  }
  if (events.landed) {
    car.suspensionKick = 1;
    const impact = clamp((events.landingSpeed || 0) / 15, 0.25, 1.25);
    for (let i = 0; i < 5 + Math.round(impact * 4); i++) _spawnDust(session, car, 0.7 + impact * 0.25, false);
    if (car.id === 'player') {
      const perfect = !!events.perfectLanding;
      const clean = perfect || !!events.cleanLanding || events.landingQuality === 'clean';
      const airTime = Number(events.airTime) || 0;
      session.landCallout = perfect ? 'PURRFECT LANDING!' : clean ? 'CLEAN PAWS!' : 'HEAVY LANDING';
      if (clean) session.landFlash = 0.55;
      else session.crashFlash = Math.max(session.crashFlash, 0.42);
      if (session.raceMode !== 'monster' && airTime >= 0.3) {
        _awardRallyStyle(
          session,
          airTime * 150 + (perfect ? 420 : clean ? 180 : 0),
          perfect ? 'BUTTER LANDING' : clean ? 'CLEAN AIR' : 'BIG AIR',
          perfect ? 0.7 : 0.35,
        );
      }
      _kickCamera(session, perfect ? 0.34 : impact * 0.62, 0, perfect ? 0.78 : impact * 0.38);
      playRacingImpact({ strength: impact, kind: 'landing' });
      _spawnImpactBurst(session, car, impact * 0.72, 'debris');
      if (perfect || impact > 0.92) session.hitStop = Math.max(session.hitStop, perfect ? 0.045 : 0.032);
      try { sfx.hit(); } catch (_) {}
    }
  }
  car.smokeClock -= dt;
  if (p.integrity < 42 && car.smokeClock <= 0) {
    _spawnDamageSmoke(session, car);
    car.smokeClock = 0.08 + p.integrity * 0.006;
  }
}

function _readBest(courseId) {
  try {
    const all = JSON.parse(localStorage.getItem('kks_rally_best_v1') || '{}');
    return Number(all[courseId]) || null;
  } catch (_) { return null; }
}

function _writeBest(courseId, seconds) {
  try {
    const all = JSON.parse(localStorage.getItem('kks_rally_best_v1') || '{}');
    const previous = Number(all[courseId]) || Infinity;
    if (seconds < previous) {
      all[courseId] = seconds;
      localStorage.setItem('kks_rally_best_v1', JSON.stringify(all));
      return true;
    }
  } catch (_) {}
  return false;
}

function _writeHighScore(key, score) {
  try {
    const all = JSON.parse(localStorage.getItem('kks_rally_best_v1') || '{}');
    const previous = Number(all[key]) || 0;
    if (score > previous) {
      all[key] = score;
      localStorage.setItem('kks_rally_best_v1', JSON.stringify(all));
      return true;
    }
  } catch (_) {}
  return false;
}

function _bestKey(session) {
  if (session?.raceMode === 'monster') {
    const event = session.monsterEvent || 'smashdown';
    const prefix = event === 'smashdown' ? 'monster-speedrun-v1' : `monster-${event}`;
    return `${prefix}:${session.monsterArenaDefinition?.id || session.course?.arenaId || 'arena'}`;
  }
  return `${session?.raceMode}:${session?.course?.customTrackId || session?.course?.id}`;
}

function _ordinal(value) {
  const n = Math.max(1, Math.round(value));
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}TH`;
  return `${n}${n % 10 === 1 ? 'ST' : n % 10 === 2 ? 'ND' : n % 10 === 3 ? 'RD' : 'TH'}`;
}

function _drawRestartOptions(session, customCourse = session.course, customTrack = session.customTrack) {
  return {
    mode: 'draw',
    carCount: session.carCount,
    customCourse,
    customTrack,
    playerAvatarId: session.playerAvatarId,
    rosterIds: session.roster.map((avatar) => avatar.id),
    cameraHost: session.cameraHost,
  };
}

function _openDrawEditorFromRace(session) {
  const draft = session.customTrack || session.course.drawDraft;
  window.kkReturnToMenu?.();
  setTimeout(() => window.kkOpenDrawTrackEditor?.(draft), 0);
}

function _restartDrawVariation(session, { reverse = false, reseed = false } = {}) {
  if (session?.raceMode !== 'draw') return false;
  const course = {
    ...session.course,
    points: session.course.points.map((point) => [...point]),
    overpasses: (session.course.overpasses || []).map((bridge) => ({ ...bridge })),
    rampFractions: [...(session.course.rampFractions || [])],
    boostFractions: [...(session.course.boostFractions || [])],
    repairFractions: [...(session.course.repairFractions || [])],
  };
  const draft = { ...(session.customTrack || session.course.drawDraft || {}) };
  if (reverse) {
    course.points = [course.points[0], ...course.points.slice(1).reverse()];
    const flip = (fraction) => ((1 - fraction) % 1 + 1) % 1;
    course.overpasses = course.overpasses.map((bridge) => ({
      ...bridge,
      fraction: flip(bridge.fraction),
      underFraction: Number.isFinite(bridge.underFraction) ? flip(bridge.underFraction) : bridge.underFraction,
    }));
    course.rampFractions = course.rampFractions.map(flip);
    course.boostFractions = course.boostFractions.map(flip);
    course.repairFractions = course.repairFractions.map(flip);
    course.drawDirection = course.drawDirection === 'reverse' ? 'forward' : 'reverse';
    draft.reverse = !draft.reverse;
  }
  if (reseed) {
    const seed = ((Number(course.seed) || Date.now()) + 0x9e3779b9) >>> 0;
    course.seed = seed;
    draft.seed = seed;
  }
  course.drawDraft = { ...(course.drawDraft || {}), ...draft };
  exitRacing(session.scene, session);
  enterRacing(session.scene, course.id, _drawRestartOptions(session, course, draft));
  return true;
}

function _saveDrawTrack(session) {
  if (session?.raceMode !== 'draw') return false;
  try {
    const draft = {
      ...(session.customTrack || session.course.drawDraft),
      name: session.course.name,
      id: session.course.customTrackId,
      stats: session.course.drawStats,
    };
    new TrackGallery().save(draft);
    const button = session.hud?.root?.querySelector('[data-action="save-track"]');
    if (button) button.textContent = 'SAVED ✓';
    return true;
  } catch (error) {
    session.hud.modeStatus.textContent = error.message || 'TRACK COULD NOT BE SAVED';
    return false;
  }
}

async function _shareDrawTrack(session) {
  if (session?.raceMode !== 'draw') return false;
  try {
    const code = TrackCodeCodec.encode(session.customTrack || session.course.drawDraft);
    await navigator.clipboard.writeText(code);
    const button = session.hud?.root?.querySelector('[data-action="share-track"]');
    if (button) button.textContent = 'CODE COPIED ✓';
    return true;
  } catch (error) {
    session.hud.modeStatus.textContent = error.message || 'COPY FAILED';
    return false;
  }
}

function _mountHud(session) {
  const host = document.getElementById('ui-root') || document.body;
  const root = document.createElement('div');
  root.id = 'kk-racing-hud';
  root.className = 'kkr-hud';
  const driftMode = session.raceMode === 'drift';
  const monsterMode = session.raceMode === 'monster';
  const drawMode = session.raceMode === 'draw';
  const freeRide = monsterMode && session.monsterEvent === 'free-ride';
  const timedSmashdown = monsterMode && session.monsterEvent === 'smashdown';
  const scoreMode = driftMode || monsterMode;
  const scoreLabel = timedSmashdown ? 'TOTAL TIME' : monsterMode ? 'ARENA SCORE' : 'DRIFT SCORE';
  const scoreHint = timedSmashdown ? 'BEAT ALL FIVE' : monsterMode ? 'VARY YOUR LINE' : 'LINK THE SLIDE';
  const finishActions = drawMode
    ? '<button data-action="retry" type="button">RACE AGAIN</button><button data-action="edit" type="button">EDIT TRACK</button><button data-action="reverse" type="button">REVERSE</button><button data-action="variation" type="button">NEW SCENERY</button><button data-action="save-track" type="button">SAVE</button><button data-action="share-track" type="button">TRACK CODE</button><button data-action="menu" type="button">MAIN MENU</button>'
    : `<button data-action="retry" type="button">RACE AGAIN</button><button data-action="next" type="button">${monsterMode ? 'GARAGE' : 'NEXT COURSE'}</button><button data-action="menu" type="button">MAIN MENU</button>`;
  root.style.setProperty('--race-accent', `#${session.course.accent.toString(16).padStart(6, '0')}`);
  root.innerHTML = `
    <div class="kkr-vignette"></div>
    <div class="kkr-topbar">
      <section class="kkr-stat kkr-position"><span class="kkr-label">${scoreMode ? scoreLabel : 'POSITION'}</span><strong>${timedSmashdown ? '0:00.000' : scoreMode ? '0' : '1ST'}</strong><small>${scoreMode ? scoreHint : `OF ${session.carCount}`}</small></section>
      <section class="kkr-course"><span class="kkr-kicker">${session.modeDef.name.toUpperCase()} · ${session.course.chapter}</span><h1></h1><span class="kkr-generated"></span></section>
      <section class="kkr-stat kkr-lap"><span class="kkr-label">${monsterMode ? (freeRide ? 'FREE RIDE' : session.monsterEvent === 'freestyle' ? 'FREESTYLE' : 'LEVEL 1 / 5') : scoreMode ? 'TIME LEFT' : 'LAP'}</span><strong>${scoreMode ? `${monsterMode ? (freeRide || timedSmashdown ? '∞' : `${MONSTER_FREESTYLE_SECONDS} SEC`) : `${session.modeDef.duration} SEC`}` : `1 / ${session.course.laps}`}</strong><small class="kkr-best">${timedSmashdown ? 'CARS LEFT' : monsterMode ? (freeRide ? 'F · REFILL' : '2 MIN SCORE') : 'BEST —'}</small></section>
    </div>
    <div class="kkr-timer">0:00.000</div>
    <canvas class="kkr-map" width="${MINIMAP_W}" height="${MINIMAP_H}" aria-label="Course minimap"></canvas>
    <div class="kkr-callout" aria-live="polite"></div>
    <div class="kkr-speed"><strong>000</strong><span>KM/H</span></div>
    <div class="kkr-health"><span>CHASSIS <b>100%</b></span><div><i></i></div><em>${monsterMode ? 'WRECKED TRUCKS RESET AT THE NEAREST SAFE SPAWN' : 'GREEN PIT LANE REPAIRS DAMAGE'}</em></div>
    <div class="kkr-mode-status"></div>
    <div class="kkr-spotlight" aria-live="polite"></div>
    <div class="kkr-drift"><span><b>${monsterMode ? '✦ ZOOMIES' : 'DRIFT CHARGE / TURBO HEAT'}</b><strong class="kkr-charge-value">0%</strong></span><div><i></i></div><em>${monsterMode ? 'SMASH + STUNT TO FILL · HOLD SHIFT TO ZOOM' : 'HOLD SHIFT · GOLD ZONE = PERFECT · RED = OVERCOOKED'}</em></div>
    <div class="kkr-controls"><kbd>W S</kbd> ${monsterMode ? 'GAS / BRAKE · AIR TRIM' : 'GAS / BRAKE'}&nbsp;&nbsp;<kbd>A D</kbd> ${monsterMode ? 'STEER · AIR TRIM' : 'STEER'}&nbsp;&nbsp;<kbd>SHIFT</kbd> ${monsterMode ? 'ZOOMIES · HOLD FOR FLIPS' : 'DRIFT'}&nbsp;&nbsp;<kbd>SPACE</kbd> HANDBRAKE&nbsp;&nbsp;<kbd>+ −</kbd> VIEW${monsterMode ? '&nbsp;&nbsp;<kbd>R</kbd> RECOVER' : ''}${freeRide ? '&nbsp;&nbsp;<kbd>F</kbd> REFILL' : ''}</div>
    <div class="kkr-camera-control">
      <button class="kkr-camera-cycle" type="button" aria-label="Camera: Isometric. Activate to cycle; hold for camera list."><span>CAMERA</span><strong>ISOMETRIC</strong></button>
      <div class="kkr-camera-list" role="menu" aria-label="Racing camera" hidden>
        <button type="button" role="menuitem" data-camera-mode="isometric">ISOMETRIC</button>
        <button type="button" role="menuitem" data-camera-mode="chase">CHASE</button>
        <button type="button" role="menuitem" data-camera-mode="driver_fpv">DRIVER FPV</button>
      </div>
    </div>
    <button class="kkr-menu" type="button">MENU</button>
    <div class="kkr-touch">
      <button class="kkr-hop-btn" type="button" aria-label="Hold handbrake">BRAKE</button>
      <button class="kkr-drift-btn" type="button" aria-label="Drift">DRIFT</button>
      ${monsterMode ? '<button class="kkr-recover-btn" type="button" aria-label="Recover truck">RESET</button>' : ''}
      ${freeRide ? '<button class="kkr-refill-btn" type="button" aria-label="Refill destruction targets">REFILL</button>' : ''}
    </div>
    <div class="kkr-finish" hidden>
      <div class="kkr-finish-card">
        <span class="kkr-finish-kicker">${monsterMode ? 'FIVE LEVELS COMPLETE' : driftMode ? 'TIME' : 'CHECKERED FLAG'}</span>
        <h2>${monsterMode ? 'ARENA CHAMPION!' : driftMode ? 'BANKED!' : 'FINISH!'}</h2>
        <strong class="kkr-finish-pos">1ST PLACE</strong>
        <div class="kkr-finish-metrics"${monsterMode ? '' : ' hidden'}>
          <span><strong data-result="crushed">0</strong><small data-result-label="crushed">CARS CRUSHED</small></span>
          <span><strong data-result="chain">—</strong><small data-result-label="chain">FASTEST LEVEL</small></span>
          <span><strong data-result="trick">0 / 5</strong><small data-result-label="trick">LEVELS CLEARED</small></span>
        </div>
        <p class="kkr-finish-time">0:00.000</p>
        <p class="kkr-finish-breakdown"></p>
        <p class="kkr-finish-best"></p>
        <div class="kkr-finish-actions">${finishActions}</div>
      </div>
    </div>`;
  root.querySelector('.kkr-course h1').textContent = session.course.name;
  root.querySelector('.kkr-generated').textContent = monsterMode
    ? `${session.monsterVehicleProfile.name.toUpperCase()} · ${session.monsterEvent.replace('-', ' ').toUpperCase()} · ${session.monsterArenaDefinition.districts.length} DISTRICTS`
    : drawMode
      ? `${session.course.drawSizeId.toUpperCase()} · ${Math.round(session.course.drawStats?.length || 0)} M · ${session.course.overpasses?.length || 0} OVERPASS${session.course.overpasses?.length === 1 ? '' : 'ES'} · ${session.course.drawStats?.personality || 'DRAWN CIRCUIT'}`
    : session.course.detailTexture ? 'VERTEX × GROK TERRAIN' : 'GENERATED CHAPTER TERRAIN';
  host.appendChild(root);
  if (new URLSearchParams(window.location.search).has('qa') && monsterMode) {
    const qaSmash = document.createElement('button');
    qaSmash.type = 'button';
    qaSmash.className = 'kkr-qa-smash';
    qaSmash.setAttribute('aria-label', 'QA crush target');
    qaSmash.addEventListener('click', () => {
      session.countdown = 0;
      session.phase = 'racing';
      _warpMonsterTarget(session, session.monsterArena.destroyed);
    });
    root.appendChild(qaSmash);
  }
  const bestKey = _bestKey(session);
  const best = _readBest(bestKey);
  root.querySelector('.kkr-best').textContent = best
    ? (timedSmashdown ? `PB ${formatRaceTime(best)}` : scoreMode ? `BEST ${Math.round(best).toLocaleString()}` : `BEST ${formatRaceTime(best)}`)
    : 'BEST —';
  if (timedSmashdown) root.querySelector('.kkr-position small').textContent = best ? `PB ${formatRaceTime(best)}` : 'BEAT ALL FIVE';
  else if (monsterMode) root.querySelector('.kkr-best').textContent = '2 MIN SCORE';
  if (freeRide) root.querySelector('.kkr-best').textContent = 'F · REFILL';
  if (monsterMode && !timedSmashdown) root.querySelector('.kkr-position small').textContent = best ? `PB ${Math.round(best).toLocaleString()}` : 'PB —';
  root.querySelector('.kkr-menu').addEventListener('click', () => window.kkReturnToMenu?.());
  const driftButton = root.querySelector('.kkr-drift-btn');
  if (monsterMode) {
    driftButton.textContent = 'ZOOM';
    driftButton.setAttribute('aria-label', 'Spend Zoomies boost');
  }
  const releaseDrift = () => { _touchDrift = false; driftButton.classList.remove('is-held'); };
  driftButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    driftButton.setPointerCapture?.(event.pointerId);
    _touchDrift = true;
    driftButton.classList.add('is-held');
  });
  driftButton.addEventListener('pointerup', releaseDrift);
  driftButton.addEventListener('pointercancel', releaseDrift);
  const handbrakeButton = root.querySelector('.kkr-hop-btn');
  const releaseHandbrake = () => { _touchHandbrake = false; handbrakeButton.classList.remove('is-held'); };
  handbrakeButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handbrakeButton.setPointerCapture?.(event.pointerId);
    _touchHandbrake = true;
    handbrakeButton.classList.add('is-held');
  });
  handbrakeButton.addEventListener('pointerup', releaseHandbrake);
  handbrakeButton.addEventListener('pointercancel', releaseHandbrake);
  root.querySelector('.kkr-recover-btn')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    session.recoverQueued = true;
  });
  root.querySelector('.kkr-refill-btn')?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    session.refillQueued = true;
  });
  root.querySelector('[data-action="retry"]').addEventListener('click', () => restartRacing(session.scene));
  root.querySelector('[data-action="next"]')?.addEventListener('click', () => {
    if (monsterMode) window.kkReturnToMenu?.();
    else restartRacing(session.scene, nextCourseId(session.course.id));
  });
  root.querySelector('[data-action="edit"]')?.addEventListener('click', () => _openDrawEditorFromRace(session));
  root.querySelector('[data-action="reverse"]')?.addEventListener('click', () => _restartDrawVariation(session, { reverse: true }));
  root.querySelector('[data-action="variation"]')?.addEventListener('click', () => _restartDrawVariation(session, { reseed: true }));
  root.querySelector('[data-action="save-track"]')?.addEventListener('click', () => _saveDrawTrack(session));
  root.querySelector('[data-action="share-track"]')?.addEventListener('click', () => _shareDrawTrack(session));
  root.querySelector('[data-action="menu"]').addEventListener('click', () => window.kkReturnToMenu?.());
  session.hud = {
    root,
    position: root.querySelector('.kkr-position strong'),
    positionHint: root.querySelector('.kkr-position small'),
    lap: root.querySelector('.kkr-lap strong'),
    lapLabel: root.querySelector('.kkr-lap .kkr-label'),
    best: root.querySelector('.kkr-best'),
    timer: root.querySelector('.kkr-timer'),
    speed: root.querySelector('.kkr-speed strong'),
    driftFill: root.querySelector('.kkr-drift i'),
    chargeValue: root.querySelector('.kkr-charge-value'),
    drift: root.querySelector('.kkr-drift'),
    callout: root.querySelector('.kkr-callout'),
    map: root.querySelector('.kkr-map'),
    finish: root.querySelector('.kkr-finish'),
    health: root.querySelector('.kkr-health'),
    healthFill: root.querySelector('.kkr-health i'),
    healthText: root.querySelector('.kkr-health b'),
    modeStatus: root.querySelector('.kkr-mode-status'),
    spotlight: root.querySelector('.kkr-spotlight'),
  };
  root.classList.toggle('is-free-ride', freeRide);
  root.classList.toggle('is-timed-smashdown', timedSmashdown);
}

function _buildMonsterReplayPresentation(session, root, owned) {
  const predictorGeometry = new THREE.RingGeometry(1.05, 1.42, 32);
  predictorGeometry.rotateX(-Math.PI / 2);
  const predictorMaterial = new THREE.MeshBasicMaterial({
    color: 0x7ef6ff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    toneMapped: false,
  });
  const predictor = new THREE.Mesh(predictorGeometry, predictorMaterial);
  predictor.name = 'monster-landing-predictor';
  predictor.renderOrder = 3;
  predictor.visible = false;
  root.add(predictor);
  owned.geometries.add(predictorGeometry);
  owned.materials.add(predictorMaterial);
  session.monsterLandingPredictor = predictor;

  const route = session.monsterRecordRun?.previousRoute || [];
  if (route.length < 2 || !['freestyle', 'free-ride'].includes(session.monsterEvent)) return;
  const geometry = new THREE.BufferGeometry().setFromPoints(route.map((point) => new THREE.Vector3(point.x, 0.075, point.z)));
  const material = new THREE.LineBasicMaterial({
    color: 0xff78c8,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    toneMapped: false,
  });
  const ghost = new THREE.Line(geometry, material);
  ghost.name = 'monster-personal-best-route';
  ghost.frustumCulled = true;
  root.add(ghost);
  owned.geometries.add(geometry);
  owned.materials.add(material);
  session.monsterGhostRoute = ghost;
}

function _updateMonsterLandingPredictor(session, kart) {
  const marker = session?.monsterLandingPredictor;
  if (!marker || !kart || state._optReduceMotion) {
    if (marker) marker.visible = false;
    return;
  }
  const clearance = kart.y - (kart.groundHeight || 0);
  if (kart.grounded || clearance < 4.5) {
    marker.visible = false;
    return;
  }
  const gravity = Math.max(8, session.monsterVehicleProfile?.tuning?.gravity || 20.5);
  let ground = kart.groundHeight || 0;
  let time = clamp((kart.vy + Math.sqrt(Math.max(0, kart.vy * kart.vy + 2 * gravity * Math.max(0, kart.y - ground)))) / gravity, 0.18, 2.35);
  let x = kart.x + kart.vx * time;
  let z = kart.z + kart.vz * time;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    ground = queryMonsterArenaGround(x, z, session.monsterArenaDefinition).height;
    time = clamp((kart.vy + Math.sqrt(Math.max(0, kart.vy * kart.vy + 2 * gravity * Math.max(0, kart.y - ground)))) / gravity, 0.18, 2.35);
    x = kart.x + kart.vx * time;
    z = kart.z + kart.vz * time;
  }
  marker.visible = true;
  marker.position.set(x, ground + 0.09, z);
  const scale = 0.85 + clamp(time / 2, 0, 0.55);
  marker.scale.setScalar(scale);
  marker.material.opacity = 0.26 + Math.sin(session.raceTime * 6) * 0.06;
}

function _startMonsterRound(session, index) {
  const rounds = session.monsterRounds;
  rounds.index = index;
  rounds.timeRemaining = rounds.mode === 'freestyle' ? MONSTER_FREESTYLE_SECONDS : Infinity;
  rounds.roundElapsed = 0;
  rounds.transitionTime = 0;
  const round = currentMonsterRound(rounds);
  configureMonsterDestructionRound(session.monsterArena, round.targetIds);
  session.monsterScore.totalTargets = round.targetIds.length;
  session.monsterSpotlight = rounds.mode === 'smashdown'
    ? null
    : createMonsterSpotlight(
        session.monsterArena,
        round,
        session.monsterScore,
        Math.min(4, session.monsterSpotlightSerial),
        session.monsterSpotlightSerial,
      );
  session.roundFlash = 1.35;
  session.roundCallout = rounds.mode === 'smashdown'
    ? `LEVEL ${round.number} · ${round.name}`
    : round.name;
}

function _recoverMonsterTruck(session, automatic = false) {
  const kart = session?.cars?.[0]?.physics;
  if (!kart || session.raceMode !== 'monster' || kart.recoveryCooldown > 0) return false;
  respawnMonsterKart(session.monsterArenaView, kart);
  initializeMonsterVehiclePhysics(kart, session.monsterVehicleProfile);
  repairKart(kart, automatic ? 24 : 16);
  kart.recoveryCooldown = 3;
  kart.immobilizedTime = 0;
  kart.landingType = '';
  session.recoveryTime = 0.34;
  session.monsterScore.chaos = Math.max(0, session.monsterScore.chaos - (automatic ? 12 : 20));
  breakMonsterChain(session.monsterScore, automatic ? 'AUTO RECOVERY' : 'RECOVERY');
  session.cameraManager?.onVehicleRespawned();
  session.rescueFlash = 0.8;
  session.roundFlash = 0.8;
  session.roundCallout = automatic ? 'AUTO RECOVERY' : 'RECOVERY · -20 ZOOMIES';
  return true;
}

function _tickMonsterRecovery(session, dt, controls) {
  if (session?.raceMode !== 'monster') return;
  const kart = session.cars?.[0]?.physics;
  if (!kart) return;
  session.recoveryTime = Math.max(0, (session.recoveryTime || 0) - dt);
  if (session.recoverQueued || gamepadState.justPressed?.y) {
    session.recoverQueued = false;
    _recoverMonsterTruck(session, false);
    return;
  }
  if (session.refillQueued) {
    session.refillQueued = false;
    if (session.monsterEvent === 'free-ride') {
      const reset = refillMonsterDestruction(session.monsterArena, kart);
      breakMonsterChain(session.monsterScore, 'ARENA REFILL');
      session.roundFlash = 0.8;
      session.roundCallout = reset ? `${reset} TARGETS REFILLED` : 'MOVE CLEAR TO REFILL';
    }
  }
  const upset = ['roof', 'left-side', 'right-side', 'belly'].includes(kart.landingType)
    || Math.abs(normalizeAngle(kart.stuntRoll || 0)) > 1.15
    || Math.abs(normalizeAngle(kart.stuntPitch || 0)) > 1.55;
  const tryingToMove = Math.abs(Number(controls?.throttle) || 0) > 0.45;
  const trapped = kart.speed < 0.65 && tryingToMove
    && (upset || (kart.groundedWheelCount ?? 4) <= 1);
  kart.immobilizedTime = trapped ? (kart.immobilizedTime || 0) + dt : 0;
  if (kart.immobilizedTime >= 2.6) _recoverMonsterTruck(session, true);
}

function _installMonsterControls(session) {
  if (session?.raceMode !== 'monster' || typeof window === 'undefined') return;
  session.monsterKeyHandler = (event) => {
    if (event.repeat || state.racing !== session) return;
    if (event.code === 'KeyR') session.recoverQueued = true;
    if (event.code === 'KeyF' && session.monsterEvent === 'free-ride') session.refillQueued = true;
  };
  window.addEventListener('keydown', session.monsterKeyHandler);
}

function _tickMonsterRound(session, dt) {
  const rounds = session.monsterRounds;
  if (!rounds) return;
  const round = currentMonsterRound(rounds);
  if (session.phase === 'racing') {
    const spotlightEvent = session.monsterSpotlight
      ? stepMonsterSpotlight(
          session.monsterSpotlight,
          session.monsterArena,
          session.monsterScore,
          dt,
        )
      : {};
    if (spotlightEvent.completed && !session.monsterSpotlight.rewarded) {
      const spotlight = session.monsterSpotlight;
      spotlight.rewarded = true;
      session.monsterScore.chaos = clamp(
        session.monsterScore.chaos + spotlight.rewardZoomies,
        0,
        100,
      );
      awardMonsterEvent(session.monsterScore, 620, `SPOTLIGHT · ${spotlight.label}`, 'spotlight', {
        tier: 'major',
        chaos: 0,
        comboGain: 0.42,
      });
      session.roundFlash = 1.25;
      session.roundCallout = `SPOTLIGHT CLEAR · +${spotlight.rewardZoomies} ZOOMIES`;
      try { sfx.victory(); } catch (_) {}
    } else if (spotlightEvent.expired && rounds.mode === 'free-ride') {
      session.monsterSpotlightSerial += 1;
      session.monsterSpotlight = createMonsterSpotlight(
        session.monsterArena,
        round,
        session.monsterScore,
        Math.min(4, session.monsterSpotlightSerial),
        session.monsterSpotlightSerial,
      );
    }
  }
  if (rounds.mode === 'free-ride') return;
  if (rounds.mode === 'freestyle') {
    if (session.phase !== 'racing') return;
    rounds.timeRemaining = Math.max(0, rounds.timeRemaining - dt);
    if (rounds.timeRemaining <= 0) {
      rounds.won = true;
      _finishPlayer(session);
    }
    return;
  }
  if (session.phase === 'racing') {
    rounds.elapsedTime += dt;
    rounds.roundElapsed += dt;
    const destroyed = activeMonsterRoundDestroyed(rounds, session.monsterArena);
    if (destroyed >= round.targetIds.length) {
      rounds.totalCrushed += destroyed;
      rounds.roundTimes.push(rounds.roundElapsed);
      if (rounds.index >= rounds.rounds.length - 1) {
        rounds.won = true;
        _finishPlayer(session);
      } else {
        session.phase = 'round-transition';
        rounds.transitionTime = 1.45;
        session.roundFlash = 1.45;
        session.roundCallout = `LEVEL CLEAR · ${formatRaceTime(rounds.roundElapsed)}`;
        try { sfx.victory(); } catch (_) {}
      }
    }
  } else if (session.phase === 'round-transition') {
    rounds.transitionTime -= dt;
    if (rounds.transitionTime <= 0) {
      _startMonsterRound(session, rounds.index + 1);
      session.phase = 'racing';
      session.goFlash = 0.55;
    }
  }
}

function _drawMinimap(session) {
  const canvas = session.hud?.map;
  if (!canvas || session.raceMode === 'monster') return;
  const ctx = canvas.getContext('2d');
  const { minX, maxX, minZ, maxZ } = session.mapBounds;
  const margin = 15;
  const scale = Math.min((MINIMAP_W - margin * 2) / (maxX - minX), (MINIMAP_H - margin * 2) / (maxZ - minZ));
  const project = (x, z) => [
    margin + (x - minX) * scale,
    MINIMAP_H - margin - (z - minZ) * scale,
  ];
  ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  session.samples.forEach((sample, index) => {
    const [x, y] = project(sample.x, sample.z);
    if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = 'rgba(10,6,12,.72)';
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.strokeStyle = `#${session.course.curb.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 5;
  ctx.stroke();
  if (session.raceMode === 'draw' && session.course.overpasses?.length) {
    ctx.strokeStyle = '#79e9ff';
    ctx.lineWidth = 3;
    for (let i = 0; i < session.samples.length; i++) {
      const sample = session.samples[i];
      const next = session.samples[(i + 1) % session.samples.length];
      if ((sample.y || 0) < 1 || (next.y || 0) < 1) continue;
      const [ax, ay] = project(sample.x, sample.z);
      const [bx, by] = project(next.x, next.z);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }
  const start = session.samples[0];
  if (start) {
    const half = session.course.trackWidth * 0.58;
    const [ax, ay] = project(start.x + start.normal.x * half, start.z + start.normal.z * half);
    const [bx, by] = project(start.x - start.normal.x * half, start.z - start.normal.z * half);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.strokeStyle = '#fff7dd'; ctx.lineWidth = 3; ctx.stroke();
  }
  for (const car of session.cars) {
    const [x, y] = project(car.physics.x, car.physics.z);
    ctx.beginPath();
    ctx.arc(x, y, car.id === 'player' ? 5.2 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = car.id === 'player' ? '#fff7dd' : `#${session.course.kartColors[car.gridIndex].toString(16).padStart(6, '0')}`;
    ctx.fill();
    if (car.id === 'player') {
      ctx.strokeStyle = '#161018';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function _updateHud(session) {
  const hud = session.hud;
  if (!hud) return;
  const player = session.cars[0].physics;
  const ranking = rankRaceCars(session.cars, session.samples.length);
  const position = ranking.findIndex((car) => car.id === 'player') + 1;
  if (session.raceMode === 'monster') {
    const monster = session.monsterScore;
    const rounds = session.monsterRounds;
    const round = currentMonsterRound(rounds);
    const timedSmashdown = rounds.mode === 'smashdown';
    const destroyed = activeMonsterRoundDestroyed(rounds, session.monsterArena);
    const carsLeft = Math.max(0, round.targetIds.length - destroyed);
    hud.position.textContent = timedSmashdown
      ? formatRaceTime(rounds.elapsedTime)
      : Math.round(monster.score).toLocaleString();
    hud.lapLabel.textContent = rounds.mode === 'free-ride' ? 'FREE RIDE'
      : rounds.mode === 'freestyle' ? 'FREESTYLE' : `LEVEL ${round.number} / ${rounds.rounds.length}`;
    hud.lap.textContent = rounds.mode === 'free-ride'
      ? '∞'
      : timedSmashdown ? '∞' : `${Math.max(0, Math.ceil(rounds.timeRemaining))} SEC`;
    hud.best.textContent = rounds.mode === 'free-ride'
      ? 'F · REFILL'
      : rounds.mode === 'freestyle' ? '2 MIN SCORE' : `${carsLeft} CAR${carsLeft === 1 ? '' : 'S'} LEFT`;
    hud.timer.textContent = timedSmashdown
      ? `${carsLeft} TO CRUSH · ${round.name}`
      : monster.wreckChain > 1.05 ? `${monster.wreckChain.toFixed(1)}× WRECK CHAIN` : 'FIND A NEW LINE';
  } else if (session.raceMode === 'drift') {
    hud.position.textContent = Math.round(session.driftScore).toLocaleString();
    hud.lap.textContent = `${Math.max(0, Math.ceil(session.modeDef.duration - session.raceTime))} SEC`;
    hud.timer.textContent = session.driftCombo > 1.05 ? `${session.driftCombo.toFixed(1)}× COMBO` : 'LINK A DRIFT';
  } else {
    hud.position.textContent = _ordinal(position);
    hud.lap.textContent = `${Math.min(session.course.laps, player.completedLaps + 1)} / ${session.course.laps}`;
    hud.timer.textContent = formatRaceTime(session.raceTime);
  }
  hud.speed.textContent = String(Math.round(player.speed * 7.4)).padStart(3, '0');
  const charge = session.raceMode === 'monster'
    ? clamp(session.monsterScore.chaos / 100, 0, 1)
    : Math.max(clamp(player.driftCharge / 2.6, 0, 1), clamp(player.boostHeat || 0, 0, 1));
  hud.driftFill.style.transform = `scaleX(${charge})`;
  hud.chargeValue.textContent = `${Math.round(charge * 100)}%`;
  hud.drift.classList.toggle('is-drifting', session.raceMode === 'monster' ? charge > 0.1 : player.drifting);
  hud.drift.classList.toggle('is-boosting', player.boostTime > 0);
  hud.drift.classList.toggle('is-perfect', !!player.driftPerfectWindow);
  hud.drift.classList.toggle('is-danger', player.driftCharge > 2.28 || (player.boostHeat || 0) > 0.88);
  hud.drift.classList.toggle('is-overheated', !!player.overheated);
  hud.healthFill.style.transform = `scaleX(${clamp(player.integrity / 100, 0, 1)})`;
  hud.healthText.textContent = `${Math.round(player.integrity)}%`;
  hud.health.classList.toggle('is-critical', player.integrity < 30);
  hud.root.classList.toggle(
    'is-timer-urgent',
    session.raceMode === 'monster' && session.phase === 'racing'
      && session.monsterRounds.mode === 'freestyle'
      && Number.isFinite(session.monsterRounds.timeRemaining)
      && session.monsterRounds.timeRemaining <= 10,
  );
  if (session.raceMode === 'draw' && session.wrongWay) hud.modeStatus.textContent = 'WRONG WAY · TURN AROUND';
  else if (player.wrecked) hud.modeStatus.textContent = session.raceMode === 'monster' ? 'WRECKED · SAFE RESET INCOMING' : 'WRECKED · REPAIR REQUIRED';
  else if (player.repairTime > 0) hud.modeStatus.textContent = 'PIT CREW · REPAIRING';
  else if (player.overheated) hud.modeStatus.textContent = 'TURBO HOT · RELEASE SHIFT TO COOL';
  else if (session.raceMode === 'monster' && session.monsterScore.pendingTrick?.label) {
    hud.modeStatus.textContent = `PENDING · ${session.monsterScore.pendingTrick.label} · ${session.monsterScore.pendingTrick.points.toLocaleString()}`;
  }
  else if (session.raceMode === 'monster' && session.monsterScore.lastEventTime > 0) hud.modeStatus.textContent = session.monsterScore.lastEvent;
  else if (session.raceMode === 'monster' && session.raceTime < 2) hud.modeStatus.textContent = 'SMASH CARS → EARN ZOOMIES';
  else if (session.raceMode === 'monster' && session.raceTime < 4) hud.modeStatus.textContent = 'HOLD SHIFT → SPEND ZOOMIES';
  else if (session.raceMode === 'monster' && session.raceTime < 6) hud.modeStatus.textContent = 'USE RAMPS → CONTROL THE TRUCK → LAND FLAT';
  else if (session.raceMode === 'monster') {
    const round = currentMonsterRound(session.monsterRounds);
    const targetStatus = session.monsterEvent === 'free-ride'
      ? `${session.monsterArena.destroyed} WRECKS · ${round.name}`
      : `${activeMonsterRoundDestroyed(session.monsterRounds, session.monsterArena)} / ${round.targetIds.length} CRUSHED · ${round.name}`;
    hud.modeStatus.textContent = `${targetStatus} · BEST ${session.monsterScore.bestTrick}`;
  }
  else if ((player.shortcutTime || 0) > 0.12) hud.modeStatus.textContent = 'SHORTCUT · HOLD THE LOOSE LINE';
  else if (session.styleEventTime > 0) hud.modeStatus.textContent = `${session.styleEvent} · ${session.styleCombo.toFixed(1)}× STYLE`;
  else if (player.draftStrength > 0.2) hud.modeStatus.textContent = `DRAFT ${Math.round(player.draftStrength * 100)}%`;
  else if (player.integrity < 70) hud.modeStatus.textContent = 'HANDLING & POWER DAMAGED';
  else if (session.styleScore > 0) hud.modeStatus.textContent = `${Math.round(session.styleScore).toLocaleString()} STYLE · ${session.styleCombo.toFixed(1)}×`;
  else hud.modeStatus.textContent = '';
  const renderInfo = getRendererDiagnostics(state);
  hud.root.dataset.raceMode = session.raceMode;
  hud.root.classList.toggle('is-controls-faded', session.phase === 'racing' && session.raceTime > 12);
  hud.root.classList.toggle('is-intro-over', session.raceMode === 'monster' && session.phase === 'racing' && session.raceTime > 6);
  hud.root.dataset.cars = String(session.carCount);
  hud.root.dataset.triangles = String(renderInfo.triangles || 0);
  hud.root.dataset.drawCalls = String(renderInfo.drawCalls || 0);
  hud.root.dataset.fps = String(Math.round(1 / Math.max(1 / 240, session.frameTimeEma || 1 / 60)));
  hud.root.dataset.assetCount = String(getRallyAssetCacheSnapshot().length);
  hud.root.dataset.assetError = session.assetError || '';
  hud.root.dataset.drivers = session.cars.map((car) => car.avatarId).join(',');
  hud.root.dataset.showcaseDrivers = String(session.cars.filter((car) => car.renderTier === 'showcase').length);
  if (session.raceMode === 'monster') {
    const spotlight = session.monsterSpotlight;
    if (hud.spotlight) {
      hud.spotlight.textContent = spotlight
        ? `SPOTLIGHT · ${spotlight.label} · ${Math.floor(spotlight.progress)} / ${spotlight.goal}`
        : '';
      hud.spotlight.classList.toggle('is-complete', !!spotlight?.completed);
    }
    hud.root.dataset.smashScore = String(Math.round(session.monsterScore.score));
    hud.root.dataset.smashCombo = String(session.monsterScore.combo.toFixed(2));
    hud.root.dataset.chaos = String(session.monsterScore.chaos.toFixed(2));
    hud.root.dataset.vehicle = session.monsterVehicleId;
    hud.root.dataset.district = monsterArenaContact(session.monsterArenaView, player).district;
    hud.root.dataset.obstacles = String(currentMonsterRound(session.monsterRounds).targetIds.length);
    hud.root.dataset.destroyed = String(activeMonsterRoundDestroyed(session.monsterRounds, session.monsterArena));
    hud.root.dataset.round = String(session.monsterRounds.index + 1);
    hud.root.dataset.roundTime = Number.isFinite(session.monsterRounds.timeRemaining)
      ? session.monsterRounds.timeRemaining.toFixed(2)
      : 'free';
    hud.root.dataset.runTime = session.monsterRounds.elapsedTime.toFixed(3);
    hud.root.dataset.roundElapsed = session.monsterRounds.roundElapsed.toFixed(3);
    hud.root.dataset.monsterEvent = session.monsterEvent;
    hud.root.dataset.pendingTrick = session.monsterScore.pendingTrick?.label || '';
  }
  session.rescueFlash = Math.max(0, session.rescueFlash - state.time.dt);
  session.landFlash = Math.max(0, session.landFlash - state.time.dt);
  session.crashFlash = Math.max(0, session.crashFlash - state.time.dt);
  session.smashFlash = Math.max(0, (session.smashFlash || 0) - state.time.dt);
  session.roundFlash = Math.max(0, (session.roundFlash || 0) - state.time.dt);
  if (session.phase === 'countdown') {
    const count = Math.ceil(session.countdown);
    hud.callout.textContent = count > 3 ? 'READY?' : String(Math.max(1, count));
    hud.callout.className = 'kkr-callout is-visible';
  } else if (session.goFlash > 0) {
    hud.callout.textContent = 'GO!';
    hud.callout.className = 'kkr-callout is-visible is-go';
  } else if (session.roundFlash > 0) {
    hud.callout.textContent = session.roundCallout;
    hud.callout.className = 'kkr-callout is-visible is-small is-round';
  } else if (session.smashFlash > 0) {
    hud.callout.textContent = session.monsterScore.lastEvent || 'SMASH!';
    hud.callout.className = 'kkr-callout is-visible is-small is-smash';
  } else if (session.rescueFlash > 0) {
    hud.callout.textContent = 'RESCUE!';
    hud.callout.className = 'kkr-callout is-visible';
  } else if (session.landFlash > 0) {
    hud.callout.textContent = session.landCallout || 'NICE LANDING!';
    hud.callout.className = 'kkr-callout is-visible is-small';
  } else if (session.crashFlash > 0.15) {
    hud.callout.textContent = player.integrity < 30 ? 'CRITICAL DAMAGE!' : 'CRUNCH!';
    hud.callout.className = 'kkr-callout is-visible is-small is-crash';
  } else {
    hud.callout.className = 'kkr-callout';
  }
  _drawMinimap(session);
  return position;
}

function _finishMonsterRecords(session) {
  if (session?.raceMode !== 'monster' || !session.monsterRecordRun) return null;
  if (session.monsterRecordRun.saved) return session.monsterRecordResult;
  session.monsterRecordResult = finishMonsterRecordRun(session.monsterRecordRun, {
    score: session.monsterScore.score,
    wreckChain: session.monsterScore.bestWreckChain,
    airTime: session.monsterScore.bestAirTime,
    trick: session.monsterScore.bestTrick,
    trickPoints: session.monsterScore.bestTrickPoints,
    completionTime: session.monsterRounds.won && session.monsterRounds.mode === 'smashdown'
      ? session.monsterRounds.elapsedTime
      : 0,
  });
  return session.monsterRecordResult;
}

function _finishPlayer(session) {
  if (session.phase === 'finished') return;
  session.phase = 'finished';
  const player = session.cars[0].physics;
  player.finished = true;
  player.finishTime = session.raceTime;
  const ranking = rankRaceCars(session.cars, session.samples.length);
  const position = ranking.findIndex((car) => car.id === 'player') + 1;
  const driftMode = session.raceMode === 'drift';
  const monsterMode = session.raceMode === 'monster';
  if (monsterMode) _finishMonsterRecords(session);
  const scoreMode = session.modeDef.objective !== 'laps';
  const monsterTime = monsterMode ? session.monsterRounds.elapsedTime : 0;
  const monsterFreestyle = monsterMode && session.monsterEvent === 'freestyle';
  const score = monsterMode ? (monsterFreestyle ? session.monsterScore.score : monsterTime) : session.driftScore;
  const bestKey = _bestKey(session);
  const newBest = monsterMode && !monsterFreestyle
    ? (session.monsterRounds.won ? _writeBest(bestKey, monsterTime) : false)
    : scoreMode
      ? _writeHighScore(bestKey, score)
      : _writeBest(bestKey, session.raceTime);
  if (session.raceMode === 'draw' && session.course.customTrackId) {
    try {
      const gallery = new TrackGallery();
      if (gallery.get(session.course.customTrackId)) {
        gallery.recordRace(session.course.customTrackId, {
          lapTime: session.raceTime / Math.max(1, session.course.laps),
          result: { position, raceTime: session.raceTime, direction: session.course.drawDirection },
          vehicle: session.playerAvatarId,
        });
      }
    } catch (_) {}
  }
  const finish = session.hud.finish;
  finish.hidden = false;
  const monsterRank = monsterMode
    ? (monsterFreestyle
        ? score >= 45000 ? 'S' : score >= 30000 ? 'A' : score >= 18000 ? 'B' : score >= 9000 ? 'C' : 'D'
        : monsterRoundRank(monsterTime, session.monsterRounds.won))
    : 'D';
  if (monsterMode) {
    finish.querySelector('.kkr-finish-kicker').textContent = monsterFreestyle
      ? 'TWO-MINUTE FREESTYLE COMPLETE'
      : session.monsterRounds.won ? 'FIVE LEVELS COMPLETE' : `TIME UP · LEVEL ${session.monsterRounds.index + 1}`;
    finish.querySelector('h2').textContent = monsterFreestyle
      ? 'RUN BANKED!'
      : session.monsterRounds.won ? 'ARENA CHAMPION!' : 'SO CLOSE!';
  }
  finish.querySelector('.kkr-finish-pos').textContent = scoreMode
    ? (monsterMode ? `${monsterRank} · ${monsterFreestyle ? `${Math.round(score).toLocaleString()} PTS` : formatRaceTime(monsterTime)}` : `${Math.round(score).toLocaleString()} POINTS`)
    : `${_ordinal(position)} PLACE`;
  const finishMetrics = finish.querySelector('.kkr-finish-metrics');
  if (monsterMode && finishMetrics) {
    const currentDestroyed = activeMonsterRoundDestroyed(session.monsterRounds, session.monsterArena);
    finishMetrics.querySelector('[data-result="crushed"]').textContent = `${session.monsterRounds.totalCrushed + (session.monsterRounds.won ? 0 : currentDestroyed)} TOTAL`;
    if (monsterFreestyle) {
      finishMetrics.querySelector('[data-result="chain"]').textContent = `${session.monsterScore.bestWreckChain.toFixed(1)}×`;
      finishMetrics.querySelector('[data-result-label="chain"]').textContent = 'BEST CHAIN';
      finishMetrics.querySelector('[data-result="trick"]').textContent = session.monsterScore.bestTrick || 'FIRST DENT';
      finishMetrics.querySelector('[data-result-label="trick"]').textContent = 'TOP TRICK';
    } else {
      const fastest = session.monsterRounds.roundTimes.length
        ? Math.min(...session.monsterRounds.roundTimes)
        : 0;
      finishMetrics.querySelector('[data-result="chain"]').textContent = fastest > 0 ? formatRaceTime(fastest) : '—';
      finishMetrics.querySelector('[data-result-label="chain"]').textContent = 'FASTEST LEVEL';
      finishMetrics.querySelector('[data-result="trick"]').textContent = `${session.monsterRounds.roundTimes.length} / 5`;
      finishMetrics.querySelector('[data-result-label="trick"]').textContent = 'LEVELS CLEARED';
    }
  }
  finish.querySelector('.kkr-finish-time').textContent = monsterMode
    ? (monsterFreestyle
        ? `${Math.round(score).toLocaleString()} POINTS · 120 SEC`
        : `${session.monsterRounds.won ? 'TOTAL' : 'RUN TIME'} ${formatRaceTime(monsterTime)} · ${session.monsterRounds.roundTimes.length} / 5 LEVELS`)
    : driftMode ? `BEST COMBO ${session.bestDriftCombo.toFixed(1)}×`
    : `${formatRaceTime(session.raceTime)} · ${Math.round(session.styleScore || 0).toLocaleString()} STYLE`;
  finish.querySelector('.kkr-finish-breakdown').textContent = monsterMode
    ? (monsterFreestyle
        ? `FREESTYLE COMPLETE · ${Object.entries(session.monsterScore.classCrushes)
            .filter(([, count]) => count > 0)
            .map(([kind, count]) => `${kind.toUpperCase()} ${count}`)
            .join(' · ') || 'NO CLASS CRUSHES'} · AIR ${session.monsterScore.totalAirTime.toFixed(1)} SEC`
        : `${session.monsterRounds.won ? 'ALL FIVE LEVELS CLEARED' : 'LEVEL TIMER EXPIRED'} · SPLITS ${session.monsterRounds.roundTimes.map((time, index) => `L${index + 1} ${time.toFixed(1)}S`).join(' · ') || '—'}`)
    : '';
  const stored = _readBest(bestKey) || (scoreMode ? score : session.raceTime);
  finish.querySelector('.kkr-finish-best').textContent = newBest
    ? (monsterMode ? 'NEW FIVE-LEVEL SPEEDRUN RECORD!' : driftMode ? 'NEW DRIFT RECORD!' : 'NEW COURSE RECORD!')
    : monsterMode && !monsterFreestyle
      ? (session.monsterRounds.won || _readBest(bestKey) ? `BEST ${formatRaceTime(stored)}` : 'CLEAR ALL FIVE LEVELS TO SET A TIME')
      : (scoreMode ? `BEST ${Math.round(stored).toLocaleString()}` : `BEST ${formatRaceTime(stored)}`);
  try { sfx.victory(); } catch (_) {}
}

function _snapshot(session) {
  if (!session) return null;
  const player = session.cars?.[0]?.physics;
  return {
    mode: state.mode,
    raceMode: session.raceMode,
    courseId: session.course.id,
    customTrackId: session.course.customTrackId || null,
    courseName: session.course.name,
    arenaId: session.monsterArenaDefinition?.id || null,
    phase: session.phase,
    raceTime: session.raceTime,
    lap: player?.completedLaps || 0,
    speed: player?.speed || 0,
    drifting: !!player?.drifting,
    boostTime: player?.boostTime || 0,
    boostHeat: player?.boostHeat || 0,
    overheated: !!player?.overheated,
    integrity: player?.integrity ?? 100,
    engineDamage: player?.engineDamage || 0,
    driftScore: session.driftScore || 0,
    driftCombo: session.driftCombo || 1,
    styleScore: session.styleScore || 0,
    styleCombo: session.styleCombo || 1,
    perfectDriftChain: session.perfectDriftChain || 0,
    drafting: player?.draftStrength || 0,
    airborne: player ? !player.grounded : false,
    cars: session.cars?.length || 0,
    drivers: session.cars?.map((car) => ({
      id: car.id,
      avatarId: car.avatarId,
      name: car.name,
      renderTier: car.renderTier,
      integrity: car.physics.integrity,
      wrecked: car.physics.wrecked,
      repairing: car.physics.repairTime > 0,
    })) || [],
    ramps: session.rampIndices?.length || 0,
    boostPads: session.boostIndices?.length || 0,
    checkpoints: session.checkpoints?.length || 0,
    overpasses: session.course.overpasses?.length || 0,
    camera: session.cameraManager?.getSnapshot() || null,
    assets: {
      ids: session.assetLease?.ids || [],
      error: session.assetError || '',
      cache: getRallyAssetCacheSnapshot(),
    },
    performance: {
      fps: Math.round(1 / Math.max(1 / 240, session.frameTimeEma || 1 / 60)),
      drawCalls: getRendererDiagnostics(state).drawCalls ?? null,
      triangles: getRendererDiagnostics(state).triangles ?? null,
    },
    monster: session.raceMode === 'monster'
      ? {
          ...monsterSnapshot(
            session.monsterArena,
            session.monsterScore,
            player,
            monsterArenaRenderSnapshot(session.monsterArenaView),
            session.monsterVehicleId,
          ),
          round: session.monsterRounds.index + 1,
          roundName: currentMonsterRound(session.monsterRounds).name,
          roundTime: session.monsterRounds.timeRemaining,
          roundElapsed: session.monsterRounds.roundElapsed,
          runTime: session.monsterRounds.elapsedTime,
          roundTimes: [...session.monsterRounds.roundTimes],
          roundTargets: currentMonsterRound(session.monsterRounds).targetIds.length,
          roundDestroyed: activeMonsterRoundDestroyed(session.monsterRounds, session.monsterArena),
          rank: monsterRoundRank(session.monsterRounds.elapsedTime, session.monsterRounds.won),
          modelAttached: !!session.cars?.[0]?.visual?.modelAttached,
          modelAnimation: {
            actions: session.cars?.[0]?.visual?.animationActions?.length || 0,
            time: session.cars?.[0]?.visual?.animationClock || session.cars?.[0]?.visual?.animationMixer?.time || 0,
            roadSpeedSynced: !!session.cars?.[0]?.visual?.animationDriveSynced,
          },
          modelMaterials: session.cars?.[0]?.visual?.modelMaterialStats || null,
          vehicleContact: monsterContactPatchSnapshot(player),
          eventMode: session.monsterEvent,
          spotlight: monsterSpotlightSnapshot(session.monsterSpotlight),
          records: monsterRecordSnapshot(session.monsterRecordRun),
          ghostVisible: !!session.monsterGhostRoute?.visible,
          landingPredictorVisible: !!session.monsterLandingPredictor?.visible,
        }
      : null,
  };
}

export function enterRacing(scene, courseId = 'forest', options = {}) {
  if (options.mode === 'crash') {
    if (state.racing && state.racing.raceMode !== 'crash') exitRacing(scene);
    return _loadCrashMode().then((api) => api.enterCrashMode(scene, { ...options, courseId }));
  }
  if (options.mode === 'trials') {
    return enterTrialsMode(scene, {
      ...options,
      trackId: options.trialsTrackId || options.trackId || 'meadow',
      vehicle: options.trialsVehicle || options.vehicle || 'monster',
    });
  }
  if (!scene || !state.hero?.mesh) throw new Error('Kaki Rally needs a scene and loaded hero');
  if (state.racing) exitRacing(scene);
  const raceMode = RACE_MODES[options.mode] ? options.mode : 'circuit';
  const modeDef = RACE_MODES[raceMode];
  const requestedCars = Math.round(Number(options.carCount) || modeDef.carCount);
  const carCount = clamp(requestedCars, modeDef.minCars, modeDef.maxCars);
  const monsterArenaDefinition = raceMode === 'monster'
    ? getMonsterArenaDefinition(options.monsterArena)
    : null;
  const course = getCourseDefinition(courseId, raceMode, {
    monsterArena: monsterArenaDefinition?.id,
    customCourse: options.customCourse,
  });
  const monsterVehicleId = ['meowster', 'cyber', 'tipsy'].includes(options.monsterVehicle)
    ? options.monsterVehicle
    : 'meowster';
  const monsterVehicleProfile = getMonsterVehicleProfile(monsterVehicleId);
  const monsterEvent = ['freestyle', 'free-ride'].includes(options.monsterEvent)
    ? options.monsterEvent
    : 'smashdown';
  const owned = { geometries: new Set(), materials: new Set(), textures: new Set() };
  const root = new THREE.Group();
  root.name = `kaki-rally-${raceMode}-${course.id}`;
  root.position.set(RACE_CX, 0, RACE_CZ);
  scene.add(root);
  const hero = state.hero.mesh;
  const savedHero = {
    parent: hero.parent,
    position: hero.position.clone(),
    quaternion: hero.quaternion.clone(),
    scale: hero.scale.clone(),
    visible: hero.visible,
    shadowStates: [],
  };
  hero.traverse?.((object) => {
    if (object.isMesh) savedHero.shadowStates.push({ object, castShadow: object.castShadow });
  });
  const session = {
    scene,
    root,
    course,
    raceMode,
    modeDef,
    carCount,
    playerAvatarId: options.playerAvatarId || 'kitty',
    roster: (options.rosterIds?.length
      ? options.rosterIds.map((id) => AVATARS.find((avatar) => avatar.id === id)).filter(Boolean)
      : [...AVATARS]),
    owned,
    assetLease: null,
    assetError: '',
    racingVfx: null,
    environment: null,
    monsterArenaDefinition,
    monsterArenaView: null,
    monsterVehicleId,
    monsterVehicleProfile,
    monsterEvent,
    savedHero,
    savedBackground: scene.background,
    savedFog: scene.fog,
    savedEnvVisible: state.envGroup ? state.envGroup.visible : true,
    samples: [],
    rampIndices: [],
    boostIndices: [],
    repairIndices: [],
    shortcuts: [],
    checkpoints: [],
    aiPath: null,
    overpassKit: null,
    customTrack: options.customTrack || course.drawDraft || null,
    cars: [],
    particles: [],
    particleCursor: 0,
    phase: 'countdown',
    countdown: COUNTDOWN_SECONDS,
    raceTime: 0,
    goFlash: 0,
    rescueFlash: 0,
    landFlash: 0,
    landCallout: 'NICE LANDING!',
    crashFlash: 0,
    smashFlash: 0,
    driftScore: 0,
    driftChain: 0,
    driftCombo: 1,
    bestDriftCombo: 1,
    driftGap: 0,
    styleScore: 0,
    styleCombo: 1,
    styleTime: 0,
    styleEvent: '',
    styleEventTime: 0,
    perfectDriftChain: 0,
    frameTimeEma: 1 / 60,
    hitStop: 0,
    cameraFx: { shake: 0, roll: 0, punch: 0, phase: 0 },
    monsterScore: raceMode === 'monster' ? createMonsterScoreState(modeDef.duration) : null,
    monsterRounds: raceMode === 'monster' ? createMonsterRoundState(monsterArenaDefinition, monsterEvent) : null,
    monsterSpotlight: null,
    monsterSpotlightSerial: 0,
    recoverQueued: false,
    refillQueued: false,
    recoveryTime: 0,
    roundFlash: 0,
    roundCallout: '',
    monsterArena: null,
    monsterRecordRun: raceMode === 'monster' ? createMonsterRecordRun({
      arenaId: monsterArenaDefinition.id,
      eventMode: monsterEvent,
      vehicleId: monsterVehicleId,
    }) : null,
    monsterRecordResult: null,
    monsterLandingPredictor: null,
    monsterGhostRoute: null,
    hud: null,
  };
  try {
    session.assetLease = createRallyAssetLease({
      courseId: course.id,
      mode: raceMode,
      monsterVehicleId,
      rendererService: state.rendererService,
    });
    session.assetLease.ready.then(() => {
      if (session.disposed) return;
      // Atlas-frame textures clone the lease's shared image source before its
      // asynchronous decode completes. Refresh those owned clones only after
      // the lease is ready; dirtying them earlier is invalid in WebGPU.
      for (const texture of session.owned.textures) {
        requestTextureUploadIfReady(texture);
      }
    }).catch((error) => {
      session.assetError = error?.message || String(error);
    });
    const lighting = getRallyLightingProfile(course);
    // Monster Smash's illustrated landmarks live on a world-anchored curved
    // horizon. A regular Texture background is screen-locked, which made the
    // city and hills slide with the camera and duplicated the art behind its
    // old rectangular planes.
    scene.background = new THREE.Color(raceMode === 'monster' ? 0x42c7df : lighting.background);
    scene.fog = new THREE.Fog(
      lighting.fogColor,
      raceMode === 'monster' ? Math.max(150, lighting.fogNear) : lighting.fogNear,
      raceMode === 'monster' ? Math.max(420, lighting.fogFar) : lighting.fogFar,
    );
    if (state.envGroup) state.envGroup.visible = false;

    const hemi = new THREE.HemisphereLight(
      lighting.hemisphere.sky,
      lighting.hemisphere.ground,
      lighting.hemisphere.intensity,
    );
    root.add(hemi);
    const sun = new THREE.DirectionalLight(lighting.key.color, lighting.key.intensity);
    sun.position.fromArray(lighting.key.position);
    sun.castShadow = true;
    const largeMonsterArena = raceMode === 'monster' && monsterArenaDefinition.targets.length > 70;
    sun.shadow.mapSize.set(largeMonsterArena ? 1024 : 2048, largeMonsterArena ? 1024 : 2048);
    const drawnExtent = raceMode === 'draw'
      ? Math.max(0, ...course.points.flatMap((point) => [Math.abs(point[0]), Math.abs(point[1])])) + 22
      : 0;
    const shadowExtent = raceMode === 'monster'
      ? Math.max(92, Math.abs(monsterArenaDefinition.bounds.maxX) + 14)
      : raceMode === 'draw' ? clamp(drawnExtent, 45, 145) : 45;
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = raceMode === 'monster' ? 220 : raceMode === 'draw' ? Math.max(130, shadowExtent * 2.4) : 130;
    sun.shadow.bias = -0.0004;
    root.add(sun);
    root.add(sun.target);
    if (raceMode === 'monster') {
      const lightX = Math.min(92, Math.abs(monsterArenaDefinition.bounds.softX) * 0.72);
      const lightZ = Math.min(68, Math.abs(monsterArenaDefinition.bounds.softZ) * 0.72);
      for (const [x, z, color] of [[-lightX, -lightZ, 0xff65b5], [lightX, -lightZ, 0x71e9ff], [-lightX, lightZ, 0xffd36f], [lightX, lightZ, 0xa985ff]]) {
        const flood = new THREE.PointLight(color, 32, raceMode === 'monster' ? 132 : 92, 1.65);
        flood.position.set(x, 16, z);
        root.add(flood);
      }
    }

    const built = _buildCourse(course, root, owned, session.assetLease, monsterArenaDefinition);
    session.environment = built.environment;
    session.monsterArenaView = built.monsterArenaView || null;
    session.samples = built.samples;
    session.rampIndices = built.rampIndices;
    session.boostIndices = built.boostIndices;
    session.repairIndices = built.repairIndices;
    session.shortcuts = built.shortcuts;
    session.checkpoints = built.checkpoints || [];
    session.aiPath = built.aiPath || null;
    session.overpassKit = built.overpassKit || null;
    if (raceMode === 'monster') {
      session.monsterArena = buildMonsterTargets(monsterArenaDefinition, root, owned, session.assetLease);
      _buildMonsterReplayPresentation(session, root, owned);
      _startMonsterRound(session, 0);
    }
    if (raceMode === 'monster') {
      const bounds = monsterArenaDefinition.bounds;
      session.mapBounds = { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ };
    } else {
      const xs = session.samples.map((p) => p.x);
      const zs = session.samples.map((p) => p.z);
      session.mapBounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    }

    if (hero.parent) hero.parent.remove(hero);
    session.cars = _createRacers(session, hero);
    _makeParticlePool(session);
    _mountHud(session);
    _installMonsterControls(session);

    state.racing = session;
    state.mode = 'racing';
    state.gameOver = false;
    state.victory = false;
    attachRacingCameraManager(session, options.cameraHost || {});
    state.hero.pos.set(
      RACE_CX + session.cars[0].physics.x,
      session.cars[0].physics.y,
      RACE_CZ + session.cars[0].physics.z,
    );
    if (raceMode === 'monster') {
      const bodyAssetId = monsterVehicleId === 'cyber'
        ? 'cyberKakiBody'
        : monsterVehicleId === 'tipsy'
          ? 'tipsyTumblerBody'
          : 'mightyMeowsterBody';
      session.assetLease.whenReady(bodyAssetId).then((model) => {
        if (state.racing !== session || session.disposed) return;
        const attached = monsterVehicleId === 'cyber'
          ? attachCyberTruckModel(session.cars[0]?.visual, model, owned)
          : monsterVehicleId === 'tipsy'
            ? attachTipsyTumblerModel(session.cars[0]?.visual, model)
            : attachMightyMeowsterModel(session.cars[0]?.visual, model, owned);
        if (!attached) {
          session.assetError ||= `${session.monsterVehicleProfile.name} body could not be attached; procedural fallback remains active.`;
        }
      }).catch(() => {});
      session.assetLease.whenReady('arenaTrafficKit').then((model) => {
        if (state.racing !== session || session.disposed) return;
        if (!attachMonsterTrafficModels(session.monsterArena, model)) {
          session.assetError ||= 'Arena traffic kit could not be attached; procedural crushable fallback remains active.';
        }
      }).catch(() => {});
      session.assetLease.whenReady('monsterEnvironmentKit').then((model) => {
        if (state.racing !== session || session.disposed) return;
        if (!attachMonsterEnvironmentKit(session.monsterArenaView, model)) {
          session.assetError ||= 'Monster Arena environment kit could not be attached; authored loading fallback remains active.';
        }
      }).catch(() => {});
      session.assetLease.whenReady('monsterAudienceBank').then((model) => {
        if (state.racing !== session || session.disposed) return;
        if (!attachMonsterAudience(session.monsterArenaView, model)) {
          session.assetError ||= 'The optimized 3D arena audience could not be attached; crowd cards remain active.';
        }
      }).catch(() => {});
    }
    window.__kkRacing = {
      snapshot: () => _snapshot(state.racing),
      setCameraMode: (mode) => state.racing?.cameraManager?.setCameraMode(mode, { instant: true }) || false,
      cycleCamera: (direction = 1) => state.racing?.cameraManager?.cycleCamera(direction) || false,
      skipCountdown: () => {
        if (!state.racing) return;
        state.racing.countdown = 0;
        state.racing.phase = 'racing';
      },
      warpToMonsterTarget: (targetIndex = 0) => {
        return _warpMonsterTarget(state.racing, targetIndex);
      },
      warpToMonsterDistrict: (districtId = state.racing?.monsterArenaDefinition?.districts?.[0]?.id) => _warpMonsterDistrict(state.racing, districtId),
      collapseMonsterStructure: (structureId = 'car-pyramid') => _collapseMonsterStructureQa(state.racing, structureId),
      refillMonsterArena: () => refillMonsterDestruction(state.racing?.monsterArena),
      setMonsterRound: (round = 1) => {
        const active = state.racing;
        if (active?.raceMode !== 'monster') return false;
        _startMonsterRound(active, clamp(Math.round(round) - 1, 0, active.monsterRounds.rounds.length - 1));
        active.countdown = 0;
        active.phase = 'racing';
        return true;
      },
      fillChaos: () => {
        if (!state.racing?.monsterScore) return false;
        state.racing.monsterScore.chaos = 100;
        return true;
      },
      showMonsterBusyState: () => _setMonsterBusyQaState(state.racing),
      showMonsterJump: (rampId = '') => _setMonsterJumpQaState(state.racing, rampId),
      warpShowcase: (fraction = 0.18) => _warpRallyShowcase(state.racing, fraction),
      showState: (kind) => _setRallyQaState(state.racing, kind),
    };
    _mountQaBridge(session, {
      'skip-countdown': () => window.__kkRacing?.skipCountdown(),
      showcase: () => window.__kkRacing?.warpShowcase(0.18),
      'monster-target': () => window.__kkRacing?.warpToMonsterTarget(0),
      'monster-spine': () => window.__kkRacing?.warpToMonsterDistrict('central-spine'),
      'monster-bowl': () => window.__kkRacing?.warpToMonsterDistrict('demolition-bowl'),
      'monster-pyramid': () => window.__kkRacing?.warpToMonsterDistrict('car-pyramid'),
      'monster-chaos': () => window.__kkRacing?.fillChaos(),
      'monster-busy': () => window.__kkRacing?.showMonsterBusyState(),
      'monster-jump': () => window.__kkRacing?.showMonsterJump(),
      'monster-refill': () => window.__kkRacing?.refillMonsterArena(),
      'monster-collapse': () => window.__kkRacing?.collapseMonsterStructure(),
      'state-boost': () => window.__kkRacing?.showState('boost'),
      'state-drift': () => window.__kkRacing?.showState('drift'),
      'state-damage': () => window.__kkRacing?.showState('damage'),
      'state-jump': () => window.__kkRacing?.showState('jump'),
      'state-landing': () => window.__kkRacing?.showState('landing'),
      'camera-medium': () => { session.qaFrustumScale = 0.74; },
      'camera-close': () => { session.qaFrustumScale = 0.5; },
    });
    return session;
  } catch (error) {
    try { exitRacing(scene, session); } catch (_) {}
    throw error;
  }
}

export function tickRacing(dt) {
  const session = state.racing;
  if (!session || !(dt > 0)) return;
  if (session.raceMode === 'crash') return _crashModeApi?.tickCrashMode(dt);
  if (session.raceMode === 'trials') return tickTrialsMode(dt);
  session.frameTimeEma += (dt - session.frameTimeEma) * 0.06;
  dt = Math.min(dt, 1 / 30);
  _tickCameraFx(session, dt);
  updateRallyEnvironment(session.environment, session.raceTime + session.countdown, dt);
  updateMonsterArena(session.monsterArenaView, session.raceTime + session.countdown, dt, session.smashFlash || 0);
  if (session.hitStop > 0) {
    session.hitStop = Math.max(0, session.hitStop - dt);
    _tickParticles(session, dt * 0.22);
    _updateHud(session);
    return;
  }
  session.styleTime = Math.max(0, session.styleTime - dt);
  session.styleEventTime = Math.max(0, session.styleEventTime - dt);
  if (session.styleTime <= 0) {
    session.styleCombo = 1;
    session.perfectDriftChain = 0;
  }
  session.goFlash = Math.max(0, session.goFlash - dt);
  if (session.phase === 'countdown') {
    session.countdown -= dt;
    if (session.countdown <= 0) {
      session.countdown = 0;
      session.phase = 'racing';
      session.goFlash = 0.8;
      try { sfx.uiClick(); } catch (_) {}
    }
  } else if (session.phase === 'racing') {
    session.raceTime += dt;
    if (session.modeDef.objective !== 'laps' && session.raceMode !== 'monster' && session.raceTime >= session.modeDef.duration) {
      session.raceTime = session.modeDef.duration;
      _finishPlayer(session);
    }
  }

  const playerInput = state.input?.moveVec || { x: 0, y: 0 };
  const monsterMode = session.raceMode === 'monster';
  const drivingPhase = session.phase === 'racing' || (monsterMode && session.phase === 'round-transition');
  const actionPressed = drivingPhase && (isDashPressed() || _touchDrift);
  const handbrakePressed = drivingPhase && (isHandbrakePressed() || _touchHandbrake);
  // Space still feeds the shared edge queue used by survivor modes. Drain it
  // here so a racing handbrake press cannot leak into a later scene as a jump.
  consumeJump();
  const playerControls = {
    throttle: drivingPhase ? -playerInput.y : 0,
    steer: drivingPhase ? mapRacingSteerInput(playerInput.x) : 0,
    drift: (!monsterMode && actionPressed) || handbrakePressed,
    handbrake: handbrakePressed,
    boost: monsterMode && actionPressed,
    hop: false,
  };
  if (monsterMode) {
    _tickMonsterRecovery(session, dt, playerControls);
    if (session.recoveryTime > 0) {
      playerControls.throttle = 0;
      playerControls.steer = 0;
      playerControls.boost = false;
      playerControls.hop = false;
    }
  }
  const steps = Math.max(1, Math.ceil(dt / (1 / 90)));
  const stepDt = dt / steps;
  for (const car of session.cars) {
    car.frameEvents.boostStarted = false;
    car.frameEvents.boostLevel = 0;
    car.frameEvents.boostHeat = car.physics.boostHeat || 0;
    car.frameEvents.overheated = false;
    car.frameEvents.cooled = false;
    car.frameEvents.jumped = false;
    car.frameEvents.landed = false;
    car.frameEvents.landingSpeed = 0;
    car.frameEvents.landingQuality = 0;
    car.frameEvents.landingGrade = '';
    car.frameEvents.perfectLanding = false;
    car.frameEvents.cleanLanding = false;
    car.frameEvents.hardLanding = false;
    car.frameEvents.bottomedOut = false;
    car.frameEvents.landingType = '';
    car.frameEvents.landingContact = '';
    car.frameEvents.groundedWheels = car.physics.groundedWheelCount ?? 0;
    car.frameEvents.wheelContacts = [];
    car.frameEvents.airTime = car.physics.airTime || 0;
    car.frameEvents.driftStrength = 0;
    car.frameEvents.driftTier = 0;
    car.frameEvents.driftPerfectWindow = false;
    car.frameEvents.perfectDrift = false;
    car.frameEvents.perfectDriftChain = 0;
    car.frameEvents.driftOvercooked = false;
    car.frameEvents.impactStrength = 0;
    car.frameControls = null;
    car.frameContact = null;
  }

  for (let step = 0; step < steps; step++) {
    for (const car of session.cars) {
      let controls = car.id === 'player' ? playerControls
        : (drivingPhase ? _aiControls(session, car) : { throttle: 0, steer: 0, drift: false, hop: false });
      const contact = _contactFor(session, car);
      contact.draftStrength = monsterMode ? 0 : _draftStrengthFor(session, car);
      const p = car.physics;
      if (!monsterMode && car.id === 'player') {
        if (contact.shortcut && p.speed > 5) {
          p.shortcutTime = (p.shortcutTime || 0) + stepDt;
        } else if ((p.shortcutTime || 0) > 0) {
          if (p.shortcutTime >= 0.45) {
            _awardRallyStyle(session, 180 + p.shortcutTime * 120, 'COMMITTED SHORTCUT', 0.45);
          }
          p.shortcutTime = 0;
        }
      }
      p.previousX = p.x;
      p.previousZ = p.z;
      p.previousY = p.y;
      if (p.wrecked) {
        p.wreckTime += stepDt;
        if (monsterMode && p.wreckTime >= 1.1) {
          respawnMonsterKart(session.monsterArenaView, p);
          initializeMonsterVehiclePhysics(p, session.monsterVehicleProfile);
          repairKart(p, 100);
          if (car.id === 'player') session.cameraManager?.onVehicleRespawned();
          breakMonsterChain(session.monsterScore, 'TRUCK RESET');
          session.rescueFlash = 0.8;
        } else if (session.raceMode === 'draw' && p.wreckTime >= 1.35) {
          RespawnGenerator.respawn(p, session.samples);
          repairKart(p, 100);
          p.wreckTime = 0;
          if (car.id === 'player') session.cameraManager?.onVehicleRespawned();
          session.rescueFlash = car.id === 'player' ? 0.9 : session.rescueFlash;
        } else if (!monsterMode && p.wreckTime >= 1.6 && session.repairIndices.length) {
          const sample = session.samples[session.repairIndices[0]];
          p.x = sample.x - sample.normal.x * session.course.trackWidth * 0.36;
          p.z = sample.z - sample.normal.z * session.course.trackWidth * 0.36;
          p.yaw = Math.atan2(sample.tangent.x, sample.tangent.z);
          p.vx = p.vz = 0;
          p.pitLocked = true;
          p.wreckTime = 0;
          if (car.id === 'player') session.cameraManager?.onVehicleRespawned();
        }
      }
      if (!monsterMode && ((contact.repairBay && p.integrity < 99.9) || p.pitLocked)) {
        p.repairTime += stepDt;
        repairKart(p, 27 * stepDt);
        if (p.pitLocked && p.integrity < 96) controls = { throttle: 0, steer: 0, drift: false, hop: false };
        if (p.integrity >= 96) p.pitLocked = false;
      } else {
        p.repairTime = 0;
      }
      if (monsterMode && car.id === 'player' && session.phase === 'racing') {
        stepMonsterChaos(session.monsterScore, p, controls, stepDt);
      }
      const events = stepKart(
        car.physics,
        controls,
        contact,
        stepDt,
        monsterMode ? session.monsterVehicleProfile.tuning : undefined,
      );
      const resolvedContact = monsterMode ? _contactFor(session, car) : contact;
      if (monsterMode) {
        stepMonsterContactPatches(
          p,
          resolvedContact,
          session.monsterVehicleProfile,
          stepDt,
          events,
        );
      }
      const accumulated = car.frameEvents;
      accumulated.boostStarted ||= events.boostStarted;
      accumulated.boostLevel = Math.max(accumulated.boostLevel, events.boostLevel || 0);
      accumulated.boostHeat = Math.max(accumulated.boostHeat, events.boostHeat || 0);
      accumulated.overheated ||= events.overheated;
      accumulated.cooled ||= events.cooled;
      accumulated.jumped ||= events.jumped;
      accumulated.landed ||= events.landed;
      accumulated.landingSpeed = Math.max(accumulated.landingSpeed, events.landingSpeed || 0);
      if (events.landed) {
        accumulated.landingQuality = events.landingQuality || 0;
        accumulated.landingGrade = events.landingGrade || '';
        accumulated.perfectLanding ||= events.perfectLanding;
        accumulated.cleanLanding ||= events.cleanLanding;
        accumulated.hardLanding ||= events.hardLanding;
        accumulated.bottomedOut ||= events.bottomedOut;
        accumulated.landingType = events.landingType || accumulated.landingType;
        accumulated.landingContact = events.landingContact || accumulated.landingContact;
        accumulated.airTime = Math.max(accumulated.airTime, events.airTime || 0);
      }
      accumulated.groundedWheels = events.groundedWheels ?? accumulated.groundedWheels;
      if (events.wheelContacts?.length) accumulated.wheelContacts.push(...events.wheelContacts);
      accumulated.driftStrength = Math.max(accumulated.driftStrength, events.driftStrength || 0);
      accumulated.driftTier = Math.max(accumulated.driftTier, events.driftTier || 0);
      accumulated.driftPerfectWindow ||= events.driftPerfectWindow;
      accumulated.perfectDrift ||= events.perfectDrift;
      accumulated.perfectDriftChain = Math.max(accumulated.perfectDriftChain, events.perfectDriftChain || 0);
      accumulated.driftOvercooked ||= events.driftOvercooked;
      accumulated.impactStrength = Math.max(accumulated.impactStrength, events.impactStrength || 0);
      car.frameControls = controls;
      car.frameContact = resolvedContact;
      if (monsterMode && car.id === 'player' && session.phase === 'racing') {
        const stunt = stepMonsterStunts(session.monsterScore, p, controls, events, stepDt, session.monsterVehicleProfile);
        const signaturePoints = stepMonsterSignatureStunts(
          session.monsterScore,
          p,
          events.jumped ? contact : resolvedContact,
          events,
        );
        if ((stunt.points || 0) >= 500 || signaturePoints > 0) {
          session.smashFlash = Math.max(session.smashFlash, signaturePoints > 0 ? 1.8 : 1.25);
          session.hitStop = Math.max(session.hitStop, signaturePoints > 0 ? 0.082 : 0.048);
          _kickCamera(session, signaturePoints > 0 ? 0.95 : 0.58, 0, signaturePoints > 0 ? 1.18 : 0.72);
          try { signaturePoints > 0 ? sfx.victory() : sfx.speedBoostActivate(); } catch (_) {}
        }
        const smashes = resolveMonsterDestruction(
          session.monsterArena,
          session.monsterScore,
          p,
          { vehicleProfile: session.monsterVehicleProfile },
        );
        if (smashes.length) {
          session.smashFlash = 1.05;
          const biggest = Math.max(...smashes.map((smash) => smash.impactSpeed || 0));
          _kickCamera(session, 0.66 + biggest / 42, (smashes.length % 2 ? 1 : -1) * 0.025, 1.05);
          session.hitStop = Math.max(session.hitStop, biggest > 18 ? 0.075 : 0.045);
          playRacingImpact({ strength: biggest / 24, kind: 'smash' });
          _spawnImpactBurst(session, car, Math.min(1.5, biggest / 18), 'debris');
          for (let smashIndex = 0; smashIndex < smashes.length; smashIndex++) {
            for (let burst = 0; burst < 12; burst++) _spawnDust(session, car, 0.78 + burst * 0.065, burst > 6);
            try { sfx.explosion(); } catch (_) {}
          }
        }
        const boundary = resolveMonsterArenaBounds(session.monsterArenaView, p);
        if (boundary.hit && boundary.speed > 6.5 && p.collisionCooldown <= 0) {
          const damage = impactDamage(boundary.speed * 0.92);
          applyKartDamage(p, damage, 'front');
          p.collisionCooldown = 0.4;
          breakMonsterChain(session.monsterScore, 'WALL HIT');
          session.crashFlash = Math.max(session.crashFlash, damage / 22);
        }
      }
      if (!monsterMode) {
        updateRaceProgress(car.physics, contact.nearest.index, session.samples.length);
        if (session.raceMode === 'draw') {
          const checkpoint = CheckpointGenerator.update(
            car.physics,
            contact.nearest.index,
            session.samples.length,
            session.checkpoints,
            stepDt,
          );
          if (car.id === 'player') session.wrongWay = checkpoint.reversed;
        }
        _resolveStockWall(session, car, contact);
        _rescueIfNeeded(session, car, contact, stepDt);
      }
      if (session.modeDef.objective === 'laps' && !car.physics.finished && car.physics.completedLaps >= session.course.laps) {
        car.physics.finished = true;
        car.physics.finishTime = session.raceTime;
        if (car.id === 'player') _finishPlayer(session);
      }
    }
    _resolveKartCollisions(session);
  }
  if (session.phase === 'racing' && session.raceMode === 'drift') {
    const player = session.cars[0].physics;
    const earned = driftScoreStep(player, dt, session.driftCombo);
    if (earned > 0) {
      session.driftScore += earned;
      session.driftChain += dt;
      session.driftGap = 0;
      session.driftCombo = clamp(1 + session.driftChain / 2.2, 1, 8);
      session.bestDriftCombo = Math.max(session.bestDriftCombo, session.driftCombo);
    } else {
      session.driftGap += dt;
      if (session.driftGap > 0.72) {
        session.driftChain = 0;
        session.driftCombo = 1;
      }
    }
  }
  if (monsterMode) {
    const collapseEvents = updateMonsterTargets(session.monsterArena, dt, session.cars[0]?.physics, {
      run: session.monsterScore,
      time: session.raceTime,
    });
    if (collapseEvents.length) {
      const impactSpeed = Math.max(0, ...collapseEvents.map((event) => event.speed || 0));
      const supportLoss = collapseEvents.some((event) => event.type === 'support-loss');
      const explosion = collapseEvents.some((event) => event.type === 'explosion');
      const domino = collapseEvents.some((event) => event.type === 'domino-impact');
      session.smashFlash = Math.max(session.smashFlash, explosion ? 1.4 : supportLoss ? 1.35 : clamp(impactSpeed / 10, 0.35, 1.1));
      _kickCamera(session, explosion ? 1.1 : supportLoss ? 0.86 : clamp(impactSpeed / 12, 0.28, 1.2), 0, explosion || supportLoss ? 1.12 : 0.72);
      if (impactSpeed > 2.5) {
        session.hitStop = Math.max(session.hitStop, clamp(impactSpeed * 0.0025, 0.022, 0.065));
        playRacingImpact({ strength: impactSpeed / 15, kind: explosion ? 'crash' : 'smash' });
      }
      if (explosion) {
        try { sfx.explosion(); } catch (_) {}
      } else if (domino) {
        try { sfx.hit(); } catch (_) {}
      }
    }
    _tickMonsterRound(session, dt);
  }
  _maintainRallyQaState(session);
  for (const car of session.cars) {
    _syncKartVisual(
      session,
      car,
      dt,
      car.frameControls || { throttle: 0, steer: 0, drift: false, hop: false },
      car.frameEvents,
      car.frameContact || { onRoad: true },
    );
  }
  _tickParticles(session, dt);
  const player = session.cars[0].physics;
  if (session.raceMode === 'monster' && session.phase !== 'finished') {
    stepMonsterRecordRun(session.monsterRecordRun, player, dt);
    _updateMonsterLandingPredictor(session, player);
  }
  state.hero.pos.set(RACE_CX + player.x, player.y, RACE_CZ + player.z);
  state.hero.vel.set(player.vx, player.vy, player.vz);
  const cameraLift = session.raceMode === 'monster' ? 0.62 : 0.25;
  const cameraLead = clamp(player.speed * 0.2, 0, session.raceMode === 'monster' ? 5.2 : 5.4);
  const velocityLength = Math.hypot(player.vx || 0, player.vz || 0);
  const leadX = velocityLength > 0.4 ? player.vx / velocityLength : Math.sin(player.yaw);
  const leadZ = velocityLength > 0.4 ? player.vz / velocityLength : Math.cos(player.yaw);
  _cameraTarget.set(
    RACE_CX + player.x + leadX * cameraLead,
    player.y * cameraLift,
    RACE_CZ + player.z + leadZ * cameraLead,
  );
  const controls = session.cars[0].frameControls || playerControls;
  updateRacingAudio({
    speed: player.speed,
    throttle: controls.throttle,
    slip: Math.abs(player.lateralSpeed || 0) / 7.5,
    airborne: !player.grounded,
    boost: player.boostTime > 0,
    turboHeat: player.boostHeat || 0,
    monster: session.raceMode === 'monster',
    wheelRpm: player.wheelRpm || 0,
    gear: player.gear || 1,
    engineLoad: player.engineLoad || 0,
    vehicleId: session.monsterVehicleId || '',
    groundedWheels: player.groundedWheelCount ?? (player.grounded ? 4 : 0),
  });
  _updateHud(session);
}

export function getRacingCameraTarget() {
  if (state.racing?.raceMode === 'crash') {
    const root = state.racing.root;
    const player = state.racing.playerPhysics;
    if (root && player) _cameraTarget.set(root.position.x + player.x, root.position.y + player.y, root.position.z + player.z);
    return _cameraTarget;
  }
  if (state.racing?.raceMode === 'trials') return getTrialsCameraTarget();
  return _cameraTarget;
}

export function updateRacingCamera(dt, options = {}) {
  if (state.racing?.raceMode === 'crash') return _crashModeApi?.updateCrashCamera(dt, options) || null;
  const result = state.racing?.cameraManager?.update(dt, options) || null;
  if (result?.camera && state.racing?.environment) {
    syncRallySkyToCamera(state.racing.environment, result.camera);
  }
  return result;
}

export function resizeRacingCamera(aspect) {
  if (state.racing?.raceMode === 'crash') return _crashModeApi?.resizeCrashMode(aspect);
  state.racing?.cameraManager?.resize(aspect);
}

export function setRacingCameraMode(mode, options = {}) {
  return state.racing?.cameraManager?.setCameraMode(mode, options) || false;
}

export function cycleRacingCamera(direction = 1) {
  return state.racing?.cameraManager?.cycleCamera(direction) || false;
}

export function resetRacingCamera() {
  state.racing?.cameraManager?.resetCamera({ instant: true });
}

export function getRacingCameraConfig() {
  const session = state.racing;
  if (session?.raceMode === 'crash') return _crashModeApi?.getCrashCameraConfig() || { chromatic: 0, bloom: 0.3 };
  if (session?.cameraManager?.lastFrame) {
    return {
      ...session.cameraManager.lastEffects,
      mode: session.cameraManager.getCurrentMode(),
      projection: session.cameraManager.activeCamera?.isPerspectiveCamera ? 'perspective' : 'orthographic',
    };
  }
  if (session?.raceMode === 'trials') return getTrialsCameraConfig();
  const monster = session?.raceMode === 'monster';
  const base = monster ? MONSTER_CAMERA : STANDARD_CAMERA;
  const player = session?.cars?.[0]?.physics;
  if (!session || !player) return base;
  const speed = clamp(player.speed / (monster ? 26 : 30), 0, 1.2);
  const air = clamp((player.y - (player.groundHeight || 0)) / (monster ? 14 : 10), 0, 1.25);
  const fx = session.cameraFx || { shake: 0, roll: 0, punch: 0, phase: 0 };
  const reducedMotion = !!state._optReduceMotion;
  const shake = reducedMotion ? 0 : fx.shake * (monster ? 0.82 : 0.62);
  return {
    offset: base.offset + speed * (monster ? 3.6 : 3.1),
    height: base.height + speed * (monster ? 4.2 : 3.4) + air * (monster ? 4.4 : 3.2),
    frustum: (base.frustum + speed * (monster ? 2.2 : 1.65) + air * 1.6 - fx.punch * 0.72)
      * (session.qaFrustumScale || 1),
    lookAtBase: base.lookAtBase + speed * 0.28,
    damping: player.grounded ? 0.17 : 0.115,
    shakeX: Math.sin(fx.phase * 1.17) * shake,
    shakeY: Math.sin(fx.phase * 1.91 + 1.2) * shake * 0.62,
    shakeZ: Math.cos(fx.phase * 1.43 + 0.4) * shake,
    roll: reducedMotion ? 0 : fx.roll + clamp(-(player.lateralSpeed || 0) * 0.0014, -0.018, 0.018),
    chromatic: reducedMotion ? 0 : 0.0008 + (player.boostTime > 0 ? 0.0014 : 0) + fx.shake * 0.00075,
    bloom: 0.34 + (player.boostTime > 0 ? 0.16 : 0) + clamp(player.y / 20, 0, 0.12),
  };
}

export function getRacingSnapshot() {
  if (state.racing?.raceMode === 'crash') return _crashModeApi?.getCrashSnapshot() || null;
  if (state.racing?.raceMode === 'trials') return getTrialsSnapshot();
  return _snapshot(state.racing);
}

function _warpMonsterTarget(session, targetIndex = 0) {
  const target = session?.monsterArena?.targets?.[targetIndex];
  const kart = session?.cars?.[0]?.physics;
  if (!target || !kart) return false;
  kart.x = target.x;
  kart.z = target.z;
  kart.previousX = target.x - Math.sin(target.yaw) * 3;
  kart.previousZ = target.z - Math.cos(target.yaw) * 3;
  kart.yaw = target.yaw;
  kart.vx = Math.sin(target.yaw) * 18;
  kart.vz = Math.cos(target.yaw) * 18;
  kart.speed = 18;
  const ground = queryMonsterArenaGround(kart.x, kart.z, session.monsterArenaDefinition);
  kart.y = ground.height;
  kart.previousY = ground.height;
  kart.groundHeight = ground.height;
  kart.grounded = true;
  initializeMonsterVehiclePhysics(kart, session.monsterVehicleProfile);
  return true;
}

function _warpMonsterDistrict(session, districtId) {
  const kart = session?.cars?.[0]?.physics;
  if (!kart || session?.raceMode !== 'monster') return false;
  const definition = session.monsterArenaDefinition;
  const district = definition.districts.find((entry) => entry.id === districtId);
  if (!district) return false;
  const preferred = definition.spawnPoints.some((spawn) => spawn.id === districtId) ? districtId
    : districtId === 'central-spine' ? 'main'
    : districtId === 'bus-rv-gap' ? 'bus-gap'
      : districtId === 'demolition-bowl' ? 'bowl'
        : districtId === 'crown-jump' ? 'crown'
          : districtId === 'crusher-alley' ? 'crusher' : 'freestyle';
  respawnMonsterKart(session.monsterArenaView, kart, preferred);
  initializeMonsterVehiclePhysics(kart, session.monsterVehicleProfile);
  const viewpoint = {
    'central-spine': { x: 0, z: -43, yaw: 0 },
    'crusher-alley': { x: -47, z: -31, yaw: 0 },
    'bus-rv-gap': { x: 38, z: -20, yaw: 0 },
    'demolition-bowl': { x: 46, z: 19, yaw: 0 },
    'crown-jump': { x: -4, z: 36, yaw: Math.PI / 2 },
    'perimeter-freestyle': { x: -68, z: 13, yaw: 0.55 },
    'launch-lanes': { x: 0, z: -48, yaw: 0 },
    'car-pyramid': { x: -29, z: 20, yaw: -2.25 },
    'bus-pyramid': { x: 49, z: 16, yaw: -2.35 },
    'blast-pit': { x: -27, z: 47, yaw: Math.PI / 2 },
    'heavy-gauntlet': { x: 0, z: -47, yaw: 0 },
    'domino-perimeter': { x: -67, z: 58, yaw: Math.PI / 2 },
  }[districtId];
  if (viewpoint) {
    const ground = queryMonsterArenaGround(viewpoint.x, viewpoint.z, definition);
    Object.assign(kart, {
      x: viewpoint.x,
      z: viewpoint.z,
      y: ground.height,
      previousX: viewpoint.x,
      previousZ: viewpoint.z,
      previousY: ground.height,
      groundHeight: ground.height,
      groundPitch: ground.pitch,
      groundRoll: ground.roll,
      yaw: viewpoint.yaw,
      vx: 0,
      vz: 0,
      vy: 0,
      speed: 0,
      grounded: true,
    });
  }
  session.countdown = 0;
  session.phase = 'racing';
  session.cameraManager?.onVehicleRespawned();
  return true;
}

function _collapseMonsterStructureQa(session, structureId = 'car-pyramid') {
  if (session?.raceMode !== 'monster' || !session.monsterArena) return false;
  const baseTargets = session.monsterArena.targets
    .filter((target) => target.structureId === structureId && (target.stackLevel || 0) === 0)
    .sort((a, b) => a.x - b.x);
  const corner = baseTargets[0];
  if (!corner) return false;
  if (!corner.destroyed) session.monsterArena.destroyed += 1;
  corner.health = -1;
  corner.damage = 1;
  corner.destroyed = true;
  corner.state = 'wreck';
  corner.crushVelocity = 0.5;
  corner.destroyedAge = 0;
  corner.vx -= 5.5;
  corner.angularVelocity = -1.1;
  session.countdown = 0;
  session.phase = 'racing';
  return corner.id;
}

function _setMonsterBusyQaState(session) {
  if (session?.raceMode !== 'monster' || !session.monsterArena) return false;
  refillMonsterDestruction(session.monsterArena);
  let destroyed = 0;
  for (const target of session.monsterArena.targets) {
    if (target.ai) {
      target.health = target.maxHealth * 0.58;
      target.damage = 0.42;
      target.destroyed = false;
      target.state = 'dented';
      target.aiSpeed = 7 + target.index % 3;
    } else if (target.rowId === 'starter-row' || target.rowId === 'crusher-lane-0' || target.index % 3 === 0) {
      target.health = -1;
      target.damage = 1;
      target.destroyed = true;
      target.state = target.index % 2 ? 'crushed' : 'wreck';
      target.crush = 0.58 + (target.index % 4) * 0.08;
      target.destroyedAge = 0.8;
      destroyed += 1;
    } else if (target.index % 3 === 1) {
      target.health = target.maxHealth * 0.48;
      target.damage = 0.52;
      target.state = 'dented';
    }
  }
  session.monsterArena.destroyed = destroyed;
  session.monsterScore.chaos = 100;
  session.monsterScore.score = Math.max(session.monsterScore.score, 24580);
  session.monsterScore.wreckChain = session.monsterScore.combo = 5.4;
  session.monsterScore.lastEvent = 'CROWN CHAOS +4,800';
  session.monsterScore.lastEventTime = 5;
  updateMonsterTargets(session.monsterArena, 0, session.cars[0]?.physics, { run: session.monsterScore, time: session.raceTime });
  _warpMonsterDistrict(session, session.monsterArenaDefinition.districts[0]?.id);
  return true;
}

function _setMonsterJumpQaState(session, rampId = '') {
  const kart = session?.cars?.[0]?.physics;
  if (!kart || session?.raceMode !== 'monster') return false;
  const definition = session.monsterArenaDefinition;
  const ramp = definition.ramps.find((entry) => entry.id === rampId) || definition.ramps[0];
  if (!ramp) return false;
  const localZ = ramp.length * 0.5 - 1.1;
  kart.x = ramp.x + Math.sin(ramp.yaw) * localZ;
  kart.z = ramp.z + Math.cos(ramp.yaw) * localZ;
  const ground = queryMonsterArenaGround(kart.x, kart.z, definition);
  kart.y = ground.height + 5.4;
  kart.previousY = kart.y - 0.2;
  kart.groundHeight = ground.height;
  kart.yaw = ramp.yaw;
  kart.vx = Math.sin(ramp.yaw) * 17;
  kart.vz = Math.cos(ramp.yaw) * 17;
  kart.vy = 7.4;
  kart.speed = 17;
  kart.grounded = false;
  kart.airTime = 0.72;
  kart.stuntPitch = 0.08;
  kart.stuntRoll = 0;
  session.monsterScore.currentAirTime = 0.72;
  session.countdown = 0;
  session.phase = 'racing';
  return true;
}

function _warpRallyShowcase(session, fraction = 0.18) {
  if (session?.raceMode === 'monster') return _warpMonsterDistrict(session, session.monsterArenaDefinition.districts[0]?.id);
  const playerCar = session?.cars?.[0];
  const kart = playerCar?.physics;
  const samples = session?.samples;
  if (!kart || !Array.isArray(samples) || samples.length < 3) return false;
  const normalized = clamp(Number(fraction) || 0.18, 0.03, 0.92);
  const index = clamp(Math.floor(samples.length * normalized), 1, samples.length - 2);
  const previous = samples[index - 1];
  const sample = samples[index];
  const next = samples[index + 1];
  const yaw = Math.atan2(next.x - previous.x, next.z - previous.z);
  kart.x = sample.x;
  kart.z = sample.z;
  kart.previousX = previous.x;
  kart.previousZ = previous.z;
  kart.yaw = yaw;
  kart.vx = 0;
  kart.vz = 0;
  kart.vy = 0;
  kart.speed = 0;
  kart.y = 0;
  kart.grounded = true;
  kart.wasGrounded = true;
  kart.airTime = 0;
  if (playerCar.frameEvents) {
    playerCar.frameEvents.jumped = false;
    playerCar.frameEvents.landed = false;
    playerCar.frameEvents.landingSpeed = 0;
  }
  session.landFlash = 0;
  session.crashFlash = 0;
  session.rescueFlash = 0;
  session.countdown = 0;
  session.phase = 'racing';
  return true;
}

function _setRallyQaState(session, kind) {
  const car = session?.cars?.[0];
  const p = car?.physics;
  if (!car || !p || !_warpRallyShowcase(session, 0.18)) return false;
  if (kind === 'boost') {
    p.boostTime = 3;
    p.speed = 20;
    for (let i = 0; i < 10; i++) _spawnDust(session, car, 1 + i * 0.04, true);
  } else if (kind === 'drift') {
    p.drifting = true;
    p.driftCharge = 2.15;
    p.speed = 16;
    p.bodyRoll = 0.14;
    for (let i = 0; i < 14; i++) _spawnDust(session, car, 1.05 + i * 0.025, false);
  } else if (kind === 'damage') {
    p.integrity = 24;
    p.bodyDamage ||= { front: 0, rear: 0, left: 0, right: 0 };
    Object.assign(p.bodyDamage, { front: 0.74, rear: 0.42, left: 0.58, right: 0.28 });
    for (let i = 0; i < 7; i++) _spawnDamageSmoke(session, car);
    _spawnImpactBurst(session, car, 0.8, 'spark');
  } else if (kind === 'jump') {
    p.y = 4.4;
    p.grounded = false;
    p.wasGrounded = false;
    p.airTime = 0.45;
    p.airPitch = -0.18;
  } else if (kind === 'landing') {
    p.suspensionCompression = 1;
    car.suspensionKick = 1;
    for (let i = 0; i < 12; i++) _spawnDust(session, car, 1.1 + i * 0.025, false);
    _spawnImpactBurst(session, car, 0.9, 'debris');
  } else {
    return false;
  }
  session.qaState = { kind, until: session.raceTime + 0.85 };
  return true;
}

function _maintainRallyQaState(session) {
  const qa = session?.qaState;
  const car = session?.cars?.[0];
  const p = car?.physics;
  if (!qa || !car || !p) return;
  if (session.raceTime > qa.until) {
    session.qaState = null;
    return;
  }
  if (qa.kind === 'drift') {
    p.drifting = true;
    p.driftCharge = Math.max(p.driftCharge || 0, 2.15);
    p.speed = Math.max(p.speed || 0, 16);
    p.bodyRoll = 0.14;
  } else if (qa.kind === 'boost') {
    p.boostTime = Math.max(p.boostTime || 0, 0.9);
    p.speed = Math.max(p.speed || 0, 20);
  } else if (qa.kind === 'jump') {
    p.y = 4.4;
    p.grounded = false;
    p.wasGrounded = false;
    p.airPitch = -0.18;
  } else if (qa.kind === 'landing') {
    p.suspensionCompression = 1;
    car.suspensionKick = Math.max(car.suspensionKick || 0, 0.82);
  }
}

function _mountQaBridge(session, actions) {
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  if (!new URLSearchParams(location.search).has('qa') || !session?.hud?.root) return;
  const bridge = document.createElement('div');
  bridge.dataset.racingQaBridge = 'true';
  bridge.setAttribute('aria-label', 'Rally QA controls');
  Object.assign(bridge.style, {
    position: 'fixed', left: '1px', bottom: '1px', zIndex: '2147483647',
    display: 'flex', width: `${Object.keys(actions).length * 5}px`, height: '5px', opacity: '0.01', overflow: 'hidden',
  });
  for (const [name, action] of Object.entries(actions)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.qaAction = name;
    button.setAttribute('aria-label', `QA ${name}`);
    button.style.cssText = 'width:5px;height:5px;min-width:5px;padding:0;border:0;';
    button.addEventListener('click', () => action());
    bridge.append(button);
  }
  session.hud.root.append(bridge);
  session.qaBridge = bridge;
  const reportAssets = () => {
    if (!bridge.isConnected) return;
    bridge.dataset.qaAssets = JSON.stringify(_snapshot(session).assets);
    const environment = session.environment;
    const ground = environment?.group?.getObjectByName?.('rally-biome-ground');
    bridge.dataset.qaEnvironment = JSON.stringify({
      authoredReady: !!environment?.authoredReady,
      authoredChildren: environment?.authoredScatter?.children?.length || 0,
      fallbackVisible: environment?.group?.getObjectByName?.(`${session.course.id}-procedural-scatter-fallback`)?.visible ?? null,
      groundMap: ground?.material?.map?.image?.currentSrc || ground?.material?.map?.image?.src || '',
      groundRepeat: ground?.material?.map?.repeat?.toArray?.() || [],
    });
  };
  reportAssets();
  session.assetLease?.ready?.then(reportAssets, reportAssets);
}

export function restartRacing(scene, courseId = null) {
  if (state.racing?.raceMode === 'crash') return _crashModeApi?.restartCrashMode() || null;
  if (state.racing?.raceMode === 'trials') {
    return restartTrialsMode(scene, {
      trackId: courseId || state.racing.track?.id || state.racing.trackId || 'meadow',
      vehicle: state.racing.vehicle?.id || state.racing.vehicleId || 'monster',
      playerAvatarId: state.racing.playerAvatarId,
    });
  }
  const id = courseId || state.racing?.course?.id || 'forest';
  const current = state.racing;
  const options = current ? {
    mode: current.raceMode,
    carCount: current.carCount,
    customCourse: current.raceMode === 'draw' ? current.course : null,
    customTrack: current.raceMode === 'draw' ? current.customTrack : null,
    monsterVehicle: current.monsterVehicleId,
    monsterArena: current.monsterArenaDefinition?.id,
    monsterEvent: current.monsterEvent,
    playerAvatarId: current.playerAvatarId,
    rosterIds: current.roster.map((avatar) => avatar.id),
    cameraHost: current.cameraHost,
  } : {};
  exitRacing(scene);
  return enterRacing(scene, id, options);
}

export function exitRacing(scene, explicitSession = null) {
  const session = explicitSession || state.racing;
  if (!session) return;
  if (session.raceMode === 'crash') return _crashModeApi?.exitCrashMode(scene, session);
  if (session.raceMode === 'trials') return exitTrialsMode(scene, session);
  _finishMonsterRecords(session);
  session.disposed = true;
  try { session.cameraManager?.dispose(); } catch (_) {}
  if (session.monsterKeyHandler && typeof window !== 'undefined') {
    window.removeEventListener('keydown', session.monsterKeyHandler);
  }
  _touchDrift = false;
  _touchHandbrake = false;
  stopRacingAudio();
  try { session.hud?.root?.remove(); } catch (_) {}
  const hero = state.hero?.mesh;
  if (hero) {
    try { hero.parent?.remove(hero); } catch (_) {}
    hero.position.copy(session.savedHero.position);
    hero.quaternion.copy(session.savedHero.quaternion);
    hero.scale.copy(session.savedHero.scale);
    hero.visible = session.savedHero.visible;
    for (const entry of session.savedHero.shadowStates || []) {
      entry.object.castShadow = entry.castShadow;
    }
    (session.savedHero.parent || scene || session.scene)?.add(hero);
  }
  try { disposeRallyEnvironment(session.environment); } catch (_) {}
  try { disposeMonsterArena(session.monsterArenaView); } catch (_) {}
  try {
    session.root?.traverse?.((object) => {
      if (object.isLight && object.shadow?.map) object.shadow.map.dispose();
    });
  } catch (_) {}
  try { session.root?.parent?.remove(session.root); } catch (_) {}
  for (const texture of session.owned?.textures || []) { try { texture.dispose(); } catch (_) {} }
  for (const material of session.owned?.materials || []) { try { material.dispose(); } catch (_) {} }
  for (const geometry of session.owned?.geometries || []) { try { geometry.dispose(); } catch (_) {} }
  try { session.assetLease?.release(); } catch (_) {}
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && new URLSearchParams(location.search).has('qa')) {
    document.body.dataset.racingCacheAfterExit = String(getRallyAssetCacheSnapshot().length);
  }
  const ownerScene = scene || session.scene;
  if (ownerScene) {
    ownerScene.background = session.savedBackground;
    ownerScene.fog = session.savedFog;
  }
  if (state.envGroup) state.envGroup.visible = session.savedEnvVisible;
  if (state.racing === session) state.racing = null;
  try { delete window.__kkRacing; } catch (_) {}
}
