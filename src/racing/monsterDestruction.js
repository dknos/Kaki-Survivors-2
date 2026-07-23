/** Pooled multi-tier vehicle destruction and deterministic derby traffic. */
import * as THREE from 'three';
import {
  cloneTextureForDeferredUpload,
  requestTextureUploadIfReady,
} from '../rendering/textureUpload.js';
import { applyKartDamage, clamp } from './physics.js';
import {
  awardMonsterRow,
  awardMonsterSignature,
  awardMonsterTargetHit,
  breakMonsterChain,
} from './monsterScoring.js';
import {
  CROWN_CHAOS_ARENA,
  queryMonsterArenaGround,
} from './monsterArenaDefinition.js';
import {
  MONSTER_TARGET_CLASSES,
  applyMonsterTargetDamage,
  canRepopulateMonsterTarget,
  evaluateMonsterTargetImpact,
  monsterChainDamage,
  monsterSupportStatus,
} from './monsterDestructionRules.js';

export { MONSTER_TARGET_CLASSES } from './monsterDestructionRules.js';

const PALETTE = [0xff5f97, 0x55d8ff, 0xffc857, 0x8ee36b, 0xa985ff, 0xff7b54, 0x4ce0bb, 0xf4eee2, 0x64768a, 0xe44f5d];
const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _position = new THREE.Vector3();
const _euler = new THREE.Euler();
const _targetMatrix = new THREE.Matrix4();
const _modelMatrix = new THREE.Matrix4();
const _pivotMatrix = new THREE.Matrix4();
const _rotationMatrix = new THREE.Matrix4();
const _offsetMatrix = new THREE.Matrix4();
const _scaleMatrix = new THREE.Matrix4();
const _dominoFallAxis = new THREE.Vector3();
const _dominoPoint = new THREE.Vector3();
const _visualColor = new THREE.Color();
const _wreckColor = new THREE.Color(0x4b352f);

const TRAFFIC_MODEL_NAMES = Object.freeze({
  sedan: 'ArenaTraffic_Sedan',
  wagon: 'ArenaTraffic_Wagon',
  pickup: 'ArenaTraffic_Pickup',
  van: 'ArenaTraffic_Van',
  limousine: 'ArenaTraffic_Limousine',
  bus: 'ArenaTraffic_Bus',
  rv: 'ArenaTraffic_RV',
  derby: 'ArenaTraffic_Derby',
  crown: 'ArenaTraffic_Crown',
});

const TRAFFIC_MODEL_DIMENSIONS = Object.freeze({
  sedan: Object.freeze({ width: 2.2, height: 1.48, length: 4.25 }),
  wagon: Object.freeze({ width: 2.28, height: 1.7, length: 4.72 }),
  pickup: Object.freeze({ width: 2.34, height: 1.72, length: 4.82 }),
  van: Object.freeze({ width: 2.42, height: 2.2, length: 5.08 }),
  limousine: Object.freeze({ width: 2.22, height: 1.54, length: 6.75 }),
  bus: Object.freeze({ width: 2.7, height: 3.08, length: 9.4 }),
  rv: Object.freeze({ width: 2.34, height: 2.67, length: 5.94 }),
  derby: Object.freeze({ width: 2.38, height: 1.82, length: 4.62 }),
  crown: Object.freeze({ width: 2.12, height: 2.12, length: 3.7 }),
});

function _compose(x, y, z, yaw, sx, sy, sz, pitch = 0, roll = 0) {
  _position.set(x, y, z);
  _euler.set(pitch, yaw, roll);
  _quat.setFromEuler(_euler);
  _scale.set(sx, sy, sz);
  _matrix.compose(_position, _quat, _scale);
  return _matrix;
}

function _dominoPoseMatrix(target, pitchAdjust = 0, rollAdjust = 0) {
  const fallX = Number(target.dominoFallX) || Math.sin(target.yaw || 0);
  const fallZ = Number(target.dominoFallZ) || Math.cos(target.yaw || 0);
  const fallLength = Math.hypot(fallX, fallZ) || 1;
  // Rotate the original bumper-standing car around the world-space axis
  // perpendicular to its actual impulse. This allows a hit from any side to
  // tip the car in that direction instead of replaying one fixed X rotation.
  _dominoFallAxis.set(fallZ / fallLength, 0, -fallX / fallLength);
  _pivotMatrix.makeTranslation(
    target.dominoPivotX,
    target.ground + Math.max(0, Number(target.dominoLift) || 0),
    target.dominoPivotZ,
  );
  _rotationMatrix.makeRotationAxis(_dominoFallAxis, Number(target.dominoTilt) || 0);
  _pivotMatrix.multiply(_rotationMatrix);
  _rotationMatrix.makeRotationY(target.yaw);
  _pivotMatrix.multiply(_rotationMatrix);
  _rotationMatrix.makeRotationX(-Math.PI * 0.5 + pitchAdjust);
  _pivotMatrix.multiply(_rotationMatrix);
  if (rollAdjust) {
    _rotationMatrix.makeRotationZ(rollAdjust);
    _pivotMatrix.multiply(_rotationMatrix);
  }
  return _pivotMatrix;
}

function _composeDominoPart(target, localY, localZ, sx, sy, sz, pitchAdjust = 0, rollAdjust = 0) {
  _dominoPoseMatrix(target, pitchAdjust, rollAdjust);
  _offsetMatrix.makeTranslation(0, localY, localZ);
  _pivotMatrix.multiply(_offsetMatrix);
  _scaleMatrix.makeScale(sx, sy, sz);
  _pivotMatrix.multiply(_scaleMatrix);
  return _pivotMatrix;
}

function _dominoWorldPoint(target, localX = 0, localY = 0, localZ = 0) {
  _dominoPoseMatrix(target);
  _dominoPoint.set(localX, localY, localZ).applyMatrix4(_pivotMatrix);
  return {
    x: _dominoPoint.x,
    y: _dominoPoint.y,
    z: _dominoPoint.z,
  };
}

function _roundedDeckGeometry(width, length, height, radius = 0.24, bevel = 0.07) {
  const halfWidth = width * 0.5;
  const halfLength = length * 0.5;
  const corner = Math.min(radius, halfWidth - 0.01, halfLength - 0.01);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + corner, -halfLength);
  shape.lineTo(halfWidth - corner, -halfLength);
  shape.quadraticCurveTo(halfWidth, -halfLength, halfWidth, -halfLength + corner);
  shape.lineTo(halfWidth, halfLength - corner);
  shape.quadraticCurveTo(halfWidth, halfLength, halfWidth - corner, halfLength);
  shape.lineTo(-halfWidth + corner, halfLength);
  shape.quadraticCurveTo(-halfWidth, halfLength, -halfWidth, halfLength - corner);
  shape.lineTo(-halfWidth, -halfLength + corner);
  shape.quadraticCurveTo(-halfWidth, -halfLength, -halfWidth + corner, -halfLength);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    // These pooled wrecks read at roughly 4-20 screen pixels. One quadratic
    // subdivision keeps the rounded silhouette while avoiding thousands of
    // sub-pixel triangles across 122 targets.
    curveSegments: 1,
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelSegments: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height * 0.5, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function _roundedPanelGeometry(width, height, depth, radius = 0.1) {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + radius, -halfHeight);
  shape.lineTo(halfWidth - radius, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + radius);
  shape.lineTo(halfWidth, halfHeight - radius);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - radius, halfHeight);
  shape.lineTo(-halfWidth + radius, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - radius);
  shape.lineTo(-halfWidth, -halfHeight + radius);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + radius, -halfHeight);
  // Detachable panels are thin, fast-moving accents. Their bevel was invisible
  // at gameplay distance but multiplied across two instances per target.
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, curveSegments: 1, bevelEnabled: false });
  geometry.translate(0, 0, -depth * 0.5);
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function _register({ geometry, material, count, owned, name, colors = false, cast = true, receive = false }) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.userData.raceOwned = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.frustumCulled = false;
  owned.geometries.add(geometry);
  owned.materials.add(material);
  if (colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  return mesh;
}

function _effectTexture(source, column, row, owned) {
  if (!source) return null;
  const texture = cloneTextureForDeferredUpload(source);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(0.25, 0.25);
  texture.offset.set(column * 0.25, (3 - row) * 0.25);
  requestTextureUploadIfReady(texture);
  owned.textures.add(texture);
  return texture;
}

function _localPoint(target, localX, localZ) {
  const sin = Math.sin(target.yaw);
  const cos = Math.cos(target.yaw);
  return {
    x: target.x + localX * cos + localZ * sin,
    z: target.z - localX * sin + localZ * cos,
  };
}

function _targetColor(target) {
  if (target.kind === 'crown') return new THREE.Color(0xffd05d);
  if (target.kind === 'derby') return new THREE.Color(PALETTE[(target.colorIndex ?? target.index * 3) % PALETTE.length]).offsetHSL(0, 0.08, -0.08);
  return new THREE.Color(PALETTE[(target.colorIndex ?? target.index) % PALETTE.length]);
}

