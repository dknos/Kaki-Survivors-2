/**
 * Authored phase director for Kaki Land's portal bosses.
 *
 * The generic enemy system still owns movement, projectiles, damage, pooling,
 * and death. This module adds the encounter rhythm that a raid-style finale
 * needs: HP gates, visible wards, priority adds, phase names, and per-phase
 * boss pattern decks. All authored creatures remain normal pooled enemies.
 */
import * as THREE from 'three';
import { ENEMY_TIERS } from './config.js';
import { spawnEnemy } from './enemies.js';
import { clearEnemyProjectiles } from './enemyProjectiles.js';
import { BLOOM_LAYER } from './rendering/bloomLayers.js';
import { sfx } from './audio.js';
import { showBanner } from './ui.js';

const TAU = Math.PI * 2;
const SIGIL_URL = new URL('../assets/fx/arena/kaki_threefold_crown_sigil_grok_v1.webp', import.meta.url).href;

const ENCOUNTER_PROFILES = Object.freeze({
  'kaki-ember': Object.freeze({
    color: 0xff704f,
    colorCss: '#ff8a68',
    phases: Object.freeze([
      Object.freeze({ label: 'THE ANVIL', patterns: Object.freeze(['quake']), intervalMul: 1.0 }),
      Object.freeze({ label: 'WORLD BREAKER', patterns: Object.freeze(['quake', 'sonic']), intervalMul: 0.82 }),
    ]),
    intermissions: Object.freeze([
      Object.freeze({
        at: 0.50,
        title: 'CINDER WARD',
        hint: 'Break the three Sparkmites',
        adds: Object.freeze([Object.freeze(['kaki_sparkmite', 3])]),
      }),
    ]),
  }),
  'kaki-tide': Object.freeze({
    color: 0x62dcff,
    colorCss: '#77e6ff',
    phases: Object.freeze([
      Object.freeze({ label: 'HIGH TIDE', patterns: Object.freeze(['engulf']), intervalMul: 1.0 }),
      Object.freeze({ label: 'RIP CURRENT', patterns: Object.freeze(['engulf', 'sonic']), intervalMul: 0.80 }),
    ]),
    intermissions: Object.freeze([
      Object.freeze({
        at: 0.50,
        title: 'UNDERTOW WARD',
        hint: 'Weave through five-current volleys',
        adds: Object.freeze([Object.freeze(['kaki_tidesprite', 4])]),
      }),
    ]),
  }),
  'kaki-bloom': Object.freeze({
    color: 0xc789ff,
    colorCss: '#d5a2ff',
    phases: Object.freeze([
      Object.freeze({ label: 'FIRST BLOOM', patterns: Object.freeze(['sonic']), intervalMul: 1.0 }),
      Object.freeze({ label: 'THORN CHOIR', patterns: Object.freeze(['sonic', 'quake']), intervalMul: 0.78 }),
    ]),
    intermissions: Object.freeze([
      Object.freeze({
        at: 0.50,
        title: 'PETAL WARD',
        hint: 'Strip the Bloomlings before the choir returns',
        adds: Object.freeze([Object.freeze(['kaki_bloomling', 3])]),
      }),
    ]),
  }),
  'kaki-main': Object.freeze({
    color: 0xffcf70,
    colorCss: '#ffd983',
    phases: Object.freeze([
      Object.freeze({ label: 'TRIAL OF EMBER', patterns: Object.freeze(['quake']), intervalMul: 1.0 }),
      Object.freeze({ label: 'TIDE ASCENDANT', patterns: Object.freeze(['engulf', 'quake']), intervalMul: 0.84 }),
      Object.freeze({ label: 'THREEFOLD DOMINION', patterns: Object.freeze(['sonic', 'engulf', 'quake']), intervalMul: 0.68 }),
    ]),
    intermissions: Object.freeze([
      Object.freeze({
        at: 0.72,
        title: 'THE THREE CROWNS DESCEND',
        hint: 'Defeat one herald of every trial',
        adds: Object.freeze([
          Object.freeze(['kaki_sparkmite', 1]),
          Object.freeze(['kaki_tidesprite', 1]),
          Object.freeze(['kaki_bloomling', 1]),
        ]),
      }),
      Object.freeze({
        at: 0.38,
        title: 'CROWN OF ALL KAKI',
        hint: 'Six heralds guard the final phase',
        adds: Object.freeze([
          Object.freeze(['kaki_sparkmite', 2]),
          Object.freeze(['kaki_tidesprite', 2]),
          Object.freeze(['kaki_bloomling', 2]),
        ]),
      }),
    ]),
  }),
});

