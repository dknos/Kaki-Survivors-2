/**
 * Sticky Web — drops a slow patch at hero position on cooldown.
 * Each web lasts ~5s and reduces enemy speed inside its radius.
 * Webs live in state.webs.list; enemies.js applies slow per-frame.
 * Visual: a single InstancedMesh of flat translucent discs (one draw call total).
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { tex } from '../particleTextures.js';
import { sfx } from '../audio.js';
import { queryRadiusInto } from '../enemies.js';

const WEB_CAP = 24;
const WEB_Y = 0.05;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _flatX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _zeroScale = new THREE.Vector3(0, 0, 0);
const _queryPos = { x: 0, z: 0 };
const _queryBuf = [];

let _inst = null;
let _baseMaterial = null;
let _dirty = false;

function _ensureMesh() {
  if (_inst) return;
  // Textured square plane → woven web sprite (radial spokes + concentric strands)
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex('webBraid'),
    color: 0xddffff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  _baseMaterial = mat;
  _inst = new THREE.InstancedMesh(geo, mat, WEB_CAP);
  _inst.count = 0;
  _inst.frustumCulled = false;
  _inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < WEB_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _inst.setMatrixAt(i, _m4);
  }
  _inst.instanceMatrix.needsUpdate = true;
  state.scene.add(_inst);
}

function _writeWebMatrix(i, web) {
  const k = web.ttl / web.life; // 1..0 over lifetime
  const r = web.radius * (0.6 + 0.4 * k);
  _v3.set(web.x, WEB_Y, web.z);
  _scale.set(r, r, r);
  _m4.compose(_v3, _flatX, _scale);
  _inst.setMatrixAt(i, _m4);
}

// Sanctum (web evolution): cumulative time since last burn-tick. Webs deal
// 1 dmg per 0.4s to enemies standing inside any *burning* web.
let _sanctumBurnAcc = 0;
const SANCTUM_BURN_INTERVAL = 0.4;
const SANCTUM_BURN_DMG = 1;
let _sanctumGoldApplied = false;

function _applySanctumGoldTint() {
  if (_sanctumGoldApplied || !_inst) return;
  // Clone the shared material so we don't recolor non-evolved webs across runs.
  _inst.material = _inst.material.clone();
  _inst.material.color.set(0xffd24a);
  _sanctumGoldApplied = true;
}

export function tickWebs(dt) {
  _ensureMesh();
  const list = state.webs.list;
  let anyBurning = false;
  // Stable in-place compaction preserves oldest-first cap semantics while
  // keeping logical indices dense for InstancedMesh.count.
  let liveCount = 0;
  let visualCount = 0;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    w.ttl -= dt;
    if (w.ttl <= 0) continue;
    if (w.burn) anyBurning = true;
    if (liveCount !== i) list[liveCount] = w;
    // Mothman's passive heal markers share this logical list but explicitly
    // have no web visual. Keep logical and visual indices independent and
    // never write beyond the InstancedMesh allocation.
    if (!w._passive && visualCount < WEB_CAP) {
      _writeWebMatrix(visualCount, w);
      _dirty = true;
      visualCount++;
    }
    liveCount++;
  }
  list.length = liveCount;
  _inst.count = visualCount;
  if (anyBurning) _applySanctumGoldTint();
  if (_dirty) { _inst.instanceMatrix.needsUpdate = true; _dirty = false; }

  // ── Sanctum: burn enemies inside burning webs + flag hero defense ──
  _sanctumBurnAcc += dt;
  const doBurnTick = _sanctumBurnAcc >= SANCTUM_BURN_INTERVAL;
  if (doBurnTick) _sanctumBurnAcc -= SANCTUM_BURN_INTERVAL;

  let heroInsideBurn = false;
  const heroPos = state.hero.pos;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (w.ttl <= 0 || !w.burn) continue;
    // Hero defense check
    if (!heroInsideBurn) {
      const hdx = heroPos.x - w.x, hdz = heroPos.z - w.z;
      if (hdx * hdx + hdz * hdz <= w.radius * w.radius) heroInsideBurn = true;
    }
    if (!doBurnTick) continue;
    // Stamp a short DoT on enemies inside this web — re-uses the existing
    // _dotDps/_dotUntil channel handled by enemies.js.
    let cands = null;
    _queryPos.x = w.x; _queryPos.z = w.z;
    try { cands = queryRadiusInto(_queryPos, w.radius, _queryBuf); } catch (_) { cands = null; }
    if (!cands) continue;
    const r2 = w.radius * w.radius;
    for (const e of cands) {
      if (!e || !e.alive || !e.mesh) continue;
      const dx = e.mesh.position.x - w.x;
      const dz = e.mesh.position.z - w.z;
      if (dx * dx + dz * dz > r2) continue;
      // Refresh a short DoT (slightly longer than the tick so it stays active
      // while inside). dps tuned so ~1 dmg lands every 0.4s = 2.5 dps.
      const dps = SANCTUM_BURN_DMG / SANCTUM_BURN_INTERVAL;
      e._dotDps = Math.max(e._dotDps || 0, dps);
      e._dotUntil = Math.max(e._dotUntil || 0, state.time.game + SANCTUM_BURN_INTERVAL * 1.25);
      e._dotSource = 'sanctum';
    }
  }
  // Hero defense flag: read by enemies.js / hero damage path. Idempotent —
  // we reset each frame so the bonus disappears the moment hero exits.
  state.hero.inSanctum = heroInsideBurn;

  // ── Webspinner "Lingering Silk" signature: standing in ANY active web
  // heals 0.5 HP/s (signature_webHeal). One heal tick per frame even if
  // multiple webs overlap; never overheal past hpMax.
  if (state.run.signature_webHeal > 0) {
    let inAnyWeb = false;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.ttl <= 0) continue;
      const hdx = heroPos.x - w.x, hdz = heroPos.z - w.z;
      if (hdx * hdx + hdz * hdz <= w.radius * w.radius) { inAnyWeb = true; break; }
    }
    if (inAnyWeb) {
      state.hero.hp = Math.min(
        state.hero.hpMax,
        state.hero.hp + state.run.signature_webHeal * dt,
      );
    }
  }
}

export function resetWebs() {
  state.webs.list.length = 0;
  state.hero.inSanctum = false;
  _sanctumBurnAcc = 0;
  if (_inst) {
    _inst.count = 0;
    if (_sanctumGoldApplied && _inst.material !== _baseMaterial) {
      _inst.material.dispose();
      _inst.material = _baseMaterial;
    }
  }
  _sanctumGoldApplied = false;
}

function _spawnWeb(x, z, level, evolved) {
  _ensureMesh();
  const list = state.webs.list;
  // Cap only actual rendered webs. Passive Mothman heal markers share this
  // list and must neither consume visual capacity nor be evicted as a web.
  let webCount = 0;
  let oldestWebIndex = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && !list[i]._passive) {
      if (oldestWebIndex < 0) oldestWebIndex = i;
      webCount++;
    }
  }
  if (webCount >= WEB_CAP && oldestWebIndex >= 0) list.splice(oldestWebIndex, 1);
  // Sanctum evolution: keep the base radius/slow/duration profile; the upgrade
  // is the burn DoT + hero defense + gold-thread visual (handled in tickWebs).
  list.push({
    x, z,
    radius: level.radius * (state.hero.statMul.area || 1),
    ttl: level.duration * (state.hero.statMul.duration || 1),
    life: level.duration * (state.hero.statMul.duration || 1),
    slowMul: level.slowMul,
    burn: !!evolved,
  });
}

export default {
  id: 'web',
  name: 'Sticky Web',
  desc: 'Drops slowing webs at your feet',
  icon: '🕸',
  maxLevel: 8,
  levels: [
    { cooldown: 3.5, duration: 5.0, radius: 3.5, slowMul: 0.50 },
    { cooldown: 3.2, duration: 5.0, radius: 3.8, slowMul: 0.45 },
    { cooldown: 3.0, duration: 5.5, radius: 4.0, slowMul: 0.42 },
    { cooldown: 2.7, duration: 5.5, radius: 4.3, slowMul: 0.38 },
    { cooldown: 2.5, duration: 6.0, radius: 4.6, slowMul: 0.35 },
    { cooldown: 2.2, duration: 6.0, radius: 4.9, slowMul: 0.32 },
    { cooldown: 2.0, duration: 6.5, radius: 5.2, slowMul: 0.28 },
    { cooldown: 1.7, duration: 7.0, radius: 5.6, slowMul: 0.25 },
  ],

  init(state, level, inst) { inst.cd = 0.4; },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;
    const h = state.hero.pos;
    _spawnWeb(h.x, h.z, level, !!inst.evolved);
    try { sfx.weaponWeb(); } catch (_) {}
    // Iter 11a SHOP_TREE Power tier 2 "Quick Hands" composes with statMul.cooldown.
    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },
};
