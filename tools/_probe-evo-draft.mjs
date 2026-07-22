// throwaway probe: does an eligible dash evolution enter weaponChoices()?
// Replicates det2 late-run state (maxed weapons, dashLevel 4, mbKills 4)
// under the same seeded mulberry32 Math.random the accept harness uses.
import { createRequire } from 'module';
const require = createRequire('/home/nemoclaw/');
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(`(() => {
  let h = 1779033703;
  const s = 'det2';
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})()`);
await page.goto('http://localhost:9477/?seed=det2', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: 60000 });
await page.evaluate(() => window.kkStartRun());
await page.waitForFunction(() => window.kkState && window.kkState.started && window.kkState.mode === 'run', null, { timeout: 120000 });
const res = await page.evaluate(async () => {
  const m = await import('./src/weapons/index.js');
  const s = window.kkState;
  // det2 end-state: sig:8 web:8 frostbloom:8 maxed; chain:4 sigilbell:4 open.
  for (const [id, lv] of [['web', 8], ['frostbloom', 8], ['chain', 4], ['sigilbell', 4]]) {
    for (let i = 0; i < lv; i++) m.acquireWeapon(id);
  }
  const sig = s.weapons.find(w => w.id === 'sig_kitty_lucky_paw');
  if (sig) for (let i = sig.level; i < 8; i++) m.acquireWeapon('sig_kitty_lucky_paw');
  s.hero.level = 26;
  s.hero.dashUnlocked = true;
  s.hero.dashLevel = 4;
  s.hero.dashEvolved = false;
  s.run.miniBossKills = 4;
  const out = { weapons: s.weapons.map(w => w.id + ':' + w.level), evoSeen: 0, drafts: [] };
  for (let i = 0; i < 20; i++) {
    const c = m.weaponChoices(3);
    if (c.some(x => x.kind === 'evolution')) out.evoSeen++;
    out.drafts.push(c.map(x => x.kind + ':' + x.id).join(','));
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
