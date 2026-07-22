/**
 * MaoMao in the walkable town: one short rescue trail, one persistent resident,
 * and one proximity interaction. Every visible marker has a gameplay purpose.
 */
import * as THREE from 'three';
import { state } from './state.js';
import { cloneCached } from './assets.js';
import { getMeta, saveMeta } from './meta.js';
import { adoptMaoMao, normalizeMaoMao, setMaoMaoRescueStep } from './maomaoState.js';
import { sfx } from './audio.js';

const MEET_POS = new THREE.Vector3(-18.0, 0, 3.8);
const DASH_POS = new THREE.Vector3(-18.0, 0, 8.2);
const JUMP_POS = new THREE.Vector3(-15.2, 0, 12.2);
const HOME_POS = new THREE.Vector3(-5.6, 0, 5.5);
const RESCUE_RADIUS = 2.25;

const HOME_NODES = [
  // Open plaza-side yard nodes: clear of the cottage footprint and readable
  // from the standard town camera, while still clustered around the daycare.
  new THREE.Vector3(-5.6, 0, 5.5),
  new THREE.Vector3(-3.6, 0, 3.0),
  new THREE.Vector3(-6.0, 0, 0.7),
  new THREE.Vector3(-2.3, 0, 7.6),
];

let _group = null;
let _cat = null;
let _catFigure = null;
let _outfitRoot = null;
let _footprints = null;
let _dashMarker = null;
let _jumpMarker = null;
let _questMarker = null;
let _target = HOME_POS.clone();
let _homeNode = 0;
let _pauseUntil = 0;
let _lastOutfit = undefined;
let _lastStep = -1;

const _tmp = new THREE.Vector3();

function mat(color, emissive = 0x000000, intensity = 0) {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, roughness: 0.82 });
}

function makeFallbackCat() {
  const g = new THREE.Group();
  const fur = mat(0xf1c7a2);
  const cream = mat(0xffefd7);
  const dark = mat(0x5a392e);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.48, 12, 8), fur);
  body.scale.set(1, 0.72, 1.3); body.position.y = 0.48; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 8), cream);
  head.position.set(0, 0.82, 0.34); g.add(head);
  for (const x of [-0.22, 0.22]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.34, 4), dark);
    ear.position.set(x, 1.15, 0.32); ear.rotation.y = Math.PI / 4; g.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.08, 6, 16, Math.PI * 1.45), fur);
  tail.position.set(-0.42, 0.5, -0.18); tail.rotation.set(Math.PI / 2, 0, -0.35); g.add(tail);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function fitCatFigure(figure) {
  figure.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
  });
  const box = new THREE.Box3().setFromObject(figure);
  const size = box.getSize(new THREE.Vector3());
  const fit = size.y > 1e-5 ? 1.2 / size.y : 1;
  figure.scale.setScalar(fit);
  const fitted = new THREE.Box3().setFromObject(figure);
  figure.position.y = -fitted.min.y;
}

