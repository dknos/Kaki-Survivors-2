/**
 * Bootstrap + main RAF loop.
 * Order of operations is locked in the loop body below; modules fill the blanks.
 */
import * as THREE from 'three/webgpu';
import { state, resetState } from './state.js';
import { WORLD, AVATARS, CHARACTERS, STAGES, DAYCARE_OUTFITS, archetypeForAvatar } from './config.js';
import { normalizeMaoMao } from './maomaoState.js';
import {
  preloadEssential, preloadStage, preloadTown, preloadCasino,
  preloadHomeDecor, lazyLoadGLTF, disposeCachedGLTF, BASE, GLTF_CACHE,
} from './assets.js';
import { createRendererService } from './rendering/createRenderer.js';
import { readBackendPreference } from './rendering/rendererSettings.js';
import {
  applyAccessibilityOptions,
  createPostPipeline,
} from './rendering/postfx/createPostPipeline.js';
import { buildEnv } from './env.js';
// PHASE 4 P4A (2026-05-18, cohort 1 of N) — Cave stage skeleton. Static
// import per [[feedback_kks_export_origin_module_break.md]]. Build/dispose
// hook in applyMetaUpgrades (stage.id === 'cave' arm) + _teardownActiveRun.
// Layered cohorts (P4A-c2 … P4A-cN) extend cave with rooms, weapons,
// hazards, neutrals, landmarks, music, textures, achievements.
import { buildCaveStage, disposeCaveStage, tickCave } from './stages/cave/caveStage.js';
import { buildKakiLandStage, disposeKakiLandStage, tickKakiLandStage, constrainKakiLandPosition, setKakiLandStageVisible } from './stages/kakiland/kakiLandStage.js';
import { loadKakiLandPortals, tickKakiLandPortals, disposeKakiLandPortals } from './kakiLandPortals.js';
import { unlockAudio, startMusic, setMusicTier, setMasterVolume, setMusicVolume, setSfxVolume, setAmbientVolume, suspendAudio, resumeAudio, sfx, playStageAmbient, stopRacingAudio, _debug as _audioDebug } from './audio.js';
import { getMeta, saveMeta, shopLevel, selectedAvatar, dailyChallengeConfig, equippedRelic, selectedStage, QUEST_TEMPLATES, weeklyMutatorConfig, commitWeeklyRun, setOption, SHOP_TREE, isAvatarUnlocked } from './meta.js';
import { applyWeeklyMutator } from './weeklyMutator.js';
import { recordRun } from './leaderboard.js';
// PHASE 4 P4E (#145) — Daily seed PRNG. Seeded at run-start when daily mode is
// active so spawnDirector decisions (angle / horde center / tier weighted pick
// / ring jitter) replay byte-for-byte across two browsers on the same day.
// Cleared in _teardownActiveRun so non-daily runs revert to native Math.random.
import { seedDaily, clearDailySeed, todaySeedInt } from './dailyRng.js';

// Module imports (filled in by parallel agents)
import { initInput, sampleInput, getZoom, resetZoom, clearSecondaryAction } from './input.js';
import { initHero, updateHero, updateDeathAnim, rebuildHero, resetHeroTransientFX, discardQueuedInteract } from './hero.js';
import { initEnemies, updateEnemies, prewarmPools, flushCorpses, releaseEnemyVisual } from './enemies.js';
import { initWeapons, tickWeapons, acquireWeapon, resetWeapons, _resetEvoAnnouncements, REGISTRY as WEAPON_REGISTRY } from './weapons/index.js';
import { tickChainArcs, disposeAllChainArcs } from './chainFx.js';
import { tickEvolveBursts, disposeAllEvolveBursts, setEvolveBurstStateRef } from './fx/evolveBurst.js';
import { initDissolveBurst, tickDissolveBursts, disposeAllDissolveBursts, setDissolveBurstStateRef } from './fx/dissolveBurst.js';
import { tickVelocityVeils, disposeAllVelocityVeils } from './fx/ribbonTrail.js';
import { loadAtlas, ensurePool, tickSpriteSystem, warmSpritePools, setLowFxProbe as setSpriteLowFxProbe } from './sprites/index.js';
import { initProjectileVisuals, releaseProjectileVisuals, flushProjectileVisuals } from './weapons/autoAim.js';
import { initXP, updateGems, resetXP } from './xp.js';
import { initSpawnDirector, tickSpawnDirector, secondsUntilNextMiniBoss } from './spawnDirector.js';
import { initUI, updateUI, showStartScreen, hideStartScreen, showOptions, hideOptions, isOptionsOpen, showBanner, hideBanner, setHUDVisible, hideShop, isShopOpen, hideGrimoire, isGrimoireOpen, showHouse, hideHouse, isHouseOpen, showQuestBoard, hideQuestBoard, isQuestBoardOpen, hideCredits, isCreditsOpen, showContextLossModal, showCasinoMenu, showCasinoSlots, showCasinoParlay } from './ui.js';
// Menu V2 — Claude Design handoff redesign. Legacy showStartScreen is preserved
// in ui.js as a safety-net fallback (callable directly) but main.js routes the
// post-preload boot path through showMenuV2 instead.
import { showMenuV2, hideMenuV2 } from './menuV2.js';
import { showCodex, hideCodex, isCodexOpen } from './codex.js';
import { initDamageNumbers, updateDamageNumbers } from './damageNumbers.js';
import { initFX, updateFX, resetFX } from './fx.js';
import { initVFXBurst, updateVFXBurst, resetVFXBurst, warmVFXBurst } from './vfxBurst.js';
import { initChests, tickChests, resetChests, spawnAt as spawnChestAt, warmChestVisuals } from './chest.js';
import { disposeBossTelegraphs, initBossTelegraphs, updateBossTelegraphs, resetBossTelegraphs } from './bossTelegraphs.js';
import { initDestructibles, resetDestructibles, syncDestructiblesVisibility } from './destructibles.js';
import { initPerfHUD, updatePerfHUD, perfStart, perfMark, _perfHUDSetProfilerOn } from './perfHUD.js';
import { initPerfProfiler, renderOverlay as renderPerfProfilerOverlay, isEnabled as isPerfProfilerEnabled } from './perfProfiler.js';
import { initParticleTextures } from './particleTextures.js';
import { initPickups, tickPickups, resetPickups } from './pickups.js';
import { initBlobShadows, updateBlobShadows } from './blobShadows.js';
import { initEnemyProjectileVisuals, updateEnemyProjectiles, clearEnemyProjectiles } from './enemyProjectiles.js';
import { buildTown, enterTown, exitTown, tickTown, setGateHandler, setInteractionHandler, refreshTownCasinoExterior, suspendTown } from './town.js';
import { buildInterior, enterInterior, exitInterior, tickInterior, setInteriorHandler } from './interior.js';
import { buildCasinoInterior, enterCasinoInterior, exitCasinoInterior, tickCasinoInterior, setCasinoInteriorHandler } from './casinoInterior.js';
import { buildCatacomb, tickCatacomb, tickCatacombEntrance, exitCatacomb, resetCatacomb } from './catacomb.js';
import { enterBulletHell, tickBulletHell, exitBulletHell, getBhCampaign } from './bullethell/index.js';
import { ARENA_CX as BH_CX, ARENA_CZ as BH_CZ } from './bullethell/bhState.js';
import { enterRacing, tickRacing, exitRacing, restartRacing, updateRacingCamera, resizeRacingCamera, getRacingCameraConfig, getRacingSnapshot } from './racing/index.js';
import { RACE_MODES } from './racing/tracks.js';
import { playCutscene } from './cutscene.js';
import { showSketchbook } from './sketchbook.js';
import { showYarnDart } from './yarndart.js';
import { showTeaSteep } from './teasteep.js';
import { initTotems, tickTotems, resetTotems, warmTotemVisuals } from './totems.js';
import { initPylons, tickPylons, resetPylons } from './pylons.js';
import { initBells, tickBells, resetBells } from './bells.js';
import { initEnemyTells, updateEnemyTells, resetEnemyTells } from './enemyTells.js';
import { initStageHazards, tickStageHazards, resetStageHazards, loadForestHazards, clearForestHazards, loadTwilightHazards, clearTwilightHazards, loadCinderHazards, clearCinderHazards, loadVoidHazards, clearVoidHazards } from './stageHazards.js';
import { applyStageRule, tickStageRule, clearStageRule } from './stageRules.js';
import { loadArenaDecor, clearArenaDecor } from './arenaDecor.js';
import { loadStageLife, tickStageLife, syncStageLifeVisibility } from './stageLife.js';
import { loadForestAmber, tickForestAmber, clearForestAmber } from './forestAmber.js';
import { initLockdownArena, tickLockdownArena, armLockdown, triggerLockdown, warmLockdownArena, disposeLockdownArenas } from './lockdownArena.js';
import { initTrapCorridor, tickTrapCorridor, armCorridor, disposeTrapCorridors } from './trapCorridor.js';
import { tickPuzzleSystem, startPuzzle as _puzzleStart } from './puzzleSystem.js';
import { detectRoom, FOREST_ROOMS, constrainForestPosition, constrainForestPortalRoomPosition } from './forestRooms.js';
import { loadForestPortals, tickForestPortals, clearForestPortals, syncForestPortalUiVisibility } from './forestPortals.js';
import { tickForestSealedDoors, disposeForestSealedDoors, onRoomEnter as _forestSealOnRoomEnter, syncForestSealedDoorUiVisibility } from './forestSealedDoors.js';
import { loadFlowWeaver, disposeFlowWeaver } from './puzzleFlowWeaver.js';
import { loadHarmonicAlignment, disposeHarmonicAlignment } from './puzzleHarmonicAlignment.js';
import { loadPrismLock, disposePrismLock } from './puzzlePrismLock.js';
// FE-V2 (2026-05-17) — Mossroot Hollow simon-says puzzle. tickMossrootPulse
// is driven internally by puzzleSystem.onTick (registered at module load);
// main.js only handles load + dispose lifecycle.
import { loadMossrootPulse, disposeMossrootPulse } from './puzzleMossrootPulse.js';
// FE-V2 Landmarks (2026-05-17) — scene-scoped VS-style interactable density
// (interactive shrines / altars). tickForestLandmarks runs the AABB
// trigger pass + telegraph pulse fade. dispose mirrors the disposeFlowWeaver
// teardown shape — also clears `state._landmarksLoaded` so the next forest
// scene load re-populates landmarks fresh.
import { tickForestLandmarks, disposeForestLandmarks } from './forestLandmarks.js';
// FE-V2 Coffins (2026-05-17) — Evolution Coffin entities (VS-style hidden
// chests that unlock superweapons). Loaded by arenaDecor alongside landmarks.
// Teardown mirrors disposeForestLandmarks — also clears state._coffinsLoaded
// so the next forest scene load triggers a fresh placement.
import { tickForestCoffins, disposeForestCoffins } from './forestCoffins.js';
// FE-V2 Neutrals (2026-05-17) — roaming non-combat entities (fireflies / deer
// / owls). Loaded by arenaDecor alongside landmarks + coffins. Teardown
// mirrors disposeForestCoffins — also clears state._neutralsLoaded so the
// next forest scene load triggers a fresh placement.
import { tickForestNeutrals, disposeForestNeutrals } from './forestNeutrals.js';
// FE-V2 Environmental Hazards (FE-V2-A5, 2026-05-17) — mushroom rings, tar
// pits, falling branches across all 7 forest rooms. Damage hero AND enemies
// (VS-style kite mechanic). Hero also gets slow (mushrooms/tar pit) and
// stun-via-zero-spd (branches). Loaded by arenaDecor alongside neutrals.
import { tickForestEnvHazards, disposeForestEnvHazards } from './forestEnvHazards.js';
// FOREST-V2-A6 Treasure Chest Drops — VS-style 3-option picker on miniboss/
// elite kill. Loaded by arenaDecor sibling to envHazards; teardown mirrors
// the same 5-site dispose pattern. Tick advances chest open animation +
// pickup detect; modal dispatch fires once per pick (user-action, not hot
// path).
import { tickForestChests, disposeForestChests } from './forestChests.js';
// FOREST-V2-A7 Reaper Endgame — VS 30-minute hunter. Spawns invincible
// Reaper at 30:00 stage time; outlast 5 minutes for +500 coins. Forest-only.
// Self-contained mesh + tick (NOT in state.enemies), so weapon hit loops
// can't touch it. Teardown mirrors the 5-site chests dispose pattern.
import { tickForestReaper, disposeForestReaper } from './forestReaper.js';
import { tickForestPickups, disposeForestPickups } from './forestPickups.js';
import { tickForestWeaponDrops, disposeForestWeaponDrops } from './forestWeaponDrops.js';
import { tickForestDayNight, disposeForestDayNight } from './forestDayNight.js';
import { tickForestSkyDome, disposeForestSkyDome } from './forestSkyDome.js';
import { tickForestHud, disposeForestHud } from './forestHud.js';
import { tickForestSigilArc, disposeForestSigilArc } from './forestSigilArc.js';
import { tickForestEmitters, disposeForestEmitters } from './forestEmitters.js';
import { tickForestBossBars, disposeForestBossBars } from './forestBossBars.js';
// PHASE 1 P1E (2026-05-17) — Boss intro cinematic. Stage-agnostic: ticked
// every frame regardless of stage so miniboss/elite/room-boss/Reaper spawns
// on ANY stage get the 1.5s dolly+banner. Mount lives in arenaDecor.
// Dispose mirrors the 5-site forestBossBars teardown so DOM doesn't leak
// across stage swaps.
import { tickBossIntroCinematic, disposeBossIntroCinematic } from './bossIntroCinematic.js';
// PHASE 1 P1J (2026-05-17) — Weapon evolve cinematic. Stage-agnostic 1.0s
// camera punch-in + gold burst + slot-7 banner when a Forest Evolution
// Coffin dispatches an evolution. Tick runs AFTER tickBossIntroCinematic so
// it takes camera priority when both fire (with a deny gate as belt-and-
// suspenders in triggerEvolveCinematic). Dispose mirrors the 5-site teardown.
import { tickEvolveCinematic, disposeEvolveCinematic } from './evolveCinematic.js';
// PHASE 1 P1F (2026-05-17) — End-of-run summary screen. Stage-agnostic VS-
// style results panel. Tick polls state.gameOver + state.run.stats
// .reaperOutlasted (NO direct hooks into enemies/death paths). Mounted
// AFTER the per-frame return guards so the main tick can short-circuit
// normally during gameOver — see _tickEndRunSummaryEarly call site at the
// top of frame() for placement detail. Dispose mirrors the 5-site
// bossIntroCinematic teardown so DOM doesn't leak across stage swaps.
import { loadEndRunSummary, tickEndRunSummary, disposeEndRunSummary } from './endRunSummary.js';
// PHASE 4 P4J (#140) — Per-run telemetry harness. Stage-agnostic poll-based
// begin/end detection (no invasive hooks into start/teardown). Counters live
// on a module-local _current record; instrumented call sites bump in-place
// via event(). Persists last 100 runs to localStorage `kks_telemetry`.
import { tickTelemetry as tickTelemetryPoll, event as telemetryEvent } from './telemetry.js';
// PHASE 1 P1B (swarm/forest-achievements) — Achievement chain. Stage-agnostic
// per-tick check loop (kills / time / weapon / hp). loadAchievements binds
// state + WEAPON_REGISTRY for the visible-kit count probe. The module also
// exports disposeAchievements for session teardown — not imported here
// because toasts self-clean (4s setTimeout) and the title panel is owned by
// menuV2 (which calls mountTitlePanel on show, never needs explicit dispose
// on hide because the parent DOM removal cascades the indicator).
import { loadAchievements, tickAchievements } from './forestAchievements.js';
import { loadTwilightFountains, tickTwilightFountains, clearTwilightFountains } from './twilightFountains.js';
import { loadCinderBallistas, tickCinderBallistas, clearCinderBallistas } from './cinderBallistas.js';
import { loadVoidTeleportPads, tickVoidTeleportPads, clearVoidTeleportPads } from './voidTeleportPads.js';
import { initMiniEvents, tickMiniEvents, resetMiniEvents, teardownMiniEvents, syncMiniEventUIVisibility } from './miniEvents.js';
import {
  initPortalShards,
  spawnPortalShards,
  tickPortalShards,
  resetPortalShards,
  syncPortalShardHudVisibility,
} from './portalShards.js';
import { tickSynergies, resetSynergies } from './synergies.js';
import { notifyTutorialEvent } from './tutorial.js';
// Iter 10b — perf soak benchmark. Side-effect import installs window.kkSoak
// so the soak is callable from the DevTools console without any UI hook.
import './perfSoak.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('game-canvas');
const stage = document.getElementById('kk-stage');
// Cap the playfield at 16:9. On wider displays (ultrawide / 32:9) the stage is
// pinned to viewport height and the extra width becomes black letterbox bars;
// on taller-than-16:9 (portrait phones) it's pinned to width with top/bottom
// bars. W/H below are the STAGE dimensions, not the window — the ortho camera
// aspect, renderer buffer, and all fixed UI overlays key off these so nothing
// stretches on a 32:9 panel. See index.html#kk-stage for the CSS contract.
// Desktop ultrawide stays capped at 16:9 (user's pick — tames 32:9 panels).
// Touch devices (phones) get 21:9 so a landscape S24 (~19.5:9) fills edge to
// edge instead of sitting in fat side bars at the 16:9 cap.
// Robust touch detection — `(pointer: coarse)` alone returned false on a real
// S24 (some Android browsers misreport), so also honor touch-point count /
// touch events. `?touch=1` forces it for the headless smoke test.
const _coarsePointer = typeof window !== 'undefined' && (
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  || (navigator.maxTouchPoints > 0)
  || ('ontouchstart' in window)
  || /[?&]touch=1/.test(location.search)
);
const MAX_ASPECT = _coarsePointer ? 21 / 9 : 16 / 9;
function computeStage() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let w, h;
  // Touch/phones: ALWAYS fill the viewport, with NO aspect cap — so neither
  // orientation gets bars. (The browser chrome can make a landscape phone's
  // usable AR exceed 21:9, e.g. ~2340x1000 = 2.34, which a cap would pillarbox
  // into side bars — exactly the report. Phones are never absurdly wide, so a
  // cap buys nothing here.) Checked FIRST so the too-wide branch can't fire.
  if (_coarsePointer) { w = vw; h = vh; }
  else if (vw / vh > MAX_ASPECT) { h = vh; w = Math.round(vh * MAX_ASPECT); }  // desktop ultrawide → pillarbox
  else { w = vw; h = Math.round(vw / MAX_ASPECT); }                            // desktop → fixed 16:9
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  return { w, h };
}

// ── Landscape gate (touch only) ──
// The game is built for landscape; a portrait phone gives a cramped view. Show
// a full-screen rotate prompt over everything while in portrait. (Best-effort
// orientation lock is attempted on first gesture — Android Chrome honors it in
// fullscreen/PWA; elsewhere it no-ops and the visual gate is the mechanism.)
let _rotateGate = null;
function _updateOrientationGate() {
  if (!_coarsePointer) return;
  if (!_rotateGate) {
    const g = document.createElement('div');
    g.id = 'kk-rotate-gate';
    g.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;'
      + 'flex-direction:column;align-items:center;justify-content:center;gap:16px;'
      + 'background:#05060a;color:#ffd27f;text-align:center;padding:24px;'
      + "font-family:'Cinzel',serif;";
    g.innerHTML = '<div style="font-size:60px;line-height:1;animation:kkrot 1.8s ease-in-out infinite;">↻</div>'
      + '<div style="font-size:22px;letter-spacing:2px;">Rotate to landscape</div>'
      + '<div style="font-size:13px;opacity:.6;font-family:Geist,system-ui,sans-serif;">Kitty Kaki plays in landscape</div>'
      + '<style>@keyframes kkrot{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(78deg)}}</style>';
    document.body.appendChild(g);
    _rotateGate = g;
  }
  _rotateGate.style.display = (window.innerHeight > window.innerWidth) ? 'flex' : 'none';
}
function _tryLockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (_) {}
}

let { w: W, h: H } = computeStage();
const ASPECT = () => W / H;

function _ensureBootLoader(message = 'Loading…') {
  let loader = document.getElementById('kk-boot-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'kk-boot-loader';
    loader.style.cssText = 'position:fixed;inset:0;background:linear-gradient(rgba(5,3,10,0.55),rgba(5,3,10,0.75)),#05030a url("assets/screens/portalkey.webp") center center / cover no-repeat;display:flex;align-items:center;justify-content:center;z-index:9999;font-family:"Cinzel",serif;font-size:14px;letter-spacing:0.3em;color:rgba(236,230,213,0.85);text-transform:uppercase;pointer-events:auto;text-shadow:0 2px 12px rgba(0,0,0,0.9);text-align:center;padding:32px;box-sizing:border-box;';
    document.body.appendChild(loader);
  }
  loader.textContent = message;
  return loader;
}

function _urlForRenderer(backend) {
  const url = new URL(window.location.href);
  url.searchParams.set('renderer', backend);
  return url.href;
}

function _showRendererFailure(error, { canSwitchToWebGL = true } = {}) {
  const loader = _ensureBootLoader('');
  loader.replaceChildren();
  loader.style.flexDirection = 'column';
  loader.style.gap = '18px';

  const title = document.createElement('strong');
  title.style.cssText = 'font-size:20px;color:#ff9b83;letter-spacing:.18em;';
  title.textContent = 'Graphics could not start';
  const detail = document.createElement('span');
  detail.style.cssText = 'max-width:620px;font:14px/1.55 Geist,system-ui,sans-serif;letter-spacing:0;text-transform:none;color:#eee6d5;';
  detail.textContent = error?.message || 'The browser could not initialize a supported graphics backend.';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center;';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.onclick = () => window.location.reload();
  actions.appendChild(retry);
  if (canSwitchToWebGL) {
    const fallback = document.createElement('button');
    fallback.type = 'button';
    fallback.textContent = 'Use WebGL 2';
    fallback.onclick = () => { window.location.href = _urlForRenderer('webgl'); };
    actions.appendChild(fallback);
  }
  for (const button of actions.children) {
    button.style.cssText = 'padding:11px 18px;border:1px solid rgba(255,210,145,.65);border-radius:8px;background:#171019;color:#ffe1ae;cursor:pointer;font:700 12px Cinzel,serif;letter-spacing:.12em;text-transform:uppercase;';
  }
  loader.append(title, detail, actions);
}

const _rendererBootLoader = _ensureBootLoader('Preparing graphics…');
// Promo capture runs inside a software-rendered browser surface. Let the
// recorder spend its frame budget on gameplay motion instead of post-FX.
const _promoCapture = typeof window !== 'undefined'
  && /[?&]promo-action=1(?:&|$)/.test(window.location.search || '');
