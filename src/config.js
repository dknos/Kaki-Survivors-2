/**
 * All gameplay tunables. Modules import from here — no magic numbers in code.
 */

export const WORLD = {
  cameraDistance: 28,       // ortho frustum half-height baseline
  cameraLerp: 0.10,         // 0..1, higher = snappier follow
  groundSize: 2400,         // forest plane edge length
  fogNear: 90,
  fogFar: 320,
  bgColor: 0x061008,
};

export const HERO = {
  glb: 'tower-castle-plain.glb',  // donor model from original game (uncompressed copy)
  targetHeight: 3.6,        // auto-fit: scale = targetHeight / bbox.y. Re-exports w/ different units survive.
  scale: 1.0,               // optional multiplier on top of auto-fit, for art tuning
  speed: 8.0,               // units/sec
  hpMax: 100,
  iFramesSec: 0.40,
  pickupRadius: 1.6,        // gem magnet base radius — walk-onto-it close range, magnet powerups scale it (iter 33c)
  contactPushback: 0.5,     // hero gets nudged on enemy contact
  yOffset: 0,
};

export const DAMAGE = {
  variance: 0.20,           // ±20% roll on every hit
  critChance: 0.08,         // 8% chance to crit
  critMul: 2.0,             // crit × 2 damage
};

export const JUMP = {
  velocity: 9.0,          // initial upward velocity (units/sec)
  gravity: -28.0,         // applied while airborne
  groundY: 0,
  coyoteTimeSec: 0.08,    // small grace window after leaving ground
};

export const DASH = {
  // Iter 2 — dash ranks up automatically at these HERO levels (no more dash
  // cards diluting the draft; weapons/index.js drops it from FILLERS).
  autoRankLevels: [5, 9, 13, 17],
  // Perfect dodge: an enemy hit absorbed by dash i-frames triggers a damage
  // pulse — dodging through attacks is the skill expression, reward it.
  perfectDodge: { pulseSec: 1.5, dmgMul: 1.3 },
  // Levels stack: each pick of the 'dash' filler increments dashLevel.
  // Level 0 = locked; level 1 = unlocked; higher = better stats.
  levels: [
    null,
    { duration: 0.22, speedMul: 5.5, cooldown: 2.6, knockback: 12, radius: 3.0, dmg: 18, iFrames: 0.30 },
    { duration: 0.24, speedMul: 6.0, cooldown: 2.3, knockback: 14, radius: 3.4, dmg: 28, iFrames: 0.35 },
    { duration: 0.26, speedMul: 6.5, cooldown: 2.0, knockback: 16, radius: 3.8, dmg: 42, iFrames: 0.40 },
    { duration: 0.28, speedMul: 7.0, cooldown: 1.7, knockback: 18, radius: 4.2, dmg: 60, iFrames: 0.45 },
    { duration: 0.30, speedMul: 7.5, cooldown: 1.4, knockback: 22, radius: 4.6, dmg: 85, iFrames: 0.50 },
  ],
};

export const XP = {
  // Fun-loop iter 1.1 — slower first picks, faster late levels. base 20 /
  // growth 1.27 kills the opening level shower (was ~10 levels in 16s with
  // the old kill-rate) while gem value = 1 + floor(D/2.5) (enemies.js spawn
  // stamp; gems stay 1 XP until ~4:10) keeps late levels flowing despite the
  // flatter growth. Curve table (xpNext per level):
  //   L1→L2: 20   L2→L3: 25   L3→L4: 32   L4→L5: 41   L5→L6: 52
  //   L6→L7: 66   L7→L8: 84   L8→L9:107  L9→L10:135  L10→L11:172
  base: 20,
  growth: 1.27,
  // Past lateLevel the curve flattens to lateGrowth (state.js xpForLevel) —
  // pure 1.27^n hit ~12.7k XP per level by L28 = 90-125s level droughts in
  // the back half of the 10-min arc.
  lateLevel: 18,
  // 1.07 not 1.10: +10%/level still outran the gem-value stairstep inside
  // its plateaus (gap grew 67→98s across L28-32). Modeled with the steeper
  // gem curve: ~22-27s/level across 300-480s.
  lateGrowth: 1.07,
  gemValue: 1,              // default
  gemSize: 0.35,
  gemMagnetMaxSpeed: 42,
  gemMagnetAccel: 60,         // unused after iter 33a (direct-seek magnet)
};

// Punch List #4 (2026-05-16) — coin-paid reroll on the level-up/sigil offer
// modal. First reroll costs `firstCost`, each subsequent one adds `costRamp`
// (30 → 50 → 70 ...). Hard-capped at `capPerOffer` rerolls per offer; the
// counter resets at the top of showLevelUpModal so a fresh level-up always
// gets a clean budget (cap does NOT leak across queued levels).
export const SIGIL_REROLL = {
  firstCost:   30,
  costRamp:    20,
  capPerOffer: 3,
};

