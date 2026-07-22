/**
 * MaoMao's Daycare — the care/customization overlay for the physical town cat.
 *
 * The cozy-identity injection (2026-07-08): the survivor loop is dark/tense;
 * this is the bright safe-space counterweight. You RESCUE a cat by playing —
 * the first completed run reveals MaoMao's town rescue trail; after the player
 * completes it, FEED / GROOM / PET / PLAY raise Happiness and permanent Bond.
 * outfits; equipping one grants a small run buff (config.DAYCARE_OUTFITS →
 * applied in main.js applyMetaUpgrades, non-leaderboard runs only).
 *
 * ── Self-contained by design ───────────────────────────────────────────────
 * Own palette, own <style>, own Escape handler. Does NOT import ui.js (avoids
 * a town.js↔ui.js↔daycare.js cycle and keeps the daycare palette deliberately
 * DISTINCT from the dark survivor UI — bright cozy vs. dark horde-night sells
 * the personality contrast). Only deps: meta.js (persist), config.js (outfit
 * catalog), audio.js (reuses existing sample-bank sfx — no new audio assets).
 *
 * ── Town integration ───────────────────────────────────────────────────────
 * town.js pushes a 'daycare' interactable + a handler that dynamic-imports
 * this module's showDaycare(). While open, town.js tickTown early-returns on
 * isDaycareOpen() so the hero can't wander/re-trigger interactables underneath
 * (mirrors the isShopOpen()/isGrimoireOpen() freeze).
 *
 * ── Persistence ────────────────────────────────────────────────────────────
 * maomaoState.js owns migration and numerical rules. Every completed Hunt
 * refreshes one rewarded round of care; repeats still animate but never grind.
 */

import { getMeta, saveMeta } from './meta.js';
import { DAYCARE_OUTFITS } from './config.js';
import { sfx } from './audio.js';
import {
  MAOMAO_NAME,
  canRewardYarnGame,
  careForMaoMao,
  finishMaoMaoYarnGame,
  maoMaoBond,
  maoMaoMood,
  normalizeMaoMao,
} from './maomaoState.js';

const CAT_NAME = MAOMAO_NAME;
const STYLE_ID = 'kk-daycare-style';
const ROOT_ID  = 'kk-daycare';
const BASE_CAT_SRC = 'assets/sprites/momo.webp';   // plain portrait (no outfit)

// Inline vector icon kit. Emoji were charming on machines with a color-emoji
// font, but several browsers/platforms rendered Feed, Groom, Yarn, Closet,
// vitals, and locked outfits as empty square glyphs. These tiny SVGs inherit
// the Daycare palette, remain sharp at every UI scale, and add no requests.
const ICONS = Object.freeze({
  fish: '<path d="M4 12c3.1-4.2 8.4-5 12.2-1.5L20 7v10l-3.8-3.5C12.4 17 7.1 16.2 4 12Z"/><circle cx="13.8" cy="10.8" r=".8" fill="currentColor" stroke="none"/>',
  comb: '<path d="M6 5h12v5H6zM8 10v7m2-7v8m2-8v7m2-7v8m2-8v7"/>',
  paw: '<ellipse cx="12" cy="15.3" rx="4.2" ry="3.5"/><circle cx="6.8" cy="10.2" r="1.8"/><circle cx="10.2" cy="7.2" r="1.8"/><circle cx="14.4" cy="7.2" r="1.8"/><circle cx="17.5" cy="10.4" r="1.8"/>',
  yarn: '<circle cx="11.2" cy="12" r="7"/><path d="M5.5 8.6c3.8.4 7.2 3.3 10.6 7.4M7.1 16.8c1.8-4.4 5-7.2 9.5-8.4M5 12.7c4.6 1.7 8.6 1.5 12.7-.5M17 17.2c2.6.2 3.4 1.1 2.3 2.7"/>',
  heart: '<path d="M12 20S4.5 15.6 4.5 9.7C4.5 5.8 9.3 4 12 7.2 14.7 4 19.5 5.8 19.5 9.7 19.5 15.6 12 20 12 20Z"/>',
  bolt: '<path d="M13.5 2.8 6.7 13h4.5l-.8 8.2L17.3 11h-4.5z"/>',
  sparkle: '<path d="M12 2.8c.7 5.2 2.8 7.3 8 8-5.2.7-7.3 2.8-8 8-.7-5.2-2.8-7.3-8-8 5.2-.7 7.3-2.8 8-8Z"/>',
  basket: '<path d="M4.2 9.5h15.6l-1.4 10H5.6zM7.2 9.5c.5-3.2 2.1-5 4.8-5s4.3 1.8 4.8 5M8 12v5m4-5v5m4-5v5"/>',
  hanger: '<path d="M10.4 6.2c0-2.1 3.2-2.1 3.2 0 0 1.7-1.6 1.8-1.6 3.1L3.8 15h16.4L12 9.3"/>',
  lock: '<rect x="5.5" y="10" width="13" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10m-3.5 4v2.5"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9a2.7 2.7 0 1 1 3.1 2.7c-.6.3-.7.8-.7 1.6M12 16.8v.2"/>',
  beanie: '<path d="M5 14c0-5 2.8-8 7-8s7 3 7 8M4.5 14h15v4h-15zM12 6V3.5"/><circle cx="12" cy="3.2" r="1.4"/>',
  scarf: '<path d="M7 5.5c3.4 2 6.6 2 10 0v6c-3.4 2-6.6 2-10 0zM14 12.7v7l2-1.3 2 1.3v-9"/>',
  crown: '<path d="m4 7 4.2 4L12 5l3.8 6L20 7l-1.5 11h-13zM6 15h12"/>',
  moonbell: '<path d="M14.8 4.2a6.8 6.8 0 1 0 4.7 10.9A7.8 7.8 0 0 1 14.8 4.2Z"/><path d="M9 16.7h6l-1 2H10z"/>',
});

