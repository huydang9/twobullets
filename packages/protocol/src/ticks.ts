// u16 wire ticks (netcode.md §3.1): wrap every 18.2 min at 60 Hz; unwrapped against the receiver's u32 tick by the
// nearest-value rule.

/** Sentinel for "no tick" in decoded structs (wire 0xFFFF where the layout allows it). */
export const NO_TICK = -1;
export const TICK16_NONE = 0xffff;

export function wrapTick16(tick: number): number {
  return tick & 0xffff;
}

/** The u32 tick nearest `referenceTick` whose low 16 bits equal `wire`. Never negative. */
export function unwrapTick16(wire: number, referenceTick: number): number {
  const ref = referenceTick < 0 ? 0 : referenceTick;
  const delta = ((((wire & 0xffff) - (ref & 0xffff) + 0x8000) & 0xffff) - 0x8000) | 0;
  const tick = ref + delta;
  return tick < 0 ? tick + 0x10000 : tick;
}

/** Signed tick distance a − b for u16 ticks, in [−32768, 32767]. */
export function tickDiff16(a: number, b: number): number {
  return (((a - b + 0x8000) & 0xffff) - 0x8000) | 0;
}

/** Encodes an optional tick (NO_TICK → 0xFFFF). A real tick whose low bits are 0xFFFF also reads back as none. */
export function encodeOptionalTick16(tick: number): number {
  return tick < 0 ? TICK16_NONE : tick & 0xffff;
}

export function decodeOptionalTick16(wire: number, referenceTick: number): number {
  return wire === TICK16_NONE ? NO_TICK : unwrapTick16(wire, referenceTick);
}
