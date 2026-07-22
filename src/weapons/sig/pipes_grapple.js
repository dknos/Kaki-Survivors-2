/**
 * Pipes' manual Rescue Hook.
 *
 * This helper is intentionally separate from pipes_arcwrench.js: Arc Wrench
 * keeps its automatic line bolt, while this module owns the hold-secondary
 * interaction and its one-target transient state. The integration contract is:
 *
 *   init(state, level, inst)
 *   tick(state, dt, level, inst)
 *   refresh(state, level, inst)
 *   dispose(state, inst)
 *
 * A held enemy carries `enemy._combatControl === inst.grappleControl`. The
 * central primary-projectile hit path may increment `.charge` on that record;
 * this module turns the charge into faster orbit and a stronger throw.
 *
 * Rendering is bounded: one persistent hook clone, one 28-link InstancedMesh,
 * and one optional charge-emblem sprite. No render object or query array is
 * allocated in tick().
 */
import * as THREE from 'three';
import {
  isSecondaryActionHeld,
  getAimDirection,
  isManualAiming,
} from '../../input.js';
import {
  queryRadiusInto,
  damageEnemy,
  setControlledEnemyXZ,
  applyVulnerability,
} from '../../enemies.js';
import { cloneCached, upgradeMaterials } from '../../assets.js';
import { sfx } from '../../audio.js';
import { spawnImpactBurst } from '../../vfxBurst.js';

const PHASE_IDLE   = 'idle';
const PHASE_FLYING = 'flying';
const PHASE_ORBIT  = 'orbit';
const PHASE_THROWN = 'thrown';

const CHAIN_CAP = 28;
const CHAIN_SPACING = 0.47;
const FLIGHT_SPEED = 46;
const MISS_COOLDOWN = 0.38;
const CONTROL_GRACE = 0.22;
const THROW_LIFE = 0.72;
const THROW_MIN_AGE = 0.16;
const THROW_HIT_RADIUS = 1.05;
const ORBIT_HIT_RADIUS = 1.18;
const ORBIT_HIT_INTERVAL = 0.16;
const MAX_THROW_HITS = 8;
const TARGET_CONE_DOT = 0.45;
const AUTO_CONE_DOT = -0.05;
const TAU = Math.PI * 2;

let _visualRoot = null;
let _hookPivot = null;
let _chain = null;
let _chainMat = null;
let _emblem = null;
let _activeInst = null;
let _nextLaunchId = 1;
let _visualAllocations = 0;
let _lastVisualCharge = -1;

const _targetBuf = [];
const _throwBuf = [];
const _orbitBuf = [];
const _aimDir = { x: 0, z: 1 };
const _probePos = new THREE.Vector3();
const _box = new THREE.Box3();
const _boxSize = new THREE.Vector3();
const _boxCenter = new THREE.Vector3();
const _linkPos = new THREE.Vector3();
const _linkScale = new THREE.Vector3(1, 1, 1);
const _linkQuat = new THREE.Quaternion();
const _linkMatrix = new THREE.Matrix4();
const _linkA = new THREE.Vector3();
const _linkB = new THREE.Vector3();
const _linkDelta = new THREE.Vector3();
const _linkUp = new THREE.Vector3(0, 1, 0);
const _chainIdle = new THREE.Color(0xd9aa56);
const _chainHot = new THREE.Color(0x72f7ff);
const _chainColor = new THREE.Color();

// Reused debug object: inspection itself does not create a stream of snapshots.
const _debug = Object.seal({
  eligible: false,
  phase: PHASE_IDLE,
  targetUuid: null,
  targetKind: null,
  orbitAngle: 0,
  orbitRadius: 0,
  charge: 0,
  cooldown: 0,
  ropeLength: 0,
  chainCount: 0,
  hookVisible: false,
  emblemVisible: false,
  activeVisuals: 0,
  poolCapacity: CHAIN_CAP,
  allocationCount: 0,
  launchId: 0,
  throwHits: 0,
  lastReleaseSpeed: 0,
  lastHitTargetUuid: null,
  lastHitDamage: 0,
  lastCancelReason: null,
});

function _clamp01(v) {
  return v <= 0 ? 0 : (v >= 1 ? 1 : v);
}

function _smoothstep(v) {
  const k = _clamp01(v);
  return k * k * (3 - 2 * k);
}

function _combatMode(mode) {
  return mode === 'run' || mode === 'catacomb';
}

function _enemyPos(enemy) {
  if (!enemy) return null;
  return enemy.mesh ? enemy.mesh.position : enemy.pos;
}

function _enemyUuid(enemy) {
  return enemy && enemy.mesh && enemy.mesh.uuid
    ? enemy.mesh.uuid
    : (enemy && enemy.glbKey ? String(enemy.glbKey) : null);
}

