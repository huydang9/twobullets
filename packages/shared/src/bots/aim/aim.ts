import type { Stance, Vec3 } from "../../movement/types";
import type { WeaponId } from "../../weapons/types";
import { BALLISTICS, WEAPONS } from "../../weapons/weapons";
import { CAMERA } from "../../constants";
import type { BotAimProfile } from "../types";
import { DEG, RAD_TO_DEG, TWO_PI, wrapAngle, type BotRandom, type MutVec3 } from "../brain/util";

// Aim model (design.md §6): a continuous aim steered toward the desired point plus a decaying acquisition offset and
// smooth seeded tracking noise, limited by a max turn rate. Recoil is kept as a separate offset: kicks apply at once,
// `recoilCompensation` of each kick is pulled back after `recoilDelaySeconds`, and the rest fades slowly (the bot
// re-centers the way a player does between bursts).

/** Aim point heights on a standing rig (hitreg/rig: body ~0.9–1.45 m, head at 1.66 m). Recoil climb pushes shots up. */
export const AIM_HEIGHT: Readonly<Record<BotAimProfile["aimPoint"], number>> = { chest: 1.1, upperChest: 1.22, neck: 1.38 };
/** Crouched aim points scale by this; downed targets use a fixed height. */
const CROUCH_SCALE = 0.58;
const DOWNED_HEIGHT = 0.35;
/** Proportional steering gain toward the goal, 1/s (feed-forward handles target motion). */
const STEER_GAIN = 14;
/** Compensation of one kick is spread over this long, s. */
const COMPENSATION_SECONDS = 0.06;
const RING = 64;
/** A target not tracked for this long is acquired again (new offset), ticks at 60 Hz. */
const REACQUIRE_TICKS = 90;
/** Target torso half-width for the fire tolerance, m. */
const TARGET_RADIUS = 0.25;
/** Uniform lattice RMS is 1/√3; the cubic blend loses a little more. */
const NOISE_RMS_SCALE = Math.sqrt(3) * 1.25;
/** Acquisition error is full for a flick of this many degrees and at least this fraction for any flick. */
const ACQUIRE_FULL_TRAVEL_DEG = 20;
const ACQUIRE_MIN_FRACTION = 0.25;
/** Tracking noise is specified at this range and scales by (reference / distance)^exponent, clamped. */
const NOISE_REFERENCE_METERS = 30;
const NOISE_RANGE_EXPONENT = 0.6;
const NOISE_RANGE_MIN = 0.35;
const NOISE_RANGE_MAX = 1.25;
const MAX_PITCH = (CAMERA.maxPitchDegrees * Math.PI) / 180;

export interface AimSolution {
  yaw: number;
  pitch: number;
  distance: number;
  /** Target angular speed across the line of sight, degrees/s. */
  angularSpeedDeg: number;
  /** Sign of the lateral (yaw) angular velocity. */
  lateralSign: number;
  /** Tolerance for the fire gate, degrees. */
  toleranceDeg: number;
  readonly point: MutVec3;
}

export function createAimSolution(): AimSolution {
  return { yaw: 0, pitch: 0, distance: 0, angularSpeedDeg: 0, lateralSign: 0, toleranceDeg: 0.4, point: { x: 0, y: 0, z: 0 } };
}

/** Height of the aim point above the feet for a stance. */
export function aimHeight(profile: BotAimProfile, stance: Stance, downed: boolean): number {
  if (downed || stance === "prone") return DOWNED_HEIGHT;
  const h = AIM_HEIGHT[profile.aimPoint];
  return stance === "crouch" ? h * CROUCH_SCALE : h;
}

/**
 * Desired aim at a target's feet position with the given velocity: aim point height, lead (`leadAccuracy` × velocity ×
 * bullet flight time) and drop compensation (`dropAccuracy` × ½ g t² × gravityScale). Writes into `out`.
 */
