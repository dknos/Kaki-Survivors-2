import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RacingCameraMode,
  availableCameraModes,
  cycleCameraMode,
} from '../src/racing/cameras/cameraModes.js';
import {
  RACING_CAMERA_PROFILES,
  cameraProfileForSession,
} from '../src/racing/cameras/racingCameraProfile.js';
import { TrackVisionAnalyzer } from '../src/racing/cameras/trackVisionAnalyzer.js';
import { RacingVisionController } from '../src/racing/cameras/racingVisionController.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative) => readFile(path.join(REPO_ROOT, relative), 'utf8');

const samples = [];
let x = 0;
let z = 0;
for (let i = 0; i < 90; i++) {
  const turn = Math.max(0, Math.min(1, (i - 28) / 18));
  const angle = turn * Math.PI * 0.5;
  const tangent = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
  if (i > 0) {
    x += tangent.x;
    z += tangent.z;
  }
  samples.push({
    x,
    y: 0,
    z,
    tangent,
    normal: { x: -tangent.z, y: 0, z: tangent.x },
  });
}

const analyzer = new TrackVisionAnalyzer({
  mode: 'draw',
  samples,
  loop: false,
  trackWidth: 10,
  worldOffset: { x: 720, y: 0, z: -520 },
});
const slow = analyzer.analyze({
  position: { x: 720, y: 0, z: -520 },
  velocity: { x: 0, y: 0, z: 5 },
  yaw: 0,
  speed: 5,
  nearestIndex: 2,
  grounded: true,
});
const fast = analyzer.analyze({
  position: { x: 720, y: 0, z: -520 },
  velocity: { x: 0, y: 0, z: 25 },
  yaw: 0,
  speed: 25,
  nearestIndex: 2,
  grounded: true,
});
assert.ok(fast.lookAheadMeters > slow.lookAheadMeters + 10, 'vision distance does not grow with speed');
assert.ok(fast.apex && fast.exit, 'circuit vision did not resolve an apex and exit');
assert.ok(['approach', 'braking_to_apex', 'turn_in'].includes(fast.stage), `unexpected approach stage: ${fast.stage}`);

const apexVision = analyzer.analyze({
  position: { x: 735, y: 0, z: -490 },
  velocity: { x: 12, y: 0, z: 12 },
  yaw: Math.PI * 0.25,
  speed: 20,
  nearestIndex: 34,
  grounded: true,
});
assert.ok(
  ['turn_in', 'apex_to_exit', 'linked_exit'].includes(apexVision.stage),
  `vision did not advance toward corner exit near the apex: ${apexVision.stage}`,
);

const fpvProfile = RACING_CAMERA_PROFILES.rally;
const visionController = new RacingVisionController();
const controllerResult = visionController.update(1 / 60, {
  vehicle: { yaw: 0, speed: 24, maxSpeed: 31, pitch: 0.1, roll: 0.2 },
  eye: { x: 0, y: 1.6, z: 0 },
  analyzer: { analyze: () => ({ target: { x: 30, y: 1, z: 5 }, tightness: 1, stage: 'turn_in', lookAheadMeters: 30 }) },
  profile: fpvProfile,
  input: {},
});
assert.ok(controllerResult.automaticYaw > 0.5, 'tight corner did not rotate the virtual head');
assert.ok(
  controllerResult.automaticYaw <= fpvProfile.fpvMaxYawDegrees * Math.PI / 180 + 1e-9,
  'automatic FPV yaw exceeded its vehicle profile limit',
);

assert.equal(cycleCameraMode(RacingCameraMode.ISOMETRIC, 1), RacingCameraMode.CHASE);
assert.equal(cycleCameraMode(RacingCameraMode.ISOMETRIC, -1), RacingCameraMode.DRIVER_FPV);
assert.deepEqual(
  availableCameraModes(RACING_CAMERA_PROFILES.pocket_pouncer),
  [RacingCameraMode.ISOMETRIC, RacingCameraMode.CHASE],
  'Pocket Rally Pouncer should keep its authored 2.5D presentation instead of exposing FPV',
);
assert.equal(cameraProfileForSession({ raceMode: 'monster', monsterVehicleId: 'cyber' }).id, 'cyber');
assert.equal(cameraProfileForSession({ raceMode: 'trials', vehicle: { id: 'buggy' } }).id, 'pocket_pouncer');
for (const profile of Object.values(RACING_CAMERA_PROFILES)) {
  for (const field of [
    'fpvEyePosition', 'fpvBaseFov', 'fpvSeatHeightRange', 'fpvMaxYawDegrees',
    'fpvMaxPitchDegrees', 'fpvInteriorVisibility', 'fpvHorizonStability',
    'fpvSuspensionMotion', 'fpvCollisionMotion', 'chaseDistance', 'chaseHeight',
    'chaseLookHeight', 'chaseMinDistance', 'chaseMaxDistance',
    'chaseSpeedDistanceMultiplier', 'chaseBaseFov', 'chaseMaxFov',
    'chasePositionDamping', 'chaseRotationDamping', 'chaseCollisionRadius',
  ]) assert.ok(field in profile, `${profile.id} camera profile is missing ${field}`);
}

