import { MOVEMENT } from "@twobullets/shared/constants";
import {
  dequantizePitch,
  dequantizePosXZ,
  dequantizePosY,
  dequantizeRemoteVel,
  dequantizeYaw,
  REMOTE_PITCH_BITS,
  REMOTE_YAW_BITS,
  RemoteFlags,
} from "@twobullets/protocol/quantize";
import type { EntityState } from "@twobullets/protocol/messages/snapshot";

// Remote player interpolation (netcode.md §4.1–4.2): a per-entity ring of the last 32 snapshot samples, sampled at a
// fractional render tick behind the server with an adaptive delay. Cubic Hermite position (snapshot velocities as
// tangents), shortest-arc yaw, discrete flags from the older sample. Past the newest sample: dead reckoning for
// ≤ 100 ms, then hold; when data resumes, the extrapolation error blends out over 100 ms.

export interface InterpolationDelayOptions {
  readonly floorMs?: number;
  readonly maxMs?: number;
  /** Shrink rate limit: ms of delay per 100 ms of time. */
  readonly shrinkPer100Ms?: number;
  readonly jitterFactor?: number;
  /** Loss above this over the window adds one snapshot interval of cushion. */
  readonly lossThreshold?: number;
}

/** interpDelay = interval × (1 + lossCushion) + 2.5σ + 1 ms, clamped; grows at once, shrinks ≤ 1 ms per 100 ms. */
export class InterpolationDelay {
  private floor: number;
  private readonly max: number;
  private readonly shrink: number;
  private readonly k: number;
  private readonly lossThreshold: number;
  private current = -1;
  private lastMs = 0;

  constructor(options: InterpolationDelayOptions = {}) {
    this.floor = options.floorMs ?? 25;
    this.max = options.maxMs ?? 150;
    this.shrink = options.shrinkPer100Ms ?? 1;
    this.k = options.jitterFactor ?? 2.5;
    this.lossThreshold = options.lossThreshold ?? 0.01;
  }

  get delayMs(): number {
    return this.current < 0 ? this.floor : this.current;
  }

  /** WSS fallback raises the floor to 50 ms (architecture.md §6.2). */
  setFloor(floorMs: number): void {
    this.floor = floorMs;
  }

  update(nowMs: number, snapshotIntervalMs: number, lossRatio: number, jitterMs: number): number {
    const cushion = lossRatio > this.lossThreshold ? 1 : 0;
    let target = snapshotIntervalMs * (1 + cushion) + this.k * jitterMs + 1;
    target = target < this.floor ? this.floor : target > this.max ? this.max : target;
    if (this.current < 0 || target >= this.current) this.current = target;
    else {
      const dt = Math.max(0, nowMs - this.lastMs);
      this.current = Math.max(target, this.current - (dt / 100) * this.shrink);
    }
    this.lastMs = nowMs;
    return this.current;
  }
}

/** Sample output; reuse one per entity. */
export interface InterpolatedPose {
  valid: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  flags: number;
  /** Render tick is past the newest sample. */
  extrapolated: boolean;
  /** How far past the newest sample, ms (capped extrapolation holds after `maxExtrapolationMs`). */
  extrapolatedMs: number;
}

export function createInterpolatedPose(): InterpolatedPose {
  return { valid: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, flags: 0, extrapolated: false, extrapolatedMs: 0 };
}

export interface EntityInterpolatorOptions {
  readonly capacity?: number;
  readonly tickRate?: number;
  readonly maxExtrapolationMs?: number;
  readonly blendMs?: number;
  /** A jump between samples beyond this speed (m/s) is a teleport: step instead of curving. */
  readonly teleportSpeed?: number;
}

const TAU = Math.PI * 2;

