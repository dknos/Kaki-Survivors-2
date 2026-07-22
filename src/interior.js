/**
 * Cabin interior — top-down iso room the player walks into from the town
 * hub's House interactable. Holds room-level interactables that open the
 * existing meta menus (Renovation desk → showHouse()) and minigames
 * (Sketchbook stand → showSketchbook(), iteration 9).
 *
 * Architecturally a sibling to town.js — own Group, own interactable list,
 * own DOM prompt, own mode-branch in main.js. The hero is shared (same
 * mesh + input), but constrained to the room's floor.
 *
 * Camera is the same THREE.OrthographicCamera; main.js applies a tighter
 * offset when state.mode === 'interior' so the room feels close.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { getMeta } from './meta.js';
import { bindPrompt, setPromptLabel } from './buttonPrompts.js';
import { makeRuneRingTexture } from './enemyTells.js';
import {
  initHomeDecor, rebuildPlacements, syncHomeUnlocks,
  openDecorateMode, isDecorateActive, tickHomeDecor,
} from './homeDecor.js';
import { sfx } from './audio.js';
import { gamepadState } from './gamepad.js';
import { consumePadLevelUpConfirm } from './input.js';
import { setOverworldForSubRoom } from './town.js';
import { cloneCached } from './assets.js';
import { WORLD } from './config.js';

// Shared rune texture for interior FX (furnace ring). Lazy-cached.
let _runeTex = null;
function _getRuneTex() { return _runeTex || (_runeTex = makeRuneRingTexture()); }

// Room dimensions (in world units). Big-cozy overhaul: enlarged 14×11 → 20×15
// so the central floor is a genuinely ownable space. MUST stay in sync with
// homeDecor.js ROOM_W/ROOM_D + the grid/reserved-tile math over there.
const ROOM_W = 20;   // x
const ROOM_D = 15;   // z
const WALL_H = 4;
const DOOR_W = 2.6;

let _group = null;
let _promptEl = null;
let _promptBinding = null;
let _decoratePromptEl = null;    // ambient "H Decorate" hint when no fixture is nearby
let _activeKey = null;
const _handlers = {};
// Positions MUST match the relocated fixtures in buildInterior (big-cozy
// perimeter layout). Move a fixture → move its interactable here too.
let _homeUnlockTimers = [];
const _interactables = [
  { pos: { x: 0,    z: 6.6 }, radius: 1.8, label: '🚪  Leave the House',        key: 'exit'    },
  { pos: { x: -5.0, z: -6.2 }, radius: 2.2, label: '🛠  Renovations Desk',       key: 'house'   },
  { pos: { x:  5.0, z: -6.2 }, radius: 2.2, label: '✎  Sketchbook · trace a doodle', key: 'sketch'  },
  { pos: { x:  0,   z: -6.5 }, radius: 2.0, label: '☕  Tea Ceremony · perfect the pour', key: 'tea' },
  { pos: { x:  8.3, z:  5.8 }, radius: 2.0, label: '🧶  Yarn Toss · throw at baskets', key: 'yarn' },
  { pos: { x: -8.0, z:  5.8 }, radius: 2.0, label: '💻  Quest Board · check the terminal', key: 'computer' },
];

function _matStandard(color, roughness = 0.85, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function _makeFloor() {
  // Wide wooden plank floor — base mesh + 9 visible plank seams running along
  // the x-axis (the long room dimension). Iter 22A bumped seam count from
  // 3→9 and added a subtle plank-tone variation so the floor reads as wood
  // even before the player drops a rug on it.
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    _matStandard(0xb6864a, 0.85),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0;
  base.receiveShadow = true;
  g.add(base);
  // Plank seams — 9 strips, evenly spaced. Use AdditiveBlending: false on
  // these because we want them to darken the wood, not glow over it.
  const seamCount = 9;
  for (let i = 1; i < seamCount; i++) {
    const zPos = -ROOM_D / 2 + (i / seamCount) * ROOM_D;
    const seam = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W, 0.04),
      new THREE.MeshBasicMaterial({ color: 0x5a3a22, transparent: true, opacity: 0.55 }),
    );
    seam.rotation.x = -Math.PI / 2;
    seam.position.y = 0.006;
    seam.position.z = zPos;
    g.add(seam);
  }
  // Faint plank-tone variation — three darker strips at irregular intervals
  // to break up the uniform color and read as separate planks.
  for (const [zN, alpha] of [[-0.35, 0.16], [0.05, 0.12], [0.42, 0.18]]) {
    const tone = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_W, ROOM_D / seamCount),
      new THREE.MeshBasicMaterial({ color: 0x8a5a32, transparent: true, opacity: alpha }),
    );
    tone.rotation.x = -Math.PI / 2;
    tone.position.y = 0.004;
    tone.position.z = zN * ROOM_D;
    g.add(tone);
  }
  // Baseboard trim along all four walls — 0.16u tall, dark wood. Sells the
  // "this is a finished room, not a void" cue.
  const trimMat = _matStandard(0x3a2a1a, 0.85);
  const trimH = 0.18;
  const tNorth = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, trimH, 0.12), trimMat);
  tNorth.position.set(0, trimH / 2, -ROOM_D / 2 + 0.18);
  g.add(tNorth);
  const tSouth = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, trimH, 0.12), trimMat);
  tSouth.position.set(0, trimH / 2,  ROOM_D / 2 - 0.18);
  g.add(tSouth);
  const tEast = new THREE.Mesh(new THREE.BoxGeometry(0.12, trimH, ROOM_D), trimMat);
  tEast.position.set(ROOM_W / 2 - 0.18, trimH / 2, 0);
  g.add(tEast);
  const tWest = new THREE.Mesh(new THREE.BoxGeometry(0.12, trimH, ROOM_D), trimMat);
  tWest.position.set(-ROOM_W / 2 + 0.18, trimH / 2, 0);
  g.add(tWest);
  return g;
}

function _makeWindowShaft() {
  // Soft cool fill near the south wall — kept INSIDE the room (no long-range
  // additive beam that reads as "glowy shit outside"). A short non-additive
  // pool on the floor + a tight PointLight.
  const g = new THREE.Group();
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(1.4, 24),
    new THREE.MeshBasicMaterial({
      color: 0xc8d8f0, transparent: true, opacity: 0.12,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(2.2, 0.02, 4.2);
  g.add(pool);
  const winLight = new THREE.PointLight(0xa8c4e8, 0.35, 6, 2);
  winLight.position.set(2.2, 2.2, 4.2);
  g.add(winLight);
  return g;
}

/** Dark void shell under/around the room so any leftover overworld never peeks. */
function _makeExteriorShell() {
  const g = new THREE.Group();
  g.name = 'interiorExteriorShell';
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x120e0c });
  // Large ground disc under the room (below floor so floor wins in the center)
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48), voidMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.08;
  g.add(ground);
  // Four tall backdrop walls just outside the room walls — occlude iso bleed
  const shellH = 10;
  const shellMat = new THREE.MeshBasicMaterial({ color: 0x1a1410, side: THREE.DoubleSide });
  const pad = 0.6;
  const n = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W + 4, shellH), shellMat);
  n.position.set(0, shellH / 2, -ROOM_D / 2 - pad);
  g.add(n);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W + 4, shellH), shellMat);
  s.position.set(0, shellH / 2, ROOM_D / 2 + pad);
  s.rotation.y = Math.PI;
  g.add(s);
  const e = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_D + 4, shellH), shellMat);
  e.position.set(ROOM_W / 2 + pad, shellH / 2, 0);
  e.rotation.y = -Math.PI / 2;
  g.add(e);
  const w = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_D + 4, shellH), shellMat);
  w.position.set(-ROOM_W / 2 - pad, shellH / 2, 0);
  w.rotation.y = Math.PI / 2;
  g.add(w);
  return g;
}

