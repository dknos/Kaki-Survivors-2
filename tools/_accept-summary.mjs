// throwaway summarizer for accept JSONs (playtest engineer scratch)
import fs from 'fs';
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log('==', f, JSON.stringify({
    end: j.endReason, deathT: j.deathT, t: j.final && j.final.t, wall: j.wallSeconds,
    med60: j.medianGapAfter60, maxGap: j.maxGap,
    evoOffered: (j.evolutionEvents || []).filter(e => e.ev === 'evo-offered').length,
    evoAchieved: (j.evolutionEvents || []).filter(e => e.ev === 'evolved').map(e => e.id + '@' + e.t),
    boss: (j.bossEvents || []).slice(-3),
    errs: Object.keys(j.errorTypes || {}),
    warns: (j.consoleWarns || []).slice(0, 5),
    weapons: j.final && j.final.weapons, lvl: j.final && j.final.level,
    minHp: j.minHp, slotOutcomes: j.slotOutcomes,
    banners: (j.banners || []).filter(b => /LV|EVO|PAIR|TRIPLE|JACKPOT/.test(b.text)).slice(0, 12),
  }, null, 1));
}
