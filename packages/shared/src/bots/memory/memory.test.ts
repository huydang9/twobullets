import { describe, expect, it } from "vitest";
import { BotMemoryState, MEMORY_CAPACITY } from "./memory";

const V = (x: number, z: number) => ({ x, y: 0, z });

describe("bot memory", () => {
  it("refreshes entries per slot and fades them linearly", () => {
    const memory = new BotMemoryState();
    memory.observe(4, true, V(10, 0), V(1, 0), 0, "seen", 1);
    memory.observe(4, true, V(12, 0), V(1, 0), 30, "seen", 1);
    expect(memory.count).toBe(1);
    memory.decay(30 + 300, 600);
    expect(memory.find(4)!.confidence).toBeCloseTo(0.5, 5);
    memory.decay(30 + 600, 600);
    expect(memory.find(4)).toBeNull();
  });

  it("evicts the weakest entry when full", () => {
    const memory = new BotMemoryState();
    for (let i = 0; i < MEMORY_CAPACITY; i++) memory.observe(i, true, V(i, 0), null, 0, "heard", 0.5 + i * 0.01);
    memory.observe(20, true, V(0, 0), null, 0, "seen", 1);
    expect(memory.count).toBe(MEMORY_CAPACITY);
    expect(memory.find(0)).toBeNull();
    expect(memory.find(20)).not.toBeNull();
  });

  it("a noise doesn't overwrite a fresher sighting; extrapolation is capped at 1.5 s", () => {
    const memory = new BotMemoryState();
    const seen = memory.observe(2, true, V(0, 0), V(4, 0), 0, "seen", 1);
    memory.observe(2, true, V(50, 50), null, 1, "heard", 0.6);
    expect(seen.source).toBe("seen");
    const out = { x: 0, y: 0, z: 0 };
    memory.estimate(seen, 600, 1 / 60, out);
    expect(out.x).toBeCloseTo(6, 5);
  });

  it("danger circles and skipped loot expire", () => {
    const memory = new BotMemoryState();
    memory.addDanger(1, 2, 8, 4, 100);
    memory.skipLoot(77, 50);
    expect(memory.danger).toHaveLength(1);
    expect(memory.isLootSkipped(77, 10)).toBe(true);
    memory.decay(100, 600);
    expect(memory.danger).toHaveLength(0);
    expect(memory.isLootSkipped(77, 60)).toBe(false);
  });
});
