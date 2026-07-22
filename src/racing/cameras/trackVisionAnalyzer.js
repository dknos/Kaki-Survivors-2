const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapIndex(index, count) {
  return ((Math.round(index) % count) + count) % count;
}

function distance2d(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.z || 0) - (a?.z || 0));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function blendPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

function sampleTangent(sample) {
  return sample?.tangent || { x: 0, y: 0, z: 1 };
}

/**
 * Converts Driver61's "one stage ahead" discipline into track-space targets.
 * The analyzer is renderer-free so authored and Draw Your Track circuits share
 * exactly the same vision decisions and can be regression-tested in Node.
 */
export class TrackVisionAnalyzer {
  constructor(trackRuntime = null) {
    this.bindTrack(trackRuntime);
  }

  bindTrack(trackRuntime = null) {
    this.track = trackRuntime || {};
    this.samples = Array.isArray(this.track.samples) ? this.track.samples : [];
    this.worldOffset = this.track.worldOffset || { x: 0, y: 0, z: 0 };
    this.loop = this.track.loop !== false;
    this.trackWidth = Number(this.track.trackWidth) || 10;
    this.spacing = this._measureSpacing();
    this.lastResult = null;
  }

  reset() {
    this.lastResult = null;
  }

  _measureSpacing() {
    if (this.samples.length < 2) return 1;
    let total = 0;
    const count = Math.min(this.loop ? this.samples.length : this.samples.length - 1, 96);
    for (let i = 0; i < count; i++) {
      const next = this.loop ? (i + 1) % this.samples.length : i + 1;
      total += distance2d(this.samples[i], this.samples[next]);
    }
    return Math.max(0.2, total / count);
  }

  _index(index) {
    if (!this.samples.length) return 0;
    return this.loop
      ? wrapIndex(index, this.samples.length)
      : clamp(Math.round(index), 0, this.samples.length - 1);
  }

  _sample(index) {
    return this.samples[this._index(index)];
  }

  _worldPoint(index, lateral = 0, height = 0.78) {
    const sample = this._sample(index) || { x: 0, y: 0, z: 0 };
    const normal = sample.normal || { x: 0, z: 0 };
    return {
      x: this.worldOffset.x + sample.x + normal.x * lateral,
      y: this.worldOffset.y + (sample.y || 0) + height,
      z: this.worldOffset.z + sample.z + normal.z * lateral,
    };
  }

  _signedCurvature(index, span = 3) {
    if (this.samples.length < span * 2 + 1) return 0;
    const before = sampleTangent(this._sample(index - span));
    const after = sampleTangent(this._sample(index + span));
    const dot = clamp(before.x * after.x + before.z * after.z, -1, 1);
    const cross = before.x * after.z - before.z * after.x;
    const distance = Math.max(this.spacing, distance2d(this._sample(index - span), this._sample(index + span)));
    return Math.atan2(cross, dot) / distance;
  }

  _findApex(startIndex, minMeters, maxMeters) {
    const count = this.samples.length;
    if (count < 12) return null;
    const threshold = 0.0095;
    const maxSteps = Math.min(count - 1, Math.ceil(maxMeters / this.spacing));
    const minSteps = Math.max(1, Math.floor(minMeters / this.spacing));
    let inCorner = false;
    let quietSteps = 0;
    let peak = null;
    for (let step = 1; step <= maxSteps; step++) {
      const curvature = this._signedCurvature(startIndex + step);
      const magnitude = Math.abs(curvature);
      if (step >= minSteps && magnitude >= threshold) {
        inCorner = true;
        quietSteps = 0;
        if (!peak || magnitude > Math.abs(peak.curvature)) {
          peak = { index: this._index(startIndex + step), step, distance: step * this.spacing, curvature };
        }
      } else if (inCorner) {
        quietSteps += 1;
        if (quietSteps >= 3) return peak;
      }
    }
    return peak;
  }

  _fallback(vehicle, lookAheadMeters) {
    const position = vehicle.position || { x: 0, y: 0, z: 0 };
    const speed = Math.max(0, Number(vehicle.speed) || 0);
    const velocity = vehicle.velocity || { x: 0, y: 0, z: 0 };
    const velocityLength = Math.hypot(velocity.x || 0, velocity.z || 0);
    const forwardX = velocityLength > 0.4 ? velocity.x / velocityLength : Math.sin(vehicle.yaw || 0);
    const forwardZ = velocityLength > 0.4 ? velocity.z / velocityLength : Math.cos(vehicle.yaw || 0);
    const flightTime = vehicle.grounded === false ? clamp(0.55 + speed * 0.012, 0.55, 1.05) : 0;
    return {
      stage: vehicle.grounded === false ? 'landing' : 'straight',
      target: {
        x: position.x + forwardX * lookAheadMeters + (velocity.x || 0) * flightTime * 0.2,
        y: position.y + 0.82 + Math.max(-1.5, (velocity.y || 0) * flightTime * 0.28),
        z: position.z + forwardZ * lookAheadMeters + (velocity.z || 0) * flightTime * 0.2,
      },
      apex: null,
      exit: null,
      nextApex: null,
      distanceToApex: Infinity,
      tightness: 0,
      turnSign: 0,
      lookAheadMeters,
    };
  }