/**
 * Static ambient GLB furniture (not player-placed). Sits on the perimeter so
 * the decorate grid stays free. Retries on enter if kits were still loading.
 */
function _ensureAmbientProps(parent) {
  if (!parent) return;
  let ambient = parent.getObjectByName('interiorAmbient');
  if (!ambient) {
    ambient = new THREE.Group();
    ambient.name = 'interiorAmbient';
    parent.add(ambient);
  }
  // Spec: key, scale, x, z, rotY, elev — all outside the 16×12 decorate grid.
  const specs = [
    { key: 'home_sofa',       scale: 1.7,  x:  8.4, z:  0.5,  rotY: -Math.PI / 2, elev: 0 },
    { key: 'home_bookshelf',  scale: 2.0,  x:  8.5, z: -4.2,  rotY: -Math.PI / 2, elev: 0 },
    { key: 'home_plant',      scale: 0.014, x:  7.2, z:  5.6,  rotY: 0.4, elev: 0 },
    { key: 'home_chair',      scale: 1.5,  x: -3.2, z: -5.4,  rotY: 0.35, elev: 0 },
    { key: 'home_lamp',       scale: 1.4,  x: -7.4, z: -2.8,  rotY: 0.2, elev: 0 },
    { key: 'home_side_table', scale: 1.4,  x:  6.8, z: -5.8,  rotY: 0, elev: 0 },
    { key: 'home_cat',        scale: 1.3,  x:  7.0, z:  1.8,  rotY: -1.1, elev: 0 },
  ];
  let placed = 0;
  for (const s of specs) {
    const tag = `ambient_${s.key}`;
    if (ambient.getObjectByName(tag)) { placed++; continue; }
    const kit = cloneCached(s.key);
    if (!kit) continue;
    kit.name = tag;
    kit.scale.setScalar(s.scale);
    kit.position.set(s.x, s.elev || 0, s.z);
    kit.rotation.y = s.rotY || 0;
    // Soft emissive bump on the lamp only — material bake, no extra PointLight.
    if (s.key === 'home_lamp') {
      kit.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && m.emissive && typeof m.emissive.setHex === 'function') {
            m.emissive.setHex(0xffd28a);
            m.emissiveIntensity = 0.55;
          }
        }
      });
    }
    ambient.add(kit);
    placed++;
  }
  return placed;
}

