/**
 * Casino interior — Seedy Tent walkable room (iter 33g).
 *
 * Architectural sibling to interior.js. Player enters via the town's casino
 * interactable, lands in this room, walks up to one of five stations, and
 * presses E to open the matching modal (Slots, Parlay, Buffs, House) or
 * walks back to the exit interactable to return to town.
 *
 * Camera + control reuse the interior-mode branch in main.js (state.mode is
 * 'casino_interior'). Hero mesh + input are shared. Hero is clamped to the
 * room with a door gap on +Z so the south wall reads as the exit.
 *
 * Visuals lean on cached Poly Pizza GLBs (casino_building, casino_chip,
 * casino_dice) plus procedural geometry (velvet floor, gold trim, slot
 * cabinet, parlay table, bar counter, ledger desk, chandelier).
 */
import * as THREE from 'three';
import { state } from './state.js';
import { bindPrompt, setPromptLabel } from './buttonPrompts.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { cloneCached } from './assets.js';
import { setOverworldForSubRoom } from './town.js';
import { getMeta } from './meta.js';

const ROOM_W = 20;
const ROOM_D = 14;
const WALL_H = 4.6;
const DOOR_W = 2.6;
const VAULT_COIN_CAP = 48;
const ROOM_STATE_POLL_SEC = 0.5;

let _group = null;
let _promptEl = null;
let _promptBinding = null;
let _activeKey = null;
let _slotScreenMat = null;
let _jackpotBulbs = null;
let _jackpotBulbMat = null;
let _casinoSignMat = null;
let _vipGroup = null;
let _vipSignMat = null;
let _vaultGroup = null;
let _vaultCoins = null;
let _vaultCoinMat = null;
let _roomWash = null;
let _roomStateSig = '';
let _nextRoomStatePoll = 0;
let _progressionGlow = 0;
let _vaultGlowBase = 0.38;
const _buffBottleMats = [];
const _handlers = {};
const _interactables = [
  { pos: { x: 0,   z: ROOM_D / 2 - 1.6 }, radius: 1.9, label: '🚪  Leave the Casino',         key: 'exit' },
  { pos: { x: -6,  z: -3.4 },             radius: 1.9, label: '🎰  Slot Machine · spin Embers',  key: 'slots' },
  { pos: { x: 6,   z: -3.4 },             radius: 1.9, label: '🪙  Parlay Table · double Sigils', key: 'parlay' },
  { pos: { x: -6,  z: 2.8 },              radius: 1.9, label: '✨  Buff Counter · spend Sigils',  key: 'buffs' },
  { pos: { x: 6,   z: 2.8 },              radius: 1.9, label: '👑  House Manager · unlocks',      key: 'house' },
];

