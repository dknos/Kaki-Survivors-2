/**
 * Portal Shards — the explore-mode OBJECTIVE loop.
 *
 * Design (researched: Risk of Rain 2 teleporter × Portal Knights collect-N ×
 * Shards-of-Solitude procgen placement — see the design discussion):
 *   • Forest is the authored exception: six Glade portals lead to sealed,
 *     multi-wave Grove Trials. Clearing all six awakens one fixed Boss Gate.
 *   • Other stages seed 5 Portal Shards across their exploration field.
 *   • Walk onto a shard to collect it. The radar footer shows SHARDS 2/5.
 *   • Collect all 5 → a PORTAL ignites at your feet → step in → the generated
 *     Catacomb dungeon. Clearing its boss returns the hero to the overworld.
 *
 * On shard stages, discoveries are split between field pickups and earned
 * mini-boss drops. Forest's same minimap surface instead shows room/gate state.
 *
 * Lifecycle is explicit: initPortalShards(scene) once, spawnPortalShards()
 * at run start, resetPortalShards() on teardown, tickPortalShards(dt) in the RUN
 * branch of the main loop.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { tex } from './particleTextures.js';
import { fxTex } from './fxTextures.js';
import { floorDecalGeometry, floorDecalMaterial, applyFloorTier } from './fxLayers.js';
import { showBanner } from './ui.js';
import { playCutscene } from './cutscene.js';
import { sfx } from './audio.js';
import { preloadDungeonKit } from './assets.js';
import { CATACOMB_ENTRANCE_POS, FOREST_BOSS_GATE_POS, enterCatacomb } from './catacomb.js';
import {
  FOREST_ROOMS,
  FOREST_PORTAL_POSITIONS,
  FOREST_WORLD_BOUNDS,
  constrainForestX,
  constrainForestZ,
  isForestPositionPlayable,
  getForestTravelCorridors,
} from './forestRooms.js';
import { FIELD_MAP_RADIUS, getStageTerrainLayout, sampleStageTerrain } from './stageTerrainLayout.js';
import {
  MINIMAP_INV_SQRT2,
  worldBoundsToMinimapBounds,
} from './minimapProjection.js';

const SHARD_COUNT = 5;
const FIELD_SHARDS = 3;                // scattered in the open (the findable path)
const RING_MIN = 44, RING_MAX = 82;   // spawn distance band (far → explore)
const MIN_SEP = 30;                    // min spacing between shards (spread them)
const COLLECT_R = 2.8;                 // walk-onto pickup radius
const PORTAL_ENTER_R = 2.2;            // walk-into-center to enter the finale
const SHARD_COLOR = 0xc87bff;          // portal-violet (matches catacomb exit rune)
const BEAM_H = 9.0;

let _scene = null;
let _hud = null;
let _minimap = null;
let _minimapCtx = null;
let _minimapNextDraw = 0;
let _minimapDirty = true;
let _minimapDrawCount = 0;
let _minimapSupported = true;
let _minimapAriaLabel = '';
let _minimapDpr = 1;
const _shards = [];      // { group, beamMat, x, z, collected, spin, earned }
let _collected = 0;
let _earnedRemaining = 0; // shards still owed by mini-boss drops (earned path)
let _portal = null;      // { group, x, z } once 5/5
let _portalPrompt = null;
let _portalArmedAt = 0;  // time.real when the portal becomes enterable (a beat)
let _armed = false;      // spawned this run (guards tick before spawn)
let _portalEntering = false;
let _forestTrialMode = false;

// Compact command-deck radar. Navigation gets the pixels; the old title,
// orientation label, and double-sided footer were removed as visual chrome.
const MINIMAP_WIDTH = 156;
const MINIMAP_HEIGHT = 104;
const MINIMAP_REDRAW_SEC = 0.125; // 8 Hz: smooth enough for navigation, cheap.
const FOREST_MAP_ROOMS = Object.values(FOREST_ROOMS);
const FOREST_OUTBOUND_PORTALS = Object.values(FOREST_PORTAL_POSITIONS);
const FOREST_MAP_BOUNDS = Object.freeze({
  minX: FOREST_WORLD_BOUNDS.minX,
  maxX: FOREST_WORLD_BOUNDS.maxX,
  minZ: FOREST_WORLD_BOUNDS.minZ,
  maxZ: FOREST_WORLD_BOUNDS.maxZ,
});
const FOREST_MAP_VIEW_BOUNDS = Object.freeze(worldBoundsToMinimapBounds(FOREST_MAP_BOUNDS));
const _mapViewBoundsScratch = { minRight: 0, maxRight: 0, minDown: 0, maxDown: 0 };

// ── HUD ──────────────────────────────────────────────────────────────────────
function _buildHud() {
  if (_hud && _hud.isConnected && _minimap && _minimap.isConnected) return;
  // Defensive module-reload cleanup: normal runs build once, but isolated
  // browser tests/HMR must not accumulate duplicate fixed-position IDs.
  document.getElementById('kk-portal-hud')?.remove();
  document.getElementById('kk-portal-minimap')?.remove();
  _hud = document.createElement('div');
  _hud.id = 'kk-portal-hud';
  // Responsive: box-sizing + max-width so wide text never crops at the sides.
  _hud.style.cssText = `
    position: fixed; top: 58px; left: 50%; transform: translateX(-50%);
    max-width: 92vw; box-sizing: border-box;
    padding: 8px 18px; pointer-events: none; z-index: 70;
    display: none; white-space: nowrap;
    background: linear-gradient(145deg, rgba(46,30,42,.94), rgba(21,15,24,.95));
    border: 1px solid var(--kk-hud-line,rgba(255,226,188,.30)); border-radius: 13px;
    color: var(--kk-hud-cream,#fff0dc); font: 800 11px 'Geist', sans-serif;
    letter-spacing: 0.16em; text-align: center; text-transform: uppercase;
    box-shadow: var(--kk-hud-shadow,0 14px 34px rgba(14,7,12,.46)), inset 0 1px 0 rgba(255,255,255,.07);
    backdrop-filter:blur(12px) saturate(125%); -webkit-backdrop-filter:blur(12px) saturate(125%);
  `;
  (document.getElementById('kk-stage') || document.body).appendChild(_hud);

  _minimap = document.createElement('canvas');
  _minimap.id = 'kk-portal-minimap';
  _minimapDpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  _minimap.width = Math.round(MINIMAP_WIDTH * _minimapDpr);
  _minimap.height = Math.round(MINIMAP_HEIGHT * _minimapDpr);
  _minimap.setAttribute('role', 'img');
  _minimap.setAttribute('aria-label', 'Portal Shard minimap');
  _minimap.style.cssText = `
    position:fixed;
    left:50%; bottom:max(9px,env(safe-area-inset-bottom));
    transform:translateX(-50%);
    width:clamp(112px,10.3vw,132px); height:auto; display:none;
    pointer-events:none; z-index:94; opacity:1;
    border:1px solid rgba(255,224,178,.42); border-radius:11px;
    background:rgba(17,12,20,.96);
    box-shadow:0 8px 20px rgba(10,5,9,.48),0 0 0 1px rgba(255,255,255,.05) inset,0 0 14px rgba(200,123,255,.12);
    backdrop-filter:blur(10px) saturate(120%);
    -webkit-backdrop-filter:blur(10px) saturate(120%);
  `;
  (document.getElementById('kk-stage') || document.body).appendChild(_minimap);
  _minimapCtx = _minimap.getContext('2d', { alpha: true });
  _minimapSupported = !!_minimapCtx;
  if (!_minimapSupported) _minimap.style.display = 'none';
}

function _isObjectiveUiVisible() {
  if (_forestTrialMode) {
    const trial = state.run && state.run.forestPortalTrials;
    return !!(_armed && _isRunUiVisible() && !(trial && trial.bossDefeated));
  }
  return !!(_armed && _isRunUiVisible() && _collected < SHARD_COUNT);
}

function _isRunUiVisible() {
  return !!(state.started && state.mode === 'run' && !state.gameOver
    && !state.pendingLevelUp && !(state.time && state.time.paused));
}

function _isMinimapVisible() {
  return !!(_minimapSupported && _armed && _isRunUiVisible());
}

function _currentMapBounds() {
  const stageId = state.run && state.run.stage && state.run.stage.id;
  if (stageId === 'forest') return FOREST_MAP_BOUNDS;
  let radius = FIELD_MAP_RADIUS;
  const include = (p) => {
    if (!p) return;
    radius = Math.max(radius, Math.abs(p.x || 0) + 12, Math.abs(p.z || 0) + 12);
  };
  include(state.hero && state.hero.pos);
  for (const shard of _shards) if (!shard.collected) include(shard);
  include(_portal);
  return {
    minX: -radius,
    maxX: radius,
    minZ: -radius,
    maxZ: radius,
  };
}

function _currentMapViewBounds(stageId) {
  if (stageId === 'forest') return FOREST_MAP_VIEW_BOUNDS;

  // Radial stages are invariant under the 45-degree camera-view rotation, so
  // fit the authored arena circle tightly. Expand only when a live objective
  // actually sits farther out; this avoids the empty corner padding produced
  // by rotating an axis-aligned square around a circular arena.
  let radius = FIELD_MAP_RADIUS;
  const include = (p) => {
    if (!p) return;
    const right = ((p.x || 0) - (p.z || 0)) * MINIMAP_INV_SQRT2;
    const down = ((p.x || 0) + (p.z || 0)) * MINIMAP_INV_SQRT2;
    radius = Math.max(radius, Math.abs(right) + 12, Math.abs(down) + 12);
  };
  include(state.hero && state.hero.pos);
  for (const shard of _shards) if (!shard.collected) include(shard);
  include(_portal);
  include(CATACOMB_ENTRANCE_POS);

  // Keep the result in reusable module scratch; `_drawMinimap` consumes it
  // synchronously before the next 8 Hz draw can mutate it.
  _mapViewBoundsScratch.minRight = -radius;
  _mapViewBoundsScratch.maxRight = radius;
  _mapViewBoundsScratch.minDown = -radius;
  _mapViewBoundsScratch.maxDown = radius;
  return _mapViewBoundsScratch;
}

function _traceWorldRect(ctx, bounds, mapX, mapY) {
  ctx.beginPath();
  ctx.moveTo(mapX(bounds.minX, bounds.minZ), mapY(bounds.minX, bounds.minZ));
  ctx.lineTo(mapX(bounds.maxX, bounds.minZ), mapY(bounds.maxX, bounds.minZ));
  ctx.lineTo(mapX(bounds.maxX, bounds.maxZ), mapY(bounds.maxX, bounds.maxZ));
  ctx.lineTo(mapX(bounds.minX, bounds.maxZ), mapY(bounds.minX, bounds.maxZ));
  ctx.closePath();
}

function _traceWorldOrientedRect(ctx, item, mapX, mapY) {
  const yaw = item.yaw || 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const stamp = (lx, lz, first) => {
    const x = item.x + lx * c + lz * s;
    const z = item.z - lx * s + lz * c;
    if (first) ctx.moveTo(mapX(x, z), mapY(x, z));
    else ctx.lineTo(mapX(x, z), mapY(x, z));
  };
  ctx.beginPath();
  stamp(-item.halfWidth, -item.halfLength, true);
  stamp(item.halfWidth, -item.halfLength, false);
  stamp(item.halfWidth, item.halfLength, false);
  stamp(-item.halfWidth, item.halfLength, false);
  ctx.closePath();
}

function _setMinimapVisible(visible) {
  if (!_minimap) return;
  if (!_minimapSupported) visible = false;
  const wasVisible = _minimap.style.display !== 'none';
  if (visible === wasVisible) return;
  _minimap.style.display = visible ? 'block' : 'none';
  if (visible && !wasVisible) _minimapDirty = true;
}

function _invalidateMinimap() {
  _minimapDirty = true;
}

function _drawMinimap() {
  const ctx = _minimapCtx;
  if (!ctx || !_minimap || !_isMinimapVisible()) {
    _minimapDirty = false;
    return;
  }

  const w = MINIMAP_WIDTH;
  const h = MINIMAP_HEIGHT;
  const padX = 7;
  const padTop = 7;
  const padBottom = 18;
  const stageId = state.run && state.run.stage && state.run.stage.id;
  const isForest = stageId === 'forest';
  _minimap.dataset.stage = stageId || '';
  _minimap.dataset.profile = isForest ? 'forest-rooms' : 'open-arena';
  _minimap.dataset.projection = 'camera-aligned';
  const worldBounds = _currentMapBounds();
  const bounds = _currentMapViewBounds(stageId);
  const spanRight = Math.max(1, bounds.maxRight - bounds.minRight);
  const spanDown = Math.max(1, bounds.maxDown - bounds.minDown);
  const scale = Math.min((w - padX * 2) / spanRight, (h - padTop - padBottom) / spanDown);
  const mapW = spanRight * scale;
  const mapH = spanDown * scale;
  const ox = (w - mapW) * 0.5;
  const oy = padTop + (h - padTop - padBottom - mapH) * 0.5;
  const mapX = (x, z) => {
    const right = (x - z) * MINIMAP_INV_SQRT2;
    return ox + (Math.max(bounds.minRight, Math.min(bounds.maxRight, right)) - bounds.minRight) * scale;
  };
  const mapY = (x, z) => {
    const down = (x + z) * MINIMAP_INV_SQRT2;
    return oy + (Math.max(bounds.minDown, Math.min(bounds.maxDown, down)) - bounds.minDown) * scale;
  };

  ctx.setTransform(_minimapDpr, 0, 0, _minimapDpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(41,26,42,.97)');
  bg.addColorStop(0.42, 'rgba(23,18,29,.97)');
  bg.addColorStop(1, 'rgba(13,12,18,.98)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const topGlow = ctx.createRadialGradient(w * 0.18, 0, 0, w * 0.18, 0, w * 0.85);
  topGlow.addColorStop(0, 'rgba(216,156,255,.17)');
  topGlow.addColorStop(1, 'rgba(216,156,255,0)');
  ctx.fillStyle = topGlow;
  ctx.fillRect(0, 0, w, h);

  // Keep navigation marks in the authored map viewport. Header/footer chrome
  // remains crisp and never gets crossed by a route line or objective pulse.
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, mapW, mapH);
  ctx.clip();

  // The grid rotates with the camera projection. It is intentionally drawn in
  // world X/Z increments so landmarks remain spatially truthful while W/A/S/D
  // movement stays aligned to the screen edges.
  ctx.strokeStyle = 'rgba(216,196,230,.075)';
  ctx.lineWidth = 1;
  for (let gx = Math.ceil(worldBounds.minX / 50) * 50; gx < worldBounds.maxX; gx += 50) {
    ctx.beginPath();
    ctx.moveTo(mapX(gx, worldBounds.minZ), mapY(gx, worldBounds.minZ));
    ctx.lineTo(mapX(gx, worldBounds.maxZ), mapY(gx, worldBounds.maxZ));
    ctx.stroke();
  }
  for (let gz = Math.ceil(worldBounds.minZ / 50) * 50; gz < worldBounds.maxZ; gz += 50) {
    ctx.beginPath();
    ctx.moveTo(mapX(worldBounds.minX, gz), mapY(worldBounds.minX, gz));
    ctx.lineTo(mapX(worldBounds.maxX, gz), mapY(worldBounds.maxX, gz));
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(233,206,246,.16)';
  ctx.lineWidth = 1;
  if (isForest) {
    _traceWorldRect(ctx, worldBounds, mapX, mapY);
    ctx.stroke();
  }

  if (isForest) {
    const currentRoom = (state.run && state.run.currentRoom) || 'glade';
    const trial = state.run && state.run.forestPortalTrials;
    // Dotted lines describe portal topology, not walkable roads.
    ctx.save();
    ctx.strokeStyle = 'rgba(216,156,255,.34)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.lineCap = 'round';
    for (const corridor of getForestTravelCorridors()) {
      ctx.beginPath();
      ctx.moveTo(mapX(corridor.from.x, corridor.from.z), mapY(corridor.from.x, corridor.from.z));
      ctx.lineTo(mapX(corridor.to.x, corridor.to.z), mapY(corridor.to.x, corridor.to.z));
      ctx.stroke();
    }
    ctx.restore();
    for (const room of FOREST_MAP_ROOMS) {
      const active = room.id === currentRoom;
      const rec = trial && trial.rooms && trial.rooms[room.id];
      const cleared = rec && rec.status === 'CLEARED';
      const fighting = rec && rec.status === 'ACTIVE';
      ctx.fillStyle = fighting ? 'rgba(255,112,82,.18)'
        : cleared ? 'rgba(125,240,196,.15)'
          : active ? 'rgba(255,216,107,.12)' : 'rgba(95,143,181,.08)';
      ctx.strokeStyle = fighting ? 'rgba(255,124,92,.90)'
        : cleared ? 'rgba(125,240,196,.80)'
          : active ? 'rgba(255,216,107,.78)' : 'rgba(95,143,181,.35)';
      ctx.lineWidth = active ? 2.2 : 1.2;
      _traceWorldRect(ctx, room.bounds, mapX, mapY);
      ctx.fill();
      ctx.stroke();
    }
    // Six Glade-side trial gates: amber available, red active, mint cleared.
    for (const portal of FOREST_OUTBOUND_PORTALS) {
      const rec = trial && trial.rooms && trial.rooms[portal.to];
      const color = rec && rec.status === 'CLEARED' ? '#7df0c4'
        : rec && rec.status === 'ACTIVE' ? '#ff795c' : '#ffd86b';
      const x = mapX(portal.x, portal.z), y = mapY(portal.x, portal.z);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#fff5d7';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(x, y, rec && rec.status === 'ACTIVE' ? 4.2 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else {
    // Open-arena stages use a stable authored radar rather than Forest's
    // disconnected room rectangles. Rings match the actual 105u filled field.
    const cx = mapX(0, 0), cy = mapY(0, 0);
    ctx.save();
    ctx.strokeStyle = 'rgba(125,240,196,.20)';
    ctx.lineWidth = 1;
    for (const radius of [35, 70, FIELD_MAP_RADIUS]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // The renderer and gameplay hazards read the same terrain descriptor. Draw
  // it here so bridge crossings are navigable information, not just scenery.
  const terrain = state.run && state.run.terrainLayoutReady === stageId
    ? getStageTerrainLayout(stageId)
    : null;
  if (terrain) {
    ctx.save();
    ctx.strokeStyle = terrain.effect === 'damage' ? 'rgba(255,105,73,.64)' : 'rgba(93,184,199,.56)';
    ctx.lineWidth = Math.max(2, terrain.width * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < terrain.points.length; i++) {
      const p = terrain.points[i];
      if (i === 0) ctx.moveTo(mapX(p.x, p.z), mapY(p.x, p.z));
      else ctx.lineTo(mapX(p.x, p.z), mapY(p.x, p.z));
    }
    ctx.stroke();
    for (const bridge of terrain.bridges) {
      ctx.fillStyle = '#e7c98f';
      ctx.strokeStyle = '#fff2c7';
      ctx.lineWidth = 0.8;
      _traceWorldOrientedRect(ctx, bridge, mapX, mapY);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  const pulse = 0.65 + 0.35 * Math.sin(((state.time && state.time.real) || 0) * 4);
  let live = 0;
  ctx.save();
  ctx.shadowColor = '#d89cff';
  ctx.shadowBlur = 8;
  if (!isForest) {
    for (const shard of _shards) {
      if (shard.collected) continue;
      live++;
      const x = mapX(shard.x, shard.z);
      const y = mapY(shard.x, shard.z);
      const r = 5 + pulse;
      ctx.fillStyle = '#e5b7ff';
      ctx.strokeStyle = '#fff3ff';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();

  // One fixed Boss Gate replaces Forest's duplicate stairs + random portal.
  const forestTrial = isForest && state.run && state.run.forestPortalTrials;
  ctx.save();
  ctx.fillStyle = isForest
    ? (forestTrial && forestTrial.bossUnlocked ? '#d8a0ff' : '#4f5665')
    : '#ffb76b';
  ctx.strokeStyle = isForest && forestTrial && forestTrial.bossUnlocked ? '#fff0ff' : '#fff0c2';
  ctx.lineWidth = forestTrial && forestTrial.bossUnlocked ? 2 : 1;
  const gatePos = isForest ? FOREST_BOSS_GATE_POS : CATACOMB_ENTRANCE_POS;
  const stairX = mapX(gatePos.x, gatePos.z), stairY = mapY(gatePos.x, gatePos.z);
  ctx.beginPath();
  ctx.arc(stairX, stairY, isForest ? 4.8 + (forestTrial && forestTrial.bossUnlocked ? pulse : 0) : 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  if (_portal) {
    const x = mapX(_portal.x, _portal.z), y = mapY(_portal.x, _portal.z);
    ctx.save();
    ctx.strokeStyle = '#e5b7ff';
    ctx.fillStyle = 'rgba(200,123,255,.62)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#d89cff';
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.arc(x, y, 6 + pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  const hero = state.hero && state.hero.pos;
  if (hero) {
    const x = mapX(hero.x, hero.z);
    const y = mapY(hero.x, hero.z);
    const facing = state.hero.facing || { x: 0, z: 1 };
    const facingRight = ((facing.x || 0) - (facing.z || 0)) * MINIMAP_INV_SQRT2;
    const facingDown = ((facing.x || 0) + (facing.z || 0)) * MINIMAP_INV_SQRT2;
    const angle = Math.atan2(facingRight, -facingDown);
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = `rgba(125,240,196,${(0.32 + pulse * 0.18).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 8.2 + pulse * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(angle);
    ctx.fillStyle = '#fff6cf';
    ctx.strokeStyle = '#3ecf9a';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#7df0c4';
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.moveTo(0, -6.5);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 3.2);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    _minimap.dataset.heroX = x.toFixed(2);
    _minimap.dataset.heroY = y.toFixed(2);
  }

  ctx.restore(); // map viewport clip

  // A single footer replaces the old map title, VIEW ALIGNED badge, compass
  // letters, and two competing objective strings. The radar itself now owns
  // almost the entire surface.
  ctx.strokeStyle = 'rgba(255,226,188,.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(8, h - 15.5);
  ctx.lineTo(w - 8, h - 15.5);
  ctx.stroke();

  const trialTotal = forestTrial ? forestTrial.total || 6 : SHARD_COUNT;
  ctx.font = "700 7px 'Geist Mono',monospace";
  ctx.fillStyle = forestTrial && forestTrial.bossUnlocked ? '#ffd86b' : '#e8d7f1';
  ctx.textAlign = 'center';
  ctx.fillText(isForest
    ? (forestTrial && forestTrial.bossUnlocked ? 'BOSS GATE READY' : `TRIALS ${_collected}/${trialTotal}`)
    : (_collected >= SHARD_COUNT ? 'PORTAL READY' : `SHARDS ${_collected}/${SHARD_COUNT}`), w * 0.5, h - 5);
  const guarded = Math.max(0, _earnedRemaining);

  _minimap.dataset.shardMarkers = String(isForest ? 0 : live);
  _minimap.dataset.trialsCleared = String(isForest ? _collected : 0);
  _minimap.dataset.bossPortal = isForest
    ? (forestTrial && forestTrial.bossUnlocked ? 'ready' : 'locked')
    : (_portal ? 'ready' : 'hidden');
  _minimap.dataset.drawCount = String(++_minimapDrawCount);
  const ariaLabel = isForest
    ? `Forest portal trials: ${_collected} of ${trialTotal} cleared; boss gate ${forestTrial && forestTrial.bossUnlocked ? 'ready' : 'locked'}`
    : (_collected >= SHARD_COUNT
      ? 'Portal minimap: portal ready'
      : `Portal Shard minimap: ${_collected} of ${SHARD_COUNT} collected, ${live} located${guarded ? `, ${guarded} guarded` : ''}`);
  if (ariaLabel !== _minimapAriaLabel) {
    _minimapAriaLabel = ariaLabel;
    _minimap.setAttribute('aria-label', ariaLabel);
  }
  _minimapDirty = false;
}

function _setHudVisible(visible) {
  if (!_hud) return;
  const display = visible ? 'block' : 'none';
  if (_hud.style.display !== display) _hud.style.display = display;
}

// Called before main.js mode-specific early returns so Catacomb, Bullet Hell,
// pause, level-up, and death transitions cannot strand overworld HUD elements.
export function syncPortalShardHudVisibility() {
  const showObjective = _isObjectiveUiVisible();
  const showMinimap = _isMinimapVisible();
  // The compact radar footer owns objective progress. The standalone pill is
  // only a fallback for a browser without canvas support.
  _setHudVisible(showObjective && !showMinimap);
  _setMinimapVisible(showMinimap);
  if (!_isRunUiVisible() && _portalPrompt && _portalPrompt.style.display !== 'none') {
    _portalPrompt.style.display = 'none';
  }
}

function _updateHud() {
  if (!_hud) return;
  if (!_armed) {
    syncPortalShardHudVisibility();
    return;
  }
  if (_forestTrialMode) {
    const trial = state.run && state.run.forestPortalTrials;
    const total = trial ? trial.total || 6 : 6;
    const cleared = Math.max(0, Math.min(total, trial ? trial.cleared || 0 : _collected));
    let pips = '';
    for (let i = 0; i < total; i++) pips += i < cleared ? '◈' : '◇';
    _hud.textContent = `GROVE TRIALS  ${pips}  ${cleared} / ${total}`;
    syncPortalShardHudVisibility();
    return;
  }
  let pips = '';
  for (let i = 0; i < SHARD_COUNT; i++) pips += i < _collected ? '◈' : '◇';
  _hud.textContent = `PORTAL SHARDS  ${pips}  ${_collected} / ${SHARD_COUNT}`;
  syncPortalShardHudVisibility();
}

// ── shard mesh ────────────────────────────────────────────────────────────────
function _makeShard(x, z, earned = false) {
  const g = new THREE.Group();
  g.name = '__portalShard';
  g.position.set(x, 0, z);

  // Floating crystal shard — elongated octahedron, glows via bloom.
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.85, 0).scale(0.7, 1.5, 0.7),
    new THREE.MeshStandardMaterial({
      color: SHARD_COLOR, emissive: SHARD_COLOR, emissiveIntensity: 1.3,
      roughness: 0.25, metalness: 0.4,
    }),
  );
  gem.position.y = 1.5;
  gem.layers.enable(BLOOM_LAYER);
  gem.castShadow = true;
  g.add(gem);
  g.userData._gem = gem;

  // Tall beacon beam — two crossed additive planes, visible through the fog.
  const beamMat = new THREE.MeshBasicMaterial({
    map: tex('glowWhite') || fxTex('portal_catacomb_outer'),
    color: SHARD_COLOR, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const ba = new THREE.Mesh(new THREE.PlaneGeometry(1.1, BEAM_H), beamMat);
  ba.position.y = BEAM_H * 0.5;
  const bb = new THREE.Mesh(new THREE.PlaneGeometry(1.1, BEAM_H), beamMat);
  bb.position.y = BEAM_H * 0.5; bb.rotation.y = Math.PI / 2;
  ba.layers.enable(BLOOM_LAYER); bb.layers.enable(BLOOM_LAYER);
  g.add(ba); g.add(bb);

  // Ground rune decal (under hero — negative renderOrder tier).
  const rune = new THREE.Mesh(
    floorDecalGeometry(3.0),
    floorDecalMaterial({ map: fxTex('portal_catacomb_outer') || tex('glowWhite'), color: SHARD_COLOR, opacity: 0.7 }),
  );
  rune.position.y = 0.04;
  applyFloorTier(rune, 'telegraph');
  g.add(rune);
  g.userData._rune = rune;

  const pl = new THREE.PointLight(SHARD_COLOR, 2.2, 16, 1.8);
  pl.position.set(0, 1.8, 0);
  g.add(pl);

  _scene.add(g);
  const shard = { group: g, beamMat, x, z, collected: false, spin: Math.random() * 6.28, earned: !!earned };
  if (earned) {
    // Spawn pop so a mini-boss drop reads as a reward, not just another pickup.
    import('./fx.js').then(({ spawnKillRing, spawnMagnetSpark }) => {
      try {
        spawnKillRing(x, z, true);
        for (let i = 0; i < 12; i++) spawnMagnetSpark(x, 1.4, z, SHARD_COLOR);
      } catch (_) {}
    }).catch(() => {});
    state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.6);
    if (state.fx.shake < 0.35) state.fx.shake = 0.35;
  }
  return shard;
}

function _isSpecialObjectiveMode() {
  return !!(state.modes && (state.modes.bossRush || state.modes.daily || state.modes.weekly));
}

function _placeRadialFieldShards(count) {
  const placed = [];
  const stageId = state.run && state.run.stage && state.run.stage.id;
  let guard = 0;
  while (placed.length < count && guard++ < 400) {
    const ang = Math.random() * Math.PI * 2;
    const r = RING_MIN + Math.random() * (RING_MAX - RING_MIN);
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (sampleStageTerrain(stageId, x, z).active) continue;
    let ok = true;
    for (const p of placed) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < MIN_SEP * MIN_SEP) { ok = false; break; }
    }
    if (ok) placed.push({ x, z });
  }
  for (let i = placed.length; i < count; i++) {
    for (let turn = 0; turn < count * 3; turn++) {
      const ang = ((i + turn * 0.37) / count) * Math.PI * 2;
      const p = { x: Math.cos(ang) * RING_MAX, z: Math.sin(ang) * RING_MAX };
      if (!sampleStageTerrain(stageId, p.x, p.z).active) { placed.push(p); break; }
    }
  }
  return placed;
}

function _safeShardPosition(stageId, x, z) {
  if (stageId === 'forest') {
    x = constrainForestX(x, 1.5);
    z = constrainForestZ(z, 1.5);
  }
  if (!sampleStageTerrain(stageId, x, z).active) return { x, z };
  for (let ring = 1; ring <= 6; ring++) {
    const radius = ring * 2.4;
    for (let step = 0; step < 12; step++) {
      const angle = (step / 12) * Math.PI * 2;
      let sx = x + Math.cos(angle) * radius;
      let sz = z + Math.sin(angle) * radius;
      if (stageId === 'forest') {
        sx = constrainForestX(sx, 1.5);
        sz = constrainForestZ(sz, 1.5);
      }
      if (!sampleStageTerrain(stageId, sx, sz).active) return { x: sx, z: sz };
    }
  }
  return { x, z };
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
export function initPortalShards(scene) {
  _scene = scene;
  _buildHud();
}

export function spawnPortalShards() {
  resetPortalShards();
  if (!_scene) return;
  // Boss Rush, Daily, and Weekly own their own victory conditions. Do not
  // spawn or advertise the five-shard finale in those modes.
  if (_isSpecialObjectiveMode()) return;
  // The final chapter has a separate 3-trial → Sovereign objective. Do not
  // layer the legacy five shards, minimap, or Catacomb portal over it.
  if (state.run && state.run.stage && state.run.stage.id === 'kakiland') return;
  state.run.portalShards = 0;
  state.run._shardDrops = null;      // clear any stale mini-boss drop queue
  _collected = 0;
  const isForest = !!(state.run && state.run.stage && state.run.stage.id === 'forest');
  if (isForest) {
    // Forest uses its six authored portal rooms as the objective. No field
    // crystals, earned-shard drops, or random portal compete with that route.
    const trial = state.run.forestPortalTrials;
    _forestTrialMode = true;
    _armed = true;
    _collected = trial ? trial.cleared || 0 : 0;
    _earnedRemaining = 0;
    state.run.portalShards = Math.min(SHARD_COUNT, _collected);
    _invalidateMinimap();
    _updateHud();
    try { showBanner('ENTER THE 6 GROVE PORTALS — CLEAR EVERY TRIAL', 3.0, '#ffd86b'); } catch (_) {}
    return;
  }
  // Cinder (Level 3) is the chapter gate: one field shard is routed to the
  // "dungeon" source (catacomb boss-clear credits it via _shardDrops), so 2
  // scatter in the field + 3 are earned (1 dungeon + 2 elite kills). Other
  // stages keep the default 3 field / 2 earned split.
  const _isCinder = !!(state.run && state.run.stage && state.run.stage.id === 'cinder');
  const _fieldCount = _isCinder ? 2 : FIELD_SHARDS;
  _earnedRemaining = SHARD_COUNT - _fieldCount;
  _armed = true;

  const placed = _placeRadialFieldShards(_fieldCount);
  for (const p of placed) _shards.push(_makeShard(p.x, p.z));

  _invalidateMinimap();
  _updateHud();
  try { showBanner('FIND THE 5 PORTAL SHARDS', 3.2, '#c87bff'); } catch (_) {}
}

export function resetPortalShards() {
  for (const s of _shards) {
    s.group.traverse((o) => {
      if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
    });
    if (s.group.parent) s.group.parent.remove(s.group);
  }
  _shards.length = 0;
  _disposePortal();
  _collected = 0;
  _earnedRemaining = 0;
  _armed = false;
  _forestTrialMode = false;
  state.run.portalShards = 0;
  if (state.run) state.run._shardDrops = null;
  if (_hud) _hud.style.display = 'none';
  _setMinimapVisible(false);
  _minimapNextDraw = 0;
  _minimapDrawCount = 0;
  _minimapAriaLabel = '';
  if (_minimapCtx && _minimap) {
    _minimapCtx.save();
    _minimapCtx.setTransform(1, 0, 0, 1, 0, 0);
    _minimapCtx.clearRect(0, 0, _minimap.width, _minimap.height);
    _minimapCtx.restore();
  }
  if (_minimap) {
    _minimap.dataset.shardMarkers = '0';
    _minimap.dataset.trialsCleared = '0';
    _minimap.dataset.bossPortal = 'hidden';
    _minimap.dataset.drawCount = '0';
    _minimap.setAttribute('aria-label', 'Portal Shard minimap');
  }
  _invalidateMinimap();
}

// ── collection ────────────────────────────────────────────────────────────────
function _collectShard(s) {
  if (s.collected) return;   // idempotent — never double-count a shard
  s.collected = true;
  _collected++;
  state.run.portalShards = _collected;
  // Burst FX at the shard.
  import('./fx.js').then(({ spawnKillRing, spawnMagnetSpark }) => {
    try {
      spawnKillRing(s.x, s.z, false);
      for (let i = 0; i < 10; i++) spawnMagnetSpark(s.x, 1.2, s.z, SHARD_COLOR);
    } catch (_) {}
  }).catch(() => {});
  state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.5);
  if (state.fx.shake < 0.25) state.fx.shake = 0.25;
  // Audio: bright collect chime so a shard pickup reads as a reward, not silence.
  try { if (sfx && sfx.shardCollect) sfx.shardCollect(); } catch (_) {}
  // Fade the shard out (mesh removed next frame via disposal below).
  s.group.traverse((o) => {
    if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
  });
  if (s.group.parent) s.group.parent.remove(s.group);

  _invalidateMinimap();
  _updateHud();
  if (_collected >= SHARD_COUNT) {
    _playPortalCutscene();
  } else {
    try { showBanner(`PORTAL SHARD  ${_collected} / ${SHARD_COUNT}`, 2.0, '#c87bff'); } catch (_) {}
    // Field shards exhausted but earned ones still owed → point the player at
    // the elites that carry the rest.
    let liveUncollected = 0;
    for (let i = 0; i < _shards.length; i++) { if (!_shards[i].collected) { liveUncollected = 1; break; } }
    if (liveUncollected === 0 && _earnedRemaining > 0) {
      try { showBanner('ELITES GUARD THE LAST SHARDS — HUNT THEM', 3.0, '#ff9a5a'); } catch (_) {}
    }
  }
}

// The gate reforged — a short cinematic beat, then the portal blooms. The
// cutscene IS the "awaken" beat, so _openPortal uses a short arm delay after.
function _playPortalCutscene() {
  if (_hud) _hud.style.display = 'none';
  _setMinimapVisible(false);
  // Start the dungeon-kit fetch under the cutscene so stepping through the
  // portal normally lands in a fully dressed catacomb with authored doors.
  try { preloadDungeonKit().catch(() => {}); } catch (_) {}
  playCutscene({
    image: 'assets/screens/portalkey.webp',
    title: 'THE PORTAL AWAKENS',
    accent: '#d8a0ff',
    lines: [
      'Five shards, made whole. The shattered gate blazes open once more.',
      'Beyond it waits the trial — a storm of light and fury.',
      'Step through, little knight.',
    ],
    onDone: () => { _openPortal(0.4); },
  });
}

// ── portal (5/5) ──────────────────────────────────────────────────────────────
function _findPortalPlacement(stageId, heroX, heroZ, facingX, facingZ) {
  const base = Math.atan2(facingZ, facingX);
  const offsets = [0, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, Math.PI];
  const forestPadding = PORTAL_ENTER_R + 0.6;

  // Keep the portal visibly separate from the hero while trying nearby angles
  // before shorter radii. At the Forest tree line this naturally turns the
  // portal inward instead of placing an unreachable gate past the boundary.
  for (const radius of [6, 7.5, 4.8]) {
    for (const offset of offsets) {
      const angle = base + offset;
      const x = heroX + Math.cos(angle) * radius;
      const z = heroZ + Math.sin(angle) * radius;
      if (stageId === 'forest' && !isForestPositionPlayable(x, z, forestPadding)) continue;
      if (!sampleStageTerrain(stageId, x, z).active) return { x, z };
    }
  }

  // Extremely crowded terrain should still never strand the objective. The
  // fallback is reachable and inside the visible Forest perimeter; normal
  // arenas retain the original forward placement.
  let x = heroX + facingX * 6;
  let z = heroZ + facingZ * 6;
  if (stageId === 'forest') {
    x = constrainForestX(x, forestPadding);
    z = constrainForestZ(z, forestPadding);
  }
  return _safeShardPosition(stageId, x, z);
}

// Pure placement probe used by browser regression coverage.
export function _debugPortalPlacement(stageId, heroX, heroZ, facingX, facingZ) {
  const length = Math.hypot(facingX, facingZ) || 1;
  return _findPortalPlacement(stageId, heroX, heroZ, facingX / length, facingZ / length);
}

function _openPortal(armDelay = 1.4) {
  // Spawn a few units in FRONT of the hero (facing dir) so they see it bloom
  // instead of being spawned on top of it and yanked straight in.
  const f = state.hero.facing;
  let fx = (f && f.x) || 0, fz = (f && f.z) || 1;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const stageId = state.run && state.run.stage && state.run.stage.id;
  const placement = _findPortalPlacement(stageId, state.hero.pos.x, state.hero.pos.z, fx, fz);
  const hx = placement.x;
  const hz = placement.z;
  _portalArmedAt = state.time.real + armDelay;   // a beat before it accepts entry
  const g = new THREE.Group();
  g.position.set(hx, 0, hz);

  // Portal ring — vertical glowing disc + rune floor + pillar of light + light.
  const ringMat = new THREE.MeshBasicMaterial({
    map: fxTex('portal_catacomb_inner') || tex('glowWhite'),
    color: 0xd8a0ff, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 5.4), ringMat);
  disc.position.y = 2.7;
  disc.layers.enable(BLOOM_LAYER);
  g.add(disc);
  g.userData._disc = disc;

  const rune = new THREE.Mesh(
    floorDecalGeometry(5.0),
    floorDecalMaterial({ map: fxTex('portal_catacomb_outer') || tex('glowWhite'), color: 0xc87bff, opacity: 0.85 }),
  );
  rune.position.y = 0.05;
  applyFloorTier(rune, 'portal');
  g.add(rune);
  g.userData._rune = rune;

  for (const rot of [0, Math.PI / 2]) {
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 12), new THREE.MeshBasicMaterial({
      map: tex('glowWhite'), color: 0xd8a0ff, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    beam.position.y = 6; beam.rotation.y = rot; beam.layers.enable(BLOOM_LAYER);
    g.add(beam);
  }
  const pl = new THREE.PointLight(0xc87bff, 3.5, 24, 1.6);
  pl.position.set(0, 2.6, 0);
  g.add(pl);

  _scene.add(g);
  _portal = { group: g, x: hx, z: hz };

  if (!_portalPrompt) {
    _portalPrompt = document.createElement('div');
    _portalPrompt.id = 'kk-portal-prompt';
    _portalPrompt.style.cssText = `
      position: fixed; bottom: 16%; left: 50%; transform: translateX(-50%);
      max-width: 92vw; box-sizing: border-box; white-space: nowrap;
      padding: 10px 22px; pointer-events: none; z-index: 90;
      background: linear-gradient(145deg, rgba(48,30,52,.96), rgba(20,14,28,.97));
      border: 1px solid rgba(216,160,255,.58); border-left: 3px solid #d89cff; border-radius: 13px;
      color: var(--kk-hud-cream,#fff0dc); font: 800 12px 'Geist', sans-serif; letter-spacing: .16em;
      box-shadow: 0 16px 36px rgba(11,6,16,.52), 0 0 24px rgba(200,123,255,.18), inset 0 1px 0 rgba(255,255,255,.08);
      backdrop-filter:blur(14px) saturate(125%); -webkit-backdrop-filter:blur(14px) saturate(125%);
      text-shadow: 0 2px 8px rgba(0,0,0,.7); display: none; text-transform:uppercase;
    `;
    document.body.appendChild(_portalPrompt);
  }
  if (_hud) _hud.style.display = 'none';
  _setMinimapVisible(false);
  try { showBanner('THE PORTAL AWAKENS', 3.5, '#d8a0ff'); } catch (_) {}
  state.fx.bloomBoost = 1.0;
  state.fx.shake = 0.7;
}

function _disposePortal() {
  if (_portal) {
    _portal.group.traverse((o) => {
      if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }
    });
    if (_portal.group.parent) _portal.group.parent.remove(_portal.group);
    _portal = null;
  }
  if (_portalPrompt) _portalPrompt.style.display = 'none';
}

// ── tick ──────────────────────────────────────────────────────────────────────
export function tickPortalShards(dt) {
  syncPortalShardHudVisibility();
  if (_forestTrialMode) {
    if (!_armed || state.mode !== 'run') return;
    const trial = state.run && state.run.forestPortalTrials;
    const next = trial ? trial.cleared || 0 : 0;
    if (next !== _collected) {
      _collected = next;
      state.run.portalShards = Math.min(SHARD_COUNT, next);
      _invalidateMinimap();
      _updateHud();
    }
    const now = state.time.real;
    if (_isMinimapVisible() && (_minimapDirty || now >= _minimapNextDraw)) {
      _drawMinimap();
      _minimapNextDraw = now + MINIMAP_REDRAW_SEC;
    }
    return;
  }
  // The always-visible stairs and the shard portal lead to the same dungeon.
  // If the player cleared it via the stairs first, retire the now-completed
  // shard objective instead of leaving an unusable 5/5 portal behind.
  const activeStageId = state.run && state.run.stage && state.run.stage.id;
  if (_armed && state.run && state.run.catacombCleared && activeStageId !== 'cinder') {
    const collected = state.run.portalShards || 0;
    resetPortalShards();
    state.run.portalShards = collected;
    try { showBanner('PORTAL TRIAL COMPLETE — DUNGEON CONQUERED', 3.0, '#ffd36b'); } catch (_) {}
    return;
  }
  if (!_armed || state.mode !== 'run') {
    return;
  }
  const now = state.time.real;
  const hx = state.hero.pos.x, hz = state.hero.pos.z;

  // Shards — spin the crystal, pulse the beam, check pickup.
  for (let i = 0; i < _shards.length; i++) {
    const s = _shards[i];
    if (s.collected) continue;
    const gem = s.group.userData._gem;
    if (gem) { gem.rotation.y += dt * 1.4; gem.position.y = 1.5 + Math.sin(now * 2 + s.spin) * 0.18; }
    if (s.beamMat) s.beamMat.opacity = 0.4 + 0.18 * Math.sin(now * 3 + s.spin);
    const rune = s.group.userData._rune;
    if (rune) rune.material.opacity = 0.55 + 0.2 * Math.sin(now * 3 + s.spin);
    const dx = hx - s.x, dz = hz - s.z;
    if (dx * dx + dz * dz <= COLLECT_R * COLLECT_R) _collectShard(s);
  }

  // ── Earned shards — mini-boss deaths queue a drop from enemies.killEnemy
  // (a plain state push, so the hot death path stays import-free). Drain here
  // and honor only while we still owe earned shards; extras are discarded.
  const q = state.run._shardDrops;
  if (q && q.length) {
    for (let i = 0; i < q.length && _earnedRemaining > 0; i++) {
      const d = q[i];
      const stageId = state.run && state.run.stage && state.run.stage.id;
      const safe = _safeShardPosition(stageId, d.x, d.z);
      _shards.push(_makeShard(safe.x, safe.z, true));
      _earnedRemaining--;
      _invalidateMinimap();
      try { showBanner('A PORTAL SHARD BREAKS FREE', 2.4, '#c87bff'); } catch (_) {}
    }
    q.length = 0;
  }
  // Anti-softlock fallback: if the player has collected every shard in play but
  // the objective still owes earned shards (mini-bosses were slow/scarce on a
  // compressed stage), surface the remainder near the hero so the portal is
  // always reachable — never a dead-end.
  if (_armed && !_portal && _earnedRemaining > 0) {
    let liveUncollected = false;
    for (let i = 0; i < _shards.length; i++) { if (!_shards[i].collected) { liveUncollected = true; break; } }
    if (!liveUncollected) {
      for (let i = 0; i < _earnedRemaining; i++) {
        const stageId = state.run && state.run.stage && state.run.stage.id;
        let safe = null;
        for (let attempt = 0; attempt < 18; attempt++) {
          const ang = Math.random() * Math.PI * 2;
          const r = 14 + Math.random() * 8;
          const candidate = _safeShardPosition(stageId, hx + Math.cos(ang) * r, hz + Math.sin(ang) * r);
          if (!sampleStageTerrain(stageId, candidate.x, candidate.z).active) { safe = candidate; break; }
        }
        safe = safe || _safeShardPosition(stageId, hx, hz);
        _shards.push(_makeShard(safe.x, safe.z, true));
      }
      _earnedRemaining = 0;
      _invalidateMinimap();
      try { showBanner('THE LAST SHARDS SURFACE', 2.6, '#c87bff'); } catch (_) {}
    }
  }

  // Portal — spin the rune, face the disc to camera-ish, handle entry.
  if (_portal) {
    const disc = _portal.group.userData._disc;
    if (disc) disc.material.opacity = 0.8 + 0.2 * Math.sin(now * 4);
    const prune = _portal.group.userData._rune;
    if (prune) prune.rotation.y += dt * 0.6;
    const dx = hx - _portal.x, dz = hz - _portal.z;
    const near = (dx * dx + dz * dz) <= (PORTAL_ENTER_R + 1.6) * (PORTAL_ENTER_R + 1.6);
    if (_portalPrompt) {
      if (near) {
        _portalPrompt.textContent = 'ENTER THE PORTAL';
        _portalPrompt.style.display = 'block';
      } else if (_portalPrompt.style.display !== 'none') {
        _portalPrompt.style.display = 'none';
      }
    }
    // Enter on walk-into-center OR interact press — but only after the arm beat
    // so the "AWAKENS" bloom lands before the mode swap.
    if (now >= _portalArmedAt) {
      const inside = (dx * dx + dz * dz) <= PORTAL_ENTER_R * PORTAL_ENTER_R;
      const pressed = state.input && state.input.interactPressed;
      if (inside || (near && pressed)) {
        _enterPortal();
      }
    }
  }

  if (_isMinimapVisible()) {
    if (_minimapDirty || now >= _minimapNextDraw) {
      _drawMinimap();
      _minimapNextDraw = now + MINIMAP_REDRAW_SEC;
    }
  } else {
    syncPortalShardHudVisibility();
  }
}

async function _enterPortal() {
  if (_portalEntering) return;
  _portalEntering = true;
  const returnPos = state.hero && state.hero.pos
    ? { x: state.hero.pos.x, y: 0, z: state.hero.pos.z }
    : null;
  // The reforged shard portal is the dungeon entrance. Use the same public
  // entry function as the overworld stairs so mode, collision, enemy cleanup,
  // return position, and dress-later asset loading remain one code path.
  try {
    const isCinderFinale = !!(state.run && state.run.catacombCleared
      && state.run.stage && state.run.stage.id === 'cinder');
    if (isCinderFinale) {
      // Cinder's dungeon contributes one of the five shards. Once all five are
      // assembled, the awakened portal must advance the chapter instead of
      // trying to reopen the already-cleared Catacomb (which its one-run guard
      // correctly rejects). Restore the bounded Bullet Hell gate that unlocks
      // Void, carrying the survivor build into that finale.
      const heroLvl = (state.hero && state.hero.level) || 1;
      let weaponLevels = 0;
      let passiveLevels = 0;
      if (Array.isArray(state.weapons)) for (const w of state.weapons) weaponLevels += w.level || 0;
      if (Array.isArray(state.passives)) for (const p of state.passives) passiveLevels += p.level || 0;
      const powerScore = Math.max(0, (heroLvl - 1) + weaponLevels + passiveLevels);
      state.run._finaleCarry = { powerScore };
      // Always keep the chapter portal bounded, including replays after Void
      // is already unlocked. The campaign grant itself is idempotent; omitting
      // this object would silently turn a replay into endless Bullet Hell.
      state.run._bhCampaign = { maxWave: 5, unlockFlag: 'unlockedVoid', label: 'Woolen Drift' };
      if (typeof window === 'undefined' || typeof window.kkStartBulletHell !== 'function') {
        throw new Error('Cinder finale entry is unavailable');
      }
      await window.kkStartBulletHell();
      if (state.mode !== 'bullethell') throw new Error('Cinder finale did not initialize');
      _disposePortal();
      _armed = false;
      if (_hud) _hud.style.display = 'none';
      _setMinimapVisible(false);
      return;
    }
    const entered = await enterCatacomb(returnPos);
    if (!entered || state.mode !== 'catacomb') throw new Error('catacomb entry was not initialized');
    _disposePortal();
    _armed = false;
    if (_hud) _hud.style.display = 'none';
    _setMinimapVisible(false);
  } catch (err) {
    console.warn('[portalShards] enterCatacomb failed:', err);
    try { showBanner('THE PORTAL FALTERS — STEP IN AGAIN', 3.2, '#ff9a5a'); } catch (_) {}
  } finally {
    _portalEntering = false;
  }
}

// Focused browser-test hook. The live array is intentionally not exposed;
// callers get only stable DOM/count data and a defensive location snapshot.
export function _debugPortalShardMap() {
  const trial = state.run && state.run.forestPortalTrials;
  return {
    canvas: _minimap,
    drawCount: _minimapDrawCount,
    locations: _shards.filter((s) => !s.collected).map((s) => ({ x: s.x, z: s.z, earned: s.earned })),
    bounds: { ..._currentMapBounds() },
    profile: state.run && state.run.stage && state.run.stage.id === 'forest' ? 'forest-rooms' : 'open-arena',
    portal: _portal ? { x: _portal.x, z: _portal.z } : null,
    trials: trial ? {
      cleared: trial.cleared || 0,
      total: trial.total || 0,
      activeRoom: trial.activeRoom || null,
      bossUnlocked: !!trial.bossUnlocked,
    } : null,
    bossGate: trial ? { x: FOREST_BOSS_GATE_POS.x, z: FOREST_BOSS_GATE_POS.z, ready: !!trial.bossUnlocked } : null,
  };
}