/** Bosses, world objectives and anything already under external control reject. */
function _canGrab(enemy) {
  if (!enemy || !enemy.alive || !enemy.mesh || enemy.mesh.visible === false) return false;
  if (enemy._heavy || enemy._noKnockback || enemy.isFinalBoss || enemy.isMiniBoss
      || enemy.isBoss || enemy.isNemesis) return false;
  if (enemy.isTotem || enemy.isPylon || enemy.isBell || enemy.isDestructible) return false;
  if (enemy._combatControl) return false;
  // A null key means the enemy was parked/retired from the live spatial hash.
  if (enemy._spatialKey == null) return false;
  return true;
}

function _canTakeCollateral(enemy, thrown) {
  if (!enemy || enemy === thrown || !enemy.alive || !enemy.mesh) return false;
  if (enemy.isTotem || enemy.isPylon || enemy.isBell || enemy.isDestructible) return false;
  return true;
}

function _writeTune(level, out) {
  const rawDmg = Number(level && level.dmg) || 12;
  // Current Arc Wrench rows span 12..60. Explicit hook fields win when the
  // signature table later grows authored values; these fallbacks need no table edit.
  const p = _clamp01((rawDmg - 12) / 48);
  out.range = Number(level && level.hookRange) || (10 + 5 * p);
  out.cooldown = Number(level && level.hookCooldown) || (3.5 - 1.5 * p);
  out.orbitRadius = Number(level && level.hookOrbitRadius) || (3.15 + 0.25 * p);
  out.orbitSpeed = Number(level && level.hookOrbitSpeed) || (2.15 + 0.85 * p);
  out.maxHold = Number(level && level.hookMaxHold) || (1.5 + 0.9 * p);
  out.throwSpeed = Number(level && level.hookThrowSpeed) || (18 + 10 * p);
  out.impactDmg = Number(level && level.hookImpactDmg) || (30 + 80 * p);
  out.maxHits = Math.max(1, Math.min(MAX_THROW_HITS,
    Math.round(Number(level && level.hookMaxHits) || (4 + 4 * p))));
  return out;
}

function _makeFallbackHook() {
  // One draw call even when the authored GLB was not ready. The partial torus
  // reads as a compact metal hook rather than silently making the action invisible.
  const geo = new THREE.TorusGeometry(0.25, 0.065, 6, 18, Math.PI * 1.55);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd8ab58,
    emissive: 0x2c7d82,
    emissiveIntensity: 0.32,
    roughness: 0.32,
    metalness: 0.74,
    depthTest: true,
    depthWrite: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.z = -0.72;
  mesh.userData.fallbackAsset = true;
  return mesh;
}

function _fitHookModel(model) {
  model.updateWorldMatrix(true, true);
  _box.setFromObject(model);
  if (_box.isEmpty()) return;
  _box.getSize(_boxSize);
  _box.getCenter(_boxCenter);
  const maxDim = Math.max(_boxSize.x, _boxSize.y, _boxSize.z, 0.001);
  // A 0.62u hook was technically present but read as a cursor speck beside a
  // 3.6u hero. Keep the authored silhouette around paw-size so its three brass
  // claws remain legible from the normal orthographic camera.
  const s = 1.0 / maxDim;
  model.scale.setScalar(s);
  model.position.set(-_boxCenter.x * s, -_boxCenter.y * s, -_boxCenter.z * s);
}

function _ensureVisuals(scene) {
  if (!scene) return false;
  if (_visualRoot) {
    if (_visualRoot.parent !== scene) scene.add(_visualRoot);
    return true;
  }

  _visualRoot = new THREE.Group();
  _visualRoot.name = '__pipesGrapple';
  _visualRoot.visible = false;
  _visualRoot.userData.visualRole = 'pipes-grapple';
  _visualRoot.userData.gameplayPurpose = 'grab-orbit-launch-readability';
  scene.add(_visualRoot);
  _visualAllocations++;

  _chainMat = new THREE.MeshStandardMaterial({
    color: _chainIdle,
    emissive: 0x22545b,
    emissiveIntensity: 0.62,
    roughness: 0.38,
    metalness: 0.66,
    toneMapped: false,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  });
  // A continuous six-sided energy cable reads much more cleanly than the old
  // row of tiny torus rings, while remaining one fixed InstancedMesh draw.
  const chainGeo = new THREE.CylinderGeometry(0.055, 0.055, 1, 6, 1, false);
  _chain = new THREE.InstancedMesh(chainGeo, _chainMat, CHAIN_CAP);
  _chain.name = 'pipesGrappleChainLinks';
  _chain.count = 0;
  _chain.frustumCulled = false;
  _chain.castShadow = false;
  _chain.receiveShadow = false;
  _chain.renderOrder = 0;
  _chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _visualRoot.add(_chain);
  _visualAllocations++;

  _hookPivot = new THREE.Group();
  _hookPivot.name = 'pipesGrappleHook';
  _hookPivot.visible = false;
  _hookPivot.renderOrder = 0;
  let hookModel = null;
  try { hookModel = cloneCached('fx_pipes_grapple_hook'); } catch (_) { hookModel = null; }
  if (hookModel) {
    try { upgradeMaterials(hookModel, 0.7, 0.32); } catch (_) {}
    _fitHookModel(hookModel);
    hookModel.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      o.renderOrder = 0;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) {
        if (!mats[i]) continue;
        mats[i].depthTest = true;
        mats[i].depthWrite = true;
      }
    });
  } else {
    hookModel = _makeFallbackHook();
  }
  _hookPivot.add(hookModel);
  _visualRoot.add(_hookPivot);
  _visualAllocations++;

  // Black in the Grok render disappears under additive blending; depthTest
  // remains enabled so the emblem behaves like world VFX, never HUD paint.
  try {
    const loader = new THREE.TextureLoader();
    const url = new URL('../../../assets/fx/pipes-grapple-emblem-grok-v1.webp', import.meta.url).href;
    const tex = loader.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.68,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    _emblem = new THREE.Sprite(mat);
    _emblem.name = 'pipesGrappleChargedEmblem';
    _emblem.visible = false;
    _emblem.renderOrder = 0;
    _emblem.scale.set(1.45, 1.45, 1.45);
    _visualRoot.add(_emblem);
    _visualAllocations++;
  } catch (_) {
    _emblem = null;
  }

  _debug.allocationCount = _visualAllocations;
  return true;
}

