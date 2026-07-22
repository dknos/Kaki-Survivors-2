/**
 * Per-stage gameplay rules ("stage modifiers" — Vampire-Survivors style).
 *
 * Each map plays differently:
 *
 *  - **forest / Overgrowth**   — enemies spawn 25% closer; every 10s a 1s
 *                                  "spore pulse" slows all enemies 40% (green tint).
 *  - **twilight / Witching Hour** — every 30s a 5s night surge: fog shrinks,
 *                                  spawn rate doubles, XP gems worth 2x.
 *  - **cinder / Eruption**     — every 20s, 3–5 lava puddles erupt within 12u
 *                                  of hero. Kills <3u from a puddle drop a bonus heart.
 *  - **void / Reaper's Toll**  — hero loses 1 HP every 8s (clamps to 1); every
 *                                  25 kills regain 5 HP. Aggression rewarded.
 *
 * Wiring points (in main.js / loop):
 *   applyStageRule(stageId, state)  → called in _primeRunStart after stage select
 *   tickStageRule(state, dt)        → called once per frame in the run tick
 *   clearStageRule(state)           → called in _teardownActiveRun
 *
 * Rule effects expose themselves via flag fields on state.run so that the
 * existing enemy/spawn/xp/hazard subsystems can opt-in with one-line checks:
 *
 *   state.run.stageRuleEnemySlow   (number ≤1)  — multiplied into enemy seek
 *   state.run.stageRuleXpMul       (number ≥1)  — multiplied into gem pickup
 *   state.run.stageRuleSpawnMul    (number ≥1)  — multiplied into target swarm
 *   state.run.stageRuleSpawnRingMul(number)     — radius multiplier on spawnOnRing
 *   state.run.twilightSurge        (bool)       — stageHazards reads to tighten fog
 *
 * The banner is a single absolutely-positioned div created once at first
 * invocation and reused.
 */
import { pushBubble } from './chatBubble.js';
import { spawnLavaPuddle, isNearLiveLava } from './stageHazards.js';
import { spawnHeart } from './pickups.js';
import { state } from './state.js';

// ── HUD banner (separate from ui.js' showBanner so we don't compete with
//    elite/boss warnings). Subtle paper-ribbon under the timer.
let _banner = null;
let _bannerText = null;
let _bannerSub = null;
let _bannerHideAt = 0;

function _centerHudBlocked() {
  if (state.run && state.run._bossIntroActive) return true;
  if (typeof document === 'undefined') return false;
  const boss = document.getElementById('kk-boss-intro-banner');
  if (boss && boss.classList.contains('kk-bi-show') && boss.style.opacity !== '0') return true;
  const bossBars = document.getElementById('kk-forest-bossbars');
  if (bossBars && bossBars.querySelector('.kk-bb-row.kk-bb-show')) return true;
  const evolve = document.getElementById('kk-evolve-cin-banner');
  if (evolve && evolve.classList.contains('kk-ec-show') && evolve.style.opacity !== '0') return true;
  // The shared notice rail sits immediately below this ribbon. Even though
  // their boxes no longer overlap, showing both recreates the dense wall of
  // centre-screen copy this hierarchy is meant to remove. Yield for the
  // shared banner's brief lease, then resume only if our own deadline remains.
  const shared = document.querySelector('.kk-shared-banner');
  return !!(shared && shared.isConnected);
}

