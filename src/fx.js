/**
 * Lightweight pooled feedback: cat-paw death poofs, magnet sparks, and the
 * tiny primary muzzle twinkle. Each family remains one InstancedMesh, so a
 * crowded wave never turns individual enemy deaths into individual draws.
 */
import * as THREE from 'three';
import { tex } from './particleTextures.js';
import { fxTex } from './fxTextures.js';
import { FLAT_X_QUAT, floorDecalMaterial, applyFloorTier } from './fxLayers.js';

const RING_CAP = 64;
const SPARK_CAP = 64;
// V2: kill-ring center twinkle pool — same cap as the rings, since each
// kill ring also spawns a center pop. Smaller scale, shorter life so it
// pops and vanishes while the ring is still expanding.
const TWINKLE_CAP = 64;

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _flatX = FLAT_X_QUAT;
const _zeroScale = new THREE.Vector3(0, 0, 0);
// Iter 33k — pool a uniform-scale temp for per-frame Matrix4.compose() calls.
// Previously each ring/spark/twinkle alloc'd `new THREE.Vector3(s,s,s)` per
// element per frame — ~300 GC objects/sec at heavy load.
const _tmpScale = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _yawQuat = new THREE.Quaternion();
const _poofQuat = new THREE.Quaternion();

let _ringInst = null;
let _sparkInst = null;
let _ringTwinkleInst = null;
const _sparkColor = new THREE.Color();
const _poofColor = new THREE.Color();
const _twinkleColor = new THREE.Color();

// Public callers still use spawnKillRing() for compatibility; the visual is
// now a compact paw-shaped dust poof instead of a persistent target-like ring.
const _rings = []; // {x,z,t,life,baseScale,rotation}
const _ringTwinkles = []; // {x,z,t,life, baseScale, color}
const _sparks = []; // {x,y,z,t,life}

let _ringDirty = false;
let _sparkDirty = false;
let _twinkleDirty = false;

export function initFX(scene) {
  // Enemy-death paw poof — authored on black for additive blending. The
  // deliberately broken silhouette cannot be mistaken for a portal, pickup,
  // AoE warning, or other interactive ground ring.
  const ringGeo = new THREE.PlaneGeometry(2.0, 2.0);
  const ringMat = floorDecalMaterial({ map: fxTex('kill_paw_poof') || tex('twinkleGold'), side: THREE.FrontSide });
  _ringInst = new THREE.InstancedMesh(ringGeo, ringMat, RING_CAP);
  _ringInst.count = 0;
  _ringInst.frustumCulled = false;
  _ringInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < RING_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _ringInst.setMatrixAt(i, _m4);
  }
  _ringInst.instanceMatrix.needsUpdate = true;
  _ringInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_CAP * 3), 3);
  _ringInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < RING_CAP; i++) _ringInst.setColorAt(i, _poofColor.setRGB(1, 1, 1));
  _ringInst.instanceColor.needsUpdate = true;
  _ringInst.userData.visualRole = 'death_feedback';
  _ringInst.userData.gameplayPurpose = 'enemy-death-poof';
  _ringInst.userData.assetPath = 'assets/fx/deaths/kill_paw_poof.webp';
  // Keep this out of selective bloom: it is already luminous artwork, and
  // bloom around many simultaneous deaths could wash over opaque actors.
  applyFloorTier(_ringInst, 'kill_pickup', { bloom: false });
  scene.add(_ringInst);

  // Magnet spark — textured billboard sparkle
  const sparkGeo = new THREE.PlaneGeometry(0.6, 0.6);
  const sparkMat = floorDecalMaterial({ map: tex('sparkCyan'), side: THREE.FrontSide });
  _sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, SPARK_CAP);
  _sparkInst.count = 0;
  _sparkInst.frustumCulled = false;
  _sparkInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Sparks face camera (we'll set rotation to face -Y axis from above)
  // For ortho iso, sprites laid flat read fine — orient like the ring (XZ plane)
  for (let i = 0; i < SPARK_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _sparkInst.setMatrixAt(i, _m4);
  }
  _sparkInst.instanceMatrix.needsUpdate = true;
  applyFloorTier(_sparkInst, 'kill_pickup');
  scene.add(_sparkInst);

  // Per-instance color attribute so spawnMagnetSpark can spawn gold variants too.
  _sparkInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SPARK_CAP * 3), 3);
  _sparkInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const defaultSparkColor = new THREE.Color(0x44ffcc);
  for (let i = 0; i < SPARK_CAP; i++) _sparkInst.setColorAt(i, defaultSparkColor);
  _sparkInst.instanceColor.needsUpdate = true;

  // V2 — kill-ring center twinkle layer. Painted with twinkleGold tex,
  // additive, per-instance color so elite kills get gold pop and trash
  // kills get warm-bone white pop. Single draw call shared across all
  // kill events. Sits at y just above the ring so the layered pop reads.
  const twinkleGeo = new THREE.PlaneGeometry(1.0, 1.0);
  const twinkleMat = floorDecalMaterial({ map: tex('twinkleGold'), side: THREE.FrontSide });
  _ringTwinkleInst = new THREE.InstancedMesh(twinkleGeo, twinkleMat, TWINKLE_CAP);
  _ringTwinkleInst.count = 0;
  _ringTwinkleInst.frustumCulled = false;
  _ringTwinkleInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < TWINKLE_CAP; i++) {
    _m4.compose(_v3.set(0, -1000, 0), _flatX, _zeroScale);
    _ringTwinkleInst.setMatrixAt(i, _m4);
  }
  _ringTwinkleInst.instanceMatrix.needsUpdate = true;
  applyFloorTier(_ringTwinkleInst, 'kill_pickup');
  _ringTwinkleInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TWINKLE_CAP * 3), 3);
  _ringTwinkleInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const defaultTwinkleColor = new THREE.Color(0xfff9e6);
  for (let i = 0; i < TWINKLE_CAP; i++) _ringTwinkleInst.setColorAt(i, defaultTwinkleColor);
  _ringTwinkleInst.instanceColor.needsUpdate = true;
  scene.add(_ringTwinkleInst);

}