export const SPAWN = {
  // iter 33t — bumped further; user saw 16 alive at run start because hero
  // kill-rate outpaced 64/sec topup. Now 213/sec topup (32 per 0.15s tick)
  // closes the deficit before XP-rich tiers thin out.
  // iter 33z — alive cap trimmed 600 → 350. User report: 219 enemies →
  // 2.3M tris / frame / 41 FPS on a mid laptop GPU. The cap was sized for
  // a beefier machine; 350 keeps the swarm-survivor feel at <1.5M tris.
  // Fun-loop iter 1.1 — base 100 made minute 1 a 128-enemy fodder shower:
  // ~10 level-ups in the first 16s and a free AFK farm for env hazards.
  // Open at 45 alive and ramp the other +55 in over the first 90s so the
  // swarm builds instead of starting maxed.
  targetAliveBase: 45,
  targetAliveRampAdd: 55,   // extra alive lerped in over targetAliveRampSec
  targetAliveRampSec: 90,
  // 22 not 28: perD was tuned against the old 20-min curve (D=4 by 8:00).
  // The 10-min arc hits D=8 by ~8:50 — at 28/D that was a 320-body meat wall
  // L34 heroes died inside at 6:40-8:50, and nobody ever met the final boss.
  // Rebalance 2026-07 — 22 → 26: that wall predates the dash/primary buffs,
  // and sprite batching removed the 41-FPS ceiling that motivated the trim.
  // targetAliveCap 350 stays as the perf guard.
  targetAlivePerD: 26,      // alive = base + ramp + D * perD  (was 40)
  targetAliveCap: 350,
  difficultyRampSec: 60,    // D goes 0→1 over first 60s
  // Fun-loop iter 2 — run arc compressed 15:00 → 10:00 (final boss at 600s,
  // minis 150/330/480). D hits 10 at 11:00; at boss time D(600) ≈ 9.1, and
  // dragon-tier (minD 7) turns on ~7:40 — top-of-curve content inside the
  // run you actually play. Tier ladder: D(t) = 1 + (t-60)/600 * 9.
  difficultyMaxSec: 660,
  difficultyMax: 10,
  ringRadius: 22,           // spawn distance from hero (visible edge)
  ringJitter: 5,
  hordeIntervalSec: 45,
  hordeCount: 85,           // Rebalance 2026-07: 70 → 85 — hordes melted on arrival
  bossIntervalSec: 300,
  spawnBatchPerTick: 32,    // how many enemies can spawn in one director tick
  tickIntervalSec: 0.15,
  // Fun-loop iter 3 — 240s meant ~2 periodic chests per 10-min run (the 240
  // number was tuned for the dead 15-min arc). 150 lands one per arc phase:
  // ~2:30 / 5:00 / 7:30 (mini-boss + final boss drops still on top).
  chestIntervalSec: 150,    // periodic chest spawn near hero
  chestEliteDropChance: 0.03, // probability an elite drop also spawns a chest
  // Iter 33l — time-based HP/dmg ramp coefficients (iter 33d originally inlined).
  // Both ride _computeDifficulty(t) [0..10]. HP scales harder than dmg so the
  // hero doesn't get clapped by attrition while late mobs still feel tanky.
  // Rebalance 2026-07 — 0.6 → 0.85: the fun-loop buffs (auto-ranking primary,
  // 1.4s dash, chest-fed weapon levels) left late trash melting at ×6.5.
  // 0.85 takes boss-time trash to ~×8.7; D<1 keeps minute-1 ant-mow intact.
  rampHpPerD: 0.85,
  // Rebalance 2026-07 — 0.17 → 0.22: 0.17 was tuned before the dash/primary
  // buffs and left late contact at only ×2.55 base against near-permanent
  // dash i-frames. 0.22 lands ×3.0 at boss time — still under the 0.3 that
  // walled playtests. Incoming stays i-frame-gated (HERO.iFramesSec 0.40).
  rampDmgPerD: 0.22,
  // Final-boss stage-HP damping (design decision, 2026-07). The per-stage
  // enemyHpMul (forest 1.0 → void 1.85) applies to ALL enemies incl. the final
  // boss, but the boss already carries the global finalBossHpMul (×16) tuned
  // for a 25-45s TTK on forest. Stacking the stage mult on top inverted boss
  // TTK — a void boss took ~1.85× longer than a forest boss while hero DPS is
  // stage-invariant. This knob rescales the boss's stage mult:
  //   effStageHp = 1 + (stageHp - 1) * finalBossStageHpDamp
  //   0.0 = FLAT (boss ignores stage HP → same TTK every stage)  ← chosen
  //   1.0 = full per-stage scaling (legacy behavior)
  //   ~0.35 = "dampened" middle ground (void boss ~1.3×)
  // Later stages still express difficulty via tougher trash swarms + higher
  // enemy damage; only the boss sponge is normalized. Mini-bosses are NOT
  // affected (their HP feeds evolution pity pacing — separate balance surface).
  finalBossStageHpDamp: 0.0,
};

/**
 * Enemy tier table. glb keys must match preload list in assets.js.
 * spd = units/sec, dmg = per-contact damage, hp = base HP, weight = roll weight,
 * minD = minimum difficulty before this tier can appear.
 * Rebalance 2026-07 — mid-band base HP raised ~+40% (skeleton/orc/demon/slime/
 * wizard/mantis/caterpillar) against the fun-loop player DPS; ant/zombie/
 * spider/goblin left tiny — the opening mow is a design pillar. Elite minD
 * lowered (giant 6→5, dragon 7→6.2) so natural elites appear mid-run.
 */
