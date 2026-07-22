/**
 * playtest-diag.mjs — headless fun-diagnosis playtest for Kitty Kaki Survivors.
 *
 * Boots the real game at http://localhost:9477/ in headless chromium (1280x720),
 * starts a Forest run as the default character via window.kkStartRun(), then
 * simulates 180-240 in-game seconds of play:
 *   - circle-strafe movement (8-dir WASD rotation every ~1.5 game-sec)
 *   - LMB held the whole run (DMD-hybrid hold-to-fire primary), cursor tracked
 *     onto the nearest live enemy's screen position every poll (competent aim)
 *   - dash (Shift) every ~8s, active-ability cast (RMB) every ~12s
 *   - level-up modal auto-resolved by pressing '1' (Digit1 hotkey -> first card)
 *
 * State is read via window.kkState (exposed unconditionally by src/perfHUD.js:101;
 * verified identical to dynamic import('./src/state.js') — same module instance).
 *
 * HEADLESS TIMING (important): headless chromium starves requestAnimationFrame
 * when the canvas never invalidates, and SwiftShader rendering runs ~0.12x real
 * time. So BEFORE page load we shim rAF -> setTimeout pump + a virtual
 * performance.now() that advances 33ms per frame (equivalent to a steady 30fps
 * machine — well inside the engine's dt clamp of 0.05). After run-start we stub
 * state.renderer.render with a no-op (game logic is fully render-independent;
 * camera.matrixWorldInverse is refreshed manually before projections).
 * NO game source files are modified.
 *
 * Output: tools/playtest-diag-out.json (+ streaming tools/playtest-diag-out.partial.jsonl)
 * Run (WSL): cd ~/kitty-kaki-survivors && node tools/playtest-diag.mjs
 */
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/nemoclaw/');
const { chromium } = require('playwright');

const TARGET_GAME_SEC = 360;   // >= 180 required; 360 catches the 5:30 miniboss beat + post-beat ebb + D>=4 wizard fans
const WALL_CAP_MS = 500000;    // hard wall-clock cap (fits a 600s caller budget)
const POLL_MS = 300;
const VIRT_STEP_MS = 33;       // virtual ms per frame (30fps-equivalent dt)
const PARTIAL = 'tools/playtest-diag-out.partial.jsonl';

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

// Virtual clock + rAF pump — installed before any page script runs.
await page.addInitScript(`(() => {
  const step = ${VIRT_STEP_MS};
  let virt = 0;
  const realNow = performance.now.bind(performance);
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
await page.goto('http://localhost:9477/?seed=diag1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.kkStartRun === 'function', null, { timeout: 60000 });

// Sanity: dynamic import returns the page's own module instance.
const ident = await page.evaluate(async () => {
  const m = await import('./src/state.js');
  return m.state === window.kkState;
});
if (!ident) throw new Error('state module identity check failed');

// Start the run (menu -> forest run, default character).
await page.evaluate(() => { window.kkStartRun(); });
await page.waitForFunction(
  () => window.kkState && window.kkState.started && window.kkState.mode === 'run',
  null, { timeout: 120000 }
);
const wallRunStart = Date.now();
stream({ ev: 'run-started', wall: (wallRunStart - wall0) / 1000 });

// Install page-side helpers: render stub + frame counter + snapshot fn.
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
      xp: s.hero.xp, xpNext: s.hero.xpNext,
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
await setDir(DIRS[0]);

const timeline = [];
const levelUps = [];
let nextSampleT = 0;
let lastDirT = 0, lastDashT = 0, lastCastT = 0;
let firstKillT = null;
let firstEnemyProjT = null;
let maxEnemies = 0, maxEnemyProj = 0, maxHeroProj = 0;
let minHp = 1e9;
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

  if (s.gameOver) { endReason = 'hero-died'; timeline.push(pick(s)); stream(pick(s)); break; }
  if (s.t >= TARGET_GAME_SEC) { timeline.push(pick(s)); stream(pick(s)); break; }

  maxEnemies = Math.max(maxEnemies, s.enemies);
  maxEnemyProj = Math.max(maxEnemyProj, s.enemyProj);
  maxHeroProj = Math.max(maxHeroProj, s.heroProj);
  minHp = Math.min(minHp, s.hp);
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
  // Non-level-up hard pauses:
  //  - forest treasure-chest 3-option picker (forestChests.js:542) -> keys 1/2/3
  //  - legacy slot-machine "Treasure" modal (ui.js:3275, still reached on forest
  //    via totem/pylon/bell/log chests, totems.js:161) -> Space skips + commits
  // Answer with 1 then Space so the run continues either way.
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

try {
  await page.evaluate(() => { window.__diagRenderOn = true; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tools/playtest-diag-shot.png', timeout: 20000 });
  await page.evaluate(() => { window.__diagRenderOn = false; });
} catch (_) {}

await browser.close();

// ── analysis ─────────────────────────────────────────────────────────────────
const wallTotal = (Date.now() - wall0) / 1000;
const killsByMin = {};
for (const s of timeline) {
  const m = Math.floor(s.t / 60);
  killsByMin[m] = Math.max(killsByMin[m] || 0, s.kills);
}
const kpm = {};
let prevK = 0;
for (const m of Object.keys(killsByMin).map(Number).sort((a, b) => a - b)) {
  kpm['min' + m] = killsByMin[m] - prevK;
  prevK = killsByMin[m];
}
const gaps = [];
for (let i = 0; i < levelUps.length; i++) {
  gaps.push(+((levelUps[i].t - (i === 0 ? 0 : levelUps[i - 1].t)).toFixed(1)));
}

const out = {
  ranAt: new Date().toISOString(),
  wallSeconds: +wallTotal.toFixed(1),
  endReason,
  identityCheck: ident,
  virtClockStepMs: VIRT_STEP_MS,
  firstKillT, firstEnemyProjT,
  maxEnemies, maxEnemyProj, maxHeroProj,
  minHp,
  killsPerMinute: kpm,
  levelUps, levelUpGaps: gaps,
  timeline,
  final,
  consoleErrors: consoleErrors.slice(0, 20),
  consoleWarns: consoleWarns.slice(0, 10),
};
fs.writeFileSync('tools/playtest-diag-out.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, timeline: `(${timeline.length} samples, see tools/playtest-diag-out.json)` }, null, 1));