function _icon(kind, extraClass = '') {
  const body = ICONS[kind] || ICONS.paw;
  return `<svg class="kkdc-icon${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function _outfitIcon(id, locked = false) {
  return _icon(locked ? 'question' : (ICONS[id] ? id : 'hanger'), 'kkdc-outfit-icon');
}

let _root = null;          // overlay element (built lazily, kept across opens)
let _open = false;
let _keyHandler = null;
let _els = {};             // cached child refs
let _yarnGame = null;      // { score, endsAt, raf, rewardEligible }

// Care actions — each raises happiness, plays a themed reaction. Amounts differ
// slightly so the loop has texture (petting is the small frequent affection,
// feeding the big top-up). Happiness clamps at 100.
const CARE = {
  feed:  { gain: 6, particle: 'fish',    sfx: 'fountainDrink', bark: 'nom nom!'  },
  groom: { gain: 5, particle: 'sparkle', sfx: 'starPickup',    bark: 'so soft~'  },
  pet:   { gain: 4, particle: 'heart',   sfx: 'heartPickup',   bark: 'purrrr'    },
};

// ── Public API ─────────────────────────────────────────────────────────────

export function isDaycareOpen() { return _open; }

export function showDaycare() {
  const meta = getMeta();
  _ensureDaycare(meta);
  if (!_root) _build();
  _open = true;
  _root.style.display = 'flex';
  // Capture-phase Escape → close, and swallow it so main.js's central Esc
  // handler doesn't also fire (mirrors endRunSummary's capture handler).
  _keyHandler = (e) => {
    if (e.code === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); hideDaycare(); }
  };
  window.addEventListener('keydown', _keyHandler, true);

  _syncAll(meta);
  try { sfx.modalOpen && sfx.modalOpen(); } catch (_) {}
  // No auto-adoption: the first Hunt reveals MaoMao's physical rescue trail.
  // Before the player completes it, _syncAll shows an exploration hint.
}

export function hideDaycare() {
  if (!_open) return;
  _open = false;
  _cancelYarnGame();
  if (_root) _root.style.display = 'none';
  if (_keyHandler) { window.removeEventListener('keydown', _keyHandler, true); _keyHandler = null; }
  try { sfx.modalClose && sfx.modalClose(); } catch (_) {}
}

// ── Build ──────────────────────────────────────────────────────────────────

function _ensureDaycare(meta) {
  return normalizeMaoMao(meta);
}

function _injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
  #${ROOT_ID} {
    position: fixed; inset: 0; z-index: 130;
    display: none; flex-direction: column; align-items: center;
    font-family: "Comic Sans MS", "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
    /* Geocities sparkle-tile floor — bright pastel, deliberately NOT the dark UI. */
    background:
      radial-gradient(circle at 20% 30%, rgba(255,255,255,0.85) 0 2px, transparent 3px) 0 0/34px 34px,
      radial-gradient(circle at 70% 65%, rgba(255,255,255,0.7) 0 1.5px, transparent 2.5px) 12px 8px/30px 30px,
      linear-gradient(135deg, #ffd6ef 0%, #d9c7ff 35%, #c7f0ff 70%, #d6ffe4 100%);
    animation: kkdc-bgshift 18s ease-in-out infinite alternate;
    overflow: auto; padding: 18px;
  }
  @keyframes kkdc-bgshift { from { background-position: 0 0, 12px 8px, 0 0; } to { background-position: 34px 34px, -18px 30px, 0 0; } }

  .kkdc-window {
    width: min(560px, 100%); box-sizing: border-box;
    /* margin:auto (not the parent's justify-content:center) centers the window
       when it fits; flex-shrink:0 stops the column flex from compressing it to
       viewport height and then clipping its own overflow:hidden — so on short
       screens the parent scrolls and the Back-to-Town button stays reachable. */
    margin: auto; flex-shrink: 0;
    background: #fff6fb;
    border: 4px solid #ff8fc7; border-radius: 14px;
    box-shadow: 0 0 0 4px #fff, 0 10px 34px rgba(120,40,120,0.35), inset 0 0 0 2px #ffd6ef;
    padding: 0 0 16px; overflow: hidden;
  }
  .kkdc-titlebar {
    background: linear-gradient(180deg, #ff9ed2, #ff6fb4);
    color: #fff; text-align: center; padding: 9px 8px;
    font-size: 21px; font-weight: bold; letter-spacing: 1px;
    text-shadow: 1px 1px 0 #c23e86, -1px -1px 0 #ffd6ef;
    border-bottom: 3px solid #ff8fc7;
  }
  .kkdc-blink { animation: kkdc-blink 1.1s steps(1) infinite; }
  @keyframes kkdc-blink { 50% { opacity: 0.25; } }
  .kkdc-rainbow { height: 5px; border: 0;
    background: linear-gradient(90deg,#ff5f7e,#ffb04d,#ffe94d,#6fe07a,#5fbaff,#b07bff,#ff7be0);
    background-size: 200% 100%; animation: kkdc-rainbow 4s linear infinite; margin: 0; }
  @keyframes kkdc-rainbow { to { background-position: 200% 0; } }

  .kkdc-stage { display: flex; flex-direction: column; align-items: center; padding: 14px 10px 6px; }
  .kkdc-icon { width: 1.15em; height: 1.15em; display: inline-block; vertical-align: -0.2em;
    overflow: visible; flex: 0 0 auto; }

  /* Empty state — shown until MaoMao's town rescue is complete. */
  .kkdc-empty { display: none; text-align: center; padding: 26px 16px 30px; }
  .kkdc-basket { color:#b06cc8; line-height: 1; animation: kkdc-idle 3.2s ease-in-out infinite; }
  .kkdc-basket .kkdc-icon { width:66px; height:66px; stroke-width:1.35; }
  .kkdc-empty-title { margin-top: 12px; font-size: 19px; font-weight: bold; color: #b03e86; }
  .kkdc-empty-hint { margin-top: 8px; font-size: 14px; color: #7a4fb0; line-height: 1.5; }

  /* ── MaoMao — Grok-generated neo-chibi portrait, matching the cozy card art. ── */
  .kkdc-cat { position: relative; width: 150px; height: 150px; transform-origin: 50% 100%; }
  .kkdc-cat.kkdc-boing { animation: kkdc-boing 0.5s cubic-bezier(.34,1.56,.64,1); }
  @keyframes kkdc-boing {
    0% { transform: scale(1,1); } 22% { transform: scale(1.16,0.82); }
    46% { transform: scale(0.9,1.14); } 70% { transform: scale(1.05,0.96); } 100% { transform: scale(1,1); }
  }
  .kkdc-cat.kkdc-idle { animation: kkdc-idle 3.2s ease-in-out infinite; }
  @keyframes kkdc-idle { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  .kkdc-catimg { width: 150px; height: 150px; display: block; image-rendering: pixelated;
    border-radius: 16px; border: 4px solid #ffb8d8;
    box-shadow: 0 5px 16px rgba(120,40,120,0.25), inset 0 0 0 2px #fff; }

  /* Floating reaction particles. */
  .kkdc-particle { position: absolute; font-size: 26px; pointer-events: none; z-index: 40;
    animation: kkdc-float 1s ease-out forwards; }
  @keyframes kkdc-float { 0% { transform: translateY(0) scale(0.6); opacity: 0; }
    20% { opacity: 1; } 100% { transform: translateY(-72px) scale(1.15); opacity: 0; } }
  .kkdc-bark { position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
    background: #fff; border: 2px solid #ff8fc7; border-radius: 12px; padding: 3px 10px;
    font-size: 13px; color: #c23e86; white-space: nowrap; z-index: 45; opacity: 0;
    animation: kkdc-bark 1.1s ease-out forwards; }
  @keyframes kkdc-bark { 0% { opacity: 0; transform: translate(-50%,4px); } 18% { opacity: 1; transform: translate(-50%,-2px); }
    80% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%,-8px); } }

  /* Happiness meter — chunky segmented pixel bar. */
  .kkdc-hlabel { margin: 10px 0 4px; font-size: 13px; font-weight: bold; color: #b03e86; letter-spacing: 2px; }
  .kkdc-bar { width: min(420px, 90%); height: 24px; background: #ffe3f2; border: 3px solid #ff8fc7;
    border-radius: 6px; overflow: hidden; position: relative;
    background-image: repeating-linear-gradient(90deg, transparent 0 26px, rgba(255,143,199,0.35) 26px 28px); }
  .kkdc-fill { height: 100%; width: 0; background: linear-gradient(90deg, #ff9ed2, #ffd24d);
    transition: width 0.45s cubic-bezier(.34,1.56,.64,1); }
  .kkdc-pct { text-align: center; font-size: 12px; color: #a5468a; margin-top: 3px; font-weight: bold; }
  .kkdc-mood { text-align: center; font-size: 13px; color: #7a4fb0; margin: 2px 0 0; min-height: 16px; }
  .kkdc-vitals { display:flex; justify-content:center; gap:10px; flex-wrap:wrap; margin-top:8px; }
  .kkdc-vital { background:#fff; border:2px solid #e2c7ff; border-radius:999px; padding:4px 10px;
    color:#74448e; font-size:11px; font-weight:800; letter-spacing:.04em; display:flex; align-items:center; gap:4px; }
  .kkdc-bondbar { width:min(330px,82%); height:8px; margin:5px auto 0; background:#eadcff; border-radius:99px; overflow:hidden; }
  .kkdc-bondfill { height:100%; width:0; background:linear-gradient(90deg,#9a70e8,#65d9c0); transition:width .35s ease; }

  /* Care buttons. */
  .kkdc-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin: 14px 0 4px; }
  .kkdc-btn { font-family: inherit; cursor: pointer; font-size: 16px; font-weight: bold; color: #7a2f5e;
    background: linear-gradient(180deg, #fff, #ffd9ee); border: 3px solid #ff8fc7; border-radius: 10px;
    padding: 10px 18px; box-shadow: 0 3px 0 #e46fa8; transition: transform 0.08s, box-shadow 0.08s;
    display:inline-flex; align-items:center; gap:7px; }
  .kkdc-btn:hover { transform: translateY(-2px); box-shadow: 0 5px 0 #e46fa8; }
  .kkdc-btn:active { transform: translateY(2px); box-shadow: 0 1px 0 #e46fa8; }
  .kkdc-btn.spent { opacity:.72; }

  /* 12-second Yarn Pounce — DOM-only, touch/controller friendly, no canvas. */
  .kkdc-yarn { display:none; width:min(440px,90%); margin:10px auto 4px; padding:10px; box-sizing:border-box;
    background:#fff8e8; border:3px solid #ffbd62; border-radius:14px; }
  .kkdc-yarn.open { display:block; }
  .kkdc-yarnhead { display:flex; justify-content:space-between; color:#8b4e35; font-size:12px; font-weight:900; }
  .kkdc-yarnarena { height:150px; margin-top:7px; position:relative; overflow:hidden; border-radius:10px;
    background:radial-gradient(circle at 50% 25%,rgba(255,255,255,.9),transparent 36%),linear-gradient(#d9f7dd,#bce8c9);
    border:2px solid #86c89d; }
  .kkdc-yarnball { position:absolute; left:44%; top:52%; width:52px; height:52px; padding:0; border:3px solid #d94d91;
    border-radius:50%; background:#ff83bd; color:#fff; cursor:pointer; box-shadow:0 4px 0 #b73b78;
    transition:left .14s ease,top .14s ease,transform .08s; }
  .kkdc-yarnball .kkdc-icon { width:31px; height:31px; vertical-align:0; }
  .kkdc-yarnball:active { transform:scale(.84); }
  .kkdc-yarnhint { margin-top:6px; text-align:center; color:#7a4f3a; font-size:11px; }

  /* Outfit shelf. */
  .kkdc-shelf-title { text-align: center; margin: 12px 0 6px; font-size: 14px; font-weight: bold; color: #b03e86; letter-spacing: 1px; }
  .kkdc-shelf { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; padding: 0 10px; }
  .kkdc-slot { width: 118px; box-sizing: border-box; background: #fff; border: 3px solid #ffcbe6;
    border-radius: 10px; padding: 8px 6px; text-align: center; cursor: pointer; transition: transform 0.1s, border-color 0.1s; }
  .kkdc-slot:hover { transform: translateY(-2px); }
  .kkdc-slot.locked { opacity: 0.62; cursor: default; filter: grayscale(0.4); }
  .kkdc-slot.equipped { border-color: #ffb43d; box-shadow: 0 0 0 3px #ffe9b0; background: #fffaf0; }
  .kkdc-slot .ico { line-height: 1; color:#a34f91; }
  .kkdc-slot .ico .kkdc-outfit-icon { width:32px; height:32px; stroke-width:1.45; }
  .kkdc-slot.locked .ico { color:#8c7b91; }
  .kkdc-slot .nm  { font-size: 12px; font-weight: bold; color: #7a2f5e; margin-top: 3px; }
  .kkdc-slot .bf  { font-size: 10px; color: #3d8a5a; margin-top: 2px; min-height: 12px; }
  .kkdc-slot .st  { font-size: 10px; color: #a5468a; margin-top: 3px; font-weight: bold; }

  .kkdc-close { margin: 16px auto 2px; font-family: inherit; cursor: pointer; font-size: 15px; font-weight: bold;
    color: #fff; background: linear-gradient(180deg, #b07bff, #8a4fe0); border: 3px solid #6a2fc0;
    border-radius: 10px; padding: 9px 22px; box-shadow: 0 3px 0 #5a259e; }
  .kkdc-close:active { transform: translateY(2px); box-shadow: 0 1px 0 #5a259e; }

  /* Rescue / unlock banner. */
  .kkdc-banner { position: fixed; top: 16%; left: 50%; transform: translateX(-50%);
    background: linear-gradient(180deg, #fff, #ffe9b0); border: 4px solid #ffb43d; border-radius: 14px;
    padding: 14px 26px; text-align: center; z-index: 200; box-shadow: 0 8px 30px rgba(150,90,20,0.4);
    animation: kkdc-pop 0.4s cubic-bezier(.34,1.56,.64,1); }
  .kkdc-banner .big { font-size: 22px; font-weight: bold; color: #c23e86; }
  .kkdc-banner .sub { font-size: 13px; color: #8a5a2f; margin-top: 4px; }
  @keyframes kkdc-pop { from { transform: translate(-50%, 8px) scale(0.8); opacity: 0; } to { transform: translate(-50%,0) scale(1); opacity: 1; } }
  `;
  document.head.appendChild(s);
}

