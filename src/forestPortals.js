/**
 * Forest Hub Portals + Pollen Breadcrumbs — Cohort 3 Agent 5 (FE-C3B).
 *
 * Contract: docs/FOREST_EXPANSION_PLAN.md §4 (Cohort 3 Agent 5) + §8.
 * Pattern reference: src/voidTeleportPads.js (entity state machine, cooldown,
 *                     iframe-on-arrival, BLOOM_LAYER rim arcs).
 * Visual style: docs/FOREST_VISUAL_STYLE.md (8-color palette, locked).
 *
 * Public API:
 *   loadForestPortals(scene)     — spawn 12 portal entities + 6 breadcrumb
 *                                  trails, return total portal count.
 *   tickForestPortals(dt, state) — per-frame: idle pulse, breadcrumb bob,
 *                                  proximity check, E-key activation,
 *                                  teleport resolution, cooldown timer,
 *                                  flash FX lifecycle.
 *   disposeForestPortals(scene)  — tear down everything (also exported as
 *                                  clearForestPortals for naming parity with
 *                                  loadForestAmber/clearForestAmber).
 *
 * === ACTIVATION MODEL (differs from voidTeleportPads!) ===
 * Void pads auto-trigger on continuous proximity. Forest portals require BOTH:
 *   (1) hero within PROXIMITY_R (2.2u) of the portal
 *   (2) `state.input?.interactPressed` true on this tick (edge-triggered E /
 *       A-button — Cohort 3A wires this in src/hero.js)
 * Defensive optional-chain on input so a missing field can't crash this
 * module while FE-C3A is in flight.
 *
 * === PORTAL TOPOLOGY (data-driven from FOREST_PORTAL_POSITIONS + FOREST_ROOMS) ===
 * Outbound portals are auto-enumerated from FOREST_PORTAL_POSITIONS; return
 * portals are auto-enumerated from FOREST_ROOMS (skipping the hub). NO
 * meta-gate; all portals are usable from run 1.
 *
 * Six outbound definitions come from FOREST_PORTAL_POSITIONS. Each room owns
 * one paired return gate, offset from its boss/puzzle center toward the Glade.
 *
 * Arrivals sit nine units from the room center toward the Glade; return gates
 * sit twelve units out on the same line. That three-unit separation prevents
 * arrival overlap while keeping both clear of centered bosses and puzzles.
 *
 * === POLLEN BREADCRUMBS ===
 * 6 trails (one per outbound portal), each pre-pooled as a single
 * InstancedMesh of BREADCRUMBS_PER_TRAIL small additive-blend mint orbs.
 * Trail goes from world-origin tree center (0,0) to the outbound portal
 * position. Per-instance bob via sin(time + phase). Seed 0xC0FFEE per spec.
 * Return portals do NOT get breadcrumbs (they live inside puzzle rooms, not
 * along the glade's tree-to-edge paths).
 *
 * === MUTATION HOOK ===
 * Mirrors voidTeleportPads: direct mutation of state.hero.pos.{x,z} +
 * state.hero.mesh.position.{x,z} on the same tick as the destination snap,
 * so the mesh never lags a frame behind the logical position. Y untouched
 * (hero stays on the floor plane).
 *
 * === PALETTE (forest, locked — see docs/FOREST_VISUAL_STYLE.md) ===
 *   slot 1 #1a1e22 — stone-trunk base (rim ring detail)
 *   slot 2 #2d3a55 — crystal-trunk mid (disc undertone)
 *   slot 3 #5f8fb5 — crystal facet hi (cooldown ring)
 *   slot 4 #7df0c4 — bio-glow primary mint (breadcrumbs, return-portal accent)
 *   slot 5 #3ecf9a — bio-glow secondary (edge fade)
 *   slot 6 #f5a300 — amber idle (outbound-portal disc baseline)
 *   slot 7 #ffd86b — amber detonation glow (teleport flash, peak emissive)
 *   slot 8 #a8e6ff — chain-lightning cyan (unused here; reserved by style guide)
 */
import * as THREE from 'three';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import {
  FOREST_PORTAL_POSITIONS,
  FOREST_ROOMS,
  FOREST_RETURN_PORTAL_OFFSET,
  FOREST_ROOM_ENTRY_OFFSET,
  getForestTravelAnchors,
} from './forestRooms.js';
import { fxTex } from './fxTextures.js';
import { bindPrompt, setPromptLabel, unbindPrompt } from './buttonPrompts.js';
import { cloneCached } from './assets.js';
import { createForestGateVeilMaterial } from './rendering/materials/telegraphMaterials.js';

// ─── tuning constants (LOCKED) ───────────────────────────────────────────────
export const PROXIMITY_R          = 2.2;
export const PROXIMITY_R2         = PROXIMITY_R * PROXIMITY_R;
export const COOLDOWN_DURATION    = 6.0;   // matches voidTeleportPads
export const IFRAMES_ON_ARRIVAL   = 0.4;   // matches voidTeleportPads
export const LOCAL_STEP_GUARD     = 0.3;   // re-entry guard at destination
export const RETURN_PORTAL_OFFSET = FOREST_RETURN_PORTAL_OFFSET;
export const ROOM_ENTRY_OFFSET    = FOREST_ROOM_ENTRY_OFFSET;

export const IDLE_PULSE_HZ        = 0.7;   // matches forest_amber idle
export const IDLE_EMISSIVE_MIN    = 1.4;
export const IDLE_EMISSIVE_MAX    = 2.0;
export const TELEPORT_FLASH_EMISSIVE = 3.5;

// Activation ring FX (slot 7, bloom ON, additive). Same expand/fade pattern
// as voidTeleportPads flash ring, palette-shifted to amber.
export const FLASH_RING_LIFE       = 0.18;
export const FLASH_RING_INNER_R    = 0.65;
export const FLASH_RING_LINE_WIDTH = 0.08;   // forest spec: 0.06-0.10
export const FLASH_RING_OPACITY    = 1.0;

