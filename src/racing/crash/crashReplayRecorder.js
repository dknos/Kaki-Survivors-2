import { CRASH_REPLAY_HZ, CRASH_REPLAY_SECONDS } from './crashConfig.js';

const POS_STRIDE = 3;
const ROT_STRIDE = 4;
const DAMAGE_ZONE_STRIDE = 4;
const WHEEL_COUNT = 4;
const WHEEL_POSITION_STRIDE = WHEEL_COUNT * POS_STRIDE;
const WHEEL_ROTATION_STRIDE = WHEEL_COUNT * ROT_STRIDE;
const DAMAGE_ZONE_NAMES = Object.freeze(['front', 'rear', 'left', 'right']);
const GLASS_TO_BYTE = Object.freeze({ intact: 0, cracked: 1, shattered: 2 });
const BYTE_TO_GLASS = Object.freeze(['intact', 'cracked', 'shattered']);

function lerp(a, b, t) { return a + (b - a) * t; }

function slerpQuaternion(a, b, t) {
  let bx = b[0]; let by = b[1]; let bz = b[2]; let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (dot > 0.9995) {
    const out = [lerp(a[0], bx, t), lerp(a[1], by, t), lerp(a[2], bz, t), lerp(a[3], bw, t)];
    const inv = 1 / Math.max(1e-9, Math.hypot(...out));
    return out.map((value) => value * inv);
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

export class CrashReplayRecorder {
  constructor({ seconds = CRASH_REPLAY_SECONDS, hz = CRASH_REPLAY_HZ, maxObjects = 64, maxEvents = 768 } = {}) {
    this.hz = Math.max(1, Math.round(hz));
    this.capacity = Math.max(2, Math.ceil(seconds * this.hz));
    this.maxObjects = Math.max(1, Math.round(maxObjects));
    this.maxEvents = Math.max(16, Math.round(maxEvents));
    const slots = this.capacity * this.maxObjects;
    this.times = new Float64Array(this.capacity);
    this.positions = new Float32Array(slots * POS_STRIDE);
    this.rotations = new Float32Array(slots * ROT_STRIDE);
    this.linearVelocities = new Float32Array(slots * POS_STRIDE);
    this.angularVelocities = new Float32Array(slots * POS_STRIDE);
    this.flags = new Uint8Array(slots);
    this.damage = new Uint8Array(slots);
    this.damageZones = new Uint8Array(slots * DAMAGE_ZONE_STRIDE);
    this.glass = new Uint8Array(slots);
    this.detached = new Uint16Array(slots);
    this.wheelFlags = new Uint8Array(slots);
    this.wheelPositions = new Float32Array(slots * WHEEL_POSITION_STRIDE);
    this.wheelRotations = new Float32Array(slots * WHEEL_ROTATION_STRIDE);
    this.inputs = new Int8Array(this.capacity * 3);
    this.objectSlots = new Map();
    this.slotIds = new Array(this.maxObjects).fill(null);
    this.events = [];
    this.writeCount = 0;
    this.frameCount = 0;
    this.nextSampleAt = -Infinity;
  }

  registerObject(id) {
    const key = String(id);
    if (this.objectSlots.has(key)) return this.objectSlots.get(key);
    const slot = this.objectSlots.size;
    if (slot >= this.maxObjects) return -1;
    this.objectSlots.set(key, slot);
    this.slotIds[slot] = key;
    return slot;
  }

  record(time, objects, input = {}) {
    const now = Number(time) || 0;
    if (now + 1e-9 < this.nextSampleAt) return false;
    this.nextSampleAt = now + 1 / this.hz;
    const frame = this.writeCount % this.capacity;
    const frameBase = frame * this.maxObjects;
    this.flags.fill(0, frameBase, frameBase + this.maxObjects);
    this.damage.fill(0, frameBase, frameBase + this.maxObjects);
    this.damageZones.fill(0, frameBase * DAMAGE_ZONE_STRIDE, (frameBase + this.maxObjects) * DAMAGE_ZONE_STRIDE);
    this.glass.fill(0, frameBase, frameBase + this.maxObjects);
    this.detached.fill(0, frameBase, frameBase + this.maxObjects);
    this.wheelFlags.fill(0, frameBase, frameBase + this.maxObjects);
    this.times[frame] = now;
    for (const object of objects || []) {
      const slot = this.registerObject(object.id);
      if (slot < 0) continue;
      const item = frameBase + slot;
      const p = item * POS_STRIDE;
      const q = item * ROT_STRIDE;
      const position = object.position || object.translation || {};
      const rotation = object.quaternion || object.rotation || {};
      const linear = object.linearVelocity || object.linvel || {};
      const angular = object.angularVelocity || object.angvel || {};
      this.positions[p] = Number(position.x) || 0;
      this.positions[p + 1] = Number(position.y) || 0;
      this.positions[p + 2] = Number(position.z) || 0;
      this.rotations[q] = Number(rotation.x) || 0;
      this.rotations[q + 1] = Number(rotation.y) || 0;
      this.rotations[q + 2] = Number(rotation.z) || 0;
      this.rotations[q + 3] = Number.isFinite(Number(rotation.w)) ? Number(rotation.w) : 1;
      this.linearVelocities[p] = Number(linear.x) || 0;
      this.linearVelocities[p + 1] = Number(linear.y) || 0;
      this.linearVelocities[p + 2] = Number(linear.z) || 0;
      this.angularVelocities[p] = Number(angular.x) || 0;
      this.angularVelocities[p + 1] = Number(angular.y) || 0;
      this.angularVelocities[p + 2] = Number(angular.z) || 0;
      this.flags[item] = object.active === false || object.visible === false ? 0 : 1;
      this.damage[item] = Math.max(0, Math.min(255, Math.round((Number(object.damage) || 0) * 255)));
      const zoneOffset = item * DAMAGE_ZONE_STRIDE;
      for (let index = 0; index < DAMAGE_ZONE_NAMES.length; index++) {
        const zone = DAMAGE_ZONE_NAMES[index];
        this.damageZones[zoneOffset + index] = Math.max(0, Math.min(255, Math.round((Number(object.damageZones?.[zone]) || 0) * 255)));
      }
      this.glass[item] = GLASS_TO_BYTE[object.glass] ?? 0;
      this.detached[item] = Math.max(0, Math.min(0xffff, Number(object.detachedMask) || 0));
      for (let index = 0; index < WHEEL_COUNT; index++) {
        const wheel = object.wheelState?.[index];
        if (!wheel) continue;
        this.wheelFlags[item] |= 1 << index;
        if (wheel.visible !== false) this.wheelFlags[item] |= 1 << (index + WHEEL_COUNT);
        const wheelPosition = item * WHEEL_POSITION_STRIDE + index * POS_STRIDE;
        const wheelRotation = item * WHEEL_ROTATION_STRIDE + index * ROT_STRIDE;
        this.wheelPositions[wheelPosition] = Number(wheel.position?.x ?? wheel.position?.[0]) || 0;
        this.wheelPositions[wheelPosition + 1] = Number(wheel.position?.y ?? wheel.position?.[1]) || 0;
        this.wheelPositions[wheelPosition + 2] = Number(wheel.position?.z ?? wheel.position?.[2]) || 0;
        this.wheelRotations[wheelRotation] = Number(wheel.quaternion?.x ?? wheel.quaternion?.[0]) || 0;
        this.wheelRotations[wheelRotation + 1] = Number(wheel.quaternion?.y ?? wheel.quaternion?.[1]) || 0;
        this.wheelRotations[wheelRotation + 2] = Number(wheel.quaternion?.z ?? wheel.quaternion?.[2]) || 0;
        const wheelW = Number(wheel.quaternion?.w ?? wheel.quaternion?.[3]);
        this.wheelRotations[wheelRotation + 3] = Number.isFinite(wheelW) ? wheelW : 1;
      }
    }
    const inputAt = frame * 3;
    this.inputs[inputAt] = Math.round(Math.max(-1, Math.min(1, Number(input.throttle) || 0)) * 127);
    this.inputs[inputAt + 1] = Math.round(Math.max(-1, Math.min(1, Number(input.steer) || 0)) * 127);
    this.inputs[inputAt + 2] = input.boom ? 1 : 0;
    this.writeCount += 1;
    this.frameCount = Math.min(this.capacity, this.frameCount + 1);
    return true;
  }

  recordEvent(event) {
    if (!event) return;
    this.events.push({ ...event, time: Number(event.time) || 0 });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  chronologicalFrames() {
    const frames = [];
    const start = Math.max(0, this.writeCount - this.frameCount);
    for (let logical = start; logical < this.writeCount; logical++) {
      const index = logical % this.capacity;
      frames.push({ logical, index, time: this.times[index] });
    }
    return frames;
  }

  _read(slot, frameIndex) {
    const item = frameIndex * this.maxObjects + slot;
    const p = item * POS_STRIDE;
    const q = item * ROT_STRIDE;
    const zoneOffset = item * DAMAGE_ZONE_STRIDE;
    const wheelState = [];
    for (let index = 0; index < WHEEL_COUNT; index++) {
      if (!(this.wheelFlags[item] & (1 << index))) {
        wheelState.push(null);
        continue;
      }
      const wheelPosition = item * WHEEL_POSITION_STRIDE + index * POS_STRIDE;
      const wheelRotation = item * WHEEL_ROTATION_STRIDE + index * ROT_STRIDE;
      wheelState.push({
        visible: !!(this.wheelFlags[item] & (1 << (index + WHEEL_COUNT))),
        position: [this.wheelPositions[wheelPosition], this.wheelPositions[wheelPosition + 1], this.wheelPositions[wheelPosition + 2]],
        quaternion: [this.wheelRotations[wheelRotation], this.wheelRotations[wheelRotation + 1], this.wheelRotations[wheelRotation + 2], this.wheelRotations[wheelRotation + 3]],
      });
    }
    return {
      active: this.flags[item] > 0,
      position: [this.positions[p], this.positions[p + 1], this.positions[p + 2]],
      quaternion: [this.rotations[q], this.rotations[q + 1], this.rotations[q + 2], this.rotations[q + 3]],
      linearVelocity: [this.linearVelocities[p], this.linearVelocities[p + 1], this.linearVelocities[p + 2]],
      angularVelocity: [this.angularVelocities[p], this.angularVelocities[p + 1], this.angularVelocities[p + 2]],
      damage: this.damage[item] / 255,
      damageZones: Object.fromEntries(DAMAGE_ZONE_NAMES.map((zone, index) => [zone, this.damageZones[zoneOffset + index] / 255])),
      glass: BYTE_TO_GLASS[this.glass[item]] || 'intact',
      detachedMask: this.detached[item],
      wheelState,
    };
  }

  sampleObject(id, time) {
    const slot = this.objectSlots.get(String(id));
    const frames = this.chronologicalFrames();
    if (slot == null || !frames.length) return null;
    const target = Number(time) || 0;
    let right = frames.findIndex((frame) => frame.time >= target);
    if (right < 0) right = frames.length - 1;
    const left = Math.max(0, right - 1);
    const aFrame = frames[left];
    const bFrame = frames[right];
    const a = this._read(slot, aFrame.index);
    const b = this._read(slot, bFrame.index);
    const span = Math.max(1e-9, bFrame.time - aFrame.time);
    const t = left === right ? 0 : Math.max(0, Math.min(1, (target - aFrame.time) / span));
    const wheelState = a.wheelState.map((aWheel, index) => {
      const bWheel = b.wheelState[index];
      if (!aWheel && !bWheel) return null;
      if (!aWheel || !bWheel) return t < 0.5 ? aWheel : bWheel;
      return {
        visible: t < 0.5 ? aWheel.visible : bWheel.visible,
        position: aWheel.position.map((value, component) => lerp(value, bWheel.position[component], t)),
        quaternion: slerpQuaternion(aWheel.quaternion, bWheel.quaternion, t),
      };
    });
    return {
      id: String(id),
      time: target,
      active: t < 0.5 ? a.active : b.active,
      position: a.position.map((value, index) => lerp(value, b.position[index], t)),
      quaternion: slerpQuaternion(a.quaternion, b.quaternion, t),
      linearVelocity: a.linearVelocity.map((value, index) => lerp(value, b.linearVelocity[index], t)),
      angularVelocity: a.angularVelocity.map((value, index) => lerp(value, b.angularVelocity[index], t)),
      damage: lerp(a.damage, b.damage, t),
      damageZones: Object.fromEntries(DAMAGE_ZONE_NAMES.map((zone) => [zone, lerp(a.damageZones[zone], b.damageZones[zone], t)])),
      glass: t < 0.5 ? a.glass : b.glass,
      detachedMask: t < 0.5 ? a.detachedMask : b.detachedMask,
      wheelState,
    };
  }

  createClip(startTime, endTime) {
    const frames = this.chronologicalFrames();
    const first = frames[0]?.time ?? 0;
    const last = frames.at(-1)?.time ?? first;
    const start = Math.max(first, Number(startTime) || first);
    const end = Math.max(start, Math.min(last, Number(endTime) || last));
    return {
      start,
      end,
      duration: end - start,
      objectIds: [...this.objectSlots.keys()],
      events: this.events.filter((event) => event.time >= start && event.time <= end).map((event) => ({ ...event })),
      stateEvents: this.events.filter((event) => event.time <= end).map((event) => ({ ...event })),
      sample: (id, time) => this.sampleObject(id, Math.max(start, Math.min(end, time))),
    };
  }

  reset() {
    this.writeCount = 0;
    this.frameCount = 0;
    this.nextSampleAt = -Infinity;
    this.events.length = 0;
    this.objectSlots.clear();
    this.slotIds.fill(null);
    this.flags.fill(0);
  }

  memoryBytes() {
    return [
      this.times,
      this.positions,
      this.rotations,
      this.linearVelocities,
      this.angularVelocities,
      this.flags,
      this.damage,
      this.damageZones,
      this.glass,
      this.detached,
      this.wheelFlags,
      this.wheelPositions,
      this.wheelRotations,
      this.inputs,
    ]
      .reduce((sum, array) => sum + array.byteLength, 0);
  }
}