export const ENEMY_TIERS = [
  { glb: 'zombie',    displayName: 'Mushnub', hp: 6, spd: 2.2, dmg: 4, minD: 0.0, weight: 10, scale: 0.9 },
  { glb: 'goblin',    displayName: 'Pocket Scrounger', hp: 9, spd: 2.9, dmg: 5, minD: 0.4, weight: 8, scale: 0.8 },
  { glb: 'skeleton',  displayName: 'Buttonbones', hp: 20, spd: 2.4, dmg: 6, minD: 0.9, weight: 7, scale: 0.9 },
  { glb: 'orc',       displayName: 'Apron Bruiser', hp: 40, spd: 1.9, dmg: 10, minD: 1.8, weight: 5, scale: 1.1 },
  { glb: 'demon',     displayName: 'Kiln Grin', hp: 30, spd: 2.6, dmg: 9, minD: 2.2, weight: 5, scale: 0.95 },
  { glb: 'robot',     displayName: 'Tin Clerk', hp: 50, spd: 1.7, dmg: 14, minD: 3.5, weight: 3, scale: 1.0 },
  { glb: 'mech',      displayName: 'Overtime Frame', hp: 90, spd: 1.4, dmg: 18, minD: 4.5, weight: 2, scale: 1.1 },
  { glb: 'xeno',      displayName: 'Wrong-Way Guest', hp: 65, spd: 3.0, dmg: 12, minD: 5.0, weight: 3, scale: 1.0 },
  { glb: 'slime',     displayName: 'Inkwell Leak', hp: 48, spd: 2.0, dmg: 8, minD: 1.5, weight: 4, scale: 1.0 },
  { glb: 'giant',     displayName: 'Heavy Apron Weighscale', hp: 200, spd: 1.2, dmg: 25, minD: 5.0, weight: 1, scale: 1.3, elite: true },
  { glb: 'dragon',    displayName: 'Weathered Wind Vane', hp: 400, spd: 1.2, dmg: 30, minD: 6.2, weight: 1, scale: 1.4, elite: true },
  // New animated Quaternius tiers
  { glb: 'spider',    displayName: 'Threadleg', hp: 8, spd: 4.2, dmg: 5, minD: 1.2, weight: 6, scale: 0.85 },
  { glb: 'wolf',      displayName: 'Night Route Hound', hp: 18, spd: 4.4, dmg: 7, minD: 2.0, weight: 5, scale: 1.0, faceYaw: Math.PI / 2, procAnim: 'pad' },
  // Iter 2 threat depth — fanAt/fanCount/fanSpread: at D >= fanAt the wizard
  // fires a fan instead of a single bolt; lead = fraction of hero velocity
  // aimed ahead of the hero (0.35 = lead the dodge, punish straight-line
  // running). Implemented in enemies.js ranged fire path.
  { glb: 'wizard',    displayName: 'Receipt Slinger', hp: 34, spd: 1.6, dmg: 8, minD: 0.8, weight: 5, scale: 0.95,
    ranged: { range: 14, stopAt: 10, cooldown: 2.0, projSpeed: 11, projDmg: 9, projTtl: 2.4,
              fanAt: 5, fanCount: 3, fanSpread: 0.22, lead: 0.25 } },
  { glb: 'ghost',     displayName: 'Unclaimed Lantern', hp: 35, spd: 2.4, dmg: 11, minD: 4.0, weight: 4, scale: 1.0, ghostly: true },
  // Original Blender toy enemies. They stay deliberately rare and 3D (not
  // sprite-batched): the mouse guarantees the readable Leaping grammar while
  // the wisp emits a slowly rotating five-thread ring with real dodge lanes.
  { glb: 'clockwork_mouse', displayName: 'Clockwork Mouse', family: 'toy',
    hp: 18, spd: 3.4, dmg: 7, minD: 1.4, weight: 2.5, scale: 0.82,
    procAnim: 'scurry', fixedAffix: 'leaping' },
  { glb: 'yarn_wisp', displayName: 'Yarn Wisp', family: 'toy',
    hp: 38, spd: 1.45, dmg: 8, minD: 2.6, weight: 1.8, scale: 1.0,
    procAnim: 'wisp',
    ranged: { range: 15, stopAt: 11, cooldown: 3.3, projSpeed: 7.5,
              projDmg: 6, projTtl: 3.0, kind: 'magic',
              pattern: 'ring', patternCount: 5, patternSpin: 0.37 } },
  // Previously preloaded but unused. Moonwing is a low-count late elite: the
  // animated Quaternius dragon remains 3D and fires a readable fire fan.
  { glb: 'dragon_evo', displayName: 'Moonwing', family: 'elite',
    hp: 620, spd: 1.35, dmg: 32, minD: 8.0, weight: 0.30, scale: 1.35, elite: true,
    finalBossEligible: false,
    ranged: { range: 18, stopAt: 12, cooldown: 3.2, projSpeed: 9.0,
              projDmg: 13, projTtl: 3.0, kind: 'fire',
              fanAt: 7.5, fanCount: 5, fanSpread: 0.17, lead: 0.18 } },
  // Kaki Land encounter adds. These are explicit phase spawns, never members
  // of an ambient director pool (minD:999 + weight:0). Their combat grammar
  // deliberately reuses bounded systems: Sparkmites pounce, Tidesprites weave
  // radial lanes, and Bloomlings fire a compact priority-target fan.
  { glb: 'kaki_sparkmite', displayName: 'Sparkmite', family: 'kaki',
    hp: 34, spd: 3.8, dmg: 8, minD: 999, weight: 0, scale: 0.82,
    procAnim: 'scurry', fixedAffix: 'leaping', kakiLandOnly: true },
  { glb: 'kaki_tidesprite', displayName: 'Tidesprite', family: 'kaki',
    hp: 42, spd: 1.55, dmg: 7, minD: 999, weight: 0, scale: 0.92,
    procAnim: 'wisp', kakiLandOnly: true,
    ranged: { range: 15, stopAt: 10.5, cooldown: 3.1, projSpeed: 7.8,
              projDmg: 7, projTtl: 3.0, kind: 'ice',
              pattern: 'ring', patternCount: 5, patternSpin: 0.31 } },
  { glb: 'kaki_bloomling', displayName: 'Bloomling', family: 'kaki',
    hp: 48, spd: 1.4, dmg: 8, minD: 999, weight: 0, scale: 0.94,
    procAnim: 'hover', kakiLandOnly: true,
    ranged: { range: 14, stopAt: 9.5, cooldown: 2.7, projSpeed: 9.0,
              projDmg: 8, projTtl: 2.5, kind: 'magic',
              fanAt: 0, fanCount: 3, fanSpread: 0.24, lead: 0.12 } },
  // ── Forest bugs (CC-BY Poly by Google + CC0 Quaternius) ──
  // procAnim drives a procedural body anim if the GLB has no clip:
  //   'crawl' = side-to-side body wiggle (legs implied)
  //   'flap'  = wing-like Z rotation + bob (butterfly)
  //   'hover' = small bob + rapid jitter (bee/wasp)
  //   'hop'   = vertical bounce (grasshopper)
  //   'inch'  = slow accordion squash (caterpillar)
  //   'pad'   = quadruped padding gait (wolf/dog): vertical bob + shoulder roll
  { glb: 'ant',         hp: 5,   spd: 3.8, dmg: 4,  minD: 0.0, weight: 14, scale: 0.55, family: 'bug', procAnim: 'crawl' },
  { glb: 'beetle',      hp: 14,  spd: 1.9, dmg: 5,  minD: 0.3, weight: 10, scale: 0.75, family: 'bug', procAnim: 'crawl' },
  { glb: 'ladybug',     hp: 10,  spd: 2.4, dmg: 5,  minD: 0.5, weight: 8,  scale: 0.65, family: 'bug', procAnim: 'crawl' },
  { glb: 'grasshopper', hp: 12,  spd: 4.4, dmg: 6,  minD: 1.0, weight: 7,  scale: 0.70, family: 'bug', procAnim: 'hop', faceYaw: -Math.PI / 2 },
  { glb: 'butterfly',   hp: 8,   spd: 2.6, dmg: 4,  minD: 0.8, weight: 6,  scale: 0.75, family: 'bug', procAnim: 'flap' },
  // Iter 2.1 — bee stays a MELEE chaser. The ranged block turned it into a
  // stopAt turret at minute 2: it stopped bodying stationary players (face-
  // tank survival regressed 25s → 80s) while stacking onto the minute-2-4
  // projectile pile-up. Wasp keeps the stinger but arrives later (minD 3.2).
  { glb: 'bee',         hp: 14,  spd: 2.8, dmg: 7,  minD: 1.5, weight: 6,  scale: 0.60, family: 'bug', procAnim: 'hover', faceYaw: -Math.PI / 2 },
  { glb: 'cockroach',   hp: 8,   spd: 4.8, dmg: 5,  minD: 1.3, weight: 7,  scale: 0.55, family: 'bug', procAnim: 'crawl' },
  { glb: 'wasp',        hp: 18,  spd: 2.8, dmg: 9,  minD: 3.2, weight: 5,  scale: 0.70, family: 'bug', procAnim: 'hover', faceYaw: -Math.PI / 2,
    ranged: { range: 12, stopAt: 8, cooldown: 2.2, projSpeed: 10, projDmg: 8, projTtl: 2.0, kind: 'fire' } },
  { glb: 'caterpillar', hp: 85,  spd: 1.0, dmg: 10, minD: 2.5, weight: 3,  scale: 0.90, family: 'bug', procAnim: 'inch' },
  { glb: 'mantis',      hp: 65,  spd: 2.0, dmg: 12, minD: 3.0, weight: 4,  scale: 1.00, family: 'bug', procAnim: 'crawl' },
  // ── KayKit skeletons (CC0) — fully rigged, clips spliced from the shared
  // Rig_Medium banks (see assets.getSkeletonClips). minD:999 + weight:0 keep
  // them OUT of the natural spawnDirector roster; they are spawned explicitly
  // by catacomb.js (dungeon wave mobs + a captain elite). Lazy-loaded via
  // assets.preloadDungeonKit on catacomb entry. dungeon:true is a marker for
  // catacomb's pool filter. faceYaw 0 — bipedal KayKit chars face +Z.
  { glb: 'skel_minion',  hp: 12, spd: 2.7, dmg: 6,  minD: 999, weight: 0, scale: 0.95, dungeon: true },
  { glb: 'skel_rogue',   hp: 16, spd: 3.3, dmg: 8,  minD: 999, weight: 0, scale: 0.95, dungeon: true },
  { glb: 'skel_mage',    hp: 22, spd: 1.7, dmg: 8,  minD: 999, weight: 0, scale: 1.00, dungeon: true,
    ranged: { range: 13, stopAt: 9, cooldown: 2.6, projSpeed: 9, projDmg: 8, projTtl: 2.4 } },
  { glb: 'skel_warrior', hp: 90, spd: 2.0, dmg: 14, minD: 999, weight: 0, scale: 1.15, dungeon: true, elite: true },
];