function _hideVisuals() {
  if (_visualRoot) _visualRoot.visible = false;
  if (_hookPivot) _hookPivot.visible = false;
  if (_chain) {
    _chain.count = 0;
    _chain.instanceMatrix.needsUpdate = true;
  }
  if (_emblem) _emblem.visible = false;
  _debug.ropeLength = 0;
  _debug.chainCount = 0;
}

function _setChargeVisual(charge) {
  const q = _clamp01(charge);
  if (_lastVisualCharge >= 0 && Math.abs(q - _lastVisualCharge) < 0.015) return;
  _lastVisualCharge = q;
  if (_chainMat) {
    _chainColor.copy(_chainIdle).lerp(_chainHot, q);
    _chainMat.color.copy(_chainColor);
    _chainMat.emissive.setRGB(0.10 + q * 0.04, 0.25 + q * 0.55, 0.28 + q * 0.62);
    _chainMat.emissiveIntensity = 0.62 + q * 0.86;
  }
}

function _writeChain(hero, endX, endY, endZ, charge) {
  if (!_chain || !_visualRoot) return;
  const startX = hero.x;
  const startY = (hero.y || 0) + 1.18;
  const startZ = hero.z;
  const dx = endX - startX;
  const dy = endY - startY;
  const dz = endZ - startZ;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const count = Math.max(2, Math.min(CHAIN_CAP, Math.ceil(len / CHAIN_SPACING)));

  for (let i = 0; i < count; i++) {
    const t0 = i / count;
    const t1 = (i + 1) / count;
    const sag0 = -0.24 * 4 * t0 * (1 - t0);
    const sag1 = -0.24 * 4 * t1 * (1 - t1);
    _linkA.set(startX + dx * t0, startY + dy * t0 + sag0, startZ + dz * t0);
    _linkB.set(startX + dx * t1, startY + dy * t1 + sag1, startZ + dz * t1);
    _linkDelta.subVectors(_linkB, _linkA);
    const segmentLength = Math.max(0.001, _linkDelta.length());
    _linkDelta.multiplyScalar(1 / segmentLength);
    _linkPos.addVectors(_linkA, _linkB).multiplyScalar(0.5);
    _linkQuat.setFromUnitVectors(_linkUp, _linkDelta);
    _linkScale.set(1, segmentLength * 1.04, 1);
    _linkMatrix.compose(_linkPos, _linkQuat, _linkScale);
    _chain.setMatrixAt(i, _linkMatrix);
  }
  _chain.count = count;
  _chain.instanceMatrix.needsUpdate = true;
  _visualRoot.visible = true;
  _debug.ropeLength = len;
  _debug.chainCount = count;
  _setChargeVisual(charge);
}

function _setHook(x, y, z, dirX, dirZ, charge) {
  if (!_hookPivot || !_visualRoot) return;
  _hookPivot.visible = true;
  _hookPivot.position.set(x, y, z);
  _hookPivot.rotation.set(0, Math.atan2(dirX, dirZ) + Math.PI * 0.5, 0);
  const pulse = 1 + _clamp01(charge) * 0.16;
  _hookPivot.scale.setScalar(pulse);
  _visualRoot.visible = true;
}

function _updateEmblem(gameState, target, charge) {
  if (!_emblem) return;
  const p = _enemyPos(target);
  const show = !!(p && charge >= 0.55 && !(gameState.run && gameState.run.lowFx));
  _emblem.visible = show;
  if (!show) return;
  const pulse = 1.72 + 0.16 * Math.sin(((gameState.time && gameState.time.real) || 0) * 8);
  _emblem.position.set(p.x, (p.y || 0) + 1.85, p.z);
  _emblem.scale.set(pulse, pulse, pulse);
}