// Promo capture runs through software WebGL under Xvfb. Render its CSS-sized
// canvas at half density so the live game clock can sustain motion; the
// browser still records a 1280x720 surface and the normal game keeps its
// existing DPR cap and visual quality.
// iter 33z — DPR cap dropped 1.75 → 1.25. User report: render 21.84 ms / 41 FPS
// with 219 enemies; bloom-pass × 1.75² = 3.06× pixel cost dominated the budget.
// 1.25 cuts rasterized pixels ~50% vs 1.75 (1.25²/1.75² = 0.51). Visual hit on
// retina is mild because the camera is ortho — geometric edges are already
// post-AA'd by the bloom downsample chain.
// A query parameter is a temporary QA/support override. When absent, boot from
// the strictly validated profile preference selected under Display settings.
const _preferredBackend = readBackendPreference(
  window.location.search,
  getMeta().optRenderer,
);
let _frameRendererFailure = false;
function _handleRendererFrameError(error) {
  // Initialization failures already have a recovery screen. Runtime WebGPU
  // validation/allocation failures used to only land in the console, leaving
  // the menu or Draw Track handoff looking frozen. Promote the first one to
  // the same actionable recovery UI and stop gameplay while it is visible.
  if (_frameRendererFailure) return;
  _frameRendererFailure = true;
  if (state?.time) state.time.paused = true;
  console.error('[renderer] Animation frame failed.', error);
  _showRendererFailure(error, {
    canSwitchToWebGL: rendererService.backend !== 'webgl',
  });
}
const rendererService = createRendererService({
  canvas,
  preferredBackend: _preferredBackend,
  settings: {
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    width: W,
    height: H,
    dprCap: 1.25,
    pixelRatio: _promoCapture ? 0.5 : undefined,
    threeRevision: THREE.REVISION,
    configureRenderer(nextRenderer) {
      nextRenderer.outputColorSpace = THREE.SRGBColorSpace;
      nextRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      nextRenderer.toneMappingExposure = 1.05;
      nextRenderer.shadowMap.enabled = !_promoCapture;
      nextRenderer.shadowMap.type = THREE.PCFShadowMap;
      nextRenderer.shadowMap.autoUpdate = true;
      nextRenderer.info.autoReset = false;
    },
    saveStateOnDeviceLoss() {
      // Persistent progression already lives in the compatible v2 save. Flush
      // it once more before recovery; the active run itself is not authoritative
      // save data and is deliberately not serialized here.
      if (saveMeta() !== true) throw new Error('Persistent progression could not be written.');
      sessionStorage.setItem('kk-renderer-loss', JSON.stringify({
        at: Date.now(),
        mode: state.mode || 'menu',
        stage: state.run?.stage?.id || null,
      }));
    },
  },
  contextProvider: () => ({
    activeScene: state.run?.stage?.id || state.mode || 'menu',
    activeMode: state.mode || 'menu',
  }),
  onFrameError: _handleRendererFrameError,
  onBackendReady({ backend }) {
    _rendererBootLoader.textContent = `Preparing ${backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'}…`;
  },
  onBackendFailure({ error, canSwitchToWebGL }) {
    _showRendererFailure(error, { canSwitchToWebGL });
  },
  onDeviceLost({ recoveryState }) {
    if (state?.time) state.time.paused = true;
    try { showContextLossModal({ backend: rendererService.backend, recoveryState }); }
    catch (error) { console.error('[renderer] recovery UI failed', error); }
  },
});

try {
  await rendererService.initialize();
} catch (error) {
  _showRendererFailure(error, { canSwitchToWebGL: _preferredBackend !== 'webgl' });
  throw error;
}

const renderer = rendererService.renderer;

const scene = new THREE.Scene();
scene.background = new THREE.Color(WORLD.bgColor);
scene.fog = new THREE.Fog(WORLD.bgColor, WORLD.fogNear, WORLD.fogFar);

// Orthographic camera, isometric-ish (matches original game's TD view)
const gameplayCamera = new THREE.OrthographicCamera(
  -WORLD.cameraDistance * ASPECT(), WORLD.cameraDistance * ASPECT(),
   WORLD.cameraDistance,            -WORLD.cameraDistance,
   0.1, 800
);
let camera = gameplayCamera;
let setPostCamera = null;
// Kaki Land originally framed almost the entire 52u island (half=22), which
// made its detailed Grok turf/plaza kit and hero read like a distant map UI.
// Keep a wider view than normal combat, but make bridges/islands something the
// player explores instead of seeing the whole chapter at once.
const KAKI_LAND_CAMERA_HALF = 15.5;
// Match original kitty-kaki forest camera offset (40, 60, 40 looking at origin).
gameplayCamera.position.set(40, 60, 40);
gameplayCamera.lookAt(0, 0, 0);

// Orthographic projection only changes when the stage aspect, camera mode, or
// zoom notch changes. Rebuilding + inverting the projection matrix every frame
// was pure work during steady-state play (and in every interior mode).
function setOrthoFrustum(halfHeight, aspect = ASPECT()) {
  const left = -halfHeight * aspect;
  const right = halfHeight * aspect;
  const top = halfHeight;
  const bottom = -halfHeight;
  if (gameplayCamera.left === left && gameplayCamera.right === right &&
      gameplayCamera.top === top && gameplayCamera.bottom === bottom) return false;
  gameplayCamera.left = left;
  gameplayCamera.right = right;
  gameplayCamera.top = top;
  gameplayCamera.bottom = bottom;
  gameplayCamera.updateProjectionMatrix();
  return true;
}

function _setActiveCamera(nextCamera) {
  if (!nextCamera || camera === nextCamera) return;
  camera = nextCamera;
  state.camera = nextCamera;
  setPostCamera?.(nextCamera);
}

function _snapBulletHellCamera() {
  _setActiveCamera(gameplayCamera);
  camera.position.set(BH_CX + 22, 42, BH_CZ + 22);
  camera.lookAt(BH_CX, 0.6, BH_CZ);
  setOrthoFrustum(25.5);
}

function _snapRacingCamera() {
  const result = updateRacingCamera(0, {
    aspect: ASPECT(),
    reducedMotion: !!state._optReduceMotion,
    snap: true,
  });
  if (result?.camera) _setActiveCamera(result.camera);
}

state.scene = scene; state.camera = camera; state.renderer = renderer;

// Install the stable r185 RenderPipeline/TSL graph after async backend init.
// Its MRT beauty pass produces selective bloom without a second scene render.
rendererService.pipeline.setScene(scene);
rendererService.pipeline.setCamera(camera);
await rendererService.pipeline.replace(({ renderer: activeRenderer, scene: activeScene, camera: activeCamera }) => (
  createPostPipeline({
    renderer: activeRenderer,
    scene: activeScene,
    camera: activeCamera,
    quality: 'legacy',
    samples: 0,
  })
));
const postPipeline = rendererService.pipeline.getPipeline();
postPipeline.setSize(W, H);
const { composer, bloomComposer, bloomPass, postFXPass } = postPipeline;
setPostCamera = (nextCamera) => rendererService.pipeline.setCamera(nextCamera);
state.composer = composer; state.bloomComposer = bloomComposer;
state.bloomPass = bloomPass; state.postFXPass = postFXPass;
state.rendererService = rendererService;
window.__kkRendererService = rendererService;

// Resize
window.addEventListener('resize', () => {
  ({ w: W, h: H } = computeStage());
  rendererService.resize(W, H);
  setOrthoFrustum(WORLD.cameraDistance);
  resizeRacingCamera(ASPECT());
  _updateOrientationGate();
});
// Landscape gate: react to rotation + show on boot. Best-effort orientation
// lock fires once on the first gesture (the API needs a user gesture/fullscreen).
window.addEventListener('orientationchange', () => setTimeout(_updateOrientationGate, 60));
if (_coarsePointer) {
  _updateOrientationGate();
  const lockOnce = () => { _tryLockLandscape(); window.removeEventListener('pointerdown', lockOnce); window.removeEventListener('touchend', lockOnce); };
  window.addEventListener('pointerdown', lockOnce, { passive: true });
  window.addEventListener('touchend', lockOnce, { passive: true });
}

function renderFrame() {
  if (_promoCapture) {
    renderer.info.reset();
    camera.layers.enableAll();
    renderer.render(scene, camera);
    return;
  }
  camera.layers.enableAll();
  rendererService.render(scene, camera);
}

// Unlock audio on first interaction
['click', 'touchstart', 'keydown'].forEach(ev =>
  window.addEventListener(ev, unlockAudio, { once: true })
);

// ── URL replay-seed parsing ──────────────────────────────────────────────────
// Format produced by leaderboard.makeSeed(): `<S>-<CC>-<MM>[-yy-mm-dd]` where
// S = stage first char, CC = char first two chars, MM = mode first two chars.
// We reverse the prefix tokens by matching against CHARACTERS/STAGES ids so a
// future renamed stage/char doesn't silently misroute. The date suffix is
// informational only — players can replay any day's seed, not just today's.
// Defensive: malformed seed = no-op + console.warn (do NOT throw on boot).
function _parseReplaySeedFromURL() {
  if (typeof window === 'undefined' || !window.location) return;
  const params = new URLSearchParams(window.location.search || '');
  const seed = params.get('seed');
  if (!seed) return;
  const parts = seed.split('-');
  if (parts.length < 3) { console.warn('[replaySeed] malformed (need 3+ tokens):', seed); return; }
  const [sTok, cTok, mTok] = parts;

  const stage = STAGES.find(s => (s.id || '').toUpperCase().startsWith(sTok));
  const char  = CHARACTERS.find(c => (c.id || '').toUpperCase().startsWith(cTok));
  if (!stage || !char) {
    console.warn('[replaySeed] unknown stage/char tokens:', sTok, cTok);
    return;
  }
  // Mode mapping (2-char prefix of the makeSeed mode string).
  // 'NM'→normal, 'HY'→hyper, 'EN'→endless, 'DA'→daily, 'BO'→boss-rush, 'WE'→weekly
  const MODE_MAP = { NM: 'normal', HY: 'hyper', EN: 'endless', DA: 'daily', BO: 'boss-rush', WE: 'weekly' };
  const mode = MODE_MAP[mTok] || 'normal';

  setOption('selectedStage', stage.id);
  setOption('selectedChar',  char.id);
  // We deliberately do NOT toggle optHyper/optDaily/etc here — letting the
  // user opt into a mode is a deliberate click. The selection just preloads
  // stage + character.
  state.replaySeed = { seed, stage: stage.id, character: char.id, mode };
}

// ── Async init ────────────────────────────────────────────────────────────────