function _makeWall(w, h, color = 0xe9d6a8) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.25),
    _matStandard(color, 0.9),
  );
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function _makeRenovationsDesk() {
  const g = new THREE.Group();
  // Desktop slab
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 1.2), _matStandard(0x6a4830, 0.7));
  top.position.y = 0.9;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // 4 legs
  for (const [x, z] of [[-0.95, -0.45],[0.95, -0.45],[-0.95, 0.45],[0.95, 0.45]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.12), _matStandard(0x4a2f1c, 0.85));
    leg.position.set(x, 0.45, z);
    g.add(leg);
  }
  // Toolbox on top (small box, brass-tinted)
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.42), _matStandard(0xc98a3a, 0.6, 0.3));
  box.position.set(-0.5, 1.16, 0);
  box.castShadow = true;
  g.add(box);
  // Floorplan paper roll
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 12), _matStandard(0xf3e8cf, 0.85));
  roll.rotation.z = Math.PI / 2;
  roll.position.set(0.5, 1.05, 0);
  g.add(roll);
  return g;
}

function _makeSketchbookStand() {
  const g = new THREE.Group();
  // Easel base — A-frame triangle
  for (const x of [-0.45, 0.45]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.10, 2.0, 0.10), _matStandard(0x4a2f1c, 0.85));
    leg.position.set(x, 1.0, 0);
    leg.rotation.z = (x < 0 ? 1 : -1) * 0.14;
    leg.castShadow = true;
    g.add(leg);
  }
  // Cross bar
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.10, 0.10), _matStandard(0x4a2f1c, 0.85));
  bar.position.set(0, 1.55, 0);
  g.add(bar);
  // Canvas / sketchbook — paper-tinted plane
  const canvas = new THREE.Mesh(
    new THREE.PlaneGeometry(0.92, 1.18),
    new THREE.MeshStandardMaterial({ color: 0xf3e8cf, roughness: 0.95, metalness: 0.0 }),
  );
  canvas.position.set(0, 1.45, 0.06);
  canvas.castShadow = true;
  g.add(canvas);
  // Sketched lines on the canvas (decoration)
  for (const [x1, y1, x2, y2] of [[-0.3, 0.2, 0.3, 0.1], [-0.2, -0.2, 0.25, -0.3], [-0.1, 0.4, 0.15, 0.3]]) {
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x231a14 }),
    );
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    line.position.set(cx, 1.45 + cy, 0.065);
    line.rotation.z = Math.atan2(y2 - y1, x2 - x1);
    g.add(line);
  }
  return g;
}

function _makeTeaKettle() {
  const g = new THREE.Group();
  // Stove top
  const stove = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 1.0), _matStandard(0x3a3a44, 0.7, 0.4));
  stove.position.y = 0.35;
  stove.castShadow = true;
  g.add(stove);
  // Burner ring — warm ember disc under the kettle. No additive / bloom so
  // it stays a cozy stove, not a combat rune leaking glow past the wall.
  const ringGeo = new THREE.PlaneGeometry(0.50, 0.50);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({
      map: _getRuneTex(),
      color: 0xff8a4a, transparent: true, opacity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  ring.position.y = 0.72;
  ring.userData._spin = 0.35; // rad/sec — read by tickInterior
  g.userData._furnaceRing = ring;
  g.add(ring);
  // Kettle body — squat sphere
  const kettle = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 16, 10),
    _matStandard(0xc98a3a, 0.5, 0.5),
  );
  kettle.scale.set(1, 0.85, 1);
  kettle.position.y = 0.95;
  kettle.castShadow = true;
  g.add(kettle);
  // Spout
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.4, 8), _matStandard(0xc98a3a, 0.5, 0.5));
  spout.rotation.z = -Math.PI / 3;
  spout.position.set(0.32, 1.1, 0);
  g.add(spout);
  // Handle (curved torus segment)
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.025, 8, 16, Math.PI), _matStandard(0x4a2f1c, 0.85));
  handle.rotation.x = Math.PI / 2;
  handle.position.set(0, 1.22, 0);
  g.add(handle);
  return g;
}

