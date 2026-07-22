/**
 * Cave sealed vault (P4A cohort 15, 2026-05-21).
 *
 * The cave's "sealed door" structural beat — reinterpreted for a survivors
 * arena. Forest's sealed doors gate a bespoke puzzle/room exploration flow
 * (forestSealedDoors.js + roomState machine); the cave is an open arena, so a
 * walled puzzle-room is a poor fit AND a large run-flow port. Instead: a
 * rune-sealed STONE VAULT at the arena edge that the wardens keep shut. Clear
 * enough of the horde (kills >= OPEN_KILLS) and the seal fails — the slab grinds
 * down into the floor and the vault yields a reward (chest + hearts). A goal +
 * payoff with zero puzzle machinery, zero run-flow coupling.
 *
 * Visual quality bar (feedback_kitty_kaki_fx_quality):
 *   - The seal is the canonical makeRuneRingTexture() art on a textured upright
 *     plane (additive, bloom-tagged), tinted slot-4 sigil — NOT a flat
 *     RingGeometry+MeshBasicMaterial. It fades as the vault opens.
 *   - The slab is real cave_stone diffuse+normal (mirrors caveStalagmites'
 *     loadPngTex), color-locked to slot-2 stone — a textured pro-asset, not a
 *     flat placeholder box.
 *   - A large, structured door reads unambiguously as architecture (same
 *     reasoning as the cohort-9 stalagmites / cohort-11 sigil floor), so a
 *     vertical silhouette in the play area carries no pickup-confusion risk.
 *
 * Architecture (mirrors the other cave cohorts):
 *   buildCaveVault(parent)  — builds the vault under a named group; returns
 *                             { group, present }.
 *   tickCaveVault(dt)       — watches the open condition + animates the grind-
 *                             down + spawns the reward once. Self-gated.
 *   disposeCaveVault()      — idempotent teardown of geo + mats + textures.
 *   getCaveVaultState()     — { present, opened, rewardDropped } smoke accessor.
 *
 * Constraints: static imports only; zero per-frame allocation; reward path is
 * try/guarded so a missing chest system never breaks the tick.
 */
import * as THREE from 'three';
import { CAVE_PALETTE } from './cavePalette.js';
import { state } from '../../state.js';
import { BLOOM_LAYER } from '../../rendering/bloomLayers.js';
import { makeRuneRingTexture } from '../../enemyTells.js';
import { spawnChest } from '../../chest.js';
import { spawnHeart } from '../../pickups.js';
import { sfx } from '../../audio.js';

const VAULT_R      = 24;        // u from origin — in the play area, reachable, clear of perimeter decor (r>=30)
const VAULT_ANGLE  = Math.PI * 0.25;  // NE — a fixed authored spot
const DOOR_W       = 3.2;
const DOOR_H       = 4.0;
const DOOR_D       = 0.7;
const SEAL_SIZE    = 2.4;
const OPEN_KILLS   = 80;        // horde cleared enough → the seal fails
const OPEN_DUR     = 1.5;       // s — grind-down animation

let _state = null;   // { group, slab, sealMesh, geos[], mats[], texs[], baseY, x, z }
let _opened = false;
let _openT = 0;
let _rewardDropped = false;