function _makeRuntimeTarget(spec, index, definition) {
  const stats = MONSTER_TARGET_CLASSES[spec.kind] || MONSTER_TARGET_CLASSES.sedan;
  const ground = queryMonsterArenaGround(spec.x, spec.z, definition).height;
  const initialDamage = clamp(Number(spec.initialDamage) || 0, 0, 0.85);
  const stackBaseY = Math.max(0, Number(spec.stackBaseY) || (spec.stackLevel || 0) * 1.05);
  const baseY = ground + stackBaseY;
  const runtime = {
    ...spec,
    index,
    stats,
    spawnX: spec.x,
    spawnZ: spec.z,
    spawnYaw: spec.yaw || 0,
    ground,
    stackBaseY,
    spawnBaseY: baseY,
    baseY,
    bottom: baseY,
    y: baseY + stats.wheel + stats.height * 0.48,
    top: baseY + stats.height,
    health: stats.health * (1 - initialDamage),
    maxHealth: stats.health,
    state: initialDamage >= 0.35 ? 'dented' : 'intact',
    destroyed: false,
    damage: initialDamage,
    crush: 0,
    crushFront: initialDamage * 0.24,
    crushRear: initialDamage * 0.18,
    crushVelocity: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angularVelocity: 0,
    pitch: 0,
    roll: 0,
    pitchVelocity: 0,
    rollVelocity: 0,
    stackState: Array.isArray(spec.supportIds) && spec.supportIds.length ? 'supported' : 'grounded',
    supportLossTime: 0,
    forceCollapse: false,
    collapseImpactSpeed: 0,
    hitCooldown: 0,
    axleHits: { front: 0, rear: 0 },
    axleHitCooldowns: { front: 0, rear: 0 },
    destroyedAge: 0,
    chainTriggered: false,
    respawnProgress: 1,
    aiAngle: Number(spec.aiPhase) || 0,
    aiSpeed: spec.ai ? 5.5 + index % 3 : 0,
    aiHitCooldown: 0,
    dominoPivotX: spec.x,
    dominoPivotZ: spec.z,
    dominoStartPitch: Number.isFinite(Number(spec.dominoStartPitch)) ? Number(spec.dominoStartPitch) : -Math.PI * 0.48,
    dominoState: spec.dominoGroup ? 'standing' : 'none',
    dominoTilt: spec.dominoGroup
      ? Math.max(0.025, Math.PI * 0.5 + (Number.isFinite(Number(spec.dominoStartPitch)) ? Number(spec.dominoStartPitch) : -Math.PI * 0.48))
      : 0,
    dominoTiltVelocity: 0,
    dominoFallX: Math.sin(spec.yaw || 0),
    dominoFallZ: Math.cos(spec.yaw || 0),
    dominoLift: 0,
    dominoGroundImpacted: false,
    dominoHitTargets: new Set(),
    dominoDirection: 1,
    dominoTriggeredNext: false,
    dominoFallTime: 0,
    explosive: !!spec.explosive,
    burning: !!spec.burning,
    exploded: false,
    explosionAge: Infinity,
    explosionFuse: -1,
    active: true,
  };
  if (runtime.dominoGroup) {
    runtime.pitch = runtime.dominoStartPitch;
    _syncDominoPose(runtime);
  }
  return runtime;
}