/**
 * Nemesis Elite (C3) — Butcher-style hunter that spawns OUTSIDE the standard
 * wave system. Intentionally exported as a sibling constant, NOT added to
 * ENEMY_TIERS — the spawnDirector tier filters (allowedTiers / elite pool /
 * final-boss reduce) would otherwise eat this row and break the contract
 * ("ignores standard wave-spawning logic"). Only spawnDirector.spawnNemesis
 * and enemies.killEnemy (via isNemesis branch) ever reference it.
 *
 * `spd` is absolute units/sec like every ENEMY_TIERS row. ~1.5× a baseline
 * mob (zombie 2.2, skeleton 2.4, mid pack ~2.6) → 4.0 reads as "faster than
 * anything else in the swarm but still dodgeable by a clean dash".
 *
 * `hp` here is the BASELINE — spawnDirector multiplies by the current
 * difficulty ramp + stage HP mul at spawn time so late-game nemesis HP scales
 * with the rest of the swarm. ~8-10× a robust mid-tier (orc 28, robot 50,
 * mech 90) → 800 baseline. At t=15:00 D≈7.6, that's 800×(1+0.6·7.6) ≈ 4448
 * raw HP (Cinder 1.6× → ~7100), enough that the player has to commit a
 * volley but not so much that a focused signature run can't burst it.
 *
 * `glowColor` is the bloom-tagged red core inset in the obsidian body. Mesh
 * builder lives in enemies.js (spawnNemesisMesh) so flash mats + procedural
 * geometry stay co-located with the other procedural enemy meshes.
 */
export const NEMESIS_TIER = {
  glb: '__nemesis__',         // sentinel; mesh is procedural, never loaded
  hp: 800,                    // baseline; difficulty + stage mults applied at spawn
  spd: 4.0,                   // absolute units/sec. 1.5× a baseline mob.
  dmg: 22,                    // 1.5× a robust mid-tier contact dmg
  scale: 1.4,                 // 1.4× visual silhouette (taller, broader)
  radius: 0.7,                // contact radius hint (current contact pipeline is flat)
  color: 0x222226,            // obsidian body
  glowColor: 0xff2020,        // red eye/core (bloom-layer tagged)
  xp: 50,                     // chunky gem on kill
  isElite: true,              // metadata; spawn director keys off isNemesis flag, not this
};

/**
 * Spawn cadence (sec) for the Nemesis Elite.
 *
 * Punch List #2 (2026-05-16) — Nemesis Tease + meta-gate:
 *   - Game has no explicit "wave N" clock; we synthesise one as
 *     wave * waveSec seconds of game time (60s/wave, standard
 *     survivors-style convention). Wave 8 = 480s, which lines up with
 *     STAGE.miniBossSchedule[1] = 480 — the second mini-boss beat.
 *   - At telegraphWave (wave 7 = 420s) the director fires an arrow + banner
 *     telegraph for ALL players (newbies AND vets) so the mechanic is
 *     taught even when no spawn follows.
 *   - At wave (wave 8 = 480s) the actual Nemesis spawns ONLY if
 *     meta.unlockFlags.finalBossWin === true (first-victory meta gate).
 *     New players see tension build for free; veterans get the hunter.
 *   - respawn cadence ([respawn.min, respawn.max] measured from kill time)
 *     is unchanged.
 *   - Single-active rule preserved: if a nemesis is still alive when the
 *     timer fires, the tick is skipped (no doubling up).
 */
