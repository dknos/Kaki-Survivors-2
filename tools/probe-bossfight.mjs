/**
 * probe-bossfight.mjs — end-to-end play-verification of the 600s final boss.
 *
 * Per variant ('fight' = accept2 smart bot, 'still' = no-intervention):
 *   1. Start a run headless (same shims as probe-finalboss / playtest-accept2:
 *      virtual clock + seeded Math.random).
 *   2. Build a representative endgame hero by direct state manipulation:
 *      hero.level 30 (+ xpNext recurve), acquireWeapon → L8 for 5 weapons
 *      incl. the avatar signature (default avatar kitty → sig_kitty_lucky_paw,
 *      which is also the starter), dashLevel 4, hp = hpMax.
 *   3. Clock-jump state.time.game to --jump (default 595). The 150/330/480
 *      miniboss beats all fire on the jump — a page-side per-frame watcher
 *      NUKES minibosses (damageEnemy 1e9) until the final boss spawns so the
 *      measured fight is the Nightmare alone (a real endgame run would have
 *      killed them already).
 *   4. Fight (or stand still) until victory / death / --until game-sec.
 *
 * Page-side rAF watcher measures (independent of the slow node poll):
 *   - finalboss spawn t + hp/hpMax/spd
 *   - every telegraph windup start (t, patternIdx, windup, enraged flag)
 *     → cadence deltas pre/post enrage (banner + behavior cross-check)
 *   - enrage flip (t, hp fraction, spd after ×1.12)
 *   - hero hp drops (each hit: t, dmg) + 1s-cadence trajectory (fbHp, dist, heroHp)
 *   - fb death → state.victory / dyingUntil / gameOver sequence
 * After the run ends: death-screen DOM (.kk-death-title), endRunSummary panel
 * (#kk-endrun-summary), relicDrop reward, banners.
 *
 * Usage (WSL): node tools/probe-bossfight.mjs [--variant=fight|still|both]
 *   [--jump=595] [--until=780] [--seed=boss1] [--wallcap=480000]
 *   [--out=tools/probe-bossfight.json]
 */
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/nemoclaw/');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const JUMP_TO = Number(args.jump) || 595;
const UNTIL = Number(args.until) || 780;          // game-sec hard stop (~3min fight cap)
const SEED = args.seed || 'boss1';
const WALL_CAP_MS = Number(args.wallcap) || 480000; // per variant
// Victory-machinery mode: multiply hero dmg so the bot's ~91 boss-dps becomes
// enough to actually kill the Nightmare inside the cap (honest runs cap out
// at ~43% boss hp). NOT a balance measurement — only for verifying enrage +
// victory wiring end-to-end. Kill still flows through real weapon damage.
const DMGBOOST = Number(args.dmgboost) || 1;
const OUT = args.out || 'tools/probe-bossfight.json';
const VARIANTS = (args.variant && args.variant !== 'both') ? [args.variant] : ['fight', 'still'];
const PARTIAL = OUT.replace(/\.json$/, '.partial.jsonl');
fs.writeFileSync(PARTIAL, '');
const stream = (obj) => { try { fs.appendFileSync(PARTIAL, JSON.stringify(obj) + '\n'); } catch (_) {} };