function _finishInstances(arena) {
  for (const mesh of arena.renderMeshes) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  for (const mesh of arena.trafficMeshes || []) mesh.instanceMatrix.needsUpdate = true;
  for (const mesh of arena.trafficMeshes || []) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

export function createMonsterDestruction({ definition = CROWN_CHAOS_ARENA, root, owned, assetLease = null } = {}) {
  if (!root || !owned) throw new Error('createMonsterDestruction requires root and owned resources');
  const targets = definition.targets.map((target, index) => _makeRuntimeTarget(target, index, definition));
  const count = targets.length;
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.43, metalness: 0.38 });
  const roofMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.52, metalness: 0.28 });
  const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0x15273a, roughness: 0.14, metalness: 0.28, clearcoat: 0.82, clearcoatRoughness: 0.16 });
  const tireMaterial = new THREE.MeshStandardMaterial({ color: 0x121117, roughness: 0.97, metalness: 0.01 });
  const metalMaterial = new THREE.MeshStandardMaterial({ color: 0xbcc2ca, roughness: 0.34, metalness: 0.8 });
  const panelMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.48, metalness: 0.4 });
  const debrisMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.67, metalness: 0.36 });
  const vfxAtlas = assetLease?.textures?.monsterArenaVfx || null;
  const smokeMaterial = new THREE.MeshBasicMaterial({
    color: 0xb9b5bc,
    map: _effectTexture(vfxAtlas, 2, 1, owned),
    transparent: true,
    opacity: vfxAtlas ? 0.68 : 0.32,
    alphaTest: vfxAtlas ? 0.015 : 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const flameOuterMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: _effectTexture(vfxAtlas, 0, 0, owned),
    transparent: true,
    opacity: 0.96,
    alphaTest: vfxAtlas ? 0.018 : 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const flameInnerMaterial = new THREE.MeshBasicMaterial({
    color: 0xffdd9a,
    map: _effectTexture(vfxAtlas, 2, 0, owned),
    transparent: true,
    opacity: 0.72,
    alphaTest: vfxAtlas ? 0.018 : 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const explosionMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: _effectTexture(vfxAtlas, 0, 3, owned),
    transparent: true,
    opacity: 0.92,
    alphaTest: vfxAtlas ? 0.015 : 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const bodies = _register({ geometry: _roundedDeckGeometry(2.25, 4.15, 0.76, 0.28, 0.07), material: bodyMaterial, count, owned, name: 'arena-destructible-bodies', colors: true, receive: true });
  const roofs = _register({ geometry: _roundedDeckGeometry(1.9, 2.45, 0.58, 0.24, 0.055), material: roofMaterial, count, owned, name: 'arena-destructible-roofs', colors: true });
  const canopies = _register({ geometry: new THREE.SphereGeometry(0.72, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62), material: glassMaterial, count, owned, name: 'arena-destructible-canopies' });
  const panels = _register({ geometry: _roundedPanelGeometry(1.7, 0.52, 0.075, 0.1), material: panelMaterial, count: count * 2, owned, name: 'arena-detachable-panels', colors: true });
  const bumperGeometry = new THREE.CapsuleGeometry(0.1, 1.9, 2, 6);
  bumperGeometry.rotateZ(Math.PI / 2);
  const bumpers = _register({ geometry: bumperGeometry, material: metalMaterial, count: count * 2, owned, name: 'arena-detachable-bumpers' });
  const wheelGeometry = new THREE.TorusGeometry(0.28, 0.12, 5, 8);
  wheelGeometry.rotateY(Math.PI / 2);
  const wheels = _register({ geometry: wheelGeometry, material: tireMaterial, count: count * 4, owned, name: 'arena-pop-wheels' });
  const debris = _register({ geometry: new THREE.TetrahedronGeometry(0.24, 0), material: debrisMaterial, count: count * 3, owned, name: 'arena-pooled-metal-debris', colors: true });
  const smoke = _register({ geometry: vfxAtlas ? new THREE.PlaneGeometry(1.5, 1.5) : new THREE.DodecahedronGeometry(0.38, 0), material: smokeMaterial, count: count * 2, owned, name: 'arena-pooled-damage-smoke', cast: false });
  const flameOuter = _register({ geometry: vfxAtlas ? new THREE.PlaneGeometry(1.5, 1.8) : new THREE.ConeGeometry(0.36, 1.45, 7), material: flameOuterMaterial, count: count * 2, owned, name: 'arena-hot-car-flame-outer', cast: false });
  const flameInner = _register({ geometry: vfxAtlas ? new THREE.PlaneGeometry(1.25, 1.55) : new THREE.ConeGeometry(0.2, 0.9, 7), material: flameInnerMaterial, count: count * 2, owned, name: 'arena-hot-car-flame-inner', cast: false });
  const explosions = _register({ geometry: vfxAtlas ? new THREE.PlaneGeometry(2.2, 2.2) : new THREE.IcosahedronGeometry(0.72, 1), material: explosionMaterial, count: count * 4, owned, name: 'arena-pooled-hot-car-explosions', cast: false });
  smoke.renderOrder = 5;
  flameOuter.renderOrder = 6;
  flameInner.renderOrder = 7;
  explosions.renderOrder = 8;

  const renderMeshes = [bodies, roofs, canopies, panels, bumpers, wheels, debris, smoke, flameOuter, flameInner, explosions];
  // The truck and stadium retain the grounding shadow. Re-rendering every
  // destructible instance into the arena-wide shadow map roughly doubles the
  // exterior triangle load, including invisible pooled debris and VFX.
  for (const mesh of renderMeshes) mesh.castShadow = false;
  root.add(...renderMeshes);
  // Fire is carried by the pooled emissive atlas. Point lights participate in
  // every StandardMaterial shader even while their intensity is zero.
  const fireLights = [];
  for (const target of targets) {
    const base = _targetColor(target);
    bodies.setColorAt(target.index, base);
    roofs.setColorAt(target.index, base.clone().offsetHSL(0, -0.05, target.kind === 'bus' || target.kind === 'rv' ? 0.08 : -0.03));
    for (let side = 0; side < 2; side += 1) panels.setColorAt(target.index * 2 + side, base.clone().offsetHSL(0, side ? -0.03 : 0.03, side ? -0.08 : 0.08));
    for (let shard = 0; shard < 3; shard += 1) debris.setColorAt(target.index * 3 + shard, base.clone().lerp(new THREE.Color(0x53545c), 0.25 + shard * 0.2));
  }
  const arena = {
    definition,
    root,
    targets,
    targetById: new Map(targets.map((target) => [target.id, target])),
    bodies,
    roofs,
    canopies,
    panels,
    bumpers,
    wheels,
    debris,
    smoke,
    flameOuter,
    flameInner,
    explosions,
    fireLights,
    productionVfxAtlas: !!vfxAtlas,
    renderMeshes,
    destroyed: 0,
    repopulated: 0,
    time: 0,
    collapseCount: 0,
    collapseImpacts: 0,
    dominoImpacts: 0,
    explosionCount: 0,
    collapsedStructures: new Set(),
    dominoRunsStarted: new Set(),
    frameCollapseEvents: [],
    debrisCap: count * 3,
    smokeCap: count * 2,
    trafficModelRoot: null,
    trafficMeshes: [],
    trafficModelsAttached: false,
  };
  updateMonsterDestruction(arena, 0, null);
  return arena;
}

/** Attach the Blender-authored class silhouettes without changing collision truth. */
export function attachMonsterTrafficModels(arena, gltf) {
  if (!arena || !gltf?.scene || arena.trafficModelsAttached) return false;
  const trafficModelRoot = new THREE.Group();
  trafficModelRoot.name = `${arena.definition.id}-destructible-traffic-models`;
  const trafficMeshes = [];
  for (const kind of Object.keys(TRAFFIC_MODEL_NAMES)) {
    const classTargets = arena.targets.filter((target) => target.kind === kind);
    if (!classTargets.length) continue;
    const sourceName = TRAFFIC_MODEL_NAMES[kind];
    const source = gltf.scene.getObjectByName(sourceName);
    if (!source) {
      trafficModelRoot.clear();
      return false;
    }
    source.updateWorldMatrix(true, true);
    const inverseSource = source.matrixWorld.clone().invert();
    let componentIndex = 0;
    source.traverse((object) => {
      if (!object.isMesh) return;
      const sourceMatrix = inverseSource.clone().multiply(object.matrixWorld);
      const instances = new THREE.InstancedMesh(object.geometry, object.material, classTargets.length);
      instances.name = `arena-traffic-${kind}-component-${componentIndex}`;
      instances.userData.targetClass = kind;
      instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instances.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(classTargets.length * 3), 3);
      instances.castShadow = classTargets.length <= 18;
      instances.receiveShadow = true;
      instances.frustumCulled = false;
      trafficModelRoot.add(instances);
      trafficMeshes.push(instances);
      classTargets.forEach((target, index) => {
        const livery = _targetColor(target).lerp(new THREE.Color(0xffffff), target.kind === 'bus' ? 0.58 : 0.42);
        instances.setColorAt(index, livery);
        target.visualInstances ||= [];
        target.visualInstances.push({ mesh: instances, index, sourceMatrix });
        target.visualModelBase = TRAFFIC_MODEL_DIMENSIONS[kind] || TRAFFIC_MODEL_DIMENSIONS.sedan;
        target.visualTint = livery.getHex();
      });
      componentIndex += 1;
    });
  }
  arena.root.add(trafficModelRoot);
  arena.trafficModelRoot = trafficModelRoot;
  arena.trafficMeshes = trafficMeshes;
  arena.trafficModelsAttached = true;
  arena.bodies.visible = false;
  arena.roofs.visible = false;
  arena.canopies.visible = false;
  updateMonsterDestruction(arena, 0, null, { time: arena.time, run: arena.run });
  return true;
}

function _chainReaction(arena, source) {
  if (source.chainTriggered) return [];
  source.chainTriggered = true;
  // Domino runs have explicit ordered contacts. Letting the generic proximity
  // pulse fire here would flatten several cars at once and erase the readable
  // one-after-another motion.
  if (source.dominoGroup) return [];
  const chained = [];
  for (const target of arena.targets) {
    if (target === source || target.active === false || target.destroyed || target.hitCooldown > 0) continue;
    const reaction = monsterChainDamage(source, target);
    if (!(reaction.damage > 0)) continue;
    const transition = applyMonsterTargetDamage(target, reaction.damage, {
      vertical: reaction.sameStack,
      cooldown: 0.18,
    });
    if (!transition.applied) continue;
    if (transition.newlyDestroyed) arena.destroyed += 1;
    chained.push(target);
  }
  return chained;
}

function _checkRow(arena, run, rowId) {
  if (!rowId) return 0;
  const row = arena.targets.filter((target) => target.rowId === rowId);
  if (!row.length || !row.every((target) => target.destroyed)) return 0;
  return awardMonsterRow(run, rowId, row.length);
}

function _beginDominoFall(arena, target, source = 'impact', impulse = {}) {
  if (!target?.dominoGroup || target.dominoState === 'fallen') return false;
  const legacyDirection = typeof impulse === 'number' ? (impulse < 0 ? -1 : 1) : 1;
  const fallbackX = Math.sin(target.yaw || 0) * legacyDirection;
  const fallbackZ = Math.cos(target.yaw || 0) * legacyDirection;
  let impulseX = typeof impulse === 'object' ? Number(impulse.x) || 0 : fallbackX;
  let impulseZ = typeof impulse === 'object' ? Number(impulse.z) || 0 : fallbackZ;
  let impulseLength = Math.hypot(impulseX, impulseZ);
  if (impulseLength < 0.01) {
    impulseX = fallbackX;
    impulseZ = fallbackZ;
    impulseLength = 1;
  }
  impulseX /= impulseLength;
  impulseZ /= impulseLength;
  const speed = Math.max(5.5, typeof impulse === 'object' ? Number(impulse.speed) || 0 : 7.5);
  const mass = Math.max(0.65, Number(target.stats?.mass) || 1);
  const linearImpulse = speed * 0.16 / Math.sqrt(mass);
  target.vx += impulseX * linearImpulse;
  target.vz += impulseZ * linearImpulse;
  target.vy = Math.max(Number(target.vy) || 0, typeof impulse === 'object' ? Number(impulse.lift) || 0 : 0);
  target.angularVelocity += typeof impulse === 'object'
    ? Number(impulse.spin) || 0
    : legacyDirection * 0.18;

  if (target.dominoState === 'falling') {
    const momentumX = (Number(target.dominoFallX) || fallbackX) * Math.max(1, target.dominoTiltVelocity || 0)
      + impulseX * speed * 0.11;
    const momentumZ = (Number(target.dominoFallZ) || fallbackZ) * Math.max(1, target.dominoTiltVelocity || 0)
      + impulseZ * speed * 0.11;
    const momentumLength = Math.hypot(momentumX, momentumZ) || 1;
    target.dominoFallX = momentumX / momentumLength;
    target.dominoFallZ = momentumZ / momentumLength;
    target.dominoTiltVelocity = Math.min(6.8, (target.dominoTiltVelocity || 0) + speed * 0.045);
    return true;
  }

  target.dominoState = 'falling';
  target.dominoFallX = impulseX;
  target.dominoFallZ = impulseZ;
  const runForwardX = Math.sin(target.spawnYaw || target.yaw || 0);
  const runForwardZ = Math.cos(target.spawnYaw || target.yaw || 0);
  target.dominoDirection = impulseX * runForwardX + impulseZ * runForwardZ < 0 ? -1 : 1;
  target.dominoFallTime = 0;
  target.dominoTriggeredNext = false;
  target.dominoGroundImpacted = false;
  target.dominoHitTargets = new Set();
  target.dominoTiltVelocity = Math.min(5.8, 1.18 + speed * 0.115 + (target.index % 4) * 0.025);
  if (!arena.dominoRunsStarted.has(target.dominoGroup)) {
    arena.dominoRunsStarted.add(target.dominoGroup);
    if (arena.run) awardMonsterSignature(arena.run, `domino-run:${target.dominoGroup}`, 'DOMINO RUN', 1100);
  }
  arena.frameCollapseEvents.push({ type: 'domino-start', target, source, speed, direction: { x: impulseX, z: impulseZ } });
  return true;
}

function _recordDominoDamage(arena, target, damage, impactSpeed) {
  if (!target || !(damage > 0)) return { applied: false, newlyDestroyed: false, stateChanged: false };
  target.hitCooldown = 0;
  const transition = applyMonsterTargetDamage(target, damage, { vertical: false, cooldown: 0.12 });
  if (!transition.applied) return transition;
  if (transition.newlyDestroyed) arena.destroyed += 1;
  if (transition.stateChanged && arena.run) {
    awardMonsterTargetHit(arena.run, target, {
      state: target.state,
      basePoints: target.stats.score,
      speed: impactSpeed,
      verticalSpeed: 0,
    });
  }
  if (transition.newlyDestroyed && arena.run) _checkRow(arena, arena.run, target.rowId);
  return transition;
}

function _scheduleExplosion(target, delay = 0.16) {
  if (!target?.explosive || target.exploded) return false;
  if (target.explosionFuse < 0) target.explosionFuse = Math.max(0.02, Number(delay) || 0.16);
  else target.explosionFuse = Math.min(target.explosionFuse, Math.max(0.02, Number(delay) || 0.16));
  return true;
}

function _detonateTarget(arena, target, kart) {
  if (!target?.explosive || target.exploded) return false;
  target.exploded = true;
  target.explosionAge = 0;
  target.explosionFuse = -1;
  target.burning = false;
  arena.explosionCount += 1;
  if (!target.destroyed) _recordDominoDamage(arena, target, target.maxHealth * 1.6, 18);
  const radius = 14.5;
  for (const other of arena.targets) {
    if (other === target || other.active === false || other.exploded) continue;
    const dx = other.x - target.x;
    const dz = other.z - target.z;
    const distance = Math.hypot(dx, dz);
    if (distance > radius) continue;
    const falloff = 1 - distance / radius;
    const damage = other.maxHealth * (0.38 + falloff * 1.12);
    const transition = _recordDominoDamage(arena, other, damage, 10 + falloff * 12);
    const impulse = (4 + falloff * 10) / Math.max(0.85, other.stats.mass * 0.72);
    const length = distance || 1;
    other.vx += dx / length * impulse;
    other.vz += dz / length * impulse;
    other.angularVelocity += (other.index % 2 ? 1 : -1) * (0.45 + falloff * 0.9);
    if (other.dominoGroup) _beginDominoFall(arena, other, 'explosion', {
      x: dx / length,
      z: dz / length,
      speed: 9 + falloff * 14,
      lift: 2.2 + falloff * 5.4,
      spin: (other.index % 2 ? 1 : -1) * (0.45 + falloff * 1.4),
    });
    if (other.supportIds?.length) other.forceCollapse = true;
    if (other.explosive && (transition.newlyDestroyed || falloff > 0.58)) {
      _scheduleExplosion(other, 0.12 + (other.index % 4) * 0.045);
    }
  }
  if (kart) {
    const dx = kart.x - target.x;
    const dz = kart.z - target.z;
    const distance = Math.hypot(dx, dz);
    if (distance < radius + 2) {
      const falloff = 1 - distance / (radius + 2);
      const length = distance || 1;
      kart.vx += dx / length * (4 + falloff * 9);
      kart.vz += dz / length * (4 + falloff * 9);
      kart.vy = Math.max(kart.vy || 0, 2.4 + falloff * 5.2);
      kart.grounded = false;
      kart.pendingImpactStrength = Math.max(kart.pendingImpactStrength || 0, 0.7 + falloff * 0.65);
      applyKartDamage(kart, clamp(5 + falloff * 18, 0, 24), dx < 0 ? 'right' : 'left');
    }
  }
  if (arena.run) awardMonsterSignature(arena.run, `hot-car:${target.id}`, 'HOT CAR BOOM', 1250);
  arena.frameCollapseEvents.push({ type: 'explosion', target, speed: 22, radius });
  return true;
}

function _findDominoStrike(arena, target) {
  if ((target.dominoTilt || 0) < 0.42) return null;
  const leading = _dominoWorldPoint(
    target,
    0,
    target.stats.height * 0.45,
    target.stats.length * 0.96,
  );
  let best = null;
  for (const other of arena.targets) {
    if (other === target || other.active === false || !other.dominoGroup || other.dominoState !== 'standing') continue;
    if (target.dominoHitTargets?.has(other.id)) continue;
    const distance = Math.hypot(leading.x - other.x, leading.z - other.z);
    const radius = other.stats.width * 0.56 + 0.72;
    const verticalContact = leading.y >= other.bottom - 0.6 && leading.y <= other.top + 1.1;
    if (distance > radius || !verticalContact) continue;
    if (!best || distance < best.distance) best = { target: other, distance, leading };
  }
  return best;
}

function _stepDominoTarget(arena, target, dt) {
  if (!target.dominoGroup) return;
  target.ground = queryMonsterArenaGround(target.dominoPivotX, target.dominoPivotZ, arena.definition).height;
  if (target.dominoState === 'standing') {
    _syncDominoPose(target);
    return;
  }

  target.dominoFallTime += dt;
  target.dominoPivotX += (Number(target.vx) || 0) * dt;
  target.dominoPivotZ += (Number(target.vz) || 0) * dt;
  target.yaw += (Number(target.angularVelocity) || 0) * dt;
  target.ground = queryMonsterArenaGround(target.dominoPivotX, target.dominoPivotZ, arena.definition).height;

  if (target.dominoState === 'falling') {
    const tilt = Math.max(0, Number(target.dominoTilt) || 0);
    const gravityTorque = 0.72 + Math.sin(Math.min(Math.PI * 0.5, tilt)) * 5.1;
    target.dominoTiltVelocity = Math.min(7.4, (Number(target.dominoTiltVelocity) || 0) + gravityTorque * dt);
    target.dominoTiltVelocity *= Math.exp(-0.34 * dt);
    target.dominoTilt += target.dominoTiltVelocity * dt;
  }

  const airborne = (Number(target.dominoLift) || 0) > 0.001 || (Number(target.vy) || 0) > 0.001;
  if (airborne) {
    target.vy -= 16 * dt;
    target.dominoLift += target.vy * dt;
    if (target.dominoLift <= 0 && target.vy < 0) {
      target.dominoLift = 0;
      target.vy = 0;
    }
  }
  target.vx *= Math.exp(-(airborne ? 0.24 : 1.18) * dt);
  target.vz *= Math.exp(-(airborne ? 0.24 : 1.18) * dt);
  target.angularVelocity *= Math.exp(-(airborne ? 0.38 : 1.35) * dt);
  _syncDominoPose(target);

  if (target.dominoState === 'falling') {
    const strike = _findDominoStrike(arena, target);
    if (strike) {
      target.dominoHitTargets.add(strike.target.id);
      const dx = strike.target.dominoPivotX - target.dominoPivotX;
      const dz = strike.target.dominoPivotZ - target.dominoPivotZ;
      const length = Math.hypot(dx, dz) || 1;
      const tipSpeed = Math.max(7.5,
        (target.dominoTiltVelocity || 0) * target.stats.length * 0.78
          + Math.hypot(target.vx || 0, target.vz || 0));
      const transition = _recordDominoDamage(arena, strike.target, strike.target.maxHealth * 1.08, tipSpeed);
      _beginDominoFall(arena, strike.target, 'domino', {
        x: dx / length,
        z: dz / length,
        speed: tipSpeed,
        lift: Math.max(0, (target.vy || 0) * 0.28),
        spin: (target.angularVelocity || 0) * 0.46 + (target.index % 2 ? 0.12 : -0.12),
      });
      strike.target.vx += (target.vx || 0) * 0.42;
      strike.target.vz += (target.vz || 0) * 0.42;
      target.dominoTiltVelocity *= 0.68;
      target.vx *= 0.82;
      target.vz *= 0.82;
      target.dominoTriggeredNext = true;
      arena.dominoImpacts += 1;
      arena.frameCollapseEvents.push({ type: 'domino-impact', target, struck: strike.target, speed: tipSpeed });
      if (strike.target.explosive && transition.newlyDestroyed) _scheduleExplosion(strike.target, 0.18);
    }
  }

  if (target.bottom < target.ground && (target.dominoTilt || 0) > 1.38) {
    target.dominoLift += target.ground - target.bottom;
    _syncDominoPose(target);
    const impactSpeed = Math.max(
      Math.max(0, -(Number(target.vy) || 0)),
      (target.dominoTiltVelocity || 0) * target.stats.length * 0.52,
    );
    if (!target.dominoGroundImpacted && (target.dominoTilt || 0) > 1.12) {
      target.dominoGroundImpacted = true;
      const transition = _recordDominoDamage(arena, target, target.maxHealth * 1.12, impactSpeed);
      if (target.explosive && (transition.newlyDestroyed || target.destroyed)) _scheduleExplosion(target, 0.13);
      arena.frameCollapseEvents.push({ type: 'domino-ground', target, speed: impactSpeed });
    }
    target.dominoState = 'fallen';
    target.dominoTilt = Math.PI * 0.5;
    target.dominoTiltVelocity = 0;
    target.dominoLift = 0;
    target.vy = 0;
    target.vx *= 0.76;
    target.vz *= 0.76;
    _syncDominoPose(target);
  }

  const settled = target.dominoGroundImpacted
    && target.dominoFallTime > 0.48
    && Math.abs(target.vy || 0) < 1.15
    && (target.dominoLift || 0) < 0.16
    && (target.dominoTiltVelocity || 0) < 1.05;
  if (settled || target.dominoFallTime > 2.5) {
    target.dominoState = 'fallen';
    target.dominoTilt = Math.PI * 0.5;
    target.dominoTiltVelocity = 0;
    target.dominoLift = 0;
    target.vy = 0;
    _syncDominoPose(target);
  }
}

function _resolveDominoBodyContacts(arena) {
  const bodies = arena.targets.filter((target) => (
    target.active !== false && target.dominoGroup && target.dominoState !== 'standing'
  ));
  for (let index = 0; index < bodies.length; index += 1) {
    const a = bodies[index];
    for (let otherIndex = index + 1; otherIndex < bodies.length; otherIndex += 1) {
      const b = bodies[otherIndex];
      if (a.top < b.bottom - 0.35 || b.top < a.bottom - 0.35) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let distance = Math.hypot(dx, dz);
      const radiusA = Math.max(a.stats.width * 0.5, Math.min(a.stats.length * 0.38, (a.dominoHorizontalRadius || 0) * 0.48));
      const radiusB = Math.max(b.stats.width * 0.5, Math.min(b.stats.length * 0.38, (b.dominoHorizontalRadius || 0) * 0.48));
      const combined = radiusA + radiusB;
      if (distance >= combined) continue;
      if (distance < 0.01) {
        const angle = (a.index * 1.61803398875 + b.index * 0.73) % (Math.PI * 2);
        dx = Math.cos(angle);
        dz = Math.sin(angle);
        distance = 1;
      }
      const nx = dx / distance;
      const nz = dz / distance;
      const inverseMassA = 1 / Math.max(0.65, a.stats.mass);
      const inverseMassB = 1 / Math.max(0.65, b.stats.mass);
      const inverseMass = inverseMassA + inverseMassB;
      const penetration = combined - distance;
      const correction = penetration * 0.52 / inverseMass;
      a.dominoPivotX -= nx * correction * inverseMassA;
      a.dominoPivotZ -= nz * correction * inverseMassA;
      b.dominoPivotX += nx * correction * inverseMassB;
      b.dominoPivotZ += nz * correction * inverseMassB;
      const closing = Math.max(0, ((a.vx || 0) - (b.vx || 0)) * nx + ((a.vz || 0) - (b.vz || 0)) * nz);
      const impulse = (closing * 0.62 + penetration * 2.1) / inverseMass;
      a.vx -= nx * impulse * inverseMassA;
      a.vz -= nz * impulse * inverseMassA;
      b.vx += nx * impulse * inverseMassB;
      b.vz += nz * impulse * inverseMassB;
      const tangent = nx * ((a.vz || 0) - (b.vz || 0)) - nz * ((a.vx || 0) - (b.vx || 0));
      a.angularVelocity -= tangent * 0.055 * inverseMassA;
      b.angularVelocity += tangent * 0.055 * inverseMassB;
      if (closing > 2.8) {
        arena.frameCollapseEvents.push({ type: 'domino-body-impact', target: a, struck: b, speed: closing });
      }
    }
  }
}

export function resolveMonsterDestruction(arena, run, kart, options = {}) {
  if (!arena || !run || !kart) return [];
  const profile = options.vehicleProfile || { mass: 2.6, ramMultiplier: 1, collisionRadius: 2.65 };
  const events = [];
  for (const target of arena.targets) {
    if (target.active === false) continue;
    const impact = evaluateMonsterTargetImpact(target, kart, profile);
    if (!impact.qualifies) continue;
    const {
      verticalContact,
      wheelContact,
      axle,
      crushZone,
      horizontalSpeed,
      impactSpeed,
      contactNormal,
      verticalSpeed,
      damageEnergy,
    } = impact;
    const travelSpeed = Math.hypot(kart.vx || 0, kart.vz || 0);
    const pushX = travelSpeed > 0.1 ? (kart.vx || 0) / travelSpeed : -(contactNormal?.x || 0);
    const pushZ = travelSpeed > 0.1 ? (kart.vz || 0) / travelSpeed : -(contactNormal?.z || 0);
    const transition = applyMonsterTargetDamage(target, damageEnergy, {
      vertical: verticalContact,
      axle,
      crushZone,
      bypassCooldown: wheelContact,
    });
    if (!transition.applied) continue;
    const { newlyDestroyed, stateChanged } = transition;
    if (newlyDestroyed) arena.destroyed += 1;

    if (!target.dominoGroup) {
      target.vx += pushX * impactSpeed * 0.2 / Math.max(0.8, target.stats.mass);
      target.vz += pushZ * impactSpeed * 0.2 / Math.max(0.8, target.stats.mass);
      target.angularVelocity += ((target.index % 2) * 2 - 1) * impactSpeed * 0.028;
    }
    if (target.supportIds?.length && (newlyDestroyed || impactSpeed > 7.5)) target.forceCollapse = true;
    if (target.dominoGroup && (newlyDestroyed || impactSpeed > 6.5)) {
      const localOffsetX = (Number(kart.x) || 0) - (Number(target.x) || 0);
      const localOffsetZ = (Number(kart.z) || 0) - (Number(target.z) || 0);
      const torqueSign = localOffsetX * pushZ - localOffsetZ * pushX;
      _beginDominoFall(arena, target, 'truck', {
        x: pushX,
        z: pushZ,
        speed: impactSpeed,
        lift: verticalContact
          ? Math.max(0, verticalSpeed * 0.42)
          : Math.max(0, impactSpeed - 8) * 0.38,
        spin: clamp(torqueSign * 0.16, -1.8, 1.8),
      });
    }
    if (target.explosive && newlyDestroyed) _scheduleExplosion(target, 0.12);
    const retention = clamp(0.975 - target.stats.mass * 0.018 / Math.max(0.8, profile.mass || 2.6), 0.82, 0.97);
    kart.vx *= retention;
    kart.vz *= retention;
    const impactStrength = clamp((impactSpeed + verticalSpeed * 0.8) / 25, 0.18, 1.35);
    kart.impactStrength = Math.max(kart.impactStrength || 0, impactStrength);
    kart.pendingImpactStrength = Math.max(kart.pendingImpactStrength || 0, impactStrength);
    kart.suspensionVelocity = (kart.suspensionVelocity || 0) + impactStrength * (verticalContact ? 2.6 : 1.3);
    if (newlyDestroyed && kart.grounded && target.stats.mass < 2.2) {
      kart.grounded = false;
      kart.vy = Math.max(kart.vy || 0, 2.25 + target.stats.height * 0.38);
    }

    let points = 0;
    if (stateChanged) {
      points = awardMonsterTargetHit(run, target, {
        state: target.state,
        basePoints: target.stats.score,
        speed: impactSpeed,
        verticalSpeed,
      });
    }
    const chained = newlyDestroyed ? _chainReaction(arena, target) : [];
    if (newlyDestroyed && target.kind === 'derby' && chained.length) {
      points += awardMonsterSignature(run, `derby-domino:${target.id}`, 'DERBY DOMINO', 880);
    }
    let rowPoints = 0;
    if (newlyDestroyed) rowPoints = _checkRow(arena, run, target.rowId);
    events.push({
      target,
      points: points + rowPoints,
      impactSpeed: impactSpeed + verticalSpeed * 0.82,
      horizontalSpeed,
      verticalSpeed,
      axle,
      crushZone,
      impactStrength,
      stateChanged,
      destroyed: newlyDestroyed,
      chained,
    });
  }
  return events;
}

function _resetTarget(target, definition) {
  target.x = target.spawnX;
  target.z = target.spawnZ;
  target.yaw = target.spawnYaw;
  target.ground = queryMonsterArenaGround(target.x, target.z, definition).height;
  target.stackBaseY = Math.max(0, Number(target.stackBaseY) || (target.stackLevel || 0) * 1.05);
  target.spawnBaseY = target.ground + target.stackBaseY;
  target.baseY = target.spawnBaseY;
  target.bottom = target.baseY;
  target.y = target.baseY + target.stats.wheel + target.stats.height * 0.48;
  target.top = target.baseY + target.stats.height;
  target.health = target.maxHealth;
  target.state = 'intact';
  target.destroyed = false;
  target.damage = 0;
  target.crush = 0;
  target.crushFront = 0;
  target.crushRear = 0;
  target.crushVelocity = 0;
  target.vx = 0;
  target.vy = 0;
  target.vz = 0;
  target.angularVelocity = 0;
  target.pitch = target.dominoGroup ? target.dominoStartPitch : 0;
  target.roll = 0;
  target.pitchVelocity = 0;
  target.rollVelocity = 0;
  target.stackState = target.supportIds?.length ? 'supported' : 'grounded';
  target.supportLossTime = 0;
  target.forceCollapse = false;
  target.collapseImpactSpeed = 0;
  target.hitCooldown = 0.4;
  target.axleHits = { front: 0, rear: 0 };
  target.axleHitCooldowns = { front: 0, rear: 0 };
  target.destroyedAge = 0;
  target.chainTriggered = false;
  target.respawnProgress = 0;
  target.dominoPivotX = target.spawnX;
  target.dominoPivotZ = target.spawnZ;
  target.dominoState = target.dominoGroup ? 'standing' : 'none';
  target.dominoTilt = target.dominoGroup
    ? Math.max(0.025, Math.PI * 0.5 + target.dominoStartPitch)
    : 0;
  target.dominoTiltVelocity = 0;
  target.dominoFallX = Math.sin(target.spawnYaw || 0);
  target.dominoFallZ = Math.cos(target.spawnYaw || 0);
  target.dominoLift = 0;
  target.dominoGroundImpacted = false;
  target.dominoHitTargets = new Set();
  target.dominoDirection = 1;
  target.dominoTriggeredNext = false;
  target.dominoFallTime = 0;
  target.exploded = false;
  target.explosionAge = Infinity;
  target.explosionFuse = -1;
  target.burning = !!target.explosive;
  if (target.dominoGroup) _syncDominoPose(target);
}

function _syncDominoPose(target) {
  if (!target?.dominoGroup) return;
  const stats = target.stats;
  const center = _dominoWorldPoint(target, 0, stats.height * 0.5, stats.length * 0.5);
  let bottom = Infinity;
  let top = -Infinity;
  for (const localX of [-stats.width * 0.5, stats.width * 0.5]) {
    for (const localY of [0, stats.height]) {
      for (const localZ of [0, stats.length]) {
        const point = _dominoWorldPoint(target, localX, localY, localZ);
        bottom = Math.min(bottom, point.y);
        top = Math.max(top, point.y);
      }
    }
  }
  target.x = center.x;
  target.y = center.y;
  target.z = center.z;
  target.baseY = bottom;
  target.bottom = bottom;
  target.top = top;
  const fallX = Number(target.dominoFallX) || Math.sin(target.yaw || 0);
  const fallZ = Number(target.dominoFallZ) || Math.cos(target.yaw || 0);
  const forwardX = Math.sin(target.yaw || 0);
  const forwardZ = Math.cos(target.yaw || 0);
  const rightX = Math.cos(target.yaw || 0);
  const rightZ = -Math.sin(target.yaw || 0);
  const tilt = Number(target.dominoTilt) || 0;
  target.pitch = -Math.PI * 0.5 + tilt * (fallX * forwardX + fallZ * forwardZ);
  target.roll = tilt * (fallX * rightX + fallZ * rightZ);
  target.dominoHorizontalRadius = stats.width * 0.5
    + Math.abs(Math.sin(Math.min(Math.PI * 0.5, tilt))) * stats.length * 0.5;
}

function _syncTargetVertical(target) {
  if (target.dominoGroup) {
    _syncDominoPose(target);
    return;
  }
  const stats = target.stats;
  const stagedCrush = Math.max(
    target.crush || 0,
    ((target.crushFront || 0) + (target.crushRear || 0)) * 0.5,
  );
  const crushScale = Math.max(0.22, 1 - stagedCrush * 0.72);
  target.bottom = target.baseY;
  target.y = target.baseY + stats.wheel + stats.height * 0.48;
  target.top = target.baseY + stats.height * crushScale;
}

function _recordCollapseDamage(arena, target, damage, verticalSpeed) {
  if (!target || !(damage > 0)) return { applied: false, newlyDestroyed: false, stateChanged: false };
  target.hitCooldown = 0;
  const transition = applyMonsterTargetDamage(target, damage, { vertical: true, cooldown: 0.14 });
  if (!transition.applied) return transition;
  if (transition.newlyDestroyed) arena.destroyed += 1;
  if (transition.stateChanged && arena.run) {
    awardMonsterTargetHit(arena.run, target, {
      state: target.state,
      basePoints: target.stats.score,
      speed: 0,
      verticalSpeed,
    });
  }
  return transition;
}

function _beginStackCollapse(arena, target, status) {
  if (!target || ['falling', 'settled'].includes(target.stackState)) return false;
  target.stackState = 'falling';
  target.forceCollapse = false;
  target.supportLossTime = 0;
  target.vy = Math.min(Number(target.vy) || 0, -0.45 - (target.stackLevel || 0) * 0.08);
  const activeSupports = (status?.active || []).map((id) => arena.targetById.get(id)).filter(Boolean);
  let tipX = 0;
  let tipZ = 0;
  if (activeSupports.length) {
    const centerX = activeSupports.reduce((sum, support) => sum + support.x, 0) / activeSupports.length;
    const centerZ = activeSupports.reduce((sum, support) => sum + support.z, 0) / activeSupports.length;
    tipX = target.x - centerX;
    tipZ = target.z - centerZ;
  }
  if (Math.hypot(tipX, tipZ) < 0.05) {
    const angle = target.index * 2.399963229728653;
    tipX = Math.cos(angle);
    tipZ = Math.sin(angle);
  }
  const tipLength = Math.hypot(tipX, tipZ) || 1;
  const tipStrength = 1.1 + (target.stackLevel || 0) * 0.22;
  target.vx += tipX / tipLength * tipStrength;
  target.vz += tipZ / tipLength * tipStrength;
  target.pitchVelocity += (target.index % 2 ? 1 : -1) * (0.72 + (target.stackLevel || 0) * 0.13);
  target.rollVelocity += tipX / tipLength * (0.95 + (target.stackLevel || 0) * 0.14);
  const structureId = target.structureId || target.stackId || target.id;
  if (!arena.collapsedStructures.has(structureId)) {
    arena.collapsedStructures.add(structureId);
    arena.collapseCount += 1;
    if (arena.run) awardMonsterSignature(arena.run, `structure-collapse:${structureId}`, 'PYRAMID COLLAPSE', 1450);
  }
  arena.frameCollapseEvents.push({ type: 'support-loss', target, structureId, lostSupports: status?.lost || [] });
  return true;
}

function _updateStackSupport(arena, target, dt) {
  if (!target.supportIds?.length || ['falling', 'settled'].includes(target.stackState)) return;
  const status = monsterSupportStatus(target, arena.targetById);
  const dislodged = target.forceCollapse || Math.hypot(target.vx || 0, target.vz || 0) > 0.9;
  if (status.supported && !dislodged) {
    target.supportLossTime = 0;
    return;
  }
  target.supportLossTime += Math.max(0, dt || 0);
  const delay = dislodged ? 0 : 0.045 + (target.stackLevel || 0) * 0.035;
  if (target.supportLossTime >= delay) _beginStackCollapse(arena, target, status);
}

function _collapseContact(arena, target, previousBaseY) {
  let best = null;
  for (const other of arena.targets) {
    if (other === target || other.destroyed || other.stackState === 'falling') continue;
    if (other.baseY >= previousBaseY - 0.2) continue;
    if (other.top < target.baseY - 0.3 || other.top > previousBaseY + 0.35) continue;
    const targetRadius = Math.max(target.stats.width * 0.55, target.stats.length * 0.48);
    const otherRadius = Math.max(other.stats.width * 0.55, other.stats.length * 0.48);
    const distance = Math.hypot(target.x - other.x, target.z - other.z);
    if (distance > (targetRadius + otherRadius) * 0.72) continue;
    if (!best || other.top > best.top || (other.top === best.top && distance < best.distance)) best = { target: other, top: other.top, distance };
  }
  return best?.target || null;
}

function _stepFallingTarget(arena, target, dt, kart) {
  const previousBaseY = target.baseY;
  target.vy -= 20.5 * dt;
  target.x += target.vx * dt;
  target.z += target.vz * dt;
  target.baseY += target.vy * dt;
  target.yaw += target.angularVelocity * dt;
  target.pitch += target.pitchVelocity * dt;
  target.roll += target.rollVelocity * dt;
  target.angularVelocity *= Math.exp(-0.7 * dt);
  target.pitchVelocity *= Math.exp(-0.46 * dt);
  target.rollVelocity *= Math.exp(-0.5 * dt);
  target.ground = queryMonsterArenaGround(target.x, target.z, arena.definition).height;

  const struck = _collapseContact(arena, target, previousBaseY);
  if (struck && target.vy < -1.5) {
    const speed = Math.max(0, -target.vy);
    const strikeDamage = speed * (4.8 + target.stats.mass * 2.4);
    const struckTransition = _recordCollapseDamage(arena, struck, strikeDamage, speed);
    _recordCollapseDamage(arena, target, speed * 3.6, speed);
    target.collapseImpactSpeed = Math.max(target.collapseImpactSpeed || 0, speed);
    arena.collapseImpacts += 1;
    arena.frameCollapseEvents.push({ type: 'vehicle-impact', target, struck, speed });
    if (struckTransition.newlyDestroyed) {
      _chainReaction(arena, struck);
      target.vy *= 0.62;
    } else {
      target.baseY = struck.top + 0.03;
      target.vy = Math.max(0.8, speed * 0.14);
      const dx = target.x - struck.x;
      const dz = target.z - struck.z;
      const distance = Math.hypot(dx, dz) || 1;
      target.vx += dx / distance * 1.4;
      target.vz += dz / distance * 1.4;
    }
  }

  if (kart && target.vy < -1.8) {
    const distance = Math.hypot(target.x - kart.x, target.z - kart.z);
    const kartTop = (Number(kart.y) || 0) + 2.8;
    if (distance < Math.max(2.7, target.stats.width * 0.62) && target.baseY <= kartTop && target.top >= (kart.y || 0)) {
      const speed = Math.max(0, -target.vy);
      applyKartDamage(kart, clamp((speed - 1.5) * target.stats.mass * 0.55, 0, 24), target.x < kart.x ? 'left' : 'right');
      const pushX = (kart.x - target.x) / Math.max(0.1, distance);
      const pushZ = (kart.z - target.z) / Math.max(0.1, distance);
      kart.vx += pushX * speed * 0.22;
      kart.vz += pushZ * speed * 0.22;
      kart.pendingImpactStrength = Math.max(kart.pendingImpactStrength || 0, clamp(speed / 14, 0.25, 1.25));
      target.vy *= -0.08;
      arena.frameCollapseEvents.push({ type: 'truck-impact', target, speed });
    }
  }

  if (target.baseY <= target.ground) {
    const speed = Math.max(0, -target.vy);
    target.baseY = target.ground;
    target.vy = 0;
    target.stackState = 'settled';
    target.collapseImpactSpeed = Math.max(target.collapseImpactSpeed || 0, speed);
    target.pitch = clamp(target.pitch, -1.05, 1.05);
    target.roll = clamp(target.roll || (target.index % 2 ? 0.42 : -0.42), -1.1, 1.1);
    target.vx *= 0.46;
    target.vz *= 0.46;
    const transition = _recordCollapseDamage(arena, target, speed * (5.4 + target.stats.mass * 2.2), speed);
    if (transition.newlyDestroyed) _chainReaction(arena, target);
    arena.collapseImpacts += 1;
    arena.frameCollapseEvents.push({ type: 'ground-impact', target, speed });
  }
  _syncTargetVertical(target);
}

function _updateDerby(arena, target, dt, kart) {
  if (!target.ai || target.destroyed) return;
  const bowl = arena.definition.bowl;
  target.aiAngle += dt * (0.31 + (target.index % 3) * 0.035);
  const radius = 10.5 + (target.index % 3) * 3.1;
  let desiredX = bowl.x + Math.cos(target.aiAngle) * radius;
  let desiredZ = bowl.z + Math.sin(target.aiAngle) * radius * 0.74;
  if (kart && Math.hypot(kart.x - target.x, kart.z - target.z) < 15 && (Math.floor(arena.time * 0.4 + target.index) % 3 === 0)) {
    desiredX = kart.x;
    desiredZ = kart.z;
  }
  const desiredYaw = Math.atan2(desiredX - target.x, desiredZ - target.z);
  let delta = desiredYaw - target.yaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  target.yaw += clamp(delta, -1.4 * dt, 1.4 * dt);
  const targetSpeed = target.aiSpeed * (target.damage > 0.4 ? 0.72 : 1);
  target.vx += (Math.sin(target.yaw) * targetSpeed - target.vx) * Math.min(1, dt * 2.4);
  target.vz += (Math.cos(target.yaw) * targetSpeed - target.vz) * Math.min(1, dt * 2.4);
  target.x += target.vx * dt;
  target.z += target.vz * dt;
  target.ground = queryMonsterArenaGround(target.x, target.z, arena.definition).height;
  target.y = target.ground + target.stats.wheel + target.stats.height * 0.48;
  target.top = target.ground + target.stats.height;

  target.aiHitCooldown = Math.max(0, target.aiHitCooldown - dt);
  if (kart && kart.grounded && target.aiHitCooldown <= 0) {
    const dx = kart.x - target.x;
    const dz = kart.z - target.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 3.1) {
      const speed = Math.hypot(target.vx, target.vz);
      if (speed > 3.5) {
        const nx = dx / Math.max(0.01, distance);
        const nz = dz / Math.max(0.01, distance);
        kart.vx += nx * speed * 0.28;
        kart.vz += nz * speed * 0.28;
        kart.angularVelocity = (kart.angularVelocity || 0) + (target.index % 2 ? 0.28 : -0.28);
        applyKartDamage(kart, clamp((speed - 3) * 0.65, 0, 8), target.index % 2 ? 'left' : 'right');
        target.aiHitCooldown = 0.8;
        breakMonsterChain(arena.run, 'DERBY HIT');
      }
    }
  }
}

function _resolveDerbyTraffic(arena) {
  const active = arena.targets.filter((target) => target.ai && !target.destroyed);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= 3.3) continue;
      if (distance < 0.01) { dx = 1; dz = 0; distance = 1; }
      const nx = dx / distance;
      const nz = dz / distance;
      const relative = Math.max(0, (a.vx - b.vx) * nx + (a.vz - b.vz) * nz);
      const separation = (3.3 - distance) * 0.5;
      a.x -= nx * separation;
      a.z -= nz * separation;
      b.x += nx * separation;
      b.z += nz * separation;
      const impulse = Math.max(1.2, relative) * 0.32;
      a.vx -= nx * impulse;
      a.vz -= nz * impulse;
      b.vx += nx * impulse;
      b.vz += nz * impulse;
      if (relative < 4 || a.aiHitCooldown > 0 || b.aiHitCooldown > 0) continue;
      const damage = clamp((relative - 3) * 1.15, 2, 16);
      for (const target of [a, b]) {
        const transition = applyMonsterTargetDamage(target, damage, { cooldown: 0.24 });
        target.aiHitCooldown = 0.55;
        if (transition.newlyDestroyed) arena.destroyed += 1;
      }
    }
  }
}