export function solveAim(
  eye: Vec3,
  feet: Vec3,
  velocity: Vec3,
  height: number,
  weaponId: WeaponId | null,
  profile: BotAimProfile,
  fireToleranceScale: number,
  out: AimSolution,
): AimSolution {
  let px = feet.x;
  let py = feet.y + height;
  let pz = feet.z;
  let dx = px - eye.x;
  let dy = py - eye.y;
  let dz = pz - eye.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (weaponId !== null) {
    const def = WEAPONS[weaponId];
    const t = distance / def.muzzleVelocity;
    px += velocity.x * t * profile.leadAccuracy;
    pz += velocity.z * t * profile.leadAccuracy;
    py += velocity.y * t * profile.leadAccuracy + profile.dropAccuracy * 0.5 * BALLISTICS.gravity * def.gravityScale * t * t;
    dx = px - eye.x;
    dy = py - eye.y;
    dz = pz - eye.z;
  }
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  out.yaw = Math.atan2(dx, dz);
  out.pitch = Math.atan2(-dy, horizontal);
  out.distance = distance;
  out.point.x = px;
  out.point.y = py;
  out.point.z = pz;
  // Lateral angular speed: velocity across the horizontal line of sight.
  if (horizontal > 1e-3) {
    const lateral = (velocity.x * dz - velocity.z * dx) / horizontal;
    out.angularSpeedDeg = (Math.abs(lateral) / Math.max(distance, 1)) * RAD_TO_DEG;
    out.lateralSign = lateral > 0 ? -1 : lateral < 0 ? 1 : 0;
  } else {
    out.angularSpeedDeg = 0;
    out.lateralSign = 0;
  }
  out.toleranceDeg = Math.max(fireToleranceScale * Math.atan2(TARGET_RADIUS, Math.max(distance, 0.5)) * RAD_TO_DEG, 0.4);
  return out;
}

export class AimModel {
  /** Steered aim before recoil, radians. */
  private baseYaw = 0;
  private basePitch = 0;
  /** Acquisition + flinch offset, radians. */
  private offsetYaw = 0;
  private offsetPitch = 0;
  private recoilUp = 0;
  private recoilRight = 0;
  private pendingUp = 0;
  private pendingRight = 0;
  private readonly compUp = new Float64Array(RING);
  private readonly compRight = new Float64Array(RING);
  private targetSlot = -1;
  private lastTrackTick = -1;
  private prevDesiredYaw = 0;
  private prevDesiredPitch = 0;
  private prevValid = false;
  private lastRecoilTick = -1;
  private goalYaw = 0.5;
  private goalPitch = 0.5;
  private ffYaw = 0.5;
  private ffPitch = 0.5;
  private maxTurn = 0.5;
  private gain = 0.5;
  private noiseTime = 0.5;
  private noise0 = 0.5;
  private noise1 = 0.5;
  private noise2 = 0.5;
  /** Angle between the output aim and the true desired aim at the last target update, degrees (NaN without target). */
  errorDeg = Number.NaN;
  /** Error the bot perceives (excludes its own tracking noise and lag), for the fire gate. */
  perceivedErrorDeg = Number.NaN;

  get yaw(): number {
    return wrapAngle(this.baseYaw + this.recoilRight);
  }

  get pitch(): number {
    const p = this.basePitch - this.recoilUp;
    return p < -MAX_PITCH ? -MAX_PITCH : p > MAX_PITCH ? MAX_PITCH : p;
  }

  get currentTarget(): number {
    return this.targetSlot;
  }

  reset(yaw: number, pitch: number): void {
    this.baseYaw = wrapAngle(yaw);
    this.basePitch = pitch;
    this.offsetYaw = 0;
    this.offsetPitch = 0;
    this.recoilUp = 0;
    this.recoilRight = 0;
    this.pendingUp = 0;
    this.pendingRight = 0;
    this.compUp.fill(0);
    this.compRight.fill(0);
    this.targetSlot = -1;
    this.lastTrackTick = -1;
    this.prevValid = false;
    this.lastRecoilTick = -1;
    this.errorDeg = Number.NaN;
    this.perceivedErrorDeg = Number.NaN;
  }

  /** Recoil from a shot this tick: applied at once; part of it is scheduled back. */
  kick(up: number, right: number, tick: number, dt: number, profile: BotAimProfile): void {
    this.recoilUp += up;
    this.recoilRight += right;
    const comp = profile.recoilCompensation;
    if (comp <= 0) return;
    const n = Math.max(1, Math.round(COMPENSATION_SECONDS / dt));
    const start = tick + 1 + Math.round(profile.recoilDelaySeconds / dt);
    const du = (up * comp) / n;
    const dr = (right * comp) / n;
    for (let k = 0; k < n; k++) {
      const i = (start + k) & (RING - 1);
      this.compUp[i] = this.compUp[i]! + du;
      this.compRight[i] = this.compRight[i]! + dr;
    }
    this.pendingUp += up * comp;
    this.pendingRight += right * comp;
  }