const [managerSource, collisionSource, inputSource, fpvSource, rallySource, trialsSource, mainSource, cssSource, gamepadSource] = await Promise.all([
  source('src/racing/cameras/racingCameraManager.js'),
  source('src/racing/cameras/chaseCameraCollision.js'),
  source('src/racing/cameras/cameraInput.js'),
  source('src/racing/cameras/driverFpvCameraRig.js'),
  source('src/racing/index.js'),
  source('src/racing/trialsMode.js'),
  source('src/main.js'),
  source('src/racing/racing.css'),
  source('src/gamepad.js'),
]);
for (const method of [
  'bindVehicle', 'bindTrack', 'setCameraMode', 'cycleCamera', 'resetCamera',
  'onVehicleRespawned', 'onVehicleChanged', 'onTrackChanged', 'getCurrentMode',
]) assert.match(managerSource, new RegExp(`\\b${method}\\s*\\(`), `camera manager is missing ${method}()`);
assert.match(managerSource, /transitionDuration\s*=\s*0\.3/, 'default camera transition is not 0.3 seconds');
assert.match(managerSource, /slerpQuaternions/, 'camera transitions do not slerp rotation');
assert.match(managerSource, /THREE\.MathUtils\.lerp\(transition\.fov/, 'camera transitions do not interpolate FOV');
assert.match(managerSource, /kks_racing_camera_mode_v1/, 'camera preference is not persisted');
assert.doesNotMatch(fpvSource, /\.add\([^)]*camera/i, 'FPV camera appears to be parented to the vehicle');
assert.doesNotMatch(inputSource, /KeyC/, 'camera cycling should only be exposed by the on-screen control');
assert.match(inputSource, /KeyV/, 'camera InputMap lacks recenter');
assert.match(inputSource, /KeyB/, 'camera InputMap lacks look-back');
assert.match(inputSource, /NumpadAdd/, 'camera InputMap lacks keyboard zoom');
assert.match(inputSource, /passive:\s*false/, 'camera wheel zoom must be able to prevent page scrolling');
assert.doesNotMatch(inputSource, /justPressed\?\.rs/, 'right-stick click still changes the on-screen-only camera');
assert.match(managerSource, /MIN_ZOOM\s*=\s*0\.72/, 'camera zoom-in bound is missing');
assert.match(managerSource, /MAX_ZOOM\s*=\s*1\.42/, 'camera zoom-out bound is missing');
assert.match(collisionSource, /object\.isInstancedMesh && object\.userData\?\.cameraBlocker !== true/, 'chase collision still raycasts bulk instanced dressing');
assert.match(collisionSource, /intersectObjects\(this\._boomCandidates, false, this\._hits\)/, 'chase boom allocates a hit array for every ray');
assert.match(collisionSource, /intersectObjects\(this\._foregroundCandidates, false, this\._hits\)/, 'chase foreground probe allocates a hit array for every ray');
assert.match(collisionSource, /prepareBoomCandidates\(focus, desired\)/, 'chase collision does not broad-phase its boom raycasts');
assert.match(collisionSource, /crowd\|audience\|spectator/, 'chase collision does not exclude audience dressing');
assert.match(collisionSource, /candidateBounds/, 'chase collision does not cache blocker world bounds per frame');
assert.match(collisionSource, /if \(!this\._foregroundCandidates\.length\) return null;/, 'chase collision still casts foreground rays with no nearby blocker');
assert.match(rallySource, /camera-collision-proxy/, 'rivals still expose every render mesh to chase collision');
assert.match(rallySource, /visual\.root\.userData\.cameraIgnore = true/, 'rival render hierarchies are not excluded behind their collision proxy');
assert.match(gamepadSource, /rs:\s*11/, 'gamepad sampler does not expose right-stick click');
assert.match(rallySource, /attachRacingCameraManager\(session, options\.cameraHost/, 'isometric rally does not bind the camera subsystem');
assert.match(trialsSource, /attachRacingCameraManager\(session, options\.cameraHost/, 'Trials does not bind the camera subsystem');
assert.match(mainSource, /updateRacingCamera\(logicDt/, 'main frame loop does not advance the camera manager');
assert.match(mainSource, /setActiveCamera: _setActiveCamera/, 'render pipeline has no active-camera handoff');
assert.match(cssSource, /\.kkr-camera-cycle/, 'compact camera control is not styled');

console.log('Kaki Rally camera subsystem smoke passed');