// Cooldown ring overlay (slot 3 crystal-facet, bloom OFF).
export const COOLDOWN_RING_INNER_R    = 0.95;
export const COOLDOWN_RING_LINE_WIDTH = 0.06;   // forest spec: 0.06-0.10
export const COOLDOWN_RING_OPACITY_MAX = 0.80;

// Rim ring on portal edge (slot 4 mint for return, slot 6 amber for outbound),
// bloom ON, additive — meets "Spider Web FX quality bar" line weight.
export const RIM_RING_LINE_WIDTH   = 0.07;   // forest spec: 0.06-0.10

// Disc Y-bob (cosmetic).
const DISC_BOB_AMP  = 0.025;
const DISC_BOB_HZ   = 0.5;
const DISC_BASE_Y   = 0.08;
const DISC_RADIUS   = 1.18;
const RIM_BASE_Y    = 0.145;

// Hidden legacy crystal record retained for sealed-door compatibility.
const CRYSTAL_BASE_Y    = 1.05;
const CRYSTAL_BOB_AMP   = 0.10;
const CRYSTAL_SPIN_HZ   = 0.35;

// Blender-authored living gate + tiny per-portal shader veil. The old 4.75u
// additive Sprite made partial off-screen rings read as giant cyan squiggles;
// the new silhouette is grounded geometry and the veil stays inside its arch.
export const FOREST_TRIAL_GATE_ASSET_KEY = 'forest_trial_gate';
const GATE_VEIL_WIDTH    = 1.72;
const GATE_VEIL_HEIGHT   = 2.04;
const GATE_VEIL_BASE_Y   = 1.24;
const GATE_STATE_SPEED   = 7.5;

// ─── breadcrumb tuning ───────────────────────────────────────────────────────
export const BREADCRUMBS_PER_TRAIL = 12;          // 8-12 per spec — use the top end
export const BREADCRUMB_SEED       = 0xC0FFEE;     // per spec
export const BREADCRUMB_ORB_R      = 0.10;         // small mint motes
export const BREADCRUMB_BOB_AMP    = 0.12;
export const BREADCRUMB_BOB_HZ     = 0.6;
export const BREADCRUMB_Y_BASE     = 0.55;

// ─── palette color constants (forest, locked) ────────────────────────────────
export const COLOR_STONE_TRUNK     = 0x1a1e22;  // slot 1
export const COLOR_CRYSTAL_MID     = 0x2d3a55;  // slot 2
export const COLOR_CRYSTAL_FACET   = 0x5f8fb5;  // slot 3 (cooldown ring)
export const COLOR_BIOGLOW_PRIMARY = 0x7df0c4;  // slot 4 (breadcrumbs / return rim)
export const COLOR_BIOGLOW_SECOND  = 0x3ecf9a;  // slot 5 (edge fade)
export const COLOR_AMBER_IDLE      = 0xf5a300;  // slot 6 (outbound disc idle)
export const COLOR_AMBER_FLASH     = 0xffd86b;  // slot 7 (teleport flash)
export const COLOR_CHAIN_CYAN      = 0xa8e6ff;  // slot 8 (reserved)

// ─── module state ────────────────────────────────────────────────────────────
const _portals = [];          // entity records (see _spawnPortal)
const _trails  = [];          // { mesh, mat, geo, instanceData[] }
const _flashRings = [];       // in-flight activation FX
const _disposables = [];      // shared geos/mats tracked for dispose
let _group = null;            // parent THREE.Group, single removal target
let _promptEl = null;
let _promptBinding = null;
let _promptPortalId = null;

// Hot-path scratch for breadcrumb matrix rewrites.
const _breadcrumbMatrix = new THREE.Matrix4();
const _breadcrumbQuat = new THREE.Quaternion();
const _breadcrumbPos = new THREE.Vector3();
const _breadcrumbScale = new THREE.Vector3();

// ─── seeded PRNG (mirrors voidTeleportPads / forestAmber) ────────────────────
function _seededRand(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── geometry builders (shared across all portals) ──────────────────────────
function _buildDiscGeometry() {
  return new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.06, 32, 1, false);
}
function _buildRimGeometry() {
  // Slim torus at the disc rim. Line weight 0.07u — within 0.06-0.10 spec.
  const geo = new THREE.TorusGeometry(DISC_RADIUS, RIM_RING_LINE_WIDTH / 2, 8, 48);
  geo.rotateX(Math.PI / 2);
  return geo;
}
function _buildCrystalGeometry() {
  // Floating glyph above portal — small octahedron, flat-shaded.
  return new THREE.OctahedronGeometry(0.25, 0);
}
function _buildBreadcrumbGeometry() {
  // Pollen orb — small icosahedron, additive blended. Cheap geometry.
  return new THREE.IcosahedronGeometry(BREADCRUMB_ORB_R, 0);
}

function _buildGateVeilGeometry() {
  return new THREE.PlaneGeometry(GATE_VEIL_WIDTH, GATE_VEIL_HEIGHT, 1, 1);
}

function _makeGateVeilMaterial(colorHex) {
  return createForestGateVeilMaterial(colorHex);
}

function _makeFallbackLivingGate(sharedGeos) {
  const root = new THREE.Group();
  root.name = 'forestTrialGateFallback';

  const arch = new THREE.Group();
  arch.name = 'forestTrialGateArch';
  const crown = new THREE.Mesh(sharedGeos.gateFallbackArch, sharedGeos.gateFallbackRootMat);
  crown.position.y = 1.33;
  arch.add(crown);
  for (const x of [-1.32, 1.32]) {
    const post = new THREE.Mesh(sharedGeos.gateFallbackPost, sharedGeos.gateFallbackRootMat);
    post.position.set(x, 0.65, 0);
    arch.add(post);
  }
  root.add(arch);

  const shutters = new THREE.Group();
  shutters.name = 'forestTrialGateShutters';
  for (const rz of [-0.72, 0, 0.72]) {
    const branch = new THREE.Mesh(sharedGeos.gateFallbackShutter, sharedGeos.gateFallbackThornMat);
    branch.rotation.z = rz;
    branch.position.y = 1.18;
    shutters.add(branch);
  }
  root.add(shutters);

  const bloom = new THREE.Group();
  bloom.name = 'forestTrialGateBloom';
  for (const [x, y] of [[-1.1, 1.8], [0, 2.62], [1.1, 1.8]]) {
    const flower = new THREE.Mesh(sharedGeos.gateFallbackBloom, sharedGeos.gateFallbackBloomMat);
    flower.position.set(x, y, -0.10);
    bloom.add(flower);
  }
  root.add(bloom);
  return { root, arch, shutters, bloom };
}

