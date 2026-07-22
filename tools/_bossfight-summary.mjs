import fs from 'fs';
const j = JSON.parse(fs.readFileSync('tools/probe-bossfight.json', 'utf8'));
for (const [k, r] of Object.entries(j.results)) {
  console.log('=== ' + k + ' ===');
  console.log(JSON.stringify({
    endReason: r.endReason, wall: r.wallSeconds, spawn: r.spawn, fbDeath: r.fbDeath,
    ttk: r.ttk, enrage: r.enrage, enrageBanner: r.enrageBannerSeen,
    windups: (r.windups || []).length, nukedMinis: r.nukedMinis,
    hits: r.fightHitCount, bigHits: r.fightBigHitCount, dmg: r.fightDmgTaken,
    minHp: r.fightMinHp, levelUps: (r.levelUps || []).length,
    tellPre: r.medianTellDeltaPre, tellPost: r.medianTellDeltaPost,
  }, null, 1));
  console.log('banners:', JSON.stringify(r.banners));
  console.log('finale:', JSON.stringify(r.finale && {
    t: r.finale.t, victory: r.finale.victory, deathTitle: r.finale.deathTitle,
    summaryShown: r.finale.summaryShown, kills: r.finale.kills, mbKills: r.finale.mbKills,
    dmgTaken: r.finale.dmgTaken, dashLevel: r.finale.dashLevel, relic: r.finale.relicDrop,
  }));
  console.log('windups:', JSON.stringify(r.windups));
  console.log('traj-first12:', JSON.stringify((r.traj || []).slice(0, 12)));
  console.log('drops:', JSON.stringify((r.fightDrops || []).slice(0, 25)));
  console.log('allDropsPreSpawn? samples-first6:', JSON.stringify((r.samples || []).slice(0, 6)));
  console.log('warns:', JSON.stringify(r.consoleWarns));
  console.log('errors:', JSON.stringify(r.errorTypes));
}
