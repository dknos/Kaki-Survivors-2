/**
 * Town hub — walkable plaza between runs.
 *
 * Phase-1 scaffold: stone plaza, cabin (future House upgrades), Adventure Gate
 * (starts a run on E), four lamp posts. The town group attaches to the main
 * scene and toggles visible based on state.mode === 'town'.
 *
 * In town mode, main.js runs a stripped-down tick (input + hero + fx + camera)
 * with no spawn director, weapons, enemies, or pickups.
 *
 * Interactables are a flat list: {pos, radius, label, key}. tickTown finds
 * the closest one inside its trigger radius and shows the [E] prompt; pressing
 * E fires the activate handler.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { AVATARS } from './config.js';
import { getMeta, setOption, isAvatarUnlocked, claimDailyGift } from './meta.js';
import { initChatBindings, tickBubbles, pushBubble, setSpeakerAnchor, clearBubbles } from './chatBubble.js';
import { isShopOpen, isGrimoireOpen } from './ui.js';
import { isDaycareOpen } from './daycare.js';
import { bindPrompt, setPromptLabel } from './buttonPrompts.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { applyRimLight, cloneCached, upgradeMaterials, getCachedTexture, GLTF_CACHE } from './assets.js';
import { sfx } from './audio.js';
import { tex } from './particleTextures.js';
import {
  activateMaoMaoInteraction,
  buildMaoMaoTown,
  enterMaoMaoTown,
  getMaoMaoInteraction,
  tickMaoMaoTown,
} from './maomao.js';

const PLAZA_R = 18;
const FENCE_R = 22;

let _group = null;
let _portal = null;
let _portalLight = null;            // portal PointLight (CC8 gate-launch flare spike)
let _promptEl = null;
let _promptBinding = null;
let _activeKey = null;
let _onGateActivate = null;
// CC8 gate-launch flourish — a brief "whoosh into the adventure" beat on gate E
// before the real run-start fires. The flare itself is animated in tickTown.
let _gateFlourishUntil = 0;         // state.time.real when the launch flare ends
let _gateLaunchPending = false;     // guard: ignore repeat E during the flare
let _gateLaunchTimer = null;        // cancellable timer; never allowed to outlive Town
let _gateLaunchId = 0;              // invalidates callbacks already queued
const GATE_FLOURISH_SEC = 0.26;     // flare duration before run-start (tunable feel knob)
const _handlers = {};

// Static interactables — character statues are appended dynamically in buildTown.
const _interactables = [
  { pos: { x: 0, z: 14 },  radius: 3.5, label: '⚔  Enter the Hunt',      key: 'gate'  },
  { pos: { x: 0, z: -14 }, radius: 4.0, label: '🏠  Enter the House',    key: 'house' },
  { pos: { x: -12, z: -3 }, radius: 3.0, label: '🛒  Shop · Spend embers', key: 'shop'  },
];
// Townsfolk — the player's unlocked hero roster milling around the plaza. The
// POOL (`_heroNpcs`) holds one entry per unlocked avatar, cloned once in
// buildTown; a random PRESENT subset (≤ TOWNSFOLK_MAX_PRESENT) is rolled each
// visit in _rollTownsfolk so the crew changes trip to trip. Present heroes
// wander between waypoints and can be talked to (E). Each entry:
// { av, name, group, pos{x,z}, target{x,z}, speed, present, pauseUntil,
//   faceYaw, barkIdx, nextBarkAt }.
const _heroNpcs = [];
const TOWNSFOLK_MAX_PRESENT = 6;

// Open wander waypoints — clear of every prop (gate 0,14 / house 0,-14 /
// shop -12,-3 / tent 12,-3 / brazier 8,12 / grimoire -9,-9 / lamps ±14).
const TOWNSFOLK_WAYPOINTS = [
  [-6, 3], [-4, 6], [-8, 5], [-3, -4], [-6, -3],
  [ 6, 3], [ 4, 6], [ 8, 5], [ 3, -4], [ 6, -3],
  [-2, 8], [ 2, 8], [ 0, 3], [-1, -6], [ 1, -6],
];

// Talk lines. Per-hero flavor keyed by avatar id; anyone without an entry
// (e.g. the tint-kittens) falls back to the shared pool.
const TOWNSFOLK_DEFAULT_BARKS = [
  'Nice day to not be getting chased, huh?',
  'Heading into the Hunt? Give one a swipe for me.',
  'I claimed the good sunbeam. First come, first served.',
  'Decorate the house yet? I helped. I watched, mostly.',
  'If you find snacks out there, remember your friends.',
  'Just stretching my legs. Long night ahead.',
];
const TOWNSFOLK_BARKS = {
  kitty:   ['Home sweet Hollow. Don’t track mud on the rug.', 'Nine lives and I’m spending them cozy.'],
  sote:    ['Stand still and the night finds you. So I walk.', 'Bring back trophies. I’ll hold the good spot.'],
  cowboy:  ['Draw’s quicker when your boots are warm.', 'Town’s big enough for all of us. Barely.'],
  pipes:   ['Roster’s looking sharp. I run a tight room.', 'You break it out there, I fix it in here. Deal?'],
  bomdia:  ['Bom dia! Sun’s up, spirits up.', 'Sing with me later? After the Hunt.'],
  mothman: ['The porch light calls. I resist. Mostly.', 'Brake-light eyes see everything, friend.'],
  camper:  ['Bedroll’s packed. Never lost, never late.', 'Save me a marshmallow from the brazier.'],
  space:   ['Gravity’s a suggestion where I’m from.', 'Whiskers vacuum-rated. Ask me anything.'],
  radcat:  ['Don’t mind the ticking. It’s just me saying hi.', 'Glow’s free. The dosimeter costs extra.'],
  mona:    ['I was painted. Then I decided to walk off.', 'Hold still — you’d make a lovely study.'],
  bezelbug:['Every facet catches the hearth just so.', 'Rivets tight, wings bright. Ready when you are.'],
  rocker:  ['Turned the amp to eleven. Town said ten. Cowards.', 'Encore’s after you clear the Hunt.'],
  borgirboss:['Hauled the whole rack in. Rockets included.', 'You want fries with that carnage?'],
};

// Hellfire Brazier — force-trigger next-run Helltide. localStorage flag
// `kk_helltide_queued` persists across the run-start so helltide.js init can
// read + consume it without touching main.js.
const HELLTIDE_QUEUED_KEY = 'kk_helltide_queued';
let _brazier = null;             // THREE.Group
let _brazierFlames = [];         // [{mesh, baseY, phase, scale}]
let _brazierLight = null;        // PointLight ref for intensity pulse
let _brazierIntenseUntil = 0;    // state.time.real when the "hotter" glow ends

// Seedy Tent (Casino — iter 22B). Cone tent + dark entrance + flickering red
// lantern that wobbles via lerp in tickTown. Locked until first Catacomb Void
// clear (meta.unlockedVoid). Interactable lives in _interactables; the activate
// handler is wired in main.js via setInteractionHandler('casino', ...).
let _tent = null;                // THREE.Group
let _tentLight = null;           // PointLight ref for flicker
let _tentLanternMesh = null;     // small additive disc on the lantern shell

// Wandering town NPC (CC5 town cohort 2) — a robed sage-cat that ambles the
// open central plaza and chatters via chatBubble.js. Its first line per visit is
// keyed off the townVisits counter (returning-player dressing, folded in here);
// then it cycles flavor barks themed to the plaza's interactables. Speaker id
// is named after the concept so a future 2nd NPC isn't a rename.
const NPC_SPEAKER_ID = 'townSage';
let _npc = null;   // { group, pos, target, speed, nextBarkAt, firstBarkDone, barkIndex }
const NPC_BARKS = [
  'Mind the brazier — it bites back if you provoke it.',
  'The Grimoire holds recipes even I have half-forgotten.',
  'Spend your embers before the gate, hm? Coin is no use to the dead.',
  'The statues remember every champion. Choose yours.',
  'I have watched kittens stroll through that gate and never... well. Off you go.',
];

// Gate biome dressing (CC6 town cohort 3) — the emissive growth in the two
// planters flanking the Adventure Gate recolors to preview the SELECTED stage's
// biome, so the gate reads as "the way to <destination>". Keyed off
// getMeta().selectedStage (set in menuV2); falls back to forest for any stage
// without an entry. Recolors a shared material per planter (see _applyGateBiome).
const _GATE_BIOME = {
  forest:   { color: 0x3f7a3a, emissive: 0x4caf50 },  // verdant foliage
  cave:     { color: 0x1f4a40, emissive: 0x7fffe4 },  // glowmoss (CAVE_PALETTE.moss)
  twilight: { color: 0x4a3a6a, emissive: 0x9a6fc0 },  // dusk violet
  cinder:   { color: 0x6a2a16, emissive: 0xff6a28 },  // ember orange
  void:     { color: 0x2a1840, emissive: 0xc87bff },  // sigil violet
  kakiland: { color: 0x2d7146, emissive: 0x59e9ff },  // tropical-cyan final chapter
};
let _gateBiomeMats = [];   // shared growth materials of the flanking planters

function _makePlazaMaterial() {
  const authored = getCachedTexture('town_plaza_cobble_v1');
  const map = authored || _makePlazaTexture();
  if (map) map.repeat.set(4.5, 4.5);
  return new THREE.MeshStandardMaterial({
    color: authored ? 0xffffff : 0xd8bd96,
    map,
    roughness: 0.92,
    metalness: 0.02,
  });
}

function _matStandard(color, roughness = 0.85, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function _makeCabin() {
  // Iter 14: Quaternius fantasy_house GLB replaces the BoxGeometry shell.
  // Glowing windows + a roof-side chimney overlay sell "home" — we keep
  // the PointLight cue inside.
  const g = new THREE.Group();
  const kit = cloneCached('kit_house');
  if (kit) {
    kit.scale.setScalar(4.2);
    kit.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    g.add(kit);
  } else {
    // Fallback: small dark hut so the door interactable still has visible mass.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(7, 4, 5), _matStandard(0x6a4a30, 0.85),
    );
    body.position.y = 2; body.castShadow = true;
    g.add(body);
  }
  // Warm interior-light cue at the front porch (existing pattern — sells
  // "the lights are on, walk in").
  const porchLight = new THREE.PointLight(0xffd28a, 0.7, 7, 2);
  porchLight.position.set(0, 2.4, 3.0);
  g.add(porchLight);
  return g;
}

function _makeAdventureGate() {
  // Iter 14: Quaternius castle_gate GLB. Keep the animated turquoise portal
  // disc + point light on top (this is the iconic "exit to adventure" cue
  // and the in-game audio is timed to its sine pulse).
  const g = new THREE.Group();
  const kit = cloneCached('kit_gate');
  if (kit) {
    kit.scale.setScalar(3.5);
    kit.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    g.add(kit);
  } else {
    // Fallback: two-pillar stone arch.
    for (const x of [-2.4, 2.4]) {
      const p = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 4.2, 0.9), _matStandard(0x5a5550, 0.9),
      );
      p.position.set(x, 2.1, 0);
      p.castShadow = true;
      g.add(p);
    }
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(6.0, 0.9, 1.0), _matStandard(0x5a5550, 0.9),
    );
    lintel.position.set(0, 4.65, 0);
    g.add(lintel);
  }
  // Glowing portal disc — flat mint puddle, no radial spoke art so it
  // doesn't read as "lines radiating across the plaza". Iter 28c's rune-
  // tex + additive blending caused the rune's 24 tick marks + 48 outer
  // hair ticks to bleed through everything in town.
  _portal = new THREE.Mesh(
    new THREE.CircleGeometry(1.8, 36),
    new THREE.MeshBasicMaterial({
      color: 0x7fffd4, transparent: true, opacity: 0.55, depthWrite: false,
    }),
  );
  _portal.rotation.x = -Math.PI / 2;
  _portal.position.set(0, 0.06, 0);
  g.add(_portal);
  // Portal point light
  const pl = new THREE.PointLight(0x7fffd4, 1.8, 14, 2);
  pl.position.set(0, 1.6, 0);
  g.add(pl);
  _portalLight = pl;   // CC8: spiked during the gate-launch flare
  return g;
}

function _makeLamp() {
  const g = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.15, 3.4, 8),
    _matStandard(0x222020, 0.85, 0.3),
  );
  post.position.y = 1.7;
  post.castShadow = true;
  g.add(post);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0xffd86a, emissive: 0xffb050, emissiveIntensity: 1.4 }),
  );
  head.position.y = 3.5;
  g.add(head);
  const pl = new THREE.PointLight(0xffb050, 0.9, 9, 2);
  pl.position.y = 3.4;
  g.add(pl);
  return g;
}

// Ambient hero NPC height (world units) — near the in-game HERO.targetHeight
// (3.6) so the townsfolk read as full characters milling around, not miniatures.
const NPC_HEIGHT = 3.3;

// Ambient hero NPC — just the avatar's REAL hero GLB standing on the ground.
// No pedestal, no picking (avatar selection lives on the start-screen carousel);
// a gentle idle bob + slow glance-sway is applied per-frame in tickTown.
//
// LOAD-BEARING: the figure OWNS its geometry + materials (deep-cloned off the
// shared GLTF cache), because _disposeUnselectedAvatars() frees every
// non-selected hero_<id> at run-start. SkeletonUtils.clone shares geo/mats with
// the cache, so without owning them these NPCs would render as disposed garbage
// the moment the player starts their first run.
function _makeHeroNpc(av) {
  const g = new THREE.Group();
  const key = av.glb ? `hero_${av.id}` : 'hero';
  const fig = cloneCached(key);
  if (fig) {
    fig.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) o.geometry = o.geometry.clone();
      o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false;
    });
    // Geometry is independently owned because the source cache may be
    // disposed. Material ownership/promotion is centralized and happens once;
    // rim nodes are attached after the donor tint below.
    upgradeMaterials(fig, 0.55, 0.92, { rim: false });
    // Auto-fit to a uniform height, then seat feet on the ground (y = 0).
    const box = new THREE.Box3().setFromObject(fig);
    const sz = box.getSize(new THREE.Vector3());
    const autoFit = sz.y > 1e-6 ? NPC_HEIGHT / sz.y : 1;
    fig.scale.setScalar(autoFit * (av.scaleMul || 1));
    const box2 = new THREE.Box3().setFromObject(fig);
    fig.position.y = -box2.min.y;
    // Donor-model avatars (kitty + the tint-kittens) carry a tint identity;
    // real-GLB heroes render as authored.
    if (!av.glb && av.tint && av.tint !== 0xffffff) {
      const t = new THREE.Color(av.tint);
      fig.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) if (material?.color) material.color.multiply(t);
      });
    }
    applyRimLight(fig);
    g.add(fig);
    g.userData._figure = fig;
  }
  return g;
}

// Roll which townsfolk are present this visit + scatter them onto waypoints.
// Called from enterTown so the crew you see changes trip to trip. Rebuilds the
// per-NPC `talk:` interactables (their pos references the live npc.pos, so the
// prompt tracks a walking hero). ≤ TOWNSFOLK_MAX_PRESENT present; with fewer
// unlocked than that, everyone shows.
function _rollTownsfolk() {
  // Drop last visit's talk interactables.
  for (let i = _interactables.length - 1; i >= 0; i--) {
    if (String(_interactables[i].key).startsWith('talk:')) _interactables.splice(i, 1);
  }
  if (!_heroNpcs.length) return;
  // Candidate pool indices EXCLUDING the player's selected avatar — that hero is
  // the character you control in town, so spawning them as a townsperson too
  // would show the same character twice ("double npc").
  const selId = getMeta().selectedAvatar;
  const idx = [];
  for (let i = 0; i < _heroNpcs.length; i++) {
    if (_heroNpcs[i].av.id !== selId) idx.push(i);
  }
  // Fisher–Yates shuffle of the candidate indices.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  const nPresent = Math.min(idx.length, TOWNSFOLK_MAX_PRESENT);
  const present = new Set(idx.slice(0, nPresent));
  const now = state.time.real;
  for (let k = 0; k < _heroNpcs.length; k++) {
    const npc = _heroNpcs[k];
    npc.present = present.has(k);
    npc.group.visible = npc.present;
    if (!npc.present) continue;
    const w0 = TOWNSFOLK_WAYPOINTS[(Math.random() * TOWNSFOLK_WAYPOINTS.length) | 0];
    const w1 = TOWNSFOLK_WAYPOINTS[(Math.random() * TOWNSFOLK_WAYPOINTS.length) | 0];
    npc.pos.x = w0[0]; npc.pos.z = w0[1];
    npc.target.x = w1[0]; npc.target.z = w1[1];
    npc.pauseUntil = 0;
    npc.nextBarkAt = now + 5 + Math.random() * 10;
    npc.group.position.set(npc.pos.x, 0, npc.pos.z);
    _interactables.push({
      pos: npc.pos,                        // live-tracked as the hero walks
      radius: 2.2,
      label: '💬  Talk to ' + npc.name,
      key: 'talk:' + npc.av.id,
    });
  }
}

// Push one of a townsperson's lines as a chat bubble anchored to them.
function _npcBark(npc) {
  const lines = TOWNSFOLK_BARKS[npc.av.id] || TOWNSFOLK_DEFAULT_BARKS;
  try { pushBubble('townnpc_' + npc.av.id, lines[npc.barkIdx % lines.length]); } catch (_) {}
  npc.barkIdx++;
}

// Talk to a present townsperson (E). They say a line, pause to "chat", and turn
// to face the player.
function _talkTo(id) {
  const npc = _heroNpcs.find((n) => n.present && n.av.id === id);
  if (!npc) return;
  _npcBark(npc);
  npc.pauseUntil = state.time.real + 3.0;
  const dx = state.hero.pos.x - npc.pos.x, dz = state.hero.pos.z - npc.pos.z;
  npc.faceYaw = Math.atan2(dx, dz);
  npc.group.rotation.y = npc.faceYaw;
  try { sfx.uiClick && sfx.uiClick(); } catch (_) {}
}

function _makeShopStall() {
  // Iter (2026-07-08): the procedural counter + red/white candy-stripe awning
  // read as placeholder next to the GLB cabin/gate. Swap to the Quaternius
  // fantasy_inn kit — a merchant building reads as "Shop" with the 🛒 label —
  // matching the cabin's asset quality. Keep the striped stall as fallback.
  const g = new THREE.Group();
  const kit = cloneCached('kit_inn');
  if (kit) {
    kit.scale.setScalar(4.0);
    kit.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.add(kit);
    // Warm "open for business" light at the entrance (same cue as the cabin).
    const shopLight = new THREE.PointLight(0xffdd9a, 0.6, 8, 2);
    shopLight.position.set(0, 2.4, 3.2);
    g.add(shopLight);
  } else {
    // Fallback: procedural market stall (counter + striped awning).
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.2, 1.4), _matStandard(0x6a4a30, 0.85));
    counter.position.y = 0.6;
    counter.castShadow = true; counter.receiveShadow = true;
    g.add(counter);
    for (const x of [-1.3, 1.3]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.8, 8), _matStandard(0x2a2018, 0.9));
      p.position.set(x, 2.0, 0);
      g.add(p);
    }
    for (let i = 0; i < 6; i++) {
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 1.6),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? 0xc23a3a : 0xece2cc, roughness: 0.9, side: THREE.DoubleSide,
        }),
      );
      stripe.position.set(-1.35 + i * 0.54, 3.0, 0.4);
      stripe.rotation.x = -Math.PI / 3;
      g.add(stripe);
    }
  }
  return g;
}

// Grimoire lectern (CC3 town cohort 1) — a stone reading-stand with a glowing
// open book on top. E opens the evolution Grimoire (ui.showGrimoire). Visual:
// short pillar + angled slab + an emissive-violet book on the bloom layer so
// it reads as arcane from across the plaza.
function _makeGrimoirePedestal() {
  const g = new THREE.Group();
  // Pillar base
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 1.2, 10), _matStandard(0x4a4a52, 0.92));
  post.position.y = 0.6;
  post.castShadow = true; post.receiveShadow = true;
  g.add(post);
  // Angled reading slab
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.0), _matStandard(0x6a4a30, 0.85));
  slab.position.set(0, 1.28, 0);
  slab.rotation.x = -Math.PI / 7;
  slab.castShadow = true;
  g.add(slab);
  // Open book — two emissive violet pages on the bloom layer.
  const pageMat = new THREE.MeshStandardMaterial({
    color: 0x2a1840, emissive: 0xc87bff, emissiveIntensity: 0.7,
    roughness: 0.6, side: THREE.DoubleSide,
  });
  for (const sx of [-1, 1]) {
    const page = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.75), pageMat);
    page.position.set(sx * 0.3, 1.4, 0);
    page.rotation.set(-Math.PI / 7, sx * 0.18, 0);
    page.layers.enable(BLOOM_LAYER);
    g.add(page);
  }
  return g;
}

// MaoMao's Daycare cottage. Iter (2026-07-08): the flat pink box + mint pyramid
// read as placeholder next to the GLB cabin/inn. Use the same cozy fantasy_house
// shape as the cabin but SMALLER (scale 3.5 vs 4.2) with a PINK roof, so it
// reads as an adorable pink cottage — unmistakably the daycare, distinct from
// the cabin/inn — plus an emissive heart sign + pink porch glow. Heart/light sit
// on the +z front face (kit_house @ 3.5 ≈ 7.5w × 11.9h × 9.3d, front z ≈ 4.6).
// Falls back to the old procedural cottage if the kit isn't cached.
function _makeDaycareCottage() {
  const g = new THREE.Group();
  const kit = cloneCached('kit_house');
  if (kit) {
    kit.scale.setScalar(3.5);
    kit.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      // Pink the teal roof for the daycare identity. Clone the material first —
      // SkeletonUtils.clone SHARES materials with the cached source, so an
      // in-place recolor would also repaint the cabin + every forest house. The
      // roof is the one strongly-teal mesh (low red, blue >> red); grey stone +
      // brown timber are excluded by the red-channel gate.
      const c = o.material && o.material.color;
      if (c && c.r < 0.28 && c.b > c.r * 1.8) {
        o.material = o.material.clone();
        o.material.color.set(0xff9ecb);
      }
    });
    g.add(kit);
  } else {
    // Fallback: procedural pink cottage (box walls + mint pyramid roof + door).
    const walls = new THREE.Mesh(new THREE.BoxGeometry(5.4, 3.4, 4.6), _matStandard(0xffb8d8, 0.85));
    walls.position.y = 1.7; walls.castShadow = true; walls.receiveShadow = true;
    g.add(walls);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.4, 2.2, 4), _matStandard(0x8fe6c4, 0.8));
    roof.position.y = 4.5; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
    g.add(roof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 0.2), _matStandard(0xfbeecf, 0.7));
    door.position.set(0, 1.1, 2.32);
    g.add(door);
  }
  // Warm pink porch light — "lights are on" cue that also casts pink onto the
  // cottage for the cozy identity. (No heart sign: the overhead camera hides
  // anything under fantasy_house's deep eave; the pink roof carries the read.)
  const porchLight = new THREE.PointLight(0xffb0dc, 1.1, 10, 2);
  porchLight.position.set(0, 3.5, 5.2);
  g.add(porchLight);
  return g;
}

// Wandering sage-cat NPC (CC5 town cohort 2). Cheap primitives, dusk-violet
// robe + cream fur so it reads distinct from the gray statues and the player
// hero: tapered robe, round head, two ear cones, an arched tail, and a
// gem-tipped staff (bloom-layer gem sells "sage"). Animated in _tickNpc.
function _makeTownNpc() {
  const g = new THREE.Group();
  const ROBE = 0x6a4a8c;   // dusk-violet (distinct from town's warm browns/golds)
  const FUR  = 0xd9b88a;   // warm cream
  const robe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.5, 1.2, 12), _matStandard(ROBE, 0.8),
  );
  robe.position.y = 0.6;
  robe.castShadow = true;
  g.add(robe);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), _matStandard(FUR, 0.7));
  head.position.y = 1.45;
  head.castShadow = true;
  g.add(head);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.24, 6), _matStandard(FUR, 0.7));
    ear.position.set(sx * 0.16, 1.7, 0);
    ear.castShadow = true;
    g.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.7, 6), _matStandard(FUR, 0.7));
  tail.position.set(0, 0.7, -0.4);
  tail.rotation.x = 0.9;
  g.add(tail);
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 6), _matStandard(0x3a2a18, 0.9));
  staff.position.set(0.34, 0.75, 0.1);
  g.add(staff);
  const gem = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a1840, emissive: 0xc87bff, emissiveIntensity: 0.9, roughness: 0.4 }),
  );
  gem.position.set(0.34, 1.55, 0.1);
  gem.layers.enable(BLOOM_LAYER);
  g.add(gem);
  return g;
}

// Gate biome planter (CC6) — a stone urn holding 3 emissive "growth" shards
// (foliage / crystal / ember, read by recolor). The three shards share ONE
// material so _applyGateBiome can retint the whole planter in a single write;
// the material is stashed on userData._growthMat for buildTown to collect.
function _makeGatePlanter() {
  const g = new THREE.Group();
  const urn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.55, 0.7, 10),
    _matStandard(0x4a4a52, 0.92),
  );
  urn.position.y = 0.35;
  urn.castShadow = true; urn.receiveShadow = true;
  g.add(urn);
  const growthMat = new THREE.MeshStandardMaterial({
    color: _GATE_BIOME.forest.color, emissive: _GATE_BIOME.forest.emissive,
    emissiveIntensity: 0.9, roughness: 0.6, metalness: 0.05,
  });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const shard = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.6 + i * 0.12, 6), growthMat);
    shard.position.set(Math.cos(a) * 0.18, 0.95 + i * 0.06, Math.sin(a) * 0.18);
    shard.rotation.z = (i - 1) * 0.18;
    shard.layers.enable(BLOOM_LAYER);
    g.add(shard);
  }
  g.userData._growthMat = growthMat;
  return g;
}

// Recolor the gate planters' growth to the selected stage's biome. Falls back
// to forest for any unmapped stage. Cheap (≤2 material writes) — safe to call
// every enterTown.
function _applyGateBiome(stageId) {
  const b = _GATE_BIOME[stageId] || _GATE_BIOME.forest;
  for (const mat of _gateBiomeMats) {
    if (!mat) continue;
    try { mat.color.setHex(b.color); mat.emissive.setHex(b.emissive); } catch (_) {}
  }
}

// Wander the NPC inside the open central plaza (target ring r∈[3,7] from origin
// so it never clips the statue arc / gate / shop / brazier / casino / fence)
// + run the bark scheduler. First bark per visit is townVisits-keyed; then it
// cycles NPC_BARKS. Reads hero/meta from the shared imports; no allocations.
function _tickNpc(dt) {
  if (!_npc) return;
  const p = _npc.pos, tgt = _npc.target;
  let dx = tgt.x - p.x, dz = tgt.z - p.z;
  let d = Math.hypot(dx, dz);
  if (d < 0.4) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 4;
    tgt.x = Math.cos(a) * r;
    tgt.z = Math.sin(a) * r;
    dx = tgt.x - p.x; dz = tgt.z - p.z; d = Math.hypot(dx, dz) || 1;
  }
  const step = Math.min(_npc.speed * dt, d);
  p.x += (dx / d) * step;
  p.z += (dz / d) * step;
  const grp = _npc.group;
  grp.position.x = p.x;
  grp.position.z = p.z;
  grp.position.y = 0.04 * Math.sin(state.time.real * 2.2);   // gentle amble bob
  grp.rotation.y = Math.atan2(dx, dz);                       // face travel dir

  const now = state.time.real;
  if (!_npc.firstBarkDone) {
    if (_npc.nextBarkAt === 0) _npc.nextBarkAt = now + 1.2;   // greeting lands ~1.2s after entry
    if (now >= _npc.nextBarkAt) {
      const meta = getMeta();
      const visits = (meta && meta.townVisits) | 0;
      const greet = (visits > 1)
        ? 'Back again? The Hunt has been hungry without you.'
        : 'Welcome to the Hollow, traveler. Rest before the Hunt.';
      pushBubble(NPC_SPEAKER_ID, greet);
      _npc.firstBarkDone = true;
      _npc.nextBarkAt = now + 7 + Math.random() * 3;
    }
  } else if (now >= _npc.nextBarkAt) {
    pushBubble(NPC_SPEAKER_ID, NPC_BARKS[_npc.barkIndex % NPC_BARKS.length]);
    _npc.barkIndex++;
    _npc.nextBarkAt = now + 7 + Math.random() * 3;
  }
}

// Brief confirmation toast for brazier interaction. ~2s, top-of-screen,
// hellfire amber. Self-contained — avoids cross-importing ui.js internals.
function _showBrazierToast(text) {
  const t = document.createElement('div');
  t.style.cssText = `
    position: fixed; left: 50%; top: 10%; transform: translateX(-50%);
    padding: 9px 22px; pointer-events: none; z-index: 100;
    background: linear-gradient(180deg, rgba(34,18,12,0.92), rgba(20,10,8,0.94));
    border: 1px solid rgba(255,122,40,0.6);
    border-radius: 8px;
    font-family: 'Cinzel Decorative', serif; font-size: 13px;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: #ffae6a;
    text-shadow: 0 0 8px rgba(255,122,40,0.55);
    box-shadow: 0 8px 22px rgba(0,0,0,0.55), 0 0 20px rgba(255,90,40,0.30);
    animation: kk-fade-in 0.18s ease-out;
  `;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 2000);
}

// Cozy pink counterpart of the brazier toast — for the daycare daily gift. The
// dark/orange brazier styling clashes with MaoMao's kawaii palette, so this one
// is warm-pink to match the daycare identity.
function _showDaycareGiftToast(text) {
  const t = document.createElement('div');
  t.style.cssText = `
    position: fixed; left: 50%; top: 12%; transform: translateX(-50%);
    padding: 11px 24px; pointer-events: none; z-index: 100;
    background: linear-gradient(180deg, #fff6fb, #ffe3f2);
    border: 2px solid #ff8fc7; border-radius: 12px;
    font-family: "Comic Sans MS", "Trebuchet MS", system-ui, sans-serif;
    font-size: 14px; font-weight: bold; color: #b03e86;
    text-shadow: 0 1px 0 rgba(255,255,255,0.7);
    box-shadow: 0 8px 24px rgba(150,60,140,0.35), 0 0 0 4px rgba(255,255,255,0.6);
    animation: kk-fade-in 0.2s ease-out;
  `;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3600);
}

// Hellfire Brazier — stone basin + flame plume. Iter 18.
// Visual: short cone-pedestal + cylinder bowl + 5 additive flame quads that
// bob and twist on a sine. Small red point light underneath for floor bleed.
// Bowl is palette-matched dark stone; flame mat uses the glowRed particle
// texture so it picks up the bloom pass.
function _makeBrazier() {
  const g = new THREE.Group();
  // Pedestal — short cone (wide base → narrow top) reads as stone foundation
  const pedestal = new THREE.Mesh(
    new THREE.ConeGeometry(0.85, 0.95, 12, 1, true),
    _matStandard(0x3c342c, 0.92, 0.05),
  );
  pedestal.position.y = 0.48;
  pedestal.castShadow = true; pedestal.receiveShadow = true;
  g.add(pedestal);
  // Bowl — short open cylinder rim
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.78, 0.55, 0.45, 16, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x2a1e16, roughness: 0.85, metalness: 0.08, side: THREE.DoubleSide,
    }),
  );
  bowl.position.y = 1.15;
  bowl.castShadow = true;
  g.add(bowl);
  // Inner ember plate — a tiny additive disc at the bottom of the bowl so the
  // brazier reads as "lit" even when the flames are at their bob trough.
  const emberDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 18),
    new THREE.MeshBasicMaterial({
      map: tex('emberWarm'),
      color: 0xff5a28, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  emberDisc.rotation.x = -Math.PI / 2;
  emberDisc.position.y = 0.98;
  emberDisc.layers.enable(BLOOM_LAYER);
  g.add(emberDisc);
  // Flame plume — 5 additive PlaneGeometry quads at varying heights & scales.
  // Each gets a phase offset so the bob/spin looks like a tongue of fire.
  const flameTex = tex('emberWarm') || tex('glowRed');
  for (let i = 0; i < 5; i++) {
    const s = 0.55 + Math.random() * 0.35;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s * 1.6),
      new THREE.MeshBasicMaterial({
        map: flameTex,
        color: 0xff7a28, transparent: true, opacity: 0.88,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    const baseY = 1.35 + Math.random() * 0.5;
    m.position.set((Math.random() - 0.5) * 0.4, baseY, (Math.random() - 0.5) * 0.4);
    m.layers.enable(BLOOM_LAYER);
    g.add(m);
    _brazierFlames.push({ mesh: m, baseY, phase: Math.random() * Math.PI * 2, scale: s });
  }
  // Floor bleed point-light — short range, red, so the flagstones around the
  // brazier get a warm wash that reads from the gate side.
  _brazierLight = new THREE.PointLight(0xff5a28, 1.4, 7, 2);
  _brazierLight.position.set(0, 1.6, 0);
  g.add(_brazierLight);
  return g;
}

// Seedy Tent — small carnival-style cone tent that houses the casino. Visual
// reads as "back-alley gambling den": dark red fabric, two wooden stakes,
// a black entrance void, and a flickering red lantern that pulses in tickTown.
// A tiny slot-cabinet peeks out of the entrance so the function is legible
// at a glance even before the player presses E. Palette-matched to the
// 8-color bible (deep red 0x7a1a1a, stake brown 0x6a4a30, lantern 0xff3a3a).
function _makeSeedyTent() {
  const g = new THREE.Group();
  // Iter 33f — Casino is the Poly by Google "Casino" CC-BY GLB (1930s neon
  // sign building on a road circle). Procedural cone tent stays as fallback
  // for the case where the GLB hasn't preloaded yet (or fails to fetch).
  const cas = cloneCached('casino_building');
  const usedGlb = !!cas;
  g.userData._usesCasinoGlb = usedGlb;
  if (cas) {
    cas.scale.setScalar(0.018);      // source bbox ~176 units; pull to ~3.2 across
    cas.rotation.y = Math.PI;        // face the camera/hero spawn
    cas.position.y = 0.05;
    cas.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.add(cas);
    // Scatter poker chips at the entrance as bling. Cheap CC-BY low-poly,
    // 284 tris each, so 4 of them barely move the draw budget.
    for (let i = 0; i < 4; i++) {
      const chip = cloneCached('casino_chip');
      if (!chip) break;
      chip.scale.setScalar(6);
      chip.position.set(
        -0.6 + i * 0.4 + (Math.random() - 0.5) * 0.2,
        0.06 + i * 0.02,
        1.4 - (i % 2) * 0.15,
      );
      chip.rotation.x = -Math.PI / 2;
      chip.rotation.z = (i / 4) * Math.PI * 2;
      g.add(chip);
    }
  }
  if (!usedGlb) {
  // Vertical fabric seams — 4 thin darker stripes around the cone for
  // line-weight texture (matches the canopy/stripe pattern shop stall uses).
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const seam = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 2.6),
      new THREE.MeshBasicMaterial({ color: 0x4a0e0e, side: THREE.DoubleSide }),
    );
    seam.position.set(Math.cos(a) * 1.55, 1.3, Math.sin(a) * 1.55);
    seam.lookAt(0, 1.3, 0);
    g.add(seam);
  }
  // Entrance void — flat black plane on the front. Slight glow rim around it.
  const entrance = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 1.4),
    new THREE.MeshBasicMaterial({ color: 0x080404, side: THREE.DoubleSide }),
  );
  entrance.position.set(0, 0.72, 1.62);
  g.add(entrance);
  // Two angled support stakes flanking the entrance
  for (const x of [-1.05, 1.05]) {
    const stake = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 1.55, 6),
      _matStandard(0x4a3220, 0.9, 0.05),
    );
    stake.position.set(x, 0.78, 1.3);
    stake.rotation.z = (x < 0) ? -0.18 : 0.18;
    stake.castShadow = true;
    g.add(stake);
  }
  // Tiny slot cabinet peeking out of the entrance — three-box stack (chassis,
  // window-pane, knob). Reads as "there's a real machine in there".
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.75, 0.4),
    _matStandard(0x2a2018, 0.6, 0.25),
  );
  cab.position.set(0, 0.37, 1.5);
  cab.castShadow = true;
  g.add(cab);
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.28),
    new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  pane.position.set(0, 0.55, 1.71);
  pane.layers.enable(BLOOM_LAYER);
  g.add(pane);
  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xc23a3a, roughness: 0.4, metalness: 0.4 }),
  );
  knob.position.set(0.18, 0.25, 1.71);
  g.add(knob);
  }   // end procedural-fallback block (iter 33f)
  // Hanging lantern on a tiny mast off the apex — additive disc + point light.
  // Kept unconditional so the casino has a red night-glow either way.
  const lantern = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 12),
    new THREE.MeshBasicMaterial({
      map: tex('emberWarm'),
      color: 0xff3a3a, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  lantern.position.set(0, 2.85, 0.6);
  lantern.layers.enable(BLOOM_LAYER);
  g.add(lantern);
  _tentLanternMesh = lantern;
  _tentLight = new THREE.PointLight(0xff3a3a, 1.2, 6, 2);
  _tentLight.position.set(0, 2.5, 0.6);
  g.add(_tentLight);
  return g;
}

// Procedural cobblestone texture for the plaza floor — warm tan stones with a
// few soft-pink accents (kawaii identity) over dark grout, so the plaza reads
// as a cozy courtyard instead of a flat grey disc. Canvas-generated (no asset),
// tiled across the circle. Built once per buildTown.
function _makePlazaTexture() {
  const S = 256;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = S;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#463d31';            // grout (dark, for stone contrast)
  ctx.fillRect(0, 0, S, S);
  const cell = 40, gap = 5;
  // Warm mid tans — kept dark enough that the bright town dusk-light doesn't
  // wash them to grey (the flat-color version's problem).
  const tones = ['#8a7a5e', '#96876a', '#7e6f55', '#a1906f', '#72654e'];
  const round = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  let i = 0;
  for (let gy = -1; gy <= S / cell; gy++) {
    for (let gx = -1; gx <= S / cell; gx++) {
      const off = (gy & 1) ? cell / 2 : 0;
      const jx = Math.random() * 3, jy = Math.random() * 3;
      const x = gx * cell + off + gap / 2 + jx;
      const y = gy * cell + gap / 2 + jy;
      const w = cell - gap - jx, h = cell - gap - jy;
      const pink = (i * 7 + gx * 3 + gy) % 9 === 0;    // ~1 in 9 = soft-pink accent
      ctx.fillStyle = pink ? '#e49bc4' : tones[(i + gx + 5) % tones.length];
      round(x, y, w, h, 6); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';         // subtle top highlight
      round(x, y, w, h * 0.4, 6); ctx.fill();
      i++;
    }
  }
  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.anisotropy = 4;
  return tex;
}

export function buildTown(scene, heroCohortIds = null) {
  if (_group) return _group;
  const g = new THREE.Group();
  g.name = 'townGroup';

  // ── Plaza floor ──
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(PLAZA_R, 64),
    _makePlazaMaterial(),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = -0.05;
  plaza.receiveShadow = true;
  g.add(plaza);
  // Darker stone border ring
  const border = new THREE.Mesh(
    new THREE.RingGeometry(PLAZA_R, PLAZA_R + 1.2, 64),
    new THREE.MeshStandardMaterial({ color: 0x3c342c, roughness: 0.9 }),
  );
  border.rotation.x = -Math.PI / 2;
  border.position.y = -0.04;
  g.add(border);

  // ── Buildings + props ──
  const cabin = _makeCabin();
  cabin.position.set(0, 0, -14);
  g.add(cabin);

  const gate = _makeAdventureGate();
  gate.position.set(0, 0, 14);
  g.add(gate);

  const shopStall = _makeShopStall();
  shopStall.position.set(-12, 0, -3);
  shopStall.rotation.y = Math.PI / 6;
  g.add(shopStall);

  // Hellfire Brazier (iter 18) — beside the gate, offset east so it doesn't
  // compete with the gate's portal disc. Distinct from the statue arc which
  // spans roughly x∈[-7, 7], z=10.5±. The brazier sits at (8, 0, 12).
  _brazier = _makeBrazier();
  _brazier.position.set(8, 0, 12);
  g.add(_brazier);
  _interactables.push({
    pos: { x: 8, z: 12 }, radius: 2.6,
    label: '🔥  Hellfire Brazier · Force-trigger next run',
    key: 'brazier',
  });

  // Seedy Tent (Casino — iter 22B). Mirrored across the plaza from the shop
  // stall at (-12,-3): we plant the tent at (12,-3), face it inward toward the
  // hero spawn so the dark entrance reads as "come in here". Lock state is
  // resolved per-tick in tickTown (label flips on/off based on meta.unlockedVoid)
  // so the gate works even on save imports / mid-session unlocks.
  _tent = _makeSeedyTent();
  _tent.position.set(12, 0, -3);
  _tent.rotation.y = -Math.PI * 0.55;
  g.add(_tent);
  _interactables.push({
    pos: { x: 12, z: -3 }, radius: 2.8,
    label: '🎰  The Seedy Tent',
    key: 'casino',
    _casino: true,    // marker so tickTown can repaint label on cosmetic state changes
  });
  // Iter 33g — casino interactable now opens the walkable casino interior.
  // Handler installed by main.js via setInteractionHandler('casino', ...).
  _handlers.brazier = () => {
    // Persist across the town→run transition. helltide.js initHelltide() reads
    // and consumes the flag, scheduling the next event ~30s into the run
    // instead of the normal 4-6 min auto window.
    try { localStorage.setItem(HELLTIDE_QUEUED_KEY, 'true'); } catch (_) {}
    // Visual + audio feedback — ominous bell, brighter flames for 5 seconds.
    try { sfx.bossWarn(); } catch (_) {}
    _brazierIntenseUntil = state.time.real + 5;
    // Confirmation toast (DOM, similar shape to _kkShowMicroToast but
    // self-contained so town.js doesn't need to import ui internals).
    _showBrazierToast('🔥 Helltide queued for next run.');
  };

  // CC3 town cohort 1 — Grimoire lectern. Mirrored back-left of the plaza,
  // clear of gate(0,14) / house(0,-14) / shop(-12,-3) / casino(12,-3) /
  // brazier(8,12) / the statue arc (z≈10.5, x∈[-7,7]).
  const grimoire = _makeGrimoirePedestal();
  grimoire.position.set(-9, 0, -9);
  grimoire.rotation.y = Math.PI / 5;
  g.add(grimoire);
  _interactables.push({
    pos: { x: -9, z: -9 }, radius: 2.6,
    label: '📖  Grimoire · Evolution recipes',
    key: 'grimoire',
  });

  // CC3 town cohort 1 — wire the Shop + Grimoire interactables to their modals.
  // Dynamic import of ui.js (matches menuV2's _openGrimoire pattern) so town.js
  // doesn't pull ui internals into its module graph / risk a circular load.
  // Guarded with `if (!_handlers.x)` so an explicit main.js setInteractionHandler
  // override still wins.
  if (!_handlers.shop) {
    _handlers.shop = () => {
      import('./ui.js').then((m) => { try { m.showShop && m.showShop(); } catch (_) {} }).catch(() => {});
    };
  }
  if (!_handlers.grimoire) {
    _handlers.grimoire = () => {
      import('./ui.js').then((m) => { try { m.showGrimoire && m.showGrimoire(); } catch (_) {} }).catch(() => {});
    };
  }

  // MaoMao's Daycare cottage — cozy pet-sim building. Left side of the plaza,
  // clear of shop(-12,-3) / grimoire(-9,-9) / the statue arc (z≈10.5). Handler
  // dynamic-imports the 2D overlay (matches the shop/grimoire lazy pattern so
  // town.js doesn't pull daycare internals into its load graph up front).
  const daycare = _makeDaycareCottage();
  daycare.position.set(-12, 0, 7);
  daycare.rotation.y = -Math.PI / 2.6;   // angle the door toward plaza center
  g.add(daycare);
  _interactables.push({
    pos: { x: -12, z: 7 }, radius: 3.2,
    label: "🐾  MaoMao's Daycare",
    key: 'daycare',
  });
  if (!_handlers.daycare) {
    _handlers.daycare = () => {
      import('./daycare.js').then((m) => { try { m.showDaycare && m.showDaycare(); } catch (_) {} }).catch(() => {});
    };
  }
  // One physical virtual pet, not a menu-only portrait. Before adoption this
  // owns MaoMao's purposeful paw/yarn rescue trail; afterward it owns her
  // resident wander, visible outfit, and proximity care interaction.
  buildMaoMaoTown(g);

  // CC5 town cohort 2 — wandering sage NPC. Spawns near plaza center, off the
  // hero spawn (0,6) so it doesn't overlap the player on entry, then ambles the
  // open central floor and chatters via chatBubble.js.
  const npcGroup = _makeTownNpc();
  _npc = {
    group: npcGroup,
    pos: { x: -3, z: 1 },
    target: { x: 4, z: -2 },
    speed: 1.6,
    nextBarkAt: 0,
    firstBarkDone: false,
    barkIndex: 0,
  };
  npcGroup.position.set(_npc.pos.x, 0, _npc.pos.z);
  g.add(npcGroup);
  // Anchor the NPC's chat bubbles to its live (mutating) pos so the bubble
  // tracks it as it wanders. Head height ~2.0 (above the 1.7 ear tips).
  setSpeakerAnchor(NPC_SPEAKER_ID, { pos: _npc.pos, y: 2.0 });

  // CC6 town cohort 3 — biome gate dressing. Two themed planters flank the
  // Adventure Gate (z=14) at the approach; their emissive growth recolors to
  // preview the selected stage's biome. Placed clear of the statue arc (z≈10.5)
  // and the gate footprint.
  _gateBiomeMats = [];
  for (const px of [-3.0, 3.0]) {
    const planter = _makeGatePlanter();
    planter.position.set(px, 0, 12.4);
    g.add(planter);
    if (planter.userData._growthMat) _gateBiomeMats.push(planter.userData._growthMat);
  }
  _applyGateBiome(getMeta().selectedStage);

  // ── Townsfolk pool — clone the memory-capped unlocked cohort preloaded by
  // main.js. Clones own their geo+materials so a later run-start dispose can't
  // free them. Locked heroes and missing meshes never become interactables.
  // Locations are rerolled per visit; avatar picking remains in the carousel.
  _heroNpcs.length = 0;
  const heroCohort = Array.isArray(heroCohortIds) ? new Set(heroCohortIds) : null;
  for (const av of AVATARS) {
    if (!isAvatarUnlocked(av.id)) continue;
    if (heroCohort && !heroCohort.has(av.id)) continue;
    const group = _makeHeroNpc(av);
    // Never publish an empty NPC/interactable. A missing cache entry used to
    // produce exactly that: the hero could talk but had no visible geometry.
    if (!group.userData._figure) continue;
    group.name = 'townHero_' + av.id;
    group.visible = false;
    g.add(group);
    const pos = { x: 0, z: 0 };
    _heroNpcs.push({
      av, name: av.name, group, pos,
      target: { x: 0, z: 0 }, speed: 1.05 + Math.random() * 0.5,
      present: false, pauseUntil: 0, faceYaw: 0,
      barkIdx: (Math.random() * 999) | 0, nextBarkAt: 0,
    });
    // Anchor this speaker's chat bubbles to its live (mutating) position.
    setSpeakerAnchor('townnpc_' + av.id, { pos, y: 2.4 });
  }

  // Lamp posts at four corners
  for (const [x, z] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) {
    const lamp = _makeLamp();
    lamp.position.set(x, 0, z);
    g.add(lamp);
  }

  // Town fence ring — short stone posts every ~30°
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.9, 0.4),
      _matStandard(0x6a635a, 0.9),
    );
    post.position.set(Math.cos(a) * FENCE_R, 0.45, Math.sin(a) * FENCE_R);
    post.castShadow = true;
    g.add(post);
  }

  scene.add(g);
  _group = g;
  try { window.kkTownHeroesDebug = debugTownHeroes; } catch (_) {}

  // ── DOM interaction prompt ──
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-town-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 10px 22px; pointer-events: auto; cursor: pointer; touch-action: manipulation; z-index: 90;
      background: linear-gradient(180deg, rgba(28,22,18,0.92), rgba(18,14,12,0.92));
      border: 1px solid rgba(255,220,160,0.35); border-radius: 8px;
      color: #f4e6c4; font: 600 16px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08);
      backdrop-filter: blur(6px);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptEl.setAttribute('role', 'button');
    _promptEl.setAttribute('aria-label', 'Interact');
    _promptEl.addEventListener('pointerdown', (e) => { e.preventDefault(); _activateActive(); });
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
    window.addEventListener('keydown', _onKeyDown);
    initChatBindings();
  }

  g.visible = false;
  return g;
}

function _disposeProceduralTree(root) {
  if (!root) return;
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) if (material) materials.add(material);
  });
  for (const geometry of geometries) {
    try { geometry.dispose(); } catch (_) {}
  }
  for (const material of materials) {
    try { material.dispose(); } catch (_) {}
  }
}

// Casino assets load lazily. Upgrade only the fallback exterior when they
// arrive instead of rebuilding the Town and duplicating its lights and props.
export function refreshTownCasinoExterior() {
  if (!_group || !_tent || _tent.userData._usesCasinoGlb || !GLTF_CACHE.casino_building) return false;
  const oldTent = _tent;
  const upgraded = _makeSeedyTent();
  if (!upgraded.userData._usesCasinoGlb) return false;
  upgraded.position.copy(oldTent.position);
  upgraded.rotation.copy(oldTent.rotation);
  upgraded.scale.copy(oldTent.scale);
  _group.add(upgraded);
  _group.remove(oldTent);
  _disposeProceduralTree(oldTent);
  _tent = upgraded;
  return true;
}

// CC8 — gate-launch flourish. On E at the gate, flare the portal (disc swell +
// opacity + light spike, animated in tickTown) for GATE_FLOURISH_SEC, then run
// the real launch handler. A brief "whoosh into the adventure" beat instead of
// an instant cut; the voidTeleport sfx (0.95s whoosh+chime) carries across the
// transition. Guarded so a repeat E during the flare is a no-op.
function _triggerGateLaunch() {
  if (_gateLaunchPending) return;
  _gateLaunchPending = true;
  _gateFlourishUntil = state.time.real + GATE_FLOURISH_SEC;
  const launchId = ++_gateLaunchId;
  try { sfx.voidTeleport && sfx.voidTeleport(); } catch (_) {}
  _gateLaunchTimer = setTimeout(() => {
    if (launchId !== _gateLaunchId) return;
    _gateLaunchTimer = null;
    _gateLaunchPending = false;
    if (state.mode !== 'town' || state.time.paused) return;
    if (_onGateActivate) _onGateActivate();
  }, GATE_FLOURISH_SEC * 1000);
}

function _onKeyDown(e) {
  if (e.code !== 'Enter' || e.repeat || state.mode !== 'town' || state.time.paused) return;
  try { if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; } catch (_) {}
  _activateActive();
}

function _activateActive() {
  if (!_activeKey) return false;
  if (_activeKey === 'gate' && _onGateActivate) _triggerGateLaunch();
  else if (_activeKey.startsWith('talk:')) _talkTo(_activeKey.slice(5));
  else if (_activeKey.startsWith('maomao:')) activateMaoMaoInteraction(_activeKey);
  else if (_handlers[_activeKey]) _handlers[_activeKey]();
  else return false;
  return true;
}

export function cancelGateLaunch() {
  _gateLaunchId++;
  if (_gateLaunchTimer !== null) clearTimeout(_gateLaunchTimer);
  _gateLaunchTimer = null;
  _gateLaunchPending = false;
  _gateFlourishUntil = 0;
}

export function setGateHandler(fn) { _onGateActivate = fn; }
export function setInteractionHandler(key, fn) { _handlers[key] = fn; }

export function suspendTown() {
  cancelGateLaunch();
  if (_group) _group.visible = false;
  _hideTownChrome();
}

export function enterTown() {
  state.mode = 'town';
  if (_group) _group.visible = true;
  _hideTownChrome();
  // CC3 town cohort 1 — persistent visit state. Count town visits so future
  // cohorts (NPC greetings, "welcome back" dressing) can branch on first-vs-
  // returning. Persisted via meta so it survives reloads.
  try {
    const meta = getMeta();
    setOption('townVisits', ((meta && meta.townVisits) | 0) + 1);
  } catch (_) {}
  // Daily come-back gift — MaoMao leaves embers once per real-world day (cozy
  // retention hook; date-gated in meta so multiple town entries the same day
  // grant only once). Delayed a beat so it lands after the arrival settles.
  try {
    const gift = claimDailyGift();
    if (gift > 0) {
      setTimeout(() => {
        _showDaycareGiftToast(`🐱 MaoMao left you ${gift} embers while you were away! 💗`);
        try { sfx.heartPickup && sfx.heartPickup(); } catch (_) {}
      }, 700);
    }
  } catch (_) {}
  // Re-arm the sage NPC's greeting so the townVisits-keyed line re-lands on each
  // entry (visits 2+ get the "back again" variant). The counter was just bumped
  // above, so the variant reflects this visit.
  if (_npc) { _npc.firstBarkDone = false; _npc.nextBarkAt = 0; }
  // Refresh gate biome dressing — selectedStage may have changed since the last
  // town visit (stage is picked in menuV2).
  try { _applyGateBiome(getMeta().selectedStage); } catch (_) {}
  // Reset the gate-launch flare guard so a fresh town visit can re-trigger it.
  cancelGateLaunch();
  // Spawn just inside the plaza, facing the gate
  state.hero.pos.set(0, 0, 6);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, 1);
  // Re-roll which townsfolk are present + where they wander (different crew
  // each visit). No-op-safe if the pool is empty.
  try { _rollTownsfolk(); } catch (_) {}
  try { enterMaoMaoTown(); } catch (_) {}
  // Settle any pending Boss Rush Wager from the previous run. Dynamic import
  // so we don't pull casino.js into the town graph unconditionally — most
  // players never set a wager. settlePendingWager() is a no-op when the
  // localStorage flag is absent or the player hasn't unlocked the casino.
  try {
    import('./casino.js')
      .then(({ settlePendingWager }) => { try { settlePendingWager(); } catch (_) {} })
      .catch(() => {});
  } catch (_) {}
}

// Hide the town's ambient DOM UI — the interact prompt + all NPC chat bubbles.
// Called when a modal opens over the plaza or the player leaves the town, so
// this body-level UI (z 88-90) doesn't bleed over menus inside #ui-root (z 10).
function _hideTownChrome() {
  if (_promptEl) _promptEl.style.display = 'none';
  _activeKey = null;
  try { clearBubbles(); } catch (_) {}
}

export function exitTown() {
  state.mode = 'run';
  suspendTown();
}

export function isInTown() { return state.mode === 'town'; }

export function debugTownHeroes() {
  return _heroNpcs.map(npc => ({
    id: npc.av.id,
    name: npc.name,
    hasFigure: !!npc.group.userData._figure,
    present: !!npc.present,
    visible: !!npc.group.visible,
    childCount: npc.group.children.length,
  }));
}

// Iter 33h — let sibling sub-modes (casino interior, etc.) hide the town
// group while their own room is on-screen. Town's plaza disc (PLAZA_R=18)
// is wider than most interior rooms, so it can bleed past the room walls
// at the iso camera frustum's edges + show through any semi-transparent
// floor tile in the interior.
export function setTownGroupVisible(v) {
  if (_group) _group.visible = !!v;
  // Leaving the town foreground (interior / casino) — drop its chrome so stuck
  // bubbles + the interact prompt don't linger over the sub-room's UI.
  if (!v) _hideTownChrome();
}

function _activeSubRoomName() {
  if (state.mode === 'interior') return 'interiorGroup';
  if (state.mode === 'casino_interior') return 'casinoInteriorGroup';
  return null;
}

function _isUnderActiveSubRoomLight(o) {
  const keep = _activeSubRoomName();
  if (!keep) return false;
  let p = o;
  while (p) {
    if (p.name === keep) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Full overworld blackout for walkable sub-rooms (house / casino).
 * active=true → hide every top-level scene child except the active room + hero,
 * and zero non-room lights (Three.js still samples PointLights under invisible
 * parents). active=false → restore previous visibility + intensities.
 */