  /** Aim punch when hit: a seeded offset added to the error. */
  flinch(profile: BotAimProfile, rng: BotRandom): void {
    const a = rng.next() * TWO_PI;
    const m = profile.flinchDeg * DEG * (0.5 + 0.5 * rng.next());
    this.offsetYaw += Math.sin(a) * m;
    this.offsetPitch += Math.cos(a) * m;
  }

  /**
   * Steers toward a target's desired aim with acquisition error, tracking noise and lateral lag. `slot` identifies the
   * target so switching or re-acquiring restarts the acquisition offset.
   */
  track(slot: number, solution: AimSolution, tick: number, dt: number, profile: BotAimProfile, rng: BotRandom, noiseScale: number): void {
    this.stepRecoil(tick, dt, profile);
    if (slot !== this.targetSlot || this.lastTrackTick < 0 || tick - this.lastTrackTick > REACQUIRE_TICKS) {
      const a = rng.next() * TWO_PI;
      // The flick error scales with how far the aim has to travel: a target already near the crosshair (the bot
      // turned toward it while noticing it) starts with a smaller offset.
      const dy = wrapInline(solution.yaw - (this.baseYaw + this.recoilRight));
      const dp = solution.pitch - this.basePitch;
      const travelDeg = Math.sqrt(dy * dy + dp * dp) * RAD_TO_DEG;
      const travel = Math.min(1, Math.max(ACQUIRE_MIN_FRACTION, travelDeg / ACQUIRE_FULL_TRAVEL_DEG));
      const m = (profile.acquireErrorDeg * travel + profile.velocityErrorScale * solution.angularSpeedDeg) * DEG * (0.6 + 0.4 * rng.next());
      this.offsetYaw = Math.sin(a) * m;
      this.offsetPitch = Math.cos(a) * m * 0.6;
      this.targetSlot = slot;
      this.prevValid = false;
    }
    this.lastTrackTick = tick;
    const decay = Math.exp(-dt / Math.max(0.01, profile.acquireSeconds));
    this.offsetYaw *= decay;
    this.offsetPitch *= decay;

    this.noiseTime = tick * dt * profile.trackingNoiseHz;
    this.sampleNoise(rng);
    // Angular noise shrinks with range: at distance players slow down and settle the (zoomed) sights.
    const rangeScale = Math.min(NOISE_RANGE_MAX, Math.max(NOISE_RANGE_MIN, Math.pow(NOISE_REFERENCE_METERS / Math.max(1, solution.distance), NOISE_RANGE_EXPONENT)));
    const rms = profile.trackingNoiseDeg * DEG * NOISE_RMS_SCALE * noiseScale * rangeScale;
    const noiseYaw = this.noise0 * rms;
    const noisePitch = this.noise1 * rms * 0.7;
    // Trailing lag across fast lateral motion.
    const lag = solution.lateralSign * profile.velocityErrorScale * solution.angularSpeedDeg * DEG * (0.6 + 0.4 * this.noise2);

    this.goalYaw = solution.yaw + this.offsetYaw + noiseYaw + lag;
    this.goalPitch = solution.pitch + this.offsetPitch + noisePitch;
    this.ffYaw = 0;
    this.ffPitch = 0;
    if (this.prevValid) {
      this.ffYaw = wrapInline(solution.yaw - this.prevDesiredYaw);
      this.ffPitch = solution.pitch - this.prevDesiredPitch;
    }
    this.prevDesiredYaw = solution.yaw;
    this.prevDesiredPitch = solution.pitch;
    this.prevValid = true;
    this.maxTurn = profile.maxTurnRateDeg * DEG;
    this.gain = STEER_GAIN;
    this.steer(dt);

    const yaw = wrapInline(this.baseYaw + this.recoilRight);
    const rawPitch = this.basePitch - this.recoilUp;
    const pitch = rawPitch < -MAX_PITCH ? -MAX_PITCH : rawPitch > MAX_PITCH ? MAX_PITCH : rawPitch;
    const cosPitch = Math.cos(solution.pitch);
    const errYaw = wrapInline(yaw - solution.yaw) * cosPitch;
    const errPitch = pitch - solution.pitch;
    this.errorDeg = Math.sqrt(errYaw * errYaw + errPitch * errPitch) * RAD_TO_DEG;
    // What the bot believes: tracking noise and lag are unconscious, so they don't hold the trigger back.
    const pYaw = wrapInline(yaw - (solution.yaw + noiseYaw + lag)) * cosPitch;
    const pPitch = pitch - (solution.pitch + noisePitch);
    this.perceivedErrorDeg = Math.sqrt(pYaw * pYaw + pPitch * pPitch) * RAD_TO_DEG;
  }

