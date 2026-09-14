import type { Vec3 } from "../movement/types";
import { clamp01, len3, lerp, smoothstep } from "./math";

export const FLASH = {
  /** Full blinding strength up to here, fading to none at blindRange, m. */
  blindFullRange: 6,
  blindRange: 24,
  maxBlindSeconds: 5,
  /** Ringing reaches further and ignores view direction. m. */
  deafFullRange: 8,
  deafRange: 32,
  maxDeafSeconds: 6,
  /** View factor: looking straight at the flash = 1, facing away = `behind`. */
  behind: 0.08,
  /** Within this distance even a flash behind you half-blinds (bounce light fills a room). m. */
  closeRange: 3,
  closeMinimumView: 0.5,
  /** Ringing strength kept when a wall is between the flash and the ears. */
  occludedDeaf: 0.4,
  /** Exposures weaker than this are ignored. */
  minStrength: 0.05,
} as const;

export interface FlashExposure {
  /** 0..1 whiteout strength. */
  readonly blind: number;
  readonly blindSeconds: number;
  /** 0..1 ringing strength. */
  readonly deaf: number;
  readonly deafSeconds: number;
}

export const NO_FLASH: FlashExposure = { blind: 0, blindSeconds: 0, deaf: 0, deafSeconds: 0 };

/**
 * Flashbang exposure for one viewer. `viewDir` is the unit look direction; `occluded` is whether the world blocks
 * the line from the flash to the eye (smoke doesn't shield: the flash lights it up).
 * - Blind = distance factor × view factor, zero when occluded. The view factor eases from 1 when facing the flash
 *   down to FLASH.behind at 180°, with a floor at close range.
 * - Deaf = distance factor (wider range), reduced when occluded.
 */
export function flashExposure(eye: Vec3, viewDir: Vec3, flash: Vec3, occluded: boolean): FlashExposure {
  const dx = flash.x - eye.x;
  const dy = flash.y - eye.y;
  const dz = flash.z - eye.z;
  const distance = len3(dx, dy, dz);

  let blind = 0;
  if (!occluded) {
    const cos = distance > 1e-6 ? (dx * viewDir.x + dy * viewDir.y + dz * viewDir.z) / distance : 1;
    let view = lerp(FLASH.behind, 1, smoothstep(-0.5, 0.85, cos));
    if (distance < FLASH.closeRange) view = Math.max(view, FLASH.closeMinimumView);
    blind = rangeFactor(distance, FLASH.blindFullRange, FLASH.blindRange) * view;
  }
  let deaf = rangeFactor(distance, FLASH.deafFullRange, FLASH.deafRange) * (occluded ? FLASH.occludedDeaf : 1);
  if (blind < FLASH.minStrength) blind = 0;
  if (deaf < FLASH.minStrength) deaf = 0;
  return { blind, blindSeconds: blind * FLASH.maxBlindSeconds, deaf, deafSeconds: deaf * FLASH.maxDeafSeconds };
}

function rangeFactor(distance: number, full: number, range: number): number {
  return clamp01(1 - (distance - full) / (range - full));
}
