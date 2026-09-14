/**
 * 1D damped harmonic oscillator tuned by frequency and damping ratio (1 = critically damped, < 1 = bouncy).
 * Advanced with the exact closed-form solution, so it behaves identically at any frame rate or frame length.
 */
export class Spring {
  value = 0;
  velocity = 0;
  private omega = 1;
  private zeta = 1;
  private impulsePerPeak = 1;

  constructor(frequencyHz: number, dampingRatio: number) {
    this.tune(frequencyHz, dampingRatio);
  }

  tune(frequencyHz: number, dampingRatio: number): void {
    this.omega = 2 * Math.PI * frequencyHz;
    this.zeta = Math.max(0, dampingRatio);
    // Peak displacement after an impulse v0 from rest, as a multiple of v0 / ω.
    let peakFactor = 1 / Math.E;
    if (this.zeta < 0.999) {
      const root = Math.sqrt(1 - this.zeta * this.zeta);
      peakFactor = Math.exp((-this.zeta / root) * Math.atan2(root, this.zeta));
    }
    this.impulsePerPeak = this.omega / peakFactor;
  }

  /** Adds velocity so that, starting from rest, the spring overshoots to roughly `peak` before settling. */
  kick(peak: number): void {
    this.velocity += peak * this.impulsePerPeak;
  }

  update(dt: number, target = 0): number {
    if (dt <= 0) return this.value;
    const w = this.omega;
    const z = this.zeta;
    const x = this.value - target;
    const v = this.velocity;
    let nx: number;
    let nv: number;
    if (z < 0.9999) {
      const wd = w * Math.sqrt(1 - z * z);
      const decay = Math.exp(-z * w * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      nx = decay * (x * c + ((v + z * w * x) / wd) * s);
      nv = decay * (v * c - ((w * w * x + z * w * v) / wd) * s);
    } else if (z < 1.0001) {
      const decay = Math.exp(-w * dt);
      const b = v + w * x;
      nx = (x + b * dt) * decay;
      nv = (v - w * b * dt) * decay;
    } else {
      const root = Math.sqrt(z * z - 1);
      const r1 = -w * (z - root);
      const r2 = -w * (z + root);
      const c1 = (v - r2 * x) / (r1 - r2);
      const c2 = x - c1;
      const e1 = Math.exp(r1 * dt);
      const e2 = Math.exp(r2 * dt);
      nx = c1 * e1 + c2 * e2;
      nv = c1 * r1 * e1 + c2 * r2 * e2;
    }
    this.value = target + nx;
    this.velocity = nv;
    return this.value;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 0 → 1 → 0 bump over [start, end], smooth at both ends. */
export function pulse(start: number, end: number, x: number): number {
  if (x <= start || x >= end) return 0;
  return Math.sin(((x - start) / (end - start)) * Math.PI);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Signed shortest angular difference a - b, radians. */
export function angleDelta(a: number, b: number): number {
  const TWO_PI = Math.PI * 2;
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d;
}