// 90s computer setup — wood desk, beige CRT, keyboard, mouse, glowing screen.
// Lain Navi variant (state.lain === true) is a darker translucent egg with
// multiple monitors, evoking the Serial Experiments Lain terminal.
function _makeComputerDesk(lain = false) {
  const g = new THREE.Group();
  // Desk top + 4 legs
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.2), _matStandard(0x6a4830, 0.7));
  top.position.y = 0.85;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  for (const [x, z] of [[-1.05, -0.50],[1.05, -0.50],[-1.05, 0.50],[1.05, 0.50]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.85, 0.12), _matStandard(0x4a2f1c, 0.85));
    leg.position.set(x, 0.42, z);
    g.add(leg);
  }
  if (lain) {
    // ── Lain Navi terminal ──
    // Translucent acrylic egg case with a soft cyan internal glow.
    const eggCase = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 18),
      new THREE.MeshStandardMaterial({
        color: 0xc8d8ff, roughness: 0.15, metalness: 0.05,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide,
      }),
    );
    eggCase.scale.set(1.0, 1.15, 1.0);
    eggCase.position.set(0, 1.35, -0.12);
    g.add(eggCase);
    // Internal core (visible through acrylic)
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x4fd0ff, emissive: 0x4fd0ff, emissiveIntensity: 0.7, roughness: 0.4 }),
    );
    core.position.set(0, 1.35, -0.12);
    g.add(core);
    // Three flat monitors arranged in an arc
    for (let i = -1; i <= 1; i++) {
      const mon = new THREE.Mesh(
        new THREE.PlaneGeometry(0.65, 0.45),
        new THREE.MeshStandardMaterial({
          color: 0x0a0e14, emissive: 0x3aa8cc, emissiveIntensity: 0.35, roughness: 0.4,
        }),
      );
      mon.position.set(i * 0.7, 1.30, 0.30);
      mon.rotation.y = -i * 0.30;
      g.add(mon);
      // Bezel
      const bez = new THREE.Mesh(
        new THREE.PlaneGeometry(0.72, 0.52),
        new THREE.MeshStandardMaterial({ color: 0x18181f, roughness: 0.55 }),
      );
      bez.position.set(i * 0.7, 1.30, 0.295);
      bez.rotation.y = -i * 0.30;
      g.add(bez);
    }
    // Cool cyan accent — short range, desk only
    const pl = new THREE.PointLight(0x4fd0ff, 0.45, 3, 2);
    pl.position.set(0, 1.6, -0.1);
    g.add(pl);
    g.userData._coreGlow = core;
  } else {
    // ── 90s beige CRT ──
    // Big chunky beige monitor with a green-on-black screen.
    const crtCase = new THREE.Mesh(
      new THREE.BoxGeometry(1.10, 0.95, 1.05),
      _matStandard(0xd9cca0, 0.85),
    );
    crtCase.position.set(0, 1.40, -0.05);
    crtCase.castShadow = true;
    g.add(crtCase);
    // Screen face — soft green phosphor, low emissive (no neon billboard)
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.78, 0.62),
      new THREE.MeshStandardMaterial({
        color: 0x0a1a0a, emissive: 0x1a8844, emissiveIntensity: 0.35, roughness: 0.55,
      }),
    );
    screen.position.set(0, 1.42, 0.48);
    g.add(screen);
    g.userData._screen = screen;
    // Speaker grille (two notches under the case)
    for (const sx of [-0.42, 0.42]) {
      const grille = new THREE.Mesh(
        new THREE.PlaneGeometry(0.18, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x4a4232, roughness: 0.9 }),
      );
      grille.position.set(sx, 1.05, 0.55);
      g.add(grille);
    }
    // Tower (PC case on the floor next to the desk)
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.78, 0.62),
      _matStandard(0xece2c2, 0.8),
    );
    tower.position.set(1.45, 0.39, 0);
    tower.castShadow = true;
    g.add(tower);
    // Tower power LED — tiny, no room-wide green cast
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 6, 4),
      new THREE.MeshStandardMaterial({ color: 0x2aff66, emissive: 0x2aff66, emissiveIntensity: 0.9 }),
    );
    led.position.set(1.45, 0.55, 0.32);
    g.add(led);
    // Soft green accent — short range so it stays on the desk
    const pl = new THREE.PointLight(0x2aff66, 0.25, 2.5, 2);
    pl.position.set(0, 1.6, 0.5);
    g.add(pl);
  }
  // Keyboard — flat box with key strip
  const kb = new THREE.Mesh(
    new THREE.BoxGeometry(1.20, 0.06, 0.40),
    _matStandard(lain ? 0x1a1a22 : 0xc8bda0, 0.85),
  );
  kb.position.set(0, 0.94, 0.42);
  g.add(kb);
  // Key strip (a darker plane on top)
  const keys = new THREE.Mesh(
    new THREE.PlaneGeometry(1.05, 0.30),
    new THREE.MeshStandardMaterial({ color: lain ? 0x0a0e14 : 0x8a826a, roughness: 0.7 }),
  );
  keys.rotation.x = -Math.PI / 2;
  keys.position.set(0, 0.98, 0.42);
  g.add(keys);
  // Mouse
  const mouse = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.05, 0.22),
    _matStandard(lain ? 0x1a1a22 : 0xc8bda0, 0.85),
  );
  mouse.position.set(0.78, 0.94, 0.42);
  g.add(mouse);
  return g;
}

function _makeYarnBasket() {
  const g = new THREE.Group();
  // Wicker bowl — wide flat cylinder
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.45, 0.40, 18),
    _matStandard(0xd99b54, 0.85),
  );
  bowl.position.y = 0.20;
  bowl.castShadow = true; bowl.receiveShadow = true;
  g.add(bowl);
  // Rim
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.06, 8, 18),
    _matStandard(0xc98a3a, 0.7),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.40;
  g.add(rim);
  // Three yarn balls sitting in the bowl
  const colors = [0xe8a3c7, 0x8aaa6a, 0xc98a3a];
  const positions = [[0.0, 0.55, 0.0], [-0.20, 0.55, 0.15], [0.20, 0.50, -0.10]];
  for (let i = 0; i < 3; i++) {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.75 }),
    );
    ball.position.set(...positions[i]);
    ball.castShadow = true;
    g.add(ball);
  }
  return g;
}

