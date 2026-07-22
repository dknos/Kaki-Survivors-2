/** Runtime generation helpers shared by Draw Your Track and Kaki Rally. */
import * as THREE from 'three';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function circularIndexDelta(from, to, count) {
  let delta = to - from;
  const half = count * 0.5;
  if (delta > half) delta -= count;
  else if (delta < -half) delta += count;
  return delta;
}

function circularIndexDistance(a, b, count) {
  return Math.abs(circularIndexDelta(a, b, count));
}

function sampleDistances(samples) {
  const distances = new Float64Array(samples.length + 1);
  let total = 0;
  for (let i = 1; i <= samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i % samples.length];
    total += Math.hypot(current.x - previous.x, current.z - previous.z);
    distances[i] = total;
  }
  return { distances, total };
}

function cyclicDistance(a, b, total) {
  const direct = Math.abs(a - b);
  return Math.min(direct, total - direct);
}

export class TrackMeshBuilder {
  /** Add gentle cosine ramps to the branch selected by the validator. */
  static applyElevation(samples, course) {
    const overpasses = Array.isArray(course?.overpasses) ? course.overpasses : [];
    for (const sample of samples) {
      sample.y = Number(sample.y) || 0;
      sample.overpassIds = [];
    }
    if (!overpasses.length || samples.length < 8) return samples;
    const { distances, total } = sampleDistances(samples);
    for (const bridge of overpasses) {
      const center = (((Number(bridge.fraction) || 0) % 1) + 1) % 1 * total;
      const approach = Math.max(22, Number(bridge.approachLength) || 30);
      const height = Math.max(4.4, Number(bridge.height) || 5.2);
      for (let i = 0; i < samples.length; i++) {
        const d = cyclicDistance(distances[i], center, total);
        if (d > approach) continue;
        const phase = d / approach;
        const elevation = height * 0.5 * (1 + Math.cos(Math.PI * phase));
        if (elevation > samples[i].y) samples[i].y = elevation;
        if (elevation > 0.28) samples[i].overpassIds.push(bridge.id);
      }
    }
    for (let i = 0; i < samples.length; i++) {
      const previous = samples[(i - 1 + samples.length) % samples.length];
      const next = samples[(i + 1) % samples.length];
      const tangent = new THREE.Vector3(next.x - previous.x, next.y - previous.y, next.z - previous.z).normalize();
      samples[i].tangent.copy(tangent);
      const horizontalLength = Math.hypot(tangent.x, tangent.z) || 1;
      samples[i].normal.set(-tangent.z / horizontalLength, 0, tangent.x / horizontalLength);
      samples[i].groundPitch = Math.atan2(tangent.y, horizontalLength);
    }
    return samples;
  }

