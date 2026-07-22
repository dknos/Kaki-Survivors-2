/**
 * Bullet-hell enemy bullet field. Unlike enemyProjectiles.js (3 meshes per
 * bolt, cap 48), this is a single InstancedMesh pool sized for danmaku
 * density — one draw call for the whole field. Bullets are flat additive
 * discs on the ground plane; collision is a small circle against the hero's
 * *bullet-hell hitbox* (bh.stats.hitR), not the survivors-mode HIT_R.
 *
 * Slots carry optional motion fields (accel, angular curve, spawn delay) so
 * patterns can charge-and-release, arc, and ramp — not just fly straight.
 * A second ring (bh.stats.grazeR) scores GRAZE on each bullet's first pass:
 * spark + tick + meter; a full meter converts to a bomb charge.
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { takeDamage as heroTakeDamage } from '../hero.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { sfx } from '../audio.js';
import { spawnImpactBurst, burstExplosion } from '../vfxBurst.js';
import { spawnAoeNova } from '../fx/aoeNova.js';
import { bh, ARENA_CX, ARENA_CZ, ARENA_R } from './bhState.js';
import { notifyBh } from './announcer.js';

const MAX_BULLETS = 1024;
// Despawn is measured from the ARENA CENTER (not the hero — rim patterns like
// edge rain / walls spawn far from the hero and must not despawn prematurely).
const DESPAWN_R = ARENA_R + 8;
const BULLET_Y = 1.0;
const GRAZE_FILL = 1 / 24;    // 24 grazes = one bomb charge

// Palette per pattern family — readable color language: what a bullet does
// is telegraphed by its color, same rule the enemy tells system uses.
export const BULLET_KINDS = {
  ring:   { color: new THREE.Color(0xff5e8a), scale: 1.0 },  // pink — radial
  spiral: { color: new THREE.Color(0xb98aff), scale: 0.9 },  // violet — spiral arms
  aimed:  { color: new THREE.Color(0xffc24a), scale: 1.1 },  // amber — aimed at you
  rain:   { color: new THREE.Color(0x7fd8ff), scale: 0.85 }, // cyan — ambient rain
  snipe:  { color: new THREE.Color(0xff4a4a), scale: 1.15 }, // red — telegraphed fast shot
};

let _mesh = null;
let _bulletTex = null;
// {x,z,vx,vz,ttl,scale,ax,az,curve,delay,grazed,fade,color} — null = free
const _slots = [];
const _free = [];
const _m4 = new THREE.Matrix4();
const _quatFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _sc = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _dimColor = new THREE.Color();

export function initBullets(scene) {
  if (!_bulletTex) {
    _bulletTex = new THREE.TextureLoader().load('assets/fx/bullethell/paw_bullet.webp');
    _bulletTex.colorSpace = THREE.SRGBColorSpace;
  }
  const geo = new THREE.PlaneGeometry(0.9, 0.9);
  const mat = new THREE.MeshBasicMaterial({
    map: _bulletTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  _mesh = new THREE.InstancedMesh(geo, mat, MAX_BULLETS);
  _mesh.userData.kkBulletHell = true;
  _mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BULLETS * 3), 3);
  _mesh.count = 0;
  _mesh.visible = false;
  _mesh.frustumCulled = false;
  _mesh.layers.enable(BLOOM_LAYER);
  _slots.length = 0;
  _free.length = 0;
  for (let i = 0; i < MAX_BULLETS; i++) { _slots.push(null); _free.push(i); _hideSlot(i); }
  _mesh.instanceMatrix.needsUpdate = true;
  scene.add(_mesh);
  return _mesh;
}

function _hideSlot(i) {
  _m4.compose(_pos.set(0, -100, 0), _quatFlat, _sc.set(0.001, 0.001, 0.001));
  _mesh.setMatrixAt(i, _m4);
}

function _releaseSlot(i) {
  if (!_slots[i]) return false;
  _slots[i] = null;
  _free.push(i);
  _hideSlot(i);
  if (_free.length === MAX_BULLETS) {
    _mesh.count = 0;
    _mesh.visible = false;
  }
  return true;
}

/**
 * Spawn one bullet. opts (all optional):
 *   ax/az   — acceleration (u/s²)
 *   curve   — angular velocity rotation (rad/s) applied to the velocity vector
 *   delay   — seconds frozen-dim before launch (charge-and-release read)
 *   ttl     — lifetime override (default 9)
 * The per-wave danger multiplier (bh.mods.bulletSpeedMul) applies here so
 * every pattern scales with the wave automatically.
 */