function _makeFireplace() {
  const g = new THREE.Group();
  // Hearth box (chimney)
  const hearth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.2, 0.8), _matStandard(0x5a4338, 0.95));
  hearth.position.y = 1.6;
  hearth.castShadow = true; hearth.receiveShadow = true;
  g.add(hearth);
  // Cavity (dark recessed box)
  const cavity = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 0.4), new THREE.MeshStandardMaterial({ color: 0x0a0608, roughness: 1 }));
  cavity.position.set(0, 0.8, 0.22);
  g.add(cavity);
  // Ember log + contained firelight (lower intensity, short range)
  const log = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 1.0, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a3a18, emissive: 0xff6a28, emissiveIntensity: 0.55 }),
  );
  log.rotation.z = Math.PI / 2;
  log.position.set(0, 0.4, 0.32);
  g.add(log);
  const flLight = new THREE.PointLight(0xff7a3a, 0.9, 5, 2);
  flLight.position.set(0, 0.9, 0.45);
  g.add(flLight);
  g.userData._fireLight = flLight;
  return g;
}

export function buildInterior(scene) {
  if (_group) return _group;
  const g = new THREE.Group();
  g.name = 'interiorGroup';
  g.visible = false;

  // Dark exterior shell first (renders under/around the room)
  g.add(_makeExteriorShell());

  // ── Floor ──
  g.add(_makeFloor());

  // ── Walls (cream plaster + wood wainscot so they don't read as flat boxes) ──
  const wallColor = 0xe8d8b8;
  const wainscotH = 1.15;
  const wainscotMat = _matStandard(0x6a4830, 0.85);
  const railMat = _matStandard(0x4a2f1c, 0.8);

  function _addWainscot(wallMesh, alongX) {
    // Lower wood panel + chair rail on the inward face of a wall mesh.
    const wx = wallMesh.position.x, wz = wallMesh.position.z;
    if (alongX) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(wallMesh.geometry.parameters.width, wainscotH, 0.06),
        wainscotMat,
      );
      // Nudge inward toward room center on z
      const inward = wz < 0 ? 0.16 : -0.16;
      panel.position.set(wx, wainscotH / 2, wz + inward);
      g.add(panel);
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(wallMesh.geometry.parameters.width, 0.08, 0.08),
        railMat,
      );
      rail.position.set(wx, wainscotH, wz + inward);
      g.add(rail);
    } else {
      const depth = wallMesh.geometry.parameters.depth;
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, wainscotH, depth),
        wainscotMat,
      );
      const inward = wx < 0 ? 0.16 : -0.16;
      panel.position.set(wx + inward, wainscotH / 2, wz);
      g.add(panel);
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.08, depth),
        railMat,
      );
      rail.position.set(wx + inward, wainscotH, wz);
      g.add(rail);
    }
  }

  // Back wall (-z)
  const back = _makeWall(ROOM_W, WALL_H, wallColor);
  back.position.set(0, WALL_H / 2, -ROOM_D / 2);
  g.add(back);
  _addWainscot(back, true);
  // Left wall (-x)
  const left = _makeWall(0.25, WALL_H, wallColor);
  left.geometry = new THREE.BoxGeometry(0.25, WALL_H, ROOM_D);
  left.position.set(-ROOM_W / 2, WALL_H / 2, 0);
  g.add(left);
  _addWainscot(left, false);
  // Right wall (+x)
  const right = _makeWall(0.25, WALL_H, wallColor);
  right.geometry = new THREE.BoxGeometry(0.25, WALL_H, ROOM_D);
  right.position.set(ROOM_W / 2, WALL_H / 2, 0);
  g.add(right);
  _addWainscot(right, false);
  // Front wall (+z) with door gap
  const halfDoor = DOOR_W / 2;
  const sideW = (ROOM_W - DOOR_W) / 2;
  const frontL = _makeWall(sideW, WALL_H, wallColor);
  frontL.position.set(-(sideW / 2 + halfDoor), WALL_H / 2, ROOM_D / 2);
  g.add(frontL);
  _addWainscot(frontL, true);
  const frontR = _makeWall(sideW, WALL_H, wallColor);
  frontR.position.set((sideW / 2 + halfDoor), WALL_H / 2, ROOM_D / 2);
  g.add(frontR);
  _addWainscot(frontR, true);
  // Lintel above door
  const lintel = _makeWall(DOOR_W + 0.25, WALL_H * 0.32, wallColor);
  lintel.position.set(0, WALL_H - 0.6, ROOM_D / 2);
  g.add(lintel);

  // Ceiling beams — three cross-beams sell "roof" without a full ceiling mesh
  // that would hide the iso view.
  const beamMat = _matStandard(0x4a2f1c, 0.85);
  for (const z of [-4, 0, 4]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W - 0.4, 0.16, 0.28), beamMat);
    beam.position.set(0, WALL_H - 0.2, z);
    g.add(beam);
  }

  // ── Furniture ──
  // Big-cozy layout: every functional fixture hugs the perimeter (back wall +
  // corners) so the whole central floor is open for the decorate grid. Reserved
  // tiles in homeDecor.js are keyed to THESE coords — move one, move both.
  const desk = _makeRenovationsDesk();
  desk.position.set(-5.0, 0, -6.2);   // back wall, left
  desk.rotation.y = 0.12;
  g.add(desk);

  const easel = _makeSketchbookStand();
  easel.position.set(5.0, 0, -6.2);   // back wall, right
  easel.rotation.y = -0.12;
  g.add(easel);

  const kettle = _makeTeaKettle();
  kettle.position.set(0, 0, -6.5);    // back wall, center
  g.add(kettle);

  const fireplace = _makeFireplace();
  fireplace.position.set(-ROOM_W / 2 + 0.4, 0, 0);   // west wall, center
  fireplace.rotation.y = Math.PI / 2;
  g.add(fireplace);

  // Yarn basket — stacked balls in a wicker bowl, south-east corner
  const yarnBasket = _makeYarnBasket();
  yarnBasket.position.set(8.3, 0, 5.8);
  g.add(yarnBasket);

  // Computer desk (90s CRT by default; Lain Navi when upgrade owned). SW corner.
  const lainOwned = !!(getMeta().quests && getMeta().quests.lainTerminal);
  const computer = _makeComputerDesk(lainOwned);
  computer.position.set(-8.0, 0, 5.8);
  computer.rotation.y = -Math.PI / 5;
  g.add(computer);
  g.userData._computer = computer;
  g.userData._computerVariant = lainOwned;

  // Soft window pool on the south wall (no additive outside-room bleed).
  g.add(_makeWindowShaft());

  // Ambient GLB furniture if kits already cached (retry on enter).
  try { _ensureAmbientProps(g); } catch (_) {}

  // ── Ambient lighting (warm, contained — short ranges so nothing lights the void) ──
  const fill = new THREE.PointLight(0xffd4a0, 0.72, 16, 2);
  fill.position.set(0, 3.4, 0);
  g.add(fill);
  const kicker = new THREE.PointLight(0x9bb6e8, 0.22, 8, 2);
  kicker.position.set(-ROOM_W / 2 + 1.5, 2.8, -ROOM_D / 2 + 1.5);
  g.add(kicker);
  const hearthWarm = new THREE.PointLight(0xffae6a, 0.4, 7, 2);
  hearthWarm.position.set(-ROOM_W / 2 + 1.5, 2.0, 0);
  g.add(hearthWarm);
  const eastWarm = new THREE.PointLight(0xffc27a, 0.28, 7, 2);
  eastWarm.position.set(ROOM_W / 2 - 2, 2.4, 2.0);
  g.add(eastWarm);

  // Hide initially — only visible when state.mode === 'interior'
  // Stash far below world; toggling .visible alone leaves lights affecting other modes.
  g.position.y = -200;
  scene.add(g);
  _group = g;

  // ── Iter 22A: cozy-home decor layer ──
  // initHomeDecor attaches a sibling group inside `g` that holds every
  // player-placed item. rebuildPlacements is called on every enter so the
  // room re-reads meta.homePlacements (so a fresh achievement-unlock seen
  // in town immediately materializes the next time the player walks in).
  initHomeDecor(g);

  // ── DOM prompt ──
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-interior-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 10px 22px; pointer-events: none; z-index: 90;
      background: linear-gradient(180deg, rgba(243,232,207,0.95), rgba(217,202,170,0.92));
      border: 1px solid rgba(35,26,20,0.55); border-radius: 8px;
      color: #231a14; font: 600 16px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.4);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
    window.addEventListener('keydown', _onKeyDown);
  }
  // Iter 22A — ambient "H · Decorate" hint pinned to the bottom-right so it
  // doesn't fight with the centered interactable prompt. Always visible
  // while inside, dimmed when no decorate-eligible state, hidden during
  // decorate mode (overlay covers its own UI).
  if (!_decoratePromptEl) {
    _decoratePromptEl = document.createElement('div');
    _decoratePromptEl.id = 'kk-interior-decorate-hint';
    _decoratePromptEl.style.cssText = `
      position: fixed; bottom: 14%; right: 24px;
      padding: 8px 16px; pointer-events: none; z-index: 89;
      background: linear-gradient(180deg, rgba(20,28,22,0.86), rgba(8,14,12,0.92));
      border: 1px solid rgba(255,232,188,0.18); border-radius: 8px;
      color: #f5efe1; font: 500 13px 'Inter', system-ui, sans-serif;
      letter-spacing: 0.16em; text-transform: uppercase;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55);
      display: none;
    `;
    _decoratePromptEl.innerHTML = _decorateHintHtml();
    document.body.appendChild(_decoratePromptEl);
  }
  return g;
}