function shortestArc(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

export class EntityInterpolator {
  private readonly cap: number;
  private readonly tickSec: number;
  private readonly maxExtraSec: number;
  private readonly blendTicks: number;
  private readonly teleportSpeed: number;
  private readonly t: Float64Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;
  private readonly yaw: Float64Array;
  private readonly pitch: Float64Array;
  private readonly fl: Int32Array;
  private n = 0;
  private wasExtrapolating = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private blendX = 0;
  private blendY = 0;
  private blendZ = 0;
  private blendStart = 0;
  private blending = false;

  constructor(options: EntityInterpolatorOptions = {}) {
    this.cap = options.capacity ?? 32;
    this.tickSec = 1 / (options.tickRate ?? 60);
    this.maxExtraSec = (options.maxExtrapolationMs ?? 100) / 1000;
    this.blendTicks = (options.blendMs ?? 100) / 1000 / this.tickSec;
    this.teleportSpeed = options.teleportSpeed ?? 80;
    const c = this.cap;
    this.t = new Float64Array(c);
    this.px = new Float64Array(c);
    this.py = new Float64Array(c);
    this.pz = new Float64Array(c);
    this.vx = new Float64Array(c);
    this.vy = new Float64Array(c);
    this.vz = new Float64Array(c);
    this.yaw = new Float64Array(c);
    this.pitch = new Float64Array(c);
    this.fl = new Int32Array(c);
  }

  get size(): number {
    return this.n;
  }
  get newestTick(): number {
    return this.n > 0 ? this.t[this.n - 1]! : -1;
  }

  /**
   * Adds a sample. Out-of-order samples are inserted in tick order; duplicates are ignored. When full, the oldest
   * sample is dropped (an older-than-oldest sample is ignored).
   */
  push(tick: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, yaw: number, pitch: number, flags: number): void {
    let i = this.n;
    while (i > 0 && this.t[i - 1]! > tick) i--;
    if (i > 0 && this.t[i - 1] === tick) return;
    if (this.n === this.cap) {
      if (i === 0) return;
      this.shift(1, 0, this.n - 1);
      this.n--;
      i--;
    }
    if (i < this.n) this.shift(i, i + 1, this.n - i);
    this.t[i] = tick;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.yaw[i] = yaw;
    this.pitch[i] = pitch;
    this.fl[i] = flags;
    this.n++;
  }

  /** Adds a decoded `full` entity at its snapshot tick (other presences are ignored). */
  pushEntity(tick: number, e: EntityState): void {
    if (e.presence !== 1) return;
    this.push(
      tick,
      dequantizePosXZ(e.xMm),
      dequantizePosY(e.yMm),
      dequantizePosXZ(e.zMm),
      dequantizeRemoteVel(e.vxQ),
      dequantizeRemoteVel(e.vyQ),
      dequantizeRemoteVel(e.vzQ),
      dequantizeYaw(e.yawQ, REMOTE_YAW_BITS),
      dequantizePitch(e.pitchQ, REMOTE_PITCH_BITS),
      e.flags,
    );
  }

  clear(): void {
    this.n = 0;
    this.wasExtrapolating = false;
    this.blending = false;
  }

  sample(renderTick: number, out: InterpolatedPose): InterpolatedPose {
    const n = this.n;
    out.extrapolated = false;
    out.extrapolatedMs = 0;
    if (n === 0) {
      out.valid = false;
      return out;
    }
    out.valid = true;
    if (renderTick <= this.t[0]!) {
      this.copySample(0, out);
    } else if (renderTick >= this.t[n - 1]!) {
      const k = n - 1;
      this.copySample(k, out);
      const ahead = (renderTick - this.t[k]!) * this.tickSec;
      if (ahead > 0) {
        out.extrapolated = true;
        out.extrapolatedMs = ahead * 1000;
        const d = ahead < this.maxExtraSec ? ahead : this.maxExtraSec;
        out.x += out.vx * d;
        out.z += out.vz * d;
        out.y += out.vy * d;
        if ((out.flags & RemoteFlags.grounded) === 0) out.y -= 0.5 * MOVEMENT.gravity * d * d;
      }
    } else {
      let b = 1;
      while (this.t[b]! <= renderTick) b++;
      this.hermite(b - 1, b, renderTick, out);
    }

    // Blend out the difference between the last extrapolated pose and the interpolated one once data resumes.
    if (this.wasExtrapolating && !out.extrapolated) {
      this.blendX = this.lastX - out.x;
      this.blendY = this.lastY - out.y;
      this.blendZ = this.lastZ - out.z;
      this.blendStart = renderTick;
      this.blending = true;
    }
    if (this.blending) {
      const w = 1 - (renderTick - this.blendStart) / this.blendTicks;
      if (w <= 0 || w > 1) this.blending = false;
      else {
        out.x += this.blendX * w;
        out.y += this.blendY * w;
        out.z += this.blendZ * w;
      }
    }
    this.wasExtrapolating = out.extrapolated;
    this.lastX = out.x;
    this.lastY = out.y;
    this.lastZ = out.z;
    return out;
  }

  private copySample(i: number, out: InterpolatedPose): void {
    out.x = this.px[i]!;
    out.y = this.py[i]!;
    out.z = this.pz[i]!;
    out.vx = this.vx[i]!;
    out.vy = this.vy[i]!;
    out.vz = this.vz[i]!;
    out.yaw = this.yaw[i]!;
    out.pitch = this.pitch[i]!;
    out.flags = this.fl[i]!;
  }

  private hermite(a: number, b: number, renderTick: number, out: InterpolatedPose): void {
    const ta = this.t[a]!;
    const h = (this.t[b]! - ta) * this.tickSec;
    const s = (renderTick - ta) / (this.t[b]! - ta);
    const dx = this.px[b]! - this.px[a]!;
    const dy = this.py[b]! - this.py[a]!;
    const dz = this.pz[b]! - this.pz[a]!;
    out.flags = this.fl[a]!;
    out.pitch = this.pitch[a]! + (this.pitch[b]! - this.pitch[a]!) * s;
    let yaw = this.yaw[a]! + shortestArc(this.yaw[a]!, this.yaw[b]!) * s;
    if (yaw < 0) yaw += TAU;
    else if (yaw >= TAU) yaw -= TAU;
    out.yaw = yaw;
    out.vx = this.vx[a]! + (this.vx[b]! - this.vx[a]!) * s;
    out.vy = this.vy[a]! + (this.vy[b]! - this.vy[a]!) * s;
    out.vz = this.vz[a]! + (this.vz[b]! - this.vz[a]!) * s;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > this.teleportSpeed * h) {
      this.copySample(a, out);
      return;
    }
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = (s3 - 2 * s2 + s) * h;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = (s3 - s2) * h;
    out.x = h00 * this.px[a]! + h10 * this.vx[a]! + h01 * this.px[b]! + h11 * this.vx[b]!;
    out.y = h00 * this.py[a]! + h10 * this.vy[a]! + h01 * this.py[b]! + h11 * this.vy[b]!;
    out.z = h00 * this.pz[a]! + h10 * this.vz[a]! + h01 * this.pz[b]! + h11 * this.vz[b]!;
  }

  private shift(from: number, to: number, count: number): void {
    this.t.copyWithin(to, from, from + count);
    this.px.copyWithin(to, from, from + count);
    this.py.copyWithin(to, from, from + count);
    this.pz.copyWithin(to, from, from + count);
    this.vx.copyWithin(to, from, from + count);
    this.vy.copyWithin(to, from, from + count);
    this.vz.copyWithin(to, from, from + count);
    this.yaw.copyWithin(to, from, from + count);
    this.pitch.copyWithin(to, from, from + count);
    this.fl.copyWithin(to, from, from + count);
  }
}
