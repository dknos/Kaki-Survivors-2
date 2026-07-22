/**
 * Bullet-hell mode run state. Module-owned (not on state.js) so the mode is
 * fully self-contained — survivors-mode systems never read or write this.
 * resetBh() is called on every mode entry.
 */
// The whole bullet-hell theater lives far from the overworld origin so
// leftover boot decor (env props, candles, stumps) can't bleed into frame.
export const ARENA_CX = 480;
export const ARENA_CZ = 480;
// Arena radius — single source of truth. Was duplicated as literals in
// index.js / foes.js / bullets.js; bullets despawn at ARENA_R + margin.
export const ARENA_R = 24;

export const bh = {
  active: false,
  wave: 0,
  foesAlive: 0,
  // Between-wave item phase: item pedestal(s) up, next wave waits for pickup.
  itemPending: null,          // {choices:[{def,mesh,gem,ring}]} while pedestals are up
  waveDelay: 0,               // countdown to next wave spawn
  waveElapsed: 0,             // seconds since current wave spawned (reinforcements)
  bombReady: true,            // Thunder Purr rearm gate (rearms each wave)
  bombFlash: 0,               // white-out timer after a bomb pop (rendered by index.js HUD)
  taken: [],                  // item defs picked up this run (HUD strip)
  grazeMeter: 0,              // 0..1 — near-misses fill it; full = +1 bomb charge
  grazeCount: 0,              // lifetime grazes this run (death-screen flavor)
  boss: null,                 // live boss foe ref while a boss is on the field
  bossName: '',               // display name for the boss HP bar
  level: 0,                   // current biome index (0..LEVELS-1); index.js owns transitions
  // Campaign gate (Level-3 → Level-4): { maxWave, unlockFlag, label } when this
  // BH entry is a bounded chapter gate rather than the endless menu mode. null =
  // endless (menu/start-screen direct play). Set via enterBulletHell's param.
  campaign: null,
  won: false,                 // set by _campaignWin — freezes the wave machine
  // Per-wave DANGER scaling (speed/rate, not hp sponging) — set by _spawnWave.
  mods: null,
  stats: null,                // reset below
  // Internal wave-machine bookkeeping (index.js owns these).
  _itemSpawnedForWave: 0,     // last wave an item pedestal was spawned for
  _lastWaveWasBoss: false,    // boss clears earn a 3-way item CHOICE
  // Snapshot of hero fields the mode mutates, restored on exit.
  _heroSnap: null,
};

export function resetBh() {
  bh.active = true;
  bh.wave = 0;
  bh.foesAlive = 0;
  bh.itemPending = null;
  bh.waveDelay = 1.5;
  bh.waveElapsed = 0;
  bh.bombReady = true;
  bh.bombFlash = 0;
  bh.taken = [];
  bh.grazeMeter = 0;
  bh.grazeCount = 0;
  bh.boss = null;
  bh.bossName = '';
  bh.level = 0;               // biome resets to ASTRAL SANCTUM on entry
  bh.campaign = null;         // enterBulletHell re-applies from its param after this
  bh.won = false;
  bh.mods = {
    bulletSpeedMul: 1,       // +4%/wave — later waves get FASTER, not spongier
    emitRateMul: 1,          // emitter cooldowns divide by this
  };
  bh._itemSpawnedForWave = 0;
  bh._lastWaveWasBoss = false;
  bh.stats = {
    dmg: 10,             // player shot damage
    fireRate: 4,         // shots per second
    shotCount: 1,        // projectiles per volley
    shotSpeed: 26,
    shotRange: 24,       // seconds-equivalent handled via ttl in shots.js
    pierce: 0,           // extra foes a shot passes through
    homing: 0,           // steer strength (0 = off)
    critChance: 0,       // Lucky Bell
    hitR: 0.34,          // hero bullet hitbox radius (Velvet Hitbox shrinks)
    grazeR: 1.2,         // graze ring radius — near-miss reward zone
    bulletDmg: 12,       // damage an enemy bullet deals to hero (+1 per 2 waves)
    bombCharges: 0,      // Thunder Purr / Static Charge / full graze meter
  };
}