function _syncDebug(gameState, inst) {
  const target = inst && (inst.grappleTarget || inst.grappleThrownTarget);
  const ctrl = inst && inst.grappleControl;
  _debug.eligible = !!(gameState && gameState.run && gameState.run.avatar === 'pipes');
  _debug.phase = inst ? inst.grapplePhase : PHASE_IDLE;
  _debug.targetUuid = _enemyUuid(target);
  _debug.targetKind = target ? (target.glbKey || target.displayName || 'enemy') : null;
  _debug.orbitAngle = inst ? inst.grappleAngle : 0;
  _debug.orbitRadius = inst ? inst.grappleRadius : 0;
  _debug.charge = ctrl ? _clamp01(ctrl.charge || 0) : 0;
  _debug.cooldown = inst ? Math.max(0, inst.grappleCd || 0) : 0;
  _debug.hookVisible = !!(_hookPivot && _hookPivot.visible && _visualRoot && _visualRoot.visible);
  _debug.emblemVisible = !!(_emblem && _emblem.visible && _visualRoot && _visualRoot.visible);
  _debug.activeVisuals = (_debug.hookVisible ? 1 : 0)
    + (_debug.chainCount > 0 ? 1 : 0)
    + (_debug.emblemVisible ? 1 : 0);
  _debug.allocationCount = _visualAllocations;
  _debug.launchId = inst ? (inst.grappleLaunchId || 0) : 0;
  _debug.throwHits = inst ? (inst.grappleThrowHits || 0) : 0;
  if (gameState && gameState.run) {
    let status = gameState.run.pipesGrapple;
    if (!status || status.owner !== 'pipes') {
      status = gameState.run.pipesGrapple = {
        owner: 'pipes', phase: PHASE_IDLE, cooldown: 0, charge: 0,
        target: null, throwHits: 0,
      };
    }
    status.phase = _debug.phase;
    status.cooldown = _debug.cooldown;
    status.charge = _debug.charge;
    status.target = _debug.targetKind;
    status.throwHits = _debug.throwHits;
  }
}

function _releaseControl(inst) {
  const target = inst.grappleTarget;
  const ctrl = inst.grappleControl;
  if (target && target._combatControl === ctrl) target._combatControl = null;
  if (ctrl) {
    ctrl.target = null;
    ctrl.until = 0;
    ctrl.charge = 0;
    ctrl.primaryHits = 0;
  }
  inst.grappleTarget = null;
}

function _cancelInternal(inst, reason, cooldown) {
  if (!inst) return false;
  const wasActive = inst.grapplePhase !== PHASE_IDLE
    || !!inst.grappleTarget || !!inst.grappleThrownTarget;
  _releaseControl(inst);
  inst.grappleThrownTarget = null;
  inst.grapplePhase = PHASE_IDLE;
  inst.grappleFlightT = 0;
  inst.grappleFlightDur = 0;
  inst.grappleOrbitT = 0;
  inst.grappleThrowAge = 0;
  inst.grappleThrowHits = 0;
  if (cooldown > (inst.grappleCd || 0)) inst.grappleCd = cooldown;
  _hideVisuals();
  _debug.lastCancelReason = reason || 'cancelled';
  return wasActive;
}

function _chooseTarget(gameState, inst) {
  const hero = gameState.hero.pos;
  const tune = inst.grappleTune;
  const area = (gameState.hero.statMul && gameState.hero.statMul.area) || 1;
  const range = tune.range * Math.min(1.22, Math.sqrt(Math.max(0.25, area)));
  let aim = null;
  try { aim = getAimDirection(_aimDir); } catch (_) { aim = _aimDir; }
  let ax = Number(aim && aim.x) || 0;
  let az = Number(aim && aim.z) || 0;
  const am = Math.hypot(ax, az) || 1;
  ax /= am; az /= am;
  _aimDir.x = ax; _aimDir.z = az;

  let candidates = _targetBuf;
  try { candidates = queryRadiusInto(hero, range, _targetBuf); }
  catch (_) { _targetBuf.length = 0; }
  const manual = (() => { try { return isManualAiming(); } catch (_) { return false; } })();
  const minDot = manual ? TARGET_CONE_DOT : AUTO_CONE_DOT;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const enemy = candidates[i];
    if (!_canGrab(enemy)) continue;
    const ep = _enemyPos(enemy);
    if (!ep) continue;
    const dx = ep.x - hero.x;
    const dz = ep.z - hero.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001 || dist > range) continue;
    const dot = (dx * ax + dz * az) / dist;
    if (dot < minDot) continue;
    const score = dot * 3.2 - dist / range;
    if (score > bestScore) { bestScore = score; best = enemy; }
  }
  inst.grappleAimX = ax;
  inst.grappleAimZ = az;
  inst.grappleRange = range;
  return best;
}

