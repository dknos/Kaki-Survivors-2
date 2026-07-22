// Quick probe: can headless chromium boot the game, start a run, read state?
// Run: node tools/playtest-probe.mjs   (from repo root in WSL)
import { createRequire } from 'module';
const require = createRequire('/home/nemoclaw/');
const { chromium } = require('playwright');

const errors = [];
const warns = [];

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  if (m.type() === 'warning') warns.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

const t0 = Date.now();
await page.goto('http://localhost:9477/?seed=diag1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: 60000 });
console.log('boot ok in', ((Date.now() - t0) / 1000).toFixed(1), 's');

// verify dynamic import returns the SAME module instance the page uses
const identity = await page.evaluate(async () => {
  const m = await import('./src/state.js');
  return {
    sameAsKkState: m.state === window.kkState,
    mode: m.state.mode,
    hasRenderer: !!m.state.renderer,
  };
});
console.log('state identity:', JSON.stringify(identity));

// start a run
await page.evaluate(() => { window.kkStartRun(); });
await page.waitForFunction(
  () => window.kkState && window.kkState.started && window.kkState.mode === 'run',
  null, { timeout: 90000 }
);
console.log('run started at', ((Date.now() - t0) / 1000).toFixed(1), 's wall');

// watch 8 wall-seconds of play with no input
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const st = window.kkState;
    const snap = (window.kkPerfSnapshot && window.kkPerfSnapshot()) || {};
    return {
      game: +st.time.game.toFixed(2),
      paused: st.time.paused,
      pendingLevelUp: st.pendingLevelUp,
      hp: st.hero.hp,
      level: st.hero.level,
      kills: st.run.kills,
      enemies: st.enemies.active.filter((e) => e.alive).length,
      heroProj: st.projectiles.active.length,
      enemyProj: st.enemyProjectiles.active.length,
      weapons: st.weapons.map((w) => w.id + ':' + w.level),
      fps: snap.fps,
    };
  });
  console.log(JSON.stringify(s));
}

console.log('console errors:', JSON.stringify(errors.slice(0, 10), null, 1));
console.log('console warns (first 5):', JSON.stringify(warns.slice(0, 5), null, 1));
await browser.close();