async function boot() {
  // URL param `?seed=F-KI-NM-26-05-13` lets a player open a friend's run with
  // the stage + character + mode preselected. We DON'T start the run — just
  // stamp meta so the character picker reflects the seed, and stash a
  // state.replaySeed for 9c's "Replaying X's run" header.
  try { _parseReplaySeedFromURL(); } catch (e) { console.warn('[boot.replaySeed]', e); }

  // Iter 36 — boot loader. Legacy showStartScreen() during preload was painting
  // the full v1 menu (title + ornament + char carousel placeholder), then v2
  // swapped in on top → visible "old menu, then new menu" flash. Use a minimal
  // black overlay during preload instead; it's removed before showMenuV2().
  const _bootLoader = _ensureBootLoader('Loading…');
  initParticleTextures();   // synchronous canvas → texture, no network
  // Hotfix #151 (perf): boot loads ONLY essential assets (hero donor + the
  // selected avatar override + paw-crystal XP + painted burger orbital). The remaining
  // avatar models load only when the Heroes carousel is opened. Stage enemy roster, town
  // kits, casino, dungeon kits, and home decor all defer to their respective
  // entry points (see assets.js preloadStage / preloadTown / preloadCasino /
  // preloadHomeDecor). Cuts menu-boot RAM from ~2.4 GB to <600 MB.
  const _bootMeta = getMeta();
  await preloadEssential((_bootMeta && _bootMeta.selectedAvatar) || 'kitty');
  // iter 33w — load the hand-painted FX manifest before initFX so synchronous
  // fxTex('ring_arcane') calls during init hit the WebP path, not the canvas
  // fallback. Texture image data still arrives async; the manifest fetch is
  // small (~1 KB) and happens in parallel with preloadEssential above.
  try {
    const { fxAwait } = await import('./fxTextures.js');
    await fxAwait();
  } catch (e) {
    console.warn('[boot.fxTex]', e);
  }

  state.envGroup = buildEnv(scene, rendererService);
  // Defer every walkable hub room to its enter handler. The cabin is mostly
  // procedural, but it is still 80+ meshes; building it here left that whole
  // invisible room in the combat scene for every run. buildCatacomb is kept because it
  // also adds the always-visible overworld entrance stairs to the run scene
  // — the chamber decor degrades to primitives without dungeon kits.
  buildCatacomb(scene);

  initInput();
  initUI();
  setHUDVisible(false);
  // PHASE 1 P1B — Achievement chain. Binds state + WEAPON_REGISTRY (already
  // imported above) so the per-tick visible-kit count + per-run Set lookup
  // work without a circular import. No DOM is touched here; mountTitlePanel
  // is wired separately by menuV2.
  loadAchievements(state, WEAPON_REGISTRY);
  // PHASE 1 P1F — End-of-run summary screen. Binds state ref so the per-
  // frame tick poll can read state.run + state.gameOver without a static
  // import cycle. DOM is lazy-built on first show; load() does NOT touch
  // the document tree.
  loadEndRunSummary(state);
  initDamageNumbers();
  initFX(scene);
  // Ascension Evolution FX (Punch List #1) needs a state handle so the
  // 30s player rim can follow state.hero.pos without a static import cycle.
  setEvolveBurstStateRef(state);
  // Dissolve-to-Gold death FX (Punch List #3). Init the pre-pooled
  // InstancedMesh (cap 256, ZERO per-death allocation) and wire the state
  // handle so `state.run.lowFx` can short-circuit the spawn path. Must run
  // AFTER the scene exists (initFX above) and BEFORE initEnemies binds the
  // killEnemy hook (defensive; init is idempotent so order is forgiving).
  initDissolveBurst(scene);
  setDissolveBurstStateRef(state);
  initVFXBurst(scene);
  initTotems(scene);
  initPylons(scene);
  initBells(scene);
  initEnemyTells(scene);
  initStageHazards(scene);
  initMiniEvents(scene);
  initPortalShards(scene);
  initChests(scene);
  // Lockdown Arena (stage-agnostic dungeon mechanic; FOREST ITER C1). Init
  // here so any stage's load* path can call armLockdown(...) once the scene
  // is alive. Forest arms one arena in the south-cluster (~1, -28) below.
  initLockdownArena(scene);
  // Trap Corridor (stage-agnostic env-damage hazard lane; FOREST ITER C2).
  // Init here so any stage's load* path can call armCorridor(...) once the
  // scene is alive. Forest arms one 3-shard corridor in the north cluster.
  initTrapCorridor(scene);
  initPickups(scene);
  initBossTelegraphs(scene);
  initDestructibles(scene);
  initPerfHUD();
  initPerfProfiler();
  _perfHUDSetProfilerOn(isPerfProfilerEnabled());
  initBlobShadows(scene);
  initHero(scene);
  initEnemies(scene);
  initWeapons();
  initProjectileVisuals(scene);
  initEnemyProjectileVisuals(scene);
  initXP(scene);
  initSpawnDirector();
  // Sprite system low-fx kill-switch — when state.run.lowFx is true, atlases
  // flagged bypassWhenLowFx skip spawn calls. Foundation only — no atlases
  // are loaded yet at this point; pools are created lazily by FX wiring.
  setSpriteLowFxProbe(() => !!(state.run && state.run.lowFx));

  // Sprite FX bootstrap — load 4 starter sheets + create pools. Async; if any
  // sheet fails to load (404 in dev, broken json), log warning and continue —
  // missing atlas just means its later spawn calls no-op; no game crash.
  (async () => {
    try {
      await Promise.all([
        loadAtlas('fx/hit_flash_v1',       'assets/sprites/fx/hit_flash_v1.json'),
        loadAtlas('fx/dust_puff_v1',       'assets/sprites/fx/dust_puff_v1.json'),
        loadAtlas('fx/aura_rings_v1',      'assets/sprites/fx/aura_rings_v1.json'),
        loadAtlas('fx/borgir_explosion_v1','assets/sprites/fx/borgir_explosion_v1.json'),
        // Enemy horde billboards (baked from the trash-mob GLBs). One atlas →
        // one InstancedMesh → the whole horde renders in a single draw call,
        // collapsing the ~1700-draw-call 3D-horde cost (see enemies.js).
        loadAtlas('enemies',               'assets/sprites/enemies_v1.json'),
      ]);
      ensurePool(scene, 'fx/hit_flash_v1',        256, { bypassWhenLowFx: true });
      ensurePool(scene, 'fx/dust_puff_v1',         96, { bypassWhenLowFx: true });
      ensurePool(scene, 'fx/aura_rings_v1',        16, { bypassWhenLowFx: false });
      ensurePool(scene, 'fx/borgir_explosion_v1',  32, { bypassWhenLowFx: false });
      ensurePool(scene, 'enemies',                512, { bypassWhenLowFx: false });
      console.log('[sprites] bootstrap ok — 5 atlases loaded, 5 pools live (hit_flash, dust_puff, aura_rings, borgir_explosion, enemies)');
    } catch (e) {
      console.warn('[sprites] bootstrap failed:', e);
    }
  })();

  // Hotfix #151: prewarmPools at boot is a no-op now that enemy GLBs defer
  // to preloadStage. The real prewarm happens inside start() after the
  // stage's mob roster lands in GLTF_CACHE. Skipping the no-op call here
  // avoids ~20 "[enemies] prewarm: GLTF X not loaded" console warnings on
  // first paint. prewarmPools is idempotent — calling it later catches up.

  resetState();
  resetZoom();      // every run starts fully zoomed in; powerup unlocks notches
  resetChests();
  resetPickups();
  // Run stats, stage decoration, and weapon visuals are intentionally deferred
  // until Embark. Besides shortening menu boot, this ensures first-session
  // avatar/stage choices are read after the player makes them.

  // Compile the shared MRT scene pass and fullscreen TSL graph while the
  // loading overlay is visible. Stage-only pipelines still warm lazily when
  // their assets load, so the menu does not wait for every game mode.
  _bootLoader.textContent = 'Warming effects…';
  try {
    await warmVFXBurst(() => rendererService.pipeline.compile());
  } catch (error) {
    _showRendererFailure(error, { canSwitchToWebGL: rendererService.backend !== 'webgl' });
    throw error;
  }

  // Iter 36 — Menu V2 swap. Essential preload has resolved, GLTF_CACHE.hero is ready,
  // so showMenuV2 can mount the carousel immediately. Tear down the boot loader
  // overlay first to avoid double-painting. hideStartScreen() left as a no-op
  // safety net in case any code path still mounted the legacy DOM.
  try { document.getElementById('kk-boot-loader')?.remove(); } catch (_) {}
  try { hideStartScreen(); } catch (_) {}
  showMenuV2();
  // ── Iter 10a — Apply saved options at boot ──
  const meta = getMeta();
  // Honor OS prefers-reduced-motion on FIRST boot only (sentinel:
  // optReduceMotionUserSet). After the user explicitly toggles the option,
  // their choice always wins over the OS hint.
  try {
    if (!meta.optReduceMotionUserSet
        && typeof window !== 'undefined'
        && typeof window.matchMedia === 'function') {
      const mm = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mm && mm.matches) {
        meta.optReduceMotion = true;
      }
    }
  } catch (_) {}
  // Mirror reduce-motion + reduced-flashing into state caches for per-frame reads.
  state._optReduceMotion   = !!meta.optReduceMotion;
  state._optReducedFlashing = !!meta.optReducedFlashing;
  // Shake multiplier: reduce-motion forces 0 regardless of optShake slider.
  state._optShakeMul = state._optReduceMotion ? 0 : Number(meta.optShake);
  // Audio mix split — push all four buses from meta. Legacy setVolume() is
  // a back-compat shim that aliases setMasterVolume; we call the explicit
  // setters here so the new keys win when both are present.
  // P4G #141 (2026-05-18): added optAmbientVolume — fourth bus governs sampled
  // stage ambient loops (forest day/night phases + flat beds). Defaults via
  // the meta DEFAULT spread; the `!= null` guard keeps boot safe for older
  // saves that predate the key.
  setMasterVolume(meta.optMasterVolume != null ? meta.optMasterVolume : meta.optVolume);
  setMusicVolume(meta.optMusicVolume != null ? meta.optMusicVolume : (meta.optVolume * 0.6));
  setSfxVolume(meta.optSfxVolume != null ? meta.optSfxVolume : meta.optVolume);
  setAmbientVolume(meta.optAmbientVolume != null ? meta.optAmbientVolume : 0.6);
  // P4G #141 — expose the audio debug surface on window for the smoke test.
  // Off the public API surface (underscore prefix). Smoke reads it directly.
  try { if (typeof window !== 'undefined') window.kkAudioDebug = _audioDebug; } catch (_) {}
  // Accessibility uniforms (chromatic gate + colorblind remap + high contrast).
  applyAccessibilityOptions(state.postFXPass, {
    reduceMotion: state._optReduceMotion,
    reduceFlashing: state._optReducedFlashing,
    colorblind:   meta.optColorblind,
    highContrast: !!meta.optHighContrast,
  });
  // Font scale CSS var.
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      let fs = Number(meta.optFontScale);
      if (!Number.isFinite(fs)) fs = 1;
      // NOTE: do NOT auto-bump on coarse — the modals/level-up cards consume this
      // var and a 1.2 bump made them oversized + cramped on a short landscape
      // phone (cards 327px tall in a 402 viewport). The main-menu legibility fix
      // is independent (menuV2.css @media coarse). Players can still raise it via
      // the Font Scale option.
      document.documentElement.style.setProperty('--kk-font-scale',
        String(Math.max(0.6, Math.min(1.6, fs))));
    }
  } catch (_) {}
  // Visibility / focus handling — suspend the audio context when the tab is
  // hidden, resume + retrigger menu bed when it returns. menuBed itself is
  // auto-managed by audio.js's mode poller started inside unlockAudio().
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        suspendAudio();
      } else {
        resumeAudio();
      }
    });
  }

  // Menu destinations share one first-wins transition. Several entry paths
  // await cold GLBs before hiding the menu; without this guard a second click
  // could finish later and overwrite the mode selected by the first click.
  let _entryPromise = null;
  const _runEntryTransition = (work) => {
    if (!_entryPromise) {
      _entryPromise = Promise.resolve().then(work).finally(() => { _entryPromise = null; });
    }
    return _entryPromise;
  };
  // Async hub loads may finish after the player has opened Options or returned
  // to Menu. A monotonic owner token lets stale work finish fetching without
  // allowing it to mutate the active scene.
  let _hubTransitionId = 0;
  const _nextHubTransition = () => ++_hubTransitionId;
  const _isCurrentTransition = (id) => id === _hubTransitionId;
  const _canContinueRunStart = (id) => {
    if (!_isCurrentTransition(id)) return false;
    if (state.mode !== 'menu' && state.mode !== 'town') return false;
    // Some older UI surfaces leave a hidden dialog node behind while they are
    // closing. A hidden node must not silently veto Embark; only a dialog the
    // player can actually see is an active modal.
    try {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!dialog) return true;
      const style = window.getComputedStyle(dialog);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
    }
    catch (_) { return true; }
  };
  const _startRun = async () => {
    if (state.started && state.mode === 'run') return;
    const transitionId = _nextHubTransition();
    // Menu entry can follow a just-closed options panel. It is safe to clear
    // that stale pause here because an actually visible modal is rejected by
    // _canContinueRunStart above.
    if (state.time) state.time.paused = false;
    if (!_canContinueRunStart(transitionId)) return;
    let _stageLoader = null;
    try {
      _stageLoader = document.createElement('div');
      _stageLoader.id = 'kk-stage-loader';
      _stageLoader.style.cssText = 'position:fixed;inset:0;background:#000;display:flex;align-items:center;justify-content:center;z-index:9999;font-family:"Cinzel",serif;font-size:14px;letter-spacing:0.3em;color:rgba(236,230,213,0.55);text-transform:uppercase;pointer-events:auto;';
      _stageLoader.textContent = 'Loading hero…';
      document.body.appendChild(_stageLoader);
    } catch (_) {}
    // iter 33y — ensure the selected avatar GLB is loaded BEFORE rebuildHero
    // runs (which clones from GLTF_CACHE). If the user picked a non-default
    // avatar in the carousel and clicked Play before its lazy fetch landed,
    // we wait here and dispose all other hero_* cache entries to free VRAM.
    // The carousel remains responsive while a cold avatar GLB downloads. If
    // selection changes during that await, load the new choice too before any
    // synchronous meta/rebuild step can fall back to the donor model.
    try {
      let loadedAvatarId = null;
      while (true) {
        const currentAvatarId = (getMeta().selectedAvatar || 'kitty');
        if (currentAvatarId === loadedAvatarId) break;
        loadedAvatarId = currentAvatarId;
        await _ensureSelectedAvatarLoaded(loadedAvatarId);
      }
    } catch (_) {}
    if (!_canContinueRunStart(transitionId)) {
      try { _stageLoader?.remove(); } catch (_) {}
      return;
    }
    try { _disposeUnselectedAvatars(); } catch (_) {}
    // Hotfix #151: load stage-specific enemy roster + decor kits before the
    // world spawns. preloadStage is idempotent (skips already-cached entries)
    // so subsequent runs on the same stage are no-ops. Show a "Loading stage…"
    // overlay during the fetch — mirrors the boot-loader pattern. After the
    // load, re-run prewarmPools so the spawner has hot pools for the new tiers.
    // Read the stage from meta directly, not state.run.stage — menuV2's stage
    // selector only mutates meta and doesn't re-run applyMetaUpgrades, so
    // state.run.stage can be stale across stage switches. Daily / Weekly
    // force STAGES[0] (forest) inside applyMetaUpgrades for leaderboard
    // fairness; mirror that here so the preload matches the actual run.
    const _metaNow = getMeta();
    const _forcedForest = !!(_metaNow && (_metaNow.optDaily || _metaNow.optWeekly));
    const _selStage = _forcedForest ? STAGES[0] : selectedStage(STAGES);
    const _stageId = (_selStage && _selStage.id) || 'forest';
    if (_stageLoader) _stageLoader.textContent = 'Loading stage…';
    try {
      try { await preloadStage(_stageId); } catch (e) { console.warn('[start.preloadStage]', e); }
      if (!_canContinueRunStart(transitionId)) return;
      // Apply avatar/character/stage choices only after authored stage assets
      // are cached. loadArenaDecor runs inside applyMetaUpgrades and memoizes
      // baked GLB accents. Boot and kkReturnToMenu leave weapons empty; this
      // therefore also builds exactly one current starter kit after the stage
      // selection has been committed.
      const _stageChanged = !state.run.stage || state.run.stage.id !== _stageId;
      const _needsStarterWeapon = state.weapons.length === 0;
      if (_stageChanged || _needsStarterWeapon) {
        applyMetaUpgrades();
      }
      if (_needsStarterWeapon) {
        acquireWeapon(state.run.starterWeapon || 'orbitals');
        for (let i = 0; i < (state.run.cellarLv || 0); i++) acquireWeapon(state.run.starterWeapon || 'orbitals');
      }
      // The selected hero uses TSL rim/damage-flash materials. Build it before
      // the stage warm-up so its first red damage flash cannot compile a new
      // node pipeline in the middle of a live combat frame.
      rebuildHero(scene);
      // Lockdown barricades are dormant until the player enters their ring.
      // Warm their first-use material/pipeline while the normal stage loader
      // is already up, so the encounter does not steal several seconds from
      // live input on a cold GPU.
      if (_stageId === 'forest' && state.run?._forestLockdownArenaId) {
        if (_stageLoader) _stageLoader.textContent = 'Warming lockdown arena…';
        try {
          await warmLockdownArena(state.run._forestLockdownArenaId, () => rendererService.pipeline.compile(scene, camera));
        } catch (error) {
          console.warn('[start.warmLockdownArena]', error);
        }
      }
      // Returning from Town preserves the selected Kaki stage in memory but
      // intentionally hides its scene root. Reclaim the shared sky/ground
      // when the player actually begins the next run.
      if (_stageId === 'kakiland') {
        setKakiLandStageVisible(true, state.scene);
        // Town intentionally leaves the floating-island geometry dormant so
        // its sky cannot bleed into the plaza. Re-arm the interaction
        // controller only when the player actually embarks; this also keeps
        // the synchronous portal-boss death hook absent while Town is live.
        loadKakiLandPortals(state.scene, state);
        if (state.envGroup && state.envGroup.userData && state.envGroup.userData.ground) {
          state.envGroup.userData.ground.visible = false;
        }
      }
      try { prewarmPools(); } catch (e) { console.warn('[start.prewarmPools]', e); }
      // Boot only sees the menu scene. At this point the real hero, stage
      // models and enemy pools all exist, so compile their material variants
      // while the loader is still covering the game. This specifically avoids
      // the first dash/hit/level-up after an asset transition becoming a
      // multi-second pipeline-creation hitch on either backend.
      if (_stageLoader) _stageLoader.textContent = 'Warming stage graphics…';
      try {
        await warmSpritePools(() => warmChestVisuals(() => warmTotemVisuals(
          () => rendererService.pipeline.compile(scene, camera),
        )));
      } catch (error) {
        console.warn('[start.warmStageGraphics]', error);
      }
    } finally {
      try { _stageLoader?.remove(); } catch (_) {}
    }
    if (!_canContinueRunStart(transitionId)) return;
    // Set run state inside try so a failure resets the guard flags and lets
    // the player retry (otherwise state.started+mode='run' stays set with the
    // menu still visible and every subsequent Embark click returns early).
    try {
      state.started = true;
      if (state.mode === 'town') exitTown();
      state.mode = 'run';
      // First-from-menu entry does not pass through _primeRunStart(), so arm
      // the active stage rule here as well. Kaki Land's portal-boss death hook
      // depends on this synchronous rule registration.
      try {
        const _stageRuleId = state.run && state.run.stage && state.run.stage.id;
        if (_stageRuleId) applyStageRule(_stageRuleId, state);
      } catch (e) { console.warn('[start.applyStageRule]', e); }
      resetMiniEvents();
      resetSynergies();
      // Stage selection is authoritative only after applyMetaUpgrades above.
      // Restamp stage-aware breakables now so Forest gets five purposeful
      // dash-smash logs in every authored room instead of the boot fallback.
      resetDestructibles();
      spawnPortalShards();
      // Iter 10b — Greed tier-4 capstone: idempotent across run-entry paths
      _maybeSpawnTreasureMapChest();
      setHUDVisible(true);
      // Once-per-install objective intro. Forest now has a dedicated key so
      // returning players see the new six-trial route once instead of carrying
      // forward the retired five-shard instructions.
      try {
        const _special = !!(state.modes && (state.modes.bossRush || state.modes.daily || state.modes.weekly));
        const _forestTrials = state.run && state.run.stage && state.run.stage.id === 'forest';
        const _kakiLand = state.run && state.run.stage && state.run.stage.id === 'kakiland';
        const _introKey = _kakiLand ? 'kks_kakiLandIntroSeen_v1' : (_forestTrials ? 'kks_forestTrialsIntroSeen_v1' : 'kks_introSeen');
        if (!_special && !localStorage.getItem(_introKey)) {
          localStorage.setItem(_introKey, '1');
          playCutscene({
            image: _kakiLand ? 'assets/kakiland/kaki-land-key-art-gpt-v2.png' : 'assets/screens/intro.webp',
            title: _kakiLand ? 'CROWN OF THE SKY' : (_forestTrials ? 'THE SIX GROVE GATES' : 'THE SHATTERED PORTAL'),
            accent: _kakiLand ? '#ffe08b' : '#c87bff',
            lines: _kakiLand ? [
              'Three floating trials guard the sanctuary above the clouds.',
              'Enter each gate, defeat its warden, and break the Sovereign seals.',
              'When the central portal blooms, the final challenger will answer.',
            ] : _forestTrials ? [
              'Six hidden groves surround the Glade. Enter each glowing gate and clear its sealed chamber.',
              'Every victory awakens one rune on the Moonroot Boss Gate.',
              'Clear all six, descend into the Catacomb, and defeat the Crypt Warden.',
            ] : [
              'The great portal that bound this world lies shattered — its five shards flung across the wilds.',
              'Gather all five. Reforge the gate.',
              'Then step through, brave one, to face what waits beyond.',
            ],
          });
        }
      } catch (_) {}
      hideStartScreen();
      hideMenuV2();
      state.run.startedAt = performance.now();
      if (meta.optMusic) startMusic();
      setMusicTier(0);
      if (state.modes && state.modes.bossRush) {
        showBanner('⚔ BOSS RUSH ⚔', 3.0, '#ff7a7a');
      } else if (state.modes && state.modes.daily) {
        showBanner('★ DAILY CHALLENGE ★', 3.0, '#c87bff');
      }
    } catch (e) {
      // A failed final-chapter entry can happen after Kaki has reclaimed the
      // shared sky/ground but before the menu transition completes. Return
      // those shared resources immediately so the retry starts from a normal
      // menu scene rather than an invisible, still-interactive island map.
      if (_stageId === 'kakiland') {
        try { disposeKakiLandPortals(state.scene); } catch (_) {}
        try { setKakiLandStageVisible(false, state.scene); } catch (_) {}
        try {
          const ground = state.envGroup && state.envGroup.userData && state.envGroup.userData.ground;
          if (ground) ground.visible = true;
        } catch (_) {}
      }
      state.started = false;
      state.mode = 'menu';
      setHUDVisible(false);
      console.error('[start] failed, state reset for retry:', e);
    }
    // Tutorial disabled by user request — how-to-play.html covers new players.
  };
  const start = () => {
    if (state.started && state.mode === 'run') return Promise.resolve();
    return _runEntryTransition(_startRun);
  };
  setGateHandler(start);
  // Gated town entry. Pick one memory-bounded cohort of unlocked heroes for
  // this session and load their real GLBs before buildTown clones them. Before
  // this contract, only the selected avatar was cached, so every other hero
  // became a visible-but-empty NPC group.
  let _townHeroCohort = null;
  const _enterTownGated = async () => {
    const transitionId = _nextHubTransition();
    if (!_townHeroCohort) {
      const selectedId = getMeta().selectedAvatar || 'kitty';
      const candidates = AVATARS.filter(av => av.id !== selectedId && isAvatarUnlocked(av.id));
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
      }
      _townHeroCohort = candidates.slice(0, 6).map(av => av.id);
    }
    try { await preloadTown(_townHeroCohort); } catch (e) { console.warn('[town.preload]', e); }
    if (!_isCurrentTransition(transitionId)) return false;
    try { buildTown(scene, _townHeroCohort); } catch (e) { console.warn('[town.build]', e); }
    if (!_isCurrentTransition(transitionId)) return false;
    enterTown();
    setHUDVisible(false);
    hideBanner();
    // _primeRunStart prepares the next run before Town appears. Clear its
    // transient stage-rule banner now so a combat objective cannot linger
    // over the hub (and so its real-time fade loop does not need to run here).
    try { clearStageRule(state); } catch (_) {}
    // Kaki Land has a stage-owned sky texture; the Town shares the same
    // Three.js scene. Hide its map and restore the normal shared background
    // before the plaza is shown. _startRun restores it on the next embark.
    if (state.run && state.run.stage && state.run.stage.id === 'kakiland') {
      setKakiLandStageVisible(false, scene);
      disposeKakiLandPortals(scene);
      if (state.envGroup && state.envGroup.userData && state.envGroup.userData.ground) {
        state.envGroup.userData.ground.visible = true;
      }
    }
    syncStageLifeVisibility();
    syncDestructiblesVisibility();
    return true;
  };
  setInteractionHandler('house', async () => {
    const transitionId = _nextHubTransition();
    // Preload home decor kits so ambient room furniture + H-overlay are ready.
    // Await a short race so first entry usually gets the sofa/bookshelf GLBs.
    try {
      await Promise.race([
        preloadHomeDecor(),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    } catch (_) {}
    if (!_isCurrentTransition(transitionId) || state.mode !== 'town') return;
    // Lazy cabin construction keeps its 80+ meshes, lights, and materials out
    // of Survivors runs. Idempotent, so subsequent entries are instant.
    try { buildInterior(scene); } catch (e) { console.warn('[interior.build]', e); }
    if (!_isCurrentTransition(transitionId) || state.mode !== 'town') return;
    // enterInterior owns full overworld blackout (town + env + forest + lights).
    enterInterior();
  });
  setInteriorHandler('exit', async () => { exitInterior(); await _enterTownGated(); });
  setInteriorHandler('house', () => showHouse());
  setInteriorHandler('sketch', () => showSketchbook());
  setInteriorHandler('yarn',   () => showYarnDart());
  setInteriorHandler('tea',    () => showTeaSteep());
  setInteriorHandler('computer', () => showQuestBoard());
  // Iter 33g — walkable casino interior. Town casino interactable now enters
  // a real room (sibling of the house) instead of opening the dashboard modal
  // directly. Stations inside route to the same modal sections.
  // Hotfix #151: preload the 3 casino GLBs + build the interior on first
  // entry (was buildCasinoInterior at boot). Idempotent.
  setInteractionHandler('casino', async () => {
    const transitionId = _nextHubTransition();
    // Settle any in-flight Boss Rush wager before entering (legacy code path).
    import('./casino.js')
      .then(({ settlePendingWager }) => { try { settlePendingWager(); } catch (_) {} })
      .catch(() => {});
    try { await preloadCasino(); } catch (e) { console.warn('[casino.preload]', e); }
    if (!_isCurrentTransition(transitionId) || state.mode !== 'town') return;
    try { refreshTownCasinoExterior(); } catch (e) { console.warn('[casino.exterior]', e); }
    try { buildCasinoInterior(scene); } catch (e) { console.warn('[casino.build]', e); }
    if (!_isCurrentTransition(transitionId) || state.mode !== 'town') return;
    enterCasinoInterior();
  });
  setCasinoInteriorHandler('exit',   async () => { exitCasinoInterior(); await _enterTownGated(); });
  setCasinoInteriorHandler('slots',  () => showCasinoSlots());
  setCasinoInteriorHandler('parlay', () => showCasinoParlay());
  setCasinoInteriorHandler('buffs',  () => showCasinoMenu('buffs'));
  setCasinoInteriorHandler('house',  () => showCasinoMenu('house'));
  // Debug shim — smoke tests + console can preload stage assets without
  // starting a run. Mirrors the lazyLoadGLTF surface from iter 33y.
  window.kkPreloadStage = preloadStage;
  window.kkPreloadTown = preloadTown;
  window.kkPreloadCasino = preloadCasino;
  window.kkPreloadHomeDecor = preloadHomeDecor;
  window.kkStartRun = start;
  const _enterTownFromMenu = async () => {
    hideStartScreen();
    hideMenuV2();
    const entered = await _enterTownGated();
    if (entered) state.started = true;   // bypass start-screen idle render path
  };
  window.kkEnterTown = () => {
    if (state.started && state.mode === 'town') return Promise.resolve();
    return _runEntryTransition(_enterTownFromMenu);
  };
  // Click/Space only triggers a run when on the start screen (menu mode).
  // In town mode they're no-ops — player uses E at the gate.
  // Iter 32e — explicit-button-only start. No Space hotkey, no window
  // click-to-start: Play (menu) → Start Run (select) is the only path.
  // Avoids accidental run starts and matches the redesigned UX.
  window.addEventListener('keydown', e => {
    if (e.code === 'Escape') {
      clearSecondaryAction();
      if (isQuestBoardOpen()) hideQuestBoard();
      else if (isHouseOpen()) hideHouse();
      // Hotfix #151: these transitions hit _enterTownGated which preloads
      // town kits. By the time the player presses Escape they've already
      // entered the town once (interior/casino are inside town), so the
      // preload is a no-op fast-path. Fire-and-forget — the Esc handler
      // doesn't need to await; town pops in within a frame on cached path.
      else if (state.mode === 'interior') { exitInterior(); _enterTownGated(); }
      else if (state.mode === 'casino_interior') { exitCasinoInterior(); _enterTownGated(); }
      // A dungeon descent is committed until its reward is claimed. Escape
      // opens the pause menu (including Return to Menu) instead of silently
      // deleting the encounter or its golden chest.
      else if (state.mode === 'catacomb') {
        if (isOptionsOpen()) hideOptions(); else showOptions();
      }
      else if (isShopOpen()) hideShop();
      else if (isGrimoireOpen()) hideGrimoire();
      else if (typeof isCreditsOpen === 'function' && isCreditsOpen()) hideCredits();
      else if (typeof isCodexOpen === 'function' && isCodexOpen()) hideCodex();
      else if (isOptionsOpen()) hideOptions();
      else if (state.started && !state.gameOver) showOptions();
    }
  });

  // ── F1 hotkey: open Codex from anywhere except mid-modal ───────────────────
  // F1 is the universal "help / index" key — surfacing the Codex (which holds
  // the affix Legend, enemy bestiary, weapon recipes, etc.) without a click.
  // Only fires when no competing modal owns input.
  window.addEventListener('keydown', e => {
    if (e.code !== 'F1') return;
    // Skip if any major modal owns focus.
    if (isCodexOpen && isCodexOpen()) { hideCodex(); e.preventDefault(); return; }
    if ((typeof isCreditsOpen === 'function' && isCreditsOpen())
        || isShopOpen() || isGrimoireOpen() || isHouseOpen()
        || isOptionsOpen() || isQuestBoardOpen()) {
      return;
    }
    // Don't preempt browser dev help if the user holds modifiers.
    if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    showCodex();
  });

  // ── Iter 23a + Iter 27 — suppress browser context menu globally ───────────
  // Right-click is a gameplay input (e.g. homeDecor pickup) — players never
  // need the browser context menu inside the game. Canvas-only suppression
  // (iter 23a) missed right-clicks on overlay DOM (decorate palette, modals).
  // Window-level catch-all covers everything; per-element handlers in
  // homeDecor.js / casino.js etc. still run their own logic on top.
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); }, false);
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, false);

  // Expose restart for the death-screen RETRY button. Avoids a full page reload
  // (which throws away the prewarmed pools + cached GLBs).
  // Self-contained modes retry themselves, not a survivors run.
  window.kkRestart = () => (
    state.mode === 'bullethell' ? _restartBulletHell()
      : (state.mode === 'racing' ? restartRacing(scene) : restartRun())
  );
  async function _restartBulletHell() {
    try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
    // Preserve a bounded campaign gate across the death-retry — capture BEFORE
    // exit/reset wipes it, re-arm the fresh entry so retries stay bounded.
    const _camp = getBhCampaign();
    exitBulletHell(scene);
    state.gameOver = false;
    state._deathShown = false;
    rebuildHero(state.scene);
    applyMetaUpgrades({ installStageScene: false });
    enterBulletHell(scene, _camp);
    _snapBulletHellCamera();
    setHUDVisible(true);
    state.started = true;
    state.run.startedAt = performance.now();
  }
  // Bullet-hell mode entry — start-screen button (ui.js) calls this. Skips
  // stage preload / spawn director / arena props entirely: the mode builds
  // its own arena and owns its enemies.
  const _startBulletHell = async () => {
    if (state.started && state.mode === 'bullethell') return;
    try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
    try { _disposeUnselectedAvatars(); } catch (_) {}
    try {
      if (state.mode === 'town') exitTown();
      state.gameOver = false;
      state._deathShown = false;
      rebuildHero(state.scene);
      applyMetaUpgrades({ installStageScene: false });
      hideStartScreen();
      hideMenuV2();
      // Bounded chapter gate carries through here from portalShards (set on
      // state.run before the portal swap); consumed once so a later menu/
      // start-screen direct launch stays the endless mode.
      const _camp = (state.run && state.run._bhCampaign) || null;
      if (state.run) state.run._bhCampaign = null;
      enterBulletHell(scene, _camp);
      _snapBulletHellCamera();
      setHUDVisible(true);
      state.started = true;
      state.run.startedAt = performance.now();
      if (getMeta().optMusic) startMusic();
      // Bullet-hell opens on the combat tier. index.js's wave machine reaffirms
      // tier 1 each non-boss wave and raises to tier 2 on boss materialize; this
      // entry set only seeds the opening ~1.5s before wave 1 spawns (was tier 0,
      // which left a calm-drone gap at the start of every run).
      setMusicTier(1);
    } catch (e) {
      state.started = false;
      state.mode = 'menu';
      console.error('[startBulletHell] failed, state reset for retry:', e);
    }
  };
  window.kkStartBulletHell = () => {
    if (state.started && state.mode === 'bullethell') return Promise.resolve();
    return _runEntryTransition(_startBulletHell);
  };
  // Kaki Rally entry. The menu's selected chapter id is the course id, so the
  // existing six-chapter rail also serves as a track picker without another
  // modal. The mode owns its course, rivals, HUD, and controls.
  const _startRacing = async (courseId = null, raceOptions = {}) => {
    if (state.started && state.mode === 'racing') return;
    try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
    try { _disposeUnselectedAvatars(); } catch (_) {}
    try {
      const playerAvatarId = getMeta().selectedAvatar || 'kitty';
      const modeDef = RACE_MODES[raceOptions.mode] || RACE_MODES.circuit;
      const carCount = Math.max(
        modeDef.minCars,
        Math.min(modeDef.maxCars, Math.round(Number(raceOptions.carCount) || modeDef.carCount)),
      );
      const roster = [
        AVATARS.find((avatar) => avatar.id === playerAvatarId),
        ...AVATARS.filter((avatar) => avatar.id !== playerAvatarId),
      ].filter(Boolean);
      // The player and first three rivals use showcase meshes. Larger packs use
      // lightweight helmeted hero proxies so 12/16-car grids stay renderable.
      const needed = roster.slice(0, Math.min(carCount, 4));
      await Promise.all(needed.map((avatar) => avatar.glb
        ? lazyLoadGLTF(`hero_${avatar.id}`, BASE + avatar.glb)
        : Promise.resolve(true)));
      if (state.mode === 'town') exitTown();
      if (state.mode === 'bullethell') exitBulletHell(scene);
      state.gameOver = false;
      state._deathShown = false;
      rebuildHero(state.scene);
      hideStartScreen();
      hideMenuV2();
      const selected = courseId || selectedStage(STAGES)?.id || 'forest';
      const racingSession = await enterRacing(scene, selected, {
        ...raceOptions,
        carCount,
        playerAvatarId,
        rosterIds: roster.map((avatar) => avatar.id),
        cameraHost: {
          orthographicCamera: gameplayCamera,
          canvas: renderer.domElement,
          setActiveCamera: _setActiveCamera,
          getAspect: ASPECT,
          transitionDuration: 0.3,
        },
      });
      if (!racingSession || state.racing !== racingSession) return;
      _snapRacingCamera();
      setHUDVisible(false);
      state.started = true;
      state.run.startedAt = performance.now();
      if (getMeta().optMusic) startMusic();
      setMusicTier(2);
    } catch (error) {
      try { exitRacing(scene); } catch (_) {}
      state.started = false;
      state.mode = 'menu';
      console.error('[startRacing] failed, state reset for retry:', error);
      try { showMenuV2(); } catch (_) {}
    }
  };
  window.kkStartRacing = (courseId = null, raceOptions = {}) => {
    if (state.started && state.mode === 'racing') return Promise.resolve();
    return _runEntryTransition(() => _startRacing(courseId, raceOptions));
  };
  window.__kkGetRacingSnapshot = getRacingSnapshot;
  // After death, take the player to town instead of restarting the run.
  // Same state cleanup, then enter the hub for shop/house/statues access.
  window.kkReturnToTown = async () => {
    // The shared death screen can route here from Bullet Hell. Restore its
    // remote arena, fog/background, input handlers and HUD before Town builds.
    if (state.mode === 'bullethell') exitBulletHell(scene);
    if (state.mode === 'racing') exitRacing(scene);
    _teardownActiveRun();
    _primeRunStart();        // hero is alive + statted up, ready for next gate-press
    const entered = await _enterTownGated();  // preload kits, then build + enter
    if (!entered) return;
    state._deathShown = false;
    state.started = true;     // bypass start-screen idle render path
    // Show an arrival toast surfacing what the run earned.
    if (window._kkLastRunSummary) _showTownArrivalToast(window._kkLastRunSummary);
  };
  // Return-to-main-menu — pauses any run, leaves town/interior/catacomb if
  // we're in one, drops back to the start screen so the player can rebind
  // character/stage/options before re-entering. Used by the death-screen and
  // pause-menu Return-to-Menu buttons (iter 29).
  window.kkReturnToMenu = () => {
    _nextHubTransition();
    const leavingMode = state.mode;
    // Rally reparents the real selected hero into its kart and hides the shared
    // environment. Restore both before the broad run reset touches hero state.
    if (leavingMode === 'racing') {
      try { exitRacing(scene); } catch (_) {}
    }
    try { _teardownActiveRun(); } catch (_) {}
    // Exit the active child first, then always suspend Town. Child exits set
    // mode back to town, which made the old sequence leave the plaza mounted.
    try {
      if (leavingMode === 'interior')              exitInterior();
      else if (leavingMode === 'casino_interior')  exitCasinoInterior();
      else if (leavingMode === 'catacomb')         exitCatacomb();
      else if (leavingMode === 'bullethell')       exitBulletHell(scene);
      else if (leavingMode === 'racing')           exitRacing(scene);
      else if (leavingMode === 'town')             exitTown();
      suspendTown();
    } catch (_) {}
    state.mode = 'menu';
    state.started = false;
    state._deathShown = false;
    state.time.paused = false;
    setHUDVisible(false);
    hideBanner();
    try { hideOptions(); } catch (_) {}
    // Death-return → Menu V2 (keep showStartScreen as fallback if v2 fails to mount).
    try { showMenuV2(); } catch (e) { console.warn('[menuV2.deathReturn]', e); showStartScreen('Press Play to begin'); }
  };
  window.__kkNextMiniBoss = secondsUntilNextMiniBoss;
  // Iter 17 — Helltide debug hook. Lets the player (and QA) force-trigger the
  // overlay event from DevTools. Returns true if it fired, false if a helltide
  // was already active or scene isn't ready.
  window.kkTriggerHelltide = () => {
    return import('./helltide.js').then(({ triggerHelltide }) => triggerHelltide());
  };
  window.kkEndHelltide = () => {
    return import('./helltide.js').then(({ endHelltide }) => endHelltide());
  };
  // QA/dev hook — jump straight into a freshly generated procedural catacomb
  // from the menu (mirrors kkStartBulletHell's hero setup, then the normal
  // enterCatacomb). Lets headless smoke drive the dungeon without walking the
  // overworld to the stairs. Returns the live dungeon layout for assertions.
  window.__kkTestEnterCatacomb = async () => {
    try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
    if (state.mode === 'town') { try { exitTown(); } catch (_) {} }
    state.gameOver = false;
    state._deathShown = false;
    rebuildHero(state.scene);
    applyMetaUpgrades();
    try { hideStartScreen(); } catch (_) {}
    try { hideMenuV2(); } catch (_) {}
    state.started = true;
    state.mode = 'run';
    // Dynamic import returns the same module singleton catacomb.js already runs
    // as, so state/scene stay shared (enterCatacomb isn't in the static import —
    // catacomb.js normally self-triggers entry via its own keydown listener).
    const m = await import('./catacomb.js');
    await m.enterCatacomb({ x: 0, y: 0, z: 0 });
    return m.isInCatacomb();
  };
}