export function spawnBullet(x, z, vx, vz, kind = 'ring', opts = null) {
  if (!_mesh || _free.length === 0) return;   // field saturated — oldest bullets carry the pressure
  if (_free.length === MAX_BULLETS) {
    _mesh.count = MAX_BULLETS;
    _mesh.visible = true;
  }
  const i = _free.pop();
  const k = BULLET_KINDS[kind] || BULLET_KINDS.ring;
  const mul = (bh.mods && bh.mods.bulletSpeedMul) || 1;
  _slots[i] = {
    x, z,
    vx: vx * mul, vz: vz * mul,
    ttl: (opts && opts.ttl) || 9,
    scale: k.scale,
    ax: (opts && opts.ax) || 0,
    az: (opts && opts.az) || 0,
    curve: (opts && opts.curve) || 0,
    delay: (opts && opts.delay) || 0,
    grazed: false,
    fade: 0,
    color: k.color,
  };
  // Delayed bullets spawn dim — they brighten to full on launch.
  if (_slots[i].delay > 0) _mesh.setColorAt(i, _dimColor.copy(k.color).multiplyScalar(0.35));
  else _mesh.setColorAt(i, k.color);
  if (_mesh.instanceColor) _mesh.instanceColor.needsUpdate = true;
}

/** Ring of n bullets from (x,z). phase rotates the whole ring. */
export function patternRing(x, z, n, speed, phase = 0, kind = 'ring', opts = null) {
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    spawnBullet(x, z, Math.cos(a) * speed, Math.sin(a) * speed, kind, opts);
  }
}

/** Ring with a SAFE LANE: skip bullets within gapWidth radians of gapAngle. */
export function patternRingWithGap(x, z, n, speed, gapAngle, gapWidth = 0.8, phase = 0, kind = 'ring', opts = null) {
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    // Signed angular distance to the gap center.
    let d = a - gapAngle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < gapWidth * 0.5) continue;
    spawnBullet(x, z, Math.cos(a) * speed, Math.sin(a) * speed, kind, opts);
  }
}

/** Two rings, half-step offset phases and staggered speeds — weave to dodge. */
export function patternDoubleRing(x, z, n, speed, phase = 0, kind = 'ring') {
  patternRing(x, z, n, speed, phase, kind);
  patternRing(x, z, n, speed * 0.72, phase + Math.PI / n, kind, { delay: 0.18 });
}

/** Fan of n bullets aimed at the hero, spread radians wide. */
export function patternAimedFan(x, z, n, speed, spread = 0.5, kind = 'aimed', opts = null) {
  const h = state.hero.pos;
  const base = Math.atan2(h.z - z, h.x - x);
  for (let i = 0; i < n; i++) {
    const a = base + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
    spawnBullet(x, z, Math.cos(a) * speed, Math.sin(a) * speed, kind, opts);
  }
}

/** One spiral arm step — call every emitter tick with an advancing angle. */
export function patternSpiralStep(x, z, angle, arms, speed, kind = 'spiral', opts = null) {
  for (let i = 0; i < arms; i++) {
    const a = angle + (i / arms) * Math.PI * 2;
    spawnBullet(x, z, Math.cos(a) * speed, Math.sin(a) * speed, kind, opts);
  }
}

/**
 * Sweeping line of bullets crossing the whole arena with a MOVING GAP.
 * angle = travel direction; gapT (0..1) = gap position along the line;
 * bullets enter from the rim opposite the travel direction.
 */
export function patternBulletWall(angle, speed, gapT = 0.5, gapWidth = 4.5, spacing = 1.7, kind = 'rain') {
  const dx = Math.cos(angle), dz = Math.sin(angle);
  const lx = -dz, lz = dx;   // lateral axis of the line
  const sx = ARENA_CX - dx * (ARENA_R + 2);
  const sz = ARENA_CZ - dz * (ARENA_R + 2);
  const half = ARENA_R;
  const gapLat = -half + gapT * half * 2;
  for (let lat = -half; lat <= half; lat += spacing) {
    if (Math.abs(lat - gapLat) < gapWidth * 0.5) continue;
    spawnBullet(sx + lx * lat, sz + lz * lat, dx * speed, dz * speed, kind, { ttl: 14 });
  }
}

/** n bullets from random rim points aimed at random interior points, with a
 *  staggered charge delay so the rain reads as a rhythm, not a curtain. */
export function patternEdgeRain(n, speed, kind = 'rain') {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sx = ARENA_CX + Math.cos(a) * (ARENA_R + 1);
    const sz = ARENA_CZ + Math.sin(a) * (ARENA_R + 1);
    const ta = Math.random() * Math.PI * 2;
    const tr = Math.random() * (ARENA_R * 0.7);
    const tx = ARENA_CX + Math.cos(ta) * tr;
    const tz = ARENA_CZ + Math.sin(ta) * tr;
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    spawnBullet(sx, sz, ((tx - sx) / d) * speed, ((tz - sz) / d) * speed, kind,
      { delay: i * 0.06, ttl: 14 });
  }
}