export function setOverworldForSubRoom(active) {
  // Town chrome (prompt / bubbles) always drops when leaving the plaza.
  if (active) _hideTownChrome();
  else setTownGroupVisible(true);

  const scene = state.scene || (state.envGroup && state.envGroup.parent) || (_group && _group.parent);
  if (!scene) {
    if (state.envGroup) state.envGroup.visible = !active;
    return;
  }

  const roomName = _activeSubRoomName();
  for (const c of scene.children) {
    if (c.name === 'heroGroup') {
      if (active) c.visible = true;
      continue;
    }
    if (c.name === 'interiorGroup' || c.name === 'casinoInteriorGroup') {
      // Only the active sub-room stays visible; the sibling parks hidden.
      if (active) c.visible = (c.name === roomName);
      continue;
    }
    if (active) {
      if (c.userData._hubSavedVis === undefined) c.userData._hubSavedVis = c.visible;
      c.visible = false;
    } else if (c.userData._hubSavedVis !== undefined) {
      c.visible = c.userData._hubSavedVis;
      delete c.userData._hubSavedVis;
    }
  }
  if (state.envGroup && active) state.envGroup.visible = false;

  // Light bleed: invisible parents do not mute lights in three.js.
  scene.traverse((o) => {
    if (!o.isLight) return;
    if (active) {
      if (_isUnderActiveSubRoomLight(o)) return;
      if (o.userData._hubSavedInt === undefined) o.userData._hubSavedInt = o.intensity;
      o.intensity = 0;
    } else if (o.userData._hubSavedInt !== undefined) {
      o.intensity = o.userData._hubSavedInt;
      delete o.userData._hubSavedInt;
    }
  });
}

