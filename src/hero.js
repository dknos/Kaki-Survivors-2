/**
 * Hero: spawn, movement, damage, level-up trigger.
 */
import * as THREE from 'three';
import { state, xpForLevel } from './state.js';
import { HERO, DASH, JUMP, AVATARS, archetypeForAvatar } from './config.js';
import {
  applyDamageFlash,
  applyRimLight,
  cloneCached,
  configureSharedEnvironmentMaterial,
  disposeUpgradedMaterials,
  upgradeMaterials,
} from './assets.js';
import { selectedAvatar } from './meta.js';
import { sfx } from './audio.js';
import { showDeathScreen, showLevelUpModal, flashDamage, flashLevelUp } from './ui.js';
import { weaponChoices } from './weapons/index.js';
import { isDashPressed, consumeJump, consumePadInteract } from './input.js';
import { gamepadState } from './gamepad.js';
import { queryRadius, damageEnemy } from './enemies.js';
import { spawnDashStreak } from './vfxBurst.js';
import { smashLogsInRadius } from './destructibles.js';
import { spawnHeroDamageNumber, spawnHeroTextFloater } from './damageNumbers.js';
import { checkEvolutionEligibility } from './weapons/index.js';
import { spawnImpactBurst } from './vfxBurst.js';
import { updateHeroProcAnim } from './heroAnim.js';

const _tmpDir = new THREE.Vector3();
// Reused accumulator for the procedural pose layer (flinch/dash/idle/attack) —
// reset each frame, no per-frame allocation.
const _procOut = { dy: 0, rx: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
// A wall-hugging Lockdown pack can put dozens of enemies inside the Dash
// radius. Resolving every death, sprite flash, XP drop and sound in one frame
// produced multi-second main-thread stalls. Keep the exact once-per-dash hit
// set, but drain it in small, deterministic slices.
const DASH_HIT_BUDGET = 12;

function _queueDashHits(hero, cfg) {
  if (!hero._dashHitQueue) {
    hero._dashHitQueue = [];
    hero._dashHitRead = 0;
    if (hero._dashHitSerial == null) hero._dashHitSerial = 0;
  }
  const queue = hero._dashHitQueue;
  const serial = hero._dashHitSerial;
  const cands = queryRadius(hero.pos, cfg.radius);
  for (let i = 0; i < cands.length; i++) {
    const enemy = cands[i];
    if (!enemy || !enemy.alive || enemy._dashQueuedSerial === serial) continue;
    enemy._dashQueuedSerial = serial;
    queue.push(enemy);
  }
}

function _drainDashHits(hero, cfg) {
  const queue = hero._dashHitQueue;
  if (!queue || hero._dashHitRead >= queue.length) return;
  const end = Math.min(queue.length, hero._dashHitRead + DASH_HIT_BUDGET);
  for (; hero._dashHitRead < end; hero._dashHitRead++) {
    const enemy = queue[hero._dashHitRead];
    if (!enemy || !enemy.alive) continue;
    enemy.knockVx = hero._dashDirX * cfg.knockback;
    enemy.knockVz = hero._dashDirZ * cfg.knockback;
    damageEnemy(enemy, cfg.dmg, 'dash');
  }
  if (hero._dashHitRead >= queue.length) {
    queue.length = 0;
    hero._dashHitRead = 0;
  }
}

// ── Mirror Step (Dash evolution) ──────────────────────────────────────────
// Shared geometry/material caches for the ghost-twin orbital burst.
const _GHOST_CORE_GEO = new THREE.SphereGeometry(0.18, 8, 8);
const _GHOST_CORE_MAT = new THREE.MeshBasicMaterial({ color: 0xff5cd0 });
const _GHOST_HALO_GEO = new THREE.SphereGeometry(0.55, 12, 10);
const _GHOST_HALO_MAT = new THREE.MeshBasicMaterial({
  color: 0xff5cd0, transparent: true, opacity: 0.35, depthWrite: false,
});
// Tracks live ghost-twin visuals so updateHero can fade them.
const _mirrorGhosts = [];

function spawnMirrorStepGhost(x, z) {
  // Visual: a magenta halo + core at the dash-start position. Lives ~0.5s
  // and shrinks/fades. Doesn't collide — purely decorative.
  const group = new THREE.Group();
  const core = new THREE.Mesh(_GHOST_CORE_GEO, _GHOST_CORE_MAT);
  const halo = new THREE.Mesh(_GHOST_HALO_GEO, _GHOST_HALO_MAT.clone());
  group.add(core);
  group.add(halo);
  group.position.set(x, 0.6, z);
  state.scene.add(group);
  _mirrorGhosts.push({ group, halo: halo.material, t: 0, life: 0.55 });

  // Orbital burst: 8 magenta projectiles radiating outward. Uses the same
  // state.projectiles.active list so the central tick handles motion/hits.
  const COUNT = 8;
  const SPEED = 18;
  const DMG = 25;
  const TTL = 0.7;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * Math.PI * 2;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    const m = new THREE.Group();
    const c = new THREE.Mesh(_GHOST_CORE_GEO, _GHOST_CORE_MAT);
    m.add(c);
    m.position.set(x, 0.5, z);
    state.scene.add(m);
    state.projectiles.active.push({
      mesh: m,
      vel: new THREE.Vector3(dir.x * SPEED, 0, dir.z * SPEED),
      dmg: DMG * (state.hero.statMul.dmg || 1),
      ttl: TTL,
      pierce: 2,
      hit: new Set(),
      ownerWeapon: 'mirror_step',
    });
  }
}

