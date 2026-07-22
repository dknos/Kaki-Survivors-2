import fs from 'fs';
for (const f of ['accept23-det2', 'accept41-det3', 'accept31-det2', 'accept23-det1', 'accept22-circle2']) {
  try {
    const j = JSON.parse(fs.readFileSync(`tools/${f}.json`, 'utf8'));
    console.log(f, '->', JSON.stringify({
      endReason: j.endReason, t: j.final && j.final.t, level: j.final && j.final.level,
      hpMax: j.final && j.final.hpMax,
      weapons: j.final && j.final.weapons, passives: j.final && j.final.passives,
    }));
  } catch (e) { console.log(f, 'ERR', String(e).slice(0, 80)); }
}
