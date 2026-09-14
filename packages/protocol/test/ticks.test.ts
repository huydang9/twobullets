import { describe, expect, it } from "vitest";
import { NO_TICK, decodeOptionalTick16, encodeOptionalTick16, tickDiff16, unwrapTick16, wrapTick16 } from "../src/ticks";
import { createTestRng, randInt } from "./rng";

describe("u16 tick unwrap", () => {
  it("recovers any tick within ±32767 of the reference", () => {
    const rng = createTestRng(3);
    for (let i = 0; i < 50000; i++) {
      const ref = randInt(rng, 0, 2 ** 31);
      const delta = randInt(rng, -32767, 32767);
      const tick = ref + delta;
      if (tick < 0) continue;
      expect(unwrapTick16(wrapTick16(tick), ref)).toBe(tick);
      expect(tickDiff16(wrapTick16(tick), wrapTick16(ref))).toBe(delta);
    }
  });

  it("never returns a negative tick near zero", () => {
    expect(unwrapTick16(0xffff, 5)).toBe(0xffff);
    expect(unwrapTick16(3, 0)).toBe(3);
    expect(unwrapTick16(0, 70000)).toBe(65536);
  });

  it("optional ticks", () => {
    expect(decodeOptionalTick16(encodeOptionalTick16(NO_TICK), 100)).toBe(NO_TICK);
    expect(decodeOptionalTick16(encodeOptionalTick16(123456), 123400)).toBe(123456);
  });
});