export function updateMonsterDestruction(arena, dt, kart, options = {}) {
  if (!arena) return [];
  arena.time = Number(options.time) || arena.time + Math.max(0, dt || 0);
  arena.run = options.run || arena.run;
  arena.frameCollapseEvents = [];
  for (const target of arena.targets) {
    if (target.active === false) continue;
    target.hitCooldown = Math.max(0, target.hitCooldown - dt);
    target.axleHitCooldowns ||= { front: 0, rear: 0 };
    target.axleHitCooldowns.front = Math.max(0, target.axleHitCooldowns.front - dt);
    target.axleHitCooldowns.rear = Math.max(0, target.axleHitCooldowns.rear - dt);
    _updateDerby(arena, target, dt, kart);
  }
  _resolveDerbyTraffic(arena);
  for (const target of arena.targets) if (target.active !== false) _updateStackSupport(arena, target, dt);
  // Advance all domino bodies before rendering any of them so contacts use one
  // coherent frame of motion instead of array-order-dependent canned timing.
  for (const target of arena.targets) {
    if (target.active !== false && target.dominoGroup) _stepDominoTarget(arena, target, dt);
  }
  _resolveDominoBodyContacts(arena);
  for (const target of arena.targets) {
    if (target.active === false) {
      if (target.visualHidden) continue;
      const hidden = 0.0001;
      arena.bodies.setMatrixAt(target.index, _compose(target.spawnX, -30, target.spawnZ, target.spawnYaw, hidden, hidden, hidden));
      arena.roofs.setMatrixAt(target.index, _compose(target.spawnX, -30, target.spawnZ, target.spawnYaw, hidden, hidden, hidden));
      arena.canopies.setMatrixAt(target.index, _compose(target.spawnX, -30, target.spawnZ, target.spawnYaw, hidden, hidden, hidden));
      for (const instance of target.visualInstances || []) instance.mesh.setMatrixAt(instance.index, _compose(target.spawnX, -30, target.spawnZ, 0, hidden, hidden, hidden));
      for (let i = 0; i < 2; i += 1) {
        arena.panels.setMatrixAt(target.index * 2 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
        arena.bumpers.setMatrixAt(target.index * 2 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
        arena.smoke.setMatrixAt(target.index * 2 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
        arena.flameOuter.setMatrixAt(target.index * 2 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
        arena.flameInner.setMatrixAt(target.index * 2 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
      }
      for (let i = 0; i < 4; i += 1) {
        arena.wheels.setMatrixAt(target.index * 4 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
        arena.explosions.setMatrixAt(target.index * 4 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
      }
      for (let i = 0; i < 3; i += 1) arena.debris.setMatrixAt(target.index * 3 + i, _compose(0, -30, 0, 0, hidden, hidden, hidden));
      target.visualHidden = true;
      continue;
    }
    target.visualHidden = false;
    if (target.dominoGroup) {
      _syncDominoPose(target);
    } else if (target.stackState === 'falling') {
      _stepFallingTarget(arena, target, dt, kart);
    } else if (!target.ai || target.destroyed) {
      target.x += target.vx * dt;
      target.z += target.vz * dt;
      target.vx *= Math.exp(-2.4 * dt);
      target.vz *= Math.exp(-2.4 * dt);
      target.yaw += target.angularVelocity * dt;
      target.angularVelocity *= Math.exp(-2.2 * dt);
    }
    if (!target.dominoGroup && target.stackState !== 'falling') {
      target.ground = queryMonsterArenaGround(target.x, target.z, arena.definition).height;
      target.baseY = target.stackState === 'supported' ? target.spawnBaseY : target.ground;
      _syncTargetVertical(target);
    }
    if (target.explosionFuse >= 0) {
      target.explosionFuse -= dt;
      if (target.explosionFuse <= 0) _detonateTarget(arena, target, kart);
    }
    if (target.exploded) target.explosionAge += dt;
    if (target.destroyed) {
      target.destroyedAge += dt;
      if (!target.dominoGroup || target.dominoState === 'fallen') {
        target.crushVelocity += dt * 3.7;
        target.crush = clamp(target.crush + dt * (1.5 + target.crushVelocity), 0, 1);
        target.crushFront = clamp(Math.max(target.crushFront || 0, target.crush), 0, 1);
        target.crushRear = clamp(Math.max(target.crushRear || 0, target.crush), 0, 1);
      }
      if (canRepopulateMonsterTarget(target, kart, arena.definition)) {
        _resetTarget(target, arena.definition);
        arena.destroyed = Math.max(0, arena.destroyed - 1);
        arena.repopulated += 1;
      }
    } else if (target.respawnProgress < 1) {
      target.respawnProgress = clamp(target.respawnProgress + dt * 0.65, 0, 1);
    }
    _syncTargetVertical(target);

    const stats = target.stats;
    const index = target.index;
    const damage = target.damage;
    const crush = target.crush;
    const crushFront = Math.max(crush, target.crushFront || 0);
    const crushRear = Math.max(crush, target.crushRear || 0);
    const sectionCrush = Math.max(crushFront, crushRear);
    const crushBias = crushFront - crushRear;
    const direction = index % 2 ? 1 : -1;
    const lengthScale = stats.length / MONSTER_TARGET_CLASSES.sedan.length;
    const widthScale = stats.width / MONSTER_TARGET_CLASSES.sedan.width;
    const heightScale = stats.height / MONSTER_TARGET_CLASSES.sedan.height;
    const appear = Math.max(0.0001, target.respawnProgress);
    if (target.dominoGroup) {
      arena.bodies.setMatrixAt(index, _composeDominoPart(
        target,
        stats.wheel + stats.height * 0.48 - crush * stats.height * 0.27,
        stats.length * 0.5,
        widthScale * (1 + damage * 0.08) * appear,
        heightScale * Math.max(0.16, 1 - crush * 0.78 - damage * 0.12) * appear,
        lengthScale * (1 - damage * 0.06) * appear,
        0,
        direction * damage * 0.08,
      ));
    } else {
      const bodyShift = crushBias * stats.length * 0.075;
      arena.bodies.setMatrixAt(index, _compose(
        target.x + Math.sin(target.yaw) * bodyShift,
        target.y - sectionCrush * stats.height * 0.25,
        target.z + Math.cos(target.yaw) * bodyShift,
        target.yaw,
        widthScale * (1 + damage * 0.08) * appear,
        heightScale * Math.max(0.16, 1 - sectionCrush * 0.78 - damage * 0.12) * appear,
        lengthScale * (1 - damage * 0.045 - sectionCrush * 0.1) * appear,
        target.pitch + damage * 0.05 + crushBias * 0.12,
        target.roll + direction * damage * 0.08,
      ));
    }

    const isTall = target.kind === 'bus' || target.kind === 'rv' || target.kind === 'van';
    if (target.dominoGroup) {
      arena.roofs.setMatrixAt(index, _composeDominoPart(
        target,
        stats.wheel + stats.height * (isTall ? 0.86 : 0.72) - crush * stats.height * 0.34,
        stats.length * (isTall ? 0.48 : 0.45),
        widthScale * (isTall ? 1.03 : 0.86) * appear,
        heightScale * (isTall ? 1.25 : 0.72) * Math.max(0.14, 1 - crush * 0.7) * appear,
        lengthScale * (isTall ? 0.95 : 0.64) * appear,
        0,
        direction * damage * 0.1,
      ));
    } else {
      const roofShift = crushBias * stats.length * 0.11;
      arena.roofs.setMatrixAt(index, _compose(
        target.x + Math.sin(target.yaw) * roofShift,
        target.y + stats.height * (isTall ? 0.38 : 0.24) - sectionCrush * stats.height * 0.34,
        target.z + Math.cos(target.yaw) * roofShift - Math.sin(target.yaw) * stats.length * 0.05,
        target.yaw + direction * damage * 0.06,
        widthScale * (isTall ? 1.03 : 0.86) * appear,
        heightScale * (isTall ? 1.25 : 0.72) * Math.max(0.14, 1 - sectionCrush * 0.7) * appear,
        lengthScale * (isTall ? 0.95 : 0.64) * appear,
        target.pitch + damage * 0.08 + crushBias * 0.16,
        target.roll + direction * damage * 0.1,
      ));
    }
    const canopyScale = isTall ? 0.0001 : appear;
    if (target.dominoGroup) {
      arena.canopies.setMatrixAt(index, _composeDominoPart(
        target,
        stats.wheel + stats.height * 0.83 - crush * 0.48,
        stats.length * 0.54,
        widthScale * 0.95 * canopyScale,
        heightScale * 0.76 * Math.max(0.12, 1 - crush * 0.75) * canopyScale,
        lengthScale * 1.12 * canopyScale,
        0,
        direction * damage * 0.14,
      ));
    } else {
      const canopyShift = crushBias * stats.length * 0.08;
      arena.canopies.setMatrixAt(index, _compose(
        target.x + Math.sin(target.yaw) * canopyShift,
        target.y + stats.height * 0.35 - sectionCrush * 0.48,
        target.z + Math.cos(target.yaw) * (0.18 + canopyShift),
        target.yaw, widthScale * 0.95 * canopyScale, heightScale * 0.76 * Math.max(0.12, 1 - sectionCrush * 0.75) * canopyScale, lengthScale * (1 - sectionCrush * 0.1) * 1.12 * canopyScale,
        target.pitch + damage * 0.16 + crushBias * 0.19, target.roll + direction * damage * 0.14,
      ));
    }

    if (target.visualInstances?.length) {
      const base = target.visualModelBase || TRAFFIC_MODEL_DIMENSIONS.sedan;
      if (target.dominoGroup) {
        _targetMatrix.copy(_composeDominoPart(
          target,
          -crush * stats.height * 0.08,
          stats.length * 0.5,
          stats.width / base.width * (1 + damage * 0.055) * appear,
          stats.height / base.height * Math.max(0.13, 1 - crush * 0.8 - damage * 0.1) * appear,
          stats.length / base.length * (1 - damage * 0.045) * appear,
          0,
          direction * (damage * 0.07 + crush * 0.1),
        ));
      } else {
        const modelShift = crushBias * stats.length * 0.08;
        _targetMatrix.copy(_compose(
          target.x + Math.sin(target.yaw) * modelShift,
          target.baseY - sectionCrush * stats.height * 0.08,
          target.z + Math.cos(target.yaw) * modelShift,
          target.yaw + direction * damage * 0.035,
          stats.width / base.width * (1 + damage * 0.055) * appear,
          stats.height / base.height * Math.max(0.13, 1 - sectionCrush * 0.8 - damage * 0.1) * appear,
          stats.length / base.length * (1 - damage * 0.035 - sectionCrush * 0.08) * appear,
          target.pitch + damage * 0.045 + sectionCrush * 0.035 + crushBias * 0.1,
          target.roll + direction * (damage * 0.07 + crush * 0.1),
        ));
      }
      for (const instance of target.visualInstances) {
        _modelMatrix.multiplyMatrices(_targetMatrix, instance.sourceMatrix);
        instance.mesh.setMatrixAt(instance.index, _modelMatrix);
        const visualColorStamp = `${Math.round(damage * 4)}:${Math.round(sectionCrush * 4)}:${target.destroyed ? 1 : 0}`;
        if (target.visualColorStamp !== visualColorStamp) {
          _visualColor.setHex(target.visualTint || 0xffffff)
            .lerp(_wreckColor, clamp(damage * 0.48 + sectionCrush * 0.34, 0, 0.72));
          if (target.destroyed) _visualColor.multiplyScalar(0.72);
          instance.mesh.setColorAt(instance.index, _visualColor);
        }
      }
      target.visualColorStamp = `${Math.round(damage * 4)}:${Math.round(sectionCrush * 4)}:${target.destroyed ? 1 : 0}`;
    }

    for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
      const side = sideIndex ? 1 : -1;
      const flight = target.destroyed ? crush * (0.8 + (index % 3) * 0.18) : damage * 0.12;
      const point = _localPoint(target, side * (stats.width * 0.5 + flight), direction * crush * 0.22);
      arena.panels.setMatrixAt(index * 2 + sideIndex, _compose(
        point.x, target.y + Math.sin(crush * Math.PI) * (0.45 + sideIndex * 0.17) - crush * 0.18, point.z,
        target.yaw + side * crush * 0.6,
        lengthScale * 0.85 * appear, heightScale * Math.max(0.4, 1 - damage * 0.3) * appear, 1 * appear,
        target.pitch + side * crush * (1.15 + sideIndex * 0.2), target.roll + direction * crush * 0.72,
      ));
      const front = sideIndex ? 1 : -1;
      const axleCrush = front > 0 ? crushFront : crushRear;
      const bumperPoint = _localPoint(target, direction * axleCrush * 0.16, front * (stats.length * 0.5 + axleCrush * 0.28));
      arena.bumpers.setMatrixAt(index * 2 + sideIndex, _compose(
        bumperPoint.x, target.baseY + stats.wheel * 0.72 + Math.sin(axleCrush * Math.PI) * 0.35, bumperPoint.z,
        target.yaw + direction * axleCrush * 0.25,
        widthScale * appear, 1 * appear, 1 * appear,
        axleCrush * (sideIndex ? 0.5 : -0.36), direction * axleCrush * 0.22,
      ));
    }

    for (let wheelIndex = 0; wheelIndex < 4; wheelIndex += 1) {
      const side = wheelIndex < 2 ? -1 : 1;
      const front = wheelIndex % 2 ? 1 : -1;
      const axleCrush = front > 0 ? crushFront : crushRear;
      const point = _localPoint(target, side * stats.width * 0.51 * (1 + axleCrush * 0.16), front * stats.length * 0.31);
      const pop = axleCrush > 0.16 ? Math.sin(axleCrush * Math.PI) * (0.55 + wheelIndex * 0.09) : 0;
      arena.wheels.setMatrixAt(index * 4 + wheelIndex, _compose(
        point.x, target.baseY + stats.wheel + pop, point.z, target.yaw,
        stats.wheel / 0.36 * appear, stats.wheel / 0.36 * appear, stats.wheel / 0.36 * appear,
        axleCrush * (2.8 + wheelIndex), axleCrush * (wheelIndex - 1.5),
      ));
    }
    for (let shard = 0; shard < 3; shard += 1) {
      const angle = target.yaw + index * 1.31 + shard * Math.PI * 2 / 3;
      const distance = crush * (0.9 + shard * 0.4 + stats.mass * 0.1);
      const scale = target.destroyed ? 0.7 + shard * 0.18 : 0.0001;
      arena.debris.setMatrixAt(index * 3 + shard, _compose(
        target.x + Math.cos(angle) * distance,
        target.baseY + 0.16 + Math.sin(crush * Math.PI) * (0.7 + shard * 0.22),
        target.z + Math.sin(angle) * distance,
        angle + crush * 2.5,
        scale, scale * 0.7, scale,
        crush * (2 + shard), direction * crush * (1.4 + shard * 0.4),
      ));
    }
    for (let puff = 0; puff < 2; puff += 1) {
      const smokeVisible = (damage >= 0.36 && !target.destroyed) || (target.burning && !target.exploded);
      const rise = smokeVisible ? (arena.time * (0.35 + puff * 0.08) + index * 0.17) % 1.5 : 0;
      const scale = smokeVisible ? ((target.burning ? 0.72 : 0.5) + rise * 0.42) : 0.0001;
      arena.smoke.setMatrixAt(index * 2 + puff, _compose(
        target.x + Math.sin(index + puff * 2.4) * 0.35,
        target.top - crush * 0.4 + rise,
        target.z + Math.cos(index * 0.7 + puff) * 0.3,
        arena.productionVfxAtlas ? Math.PI * 0.25 : arena.time * 0.2,
        scale, scale, scale,
      ));

      const fireVisible = target.burning && !target.exploded;
      const flicker = fireVisible ? 0.82 + (Math.sin(arena.time * 18 + index * 1.7 + puff * 2.2) + 1) * 0.18 : 0.0001;
      const firePoint = target.dominoGroup
        ? _dominoWorldPoint(target, (puff ? 1 : -1) * stats.width * 0.18, stats.height * 0.72, stats.length * 0.22)
        : { ..._localPoint(target, (puff ? 1 : -1) * stats.width * 0.18, stats.length * 0.22), y: target.baseY + stats.height * 0.9 };
      arena.flameOuter.setMatrixAt(index * 2 + puff, _compose(
        firePoint.x,
        firePoint.y + 0.55 * flicker,
        firePoint.z,
        arena.productionVfxAtlas ? Math.PI * 0.25 : arena.time * 0.7 + puff,
        0.78 * flicker,
        1.2 * flicker,
        0.78 * flicker,
      ));
      arena.flameInner.setMatrixAt(index * 2 + puff, _compose(
        firePoint.x,
        firePoint.y + 0.38 * flicker,
        firePoint.z,
        arena.productionVfxAtlas ? Math.PI * 0.25 : -arena.time * 0.55 + puff,
        0.62 * flicker,
        0.94 * flicker,
        0.62 * flicker,
      ));
    }
    for (let burst = 0; burst < 4; burst += 1) {
      const explosionVisible = target.exploded && target.explosionAge < 0.92;
      const progress = explosionVisible ? clamp(target.explosionAge / 0.92, 0, 1) : 1;
      const angle = burst / 4 * Math.PI * 2 + target.index * 0.73;
      const radius = explosionVisible ? (0.8 + progress * 5.8) * (0.72 + burst * 0.08) : 0;
      const scale = explosionVisible ? Math.max(0.0001, (1 - progress) * 2.8 + 0.35) : 0.0001;
      arena.explosions.setMatrixAt(index * 4 + burst, _compose(
        target.x + Math.cos(angle) * radius,
        target.baseY + 1.4 + Math.sin(progress * Math.PI) * (2.8 + burst * 0.35),
        target.z + Math.sin(angle) * radius,
        arena.productionVfxAtlas ? Math.PI * 0.25 : angle + progress * 2.4,
        scale * (1 + burst * 0.08),
        scale,
        scale * (0.9 + burst * 0.06),
      ));
    }
  }
  const burningTargets = arena.targets.filter((target) => target.active !== false && target.burning && !target.exploded);
  for (let index = 0; index < (arena.fireLights?.length || 0); index += 1) {
    const light = arena.fireLights[index];
    const target = burningTargets[index];
    if (!target) {
      light.intensity = 0;
      continue;
    }
    const point = target.dominoGroup
      ? _dominoWorldPoint(target, 0, target.stats.height * 0.72, target.stats.length * 0.16)
      : { x: target.x, y: target.baseY + target.stats.height * 0.9, z: target.z };
    light.position.set(point.x, point.y + 1.1, point.z);
    light.intensity = 6.5 + Math.sin(arena.time * 15 + target.index) * 1.3;
  }
  _finishInstances(arena);
  return arena.frameCollapseEvents;
}

export function refillMonsterDestruction(arena, kart = null) {
  if (!arena) return 0;
  let reset = 0;
  for (const target of arena.targets) {
    const initialStackState = target.supportIds?.length ? 'supported' : 'grounded';
    const dominoMoved = target.dominoGroup && target.dominoState !== 'standing';
    if (target.destroyed || target.damage > 0 || target.stackState !== initialStackState || dominoMoved || target.exploded) {
      if (kart && Math.hypot(
        (Number(kart.x) || 0) - (Number(target.spawnX) || 0),
        (Number(kart.z) || 0) - (Number(target.spawnZ) || 0),
      ) < Math.max(5.5, (Number(target.stats?.length) || 4) * 0.72)) continue;
      _resetTarget(target, arena.definition);
      target.respawnProgress = 1;
      reset += 1;
    }
  }
  arena.destroyed = 0;
  arena.collapseCount = 0;
  arena.collapseImpacts = 0;
  arena.dominoImpacts = 0;
  arena.explosionCount = 0;
  arena.collapsedStructures.clear();
  arena.dominoRunsStarted.clear();
  updateMonsterDestruction(arena, 0, null);
  return reset;
}

/** Reset and reveal only the targets assigned to the current timed round. */
export function configureMonsterDestructionRound(arena, targetIds = []) {
  if (!arena) return 0;
  const activeIds = new Set(targetIds);
  for (const target of arena.targets) {
    _resetTarget(target, arena.definition);
    target.active = activeIds.has(target.id);
    target.respawnProgress = target.active ? 1 : 0;
    target.hitCooldown = 0;
  }
  arena.destroyed = 0;
  arena.collapseCount = 0;
  arena.collapseImpacts = 0;
  arena.dominoImpacts = 0;
  arena.explosionCount = 0;
  arena.collapsedStructures.clear();
  arena.dominoRunsStarted.clear();
  updateMonsterDestruction(arena, 0, null);
  return activeIds.size;
}

export function monsterDestructionSnapshot(arena) {
  const byState = {};
  const byClass = {};
  for (const target of arena?.targets || []) {
    byState[target.state] = (byState[target.state] || 0) + 1;
    byClass[target.kind] = (byClass[target.kind] || 0) + 1;
  }
  return {
    total: arena?.targets?.length || 0,
    destroyed: arena?.destroyed || 0,
    repopulated: arena?.repopulated || 0,
    byState,
    byClass,
    derbyActive: arena?.targets?.filter((target) => target.ai && !target.destroyed).length || 0,
    debrisCap: arena?.debrisCap || 0,
    smokeCap: arena?.smokeCap || 0,
    trafficModelsAttached: !!arena?.trafficModelsAttached,
    trafficModelClasses: new Set((arena?.targets || []).filter((target) => target.visualInstances?.length).map((target) => target.kind)).size,
    productionVfxAtlas: !!arena?.productionVfxAtlas,
    fireLights: arena?.fireLights?.length || 0,
    structures: new Set((arena?.targets || []).map((target) => target.structureId).filter(Boolean)).size,
    falling: arena?.targets?.filter((target) => target.stackState === 'falling').length || 0,
    settled: arena?.targets?.filter((target) => target.stackState === 'settled').length || 0,
    collapseCount: arena?.collapseCount || 0,
    collapseImpacts: arena?.collapseImpacts || 0,
    dominoStanding: arena?.targets?.filter((target) => target.dominoState === 'standing').length || 0,
    dominoFalling: arena?.targets?.filter((target) => target.dominoState === 'falling').length || 0,
    dominoFallen: arena?.targets?.filter((target) => target.dominoState === 'fallen').length || 0,
    dominoRuns: arena?.dominoRunsStarted?.size || 0,
    dominoImpacts: arena?.dominoImpacts || 0,
    hotCars: arena?.targets?.filter((target) => target.explosive).length || 0,
    burningCars: arena?.targets?.filter((target) => target.burning && !target.exploded).length || 0,
    explosions: arena?.explosionCount || 0,
  };
}
