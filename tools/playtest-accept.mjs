/**
 * playtest-accept.mjs — iteration-1 acceptance playtest for Kitty Kaki Survivors.
 *
 * Extension of playtest-diag.mjs (same headless-timing shims, see that file's
 * header) with a strategy flag + acceptance-target instrumentation.
 *
 * Usage (WSL): cd ~/kitty-kaki-survivors && node tools/playtest-accept.mjs \
 *     [--strategy=circle|facetank] [--out=tools/out.json] [--seed=diag1] [--target=240]
 *
 * Strategies:
 *   circle   (default) — 8-dir circle-strafe rotation, dash every 8s, RMB every 12s,
 *                        LMB held with cursor on nearest enemy.
 *   facetank           — NO movement keys, NO dash. Still aims + holds LMB and
 *                        casts RMB (fights back, refuses to move).
 *
 * Extra measurements vs playtest-diag.mjs:
 *   - per-poll max simultaneous enemy projectiles inside t=60..180
 *   - minHp timestamp
 *   - level-up chain detection (consecutive modals <=1.5 game-sec apart)
 *   - trailing level-up gap (end-of-run minus last level-up)
 *   - damage shares: bomb_pickup / environment / player-weapon buckets
 */
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/nemoclaw/');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const STRATEGY = args.strategy === 'facetank' ? 'facetank' : 'circle';
const OUT = args.out || `tools/playtest-accept-${STRATEGY}.json`;
const SEED = args.seed || 'diag1';
const TARGET_GAME_SEC = Number(args.target) || 240;
const WALL_CAP_MS = 500000;
const POLL_MS = 300;
const VIRT_STEP_MS = 33;
const PARTIAL = OUT.replace(/\.json$/, '.partial.jsonl');

const consoleErrors = [];
const consoleWarns = [];
fs.writeFileSync(PARTIAL, '');
const stream = (obj) => { try { fs.appendFileSync(PARTIAL, JSON.stringify(obj) + '\n'); } catch (_) {} };

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  if (m.type() === 'warning') consoleWarns.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 300)));

await page.addInitScript(`(() => {
  const step = ${VIRT_STEP_MS};
  let virt = 0;
  performance.now = () => virt;
  let cbs = [];
  window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  window.cancelAnimationFrame = () => {};
  const pump = () => {
    virt += step;
    const run = cbs; cbs = [];
    for (const cb of run) { try { cb(virt); } catch (e) { console.error('rAF cb', e); } }
    setTimeout(pump, 0);
  };
  setTimeout(pump, 50);
})();`);

const wall0 = Date.now();
await page.goto('http://localhost:9477/?seed=' + encodeURIComponent(SEED), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: 60000 });

const ident = await page.evaluate(async () => {
  const m = await import('./src/state.js');
  return m.state === window.kkState;
});
if (!ident) throw new Error('state module identity check failed');

await page.evaluate(() => { window.kkStartRun(); });
await page.waitForFunction(
  () => window.kkState && window.kkState.started && window.kkState.mode === 'run',
  null, { timeout: 120000 }
);
const wallRunStart = Date.now();
stream({ ev: 'run-started', strategy: STRATEGY, wall: (wallRunStart - wall0) / 1000 });

await page.evaluate(() => {
  const st = window.kkState;
  window.__diagFrames = 0;
  const cnt = () => { window.__diagFrames++; requestAnimationFrame(cnt); };
  requestAnimationFrame(cnt);
  window.__diagRealRender = st.renderer.render.bind(st.renderer);
  window.__diagRenderOn = false;
  st.renderer.render = function (...a) { if (window.__diagRenderOn) return window.__diagRealRender(...a); };

  window.__diagSnap = () => {
    const s = window.kkState;
    try { s.camera.updateMatrixWorld(true); } catch (_) {}
    let alive = 0, elites = 0;
    let nearest = null, nearD2 = Infinity;
    const hp = s.hero.pos;
    for (const e of s.enemies.active) {
      if (!e || !e.alive) continue;
      alive++;
      if (e.elite || e.isMiniBoss) elites++;
      const ep = e.mesh ? e.mesh.position : e.pos;
      if (ep) {
        const dx = ep.x - hp.x, dz = ep.z - hp.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearD2) { nearD2 = d2; nearest = ep; }
      }
    }
    let aim = null;
    if (nearest && s.camera && s.renderer) {
      try {
        const v = nearest.clone().project(s.camera);
        const r = s.renderer.domElement.getBoundingClientRect();
        aim = { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (-v.y + 1) / 2 * r.height };
      } catch (_) {}
    }
    return {
      t: +s.time.game.toFixed(2),
      paused: s.time.paused,
      pending: s.pendingLevelUp,
      pendingCount: s.pendingLevelCount,
      choices: s.pendingLevelUp ? s.levelUpChoices.map(c => (c.kind || '?') + ':' + c.id) : null,
      hp: +s.hero.hp.toFixed(1),
      hpMax: s.hero.hpMax,
      level: s.hero.level,
      kills: s.run.kills,
      dmgTaken: +((s.run.dmgTaken || 0)).toFixed(1),
      enemies: alive, elites,
      nearestDist: nearest ? +Math.sqrt(nearD2).toFixed(1) : null,
      heroProj: s.projectiles.active.length,
      enemyProj: s.enemyProjectiles.active.length,
      gems: s.gems.list.filter(g => g.active).length,
      gameOver: s.gameOver,
      frames: window.__diagFrames,
      activeAbility: s.hero.active && s.hero.active.id,
      aim,
    };
  };
});

