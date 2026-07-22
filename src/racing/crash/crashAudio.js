import {
  playRacingImpact,
  sfx,
  stopRacingAudio,
  updateRacingAudio,
} from '../../audio.js';

export function createCrashAudio() {
  return { lastImpactAt: -Infinity, lastGlassAt: -Infinity, lastClatterAt: -Infinity, voices: [], disposed: false };
}

export function updateCrashAudio(audio, player, controls = {}, playback = null) {
  if (!audio || audio.disposed || !player?.body) return;
  const recordedVelocity = playback?.sample?.linearVelocity;
  const velocity = recordedVelocity
    ? { x: recordedVelocity[0] || 0, y: recordedVelocity[1] || 0, z: recordedVelocity[2] || 0 }
    : player.body.linvel();
  const recordedRotation = playback?.sample?.quaternion;
  const rotation = recordedRotation
    ? { x: recordedRotation[0] || 0, y: recordedRotation[1] || 0, z: recordedRotation[2] || 0, w: recordedRotation[3] ?? 1 }
    : player.body.rotation();
  const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
  const forwardZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
  const forwardSpeed = velocity.x * forwardX + velocity.z * forwardZ;
  const lateral = velocity.x * forwardZ - velocity.z * forwardX;
  const timeScale = Math.max(0.12, Math.min(1, Number(playback?.speed) || 1));
  updateRacingAudio({
    // Driving the shared engine model from recorded velocity and replay speed
    // creates a restrained slow-motion pitch/low-pass treatment without
    // rewiring the game's global audio buses.
    speed: Math.hypot(velocity.x, velocity.z) * timeScale,
    throttle: controls.throttle || 0,
    slip: Math.min(1, Math.abs(lateral) / 8),
    airborne: player.cameraState?.grounded === false,
    boost: false,
    wheelRpm: Math.abs(forwardSpeed) * 11 * timeScale,
    gear: Math.max(1, Math.min(5, Math.ceil(Math.abs(forwardSpeed) / 7))),
    engineLoad: Math.abs(controls.throttle || 0),
    groundedWheels: player.cameraState?.groundedWheels ?? 4,
  });
}

export function playCrashContact(audio, event, time) {
  if (!audio || audio.disposed) return false;
  if (time - audio.lastImpactAt < 0.035) return false;
  audio.lastImpactAt = time;
  const impulseWeight = Math.sqrt(Math.max(0, event.impulse || 0) / 11000);
  const speedWeight = Math.min(1.35, Math.max(0.2, (event.relativeSpeed || 0) / 15));
  const strength = Math.min(1.6, Math.max(0.12, impulseWeight * speedWeight));
  const heavy = ['bus', 'boxTruck', 'semi', 'trailer', 'tanker'].includes(event.aClass)
    || ['bus', 'boxTruck', 'semi', 'trailer', 'tanker'].includes(event.bClass);
  return playRacingImpact({ strength: heavy ? strength * 1.24 : strength, kind: heavy ? 'smash' : 'crash' });
}

export function playCrashGlassAudio(audio, time) {
  if (!audio || audio.disposed || time - audio.lastGlassAt < 0.12) return false;
  audio.lastGlassAt = time;
  try { sfx.crystalShatter?.(); } catch (_) {}
  return true;
}

export function playCrashDetachedAudio(audio, time) {
  if (!audio || audio.disposed || time - audio.lastClatterAt < 0.08) return false;
  audio.lastClatterAt = time;
  try { sfx.grappleImpact?.({ charge: 0.35 }); } catch (_) {}
  return playRacingImpact({ strength: 0.24, kind: 'landing' });
}

export function playKakiBoomAudio() {
  try { sfx.bossShockwave?.(); } catch (_) {}
  try { sfx.explosion?.(); } catch (_) {}
}

export function playKakiBoomChargeAudio() {
  try { sfx.bossWarn?.(); } catch (_) {}
}

export function playCrashExplosionAudio() {
  try { sfx.explosion?.(); } catch (_) {}
  playRacingImpact({ strength: 1.5, kind: 'smash' });
}

export function resetCrashReplayAudio(audio) {
  if (!audio || audio.disposed) return false;
  audio.lastImpactAt = -Infinity;
  audio.lastGlassAt = -Infinity;
  audio.lastClatterAt = -Infinity;
  return true;
}

export function disposeCrashAudio(audio) {
  if (!audio || audio.disposed) return false;
  audio.disposed = true;
  stopRacingAudio();
  return true;
}