function _beginFlight(gameState, inst) {
  const hero = gameState.hero.pos;
  const target = _chooseTarget(gameState, inst);
  inst.grappleTarget = target;
  inst.grapplePhase = PHASE_FLYING;
  inst.grappleFlightT = 0;
  inst.grappleFlightX = hero.x;
  inst.grappleFlightZ = hero.z;
  let endX = hero.x + inst.grappleAimX * inst.grappleRange;
  let endZ = hero.z + inst.grappleAimZ * inst.grappleRange;
  if (target) {
    const ep = _enemyPos(target);
    if (ep) { endX = ep.x; endZ = ep.z; }
  }
  const dist = Math.hypot(endX - hero.x, endZ - hero.z);
  inst.grappleFlightDur = Math.max(0.08, Math.min(0.28, dist / FLIGHT_SPEED));
  try { if (sfx && sfx.grappleFire) sfx.grappleFire(); } catch (_) {}
  _debug.lastCancelReason = null;
}

function _latch(gameState, inst) {
  const target = inst.grappleTarget;
  if (!_canGrab(target)) {
    _cancelInternal(inst, 'invalid-latch', MISS_COOLDOWN);
    return false;
  }
  const hero = gameState.hero.pos;
  const ep = _enemyPos(target);
  if (!ep) {
    _cancelInternal(inst, 'missing-target-position', MISS_COOLDOWN);
    return false;
  }
  const dx = ep.x - hero.x;
  const dz = ep.z - hero.z;
  const dist = Math.hypot(dx, dz);
  if (dist > inst.grappleRange * 1.3) {
    _cancelInternal(inst, 'target-escaped', MISS_COOLDOWN);
    return false;
  }

  const ctrl = inst.grappleControl;
  ctrl.target = target;
  ctrl.until = ((gameState.time && gameState.time.game) || 0) + CONTROL_GRACE;
  ctrl.charge = 0;
  ctrl.primaryHits = 0;
  target._combatControl = ctrl;
  target.knockVx = 0;
  target.knockVz = 0;
  target.contactCooldown = Math.max(target.contactCooldown || 0, 0.35);
  inst.grapplePhase = PHASE_ORBIT;
  inst.grappleAngle = Math.atan2(dz, dx);
  inst.grappleLatchRadius = Math.max(inst.grappleTune.orbitRadius, dist);
  inst.grappleRadius = dist;
  inst.grappleOrbitT = 0;
  const facing = gameState.hero.facing || _aimDir;
  const cross = (facing.x || 0) * dz - (facing.z || 1) * dx;
  inst.grappleOrbitDir = cross < 0 ? -1 : 1;
  try { applyVulnerability(target, 1.08, 0.55); } catch (_) {}
  try { if (sfx && sfx.grappleLatch) sfx.grappleLatch(); } catch (_) {}
  try { spawnImpactBurst(ep.x, (ep.y || 0) + 0.7, ep.z, 0x79f7ff, 0.38, 4); } catch (_) {}
  return true;
}

function _tickFlying(gameState, dt, inst, released) {
  if (released) {
    _cancelInternal(inst, 'released-before-latch', MISS_COOLDOWN * 0.65);
    return;
  }
  const target = inst.grappleTarget;
  if (target && !_canGrab(target)) {
    _cancelInternal(inst, 'target-lost-in-flight', MISS_COOLDOWN);
    return;
  }
  inst.grappleFlightT += Math.max(0, dt);
  const k = _smoothstep(inst.grappleFlightT / Math.max(0.001, inst.grappleFlightDur));
  const hero = gameState.hero.pos;
  let endX = hero.x + inst.grappleAimX * inst.grappleRange;
  let endY = 0.72;
  let endZ = hero.z + inst.grappleAimZ * inst.grappleRange;
  if (target) {
    const ep = _enemyPos(target);
    if (ep) { endX = ep.x; endY = (ep.y || 0) + 0.72; endZ = ep.z; }
  }
  const x = inst.grappleFlightX + (endX - inst.grappleFlightX) * k;
  const z = inst.grappleFlightZ + (endZ - inst.grappleFlightZ) * k;
  const y = 0.78 + (endY - 0.78) * k + Math.sin(k * Math.PI) * 0.28;
  _setHook(x, y, z, inst.grappleAimX, inst.grappleAimZ, 0);
  _writeChain(hero, x, y, z, 0);
  if (k < 1) return;
  if (target) _latch(gameState, inst);
  else _cancelInternal(inst, 'miss', MISS_COOLDOWN);
}

