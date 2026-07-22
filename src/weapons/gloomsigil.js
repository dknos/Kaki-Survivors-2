/**
 * Gloomsigil — cave-stage weapon (P4A cohort 7, 2026-05-20).
 *
 * Plants a stationary violet sigil field at the hero's position every cooldown.
 * The field persists for `duration` seconds, ticking `dmg` to every enemy
 * inside its radius on a fixed 0.5s cadence — a placed damage-over-time zone,
 * distinct from frostbloom's instant hero-centred pulse and orbitals' orbit.
 * Drop a sigil, walk on, let the swarm grind itself on it.
 *
 * Stage-gated: `stages: ['cave']` → only offered in the level-up pool on cave
 * runs (see weaponChoices filter in index.js). Carried weapons still tick on
 * any stage, but the card never appears outside the cave.
 *
 * VFX budget (PROGRESSION_REDESIGN §2.1): NO new pool, NO new texture. Reuses
 * the canonical rune-ring art (makeRuneRingTexture) for the field disc and the
 * shared fx.js spark pool for the plant flourish. Slot-4 sigil violet
 * (CAVE_PALETTE.sigil = 0xc87bff) so it reads as cave magic under bloom.
 */
import * as THREE from 'three';
import { damageEnemy, queryRadius } from '../enemies.js';
import { sfx } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';
import { spawnMagnetSpark } from '../fx.js';
import { fxTex } from '../fxTextures.js';
import { applyFloorTier } from '../fxLayers.js';

const SIGIL_VIOLET = 0xc87bff;   // CAVE_PALETTE.sigil (slot 4)
const FIELD_COUNT  = 3;          // concurrent planted fields (cycled)
const TICK_EVERY   = 0.5;        // DoT cadence (seconds)

const RING_GEO = new THREE.PlaneGeometry(2.0, 2.0);
let _runeTex = null;
function _getTex() { return _runeTex || (_runeTex = fxTex('aoe_void') || makeRuneRingTexture()); }
function _makeFieldMat() {
  return new THREE.MeshBasicMaterial({
    map: _getTex(),
    color: SIGIL_VIOLET,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _axisY = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

function _makeField() {
  const m = new THREE.Mesh(RING_GEO, _makeFieldMat());
  m.quaternion.copy(_flat);
  m.position.y = 0.05;
  m.visible = false;
  applyFloorTier(m, 'telegraph', { bloom: false });
  m.userData.yawBase = Math.random() * Math.PI * 2;
  return m;
}

export default {
  id: 'gloomsigil',
  name: 'Gloomsigil',
  desc: 'Plants a violet sigil field that grinds damage into any enemy standing on it',
  icon: '🔮',
  stages: ['cave'],            // cave-only level-up offer
  maxLevel: 8,
  levels: [
    { cooldown: 4.5, radius: 3.4, duration: 3.0, dmg: 4  },
    { cooldown: 4.1, radius: 3.8, duration: 3.3, dmg: 6  },
    { cooldown: 3.7, radius: 4.2, duration: 3.6, dmg: 8  },
    { cooldown: 3.3, radius: 4.7, duration: 4.0, dmg: 11 },
    { cooldown: 2.9, radius: 5.2, duration: 4.4, dmg: 14 },
    { cooldown: 2.5, radius: 5.7, duration: 4.8, dmg: 18 },
    { cooldown: 2.1, radius: 6.3, duration: 5.2, dmg: 22 },
    { cooldown: 1.8, radius: 7.0, duration: 5.6, dmg: 27 },
  ],

  init(state, level, inst) {
    inst.cd = 0.5;
    inst.fields = [];
    inst._next = 0;
    for (let i = 0; i < FIELD_COUNT; i++) {
      const m = _makeField();
      state.scene.add(m);
      inst.fields.push({ mesh: m, age: -1, r: 0, x: 0, z: 0, nextTick: 0 });
    }
  },

  tick(state, dt, level, inst) {
    if (!inst.fields) return;
    const hero = state.hero.pos;
    const now = state.time.game;
    const areaMul = state.hero.statMul.area || 1;
    const radius = level.radius * areaMul;
    const dmgMul = state.hero.statMul.dmg || 1;
    const dmg = level.dmg * dmgMul;

    // Plant a new field on cooldown (cycles through the FIELD_COUNT slots).
    inst.cd -= dt;
    if (inst.cd <= 0) {
      inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
      const f = inst.fields[inst._next % FIELD_COUNT];
      inst._next++;
      f.age = 0;
      f.x = hero.x;
      f.z = hero.z;
      f.r = radius;
      f.nextTick = 0;        // tick immediately on plant
      if (!state._optReduceMotion) {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          spawnMagnetSpark(f.x + Math.cos(a) * radius * 0.5, 0.3, f.z + Math.sin(a) * radius * 0.5, SIGIL_VIOLET);
        }
      }
      try { sfx.weaponWeb && sfx.weaponWeb(); } catch (_) {}
    }

    // Advance each active field: DoT cadence + ring visual.
    for (const f of inst.fields) {
      if (f.age < 0) continue;
      f.age += dt;
      if (f.age > level.duration) { f.age = -1; f.mesh.visible = false; continue; }

      // Damage-over-time on the fixed cadence.
      f.nextTick -= dt;
      if (f.nextTick <= 0) {
        f.nextTick = TICK_EVERY;
        const cand = queryRadius({ x: f.x, z: f.z }, f.r);
        if (cand && cand.length) {
          for (const e of cand) {
            if (!e || !e.alive) continue;
            damageEnemy(e, dmg, 'gloomsigil');
          }
        }
      }

      // Visual: steady disc that fades in over the first 0.3s and out over the
      // last 0.6s; rune ticks rotate slowly so the glyph reads as "inscribed".
      const fadeIn = Math.min(1, f.age / 0.3);
      const fadeOut = Math.min(1, (level.duration - f.age) / 0.6);
      const op = 0.6 * Math.min(fadeIn, fadeOut);
      const scale = f.r;
      f.mesh.position.set(f.x, 0.05, f.z);
      f.mesh.scale.set(scale, scale, scale);
      const yaw = (f.mesh.userData.yawBase || 0) + now * 0.5;
      _quat.setFromAxisAngle(_axisY, yaw);
      f.mesh.quaternion.multiplyQuaternions(_quat, _flat);
      f.mesh.material.opacity = op;
      f.mesh.visible = op > 0.01;
    }
  },

  refresh(state, level, inst) {
    // Idempotent level-up snap so the next plant fires soon at the new level.
    if (inst.cd > level.cooldown * 0.5) inst.cd = level.cooldown * 0.25;
  },

  dispose(state, inst) {
    if (!inst.fields) return;
    for (const f of inst.fields) {
      if (f.mesh && f.mesh.parent) f.mesh.parent.remove(f.mesh);
      if (f.mesh && f.mesh.material) f.mesh.material.dispose();
    }
    inst.fields = null;
  },
};