  analyze(vehicle = {}, options = {}) {
    const speed = Math.max(0, Number(vehicle.speed) || 0);
    const braking = clamp(Number(options.braking ?? vehicle.braking) || 0, 0, 1);
    const lookAheadMeters = clamp(9 + speed * 0.72 + (vehicle.boosting ? 4 : 0), 10, 38);
    if (this.samples.length < 12 || this.track.mode === 'monster' || this.track.mode === 'trials') {
      this.lastResult = this._fallback(vehicle, lookAheadMeters);
      return this.lastResult;
    }

    const currentIndex = this._index(vehicle.nearestIndex || 0);
    const apex = this._findApex(currentIndex, 1.5, Math.max(34, lookAheadMeters + 24));
    if (!apex) {
      const targetIndex = currentIndex + Math.round(lookAheadMeters / this.spacing);
      this.lastResult = {
        ...this._fallback(vehicle, lookAheadMeters),
        target: this._worldPoint(targetIndex, 0, 0.82),
      };
      return this.lastResult;
    }

    const turnSign = Math.sign(apex.curvature) || 1;
    const tightness = clamp(Math.abs(apex.curvature) / 0.065, 0, 1);
    const apexLateral = turnSign * this.trackWidth * lerp(0.16, 0.3, tightness);
    const apexPoint = this._worldPoint(apex.index, apexLateral, 0.7);
    const exitMeters = lerp(9, 15, 1 - tightness);
    const exitSteps = Math.max(4, Math.round(exitMeters / this.spacing));
    const exitIndex = this._index(apex.index + exitSteps);
    const exitPoint = this._worldPoint(exitIndex, -turnSign * this.trackWidth * 0.24, 0.78);
    const nextApex = this._findApex(exitIndex, 4, 28);
    const nextApexPoint = nextApex
      ? this._worldPoint(
          nextApex.index,
          Math.sign(nextApex.curvature || 1) * this.trackWidth * 0.22,
          0.72,
        )
      : null;

    const approachWindow = Math.max(10, speed * 0.48 + braking * 8);
    let stage = 'approach';
    let target = apexPoint;
    if (apex.distance <= 4.4) {
      stage = nextApexPoint && nextApex.distance <= 22 ? 'linked_exit' : 'apex_to_exit';
      target = nextApexPoint
        ? blendPoint(exitPoint, nextApexPoint, clamp((22 - nextApex.distance) / 22, 0.18, 0.58))
        : exitPoint;
    } else if (apex.distance <= approachWindow) {
      stage = 'turn_in';
      const throughCorner = clamp(1 - apex.distance / Math.max(4.5, approachWindow), 0.12, 0.58);
      target = blendPoint(apexPoint, exitPoint, throughCorner);
    } else if (braking > 0.22) {
      stage = 'braking_to_apex';
    }

    this.lastResult = {
      stage,
      target,
      apex: apexPoint,
      exit: exitPoint,
      nextApex: nextApexPoint,
      distanceToApex: apex.distance,
      tightness,
      turnSign,
      lookAheadMeters,
      curvature: apex.curvature,
    };
    return this.lastResult;
  }

  groundHeightAtWorld(x, z, fallback = 0) {
    if (typeof this.track.groundHeightAt === 'function') {
      const value = this.track.groundHeightAt(x, z);
      if (Number.isFinite(value)) return value;
    }
    if (!this.samples.length) return fallback;
    let nearest = this.samples[0];
    let best = Infinity;
    const localX = x - (this.worldOffset.x || 0);
    const localZ = z - (this.worldOffset.z || 0);
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i];
      const distance = (sample.x - localX) ** 2 + (sample.z - localZ) ** 2;
      if (distance < best) {
        best = distance;
        nearest = sample;
      }
    }
    return (this.worldOffset.y || 0) + (nearest?.y || fallback);
  }
}

export function normalizeVisionAngle(angle) {
  let wrapped = (angle + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}