function _ensureBanner() {
  if (_banner) return _banner;
  const div = document.createElement('div');
  div.id = 'kk-stage-rule-banner';
  div.style.cssText = `
    position: fixed; top: 82px; left: 50%; transform: translateX(-50%);
    pointer-events: none; z-index: 86;
    padding: 8px 18px 9px;
    background: linear-gradient(145deg, rgba(46,30,40,.94), rgba(21,15,22,.95));
    border: 1px solid var(--kk-hud-line, rgba(255,226,188,.30));
    border-top-color: rgba(255,245,226,.42);
    border-radius: 13px;
    box-shadow: var(--kk-hud-shadow, 0 14px 34px rgba(14,7,12,.46)), inset 0 1px 0 rgba(255,255,255,.07);
    backdrop-filter: blur(12px) saturate(125%); -webkit-backdrop-filter: blur(12px) saturate(125%);
    text-align: center; min-width: 260px; max-width: 92vw; box-sizing: border-box;
    opacity: 0; transition: opacity 0.24s ease, transform 0.24s ease;
    font-family: 'Geist', sans-serif;
  `;
  const title = document.createElement('div');
  title.style.cssText = 'font-size:10px;letter-spacing:.23em;color:var(--kk-hud-honey,#ffd18b);text-transform:uppercase;font-weight:900;';
  const sub = document.createElement('div');
  sub.style.cssText = "font-family:'Geist',sans-serif;font-size:10px;font-weight:600;color:var(--kk-hud-muted,rgba(255,240,220,.64));letter-spacing:.035em;margin-top:3px;";
  div.appendChild(title);
  div.appendChild(sub);
  document.body.appendChild(div);
  _banner = div;
  _bannerText = title;
  _bannerSub = sub;
  return div;
}

function _showBanner(text, sub, durationSec = 3) {
  _ensureBanner();
  _bannerText.textContent = text;
  _bannerSub.textContent = sub || '';
  // Boss/evolution cinematics own the centre lane. Keep the rule's deadline
  // running so a one-second pulse cannot reappear stale after the cinematic;
  // longer run-start notices may resume only for their remaining duration.
  _banner.style.opacity = _centerHudBlocked() ? '0' : '1';
  _bannerHideAt = state.time.real + durationSec;
}

function _tickBanner() {
  if (!_banner) return;
  // The banner is dormant for almost the entire run. Expire/check the cheap
  // numeric lease first so inactive frames never query three DOM owners.
  if (_bannerHideAt <= 0) return;
  if (state.time.real >= _bannerHideAt) {
    _banner.style.opacity = '0';
    _bannerHideAt = 0;
    return;
  }
  if (_centerHudBlocked()) {
    _banner.style.opacity = '0';
    return;
  }
  _banner.style.opacity = '1';
}

function _setBannerSub(text) {
  if (!_banner) return;
  _bannerSub.textContent = text || '';
}

// ── Default state.run flag reset (called on apply + clear) ─────────────────
function _resetRuleFlags(s) {
  s.run.stageRuleEnemySlow   = 1;
  s.run.stageRuleXpMul       = 1;
  s.run.stageRuleSpawnMul    = 1;
  s.run.stageRuleSpawnRingMul = 1;
  s.run.twilightSurge        = false;
}