function _build() {
  _injectStyle();
  const root = document.createElement('div');
  root.id = ROOT_ID;

  const win = document.createElement('div');
  win.className = 'kkdc-window';
  win.innerHTML = `
    <div class="kkdc-titlebar">✦ ${CAT_NAME}'s Daycare <span class="kkdc-blink">✦</span></div>
    <hr class="kkdc-rainbow">
    <div class="kkdc-stage">
      <div class="kkdc-empty">
        <div class="kkdc-basket">${_icon('basket')}</div>
        <div class="kkdc-empty-title">MaoMao is still out in town…</div>
        <div class="kkdc-empty-hint">Complete one Hunt, then follow the pink paw prints<br>beside the Daycare. Dash, jump, and earn her trust! ${_icon('paw')}</div>
      </div>
      <div class="kkdc-careui">
        <div class="kkdc-cat kkdc-idle">
          <img class="kkdc-catimg" src="assets/sprites/momo.webp" alt="MaoMao the cat">
        </div>
        <div class="kkdc-mood"></div>
        <div class="kkdc-hlabel">♥ HAPPINESS ♥</div>
        <div class="kkdc-bar"><div class="kkdc-fill"></div></div>
        <div class="kkdc-pct"></div>
        <div class="kkdc-vitals">
          <div class="kkdc-vital kkdc-energy"></div>
          <div class="kkdc-vital kkdc-bond"></div>
          <div class="kkdc-vital kkdc-yarnbest"></div>
        </div>
        <div class="kkdc-bondbar"><div class="kkdc-bondfill"></div></div>
        <div class="kkdc-actions">
          <button class="kkdc-btn" data-care="feed">${_icon('fish')}<span>Feed</span></button>
          <button class="kkdc-btn" data-care="groom">${_icon('comb')}<span>Groom</span></button>
          <button class="kkdc-btn" data-care="pet">${_icon('paw')}<span>Pet</span></button>
          <button class="kkdc-btn" data-care="play">${_icon('yarn')}<span>Yarn Pounce</span></button>
        </div>
        <div class="kkdc-yarn">
          <div class="kkdc-yarnhead"><span>YARN POUNCE</span><span class="kkdc-yarntime">12.0s</span><span class="kkdc-yarnscore">0 pounces</span></div>
          <div class="kkdc-yarnarena"><button class="kkdc-yarnball" aria-label="Pounce on the yarn ball">${_icon('yarn')}</button></div>
          <div class="kkdc-yarnhint">Catch the yarn before time runs out. Mouse, touch, or keyboard all work.</div>
        </div>
      </div>
    </div>
    <hr class="kkdc-rainbow kkdc-shelf-rule">
    <div class="kkdc-shelf-title">${_icon('hanger')} MaoMao's Closet — happiness unlocks one small support perk</div>
    <div class="kkdc-shelf"></div>
    <button class="kkdc-close">✕ Back to Town</button>
  `;
  root.appendChild(win);
  document.body.appendChild(root);
  _root = root;

  _els = {
    cat:    win.querySelector('.kkdc-cat'),
    catimg: win.querySelector('.kkdc-catimg'),
    mouth:  win.querySelector('.kkdc-mouth'),
    mood:   win.querySelector('.kkdc-mood'),
    fill:   win.querySelector('.kkdc-fill'),
    pct:    win.querySelector('.kkdc-pct'),
    shelf:  win.querySelector('.kkdc-shelf'),
    careui: win.querySelector('.kkdc-careui'),
    empty:  win.querySelector('.kkdc-empty'),
    shelfTitle: win.querySelector('.kkdc-shelf-title'),
    shelfRule:  win.querySelector('.kkdc-shelf-rule'),
    energy:     win.querySelector('.kkdc-energy'),
    bond:       win.querySelector('.kkdc-bond'),
    bondFill:   win.querySelector('.kkdc-bondfill'),
    yarnBest:   win.querySelector('.kkdc-yarnbest'),
    yarn:       win.querySelector('.kkdc-yarn'),
    yarnBall:   win.querySelector('.kkdc-yarnball'),
    yarnTime:   win.querySelector('.kkdc-yarntime'),
    yarnScore:  win.querySelector('.kkdc-yarnscore'),
  };

  win.querySelectorAll('.kkdc-btn[data-care]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = b.getAttribute('data-care');
      if (action === 'play') _startYarnGame();
      else _doCare(action);
    });
  });
  _els.yarnBall.addEventListener('click', (e) => { e.stopPropagation(); _catchYarn(); });
  win.querySelector('.kkdc-close').addEventListener('click', (e) => { e.stopPropagation(); hideDaycare(); });
}