export const NEMESIS_SPAWN = {
  // Wave-based first spawn (Punch List #2). wave * waveSec → seconds.
  wave: 8,                    // first spawn fires at game-time wave * waveSec
  telegraphWave: 7,           // arrow + banner fires one wave earlier
  waveSec: 60,                // seconds per synthetic "wave"
  arrowLifetimeSec: 60,       // directional arrow visible 60s or until spawn
  // Post-kill respawn cadence (unchanged from C3).
  respawnMinSec: 120,
  respawnJitterSec: 60,       // post-kill ∈ [120, 180]
  spawnRadius: 50,            // distance from hero (well off-screen)
};

/** Initial roster size pre-warmed per pool to hide first-horde stall. */
export const POOL_PREWARM = {
  // iter 33y — trimmed ~40% from iter 33t. Pools auto-grow on miss (one-shot
  // clone stall) so prewarm only needs to cover the first ~30 seconds of
  // spawns, not the whole run cap. The old prewarm carried ~870 cloned
  // meshes — a big chunk of resident JS + GPU memory even before play.
  zombie: 40, goblin: 40, skeleton: 30, orc: 20, demon: 20,
  robot: 14, mech: 8,  xeno: 14, slime: 18, giant: 3, dragon: 2,
  spider: 28, wolf: 22, wizard: 14, ghost: 14,
  clockwork_mouse: 6, yarn_wisp: 5, dragon_evo: 1,
  // Low-count Kaki intermission adds. Boss GLBs are singleton clones and do
  // not need a resident pool; these three can overlap in Sovereign phases.
  kaki_sparkmite: 6, kaki_tidesprite: 6, kaki_bloomling: 6,
  // Forest bugs — primary forest tier, still highest counts but trimmed.
  ant: 60, beetle: 36, ladybug: 30, grasshopper: 24, butterfly: 18,
  bee: 18, cockroach: 24, wasp: 14, caterpillar: 8, mantis: 8,
};

export const SPATIAL = {
  cellSize: 6,              // SpatialHash cell edge
};

export const WEAPONS = {
  startingWeapon: 'orbitals',
  maxSlots: 6,
  maxPassives: 6,
};

// ── Daily Challenge rewards (Punch List #6, 2026-05-16) ────────────────────
// Daily wins pay a flat 2.5× coin multiplier on top of the existing
// (Hyper × Vault × greed) chain — applied multiplicatively in
// meta.commitRunResults() so the daily-only branch composes cleanly without
// touching the additive greedMul stack. Loss/abandon runs get NO multiplier.
// The cosmetic "Daily Survivor" badge unlocks on the first daily win and
// persists in meta.badges; it has no mechanical effect anywhere in the game
// (purely a start-screen pip + death-screen banner).
export const DAILY_REWARD_MULT = 2.5;
export const DAILY_SURVIVOR_BADGE_ID = 'daily_survivor';

// Playable characters — each overrides starting weapon + a few base stats.
// `id` is the persistent identifier; `unlock` is null for default or an
// achievement id / 'sigils:N' / 'flag:fieldName' for gated characters.
//
// Each character also defines a `signature(runState)` function that stamps
// a `runState.signature_*` flag (or sets `passive_*` for the iter-6 SHOP_TREE
// interop). Readers live in hero.js / enemies.js / weapons/*.js (iter 7b).
// Tuning constants are locked in ITER_789_BRIEFS.md (iter 7 — Tuning targets).
export const CHARACTERS = [
  {
    // Iter 32: archetype id kept as 'kitty' for save-compat, but display
    // name is "Balanced" — the avatar named "Kitty Kaki" is a separate concept.
    id: 'kitty',  name: 'Balanced',   icon: '🍔',
    desc: 'Default kit. Starts with Cheesy Burgers.',
    starter: 'orbitals',
    statMul: { dmg: 1.0, moveSpeed: 1.0, magnet: 1.0 },
    hpMax: 100,
    unlock: null,
    tint: 0xffffff, scaleMul: 1.00,
    signatureName: 'Nine Lives',
    signatureDesc: 'First lethal hit per run becomes 1 HP + 1.5s i-frame.',
    // Use `if (!passive_revives)` (NOT +=) so we don't stack with SHOP_TREE
    // Second Wind / Phoenix. Risk flag called out in iter-7 brief. The
    // signature_* flag is the dedicated reader path (hero.js) and is
    // idempotent regardless of SHOP_TREE ownership.
    signature: (runState) => {
      if (!runState.passive_revives) runState.passive_revives = 1;
      runState.signature_nineLives = true;
    },
  },
  {
    id: 'boom',   name: 'Boom',       icon: '⚡',
    desc: 'Glass cannon. Starts with Chain Lightning. +20% damage, -25% HP.',
    starter: 'chain',
    statMul: { dmg: 1.20, moveSpeed: 1.0, magnet: 1.0 },
    hpMax: 75,
    unlock: 'first_jackpot',
    tint: 0xff7a3a, scaleMul: 0.92,    // placeholder: orange-red, smaller silhouette
    signatureName: 'Charged Coil',
    signatureDesc: 'Every 5th Chain Lightning arc triggers a free re-cast.',
    signature: (runState) => {
      runState.signature_chainEcho = true;
      runState.signature_chainEchoCounter = 0;
    },
  },
  {
    id: 'webspinner', name: 'Webspinner', icon: '🕷️',
    desc: 'Trapper. Starts with Sticky Web. +30% pickup radius, slower.',
    starter: 'web',
    statMul: { dmg: 1.0, moveSpeed: 0.88, magnet: 1.30 },
    hpMax: 110,
    unlock: 'minibox_x3',
    tint: 0xa066ff, scaleMul: 1.08,    // placeholder: violet, chunkier
    signatureName: 'Lingering Silk',
    signatureDesc: 'Heal 0.5 HP/s while standing inside any of your webs.',
    signature: (runState) => {
      runState.signature_webHeal = 0.5;
    },
  },
  {
    id: 'sniper', name: 'Sniper',      icon: '🎯',
    desc: 'Precise. Starts with Magic Missile. +35% projectile speed, +10% damage.',
    starter: 'autoaim',
    statMul: { dmg: 1.10, moveSpeed: 1.0, magnet: 1.0, projSpeed: 1.35 },
    hpMax: 95,
    unlock: 'first_victory',
    tint: 0x66ddaa, scaleMul: 0.96,    // placeholder: pale green, slim
    signatureName: 'Headhunter',
    signatureDesc: '×3 dmg above 80% HP, ×0.7 below 20%. Reward openers.',
    signature: (runState) => {
      runState.signature_executeBonus = true;
    },
  },
  {
    // Burst-identity character: dies LOUDLY. One free 200-dmg shockwave on
    // death — the inverse of Clockwork's slow-burn scaling. Glass cannon
    // build, slight dmg edge, low HP, warm-red phoenix tint.
    id: 'phoenix', name: 'Phoenix Vow', icon: '🪶',
    desc: 'Burns hot. +15% damage, low HP. Dies in a 200-dmg shockwave.',
    starter: 'autoaim',
    statMul: { dmg: 1.15, moveSpeed: 1.05, magnet: 1.0 },
    hpMax: 80,
    unlock: 'sigils:30',
    tint: 0xff6655, scaleMul: 0.94,    // ember-red, slightly slimmer
    signatureName: 'Ember Burst',
    signatureDesc: 'On dying, emit a 10u shockwave: 200 dmg + 0.5s knockback.',
    signature: (runState) => {
      runState.signature_emberBurst = true;
    },
  },
  {
    // Late-game scaling identity: deliberately under-tuned early so the
    // 0.00375/s tempo accumulator (cap +60% at 2:40) reads as a real arc.
    // The mirror of Phoenix — payoff for not-dying instead of dying-loud.
    id: 'clockwork', name: 'Clockwork', icon: '⚙️',
    desc: 'Slow start, late payoff. +3% damage every 8s (max +60% at 2:40).',
    starter: 'orbitals',
    statMul: { dmg: 0.90, moveSpeed: 1.0, magnet: 1.0 },
    hpMax: 95,
    unlock: 'flag:unlockedClockwork',
    tint: 0xc89858, scaleMul: 1.00,    // brass cog
    signatureName: 'Tempo',
    signatureDesc: '+3% all damage every 8s of run-time (cap +60% at 2:40).',
    signature: (runState) => {
      // ratePerSec * t, capped. 0.00375/s = +3% / 8s. 0.60 cap reached at 160s.
      runState.signature_tempo = { ratePerSec: 0.00375, cap: 0.60 };
      runState.signature_tempoBonus = 0;
    },
  },
];