// ── shared in-page helpers (injected per variant) ───────────────────────────
const DIRS = [
  ['KeyW'], ['KeyW', 'KeyD'], ['KeyD'], ['KeyS', 'KeyD'],
  ['KeyS'], ['KeyS', 'KeyA'], ['KeyA'], ['KeyA', 'KeyW'],
];
// Inverse of hero.js's iso remap — see playtest-accept2.mjs.
function octantToward(hx, hz, tx, tz) {
  const wx = tx - hx, wz = tz - hz;
  const ang = Math.atan2(wx + wz, wx - wz);
  return ((Math.round((ang + Math.PI / 2) / (Math.PI / 4)) % 8) + 8) % 8;
}
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : +(((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(2));
};

async function runVariant(variant) {
  const consoleErrors = [];
  const consoleWarns = [];
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    if (m.type() === 'warning') consoleWarns.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

  // Deterministic Math.random — same rationale as playtest-accept2.mjs.
  await page.addInitScript(`(() => {
    let h = 1779033703;
    const s = ${JSON.stringify(SEED)};
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    Math.random = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })()`);

  // Virtual clock pump — mirrors probe-finalboss.mjs.
  await page.addInitScript(`(() => {
    let virt = 0;
    performance.now = () => virt;
    let cbs = [];
    window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
    window.cancelAnimationFrame = () => {};
    const pump = () => {
      virt += 33;
      const run = cbs; cbs = [];
      for (const cb of run) { try { cb(virt); } catch (e) { console.error('rAF cb', e && e.stack ? e.stack.split('\\n').slice(0, 3).join(' | ') : e); } }
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
  stream({ ev: 'run-started', variant, wall: (Date.now() - wall0) / 1000 });

  // Let lazy GLB/asset fetches land before the jump — run 1 of this probe lost
  // ALL boss spawns (mini + final, zero entities despite warn banners firing)
  // in a browser instance that logged net::ERR_TIMED_OUT + GLB fetch failures.
  await page.waitForTimeout(6000);

  // ── Build the endgame hero + install instrumentation, then jump ──────────
  const build = await page.evaluate(async () => {
    const s = window.kkState;
    s.renderer.render = function () {};   // probe never needs pixels

    const W  = await import('./src/weapons/index.js');
    const EN = await import('./src/enemies.js');
    const SM = await import('./src/state.js');
    window.__dmgEnemy = EN.damageEnemy;

    // Representative endgame build: 5 weapons at L8 incl. the avatar sig
    // (sig_kitty_lucky_paw IS the default starter, so this maxes it).
    const ids = ['sig_kitty_lucky_paw', 'orbitals', 'chain', 'frostbloom', 'sigilbell'];
    for (const id of ids) for (let i = 0; i < 8; i++) W.acquireWeapon(id);
    // Passives: a passive-less hpMax-100 hero (run 1 of this probe) dies to the
    // D9 fodder swarm in ~25s and never meets the boss. Any hero that
    // LEGITIMATELY reaches 600s carries survival passives — max 6 slots.
    const passives = ['spinach', 'armor', 'hollow', 'pummarola', 'tome', 'wings'];
    for (const id of passives) for (let i = 0; i < 5; i++) {
      try { W.applyPassive({ id }); } catch (_) {}
    }
    s.hero.level = 30;
    s.hero.xp = 0;
    try { s.hero.xpNext = SM.xpForLevel ? SM.xpForLevel(30) : 99999; } catch (_) { s.hero.xpNext = 99999; }
    s.hero.dashLevel = 4;
    s.hero.dashUnlocked = true;
    s.hero.hp = s.hero.hpMax;   // after hollow heart raised hpMax

    // Banner capture (boss warns / ENRAGED / VICTORY etc).
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

    // Heart pickups live module-private — locate via InstancedMesh color
    // (0xff3355 heart body), same trick as playtest-accept2.mjs.
    window.__heartInst = null;
    window.__findHeartInst = () => {
      if (window.__heartInst) return window.__heartInst;
      try {
        s.scene.traverse((o) => {
          if (!window.__heartInst && o.isInstancedMesh && o.material && o.material.color &&
              o.material.color.getHex() === 0xff3355) window.__heartInst = o;
        });
      } catch (_) {}
      return window.__heartInst;
    };

    // ── Per-frame watcher: spawn / windups / enrage / hp drops / traj ──────
    const bf = window.__bf = {
      spawn: null, fbDeath: null, enrage: null,
      windups: [], heroDrops: [], traj: [],
      nukedMinis: 0, prevHp: s.hero.hp, trajNext: 0, lastWindup: -1,
      enrageSpdBefore: null, lastResolveT: null, prevWindupActive: false,
    };
    const tick = () => {
      try {
        const t = s.time.game;
        let fb = null;
        for (const e of s.enemies.active) {
          if (!e || !e.alive) continue;
          if (e.isFinalBoss) { fb = e; continue; }
          // Pre-fight cleanup: the 595-jump dumps all 3 miniboss beats at
          // once. Nuke them until the final boss exists so the measured
          // fight is the Nightmare alone.
          if (e.isMiniBoss && !bf.spawn) {
            try { window.__dmgEnemy(e, 1e9, 'probe_nuke'); bf.nukedMinis++; } catch (_) {}
          }
        }
        if (fb && !bf.spawn) {
          bf.spawn = {
            t: +t.toFixed(2), hp: Math.round(fb.hp),
            hpMax: Math.round(fb.hpMax || fb.hp), spd: +((fb.spd || 0)).toFixed(2),
          };
          bf.enrageSpdBefore = +((fb.spd || 0)).toFixed(2);
        }
        if (fb) {
          // Telegraph-resolve tracking: windup active → idle = pattern just
          // fired. Hero hp drops within ~0.6s of this are telegraph hits.
          const wActive = fb._windupStart > 0;
          if (bf.prevWindupActive && !wActive) bf.lastResolveT = t;
          bf.prevWindupActive = wActive;
          if (fb._windupStart > 0 && fb._windupStart !== bf.lastWindup) {
            bf.lastWindup = fb._windupStart;
            if (bf.windups.length < 200) bf.windups.push({
              t: +fb._windupStart.toFixed(2), pat: fb._activePatternIdx,
              windup: fb._activeWindup, enraged: !!fb._enraged50,
              nextTellAt: fb._nextTellAt != null ? +fb._nextTellAt.toFixed(2) : null,
            });
          }
          if (fb._enraged50 && !bf.enrage) {
            bf.enrage = {
              t: +t.toFixed(2), fbHp: Math.round(fb.hp),
              frac: +(fb.hp / (fb.hpMax || 1)).toFixed(3),
              spdBefore: bf.enrageSpdBefore, spdAfter: +((fb.spd || 0)).toFixed(2),
            };
          }
          if (t >= bf.trajNext && bf.traj.length < 500) {
            bf.trajNext = t + 1.0;
            const dx = fb.mesh.position.x - s.hero.pos.x;
            const dz = fb.mesh.position.z - s.hero.pos.z;
            bf.traj.push({
              t: +t.toFixed(1), fbHp: Math.round(fb.hp),
              dist: +Math.hypot(dx, dz).toFixed(1), heroHp: +s.hero.hp.toFixed(1),
            });
          }
        } else if (bf.spawn && !bf.fbDeath) {
          bf.fbDeath = {
            t: +t.toFixed(2), victory: !!s.victory, gameOver: !!s.gameOver,
            dyingUntil: s.dyingUntil, timeReal: +s.time.real.toFixed(2),
            heroHp: +s.hero.hp.toFixed(1),
          };
        }
        const hp = s.hero.hp;
        if (hp < bf.prevHp - 0.5 && bf.heroDrops.length < 400) {
          bf.heroDrops.push({
            t: +t.toFixed(2), dmg: +(bf.prevHp - hp).toFixed(1), hpAfter: +hp.toFixed(1),
            dtResolve: bf.lastResolveT != null ? +(t - bf.lastResolveT).toFixed(2) : null,
          });
        }
        bf.prevHp = hp;
      } catch (_) {}
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);

    // ── node-poll snapshot ────────────────────────────────────────────────
    window.__snap = () => {
      try { s.camera.updateMatrixWorld(true); } catch (_) {}
      let fb = null, alive = 0, mbAlive = 0;
      let nearest = null, nearD2 = Infinity;
      const hp = s.hero.pos;
      for (const e of s.enemies.active) {
        if (!e || !e.alive) continue;
        alive++;
        if (e.isMiniBoss) mbAlive++;
        if (e.isFinalBoss) fb = e;
        const ep = e.mesh ? e.mesh.position : e.pos;
        if (ep) {
          const dx = ep.x - hp.x, dz = ep.z - hp.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < nearD2) { nearD2 = d2; nearest = ep; }
        }
      }
      // Aim at the final boss when alive, else nearest enemy.
      let aim = null;
      const tgt = fb && fb.mesh ? fb.mesh.position : nearest;
      if (tgt && s.camera && s.renderer) {
        try {
          const v = tgt.clone().project(s.camera);
          const r = s.renderer.domElement.getBoundingClientRect();
          aim = { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (-v.y + 1) / 2 * r.height };
        } catch (_) {}
      }
      // Reactive-dash sense (accept2): enemy bolt within 4u and closing.
      let dashThreat = false;
      for (const p of s.enemyProjectiles.active) {
        if (!p || !p.mesh) continue;
        const dx = hp.x - p.mesh.position.x, dz = hp.z - p.mesh.position.z;
        if (dx * dx + dz * dz > 16) continue;
        if ((p.vx || 0) * dx + (p.vz || 0) * dz > 0) { dashThreat = true; break; }
      }
      // Nearest heart (accept2 trick).
      let heart = null;
      const hi = window.__findHeartInst();
      if (hi) {
        const arr = hi.instanceMatrix.array;
        let hd2 = Infinity, hx2 = 0, hz2 = 0;
        for (let i = 0; i < hi.count; i++) {
          const o = i * 16;
          const sc2 = arr[o] * arr[o] + arr[o + 1] * arr[o + 1] + arr[o + 2] * arr[o + 2];
          if (sc2 < 1e-6 || arr[o + 13] < -100) continue;
          const dx = arr[o + 12] - hp.x, dz = arr[o + 14] - hp.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < hd2) { hd2 = d2; hx2 = arr[o + 12]; hz2 = arr[o + 14]; }
        }
        if (hd2 < Infinity) heart = { x: +hx2.toFixed(1), z: +hz2.toFixed(1), d: +Math.sqrt(hd2).toFixed(1) };
      }
      // Ranked draft pick (accept2 iter-3 rules).
      let bestChoiceIdx = null;
      if (s.pendingLevelUp && s.levelUpChoices && s.levelUpChoices.length) {
        const ownedW = new Set(s.weapons.map(w => w.id));
        const fc = s.hero.fillerCounts || {};
        const evoAdv = { echo: 1, steadfast: 1, magnet: 1, cooldown: 1 };
        const rank = (c) => {
          if (c.kind === 'evolution') return 0;
          if (c.kind === 'weapon') return ownedW.has(c.id) ? 1 : 2;
          if (c.kind === 'filler' && (fc[c.id] || 0) > 0) return 1;
          if (c.kind === 'active') return 3;
          if (c.kind === 'passive') return 4;
          return 5;
        };
        let bestR = 99, bestS = 99;
        s.levelUpChoices.forEach((c, i) => {
          const r = rank(c);
          const sub = ((c.kind === 'passive' || c.kind === 'filler') && evoAdv[c.id]) ? 0 : 1;
          if (r < bestR || (r === bestR && sub < bestS)) { bestR = r; bestS = sub; bestChoiceIdx = i; }
        });
      }
      return {
        t: +s.time.game.toFixed(2), paused: s.time.paused, pending: s.pendingLevelUp,
        hp: +s.hero.hp.toFixed(1), hpMax: s.hero.hpMax, level: s.hero.level,
        enemies: alive, mbAlive, fbAlive: !!fb, fbHp: fb ? Math.round(fb.hp) : null,
        victory: !!s.victory, gameOver: !!s.gameOver,
        roomState: s.run.roomState, lockdown: !!s.run.lockdownActive,
        hx: +hp.x.toFixed(1), hz: +hp.z.toFixed(1),
        aim, dashThreat, heart, bestChoiceIdx,
        deathDom: !!document.querySelector('.kk-death-title'),
        summaryDom: !!document.getElementById('kk-endrun-summary'),
      };
    };

    return {
      weapons: s.weapons.map(w => w.id + ':' + w.level),
      passives: s.passives.map(p => p.id + ':' + p.level),
      level: s.hero.level, dashLevel: s.hero.dashLevel,
      hp: s.hero.hp, hpMax: s.hero.hpMax,
      avatar: s.run.avatar, starter: s.run.starterWeapon,
    };
  });
  stream({ ev: 'hero-built', variant, build });

  if (DMGBOOST > 1) {
    await page.evaluate((b) => { window.kkState.hero.statMul.dmg *= b; }, DMGBOOST);
  }

  // Clock jump → 595. Watcher + spawn director take it from here.
  await page.evaluate((jumpTo) => { window.kkState.time.game = jumpTo; }, JUMP_TO);

  // ── bot loop ──────────────────────────────────────────────────────────────
  let heldKeys = [];
  async function setDir(keys) {
    for (const k of heldKeys) if (!keys.includes(k)) await page.keyboard.up(k);
    for (const k of keys) if (!heldKeys.includes(k)) await page.keyboard.down(k);
    heldKeys = keys;
  }
  if (variant === 'fight') {
    await page.mouse.move(640, 360);
    await page.mouse.down();          // LMB hold-to-fire, never released
    await setDir(DIRS[0]);
  }

  let dirIdx = 0, lastDirT = 0, lastDashT = 0, lastCastT = 0, heartSeekUntil = -1;
  const levelUps = [];
  const samples = [];
  let nextSampleT = 0;
  let minHp = 1e9, minHpT = null;
  let endReason = 'until-cap';
  while (true) {
    if (Date.now() - wall0 > WALL_CAP_MS) { endReason = 'wall-cap'; break; }
    let s;
    try { s = await page.evaluate(() => window.__snap()); }
    catch (e) { endReason = 'snap-failed: ' + String(e).slice(0, 120); break; }

    if (s.victory || s.gameOver) {
      endReason = s.victory ? 'victory' : 'hero-died';
      samples.push(s); stream({ variant, ...s });
      break;
    }
    if (s.pending) {
      const idx = (variant === 'fight' && s.bestChoiceIdx != null) ? Math.min(s.bestChoiceIdx, 2) : 0;
      await page.keyboard.press('Digit' + (idx + 1));
      levelUps.push({ t: s.t, idx });
      await page.waitForTimeout(80);
      continue;
    }
    if (s.paused) {
      await page.keyboard.press('Digit1');
      await page.waitForTimeout(60);
      await page.keyboard.press('Space');
      await page.waitForTimeout(100);
      continue;
    }
    if (s.t >= UNTIL) { endReason = 'until-cap'; samples.push(s); break; }

    if (s.hp < minHp) { minHp = s.hp; minHpT = s.t; }
    if (s.t >= nextSampleT) {
      samples.push(s); stream({ variant, t: s.t, hp: s.hp, fbHp: s.fbHp, enemies: s.enemies });
      nextSampleT = Math.floor(s.t / 2) * 2 + 2;
    }

    if (variant === 'fight') {
      if (s.aim) {
        const x = Math.max(8, Math.min(1272, s.aim.x));
        const y = Math.max(8, Math.min(712, s.aim.y));
        try { await page.mouse.move(x, y); } catch (_) {}
      }
      // Heart seeking (accept2): hurt + heart in range → steer at it.
      if (s.hp < s.hpMax * 0.5 && s.heart && s.heart.d <= 25) heartSeekUntil = Math.max(heartSeekUntil, s.t + 2);
      if (s.t < heartSeekUntil && s.heart) {
        const ni = octantToward(s.hx, s.hz, s.heart.x, s.heart.z);
        if (ni !== dirIdx) { dirIdx = ni; await setDir(DIRS[dirIdx]); }
        lastDirT = s.t;
      } else if (s.t - lastDirT > 1.5) {
        dirIdx = (dirIdx + 1) % DIRS.length;
        await setDir(DIRS[dirIdx]);
        lastDirT = s.t;
      }
      // Smart dash: imminent bolt → dash now; else blind 3s cadence.
      if ((s.dashThreat && s.t - lastDashT > 0.8) || s.t - lastDashT > 3) {
        await page.keyboard.down('ShiftLeft');
        await page.waitForTimeout(40);
        await page.keyboard.up('ShiftLeft');
        lastDashT = s.t;
      }
      if (s.t - lastCastT > 12) {
        try { await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); } catch (_) {}
        lastCastT = s.t;
      }
    }
    await page.waitForTimeout(150);
  }

  // Let the dying/victory anim play out → death screen + summary DOM.
  if (endReason === 'victory' || endReason === 'hero-died') {
    await page.waitForFunction(
      () => !!document.querySelector('.kk-death-title') || !!document.getElementById('kk-endrun-summary'),
      null, { timeout: 30000 }
    ).catch(() => {});
    await page.waitForTimeout(1500); // let banners/summary fill in
  }

  // ── final capture ─────────────────────────────────────────────────────────
  const bf = await page.evaluate(() => window.__bf).catch(() => null);
  const banners = await page.evaluate(() => window.__banners || []).catch(() => []);
  const finale = await page.evaluate(() => {
    const s = window.kkState;
    const title = document.querySelector('.kk-death-title');
    const death = document.querySelector('.kk-death');
    const panel = document.getElementById('kk-endrun-summary');
    const byW = {};
    try {
      for (const [k, v] of Object.entries(s.run.dmgByWeapon || {})) byW[k] = Math.round(v);
    } catch (_) {}
    return {
      t: +s.time.game.toFixed(1), victory: !!s.victory, gameOver: !!s.gameOver,
      dyingUntil: s.dyingUntil, timeReal: +s.time.real.toFixed(1),
      deathShown: !!s._deathShown,
      deathTitle: title ? title.textContent : null,
      deathText: death ? death.textContent.replace(/\s+/g, ' ').slice(0, 900) : null,
      summaryShown: !!panel,
      summaryText: panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 900) : null,
      relicDrop: s.run.relicDrop || null,
      heroHp: +s.hero.hp.toFixed(1), hpMax: s.hero.hpMax, level: s.hero.level,
      dashLevel: s.hero.dashLevel,
      kills: s.run.kills, mbKills: s.run.miniBossKills || 0,
      dmgTaken: Math.round(s.run.dmgTaken || 0), dmgDealt: Math.round(s.run.dmgDealt || 0),
      dmgByWeapon: byW,
      weapons: s.weapons.map(w => w.id + ':' + w.level + (w.inst && w.inst.evolved ? ':EVO' : '')),
    };
  }).catch(() => null);
  await browser.close();

  // ── analysis ──────────────────────────────────────────────────────────────
  const spawn = bf && bf.spawn;
  const fbDeath = bf && bf.fbDeath;
  const ttk = (spawn && fbDeath) ? +(fbDeath.t - spawn.t).toFixed(1) : null;
  const windups = (bf && bf.windups) || [];
  const deltasPre = [], deltasPost = [];
  for (let i = 1; i < windups.length; i++) {
    const d = +(windups[i].t - windups[i - 1].t).toFixed(2);
    (windups[i].enraged ? deltasPost : deltasPre).push(d);
  }
  const fightDrops = (bf && bf.heroDrops || []).filter(d => spawn && d.t >= spawn.t);
  const bigHits = fightDrops.filter(d => d.dmg > 20);
  // Telegraph-attributed: hp drop within 0.6s of a boss pattern resolving.
  const telegraphHits = fightDrops.filter(d => d.dtResolve != null && d.dtResolve < 0.6);
  const fightDmg = +fightDrops.reduce((a, d) => a + d.dmg, 0).toFixed(1);
  let fightMinHp = null, fightMinHpT = null;
  for (const d of fightDrops) if (fightMinHp === null || d.hpAfter < fightMinHp) { fightMinHp = d.hpAfter; fightMinHpT = d.t; }
  const errorTypes = {};
  for (const e of consoleErrors) {
    const key = e.split('\n')[0].slice(0, 100);
    errorTypes[key] = (errorTypes[key] || 0) + 1;
  }

  return {
    variant, seed: SEED, jumpTo: JUMP_TO, dmgboost: DMGBOOST, endReason,
    wallSeconds: +((Date.now() - wall0) / 1000).toFixed(1),
    build,
    spawn, fbDeath, ttk,
    enrage: bf && bf.enrage,
    enrageBannerSeen: banners.some(b => /ENRAGED/.test(b.text)),
    windups,
    tellDeltasPreEnrage: deltasPre, tellDeltasPostEnrage: deltasPost,
    medianTellDeltaPre: median(deltasPre), medianTellDeltaPost: median(deltasPost),
    nukedMinis: bf && bf.nukedMinis,
    bossNeverSpawned: !spawn && endReason !== 'wall-cap',
    heroDropsAll: (bf && bf.heroDrops) || [],
    fightDrops, fightHitCount: fightDrops.length,
    fightBigHits: bigHits, fightBigHitCount: bigHits.length,
    telegraphHits, telegraphHitCount: telegraphHits.length,
    fightDmgTaken: fightDmg, fightMinHp, fightMinHpT,
    minHpPolled: minHp === 1e9 ? null : minHp, minHpPolledT: minHpT,
    traj: bf && bf.traj,
    levelUps,
    banners: banners.filter(b => /BOSS|FOE|ELITE|INCOMING|ENRAGED|NIGHTMARE|VICTORY|HUNTS|RETURNED/.test(b.text)),
    finale,
    samples: samples.filter((_, i) => i % 3 === 0),
    consoleErrorsCount: consoleErrors.length,
    errorTypes,
    poolEmptyWarns: consoleWarns.filter(w => w.includes('pool empty')).length,
    assetFailWarns: consoleWarns.filter(w => w.includes('[assets] failed')).length,
    consoleWarns: consoleWarns.slice(0, 10),
  };
}

const results = {};
for (const v of VARIANTS) {
  // Retry once on fatal — run 2 of this probe lost the whole fight variant to
  // a flaky "browser has been closed" during startup waitForFunction.
  for (let attempt = 1; attempt <= 2; attempt++) {
    stream({ ev: 'variant-start', variant: v, attempt });
    try { results[v] = await runVariant(v); results[v].attempt = attempt; }
    catch (e) { results[v] = { variant: v, attempt, fatal: String(e).slice(0, 400) }; }
    stream({ ev: 'variant-done', variant: v, attempt, endReason: results[v].endReason || 'fatal' });
    if (!results[v].fatal) break;
  }
}

const out = { ranAt: new Date().toISOString(), jumpTo: JUMP_TO, until: UNTIL, seed: SEED, results };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const brief = {};
for (const [k, r] of Object.entries(results)) {
  brief[k] = r.fatal ? { fatal: r.fatal } : {
    endReason: r.endReason, spawn: r.spawn, ttk: r.ttk, enrage: r.enrage,
    enrageBannerSeen: r.enrageBannerSeen,
    medianTellDeltaPre: r.medianTellDeltaPre, medianTellDeltaPost: r.medianTellDeltaPost,
    fightHitCount: r.fightHitCount, fightBigHitCount: r.fightBigHitCount,
    telegraphHitCount: r.telegraphHitCount,
    fightDmgTaken: r.fightDmgTaken, fightMinHp: r.fightMinHp,
    fbDeath: r.fbDeath,
    deathTitle: r.finale && r.finale.deathTitle, summaryShown: r.finale && r.finale.summaryShown,
    relic: r.finale && r.finale.relicDrop, wallSeconds: r.wallSeconds,
  };
}
console.log(JSON.stringify({ out: OUT, brief }, null, 1));
