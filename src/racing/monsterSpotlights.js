/** Deterministic, achievable overlays for Monster Smash rounds and Free Ride. */
import { clamp } from './physics.js';

const HEAVY_KINDS = new Set(['pickup', 'van', 'limousine', 'bus', 'rv', 'crown']);

function _activeTargets(arena, round) {
  const active = new Set(round?.targetIds || []);
  return (arena?.targets || []).filter((target) => active.has(target.id));
}

function _classTotal(score, kinds) {
  return [...kinds].reduce((sum, kind) => sum + (Number(score?.classCrushes?.[kind]) || 0), 0);
}

function _candidateDefinitions(arena, round, roundIndex) {
  const targets = _activeTargets(arena, round);
  const hasHeavy = targets.some((target) => HEAVY_KINDS.has(target.kind));
  const hasDerby = targets.some((target) => target.kind === 'derby');
  const dominoes = targets.filter((target) => target.dominoGroup).length;
  const candidates = [];
  if (targets.length >= 5) candidates.push({
    id: 'chain-five', label: 'CHAIN 5 CRUSHES', metric: 'chain', goal: 5, rewardTime: 4, rewardZoomies: 18,
  });
  if (roundIndex >= 1 && hasHeavy) candidates.push({
    id: 'heavy-down', label: 'FLATTEN 1 HEAVY', metric: 'heavy', goal: 1, rewardTime: 5, rewardZoomies: 24,
  });
  if (roundIndex >= 2) candidates.push({
    id: 'clean-air', label: 'LAND CLEAN AIR', metric: 'clean', goal: 1, rewardTime: 5, rewardZoomies: 22,
  });
  if (roundIndex >= 3 && dominoes >= 6) candidates.push({
    id: 'domino-six', label: 'DROP 6 DOMINOES', metric: 'domino', goal: 6, rewardTime: 6, rewardZoomies: 28,
  });
  if (roundIndex >= 3 && hasDerby) candidates.push({
    id: 'derby-pair', label: 'KO 2 DERBY CARS', metric: 'derby', goal: 2, rewardTime: 6, rewardZoomies: 26,
  });
  if (roundIndex >= 4 && targets.length >= 8) candidates.push({
    id: 'variety-three', label: 'CRUSH 3 CLASSES', metric: 'variety', goal: 3, rewardTime: 7, rewardZoomies: 30,
  });
  if (!candidates.length && targets.length) candidates.push({
    id: 'first-crush', label: 'CRUSH A TARGET', metric: 'destroyed', goal: 1, rewardTime: 3, rewardZoomies: 14,
  });
  return candidates;
}

function _metric(state, arena, score) {
  switch (state.metric) {
    case 'chain': return Math.max(0, Number(score?.wreckChain) || 1);
    case 'heavy': return _classTotal(score, HEAVY_KINDS) - state.baseline;
    case 'clean': return (Number(score?.cleanLandings) || 0) - state.baseline;
    case 'domino': return (Number(arena?.dominoImpacts) || 0) - state.baseline;
    case 'derby': return (Number(score?.derbyKnockouts) || 0) - state.baseline;
    case 'variety': {
      const current = Object.entries(score?.classCrushes || {}).filter(([, count]) => Number(count) > 0).length;
      return current - state.baseline;
    }
    default: return (Number(arena?.destroyed) || 0) - state.baseline;
  }
}

function _baseline(metric, arena, score) {
  if (metric === 'heavy') return _classTotal(score, HEAVY_KINDS);
  if (metric === 'clean') return Number(score?.cleanLandings) || 0;
  if (metric === 'domino') return Number(arena?.dominoImpacts) || 0;
  if (metric === 'derby') return Number(score?.derbyKnockouts) || 0;
  if (metric === 'variety') return Object.entries(score?.classCrushes || {}).filter(([, count]) => Number(count) > 0).length;
  if (metric === 'destroyed') return Number(arena?.destroyed) || 0;
  return 0;
}

export function createMonsterSpotlight(arena, round, score, roundIndex = 0, seedOffset = 0) {
  const candidates = _candidateDefinitions(arena, round, roundIndex);
  if (!candidates.length) return null;
  const choice = candidates[Math.abs((roundIndex * 3 + seedOffset) % candidates.length)];
  return {
    ...choice,
    baseline: _baseline(choice.metric, arena, score),
    progress: 0,
    completed: false,
    rewarded: false,
    age: 0,
    expiresIn: 42,
  };
}

export function stepMonsterSpotlight(spotlight, arena, score, dt) {
  if (!spotlight || spotlight.rewarded) return { completed: false, progress: spotlight?.progress || 0 };
  spotlight.age += Math.max(0, Number(dt) || 0);
  spotlight.progress = clamp(_metric(spotlight, arena, score), 0, spotlight.goal);
  const justCompleted = !spotlight.completed && spotlight.progress >= spotlight.goal;
  spotlight.completed ||= justCompleted;
  return {
    completed: justCompleted,
    progress: spotlight.progress,
    expired: spotlight.age >= spotlight.expiresIn && !spotlight.completed,
  };
}

export function monsterSpotlightSnapshot(spotlight) {
  if (!spotlight) return null;
  return {
    id: spotlight.id,
    label: spotlight.label,
    progress: spotlight.progress,
    goal: spotlight.goal,
    completed: spotlight.completed,
    age: spotlight.age,
  };
}