// ── input simulation loop ────────────────────────────────────────────────────
const DIRS = [
  ['KeyW'], ['KeyW', 'KeyD'], ['KeyD'], ['KeyS', 'KeyD'],
  ['KeyS'], ['KeyS', 'KeyA'], ['KeyA'], ['KeyA', 'KeyW'],
];
let dirIdx = 0;
let heldKeys = [];
async function setDir(keys) {
  for (const k of heldKeys) if (!keys.includes(k)) await page.keyboard.up(k);
  for (const k of keys) if (!heldKeys.includes(k)) await page.keyboard.down(k);
  heldKeys = keys;
}

await page.mouse.move(640, 360);
await page.mouse.down();           // LMB hold-to-fire, never released
if (STRATEGY === 'circle') await setDir(DIRS[0]);

const timeline = [];
const levelUps = [];
let nextSampleT = 0;
let lastDirT = 0, lastDashT = 0, lastCastT = 0;
let firstKillT = null;
let firstEnemyProjT = null;
let maxEnemies = 0, maxEnemyProj = 0, maxHeroProj = 0;
let maxEnemyProjWindow = 0, maxEnemyProjWindowT = null;   // window t=60..180
let minHp = 1e9, minHpT = null;
let deathT = null;
let endReason = 'target-reached';

function pick(s) {
  return {
    t: s.t, hp: s.hp, level: s.level, kills: s.kills,
    enemies: s.enemies, elites: s.elites, nearestDist: s.nearestDist,
    heroProj: s.heroProj, enemyProj: s.enemyProj, gems: s.gems,
    dmgTaken: s.dmgTaken, frames: s.frames, active: s.activeAbility,
  };
}

while (true) {
  if (Date.now() - wallRunStart > WALL_CAP_MS) { endReason = 'wall-cap'; break; }

  let s;
  try { s = await page.evaluate(() => window.__diagSnap()); }
  catch (e) { endReason = 'snap-failed: ' + String(e).slice(0, 120); break; }

  if (s.gameOver) { endReason = 'hero-died'; deathT = s.t; timeline.push(pick(s)); stream(pick(s)); break; }
  if (s.t >= TARGET_GAME_SEC) { timeline.push(pick(s)); stream(pick(s)); break; }

  maxEnemies = Math.max(maxEnemies, s.enemies);
  maxEnemyProj = Math.max(maxEnemyProj, s.enemyProj);
  maxHeroProj = Math.max(maxHeroProj, s.heroProj);
  if (s.t >= 60 && s.t <= 180 && s.enemyProj > maxEnemyProjWindow) {
    maxEnemyProjWindow = s.enemyProj; maxEnemyProjWindowT = s.t;
  }
  if (s.hp < minHp) { minHp = s.hp; minHpT = s.t; }
  if (firstKillT === null && s.kills > 0) firstKillT = s.t;
  if (firstEnemyProjT === null && s.enemyProj > 0) firstEnemyProjT = s.t;

  if (s.pending) {
    const picked = s.choices && s.choices[0];
    await page.keyboard.press('Digit1');
    levelUps.push({ t: s.t, toLevel: s.level + 1, picked, queue: s.pendingCount });
    stream({ ev: 'levelup', t: s.t, picked });
    await page.waitForTimeout(100);
    continue;
  }
  if (s.paused) {
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(80);
    await page.keyboard.press('Space');
    stream({ ev: 'paused-modal-answered', t: s.t });
    await page.waitForTimeout(120);
    continue;
  }

  if (s.t >= nextSampleT) {
    timeline.push(pick(s));
    stream(pick(s));
    nextSampleT = Math.floor(s.t / 2) * 2 + 2;
  }

  if (s.aim) {
    const x = Math.max(8, Math.min(1272, s.aim.x));
    const y = Math.max(8, Math.min(712, s.aim.y));
    try { await page.mouse.move(x, y); } catch (_) {}
  }

  if (STRATEGY === 'circle') {
    if (s.t - lastDirT > 1.5) {
      dirIdx = (dirIdx + 1) % DIRS.length;
      await setDir(DIRS[dirIdx]);
      lastDirT = s.t;
    }
    if (s.t - lastDashT > 8) {
      await page.keyboard.down('ShiftLeft');
      await page.waitForTimeout(50);
      await page.keyboard.up('ShiftLeft');
      lastDashT = s.t;
    }
  }
  if (s.t - lastCastT > 12) {
    try { await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); } catch (_) {}
    lastCastT = s.t;
  }

  await page.waitForTimeout(POLL_MS);
}