const _tierById = Object.freeze(Object.fromEntries(ENEMY_TIERS.map((tier) => [tier.glb, tier])));

let _scene = null;
let _state = null;
let _active = null;
let _visual = null;

function _makeVisual(scene) {
  const root = new THREE.Group();
  root.name = 'kakiLand_bossEncounterWard';
  root.visible = false;

  const texture = new THREE.TextureLoader().load(SIGIL_URL);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  decal.name = 'kakiLand_threefoldCrownSigil';
  decal.rotation.x = -Math.PI / 2;
  decal.renderOrder = -1;
  decal.layers.enable(BLOOM_LAYER);
  root.add(decal);

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1, 22, 12),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.13,
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  shell.name = 'kakiLand_encounterWardShell';
  root.add(shell);

  const orbGeo = new THREE.OctahedronGeometry(0.24, 0);
  const orbColors = [0xff6848, 0x55dcff, 0xbf78ff];
  const orbs = [];
  for (let i = 0; i < orbColors.length; i++) {
    const orb = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({
      color: orbColors[i],
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    orb.name = `kakiLand_wardCrown_${i}`;
    orb.layers.enable(BLOOM_LAYER);
    root.add(orb);
    orbs.push(orb);
  }

  scene.add(root);
  return { root, decal, shell, orbs, texture, orbGeo };
}

function _setPhase(boss, profile, index) {
  const phase = profile.phases[Math.min(index, profile.phases.length - 1)];
  boss._kakiEncounterPhase = index;
  boss._kakiEncounterPhaseLabel = phase.label;
  boss._kakiPatternIds = phase.patterns;
  boss._kakiIntervalMul = phase.intervalMul;
  boss._patternSeq = -1;
}

function _armNextFloor(active) {
  const next = active.profile.intermissions[active.intermissionIndex];
  active.boss._encounterDamageFloorHp = next
    ? active.boss.hpMax * next.at
    : 0;
  active.boss._encounterFloorReached = false;
}

function _spawnIntermissionAdds(active, intermission) {
  let total = 0;
  for (const [, count] of intermission.adds) total += count;
  let serial = 0;
  for (const [tierId, count] of intermission.adds) {
    const base = _tierById[tierId];
    if (!base) continue;
    for (let i = 0; i < count; i++) {
      const angle = (serial / Math.max(1, total)) * TAU
        + active.intermissionIndex * 0.43
        + (tierId === 'kaki_tidesprite' ? 0.18 : 0);
      const radius = 3.6 + (serial & 1) * 0.85;
      const x = active.boss.mesh.position.x + Math.cos(angle) * radius;
      const z = active.boss.mesh.position.z + Math.sin(angle) * radius;
      const add = spawnEnemy({
        ...base,
        kakiLandPortalId: active.portalId,
        kakiLandEncounterAdd: true,
        kakiLandEncounterRole: tierId === 'kaki_sparkmite'
          ? 'breaker'
          : (tierId === 'kaki_tidesprite' ? 'weaver' : 'warder'),
      }, x, z);
      serial++;
      if (!add) continue;
      add._kakiEncounterOwner = active.boss;
      add._kakiEncounterWave = active.intermissionIndex;
      // Bloomlings are priority warders, but the ward is six hits rather than
      // the generic 50-hit Shielded affix. This keeps the role readable
      // without turning an intermission into a sustain-DPS tax.
      if (tierId === 'kaki_bloomling') {
        add._shieldHp = active.portalId === 'kaki-main' ? 8 : 6;
        add._shieldedRim = true;
      }
      active.adds.push(add);
    }
  }
  return active.adds.length;
}

function _beginIntermission(active) {
  const boss = active.boss;
  const intermission = active.profile.intermissions[active.intermissionIndex];
  if (!intermission) return;
  active.shielded = true;
  active.startedAt = _state.time.game;
  boss._encounterInvulnerable = true;
  boss._encounterFloorReached = false;
  boss._encounterDamageFloorHp = 0;
  boss._encounterSavedSpd = boss.spd;
  boss.spd = 0;
  boss._kakiEncounterPhaseLabel = 'WARD PHASE';
  boss._windupStart = -1;
  boss._activePatternIdx = null;
  boss._activeWindup = 0;
  boss._patternSeq = -1;
  active.adds.length = 0;
  try { clearEnemyProjectiles(); } catch (_) {}
  const count = _spawnIntermissionAdds(active, intermission);
  boss._kakiEncounterAddsAlive = count;

  if (_visual) {
    _visual.root.visible = true;
    _visual.shell.material.color.setHex(active.profile.color);
  }
  _state.fx.bloomBoost = Math.max(_state.fx.bloomBoost || 0, 0.95);
  _state.fx.chromaticPulse = Math.max(_state.fx.chromaticPulse || 0, 0.55);
  _state.fx.shake = Math.max(_state.fx.shake || 0, 0.45);
  try { if (sfx && sfx.bossWarn) sfx.bossWarn(); } catch (_) {}
  try {
    showBanner(`${intermission.title} — ${intermission.hint}`, 3.2, active.profile.colorCss);
  } catch (_) {}

  // Asset-load failure must never create an immortal boss. The visible ward
  // still flashes, then the phase resumes immediately with a diagnostic.
  if (count === 0) {
    console.warn(`[kaki encounter] no adds spawned for ${active.portalId}`);
    _endIntermission(active);
  }
}

function _endIntermission(active) {
  const boss = active.boss;
  active.shielded = false;
  active.adds.length = 0;
  boss._encounterInvulnerable = false;
  boss._encounterFloorReached = false;
  boss._kakiEncounterAddsAlive = 0;
  boss.spd = boss._encounterSavedSpd || boss.spd || 1;
  boss._encounterSavedSpd = 0;
  active.intermissionIndex++;
  active.phaseIndex = Math.min(active.intermissionIndex, active.profile.phases.length - 1);
  _setPhase(boss, active.profile, active.phaseIndex);
  _armNextFloor(active);
  boss._nextTellAt = _state.time.game + 1.15;
  if (_visual) _visual.root.visible = false;

  const phase = active.profile.phases[active.phaseIndex];
  _state.fx.bloomBoost = Math.max(_state.fx.bloomBoost || 0, 0.85);
  _state.fx.chromaticPulse = Math.max(_state.fx.chromaticPulse || 0, 0.40);
  _state.fx.shake = Math.max(_state.fx.shake || 0, 0.35);
  try { if (sfx && sfx.bossSpawn) sfx.bossSpawn(); } catch (_) {}
  try {
    showBanner(`PHASE ${active.phaseIndex + 1} — ${phase.label}`, 2.8, active.profile.colorCss);
  } catch (_) {}
}

function _tickWardVisual(active, dt) {
  if (!_visual || !_visual.root.visible || !active || !active.boss || !active.boss.mesh) return;
  const t = _state.time.game;
  const p = active.boss.mesh.position;
  const isFinal = active.portalId === 'kaki-main';
  const radius = isFinal ? 3.45 : 2.65;
  const centerY = (active.boss._baseY || p.y || 0) + (isFinal ? 1.55 : 1.20);
  const pulse = 1 + Math.sin(t * 4.5) * 0.035;

  _visual.decal.position.set(p.x, 0.055, p.z);
  _visual.decal.scale.setScalar(radius * 1.38 * pulse);
  _visual.decal.rotation.z += dt * 0.22;
  _visual.decal.material.opacity = 0.40 + Math.sin(t * 5.0) * 0.08;

  _visual.shell.position.set(p.x, centerY, p.z);
  _visual.shell.scale.setScalar(radius * pulse);
  _visual.shell.rotation.y += dt * 0.38;
  _visual.shell.rotation.z += dt * 0.18;
  _visual.shell.material.opacity = 0.11 + Math.sin(t * 6.5) * 0.025;

  for (let i = 0; i < _visual.orbs.length; i++) {
    const orb = _visual.orbs[i];
    const a = t * (0.72 + i * 0.08) + (i / _visual.orbs.length) * TAU;
    orb.position.set(
      p.x + Math.cos(a) * radius * 0.86,
      centerY + Math.sin(t * 2.4 + i * 1.9) * 0.42,
      p.z + Math.sin(a) * radius * 0.86,
    );
    orb.rotation.x += dt * (1.2 + i * 0.2);
    orb.rotation.y += dt * (1.5 + i * 0.18);
  }
}

export function loadKakiLandBossEncounters(scene, state) {
  if (!scene || !state) return false;
  if (_scene && _scene !== scene) disposeKakiLandBossEncounters(_scene);
  _scene = scene;
  _state = state;
  if (!_visual) _visual = _makeVisual(scene);
  return true;
}

export function beginKakiLandBossEncounter(boss, portalId) {
  const profile = ENCOUNTER_PROFILES[portalId];
  if (!_scene || !_state || !boss || !profile) return false;
  _active = {
    boss,
    portalId,
    profile,
    phaseIndex: 0,
    intermissionIndex: 0,
    shielded: false,
    startedAt: _state.time.game,
    adds: [],
  };
  boss._kakiEncounterProfileId = portalId;
  boss._kakiEncounterAddsAlive = 0;
  boss._encounterInvulnerable = false;
  boss._encounterSavedSpd = 0;
  _setPhase(boss, profile, 0);
  _armNextFloor(_active);
  if (_visual) _visual.root.visible = false;
  return true;
}

export function tickKakiLandBossEncounter(dt) {
  const active = _active;
  if (!active || !active.boss || !active.boss.alive) return;

  if (!active.shielded) {
    if (active.boss._encounterFloorReached
        || (active.boss._encounterDamageFloorHp > 0
          && active.boss.hp <= active.boss._encounterDamageFloorHp + 1e-6)) {
      _beginIntermission(active);
    }
    return;
  }

  let alive = 0;
  for (let i = 0; i < active.adds.length; i++) {
    if (active.adds[i] && active.adds[i].alive) alive++;
  }
  active.boss._kakiEncounterAddsAlive = alive;
  _tickWardVisual(active, dt);
  if (alive === 0) _endIntermission(active);
}

/** Called synchronously from the Kaki kill hook for both adds and bosses. */
export function notifyKakiLandEncounterEnemyKilled(enemy) {
  const active = _active;
  if (!active || !enemy) return false;
  if (enemy === active.boss) {
    endKakiLandBossEncounter(enemy);
    return true;
  }
  if (!enemy._kakiEncounterAdd || enemy._kakiEncounterOwner !== active.boss) return false;
  enemy._kakiEncounterOwner = null;
  if (active.boss) {
    let alive = 0;
    for (let i = 0; i < active.adds.length; i++) {
      if (active.adds[i] && active.adds[i].alive && active.adds[i] !== enemy) alive++;
    }
    active.boss._kakiEncounterAddsAlive = alive;
  }
  return true;
}

export function endKakiLandBossEncounter(boss = null) {
  if (!_active || (boss && _active.boss !== boss)) return false;
  const target = _active.boss;
  if (target) {
    target._encounterInvulnerable = false;
    target._encounterDamageFloorHp = 0;
    target._encounterFloorReached = false;
    target._kakiEncounterAddsAlive = 0;
    target._kakiPatternIds = null;
    target._kakiIntervalMul = 1;
  }
  if (_visual) _visual.root.visible = false;
  _active = null;
  return true;
}

export function disposeKakiLandBossEncounters(scene = _scene) {
  if (scene && _scene && scene !== _scene) return false;
  endKakiLandBossEncounter();
  if (_visual) {
    if (_visual.root.parent) _visual.root.parent.remove(_visual.root);
    _visual.decal.geometry.dispose();
    _visual.decal.material.dispose();
    _visual.shell.geometry.dispose();
    _visual.shell.material.dispose();
    for (const orb of _visual.orbs) orb.material.dispose();
    _visual.orbGeo.dispose();
    // Texture is stage-scoped and not registered in a shared cache.
    _visual.texture.dispose();
  }
  _visual = null;
  _active = null;
  _scene = null;
  _state = null;
  return true;
}

export function getKakiLandBossEncounterDebugState() {
  const active = _active;
  return {
    loaded: !!_scene,
    active: !!active,
    portalId: active ? active.portalId : null,
    bossAsset: active && active.boss ? active.boss.glbKey : null,
    phaseIndex: active ? active.phaseIndex : -1,
    phaseLabel: active && active.boss ? active.boss._kakiEncounterPhaseLabel : '',
    shielded: !!(active && active.shielded),
    addsAlive: active && active.boss ? (active.boss._kakiEncounterAddsAlive || 0) : 0,
    intermissionIndex: active ? active.intermissionIndex : -1,
    phaseCount: active ? active.profile.phases.length : 0,
    intermissionCount: active ? active.profile.intermissions.length : 0,
    sigilAsset: 'kaki_threefold_crown_sigil_grok_v1.webp',
  };
}

export { ENCOUNTER_PROFILES as KAKI_LAND_ENCOUNTER_PROFILES };
