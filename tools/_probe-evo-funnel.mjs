// throwaway probe: does a maxed weapon's paired evolution filler reach the
// draft as a REAL pool citizen (not end-of-pool padding)? Forces orbitals to
// maxLevel (evo Toxic Halo wants filler 'magnet' x2), rolls 20 drafts, and
// counts drafts containing filler:magnet — expect >= 6/20. Also asserts the
// active-pity pin is capped at 3 drafts (state.run._activePityShown === 3).
// Mirrors tools/_probe-evo-draft.mjs (same seeded mulberry32 Math.random).
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
  // Max orbitals (acquireWeapon caps at maxLevel internally). Hero level 10
  // with an EMPTY active slot so the pity path is live and its 3-draft cap
  // is exercised alongside the filler funnel.
  for (let i = 0; i < 12; i++) m.acquireWeapon('orbitals');
  s.hero.level = 10;
  const out = {
    weapons: s.weapons.map(w => w.id + ':' + w.level),
    magnetCount: s.hero.fillerCounts && s.hero.fillerCounts.magnet,
    fillerDrafts: 0, activePinned: 0, drafts: [],
  };
  for (let i = 0; i < 20; i++) {
    const c = m.weaponChoices(3);
    if (c.some(x => x.kind === 'filler' && x.id === 'magnet')) out.fillerDrafts++;
    if (c[0] && c[0].kind === 'active') out.activePinned++;
    out.drafts.push(c.map(x => x.kind + ':' + x.id).join(','));
  }
  out.pityShown = s.run && s.run._activePityShown;
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
const ok = res.fillerDrafts >= 6 && res.pityShown === 3;
console.log(ok
  ? `PASS — filler:magnet in ${res.fillerDrafts}/20 drafts (>=6); pity pinned ${res.pityShown}/3 then released`
  : `FAIL — filler:magnet in ${res.fillerDrafts}/20 drafts (want >=6); pityShown=${res.pityShown} (want 3)`);
process.exit(ok ? 0 : 1);
