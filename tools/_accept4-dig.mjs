// _accept4-dig.mjs — targeted follow-ups on the accept4 set.
import fs from 'fs';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const lines = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const det3 = read('tools/accept4-det3.json');
const det2 = read('tools/accept4-det2.json');
const p3 = lines('tools/accept4-det3.partial.jsonl');

// 1) det3 death window: all stream lines t in [425, 443] incl events + room state
const win = p3.filter(o => (typeof o.t === 'number' && o.t >= 425 && o.t <= 443));
console.log('--- det3 stream 425..443 ---');
for (const o of win) console.log(JSON.stringify(o));

// banners near death
console.log('--- det3 banners 400..443 ---');
for (const b of (det3.banners || [])) if (b.t >= 400 && b.t <= 443) console.log(JSON.stringify(b));

// 2) det3 nova-slot0 drafts: full levelup lines
console.log('--- det3 nova slot0 levelups ---');
for (const o of p3) if (o.ev === 'levelup' && o.choices && o.choices[0] === 'active:nova') console.log(JSON.stringify(o));

// 3) det3 full console errors for ERR_TIMED_OUT
console.log('--- det3 consoleErrors non-trim ---');
for (const e of (det3.consoleErrors || [])) if (!/trim/.test(e)) console.log(e);
console.log('--- det3 consoleWarns sample ---');
for (const w of (det3.consoleWarns || []).slice(0, 10)) console.log(w);

// 4) det2 maxGap 87.5 — locate the drought
console.log('--- det2 levelUp gaps > 40 ---');
const lu = det2.levelUps || [];
for (let i = 0; i < lu.length; i++) {
  const prev = i === 0 ? 0 : lu[i - 1].t;
  const g = lu[i].t - prev;
  if (g > 40) console.log(`gap ${g.toFixed(1)}s: ${prev.toFixed(1)} -> ${lu[i].t.toFixed(1)} picked=${lu[i].picked}`);
}

// 5) per-run evolutionEvents raw
for (const f of ['tools/accept4-det1.json', 'tools/accept4-det2.json', 'tools/accept4-det3.json', 'tools/accept4-facetank.json']) {
  const j = read(f);
  console.log(`--- ${f} evolutionEvents ---`, JSON.stringify(j.evolutionEvents));
}

// 6) alive-count spikes anywhere (delta > 150 within ~3s) across circle runs — is det3 death spike unique?
for (const [name, pf] of [['det1', 'tools/accept4-det1.partial.jsonl'], ['det2', 'tools/accept4-det2.partial.jsonl'], ['det3', 'tools/accept4-det3.partial.jsonl']]) {
  const ss = lines(pf).filter(o => o.ev === undefined && typeof o.t === 'number' && typeof o.enemies === 'number');
  const spikes = [];
  for (let i = 1; i < ss.length; i++) {
    const a = ss[i - 1], b = ss[i];
    if (b.t - a.t <= 3.5 && b.enemies - a.enemies > 150) spikes.push({ t: b.t, from: a.enemies, to: b.enemies, dt: +(b.t - a.t).toFixed(1) });
  }
  console.log(`--- ${name} alive spikes >150 ---`, JSON.stringify(spikes));
}