export function tickTown(dt) {
  if (state.mode !== 'town') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    return;
  }

  // A town modal (Shop / Grimoire) is open over the plaza — suppress the town's
  // ambient DOM UI so the interact prompt + NPC chat bubbles don't render on top
  // of the menu (they're body-level; the menu lives inside #ui-root's stacking
  // context). Skip wander/barks/prompt while it's up.
  if (isShopOpen() || isGrimoireOpen() || isDaycareOpen()) { _hideTownChrome(); return; }

  // Wander the sage NPC (+ its bark scheduler) first so its bubble reads from
  // the NPC's current spot, then position + fade all speech bubbles.
  _tickNpc(dt);
  tickMaoMaoTown(dt);
  tickBubbles();

  // Animate portal — gentle scale pulse + opacity sine
  const t = state.time.real;
  if (_portal) {
    if (t < _gateFlourishUntil) {
      // CC8 launch flare — disc swells + brightens toward the cut (k: 0→1).
      const k = 1 - (_gateFlourishUntil - t) / GATE_FLOURISH_SEC;
      const s = 1 + 1.6 * k;
      _portal.scale.set(s, s, s);
      _portal.material.opacity = Math.min(1, 0.55 + 0.5 * k);
      if (_portalLight) _portalLight.intensity = 1.8 + 4.0 * k;
    } else {
      const s = 1 + 0.08 * Math.sin(t * 2.6);
      _portal.scale.set(s, s, s);
      _portal.material.opacity = 0.50 + 0.18 * Math.sin(t * 2.6 + 0.4);
      if (_portalLight) _portalLight.intensity = 1.8;
    }
  }
  // Townsfolk — the present subset wanders between waypoints (pausing at each),
  // faces travel direction with a walk-bob, and occasionally chats when the
  // player is nearby. Absent pool members are hidden + skipped. npc.pos is the
  // same object the talk-interactable reads, so the prompt tracks a moving hero.
  const hp = state.hero.pos;
  for (const npc of _heroNpcs) {
    if (!npc.present) continue;
    const grp = npc.group;
    if (t < npc.pauseUntil) {
      // Paused (idle / chatting) — gentle breathing bob, hold facing.
      grp.position.y = 0.035 * Math.sin(t * 1.6 + npc.barkIdx);
      grp.rotation.y = npc.faceYaw;
    } else {
      let dx = npc.target.x - npc.pos.x, dz = npc.target.z - npc.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.4) {
        // Reached the waypoint — pause, then head somewhere new.
        npc.pauseUntil = t + 1.5 + Math.random() * 2.5;
        const w = TOWNSFOLK_WAYPOINTS[(Math.random() * TOWNSFOLK_WAYPOINTS.length) | 0];
        npc.target.x = w[0]; npc.target.z = w[1];
        grp.position.y = 0;
      } else {
        const step = Math.min(npc.speed * dt, d);
        npc.pos.x += (dx / d) * step;
        npc.pos.z += (dz / d) * step;
        npc.faceYaw = Math.atan2(dx, dz);
        grp.position.x = npc.pos.x;
        grp.position.z = npc.pos.z;
        grp.position.y = 0.05 * Math.abs(Math.sin(t * 6 + npc.barkIdx));   // walk bob
        grp.rotation.y = npc.faceYaw;
      }
    }
    // Ambient chatter — only when the player is nearby, so bubbles don't pop
    // across an empty plaza. Staggered per-NPC to avoid a chorus.
    if (t >= npc.nextBarkAt) {
      const pdx = hp.x - npc.pos.x, pdz = hp.z - npc.pos.z;
      if (pdx * pdx + pdz * pdz < 81) _npcBark(npc);       // within ~9u
      npc.nextBarkAt = t + 14 + Math.random() * 12;
    }
  }

  // Seedy Tent — flickering red lantern (pulse + intensity wobble) + repaint
  // the casino interactable label whenever meta.unlockedVoid flips. Reading
  // getMeta() once per frame is cheap; we only mutate the label string when
  // the state actually changes (cached in _userData of the interactable).
  if (_tent && _tentLight) {
    const flicker = 1 + 0.18 * Math.sin(t * 9.2) + 0.10 * Math.sin(t * 21.5 + 0.7);
    _tentLight.intensity = 1.1 * flicker;
    if (_tentLanternMesh && _tentLanternMesh.material) {
      _tentLanternMesh.material.opacity = 0.85 + 0.15 * Math.sin(t * 6.1);
    }
  }
  // Casino is always unlocked as of iter 33e — no per-frame label repaint needed,
  // but we leave the iterator scaffolding here in case future state needs it.

  // Hellfire Brazier — bob/twist flames; "intense" window after a press makes
  // flames climb + light bleed brighter for ~5s as the confirmation cue.
  if (_brazier && _brazierFlames.length) {
    const intense = state.time.real < _brazierIntenseUntil;
    const climbBoost = intense ? 0.45 : 0;
    const scaleBoost = intense ? 1.35 : 1.0;
    for (const f of _brazierFlames) {
      const m = f.mesh;
      m.position.y = f.baseY + climbBoost + 0.08 * Math.sin(t * 4.5 + f.phase);
      m.rotation.y = Math.sin(t * 2.2 + f.phase) * 0.6;
      const flicker = 1 + 0.12 * Math.sin(t * 11 + f.phase * 2);
      m.scale.set(f.scale * scaleBoost * flicker, f.scale * scaleBoost * flicker, 1);
    }
    if (_brazierLight) {
      // Idle pulse ~1.2-1.7; intense pushes to 2.4-3.2.
      const base = intense ? 2.6 : 1.4;
      _brazierLight.intensity = base + 0.35 * Math.sin(t * 7.5);
    }
  }

  // Closest interactable inside its trigger radius
  const h = state.hero.pos;
  let best = null, bestD = Infinity;
  for (const it of _interactables) {
    const dx = h.x - it.pos.x;
    const dz = h.z - it.pos.z;
    const d2 = dx * dx + dz * dz;
    const r = it.radius;
    if (d2 < r * r && d2 < bestD) { best = it; bestD = d2; }
  }
  // MaoMao moves, so resolve her candidate dynamically instead of mutating
  // the static building/NPC interaction list every frame.
  const mao = getMaoMaoInteraction(h);
  if (mao && mao.d2 < bestD) { best = mao; bestD = mao.d2; }
  _activeKey = best ? best.key : null;
  if (state.input && state.input.interactPressed) {
    state.input.interactPressed = false;
    _activateActive();
    if (state.mode !== 'town') {
      if (_promptEl) _promptEl.style.display = 'none';
      return;
    }
  }
  if (best) {
    setPromptLabel(_promptBinding, best.label);
    _promptEl.style.display = 'block';
  } else {
    _promptEl.style.display = 'none';
  }
  // Constrain hero to fence — sliding clamp
  const r2 = h.x * h.x + h.z * h.z;
  const R = FENCE_R - 0.8;
  if (r2 > R * R) {
    const r = Math.sqrt(r2);
    h.x = (h.x / r) * R;
    h.z = (h.z / r) * R;
  }
}
