/**
 * Echo Bolt — cave-stage weapon #2 (P4A cohort 8, 2026-05-20).
 *
 * Fires a sigil bolt at the nearest enemy every cooldown. A projectile weapon,
 * mechanically distinct from the cave's other weapon (Gloomsigil = placed DoT
 * field) and from frostbloom (hero pulse) / orbitals (orbit) / sigilbell
 * (timed mine). Closes the P4A "2 cave weapons" acceptance item.
 *
 * Stage-gated: `stages: ['cave']` → cave-only level-up offer (index.js
 * weaponChoices gate; carried weapons still tick anywhere).
 *
 * VFX budget (PROGRESSION_REDESIGN §2.1): NO new pool. Reuses autoAim's
 * pooled InstancedMesh projectile via the exported spawnAutoAimProjectile —
 * the central projectile tick in index.js moves/collides/damages it by the
 * `ownerWeapon: 'echobolt'` tag. The pool's bolt art is ice-cyan (no per-cast
 * color override exists, and adding one would edit shared autoAim materials),
 * so cave flavor comes from a violet slot-4 muzzle spark on the existing fx.js
 * spark pool + the weapon name/icon — not a new draw call.
 */
import { state } from '../state.js';
import { queryRadius } from '../enemies.js';
import { spawnAutoAimProjectile } from './autoAim.js';
import { spawnMagnetSpark } from '../fx.js';
import { sfx } from '../audio.js';

const SIGIL_VIOLET = 0xc87bff;   // CAVE_PALETTE.sigil (slot 4)
const SEARCH_RADIUS = 32;        // nearest-enemy query range

// Minimal nearest-enemy finder (mirrors autoAim's local helper — kept inline
// so echobolt doesn't depend on an autoAim export that isn't public).
function _nearest(pos) {
  let cand = null;
  try { cand = queryRadius(pos, SEARCH_RADIUS); } catch (_) { cand = null; }
  if (!cand || cand.length === 0) cand = state.enemies.active;
  if (!cand || cand.length === 0) return null;
  let best = null, bestD2 = Infinity;
  for (const e of cand) {
    if (!e || !e.alive) continue;
    const ep = e.mesh ? e.mesh.position : e.pos;
    if (!ep) continue;
    const dx = ep.x - pos.x, dz = ep.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

export default {
  id: 'echobolt',
  name: 'Echo Bolt',
  desc: 'Looses a sigil bolt at the nearest enemy, piercing through the cave dark',
  icon: '⚡',
  stages: ['cave'],            // cave-only level-up offer
  maxLevel: 8,
  levels: [
    { cooldown: 1.30, speed: 17, ttl: 1.1, pierce: 1, dmg: 7  },
    { cooldown: 1.20, speed: 18, ttl: 1.1, pierce: 1, dmg: 10 },
    { cooldown: 1.10, speed: 19, ttl: 1.2, pierce: 2, dmg: 13 },
    { cooldown: 1.00, speed: 20, ttl: 1.2, pierce: 2, dmg: 17 },
    { cooldown: 0.90, speed: 21, ttl: 1.3, pierce: 3, dmg: 21 },
    { cooldown: 0.80, speed: 22, ttl: 1.3, pierce: 3, dmg: 26 },
    { cooldown: 0.70, speed: 23, ttl: 1.4, pierce: 4, dmg: 31 },
    { cooldown: 0.60, speed: 24, ttl: 1.5, pierce: 4, dmg: 37 },
  ],

  init(state, level, inst) {
    inst.cd = 0;   // fire on first tick when an enemy is present
  },

  tick(state, dt, level, inst) {
    if (inst.cd === undefined) inst.cd = 0;
    inst.cd -= dt;
    if (inst.cd > 0) return;

    const hero = state.hero.pos;
    const target = _nearest(hero);
    if (!target) { inst.cd = 0.15; return; }   // no target: short retry, no fire
    const tp = target.mesh ? target.mesh.position : target.pos;
    const dx = tp.x - hero.x, dz = tp.z - hero.z;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { x: dx / len, z: dz / len };

    const dmg = level.dmg * (state.hero.statMul.dmg || 1);
    spawnAutoAimProjectile(hero, dir, level, dmg, 1, 0, 'echobolt', null);

    // Cave-violet muzzle spark (reuses the fx.js spark pool — no new draw).
    if (!state._optReduceMotion) {
      spawnMagnetSpark(hero.x + dir.x * 0.8, 0.6, hero.z + dir.z * 0.8, SIGIL_VIOLET);
    }
    try { sfx.weaponAutoaim && sfx.weaponAutoaim(); } catch (_) {}

    inst.cd = level.cooldown * (state.hero.statMul.cooldown || 1) * (state.run.passive_cooldown || 1);
  },

  refresh(state, level, inst) {
    if (inst.cd === undefined || inst.cd > level.cooldown) inst.cd = level.cooldown * 0.25;
  },
};