function _teardownActiveRun() {
  clearSecondaryAction();
  // Tutorial: stage 6 (shop hint) fires on first death/run-end.
  try { notifyTutorialEvent('runEnd'); } catch (_) {}
  // P4E (#145) — drop the daily seed so the next non-daily run uses native
  // Math.random. Idempotent; no-op if not seeded.
  try { clearDailySeed(); } catch (_) {}

  // Return active enemies to pools + hide them
  const active = state.enemies.active;
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (!e || !e.mesh) continue;
    e.alive = false;
    e.mesh.visible = false;
    disposeBossTelegraphs(e);
    // Totems, pylons, bells aren't pooled — unique geometries. Detach;
    // reset* functions clear their respective lists.
    if (e.isTotem || e.isPylon || e.isBell) {
      if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
      continue;
    }
    releaseEnemyVisual(e);
  }
  active.length = 0;
  // Death-pop corpses were already spliced out of active — flush them too or
  // end-of-run kills stay visible as frozen ghosts after the clock resets.
  try { flushCorpses(); } catch (_) {}
  if (state.enemies.spatial && typeof state.enemies.spatial.clear === 'function') {
    state.enemies.spatial.clear();
  }
  // iter 33u — projectile meshes are off-scene position handles; visuals
  // live in InstancedMesh slots and must be returned to the free pool.
  for (const p of state.projectiles.active) {
    try { releaseProjectileVisuals(p); } catch (_) {}
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
  }
  flushProjectileVisuals();
  state.projectiles.active.length = 0;
  resetHeroTransientFX();
  disposeAllChainArcs(state.scene);
  // Clear enemy projectiles too, including their per-shot owned materials.
  clearEnemyProjectiles();
  // Clear webs (visual is hidden by tickWebs since list is empty)
  if (state.webs && state.webs.list) state.webs.list.length = 0;

  // Kaki owns the scene background as well as its geometry. It must release
  // that ownership before arenaDecor restores/tints the shared sky; reversing
  // this order can leave the floating-island sky visible in Town.
  if (state.scene) disposeKakiLandPortals(state.scene);
  if (state.scene) disposeKakiLandStage(state.scene);
  if (state.envGroup && state.envGroup.userData && state.envGroup.userData.ground) {
    state.envGroup.userData.ground.visible = true;
  }
  // Tear down arena decor (re-built when the next run's stage tint applies).
  if (state.scene) clearArenaDecor(state.scene);
  // Stop the stage ambient bed — re-armed when the next run picks its stage.
  playStageAmbient(null);
  // Tear down forest amber alongside decor (no-op on non-forest stages).
  if (state.scene) clearForestAmber(state.scene);
  // Tear down lockdown arenas (FOREST ITER C1). Disposes any registered
  // arena's door meshes + clears state.run.lockdown* flags. Stage-agnostic;
  // safe to call regardless of which stage was active.
  if (state.scene) disposeLockdownArenas(state.scene);
  // Tear down trap corridors (FOREST ITER C2). Disposes any registered
  // corridor's pre-pooled shard + ring meshes + clears
  // state.run.trapCorridorActive. Stage-agnostic; safe to call regardless of
  // which stage was active.
  if (state.scene) disposeTrapCorridors(state.scene);
  // Drop forest slow-zones too — paired with amber since both key off the
  // same hotspot JSON. No-op on non-forest stages.
  if (state.scene) clearForestHazards(state.scene);
  // FE-C3B + FE-C3C: forest portals + 3 puzzle scenes — same teardown contract
  // as amber/hazards, no-op on non-forest stages.
  if (state.scene) clearForestPortals(state.scene);
  if (state.scene) disposeFlowWeaver(state.scene);
  if (state.scene) disposeHarmonicAlignment(state.scene);
  if (state.scene) disposePrismLock(state.scene);
  if (state.scene) disposeMossrootPulse(state.scene);   // FE-V2
  // FE-V2 Landmarks teardown — flips state._landmarksLoaded back to false so
  // the next forest scene load triggers a fresh pre-pool. No-op on first
  // disposal (idempotent), no-op on non-forest stages (early-out when
  // _loaded is false).
  if (state.scene) {
    disposeForestLandmarks(state.scene);
    if (state) state._landmarksLoaded = false;
  }
  // FE-V2 Coffins teardown — same idempotency + gate-flag reset shape as
  // landmarks. The next forest scene load gets a fresh coffin placement.
  if (state.scene) {
    disposeForestCoffins(state.scene);
    if (state) state._coffinsLoaded = false;
  }
  // FE-V2 Neutrals teardown — same idempotency + gate-flag reset shape as
  // landmarks/coffins. Next forest scene load gets fresh fireflies/deer/owls.
  if (state.scene) {
    disposeForestNeutrals(state.scene);
    if (state) state._neutralsLoaded = false;
  }
  // FE-V2 Env-Hazards teardown — same idempotency + gate-flag reset shape as
  // landmarks/coffins/neutrals. Next forest scene load re-scatters hazards.
  if (state.scene) {
    disposeForestEnvHazards(state.scene);
    if (state) state._envHazardsLoaded = false;
  }
  // FOREST-V2-A6 Treasure Chests teardown — pre-pool + modal dismiss.
  if (state.scene) {
    disposeForestChests(state.scene);
    if (state) state._chestsLoaded = false;
  }
  // FOREST-V2-A14 Sealed Door teardown — DOM prompt + module state. Idempotent
  // across stage swaps; the per-run _sealedRooms state is wiped by resetState.
  disposeForestSealedDoors();
  if (state) state._sealedDoorsLoaded = false;
  // FOREST-V2-A7 Reaper teardown — mesh group + DOM red-tint overlay +
  // outlast pillar burst. Idempotent; safe on non-forest runs (no-op).
  if (state.scene) {
    disposeForestReaper(state.scene);
    if (state) state._reaperLoaded = false;
  }
  // FOREST-V2-A8 Floor Pickups teardown — pre-pool + flash overlay.
  if (state.scene) {
    disposeForestPickups(state.scene);
    if (state) state._pickupsLoaded = false;
  }
  // FOREST-V2-A17 Ground Weapon Drops teardown — pre-pool only.
  if (state.scene) {
    disposeForestWeaponDrops(state.scene);
    if (state) state._weaponDropsLoaded = false;
  }
  // FOREST-V2-A9 Day/Night Cycle teardown — restores baseline light/fog
  // values via fingerprint compare so a stage-transition dispose (where
  // applyStageTint already overwrote) skips the restore. Idempotent.
  if (state.scene) {
    disposeForestDayNight(state.scene);
    if (state) state._dayNightLoaded = false;
  }
  if (state.scene) {
    disposeForestSkyDome(state.scene);
    if (state) state._skyDomeLoaded = false;
  }
  // FOREST-V2-A10 Stage HUD teardown — removes #kk-forest-hud + style by id.
  // DOM-only; no scene param. Idempotent; safe across stage swaps.
  disposeForestHud();
  if (state) state._hudLoaded = false;
  // PHASE 1 P1G Sigil Arc teardown — removes scene group + DOM widget.
  // Idempotent; safe across stage swaps.
  disposeForestSigilArc();
  if (state) state._sigilArcLoaded = false;
  // PHASE 1 P1I Ambient Emitters teardown — removes scene group + pre-pooled
  // InstancedMeshes (pollen/lanterns/mist). Idempotent; safe across stage swaps.
  disposeForestEmitters();
  if (state) state._emittersLoaded = false;
  // FOREST-V2-A11 Boss HP Bars teardown — removes #kk-forest-bossbars + style.
  // DOM-only; no scene param. Idempotent; safe across stage swaps.
  disposeForestBossBars();
  if (state) state._bossBarsLoaded = false;
  // PHASE 1 P1E Boss Intro Cinematic teardown — removes #kk-boss-intro-banner
  // + style. DOM-only; no scene param. Idempotent; safe across stage swaps.
  disposeBossIntroCinematic();
  if (state) state._bossIntroLoaded = false;
  // PHASE 1 P1J Weapon Evolve Cinematic teardown — removes #kk-evolve-cin-banner
  // + style + burst mesh. Idempotent; safe across stage swaps. Mirrors the
  // bossIntro teardown shape.
  disposeEvolveCinematic();
  if (state) state._evolveCinematicLoaded = false;
  // PHASE 1 P1F End-of-run summary teardown — removes #kk-endrun-summary
  // + style + keydown handler. DOM-only; no scene param. Idempotent; safe
  // across stage swaps. Does NOT clear state.run._summaryShown — that's
  // owned by state.resetState() which fires on the next run start.
  disposeEndRunSummary();
  if (state) state._endRunSummaryLoaded = false;
  // Tear down twilight fountains (no-op on non-twilight stages). Mirrors
  // the forestAmber teardown shape; clear path also nulls
  // state.run.fountainSpeedBuff so the buff can't leak across runs.
  if (state.scene) clearTwilightFountains(state.scene);
  // Drop twilight slow-zones too — paired with fountains since both key off
  // the same hedge derivation. No-op on non-twilight stages.
  if (state.scene) clearTwilightHazards(state.scene);
  // Tear down cinder ballistas (no-op on non-cinder stages). Per-entity
  // activation flags live on _ballistas; wiping the array wipes the activation
  // state alongside it, so nothing leaks across runs.
  if (state.scene) clearCinderBallistas(state.scene);
  // Drop cinder slow-zones too — paired with ballistas since both key off the
  // same catapult derivation. No-op on non-cinder stages.
  if (state.scene) clearCinderHazards(state.scene);
  // Tear down void teleport pads (no-op on non-void stages). Per-entity
  // cooldown timestamps live on _pads; wiping the array wipes the cooldown
  // state alongside it, so nothing leaks across runs.
  if (state.scene) clearVoidTeleportPads(state.scene);
  // P4A cohort 1 — tear down cave decor (no-op on non-cave stages — early
  // return inside disposeCaveStage when _group is null). Mirrors the
  // forestAmber/twilight/cinder/void teardown shape.
  if (state.scene) disposeCaveStage(state.scene);
  // Drop any live Ascension burst + 30s player rim. Mirrors the chainFx
  // teardown shape; matters when the player dies mid-rim (would otherwise
  // ghost-attach a glowing ring to the next run's hero spawn position).
  if (state.scene) disposeAllEvolveBursts(state.scene);
  // Punch List #3 — drop any live dissolve burst slots so a stranded gold-
  // dust mote from the last enemy doesn't ghost into the next run's
  // pre-spawn camera frame. The InstancedMesh itself stays alive (it's
  // reused across runs — same shape as fx.js kill ring init pattern).
  if (state.scene) disposeAllDissolveBursts(state.scene);
  // Punch List #7 — Velocity Veil ribbon trail. Drop any live ribbon
  // segments + descriptors so a stranded fountain trail can't ghost into
  // the next run's hero spawn position. Mirrors the dissolveBurst teardown
  // shape — the InstancedMesh itself stays alive for re-use.
  if (state.scene) disposeAllVelocityVeils(state.scene);

  // Finalize Helltide BEFORE resetState wipes its state. teardownHelltide
  // reads state.run.helltideActive + helltideEmbersBanked to credit lifetime
  // stats; if resetState fires first those flags are gone and the credit
  // never happens (Codex review found this defeated the iter 20 fix).
  // teardownMiniEvents calls into teardownHelltide internally.
  teardownMiniEvents();

  // Hide leased gem slots while their logical records still exist. resetState
  // truncates the list and cannot recover the live InstancedMesh indices.
  resetXP();
  resetWeapons();
  // Reset core state (clears weapons, fillerCounts, etc.)
  resetState();
  resetZoom();
  resetChests();
  resetPickups();
  resetFX();
  resetVFXBurst();
  resetTotems();
  resetPylons();
  resetBells();
  resetEnemyTells();
  resetStageHazards();
  clearStageRule(state);
  resetPortalShards();
  resetCatacomb();
  resetBossTelegraphs();
  resetDestructibles();
  initSpawnDirector();
  _resetEvoAnnouncements();
  _resetSecretChecks();
}

function _primeRunStart() {
  // Snapshot active quest progress so the town arrival toast can show
  // exactly how much each bounty advanced during the run that just ended.
  try {
    const meta = getMeta();
    const active = (meta.quests && meta.quests.active) || [];
    window._kkQuestSnapshot = active.map(q => ({ id: q.id, progress: q.progress || 0 }));
  } catch (_) { window._kkQuestSnapshot = []; }
  // Rebuild hero mesh so a newly-picked character's placeholder tint applies.
  rebuildHero(state.scene);
  applyMetaUpgrades();
  // Iter 10b — Greed tier-4 capstone fires here so the chest is in the world
  // BEFORE the spawn director starts the wave. The guard makes the call
  // idempotent across the menu→start path that ALSO calls it.
  _maybeSpawnTreasureMapChest();
  // Re-give the selected character's starter weapon (+ Cellar bonus levels)
  acquireWeapon(state.run.starterWeapon || 'orbitals');
  for (let i = 0; i < (state.run.cellarLv || 0); i++) acquireWeapon(state.run.starterWeapon || 'orbitals');
  // Restore hero visuals (death anim mutated opacity + scale)
  if (state.hero.mesh) {
    state.hero.mesh.traverse(o => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.opacity !== undefined) m.opacity = 1; }
      }
    });
  }
  // Activate the chosen stage's gameplay rule (per-stage modifier).
  try {
    const sid = state.run && state.run.stage && state.run.stage.id;
    if (sid) applyStageRule(sid, state);
  } catch (_) {}
}

// Tiny HTML escape so quest names don't break the toast if a future template
// happens to include a special character.
function escapeHtmlS(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Paper-styled arrival toast shown briefly after returning to town from a run.
// Surfaces what the previous run earned so the upgrade decision is easy.
function _showTownArrivalToast(s) {
  // Reuse an existing toast slot if there is one (dismiss-replace pattern)
  const old = document.getElementById('kk-town-arrival');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const div = document.createElement('div');
  div.id = 'kk-town-arrival';
  const lines = [];
  if (s.victory) lines.push(`<div style="font-family:'Cinzel Decorative',serif;font-size:13px;letter-spacing:0.28em;color:#ffd24a;text-transform:uppercase;margin-bottom:4px;">★ Victory</div>`);
  lines.push(`<div style="font-family:'Cinzel Decorative',serif;font-size:22px;font-weight:900;letter-spacing:0.12em;color:#231a14;">Welcome back to the village.</div>`);
  lines.push(`<div style="font-family:'Inter',sans-serif;font-size:13px;color:#5a4838;margin-top:6px;letter-spacing:0.08em;">From that hunt:</div>`);
  lines.push(`<div style="font-family:'JetBrains Mono',monospace;font-size:15px;color:#231a14;margin-top:4px;display:flex;gap:18px;justify-content:center;">
    <span>+${s.coinsEarned} 🪙</span>
    <span>+${s.embersEarned} 🔥</span>
    <span>${s.kills} kills</span>
    <span>${Math.floor(s.time/60)}:${String(Math.floor(s.time%60)).padStart(2,'0')}</span>
  </div>`);
  // The results panel already presents every durable unlock. Town keeps one
  // compact reminder instead of replaying another vertical banner stack.
  const highlights = Array.isArray(s.highlights) ? s.highlights.filter(Boolean) : [];
  if (highlights.length > 0) {
    const shown = highlights.slice(0, 2).map(escapeHtmlS).join(' · ');
    const more = highlights.length > 2 ? ` · +${highlights.length - 2} more` : '';
    lines.push(`<div style="margin-top:8px;color:#8b4aa6;font-family:'Cinzel Decorative',serif;font-size:12px;letter-spacing:0.12em;line-height:1.45;">NEW · ${shown}${more}</div>`);
  }
  // Quest progress deltas — diff against the snapshot taken at run start.
  try {
    const snap = window._kkQuestSnapshot || [];
    const snapMap = new Map(snap.map(q => [q.id, q.progress]));
    const meta = getMeta();
    const active = (meta.quests && meta.quests.active) || [];
    const rows = [];
    for (const q of active) {
      const before = snapMap.get(q.id) || 0;
      const delta = (q.progress || 0) - before;
      if (delta <= 0) continue;
      const tpl = QUEST_TEMPLATES.find(t => t.id === q.id);
      if (!tpl) continue;
      const ready = q.progress >= tpl.goal;
      const color = ready ? '#ffae6a' : '#5a8a3a';
      rows.push(`<div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:${color};display:flex;justify-content:space-between;gap:14px;">
        <span style="opacity:0.78;">${tpl.icon} ${escapeHtmlS(tpl.name)}</span>
        <span>+${delta}  ${q.progress}/${tpl.goal}${ready ? '  ★' : ''}</span>
      </div>`);
    }
    if (rows.length > 0) {
      lines.push(`<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(35,26,20,0.25);font-family:'Inter',sans-serif;font-size:11px;letter-spacing:0.22em;color:#5a4838;text-transform:uppercase;text-align:left;">Quest progress</div>`);
      lines.push(`<div style="margin-top:4px;display:flex;flex-direction:column;gap:2px;text-align:left;">${rows.join('')}</div>`);
    }
  } catch (_) {}
  div.innerHTML = lines.join('');
  div.style.cssText = `
    position: fixed; top: 8%; left: 50%; transform: translateX(-50%);
    padding: 18px 32px; pointer-events: none; z-index: 95;
    background: linear-gradient(180deg, rgba(243,232,207,0.96), rgba(217,202,170,0.95));
    border: 1px solid rgba(35,26,20,0.6); border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.55);
    text-align: center; min-width: 360px;
    opacity: 0; transform: translateX(-50%) translateY(-12px);
    transition: opacity 0.35s ease, transform 0.35s ease;
  `;
  document.body.appendChild(div);
  // Animate in
  requestAnimationFrame(() => {
    div.style.opacity = '1';
    div.style.transform = 'translateX(-50%) translateY(0)';
  });
  // Auto-dismiss after 5s
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(-50%) translateY(-12px)';
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 500);
  }, 5000);
}

async function restartRun() {
  // iter 33y — re-loading a non-default avatar is the most common reason a
  // restart would otherwise spawn the donor model; await the lazy fetch.
  try { await _ensureSelectedAvatarLoaded(); } catch (_) {}
  try { _disposeUnselectedAvatars(); } catch (_) {}
  _teardownActiveRun();
  _primeRunStart();
  resetMiniEvents();
  resetSynergies();
  resetDestructibles();
  spawnPortalShards();
  state.mode = 'run';
  state._deathShown = false;
  setHUDVisible(true);
  state.started = true;
  state.run.startedAt = performance.now();
}

