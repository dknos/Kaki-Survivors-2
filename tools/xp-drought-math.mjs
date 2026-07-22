// XP-drought math model (read-only analysis probe, no game code imported).
// Mirrors: state.js xpForLevel, spawnDirector.js computeDifficulty,
// enemies.js gem stamp `1 + floor(D/2.5)`.
const XP = { base: 20, growth: 1.27, lateLevel: 18, lateGrowth: 1.10 };

function xpForLevel(lvl, lateGrowth = XP.lateGrowth, lateLevel = XP.lateLevel) {
  if (lvl <= lateLevel) return Math.ceil(XP.base * Math.pow(XP.growth, lvl - 1));
  return Math.ceil(XP.base * Math.pow(XP.growth, lateLevel - 1) * Math.pow(lateGrowth, lvl - lateLevel));
}

function D(t) {
  if (t <= 0) return 0;
  if (t < 60) return t / 60;
  if (t < 660) return 1 + (t - 60) / 600 * 9;
  return 10;
}

const gemBase = t => 1 + Math.floor(D(t) / 2.5);          // live curve
const gemSteep = t => 1 + Math.floor(D(t) / 1.5);         // proposed fix

// Gem value step times (live curve)
console.log('--- gem value steps (live 1+floor(D/2.5)) ---');
for (const v of [2, 3, 4, 5]) {
  const Dneeded = (v - 1) * 2.5;
  const t = 60 + (Dneeded - 1) / 9 * 600;
  console.log(`value ${v} unlocks at D=${Dneeded} -> t=${t.toFixed(0)}s (${(t/60).toFixed(1)} min)`);
}

console.log('\n--- xpNext table (live lateGrowth 1.10) ---');
for (const L of [18, 20, 22, 24, 26, 28, 30, 32, 34]) {
  console.log(`L${L}->L${L+1}: ${xpForLevel(L)}  | lateGrowth 1.07: ${xpForLevel(L, 1.07)} | lateLevel 22: ${xpForLevel(L, 1.10, 22)}`);
}

// Simulate leveling with kill-rate K (ramps 3 -> K over first 180s), xpMul=1.
function sim(K, gemFn, xpFn, label) {
  let xp = 0, lvl = 1, next = xpFn(1), lastT = 0;
  const dt = 0.05, marks = {};
  let maxGapBand = 0, first45 = null, first60 = null;
  const gaps = [];
  for (let t = 0; t <= 600; t += dt) {
    const k = Math.min(K, 3 + (K - 3) * (t / 180));
    xp += k * gemFn(t) * dt;
    while (xp >= next) {
      xp -= next; lvl++; next = xpFn(lvl);
      const gap = t - lastT; gaps.push({ t, gap, lvl });
      if (t > 200 && first45 === null && gap > 45) first45 = { t, gap, lvl };
      if (t > 200 && first60 === null && gap > 60) first60 = { t, gap, lvl };
      if (t >= 300 && t <= 480) maxGapBand = Math.max(maxGapBand, gap);
      lastT = t;
    }
    for (const m of [300, 350, 400, 450, 500]) {
      if (!marks[m] && t >= m) marks[m] = { lvl, next, inc: k * gemFn(t) };
    }
  }
  console.log(`\n[${label}] K=${K}/s`);
  for (const m of [300, 350, 400, 450, 500]) {
    const { lvl, next, inc } = marks[m];
    console.log(`  t=${m}s D=${D(m).toFixed(2)} gem=${gemFn(m)}: L${lvl}, xpNext=${next}, income=${inc.toFixed(0)} xp/s -> ${(next/inc).toFixed(0)}s/level`);
  }
  console.log(`  max gap in 300-480s band: ${maxGapBand.toFixed(0)}s` +
    `; first gap>45s: ${first45 ? `t=${first45.t.toFixed(0)} L${first45.lvl} (${first45.gap.toFixed(0)}s)` : 'never'}` +
    `; first gap>60s: ${first60 ? `t=${first60.t.toFixed(0)} L${first60.lvl} (${first60.gap.toFixed(0)}s)` : 'never'}`);
}

for (const K of [10, 15, 20]) sim(K, gemBase, l => xpForLevel(l), 'LIVE');
console.log('\n=== FIX VARIANTS (K=15) ===');
sim(15, gemSteep, l => xpForLevel(l), 'fix A: gem 1+floor(D/1.5)');
sim(15, gemBase, l => xpForLevel(l, 1.07), 'fix B: lateGrowth 1.07');
sim(15, gemSteep, l => xpForLevel(l, 1.07), 'fix A+B combined');