/** Paired emitters on opposite rim points, both firing aimed fans — the hero
 *  has to break line-of-sight with one to dodge the other. */
export function patternCrossfire(n, speed, spread = 0.5, kind = 'aimed') {
  const a = Math.random() * Math.PI * 2;
  for (const side of [0, Math.PI]) {
    const sx = ARENA_CX + Math.cos(a + side) * (ARENA_R - 2);
    const sz = ARENA_CZ + Math.sin(a + side) * (ARENA_R - 2);
    patternAimedFan(sx, sz, n, speed, spread, kind);
  }
}

/** Clear the whole field instantly (mode exit / restart only — gameplay paths
 *  should prefer fadeAllBullets so flow isn't chopped). Returns cleared count. */
export function clearAllBullets() {
  let n = 0;
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (_releaseSlot(i)) n++;
  }
  if (_mesh) _mesh.instanceMatrix.needsUpdate = true;
  return n;
}

/** Convert every live bullet to a harmless fading spark over `dur` seconds.
 *  Used on wave clear + bombs — the field dissolves instead of blinking out. */
export function fadeAllBullets(dur = 0.8) {
  if (!_mesh || _free.length === MAX_BULLETS) return;
  for (let i = 0; i < MAX_BULLETS; i++) {
    const b = _slots[i];
    if (b && b.fade <= 0) b.fade = dur * (0.55 + Math.random() * 0.45);
  }
}

/** Cancel enemy bullets within r of (x,z) — the on-kill crowd-pleaser. The
 *  cancelled bullets convert to short sparks. Returns cancelled count. */
export function cancelBulletsNear(x, z, r) {
  if (!_mesh || _free.length === MAX_BULLETS) return 0;
  const r2 = r * r;
  let n = 0;
  for (let i = 0; i < MAX_BULLETS; i++) {
    const b = _slots[i];
    if (!b || b.fade > 0) continue;
    const dx = b.x - x, dz = b.z - z;
    if (dx * dx + dz * dz <= r2) {
      b.fade = 0.3;
      // A couple of embers per cancel wave, not per bullet — pool is finite.
      if (n < 4) spawnImpactBurst(b.x, BULLET_Y, b.z, 0xfff3a0, 0.2);
      n++;
    }
  }
  return n;
}

/** Detonate a bomb: consume a charge, dissolve the field, white-out + boom.
 *  Shared by the passive Thunder Purr intercept and the manual Space/B input.
 *  Returns true if a charge was spent. */
export function triggerBomb() {
  if (!bh.active || bh.stats.bombCharges <= 0) return false;
  bh.stats.bombCharges--;
  bh.bombFlash = 0.4;
  fadeAllBullets(0.45);
  const h = state.hero.pos;
  burstExplosion(h.x, h.z, 9, 0xaef7ff);
  // Arena-sweeping shockwave nova — reads as the blast clearing the field.
  spawnAoeNova(h.x, h.z, ARENA_R + 2, 'aoe_shockwave', 0xaef7ff, 0.7);
  state.fx.shake = Math.min(1, state.fx.shake + 0.5);
  if (sfx && sfx.weaponBomb) sfx.weaponBomb();
  return true;
}

/** GRAZE: first pass of a bullet through the graze ring. Spark + tick + meter;
 *  a full meter converts to a bomb charge. Also fed by perfect dodges (see
 *  index.js — hero.js's dash-through-projectile path is listened to, not edited). */
export function awardGraze(n = 1, x = null, z = null) {
  bh.grazeCount += n;
  bh.grazeMeter += GRAZE_FILL * n;
  if (x !== null) spawnImpactBurst(x, BULLET_Y, z, 0xaef7ff, 0.2);
  if (sfx && sfx.coinPickup) sfx.coinPickup();
  if (bh.grazeMeter >= 1) {
    bh.grazeMeter -= 1;
    bh.stats.bombCharges++;
    notifyBh('Paw bomb charged', '#9adcff', { priority: 1, duration: 1.15 });
    if (sfx && sfx.starPickup) sfx.starPickup();
  }
}

export function liveBulletCount() {
  return _mesh ? MAX_BULLETS - _free.length : 0;
}

function _segmentPointDist2(ax, az, bx, bz, px, pz) {
  const abx = bx - ax, abz = bz - az;
  const den = abx * abx + abz * abz;
  if (den <= 1e-9) {
    const dx = px - ax, dz = pz - az;
    return dx * dx + dz * dz;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / den));
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return dx * dx + dz * dz;
}