// ── Rule definitions ───────────────────────────────────────────────────────
export const STAGE_RULES = {
  forest: {
    name: 'Overgrowth',
    blurb: 'The wood draws close. Spore pulses dull the swarm.',
    onRunStart(s) {
      s.run._fr_pulseAt = 10;   // first pulse at game-time 10s
      s.run._fr_pulseEndAt = -1;
      s.run.stageRuleSpawnRingMul = 0.75;   // 25% tighter ring
    },
    onTick(s, dt) {
      const t = s.time.game;
      // End an active pulse
      if (s.run._fr_pulseEndAt > 0 && t >= s.run._fr_pulseEndAt) {
        s.run._fr_pulseEndAt = -1;
        s.run.stageRuleEnemySlow = 1;
      }
      // Start a new pulse
      if (t >= s.run._fr_pulseAt) {
        s.run.stageRuleEnemySlow = 0.60;     // 40% slow
        s.run._fr_pulseEndAt = t + 1.0;
        s.run._fr_pulseAt = t + 10;
        // Green pulse via existing FX channels
        s.fx.bloomBoost = Math.max(s.fx.bloomBoost, 0.55);
        s.fx.chromaticPulse = Math.max(s.fx.chromaticPulse, 0.35);
        _showBanner('Spore Pulse', 'Enemies slowed', 1.0);
      }
    },
    onEnemySpawn(enemy, s) {
      // Already handled by stageRuleSpawnRingMul on the spawn ring; nothing extra.
    },
  },

  twilight: {
    name: 'Witching Hour',
    blurb: 'When night closes in, the swarm doubles — and so do the gems.',
    onRunStart(s) {
      s.run._tw_surgeAt = 30;
      s.run._tw_surgeEndAt = -1;
    },
    onTick(s, dt) {
      const t = s.time.game;
      if (s.run._tw_surgeEndAt > 0) {
        const remain = s.run._tw_surgeEndAt - t;
        if (remain <= 0) {
          s.run._tw_surgeEndAt = -1;
          s.run.twilightSurge = false;
          s.run.stageRuleSpawnMul = 1;
          s.run.stageRuleXpMul = 1;
        } else {
          _setBannerSub(`Surge: ${remain.toFixed(1)}s — 2× spawns / 2× XP`);
        }
      }
      if (t >= s.run._tw_surgeAt && s.run._tw_surgeEndAt < 0) {
        s.run._tw_surgeEndAt = t + 5.0;
        s.run._tw_surgeAt = t + 30;
        s.run.twilightSurge = true;
        s.run.stageRuleSpawnMul = 2.0;
        s.run.stageRuleXpMul = 2.0;
        s.fx.bloomBoost = Math.max(s.fx.bloomBoost, 0.7);
        s.fx.chromaticPulse = Math.max(s.fx.chromaticPulse, 0.5);
        _showBanner('Witching Hour', 'Surge: 5.0s — 2× spawns / 2× XP', 5.0);
      }
    },
    onEnemySpawn() {},
  },

  cinder: {
    name: 'Eruption',
    blurb: 'The ground splits. Hot earth drops trophies for the bold.',
    onRunStart(s) {
      s.run._ci_eruptAt = 20;
    },
    onTick(s, dt) {
      const t = s.time.game;
      if (t >= s.run._ci_eruptAt) {
        s.run._ci_eruptAt = t + 20;
        const count = 3 + Math.floor(Math.random() * 3);   // 3..5
        const hp = s.hero.pos;
        for (let i = 0; i < count; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 3 + Math.random() * 9;                 // within 12u
          const x = hp.x + Math.cos(a) * r;
          const z = hp.z + Math.sin(a) * r;
          try { spawnLavaPuddle(x, z); } catch (_) {}
        }
        s.fx.bloomBoost = Math.max(s.fx.bloomBoost, 0.6);
        s.fx.shake = Math.max(s.fx.shake || 0, 0.35);
        _showBanner('Eruption', `${count} puddles burst near you`, 2.0);
      }
    },
    onEnemySpawn() {},
    // Called from enemies.js killEnemy hook
    onKill(enemy, s) {
      const ex = enemy.mesh.position.x, ez = enemy.mesh.position.z;
      if (!isNearLiveLava(ex, ez, 3)) return;
      try { spawnHeart(ex, ez); } catch (_) {}
    },
  },

  void: {
    name: "Reaper's Toll",
    blurb: 'The crypt drains you. Kill 25 to claw back what was taken.',
    onRunStart(s) {
      s.run._vd_nextToll = 8;
      s.run._vd_killBaseline = s.run.kills || 0;
    },
    onTick(s, dt) {
      const t = s.time.game;
      if (t >= s.run._vd_nextToll) {
        s.run._vd_nextToll = t + 8;
        // Bypass iFrames / damage flow — direct HP nibble that clamps to 1.
        if (s.hero && !s.gameOver) {
          s.hero.hp = Math.max(1, s.hero.hp - 1);
          s.fx.chromaticPulse = Math.max(s.fx.chromaticPulse, 0.4);
        }
      }
      // Kill-bounty refund — every 25 kills, regain 5 HP.
      const k = (s.run.kills || 0) - (s.run._vd_killBaseline || 0);
      const earned = Math.floor(k / 25);
      const taken  = s.run._vd_killBountiesTaken || 0;
      if (earned > taken) {
        s.run._vd_killBountiesTaken = earned;
        if (s.hero && s.hero.hpMax) {
          s.hero.hp = Math.min(s.hero.hpMax, s.hero.hp + 5);
          _showBanner("Reaper's Toll", '+5 HP — the toll is paid back', 1.6);
          s.fx.bloomBoost = Math.max(s.fx.bloomBoost, 0.5);
        }
      }
    },
    onEnemySpawn() {},
  },

  kakiland: {
    name: 'Threefold Gate',
    blurb: 'Clear the three satellite trials to awaken the Kaki Sovereign.',
    onRunStart(s) {
      if (!s.run.kakiLand) {
        s.run.kakiLand = {
          trials: { ember: false, tide: false, bloom: false },
          mainPortalUnlocked: false,
          mainBossSpawned: false,
        };
      }
    },
    // The portal controller registers this hook at mount time. Keeping the
    // dependency injection on state avoids a static ESM cycle through
    // enemies.js, while preserving synchronous completion before victory.
    onKill(enemy, s) {
      if (!enemy || !enemy.kakiLandPortalId) return;
      if (typeof s._onKakiLandBossKilled === 'function') {
        s._onKakiLandBossKilled(enemy);
      }
    },
    onEnemySpawn() {},
  },
};

