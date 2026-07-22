/**
 * Treasure chests spawn periodically near the hero and on elite kills.
 * On pickup, opens a slot-machine modal that rolls 3 reels for a powerup.
 *
 * Chest visual: asset-backed chest + compact paw-and-whisker reward marker.
 * Will be swapped for a GLB later when one is downloaded.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { showSlotMachine } from './ui.js';
import { spawnKillRing, spawnMagnetSpark } from './fx.js';
import { cloneCached, configureSharedEnvironmentMaterial } from './assets.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { tex } from './particleTextures.js';
import { constrainForestX, constrainForestZ } from './forestRooms.js';
import { createPickupMarker } from './fx/pickupMarker.js';

const PICKUP_RADIUS_SQ = 4.0;   // 2 units
const CHEST_Y = 0.5;

// Module-local: scene + chest list. We keep meshes pooled per-chest (each chest
// has its own group; small count so no need to over-engineer).
const _chests = [];     // {group, x, z, alive, t}
let _scene = null;

function _makeChestMesh(assetKey = 'chest') {
  const g = new THREE.Group();
  g.name = `chest:${assetKey}`;
  g.userData.assetKey = assetKey;

  // Try to use the GLB; auto-fit so it's player-readable
  const glb = cloneCached(assetKey) || cloneCached('chest');
  if (glb) {
    const box = new THREE.Box3().setFromObject(glb);
    const sz = box.getSize(new THREE.Vector3());
    const target = 1.8;
    const fit = sz.y > 1e-6 ? target / sz.y : 1;
    glb.scale.setScalar(fit);
    glb.position.y = -box.min.y * fit; // rest on ground
    glb.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
        // Make the chest glow gently
        if (o.material && 'emissive' in o.material) {
          o.material.emissive = new THREE.Color(0xffaa22);
          o.material.emissiveIntensity = 0.35;
        }
      }
    });
    g.add(glb);
  } else {
    // Fallback box if GLB missing
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.0, 1.0),
      configureSharedEnvironmentMaterial(
        new THREE.MeshLambertMaterial({ color: 0xb8860b, emissive: 0x442200, emissiveIntensity: 0.6 }),
        0,
      ),
    );
    body.position.y = CHEST_Y;
    g.add(body);
  }

  // High-quality paw marker above the chest. It keeps the reward readable
  // through a crowd without creating another unexplained gold O on the map.
  const marker = createPickupMarker({
    size: 1.45,
    opacity: 0.84,
    gameplayPurpose: 'walk-over treasure chest',
    userData: { chestPart: 'rewardMarker' },
  }).mesh;
  marker.position.y = 2.2;
  marker.userData.spinPhase = Math.random() * Math.PI * 2;
  g.add(marker);
  // A small twinkle gives a subtle long-range catchlight without a halo.
  const twinkle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.9),
    new THREE.MeshBasicMaterial({
      map: tex('twinkleGold'),
      transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  twinkle.position.y = 2.55;
  twinkle.rotation.x = -Math.PI / 2;
  twinkle.layers.enable(BLOOM_LAYER);
  g.add(twinkle);

  // Tag for the idle animation loop.
  g.userData.marker = marker;
  g.userData.twinkle = twinkle;
  return g;
}

export function initChests(scene) {
  _scene = scene;
}

// Ephemeral "open chest" visual — spawns the chest_open GLB at world (x,z) and
// despawns it after 1.4s. Lives outside the chest list (no pickup logic).
const _openFlashes = []; // { group, t, life }
function _spawnOpenChestFlash(x, z) {
  if (!_scene) return;
  const glb = cloneCached('chest_open');
  if (!glb) return;
  const box = new THREE.Box3().setFromObject(glb);
  const sz = box.getSize(new THREE.Vector3());
  const target = 2.0;
  const fit = sz.y > 1e-6 ? target / sz.y : 1;
  glb.scale.setScalar(fit);
  glb.position.set(x, -box.min.y * fit, z);
  glb.traverse(o => {
    if (o.isMesh && o.material && 'emissive' in o.material) {
      o.material.emissive = new THREE.Color(0xffd24a);
      o.material.emissiveIntensity = 0.6;
    }
  });
  _scene.add(glb);
  _openFlashes.push({ group: glb, t: 0, life: 1.4 });
}

export function spawnChest(x, z) {
  // Forest stage-gate at the single choke point: every legacy chest opens the
  // slot-machine modal on pickup, which can soft-lock against forest-v2 room
  // modals. On forest, ALL spawners (director periodic, mini-events, helltide,
  // totems/pylons/bells/destructibles, elite drops) delegate to the forest
  // chest picker instead. Callers that must bypass (final-boss / endless
  // reward) use spawnChestRaw below.
  if (state.mode === 'run' && state.run && state.run.stage && state.run.stage.id === 'forest') {
    const safeX = constrainForestX(x, 2);
    const safeZ = constrainForestZ(z, 2);
    import('./forestChests.js')
      .then(({ dropForestChest }) => dropForestChest({ x: safeX, z: safeZ }))
      .catch(() => {});
    return;
  }
  spawnChestRaw(x, z);
}

// Raw legacy chest — no forest delegation. For the final-boss/endless reward
// path only: dropForestChest silently no-ops at its 8-chest pool cap, which
// must never eat the victory reward.
export function spawnChestRaw(x, z, opts = null) {
  if (!_scene) return null;
  if (state.run && state.run.stage && state.run.stage.id === 'forest') {
    x = constrainForestX(x, 2);
    z = constrainForestZ(z, 2);
  }
  const mesh = _makeChestMesh(opts && opts.assetKey ? opts.assetKey : 'chest');
  mesh.position.set(x, 0, z);
  _scene.add(mesh);
  const handle = { group: mesh, x, z, alive: true, t: 0 };
  _chests.push(handle);
  return handle;
}

/** Remove one raw chest by handle; safe after pickup or repeated teardown. */
export function despawnChest(handle) {
  if (!handle) return false;
  const i = _chests.indexOf(handle);
  if (i >= 0) _chests.splice(i, 1);
  handle.alive = false;
  if (handle.group && handle.group.parent) handle.group.parent.remove(handle.group);
  return i >= 0;
}