/**
 * Avatars — visual character identity, independent of gameplay archetype.
 * Iter 32 split: CHARACTERS (above) now exclusively means archetype/profile
 * (starter weapon, stat multipliers, signature). AVATARS defines which mesh
 * + tint renders for the hero. The start screen presents both pickers:
 * carousel for avatar, chip row for archetype.
 *
 * `glb` field is optional — null/undefined means use the shared HERO.glb
 * donor model with optional tint. When set, preloadAll registers it as
 * `hero_${id}` and hero.js pulls that key.
 */
// Iter 34 — Phase C (progression redesign): each avatar carries its own
// gameplay identity. `baseArchetype` points to a CHARACTERS row whose
// statMul/hpMax/starter/signature get applied at run start; the original
// 6 archetypes (Balanced / Boom / Webspinner / Sniper / Phoenix / Clockwork)
// are mapped onto the avatars they "absorb" per docs/PROGRESSION_REDESIGN.md
// §5.C. `signatureWeapon` is the bespoke weapon id assigned to the avatar
// — until Phase D/F lands the module, it falls back to baseArchetype.starter.
// `unlock` follows the same shape as CHARACTERS.unlock (null = free; an
// achievement id, 'sigils:N', or 'flag:fieldName').
export const AVATARS = [
  {
    id: 'kitty', name: 'Kitty Kaki', icon: '🐱',
    desc: 'The original. Plush, pink-eared, ready for mayhem.',
    glb: null,                          // donor model (tower-castle-plain)
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced (Nine Lives + orbitals)
    signatureWeapon: 'sig_kitty_lucky_paw',
    unlock: null,
  },
  {
    id: 'sote',  name: 'Sote',       icon: '🐺',
    desc: 'Heavy-built Rodin-baked silhouette. Same gameplay, new look.',
    glb: 'sote.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; bespoke kit lands in Phase F
    signatureWeapon: 'sig_sote_warhowl',
    unlock: null,                       // STARTER per Phase B
  },
  {
    id: 'cowboy', name: 'CowboyKaki', icon: '🤠',
    desc: 'Spurs, brim, and a slow draw. Same kitty, frontier loadout.',
    glb: 'cowboykaki.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'sniper',            // Headhunter + autoaim
    signatureWeapon: 'sig_cowboy_sixshooter',
    unlock: null,                       // STARTER per Phase B
  },
  {
    id: 'pipes', name: 'Pipes', icon: '🥸',
    desc: 'Team-lead avatar. Mustache, red shirt, runs the room.',
    glb: 'pipes.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'boom',              // Charged Coil + chain lightning
    signatureWeapon: 'sig_pipes_arcwrench',
    unlock: 'flag:pipes',
  },
  {
    id: 'bomdia', name: 'Bom Dia', icon: '☀️',
    desc: 'Bom Dia — green twin-tails, idol energy at sunrise.',
    glb: 'bomdia.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'clockwork',         // Tempo + orbitals (absorbs Clockwork)
    signatureWeapon: 'sig_bomdia_sunburst',
    unlock: 'flag:bomdia',
  },
  {
    id: 'mothman', name: 'Mothman', icon: '🦋',
    desc: 'Mothman — pink-winged cryptid, eyes like brake lights.',
    glb: 'mothman.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'webspinner',        // Lingering Silk + web
    signatureWeapon: 'sig_mothman_dustcloak',
    unlock: 'flag:mothman',
  },
  {
    id: 'camper', name: 'Camper', icon: '⛺',
    desc: 'Camper — blue pigtails, bedroll, never lost in the woods.',
    glb: 'camper.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'phoenix',           // Ember Burst + autoaim (absorbs Phoenix)
    signatureWeapon: 'sig_camper_signalfire',
    unlock: 'flag:camper',
  },
  {
    id: 'space', name: 'Space Kitty', icon: '🚀',
    desc: 'Space Kitty — vacuum-rated whiskers, zero-G stride.',
    glb: 'spacekitty.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; orbital sat kit lands Phase D
    signatureWeapon: 'sig_space_satellites',
    unlock: 'flag:space',
  },
  {
    id: 'radcat', name: 'Radcat', icon: '☢️',
    desc: 'Geiger-line stray. Oil-slick coat, cyan spine piping, dosimeter eyes.',
    glb: 'radcat.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; DoT zone kit lands Phase F
    signatureWeapon: 'sig_radcat_fallout',
    unlock: 'flag:radcat',
  },
  {
    id: 'mona', name: 'Mona', icon: '🎨',
    desc: 'Painted, not born. Madonna della Falena — the paint moved.',
    glb: 'mona.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; paint AoE kit lands Phase F
    signatureWeapon: 'sig_mona_brushstroke',
    unlock: 'flag:mona',
  },
  {
    id: 'bezelbug', name: 'BezelBug', icon: '💎',
    desc: 'BezelBug — gem-encrusted exoskeleton, rivet-set wings.',
    glb: 'bezelbug.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; gem-shard kit lands Phase F
    signatureWeapon: 'sig_bezelbug_facet',
    unlock: 'flag:bezelbug',
  },
  {
    id: 'rocker', name: 'RockerKaki', icon: '🎸',
    desc: 'RockerKaki — leathers, hair-spray halo, amp turned to eleven.',
    glb: 'rockerkaki.glb',
    tint: 0xffffff, scaleMul: 1.00,
    baseArchetype: 'kitty',             // Balanced base; sonic-wave kit lands Phase F
    signatureWeapon: 'sig_rocker_powerchord',
    unlock: 'flag:rocker',
  },
  {
    id: 'borgirboss', name: 'BorgirBoss', icon: '🍔',
    desc: 'BorgirBoss — burger dump truck hauling a rack of rocket launchers.',
    glb: 'borgirboss.glb',
    tint: 0xffffff, scaleMul: 1.15,
    baseArchetype: 'boom',              // big silhouette + signature ranged barrage
    signatureWeapon: 'sig_borgirboss_rocketrack',
    // Hardest avatar in the roster — only unlocks after sweeping every boss
    // on the hypermode difficulty modifier. Flag set in commitRunResults.
    unlock: 'flag:allBossesHypermode',
  },
  // PHASE 4 P4F (2026-05-18, #144) — Forest-achievement-gated hidden roster.
  // Three avatars whose `unlock` field carries a forestAchievements.js id.
  // The hook in forestAchievements.js#unlockAchievement scans AVATARS for any
  // entry whose `unlock` equals the just-fired id, then calls
  // unlockAvatar(av.id, 'achievement:' + id). The 'achievement:' source prefix
  // triggers the unlock-toast banner.
  //
  // Glbs reuse the donor kitty model with a unique tint per char (no asset
  // pipeline change). 8-color forest palette tints picked for visual distinction
  // (rune=cyan/teal, mire=swamp green, shroud=violet/death).
  {
    id: 'rune_kitten', name: 'Rune Kitten', icon: '🔷',
    desc: 'Rune Kitten — sigil-etched fur, never struck in battle.',
    glb: null,                          // donor kitty model + tint
    tint: 0x7fffe4, scaleMul: 1.00,     // cyan/teal — slot reserved for rune-blue
    baseArchetype: 'kitty',             // Balanced base
    signatureWeapon: 'sig_kitty_lucky_paw',
    unlock: 'no_hit_clear',             // forest achievement id (NOT 'flag:' form)
  },
  {
    id: 'mire_kitten', name: 'Mire Kitten', icon: '🟢',
    desc: 'Mire Kitten — spore-veiled, reads every ring before it pops.',
    glb: null,
    tint: 0x4a7a4a, scaleMul: 1.00,     // forest-green (slot-2 spore puff)
    baseArchetype: 'kitty',
    signatureWeapon: 'sig_kitty_lucky_paw',
    unlock: 'rings_dodged_100',
  },
  {
    id: 'shroud_kitten', name: 'Shroud Kitten', icon: '🟣',
    desc: 'Shroud Kitten — Reaper-marked, the scythe passed and never returned.',
    glb: null,
    tint: 0x6a4a8a, scaleMul: 1.00,     // void-purple (matches Catacomb stage tint)
    baseArchetype: 'kitty',
    signatureWeapon: 'sig_kitty_lucky_paw',
    unlock: 'reaper_outlasted',         // existing achievement, fires at 35:00
  },
];