// Ambient decorate-hint text. Only surface the gamepad [Y] glyph when a pad is
// actually connected — a mouse+keyboard player shouldn't see controller prompts.
function _decorateHintHtml() {
  return gamepadState.connected
    ? '<b style="color:#ffd27f;">H</b> / <b style="color:#ffd27f;">[Y]</b> · Decorate'
    : '<b style="color:#ffd27f;">H</b> · Decorate';
}

function _onKeyDown(e) {
  if (state.mode !== 'interior') return;
  // Iter 22A — H opens the decorate overlay. We intercept BEFORE the
  // interact-key check so the player can hit H whether or not they're
  // standing on an interactable. homeDecor.js handles its own ESC/H exit.
  if (e.code === 'KeyH' && !isDecorateActive()) {
    e.preventDefault();
    openDecorateMode();
    return;
  }
  // While decorate mode is open, the regular interactable keybind is dead.
  if (isDecorateActive()) return;
  if (e.code === 'Enter' && !e.repeat && !state.time.paused) {
    try { if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; } catch (_) {}
    _activateActive();
  }
}

function _activateActive() {
  if (!_activeKey) return;
  if (_activeKey === 'exit') { _handlers.exit && _handlers.exit(); return; }
  if (_handlers[_activeKey]) _handlers[_activeKey]();
}