export function updateBullets(dt) {
  if (!_mesh || _free.length === MAX_BULLETS) return;
  const h = state.hero.pos;
  const hitR = bh.stats.hitR;
  const hitR2 = hitR * hitR;
  const grazeR2 = bh.stats.grazeR * bh.stats.grazeR;
  const t = state.time.game;
  for (let i = 0; i < MAX_BULLETS; i++) {
    const b = _slots[i];
    if (!b) continue;

    // Fading sparks: harmless, shrink + dim out, then free the slot. Still
    // graze-able — walking through the dissolving field earns meter, which
    // is why wave clears fade instead of deleting.
    if (b.fade > 0) {
      b.fade -= dt;
      if (b.fade <= 0) {
        _releaseSlot(i);
        continue;
      }
      if (!b.grazed) {
        const gdx = b.x - h.x, gdz = b.z - h.z;
        if (gdx * gdx + gdz * gdz <= grazeR2) { b.grazed = true; awardGraze(1, b.x, b.z); }
      }
      const fk = Math.min(1, b.fade / 0.3);
      const fs = b.scale * fk * 0.9;
      _mesh.setColorAt(i, _dimColor.copy(b.color).multiplyScalar(fk));
      _m4.compose(_pos.set(b.x, BULLET_Y, b.z), _quatFlat, _sc.set(fs, fs, fs));
      _mesh.setMatrixAt(i, _m4);
      if (_mesh.instanceColor) _mesh.instanceColor.needsUpdate = true;
      continue;
    }

    // Charge delay: frozen dim, pulsing slightly, then launch at full color.
    if (b.delay > 0) {
      b.delay -= dt;
      if (b.delay <= 0) {
        _mesh.setColorAt(i, b.color);
        if (_mesh.instanceColor) _mesh.instanceColor.needsUpdate = true;
      } else {
        const ds = b.scale * (0.45 + Math.sin(t * 14 + i) * 0.08);
        _m4.compose(_pos.set(b.x, BULLET_Y, b.z), _quatFlat, _sc.set(ds, ds, ds));
        _mesh.setMatrixAt(i, _m4);
        continue;
      }
    }

    // Motion: optional angular curve rotates the velocity, then accel adds.
    if (b.curve !== 0) {
      const ca = Math.cos(b.curve * dt), sa = Math.sin(b.curve * dt);
      const nvx = b.vx * ca - b.vz * sa;
      b.vz = b.vx * sa + b.vz * ca;
      b.vx = nvx;
    }
    const prevX = b.x, prevZ = b.z;
    b.vx += b.ax * dt;
    b.vz += b.az * dt;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.ttl -= dt;

    // Despawn from the ARENA CENTER — rim patterns live far from the hero.
    const cx = b.x - ARENA_CX, cz = b.z - ARENA_CZ;
    if (b.ttl <= 0 || cx * cx + cz * cz > DESPAWN_R * DESPAWN_R) {
      _releaseSlot(i);
      continue;
    }

    const d2 = _segmentPointDist2(prevX, prevZ, b.x, b.z, h.x, h.z);

    if (d2 <= hitR2) {
      if (bh.stats.bombCharges > 0 && bh.bombReady) {
        // Thunder Purr: consume a charge, wipe the field instead of taking the
        // hit. triggerBomb FADES bullets (no instant clear), so we keep looping
        // — the remaining slots become sparks and still get matrix updates this
        // frame. No early return: a mid-frame return used to skip matrix
        // updates, which corrupts the instance buffer now that bombs no longer
        // empty the field synchronously.
        bh.bombReady = false;
        triggerBomb();
        continue;
      }
      heroTakeDamage(bh.stats.bulletDmg, 'projectile');
      _releaseSlot(i);
      continue;
    }

    // Graze: first pass through the outer ring only (per-bullet flag).
    if (!b.grazed && d2 <= grazeR2) {
      b.grazed = true;
      awardGraze(1, b.x, b.z);
    }

    // Pulse scale so the field reads alive, not confetti.
    const s = b.scale * (1 + Math.sin(t * 10 + i * 0.7) * 0.12);
    _m4.compose(_pos.set(b.x, BULLET_Y, b.z), _quatFlat, _sc.set(s, s, s));
    _mesh.setMatrixAt(i, _m4);
  }
  _mesh.instanceMatrix.needsUpdate = true;
}

export function disposeBullets(scene) {
  if (!_mesh) return;
  scene.remove(_mesh);
  _mesh.geometry.dispose();
  _mesh.material.dispose();
  _mesh = null;
  _slots.length = 0;
  _free.length = 0;
}