// ── MaoMao's Daycare outfits ───────────────────────────────────────────────
// Caring/playing with MaoMao fills a Happiness meter; each threshold
// unlocks a wearable. Equipping one grants a small run buff (applied in
// main.js applyMetaUpgrades, non-leaderboard runs only). The buff descriptor
// is explicit about additive vs multiplicative so the applier can't muddle
// them: `statMul` → h.statMul[stat] *= mul; `hpMax` → h.hpMax += add.
// `buff: null` is allowed — a cosmetic-only outfit ("certain clothes give
// buffs", not all). `unlockAt` is a happiness threshold (0–100). `sprite` is a
// Grok-generated MaoMao-wearing-it portrait (daycare.js swaps the whole cat image
// on equip so the outfit is actually WORN, not a floating badge); omit it for a
// cosmetic with no art and the daycare falls back to the plain portrait.
export const DAYCARE_OUTFITS = [
  { id: 'beanie', name: 'Cozy Beanie', icon: '🧶', unlockAt: 25,
    sprite: 'assets/sprites/momo_beanie.webp',
    buffLabel: '+4% Move Speed', buff: { type: 'statMul', stat: 'moveSpeed', mul: 1.04 } },
  { id: 'scarf',  name: 'Snug Scarf',  icon: '🧣', unlockAt: 55,
    sprite: 'assets/sprites/momo_scarf.webp',
    buffLabel: '+15 Max HP',     buff: { type: 'hpMax', add: 15 } },
  { id: 'crown',  name: 'Royal Crown', icon: '👑', unlockAt: 90,
    sprite: 'assets/sprites/momo_crown.webp',
    buffLabel: '+4% Damage',     buff: { type: 'statMul', stat: 'dmg', mul: 1.04 } },
  { id: 'moonbell', name: 'Moonbell Collar', icon: '🌙', unlockAt: null,
    unlockLabel: 'Clear the Catacomb', sprite: 'assets/sprites/maomao_moonbell.webp',
    buffLabel: '+8% Pickup Reach', buff: { type: 'statMul', stat: 'magnet', mul: 1.08 } },
];