// ── Iter 22A — one-shot unlock toast for newly-granted home items ──────────
// Mirrors the _kkShowMicroToast cadence in ui.js (1.4s top-center pulse) so
// the player gets the same "achievement-style" cue without us coupling to
// ui.js (which is in our scope but kept thin per the brief).
function _showHomeUnlockToast(itemDef) {
  const toast = document.createElement('div');
  const flavor = itemDef.flavor ? ` — ${itemDef.flavor}` : '';
  toast.textContent = `🎁 Unlocked: ${itemDef.name}${flavor}`;
  toast.style.cssText = `
    position: fixed; left: 50%; top: 16%;
    transform: translateX(-50%);
    padding: 10px 22px;
    background: linear-gradient(180deg, rgba(28,36,30,0.96), rgba(14,20,16,0.98));
    border: 1px solid #ffd27f;
    border-radius: 8px;
    color: #ffd27f;
    font: 600 14px 'Inter', system-ui, sans-serif;
    letter-spacing: 0.14em; text-transform: uppercase;
    text-shadow: 0 0 6px rgba(255,210,127,0.45);
    box-shadow: 0 8px 22px rgba(0,0,0,0.55), 0 0 18px rgba(255,210,127,0.28);
    pointer-events: none;
    z-index: 250;
    animation: kk-fade-in 0.22s ease-out;
  `;
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 2400);
}

export function setInteriorHandler(key, fn) { _handlers[key] = fn; }

function _disposeOwnedComputer(root) {
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

function _syncComputerVariant() {
  if (!_group) return;
  const lainOwned = !!(getMeta().quests && getMeta().quests.lainTerminal);
  if (_group.userData._computer && _group.userData._computerVariant === lainOwned) return;
  const oldComputer = _group.userData._computer;
  if (oldComputer) {
    if (oldComputer.parent) oldComputer.parent.remove(oldComputer);
    _disposeOwnedComputer(oldComputer);
  }
  const computer = _makeComputerDesk(lainOwned);
  computer.position.set(-8.0, 0, 5.8);
  computer.rotation.y = -Math.PI / 5;
  _group.add(computer);
  _group.userData._computer = computer;
  _group.userData._computerVariant = lainOwned;
}

export function enterInterior() {
  state.mode = 'interior';
  // Full overworld blackout — forest grass + glow orbs + outdoor lights were
  // bleeding past the short dollhouse walls (casino already had a partial fix).
  try { setOverworldForSubRoom(true); } catch (_) {}
  // Warm dark backdrop while indoors (forest green bg made the void feel outdoor)
  try {
    if (state.scene) {
      if (state.scene.userData._hubSavedBg === undefined && state.scene.background) {
        state.scene.userData._hubSavedBg = state.scene.background.clone
          ? state.scene.background.clone()
          : state.scene.background;
      }
      state.scene.background = new THREE.Color(0x1a120e);
      if (state.scene.fog) {
        if (state.scene.userData._hubSavedFogNear === undefined) {
          state.scene.userData._hubSavedFogNear = state.scene.fog.near;
          state.scene.userData._hubSavedFogFar = state.scene.fog.far;
          state.scene.userData._hubSavedFogColor = state.scene.fog.color.clone();
        }
        state.scene.fog.color.setHex(0x1a120e);
        state.scene.fog.near = 40;
        state.scene.fog.far = 90;
      }
    }
  } catch (_) {}
  if (_group) {
    _group.visible = true;
    _group.position.y = 0;
    // Reuse the desk on repeat visits; replace and dispose it only when the
    // Lain upgrade changes.
    _syncComputerVariant();
    // Kits may have finished loading since last visit — place ambient GLBs.
    try { _ensureAmbientProps(_group); } catch (_) {}
  }
  // Iter 22A — sync home-item unlocks (any new achievements since last visit
  // immediately grant their tied item), then re-instantiate every persisted
  // placement so the room reflects the saved state. Newly-unlocked items
  // toast one at a time with a 400ms stagger so a back-to-back unlock spree
  // (first-run player popping multiple achievements on the same return)
  // reads as a celebration, not a wall of text.
  try {
    const granted = syncHomeUnlocks();
    for (const timer of _homeUnlockTimers) clearTimeout(timer);
    _homeUnlockTimers = granted.map((def, i) => setTimeout(() => {
        try { sfx.modalOpen(); } catch (_) {}
        _showHomeUnlockToast(def);
      }, 400 * (i + 1)));
    rebuildPlacements();
  } catch (e) { /* never block enter on decor errors */ }
  // Refresh the decorate hint's glyphs for the current input device.
  if (_decoratePromptEl) _decoratePromptEl.innerHTML = _decorateHintHtml();
  // Spawn at the door (south end of the room)
  state.hero.pos.set(0, 0, ROOM_D / 2 - 2);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, -1);
}

