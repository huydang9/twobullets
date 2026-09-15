import { createGroundLoot, generateLoot, queryGroundLoot } from "@twobullets/shared/equipment/loot";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { describe, expect, it } from "vitest";
import { queryGroundLootInto } from "../../src/match/lootQuery";

describe("queryGroundLootInto", () => {
  const ground = createGroundLoot(generateLoot(0x2b0b, MAP_V1.pois, MAP_V1.buildings).items);
  const centers = [...ground.items.values()].filter((_, i) => i % 97 === 0).map((item) => ({ x: item.position[0] + 1.3, y: item.position[1], z: item.position[2] - 0.7 }));

  it("matches queryGroundLoot, and its nearest `limit` items with a limit", () => {
    const out: Parameters<typeof queryGroundLootInto>[3] = [];
    let dense = 0;
    for (const center of centers) {
      const expected = queryGroundLoot(ground, center, 35).map((i) => i.lootId);
      queryGroundLootInto(ground, center, 35, out);
      expect(out.map((i) => i.lootId)).toEqual(expected);
      queryGroundLootInto(ground, center, 35, out, 64);
      expect(out.map((i) => i.lootId)).toEqual(expected.slice(0, 64));
      if (expected.length > 64) dense++;
    }
    expect(dense).toBeGreaterThan(0);
  });
});
