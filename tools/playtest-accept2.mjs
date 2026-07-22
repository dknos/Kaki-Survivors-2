/**
 * playtest-accept2.mjs — iteration-2 acceptance playtest for Kitty Kaki Survivors.
 *
 * Extension of playtest-accept.mjs (same headless-timing shims + strategies)
 * with full-arc instrumentation for the 10-minute run:
 *   - miniboss spawn/death events (isMiniBoss entities + run.miniBossKills)
 *   - final boss spawn/death (isFinalBoss entity + state.victory)
 *   - evolution events: offers seen in the draft, achieved evolutions
 *     (weapon inst.evolved / hero.dashEvolved / run.hasEvolvedThisRun)
 *   - hero level timeline (t -> level)
 *   - primary damage share of player-weapon damage
 *   - console error TYPES deduped (baseline = SwiftShader 'trim' TypeError)
 *   - slot-machine outcomes (chest modal result line, e.g. "PAIR 🕸️ — WEB +2 → Lv 5")
 *
 * Iter-3 circle bot (facetank unchanged):
 *   - draft ranking: evolution > owned weapon/filler upgrade > new weapon > passive
 *   - smart dash: enemy bolt within 4u and closing → dash (perfect-dodge absorb)
 *   - heart seeking: hp<50% + heart within 25u → steer the orbit at it for 2s
 *
 * Usage (WSL): cd ~/kitty-kaki-survivors && node tools/playtest-accept2.mjs \
 *     [--strategy=circle|facetank] [--out=tools/out.json] [--seed=diag1]
 *     [--target=660] [--wallcap=2700000]
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
const OUT = args.out || `tools/playtest-accept2-${STRATEGY}.json`;
const SEED = args.seed || 'diag1';
const TARGET_GAME_SEC = Number(args.target) || 660;
const WALL_CAP_MS = Number(args.wallcap) || 2700000;
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

// Deterministic Math.random — the game's ?seed= URL param only preselects
// stage/char (and daily mode only pins the spawn stream); damage variance,
// crits, and drops all use raw Math.random. Without this, "seeded" accept
// runs swing wildly (same config: deaths at 134s..660s-alive) and tuning
// chases noise. mulberry32 keyed off the --seed string.
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
  // Banner capture — showBanner divs are anonymous; watch body for short
  // ALL-CAPS text nodes (catches boss warns/names + some modal noise).
  window.__banners = [];
  const obs = new MutationObserver((muts) => {
    if (window.__banners.length > 300) return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.textContent) {
        const txt = n.textContent.trim();
        if (txt.length > 2 && txt.length < 80 && /[A-Z]{3}/.test(txt)) {
          window.__banners.push({ t: +st.time.game.toFixed(1), text: txt.slice(0, 70) });
        }
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  window.__diagFrames = 0;
  const cnt = () => { window.__diagFrames++; requestAnimationFrame(cnt); };
  requestAnimationFrame(cnt);
  window.__diagRealRender = st.renderer.render.bind(st.renderer);
  window.__diagRenderOn = false;
  st.renderer.render = function (...a) { if (window.__diagRenderOn) return window.__diagRealRender(...a); };

  // Heart pickups live in a module-private array (src/pickups.js _hearts) with
  // no state/export accessor — read positions off the heart InstancedMesh
  // instead. 0xff3355 is unique to the heart body material; hidden slots are
  // parked at y=-1000 with zero scale.
  window.__heartInst = null;
  window.__findHeartInst = () => {
    if (window.__heartInst) return window.__heartInst;
    try {
      st.scene.traverse((o) => {
        if (!window.__heartInst && o.isInstancedMesh && o.material && o.material.color &&
            o.material.color.getHex() === 0xff3355) window.__heartInst = o;
      });
    } catch (_) {}
    return window.__heartInst;
  };

  window.__diagSnap = () => {
    const s = window.kkState;
    try { s.camera.updateMatrixWorld(true); } catch (_) {}
    let alive = 0, elites = 0;
    let nearest = null, nearD2 = Infinity;
    const miniIdx = [];
    let fbAlive = false, fbHp = null;
    const hp = s.hero.pos;
    for (const e of s.enemies.active) {
      if (!e || !e.alive) continue;
      alive++;
      if (e.elite || e.isMiniBoss) elites++;
      if (e.isMiniBoss) miniIdx.push(e._patternIdx != null ? e._patternIdx : -1);
      if (e.isFinalBoss) { fbAlive = true; fbHp = Math.round(e.hp); }
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
    const evolved = [];
    for (const w of s.weapons) if (w && w.inst && w.inst.evolved) evolved.push(w.id);
    if (s.hero.dashEvolved) evolved.push('dash');

    // ── iter-3 bot senses ────────────────────────────────────────────────
    // Dash threat: any enemy bolt within 4u of the hero AND closing
    // (velocity dot hero-direction > 0).
    let dashThreat = false;
    for (const p of s.enemyProjectiles.active) {
      if (!p || !p.mesh) continue;
      const dx = hp.x - p.mesh.position.x, dz = hp.z - p.mesh.position.z;
      if (dx * dx + dz * dz > 16) continue;
      if ((p.vx || 0) * dx + (p.vz || 0) * dz > 0) { dashThreat = true; break; }
    }
    // Nearest live heart pickup (see __findHeartInst note above).
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
    // Draft ranking: evolution(0) > owned weapon/filler upgrade(1) >
    // new weapon(2) > active(3) > passive(4) > rest(5). Active sits above
    // passive because an empty cast slot pins 'nova' to draft slot 0 forever
    // (weaponChoices pity) — never taking it both wastes the RMB cast and
    // shrinks every draft to 2 effective cards. Within a rank prefer cards
    // that advance an evolution gate (echo/steadfast passives,
    // magnet/cooldown fillers) so maxed bases actually reach their evo card.
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
    // Slot-machine result line (chest treasure modal): locate the modal via
    // its fixed subtitle text, then the sibling div carrying the outcome.
    let slotText = null;
    try {
      for (const d of document.querySelectorAll('div')) {
        if (d.textContent === 'Spin the reels of fortune' && d.parentElement) {
          for (const c of d.parentElement.children) {
            if (c !== d && c.tagName === 'DIV' && /JACKPOT|TRIPLE|PAIR|BUSTED|Rolling|—/.test(c.textContent)) {
              slotText = c.textContent.slice(0, 90);
              break;
            }
          }
          break;
        }
      }
    } catch (_) {}

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
      miniIdx, fbAlive, fbHp,
      mbAlive: miniIdx.length,
      roomState: s.run.roomState,
      lockdown: !!s.run.lockdownActive,
      mbKills: s.run.miniBossKills || 0,
      victory: !!s.victory,
      hasEvolved: !!s.run.hasEvolvedThisRun,
      evolved,
      nearestDist: nearest ? +Math.sqrt(nearD2).toFixed(1) : null,
      heroProj: s.projectiles.active.length,
      enemyProj: s.enemyProjectiles.active.length,
      gems: s.gems.list.filter(g => g.active).length,
      gameOver: s.gameOver,
      frames: window.__diagFrames,
      activeAbility: s.hero.active && s.hero.active.id,
      aim,
      hx: +hp.x.toFixed(1), hz: +hp.z.toFixed(1),
      dashThreat, heart, bestChoiceIdx, slotText,
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

// Inverse of hero.js's iso remap (worldX=(mvx+mvy)·k, worldZ=(mvy−mvx)·k):
// the input-space vector toward world (tx,tz) is (wx−wz, wx+wz). Octant 0 = KeyW.
function octantToward(hx, hz, tx, tz) {
  const wx = tx - hx, wz = tz - hz;
  const ang = Math.atan2(wx + wz, wx - wz);
  return ((Math.round((ang + Math.PI / 2) / (Math.PI / 4)) % 8) + 8) % 8;
}
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
const bossEvents = [];
const evolutionEvents = [];
const slotOutcomes = [];
let lastSlotText = null;
let heartSeekUntil = -1;
const evoOffersSeen = new Set();
const evolvedSeen = new Set();
let mbSpawnedSeen = 0;   // cumulative spawns = alive + killed (entities are stripped of _patternIdx)
let lastMbKills = 0;
let fbSpawned = false, fbDead = false;
let nextSampleT = 0;
let lastDirT = 0, lastDashT = 0, lastCastT = 0;
let firstKillT = null;
let firstEnemyProjT = null;
let maxEnemies = 0, maxEnemyProj = 0, maxHeroProj = 0;
let minHp = 1e9, minHpT = null;
let deathT = null;
let endReason = 'target-reached';

function pick(s) {
  return {
    t: s.t, hp: s.hp, level: s.level, kills: s.kills,
    enemies: s.enemies, elites: s.elites, nearestDist: s.nearestDist,
    heroProj: s.heroProj, enemyProj: s.enemyProj, gems: s.gems,
    dmgTaken: s.dmgTaken, frames: s.frames, active: s.activeAbility,
    mbKills: s.mbKills, mbAlive: s.mbAlive, fbAlive: s.fbAlive,
    room: s.roomState + ':' + (s.lockdown ? 'LOCK' : '-'),
  };
}

function trackEvents(s) {
  const mbCum = s.mbAlive + s.mbKills;
  while (mbSpawnedSeen < mbCum) {
    mbSpawnedSeen++;
    bossEvents.push({ ev: 'miniboss-spawn', n: mbSpawnedSeen, t: s.t });
    stream({ ev: 'miniboss-spawn', n: mbSpawnedSeen, t: s.t });
  }
  if (s.mbKills > lastMbKills) {
    bossEvents.push({ ev: 'miniboss-death', n: s.mbKills, t: s.t });
    stream({ ev: 'miniboss-death', n: s.mbKills, t: s.t });
    lastMbKills = s.mbKills;
  }
  if (s.fbAlive && !fbSpawned) {
    fbSpawned = true;
    bossEvents.push({ ev: 'finalboss-spawn', t: s.t, hp: s.fbHp });
    stream({ ev: 'finalboss-spawn', t: s.t, hp: s.fbHp });
  }
  if (s.victory && !fbDead) {
    fbDead = true;
    bossEvents.push({ ev: 'finalboss-death', t: s.t });
    stream({ ev: 'finalboss-death', t: s.t });
  }
  for (const id of s.evolved) {
    if (!evolvedSeen.has(id)) {
      evolvedSeen.add(id);
      evolutionEvents.push({ ev: 'evolved', id, t: s.t });
      stream({ ev: 'evolved', id, t: s.t });
    }
  }
  if (s.choices) {
    for (const c of s.choices) {
      if (c.startsWith('evolution:') && !evoOffersSeen.has(c)) {
        evoOffersSeen.add(c);
        evolutionEvents.push({ ev: 'evo-offered', id: c.slice(10), t: s.t });
        stream({ ev: 'evo-offered', id: c.slice(10), t: s.t });
      }
    }
  }
}

while (true) {
  if (Date.now() - wallRunStart > WALL_CAP_MS) { endReason = 'wall-cap'; break; }

  let s;
  try { s = await page.evaluate(() => window.__diagSnap()); }
  catch (e) { endReason = 'snap-failed: ' + String(e).slice(0, 120); break; }

  trackEvents(s);

  // Slot outcomes (T-chests): record the resolved result line once per modal.
  if (s.slotText && s.slotText !== 'Rolling…' && s.slotText !== lastSlotText) {
    lastSlotText = s.slotText;
    slotOutcomes.push({ t: s.t, text: s.slotText });
    stream({ ev: 'slot-outcome', t: s.t, text: s.slotText });
  }
  if (!s.slotText) lastSlotText = null;

  if (s.gameOver) { endReason = 'hero-died'; deathT = s.t; timeline.push(pick(s)); stream(pick(s)); break; }
  if (s.victory) { endReason = 'victory'; timeline.push(pick(s)); stream(pick(s)); break; }
  if (s.t >= TARGET_GAME_SEC) { timeline.push(pick(s)); stream(pick(s)); break; }

  maxEnemies = Math.max(maxEnemies, s.enemies);
  maxEnemyProj = Math.max(maxEnemyProj, s.enemyProj);
  maxHeroProj = Math.max(maxHeroProj, s.heroProj);
  if (s.hp < minHp) { minHp = s.hp; minHpT = s.t; }
  if (firstKillT === null && s.kills > 0) firstKillT = s.t;
  if (firstEnemyProjT === null && s.enemyProj > 0) firstEnemyProjT = s.t;

  if (s.pending) {
    // Iter-3 circle bot drafts by rank (see __diagSnap); facetank keeps the
    // legacy first-card pick. Clamp to Digit3 — ui.js only binds 3 hotkeys
    // (casino bonus can show a 4th card the keyboard can't reach).
    const idx = (STRATEGY === 'circle' && s.bestChoiceIdx != null) ? Math.min(s.bestChoiceIdx, 2) : 0;
    const picked = s.choices && s.choices[idx];
    await page.keyboard.press('Digit' + (idx + 1));
    levelUps.push({ t: s.t, toLevel: s.level + 1, picked, idx, queue: s.pendingCount });
    stream({ ev: 'levelup', t: s.t, picked, idx, choices: s.choices });
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
    // Heart seeking: hurt + heart in range → steer the orbit at it for 2s
    // (re-armed every poll while still hurt, so it chases until healed).
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
    // Smart dash: imminent enemy bolt → dash now (perfect-dodge absorbs);
    // otherwise keep the blind 3s cadence. 0.8s floor stops poll-rate spam.
    if ((s.dashThreat && s.t - lastDashT > 0.8) || s.t - lastDashT > 3) {
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
let banners = null;
try { banners = await page.evaluate(() => window.__banners || null); } catch (_) {}
try {
  final = await page.evaluate(() => {
    const s = window.kkState;
    return {
      t: +s.time.game.toFixed(1),
      mode: s.mode, gameOver: s.gameOver, victory: s.victory,
      level: s.hero.level, hp: +s.hero.hp.toFixed(1), hpMax: s.hero.hpMax,
      kills: s.run.kills,
      miniBossKills: s.run.miniBossKills || 0,
      hasEvolvedThisRun: !!s.run.hasEvolvedThisRun,
      dmgDealt: Math.round(s.run.dmgDealt), dmgTaken: Math.round(s.run.dmgTaken),
      dmgByWeapon: Object.fromEntries(Object.entries(s.run.dmgByWeapon || {}).map(([k, v]) => [k, Math.round(v)])),
      weapons: s.weapons.map(w => w.id + ':' + w.level + (w.inst && w.inst.evolved ? ':EVO' : '')),
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
const dmgPrimary = byW.primary || 0;
const primaryPctOfWeapons = dmgWeapon ? +(100 * dmgPrimary / dmgWeapon).toFixed(1) : null;
// console error types deduped (baseline = SwiftShader 'trim' TypeError noise)
const errorTypes = {};
for (const e of consoleErrors) {
  const key = e.split('\n')[0].slice(0, 120);
  errorTypes[key] = (errorTypes[key] || 0) + 1;
}

const out = {
  ranAt: new Date().toISOString(),
  strategy: STRATEGY,
  seed: SEED,
  targetGameSec: TARGET_GAME_SEC,
  wallSeconds: +wallTotal.toFixed(1),
  endReason, deathT,
  identityCheck: ident,
  virtClockStepMs: VIRT_STEP_MS,
  firstKillT, firstEnemyProjT,
  maxEnemies, maxEnemyProj, maxHeroProj,
  minHp, minHpT,
  bossEvents,
  evolutionEvents,
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
    primary: dmgPrimary, primaryPctOfPlayerWeapons: primaryPctOfWeapons,
  },
  slotOutcomes,
  timeline,
  final,
  banners,
  errorTypes,
  poolEmptyWarns: consoleWarns.filter(w => w.includes('pool empty')).length,
  poolEmptyWarnSamples: consoleWarns.filter(w => w.includes('pool empty')).slice(0, 5),
  consoleErrors: consoleErrors.slice(0, 30),
  consoleWarns: consoleWarns.slice(0, 10),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, timeline: `(${timeline.length} samples, see ${OUT})`, levelUps: `(${levelUps.length} level-ups, see ${OUT})`, consoleErrors: `(${consoleErrors.length} errors, deduped in errorTypes)` }, null, 1));