// iter 33y — hero-cache helpers.
async function _ensureSelectedAvatarLoaded(selectedAvatarId = null) {
  const meta = getMeta();
  const id = selectedAvatarId || meta.selectedAvatar || 'kitty';
  const av = AVATARS.find(a => a.id === id);
  if (!av || !av.glb) return;        // donor-model avatar — already loaded
  const key = `hero_${id}`;
  if (GLTF_CACHE[key]) return;
  await lazyLoadGLTF(key, BASE + av.glb);
}
function _disposeUnselectedAvatars() {
  const meta = getMeta();
  const sel = meta.selectedAvatar || 'kitty';
  for (const av of (AVATARS || [])) {
    if (av.id === sel || !av.glb) continue;
    disposeCachedGLTF(`hero_${av.id}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let _lastT = performance.now();
// Menu V2 is fully opaque and owns its own lightweight hero renderer. Keep the
// hidden gameplay canvas alive for transitions, but don't burn two post-FX
// passes at monitor refresh rate behind it.
const IDLE_RENDER_INTERVAL_MS = 250;
let _nextIdleRenderAt = 0;
// Per-run one-shot secret-check guards (reset on restart via _resetSecretChecks)
let _checkedUntouchable = false;
let _checkedMarathon = false;
let _checkedHoarder = false;
export function _resetSecretChecks() {
  _checkedUntouchable = false;
  _checkedMarathon = false;
  _checkedHoarder = false;
}

// Apply the player's purchased shop upgrades to hero stats at run start.
// Called after resetState (which wipes mutators).
function applyMetaUpgrades({ installStageScene = true } = {}) {
  const h = state.hero;
  const meta = getMeta();
  // Mode exclusivity — Weekly takes precedence over Daily/BossRush so a leaderboard
  // entry can't be tagged with two competing modifier sets. We *don't* mutate the
  // saved options (no setOption here) so the user's toggles persist when they
  // switch back; we just suppress the others for this run.
  const weeklyOn = !!(meta && meta.optWeekly);
  const dailyOn = !weeklyOn && !!(meta && meta.optDaily);
  // Iter 34 — Phase C: gameplay derives from the selected avatar's
  // baseArchetype, not from a separate "selectedChar" archetype pick. The
  // archetype lookup table (CHARACTERS) still holds the signature functions
  // until Phase D/F replaces them with per-avatar bespoke kits. Daily
  // challenge still uses the legacy archetype-id pool — it shuffles WHICH
  // archetype the run is locked to, so we override avatar.baseArchetype just
  // for this run.
  const avatar = selectedAvatar(AVATARS) || AVATARS[0];
  let char = archetypeForAvatar(avatar);
  let dailyCfg = null;
  if (dailyOn) {
    dailyCfg = dailyChallengeConfig(CHARACTERS.map(c => c.id));
    char = CHARACTERS.find(c => c.id === dailyCfg.character) || char;
  }
  if (char) {
    h.hpMax = char.hpMax || h.hpMax;
    h.hp = h.hpMax;
    for (const k of Object.keys(char.statMul || {})) {
      h.statMul[k] = (h.statMul[k] || 1) * char.statMul[k];
    }
    state.run.character = char.id;        // archetype id (legacy field; leaderboards read this)
    state.run.avatar    = avatar.id;      // canonical identity going forward
    // Iter 34 — Phase D: if the avatar's bespoke signature weapon module is
    // registered (cowboy/mothman/space in Phase D; rest in F), start the run
    // with that instead of the archetype's generic starter. WEAPON_REGISTRY
    // gates the swap so Phase-F-pending kits fall back cleanly.
    const sigId = avatar.signatureWeapon;
    const sigRegistered = !!(sigId && WEAPON_REGISTRY[sigId]);
    state.run.starterWeapon = sigRegistered ? sigId : char.starter;
    state.run.signatureWeapon = sigId || null;
    state.run.signatureRegistered = sigRegistered;
    if (typeof char.signature === 'function') {
      try { char.signature(state.run); } catch (e) { console.warn('[char.signature]', e); }
    }
  }
  state.run.daily = dailyOn ? dailyCfg : null;

  // Iter 9: weekly mutator stamps state.run.weekly* fields read by spawnDirector,
  // enemies.spawnEnemy, xp.js (gem-value mul), and weaponChoices (NO_PASSIVES).
  // Like Daily, weekly suppresses shop bonuses for a fair leaderboard.
  // _weeklyCommitted is a per-run one-shot guard for the run-end commit below.
  state.run._weeklyCommitted = false;
  if (weeklyOn) {
    const cfg = weeklyMutatorConfig();
    const mutator = applyWeeklyMutator(state.run, cfg.mutatorId);
    state.run.weekly = { weekKey: cfg.weekKey, mutatorId: cfg.mutatorId, mutatorLabel: cfg.mutatorLabel };
    if (!mutator) console.warn('[weekly] unknown mutator', cfg.mutatorId);
  } else {
    state.run.weekly = null;
  }

  // Fair-leaderboard gate: Daily AND Weekly both suppress shop/house/relic
  // bonuses so the run is character-only + active modifier (daily challenge
  // tweak or weekly mutator). Centralized so adding future leaderboard modes
  // is a one-liner.
  const runFair = dailyOn || weeklyOn;
  if (!runFair) {
    // Shop upgrades stack on top (skipped in daily/weekly for fair leaderboard)
    const hpLv = shopLevel('hp');
    if (hpLv > 0) { h.hpMax += 10 * hpLv; h.hp = h.hpMax; }
    const magLv = shopLevel('magnet');
    if (magLv > 0) h.statMul.magnet *= (1 + 0.15 * magLv);
    const spdLv = shopLevel('speed');
    if (spdLv > 0) h.statMul.moveSpeed *= (1 + 0.05 * spdLv);
    const dmgLv = shopLevel('damage');
    if (dmgLv > 0) h.statMul.dmg *= (1 + 0.05 * dmgLv);
  } else if (dailyOn) {
    // Daily modifier: apply a small thematic tweak so each day plays distinctly
    switch (dailyCfg.modifier) {
      case 'LOW HP':       h.hpMax = Math.max(30, Math.floor(h.hpMax * 0.6)); h.hp = h.hpMax; break;
      case 'SWARM DAY':    state.run.dailySpawnMul = 1.35; break;
      case 'HARDER SPAWNS':state.run.dailyHpMul = 1.5; break;
      case 'FAST CHESTS':  state.run.dailyChestMul = 0.5; break;
      // 'NO SHOP BONUSES' is the implicit default — already covered above.
    }
  }
  // Weekly mutator was already applied above (stamps state.run.weekly*); no
  // per-mutator dispatch here — readers in spawnDirector / xp / enemies do the work.

  // ── House upgrades (Embers currency) — apply regardless of daily mode since
  // they represent long-term home investment, not run-specific shop bonuses.
  // Some upgrades still respect daily/weekly for fairness (handled per-track below).
  const house = (meta.house || {});
  const kitchenLv  = house.kitchen  || 0;
  const cellarLv   = house.cellar   || 0;
  const gardenLv   = house.garden   || 0;
  const shrineLv   = house.shrine   || 0;
  const apoLv      = house.apothecary || 0;
  if (kitchenLv  > 0 && !runFair) { h.hpMax += 20 * kitchenLv; h.hp = h.hpMax; }
  // Cellar gets applied after acquireWeapon runs (see below). Stash on run.
  state.run.cellarLv = (cellarLv > 0 && !runFair) ? cellarLv : 0;
  if (gardenLv   > 0 && !runFair) state.run.heartPotency = 1 + 0.5 * gardenLv;
  if (shrineLv   > 0 && !runFair) h.rerolls += shrineLv;
  if (apoLv      > 0 && !runFair) h.regenPerSec += 0.5 * apoLv;

  // ── MaoMao — the outfit she currently wears supplies one deliberately small
  // support perk, and only on non-fair
  // runs (daily/weekly stay character-only for leaderboard integrity, same as
  // house/shop above). Buff descriptor is explicit additive-vs-multiplicative
  // so this can't silently no-op (cf. the shopTree "broken promise" below).
  state.run.outfitBuff = null;   // cleared each apply; set below so the HUD cue mirrors what actually landed
  const mao = normalizeMaoMao(meta);
  if (!runFair && mao.adopted && mao.equippedOutfit) {
    const outfit = DAYCARE_OUTFITS.find(o => o.id === mao.equippedOutfit);
    const b = outfit && outfit.buff;
    if (b) {
      if (b.type === 'statMul' && b.stat) h.statMul[b.stat] = (h.statMul[b.stat] || 1) * b.mul;
      else if (b.type === 'hpMax') { h.hpMax += b.add; h.hp = h.hpMax; }
      state.run.outfitBuff = { id: outfit.id, icon: outfit.icon, name: outfit.name, label: outfit.buffLabel, cat: 'MaoMao' };
    }
  }

  // ── Shop Tree (iter 6 "Meta With Teeth") — bake each owned node's effect
  // into runState passive_* scalars + flags. Suppressed in daily/weekly for
  // the same fair-leaderboard reason as the flat shop bonuses above. Without
  // this loop the three tier-4 capstones (Phoenix / Overdrive / Treasure Map)
  // along with every lower-tier node would silently do nothing — see iter 10b
  // brief, "single biggest broken promise in the codebase".
  if (!runFair) {
    const ownedTree = meta.shopTree || {};
    for (const node of SHOP_TREE) {
      if (!ownedTree[node.id]) continue;
      try { node.effect(state.run); } catch (err) {
        console.warn('[shopTree effect]', node.id, err);
      }
    }
    // Phoenix tier-4 capstone cap: hard-limit revives at 6. Brief specs
    // `Math.min(6, passive_revives)` literally — the tuning row mentions
    // "4 base + 2 vault levels" but house.vault is the coin-bonus track
    // (max 3, +25%/lv end-of-run coins), unrelated to revives. The clamp
    // therefore lands at a flat 6, applied AFTER the loop so a future
    // node that adds revives still gets trimmed. Cheating-proof against
    // console pokes after applyMetaUpgrades returns? No — clamp only fires
    // at run prime — but brief explicitly tests via "console.set after
    // applyMetaUpgrades", confirming the clamp is a run-start trim, not a
    // per-frame ward.
    if ((state.run.passive_revives || 0) > 6) {
      state.run.passive_revives = 6;
    }
  }

  // Equipped relic affixes stack on top of shop/character (skipped in daily/weekly).
  if (!runFair) {
    const relic = equippedRelic();
    if (relic && relic.affixes) {
      for (const a of relic.affixes) {
        if (a.stat === 'hpMax') {
          h.hpMax += a.value;
          h.hp = h.hpMax;
        } else if (h.statMul && a.stat in h.statMul) {
          // Negative values (cooldown) compose multiplicatively against the
          // existing mul, so e.g. -0.15 → ×0.85.
          if (a.value < 0) h.statMul[a.stat] *= (1 + a.value);
          else             h.statMul[a.stat] *= (1 + a.value);
        }
      }
      state.run.equippedRelic = relic;
    }
  }

  // Iter 33e — apply casino permanent + queued temporary buffs. Stacks on
  // top of shop / relic / SHOP_TREE so casino doesn't no-op when those exist.
  import('./casino.js').then(({ applyCasinoBuffsOnRunStart }) => {
    try { applyCasinoBuffsOnRunStart(); } catch (_) {}
  });

  // Mode flags snapshot. Weekly is mutually exclusive with Daily/BossRush —
  // dailyOn was already gated above so the && !dailyOn guards subsume weekly.
  state.modes.hyper = !!(meta.unlockedHyper && meta.optHyper) && !dailyOn && !weeklyOn;
  state.modes.endless = !!(meta.unlockedEndless && meta.optEndless) && !dailyOn && !weeklyOn;
  state.modes.daily = dailyOn;
  state.modes.weekly = weeklyOn;
  // P4E (#145) — seed the daily PRNG when daily mode is on, otherwise CLEAR
  // it so a previous daily run can't poison this run's spawn determinism.
  // Self-gating: idempotent within a run (subsequent applyMetaUpgrades calls
  // re-seed to the same YYYYMMDD, mulberry32 state restarts → same stream).
  if (dailyOn) {
    try { seedDaily(todaySeedInt()); } catch (e) { console.warn('[p4e.seedDaily]', e); }
  } else {
    try { clearDailySeed(); } catch (_) {}
  }
  // Boss Rush is gated by first-victory (same unlock as Hyper), and is
  // incompatible with Daily / Weekly (each picks its own modifier set).
  state.modes.bossRush = !!(meta.unlockedHyper && meta.optBossRush) && !dailyOn && !weeklyOn;
  // P4D NG+ modifiers (#143) — gated by meta.unlockedNgPlus AND limited to the
  // Forest stage (acceptance scope per docs/P4_BACKLOG.md). Mirror into
  // state.modes so the existing telemetry.js beginRun call (which does
  // `modifiers: state.modes ?...` at line 329) auto-tags each flag into the
  // per-run record without touching telemetry.js itself. Each flag is
  // independently consumed: ngMirror in spawnDirector swarmMul, ngTwin in
  // spawnMiniBoss/spawnFinalBoss adjacency, ngHalfPickup in
  // forestPickups.dropForestPickup roll gate.
  const ngPlusEligible = !!meta.unlockedNgPlus && !dailyOn && !weeklyOn
    && (meta.selectedStage === 'forest');
  state.modes.ngMirror     = !!(ngPlusEligible && meta.optNgMirror);
  state.modes.ngTwin       = !!(ngPlusEligible && meta.optNgTwin);
  state.modes.ngHalfPickup = !!(ngPlusEligible && meta.optNgHalfPickup);

  // Stage selection — modifies enemy HP, final-boss timing, ground tint.
  // Daily / Weekly force stage 1 so the leaderboard is fair.
  const stage = (dailyOn || weeklyOn) ? STAGES[0] : selectedStage(STAGES);
  state.run.stage = stage;
  // The final chapter is a compact, authored portal route. Endless and Boss
  // Rush would replace/suppress its Sovereign victory condition, so they are
  // intentionally disabled for this one stage without changing saved toggles.
  if (stage && stage.id === 'kakiland') {
    state.modes.endless = false;
    state.modes.bossRush = false;
  }
  if (stage && stage.id !== 'forest') {
    state.run.stageHpMul = stage.enemyHpMul || 1;
    state.run.stageFinalBossAt = stage.finalBossAt || null;
  } else {
    state.run.stageHpMul = 1;
    state.run.stageFinalBossAt = null;
  }
  // Repaint the ground tint for the chosen stage.
  if (state.envGroup && state.envGroup.userData) {
    if (typeof state.envGroup.userData.applyStageTint === 'function') {
      state.envGroup.userData.applyStageTint(stage);
    }
  }
  // Per-stage instanced decor (trees / crystals / lava cracks / bones). Built
  // on top of the tint so each arena reads visually distinct, not just recolored.
  if (installStageScene && stage && state.scene) {
    // applyMetaUpgrades can run while a prior stage is still mounted (for
    // example the first menu launch after a different pre-primed stage).
    // Remove Kaki first so its async sky cannot survive the swap.
    disposeKakiLandPortals(state.scene);
    disposeKakiLandStage(state.scene);
    loadArenaDecor(stage.id, state.scene);
    // arenaDecor pre-allocates every Forest trial room for instant portal
    // transfers. Apply the initial visibility contract before the first
    // combat frame; previously non-Glade room batches stayed enabled until
    // the player completed their first portal transition.
    if (stage.id === 'forest') _applyForestRoomVisibility('glade');
    // Seeded lived-in overlay: clustered flora/minerals, cat-paw exploration
    // cues, and a tiny pooled ambient-life layer for every overworld biome.
    // It is intentionally independent of the larger authored landscape so
    // Cave (which owns its own stage builder) receives the same richness pass.
    try { loadStageLife(stage.id, state.scene); }
    catch (e) { console.warn('[main] loadStageLife failed:', e); }
    // Phase-2 swarm: forest-only Explosive Amber interactables. Fire-and-forget
    // — applyMetaUpgrades is sync; amber spawning a frame late is invisible to
    // the player. clearForestAmber is invariant: safe to no-op on non-forest.
    if (stage.id === 'forest') {
      loadForestAmber(state.scene).catch((e) => {
        console.warn('[main] loadForestAmber failed:', e);
      });
      // Swarm Phase 3: chokepoint slow-zones around amber hotspots — funnels
      // swarms into single-file lines through cluster gaps. Fire-and-forget;
      // enemies.js short-circuits on null until state.run.forestSlowZones is
      // published, so zones spawning a frame late is invisible.
      loadForestHazards(state.scene).catch((e) => {
        console.warn('[main] loadForestHazards failed:', e);
      });
      // FE-C3B: 3 outbound + 3 return amber-tinted portals between Glade and
      // the 3 puzzle rooms (saphollow / crystalchoir / amberlabyrinth) +
      // pollen breadcrumbs from world origin to each outbound portal.
      // Sync loaders — try/catch since they don't return Promises.
      try { loadForestPortals(state.scene); } catch (e) { console.warn('[main] loadForestPortals failed:', e); }
      // FE-C3C: puzzle rooms — Flow Weaver (Sap Hollow) / Harmonic Alignment
      // (Crystal Choir) / Prism Lock (Amber Labyrinth). Each load* instantiates
      // the puzzle's meshes; puzzleSystem.startPuzzle(id) activates one when
      // hero enters the matching room. Module-load already called registerPuzzle
      // via the new imports above; load* just builds the scene objects.
      try { loadFlowWeaver(state.scene); } catch (e) { console.warn('[main] loadFlowWeaver failed:', e); }
      try { loadHarmonicAlignment(state.scene); } catch (e) { console.warn('[main] loadHarmonicAlignment failed:', e); }
      try { loadPrismLock(state.scene); } catch (e) { console.warn('[main] loadPrismLock failed:', e); }
      // FE-V2: Mossroot Pulse puzzle (Mossroot Hollow). Bramble Maze + Glowfen
      // ship without puzzles in v0.2 (no load* needed).
      try { loadMossrootPulse(state.scene); } catch (e) { console.warn('[main] loadMossrootPulse failed:', e); }
      // FOREST ITER C1: Lockdown Arena, one arena per run for v1. Anchored on
      // the south amber cluster (~1, -28) — 6 dense hotspots (seeds 1003,
      // 1007, 1009, 1011, 1013, 1014) inside Glade bounds (glade maxZ=45 so
      // an 8u-radius arena at z=-28 sits well inside the hub, not pushed
      // past the right cluster which would clip Glade bounds at x=46+8).
      // Palette: slot 2 wall #2d3a55, slot 4 glow #7df0c4, slot 6 clear
      // amber #f5a300 — all from docs/FOREST_VISUAL_STYLE.md.
      try {
        state.run._forestLockdownArenaId = armLockdown({
          center: { x: 1.0, z: -28.0 },
          radius: 8,
          paletteSlots: { wall: 0x2d3a55, glow: 0x7df0c4, clear: 0xf5a300 },
        });
      } catch (e) { console.warn('[main] armLockdown(forest) failed:', e); }
      // FOREST ITER C2: Trap Corridor — 3-shard env-damage lane in the north
      // amber cluster (~x=-1, z=18-26). The cluster has 4+ dense amber
      // hotspots (seeds 1005,1006,1012,1015 etc. — see
      // assets/forest_amber_hotspots.json) creating a natural choke point;
      // we line 3 shard traps along that lane forming a ~9u corridor.
      // Coords are well clear of the south Lockdown Arena (1, -28) radius 8.
      // Palette: slot 1 idle #1a1e22 (dormant), slot 4 telegraph #7df0c4
      // (bio-glow mint pulse), slot 3 active #5f8fb5 (pale cyan-steel
      // crystal). Per FOREST_VISUAL_STYLE.md locked palette.
      try {
        armCorridor({
          id: 'forest-north-shard-lane',
          variant: 'shard',
          points: [
            { x: -1.0, z: 19.0, radius: 1.6 },
            { x: -1.0, z: 22.0, radius: 1.6 },
            { x: -1.0, z: 25.0, radius: 1.6 },
          ],
          paletteSlots: { idle: 0x1a1e22, telegraph: 0x7df0c4, active: 0x5f8fb5 },
        });
      } catch (e) { console.warn('[main] armCorridor(forest) failed:', e); }
      // Defensive: re-entering forest should drop any leftover twilight FX.
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
      disposeCaveStage(state.scene);     // P4A: cave decor must be gone on forest
    } else if (stage.id === 'twilight') {
      // Phase-2 swarm: Blood/Light Fountains — proximity drink → 1.75× move
      // speed for 4s, 30s per-fountain cooldown. Fire-and-forget; hero.js
      // short-circuits on null until state.run.fountainSpeedBuff is published.
      loadTwilightFountains(state.scene).catch((e) => {
        console.warn('[main] loadTwilightFountains failed:', e);
      });
      // Swarm Phase 3: hedge-corridor slow-zones — funnel swarms into
      // single-file lines through hedge gaps. Fire-and-forget; enemies.js
      // short-circuits on null until state.run.twilightSlowZones is
      // published, so zones spawning a frame late is invisible.
      loadTwilightHazards(state.scene).catch((e) => {
        console.warn('[main] loadTwilightHazards failed:', e);
      });
      // Defensive: forest decor must be gone on twilight.
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearForestPortals(state.scene);
      disposeFlowWeaver(state.scene);
      disposeHarmonicAlignment(state.scene);
      disposePrismLock(state.scene);
      disposeMossrootPulse(state.scene);   // FE-V2
      disposeForestLandmarks(state.scene); state._landmarksLoaded = false; // FE-V2 Landmarks
      disposeForestCoffins(state.scene);   state._coffinsLoaded   = false; // FE-V2 Coffins
      disposeForestNeutrals(state.scene);  state._neutralsLoaded  = false; // FE-V2 Neutrals
      disposeForestEnvHazards(state.scene); state._envHazardsLoaded = false; // FE-V2 EnvHazards
      disposeForestChests(state.scene);     state._chestsLoaded     = false; // FOREST-V2-A6 Chests
      disposeForestSealedDoors();           state._sealedDoorsLoaded = false; // FOREST-V2-A14 Sealed Doors
      disposeForestReaper(state.scene);     state._reaperLoaded     = false; // FOREST-V2-A7 Reaper
      disposeForestPickups(state.scene);    state._pickupsLoaded    = false; // FOREST-V2-A8 Pickups
      disposeForestWeaponDrops(state.scene); state._weaponDropsLoaded = false; // FOREST-V2-A17 Weapon Drops
      disposeForestDayNight(state.scene);   state._dayNightLoaded   = false; // FOREST-V2-A9 Day/Night
      disposeForestSkyDome(state.scene);    state._skyDomeLoaded    = false; // FOREST-V2-A34 Sky Dome
      disposeForestHud();                   state._hudLoaded        = false; // FOREST-V2-A10 Stage HUD
      disposeForestSigilArc();              state._sigilArcLoaded   = false; // PHASE 1 P1G Sigil Arc
      disposeForestEmitters();              state._emittersLoaded   = false; // PHASE 1 P1I Ambient Emitters
      disposeForestBossBars();              state._bossBarsLoaded   = false; // FOREST-V2-A11 Boss HP Bars
      disposeBossIntroCinematic();          state._bossIntroLoaded  = false; // PHASE 1 P1E Boss Intro Cinematic
      disposeEvolveCinematic();             state._evolveCinematicLoaded = false; // PHASE 1 P1J Weapon Evolve Cinematic
      disposeEndRunSummary();               state._endRunSummaryLoaded = false; // PHASE 1 P1F End-of-run Summary
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
      disposeCaveStage(state.scene);     // P4A: cave decor must be gone on twilight
    } else if (stage.id === 'cinder') {
      // Phase-2 swarm: Cinder Ballistas — proximity-triggered 10s repair →
      // permanent auto-fire piercing bolts. Fire-and-forget; tickCinderBallistas
      // bails when _ballistas is empty so a frame-late spawn is invisible.
      loadCinderBallistas(state.scene).catch((e) => {
        console.warn('[main] loadCinderBallistas failed:', e);
      });
      // Swarm Phase 3: catapult slow-zones — funnel swarms AROUND the ruined
      // siege engines (figure-eight kiting per docs/CINDER_VISUAL_STYLE.md).
      // Fire-and-forget; enemies.js short-circuits on null until
      // state.run.cinderSlowZones is published, so zones spawning a frame
      // late is invisible.
      loadCinderHazards(state.scene).catch((e) => {
        console.warn('[main] loadCinderHazards failed:', e);
      });
      // Defensive: forest/twilight decor must be gone on cinder.
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearForestPortals(state.scene);
      disposeFlowWeaver(state.scene);
      disposeHarmonicAlignment(state.scene);
      disposePrismLock(state.scene);
      disposeMossrootPulse(state.scene);   // FE-V2
      disposeForestLandmarks(state.scene); state._landmarksLoaded = false; // FE-V2 Landmarks
      disposeForestCoffins(state.scene);   state._coffinsLoaded   = false; // FE-V2 Coffins
      disposeForestNeutrals(state.scene);  state._neutralsLoaded  = false; // FE-V2 Neutrals
      disposeForestEnvHazards(state.scene); state._envHazardsLoaded = false; // FE-V2 EnvHazards
      disposeForestChests(state.scene);     state._chestsLoaded     = false; // FOREST-V2-A6 Chests
      disposeForestSealedDoors();           state._sealedDoorsLoaded = false; // FOREST-V2-A14 Sealed Doors
      disposeForestReaper(state.scene);     state._reaperLoaded     = false; // FOREST-V2-A7 Reaper
      disposeForestPickups(state.scene);    state._pickupsLoaded    = false; // FOREST-V2-A8 Pickups
      disposeForestWeaponDrops(state.scene); state._weaponDropsLoaded = false; // FOREST-V2-A17 Weapon Drops
      disposeForestDayNight(state.scene);   state._dayNightLoaded   = false; // FOREST-V2-A9 Day/Night
      disposeForestSkyDome(state.scene);    state._skyDomeLoaded    = false; // FOREST-V2-A34 Sky Dome
      disposeForestHud();                   state._hudLoaded        = false; // FOREST-V2-A10 Stage HUD
      disposeForestSigilArc();              state._sigilArcLoaded   = false; // PHASE 1 P1G Sigil Arc
      disposeForestEmitters();              state._emittersLoaded   = false; // PHASE 1 P1I Ambient Emitters
      disposeForestBossBars();              state._bossBarsLoaded   = false; // FOREST-V2-A11 Boss HP Bars
      disposeBossIntroCinematic();          state._bossIntroLoaded  = false; // PHASE 1 P1E Boss Intro Cinematic
      disposeEvolveCinematic();             state._evolveCinematicLoaded = false; // PHASE 1 P1J Weapon Evolve Cinematic
      disposeEndRunSummary();               state._endRunSummaryLoaded = false; // PHASE 1 P1F End-of-run Summary
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
      disposeCaveStage(state.scene);     // P4A: cave decor must be gone on cinder
    } else if (stage.id === 'void') {
      // Phase-2 swarm: Void Teleport Pads — proximity-triggered (≤1.2u) instant
      // pad-to-pad teleport with 6s per-pad cooldown + 0.4s iFrames on arrival.
      // Fire-and-forget; tickVoidTeleportPads bails when _pads is empty so a
      // frame-late spawn is invisible. Destination resolution: explicit
      // pairWith if set (suppressed if paired pad in cooldown), else nearest
      // OTHER non-cooldown pad. Suppressed teleports still consume the step
      // trigger via the origin's localStepGuard — player must step off and
      // back on to retry.
      loadVoidTeleportPads(state.scene).catch((e) => {
        console.warn('[main] loadVoidTeleportPads failed:', e);
      });
      // B3: Void chasm hazards — pre-existing tile-gap damage zones (5 dmg/s,
      // iframe-respecting so teleport-arrival doesn't punish). Fire-and-forget;
      // the per-frame check in tickStageHazards short-circuits on null until
      // state.run.voidChasms is published, so a frame-late load is invisible.
      // Mirrors the cinder lava pattern minus the arming flash — chasms are
      // visible geometry, not a telegraphed spawn.
      loadVoidHazards(state.scene).catch((e) => {
        console.warn('[main] loadVoidHazards failed:', e);
      });
      // Defensive: forest/twilight/cinder decor must be gone on void.
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearForestPortals(state.scene);
      disposeFlowWeaver(state.scene);
      disposeHarmonicAlignment(state.scene);
      disposePrismLock(state.scene);
      disposeMossrootPulse(state.scene);   // FE-V2
      disposeForestLandmarks(state.scene); state._landmarksLoaded = false; // FE-V2 Landmarks
      disposeForestCoffins(state.scene);   state._coffinsLoaded   = false; // FE-V2 Coffins
      disposeForestNeutrals(state.scene);  state._neutralsLoaded  = false; // FE-V2 Neutrals
      disposeForestEnvHazards(state.scene); state._envHazardsLoaded = false; // FE-V2 EnvHazards
      disposeForestChests(state.scene);     state._chestsLoaded     = false; // FOREST-V2-A6 Chests
      disposeForestSealedDoors();           state._sealedDoorsLoaded = false; // FOREST-V2-A14 Sealed Doors
      disposeForestReaper(state.scene);     state._reaperLoaded     = false; // FOREST-V2-A7 Reaper
      disposeForestPickups(state.scene);    state._pickupsLoaded    = false; // FOREST-V2-A8 Pickups
      disposeForestWeaponDrops(state.scene); state._weaponDropsLoaded = false; // FOREST-V2-A17 Weapon Drops
      disposeForestDayNight(state.scene);   state._dayNightLoaded   = false; // FOREST-V2-A9 Day/Night
      disposeForestSkyDome(state.scene);    state._skyDomeLoaded    = false; // FOREST-V2-A34 Sky Dome
      disposeForestHud();                   state._hudLoaded        = false; // FOREST-V2-A10 Stage HUD
      disposeForestSigilArc();              state._sigilArcLoaded   = false; // PHASE 1 P1G Sigil Arc
      disposeForestEmitters();              state._emittersLoaded   = false; // PHASE 1 P1I Ambient Emitters
      disposeForestBossBars();              state._bossBarsLoaded   = false; // FOREST-V2-A11 Boss HP Bars
      disposeBossIntroCinematic();          state._bossIntroLoaded  = false; // PHASE 1 P1E Boss Intro Cinematic
      disposeEvolveCinematic();             state._evolveCinematicLoaded = false; // PHASE 1 P1J Weapon Evolve Cinematic
      disposeEndRunSummary();               state._endRunSummaryLoaded = false; // PHASE 1 P1F End-of-run Summary
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      disposeCaveStage(state.scene);     // P4A: cave decor must be gone on void
    } else if (stage.id === 'cave') {
      // Cave stage: authored grotto, vault precinct, ambient life, and real
      // cave-in hazards. Defensive teardown mirrors the
      // void branch's pattern: any forest/twilight/cinder/void decor
      // surviving from a previous run gets dropped on cave entry.
      try {
        buildCaveStage(state.scene);
      } catch (e) {
        console.warn('[main] buildCaveStage failed:', e);
      }
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearForestPortals(state.scene);
      disposeFlowWeaver(state.scene);
      disposeHarmonicAlignment(state.scene);
      disposePrismLock(state.scene);
      disposeMossrootPulse(state.scene);   // FE-V2
      disposeForestLandmarks(state.scene); state._landmarksLoaded = false; // FE-V2 Landmarks
      disposeForestCoffins(state.scene);   state._coffinsLoaded   = false; // FE-V2 Coffins
      disposeForestNeutrals(state.scene);  state._neutralsLoaded  = false; // FE-V2 Neutrals
      disposeForestEnvHazards(state.scene); state._envHazardsLoaded = false; // FE-V2 EnvHazards
      disposeForestChests(state.scene);     state._chestsLoaded     = false; // FOREST-V2-A6 Chests
      disposeForestSealedDoors();           state._sealedDoorsLoaded = false; // FOREST-V2-A14 Sealed Doors
      disposeForestReaper(state.scene);     state._reaperLoaded     = false; // FOREST-V2-A7 Reaper
      disposeForestPickups(state.scene);    state._pickupsLoaded    = false; // FOREST-V2-A8 Pickups
      disposeForestWeaponDrops(state.scene); state._weaponDropsLoaded = false; // FOREST-V2-A17 Weapon Drops
      disposeForestDayNight(state.scene);   state._dayNightLoaded   = false; // FOREST-V2-A9 Day/Night
      disposeForestSkyDome(state.scene);    state._skyDomeLoaded    = false; // FOREST-V2-A34 Sky Dome
      disposeForestHud();                   state._hudLoaded        = false; // FOREST-V2-A10 Stage HUD
      disposeForestSigilArc();              state._sigilArcLoaded   = false; // PHASE 1 P1G Sigil Arc
      disposeForestEmitters();              state._emittersLoaded   = false; // PHASE 1 P1I Ambient Emitters
      disposeForestBossBars();              state._bossBarsLoaded   = false; // FOREST-V2-A11 Boss HP Bars
      disposeBossIntroCinematic();          state._bossIntroLoaded  = false; // PHASE 1 P1E Boss Intro Cinematic
      disposeEvolveCinematic();             state._evolveCinematicLoaded = false; // PHASE 1 P1J Weapon Evolve Cinematic
      disposeEndRunSummary();               state._endRunSummaryLoaded = false; // PHASE 1 P1F End-of-run Summary
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
    } else if (stage.id === 'kakiland') {
      // Final chapter: the floating islands and their four portal landmarks
      // replace every normal overworld feature. Keep arenaDecor's empty root
      // (it owns shared boss presentation), then clear the prior biome before
      // mounting Kaki's generated world and controller.
      _clearPriorStageFeaturesForKaki(state.scene);
      try {
        buildKakiLandStage(state.scene);
        loadKakiLandPortals(state.scene, state);
      } catch (e) {
        console.warn('[main] Kaki Land stage build failed:', e);
        if (state.envGroup && state.envGroup.userData && state.envGroup.userData.ground) {
          state.envGroup.userData.ground.visible = true;
        }
      }
    } else {
      // Defensive: stage transition from forest/twilight/cinder → other should
      // drop all. resetState() path already calls these via the block above,
      // but applyMetaUpgrades runs on stage select without a reset (mid-run).
      clearForestAmber(state.scene);
      clearForestHazards(state.scene);
      clearForestPortals(state.scene);
      disposeFlowWeaver(state.scene);
      disposeHarmonicAlignment(state.scene);
      disposePrismLock(state.scene);
      disposeMossrootPulse(state.scene);   // FE-V2
      disposeForestLandmarks(state.scene); state._landmarksLoaded = false; // FE-V2 Landmarks
      disposeForestCoffins(state.scene);   state._coffinsLoaded   = false; // FE-V2 Coffins
      disposeForestNeutrals(state.scene);  state._neutralsLoaded  = false; // FE-V2 Neutrals
      disposeForestEnvHazards(state.scene); state._envHazardsLoaded = false; // FE-V2 EnvHazards
      disposeForestChests(state.scene);     state._chestsLoaded     = false; // FOREST-V2-A6 Chests
      disposeForestSealedDoors();           state._sealedDoorsLoaded = false; // FOREST-V2-A14 Sealed Doors
      disposeForestReaper(state.scene);     state._reaperLoaded     = false; // FOREST-V2-A7 Reaper
      disposeForestPickups(state.scene);    state._pickupsLoaded    = false; // FOREST-V2-A8 Pickups
      disposeForestWeaponDrops(state.scene); state._weaponDropsLoaded = false; // FOREST-V2-A17 Weapon Drops
      disposeForestDayNight(state.scene);   state._dayNightLoaded   = false; // FOREST-V2-A9 Day/Night
      disposeForestSkyDome(state.scene);    state._skyDomeLoaded    = false; // FOREST-V2-A34 Sky Dome
      disposeForestHud();                   state._hudLoaded        = false; // FOREST-V2-A10 Stage HUD
      disposeForestSigilArc();              state._sigilArcLoaded   = false; // PHASE 1 P1G Sigil Arc
      disposeForestEmitters();              state._emittersLoaded   = false; // PHASE 1 P1I Ambient Emitters
      disposeForestBossBars();              state._bossBarsLoaded   = false; // FOREST-V2-A11 Boss HP Bars
      disposeBossIntroCinematic();          state._bossIntroLoaded  = false; // PHASE 1 P1E Boss Intro Cinematic
      disposeEvolveCinematic();             state._evolveCinematicLoaded = false; // PHASE 1 P1J Weapon Evolve Cinematic
      disposeEndRunSummary();               state._endRunSummaryLoaded = false; // PHASE 1 P1F End-of-run Summary
      clearTwilightFountains(state.scene);
      clearTwilightHazards(state.scene);
      clearCinderBallistas(state.scene);
      clearCinderHazards(state.scene);
      clearVoidTeleportPads(state.scene);
      clearVoidHazards(state.scene);
      disposeCaveStage(state.scene);     // P4A: defensive — cave decor must be gone on unknown stage
    }
  }
  // Per-stage ambient bed (loop). `forest` and `twilight` ship ambient files
  // (assets/audio/forest/forest_ambient.ogg and audio/twilight/twilight_ambient.ogg);
  // other stages no-op until their packs land. Routed through the music
  // submaster so the Music Volume slider controls it. Stop on null/unknown stage.
  if (stage) {
    playStageAmbient(stage.id);
  } else {
    playStageAmbient(null);
  }
}

// Kaki Land intentionally preserves arenaDecor's shared boss/evolution
// presentation roots. This narrower cleanup removes active biome gameplay
// without disposing those generic cinematic mounts a second time.
function _clearPriorStageFeaturesForKaki(scene) {
  if (!scene) return;
  clearForestAmber(scene);
  clearForestHazards(scene);
  clearForestPortals(scene);
  disposeFlowWeaver(scene);
  disposeHarmonicAlignment(scene);
  disposePrismLock(scene);
  disposeMossrootPulse(scene);
  disposeForestLandmarks(scene); state._landmarksLoaded = false;
  disposeForestCoffins(scene); state._coffinsLoaded = false;
  disposeForestNeutrals(scene); state._neutralsLoaded = false;
  disposeForestEnvHazards(scene); state._envHazardsLoaded = false;
  disposeForestChests(scene); state._chestsLoaded = false;
  disposeForestSealedDoors(); state._sealedDoorsLoaded = false;
  disposeForestReaper(scene); state._reaperLoaded = false;
  disposeForestPickups(scene); state._pickupsLoaded = false;
  disposeForestWeaponDrops(scene); state._weaponDropsLoaded = false;
  disposeForestDayNight(scene); state._dayNightLoaded = false;
  disposeForestSkyDome(scene); state._skyDomeLoaded = false;
  disposeForestHud(); state._hudLoaded = false;
  disposeForestSigilArc(); state._sigilArcLoaded = false;
  disposeForestEmitters(); state._emittersLoaded = false;
  disposeForestBossBars(); state._bossBarsLoaded = false;
  clearTwilightFountains(scene);
  clearTwilightHazards(scene);
  clearCinderBallistas(scene);
  clearCinderHazards(scene);
  clearVoidTeleportPads(scene);
  clearVoidHazards(scene);
  disposeLockdownArenas(scene);
  disposeTrapCorridors(scene);
  disposeCaveStage(scene);
}

// ── Tier-4 Overdrive capstone tick (Power branch) ─────────────────────────
// Cycle: passive_overdrive=true → accumulate overdriveTimer until 60s, flip
// overdriveActive=true for 5s, then flip back and reset the timer. During
// the active window we stash + transient-multiply hero.statMul.cooldown
// (×0.667 ≈ +50% attack speed) and hero.statMul.dmg (×1.25 = +25% damage).
// Stash pattern guards against FP drift AND against death-mid-frenzy: if
// resetState clears state.run, the stash goes with it; we re-read fresh
// values on the next activation.
const OVERDRIVE_WAIT  = 60.0;
const OVERDRIVE_ACTIVE = 5.0;
const OVERDRIVE_CD_MUL = 0.667;
const OVERDRIVE_DMG_MUL = 1.25;
function _tickOverdrive(dt) {
  const r = state.run;
  if (!r.passive_overdrive) return;
  const h = state.hero;
  if (!r.overdriveActive) {
    r.overdriveTimer = (r.overdriveTimer || 0) + dt;
    if (r.overdriveTimer >= OVERDRIVE_WAIT) {
      // ── Activate ──
      r.overdriveActive = true;
      r.overdriveTimer = 0;
      r._overdrivePrevCD  = h.statMul.cooldown;
      r._overdrivePrevDmg = h.statMul.dmg;
      h.statMul.cooldown = h.statMul.cooldown * OVERDRIVE_CD_MUL;
      h.statMul.dmg      = h.statMul.dmg      * OVERDRIVE_DMG_MUL;
      // Amber screen tint: try the postfx uniform first (10a may add it),
      // otherwise fall back to a bloomBoost pulse so the player still sees
      // a frenzy flash. The bloomBoost decays at ×0.1/sec so a one-shot
      // here visibly lingers across the 5s window.
      if (state.postFXPass && state.postFXPass.uniforms && state.postFXPass.uniforms.uOverdriveTint) {
        state.postFXPass.uniforms.uOverdriveTint.value = 1.0;
      }
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.85);
      try { if (sfx && sfx.levelUp) sfx.levelUp(); } catch (_) {}
    }
  } else {
    r.overdriveTimer = (r.overdriveTimer || 0) + dt;
    if (r.overdriveTimer >= OVERDRIVE_ACTIVE) {
      // ── Deactivate ──
      r.overdriveActive = false;
      r.overdriveTimer = 0;
      // Restore from stash (not invert-multiply — FP drift is real).
      if (r._overdrivePrevCD != null)  h.statMul.cooldown = r._overdrivePrevCD;
      if (r._overdrivePrevDmg != null) h.statMul.dmg      = r._overdrivePrevDmg;
      r._overdrivePrevCD  = null;
      r._overdrivePrevDmg = null;
      if (state.postFXPass && state.postFXPass.uniforms && state.postFXPass.uniforms.uOverdriveTint) {
        state.postFXPass.uniforms.uOverdriveTint.value = 0.0;
      }
    } else {
      // Mid-active: keep nudging bloomBoost so the frenzy reads continuously
      // (it decays each frame; a small per-tick top-up is the safe path).
      state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.45);
    }
  }
}

// Iter 10b — Greed tier-4 capstone helper. Spawns one chest in front-right
// of the hero at run entry, exactly once per run. Guard via state.run flag
// so the two call sites (restartRun via _primeRunStart + start() for the
// first-from-menu path) don't double-spawn.
function _maybeSpawnTreasureMapChest() {
  if (!state.run.passive_treasureMap) return;
  if (state.run._treasureMapSpawned) return;
  state.run._treasureMapSpawned = true;
  try {
    spawnChestAt(state.hero.pos.x + 5, state.hero.pos.z + 5);
  } catch (err) { console.warn('[treasureMap spawn]', err); }
}

function applyShake(realDt) {
  // Small repeated impacts still get their particles, sound, hit flash, and
  // damage feedback. Reserve actual camera travel for a clearly heavy hit so
  // horde combat cannot turn into continuous vibration.
  if (state.fx.shake < 0.45) { state.fx._shakeT = 0; return; }
  // Time accumulator since the current shake spike began. Resets when shake
  // decays to zero (above guard). Used for the rampIn below — without it,
  // a fresh shake spike applies its full sin/cos offset on the first frame
  // (sin/cos are time-indexed off state.time.real, which has no zero-phase
  // relationship to the shake spike). At shake=0.5 that's a ±0.6u camera
  // teleport in a single frame — read as a "camera goes weird" hiccup
  // on miniboss spawn rather than a shake. (Fix 2026-05-16.)
  state.fx._shakeT = (state.fx._shakeT || 0) + realDt;
  const rampIn = Math.min(1, state.fx._shakeT * 12); // full strength at ~83ms
  const opt = (state._optShakeMul !== undefined) ? state._optShakeMul : 1.0;
  const s = state.fx.shake * opt * rampIn;
  const t = state.time.real * 60;
  const k = 0.7 * s;   // base amplitude — toned down from 1.2 (shake was too heavy)
  camera.position.x += Math.sin(t * 1.7) * k;
  camera.position.z += Math.cos(t * 2.3) * k;
  state.fx.shake *= Math.pow(0.0008, realDt);
}

// ── FE-C3A — Forest room transition + camera lerp ──────────────────────────
// Module-local state for the room state machine. Driven each frame from the
// Forest tick block (which guards on state.run.stage.id === 'forest' so
// these stay quiescent on other stages).
//
//   _forestCamLerp.active:    true while a transition is animating
//   _forestCamLerp.elapsed:   seconds since transition began
//   _forestCamLerp.targetX/Z: room center the camera is settling toward
//
// The transition lifecycle (per FOREST_EXPANSION_PLAN §4 FE-C3A):
//   1. detectRoom(hero.pos.x, hero.pos.z) reports newRoomId != currentRoom
//   2. Set roomState='TRANSITIONING', currentRoom=newRoomId
//   3. Hide every InstancedMesh whose userData.roomId is set AND not in the
//      visible set {currentRoom, 'glade'}; show those that are.
//   4. Lerp camera toward room center for FOREST_CAM_LERP_SEC
//   5. After the lerp completes, settle roomState into 'ARENA' if the new
//      room is the glade hub, or 'IN_ROOM' otherwise. PUZZLE_ACTIVE is owned
//      by puzzleSystem.js and never set by this transition path.
const FOREST_CAM_LERP_SEC = 0.6;
const _forestCamLerp = {
  active: false,
  elapsed: 0,
  targetX: null,
  targetZ: null,
};

/**
 * Walk the per-room InstancedMesh tags installed by arenaDecor.js. Each child
 * with `userData.roomId` set gets .visible flipped to match the rule "show
 * only the current room + glade". The glade is always visible because it's
 * the hub backdrop the puzzle rooms "lean against" geometrically.
 *
 * Cheap: ~30 children traversal once per transition (NOT per frame).
 *
 * @param {string} currentRoomId
 */
function _applyForestRoomVisibility(currentRoomId) {
  const sc = state.scene;
  if (!sc) return;
  const decor = sc.getObjectByName('__arenaDecor');
  if (!decor) return;
  decor.traverse((o) => {
    const rid = o.userData && o.userData.roomId;
    if (!rid) return; // un-tagged decor (non-Forest, or props) — leave alone
    o.visible = (rid === currentRoomId) || (rid === 'glade');
  });
}

/**
 * Per-frame room transition driver. Called only on Forest stage. Cheap
 * fast-path when nothing is changing (detectRoom returns the same id every
 * frame for a stationary hero).
 *
 * @param {number} dt seconds since last frame
 */
function _tickForestRoomTransition(dt) {
  // Don't change rooms or run camera lerp while a puzzle is in flight — the
  // hero is locked to a puzzle room until it ends (win/fail/timeout) and the
  // boss force-return path in spawnDirector handles the override case.
  if (state.run && state.run.roomState === 'PUZZLE_ACTIVE') return;

  const hp = state.hero && state.hero.pos;
  if (!hp) return;
  const detected = detectRoom(hp.x, hp.z);
  const cur = (state.run && state.run.currentRoom) || 'glade';

  // detected may be null in no-man's-land between rooms — keep the last
  // known room so visibility doesn't flicker as the hero crosses a portal.
  if (detected && detected !== cur) {
    const transfer = state.run && state.run._forestPortalTransfer;
    const normalPortalRun = !(state.modes
      && (state.modes.bossRush || state.modes.daily || state.modes.weekly));
    const transferValid = !!(transfer && transfer.from === cur && transfer.to === detected
      && state.time.game <= transfer.expiresAt);
    // In the normal Forest route, room changes belong to an activated portal.
    // This is a second ownership check behind the movement clamp, protecting
    // against a large debug/physics teleport activating a trial by position.
    if (normalPortalRun && !transferValid) return;
    state.run.currentRoom = detected;
    state.run.roomState = 'TRANSITIONING';
    if (transferValid) state.run._forestPortalTransfer = null;
    // PHASE 4 P4J — telemetry room_enter (forest stage only — this hook is
    // inside _tickForestRoomTransition, no need to gate further).
    try { telemetryEvent('room_enter', { id: detected }); } catch (_) {}
    _applyForestRoomVisibility(detected);
    // FOREST-V2-A14 — sealed-door cohort needs the room-enter edge to spawn
    // a miniboss + seal the return portal (first-time entries) or re-seal a
    // mid-fight return (defensive — see forestSealedDoors.onRoomEnter). Glade
    // is a no-op inside the hook. try/catch isolates seal faults from the
    // camera/visibility transition that follows.
    try {
      _forestSealOnRoomEnter(detected, transferValid ? {
        viaPortal: true,
        kind: transfer.kind,
        portalId: transfer.portalId,
        from: transfer.from,
      } : null);
    } catch (e) { console.warn('[main] forestSeal onRoomEnter failed:', e); }
    const room = FOREST_ROOMS[detected];
    if (room && room.center) {
      _forestCamLerp.active = true;
      _forestCamLerp.elapsed = 0;
      _forestCamLerp.targetX = room.center.x;
      _forestCamLerp.targetZ = room.center.z;
    }
  }

  // Advance the lerp clock. When it elapses, settle roomState into
  // 'ARENA' (glade hub) or 'IN_ROOM' (any puzzle room). Don't downgrade
  // PUZZLE_ACTIVE here — puzzleSystem owns that state.
  if (_forestCamLerp.active) {
    _forestCamLerp.elapsed += dt;
    if (_forestCamLerp.elapsed >= FOREST_CAM_LERP_SEC) {
      _forestCamLerp.active = false;
      _forestCamLerp.targetX = null;
      _forestCamLerp.targetZ = null;
      if (state.run.roomState !== 'PUZZLE_ACTIVE') {
        state.run.roomState = state.run.forestTrialActive
          ? 'PORTAL_TRIAL'
          : (state.run.currentRoom === 'glade') ? 'ARENA' : 'IN_ROOM';
        // Auto-arm the puzzle when transition lerp finishes inside a puzzle
        // room. Skips if puzzle already solved this run (player just sight-sees).
        const room = FOREST_ROOMS[state.run.currentRoom];
        if (room && room.puzzle && !state.run.forestTrialActive
            && !state.run.forestPuzzlesSolved[room.puzzle]) {
          _puzzleStart(room.puzzle);
        }
      }
    }
  }
}

function frame(now) {
  const elapsedDt = Math.max(0, (now - _lastT) / 1000);
  const realDt = Math.min(0.05, elapsedDt);
  _lastT = now;
  state.time.real += realDt;

  // PHASE 1 P1F — End-of-run summary polling. MUST run BEFORE the per-mode
  // early-return branches (interior/casino/catacomb/town) AND before the
  // gameOver/paused/pendingLevelUp gate at the main-run branch, because
  // those branches short-circuit the rest of frame(). The poll itself is
  // cheap (one boolean + one stats lookup) and self-gates on
  // state.run._summaryShown so it does real work only on the first
  // transition frame each run.
  tickEndRunSummary(state, realDt);
  // PHASE 4 P4J — Telemetry poll. Mirrors tickEndRunSummary placement: must
  // run BEFORE the per-mode early returns + the gameOver/paused gate so the
  // end-edge detection fires on the same frame the summary appears. Cheap
  // (one-shot flag short-circuits steady-state frames).
  tickTelemetryPoll(state);
  // Objective HUD owns overworld-only UI. Run this before every mode/paused
  // early-return so Catacomb/Bullet Hell/menu transitions cannot strand it.
  syncPortalShardHudVisibility();
  syncForestPortalUiVisibility(state);
  syncForestSealedDoorUiVisibility(state);
  syncStageLifeVisibility();
  syncDestructiblesVisibility();
  if (state.gameOver || state.pendingLevelUp || (state.time && state.time.paused)) {
    discardQueuedInteract();
  }

  // Interior mode — close iso camera over a small room.
  if (state.mode === 'interior') {
    sampleInput();
    updateHero(realDt);
    updateFX(realDt);
    updateVFXBurst(realDt);
    updateBlobShadows();
    tickInterior(realDt);
    // Tighter camera + frustum for the interior — frames the room intimately.
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 20 - camera.position.x) * 0.18;
    camera.position.z += (hp.z + 20 - camera.position.z) * 0.18;
    camera.position.y = 34;
    camera.lookAt(hp.x, 0.7, hp.z);
    const _ihalf = 11;   // big-cozy interior (20×15) — wider framing
    setOrthoFrustum(_ihalf);
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    return;
  }

  // Casino interior — same camera shape as the house, slightly pulled back
  // so all 5 stations stay framed.
  if (state.mode === 'casino_interior') {
    sampleInput();
    updateHero(realDt);
    updateFX(realDt);
    updateVFXBurst(realDt);
    updateBlobShadows();
    tickCasinoInterior(realDt);
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 20 - camera.position.x) * 0.16;
    camera.position.z += (hp.z + 20 - camera.position.z) * 0.16;
    camera.position.y = 34;
    camera.lookAt(hp.x, 0.7, hp.z);
    const _chalf = 11;
    setOrthoFrustum(_chalf);
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    return;
  }

  // Kaki Rally — dynamic isometric chase or dedicated side-view Trials camera.
  // The racing module owns vehicle physics, AI, scoring, particles, and its
  // HUD; main keeps the shared renderer/post stack and input sampler alive.
  if (state.mode === 'racing') {
    if (state.time.paused) {
      // Persistent engine/tire nodes otherwise hold their last throttle and
      // slip gains for the entire Options pause. The next live racing tick
      // recreates and smoothly ramps the layer from the current vehicle state.
      stopRacingAudio();
      const pausedCamera = updateRacingCamera(0, {
        aspect: ASPECT(),
        reducedMotion: !!state._optReduceMotion,
        paused: true,
      });
      if (pausedCamera?.camera) _setActiveCamera(pausedCamera.camera);
      if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
      renderFrame();
      return;
    }
    const logicDt = Math.min(realDt, 1 / 30);
    state.time.dt = logicDt;
    state.time.game += logicDt;
    sampleInput();
    tickRacing(logicDt, elapsedDt);

    const cameraUpdate = updateRacingCamera(logicDt, {
      aspect: ASPECT(),
      reducedMotion: !!state._optReduceMotion,
      paused: false,
    });
    if (cameraUpdate?.camera) _setActiveCamera(cameraUpdate.camera);
    const cameraConfig = cameraUpdate?.effects || getRacingCameraConfig();
    if (state.postFXPass) {
      state.postFXPass.uniforms.time.value = state.time.real;
      state.postFXPass.uniforms.chromatic.value = cameraConfig.chromatic ?? 0.0008;
    }
    if (state.bloomPass) {
      const vfxMul = (getMeta().optVfx !== undefined ? getMeta().optVfx : 1.0);
      state.bloomPass.strength = (cameraConfig.bloom ?? 0.34) * vfxMul;
    }
    renderFrame();
    updatePerfHUD();
    renderPerfProfilerOverlay();
    return;
  }

  // Bullet-hell mode — self-contained tick (src/bullethell/). Reuses hero
  // movement/dash/death + renderer; owns bullets, foes, waves, items. No
  // spawn director, no weapons tick (manual fire lives in bullethell/shots.js),
  // no xp/level-ups by design.
  if (state.mode === 'bullethell') {
    if (state.gameOver || state.time.paused) {
      if (state.gameOver) {
        updateDeathAnim(realDt);
        updateDamageNumbers(realDt);
        applyShake(realDt);
      }
      if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
      renderFrame();
      return;
    }
    let logicDt = realDt;
    if (state.fx.hitStop > 0) {
      state.fx.hitStop = Math.max(0, state.fx.hitStop - realDt);
      logicDt = 0;
    }
    // Bullet-hell collision is point-vs-small-circle at high speeds: a big
    // frame gap tunnels shots through foes and bullets through the hitbox.
    // Clamp to 30fps-equivalent — the game slows down under lag instead of
    // becoming leaky. (Survivors mode tolerates big dt; this mode can't.)
    logicDt = Math.min(logicDt, 1 / 30);
    state.time.dt = logicDt;
    state.time.game += logicDt;

    sampleInput();
    updateHero(logicDt);
    tickBulletHell(logicDt, scene);
    updateFX(logicDt);
    updateVFXBurst(logicDt);
    updateBlobShadows();
    updateDamageNumbers(realDt);

    state.fx.chromaticPulse *= Math.pow(0.05, realDt);
    state.fx.bloomBoost     *= Math.pow(0.10, realDt);

    // Keep the whole arena and its rim emitters visible. Hero-follow used to
    // clip incoming walls/rain precisely when the player moved toward an edge.
    camera.position.x += (BH_CX + 22 - camera.position.x) * 0.28;
    camera.position.z += (BH_CZ + 22 - camera.position.z) * 0.28;
    camera.position.y = 42;
    camera.lookAt(BH_CX, 0.6, BH_CZ);
    const _bhalf = 25.5;
    setOrthoFrustum(_bhalf);

    applyShake(realDt);
    if (state.postFXPass) {
      state.postFXPass.uniforms.time.value = state.time.real;
      state.postFXPass.uniforms.chromatic.value = 0.0008 + state.fx.chromaticPulse * 0.004;
    }
    if (state.bloomPass) {
      const vfxMul = (getMeta().optVfx !== undefined ? getMeta().optVfx : 1.0);
      state.bloomPass.strength = (0.30 + state.fx.bloomBoost * 0.30) * vfxMul;
    }
    updateUI();
    renderFrame();
    updatePerfHUD();
    renderPerfProfilerOverlay();
    return;
  }

  // Catacomb mode — full combat tick inside the dungeon sub-arena.
  // Same logic as the run branch, but:
  //   * no spawn director (catacomb manages its own mini-waves)
  //   * no totems/pylons/bells/destructibles (overworld objectives)
  //   * tighter iso camera (same offset shape as interior mode)
  if (state.mode === 'catacomb') {
    if (state.pendingLevelUp || state.gameOver || state.time.paused) {
      if (state.gameOver) {
        updateDeathAnim(realDt);
        updateDamageNumbers(realDt);
        applyShake(realDt);
      }
      if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
      renderFrame();
      return;
    }
    let logicDt = realDt;
    if (state.fx.hitStop > 0) {
      state.fx.hitStop = Math.max(0, state.fx.hitStop - realDt);
      logicDt = 0;
    }
    state.time.dt = logicDt;
    state.time.game += logicDt;

    // Clockwork "Tempo" signature: damage multiplier ramps with run-time.
    // Idempotent (function of state.time.game), safe to compute in any active branch.
    if (state.run.signature_tempo) {
      state.run.signature_tempoBonus = Math.min(
        state.run.signature_tempo.cap,
        state.run.signature_tempo.ratePerSec * state.time.game,
      );
    }

    sampleInput();
    updateHero(logicDt);
    _tickOverdrive(logicDt);
    updateEnemies(logicDt);
    tickWeapons(logicDt);
    updateGems(logicDt);
    updateFX(logicDt);
    updateVFXBurst(logicDt);
    updateEnemyProjectiles(logicDt);
    tickChests(logicDt);
    updateBossTelegraphs(logicDt);
    updateEnemyTells(logicDt);
    tickPickups(logicDt);
    tickChainArcs(logicDt);
    tickEvolveBursts(logicDt);
    tickDissolveBursts(logicDt);
    tickSpriteSystem(logicDt);
    updateBlobShadows();
    updateDamageNumbers(realDt);
    tickCatacomb(logicDt);

    state.fx.chromaticPulse *= Math.pow(0.05, realDt);
    state.fx.bloomBoost     *= Math.pow(0.10, realDt);

    // Tight iso camera (mirrors interior offset shape)
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 22 - camera.position.x) * 0.16;
    camera.position.z += (hp.z + 22 - camera.position.z) * 0.16;
    camera.position.y = 38;
    camera.lookAt(hp.x, 0.6, hp.z);
    const _chalf = 14;
    setOrthoFrustum(_chalf);

    // Dungeon bosses and evolutions use the same camera/FX language as the
    // overworld. These run after follow/frustum so their authored override wins.
    tickBossIntroCinematic(state, realDt, camera);
    tickEvolveCinematic(state, realDt, camera);

    applyShake(realDt);
    if (state.postFXPass) {
      state.postFXPass.uniforms.time.value = state.time.real;
      state.postFXPass.uniforms.chromatic.value = 0.0008 + state.fx.chromaticPulse * 0.004;
    }
    if (state.bloomPass) {
      const vfxMul = (getMeta().optVfx !== undefined ? getMeta().optVfx : 1.0);
      state.bloomPass.strength = (0.30 + state.fx.bloomBoost * 0.30) * vfxMul;
    }
    updateUI();
    renderFrame();
    updatePerfHUD();
    renderPerfProfilerOverlay();
    return;
  }

  // Town hub mode — stripped-down tick: input + hero + fx + camera + render.
  if (state.mode === 'town') {
    sampleInput();
    updateHero(realDt);
    updateFX(realDt);
    updateVFXBurst(realDt);
    updateBlobShadows();
    tickTown(realDt);
    // Camera follows hero (same offset as in-game so the transition is seamless)
    const hp = state.hero.pos;
    camera.position.x += (hp.x + 40 - camera.position.x) * WORLD.cameraLerp;
    camera.position.z += (hp.z + 40 - camera.position.z) * WORLD.cameraLerp;
    camera.position.y = 60;
    camera.lookAt(hp.x, 0, hp.z);
    // A Kaki run uses a deliberately wide 76-unit overview. Town is a normal
    // walkable hub, so always restore the player zoom/frustum on this mode
    // boundary instead of leaving the plaza tiny after a final-chapter run.
    setOrthoFrustum(WORLD.cameraDistance / getZoom());
    if (state.envGroup && state.envGroup.userData.sun) {
      const sun = state.envGroup.userData.sun;
      sun.position.set(hp.x + 60, 80, hp.z + 40);
      sun.target.position.set(hp.x, 0, hp.z);
      sun.target.updateMatrixWorld();
    }
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    return;
  }

  if (!state.started) {
    if (now >= _nextIdleRenderAt) {
      renderFrame();
      _nextIdleRenderAt = now + IDLE_RENDER_INTERVAL_MS;
    }
    return;
  }

  if (state.pendingLevelUp || state.gameOver || state.time.paused) {
    syncMiniEventUIVisibility(false);
    // Frozen — render only. Death animation still ticks on real time.
    if (state.gameOver) {
      updateDeathAnim(realDt);
      updateDamageNumbers(realDt);
      applyShake(realDt);
      // ── Weekly run-end commit (iter 9). One-shot on gameOver transition.
      // 9a designed commitRunResults to forward `weekly: true`, but 9c's
      // showDeathScreen currently doesn't pass it — so we commit defensively
      // here from main.js per the brief's "run-end commit in main.js" mandate.
      // _weeklyCommitted (stamped false in applyMetaUpgrades) prevents the
      // per-frame loop from double-committing. Also records a leaderboard
      // entry with mode:'weekly' so the Hall of Records modal can list it.
      if (state.modes && state.modes.weekly && state.run && !state.run._weeklyCommitted) {
        state.run._weeklyCommitted = true;
        try {
          commitWeeklyRun({
            kills: state.run.kills,
            time: state.time.game,
            character: state.run.character,
            stage: state.run.stage ? state.run.stage.id : null,
          });
        } catch (e) { console.warn('[weekly.commit]', e); }
        try {
          recordRun({
            stage: state.run.stage ? state.run.stage.id : 'forest',
            char: state.run.character || 'kitty',
            mode: 'weekly',
            kills: state.run.kills,
            timeSurvived: state.time.game,
            level: state.hero.level,
            dmgDealt: state.run.dmgDealt,
            victory: !!state.victory,
          });
        } catch (e) { console.warn('[weekly.recordRun]', e); }
      }
      // P4E (#145) — daily leaderboard commit. Mirrors the weekly block above:
      // one-shot per run via _dailyCommitted, writes a recordRun entry tagged
      // mode='daily' (which stamps dailyDate via leaderboard.recordRun). The
      // existing commitDailyRun call in ui.js:1707 still owns the meta bests
      // toast + sigil grant; this site just adds the per-entry record that
      // topDailyForSeed / topDailyToday read.
      if (state.modes && state.modes.daily && state.run && !state.run._dailyCommitted) {
        state.run._dailyCommitted = true;
        try {
          recordRun({
            stage: state.run.stage ? state.run.stage.id : 'forest',
            char: state.run.character || 'kitty',
            mode: 'daily',
            kills: state.run.kills,
            timeSurvived: state.time.game,
            level: state.hero.level,
            dmgDealt: state.run.dmgDealt,
            victory: !!state.victory,
          });
        } catch (e) { console.warn('[daily.recordRun]', e); }
      }
    }
    if (state.postFXPass) state.postFXPass.uniforms.time.value = state.time.real;
    renderFrame();
    return;
  }

  // Hit-stop: drain timer on real time, scale gameplay dt to 0 while active.
  // Damage numbers still tick on realDt so they don't visually stall.
  let logicDt = realDt;
  if (state.fx.hitStop > 0) {
    state.fx.hitStop = Math.max(0, state.fx.hitStop - realDt);
    logicDt = 0;
  }
  state.time.dt = logicDt;
  state.time.game += logicDt;

  // Clockwork "Tempo" signature: damage multiplier ramps with run-time.
  // Read by enemies.js damageEnemy(). Idempotent — function of state.time.game.
  if (state.run.signature_tempo) {
    state.run.signature_tempoBonus = Math.min(
      state.run.signature_tempo.cap,
      state.run.signature_tempo.ratePerSec * state.time.game,
    );
  }

  // ── Logic phase ── (iter 33o — perfMark wraps subsystems for breakdown).
  let _p;
  sampleInput();
  _p=perfStart(); updateHero(logicDt);            perfMark('hero', _p);
  if (state.run && state.run.stage && state.run.stage.id === 'forest'
      && constrainForestPosition(state.hero && state.hero.pos)) {
    // The visible Wildwood tree line is the physical map edge. Cancel residual
    // dash/input velocity so the camera does not jitter against the clamp.
    // updateHero already copied its pre-clamp position to the display mesh, so
    // resync it here to keep collision, camera, and rendering on one boundary.
    if (state.hero && state.hero.vel) state.hero.vel.set(0, 0, 0);
    if (state.hero && state.hero.mesh && state.hero.mesh.position) {
      state.hero.mesh.position.x = state.hero.pos.x;
      state.hero.mesh.position.z = state.hero.pos.z;
    }
  }
  if (state.run && state.run.stage && state.run.stage.id === 'forest'
      && !(state.modes && (state.modes.bossRush || state.modes.daily || state.modes.weekly))
      && constrainForestPortalRoomPosition(
        state.hero && state.hero.pos,
        state.run.currentRoom || 'glade',
        state.run._forestPortalTransfer,
        state.time.game,
      )) {
    if (state.hero && state.hero.vel) state.hero.vel.set(0, 0, 0);
    if (state.hero && state.hero.mesh && state.hero.mesh.position) {
      state.hero.mesh.position.x = state.hero.pos.x;
      state.hero.mesh.position.z = state.hero.pos.z;
    }
  }
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland'
      && constrainKakiLandPosition(state.hero && state.hero.pos)) {
    // The islands are intentionally open-ended visually; this lightweight
    // clamp keeps dashes and long kites on real land/bridges without a heavy
    // physics collider system.
    if (state.hero && state.hero.vel) state.hero.vel.set(0, 0, 0);
    if (state.hero && state.hero.mesh && state.hero.mesh.position) {
      state.hero.mesh.position.x = state.hero.pos.x;
      state.hero.mesh.position.z = state.hero.pos.z;
    }
  }
  // Forest travel is input-driven and grants arrival i-frames. Resolve the
  // interact edge immediately after movement, BEFORE enemies, hostile shots,
  // and environmental hazards get their damage ticks. The previous ordering
  // ran the portal near the end of the Forest block, so a low-HP player who
  // pressed E on a valid gate could still die at the origin earlier in the
  // same frame; the destination protection arrived one frame too late.
  //
  // Room ownership follows the snap in the same phase. That lets the spawn
  // director see `forestTrialActive` before it tops up the overworld and lets
  // updateEnemies retire off-room mobs on the arrival frame rather than one
  // frame later. Both helpers retain their own Forest/lifecycle gates.
  if (state.run && state.run.stage && state.run.stage.id === 'forest') {
    _p=perfStart(); tickForestPortals(logicDt, state); perfMark('forestPortals', _p);
    _p=perfStart(); _tickForestRoomTransition(logicDt); perfMark('roomTransition', _p);
  }
  _p=perfStart(); tickSpawnDirector(logicDt);     perfMark('spawnDir', _p);
  // Lockdown Arena (stage-agnostic; FOREST ITER C1). Runs AFTER spawnDirector
  // so any same-frame wave dispatch lands while the director is paused (the
  // director's lockdownActive guard at spawnDirector.js bails before any
  // top-up so we don't double-spawn). Cheap when no arena is live.
  _p=perfStart(); tickLockdownArena(logicDt);     perfMark('lockdown', _p);
  // Trap Corridor (stage-agnostic env-damage hazard; FOREST ITER C2). Cheap
  // when no corridors are armed. Pass canonical hero + enemies lists directly
  // so the module stays state-agnostic. Damage uses static imports per the
  // perf-fix 9509535 contract — no dynamic import().then() in the hot path.
  _p=perfStart(); tickTrapCorridor(logicDt, state.hero, state.enemies.active); perfMark('trapCorridor', _p);
  // Tier-4 Overdrive capstone (Power branch) — must tick BEFORE tickWeapons
  // so the stashed statMul multipliers apply within the same frame's weapon
  // cooldown reads (autoAim / chain / orbitals all read h.statMul.cooldown).
  _tickOverdrive(logicDt);
  _p=perfStart(); updateEnemies(logicDt);         perfMark('enemies', _p);
  _p=perfStart(); tickWeapons(logicDt);           perfMark('weapons', _p);
  _p=perfStart(); updateGems(logicDt);            perfMark('gems', _p);
  _p=perfStart(); updateFX(logicDt);              perfMark('fx', _p);
  _p=perfStart(); updateVFXBurst(logicDt);        perfMark('vfxBurst', _p);
  _p=perfStart(); updateEnemyProjectiles(logicDt);perfMark('eprojs', _p);
  _p=perfStart(); tickChests(logicDt);            perfMark('chests', _p);
  _p=perfStart(); updateBossTelegraphs(logicDt);  perfMark('bossTells', _p);
  _p=perfStart(); tickTotems(logicDt);            perfMark('totems', _p);
  _p=perfStart(); tickPylons(logicDt);            perfMark('pylons', _p);
  _p=perfStart(); tickBells(logicDt);             perfMark('bells', _p);
  _p=perfStart(); updateEnemyTells(logicDt);      perfMark('enemyTells', _p);
  _p=perfStart(); tickStageHazards(logicDt);      perfMark('hazards', _p);
  // Forest-only: Explosive Amber interactables (Phase-2 swarm). No-op on
  // other stages — tickForestAmber bails when _entities is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'forest') {
    _p=perfStart(); tickForestAmber(logicDt, state); perfMark('forestAmber', _p);
    // FE-V2 Landmarks (2026-05-17) — AABB trigger pass for shrines/altars +
    // telegraph pulse fade. Bails immediately when no landmarks loaded.
    _p=perfStart(); tickForestLandmarks(logicDt, state); perfMark('forestLandmarks', _p);
    // FE-V2 Coffins (2026-05-17) — state-machine + open-burst tick. Bails
    // immediately when no coffins loaded; cheap on non-trigger frames.
    _p=perfStart(); tickForestCoffins(state, logicDt); perfMark('forestCoffins', _p);
    // FE-V2 Neutrals (2026-05-17) — fireflies drift, deer state machine,
    // owl blink scheduler. Bails immediately when no neutrals loaded.
    _p=perfStart(); tickForestNeutrals(state, logicDt); perfMark('forestNeutrals', _p);
    // FE-V2-A5 EnvHazards (2026-05-17) — mushroom rings / tar pits / falling
    // branches. Reads hero + enemies; MIN-stacks hero hazardSlow against
    // pollen (tickStageHazards writes absolute at line 1734 above — our tick
    // ordering matters, must run AFTER). Bails immediately when not loaded.
    _p=perfStart(); tickForestEnvHazards(state, logicDt); perfMark('forestEnvHazards', _p);
    // FOREST-V2-A6 Treasure Chests (2026-05-17) — pickup detect + lid open
    // anim + burst fade. Bails immediately when no chests loaded. Reward
    // dispatch fires from the modal pick (user-action), not here.
    _p=perfStart(); tickForestChests(state, logicDt); perfMark('forestChests', _p);
    // FOREST-V2-A7 Reaper (2026-05-17) — 30:00 spawn schedule + chase + 35:00
    // outlast bonus. No-op until state.time.game crosses WARN_T (1770s); cheap
    // on early-game frames (one early-return on the warned flag).
    _p=perfStart(); tickForestReaper(state, logicDt); perfMark('forestReaper', _p);
    // FOREST-V2-A8 Floor Pickups — pickup detect + sparkle anim + linger
    // despawn for bomb/magnet/chicken. Bails immediately when no pickups
    // loaded. Effect dispatch (kill-all/vacuum/heal) fires on contact.
    _p=perfStart(); tickForestPickups(state, logicDt); perfMark('forestPickups', _p);
    // FOREST-V2-A17 Ground Weapon Drops — pickup detect + sparkle anim + 60s
    // linger despawn for weapon-drop pickups. Bails immediately when no
    // pickups loaded. acquireWeapon dispatch fires on contact.
    _p=perfStart(); tickForestWeaponDrops(state, logicDt); perfMark('forestWeaponDrops', _p);
    // FOREST-V2-A9 Day/Night Cycle — lerps sun/hemi/fog from MIDDAY→BLOOD_MOON
    // over the 30:00 Reaper arc. Bails immediately when not loaded (forest-
    // only gate above already filters non-forest stages).
    _p=perfStart(); tickForestDayNight(state, logicDt); perfMark('forestDayNight', _p);
    // FOREST-V2-A34 Sky Dome (PHASE 3 P3D) — crossfades the 5 per-phase
    // sky-dome textures (midday→golden→dusk→twilight→bloodmoon). Bails
    // immediately when not loaded (forest-only gate above already filters).
    _p=perfStart(); tickForestSkyDome(state, logicDt); perfMark('forestSkyDome', _p);
    // FOREST-V2-A10 Stage HUD — top-bar clock + Reaper countdown + counters.
    // DOM-only; reads state.time.game + state.run.kills; mutates textContent
    // + clock color only. Bails when not loaded (forest-only gate above
    // already filters non-forest stages). Show/hide via style.visibility.
    _p=perfStart(); tickForestHud(state, logicDt); perfMark('forestHud', _p);
    // PHASE 1 P1G Sigil Reward Arc (2026-05-17) — polls meta.lifetime.sigilsEarned
    // diff and spawns gold-star arcs from kill pos to HUD-anchor (top-right
    // "Sigils: N" widget). Bails when not loaded (forest-only gate above).
    _p=perfStart(); tickForestSigilArc(state, logicDt); perfMark('forestSigilArc', _p);
    // PHASE 1 P1I Ambient Particle Emitters (2026-05-17) — pollen drift (glade),
    // lantern flicker (saphollow), mist (glowfen). Per-room gate via
    // state.run.currentRoom; off-room emitters flip mesh.visible=false and
    // skip stamp. Bails when not loaded (forest-only gate above already
    // filters non-forest stages).
    _p=perfStart(); tickForestEmitters(state, logicDt); perfMark('forestEmitters', _p);
    // FOREST-V2-A11 Boss HP Bars — top-center DOM overlay for active boss/elite
    // HP + Reaper INVINCIBLE label. Reads state.enemies.active + Reaper run
    // flags; mutates textContent + style.width/opacity only on change. Bails
    // when not loaded (forest-only gate above already filters non-forest stages).
    _p=perfStart(); tickForestBossBars(state, logicDt); perfMark('forestBossBars', _p);
    // FE-C3A — puzzle system tick. Room transition + portal interaction now
    // run directly after hero movement above so arrival i-frames are active
    // before any combat/hazard damage can resolve on the same frame.
    _p=perfStart(); tickPuzzleSystem(logicDt); perfMark('puzzleSystem', _p);
    // FOREST-V2-A14 — sealed-door room progression: pulses sealed portal tint
    // + manages the "SEALED — clear room first" proximity prompt. Bails fast
    // when no portals exist; event-driven spawn/unseal happens in onRoomEnter
    // (wired below in _tickForestRoomTransition) and in enemies.killEnemy.
    _p=perfStart(); tickForestSealedDoors(state, logicDt); perfMark('forestSealedDoors', _p);
    // FOREST ITER C1 — Lockdown Arena zone trigger. One-shot per run via
    // _forestLockdownFired guard (reset in state.resetState). Trigger fires
    // when hero crosses inside the arena radius AND no lockdown is already
    // active (state.run.lockdownActive is also the spawnDirector pause flag).
    // Hero must be in the Glade hub (currentRoom='glade') so puzzle-room
    // crossings don't trip the trigger.
    if (!state.run._forestLockdownFired
        && !state.run.lockdownActive
        && state.run.currentRoom === 'glade'
        && state.run._forestLockdownArenaId
        && state.hero && state.hero.pos) {
      const ARENA_CX = 1.0, ARENA_CZ = -28.0, ARENA_R = 8;
      const _dx = state.hero.pos.x - ARENA_CX;
      const _dz = state.hero.pos.z - ARENA_CZ;
      if (_dx * _dx + _dz * _dz <= ARENA_R * ARENA_R) {
        state.run._forestLockdownFired = true;
        try { triggerLockdown(state.run._forestLockdownArenaId); }
        catch (e) { console.warn('[main] triggerLockdown failed:', e); }
      }
    }
  }
  // Twilight-only: Blood/Light Fountains. No-op on other stages —
  // tickTwilightFountains bails when _fountains is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'twilight') {
    _p=perfStart(); tickTwilightFountains(logicDt, state); perfMark('twilightFountains', _p);
  }
  // Cinder-only: Ballista Turret interactables. No-op on other stages —
  // tickCinderBallistas bails when _ballistas is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'cinder') {
    _p=perfStart(); tickCinderBallistas(logicDt, state); perfMark('cinderBallistas', _p);
  }
  // Void-only: Teleport Pad interactables. No-op on other stages —
  // tickVoidTeleportPads bails when _pads is empty.
  if (state.run && state.run.stage && state.run.stage.id === 'void') {
    _p=perfStart(); tickVoidTeleportPads(logicDt, state); perfMark('voidTeleportPads', _p);
  }
  // Kaki Land owns its animated portals and three-trial interaction route.
  // The global director/objective systems are gated above; this is the only
  // source of final-chapter combat spawns.
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland') {
    _p=perfStart(); tickKakiLandStage(realDt); perfMark('kakiLandStage', _p);
    _p=perfStart(); tickKakiLandPortals(logicDt, state); perfMark('kakiLandPortals', _p);
    _p=perfStart(); tickForestBossBars(state, logicDt); perfMark('kakiBossBars', _p);
  }
  // A4 refactor: single shared chain-arc tick for ALL consumers (chain.js
  // weapon + forestAmber interactable). Runs AFTER both spawners so new arcs
  // get a clean t=0 first frame, matching the pre-refactor weapon behavior
  // byte-for-byte and matching the pre-refactor forest behavior within ~1%
  // opacity drift on frame 0 (life=0.4s, dt~0.016s → k≈0.04).
  _p=perfStart(); tickChainArcs(logicDt);         perfMark('chainArcs', _p);
  _p=perfStart(); tickEvolveBursts(logicDt);      perfMark('evolveBursts', _p);
  _p=perfStart(); tickDissolveBursts(logicDt);    perfMark('dissolveBursts', _p);
  // Punch List #7 — Velocity Veil ribbon trail + splash. Stage-agnostic
  // tick (only fires meaningful work while a veil descriptor is active;
  // descriptors only spawn on Twilight fountain drinks). Cap MAX_VEILS=4,
  // POOL_CAP=128 InstancedMesh slots, ZERO per-tick allocation.
  _p=perfStart(); tickVelocityVeils(logicDt);     perfMark('velocityVeils', _p);
  // Sprite system (atlas-driven, InstancedMesh, billboard shader). Stage-
  // agnostic. Only does work if ensurePool() has been called for ≥1 atlas;
  // until then the loop is empty. Pools are created by FX wiring (#98) and
  // mob spawn (#99) — foundation file doesn't bootstrap any sheets.
  _p=perfStart(); tickSpriteSystem(logicDt);      perfMark('spriteSystem', _p);
  _p=perfStart(); tickStageRule(state, logicDt);  perfMark('stageRule', _p);
  _p=perfStart(); tickMiniEvents(logicDt);        perfMark('miniEvents', _p);
  // PHASE 1 P1B — Achievement chain tick (stage-agnostic). Most checks bail
  // immediately on a per-run Set lookup once unlocked; cheap on the hot path.
  _p=perfStart(); tickAchievements(state, logicDt); perfMark('achievements', _p);
  _p=perfStart(); tickPortalShards(logicDt);      perfMark('portalShards', _p);
  _p=perfStart(); tickStageLife(realDt);          perfMark('stageLife', _p);
  _p=perfStart(); tickSynergies(logicDt);         perfMark('synergies', _p);
  _p=perfStart(); tickPickups(logicDt);           perfMark('pickups', _p);
  _p=perfStart(); tickCatacombEntrance(logicDt);  perfMark('catacEntry', _p);
  _p=perfStart(); updateBlobShadows();            perfMark('blobs', _p);
  _p=perfStart(); updateDamageNumbers(realDt);    perfMark('dmgNums', _p);

  // FX decay (real time so feedback fades even during hit-stop)
  state.fx.chromaticPulse *= Math.pow(0.05, realDt);
  state.fx.bloomBoost     *= Math.pow(0.10, realDt);

  // Camera follow hero (lerp xz, keep height + offset matching original game)
  const hp = state.hero.pos;
  const camLerp = WORLD.cameraLerp;
  // FE-C3A — during a Forest room transition, drive the camera toward the
  // room center instead of toward the hero. Stronger lerp (0.18) so the
  // 0.6s window resolves into a visible "settle to room" motion rather than
  // hanging halfway. Falls through to the standard hero-follow when the
  // transition completes (_forestCamLerp.active flips false).
  const isKakiLandRun = !!(state.run && state.run.stage && state.run.stage.id === 'kakiland');
  if (isKakiLandRun) {
    // Treat every floating island as a full play-space. The bridge routes
    // remain readable at the slightly wider Kaki frustum, but the camera now
    // tracks the hero so terrain, landmarks and portal fights have game-scale
    // presence instead of reading as a far-away strategy-map overview.
    camera.position.x += (hp.x + 40 - camera.position.x) * camLerp;
    camera.position.z += (hp.z + 40 - camera.position.z) * camLerp;
    camera.position.y = 60;
    camera.lookAt(hp.x, 0, hp.z);
  } else if (state.run && state.run.stage && state.run.stage.id === 'forest'
      && _forestCamLerp.active && _forestCamLerp.targetX != null) {
    const tcx = _forestCamLerp.targetX;
    const tcz = _forestCamLerp.targetZ;
    camera.position.x += (tcx + 40 - camera.position.x) * 0.18;
    camera.position.z += (tcz + 40 - camera.position.z) * 0.18;
    camera.position.y = 60;
    camera.lookAt(tcx, 0, tcz);
  } else {
    camera.position.x += (hp.x + 40 - camera.position.x) * camLerp;
    camera.position.z += (hp.z + 40 - camera.position.z) * camLerp;
    camera.position.y = 60;
    camera.lookAt(hp.x, 0, hp.z);
  }

  // Sun + shadow-camera follow: keep the directional light at a fixed offset
  // from the hero so the 80-unit shadow frustum always contains the action.
  if (state.envGroup && state.envGroup.userData.sun) {
    const sun = state.envGroup.userData.sun;
    sun.position.set(hp.x + 60, 80, hp.z + 40);
    sun.target.position.set(hp.x, 0, hp.z);
    sun.target.updateMatrixWorld();
  }

  // Per-stage atmospheric particles (iter 15) — drift pollen/wisps/embers/
  // sparkles around the hero. Guarded for title-screen / town frames where
  // envGroup may exist but no stage is active.
  if (state.envGroup && typeof state.envGroup.userData.tickAtmosphere === 'function') {
    state.envGroup.userData.tickAtmosphere(realDt, state.hero);
  }
  // P4A cohort 3 — tick cave-owned per-frame decor (currently glowmoss alpha
  // pulse). Self-gates on its module-level _group so non-cave runs are a
  // free no-op per [[feedback_kks_wave_dispatcher_throttle.md]].
  tickCave(realDt);

  applyShake(realDt);

  // Apply zoom — adjusts the orthographic frustum size each frame.
  const z = getZoom();
  const half = isKakiLandRun ? KAKI_LAND_CAMERA_HALF : WORLD.cameraDistance / z;
  setOrthoFrustum(half);

  // PHASE 1 P1E — Boss intro cinematic. Ticked AFTER hero-follow + per-frame
  // frustum bake so a writes to camera.position / camera.zoom override the
  // hero-follow each frame during the 1.5s sequence. Stage-agnostic; bails
  // fast when no sequence is active and no untriggered roomboss is present.
  _p=perfStart(); tickBossIntroCinematic(state, realDt, camera); perfMark('bossIntroCinematic', _p);

  // PHASE 1 P1J — Weapon evolve cinematic. Ticked AFTER bossIntroCinematic
  // so writes to camera.position / camera.zoom override BOTH the hero-follow
  // AND the boss-intro override during the 1.0s sequence (evolve takes
  // priority by being the LAST writer per frame). Stage-agnostic; bails
  // fast when no sequence is active.
  _p=perfStart(); tickEvolveCinematic(state, realDt, camera); perfMark('evolveCinematic', _p);

  // Update post-FX uniforms
  if (state.postFXPass) {
    state.postFXPass.uniforms.time.value = state.time.real;
    state.postFXPass.uniforms.chromatic.value = 0.0008 + state.fx.chromaticPulse * 0.004;
  }
  if (state.bloomPass) {
    const vfxMul = (getMeta().optVfx !== undefined ? getMeta().optVfx : 1.0);
    state.bloomPass.strength = (0.30 + state.fx.bloomBoost * 0.30) * vfxMul;
  }

  // Music intensity: 0 in first 20s, 1 mid-game, 2 once final boss is up
  const hasFinalBoss = state.enemies.active.some(e => e.isFinalBoss);
  setMusicTier(hasFinalBoss ? 2 : (state.time.game > 20 ? 1 : 0));

  // Secret-unlock time checks (cheap; functions self-dedupe via meta.secrets)
  if (state.run.flawless && state.time.game >= 300 && !_checkedUntouchable) {
    _checkedUntouchable = true;
    import('./ui.js').then(({ trySecret }) => trySecret('untouchable_5min'));
  }
  if (state.time.game >= 1500 && !_checkedMarathon) {
    _checkedMarathon = true;
    import('./ui.js').then(({ trySecret }) => trySecret('marathon'));
  }
  if (!_checkedHoarder) {
    const m = getMeta();
    if (m.lifetime && (m.lifetime.coinsEverEarned || 0) >= 500) {
      _checkedHoarder = true;
      import('./ui.js').then(({ trySecret }) => trySecret('hoarder'));
    }
  }

  // Color grade: subtle red shadow tint during final boss (urgent vibe).
  if (state.postFXPass && state.postFXPass.uniforms.lift) {
    const liftU = state.postFXPass.uniforms.lift.value;
    const targetR = hasFinalBoss ? 0.05 : 0.00;
    const targetB = hasFinalBoss ? -0.02 : 0.02;
    liftU.x += (targetR - liftU.x) * 0.04;
    liftU.z += (targetB - liftU.z) * 0.04;
  }

  _p=perfStart(); updateUI();      perfMark('ui', _p);

  // FE-C3A — end-of-frame sweep for one-shot interact flag. hero.js sets it
  // when the player hits E or B-button; readers (puzzle/portal systems) see
  // it during the same frame's tick. Clearing here means a frame with no
  // reader still leaves a clean slate next frame. Safe to clear even when
  // not set (no-op assignment).
  if (state.input) state.input.interactPressed = false;

  _p=perfStart(); renderFrame();   perfMark('render', _p);
  updatePerfHUD();
  renderPerfProfilerOverlay();
}

// The frame body deliberately never schedules itself. Keeping scheduling at
// this single boundary makes every early-return mode follow the same lifecycle
// used by WebGPURenderer. The later service integration replaces only the
// registration call; gameplay frame order remains unchanged.
let _mainLoopRunning = false;
let _mainLoopStartCount = 0;
let _mainLoopFrameCount = 0;
let _mainLoopLastTimestamp = null;
let _mainLoopDuplicateTimestampCount = 0;

function _dispatchMainFrame(now) {
  if (!_mainLoopRunning) return;
  if (now === _mainLoopLastTimestamp) _mainLoopDuplicateTimestampCount += 1;
  _mainLoopLastTimestamp = now;
  _mainLoopFrameCount += 1;
  try {
    frame(now);
  } catch (error) {
    void _stopMainLoop().catch(() => {});
    throw error;
  }
}

async function _startMainLoop() {
  if (_mainLoopRunning) return false;
  _mainLoopRunning = true;
  _mainLoopStartCount += 1;
  _lastT = performance.now();
  try {
    await rendererService.setAnimationLoop(_dispatchMainFrame);
    return true;
  } catch (error) {
    _mainLoopRunning = false;
    throw error;
  }
}

async function _stopMainLoop() {
  const changed = _mainLoopRunning;
  _mainLoopRunning = false;
  await rendererService.setAnimationLoop(null);
  return changed;
}

window.__kkMainLoop = Object.freeze({
  snapshot: () => Object.freeze({
    running: _mainLoopRunning,
    owner: 'renderer.setAnimationLoop',
    startCount: _mainLoopStartCount,
    frameCount: _mainLoopFrameCount,
    duplicateTimestampCount: _mainLoopDuplicateTimestampCount,
  }),
});

// ── WebGL context-loss rebuild stub ──────────────────────────────────────────
// Renderer-migration QA scenes are opt-in and intentionally absent from the
// normal module graph. Keep this exact matcher in sync with qa/qaScenes.js;
// notably, the established `?qa=1` and `?qa=crash` harnesses do not match.
function _requestedRendererQaScene() {
  let selector = '';
  try { selector = new URLSearchParams(window.location.search || '').get('qa') || ''; }
  catch (_) { return ''; }
  const stages = new Set(['forest', 'twilight', 'cinder', 'void', 'cave', 'kakiland']);
  const fixed = new Set([
    'menu', 'main-menu', 'hero-selection', 'forest-horde', 'max-weapon-fx',
    'kakiland-boss', 'town-night', 'town-house-interior', 'town-casino-interior',
    'catacomb', 'bullet-hell', 'rally-heavy', 'rally-first-person', 'rally-chase',
    'monster-smash', 'monster-smash-chase', 'draw-track', 'trials', 'catastrophe', 'postfx',
    'low-effects', 'reduced-motion', 'reduced-flashing', 'high-contrast',
  ]);
  if (fixed.has(selector)) return selector;
  if (selector.startsWith('stage-') && stages.has(selector.slice(6))) return selector;
  if (selector.startsWith('final-boss-') && stages.has(selector.slice(11))) return selector;
  return '';
}

boot().then(async () => {
  await _startMainLoop();
  const qaSelector = _requestedRendererQaScene();
  if (!qaSelector) return;
  // Register after the main frame callback so setup cannot become a second
  // animation-loop owner or mutate state before normal boot reaches first RAF.
  requestAnimationFrame(() => {
    import('./qa/qaScenes.js')
      .then(({ initializeQaScene }) => initializeQaScene(qaSelector))
      .catch((error) => {
        const entry = {
          source: 'dynamic-import',
          name: error?.name || 'Error',
          message: error?.message || String(error),
          stack: error?.stack || '',
        };
        console.error(`[qa:${qaSelector}] could not initialize`, error);
        if (!window.__kkQa) {
          window.__kkQa = {
            schemaVersion: 1,
            selector: qaSelector,
            status: 'error',
            ready: false,
            errors: [entry],
            snapshot() {
              return {
                schemaVersion: 1,
                selector: qaSelector,
                status: 'error',
                ready: false,
                errors: [entry],
              };
            },
          };
        }
      });
  });
});