// ── Care loop ────────────────────────────────────────────────────────────────

function _doCare(action) {
  const spec = CARE[action];
  if (!spec) return;
  const meta = getMeta();
  const result = careForMaoMao(meta, action);
  if (!result.ok) return;
  saveMeta();

  // Juice: cat boing + particles + bark + sfx. The reaction IS the reward.
  _boing();
  _spawnParticles(spec.particle, 5);
  _bark(result.rewarded ? spec.bark : 'more cuddles!');
  try { sfx[spec.sfx] && sfx[spec.sfx](); } catch (_) {}

  _syncAll(meta);

  if (!result.rewarded) _banner('COZY TIME', 'Progress refreshes after the next Hunt — petting is always welcome.');
  for (const o of result.unlocked) {
    try { sfx.evolutionChime && sfx.evolutionChime(); } catch (_) {}
    _banner(`★ NEW OUTFIT! ★`, `${o.name} — ${o.buffLabel || 'cosmetic'}`);
  }
}

const YARN_SPOTS = [[8,12],[42,8],[76,16],[18,58],[62,54],[38,34],[78,62],[8,66]];

function _startYarnGame() {
  const meta = getMeta();
  const pet = _ensureDaycare(meta);
  if (!pet.adopted || _yarnGame) return;
  _yarnGame = {
    score: 0,
    endsAt: performance.now() + 12000,
    rewardEligible: canRewardYarnGame(meta),
    raf: 0,
  };
  _els.yarn.classList.add('open');
  _els.yarnScore.textContent = '0 pounces';
  _els.yarnBall.style.left = '44%';
  _els.yarnBall.style.top = '52%';
  _els.yarnBall.focus({ preventScroll: true });
  _bark(_yarnGame.rewardEligible ? 'yarn time!' : 'practice pounce!');
  const frame = () => {
    if (!_yarnGame) return;
    const left = Math.max(0, _yarnGame.endsAt - performance.now());
    _els.yarnTime.textContent = (left / 1000).toFixed(1) + 's';
    if (left <= 0) { _finishYarnGame(); return; }
    _yarnGame.raf = requestAnimationFrame(frame);
  };
  _yarnGame.raf = requestAnimationFrame(frame);
}