function _markGateMeshes(node, { bloom = false, shadow = true } = {}) {
  if (!node) return;
  node.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = shadow && !bloom;
    obj.receiveShadow = shadow && !bloom;
    if (bloom) obj.layers.enable(BLOOM_LAYER);
  });
}

function _buildLivingGate(entGroup, sharedGeos, def, baseColor) {
  const gateGroup = new THREE.Group();
  gateGroup.name = 'forestTrialGate';
  gateGroup.userData.assetKey = FOREST_TRIAL_GATE_ASSET_KEY;
  gateGroup.userData.purpose = 'interactive-room-trial-gate';
  // The arch is intentionally two-sided. Facing it toward the Glade/path still
  // gives the asymmetric root curls a consistent authored orientation.
  gateGroup.rotation.y = Math.atan2(-def.x, -def.z);

  const kit = cloneCached(FOREST_TRIAL_GATE_ASSET_KEY);
  let gateArch;
  let gateShutters;
  let gateBloom;
  if (kit) {
    kit.name = 'forestTrialGateAsset';
    gateArch = kit.getObjectByName('Gate_Arch');
    gateShutters = kit.getObjectByName('Gate_Shutters');
    gateBloom = kit.getObjectByName('Gate_Bloom');
    if (gateArch) gateArch.name = 'forestTrialGateArch';
    if (gateShutters) gateShutters.name = 'forestTrialGateShutters';
    if (gateBloom) gateBloom.name = 'forestTrialGateBloom';
    gateGroup.add(kit);
  }
  // Asset failures cannot make an interactive portal invisible. This fallback
  // is dimensional and stateful, but normal Forest preload always uses the GLB.
  if (!gateArch || !gateShutters || !gateBloom) {
    if (kit) gateGroup.remove(kit);
    const fallback = _makeFallbackLivingGate(sharedGeos);
    gateGroup.add(fallback.root);
    gateArch = fallback.arch;
    gateShutters = fallback.shutters;
    gateBloom = fallback.bloom;
    gateGroup.userData.assetFallback = true;
  }
  _markGateMeshes(gateArch);
  // The merged diagonal lattice can project a disproportionately long opaque
  // shadow at dusk. It is a readable state overlay, not structural scenery.
  _markGateMeshes(gateShutters, { shadow: false });
  _markGateMeshes(gateBloom, { bloom: true });

  const gateVeilMat = _makeGateVeilMaterial(baseColor);
  const gateVeil = new THREE.Mesh(sharedGeos.gateVeil, gateVeilMat);
  gateVeil.name = 'forestTrialGateVeil';
  gateVeil.position.set(0, GATE_VEIL_BASE_Y, 0.025);
  gateVeil.renderOrder = 2;
  // Main pass only. Bloom is reserved for the tiny cleared-state flowers;
  // putting this entire aperture into the bloom composer erased its colour
  // and the authored arch silhouette at normal gameplay scale.
  gateVeil.layers.disable(BLOOM_LAYER);
  gateVeil.userData.purpose = 'walk-through-portal-veil';
  gateGroup.add(gateVeil);
  entGroup.add(gateGroup);

  return { gateGroup, gateArch, gateVeil, gateVeilMat, gateShutters, gateBloom };
}

function _easeGatePose(portal) {
  if (!portal || !portal.gateGroup) return;
  const sealed = portal.gateVisualState === 'SEALED';
  const cleared = portal.gateVisualState === 'CLEARED';
  const sealAmount = Math.max(0, Math.min(1, portal.gateSealAmount || 0));
  const bloomAmount = Math.max(0, Math.min(1, portal.gateBloomAmount || 0));
  const veilAmount = Math.max(0, Math.min(1, portal.gateVeilAmount || 0));
  if (portal.gateShutters) {
    portal.gateShutters.visible = sealed;
    portal.gateShutters.scale.set(Math.max(0.055, sealAmount), 0.92 + sealAmount * 0.08, 1);
  }
  if (portal.gateBloom) {
    portal.gateBloom.visible = cleared;
    const s = 0.52 + bloomAmount * 0.48;
    portal.gateBloom.scale.setScalar(s);
  }
  if (portal.gateVeil) portal.gateVeil.visible = !sealed;
  if (portal.gateVeilMat) {
    const opacity = veilAmount * (0.48 + 0.055 * Math.sin(portal.pulsePhase || 0));
    portal.gateVeilMat.opacity = opacity;
    portal.gateVeilMat.uniforms.uOpacity.value = opacity;
  }
}

/**
 * Public visual-state seam used by the sealed-room coordinator and smoke
 * coverage. Mechanics remain authoritative elsewhere; this only changes the
 * physical arch contents and never teleports/spawns/rewards.
 */
export function setForestPortalGateState(portal, nextState, snap = false) {
  if (!portal || !portal.gateGroup) return false;
  const state = String(nextState || 'AVAILABLE').toUpperCase();
  if (!['AVAILABLE', 'SEALED', 'CLEARED'].includes(state)) return false;
  const first = !portal.gateVisualState;
  portal.gateVisualState = state;
  portal.gateSealTarget = state === 'SEALED' ? 1 : 0;
  portal.gateBloomTarget = state === 'CLEARED' ? 1 : 0;
  portal.gateVeilTarget = state === 'SEALED' ? 0 : 1;
  if (snap || first) {
    portal.gateSealAmount = portal.gateSealTarget;
    portal.gateBloomAmount = portal.gateBloomTarget;
    portal.gateVeilAmount = portal.gateVeilTarget;
  } else {
    // Make the incoming authored layer testable/readable on the transition
    // frame; the rest of the motion eases in tickForestPortals.
    if (state === 'SEALED') portal.gateSealAmount = Math.max(0.055, portal.gateSealAmount || 0);
    if (state === 'CLEARED') portal.gateBloomAmount = Math.max(0.055, portal.gateBloomAmount || 0);
  }
  portal.gateGroup.userData.visualState = state;
  _easeGatePose(portal);
  return true;
}