function _beginThrow(gameState, inst) {
  const target = inst.grappleTarget;
  const ctrl = inst.grappleControl;
  if (!target || !target.alive || target._combatControl !== ctrl) {
    _cancelInternal(inst, 'target-lost-before-throw', MISS_COOLDOWN);
    return false;
  }
  const ep = _enemyPos(target);
  if (!ep) {
    _cancelInternal(inst, 'missing-throw-position', MISS_COOLDOWN);
    return false;
  }

  let dx = 0, dz = 0;
  let manual = false;
  try { manual = isManualAiming(); } catch (_) {}
  if (manual) {
    try {
      const aim = getAimDirection(_aimDir);
      dx = Number(aim && aim.x) || 0;
      dz = Number(aim && aim.z) || 0;
    } catch (_) {}
  }
  if (Math.abs(dx) + Math.abs(dz) < 0.001) {
    // Tangent to the current orbit: a natural swing-release fallback.
    dx = -Math.sin(inst.grappleAngle) * inst.grappleOrbitDir;
    dz =  Math.cos(inst.grappleAngle) * inst.grappleOrbitDir;
  }
  const dm = Math.hypot(dx, dz) || 1;
  dx /= dm; dz /= dm;
  const charge = _clamp01(ctrl.charge || 0);
  const speed = inst.grappleTune.throwSpeed * (1 + charge * 0.35);

  _releaseControl(inst);
  target.knockVx = dx * speed;
  target.knockVz = dz * speed;
  target.contactCooldown = Math.max(target.contactCooldown || 0, THROW_LIFE);
  target._pipesHookThrownUntil = ((gameState.time && gameState.time.game) || 0) + THROW_LIFE;
  inst.grappleThrownTarget = target;
  inst.grapplePhase = PHASE_THROWN;
  inst.grappleThrowAge = 0;
  inst.grappleThrowHits = 0;
  inst.grappleThrowX = ep.x;
  inst.grappleThrowZ = ep.z;
  inst.grappleThrowDirX = dx;
  inst.grappleThrowDirZ = dz;
  inst.grappleThrowCharge = charge;
  inst.grappleThrowDmg = inst.grappleTune.impactDmg
    * ((gameState.hero.statMul && gameState.hero.statMul.dmg) || 1)
    * (1 + charge);
  inst.grappleLaunchId = _nextLaunchId++;
  if (_nextLaunchId > 0x3fffffff) _nextLaunchId = 1;
  const cdMul = (gameState.hero.statMul && gameState.hero.statMul.cooldown) || 1;
  const passiveCd = (gameState.run && gameState.run.passive_cooldown) || 1;
  inst.grappleCd = inst.grappleTune.cooldown * cdMul * passiveCd;
  _debug.lastReleaseSpeed = speed;
  _hideVisuals();
  try { if (sfx && sfx.grappleThrow) sfx.grappleThrow({ charge }); } catch (_) {}
  try { spawnImpactBurst(ep.x, (ep.y || 0) + 0.65, ep.z, charge > 0.7 ? 0x75f8ff : 0xe4b762, 0.5, 5); } catch (_) {}
  return true;
}

function _tickOrbitCollision(gameState, inst, target, charge) {
  const now = (gameState.time && gameState.time.game) || 0;
  if (now < (inst.grappleNextOrbitHitAt || 0)) return;
  inst.grappleNextOrbitHitAt = now + ORBIT_HIT_INTERVAL;
  const ep = _enemyPos(target);
  if (!ep) return;
  let candidates = _orbitBuf;
  try { candidates = queryRadiusInto(ep, ORBIT_HIT_RADIUS, _orbitBuf); }
  catch (_) { _orbitBuf.length = 0; }
  for (let i = 0; i < candidates.length; i++) {
    const victim = candidates[i];
    if (!_canTakeCollateral(victim, target)) continue;
    if (now - (victim._pipesHookOrbitHitAt || -99) < ORBIT_HIT_INTERVAL * 0.95) continue;
    victim._pipesHookOrbitHitAt = now;
    const dmg = inst.grappleTune.impactDmg * 0.18
      * ((gameState.hero.statMul && gameState.hero.statMul.dmg) || 1)
      * (1 + charge * 0.5);
    try { damageEnemy(victim, dmg, 'pipes_grapple_swing'); } catch (_) {}
    if (victim.alive && !victim._heavy && !victim._noKnockback) {
      const tangentX = -Math.sin(inst.grappleAngle) * inst.grappleOrbitDir;
      const tangentZ =  Math.cos(inst.grappleAngle) * inst.grappleOrbitDir;
      victim.knockVx = tangentX * (5 + charge * 4);
      victim.knockVz = tangentZ * (5 + charge * 4);
    }
    const vp = _enemyPos(victim) || ep;
    try { spawnImpactBurst(vp.x, (vp.y || 0) + 0.62, vp.z, charge > 0.7 ? 0x76f7ff : 0xe0ad58, 0.42, 3); } catch (_) {}
    _debug.lastHitTargetUuid = _enemyUuid(victim);
    _debug.lastHitDamage = dmg;
    break; // one readable impact per 160ms, even inside a dense horde
  }
}