/**
 * Pop the pooled paw-shaped death poof at world (x,z). The legacy function
 * name is retained because chests, destructibles, and weapons share this
 * feedback API. opts {life, scale} remain backward compatible.
 */
export function spawnDeathPoof(x, z, elite = false, opts = null) {
  if (_rings.length >= RING_CAP) _rings.shift();
  _rings.push({
    x, z, t: 0,
    life: (opts && opts.life) || (elite ? 0.34 : 0.22),
    baseScale: (opts && opts.scale) || (elite ? 1.15 : 0.72),
    rotation: Math.random() * Math.PI * 2,
  });
}

// Backward-compatible export for older gameplay modules. New code should use
// spawnDeathPoof so the function name describes the authored asset.
export const spawnKillRing = spawnDeathPoof;

/** Pop a magnet spark at world position. `color` is hex; default cyan. */
export function spawnMagnetSpark(x, y, z, color = 0x44ffcc) {
  if (_sparks.length >= SPARK_CAP) _sparks.shift();
  _sparks.push({ x, y, z, t: 0, life: 0.35, color });
}

/**
 * Tiny muzzle flash for the held-fire primary. Reuses the kill-ring twinkle
 * InstancedMesh pool (zero new draw calls; TWINKLE_CAP shift-on-add is the
 * budget cap — at ~3.3 fires/s the flash occupies a handful of the 64 slots).
 * Offset along the fire angle so it reads at the weapon mouth, not the feet.
 */
export function spawnPrimaryMuzzle(x, z, angle) {
  if (_ringTwinkles.length >= TWINKLE_CAP) _ringTwinkles.shift();
  _ringTwinkles.push({
    x: x + Math.cos(angle) * 0.55,
    z: z + Math.sin(angle) * 0.55,
    t: 0,
    life: 0.09,
    baseScale: 0.45,
    color: 0xffe9a8,
  });
}