function makePawTrail() {
  const points = [
    [-1.8, 6.4, -0.2], [-3.5, 6.4, 0.25], [-5.2, 6.2, -0.2],
    [-6.8, 6.0, 0.25], [-8.1, 5.9, -0.2], [-9.0, 5.9, -0.3],
    [-10.5, 5.5, 0.2], [-12.0, 5.0, -0.25],
    [-13.6, 4.7, 0.2], [-15.1, 4.3, -0.2], [-16.6, 4.0, 0.25],
    [-18.0, 3.8, -0.2], [-18.1, 5.4, 0.2], [-18.0, 6.9, -0.2],
  ];
  const geo = new THREE.CircleGeometry(0.29, 10);
  const material = new THREE.MeshBasicMaterial({ color: 0xff4fa3, transparent: true, opacity: 0.98, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geo, material, points.length * 4);
  mesh.name = 'maomaoPurposePawTrail';
  mesh.userData.purpose = 'find-maomao-navigation';
  mesh.renderOrder = -1;
  const d = new THREE.Object3D();
  let slot = 0;
  for (const [x, z, tilt] of points) {
    const parts = [[0, 0, 1.25], [-0.16, 0.17, 0.62], [0, 0.23, 0.62], [0.16, 0.17, 0.62]];
    for (const [ox, oz, scale] of parts) {
      d.position.set(x + ox * 1.35, 0.075, z + oz * 1.35);
      d.rotation.set(-Math.PI / 2, 0, tilt);
      d.scale.setScalar(scale);
      d.updateMatrix();
      mesh.setMatrixAt(slot++, d.matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function makeQuestMarker() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 160;
  const c = canvas.getContext('2d');
  c.shadowColor = 'rgba(50,12,35,.35)'; c.shadowBlur = 16; c.shadowOffsetY = 8;
  c.fillStyle = 'rgba(255,248,239,.96)';
  c.beginPath(); c.roundRect(20, 18, 472, 116, 46); c.fill();
  c.shadowColor = 'transparent'; c.lineWidth = 10; c.strokeStyle = '#ff5fa9'; c.stroke();
  c.fillStyle = '#ff5fa9'; c.beginPath(); c.arc(78, 70, 24, 0, Math.PI * 2); c.arc(112, 70, 24, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(55, 79); c.lineTo(135, 79); c.lineTo(95, 124); c.closePath(); c.fill();
  c.fillStyle = '#7b3158'; c.font = '900 46px Trebuchet MS, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
  c.fillText('MAOMAO', 158, 79);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.name = 'maomaoPurposeQuestMarker';
  sprite.userData.purpose = 'identify-interactive-rescue-cat';
  sprite.position.set(0, 2.15, 0);
  sprite.scale.set(3.6, 1.12, 1);
  sprite.renderOrder = 50;
  return sprite;
}

function makeDashMarker() {
  const g = new THREE.Group();
  g.name = 'maomaoPurposeDashYarn';
  g.userData.purpose = 'dash-through-yarn-to-follow-maomao';
  const yarn = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 8), mat(0xff72b6, 0x8a204f, 0.18));
  yarn.position.y = 0.42; yarn.castShadow = true; g.add(yarn);
  for (let i = 0; i < 3; i++) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.35 - i * 0.05, 0.025, 5, 16), mat(0xffd2e8));
    wrap.position.y = 0.43; wrap.rotation.set(Math.PI / 2 + i * 0.5, i * 0.8, 0); g.add(wrap);
  }
  g.position.copy(DASH_POS);
  return g;
}

function makeJumpMarker() {
  const g = new THREE.Group();
  g.name = 'maomaoPurposeJumpRibbon';
  g.userData.purpose = 'jump-over-ribbon-to-gain-maomao-trust';
  const postMat = mat(0xb98557);
  const ribbonMat = mat(0x9ef0d3, 0x287a62, 0.14);
  for (const x of [-0.9, 0.9]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.72, 8), postMat);
    post.position.set(x, 0.36, 0); post.castShadow = true; g.add(post);
  }
  const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.8, 8), ribbonMat);
  ribbon.rotation.z = Math.PI / 2; ribbon.position.y = 0.48; g.add(ribbon);
  g.position.copy(JUMP_POS);
  return g;
}

function clearOutfit() {
  if (!_outfitRoot) return;
  while (_outfitRoot.children.length) {
    const child = _outfitRoot.children.pop();
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
}

function syncOutfit(pet) {
  const id = pet.adopted ? pet.equippedOutfit : null;
  if (id === _lastOutfit) return;
  _lastOutfit = id;
  clearOutfit();
  if (!_outfitRoot || !id) return;

  if (id === 'beanie') {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xd36a9d));
    cap.position.set(0, 1.12, 0.22); cap.scale.y = 0.72; _outfitRoot.add(cap);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), mat(0xffd0e6));
    pom.position.set(0, 1.32, 0.22); _outfitRoot.add(pom);
  } else if (id === 'scarf') {
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.065, 7, 16), mat(0xc87bff));
    scarf.position.set(0, 0.77, 0.14); scarf.rotation.x = Math.PI / 2; _outfitRoot.add(scarf);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.07), mat(0xe5b6ff));
    tail.position.set(0.19, 0.58, 0.35); tail.rotation.z = -0.2; _outfitRoot.add(tail);
  } else if (id === 'crown') {
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.27, 0.3, 6, 1, true), mat(0xffd24d, 0x8a5c00, 0.22));
    crown.position.set(0, 1.21, 0.22); _outfitRoot.add(crown);
    const jewel = new THREE.Mesh(new THREE.SphereGeometry(0.055, 7, 5), mat(0xff72b6, 0x7a1645, 0.25));
    jewel.position.set(0, 1.22, 0.43); _outfitRoot.add(jewel);
  } else if (id === 'moonbell') {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.048, 7, 18), mat(0x9c6cff, 0x3e1f77, 0.20));
    collar.position.set(0, 0.77, 0.14); collar.rotation.x = Math.PI / 2; _outfitRoot.add(collar);
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.085, 9, 7), mat(0x8fffe5, 0x167a68, 0.55));
    bell.position.set(0, 0.67, 0.38); bell.scale.y = 1.18; _outfitRoot.add(bell);
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.052, 0), mat(0xffd66d, 0x815100, 0.35));
    star.position.set(0, 0.77, 0.39); _outfitRoot.add(star);
  }
  _outfitRoot.traverse((o) => { if (o.isMesh) o.castShadow = true; });
}

