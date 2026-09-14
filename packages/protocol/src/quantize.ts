import {
  dequantizePitch as sharedDequantizePitch,
  dequantizeYaw as sharedDequantizeYaw,
  PITCH_Q_BITS,
  quantizePitch as sharedQuantizePitch,
  quantizeYaw as sharedQuantizeYaw,
  YAW_Q_BITS,
} from "@twobullets/shared/aim";

// Quantizers (netcode.md §6.3). Single source of truth for wire bit widths and ranges; codecs carry the quantized
// integers so baselines compare exactly. All quantizers clamp into range, so any float maps to a valid wire value.

export const TICK_RATE = 60;
export const TICK_SECONDS = 1 / TICK_RATE;

const TAU = Math.PI * 2;
export const MAX_PITCH_RAD = (89 * Math.PI) / 180;

/** Clamps a rounded value; NaN maps to the in-range value nearest 0 and −0 to 0, so baselines compare exactly. */
function clamp(v: number, lo: number, hi: number): number {
  if (v !== v) return lo > 0 ? lo : hi < 0 ? hi : 0;
  return v < lo ? lo : v > hi ? hi : v + 0;
}

// ---- Positions: 1 mm, unsigned with an offset ------------------------------------------------------------------
// The map is centred on the origin (playable ±500 m, terrain ±640 m), so x/z are offset by half the 20-bit span
// (±524.288 m) rather than netcode.md's −24 m, which assumed a 0..1000 m map.

export const POS_XZ_BITS = 20;
export const POS_Y_BITS = 19;
export const POS_XZ_OFFSET_M = 524.288;
export const POS_Y_OFFSET_M = 12;
export const POS_XZ_MAX_Q = (1 << POS_XZ_BITS) - 1;
export const POS_Y_MAX_Q = (1 << POS_Y_BITS) - 1;

export function quantizePosXZ(m: number): number {
  return clamp(Math.round((m + POS_XZ_OFFSET_M) * 1000), 0, POS_XZ_MAX_Q);
}
export function dequantizePosXZ(q: number): number {
  return q / 1000 - POS_XZ_OFFSET_M;
}
export function quantizePosY(m: number): number {
  return clamp(Math.round((m + POS_Y_OFFSET_M) * 1000), 0, POS_Y_MAX_Q);
}
export function dequantizePosY(q: number): number {
  return q / 1000 - POS_Y_OFFSET_M;
}

/** Audible-only entities (§6.5): 0.5 m steps, x/z 11 bits over [−512, 511.5] m, y 10 bits over [−12, 499.5] m. */
export const AUDIBLE_XZ_BITS = 11;
export const AUDIBLE_Y_BITS = 10;
const AUDIBLE_XZ_OFFSET_MM = Math.round((512 - POS_XZ_OFFSET_M) * 1000);

/** Offset-mm position → 0.5 m step. */
export function audibleXZFromMm(xMm: number): number {
  return clamp(Math.round((xMm + AUDIBLE_XZ_OFFSET_MM) / 500), 0, (1 << AUDIBLE_XZ_BITS) - 1);
}
export function audibleXZToMm(q: number): number {
  return q * 500 - AUDIBLE_XZ_OFFSET_MM;
}
export function audibleYFromMm(yMm: number): number {
  return clamp(Math.round(yMm / 500), 0, (1 << AUDIBLE_Y_BITS) - 1);
}
export function audibleYToMm(q: number): number {
  return q * 500;
}

// ---- Velocities -------------------------------------------------------------------------------------------------

/** Owner velocity: zigzag 1 mm/s, ±65.535 m/s. */
export const OWNER_VEL_BITS = 17;
export const OWNER_VEL_MAX_Q = 65535;
export function quantizeOwnerVel(mps: number): number {
  return clamp(Math.round(mps * 1000), -OWNER_VEL_MAX_Q, OWNER_VEL_MAX_Q);
}
export function dequantizeOwnerVel(q: number): number {
  return q / 1000;
}

/** Remote velocity: zigzag 0.125 m/s, ±63.875 m/s. */
export const REMOTE_VEL_BITS = 10;
export const REMOTE_VEL_MAX_Q = 511;
export const REMOTE_VEL_STEP = 0.125;
export function quantizeRemoteVel(mps: number): number {
  return clamp(Math.round(mps / REMOTE_VEL_STEP), -REMOTE_VEL_MAX_Q, REMOTE_VEL_MAX_Q);
}
export function dequantizeRemoteVel(q: number): number {
  return q * REMOTE_VEL_STEP;
}

// ---- Angles -----------------------------------------------------------------------------------------------------

/** Uniform yaw over [0, 2π): any radian value wraps first. */
export function quantizeYaw(rad: number, bits: number): number {
  const steps = 2 ** bits;
  let n = rad % TAU;
  if (n < 0) n += TAU;
  const q = Math.round((n / TAU) * steps);
  return q >= 0 && q < steps ? q + 0 : 0;
}
export function dequantizeYaw(q: number, bits: number): number {
  return (q / 2 ** bits) * TAU;
}