function _tickOrbit(gameState, dt, inst, released) {
  const target = inst.grappleTarget;
  const ctrl = inst.grappleControl;
  if (!target || !target.alive || target._combatControl !== ctrl) {
    _cancelInternal(inst, 'target-lost', MISS_COOLDOWN);
    return;
  }
  if (!Number.isFinite(ctrl.charge)) ctrl.charge = 0;
  ctrl.charge = _clamp01(ctrl.charge);
  ctrl.until = ((gameState.time && gameState.time.game) || 0) + CONTROL_GRACE;
  inst.grappleOrbitT += Math.max(0, dt);

  const reel = _smoothstep(inst.grappleOrbitT / 0.30);
  inst.grappleRadius = inst.grappleLatchRadius
    + (inst.grappleTune.orbitRadius - inst.grappleLatchRadius) * reel;
  const speed = inst.grappleTune.orbitSpeed * (1 + ctrl.charge * 0.8);
  inst.grappleAngle = (inst.grappleAngle + speed * inst.grappleOrbitDir * dt) % TAU;
  const hero = gameState.hero.pos;
  const x = hero.x + Math.cos(inst.grappleAngle) * inst.grappleRadius;
  const z = hero.z + Math.sin(inst.grappleAngle) * inst.grappleRadius;
  // Treat only an explicit `false` as rejection. This keeps the helper
  // compatible with setter-style integrations that intentionally return void.
  if (setControlledEnemyXZ(target, x, z) === false) {
    _cancelInternal(inst, 'target-left-active-world', MISS_COOLDOWN);
    return;
  }
  const ep = _enemyPos(target);
  const y = ((ep && ep.y) || 0) + 0.76;
  const radialX = x - hero.x;
  const radialZ = z - hero.z;
  _setHook(x, y, z, radialX, radialZ, ctrl.charge);
  _writeChain(hero, x, y, z, ctrl.charge);
  _updateEmblem(gameState, target, ctrl.charge);
  _tickOrbitCollision(gameState, inst, target, ctrl.charge);

  if (released || inst.grappleOrbitT >= inst.grappleTune.maxHold) {
    _beginThrow(gameState, inst);
  }
}

function _finishThrow(inst, reason) {
  inst.grappleThrownTarget = null;
  inst.grapplePhase = PHASE_IDLE;
  inst.grappleThrowAge = 0;
  _hideVisuals();
  if (reason) _debug.lastCancelReason = reason;
}

function _tickThrown(gameState, dt, inst) {
  const target = inst.grappleThrownTarget;
  if (!target || !target.alive || !target.mesh || target._spatialKey == null) {
    _finishThrow(inst, 'thrown-target-lost');
    return;
  }
  const ep = _enemyPos(target);
  if (!ep) {
    _finishThrow(inst, 'thrown-target-position-lost');
    return;
  }
  inst.grappleThrowAge += Math.max(0, dt);
  const travel = Math.hypot(ep.x - inst.grappleThrowX, ep.z - inst.grappleThrowZ);
  _probePos.set(
    (ep.x + inst.grappleThrowX) * 0.5,
    ep.y || 0,
    (ep.z + inst.grappleThrowZ) * 0.5,
  );
  const probeRadius = THROW_HIT_RADIUS + travel * 0.5;
  let candidates = _throwBuf;
  try { candidates = queryRadiusInto(_probePos, probeRadius, _throwBuf); }
  catch (_) { _throwBuf.length = 0; }

  for (let i = 0; i < candidates.length && inst.grappleThrowHits < inst.grappleTune.maxHits; i++) {
    const victim = candidates[i];
    if (!_canTakeCollateral(victim, target)) continue;
    if (victim._pipesHookLaunchHitId === inst.grappleLaunchId) continue;
    victim._pipesHookLaunchHitId = inst.grappleLaunchId;
    const vp = _enemyPos(victim);
    const vx = vp ? vp.x : ep.x;
    const vy = vp ? (vp.y || 0) + 0.65 : 0.65;
    const vz = vp ? vp.z : ep.z;
    const dmg = inst.grappleThrowDmg;
    try { applyVulnerability(victim, 1.12, 0.8); } catch (_) {}
    try { damageEnemy(victim, dmg, 'pipes_grapple_throw'); } catch (_) {}
    if (victim.alive && !victim._heavy && !victim._noKnockback) {
      victim.knockVx = inst.grappleThrowDirX * (8 + inst.grappleThrowCharge * 5);
      victim.knockVz = inst.grappleThrowDirZ * (8 + inst.grappleThrowCharge * 5);
      victim.contactCooldown = Math.max(victim.contactCooldown || 0, 0.35);
    }
    inst.grappleThrowHits++;
    _debug.lastHitTargetUuid = _enemyUuid(victim);
    _debug.lastHitDamage = dmg;
    try { spawnImpactBurst(vx, vy, vz, inst.grappleThrowCharge > 0.7 ? 0x77f8ff : 0xf3b85c, 0.72, 7); } catch (_) {}
    try { if (sfx && sfx.grappleImpact) sfx.grappleImpact({ charge: inst.grappleThrowCharge }); } catch (_) {}

    // The improvised projectile shares a little of every collision's impact.
    // Check alive immediately: a killed target's pooled mesh may be reused.
    if (target.alive) {
      try { damageEnemy(target, dmg * 0.18, 'pipes_grapple_throw'); } catch (_) {}
    }
    if (!target.alive) break;
  }

  if (!target.alive) {
    _finishThrow(inst, 'thrown-target-broke');
    return;
  }
  inst.grappleThrowX = ep.x;
  inst.grappleThrowZ = ep.z;
  const moving = Math.hypot(target.knockVx || 0, target.knockVz || 0);
  if (inst.grappleThrowHits >= inst.grappleTune.maxHits
      || inst.grappleThrowAge >= THROW_LIFE
      || (inst.grappleThrowAge >= THROW_MIN_AGE && moving < 1.0)) {
    _finishThrow(inst, null);
  }
}

