/**
 * Isaac-style item pedestals for bullet-hell mode. Normal wave clears spawn
 * ONE pedestal; boss clears spawn a CHOICE of three in an arc — first one
 * walked over applies, the others despawn. Walking over applies instantly
 * (no choice screen — that's the whole point of the pivot). Effects mutate
 * bh.stats only, except Nine Lives (hero hp/hpMax — restored from the
 * snapshot index.js takes on mode entry).
 */
import * as THREE from 'three';
import { state } from '../state.js';
import { BLOOM_LAYER } from '../rendering/bloomLayers.js';
import { sfx } from '../audio.js';
import { makeRuneRingTexture } from '../enemyTells.js';
import { floorDecalMaterial } from '../fxLayers.js';
import { spawnImpactBurst } from '../vfxBurst.js';
import { bh } from './bhState.js';
import { notifyBh } from './announcer.js';
import { getRendererCanvas } from '../rendering/rendererAccess.js';

const PICKUP_R = 1.6;

export const ITEMS = [
  { id: 'claws',   name: 'Sharp Claws',   desc: '+35% damage',            color: 0xff6a4a, apply: s => { s.dmg *= 1.35; } },
  { id: 'paws',    name: 'Quick Paws',    desc: '+25% fire rate',         color: 0xffd24a, apply: s => { s.fireRate *= 1.25; } },
  { id: 'split',   name: 'Split Shot',    desc: '+1 projectile',          color: 0xaef7ff, apply: s => { s.shotCount += 1; } },
  { id: 'velvet',  name: 'Velvet Hitbox', desc: 'hitbox −25%',            color: 0xff9af0, apply: s => { s.hitR *= 0.75; } },
  { id: 'fang',    name: 'Piercing Fang', desc: 'shots pierce +1',        color: 0xb98aff, apply: s => { s.pierce += 1; } },
  { id: 'whisker', name: 'Long Whiskers', desc: '+30% shot speed/range',  color: 0x7fd8ff, apply: s => { s.shotSpeed *= 1.3; s.shotRange *= 1.3; } },
  { id: 'lives',   name: 'Nine Lives',    desc: '+20 max HP, heal 50%',   color: 0x8aff9a,
    apply: () => { const h = state.hero; h.hpMax += 20; h.hp = Math.min(h.hpMax, h.hp + h.hpMax * 0.5); } },
  { id: 'bell',    name: 'Lucky Bell',    desc: '10% crit ×3 (stacks)',   color: 0xfff3a0, apply: s => { s.critChance = Math.min(0.6, s.critChance + 0.10); } },
  { id: 'ghost',   name: 'Ghost Tail',    desc: 'shots home (stacks)',    color: 0xd8d8ff, apply: s => { s.homing += 1.6; } },
  { id: 'purr',    name: 'Thunder Purr',  desc: 'bomb charge: a hit clears the screen instead', color: 0x9adcff, apply: s => { s.bombCharges += 1; } },
  { id: 'halo',    name: 'Graze Halo',    desc: '+35% graze radius',      color: 0xaef7ff, apply: s => { s.grazeR *= 1.35; } },
  { id: 'static',  name: 'Static Charge', desc: '+1 bomb charge, +½ graze meter', color: 0xffe94a,
    apply: s => { s.bombCharges += 1; bh.grazeMeter = Math.min(0.99, bh.grazeMeter + 0.5); } },
  { id: 'frenzy',  name: 'Frenzy Fang',   desc: '+15% damage, +15% fire rate', color: 0xff8a4a, apply: s => { s.dmg *= 1.15; s.fireRate *= 1.15; } },
];

let _rng = Math.random;
let _runeTex = null;   // cached — shared by every pedestal ring this session
let _rewardTex = null; // tiny shared Grok charm sprite, retained across entries
const _labelWorld = new THREE.Vector3();

function _rewardCanvasRect(pending) {
  const w = window.innerWidth, h = window.innerHeight;
  if (!pending._rect || pending._vw !== w || pending._vh !== h) {
    pending._vw = w; pending._vh = h;
    const canvas = getRendererCanvas(state);
    pending._rect = canvas
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0, width: w, height: h };
  }
  return pending._rect;
}

/** Weighted pool: items the run hasn't taken twice yet; repeats when it dries. */
function _pickDefs(count) {
  const counts = {};
  for (const t of bh.taken) counts[t.id] = (counts[t.id] || 0) + 1;
  let pool = ITEMS.filter(it => (counts[it.id] || 0) < 2);
  if (pool.length === 0) pool = ITEMS.slice();
  const picks = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(_rng() * pool.length);
    picks.push(pool[idx]);
    pool.splice(idx, 1);   // distinct choices within one arc
  }
  return picks;
}