// ── Hooks called by external systems ───────────────────────────────────────

/** Called from enemies.js spawnEnemy (post-construct). One-line opt-in. */
export function notifyStageEnemySpawn(enemy) {
  const rid = state.run && state.run.stage && state.run.stage.id;
  const rule = rid && STAGE_RULES[rid];
  if (!rule || !rule.onEnemySpawn) return;
  try { rule.onEnemySpawn(enemy, state); } catch (_) {}
}

/** Called from enemies.js killEnemy (Cinder heart-drop bonus). */
export function notifyStageEnemyKill(enemy) {
  const rid = state.run && state.run.stage && state.run.stage.id;
  const rule = rid && STAGE_RULES[rid];
  if (!rule || !rule.onKill) return;
  try { rule.onKill(enemy, state); } catch (_) {}
}

/** Called from hero.js takeDamage if the rule wants to mutate incoming damage. */
export function notifyStagePlayerHit(amount) {
  const rid = state.run && state.run.stage && state.run.stage.id;
  const rule = rid && STAGE_RULES[rid];
  if (!rule || !rule.onPlayerHit) return amount;
  try { return rule.onPlayerHit(amount, state); } catch (_) { return amount; }
}

// ── Public lifecycle ───────────────────────────────────────────────────────

export function applyStageRule(stageId, s = state) {
  _resetRuleFlags(s);
  s.run._stageRuleId = stageId || null;
  const rule = stageId && STAGE_RULES[stageId];
  if (!rule) return;
  try { rule.onRunStart && rule.onRunStart(s); } catch (_) {}
  // Announce via chat bubble + HUD banner
  try { pushBubble('system', rule.name + ': ' + rule.blurb); } catch (_) {}
  _showBanner(rule.name, rule.blurb, 4.5);
  // Tickle the existing stage tint so the rule activation feels visible.
  try {
    if (s.envGroup && s.envGroup.userData && typeof s.envGroup.userData.applyStageTint === 'function') {
      s.envGroup.userData.applyStageTint(s.run.stage);
    }
  } catch (_) {}
}

export function tickStageRule(s = state, dt) {
  _tickBanner();
  const rid = s.run && s.run._stageRuleId;
  const rule = rid && STAGE_RULES[rid];
  if (!rule || !rule.onTick) return;
  try { rule.onTick(s, dt); } catch (_) {}
}

export function clearStageRule(s = state) {
  _resetRuleFlags(s);
  if (s.run) s.run._stageRuleId = null;
  if (_banner) {
    _banner.style.opacity = '0';
    _bannerHideAt = 0;
  }
}
