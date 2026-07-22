/** Distinct attack identities for the four themed Bullet Hell bosses. */
import { state } from '../state.js';
import { bh, ARENA_CX, ARENA_CZ } from './bhState.js';
import {
  patternRing, patternRingWithGap, patternDoubleRing, patternAimedFan,
  patternSpiralStep, patternBulletWall, patternEdgeRain, patternCrossfire,
} from './bullets.js';

export const BOSS_PATTERN_KEYS = ['velvet', 'cinder', 'frost', 'gold'];

function _velvet(f) {
  const h = state.hero.pos;
  if (f.phaseIdx === 0) {
    if (f.alt % 2) {
      const gap = Math.atan2(h.z - f.z, h.x - f.x) + (f.alt % 4 < 2 ? -0.35 : 0.35);
      patternRingWithGap(f.x, f.z, 28, 6.1, gap, 0.95, f.phase, 'ring');
      f.phase += 0.24;
    } else {
      f.burst = 3; f.burstGap = 0.23;
      f.burstFn = (g) => patternAimedFan(g.x, g.z, 5, 8.8, 0.82, 'aimed');
    }
  } else if (f.phaseIdx === 1) {
    f.dir *= -1;
    f.burst = 12; f.burstGap = 0.075;
    f.burstFn = (g) => {
      patternSpiralStep(g.x, g.z, g.phase, 3, 5.7, 'spiral', { curve: 0.16 * g.dir });
      g.phase += 0.34 * g.dir;
    };
  } else {
    const gap = Math.atan2(h.z - f.z, h.x - f.x);
    patternRingWithGap(f.x, f.z, 32, 7.0, gap, 0.8, f.phase += 0.31, 'ring');
    patternCrossfire(3, 9.2, 0.55, 'aimed');
  }
}

function _cinder(f) {
  const h = state.hero.pos;
  if (f.phaseIdx === 0) {
    if (f.alt % 2) {
      // Ember blossoms mark the hero's old cell, then expand after a fair delay.
      patternRing(h.x, h.z, 10, 4.8, f.phase, 'aimed', { delay: 0.78 });
      patternRing(h.x, h.z, 15, 7.4, f.phase + 0.18, 'ring', { delay: 1.02 });
      f.phase += 0.37;
    } else patternAimedFan(f.x, f.z, 7, 9.4, 1.0, 'aimed');
  } else if (f.phaseIdx === 1) {
    const a = Math.atan2(ARENA_CZ - f.z, ARENA_CX - f.x) + f.alt * 0.24;
    f.gapT = (f.gapT === undefined ? 0.22 : f.gapT + 0.31) % 1;
    patternBulletWall(a, 5.5, f.gapT, 6.6, 1.65, 'aimed');
    patternAimedFan(f.x, f.z, 3, 12, 0.45, 'snipe');
  } else {
    const a = f.phase += 0.42;
    f.gapT = (f.gapT === undefined ? 0.35 : f.gapT + 0.23) % 1;
    patternBulletWall(a, 5.9, f.gapT, 7.2, 1.75, 'aimed');
    if (f.alt % 2 === 0) patternBulletWall(a + Math.PI / 2, 5.2, 1 - f.gapT, 7.8, 1.8, 'ring');
    patternRing(h.x, h.z, 12, 6.8, a, 'aimed', { delay: 0.82 });
  }
}

function _frost(f) {
  const h = state.hero.pos;
  if (f.phaseIdx === 0) {
    if (f.alt % 2) {
      const gap = Math.atan2(h.z - f.z, h.x - f.x);
      patternRingWithGap(f.x, f.z, 26, 5.6, gap, 1.05, f.phase += 0.2, 'rain', { delay: 0.22 });
    } else patternEdgeRain(14, 6.1, 'rain');
  } else if (f.phaseIdx === 1) {
    f.dir *= -1;
    f.burst = 10; f.burstGap = 0.1;
    f.burstFn = (g) => {
      patternSpiralStep(g.x, g.z, g.phase, 4, 5.0, 'rain', { curve: -0.12 * g.dir });
      g.phase += 0.29 * g.dir;
    };
  } else {
    patternDoubleRing(f.x, f.z, 20, 6.1, f.phase += 0.28, 'rain');
    if (f.alt % 2) patternCrossfire(2, 15.5, 0.32, 'snipe');
    else patternEdgeRain(16, 6.7, 'rain');
  }
}

function _gold(f) {
  const h = state.hero.pos;
  if (f.phaseIdx === 0) {
    if (f.alt % 2) patternCrossfire(4, 9.0, 0.7, 'aimed');
    else {
      const gap = Math.atan2(h.z - f.z, h.x - f.x);
      patternRingWithGap(f.x, f.z, 30, 6.4, gap, 0.9, f.phase += 0.3, 'aimed');
    }
  } else if (f.phaseIdx === 1) {
    f.dir *= -1;
    f.burst = 14; f.burstGap = 0.065;
    f.burstFn = (g) => {
      patternSpiralStep(g.x, g.z, g.phase, 4, 5.8, 'aimed', { curve: 0.2 * g.dir });
      g.phase += 0.3 * g.dir;
    };
  } else {
    // Rotating clock-hand lanes: broad promised gaps keep the lattice fair.
    const a = f.phase += Math.PI / 5;
    f.gapT = (f.gapT === undefined ? 0.5 : f.gapT + 0.2) % 1;
    patternBulletWall(a, 6.0, f.gapT, 7.4, 1.75, 'aimed');
    if (f.alt % 2 === 0) patternDoubleRing(f.x, f.z, 18, 6.8, a, 'spiral');
    else patternCrossfire(3, 10.5, 0.5, 'aimed');
  }
}

export function fireBossPattern(f) {
  f.alt = (f.alt || 0) + 1;
  const level = Math.max(0, Math.min(3, bh.level | 0));
  if (level === 0) _velvet(f);
  else if (level === 1) _cinder(f);
  else if (level === 2) _frost(f);
  else _gold(f);
}