function _buildPedestal(scene, def, x, z) {
  const group = new THREE.Group();
  group.userData.kkBulletHell = true;
  if (!_rewardTex) {
    _rewardTex = new THREE.TextureLoader().load('assets/fx/bullethell/cat_bell_reward.webp');
    _rewardTex.colorSpace = THREE.SRGBColorSpace;
  }
  const gem = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _rewardTex, color: def.color, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  gem.position.y = 1.45;
  gem.scale.set(2.35, 2.35, 1);
  gem.layers.enable(BLOOM_LAYER);
  // Rune-ring ground decal (style bar: no flat RingGeometry) — same canonical
  // texture the enemy tells system uses, tinted to the item color.
  if (!_runeTex) _runeTex = makeRuneRingTexture();
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    floorDecalMaterial({ map: _runeTex, color: def.color, opacity: 0.85 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.layers.enable(BLOOM_LAYER);
  group.add(gem); group.add(ring);
  group.position.set(x, 0, z);
  scene.add(group);

  // Reward time is the one moment item text is useful. A small world-anchored
  // card makes the three-way boss choice informed without a blocking modal.
  const label = document.createElement('div');
  label.className = 'kk-bh-reward-label';
  label.style.cssText = `position:fixed; z-index:66; pointer-events:none;
    transform:translate(-50%,-100%); width:132px; padding:4px 7px;
    border:1px solid rgba(255,255,255,0.22); border-radius:7px;
    background:rgba(8,6,18,0.82); color:#f8f1df; text-align:center;
    box-shadow:0 4px 14px rgba(0,0,0,0.38); opacity:0; display:none;
    font-family:'Courier New',monospace; line-height:1.2;
    transition:opacity .12s ease, filter .12s ease;`;
  const name = document.createElement('div');
  name.textContent = def.name;
  name.style.cssText = `font-size:11px; font-weight:800; color:#${def.color.toString(16).padStart(6, '0')};`;
  const desc = document.createElement('div');
  desc.textContent = def.desc;
  desc.style.cssText = 'font-size:9px; margin-top:2px; color:rgba(248,241,223,.76);';
  label.appendChild(name); label.appendChild(desc);
  document.body.appendChild(label);
  return { def, mesh: group, gem, ring, label };
}

/** Spawn ONE pedestal with a random not-yet-stacked item at (x,z). */
export function spawnItemPedestal(scene, x, z) {
  const [def] = _pickDefs(1);
  bh.itemPending = { choices: [_buildPedestal(scene, def, x, z)] };
}

/** Boss reward: a CHOICE of `count` pedestals fanned in an arc around (cx,cz).
 *  First one walked over applies; the rest despawn. */
export function spawnItemChoiceArc(scene, cx, cz, count = 3, facingA = 0) {
  const defs = _pickDefs(count);
  const choices = [];
  const spreadStep = 0.55;
  for (let i = 0; i < defs.length; i++) {
    const a = facingA + (i - (defs.length - 1) / 2) * spreadStep;
    choices.push(_buildPedestal(scene, defs[i], cx + Math.cos(a) * 4.5, cz + Math.sin(a) * 4.5));
  }
  bh.itemPending = { choices };
}

/** Tick pedestals: bob + pickup check. Returns true the frame one is taken. */
export function updateItemPedestal(dt, scene) {
  const pending = bh.itemPending;
  if (!pending) return false;
  const t = state.time.game;
  const h = state.hero.pos;
  let nearest = null, nearestD2 = Infinity;
  for (const it of pending.choices) {
    const dx = it.mesh.position.x - h.x, dz = it.mesh.position.z - h.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < nearestD2) { nearestD2 = d2; nearest = it; }
  }
  const rect = _rewardCanvasRect(pending);
  for (const it of pending.choices) {
    it.gem.position.y = 1.3 + Math.sin(t * 2.4) * 0.18;
    it.gem.material.rotation += dt * 0.32;
    it.ring.rotation.z += dt * 0.5;
    const rs = 1 + Math.sin(t * 2.4) * 0.08;
    it.ring.scale.set(rs, rs, rs);
    _labelWorld.set(it.mesh.position.x, 3.1, it.mesh.position.z).project(state.camera);
    if (it.label) {
      const selected = it === nearest;
      it.label.style.display = selected ? 'block' : 'none';
      it.label.style.left = (rect.left + (_labelWorld.x * 0.5 + 0.5) * rect.width) + 'px';
      it.label.style.top = (rect.top + (-_labelWorld.y * 0.5 + 0.5) * rect.height) + 'px';
      it.label.style.opacity = selected ? '1' : '0';
      it.label.style.filter = selected ? 'brightness(1.15)' : 'none';
    }
    const dx = it.mesh.position.x - h.x, dz = it.mesh.position.z - h.z;
    if (dx * dx + dz * dz <= PICKUP_R * PICKUP_R) {
      it.def.apply(bh.stats);
      bh.taken.push(it.def);
      notifyBh(`${it.def.name} · ${it.def.desc}`, '#' + it.def.color.toString(16).padStart(6, '0'),
        { priority: 1, duration: 1.2 });
      spawnImpactBurst(it.mesh.position.x, 1.2, it.mesh.position.z, it.def.color, 0.8);
      if (sfx && sfx.starPickup) sfx.starPickup();
      _disposePedestals(scene);
      return true;
    }
  }
  return false;
}

function _disposePedestals(scene) {
  const pending = bh.itemPending;
  if (!pending) return;
  for (const it of pending.choices) {
    scene.remove(it.mesh);
    if (it.gem.geometry) it.gem.geometry.dispose();
    it.gem.material.dispose();
    it.ring.geometry.dispose(); it.ring.material.dispose();
    if (it.label && it.label.parentNode) it.label.parentNode.removeChild(it.label);
  }
  bh.itemPending = null;
}

export function disposeItems(scene) {
  _disposePedestals(scene);
  if (_runeTex) { _runeTex.dispose(); _runeTex = null; }
}