/**
 * Avatar→archetype apply helper. Reads CHARACTERS row that the avatar's
 * baseArchetype points at, then returns its statMul/hpMax/starter/signature
 * fields composed onto a fresh object. Phase C uses this to remove the
 * "two-axis selection" UI: only the avatar is chosen, gameplay derives.
 *
 * Phase D/F will replace `baseArchetype` lookups with the avatar's own
 * bespoke fields. Until then this shim keeps existing archetype signatures
 * (Nine Lives, Headhunter, Tempo, etc.) intact while the kit registry fills.
 */
export function archetypeForAvatar(avatar) {
  if (!avatar) return CHARACTERS[0];
  const arch = CHARACTERS.find(c => c.id === avatar.baseArchetype);
  return arch || CHARACTERS[0];
}

/**
 * Selectable stages. Stage 1 is the default; Stage 2 unlocks on first victory
 * (shares the `unlockedHyper` flag — same trigger). Each stage tweaks the
 * difficulty curve and re-tints the ground for biome flavor without needing
 * a full asset swap.
 */
export const STAGES = [
  {
    id: 'forest', name: 'Felt Switchback',
    desc: 'A moss-soft route held together by gold stitches. The postal desk is still open, technically.',
    enemyHpMul: 1.0,
    finalBossAt: 600,           // 10:00 (default — iter 2 arc compression)
    groundTint: 0xffffff,       // base — no recolor
    fogColor: null,             // default world fog
    unlock: null,
  },
  {
    id: 'twilight', name: 'Paper Woods',
    desc: 'Damp maps grow from quiet trees. Paths fold when nobody is looking.',
    enemyHpMul: 1.30,
    finalBossAt: 540,           // 9:00 — final boss arrives 1 min sooner
    // Real PBR swap: ground uses brown_mud (Poly Haven CC0). Slight cool
    // desaturation on top so the mood reads as twilight, not midday.
    groundTint: 0xb6bccc,
    fogColor: 0x0a1a22,
    unlock: 'unlockedHyper',    // first victory
  },
  {
    id: 'cinder', name: 'Ceramic Basin',
    desc: 'Fired-clay undercaves where chipped cups keep the heat and the grudges.',
    enemyHpMul: 1.60,
    finalBossAt: 480,           // 8:00 — bosses come fast and hot
    // Reuses brown_mud ground but tinted deep red so it reads as fired clay /
    // basalt rather than mud. Fog goes warm-charcoal.
    groundTint: 0xc04428,
    fogColor: 0x2a0904,
    unlock: 'unlockedCinder',   // first twilight victory
  },
  {
    id: 'void', name: 'Woolen Drift',
    desc: 'A bone-quiet drift of violet wool. Every footstep returns wearing somebody else\'s echo.',
    enemyHpMul: 1.85,
    finalBossAt: 420,           // 7:00 — death pressure forces fast runs
    // Cold purple-bruise tint with deep-violet fog to read as crypt-light.
    groundTint: 0x6a4a8a,
    fogColor: 0x0a0612,
    unlock: 'unlockedVoid',     // clear Cinder's bounded portal finale
  },
  // PHASE 4 P4A (2026-05-18, cohort 1 of N) — Cave stage skeleton. Selectable
  // from menu via STAGE_ART entry in src/menuV2.js. Palette doc at
  // docs/CAVE_VISUAL_STYLE.md. groundTint (slot-2 stone) + fogColor (slot-1
  // shadow) pipe through env.js#applyStageTint without modification — cave
  // currently falls through to the twilight ground pack, lighting falls
  // through to forest baseline. Layered cohorts (P4A-c2 … P4A-cN) add rooms,
  // weapons, hazards, neutrals, landmarks, music, textures, achievements.
  {
    id: 'cave', name: 'Glass Mile',
    desc: 'Wet grottos measured in reflections. The last survey marker is still counting.',
    enemyHpMul: 1.45,
    finalBossAt: 540,
    groundTint: 0x4a4a52,       // slot-2 wet stone (CAVE_PALETTE.stone)
    fogColor: 0x1a1820,         // slot-1 cave shadow (CAVE_PALETTE.shadow)
    unlock: 'unlockedCave',     // first Catacomb Void clear
  },
  {
    id: 'kakiland', name: 'Chalk Plateau',
    desc: 'The final sky route. Clear three old marks and ask the erased horizon to stay put.',
    enemyHpMul: 1.95,
    // Kaki Land owns its own three-trial portal route and final boss instead
    // of the ordinary timer director. Keep this as metadata for HUD/telemetry.
    finalBossAt: 900,
    groundTint: 0xc7df79,
    fogColor: 0x9ed8f2,
    unlock: 'unlockedKakiLand', // first Stonewright Caverns victory
  },
];

export const STAGE = {
  durationSec: 1800,        // run length
  // Fun-loop iter 2 — 10-minute arc: boss beats every ~2.5-3 min instead of
  // a 15-minute slog with dead air. finalBossHpMul 30 → 12 kept kill time
  // in the 25-45s cinematic band against the weaker 10-minute build.
  // Rebalance 2026-07 — 12 → 16: the 12 was tuned pre-dash/primary buffs and
  // pre-chest-fed weapon levels; TTK badly undershot the 25-45s target.
  finalBossAt: 600,         // 10 min — final boss spawns; killing it triggers victory
  finalBossWarnSec: 5,      // banner shown N sec before spawn
  finalBossHpMul: 16,       // boss is the chosen elite at this HP multiplier
  finalBossScaleMul: 2.2,
  miniBossSchedule: [150, 330, 480],   // 2:30 / 5:30 / 8:00 mini-boss beats
  miniBossWarnSec: 3,
  // 2.2 not 3: the compressed D-curve already multiplies elite HP via rampHp
  // (×3.0 at 2:30, ×5.3 at 5:30 post-rebalance) — at ×3 a miniboss took 460+s
  // to kill, starving evolution paths keyed to miniboss kills. Rebalance
  // 2026-07 raised 1.6 → 2.2: 1.6 undershot the 15-45s TTK target once the
  // dash/primary buffs landed. Past ~2.5, re-verify evolution pity pacing.
  miniBossHpMul: 2.2,
  miniBossScaleMul: 1.4,
};