function _catchYarn() {
  if (!_yarnGame) return;
  _yarnGame.score += 1;
  const [left, top] = YARN_SPOTS[_yarnGame.score % YARN_SPOTS.length];
  _els.yarnBall.style.left = left + '%';
  _els.yarnBall.style.top = top + '%';
  _els.yarnScore.textContent = `${_yarnGame.score} pounce${_yarnGame.score === 1 ? '' : 's'}`;
  _spawnParticles(_yarnGame.score % 3 === 0 ? 'sparkle' : 'paw', 2);
  if (_yarnGame.score >= 8) _finishYarnGame();
}

function _finishYarnGame() {
  if (!_yarnGame) return;
  const score = _yarnGame.score;
  cancelAnimationFrame(_yarnGame.raf);
  _yarnGame = null;
  _els.yarn.classList.remove('open');
  const meta = getMeta();
  const result = finishMaoMaoYarnGame(meta, score);
  saveMeta();
  _boing();
  _bark(score >= 6 ? 'ZOOMIES!' : 'again!');
  try { sfx.starPickup?.(); } catch (_) {}
  _syncAll(meta);
  const sub = result.rewarded
    ? `${score} pounces · happiness and Bond increased.`
    : `${score} pounces · practice stays free until the next Hunt.`;
  _banner(score >= 8 ? '★ PERFECT POUNCE! ★' : 'YARN CHASE', sub);
  for (const o of result.unlocked) _banner('★ NEW OUTFIT! ★', `${o.name} — ${o.buffLabel}`);
}