export function init(gameState, level, inst) {
  if (!inst) return;
  if (_activeInst && _activeInst !== inst) _cancelInternal(_activeInst, 'new-instance', 0);
  _activeInst = inst;
  _ensureVisuals(gameState && gameState.scene);
  inst.grappleTune = inst.grappleTune || {};
  _writeTune(level, inst.grappleTune);
  inst.grappleControl = inst.grappleControl || {
    kind: 'pipes-hook',
    ownerAvatar: 'pipes',
    target: null,
    until: 0,
    charge: 0,
    primaryHits: 0,
  };
  inst.grapplePhase = PHASE_IDLE;
  inst.grappleTarget = null;
  inst.grappleThrownTarget = null;
  inst.grappleCd = 0;
  inst.grappleAngle = 0;
  inst.grappleRadius = 0;
  inst.grappleOrbitT = 0;
  inst.grappleThrowHits = 0;
  inst.grappleNextOrbitHitAt = 0;
  inst.grappleLaunchId = 0;
  inst.grappleMode = gameState ? gameState.mode : null;
  try { inst.grappleWasHeld = !!isSecondaryActionHeld(); }
  catch (_) { inst.grappleWasHeld = false; }
  _hideVisuals();
  _syncDebug(gameState, inst);
}

export function tick(gameState, dt, level, inst) {
  if (!gameState || !inst) return;
  if (_activeInst !== inst) _activeInst = inst;
  if (!_visualRoot) _ensureVisuals(gameState.scene);
  if (!inst.grappleTune || !inst.grappleControl) init(gameState, level, inst);
  if (inst.grappleCd > 0) inst.grappleCd = Math.max(0, inst.grappleCd - Math.max(0, dt));

  let held = false;
  try { held = !!isSecondaryActionHeld(); } catch (_) {}
  const pressed = held && !inst.grappleWasHeld;
  const released = !held && !!inst.grappleWasHeld;
  inst.grappleWasHeld = held;

  const pipes = !!(gameState.run && gameState.run.avatar === 'pipes');
  const live = pipes && gameState.started && !gameState.gameOver && _combatMode(gameState.mode);
  if (!live) {
    if (inst.grapplePhase !== PHASE_IDLE || inst.grappleTarget || inst.grappleThrownTarget) {
      _cancelInternal(inst, pipes ? 'combat-inactive' : 'not-pipes', 0);
    }
    inst.grappleMode = gameState.mode;
    _syncDebug(gameState, inst);
    return;
  }

  // Catacomb/Bullet-Hell/world transitions can park a still-live enemy. Cancel
  // before any target position or spatial method is touched in the new mode.
  if (inst.grappleMode !== gameState.mode) {
    _cancelInternal(inst, 'mode-change', 0);
    inst.grappleMode = gameState.mode;
    inst.grappleWasHeld = held; // require a fresh release/press in the new world
    _syncDebug(gameState, inst);
    return;
  }

  if (inst.grapplePhase === PHASE_FLYING) {
    _tickFlying(gameState, dt, inst, released);
  } else if (inst.grapplePhase === PHASE_ORBIT) {
    _tickOrbit(gameState, dt, inst, released);
  } else if (inst.grapplePhase === PHASE_THROWN) {
    _tickThrown(gameState, dt, inst);
  } else if (pressed && inst.grappleCd <= 0) {
    _beginFlight(gameState, inst);
  }
  _syncDebug(gameState, inst);
}

export function refresh(gameState, level, inst) {
  if (!inst) return;
  inst.grappleTune = inst.grappleTune || {};
  _writeTune(level, inst.grappleTune);
  if (inst.grappleCd > inst.grappleTune.cooldown) {
    inst.grappleCd = inst.grappleTune.cooldown * 0.35;
  }
  _syncDebug(gameState, inst);
}

/**
 * Cancel the live hook without launching it. Public for confirmed death and
 * committed mode-transition callers. Uses the active Pipes instance by default.
 */
export function cancel(reason = 'cancelled', inst = _activeInst) {
  const changed = _cancelInternal(inst, reason, 0);
  if (_activeInst) _syncDebug(null, _activeInst);
  return changed;
}

export function dispose(gameState, inst) {
  const targetInst = inst || _activeInst;
  _cancelInternal(targetInst, 'dispose', 0);
  if (targetInst) {
    targetInst.grappleWasHeld = false;
    targetInst.grappleMode = null;
  }
  if (_activeInst === targetInst) _activeInst = null;
  _hideVisuals();
  _syncDebug(gameState, targetInst);
}

/** Reused, sealed object. Treat as read-only. */
export function debug() {
  return _debug;
}

// Descriptive aliases make the delegation call sites self-documenting while
// retaining the compact init/tick/refresh/dispose contract above.
export {
  init as initPipesGrapple,
  tick as tickPipesGrapple,
  refresh as refreshPipesGrapple,
  dispose as disposePipesGrapple,
  cancel as cancelPipesGrapple,
  debug as getPipesGrappleDebug,
};