  /**
   * Build the complete Kaki Skyway kit without creating per-frame geometry
   * work. The road surface already follows the elevated samples; this adds the
   * structure that makes that elevation read as a deliberate overpass rather
   * than a floating strip of track.
   */
  static buildOverpasses({ root, course, samples, owned }) {
    const bridges = Array.isArray(course?.overpasses) ? course.overpasses : [];
    if (!root?.add || !bridges.length || samples.length < 8) return null;
    const group = new THREE.Group();
    group.name = 'draw-track-overpass-kit';
    const railGeometry = new THREE.CapsuleGeometry(0.12, 1.5, 3, 6);
    railGeometry.rotateX(Math.PI * 0.5);
    const pillarGeometry = new THREE.BoxGeometry(0.72, 1, 0.72);
    const beamGeometry = new THREE.BoxGeometry(1, 0.32, 0.48);
    const deckGeometry = new THREE.BoxGeometry(1, 0.34, 1);
    const fasciaGeometry = new THREE.BoxGeometry(0.18, 0.56, 1);
    const portalPostGeometry = new THREE.BoxGeometry(0.36, 1, 0.36);
    const markerGeometry = new THREE.BoxGeometry(0.08, 0.38, 0.58);
    const lampGeometry = new THREE.SphereGeometry(0.18, 8, 6);
    const railMaterial = new THREE.MeshStandardMaterial({
      color: course.curb,
      emissive: course.accent,
      emissiveIntensity: 0.2,
      roughness: 0.48,
      metalness: 0.52,
    });
    const supportMaterial = new THREE.MeshStandardMaterial({ color: 0x5b6066, roughness: 0.68, metalness: 0.42 });
    const deckMaterial = new THREE.MeshStandardMaterial({ color: 0x34393e, roughness: 0.74, metalness: 0.28 });
    const fasciaMaterial = new THREE.MeshStandardMaterial({
      color: course.shoulder,
      emissive: course.accent,
      emissiveIntensity: 0.08,
      roughness: 0.62,
      metalness: 0.34,
    });
    const markerMaterial = new THREE.MeshStandardMaterial({
      color: course.curb,
      emissive: course.accent,
      emissiveIntensity: 0.34,
      roughness: 0.4,
      metalness: 0.3,
    });
    const accentMarkerMaterial = new THREE.MeshStandardMaterial({
      color: course.accent,
      emissive: course.accent,
      emissiveIntensity: 0.5,
      roughness: 0.34,
      metalness: 0.24,
    });
    const lampMaterial = new THREE.MeshStandardMaterial({
      color: 0xfff5c7,
      emissive: course.accent,
      emissiveIntensity: 2.4,
      roughness: 0.22,
      metalness: 0.05,
    });
    owned.geometries.add(railGeometry);
    owned.geometries.add(pillarGeometry);
    owned.geometries.add(beamGeometry);
    owned.geometries.add(deckGeometry);
    owned.geometries.add(fasciaGeometry);
    owned.geometries.add(portalPostGeometry);
    owned.geometries.add(markerGeometry);
    owned.geometries.add(lampGeometry);
    owned.materials.add(railMaterial);
    owned.materials.add(supportMaterial);
    owned.materials.add(deckMaterial);
    owned.materials.add(fasciaMaterial);
    owned.materials.add(markerMaterial);
    owned.materials.add(accentMarkerMaterial);
    owned.materials.add(lampMaterial);

    const railTransforms = [];
    const supportTransforms = [];
    const beamTransforms = [];
    const deckTransforms = [];
    const fasciaTransforms = [];
    const portalPostTransforms = [];
    const portalBeamTransforms = [];
    const markerTransforms = [[], []];
    const lampTransforms = [];
    const sideOffset = course.trackWidth * 0.5 + 0.38;
    for (let i = 0; i < samples.length; i += 2) {
      const sample = samples[i];
      if (sample.y < 0.72 || !sample.overpassIds?.length) continue;
      const previous = samples[(i - 1 + samples.length) % samples.length];
      const next = samples[(i + 1) % samples.length];
      const span = Math.max(0.8, Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z) * 0.58);
      const yaw = Math.atan2(sample.tangent.x, sample.tangent.z);
      const pitch = -Math.atan2(sample.tangent.y, Math.hypot(sample.tangent.x, sample.tangent.z) || 1);
      deckTransforms.push({
        x: sample.x, y: sample.y - 0.31, z: sample.z, yaw, pitch,
        sx: course.trackWidth + 1.28, sy: 1, sz: span,
      });
      for (const side of [-1, 1]) {
        fasciaTransforms.push({
          x: sample.x + sample.normal.x * side * sideOffset,
          y: sample.y - 0.3,
          z: sample.z + sample.normal.z * side * sideOffset,
          yaw, pitch, sx: 1, sy: 1, sz: span,
        });
        if (i % 4 === 0) {
          railTransforms.push({
            x: sample.x + sample.normal.x * side * sideOffset,
            y: sample.y + 0.64,
            z: sample.z + sample.normal.z * side * sideOffset,
            yaw, pitch, sx: 1, sy: 1, sz: Math.max(1.25, span * 1.04),
          });
        }
        if (sample.y > 2.1 && i % 8 === 0) {
          markerTransforms[(i / 8 + (side > 0 ? 1 : 0)) % 2].push({
            x: sample.x + sample.normal.x * side * (sideOffset + 0.1),
            y: sample.y - 0.22,
            z: sample.z + sample.normal.z * side * (sideOffset + 0.1),
            yaw, pitch, sx: 1, sy: 1, sz: 1,
          });
        }
      }
    }
    const { distances, total } = sampleDistances(samples);
    const nearestSample = (targetRaw) => {
      const target = (targetRaw % total + total) % total;
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const d = cyclicDistance(distances[i], target, total);
        if (d < bestDistance) { bestDistance = d; best = i; }
      }
      return samples[best];
    };
    for (const bridge of bridges) {
      const center = (((Number(bridge.fraction) || 0) % 1) + 1) % 1 * total;
      for (const direction of [-1, 1]) {
        const sample = nearestSample(center + direction * bridge.approachLength * 0.46);
        if (sample.y < 2.3) continue;
        const yaw = Math.atan2(sample.tangent.x, sample.tangent.z);
        const supportOffset = course.trackWidth * 0.5 - 0.7;
        for (const side of [-1, 1]) {
          supportTransforms.push({
            x: sample.x + sample.normal.x * side * supportOffset,
            y: sample.y * 0.5 - 0.06,
            z: sample.z + sample.normal.z * side * supportOffset,
            yaw,
            sx: 1,
            sy: sample.y + 0.12,
            sz: 1,
          });
        }
        beamTransforms.push({
          x: sample.x,
          y: sample.y - 0.36,
          z: sample.z,
          yaw,
          sx: course.trackWidth + 1.3,
          sy: 1,
          sz: 1,
        });
      }
      // Twin illuminated portal frames announce the bridge before the player
      // reaches the crossing. They sit well clear of the underpass opening.
      for (const direction of [-1, 1]) {
        const sample = nearestSample(center + direction * bridge.approachLength * 0.27);
        if (sample.y < 2.8) continue;
        const yaw = Math.atan2(sample.tangent.x, sample.tangent.z);
        const postOffset = course.trackWidth * 0.5 + 0.72;
        for (const side of [-1, 1]) {
          portalPostTransforms.push({
            x: sample.x + sample.normal.x * side * postOffset,
            y: sample.y + 1.5,
            z: sample.z + sample.normal.z * side * postOffset,
            yaw, sx: 1, sy: 3, sz: 1,
          });
          lampTransforms.push({
            x: sample.x + sample.normal.x * side * (postOffset - 0.12),
            y: sample.y + 2.82,
            z: sample.z + sample.normal.z * side * (postOffset - 0.12),
            yaw, sx: 1, sy: 1, sz: 1,
          });
        }
        portalBeamTransforms.push({
          x: sample.x,
          y: sample.y + 3.02,
          z: sample.z,
          yaw,
          sx: course.trackWidth + 2.05,
          sy: 1,
          sz: 1,
        });
      }
      // Warm marker lamps under the deck make the lower route legible at
      // speed, especially in the neon and forest themes, without adding real
      // point lights or a per-frame cost.
      const crest = nearestSample(center);
      const underLampOffset = Math.max(1.2, course.trackWidth * 0.28);
      for (const side of [-1, 1]) {
        lampTransforms.push({
          x: crest.x + crest.normal.x * side * underLampOffset,
          y: Math.max(2.8, crest.y - 0.62),
          z: crest.z + crest.normal.z * side * underLampOffset,
          yaw: Math.atan2(crest.tangent.x, crest.tangent.z),
          sx: 1.15, sy: 0.8, sz: 1.15,
        });
      }
    }

    const makeInstances = (geometry, material, transforms, name) => {
      if (!transforms.length) return null;
      const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
      const dummy = new THREE.Object3D();
      transforms.forEach((transform, index) => {
        dummy.position.set(transform.x, transform.y, transform.z);
        dummy.rotation.order = 'YXZ';
        dummy.rotation.set(transform.pitch || 0, transform.yaw || 0, transform.roll || 0);
        dummy.scale.set(transform.sx || 1, transform.sy || 1, transform.sz || 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    makeInstances(deckGeometry, deckMaterial, deckTransforms, 'draw-track-bridge-decks');
    makeInstances(fasciaGeometry, fasciaMaterial, fasciaTransforms, 'draw-track-bridge-fascias');
    makeInstances(railGeometry, railMaterial, railTransforms, 'draw-track-bridge-guardrails');
    makeInstances(pillarGeometry, supportMaterial, supportTransforms, 'draw-track-bridge-supports');
    makeInstances(beamGeometry, supportMaterial, beamTransforms, 'draw-track-bridge-crossbeams');
    makeInstances(portalPostGeometry, supportMaterial, portalPostTransforms, 'draw-track-bridge-portal-posts');
    makeInstances(beamGeometry, railMaterial, portalBeamTransforms, 'draw-track-bridge-portal-beams');
    makeInstances(markerGeometry, markerMaterial, markerTransforms[0], 'draw-track-bridge-checkers-a');
    makeInstances(markerGeometry, accentMarkerMaterial, markerTransforms[1], 'draw-track-bridge-checkers-b');
    makeInstances(lampGeometry, lampMaterial, lampTransforms, 'draw-track-bridge-marker-lights');
    root.add(group);
    return group;
  }
}

export class CheckpointGenerator {
  static generate(samples, trackWidth) {
    if (!samples?.length) return [];
    const { total } = sampleDistances(samples);
    const count = clamp(Math.round(total / 28), 8, 18);
    const checkpoints = [];
    for (let order = 1; order < count; order++) {
      const index = Math.round(samples.length * order / count) % samples.length;
      checkpoints.push({
        id: `checkpoint-${order}`,
        order,
        index,
        width: trackWidth + 8,
        sample: samples[index],
      });
    }
    return checkpoints;
  }

  static reset(kart) {
    kart.drawCheckpoint = {
      next: 0,
      lap: 0,
      lastNearest: Number(kart.nearestIndex) || 0,
      lastPassedIndex: Number(kart.nearestIndex) || 0,
      reversedTime: 0,
    };
    kart.completedLaps = 0;
    return kart.drawCheckpoint;
  }

  static update(kart, nearestIndex, sampleCount, checkpoints, dt = 0) {
    const state = kart.drawCheckpoint || CheckpointGenerator.reset(kart);
    const previous = state.lastNearest;
    const delta = circularIndexDelta(previous, nearestIndex, sampleCount);
    const plausible = Math.abs(delta) <= sampleCount * 0.12;
    state.reversedTime = plausible && delta < -0.25
      ? state.reversedTime + Math.max(0, dt)
      : Math.max(0, state.reversedTime - Math.max(0, dt) * 1.8);
    state.lastNearest = nearestIndex;
    const window = Math.max(3, Math.round(sampleCount / 90));
    const target = checkpoints[state.next];
    if (target && plausible && circularIndexDistance(nearestIndex, target.index, sampleCount) <= window) {
      const absoluteTarget = state.lap * sampleCount + target.index;
      if ((Number(kart.unwrappedIndex) || 0) >= absoluteTarget - window) {
        state.lastPassedIndex = target.index;
        state.next++;
      }
    }
    if (state.next >= checkpoints.length
      && circularIndexDistance(nearestIndex, 0, sampleCount) <= window
      && (Number(kart.unwrappedIndex) || 0) >= (state.lap + 1) * sampleCount - window) {
      state.lap++;
      state.next = 0;
      state.lastPassedIndex = 0;
    }
    kart.completedLaps = state.lap;
    return {
      completedLaps: state.lap,
      nextCheckpoint: checkpoints[state.next] || null,
      reversed: state.reversedTime > 0.75,
    };
  }
}

export class RespawnGenerator {
  static respawn(kart, samples, { useCheckpoint = true, backtrack = 2 } = {}) {
    if (!kart || !samples?.length) return false;
    const checkpointIndex = useCheckpoint ? kart.drawCheckpoint?.lastPassedIndex : null;
    const base = Number.isFinite(checkpointIndex) ? checkpointIndex : Number(kart.nearestIndex) || 0;
    const index = ((Math.round(base) - backtrack) % samples.length + samples.length) % samples.length;
    const sample = samples[index];
    kart.x = sample.x;
    kart.z = sample.z;
    kart.y = sample.y || 0;
    kart.groundHeight = sample.y || 0;
    kart.groundPitch = sample.groundPitch || 0;
    kart.yaw = Math.atan2(sample.tangent.x, sample.tangent.z);
    kart.vx = 0;
    kart.vy = 0;
    kart.vz = 0;
    kart.speed = 0;
    kart.angularVelocity = 0;
    kart.airPitch = 0;
    kart.airRoll = 0;
    kart.grounded = true;
    kart.nearestIndex = index;
    kart.rescueTime = 0;
    return true;
  }
}

export class AIPathGenerator {
  static generate(samples, trackWidth = 9.2) {
    if (!samples?.length) return [];
    const path = [];
    const count = samples.length;
    for (let i = 0; i < count; i++) {
      const previous = samples[(i - 4 + count) % count];
      const next = samples[(i + 7) % count];
      const current = samples[i];
      const ax = current.x - previous.x;
      const az = current.z - previous.z;
      const bx = next.x - current.x;
      const bz = next.z - current.z;
      const al = Math.hypot(ax, az) || 1;
      const bl = Math.hypot(bx, bz) || 1;
      const turn = Math.acos(clamp((ax * bx + az * bz) / (al * bl), -1, 1));
      const slope = Math.abs(current.groundPitch || 0);
      const targetSpeed = clamp(24.5 - turn * 17 - slope * 19 + (trackWidth - 9.2) * 0.18, 8.2, 25.5);
      path.push({
        index: i,
        x: current.x,
        y: current.y || 0,
        z: current.z,
        tangent: current.tangent,
        normal: current.normal,
        targetSpeed,
        turn,
      });
    }
    // Brake before the corner, not when the kart is already inside it.
    for (let i = 0; i < count; i++) {
      for (let look = 1; look <= 12; look++) {
        const future = path[(i + look) % count].targetSpeed + look * 0.42;
        path[i].targetSpeed = Math.min(path[i].targetSpeed, future);
      }
    }
    return path;
  }

  static validate(path) {
    if (!Array.isArray(path) || path.length < 48) return { valid: false, reason: 'AI route is incomplete' };
    for (let i = 0; i < path.length; i++) {
      const point = path[i];
      const next = path[(i + 1) % path.length];
      if (![point.x, point.y, point.z, point.targetSpeed].every(Number.isFinite)) {
        return { valid: false, reason: 'AI route contains invalid numbers' };
      }
      if (Math.hypot(next.x - point.x, next.z - point.z) > 9) {
        return { valid: false, reason: 'AI route has a discontinuity' };
      }
      if (Math.abs(point.tangent?.y || 0) > 0.22) {
        return { valid: false, reason: 'Bridge grade exceeds the AI-safe limit' };
      }
    }
    return { valid: true, reason: '' };
  }
}