function _cancelYarnGame() {
  if (!_yarnGame) return;
  cancelAnimationFrame(_yarnGame.raf);
  _yarnGame = null;
  _els.yarn?.classList.remove('open');
}

function _equip(id) {
  const meta = getMeta();
  _ensureDaycare(meta);
  if (!meta.daycare.unlockedOutfits.includes(id)) { try { sfx.uiError && sfx.uiError(); } catch (_) {} return; }
  // Toggle off if re-clicking the equipped one.
  meta.daycare.equippedOutfit = (meta.daycare.equippedOutfit === id) ? null : id;
  saveMeta();
  try { sfx.uiClick && sfx.uiClick(); } catch (_) {}
  _boing();
  _syncAll(meta);
}

// ── Render / sync ────────────────────────────────────────────────────────────

function _syncAll(meta) {
  const pet = _ensureDaycare(meta);
  const adopted = !!pet.adopted;
  if (_els.empty)      _els.empty.style.display = adopted ? 'none' : 'block';
  if (_els.careui)     _els.careui.style.display = adopted ? '' : 'none';
  if (_els.shelfTitle) _els.shelfTitle.style.display = adopted ? '' : 'none';
  if (_els.shelf)      _els.shelf.style.display = adopted ? '' : 'none';
  if (_els.shelfRule)  _els.shelfRule.style.display = adopted ? '' : 'none';
  if (!adopted) {
    const hint = _els.empty?.querySelector('.kkdc-empty-hint');
    if (hint) hint.innerHTML = pet.encounterUnlocked
      ? `Pink paw prints have appeared beside the Daycare.<br>Find MaoMao and earn her trust! ${_icon('paw')}`
      : `Complete one Hunt, then return to town.<br>MaoMao will leave a trail for you! ${_icon('paw')}`;
    return;
  }

  const h = pet.happiness | 0;
  if (_els.fill) _els.fill.style.width = h + '%';
  if (_els.pct)  _els.pct.textContent = h + ' / 100';
  const bond = maoMaoBond(pet);
  if (_els.energy) _els.energy.innerHTML = `${_icon('bolt')}<span>Energy ${pet.energy} / 3</span>`;
  if (_els.bond) _els.bond.innerHTML = `${_icon('heart')}<span>${bond.name} · ${bond.xp} Bond</span>`;
  if (_els.bondFill) _els.bondFill.style.width = (bond.progress * 100).toFixed(1) + '%';
  if (_els.yarnBest) _els.yarnBest.innerHTML = `${_icon('yarn')}<span>Best ${pet.yarnBest || 0}</span>`;
  document.querySelectorAll('.kkdc-btn[data-care]').forEach((button) => {
    const action = button.getAttribute('data-care');
    const spent = pet.careClaims[action] === pet.careCycle;
    button.classList.toggle('spent', spent);
    button.title = spent ? 'Progress refreshes after your next Hunt; the interaction remains available.' : 'Full care reward available.';
  });
  _updateExpression(h, pet);
  _renderWornOutfit(meta);
  _renderShelf(meta);
}