// Iter 10b — canonical chest-spawn helper for callers that don't want the
// near-hero randomized placement. Thin wrapper so the Treasure Map capstone in
// _primeRunStart can drop a chest at a stable offset from the hero spawn.
// Same return contract as spawnChest (void; chest is pushed onto _chests).
export function spawnAt(x, z) {
  return spawnChest(x, z);
}

function _tickOpenFlashes(dt) {
  for (let i = _openFlashes.length - 1; i >= 0; i--) {
    const f = _openFlashes[i];
    f.t += dt;
    const k = f.t / f.life;
    if (k >= 1) {
      _scene.remove(f.group);
      _openFlashes.splice(i, 1);
      continue;
    }
    // Lift + fade
    f.group.position.y += dt * 0.4;
    f.group.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m.transparent) { m.transparent = true; m.depthWrite = false; }
          m.opacity = Math.max(0, 1 - k * 1.1);
        }
      }
    });
  }
}

export function tickChests(dt) {
  _tickOpenFlashes(dt);
  if (_chests.length === 0) return;
  // Gem collection runs earlier in the frame and can open a level-up draft.
  // Do not let a chest underneath the hero open a second modal in that same
  // frame (or while a cascade draft is visible); it remains visibly waiting
  // and becomes collectible as soon as the player finishes that choice.
  // `pendingLevelUp` means a draft visibly owns input. A non-zero count with
  // pendingLevelUp=false is the intentional three-second chain-breaker rest;
  // it must not starve a chest that is already underfoot during that quiet
  // window. The banked drafts resume normally after the chest modal closes.
  if (state.pendingLevelUp || state.time.paused) return;
  const hx = state.hero.pos.x, hz = state.hero.pos.z;
  for (let i = _chests.length - 1; i >= 0; i--) {
    const c = _chests[i];
    if (!c.alive) continue;
    c.t += dt;

    // Gently breathe the reward badge; it should feel alive, not rotate into
    // the target-like circle that made drops look like hostile AoEs.
    const marker = c.group.userData.marker;
    if (marker) {
      const phase = marker.userData.spinPhase || 0;
      marker.rotation.y = phase + Math.sin(c.t * 1.25 + phase) * 0.08;
      const s = 1 + Math.sin(c.t * 2.4 + phase) * 0.05;
      marker.scale.setScalar(s);
    }
    const twinkle = c.group.userData.twinkle;
    if (twinkle) {
      twinkle.rotateZ(dt * 3.2);
      twinkle.material.opacity = 0.7 + 0.3 * Math.abs(Math.sin(c.t * 5.5));
    }
    c.group.position.y = Math.sin(c.t * 2.0) * 0.08;

    // Pickup check
    const dx = c.x - hx, dz = c.z - hz;
    if (dx * dx + dz * dz <= PICKUP_RADIUS_SQ) {
      c.alive = false;
      spawnKillRing(c.x, c.z, true); // large celebratory paw poof
      // Burst of 10 gold sparks outward
      for (let s = 0; s < 10; s++) {
        const a = (s / 10) * Math.PI * 2 + Math.random() * 0.3;
        const r = 0.4 + Math.random() * 0.4;
        spawnMagnetSpark(c.x + Math.cos(a) * r, 0.6 + Math.random() * 1.0, c.z + Math.sin(a) * r, 0xffe14a);
      }
      // Visual "open" — swap to chest_open GLB at the same position for a beat,
      // then despawn. Fire-and-forget; the open mesh is its own ephemeral object.
      _spawnOpenChestFlash(c.x, c.z);
      _scene.remove(c.group);
      _chests.splice(i, 1);
      state.fx.shake = Math.max(state.fx.shake, 0.4);
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost, 0.5);
      import('./ui.js').then(({ tryAchievement }) => tryAchievement('first_chest'));
      import('./meta.js').then(({ questEvent }) => questEvent('chestOpen'));
      showSlotMachine();
      return; // one chest per frame
    }
  }
}

export function spawnChestNearHero(minR = 6, maxR = 12) {
  const ang = Math.random() * Math.PI * 2;
  const r = minR + Math.random() * (maxR - minR);
  let x = state.hero.pos.x + Math.cos(ang) * r;
  let z = state.hero.pos.z + Math.sin(ang) * r;
  if (state.run && state.run.stage && state.run.stage.id === 'forest') {
    x = constrainForestX(x, 2);
    z = constrainForestZ(z, 2);
  }
  spawnChest(x, z);
}

export function resetChests() {
  if (!_scene) return;
  for (const c of _chests) {
    if (c.group && c.group.parent) c.group.parent.remove(c.group);
  }
  _chests.length = 0;
  for (const flash of _openFlashes) {
    if (flash.group && flash.group.parent) flash.group.parent.remove(flash.group);
  }
  _openFlashes.length = 0;
}
