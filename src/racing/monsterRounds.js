/** Pure five-level progression for Monster Smash. The run clock is informational only. */

export const MONSTER_ROUND_SECONDS = 30;
export const MONSTER_ROUND_COUNT = 5;
export const MONSTER_FREESTYLE_SECONDS = 120;
export const MONSTER_EVENT_MODES = Object.freeze(['smashdown', 'freestyle', 'free-ride']);

const ids = (targets, predicate) => targets.filter(predicate).map((target) => target.id);
const group = (targets, prefix) => ids(targets, (target) => target.id.startsWith(prefix));

export function createMonsterRoundDefinitions(definition) {
  const targets = definition?.targets || [];
  if (definition?.id !== 'pileup-pyramid-yard') {
    const district = (name) => ids(targets, (target) => target.district === name);
    const central = district('central-spine');
    const crusher = district('crusher-alley');
    const gap = district('bus-rv-gap');
    const bowl = district('demolition-bowl');
    const crown = district('crown-jump');
    return Object.freeze([
      Object.freeze({ number: 1, name: 'FIRST DENTS', targetIds: Object.freeze(central) }),
      Object.freeze({ number: 2, name: 'CRUSHER ALLEY', targetIds: Object.freeze(crusher) }),
      Object.freeze({ number: 3, name: 'BUS GAP', targetIds: Object.freeze([...gap, ...central]) }),
      Object.freeze({ number: 4, name: 'BOWL BRAWL', targetIds: Object.freeze([...bowl, ...crown, ...central]) }),
      Object.freeze({ number: 5, name: 'COLISEUM CHAOS', targetIds: Object.freeze([...targets]) }),
    ]);
  }
  const heavy = ids(targets, (target) => target.district === 'heavy-gauntlet');
  const stunt = group(targets, 'stunt-line-');
  const bales = group(targets, 'fire-bale-');
  const cars = group(targets, 'car-pyramid-');
  const buses = group(targets, 'bus-pyramid-');
  const blast = group(targets, 'blast-pinwheel-');
  const north = group(targets, 'domino-north-');
  const east = group(targets, 'domino-east-');
  const south = group(targets, 'domino-south-');
  const west = group(targets, 'domino-west-');
  return Object.freeze([
    Object.freeze({ number: 1, name: 'STUNT SCHOOL', targetIds: Object.freeze([...heavy, ...stunt]) }),
    Object.freeze({ number: 2, name: 'BALE BREAKER', targetIds: Object.freeze([...cars, ...bales]) }),
    Object.freeze({ number: 3, name: 'PYRAMID PANIC', targetIds: Object.freeze([...buses, ...blast, ...bales, ...stunt]) }),
    Object.freeze({ number: 4, name: 'DOMINO CROSS', targetIds: Object.freeze([...north, ...east]) }),
    Object.freeze({ number: 5, name: 'GRAND FINALE', targetIds: Object.freeze([...south, ...west, ...cars]) }),
  ]);
}

export function createMonsterRoundState(definition, mode = 'smashdown') {
  const eventMode = MONSTER_EVENT_MODES.includes(mode) ? mode : 'smashdown';
  const authoredRounds = createMonsterRoundDefinitions(definition);
  const openRound = Object.freeze({
    number: 1,
    name: eventMode === 'free-ride' ? 'FREE RIDE' : 'FREESTYLE',
    targetIds: Object.freeze((definition?.targets || []).map((target) => target.id)),
  });
  const rounds = eventMode === 'smashdown' ? authoredRounds : Object.freeze([openRound]);
  return {
    mode: eventMode,
    rounds,
    index: 0,
    // Smashdown has no fail clock. Keep the field for snapshot/API compatibility,
    // but it is intentionally infinite and never decremented.
    timeRemaining: eventMode === 'free-ride' || eventMode === 'smashdown' ? Infinity : MONSTER_FREESTYLE_SECONDS,
    elapsedTime: 0,
    roundElapsed: 0,
    roundTimes: [],
    totalCrushed: 0,
    transitionTime: 0,
    won: false,
  };
}

export function currentMonsterRound(state) {
  return state?.rounds?.[state.index] || null;
}

export function activeMonsterRoundDestroyed(state, arena) {
  const active = new Set(currentMonsterRound(state)?.targetIds || []);
  return (arena?.targets || []).filter((target) => active.has(target.id) && target.destroyed).length;
}

/** Lower completion times earn the stronger rank. Incomplete runs are unranked. */
export function monsterRoundRank(totalTime, completed = true) {
  if (!completed || !Number.isFinite(totalTime) || totalTime <= 0) return 'DNF';
  return totalTime <= 75 ? 'S' : totalTime <= 100 ? 'A' : totalTime <= 120 ? 'B' : totalTime <= 135 ? 'C' : 'D';
}
