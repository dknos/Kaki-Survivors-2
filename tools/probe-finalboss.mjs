/**
 * probe-finalboss.mjs — targeted spawn-machinery probe for the 600s final boss.
 *
 * Starts a normal run headless (same shims as playtest-accept2.mjs), god-modes
 * the hero (hp 99999), then JUMPS state.time.game to --jump (default 540) so
 * the miniboss beats (150/330/480) and the final-boss beat (600) fire on a
 * full-density field. Watches mbAlive / fbAlive / banners until --until
 * game-sec (default 640) and dumps events.
 *
 * Usage (WSL): node tools/probe-finalboss.mjs [--jump=540] [--until=640] [--out=tools/probe-finalboss.json]
 */
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/nemoclaw/');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const JUMP_TO = Number(args.jump) || 540;
const UNTIL = Number(args.until) || 640;
const OUT = args.out || 'tools/probe-finalboss.json';

const consoleErrors = [];
const consoleWarns = [];
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  if (m.type() === 'warning') consoleWarns.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

await page.addInitScript(`(() => {
  let virt = 0;
  performance.now = () => virt;
  let cbs = [];
  window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = () => {};
  const pump = () => {
    virt += 33;
    const run = cbs; cbs = [];
    for (const cb of run) { try { cb(virt); } catch (e) { console.error('rAF cb', e); } }
    setTimeout(pump, 0);
  };
  setTimeout(pump, 50);
})();`);

await page.goto('http://localhost:9477/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: 60000 });
await page.evaluate(() => { window.kkStartRun(); });
await page.waitForFunction(
  () => window.kkState && window.kkState.started && window.kkState.mode === 'run',
  null, { timeout: 120000 }
);

await page.evaluate(() => {
  const s = window.kkState;
  s.renderer.render = function () {};   // probe never needs pixels
  window.__banners = [];
  const obs = new MutationObserver((muts) => {
    if (window.__banners.length > 300) return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.textContent) {
        const txt = n.textContent.trim();
        if (txt.length > 2 && txt.length < 80 && /[A-Z]{3}/.test(txt)) {
          window.__banners.push({ t: +s.time.game.toFixed(1), text: txt.slice(0, 70) });
        }
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  window.__snap = () => {
    let mbAlive = 0, fbAlive = false, fbHp = null, alive = 0;
    for (const e of s.enemies.active) {
      if (!e || !e.alive) continue;
      alive++;
      if (e.isMiniBoss) mbAlive++;
      if (e.isFinalBoss) { fbAlive = true; fbHp = Math.round(e.hp); }
    }
    return {
      t: +s.time.game.toFixed(2), paused: s.time.paused, pending: s.pendingLevelUp,
      enemies: alive, mbAlive, fbAlive, fbHp,
      mbKills: s.run.miniBossKills || 0,
      victory: !!s.victory, gameOver: s.gameOver,
      roomState: s.run.roomState, lockdown: !!s.run.lockdownActive,
      hp: Math.round(s.hero.hp),
    };
  };
});

// God-mode + clock jump
await page.evaluate((jumpTo) => {
  const s = window.kkState;
  s.hero.hpMax = 99999; s.hero.hp = 99999;
  s.time.game = jumpTo;
}, JUMP_TO);

await page.mouse.move(640, 360);
await page.mouse.down();

const samples = [];
const events = [];
let lastMbAlive = 0, lastMbKills = 0, fbSeen = false;
const wall0 = Date.now();
while (Date.now() - wall0 < 480000) {
  let s;
  try { s = await page.evaluate(() => window.__snap()); }
  catch (e) { events.push({ ev: 'snap-failed', err: String(e).slice(0, 120) }); break; }
  if (s.pending || s.paused) {
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(80);
    await page.keyboard.press('Space');
    continue;
  }
  samples.push(s);
  const cum = s.mbAlive + s.mbKills;
  if (cum > lastMbAlive + lastMbKills) events.push({ ev: 'miniboss-spawn', t: s.t, mbAlive: s.mbAlive });
  if (s.mbKills > lastMbKills) events.push({ ev: 'miniboss-death', t: s.t, n: s.mbKills });
  lastMbAlive = s.mbAlive; lastMbKills = s.mbKills;
  if (s.fbAlive && !fbSeen) { fbSeen = true; events.push({ ev: 'finalboss-spawn', t: s.t, hp: s.fbHp }); }
  if (s.victory) { events.push({ ev: 'victory', t: s.t }); break; }
  if (s.gameOver) { events.push({ ev: 'hero-died', t: s.t }); break; }
  if (s.t >= UNTIL) break;
  await page.waitForTimeout(250);
}

const banners = await page.evaluate(() => window.__banners).catch(() => null);
await browser.close();

const out = {
  jumpTo: JUMP_TO, until: UNTIL,
  events,
  fbSeen,
  banners: (banners || []).filter(b => /BOSS|FOE|ELITE|INCOMING|EVOL|NEMESIS|RETURNED|SOVEREIGN|HUNTS/.test(b.text)),
  samples: samples.filter((_, i) => i % 4 === 0),
  consoleWarns: consoleWarns.slice(0, 20),
  consoleErrorsCount: consoleErrors.length,
  consoleErrorsUnique: [...new Set(consoleErrors.map(e => e.split('\n')[0].slice(0, 100)))],
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, samples: `(${samples.length} samples, see ${OUT})` }, null, 1));
