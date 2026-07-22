// _accept4-analyze.mjs — T1..T6 evaluation over the accept4 run set.
// Reads tools/accept4-*.json + .partial.jsonl; prints a single JSON report.
import fs from 'fs';

const RUNS = [
  { name: 'circle-det1', json: 'tools/accept4-det1.json' },
  { name: 'circle-det2', json: 'tools/accept4-det2.json' },
  { name: 'circle-det3', json: 'tools/accept4-det3.json' },
  { name: 'facetank-det1', json: 'tools/accept4-facetank.json' },
];

const BASELINE_ERR = /trim/i; // per-frame trim TypeError baseline

const report = { runs: {}, t1Deaths: [], t2Evolution: {}, t3NovaSlot0: {}, t4Boss: {}, t5PoolWarns: {}, t6Errors: {} };

for (const r of RUNS) {
  if (!fs.existsSync(r.json)) { report.runs[r.name] = 'MISSING'; continue; }
  const j = JSON.parse(fs.readFileSync(r.json, 'utf8'));
  const partialPath = r.json.replace(/\.json$/, '.partial.jsonl');
  const lines = fs.existsSync(partialPath)
    ? fs.readFileSync(partialPath, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const samples = lines.filter(o => o.ev === undefined && typeof o.t === 'number' && typeof o.enemies === 'number');

  report.runs[r.name] = {
    seed: j.seed, strategy: j.strategy, endReason: j.endReason, deathT: j.deathT,
    finalT: j.final && j.final.t, level: j.final && j.final.level, kills: j.final && j.final.kills,
    wallSeconds: j.wallSeconds, maxEnemies: j.maxEnemies,
    med60: j.medianGapAfter60, medAll: j.medianGapAll, maxGap: j.maxGap, trailingGap: j.trailingGap,
    mbKills: j.final && j.final.miniBossKills,
    weapons: j.final && j.final.weapons, passives: j.final && j.final.passives,
    dmgShares: j.dmgShares && {
      bombPct: j.dmgShares.bombPct, playerWeaponsPct: j.dmgShares.playerWeaponsPct,
      primaryPctOfPlayerWeapons: j.dmgShares.primaryPctOfPlayerWeapons,
    },
  };

  // ── T1: fair deaths ──
  if (j.endReason === 'hero-died' && j.deathT != null) {
    const dT = j.deathT;
    const win = samples.filter(s => s.t >= dT - 8 && s.t <= dT + 0.5);
    const at = (t) => { // nearest sample at-or-before t
      let best = null;
      for (const s of samples) if (s.t <= t && (!best || s.t > best.t)) best = s;
      return best;
    };
    const sDeath = at(dT);
    const s3 = at(dT - 3);
    const aliveDelta = (sDeath && s3) ? sDeath.enemies - s3.enemies : null;
    // teleport-encirclement: any consecutive sample pair (dt<=2.5s, scaled to 1s rate)
    // where nearestDist went >8 -> <2
    let teleport = null;
    for (let i = 1; i < win.length; i++) {
      const a = win[i - 1], b = win[i];
      if (a.nearestDist != null && b.nearestDist != null && a.nearestDist > 8 && b.nearestDist < 2) {
        teleport = { from: a.nearestDist, to: b.nearestDist, dt: +(b.t - a.t).toFixed(2), atT: b.t };
      }
    }
    report.t1Deaths.push({
      run: r.name, deathT: dT,
      aliveAtDeath: sDeath && sDeath.enemies, aliveMinus3s: s3 && s3.enemies, aliveDelta3s: aliveDelta,
      hpTrail: win.map(s => ({ t: s.t, hp: s.hp, enemies: s.enemies, near: s.nearestDist })),
      teleportJump: teleport,
      fair: (aliveDelta == null || aliveDelta < 150) && !teleport,
    });
  }

  // ── T2: evolution events ──
  report.t2Evolution[r.name] = (j.evolutionEvents || []).map(e => `${e.ev}:${e.id}@${e.t}`);

  // ── T3: nova slot-0 drafts ──
  const lvls = lines.filter(o => o.ev === 'levelup' && o.choices);
  const novaSlot0 = lvls.filter(l => l.choices[0] === 'active:nova');
  const novaTaken = lvls.filter(l => l.picked === 'active:nova');
  report.t3NovaSlot0[r.name] = {
    draftsTotal: lvls.length,
    novaSlot0Count: novaSlot0.length,
    novaSlot0Times: novaSlot0.map(l => l.t),
    novaTakenAt: novaTaken.map(l => l.t),
    activeEnd: j.final && j.final.activeAbility,
  };

  // ── T4: final boss ──
  const fb = (j.bossEvents || []).filter(e => e.ev.startsWith('finalboss'));
  const enrage = (j.banners || []).filter(b => /ENRAGE/i.test(b.text));
  const fbBanners = (j.banners || []).filter(b => /BOSS|KAKI|FINAL/i.test(b.text)).slice(0, 6);
  report.t4Boss[r.name] = {
    reached600: (j.final && j.final.t >= 600) || fb.length > 0,
    finalbossEvents: fb, enrageBanners: enrage, bossBanners: fbBanners,
    victory: j.final && j.final.victory,
  };

  // ── T5: pool warns ──
  const poolLines = (j.consoleWarns || []).filter(w => w.includes('pool empty'));
  // dedupe per glbKey from samples
  const byKey = {};
  for (const w of (j.poolEmptyWarnSamples || [])) {
    const m = w.match(/pool empty[^a-zA-Z0-9_]*([a-zA-Z0-9_\-]+)/);
    const k = m ? m[1] : w.slice(0, 60);
    byKey[k] = (byKey[k] || 0) + 1;
  }
  report.t5PoolWarns[r.name] = { total: j.poolEmptyWarns, samples: j.poolEmptyWarnSamples, byKeySampled: byKey };

  // ── T6: error types ──
  const nonBaseline = {};
  for (const [k, v] of Object.entries(j.errorTypes || {})) {
    if (!BASELINE_ERR.test(k)) nonBaseline[k] = v;
  }
  report.t6Errors[r.name] = { all: j.errorTypes, nonBaseline };
}

console.log(JSON.stringify(report, null, 1));
