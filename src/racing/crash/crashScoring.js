import {
  CRASH_CHAIN_TIMEOUT,
  CRASH_MAX_RUN_SECONDS,
  CRASH_SCORE,
  CRASH_TRAFFIC_PROFILES,
} from './crashConfig.js';

function orderedPair(a, b) {
  return String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`;
}

export function createCrashScoreState(startedAt = 0) {
  return {
    score: 0,
    chain: 0,
    longestChain: 0,
    chainStartedAt: 0,
    chainDuration: 0,
    lastQualifyingImpactAt: Number(startedAt) || 0,
    firstImpactAt: -1,
    largestImpact: null,
    participants: new Set(),
    classes: new Set(),
    blockedLanes: new Set(),
    specials: new Set(),
    pairCooldowns: new Map(),
    events: [],
    boomCharge: 0,
    boomUsed: false,
    runStartedAt: Number(startedAt) || 0,
    qualifyingImpacts: 0,
  };
}

export function scoreCrashImpact(state, event, now) {
  if (!state || !event) return { awarded: 0, qualified: false, reason: 'missing' };
  const time = Number(now) || 0;
  const a = String(event.aId || 'environment');
  const b = String(event.bId || 'environment');
  const pair = orderedPair(a, b);
  const relativeSpeed = Math.max(0, Number(event.relativeSpeed) || 0);
  const impulse = Math.max(0, Number(event.impulse) || Number(event.force) * (Number(event.dt) || 1 / 90) || 0);
  if (relativeSpeed < CRASH_SCORE.minimumRelativeSpeed || impulse < CRASH_SCORE.minimumImpulse) {
    return { awarded: 0, qualified: false, reason: 'threshold' };
  }
  if ((state.pairCooldowns.get(pair) || -Infinity) > time) {
    return { awarded: 0, qualified: false, reason: 'cooldown' };
  }
  state.pairCooldowns.set(pair, time + CRASH_SCORE.pairCooldown);
  const classA = event.aClass || 'environment';
  const classB = event.bClass || 'environment';
  const modifier = Math.max(
    CRASH_TRAFFIC_PROFILES[classA]?.value || (classA === 'player' ? 1.2 : 0.72),
    CRASH_TRAFFIC_PROFILES[classB]?.value || (classB === 'player' ? 1.2 : 0.72),
  );
  let awarded = Math.round(Math.sqrt(impulse) * relativeSpeed * modifier * 2.15);
  const newParticipants = [];
  for (const [id, classId, eligible] of [
    [a, classA, event.aParticipant !== false],
    [b, classB, event.bParticipant !== false],
  ]) {
    if (!eligible) continue;
    if (id === 'environment' || id === 'ground' || id === 'player') continue;
    if (!state.participants.has(id)) {
      state.participants.add(id);
      newParticipants.push(id);
      awarded += CRASH_SCORE.participantBonus;
      if (classId && !state.classes.has(classId)) {
        state.classes.add(classId);
        awarded += CRASH_SCORE.classBonus;
      }
    }
  }
  if (state.firstImpactAt < 0) {
    state.firstImpactAt = time;
    state.chainStartedAt = time;
  }
  state.lastQualifyingImpactAt = time;
  state.chain = state.participants.size;
  state.longestChain = Math.max(state.longestChain, state.chain);
  state.chainDuration = Math.max(0, time - state.chainStartedAt);
  state.score += awarded;
  state.qualifyingImpacts += 1;
  state.boomCharge = Math.min(1, state.boomCharge + Math.min(0.24, impulse / 72000 + newParticipants.length * 0.055));
  const scored = {
    time, aId: a, bId: b, aClass: classA, bClass: classB,
    impulse, relativeSpeed, value: awarded, participants: [...newParticipants],
    point: event.point || null,
  };
  state.events.push(scored);
  if (!state.largestImpact || scored.value > state.largestImpact.value) state.largestImpact = scored;
  return { awarded, qualified: true, reason: 'impact', event: scored };
}

export function awardCrashSpecial(state, kind, value = 0, now = 0, detail = {}) {
  if (!state || state.specials.has(kind)) return 0;
  state.specials.add(kind);
  const defaults = {
    rollover: CRASH_SCORE.rolloverBonus,
    airborne: CRASH_SCORE.airborneBonus,
    jackknife: CRASH_SCORE.jackknifeBonus,
    bus: CRASH_SCORE.busBonus,
    tanker: CRASH_SCORE.tankerBonus,
    structure: CRASH_SCORE.structureBonus,
    gridlock: CRASH_SCORE.gridlockBonus,
  };
  const awarded = Math.round(Number(value) || defaults[kind] || 500);
  state.score += awarded;
  state.events.push({ type: kind, time: Number(now) || 0, value: awarded, ...detail });
  return awarded;
}

export function markCrashLaneBlocked(state, laneId, now = 0) {
  if (!state || !laneId || state.blockedLanes.has(laneId)) return 0;
  state.blockedLanes.add(laneId);
  const awarded = CRASH_SCORE.laneBlockedBonus;
  state.score += awarded;
  state.events.push({ type: 'lane-blocked', laneId, time: Number(now) || 0, value: awarded });
  if (state.blockedLanes.size >= 4) awardCrashSpecial(state, 'gridlock', 0, now);
  return awarded;
}

export function crashChainShouldSettle(state, now) {
  if (!state || state.firstImpactAt < 0) return false;
  const time = Number(now) || 0;
  return time - state.lastQualifyingImpactAt >= CRASH_CHAIN_TIMEOUT
    || time - state.runStartedAt >= CRASH_MAX_RUN_SECONDS;
}

export function crashMedalForScore(score) {
  const value = Math.max(0, Number(score) || 0);
  if (value >= 100000) return 'PLATINUM PAW';
  if (value >= 62000) return 'GOLD PAW';
  if (value >= 34000) return 'SILVER PAW';
  if (value >= 15000) return 'BRONZE PAW';
  return 'WARM-UP';
}

export function crashScoreSnapshot(state, now = 0) {
  return {
    score: Math.round(state?.score || 0),
    chain: state?.chain || 0,
    longestChain: state?.longestChain || 0,
    // Chain duration is the span between qualifying impacts. Quiet-settle and
    // post-impact replay-tail time must not inflate the result.
    chainDuration: state?.firstImpactAt >= 0 ? state.chainDuration : 0,
    vehicles: state?.participants?.size || 0,
    classes: state?.classes?.size || 0,
    lanesBlocked: state?.blockedLanes?.size || 0,
    boomCharge: state?.boomCharge || 0,
    boomUsed: !!state?.boomUsed,
    largestImpact: state?.largestImpact || null,
    specials: [...(state?.specials || [])],
    medal: crashMedalForScore(state?.score || 0),
  };
}