function toast(message, color = '#ff9dcc') {
  const old = document.getElementById('kk-maomao-toast');
  old?.remove();
  const el = document.createElement('div');
  el.id = 'kk-maomao-toast';
  el.textContent = message;
  el.style.cssText = `position:fixed;left:50%;top:15%;transform:translateX(-50%);z-index:150;max-width:min(520px,88vw);padding:12px 20px;border:3px solid ${color};border-radius:16px;background:rgba(255,250,244,.96);color:#6d3452;font:800 16px/1.35 'Trebuchet MS',sans-serif;text-align:center;box-shadow:0 9px 28px rgba(60,24,46,.28);pointer-events:none;`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .35s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 380); }, 2600);
}

function syncRescueVisuals(pet, snap = false) {
  if (!_group || !_cat) return;
  _group.visible = !!pet.encounterUnlocked;
  _cat.visible = !!pet.encounterUnlocked;
  _footprints.visible = !!(pet.encounterUnlocked && !pet.adopted);
  _dashMarker.visible = !!(!pet.adopted && pet.rescueStep === 1);
  _jumpMarker.visible = !!(!pet.adopted && pet.rescueStep === 2);
  if (_questMarker) {
    // Keep a smaller nameplate after adoption: at the wide town camera the
    // 1.5u cat can otherwise disappear among townsfolk/building silhouettes.
    _questMarker.visible = pet.adopted || pet.rescueStep === 0 || pet.rescueStep === 3;
    _questMarker.scale.set(pet.adopted ? 3.0 : 3.6, pet.adopted ? 0.86 : 1.12, 1);
    _questMarker.material.opacity = pet.adopted ? 0.82 : 1;
  }

  if (pet.adopted) _target.copy(HOME_NODES[_homeNode]);
  else if (pet.rescueStep <= 0) _target.copy(MEET_POS);
  else if (pet.rescueStep === 1) _target.copy(DASH_POS).add(_tmp.set(0.8, 0, 0.5));
  else if (pet.rescueStep === 2) _target.copy(JUMP_POS).add(_tmp.set(0.7, 0, 0.55));
  else _target.copy(HOME_POS);
  if (snap) _cat.position.copy(_target);
  _lastStep = pet.rescueStep;
  syncOutfit(pet);
}

export function buildMaoMaoTown(parent) {
  if (_group) return _group;
  const g = new THREE.Group();
  g.name = 'maomaoTownLife';
  g.userData.purpose = 'virtual-pet-rescue-and-daycare-resident';

  _cat = new THREE.Group();
  _cat.name = 'maomaoCat';
  _cat.scale.setScalar(1.25); // readable beside hero at the 60u town camera
  _catFigure = cloneCached('home_cat') || makeFallbackCat();
  fitCatFigure(_catFigure);
  _cat.add(_catFigure);
  _outfitRoot = new THREE.Group();
  _outfitRoot.name = 'maomaoOutfit';
  _cat.add(_outfitRoot);
  _questMarker = makeQuestMarker();
  _cat.add(_questMarker);
  g.add(_cat);

  _footprints = makePawTrail(); g.add(_footprints);
  _dashMarker = makeDashMarker(); g.add(_dashMarker);
  _jumpMarker = makeJumpMarker(); g.add(_jumpMarker);

  parent.add(g);
  _group = g;
  syncRescueVisuals(normalizeMaoMao(getMeta()), true);
  try { window.kkMaoMaoDebug = debugMaoMao; } catch (_) {}
  return g;
}

export function enterMaoMaoTown() {
  const pet = normalizeMaoMao(getMeta());
  _homeNode = 0;
  _pauseUntil = state.time.real + 1.2;
  syncRescueVisuals(pet, true);
}

