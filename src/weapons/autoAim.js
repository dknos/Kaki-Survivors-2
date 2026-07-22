/**
 * Magic Missile — auto-aim projectile weapon.
 * Fires at the nearest enemy on cooldown. Projectile updates live in weapons/index.js.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { queryRadiusInto } from '../enemies.js';
import { sfx } from '../audio.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { getAimWorldPos } from '../input.js';
import { getMeta } from '../meta.js';
import { fxTex } from '../fxTextures.js';

// Grok/SuperHeavy paw-and-yarn comet: a concrete cat-themed projectile with a
// directional silhouette. Two pooled layers (painted core + restrained glow)
// replace the old six-draw stack of circular iceBolt/flashStar/mote planes.
const PROJ_HALO_GEO  = new THREE.PlaneGeometry(1.34, 1.34);
const PROJ_CORE_GEO  = new THREE.PlaneGeometry(1.18, 1.18);
// Materials are lazy so the manifest has time to prime before projectile-pool
// construction. A direct URL fallback still guarantees the authored sprite if
// the first shot races the manifest fetch.
let _haloMat = null, _coreMat = null;
let _haloMatIce = null, _coreMatIce = null;
let _pawTexDirect = null;
const _pawLoader = new THREE.TextureLoader();
function _getPawCometTex() {
  const authored = fxTex('weapon_paw_comet');
  if (authored) return authored;
  if (!_pawTexDirect) {
    _pawTexDirect = _pawLoader.load(new URL('../../assets/fx/weapons/paw_comet.webp', import.meta.url).href);
    _pawTexDirect.colorSpace = THREE.SRGBColorSpace;
    _pawTexDirect.minFilter = THREE.LinearMipmapLinearFilter;
    _pawTexDirect.magFilter = THREE.LinearFilter;
  }
  return _pawTexDirect;
}
function _mkHaloMat() {
  return new THREE.MeshBasicMaterial({
    map: _getPawCometTex(), color: 0x79d9d5,
    transparent: true, opacity: 0.28, alphaTest: 0.025,
    depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkCoreMat() {
  return new THREE.MeshBasicMaterial({
    map: _getPawCometTex(), color: 0xffffff,
    transparent: true, opacity: 0.96, alphaTest: 0.06,
    depthTest: true, depthWrite: false, blending: THREE.NormalBlending,
  });
}
function _mkHaloMatIce() {
  return new THREE.MeshBasicMaterial({
    map: _getPawCometTex(), color: 0xa6d8ff,
    transparent: true, opacity: 0.30, alphaTest: 0.025,
    depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function _mkCoreMatIce() {
  return new THREE.MeshBasicMaterial({
    map: _getPawCometTex(), color: 0xe5f4ff,
    transparent: true, opacity: 0.98, alphaTest: 0.06,
    depthTest: true, depthWrite: false, blending: THREE.NormalBlending,
  });
}
function _getHaloMat()      { return _haloMat      || (_haloMat      = _mkHaloMat()); }
function _getCoreMat()      { return _coreMat      || (_coreMat      = _mkCoreMat()); }
function _getHaloMatIce()   { return _haloMatIce   || (_haloMatIce   = _mkHaloMatIce()); }
function _getCoreMatIce()   { return _coreMatIce   || (_coreMatIce   = _mkCoreMatIce()); }
const _flatQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _yawQuat = new THREE.Quaternion();

// ─────────────────────────────────────────────────────────────────────────────
// iter 33u — InstancedMesh visual pool for projectiles.
// Each projectile gets a slot in 2 capacity-256 InstancedMesh banks (normal +
// ice variant), 2 parts each (painted core + restrained silhouette glow) → 4
// draws total regardless of projectile count.
// Per-slot rotation+scale matrix is baked at attach time; per-frame sync just
// rewrites the translation portion via Matrix4.setPosition().
// ─────────────────────────────────────────────────────────────────────────────
const CAP_PROJ = 256;
let _projInst = null;          // { haloN, coreN, haloI, coreI }
const _freeN = [];
const _freeI = [];
const _haloMatsN = [], _coreMatsN = [];
const _haloMatsI = [], _coreMatsI = [];
const _hideMat = new THREE.Matrix4();
_hideMat.compose(new THREE.Vector3(0, -1000, 0), new THREE.Quaternion(), new THREE.Vector3(0, 0, 0));
const _scratchPos = new THREE.Vector3();
const _scratchScale = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);
let _projDirtyN = false;
let _projDirtyI = false;
let _projLiveN = 0;
let _projLiveI = 0;

export function initProjectileVisuals(scene) {
  if (_projInst) return;
  const mkInst = (geo, mat, variant, part) => {
    const im = new THREE.InstancedMesh(geo, mat, CAP_PROJ);
    im.count = CAP_PROJ;
    // A fixed-count InstancedMesh still submits a draw when every matrix is
    // collapsed/offscreen. Keep empty banks out of both beauty and bloom
    // passes; the first leased slot makes its two meshes visible again.
    im.visible = false;
    im.frustumCulled = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Only the restrained halo participates in selective bloom. The painted
    // core stays on the normal depth-tested layer so it cannot wash over the
    // hero like the old additive circles did.
    if (part === 'halo') im.layers.enable(BLOOM_LAYER);
    im.userData.visualRole = 'player_projectile';
    im.userData.weaponId = 'autoaim';
    im.userData.variant = variant;
    im.userData.part = part;
    for (let i = 0; i < CAP_PROJ; i++) im.setMatrixAt(i, _hideMat);
    im.instanceMatrix.needsUpdate = true;
    return im;
  };
  _projInst = {
    haloN:  mkInst(PROJ_HALO_GEO,  _getHaloMat(),    'normal', 'halo'),
    coreN:  mkInst(PROJ_CORE_GEO,  _getCoreMat(),    'normal', 'core'),
    haloI:  mkInst(PROJ_HALO_GEO,  _getHaloMatIce(), 'ice',    'halo'),
    coreI:  mkInst(PROJ_CORE_GEO,  _getCoreMatIce(), 'ice',    'core'),
  };
  scene.add(_projInst.haloN, _projInst.coreN);
  scene.add(_projInst.haloI, _projInst.coreI);
  for (let i = CAP_PROJ - 1; i >= 0; i--) {
    _haloMatsN[i] = new THREE.Matrix4();
    _coreMatsN[i] = new THREE.Matrix4();
    _haloMatsI[i] = new THREE.Matrix4();
    _coreMatsI[i] = new THREE.Matrix4();
    _freeN.push(i);
    _freeI.push(i);
  }
}

function _attachProjectileVisuals(proj, origin, dir, ice, scaleMul) {
  if (!_projInst) { proj._slot = -1; return false; }
  const free = ice ? _freeI : _freeN;
  if (free.length === 0) { proj._slot = -1; return false; }
  const slot = free.pop();
  proj._slot = slot;
  proj._ice = ice;
  // The source art points along local +X. Flatten it to XZ, then yaw +X onto
  // the projectile velocity so the paw and yarn tail always fly nose-first.
  _yawQuat.setFromAxisAngle(_upAxis, -Math.atan2(dir.z, dir.x));
  _scratchQuat.copy(_yawQuat).multiply(_flatQuat);
  const haloMat = (ice ? _haloMatsI : _haloMatsN)[slot];
  _scratchScale.set(1.08 * scaleMul, 1.08 * scaleMul, 1.08 * scaleMul);
  _scratchPos.set(origin.x, 0.5 - 0.02, origin.z);
  haloMat.compose(_scratchPos, _scratchQuat, _scratchScale);
  const coreMat = (ice ? _coreMatsI : _coreMatsN)[slot];
  _scratchScale.set(scaleMul, scaleMul, scaleMul);
  _scratchPos.set(origin.x, 0.5 + 0.01, origin.z);
  coreMat.compose(_scratchPos, _scratchQuat, _scratchScale);
  proj._haloMat = haloMat;
  proj._coreMat = coreMat;
  const halo  = ice ? _projInst.haloI  : _projInst.haloN;
  const core  = ice ? _projInst.coreI  : _projInst.coreN;
  if (ice) {
    _projLiveI += 1;
    _projDirtyI = true;
  } else {
    _projLiveN += 1;
    _projDirtyN = true;
  }
  halo.visible = true;
  core.visible = true;
  halo.setMatrixAt(slot, haloMat);
  core.setMatrixAt(slot, coreMat);
  return true;
}

export function syncProjectileVisuals(proj) {
  if (!_projInst || proj._slot == null || proj._slot < 0) return;
  const ice = proj._ice;
  const halo  = ice ? _projInst.haloI  : _projInst.haloN;
  const core  = ice ? _projInst.coreI  : _projInst.coreN;
  const px = proj.mesh.position.x;
  const pz = proj.mesh.position.z;
  proj._haloMat.setPosition(px, 0.5 - 0.02, pz);
  proj._coreMat.setPosition(px, 0.5 + 0.01, pz);
  halo.setMatrixAt(proj._slot, proj._haloMat);
  core.setMatrixAt(proj._slot, proj._coreMat);
  if (ice) _projDirtyI = true;
  else _projDirtyN = true;
}

export function flushProjectileVisuals() {
  if (!_projInst) return;
  if (_projDirtyN) {
    _projInst.haloN.instanceMatrix.needsUpdate = true;
    _projInst.coreN.instanceMatrix.needsUpdate = true;
    _projDirtyN = false;
  }
  if (_projDirtyI) {
    _projInst.haloI.instanceMatrix.needsUpdate = true;
    _projInst.coreI.instanceMatrix.needsUpdate = true;
    _projDirtyI = false;
  }
}

export function releaseProjectileVisuals(proj) {
  if (!_projInst || proj._slot == null || proj._slot < 0) return;
  const ice = proj._ice;
  const slot = proj._slot;
  const halo  = ice ? _projInst.haloI  : _projInst.haloN;
  const core  = ice ? _projInst.coreI  : _projInst.coreN;
  halo.setMatrixAt(slot, _hideMat);
  core.setMatrixAt(slot, _hideMat);
  if (ice) {
    _projLiveI = Math.max(0, _projLiveI - 1);
    _projDirtyI = true;
    if (_projLiveI === 0) {
      halo.visible = false;
      core.visible = false;
    }
  } else {
    _projLiveN = Math.max(0, _projLiveN - 1);
    _projDirtyN = true;
    if (_projLiveN === 0) {
      halo.visible = false;
      core.visible = false;
    }
  }
  (ice ? _freeI : _freeN).push(slot);
  proj._slot = -1;
}

// Hero-relative search radius for the auto-aim weapon (iter 33x). Camera is
// ortho half-height 28u, so anything beyond ~24u from the hero is on the edge
// of the screen or off-screen entirely. We cap the search at 18u so the
// weapon only ever locks onto enemies that read on-screen — no "auto-killing
// targets I can't see".
const SEARCH_RADIUS = 18;
const FAN_SPREAD = 0.18; // radians between fanned projectiles
const _targetQueryBuf = [];
const _shotDir = { x: 0, z: 0 };
const GLASSWIND_OPTS = Object.freeze({ ice: true, splitOnHit: true });

function findNearestEnemy(pos) {
  // Try queryRadius first (uses spatial hash if available)
  let candidates = null;
  try { candidates = queryRadiusInto(pos, SEARCH_RADIUS, _targetQueryBuf); } catch (_) { candidates = null; }
  if (!candidates || candidates.length === 0) candidates = state.enemies.active;
  if (!candidates || candidates.length === 0) return null;

  let best = null;
  let bestD2 = Infinity;
  for (const e of candidates) {
    if (!e || !e.alive) continue;
    const ep = e.mesh ? e.mesh.position : e.pos;
    if (!ep) continue;
    const dx = ep.x - pos.x;
    const dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}


// Exported for sig kits (Phase D) so cowboy_sixshooter etc. can drop bullets
// through the same InstancedMesh pool instead of allocating their own draws.
// Same signature as the historic local function — kept stable for callers.
export function spawnAutoAimProjectile(origin, dir, level, dmg, speedMul = 1, pierceBonus = 0, owner = 'autoaim', opts = null) {
  return spawnProjectile(origin, dir, level, dmg, speedMul, pierceBonus, owner, opts);
}

function spawnProjectile(origin, dir, level, dmg, speedMul = 1, pierceBonus = 0, owner = 'autoaim', opts = null) {
  const ice = !!(opts && opts.ice);
  const scaleMul = (opts && opts.scale) || 1;
  // Attack-recoil signal: stamp hero with fire timestamp + normalized direction
  // so the animation layer can play a recoil without touching weapon logic.
  const _alen = Math.hypot(dir.x, dir.z) || 1;
  state.hero._attackAt  = state.time.real;
  const attackDir = state.hero._attackDir || (state.hero._attackDir = { x: 0, z: 0 });
  attackDir.x = dir.x / _alen;
  attackDir.z = dir.z / _alen;
  // iter 33u — group is a position-only handle; visuals come from the
  // InstancedMesh pool. Group itself is NOT added to scene.
  const group = new THREE.Group();
  group.position.set(origin.x, 0.5, origin.z);
  const vel = new THREE.Vector3(dir.x, 0, dir.z).multiplyScalar(level.speed * (state.hero.statMul.projSpeed || 1) * speedMul);
  const proj = {
    mesh: group,
    vel,
    dmg,
    ttl: level.ttl * (state.hero.statMul.duration || 1),
    pierce: level.pierce + pierceBonus,
    hit: new Set(),
    ownerWeapon: owner,
  };
  if (opts) {
    if (opts.splitOnHit) proj.splitOnHit = true;
    if (opts.ttlOverride != null) proj.ttl = opts.ttlOverride;
    if (opts.pierceOverride != null) proj.pierce = opts.pierceOverride;
    if (opts.noSplit) proj.noSplit = true;
  }
  // Collision and visuals share one lease. If the bounded visual pool is
  // exhausted, reject this shot instead of creating an invisible projectile
  // that can still damage enemies.
  if (!_attachProjectileVisuals(proj, origin, dir, ice, scaleMul)) return null;
  state.projectiles.active.push(proj);
  return proj;
}

// Exported so the central projectile tick can spawn Glasswind shards on hit
// without re-importing autoAim internals. Spawns 2 perpendicular half-dmg shards.
export function spawnGlasswindShards(origin, parentVel, parentDmg) {
  // Perpendicular split: ±35° off the original heading. Shards inherit the
  // parent's actual world-velocity (already statMul-scaled) so they don't
  // double-multiply via spawnProjectile's level.speed path.
  const baseAngle = Math.atan2(parentVel.z, parentVel.x);
  const speed = Math.hypot(parentVel.x, parentVel.z) || 1;
  for (let side = -1; side <= 1; side += 2) {
    const a = baseAngle + side * 0.6;
    _shotDir.x = Math.cos(a);
    _shotDir.z = Math.sin(a);
    const group = new THREE.Group();
    group.position.set(origin.x, 0.5, origin.z);
    const vel = new THREE.Vector3(_shotDir.x, 0, _shotDir.z).multiplyScalar(speed * 0.9);
    const proj = {
      mesh: group, vel,
      dmg: parentDmg * 0.5, ttl: 0.8, pierce: 1,
      hit: new Set(), ownerWeapon: 'glasswind', noSplit: true,
    };
    if (_attachProjectileVisuals(proj, origin, _shotDir, true, 0.6)) {
      state.projectiles.active.push(proj);
    }
  }
}

export default {
  id: 'autoaim',
  name: 'Magic Missile',
  desc: 'Auto-fires at the nearest enemy',
  icon: '✨',
  maxLevel: 8,
  levels: [
    // iter 33x — range is speed × ttl. Camera ortho half-height = 28u, so we
    // cap each level's max travel under 22u to keep projectiles within the
    // visible play area. Damage trimmed ~30% so the auto-aim doesn't trivialize
    // mid-tier mobs while the player is still levelling other weapons.
    { cooldown: 1.00, speed: 16, dmg:  8, ttl: 1.10, pierce: 1, count: 1 },
    { cooldown: 0.85, speed: 17, dmg: 11, ttl: 1.15, pierce: 1, count: 1 },
    { cooldown: 0.75, speed: 18, dmg: 15, ttl: 1.20, pierce: 2, count: 1 },
    { cooldown: 0.65, speed: 19, dmg: 21, ttl: 1.20, pierce: 2, count: 2 },
    { cooldown: 0.55, speed: 20, dmg: 28, ttl: 1.20, pierce: 3, count: 2 },
    { cooldown: 0.50, speed: 21, dmg: 38, ttl: 1.20, pierce: 3, count: 3 },
    { cooldown: 0.45, speed: 22, dmg: 50, ttl: 1.20, pierce: 4, count: 3 },
    { cooldown: 0.40, speed: 22, dmg: 63, ttl: 1.20, pierce: 4, count: 4 },
  ],

  init(state, level, inst) {
    inst.cd = 0; // fire immediately on first tick when an enemy is present
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;

    const hero = state.hero.pos;
    // Manual aim: fire toward the projected cursor world position instead of
    // the nearest enemy. Honored when meta.optManualAim is on.
    const meta = getMeta();
    let tp;
    if (meta && meta.optManualAim) {
      const aim = getAimWorldPos();
      tp = aim;
    } else {
      const target = findNearestEnemy(hero);
      if (!target) {
        inst.cd = 0.15;
        return;
      }
      tp = target.mesh ? target.mesh.position : target.pos;
    }
    const dx = tp.x - hero.x;
    const dz = tp.z - hero.z;
    const baseAngle = Math.atan2(dz, dx);

    const dmgMul = state.hero.statMul.dmg || 1;
    const evo = !!inst.evolved;
    // Glasswind: +50% projectiles per volley (rounded up, min +1), pale-blue
    // visual, and each bullet carries `splitOnHit` so the central projectile
    // tick spawns 2 half-damage ice shards on first hit.
    const dmg = level.dmg * dmgMul;
    const baseCount = level.count;
    const n = evo ? Math.max(baseCount + 1, Math.ceil(baseCount * 1.5)) : baseCount;
    const projSpeedMul = 1;
    const pierceBonus = 0;
    const spawnOpts = evo ? GLASSWIND_OPTS : null;
    const ownerTag = evo ? 'glasswind' : 'autoaim';

    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * FAN_SPREAD;
      const a = baseAngle + offset;
      _shotDir.x = Math.cos(a);
      _shotDir.z = Math.sin(a);
      spawnProjectile(hero, _shotDir, level, dmg, projSpeedMul, pierceBonus, ownerTag, spawnOpts);
    }

    try { sfx.weaponAutoaim(); } catch (_) {}

    // Iter 11a SHOP_TREE Power tier 2 "Quick Hands" multiplies on top of the
    // existing statMul.cooldown chain (passives/signature_tempo/Overdrive).
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    // Snap cooldown so the new level can fire promptly.
    if (inst.cd === undefined || inst.cd > level.cooldown) {
      inst.cd = Math.min(inst.cd ?? 0, level.cooldown * 0.25);
    }
  },
};