function _matStandard(color, roughness = 0.85, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function _canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  paint(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  return texture;
}

function _roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function _drawPaw(ctx, x, y, scale, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y + 16 * scale, 31 * scale, 25 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [dx, dy, r] of [[-30, -17, 12], [-10, -30, 13], [12, -30, 13], [31, -16, 12]]) {
    ctx.beginPath();
    ctx.arc(x + dx * scale, y + dy * scale, r * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function _makeFloorTexture() {
  return _canvasTexture(768, 512, (ctx, w, h) => {
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.42, 20, w * 0.5, h * 0.5, w * 0.62);
    bg.addColorStop(0, '#681d23');
    bg.addColorStop(0.58, '#4a0e14');
    bg.addColorStop(1, '#26080d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const x0 = 70, y0 = 62, iw = w - 140, ih = h - 124;
    const tileW = iw / 6, tileH = ih / 4;
    for (let x = 0; x < 6; x++) {
      for (let y = 0; y < 4; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#25090d' : '#3b1015';
        ctx.fillRect(x0 + x * tileW, y0 + y * tileH, tileW + 1, tileH + 1);
      }
    }

    ctx.strokeStyle = '#d9a94f';
    ctx.lineWidth = 8;
    ctx.strokeRect(x0, y0, iw, ih);
    ctx.strokeStyle = 'rgba(255,220,128,0.44)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 13, y0 + 13, iw - 26, ih - 26);

    ctx.globalAlpha = 0.14;
    _drawPaw(ctx, 42, 48, 0.45, '#ffd27f');
    _drawPaw(ctx, w - 42, 48, 0.45, '#ffd27f');
    _drawPaw(ctx, 42, h - 48, 0.45, '#ffd27f');
    _drawPaw(ctx, w - 42, h - 48, 0.45, '#ffd27f');
    ctx.globalAlpha = 1;

    // Central nine-lives crest: one quiet landmark instead of more floor props.
    ctx.strokeStyle = 'rgba(255,210,127,0.26)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, 54, 0, Math.PI * 2);
    ctx.stroke();
    _drawPaw(ctx, w * 0.5, h * 0.5 - 5, 0.72, 'rgba(255,210,127,0.22)');
  });
}

function _makePlaqueTexture(title, subtitle, accent = '#ff5e5e', background = '#24080c') {
  return _canvasTexture(768, 256, (ctx, w, h) => {
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, background);
    bg.addColorStop(0.5, '#120609');
    bg.addColorStop(1, background);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    _roundedRect(ctx, 12, 12, w - 24, h - 24, 26);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 8;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;

    _drawPaw(ctx, 72, h * 0.5 - 3, 0.58, accent);
    _drawPaw(ctx, w - 72, h * 0.5 - 3, 0.58, accent);

    const titleSize = title.length > 11 ? 66 : 86;
    ctx.font = `900 ${titleSize}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff1d0';
    ctx.shadowColor = accent;
    ctx.shadowBlur = 16;
    ctx.fillText(title, w * 0.5, h * 0.43);
    ctx.shadowBlur = 0;
    ctx.font = '700 25px Arial, sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(subtitle, w * 0.5, h * 0.76);
  });
}

function _drawFish(ctx, x, y, scale, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x - 5 * scale, y, 43 * scale, 26 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 34 * scale, y);
  ctx.lineTo(x + 70 * scale, y - 29 * scale);
  ctx.lineTo(x + 70 * scale, y + 29 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2a0a0f';
  ctx.beginPath();
  ctx.arc(x - 30 * scale, y - 5 * scale, 5 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function _drawYarn(ctx, x, y, scale, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 8 * scale;
  ctx.beginPath();
  ctx.arc(x, y, 39 * scale, 0, Math.PI * 2);
  ctx.stroke();
  for (const tilt of [-0.65, 0, 0.65]) {
    ctx.beginPath();
    ctx.ellipse(x, y, 34 * scale, 15 * scale, tilt, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x + 26 * scale, y + 28 * scale);
  ctx.bezierCurveTo(x + 55 * scale, y + 45 * scale, x + 52 * scale, y + 68 * scale, x + 83 * scale, y + 68 * scale);
  ctx.stroke();
  ctx.restore();
}

function _makeSlotScreenTexture() {
  return _canvasTexture(768, 384, (ctx, w, h) => {
    ctx.fillStyle = '#120609';
    ctx.fillRect(0, 0, w, h);
    const accents = ['#ff8a72', '#ffd27f', '#c9a4ff'];
    const labels = ['PAW', 'FISH', 'YARN'];
    for (let i = 0; i < 3; i++) {
      const x = i * 256;
      const glow = ctx.createRadialGradient(x + 128, 150, 10, x + 128, 160, 150);
      glow.addColorStop(0, i === 1 ? '#664117' : (i === 2 ? '#381d50' : '#52151a'));
      glow.addColorStop(1, '#17080c');
      ctx.fillStyle = glow;
      ctx.fillRect(x + 8, 8, 240, h - 16);
      ctx.strokeStyle = accents[i];
      ctx.lineWidth = 7;
      ctx.strokeRect(x + 12, 12, 232, h - 24);
      if (i === 0) _drawPaw(ctx, x + 128, 155, 1.35, accents[i]);
      else if (i === 1) _drawFish(ctx, x + 128, 165, 1.25, accents[i]);
      else _drawYarn(ctx, x + 118, 160, 1.18, accents[i]);
      ctx.font = '800 30px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff1d0';
      ctx.fillText(labels[i], x + 128, 330);
    }
  });
}

function _emissivePanelMaterial(texture, intensity = 1.0) {
  return new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: intensity,
    roughness: 0.45,
    metalness: 0.05,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function _makeFloor() {
  // One authored canvas carpet replaces the former 24 independent checker
  // planes + four border meshes. It keeps the rich floor read at one draw.
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    new THREE.MeshStandardMaterial({ map: _makeFloorTexture(), color: 0xffffff, roughness: 0.94 }),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0;
  base.receiveShadow = true;
  g.add(base);
  // Baseboard trim along all four walls
  const trimMat = _matStandard(0x2a0a0a, 0.85);
  const trimH = 0.22;
  const tN = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, trimH, 0.14), trimMat);
  tN.position.set(0, trimH / 2, -ROOM_D / 2 + 0.18);
  g.add(tN);
  const tS = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, trimH, 0.14), trimMat);
  tS.position.set(0, trimH / 2, ROOM_D / 2 - 0.18);
  g.add(tS);
  const tE = new THREE.Mesh(new THREE.BoxGeometry(0.14, trimH, ROOM_D), trimMat);
  tE.position.set(ROOM_W / 2 - 0.18, trimH / 2, 0);
  g.add(tE);
  const tW = new THREE.Mesh(new THREE.BoxGeometry(0.14, trimH, ROOM_D), trimMat);
  tW.position.set(-ROOM_W / 2 + 0.18, trimH / 2, 0);
  g.add(tW);
  return g;
}

function _makeWall(w, h, color = 0x6a1014) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.25),
    _matStandard(color, 0.95),
  );
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function _makeNeonSign() {
  // Authored canvas plaque: real lettering, paw marks and a restrained neon
  // edge. Opaque emissive remains depth-correct in the iso view.
  const g = new THREE.Group();
  _casinoSignMat = _emissivePanelMaterial(
    _makePlaqueTexture('SEEDY TENT', 'LUCK  •  LOOT  •  NINE LIVES', '#ff6b6b'),
    0.56,
  );
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 1.55),
    _casinoSignMat,
  );
  panel.position.set(0, WALL_H - 1.42, -ROOM_D / 2 + 0.4);
  g.add(panel);
  // Warm fill light on the back wall (kept — point lights are world-space and
  // attenuate correctly, no additive overdraw).
  const pl = new THREE.PointLight(0xff7a3a, 1.1, 7, 2);
  pl.position.set(0, WALL_H - 0.8, -ROOM_D / 2 + 1.2);
  g.add(pl);
  return g;
}

function _makeChandelier() {
  // Hanging brass ring + six candle bulbs. Bulbs share one instanced draw.
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.1, 0.06, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = WALL_H - 1.2;
  g.add(ring);
  // Suspension chain (short cylinder)
  const chain = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6),
    _matStandard(0x8a6a3a, 0.6, 0.5),
  );
  chain.position.y = WALL_H - 0.7;
  g.add(chain);
  // Candle bulbs around the ring
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0xffd27f, emissive: 0xffd27f, emissiveIntensity: 1.8, roughness: 0.4,
  });
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.10, 8, 6), bulbMat, 6);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * 1.1, WALL_H - 1.2, Math.sin(a) * 1.1);
    dummy.updateMatrix();
    bulbs.setMatrixAt(i, dummy.matrix);
  }
  bulbs.instanceMatrix.needsUpdate = true;
  bulbs.layers.enable(BLOOM_LAYER);
  g.add(bulbs);
  const pl = new THREE.PointLight(0xffd27f, 1.2, 14, 2);
  pl.position.set(0, WALL_H - 1.2, 0);
  g.add(pl);
  return g;
}

function _makeSlotMachine() {
  // Three-window slot cabinet with a single authored reel screen. Paw, fish and
  // yarn glyphs replace the old blank color panes and cost one draw, not three.
  const g = new THREE.Group();
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 2.4, 0.9),
    _matStandard(0x3a1410, 0.7, 0.2),
  );
  chassis.position.y = 1.2;
  chassis.castShadow = true; chassis.receiveShadow = true;
  g.add(chassis);
  // Top crest — gold arch
  const crest = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.4, 1.0),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  crest.position.y = 2.6;
  g.add(crest);
  // Brass frame around the reel area
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.55, 0.95, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.4, metalness: 0.6 }),
  );
  frame.position.set(0, 1.55, 0.46);
  g.add(frame);
  _slotScreenMat = _emissivePanelMaterial(_makeSlotScreenTexture(), 1.05);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.40, 0.78), _slotScreenMat);
  screen.position.set(0, 1.55, 0.49);
  screen.layers.enable(BLOOM_LAYER);
  screen.userData.visualRole = 'casino_slot_screen';
  g.add(screen);

  // Jackpot bulbs fill from left to right as lifetime jackpots accumulate.
  _jackpotBulbMat = new THREE.MeshStandardMaterial({
    color: 0xffd27f, emissive: 0xffb347, emissiveIntensity: 1.2, roughness: 0.35,
  });
  _jackpotBulbs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.065, 8, 6),
    _jackpotBulbMat,
    5,
  );
  const bulbDummy = new THREE.Object3D();
  for (let i = 0; i < 5; i++) {
    bulbDummy.position.set(-0.56 + i * 0.28, 2.61, 0.52);
    bulbDummy.updateMatrix();
    _jackpotBulbs.setMatrixAt(i, bulbDummy.matrix);
  }
  _jackpotBulbs.instanceMatrix.needsUpdate = true;
  _jackpotBulbs.count = 0;
  _jackpotBulbs.layers.enable(BLOOM_LAYER);
  g.add(_jackpotBulbs);
  // Pull-lever on the side — short cylinder + red ball
  const leverArm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.55, 8),
    _matStandard(0x8a6a3a, 0.5, 0.5),
  );
  leverArm.position.set(1.0, 1.7, 0);
  g.add(leverArm);
  const leverBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xc23a3a, roughness: 0.4, metalness: 0.5 }),
  );
  leverBall.position.set(1.0, 2.0, 0);
  g.add(leverBall);
  // Coin tray at the bottom
  const tray = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.2, 0.5),
    _matStandard(0x2a1410, 0.7, 0.2),
  );
  tray.position.set(0, 0.3, 0.5);
  g.add(tray);
  // Coin tray glow
  const trayGlow = new THREE.PointLight(0xffd27f, 0.5, 3, 2);
  trayGlow.position.set(0, 0.6, 0.8);
  g.add(trayGlow);
  return g;
}

function _makeParlayTable() {
  // Round green-felt poker table w/ gold trim, casino_dice + chip stacks on top.
  const g = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 0.12, 24),
    new THREE.MeshStandardMaterial({ color: 0x0e5a32, roughness: 0.95 }),
  );
  top.position.y = 0.9;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // Gold trim ring
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(1.4, 0.07, 8, 32),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.96;
  g.add(trim);
  // Pedestal
  const ped = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.32, 0.85, 12),
    _matStandard(0x3a1410, 0.7, 0.2),
  );
  ped.position.y = 0.45;
  g.add(ped);
  // Floor flare
  const flare = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.05, 12),
    _matStandard(0x231a14, 0.85),
  );
  flare.position.y = 0.02;
  g.add(flare);
  // Dice on top (cached GLB) — two pips so it reads as a parlay roll
  for (let i = 0; i < 2; i++) {
    const die = cloneCached('casino_dice');
    if (!die) break;
    die.scale.setScalar(1.6);
    die.position.set(-0.3 + i * 0.6, 1.06, -0.2 + i * 0.4);
    die.rotation.set(Math.random() * 0.3, Math.random() * Math.PI, Math.random() * 0.3);
    die.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    g.add(die);
  }
  // Chip stacks (cached GLB) — two stacks of 3 each
  for (const [sx, sz] of [[-0.7, 0.3], [0.5, 0.5]]) {
    for (let s = 0; s < 3; s++) {
      const chip = cloneCached('casino_chip');
      if (!chip) break;
      chip.scale.setScalar(5);
      chip.rotation.x = -Math.PI / 2;
      chip.position.set(sx, 0.97 + s * 0.04, sz);
      g.add(chip);
    }
  }
  return g;
}

function _makeBuffCounter() {
  // Long wooden bar w/ brass rail and three glowing bottles on the back shelf.
  // Reads as a counter you walk up to and buy something from.
  const g = new THREE.Group();
  // Bar top
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.18, 1.0),
    _matStandard(0x3a1a10, 0.6, 0.25),
  );
  top.position.set(0, 1.05, 0);
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // Brass rail along the front edge
  const rail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 3.6, 8),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.35, metalness: 0.65 }),
  );
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, 0.85, 0.55);
  g.add(rail);
  // Front panel (kick board)
  const front = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.95, 0.08),
    _matStandard(0x2a0a0a, 0.85),
  );
  front.position.set(0, 0.48, 0.5);
  g.add(front);
  // Back shelf — three bottles glowing magenta/cyan/gold. Material refs are
  // cached so purchased buffs can brighten the display without scene traversal.
  for (let i = 0; i < 3; i++) {
    const color = [0xc9a4ff, 0x4fd0ff, 0xffd27f][i];
    const bottleMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.9, roughness: 0.45,
    });
    _buffBottleMats.push(bottleMat);
    const bottle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.16, 0.55, 10),
      bottleMat,
    );
    bottle.position.set(-0.9 + i * 0.9, 1.45, -0.35);
    bottle.layers.enable(BLOOM_LAYER);
    bottle.castShadow = true;
    g.add(bottle);
    const cork = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.10, 8),
      _matStandard(0x4a2f1c, 0.85),
    );
    cork.position.set(-0.9 + i * 0.9, 1.77, -0.35);
    g.add(cork);
  }
  // Back shelf plank
  const shelf = new THREE.Mesh(
    new THREE.BoxGeometry(3.0, 0.06, 0.30),
    _matStandard(0x3a1a10, 0.6, 0.25),
  );
  shelf.position.set(0, 1.15, -0.35);
  g.add(shelf);
  // Counter accent light
  const pl = new THREE.PointLight(0xc9a4ff, 0.6, 4, 2);
  pl.position.set(0, 1.6, 0.5);
  g.add(pl);
  return g;
}

function _makeHouseDesk() {
  // Manager's desk — ornate wood, ledger book, chip-stack centerpiece,
  // crown ornament so the "house upgrades" function reads at a glance.
  const g = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.16, 1.1),
    _matStandard(0x3a1a10, 0.6, 0.25),
  );
  top.position.y = 0.95;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // 4 legs
  for (const [x, z] of [[-1.05, -0.45], [1.05, -0.45], [-1.05, 0.45], [1.05, 0.45]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.14), _matStandard(0x2a0a0a, 0.85));
    leg.position.set(x, 0.475, z);
    g.add(leg);
  }
  // Ledger book
  const book = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.14, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x8a1a1a, roughness: 0.7 }),
  );
  book.position.set(-0.55, 1.10, 0);
  g.add(book);
  // Quill on top of book
  const quill = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.005, 0.50, 6),
    _matStandard(0xf3e8cf, 0.85),
  );
  quill.rotation.z = Math.PI / 5;
  quill.position.set(-0.45, 1.30, -0.10);
  g.add(quill);
  // Chip-stack centerpiece — six chips stacked on a felt tray
  const tray = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.03, 12),
    new THREE.MeshStandardMaterial({ color: 0x0e5a32, roughness: 0.95 }),
  );
  tray.position.set(0.55, 1.05, 0);
  g.add(tray);
  for (let s = 0; s < 6; s++) {
    const chip = cloneCached('casino_chip');
    if (!chip) break;
    chip.scale.setScalar(5);
    chip.rotation.x = -Math.PI / 2;
    chip.position.set(0.55, 1.08 + s * 0.04, 0);
    g.add(chip);
  }
  // Crown ornament on top of the desk's back
  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(0.15, 0.30, 6),
    new THREE.MeshStandardMaterial({ color: 0xc98a3a, emissive: 0xffd27f, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.7 }),
  );
  crown.position.set(0.55, 1.55, -0.45);
  crown.layers.enable(BLOOM_LAYER);
  g.add(crown);
  return g;
}

function _makeVipDressing() {
  const g = new THREE.Group();
  g.name = 'casinoVipDressing';

  const postMat = new THREE.MeshStandardMaterial({
    color: 0xd9a94f, roughness: 0.32, metalness: 0.72,
  });
  const posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.07, 0.10, 1.25, 10),
    postMat,
    4,
  );
  const dummy = new THREE.Object3D();
  const postPositions = [[-1.65, -0.72], [1.65, -0.72], [-1.65, 0.72], [1.65, 0.72]];
  for (let i = 0; i < postPositions.length; i++) {
    dummy.position.set(postPositions[i][0], 0.625, postPositions[i][1]);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
  }
  posts.instanceMatrix.needsUpdate = true;
  g.add(posts);

  // Two soft velvet ropes frame the desk without blocking the approach lane.
  const ropeMat = new THREE.MeshStandardMaterial({
    color: 0x8e1830, emissive: 0x410712, emissiveIntensity: 0.32,
    roughness: 0.72,
  });
  for (const x of [-1.65, 1.65]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, 1.02, -0.72),
      new THREE.Vector3(x, 0.73, 0),
      new THREE.Vector3(x, 1.02, 0.72),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.045, 6, false), ropeMat));
  }

  _vipSignMat = _emissivePanelMaterial(
    _makePlaqueTexture('VIP CATS', 'HOUSE MEMBER LOUNGE', '#ffd27f', '#261407'),
    0.46,
  );
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.70), _vipSignMat);
  sign.position.set(0, 1.82, 0.78);
  sign.rotation.y = Math.PI;
  g.add(sign);

  g.position.set(6, 0, 3.15);
  g.visible = false;
  return g;
}

function _makeVaultDressing() {
  const g = new THREE.Group();
  g.name = 'casinoVaultDressing';

  const woodMat = _matStandard(0x38140e, 0.66, 0.16);
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xd9a94f, roughness: 0.30, metalness: 0.74,
  });
  const chest = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.78, 1.05), woodMat);
  chest.position.y = 0.42;
  chest.castShadow = true;
  g.add(chest);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.26, 1.12), woodMat);
  lid.position.y = 0.94;
  lid.rotation.z = -0.10;
  lid.castShadow = true;
  g.add(lid);
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.09), goldMat);
  lock.position.set(0, 0.72, 0.57);
  g.add(lock);

  _vaultCoinMat = new THREE.MeshStandardMaterial({
    color: 0xffca5c,
    emissive: 0x6b3207,
    emissiveIntensity: 0.38,
    roughness: 0.28,
    metalness: 0.70,
  });
  _vaultCoins = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.13, 0.13, 0.038, 12),
    _vaultCoinMat,
    VAULT_COIN_CAP,
  );
  const coinDummy = new THREE.Object3D();
  for (let i = 0; i < VAULT_COIN_CAP; i++) {
    const layer = Math.floor(i / 12);
    const slot = i % 12;
    const a = slot * 2.399963 + layer * 0.41;
    const radius = 0.18 + Math.sqrt(slot / 11) * (0.46 + layer * 0.035);
    coinDummy.position.set(
      Math.cos(a) * radius,
      1.10 + layer * 0.052,
      Math.sin(a) * radius - 0.03,
    );
    coinDummy.rotation.set(0, a, (slot % 3 - 1) * 0.05);
    coinDummy.updateMatrix();
    _vaultCoins.setMatrixAt(i, coinDummy.matrix);
  }
  _vaultCoins.instanceMatrix.needsUpdate = true;
  _vaultCoins.count = 0;
  g.add(_vaultCoins);

  const vaultSignMat = _emissivePanelMaterial(
    _makePlaqueTexture('THE VAULT', 'WINNINGS ON DISPLAY', '#ffd27f', '#241606'),
    0.42,
  );
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.95, 0.65), vaultSignMat);
  sign.position.set(0, 2.05, 0);
  g.add(sign);

  // Center it beneath the far-wall marquee. The iso camera looks from +X/+Z,
  // so an east-wall hoard would be hidden behind the near wall.
  g.position.set(0, 0, -5.2);
  g.visible = false;
  return g;
}

function _syncCasinoRoomState(force = false) {
  if (!_group) return;
  let meta = null;
  try { meta = getMeta(); } catch (_) { meta = null; }
  meta = meta || {};
  const house = meta.casinoHouse || {};
  const vipOwned = !!house.vip_multipliers;
  const vaultOwned = !!house.vault_decor;
  const lifetimeWon = Math.max(0, Number(meta.casinoLifetimeWon) || 0);
  const jackpots = Math.max(0, Number(meta.casinoSlotsBigWins) || 0);
  const queued = Array.isArray(meta.casinoRunQueued) ? meta.casinoRunQueued.length : 0;
  let permLevels = 0;
  for (const value of Object.values(meta.casinoPerm || {})) permLevels += Math.max(0, Number(value) || 0);
  const coinCount = vaultOwned
    ? Math.min(VAULT_COIN_CAP, 8 + Math.floor(Math.log2(1 + lifetimeWon / 25) * 5))
    : 0;
  const sig = `${vipOwned ? 1 : 0}|${vaultOwned ? 1 : 0}|${coinCount}|${jackpots}|${permLevels}|${queued}`;
  if (!force && sig === _roomStateSig) return;
  _roomStateSig = sig;

  if (_vipGroup) _vipGroup.visible = vipOwned;
  if (_vaultGroup) _vaultGroup.visible = vaultOwned;
  if (_vaultCoins) _vaultCoins.count = coinCount;
  if (_jackpotBulbs) _jackpotBulbs.count = Math.min(5, jackpots);
  _progressionGlow = Math.min(1, permLevels / 9 + queued * 0.08);
  _vaultGlowBase = 0.34 + (coinCount / VAULT_COIN_CAP) * 0.48;
  if (_vaultCoinMat) _vaultCoinMat.emissiveIntensity = _vaultGlowBase;
  if (_casinoSignMat) _casinoSignMat.emissiveIntensity = 0.52 + Math.min(0.18, jackpots * 0.03);
  if (_roomWash) _roomWash.intensity = 0.38 + (vipOwned ? 0.08 : 0) + (vaultOwned ? 0.08 : 0);
}

function _makeExitDoor() {
  // Visual marker for the south exit — wood double door + green EXIT sign.
  const g = new THREE.Group();
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR_W, WALL_H - 0.6, 0.12),
    _matStandard(0x3a1a10, 0.8, 0.1),
  );
  door.position.y = (WALL_H - 0.6) / 2;
  g.add(door);
  // Door split line
  const split = new THREE.Mesh(
    new THREE.PlaneGeometry(0.04, WALL_H - 0.8),
    new THREE.MeshBasicMaterial({ color: 0x0a0608 }),
  );
  split.position.set(0, (WALL_H - 0.6) / 2, 0.07);
  g.add(split);
  // Legible authored exit plaque instead of a blank green rectangle.
  const exitMat = _emissivePanelMaterial(
    _makePlaqueTexture('EXIT', 'RETURN TO TOWN', '#7fffa0', '#0b2417'),
    0.46,
  );
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 0.45),
    exitMat,
  );
  sign.position.set(0, WALL_H - 0.4, 0.07);
  g.add(sign);
  return g;
}

export function buildCasinoInterior(scene) {
  if (_group) return _group;
  const g = new THREE.Group();
  g.name = 'casinoInteriorGroup';

  // ── Floor ──
  g.add(_makeFloor());

  // ── Walls (back, east, west, front w/ door gap) ──
  const back = _makeWall(ROOM_W, WALL_H);
  back.position.set(0, WALL_H / 2, -ROOM_D / 2);
  g.add(back);
  const left = _makeWall(ROOM_D, WALL_H);
  left.rotation.y = Math.PI / 2;
  left.position.set(-ROOM_W / 2, WALL_H / 2, 0);
  g.add(left);
  const right = _makeWall(ROOM_D, WALL_H);
  right.rotation.y = Math.PI / 2;
  right.position.set(ROOM_W / 2, WALL_H / 2, 0);
  g.add(right);
  const halfDoor = DOOR_W / 2;
  const sideW = (ROOM_W - DOOR_W) / 2;
  const frontL = _makeWall(sideW, WALL_H);
  frontL.position.set(-(sideW / 2 + halfDoor), WALL_H / 2, ROOM_D / 2);
  g.add(frontL);
  const frontR = _makeWall(sideW, WALL_H);
  frontR.position.set((sideW / 2 + halfDoor), WALL_H / 2, ROOM_D / 2);
  g.add(frontR);
  const lintel = _makeWall(DOOR_W + 0.25, WALL_H * 0.32);
  lintel.position.set(0, WALL_H - 0.6, ROOM_D / 2);
  g.add(lintel);

  // ── Neon "CASINO" sign on the back wall ──
  g.add(_makeNeonSign());

  // ── Chandelier overhead ──
  g.add(_makeChandelier());

  // ── Furniture (5 stations matching _interactables) ──
  const slot = _makeSlotMachine();
  slot.position.set(-6, 0, -3.4 - 0.6);   // sit slightly behind the interact spot
  slot.rotation.y = 0.18;
  g.add(slot);

  const parlay = _makeParlayTable();
  parlay.position.set(6, 0, -3.4);
  g.add(parlay);

  const counter = _makeBuffCounter();
  counter.position.set(-6, 0, 2.8 + 0.4);
  counter.rotation.y = -Math.PI;          // face south so player approaches from front
  g.add(counter);

  const desk = _makeHouseDesk();
  desk.position.set(6, 0, 2.8 + 0.3);
  desk.rotation.y = Math.PI;
  g.add(desk);

  // House upgrades are physical room changes, not menu-only checkboxes.
  _vipGroup = _makeVipDressing();
  g.add(_vipGroup);
  _vaultGroup = _makeVaultDressing();
  g.add(_vaultGroup);

  const door = _makeExitDoor();
  door.position.set(0, 0, ROOM_D / 2 - 0.05);
  g.add(door);

  // ── Side decor: poker chip clusters on the floor near the entry ──
  for (let i = 0; i < 6; i++) {
    const chip = cloneCached('casino_chip');
    if (!chip) break;
    chip.scale.setScalar(5);
    chip.rotation.x = -Math.PI / 2;
    chip.rotation.z = (i / 6) * Math.PI * 2;
    chip.position.set(
      (i % 2 === 0 ? -1 : 1) * (3 + Math.random() * 0.5),
      0.04 + (i % 3) * 0.02,
      ROOM_D / 2 - 3.2 + (Math.random() - 0.5) * 0.4,
    );
    g.add(chip);
  }

  // ── Ambient lighting ──
  const fill = new THREE.PointLight(0xffae6a, 0.55, 24, 2);
  fill.position.set(0, 3.4, 0);
  g.add(fill);
  // Cool kicker from front-left so the chandelier warm fill reads warm
  const kicker = new THREE.PointLight(0xc9a4ff, 0.35, 18, 2);
  kicker.position.set(-ROOM_W / 2 + 1.5, 3.0, ROOM_D / 2 - 2);
  g.add(kicker);
  // Red wall-wash from the neon sign side
  const wash = new THREE.PointLight(0xff3a3a, 0.4, 12, 2);
  wash.position.set(0, 2.4, -ROOM_D / 2 + 2);
  g.add(wash);
  _roomWash = wash;

  // Hide initially — only visible when state.mode === 'casino_interior'
  g.position.y = -200;
  g.userData.casinoPolish = {
    authoredSigns: true,
    texturedFloorDraws: 1,
    vaultCoinCap: VAULT_COIN_CAP,
  };
  scene.add(g);
  _group = g;
  _syncCasinoRoomState(true);

  // ── DOM prompt ──
  if (!_promptEl) {
    _promptEl = document.createElement('div');
    _promptEl.id = 'kk-casino-interior-prompt';
    _promptEl.style.cssText = `
      position: fixed; bottom: 14%; left: 50%; transform: translateX(-50%);
      padding: 8px 16px; pointer-events: none; z-index: 90;
      background: linear-gradient(180deg, rgba(36,10,12,0.95), rgba(20,6,8,0.95));
      border: 1px solid rgba(255,60,60,0.55); border-radius: 8px;
      color: #ffd27f; font: 600 14px 'Cinzel Decorative', serif;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,210,127,0.18);
      display: none;
    `;
    document.body.appendChild(_promptEl);
    _promptBinding = bindPrompt(_promptEl, 'interact', '');
    window.addEventListener('keydown', _onKeyDown);
  }
  return g;
}

function _activateActive() {
  if (!_activeKey) return;
  if (_handlers[_activeKey]) _handlers[_activeKey]();
}

function _onKeyDown(e) {
  if (e.code !== 'Enter' || e.repeat || state.mode !== 'casino_interior' || state.time.paused) return;
  try { if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; } catch (_) {}
  _activateActive();
}

export function setCasinoInteriorHandler(key, fn) { _handlers[key] = fn; }

export function enterCasinoInterior() {
  state.mode = 'casino_interior';
  if (_group) _group.position.y = 0;
  _roomStateSig = '';
  _nextRoomStatePoll = 0;
  _syncCasinoRoomState(true);
  // Full overworld blackout (town + env + forest clutter + light zeroing).
  // Plain visible=false on town left PointLights bleeding through the room.
  try { setOverworldForSubRoom(true); } catch (_) {}
  // Spawn at the door (south end of the room)
  state.hero.pos.set(0, 0, ROOM_D / 2 - 2.4);
  state.hero.vel.set(0, 0, 0);
  state.hero.facing.set(0, 0, -1);
}

export function exitCasinoInterior() {
  state.mode = 'town';
  if (_group) _group.position.y = -200;
  try { setOverworldForSubRoom(false); } catch (_) {}
  if (_promptEl) _promptEl.style.display = 'none';
  _activeKey = null;
}

export function tickCasinoInterior(dt) {
  if (state.mode !== 'casino_interior') {
    if (_promptEl && _promptEl.style.display !== 'none') _promptEl.style.display = 'none';
    return;
  }

  // Animate cached materials only. The old implementation traversed every
  // room object each frame to find three reel panes.
  const t = state.time.real;
  if (t >= _nextRoomStatePoll) {
    _nextRoomStatePoll = t + ROOM_STATE_POLL_SEC;
    _syncCasinoRoomState();
  }
  if (_slotScreenMat) {
    const focus = _activeKey === 'slots' ? 0.24 : 0;
    _slotScreenMat.emissiveIntensity = 0.96 + focus + 0.12 * (0.5 + 0.5 * Math.sin(t * 4.3));
  }
  if (_jackpotBulbMat) {
    _jackpotBulbMat.emissiveIntensity = 1.05 + 0.65 * (0.5 + 0.5 * Math.sin(t * 6.2));
  }
  for (let i = 0; i < _buffBottleMats.length; i++) {
    const focus = _activeKey === 'buffs' ? 0.28 : 0;
    _buffBottleMats[i].emissiveIntensity = 0.68 + _progressionGlow * 0.52 + focus
      + 0.15 * Math.sin(t * 2.5 + i * 2.1);
  }
  if (_vipSignMat && _vipGroup && _vipGroup.visible) {
    _vipSignMat.emissiveIntensity = 0.42 + 0.08 * (0.5 + 0.5 * Math.sin(t * 2.0));
  }
  if (_vaultCoinMat && _vaultGroup && _vaultGroup.visible) {
    _vaultCoinMat.emissiveIntensity += (_vaultGlowBase + 0.10 * Math.sin(t * 2.6) - _vaultCoinMat.emissiveIntensity)
      * Math.min(1, dt * 4);
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
    if (state.mode !== 'casino_interior') {
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

  // Constrain hero to room interior with a small wall margin
  const margin = 0.6;
  const minX = -ROOM_W / 2 + margin;
  const maxX =  ROOM_W / 2 - margin;
  const minZ = -ROOM_D / 2 + margin;
  // Door gap on +z lets the player walk out — exit handled by the 'exit' interactable
  const maxZ = (Math.abs(h.x) < DOOR_W / 2 + 0.2)
    ? ROOM_D / 2 + 1.8
    : ROOM_D / 2 - margin;
  if (h.x < minX) h.x = minX;
  if (h.x > maxX) h.x = maxX;
  if (h.z < minZ) h.z = minZ;
  if (h.z > maxZ) h.z = maxZ;
}