// Cat face + mood line shift by happiness tier — a number going up isn't
// delight; a cat that visibly warms up is.
function _updateExpression(h, pet) {
  let mouth = 'ᵕ', mood = maoMaoMood(pet);
  if (h >= 90) mouth = '◡';
  else if (h >= 55) mouth = 'ω';
  else if (h >= 25) mouth = '‿';
  if (_els.mouth) _els.mouth.textContent = mouth;
  if (_els.mood)  _els.mood.textContent = mood;
}

// The equipped outfit is shown by swapping the whole cat portrait to a variant
// where MaoMao actually WEARS it (legacy momo_* filenames preserve cache URLs)
// emoji badge. Falls back to the plain portrait when the outfit has no sprite
// (cosmetic-only or asset not yet generated), so equipping never breaks the img.
function _renderWornOutfit(meta) {
  if (!_els.catimg) return;
  const id = meta.daycare.equippedOutfit;
  const o = id && DAYCARE_OUTFITS.find(x => x.id === id);
  const src = (o && o.sprite) ? o.sprite : BASE_CAT_SRC;
  if (_els.catimg.getAttribute('src') !== src) _els.catimg.setAttribute('src', src);
}

function _renderShelf(meta) {
  const shelf = _els.shelf;
  if (!shelf) return;
  shelf.innerHTML = '';
  for (const o of DAYCARE_OUTFITS) {
    const unlocked = meta.daycare.unlockedOutfits.includes(o.id);
    const equipped = meta.daycare.equippedOutfit === o.id;
    const slot = document.createElement('div');
    slot.className = 'kkdc-slot' + (unlocked ? '' : ' locked') + (equipped ? ' equipped' : '');
    const status = !unlocked
      ? `${o.unlockLabel || `Happiness ${o.unlockAt}`}`
      : (equipped ? '✓ EQUIPPED' : 'tap to wear');
    slot.innerHTML = `
      <div class="ico">${_outfitIcon(o.id, !unlocked)}</div>
      <div class="nm">${o.name}</div>
      <div class="bf">${o.buffLabel || 'cosmetic'}</div>
      <div class="st">${unlocked ? '' : _icon('lock')} ${status}</div>`;
    if (unlocked) slot.addEventListener('click', (e) => { e.stopPropagation(); _equip(o.id); });
    shelf.appendChild(slot);
  }
}

