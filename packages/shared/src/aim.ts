import { CAMERA } from "./constants";

// Input aim quantization (netcode.md §6.3, refactor R10). The client simulates the dequantized aim so its shots and
// movement match the server's exactly; the camera keeps the raw float aim (difference ≤ 6 µrad yaw, 12 µrad pitch).

const TWO_PI = Math.PI * 2;
/** 20-bit yaw over [0, 2π). */
export const YAW_Q_BITS = 20;
/** 18-bit pitch over ±CAMERA.maxPitchDegrees, with 0 exactly representable. */
export const PITCH_Q_BITS = 18;

const YAW_STEPS = 2 ** YAW_Q_BITS;
const YAW_STEP = TWO_PI / YAW_STEPS;
const MAX_PITCH = (CAMERA.maxPitchDegrees * Math.PI) / 180;
/** Steps on each side of level; q = PITCH_ZERO_Q is exactly 0, 0 and 2·PITCH_ZERO_Q are ±MAX_PITCH. */
const PITCH_ZERO_Q = 2 ** (PITCH_Q_BITS - 1) - 1;
const PITCH_STEP = MAX_PITCH / PITCH_ZERO_Q;

/** Yaw radians (any range) → 20-bit steps. */
export function quantizeYaw(yaw: number): number {
  const wrapped = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round(wrapped / YAW_STEP) % YAW_STEPS;
}

export function dequantizeYaw(yawQ: number): number {
  return yawQ * YAW_STEP;
}

/** Pitch radians (+ = down), clamped to ±CAMERA.maxPitchDegrees → 18-bit steps. */
export function quantizePitch(pitch: number): number {
  const clamped = pitch < -MAX_PITCH ? -MAX_PITCH : pitch > MAX_PITCH ? MAX_PITCH : pitch;
  return Math.round(clamped / PITCH_STEP) + PITCH_ZERO_Q;
}

export function dequantizePitch(pitchQ: number): number {
  return (pitchQ - PITCH_ZERO_Q) * PITCH_STEP;
}

export interface QuantizedAim {
  readonly yawQ: number;
  readonly pitchQ: number;
}

export function quantizeAim(yaw: number, pitch: number): QuantizedAim {
  return { yawQ: quantizeYaw(yaw), pitchQ: quantizePitch(pitch) };
}

export function dequantizeAim(yawQ: number, pitchQ: number): { readonly yaw: number; readonly pitch: number } {
  return { yaw: dequantizeYaw(yawQ), pitch: dequantizePitch(pitchQ) };
}
