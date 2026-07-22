/**
 * Pooled ground-flat AoE nova sprites — big additive bursts for area effects
 * (element novas, shockwaves, bombs, boss tells). Backed by the generated
 * fx/aoe textures (fxTex). Driven by vfxBurst's existing init/update/reset
 * lifecycle so every mode gets it for free with no main.js wiring.
 *
 * spawnAoeNova(x, z, radius, texName, color, life) — one call, fire and forget.
 * Textures are cached by fxTex; a spawn with an unloaded manifest is skipped
 * (no solid-square fallback). Each nova grows radius*0.4 → radius with an
 * ease-out and fades in fast / out slow. Flat on the ground plane, additive,
 * on the bloom layer.
 */
import * as THREE from 'three';
import { fxTex } from '../fxTextures.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';

const CAP = 24;
let _pool = null;

export function initAoeNova(scene) {
  if (_pool) return;
  _pool = [];
  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < CAP; i++) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, -1000, 0);
    mesh.visible = false;
    // Floor-decal tier: negative so the nova sorts UNDER the opaque hero and
    // enemy sprites instead of over them (was renderOrder 3, which read as the
    // AoE layering above the player). depthTest still clips it to the ground.
    mesh.renderOrder = -1;
    mesh.layers.enable(BLOOM_LAYER);
    scene.add(mesh);
    _pool.push({ mesh, active: false, t: 0, life: 0, r0: 1, r1: 2, x: 0, z: 0, y: 0.08 });
  }
}

/**
 * Spawn a flat AoE nova. radius = final world radius; texName = an fx/aoe
 * manifest key (aoe_fire / aoe_frost / aoe_shock / aoe_holy / aoe_void /
 * aoe_poison / aoe_shockwave / aoe_beam / aoe_roots / aoe_slash); color tints
 * the additive sprite; life = seconds.
 */
export function spawnAoeNova(x, z, radius = 4, texName = 'aoe_shockwave', color = 0xffffff, life = 0.55, y = 0.08) {
  if (!_pool) return;
  const tex = fxTex(texName);
  if (!tex) return;                       // manifest not ready — skip, no square
  // Grab a free slot, else recycle the oldest.
  let slot = null;
  for (const s of _pool) { if (!s.active) { slot = s; break; } }
  if (!slot) {
    slot = _pool[0];
    for (const s of _pool) if (s.t / s.life > slot.t / slot.life) slot = s;
  }
  slot.mesh.material.map = tex;
  slot.mesh.material.needsUpdate = true;
  slot.mesh.material.color.setHex(color);
  slot.active = true; slot.t = 0; slot.life = life;
  slot.r0 = radius * 0.4; slot.r1 = radius; slot.x = x; slot.z = z; slot.y = y;
  slot.mesh.visible = true;
}

export function updateAoeNova(dt) {
  if (!_pool) return;
  for (const s of _pool) {
    if (!s.active) continue;
    s.t += dt;
    const k = s.t / s.life;
    if (k >= 1) {
      s.active = false; s.mesh.visible = false; s.mesh.position.y = -1000;
      s.mesh.material.opacity = 0;
      continue;
    }
    const grow = 1 - (1 - k) * (1 - k);            // ease-out
    const r = s.r0 + (s.r1 - s.r0) * grow;
    s.mesh.position.set(s.x, s.y, s.z);
    s.mesh.scale.set(r * 2, r * 2, 1);
    s.mesh.material.opacity = k < 0.2 ? (k / 0.2) : Math.max(0, 1 - (k - 0.2) / 0.8);
  }
}

export function resetAoeNova() {
  if (!_pool) return;
  for (const s of _pool) {
    s.active = false;
    s.mesh.visible = false;
    s.mesh.position.y = -1000;
    s.mesh.material.opacity = 0;
  }
}