// ── FX helpers ───────────────────────────────────────────────────────────────

function _boing() {
  const c = _els.cat;
  if (!c) return;
  c.classList.remove('kkdc-boing');
  // Force reflow so re-adding the class restarts the animation.
  void c.offsetWidth;
  c.classList.add('kkdc-boing');
}

function _spawnParticles(iconKind, n) {
  const stage = _els.cat && _els.cat.parentElement;
  if (!stage) return;
  const host = _els.cat;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div');
    p.className = 'kkdc-particle';
    p.innerHTML = _icon(iconKind);
    // Spread across the cat's width, staggered timing.
    p.style.left = (20 + Math.floor((i / Math.max(1, n - 1)) * 100)) + 'px';
    p.style.top = (30 + (i % 2) * 14) + 'px';
    p.style.animationDelay = (i * 60) + 'ms';
    host.appendChild(p);
    setTimeout(() => { if (p.parentNode) p.parentNode.removeChild(p); }, 1200 + i * 60);
  }
}

function _bark(text) {
  const host = _els.cat;
  if (!host) return;
  const b = document.createElement('div');
  b.className = 'kkdc-bark';
  b.textContent = text;
  host.appendChild(b);
  setTimeout(() => { if (b.parentNode) b.parentNode.removeChild(b); }, 1200);
}

function _banner(big, sub) {
  const el = document.createElement('div');
  el.className = 'kkdc-banner';
  el.innerHTML = `<div class="big">${big}</div><div class="sub">${sub}</div>`;
  (_root || document.body).appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.4s';
    el.style.opacity = '0';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 420);
  }, 1900);
}