// ── final state dump ─────────────────────────────────────────────────────────
let final = null;
try {
  final = await page.evaluate(() => {
    const s = window.kkState;
    return {
      t: +s.time.game.toFixed(1),
      mode: s.mode, gameOver: s.gameOver, victory: s.victory,
      level: s.hero.level, hp: +s.hero.hp.toFixed(1), hpMax: s.hero.hpMax,
      kills: s.run.kills,
      dmgDealt: Math.round(s.run.dmgDealt), dmgTaken: Math.round(s.run.dmgTaken),
      dmgByWeapon: Object.fromEntries(Object.entries(s.run.dmgByWeapon || {}).map(([k, v]) => [k, Math.round(v)])),
      weapons: s.weapons.map(w => w.id + ':' + w.level),
      passives: s.passives.map(p => p.id + ':' + p.level),
      activeAbility: s.hero.active && s.hero.active.id,
      flawless: s.run.flawless,
      gold: s.run.gold,
      pickedGems: s.run.pickedGems,
      roomState: s.run.roomState, currentRoom: s.run.currentRoom,
    };
  });
} catch (_) {}

await browser.close();

// ── analysis ─────────────────────────────────────────────────────────────────
const wallTotal = (Date.now() - wall0) / 1000;
const gaps = [];
for (let i = 0; i < levelUps.length; i++) {
  gaps.push(+((levelUps[i].t - (i === 0 ? 0 : levelUps[i - 1].t)).toFixed(1)));
}
const endT = final ? final.t : (timeline.length ? timeline[timeline.length - 1].t : 0);
const trailingGap = levelUps.length ? +(endT - levelUps[levelUps.length - 1].t).toFixed(1) : null;
// chain = consecutive level-up modals <=1.5 game-sec apart (back-to-back queue dumps)
let maxChain = levelUps.length ? 1 : 0, chain = 1;
for (let i = 1; i < levelUps.length; i++) {
  if (levelUps[i].t - levelUps[i - 1].t <= 1.5) chain++; else chain = 1;
  if (chain > maxChain) maxChain = chain;
}
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : +(((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1));
};
// damage shares
const ENV_KEYS = ['trapCorridor', 'forest_amber', 'forestEnvHazard', 'forestHazard', 'envHazard'];
let dmgBomb = 0, dmgEnv = 0, dmgWeapon = 0, dmgOther = 0, dmgTotal = 0;
const byW = (final && final.dmgByWeapon) || {};
for (const [k, v] of Object.entries(byW)) {
  dmgTotal += v;
  if (k === 'bomb_pickup' || k === 'bomb') dmgBomb += v;
  else if (ENV_KEYS.includes(k)) dmgEnv += v;
  else if (k === 'dash') dmgOther += v;
  else dmgWeapon += v;
}
const pct = (x) => dmgTotal ? +(100 * x / dmgTotal).toFixed(1) : null;

const out = {
  ranAt: new Date().toISOString(),
  strategy: STRATEGY,
  seed: SEED,
  wallSeconds: +wallTotal.toFixed(1),
  endReason, deathT,
  identityCheck: ident,
  virtClockStepMs: VIRT_STEP_MS,
  firstKillT, firstEnemyProjT,
  maxEnemies, maxEnemyProj, maxHeroProj,
  maxEnemyProjWindow_60_180: maxEnemyProjWindow,
  maxEnemyProjWindowT: maxEnemyProjWindowT,
  minHp, minHpT,
  levelUps, levelUpGaps: gaps,
  medianGapAll: median(gaps),
  medianGapAfter60: median(gaps.filter((g, i) => levelUps[i].t > 60)),
  maxGap: gaps.length ? Math.max(...gaps) : null,
  trailingGap,
  maxLevelUpChain: maxChain,
  dmgShares: {
    total: dmgTotal,
    bomb: dmgBomb, bombPct: pct(dmgBomb),
    env: dmgEnv, envPct: pct(dmgEnv),
    playerWeapons: dmgWeapon, playerWeaponsPct: pct(dmgWeapon),
    other: dmgOther, otherPct: pct(dmgOther),
  },
  timeline,
  final,
  consoleErrors: consoleErrors.slice(0, 30),
  consoleWarns: consoleWarns.slice(0, 10),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, timeline: `(${timeline.length} samples, see ${OUT})`, levelUps: `(${levelUps.length} level-ups, see ${OUT})` }, null, 1));