// Load a cave_stone PNG mirroring caveStalagmites/env.js#loadPngTex.
function _loadStoneTex(loader, url, srgb) {
  const t = loader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb && 'colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Build the sealed vault under `parent` (the caveStage group). Returns
 * { group, present }. Idempotent.
 */
export function buildCaveVault(parent) {
  if (_state) disposeCaveVault();
  if (!parent) return { group: null, present: false };

  const group = new THREE.Group();
  group.name = 'caveStage_vaultGroup';

  const x = Math.cos(VAULT_ANGLE) * VAULT_R;
  const z = Math.sin(VAULT_ANGLE) * VAULT_R;
  const baseY = DOOR_H / 2;   // slab bottom sits on the floor at y=0

  // Door faces the arena center so the player sees the seal. The slab's local
  // +Z is the front; yaw so +Z points toward origin (i.e. toward -position).
  const faceYaw = Math.atan2(-x, -z);

  const loader = new THREE.TextureLoader();
  const diffuse = _loadStoneTex(loader, 'assets/textures/cave_stone_diffuse.png', true);
  const normal  = _loadStoneTex(loader, 'assets/textures/cave_stone_normal.png', false);

  const slabGeo = new THREE.BoxGeometry(DOOR_W, DOOR_H, DOOR_D);
  const slabMat = new THREE.MeshStandardMaterial({
    color: CAVE_PALETTE.stone,   // palette-locked; also the fetch-fail fallback hue
    map: diffuse,
    normalMap: normal,
    roughness: 0.9,
    metalness: 0.05,
  });
  const slab = new THREE.Mesh(slabGeo, slabMat);
  slab.position.set(x, baseY, z);
  slab.rotation.y = faceYaw;
  slab.castShadow = false;
  slab.receiveShadow = false;
  slab.name = 'caveStage_vaultDoor';
  group.add(slab);

  // Rune seal — canonical rune art on an upright textured plane, additive +
  // bloom, slot-4 sigil. Offset slightly in front of the door face (+local Z).
  const sealTex = makeRuneRingTexture();
  const sealGeo = new THREE.PlaneGeometry(SEAL_SIZE, SEAL_SIZE);
  const sealMat = new THREE.MeshBasicMaterial({
    map: sealTex,
    color: CAVE_PALETTE.sigil,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const sealMesh = new THREE.Mesh(sealGeo, sealMat);
  // Place in front of the door: front normal is +Z rotated by faceYaw.
  const fnx = Math.sin(faceYaw), fnz = Math.cos(faceYaw);
  sealMesh.position.set(x + fnx * (DOOR_D / 2 + 0.05), baseY + 0.2, z + fnz * (DOOR_D / 2 + 0.05));
  sealMesh.rotation.y = faceYaw;
  sealMesh.layers.enable(BLOOM_LAYER);
  sealMesh.name = 'caveStage_vaultSeal';
  group.add(sealMesh);

  parent.add(group);
  _state = { group, slab, slabGeo, slabMat, sealMesh, sealGeo, sealMat, sealTex, diffuse, normal, baseY, x, z };
  _opened = false;
  _openT = 0;
  _rewardDropped = false;
  return { group, present: true };
}

/**
 * Per-frame: open when the horde is cleared, grind the slab down, drop the
 * reward once. Self-gated: no _state (non-cave run) is a free no-op.
 */
export function tickCaveVault(dt) {
  if (!_state) return;
  if (!Number.isFinite(dt) || dt <= 0) return;

  if (!_opened) {
    const kills = (state.run && state.run.kills) | 0;
    const echoCredits = Math.max(0, (state.run && state.run.caveEchoCredits) | 0);
    if (kills + echoCredits >= OPEN_KILLS && !state.gameOver) {
      _opened = true;
      _openT = 0;
      try { if (sfx && sfx.bossSpawn) sfx.bossSpawn(); } catch (_) {}   // a low stone groan cue
      try { if (state.fx) state.fx.shake = Math.max(state.fx.shake || 0, 0.35); } catch (_) {}
    }
    return;
  }

  if (_openT < OPEN_DUR) {
    _openT += dt;
    const p = Math.min(1, _openT / OPEN_DUR);
    // Seal fades out over the first 60% of the open.
    _state.sealMat.opacity = 0.95 * Math.max(0, 1 - p / 0.6);
    // Slab grinds straight down into the floor (ease-out).
    const sink = (1 - (1 - p) * (1 - p)) * DOOR_H;
    _state.slab.position.y = _state.baseY - sink;

    if (p >= 1 && !_rewardDropped) {
      _rewardDropped = true;
      _state.sealMesh.visible = false;
      // Reward bundle at the vault mouth.
      try { spawnChest(_state.x, _state.z); } catch (_) {}
      try { spawnHeart(_state.x - 1.0, _state.z); } catch (_) {}
      try { spawnHeart(_state.x + 1.0, _state.z); } catch (_) {}
      try { if (state.fx) state.fx.bloomBoost = Math.max(state.fx.bloomBoost || 0, 0.6); } catch (_) {}
    }
  }
}

/** Smoke accessor: vault presence + open/reward state. */
export function getCaveVaultState() {
  return { present: !!_state, opened: _opened, rewardDropped: _rewardDropped };
}

/** Idempotent teardown of geometry + materials + textures. */
export function disposeCaveVault() {
  if (!_state) return false;
  const { group, slabGeo, slabMat, sealGeo, sealMat, sealTex, diffuse, normal } = _state;
  if (group && group.parent) group.parent.remove(group);
  try { slabGeo && slabGeo.dispose(); } catch (_) {}
  try { slabMat && slabMat.dispose(); } catch (_) {}
  try { sealGeo && sealGeo.dispose(); } catch (_) {}
  try { sealMat && sealMat.dispose(); } catch (_) {}
  try { sealTex && sealTex.dispose(); } catch (_) {}
  try { diffuse && diffuse.dispose(); } catch (_) {}
  try { normal && normal.dispose(); } catch (_) {}
  _state = null;
  _opened = false;
  _openT = 0;
  _rewardDropped = false;
  return true;
}