export function updateFX(dt) {
  // Compact descriptors before writing matrices. A fixed-cap draw count plus
  // front-shifting descriptors left stale trailing slots visible; dense
  // swap-removal keeps logical and GPU indices aligned.
  for (let i = _rings.length - 1; i >= 0; i--) {
    const r = _rings[i];
    r.t += dt;
    if (r.t < r.life) continue;
    const last = _rings.length - 1;
    if (i !== last) _rings[i] = _rings[last];
    _rings.pop();
  }
  _ringInst.count = _rings.length;
  for (let i = 0; i < _rings.length; i++) {
    const r = _rings[i];
    const k = r.t / r.life;
    // Snap in, breathe once, and dissolve in place. Unlike the old 3.5x
    // expanding circle this never grows across the surrounding play space.
    const easeOut = 1 - (1 - k) * (1 - k);
    const s = r.baseScale * (0.76 + easeOut * 0.32 - k * 0.08);
    const fadeK = Math.max(0, Math.min(1, (k - 0.42) / 0.58));
    const brightness = 1 - fadeK * fadeK * (3 - 2 * fadeK);
    _v3.set(r.x, 0.08, r.z);
    _yawQuat.setFromAxisAngle(_upAxis, r.rotation);
    _poofQuat.multiplyQuaternions(_yawQuat, _flatX);
    _m4.compose(_v3, _poofQuat, _tmpScale.set(s, s, s));
    _ringInst.setMatrixAt(i, _m4);
    _ringInst.setColorAt(i, _poofColor.setRGB(brightness, brightness, brightness));
    _ringDirty = true;
  }

  // V2: kill-ring center twinkle pop — life 0.18/0.28s, ease-out scale,
  // additive fade. Paired 1:1 with kill rings (independent index — gallery
  // arrays may not stay aligned after drops).
  if (_ringTwinkleInst) {
    for (let i = _ringTwinkles.length - 1; i >= 0; i--) {
      const tw = _ringTwinkles[i];
      tw.t += dt;
      if (tw.t < tw.life) continue;
      const last = _ringTwinkles.length - 1;
      if (i !== last) _ringTwinkles[i] = _ringTwinkles[last];
      _ringTwinkles.pop();
    }
    _ringTwinkleInst.count = _ringTwinkles.length;
    for (let i = 0; i < _ringTwinkles.length; i++) {
      const tw = _ringTwinkles[i];
      const k = tw.t / tw.life;
      // Ease-out scale: snap in fast, then slight grow as it fades.
      const easeIn = Math.min(1, k * 4);             // 0 → 1 in first 25%
      const s = tw.baseScale * (0.35 + 0.85 * easeIn) * (1 - 0.2 * k);
      _v3.set(tw.x, 0.10, tw.z);
      _m4.compose(_v3, _flatX, _tmpScale.set(s, s, s));
      _ringTwinkleInst.setMatrixAt(i, _m4);
      // Color fade: hold full bright for first 40%, then linear fade.
      const a = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      _twinkleColor.setHex(tw.color).multiplyScalar(a);
      _ringTwinkleInst.setColorAt(i, _twinkleColor);
      _twinkleDirty = true;
    }
  }

  // Sparks
  for (let i = _sparks.length - 1; i >= 0; i--) {
    const sp = _sparks[i];
    sp.t += dt;
    if (sp.t < sp.life) continue;
    const last = _sparks.length - 1;
    if (i !== last) _sparks[i] = _sparks[last];
    _sparks.pop();
  }
  _sparkInst.count = _sparks.length;
  for (let i = 0; i < _sparks.length; i++) {
    const sp = _sparks[i];
    const k = sp.t / sp.life;
    const rise = k * 1.2;
    const s = (1 - k) * 1.5; // sprite scale multiplier — start bigger than 1 unit
    _v3.set(sp.x, sp.y + rise, sp.z);
    _m4.compose(_v3, _flatX, _tmpScale.set(s, s, s));
    _sparkInst.setMatrixAt(i, _m4);
    _sparkInst.setColorAt(i, _sparkColor.setHex(sp.color || 0x44ffcc));
    _sparkDirty = true;
  }

  if (_ringDirty)  {
    _ringInst.instanceMatrix.needsUpdate = true;
    if (_ringInst.instanceColor) _ringInst.instanceColor.needsUpdate = true;
    _ringDirty = false;
  }
  if (_sparkDirty) {
    _sparkInst.instanceMatrix.needsUpdate = true;
    if (_sparkInst.instanceColor) _sparkInst.instanceColor.needsUpdate = true;
    _sparkDirty = false;
  }
  if (_twinkleDirty && _ringTwinkleInst) {
    _ringTwinkleInst.instanceMatrix.needsUpdate = true;
    if (_ringTwinkleInst.instanceColor) _ringTwinkleInst.instanceColor.needsUpdate = true;
    _twinkleDirty = false;
  }
}

export function resetFX() {
  _rings.length = 0;
  _ringTwinkles.length = 0;
  _sparks.length = 0;
  if (_ringInst) _ringInst.count = 0;
  if (_ringTwinkleInst) _ringTwinkleInst.count = 0;
  if (_sparkInst) _sparkInst.count = 0;
}
