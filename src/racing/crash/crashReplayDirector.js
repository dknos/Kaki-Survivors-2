const EVENT_WEIGHT = Object.freeze({
  'highest-impact': 9,
  impact: 5,
  explosion: 8,
  kakiBoom: 8.5,
  jackknife: 7.5,
  rollover: 6.5,
  'structure-collapse': 7,
  'new-participant': 3,
});

export function rankReplayHighlights(events = []) {
  return events.map((event, index) => ({
    ...event,
    _index: index,
    highlightScore: (EVENT_WEIGHT[event.type] || 1)
      + Math.log10(1 + Math.max(0, Number(event.impulse) || Number(event.value) || Number(event.force) || 0)),
  })).sort((a, b) => b.highlightScore - a.highlightScore || a.time - b.time);
}

function impactMagnitude(event) {
  return Math.max(0, Number(event?.impulse) || Number(event?.value) || Number(event?.force) || 0);
}

export function selectLargestReplayImpact(events = []) {
  return events.filter((event) => event.type === 'impact')
    .sort((a, b) => impactMagnitude(b) - impactMagnitude(a) || a.time - b.time)[0] || null;
}

export function replayWindowForHighlights(events = [], history = {}) {
  const ranked = rankReplayHighlights(events);
  const largest = selectLargestReplayImpact(ranked) || ranked[0] || { time: Number(history.end) || 0 };
  const earliest = Number(history.start) || 0;
  const latest = Math.max(earliest, Number(history.end) || earliest);
  let start = Math.max(earliest, largest.time - 3.15);
  let end = Math.min(latest, start + 10.5);
  if (end - start < 8 && latest - earliest >= 8) start = Math.max(earliest, end - 8);
  if (end - start > 12) end = start + 12;
  return { start, end, duration: end - start, highlight: largest };
}

function pushShot(shots, shot) {
  const previous = shots.at(-1);
  if (previous && previous.family === shot.family) shot.family = shot.alternate || 'crane';
  shots.push({ ...shot });
}

export function buildReplayShotPlan(events = [], window = { start: 0, end: 10 }, options = {}) {
  const ranked = rankReplayHighlights(events);
  const largest = selectLargestReplayImpact(ranked) || ranked[0] || { time: window.start + 3, point: { x: 0, y: 0, z: 0 }, subjectId: 'player' };
  const secondary = ranked.find((event) => event !== largest && event.time > largest.time + 0.55 && event.time < window.end - 0.35)
    || ranked.find((event) => event !== largest && Math.abs(event.time - largest.time) > 0.75)
    || largest;
  const start = Number(window.start) || 0;
  const end = Math.max(start, Number(window.end) || start);
  const duration = Math.max(0.01, end - start);
  const reduced = !!options.reduceMotion;
  const shots = [];
  let cursor = start;
  const emit = (until, shot) => {
    const boundary = Math.max(cursor, Math.min(end, until));
    if (boundary - cursor < 0.18) return false;
    pushShot(shots, { ...shot, start: cursor, end: boundary });
    cursor = boundary;
    return true;
  };

  const establishing = Math.min(1.08, Math.max(0.82, duration * 0.18));
  const preImpact = Math.max(start, Math.min(end, largest.time - 0.68));
  const highlightStart = Math.max(start + Math.min(establishing, duration * 0.34), preImpact);
  emit(Math.min(start + establishing, highlightStart), { family: 'rear_chase', subjectId: 'player', speed: 1 });
  emit(highlightStart, { family: 'front_pursuit', alternate: 'roadside', subjectId: 'player', focus: largest.point, speed: 1 });
  emit(Math.max(cursor + 0.42, Math.min(end, largest.time + 0.48)), {
    family: reduced ? 'roadside' : 'target_pov',
    alternate: 'front_pursuit',
    subjectId: largest.subjectId || largest.bId || 'player',
    focus: largest.point,
    speed: reduced ? 1 : 0.25,
    highlight: true,
  });

  const tailAvailable = Math.max(0, end - cursor);
  const orbitDuration = Math.min(1.15, Math.max(0.22, Math.min(duration * 0.14, tailAvailable * 0.48)));
  const orbitStart = Math.max(cursor, end - orbitDuration);
  const wideAvailable = Math.max(0, orbitStart - cursor);
  const overheadDuration = Math.min(1.05, Math.max(0.22, Math.min(duration * 0.12, wideAvailable)));
  const latestChainEvent = events.filter((event) => ['impact', 'new-participant', 'explosion', 'kakiBoom'].includes(event.type))
    .reduce((latest, event) => Math.max(latest, Number(event.time) || start), start);
  const overheadStart = Math.max(cursor, Math.min(
    orbitStart - 0.18,
    Math.max(orbitStart - overheadDuration, latestChainEvent - 0.08),
  ));

  if (secondary !== largest && secondary.time > cursor + 0.24 && secondary.time < overheadStart - 0.24) {
    emit(Math.max(cursor, secondary.time - 0.28), { family: 'crane', alternate: 'long_lens', subjectId: 'player', focus: largest.point, speed: reduced ? 1 : 0.5 });
    emit(Math.min(overheadStart, secondary.time + 0.72), {
      family: reduced ? 'roadside' : 'wheel_track',
      alternate: 'roadside',
      subjectId: secondary.subjectId || secondary.bId || 'player',
      focus: secondary.point,
      speed: reduced ? 1 : 0.5,
    });
  }
  emit(overheadStart, { family: 'crane', alternate: 'long_lens', subjectId: 'player', focus: largest.point, speed: reduced ? 1 : 0.5 });
  emit(orbitStart, { family: 'overhead', subjectId: 'player', focus: largest.point, speed: reduced ? 1 : 0.5 });
  emit(end, { family: reduced ? 'crane' : 'wreck_orbit', alternate: 'roadside', subjectId: 'player', focus: largest.point, speed: reduced ? 1 : 0.5 });
  return shots;
}

export function replayShotAt(plan, time) {
  return plan.find((shot) => time >= shot.start && time < shot.end) || plan.at(-1) || null;
}

export function scoreReplayCameraCandidate(candidate = {}, previous = null) {
  let score = 0;
  score += Math.max(0, Math.min(1, Number(candidate.lineOfSight) || 0)) * 3;
  score += Math.max(0, Math.min(1, Number(candidate.coverage) || 0)) * 2.5;
  score += Math.max(0, Math.min(1, Number(candidate.twoSubjectFraming) || 0)) * 2;
  score += Math.max(0, Math.min(1, Number(candidate.velocityAlignment) || 0));
  score += Math.max(0, Math.min(1, Number(candidate.distanceFitness) || 0)) * 1.4;
  score += Math.max(0, Math.min(1, Number(candidate.continuity) || 0)) * 0.7;
  score -= Math.max(0, Number(candidate.obstruction) || 0) * 4;
  score -= Math.max(0, Number(candidate.cameraIntrusions) || 0) * 8;
  if (Number.isFinite(candidate.cameraClearance)) score -= Math.max(0, 0.72 - candidate.cameraClearance) * 8;
  score -= Math.max(0, Number(candidate.groundPenalty) || 0) * 3;
  if (previous?.family === candidate.family) score -= 2.2;
  if (previous?.azimuth != null && candidate.azimuth != null && Math.abs(previous.azimuth - candidate.azimuth) < 0.28) score -= 1.3;
  return score;
}