// Cooldown overlay ring — RingGeometry on XZ plane, slot 3 crystal-facet,
// bloom OFF, additive. Per-portal so opacity ramps independently.
function _spawnCooldownRing(parentGroup) {
  const inner = COOLDOWN_RING_INNER_R;
  const outer = inner + COOLDOWN_RING_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_CRYSTAL_FACET,
    transparent: true,
    opacity: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // NOTE: do NOT enable BLOOM_LAYER. Cooldown is a state, not a celebration.
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.09;
  mesh.visible = false;
  parentGroup.add(mesh);
  return { mesh, mat, geo };
}

// ─── teleport flash ring (slot 7 amber, bloom ON) ───────────────────────────
function _spawnFlashRing(scene, x, z) {
  const inner = FLASH_RING_INNER_R;
  const outer = inner + FLASH_RING_LINE_WIDTH;
  const geo = new THREE.RingGeometry(inner, outer, 48, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_AMBER_FLASH,
    transparent: true,
    opacity: FLASH_RING_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.10, z);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  return {
    group: mesh,
    mats: [mat],
    geos: [geo],
    baseOpacity: FLASH_RING_OPACITY,
    t: 0,
    life: FLASH_RING_LIFE,
  };
}

// ─── per-portal spawn ───────────────────────────────────────────────────────
function _spawnPortal(parentGroup, sharedGeos, def) {
  // def: { id, x, z, dest:{x,z}, kind:'outbound'|'return', seed }
  const rng = _seededRand(def.seed);
  const entGroup = new THREE.Group();
  entGroup.position.set(def.x, 0, def.z);
  entGroup.visible = def.roomId === 'glade';

  // Tint — outbound portals are amber (warm welcome from glade), return
  // portals are mint (cool come-home glow). Both flash slot-7 on activation.
  const baseColor = (def.kind === 'outbound') ? COLOR_AMBER_IDLE : COLOR_BIOGLOW_PRIMARY;
  const rimColor  = (def.kind === 'outbound') ? COLOR_AMBER_IDLE : COLOR_BIOGLOW_PRIMARY;
  const peakColor = COLOR_AMBER_FLASH;

  // Per-entity disc material — emissive lerps for idle pulse, spikes to
  // slot-7 flash on activation.
  const discMat = new THREE.MeshStandardMaterial({
    map: fxTex('ring_arcane'),
    emissiveMap: fxTex('ring_arcane'),
    color: COLOR_CRYSTAL_MID,           // slot 2 undertone keeps disc readable
    emissive: baseColor,
    emissiveIntensity: IDLE_EMISSIVE_MIN,
    transparent: true,
    opacity: 0.95,
    roughness: 0.30,
    metalness: 0.20,
    flatShading: true,
  });
  const discMesh = new THREE.Mesh(sharedGeos.disc, discMat);
  discMesh.position.y = DISC_BASE_Y;
  // The authored upright gateway is the portal's bloom/readability anchor.
  // Keeping the floor disc in the main pass avoids paying a second draw for
  // every Glade portal and prevents the ground mark from washing out.
  entGroup.add(discMesh);

  // Rim ring — slim torus, additive emissive on BLOOM_LAYER. This is the
  // "Spider Web FX bar" arc visual. Line weight 0.07u (within 0.06-0.10).
  const rimMat = new THREE.MeshBasicMaterial({
    color: rimColor,
    transparent: true,
    opacity: 0.90,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const rimMesh = new THREE.Mesh(sharedGeos.rim, rimMat);
  rimMesh.position.y = RIM_BASE_Y;
  // Main pass only; the authored arch and restrained normal-blend veil carry
  // portal readability without duplicating six floor rings into bloom.
  entGroup.add(rimMesh);

  // Floating glyph crystal above portal (octahedron, slot 3 facet color,
  // slight bloom). Per-instance spin/bob in tick.
  const crystalMat = new THREE.MeshStandardMaterial({
    color: COLOR_CRYSTAL_FACET,
    emissive: baseColor,
    emissiveIntensity: 1.2,
    roughness: 0.35,
    metalness: 0.30,
    flatShading: true,
  });
  const crystalMesh = new THREE.Mesh(sharedGeos.crystal, crystalMat);
  crystalMesh.position.y = CRYSTAL_BASE_Y;
  // The authored living gate is the portal identity. Keep the legacy
  // crystal record for seal-code compatibility, but do not render another
  // low-poly diamond above it.
  crystalMesh.visible = false;

  // Grounded Blender-authored arch. Its thorn shutters and moonbloom accents
  // are physical state layers; the small shader veil replaces the oversized
  // billboard while retaining per-portal color/pulse control.
  const livingGate = _buildLivingGate(entGroup, sharedGeos, def, baseColor);
  const beaconMesh = livingGate.gateVeil; // compatibility alias: now a Mesh, never a Sprite
  const beaconMat = livingGate.gateVeilMat;

  // Cooldown overlay.
  const cooldownRing = _spawnCooldownRing(entGroup);

  parentGroup.add(entGroup);

  const record = {
    id: def.id,
    x: def.x,
    z: def.z,
    dest: { x: def.dest.x, z: def.dest.z },
    kind: def.kind,
    // FOREST-V2-A14 — room identity for sealed-door cohort (forestSealedDoors.js).
    // `roomId`     = the room this portal SITS IN (outbound: 'glade'; return: room id)
    // `destRoomId` = the room this portal TRANSPORTS TO (outbound: p.to; return: 'glade')
    roomId: def.roomId || null,
    destRoomId: def.destRoomId || null,
    seed: def.seed,
    baseColorHex: baseColor,
    peakColorHex: peakColor,
    cooldownUntil: 0,
    localStepGuard: 0,
    pulsePhase: rng() * Math.PI * 2,
    bobPhase:   rng() * Math.PI * 2,
    crystalPhase: rng() * Math.PI * 2,
    cooldownActive: false,
    entGroup,
    discMesh,
    discMat,
    rimMesh,
    rimMat,
    crystalMesh,
    crystalMat,
    authoredGateAssetKey: FOREST_TRIAL_GATE_ASSET_KEY,
    gateGroup: livingGate.gateGroup,
    gateArch: livingGate.gateArch,
    gateVeil: livingGate.gateVeil,
    gateVeilMat: livingGate.gateVeilMat,
    gateShutters: livingGate.gateShutters,
    gateBloom: livingGate.gateBloom,
    gateVisualState: null,
    gateSealAmount: 0,
    gateSealTarget: 0,
    gateBloomAmount: 0,
    gateBloomTarget: 0,
    gateVeilAmount: 1,
    gateVeilTarget: 1,
    beaconMesh,
    beaconMat,
    cooldownRing,
    rng,
  };
  setForestPortalGateState(record, 'AVAILABLE', true);
  return record;
}

// ─── breadcrumb trail (InstancedMesh, pre-pooled, additive, bloom) ──────────
function _spawnBreadcrumbTrail(parentGroup, sharedGeo, fromX, fromZ, toX, toZ, seed) {
  const rng = _seededRand(seed);

  const mat = new THREE.MeshBasicMaterial({
    color: COLOR_BIOGLOW_PRIMARY,      // slot 4 mint
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.InstancedMesh(sharedGeo, mat, BREADCRUMBS_PER_TRAIL);
  mesh.layers.enable(BLOOM_LAYER);
  // Instance color array would let per-orb tint vary; we keep one color so
  // palette stays locked. Per-instance scale + bob phase carry the variation.

  const instanceData = new Array(BREADCRUMBS_PER_TRAIL);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();

  const dx = toX - fromX;
  const dz = toZ - fromZ;

  for (let i = 0; i < BREADCRUMBS_PER_TRAIL; i++) {
    // Evenly distribute along the line with a small lateral jitter so the
    // trail looks scattered rather than dotted-line. Skip the absolute
    // endpoints (i+1)/(N+1).
    const tParam = (i + 1) / (BREADCRUMBS_PER_TRAIL + 1);
    // Lateral jitter perpendicular to the line, ±0.5u.
    const lat = (rng() - 0.5) * 1.0;
    // Tangent direction (normalized) + perpendicular.
    const len = Math.max(1e-3, Math.hypot(dx, dz));
    const tx = dx / len, tz = dz / len;
    const px = -tz, pz = tx;             // perpendicular (XZ-plane)
    const baseX = fromX + dx * tParam + px * lat;
    const baseZ = fromZ + dz * tParam + pz * lat;
    const bobPhase = rng() * Math.PI * 2;
    const scl = 0.7 + rng() * 0.6;       // 0.7-1.3 visual variation

    instanceData[i] = {
      baseX,
      baseZ,
      bobPhase,
      scl,
    };

    scaleVec.set(scl, scl, scl);
    m.compose(
      new THREE.Vector3(baseX, BREADCRUMB_Y_BASE, baseZ),
      q,
      scaleVec
    );
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  parentGroup.add(mesh);

  return { mesh, mat, geo: sharedGeo, instanceData, roomId: 'glade' };
}

function _ensurePrompt() {
  if (_promptEl || typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.id = 'kk-forest-portal-prompt';
  el.style.cssText = `
    position:fixed; left:50%; bottom:18%; transform:translateX(-50%);
    display:none; z-index:72; padding:8px 18px; white-space:nowrap;
    color:#fff4cc; font:700 15px 'Cinzel',serif; letter-spacing:.08em;
    background:linear-gradient(180deg,rgba(28,22,12,.90),rgba(10,9,6,.92));
    border:1px solid rgba(255,216,107,.58); border-radius:9px;
    box-shadow:0 6px 22px rgba(0,0,0,.55),0 0 18px rgba(245,163,0,.20);
    pointer-events:none;
  `;
  (document.getElementById('ui-root') || document.body).appendChild(el);
  _promptEl = el;
  _promptBinding = bindPrompt(el, 'interact', 'Enter portal');
}

function _hidePrompt() {
  if (_promptEl) _promptEl.style.display = 'none';
  _promptPortalId = null;
}

export function syncForestPortalUiVisibility(state) {
  const active = !!(state && state.started && state.mode === 'run'
    && !state.gameOver && !state.pendingLevelUp
    && !(state.time && state.time.paused)
    && state.run && state.run.stage && state.run.stage.id === 'forest');
  if (!active) _hidePrompt();
}

// ─── public: load ───────────────────────────────────────────────────────────
export function loadForestPortals(scene) {
  if (!scene) return 0;
  // Idempotent: tear down any prior group before rebuilding.
  disposeForestPortals(scene);

  _group = new THREE.Group();
  _group.name = '__forestPortals';

  // Shared geometries — disposed in disposeForestPortals.
  const discGeo      = _buildDiscGeometry();
  const rimGeo       = _buildRimGeometry();
  const crystalGeo   = _buildCrystalGeometry();
  const breadcrumbGeo = _buildBreadcrumbGeometry();
  const gateVeilGeo = _buildGateVeilGeometry();
  // Shared dimensional fallback only appears after an authored GLB load
  // failure. It is still pooled so twelve failed gates do not allocate twelve
  // geometry/material sets.
  const gateFallbackArch = new THREE.TorusGeometry(1.34, 0.17, 6, 20, Math.PI);
  const gateFallbackPost = new THREE.CylinderGeometry(0.16, 0.22, 1.30, 7);
  const gateFallbackShutter = new THREE.BoxGeometry(2.28, 0.11, 0.10);
  const gateFallbackBloom = new THREE.OctahedronGeometry(0.16, 0);
  const gateFallbackRootMat = new THREE.MeshStandardMaterial({ color: 0x5d3b20, roughness: 0.9 });
  const gateFallbackThornMat = new THREE.MeshStandardMaterial({ color: 0x27120d, roughness: 0.94 });
  const gateFallbackBloomMat = new THREE.MeshStandardMaterial({
    color: COLOR_BIOGLOW_PRIMARY,
    emissive: COLOR_BIOGLOW_SECOND,
    emissiveIntensity: 1.6,
    roughness: 0.7,
  });
  _disposables.push(
    discGeo, rimGeo, crystalGeo, breadcrumbGeo, gateVeilGeo,
    gateFallbackArch, gateFallbackPost, gateFallbackShutter, gateFallbackBloom,
    gateFallbackRootMat, gateFallbackThornMat, gateFallbackBloomMat,
  );

  const sharedGeos = {
    disc: discGeo,
    rim: rimGeo,
    crystal: crystalGeo,
    breadcrumb: breadcrumbGeo,
    gateVeil: gateVeilGeo,
    gateFallbackArch,
    gateFallbackPost,
    gateFallbackShutter,
    gateFallbackBloom,
    gateFallbackRootMat,
    gateFallbackThornMat,
    gateFallbackBloomMat,
  };
  _ensurePrompt();

  // ── Outbound portals (6) — land near the paired return portal, but not on
  //    top of it or the room-center boss/puzzle footprint.
  let seedCounter = 7000;
  const outboundDefs = [];
  for (const key in FOREST_PORTAL_POSITIONS) {
    const p = FOREST_PORTAL_POSITIONS[key];
    const destRoom = FOREST_ROOMS[p.to];
    if (!destRoom) {
      console.warn('[forestPortals] missing destination room for', key, p);
      continue;
    }
    const anchors = getForestTravelAnchors(p.to);
    const entry = anchors ? anchors.entry : { ...destRoom.center };
    outboundDefs.push({
      id: key,
      x: p.x,
      z: p.z,
      dest: entry,
      kind: 'outbound',
      roomId: 'glade',
      destRoomId: p.to,
      seed: seedCounter++,
    });
  }
  for (const def of outboundDefs) {
    _portals.push(_spawnPortal(_group, sharedGeos, def));
  }

  // ── Return portals (6) — offset toward the Glade so room-center encounters
  //    and puzzle fixtures cannot cover the gate.
  //    Naming: 'returnSaphollow' etc. Iteration order matches FOREST_ROOMS,
  //    but skip the hub (glade).
  const gladeCenter = FOREST_ROOMS.glade.center;
  for (const roomId in FOREST_ROOMS) {
    const room = FOREST_ROOMS[roomId];
    if (room.isHub) continue;
    const anchors = getForestTravelAnchors(roomId);
    const anchor = anchors ? anchors.return : { ...room.center };
    _portals.push(_spawnPortal(_group, sharedGeos, {
      id: 'return_' + roomId,
      x: anchor.x,
      z: anchor.z,
      dest: { x: gladeCenter.x, z: gladeCenter.z },
      kind: 'return',
      roomId: roomId,
      destRoomId: 'glade',
      seed: seedCounter++,
    }));
  }

  // ── Pollen breadcrumbs (6 trails — outbound only). Seed 0xC0FFEE per spec;
  //    nudged per-trail so the trails don't all jitter identically.
  for (let i = 0; i < outboundDefs.length; i++) {
    const def = outboundDefs[i];
    const trail = _spawnBreadcrumbTrail(
      _group,
      breadcrumbGeo,
      0, 0,                       // central tree at world origin (per spec)
      def.x, def.z,
      (BREADCRUMB_SEED + i * 17) >>> 0
    );
    _trails.push(trail);
  }

  scene.add(_group);
  return _portals.length;
}

// ─── helper: lookup portal by id (defensive — for E-key intent testing) ─────
function _findReadyPortalNearHero(heroPos, tNow) {
  let best = null;
  let bestD2 = PROXIMITY_R2;
  for (const portal of _portals) {
    // FOREST-V2-A14 — sealed-door cohort flips portal._sealed=true when the
    // room's miniboss is alive. Treat sealed portals as un-pickable here so
    // both E-press and walk-into-portal paths no-op cleanly without any
    // hero teleport. The proximity prompt overlay is owned by forestSealedDoors.
    if (!portal.entGroup.visible || portal._sealed) continue;
    if (portal.cooldownUntil > tNow) continue;
    if (portal.localStepGuard > tNow) continue;
    const dx = heroPos.x - portal.x;
    const dz = heroPos.z - portal.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= bestD2) {
      best = portal;
      bestD2 = d2;
    }
  }
  return best;
}

function _syncTrialPortalVisual(portal, state) {
  if (!portal || portal.kind !== 'outbound' || portal._sealed) return;
  const trial = state.run && state.run.forestPortalTrials;
  const rec = trial && trial.rooms && trial.rooms[portal.destRoomId];
  const cleared = !!(rec && rec.status === 'CLEARED');
  const desired = cleared ? COLOR_BIOGLOW_PRIMARY : COLOR_AMBER_IDLE;
  const nextState = cleared ? 'CLEARED' : 'AVAILABLE';
  if (portal._trialVisual === nextState && portal.gateVisualState === nextState) return;
  portal._trialVisual = nextState;
  portal.baseColorHex = desired;
  if (portal.discMat && portal.discMat.emissive) portal.discMat.emissive.setHex(desired);
  if (portal.rimMat && portal.rimMat.color) portal.rimMat.color.setHex(desired);
  if (portal.crystalMat && portal.crystalMat.emissive) portal.crystalMat.emissive.setHex(desired);
  if (portal.beaconMat && portal.beaconMat.color) portal.beaconMat.color.setHex(desired);
  setForestPortalGateState(portal, nextState);
}

// ─── public: tick ───────────────────────────────────────────────────────────
export function tickForestPortals(dt, state) {
  if (!state || _portals.length === 0) return;
  const scene = state.scene;
  if (!scene) return;
  const tNow = (state.time && state.time.game) || 0;
  const hero = state.hero;
  const heroPos = hero && hero.pos;
  const heroAlive = !!(hero && hero.hp > 0 && !state.gameOver);
  const paused = !!(state.time && state.time.paused);
  const currentRoom = (state.run && state.run.currentRoom) || 'glade';

  // ── PASS 1: idle pulse + cooldown timer + crystal bob/spin + breadcrumb bob
  for (const portal of _portals) {
    _syncTrialPortalVisual(portal, state);
    const visible = portal.roomId === currentRoom;
    portal.entGroup.visible = visible;
    if (!visible) continue;
    // Idle disc emissive pulse — slot 6 (or slot 4 for return) → slot 7 peak.
    portal.pulsePhase += dt * (Math.PI * 2 * IDLE_PULSE_HZ);
    const k = 0.5 + 0.5 * Math.sin(portal.pulsePhase);
    const gateStep = Math.min(1, Math.max(0, dt) * GATE_STATE_SPEED);
    portal.gateSealAmount += (portal.gateSealTarget - portal.gateSealAmount) * gateStep;
    portal.gateBloomAmount += (portal.gateBloomTarget - portal.gateBloomAmount) * gateStep;
    portal.gateVeilAmount += (portal.gateVeilTarget - portal.gateVeilAmount) * gateStep;
    if (portal.discMat) {
      portal.discMat.emissiveIntensity = IDLE_EMISSIVE_MIN
        + (IDLE_EMISSIVE_MAX - IDLE_EMISSIVE_MIN) * k;
      if (k > 0.95) portal.discMat.emissive.setHex(portal.peakColorHex);
      else          portal.discMat.emissive.setHex(portal.baseColorHex);
    }

    // Disc Y-bob (cosmetic).
    portal.bobPhase += dt * (Math.PI * 2 * DISC_BOB_HZ);
    if (portal.discMesh) {
      portal.discMesh.position.y = DISC_BASE_Y + Math.sin(portal.bobPhase) * DISC_BOB_AMP;
    }
    if (portal.rimMesh) {
      portal.rimMesh.position.y = RIM_BASE_Y + Math.sin(portal.bobPhase) * DISC_BOB_AMP;
      portal.rimMat.opacity = 0.74 + k * 0.24;
    }
    if (portal.beaconMesh) {
      portal.beaconMat.color.setHex(portal.baseColorHex);
      if (portal.gateVeilMat) {
        portal.gateVeilMat.uniforms.uMotionScale.value = state._optReduceMotion ? 0 : 1;
        portal.gateVeilMat.uniforms.uTime.value = tNow + portal.seed * 0.013;
      }
    }
    _easeGatePose(portal);

    // Floating crystal — slow spin + sin-bob above the disc.
    portal.crystalPhase += dt * (Math.PI * 2 * CRYSTAL_SPIN_HZ);
    if (portal.crystalMesh) {
      portal.crystalMesh.rotation.y = portal.crystalPhase;
      portal.crystalMesh.position.y = CRYSTAL_BASE_Y + Math.sin(portal.crystalPhase * 1.3) * CRYSTAL_BOB_AMP;
    }

    // Cooldown overlay opacity ramp.
    if (portal.cooldownActive) {
      const remaining = portal.cooldownUntil - tNow;
      if (remaining > 0) {
        const frac = Math.max(0, Math.min(1, remaining / COOLDOWN_DURATION));
        if (portal.cooldownRing) {
          portal.cooldownRing.mat.opacity = COOLDOWN_RING_OPACITY_MAX * frac;
          portal.cooldownRing.mesh.visible = true;
        }
      } else {
        if (portal.cooldownRing) {
          portal.cooldownRing.mat.opacity = 0;
          portal.cooldownRing.mesh.visible = false;
        }
        portal.cooldownActive = false;
      }
    }
  }

  // ── Breadcrumb bob — single matrix rewrite per orb. Cheap.
  if (_trails.length > 0) {
    const trailsVisible = currentRoom === 'glade';
    for (const trail of _trails) {
      trail.mesh.visible = trailsVisible;
      if (!trailsVisible) continue;
      const data = trail.instanceData;
      const len = data.length;
      for (let i = 0; i < len; i++) {
        const d = data[i];
        d.bobPhase += dt * (Math.PI * 2 * BREADCRUMB_BOB_HZ);
        const y = BREADCRUMB_Y_BASE + Math.sin(d.bobPhase) * BREADCRUMB_BOB_AMP;
        _breadcrumbPos.set(d.baseX, y, d.baseZ);
        _breadcrumbScale.set(d.scl, d.scl, d.scl);
        _breadcrumbMatrix.compose(_breadcrumbPos, _breadcrumbQuat, _breadcrumbScale);
        trail.mesh.setMatrixAt(i, _breadcrumbMatrix);
      }
      trail.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const nearby = (heroAlive && !paused && heroPos)
    ? _findReadyPortalNearHero(heroPos, tNow)
    : null;
  if (nearby) {
    if (_promptPortalId !== nearby.id) {
      const room = FOREST_ROOMS[nearby.destRoomId];
      const trial = state.run && state.run.forestPortalTrials;
      const roomState = trial && nearby.kind === 'outbound'
        ? trial.rooms && trial.rooms[nearby.destRoomId]
        : null;
      const label = nearby.kind === 'return'
        ? 'Return to The Glade'
        : roomState && roomState.status === 'CLEARED'
          ? `${room ? room.name : 'Room'} — Cleared`
          : `Enter ${room ? room.name : 'portal'} Trial`;
      setPromptLabel(_promptBinding, label);
      _promptPortalId = nearby.id;
    }
    if (_promptEl) _promptEl.style.display = 'block';
  } else {
    _hidePrompt();
  }

  // ── PASS 2: E-key edge + proximity + activation.
  // Edge-triggered: interactPressed is true on the tick the key transitions
  // down. Defensive optional chain because Cohort 3A is wiring this in
  // parallel; if missing we just skip activation rather than crash.
  const interactEdge = !!(state.input && state.input.interactPressed);
  if (heroAlive && heroPos && interactEdge) {
    const target = _findReadyPortalNearHero(heroPos, tNow);
    if (target) {
      // === ACTIVATION FRAME ===
      // (1) Origin flash — disc emissive spike + slot-7 ring.
      if (target.discMat) {
        target.discMat.emissive.setHex(COLOR_AMBER_FLASH);
        target.discMat.emissiveIntensity = TELEPORT_FLASH_EMISSIVE;
      }
      _flashRings.push(_spawnFlashRing(scene, target.x, target.z));

      // Portal-owned travel intent. main.js consumes this exact token on the
      // next room-detection edge; direct walking along a decorative moss road
      // has no token and is contained by constrainForestPortalRoomPosition().
      if (state.run) {
        state.run._forestPortalTransfer = {
          from: target.roomId,
          to: target.destRoomId,
          kind: target.kind,
          portalId: target.id,
          expiresAt: tNow + 1.0,
        };
      }

      // (2) Hero position snap — pos + mesh in the same tick.
      state.hero.pos.x = target.dest.x;
      state.hero.pos.z = target.dest.z;
      if (state.hero.mesh) {
        state.hero.mesh.position.x = target.dest.x;
        state.hero.mesh.position.z = target.dest.z;
      }

      // (3) iFrames on arrival — preserve any longer existing window.
      state.hero.iFramesUntil = Math.max(
        state.hero.iFramesUntil || 0,
        tNow + IFRAMES_ON_ARRIVAL
      );

      // (4) Destination flash at arrival point (matches voidTeleportPads
      //     "single-frame peak on origin AND destination on the same
      //     frame"). The destination isn't an entity itself, so we just
      //     spawn the slot-7 ring at the arrival coord.
      _flashRings.push(_spawnFlashRing(scene, target.dest.x, target.dest.z));

      // (5) Cooldown on ORIGIN portal.
      target.cooldownUntil = tNow + COOLDOWN_DURATION;
      target.cooldownActive = true;
      if (target.cooldownRing) {
        target.cooldownRing.mat.opacity = COOLDOWN_RING_OPACITY_MAX;
        target.cooldownRing.mesh.visible = true;
      }
      _hidePrompt();

      // (6) Re-entry guard on ANY portal whose position is at the arrival
      //     coord (e.g. the paired return portal at room center — landing
      //     on top of it should NOT immediately consume the next E-press).
      for (const p of _portals) {
        if (p === target) continue;
        const ddx = p.x - target.dest.x;
        const ddz = p.z - target.dest.z;
        if (ddx * ddx + ddz * ddz <= PROXIMITY_R2) {
          p.localStepGuard = tNow + LOCAL_STEP_GUARD;
        }
      }

      // (7) Defensive SFX — only fire if a forest-portal handler exists.
      //     Don't fall through to void-themed sounds.
      // (audio.js may add `sfx.forestPortal` later; we don't import it here
      //  to keep the dep graph tight. Wiring is FE-C3A's call.)
    }
  }

  // ── PASS 3: tick flash rings (expand + fade + dispose on expiry).
  for (let i = _flashRings.length - 1; i >= 0; i--) {
    const r = _flashRings[i];
    r.t += dt;
    const k = Math.min(1, r.t / r.life);
    const sc = 1.0 + 1.5 * k;
    r.group.scale.set(sc, 1, sc);
    r.mats[0].opacity = r.baseOpacity * (1 - k);
    if (k >= 1) {
      if (r.group.parent) r.group.parent.remove(r.group);
      else if (scene) scene.remove(r.group);
      for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
      for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
      _flashRings.splice(i, 1);
    }
  }
}

// ─── public: dispose ────────────────────────────────────────────────────────
export function disposeForestPortals(scene) {
  // Tear down in-flight flash rings (scene children).
  for (const r of _flashRings) {
    if (r.group && r.group.parent) r.group.parent.remove(r.group);
    else if (r.group && scene) scene.remove(r.group);
    for (const g of r.geos) { try { g.dispose(); } catch (_) {} }
    for (const m of r.mats) { try { m.dispose(); } catch (_) {} }
  }
  _flashRings.length = 0;

  // Tear down per-portal materials (geometries are shared, disposed below).
  for (const portal of _portals) {
    if (portal.cooldownRing) {
      try { portal.cooldownRing.mat.dispose(); } catch (_) {}
      try { portal.cooldownRing.geo.dispose(); } catch (_) {}
      portal.cooldownRing = null;
    }
    if (portal.discMat)    { try { portal.discMat.dispose(); } catch (_) {} }
    if (portal.rimMat)     { try { portal.rimMat.dispose(); } catch (_) {} }
    if (portal.crystalMat) { try { portal.crystalMat.dispose(); } catch (_) {} }
    if (portal.beaconMat)  { try { portal.beaconMat.dispose(); } catch (_) {} }
  }

  // Tear down breadcrumb trail InstancedMesh materials.
  for (const trail of _trails) {
    if (trail.mat) { try { trail.mat.dispose(); } catch (_) {} }
    // The InstancedMesh itself is parented to _group, removed wholesale below.
    // Its geometry is in _disposables and disposed there.
  }
  _trails.length = 0;

  // Remove parent group + dispose shared geos/mats.
  if (_group) {
    if (scene && _group.parent === scene) scene.remove(_group);
    else if (_group.parent) _group.parent.remove(_group);
    _group = null;
  }
  for (const d of _disposables) { try { d.dispose && d.dispose(); } catch (_) {} }
  _disposables.length = 0;

  _portals.length = 0;
  if (_promptBinding) unbindPrompt(_promptBinding);
  _promptBinding = null;
  if (_promptEl) _promptEl.remove();
  _promptEl = null;
  _promptPortalId = null;
}

// Naming-parity alias for code that follows the loadForestAmber/clearForestAmber
// convention. Functionally identical to disposeForestPortals.
export { disposeForestPortals as clearForestPortals };

// ─── debug exports (mirror voidTeleportPads / forestAmber pattern) ──────────
export function _debugPortals()    { return _portals.slice(); }
export function _debugTrails()     { return _trails.slice(); }
export function _debugFlashRings() { return _flashRings.slice(); }

// FOREST-V2-A14 — live portal-record accessor for the sealed-door cohort.
// Returns the same internal array reference (NOT a copy) so the consumer
// (src/forestSealedDoors.js) can mutate per-portal `_sealed` flags + tint
// materials in place. Cohort 14 is the only intended caller; other modules
// should keep using _debugPortals() which returns a defensive shallow copy.
export function getForestPortals() { return _portals; }