export function tickMaoMaoTown(dt) {
  if (!_group || state.mode !== 'town') return;
  const meta = getMeta();
  const pet = normalizeMaoMao(meta);
  if (_lastStep !== pet.rescueStep) syncRescueVisuals(pet);

  const hero = state.hero;
  if (!pet.adopted && pet.encounterUnlocked && pet.rescueStep === 1) {
    const near = hero.pos.distanceToSquared(DASH_POS) < RESCUE_RADIUS * RESCUE_RADIUS;
    if (near && state.time.real < hero.dashUntil) {
      setMaoMaoRescueStep(meta, 2); saveMeta(); syncRescueVisuals(pet);
      toast('Nice dash! MaoMao waits beside the mint ribbon. Jump over it!');
      try { sfx.starPickup?.(); } catch (_) {}
    }
  } else if (!pet.adopted && pet.encounterUnlocked && pet.rescueStep === 2) {
    const dx = hero.pos.x - JUMP_POS.x, dz = hero.pos.z - JUMP_POS.z;
    if (dx * dx + dz * dz < RESCUE_RADIUS * RESCUE_RADIUS && hero.pos.y > 0.22) {
      setMaoMaoRescueStep(meta, 3); saveMeta(); syncRescueVisuals(pet);
      toast('MaoMao slow-blinks at you. Go say hello!');
      try { sfx.heartPickup?.(); } catch (_) {}
    }
  }

  if (pet.adopted && state.time.real >= _pauseUntil) {
    if (_cat.position.distanceToSquared(_target) < 0.14) {
      _homeNode = (_homeNode + 1 + ((Math.random() * (HOME_NODES.length - 1)) | 0)) % HOME_NODES.length;
      _target.copy(HOME_NODES[_homeNode]);
      _pauseUntil = state.time.real + 1.5 + Math.random() * 2.5;
    }
  }

  const dx = _target.x - _cat.position.x;
  const dz = _target.z - _cat.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 0.04 && state.time.real >= _pauseUntil) {
    const step = Math.min((pet.adopted ? 0.85 : 3.2) * dt, dist);
    _cat.position.x += dx / dist * step;
    _cat.position.z += dz / dist * step;
    _cat.rotation.y = Math.atan2(dx, dz);
    _cat.position.y = 0.035 * Math.abs(Math.sin(state.time.real * 7));
  } else {
    _cat.position.y = 0.025 * Math.sin(state.time.real * 2.2);
    _cat.rotation.z = 0.025 * Math.sin(state.time.real * 1.3);
  }
  if (_dashMarker?.visible) _dashMarker.rotation.y += dt * 0.7;
  syncOutfit(pet);
}

/** Dynamic interaction candidate consumed by town.js's closest-item pass. */
export function getMaoMaoInteraction(heroPos) {
  if (!_cat || !_cat.visible) return null;
  const pet = normalizeMaoMao(getMeta());
  if (!pet.encounterUnlocked) return null;
  if (!pet.adopted && pet.rescueStep !== 0 && pet.rescueStep !== 3) return null;
  const dx = heroPos.x - _cat.position.x;
  const dz = heroPos.z - _cat.position.z;
  const d2 = dx * dx + dz * dz;
  const radius = pet.adopted ? 2.3 : 2.6;
  if (d2 > radius * radius) return null;
  return {
    pos: _cat.position,
    radius,
    d2,
    key: pet.adopted ? 'maomao:care' : (pet.rescueStep === 0 ? 'maomao:meet' : 'maomao:welcome'),
    label: pet.adopted ? '🐾  Spend time with MaoMao' : (pet.rescueStep === 0 ? '🐱  Gently approach MaoMao' : '💗  Welcome MaoMao home'),
  };
}

export function activateMaoMaoInteraction(key) {
  const meta = getMeta();
  const pet = normalizeMaoMao(meta);
  if (key === 'maomao:meet' && !pet.adopted && pet.rescueStep === 0) {
    setMaoMaoRescueStep(meta, 1); saveMeta(); syncRescueVisuals(pet);
    toast('MaoMao is curious! Dash through the pink yarn ball to follow her.');
    try { sfx.modalOpen?.(); } catch (_) {}
    return;
  }
  if (key === 'maomao:welcome' && adoptMaoMao(meta)) {
    saveMeta(); syncRescueVisuals(pet, true);
    toast('MaoMao joined the Daycare! No chores—just care, play, and purrs.');
    try { sfx.evolutionChime?.(); } catch (_) {}
    setTimeout(() => import('./daycare.js').then(m => m.showDaycare?.()).catch(() => {}), 900);
    return;
  }
  if (key === 'maomao:care' && pet.adopted) {
    import('./daycare.js').then(m => m.showDaycare?.()).catch(() => {});
  }
}

export function debugMaoMao() {
  const pet = normalizeMaoMao(getMeta());
  return {
    built: !!_group,
    catVisible: !!_cat?.visible,
    catPosition: _cat ? { x: _cat.position.x, y: _cat.position.y, z: _cat.position.z } : null,
    footprintVisible: !!_footprints?.visible,
    dashVisible: !!_dashMarker?.visible,
    jumpVisible: !!_jumpMarker?.visible,
    pet: JSON.parse(JSON.stringify(pet)),
    purpose: _group?.userData?.purpose || null,
  };
}