export function exitInterior() {
  state.mode = 'town';
  if (_group) {
    _group.visible = false;
    _group.position.y = -200;
  }
  try { setOverworldForSubRoom(false); } catch (_) {}
  // Restore outdoor sky / fog
  try {
    if (state.scene) {
      if (state.scene.userData._hubSavedBg !== undefined) {
        state.scene.background = state.scene.userData._hubSavedBg;
        delete state.scene.userData._hubSavedBg;
      } else {
        state.scene.background = new THREE.Color(WORLD.bgColor);
      }
      if (state.scene.fog && state.scene.userData._hubSavedFogNear !== undefined) {
        state.scene.fog.near = state.scene.userData._hubSavedFogNear;
        state.scene.fog.far = state.scene.userData._hubSavedFogFar;
        state.scene.fog.color.copy(state.scene.userData._hubSavedFogColor);
        delete state.scene.userData._hubSavedFogNear;
        delete state.scene.userData._hubSavedFogFar;
        delete state.scene.userData._hubSavedFogColor;
      }
    }
  } catch (_) {}
  if (_promptEl) _promptEl.style.display = 'none';
  if (_decoratePromptEl) _decoratePromptEl.style.display = 'none';
  for (const timer of _homeUnlockTimers) clearTimeout(timer);
  _homeUnlockTimers = [];
  _activeKey = null;
}

export function tickInterior(dt) {
  if (state.mode !== 'interior') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    if (_decoratePromptEl && _decoratePromptEl.style.display !== 'none') _decoratePromptEl.style.display = 'none';
    return;
  }

  // Iter 22A — feed the home-decor cursor (no-op when decorate mode is off).
  // Must run BEFORE the early-return below so the cursor tracks even when
  // decorate mode is the only active overlay.
  try { tickHomeDecor(); } catch (_) {}

  // While decorate mode is active, suppress the interactable prompt + the
  // ambient H hint (the overlay has its own controls strip).
  if (isDecorateActive()) {
    if (_promptEl) _promptEl.style.display = 'none';
    if (_decoratePromptEl) _decoratePromptEl.style.display = 'none';
    return;
  }

  // Iter 23b — gamepad Y opens decorate mode (mirrors the H keybind).
  // input.js queues `_padLevelUpConfirmQueued` on every Y-press globally;
  // it's only consumed by the level-up modal, which never fires inside the
  // interior. We drain it here AND act on it. Reading justPressed.y directly
  // is also fine since the queue + edge fire on the same frame, but going
  // through consume() keeps the drain explicit.
  if (gamepadState.connected && consumePadLevelUpConfirm()) {
    try { openDecorateMode(); } catch (_) {}
    return;
  }

  // Flicker fire light gently for atmosphere + slow-spin the furnace rune ring
  // (iter 10b FX residue cleanup — the kettle stove ring is now a rune mesh
  // with userData._spin set to its yaw rate in rad/sec).
  if (_group) {
    const t = state.time.real;
    _group.traverse(o => {
      if (o.userData && o.userData._fireLight) {
        o.userData._fireLight.intensity = 0.75 + 0.2 * Math.sin(t * 6.7) + 0.1 * Math.sin(t * 13.1);
      }
      if (o.userData && typeof o.userData._spin === 'number') {
        o.rotation.y += dt * o.userData._spin;
      }
    });
  }

  // Find closest interactable
  const h = state.hero.pos;
  let best = null, bestD = Infinity;
  for (const it of _interactables) {
    const dx = h.x - it.pos.x;
    const dz = h.z - it.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < it.radius * it.radius && d2 < bestD) { best = it; bestD = d2; }
  }
  _activeKey = best ? best.key : null;
  if (state.input && state.input.interactPressed) {
    state.input.interactPressed = false;
    _activateActive();
    if (state.mode !== 'interior') {
      if (_promptEl) _promptEl.style.display = 'none';
      if (_decoratePromptEl) _decoratePromptEl.style.display = 'none';
      return;
    }
  }
  if (best) {
    setPromptLabel(_promptBinding, best.label);
    _promptEl.style.display = 'block';
  } else {
    _promptEl.style.display = 'none';
  }
  // Iter 22A — ambient "H · Decorate" hint always present in the interior.
  if (_decoratePromptEl) _decoratePromptEl.style.display = 'block';

  // Constrain hero to room interior with a small wall margin
  const margin = 0.6;
  const minX = -ROOM_W / 2 + margin;
  const maxX =  ROOM_W / 2 - margin;
  const minZ = -ROOM_D / 2 + margin;
  // The door gap on +z lets the player walk out without clipping
  const maxZ = (Math.abs(h.x) < DOOR_W / 2 + 0.2)
    ? ROOM_D / 2 + 1.8           // door gap: extra room to walk through (exits handled separately)
    : ROOM_D / 2 - margin;
  if (h.x < minX) h.x = minX;
  if (h.x > maxX) h.x = maxX;
  if (h.z < minZ) h.z = minZ;
  if (h.z > maxZ) h.z = maxZ;
}
