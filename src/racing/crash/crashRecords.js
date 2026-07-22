import { CRASH_RECORD_KEY } from './crashConfig.js';
import { crashMedalForScore } from './crashScoring.js';

function safeRecord(value = {}) {
  return {
    score: Math.max(0, Math.round(Number(value.score) || 0)),
    medal: String(value.medal || crashMedalForScore(value.score)),
    vehicleId: String(value.vehicleId || 'muscle'),
    junctionId: String(value.junctionId || 'pawprint-interchange'),
    vehicles: Math.max(0, Math.round(Number(value.vehicles) || 0)),
    largestImpact: Math.max(0, Math.round(Number(value.largestImpact) || 0)),
    at: Math.max(0, Number(value.at) || 0),
  };
}

export function readCrashRecord(storage = globalThis.localStorage) {
  try {
    return safeRecord(JSON.parse(storage?.getItem?.(CRASH_RECORD_KEY) || '{}'));
  } catch (_) {
    return safeRecord();
  }
}

export function writeCrashRecord(result, storage = globalThis.localStorage) {
  const previous = readCrashRecord(storage);
  const candidate = safeRecord(result);
  if (candidate.score < previous.score) return { record: previous, isPersonalBest: false };
  const isPersonalBest = candidate.score > previous.score;
  try { storage?.setItem?.(CRASH_RECORD_KEY, JSON.stringify(candidate)); } catch (_) {}
  return { record: candidate, isPersonalBest };
}

export function clearCrashRecord(storage = globalThis.localStorage) {
  try { storage?.removeItem?.(CRASH_RECORD_KEY); } catch (_) {}
}