function _tickMirrorGhosts(dt) {
  for (let i = _mirrorGhosts.length - 1; i >= 0; i--) {
    const g = _mirrorGhosts[i];
    g.t += dt;
    const k = g.t / g.life;
    if (k >= 1) {
      state.scene.remove(g.group);
      if (g.halo) g.halo.dispose();
      _mirrorGhosts.splice(i, 1);
      continue;
    }
    const fade = 1 - k;
    if (g.halo) g.halo.opacity = 0.35 * fade;
    g.group.scale.setScalar(1 + k * 0.6);
  }
}

export function resetHeroTransientFX() {
  for (let i = 0; i < _mirrorGhosts.length; i++) {
    const g = _mirrorGhosts[i];
    if (g.group && g.group.parent) g.group.parent.remove(g.group);
    if (g.halo) g.halo.dispose();
  }
  _mirrorGhosts.length = 0;
}

export function initHero(scene) {
  const group = new THREE.Group();
  group.name = 'heroGroup';

  // GLB-load fallback marker lives in the `else` branch below (cone @ y=1.1).
  // No unconditional ground disc — that was reading as a green ring/shadow
  // on top of the loaded GLB.
  // Iter 32: avatar (visual identity) is decoupled from character (archetype).
  // Pick mesh by avatar.glb override; fall back to shared 'hero' donor.
  const _avatar = selectedAvatar(AVATARS);
  const _heroKey = _avatar && _avatar.glb ? `hero_${_avatar.id}` : 'hero';
  const mesh = cloneCached(_heroKey) || cloneCached('hero');
  if (mesh) {
    // Own/promote once before any per-avatar styling. Rim and flash nodes are
    // attached only after tinting so no later Material.clone() disconnects
    // their per-object controller state.
    upgradeMaterials(mesh, 0.55, 0.92, { rim: false });
    // Auto-fit: measure native bbox, derive scale = targetHeight / bbox.y.
    // Survives GLB re-exports with different units (the 0.06→4.0 drift saga).
    const rawBox = new THREE.Box3().setFromObject(mesh);
    const rawSize = rawBox.getSize(new THREE.Vector3());
    const autoFit = rawSize.y > 1e-6 ? HERO.targetHeight / rawSize.y : 1;
    // Iter 32: tint comes from the ARCHETYPE block, but only when the avatar
    // has no dedicated mesh — tinting a Sote-baked model would look wrong
    // (his textures are already authored). Avatars w/ their own GLB render
    // unaltered regardless of archetype color.
    // Iter 34: archetype derives from the avatar's baseArchetype field
    // (Phase C of progression redesign), not from a separate selectedChar.
    const char = archetypeForAvatar(_avatar);
    const avatarScale = _avatar && _avatar.scaleMul ? _avatar.scaleMul : 1;
    const charScale = char && char.scaleMul ? char.scaleMul : 1;
    const applyArchetypeTint = !(_avatar && _avatar.glb);
    const charTint = (applyArchetypeTint && char && char.tint != null) ? char.tint : 0xffffff;
    mesh.scale.setScalar(autoFit * HERO.scale * charScale * avatarScale);
    mesh.position.set(0, HERO.yOffset, 0);
    let meshCount = 0;
    const _tint = new THREE.Color(charTint);
    mesh.traverse((o) => {
      if (o.isMesh) {
        meshCount++;
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
        if (charTint !== 0xffffff && o.material) {
          const materials = Array.isArray(o.material) ? o.material : [o.material];
          for (const material of materials) {
            if (material?.color) material.color.multiply(_tint);
          }
        }
      }
    });
    applyRimLight(mesh);
    applyDamageFlash(mesh, {
      color: 0xff3344,
      intensity: 2.4,
      amount: 0,
    });
    group.add(mesh);
    _innerMesh = mesh;
    _baseInnerY = mesh.position.y;
    _baseScale = mesh.scale.x;
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    console.log(`[hero] GLB loaded — ${meshCount} mesh(es), raw bbox.y=${rawSize.y.toFixed(3)}, autoFit=${autoFit.toFixed(3)}, final size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
  } else {
    // Hero GLB didn't load — make the marker tower-shaped so it's obvious
    const fallback = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 2.2, 8),
      configureSharedEnvironmentMaterial(
        new THREE.MeshLambertMaterial({ color: 0xff44cc, emissive: 0x441133 }),
        0,
      )
    );
    fallback.position.y = 1.1;
    group.add(fallback);
    console.warn('[hero] tower-castle.glb missing — using fallback cone');
  }

  scene.add(group);
  state.hero.mesh = group;
  state.hero.pos = new THREE.Vector3(0, 0, 0);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, 1);
  // Iter 2 — per-run combat stamps. initHero runs on every run start (via
  // rebuildHero) AFTER resetState zeroes the game clock, so stale 'until'
  // stamps from a prior run would otherwise read as armed for the new run.
  state.hero._dashIFramesUntil = 0;
  state.hero._lastDashRankLevel = null;
  state.hero._flashUntil = 0;
  state.hero._wasFlashing = false;
  state.run.perfectDodgeUntil = 0;
  // A dash in the hub (frozen game clock) stamps iFramesUntil≈0.30 and shake
  // while the clock reads 0, which then leaks ~0.3s of invincibility + flicker +
  // shake into the opening of the next run. Clear both here like the dash stamps.
  state.hero.iFramesUntil = 0;
  state.fx.shake = 0;
}

/**
 * Re-create the hero mesh for the currently-selected character. Called when
 * the player picks a different character on the start screen, and on restart.
 * Cheap: GLB is cached, only does a clone + re-add.
 */
export function rebuildHero(scene) {
  if (_innerMesh) disposeUpgradedMaterials(_innerMesh);
  if (state.hero.mesh && state.hero.mesh.parent) {
    state.hero.mesh.parent.remove(state.hero.mesh);
  }
  state.hero.mesh = null;
  _innerMesh = null;
  initHero(scene);
}

// Camera is at (+X, +Y, +Z) looking at hero — yaw 45°. Remap input axes to
// align with what the player sees on screen instead of raw world XZ.
const SQRT_HALF = 0.7071067811865476;

// Procedural walk animation state
let _stepPhase = 0;
let _innerMesh = null;     // the GLB child of state.hero.mesh (excludes the disc marker)
let _baseInnerY = 0;
let _baseScale = 1;        // captured at init after auto-fit, used by death anim

// ── Interact key (FE-C3A, Forest Expansion) ─────────────────────────────────
// Edge-triggered E (keyboard) + B-button (gamepad). Writes one-frame
// state.input.interactPressed = true; consumed by puzzle system / portals on
// read. Note: spec called for A-button (gamepad), but A is already DASH
// (input.js isDashPressed checks gamepadState.buttons.a). The existing input
// pipeline routes B → _padInteractQueued → consumePadInteract(), so we reuse
// that to avoid colliding with dash.
let _interactKeyQueued = false;
let _interactListenerInstalled = false;
// A gamepad button used to close a paused modal can still be physically held
// on the first resumed gameplay sample. Suppress B until it is released so
// that close action cannot also activate a nearby portal.
let _suppressPadInteractUntilRelease = false;
function _installInteractListener() {
  if (_interactListenerInstalled) return;
  _interactListenerInstalled = true;
  // Edge-trigger on keydown, ignore auto-repeat so a held E only fires once.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' || e.repeat) return;
    const blocked = !state.started || state.gameOver || state.pendingLevelUp
      || !!(state.time && state.time.paused);
    _interactKeyQueued = !blocked;
  });
}
_installInteractListener();

/** Drop keyboard/gamepad interaction edges while gameplay is blocked. */
export function discardQueuedInteract() {
  _interactKeyQueued = false;
  _suppressPadInteractUntilRelease = true;
  try { consumePadInteract(); } catch (_) {}
  if (state.input) state.input.interactPressed = false;
}

// Iter 2 — dash auto-ranks at fixed hero levels (DASH.autoRankLevels). Called
// every frame from updateHero (stamp-compare = no-op unless level changed) so
// it sees levels granted by BOTH the hero.js XP drain below and xp.js's
// instant-level pickups. `h.level < stamped` means the run restarted under a
// stale stamp — re-stamp without ranking.
function _checkDashAutoRank(h) {
  const stamped = h._lastDashRankLevel;
  if (stamped == null || h.level < stamped) { h._lastDashRankLevel = h.level; return; }
  if (h.level === stamped) return;
  const maxLvl = DASH.levels.length - 1;
  const ranks = DASH.autoRankLevels || [];
  let granted = false;
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] > stamped && ranks[i] <= h.level && h.dashLevel < maxLvl) {
      h.dashLevel += 1;
      granted = true;
    }
  }
  h._lastDashRankLevel = h.level;
  if (granted) {
    // Dash left the draft (where picking it WAS the announcement) — call the
    // rank out, and poke evolution eligibility so the Mirror Step READY
    // banner lands the moment the dashLevel gate is crossed, not minutes
    // later on the next filler pick / miniboss kill.
    try { spawnHeroTextFloater(`DASH RANK ${h.dashLevel}`); } catch (_) {}
    if (sfx && sfx.weaponDash) sfx.weaponDash();
    try { checkEvolutionEligibility(); } catch (_) {}
  }
}

function _heroInputBlocked() {
  if (state.time && state.time.paused) return true;
  try {
    return !!(typeof document !== 'undefined'
      && document.querySelector('[role="dialog"][aria-modal="true"]'));
  } catch (_) {
    return false;
  }
}

export function updateHero(dt) {
  // Hub/overlay scenes still tick cosmetic visuals, but movement and context
  // actions must never leak through an Options, Shop, or minigame dialog.
  if (_heroInputBlocked()) {
    discardQueuedInteract();
    if (state.input && state.input.moveVec && state.input.moveVec.set) state.input.moveVec.set(0, 0);
    return;
  }
  const h = state.hero;
  const mv = state.input.moveVec;

  // ── Interact one-shot (FE-C3A) ─────────────────────────────────────────
  // Drain the keyboard edge-trigger AND the gamepad B-button queue into
  // state.input.interactPressed. Set true for exactly this frame; main.js
  // clears it at the end of the tick so a missed reader never sees a stale
  // press next frame. Cleared here too in case readers (puzzle/portal) run
  // before main.js's end-of-frame sweep and to handle the no-press case.
  state.input.interactPressed = false;
  let _padInteract = false;
  try { _padInteract = consumePadInteract(); } catch (_) {}
  if (_suppressPadInteractUntilRelease) {
    _padInteract = false;
    if (!(gamepadState.connected && gamepadState.buttons && gamepadState.buttons.b)) {
      _suppressPadInteractUntilRelease = false;
    }
  }
  if (_interactKeyQueued || _padInteract) {
    state.input.interactPressed = true;
    _interactKeyQueued = false;
  }

  // Isometric input remap: screen up = world -X-Z, screen right = world +X-Z.
  let speedMul = h.statMul.moveSpeed || 1;
  if (h.dashCD > 0) h.dashCD -= dt;

  // Pummarola passive: continuous HP regen (capped at hpMax). Cheap, no alloc.
  // Iter 11 — Shop Tree Live Wires: Survival tier 3 "Regeneration" adds
  // passive_regen HP/sec on top of Pummarola so the two stack additively
  // (a player with both gets regenPerSec + passive_regen per second).
  const _regenRate = (h.regenPerSec || 0) + (state.run.passive_regen || 0);
  if (_regenRate > 0 && h.hp > 0 && h.hp < h.hpMax && !state.gameOver) {
    h.hp = Math.min(h.hpMax, h.hp + _regenRate * dt);
  }

  // Dash trigger
  if (h.dashUnlocked && h.dashLevel > 0 && h.dashCD <= 0 && state.time.real >= h.dashUntil && isDashPressed()) {
    const cfg = DASH.levels[Math.min(h.dashLevel, DASH.levels.length - 1)];
    if (cfg) {
      // Air-dash combo: if jumping/airborne at dash start, lock a 0.4s phase
      // dash that ignores gravity. Reads as a true "blink forward in air" beat
      // — pre-evolution flavor of a phase dash.
      const isAirborne = !h.grounded || h.pos.y > 0.01;
      const dur = isAirborne ? Math.max(cfg.duration, 0.4) : cfg.duration;
      h.dashUntil = state.time.real + dur;
      h._airDashUntil = isAirborne ? state.time.real + dur : 0;
      // Mirror Step (dash evolution): −25% dash cooldown + spawn a ghost twin
      // at the start position that fires one orbital burst before fading.
      const cdMul = h.dashEvolved ? 0.75 : 1.0;
      h.dashCD = cfg.cooldown * cdMul;
      h._dashHitSerial = (h._dashHitSerial || 0) + 1;
      // A fresh dash cannot inherit a partially-drained previous queue. In
      // normal tuning the prior queue drains long before cooldown, but this
      // makes the invariant explicit under extreme horde QA.
      if (h._dashHitQueue) { h._dashHitQueue.length = 0; h._dashHitRead = 0; }
      if (h.dashEvolved) {
        try { spawnMirrorStepGhost(h.pos.x, h.pos.z); } catch (_) {}
      }
      if (sfx && sfx.weaponDash) sfx.weaponDash();
      h.iFramesUntil = state.time.game + cfg.iFrames;
      // Iter 2 — parallel stamp so takeDamage can tell DASH i-frames apart
      // from post-hit i-frames (perfect-dodge detection).
      h._dashIFramesUntil = h.iFramesUntil;
      if (isAirborne) {
        h.velY = 0;             // freeze vertical motion at dash start
      }
      // Dash direction: current move input, or facing if idle
      const ix = mv.x, iy = mv.y;
      if (ix * ix + iy * iy > 0.01) {
        h.dashDir.x = (ix + iy) * SQRT_HALF;
        h.dashDir.z = (iy - ix) * SQRT_HALF;
        const dl = Math.hypot(h.dashDir.x, h.dashDir.z) || 1;
        h.dashDir.x /= dl; h.dashDir.z /= dl;
      }
      // else: keep last dashDir (or facing); state.hero.facing is already a unit XZ vector
      if (h.facing && (h.facing.x || h.facing.z) && ix*ix+iy*iy < 0.01) {
        h.dashDir.x = h.facing.x; h.dashDir.z = h.facing.z;
      }
      state.fx.shake = Math.max(state.fx.shake, 0.35);
    }
  }

  // Apply dash speed boost + knock+damage to nearby enemies on each dashing frame
  const dashing = state.time.real < h.dashUntil;
  if (dashing) {
    const cfg = DASH.levels[Math.min(h.dashLevel, DASH.levels.length - 1)];
    if (cfg) {
      // Motion trail — one stretched additive plane behind the hero per frame.
      // Mirror Step recolors the dash trail magenta.
      const trailColor = h.dashEvolved ? 0xff5cd0 : 0x7fffe4;
      try { spawnDashStreak(h.pos.x, h.pos.z, h.dashDir.x, h.dashDir.z, trailColor); } catch (_) {}
      speedMul *= cfg.speedMul;
      // Hit enemies within radius around hero this frame
      try {
        _queueDashHits(h, cfg);
        // Smash any breakable logs the dash sweeps through.
        smashLogsInRadius(h.pos.x, h.pos.z, cfg.radius);
      } catch (_) {}
      h._dashDirX = h.dashDir.x;
      h._dashDirZ = h.dashDir.z;
    }
  }

  // Keep draining after movement ends: the queue contains the exact enemies
  // the dash swept, and resolving it over a few frames preserves total damage
  // while preventing one packed wall collision from monopolizing a frame.
  if (h._dashHitQueue && h._dashHitQueue.length > 0) {
    const cfg = DASH.levels[Math.min(h.dashLevel, DASH.levels.length - 1)];
    if (cfg) _drainDashHits(h, cfg);
  }

  // Stage hazard slow (pollen drifts, etc.) — read by hero movement.
  const hazardSlow = h.hazardSlow || 1;
  // Grothar Engulf 1.0s slow flag (set by bossTelegraphs.js on resolve).
  if (state.run.signature_engulfSlowUntil && state.run.signature_engulfSlowUntil > state.time.game) speedMul *= 0.5;
  // Frosted-affix aura slow (set per-frame by enemies.js agent 8a; defaults to 1).
  if (state.run.affix_frostSlow) speedMul *= state.run.affix_frostSlow;
  // Twilight Fountain drink buff — published by src/twilightFountains.js when
  // the player drinks within proximity of a fountain. 1.75× for 4 seconds,
  // 30s per-fountain cooldown. Mirrors the engulf/frost publish-and-read
  // pattern above so this stays stat-recompute-safe (Option A in
  // twilightFountains.js header).
  if (state.run.fountainSpeedBuff && state.run.fountainSpeedBuff.expiresAt > state.time.game) {
    speedMul *= state.run.fountainSpeedBuff.mul;
  }
  const speed = HERO.speed * speedMul * hazardSlow;
  // While dashing, override input direction with the locked dashDir
  const dx = dashing ? h.dashDir.x : (mv.x + mv.y) * SQRT_HALF;
  const dz = dashing ? h.dashDir.z : (mv.y - mv.x) * SQRT_HALF;
  const vx = dx * speed;
  const vz = dz * speed;
  h.vel.set(vx, 0, vz);

  h.pos.x += vx * dt;
  h.pos.z += vz * dt;

  // ── Jump / gravity ──
  if (consumeJump() && h.grounded) {
    h.velY = JUMP.velocity;
    h.grounded = false;
  }
  // While an air-dash is active, freeze the hero at current altitude (no
  // gravity). When it expires, gravity resumes naturally for the rest of the
  // jump arc.
  const airDashing = h._airDashUntil && state.time.real < h._airDashUntil;
  if (airDashing) {
    h.velY = 0;
    h.grounded = false;
  } else if (!h.grounded || h.pos.y > JUMP.groundY) {
    h.velY += JUMP.gravity * dt;
    h.pos.y += h.velY * dt;
    if (h.pos.y <= JUMP.groundY) {
      // Landing — capture velY for squash strength, then ground.
      const impact = Math.min(1.0, -h.velY / 12);
      if (impact > 0.05) {
        h._squashUntil = state.time.real + 0.18;
        h._squashStrength = impact;
      }
      h.pos.y = JUMP.groundY;
      h.velY = 0;
      h.grounded = true;
    }
  } else {
    h.pos.y = JUMP.groundY;
  }

  if (h.mesh) {
    h.mesh.position.set(h.pos.x, HERO.yOffset + h.pos.y, h.pos.z);

    // Face move direction + procedural walk animation
    const mag2 = vx * vx + vz * vz;
    if (mag2 > 1e-4) {
      _tmpDir.set(vx, 0, vz).normalize();
      h.facing.copy(_tmpDir);
      const yaw = Math.atan2(vx, vz);
      h.mesh.rotation.y = yaw;

      // Step phase advances faster the faster we walk
      const mag = Math.sqrt(mag2);
      _stepPhase += mag * dt * 1.6;
    } else {
      _stepPhase += dt * 0.5;  // gentle idle breathing
    }

    if (_innerMesh) {
      const moving = mag2 > 1e-4;
      // Airborne: zero out the step bob/sway, lean into velocity for "leap" feel.
      const airFactor = h.grounded ? 1.0 : 0.15;
      const bob = (moving ? Math.abs(Math.sin(_stepPhase * Math.PI)) * 0.25
                          : Math.sin(_stepPhase) * 0.04) * airFactor;
      // Tilt forward into movement direction (about local X axis)
      const tilt = (moving ? 0.18 : 0) * airFactor + (h.grounded ? 0 : 0.10);
      // Side-to-side sway each step (about local Z axis)
      const sway = (moving ? Math.sin(_stepPhase * Math.PI) * 0.10 : 0) * airFactor;

      // Landing squash as scale multipliers (1 = none) — brief Y-flatten +
      // X/Z-bulge after a high-velocity ground hit. Folded into the compose
      // below so it stacks with the procedural pose layer instead of fighting it.
      let sqX = 1, sqY = 1, sqZ = 1;
      if (h._squashUntil && state.time.real < h._squashUntil) {
        const k = (h._squashUntil - state.time.real) / 0.18;   // 1→0
        const amt = (h._squashStrength || 0.5) * k;
        sqY = 1 - amt * 0.25; sqX = 1 + amt * 0.15; sqZ = 1 + amt * 0.15;
      } else if (h._squashUntil) {
        h._squashUntil = 0;
      }

      // Procedural pose layer — hit flinch, dash stretch, idle breathing,
      // attack recoil. Additive offsets / multiplicative scale on top of the
      // walk + squash above. Reset the accumulator, then compose.
      _procOut.dy = 0; _procOut.rx = 0; _procOut.rz = 0;
      _procOut.sx = 1; _procOut.sy = 1; _procOut.sz = 1;
      try { updateHeroProcAnim(h, state.time.real, dt, _procOut); } catch (_) {}

      _innerMesh.position.y = _baseInnerY + bob + _procOut.dy;
      _innerMesh.rotation.x = tilt + _procOut.rx;
      _innerMesh.rotation.z = sway + _procOut.rz;
      _innerMesh.scale.set(
        _baseScale * sqX * _procOut.sx,
        _baseScale * sqY * _procOut.sy,
        _baseScale * sqZ * _procOut.sz,
      );
    }

    // I-frame flicker — COMBAT MODES ONLY. In town/interior/casino/menu the game
    // clock (state.time.game) is frozen while wall time (state.time.real) keeps
    // ticking, so a leftover iFramesUntil from the last run would satisfy
    // `game < iFramesUntil` forever and blink the hero endlessly (phase toggles
    // on real time). Only flicker where the game clock actually advances.
    const _m = state.mode;
    const _combat = (_m === 'run' || _m === 'bullethell' || _m === 'catacomb');
    const _promoCapture = typeof window !== 'undefined' && window.__promoCapture === true;
    if (_combat && !_promoCapture && state.time.game < h.iFramesUntil) {
      const phase = Math.floor(state.time.real * 1000 / 80) % 2;
      h.mesh.visible = phase === 0;
    } else if (!h.mesh.visible) {
      h.mesh.visible = true;
    }

    // TSL hit flash: one edge-triggered controller write, with no material
    // property traversal or per-frame node/material allocation.
    const flashController = _innerMesh?.userData?.damageFlashController;
    if (flashController) {
      const flashing = (h._flashUntil || 0) > state.time.real;
      if (flashing !== h._wasFlashing) {
        flashController.setFlashing(flashing);
        h._wasFlashing = flashing;
      }
    }
  }

  // Mirror Step: tick the ghost-twin visuals (fade/scale out).
  _tickMirrorGhosts(dt);

  // Level-up check — Iter 32i batching.
  // Drain ALL levels in one go, count them into pendingLevelCount, then
  // open a single modal that the player walks through. Was: each iteration
  // showed a separate modal, recurring after applyLevelUpChoice, causing
  // the "click click click" cascade.
  let didLevel = false;
  while (h.xp >= h.xpNext) {
    h.xp -= h.xpNext;
    h.level += 1;
    h.xpNext = xpForLevel(h.level);
    state.pendingLevelCount = (state.pendingLevelCount || 0) + 1;
    didLevel = true;
  }
  if (didLevel && !state.pendingLevelUp) {
    state.pendingLevelUp = true;
    state.levelUpChoices = weaponChoices(3 + ((state && state.run && state.run.casinoExtraChoices) || 0));
    showLevelUpModal(state.levelUpChoices);
    if (sfx && sfx.levelUp) sfx.levelUp();
    try { flashLevelUp(); } catch (_) {}
  }

  // Iter 2 — dash auto-rank (sees xp.js level grants too; see helper).
  _checkDashAutoRank(h);
}

// Perfect dodge (Iter 2): a hit absorbed specifically by DASH i-frames arms a
// short global damage pulse (DASH.perfectDodge) that enemies.damageEnemy reads
// off state.run.perfectDodgeUntil in its multiplier stack. Feedback fires only
// on the ARMING hit — refreshes inside an already-active pulse stay silent so
// a multi-hit dash can't machine-gun the fx/sfx.
function _onPerfectDodge() {
  const pd = DASH.perfectDodge;
  if (!pd) return;
  const already = state.run.perfectDodgeUntil && state.time.game < state.run.perfectDodgeUntil;
  state.run.perfectDodgeUntil = state.time.game + pd.pulseSec;
  if (already) return;
  // No chromaticPulse here — that channel means "hurt". Gold floater + a
  // dedicated rising chime carry the "you did something right" read.
  if (state.fx.shake < 0.22) state.fx.shake = 0.22;
  try { spawnHeroTextFloater('PERFECT DODGE'); } catch (_) {}
  if (sfx && sfx.perfectDodge) sfx.perfectDodge();
}

// source: 'contact' (default) | 'projectile' | 'telegraph' | env kinds.
// Perfect dodge procs ONLY on projectile/telegraph absorbs — dash is also the
// melee damage tool, so plain body contact during a dash is near-guaranteed
// and would turn the proc into a free +30% buff instead of a dodge read.
export function takeDamage(amt, source) {
  const h = state.hero;
  if (state.time.game < h.iFramesUntil) {
    if (state.time.game < (h._dashIFramesUntil || 0)
        && (source === 'projectile' || source === 'telegraph')) {
      _onPerfectDodge();
    }
    return;
  }
  if (state.gameOver) return;

  // Armor passive multiplier (lower = less damage taken; capped at 0.40)
  let dmgMul = (h.statMul && h.statMul.dmgTaken) ? h.statMul.dmgTaken : 1;
  // Sanctum (Sticky Web evolution): −30% damage while standing in any
  // burning web. Flag refreshed every web tick — see weapons/web.js.
  if (h.inSanctum) dmgMul *= 0.7;
  // Iter 11 — Shop Tree Live Wires: Survival tier 1 "Iron Skin" wires
  // passive_dmgReduction (additive 0..1, cap 0.75) into incoming damage.
  // Composes multiplicatively with the existing dmgTaken multiplier so a
  // run with Armor + Iron Skin stacks gracefully. Must run BEFORE Nine Lives
  // consumption below so the signature consumes a post-DR lethal hit.
  if (state.run.passive_dmgReduction > 0) {
    dmgMul *= (1 - Math.min(0.75, state.run.passive_dmgReduction));
  }
  amt = amt * dmgMul;
  h.hp -= amt;
  h.iFramesUntil = state.time.game + HERO.iFramesSec;
  state.run.dmgTaken += amt;
  state.run.flawless = false;
  state.run.noDmgKills = 0;
  // Damage-scaled feedback: small hits = subtle, big hits = jarring.
  const sev = Math.min(1, amt / 30);          // 30 dmg → max severity
  state.fx.chromaticPulse = 0.4 + 0.6 * sev;
  if (state.fx.shake < 0.30 + 0.30 * sev) state.fx.shake = 0.30 + 0.30 * sev;
  // Deeper "ouch" SFX for harder hits. Wired in audio.js.
  try { flashDamage(sev); } catch (_) {}
  // Iter 24d — heroHurt SFX gain scales with damage severity (0.42..0.78).
  // Heavy contact (boss slam) gets a louder, lower-pitched ouch.
  if (sfx && sfx.heroHurt) {
    sfx.heroHurt({ gain: 0.42 + sev * 0.36, rate: 1.0 - sev * 0.08 });
  }
  try { spawnHeroDamageNumber(amt); } catch (_) {}

  // Iter 24d — hero mesh red-flash + contact-point spark burst.
  // Flash duration scales 0.10..0.22s with severity. Spark fires at hero
  // chest height so iso camera reads it as a hit, not a footstep.
  h._flashUntil = state.time.real + (0.10 + sev * 0.12);
  // Procedural hit-flinch trigger (read by heroAnim.js).
  h._hurtAt = state.time.real;
  try {
    spawnImpactBurst(h.pos.x, (h.pos.y || 0) + 0.9, h.pos.z, 0xff3344, 0.4 + sev * 0.5);
  } catch (_) {}

  if (h.hp <= 0) {
    // ── Kitty "Nine Lives" signature: first lethal hit becomes 1 HP + i-frame.
    // Skipped if Shop Tree Second Wind already grants a revive — prevents
    // double-stacking the survival comeback (see ITER_789_BRIEFS.md risk flag).
    if (
      state.run.signature_nineLives === true &&
      !state.run.signature_nineLivesUsed &&
      !state.run.passive_revives
    ) {
      h.hp = 1;
      h.iFramesUntil = (state.time.game + HERO.iFramesSec) + 1.5;
      state.run.signature_nineLivesUsed = true;
      return;
    }

    // ── Phoenix "Ember Burst" signature: on death, emit a one-shot AoE before
    // routing to the death screen. Fires exactly once per run.
    if (state.run.signature_emberBurst) {
      state.run.signature_emberBurst = false;
      try {
        const hp = state.hero.pos;
        const targets = queryRadius(hp, 10) || [];
        for (const e of targets) {
          if (!e || !e.alive || !e.mesh) continue;
          // Knockback: normalized direction away from hero × 16
          const dx = e.mesh.position.x - hp.x;
          const dz = e.mesh.position.z - hp.z;
          const len = Math.hypot(dx, dz) || 1;
          e.knockVx = (dx / len) * 16;
          e.knockVz = (dz / len) * 16;
          damageEnemy(e, 200, 'phoenix');
        }
      } catch (err) { console.warn('[phoenix emberBurst]', err); }
    }

    h.hp = 0;
    if (state.run) {
      state.run.outcome = {
        kind: 'defeat',
        stageId: state.run.stage ? state.run.stage.id : null,
        at: state.time.game,
      };
    }
    state.gameOver = true;
    state.dyingUntil = state.time.real + 1.4;
    state.fx.shake = 1.0;
    state.fx.chromaticPulse = 1;
    if (sfx && sfx.heroDeath) sfx.heroDeath();
    // death screen deferred until anim plays out — see updateDeathAnim
  }
}

// Animate hero during the 1.4s death window: squash, spin, fade. Called from
// main.js even while gameOver is true (so the world freezes around the anim).
export function updateDeathAnim(realDt) {
  if (!_innerMesh || !state.gameOver) return;
  const remain = state.dyingUntil - state.time.real;
  const total = 1.4;
  const k = 1 - Math.max(0, Math.min(1, remain / total));   // 0..1 progress
  if (state.victory) {
    // Victory: hop + spin + bright stay (no fade, no sink)
    const hop = Math.sin(k * Math.PI) * 1.6;
    _innerMesh.position.y = _baseInnerY + hop;
    _innerMesh.rotation.y += realDt * 8;
    _innerMesh.scale.set(_baseScale, _baseScale * (1 + hop * 0.15), _baseScale);
  } else {
    // Defeat: squash, sink, fade
    const sxz = 1 + Math.sin(k * Math.PI) * 0.4 - k * 0.35 + Math.sin(k * Math.PI * 4) * 0.05;
    const sy  = 1 + Math.cos(k * Math.PI) * 0.3 - k * 0.6;
    _innerMesh.scale.set(_baseScale * sxz, _baseScale * sy, _baseScale * sxz);
    _innerMesh.rotation.y += realDt * (8 + k * 14);
    _innerMesh.rotation.z = Math.sin(k * Math.PI * 2) * 0.5;
    _innerMesh.position.y = _baseInnerY - k * 0.8;
    _innerMesh.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m.transparent) { m.transparent = true; m.depthWrite = false; }
          m.opacity = Math.max(0, 1 - k * 1.15);
        }
      }
    });
  }
  if (remain <= 0 && !state._deathShown) {
    state._deathShown = true;
    showDeathScreen();
  }
}