  /** Turns toward a look direction without a target (moving, scanning). `rateScale` slows casual turns. */
  look(yaw: number, pitch: number, tick: number, dt: number, profile: BotAimProfile, rateScale: number): void {
    this.stepRecoil(tick, dt, profile);
    this.offsetYaw = 0;
    this.offsetPitch = 0;
    this.prevValid = false;
    this.errorDeg = Number.NaN;
    this.perceivedErrorDeg = Number.NaN;
    this.goalYaw = yaw;
    this.goalPitch = pitch;
    this.ffYaw = 0;
    this.ffPitch = 0;
    this.maxTurn = profile.maxTurnRateDeg * DEG * rateScale;
    this.gain = STEER_GAIN * 0.6;
    this.steer(dt);
  }

  /** Forget the target so the next track() acquires with a fresh offset. */
  dropTarget(): void {
    this.targetSlot = -1;
    this.lastTrackTick = -1;
  }

  /** Smooth seeded value noise in [-1, 1] per axis at `noiseTime` (smoothstep blend between lattice values). */
  private sampleNoise(rng: BotRandom): void {
    const t = this.noiseTime;
    const k = Math.floor(t) | 0;
    const f = t - k;
    const s = f * f * (3 - 2 * f);
    let a = rng.lattice(k, 0);
    this.noise0 = a + (rng.lattice(k + 1, 0) - a) * s;
    a = rng.lattice(k, 1);
    this.noise1 = a + (rng.lattice(k + 1, 1) - a) * s;
    const t2 = t * 0.5;
    const k2 = Math.floor(t2) | 0;
    const f2 = t2 - k2;
    const s2 = f2 * f2 * (3 - 2 * f2);
    a = rng.lattice(k2, 2);
    this.noise2 = a + (rng.lattice(k2 + 1, 2) - a) * s2;
  }

  /** Steers toward the goal fields (kept in fields: fresh doubles passed to a non-inlined call would be boxed). */
  private steer(dt: number): void {
    const k = Math.min(1, this.gain * dt);
    let dy = wrapInline(this.goalYaw - this.baseYaw) * k + this.ffYaw;
    let dp = (this.goalPitch - this.basePitch) * k + this.ffPitch;
    const step = Math.sqrt(dy * dy + dp * dp);
    const limit = this.maxTurn * dt;
    if (step > limit && step > 0) {
      const s = limit / step;
      dy *= s;
      dp *= s;
    }
    this.baseYaw = wrapInline(this.baseYaw + dy);
    this.basePitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.basePitch + dp));
  }

  private stepRecoil(tick: number, dt: number, profile: BotAimProfile): void {
    if (tick === this.lastRecoilTick) return;
    this.lastRecoilTick = tick;
    const i = tick & (RING - 1);
    const cu = this.compUp[i]!;
    const cr = this.compRight[i]!;
    this.compUp[i] = 0;
    this.compRight[i] = 0;
    this.recoilUp -= cu;
    this.recoilRight -= cr;
    this.pendingUp -= cu;
    this.pendingRight -= cr;
    // The uncompensated residual fades as the bot re-centers.
    const decay = Math.exp(-dt / Math.max(0.15, profile.acquireSeconds));
    this.recoilUp = this.pendingUp + (this.recoilUp - this.pendingUp) * decay;
    this.recoilRight = this.pendingRight + (this.recoilRight - this.pendingRight) * decay;
  }
}

/** wrapAngle for hot paths (a tiny function V8 always inlines; keeps fresh doubles unboxed). */
function wrapInline(a: number): number {
  a = a % TWO_PI;
  return a > Math.PI ? a - TWO_PI : a <= -Math.PI ? a + TWO_PI : a;
}