/** Uniform pitch over [−89°, +89°], endpoints exact. */
export function quantizePitch(rad: number, bits: number): number {
  const max = 2 ** bits - 1;
  return clamp(Math.round(((rad + MAX_PITCH_RAD) / (2 * MAX_PITCH_RAD)) * max), 0, max);
}
export function dequantizePitch(q: number, bits: number): number {
  return (q / (2 ** bits - 1)) * 2 * MAX_PITCH_RAD - MAX_PITCH_RAD;
}

/**
 * Input aim (the client simulates the dequantized value so client and server fire identical directions). The sim owns
 * the meaning of the 20/18-bit codes (packages/shared/src/aim.ts: pitch is zero-exact over ±89°, max code 2^18 − 2),
 * so these are the shared functions, not a second layout.
 */
export const AIM_YAW_BITS = YAW_Q_BITS;
export const AIM_PITCH_BITS = PITCH_Q_BITS;
export const REMOTE_YAW_BITS = 12;
export const REMOTE_PITCH_BITS = 10;

export function quantizeAimYaw(rad: number): number {
  return sharedQuantizeYaw(rad);
}
export function dequantizeAimYaw(q: number): number {
  return sharedDequantizeYaw(q);
}
export function quantizeAimPitch(rad: number): number {
  return sharedQuantizePitch(rad);
}
export function dequantizeAimPitch(q: number): number {
  return sharedDequantizePitch(q);
}

// ---- Scalars ----------------------------------------------------------------------------------------------------

/** Seconds → whole ticks, clamped to `bits`. */
export function quantizeTicks(seconds: number, bits: number): number {
  return clamp(Math.round(seconds * TICK_RATE), 0, 2 ** bits - 1);
}
export function dequantizeTicks(q: number): number {
  return q * TICK_SECONDS;
}

/** Health/damage in 0.1 HP. */
export function quantizeHealth(hp: number, bits: number): number {
  return clamp(Math.round(hp * 10), 0, 2 ** bits - 1);
}
export function dequantizeHealth(q: number): number {
  return q / 10;
}

/** Weapon cooldown: 1/64 tick, 13 bits (≤ 2.13 s). */
export const COOLDOWN_BITS = 13;
const COOLDOWN_STEPS_PER_SECOND = TICK_RATE * 64;
export function quantizeCooldown(seconds: number): number {
  return clamp(Math.round(seconds * COOLDOWN_STEPS_PER_SECOND), 0, (1 << COOLDOWN_BITS) - 1);
}
export function dequantizeCooldown(q: number): number {
  return q / COOLDOWN_STEPS_PER_SECOND;
}

/** Weapon phase timer: whole ticks, 9 bits (reload/equip times are whole ticks at 60 Hz). */
export const PHASE_TIMER_BITS = 9;

/** Degrees in 1/64° steps (bloom 8 bits, shot spread 11 bits). */
export function quantizeDegrees64(deg: number, bits: number): number {
  return clamp(Math.round(deg * 64), 0, 2 ** bits - 1);
}
export function dequantizeDegrees64(q: number): number {
  return q / 64;
}
export const BLOOM_BITS = 8;

/** 0..1 blend → 0..255. */
export function quantizeUnit8(t: number): number {
  return clamp(Math.round(t * 255), 0, 255);
}
export function dequantizeUnit8(q: number): number {
  return q / 255;
}

/** Whole points rounded up, so a nearly empty bar or armor piece never reads as 0 (boost 7 bits, durability 8 bits). */
export function quantizePointsCeil(points: number, bits: number): number {
  return clamp(Math.ceil(points - 1e-9), 0, 2 ** bits - 1);
}

/** Stance wire code: 0 stand, 1 crouch, 2 prone. */
export const StanceCode = { stand: 0, crouch: 1, prone: 2 } as const;
export type StanceCode = (typeof StanceCode)[keyof typeof StanceCode];

// ---- Remote entity flags (21 bits: §6.5 plus the weapon id) -------------------------------------------------------

export const RemoteFlags = {
  stanceShift: 0,
  stanceMask: 0x3,
  moveModeShift: 2,
  moveModeMask: 0x3 << 2,
  grounded: 1 << 4,
  sprint: 1 << 5,
  ads: 1 << 6,
  weaponSlotShift: 7,
  weaponSlotMask: 0x3 << 7,
  weaponPhaseShift: 9,
  weaponPhaseMask: 0x3 << 9,
  lifeShift: 11,
  lifeMask: 0x3 << 11,
  helmetShift: 13,
  helmetMask: 0x3 << 13,
  vestShift: 15,
  vestMask: 0x3 << 15,
  cooking: 1 << 17,
  /** `weaponCode` of the weapon in hand (0 unarmed), protocol v2. */
  weaponIdShift: 18,
  weaponIdMask: 0x7 << 18,
} as const;
export const REMOTE_FLAG_BITS = 21;
