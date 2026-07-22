/** Monster Arena public facade kept small so racing/index.js stays lifecycle-focused. */
import { buildCyberTruckVisual, buildMightyMeowsterVisual, buildTipsyTumblerVisual } from './racingVehicles.js';
import {
  attachMonsterTrafficModels,
  createMonsterDestruction,
  configureMonsterDestructionRound,
  monsterDestructionSnapshot,
  MONSTER_TARGET_CLASSES,
  refillMonsterDestruction,
  resolveMonsterDestruction,
  updateMonsterDestruction,
} from './monsterDestruction.js';

export {
  MONSTER_TUNING,
  MONSTER_VEHICLE_PROFILES,
  awardMonsterEvent,
  awardMonsterRow,
  awardMonsterSignature,
  awardMonsterSmash,
  breakMonsterChain,
  createMonsterScoreState,
  getMonsterVehicleProfile,
  resolveMonsterSmashes,
  stepMonsterChaos,
  stepMonsterSignatureStunts,
  stepMonsterStunts,
} from './monsterScoring.js';

export {
  attachMonsterTrafficModels,
  createMonsterDestruction,
  configureMonsterDestructionRound,
  MONSTER_TARGET_CLASSES,
  refillMonsterDestruction,
  resolveMonsterDestruction,
  updateMonsterDestruction,
};

export function buildMonsterTruck(options = {}) {
  return buildMightyMeowsterVisual(options);
}

export function buildCyberTruck(options = {}) {
  return buildCyberTruckVisual(options);
}

export function buildTipsyTumbler(options = {}) {
  return buildTipsyTumblerVisual(options);
}

/** Compatibility alias for older callers; the new arena owns authored specs. */
export function buildMonsterTargets(definition, root, owned, assetLease = null) {
  return createMonsterDestruction({ definition, root, owned, assetLease });
}

export function updateMonsterTargets(arena, dt, kart = null, options = {}) {
  return updateMonsterDestruction(arena, dt, kart, options);
}

export function monsterSnapshot(arena, run, kart, arenaView = null, vehicleId = 'meowster') {
  return {
    score: Math.round(run?.score || 0),
    combo: run?.combo || 1,
    wreckChain: run?.wreckChain || run?.combo || 1,
    bestWreckChain: run?.bestWreckChain || 1,
    chaos: run?.chaos || 0,
    chaosSpent: run?.chaosSpent || 0,
    smashed: arena?.destroyed || 0,
    totalTargets: arena?.targets?.length || 0,
    totalAirTime: run?.totalAirTime || 0,
    bestAirTime: run?.bestAirTime || 0,
    bestTrick: run?.bestTrick || '',
    pendingTrick: run?.pendingTrick || null,
    flips: run?.flips || 0,
    barrelRolls: run?.barrelRolls || 0,
    perfectLandings: run?.perfectLandings || 0,
    derbyKnockouts: run?.derbyKnockouts || 0,
    classCrushes: run?.classCrushes || {},
    vehicleId,
    stuntPitch: kart?.stuntPitch || 0,
    stuntRoll: kart?.stuntRoll || 0,
    wheelRadius: 1.05,
    collisionRadius: kart?.collisionRadius || 2.65,
    mass: kart?.mass || 2.6,
    destruction: monsterDestructionSnapshot(arena),
    arena: arenaView,
  };
}
