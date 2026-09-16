import { describe, expect, it } from "vitest";
import { getBuildingPrefab, getPrefabLootSpots, isBuildingPrefabId, worldToLocal } from "../map/buildings/index";
import { MAP_V1 } from "../map/mapV1";
import { ITEMS, type ItemId } from "./items";
import {
  createGroundLoot,
  dropGroundItem,
  generateLoot,
  LOOT,
  pickLootTarget,
  queryGroundLoot,
  setGroundQuantity,
  takeGroundItem,
  type LootBuilding,
  type LootLayout,
} from "./loot";

const SEED = 0xc0ffee;
const buildings: readonly LootBuilding[] = MAP_V1.buildings;

function categoryCounts(layout: LootLayout): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of layout.items) {
    const category = ITEMS[item.itemId].category;
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

function itemCounts(layout: LootLayout): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of layout.items) counts[item.itemId] = (counts[item.itemId] ?? 0) + 1;
  return counts;
}

describe("loot generation", () => {
  const layout = generateLoot(SEED, MAP_V1.pois, buildings);

  it("is reproducible from the seed and changes with it", () => {
    expect(generateLoot(SEED, MAP_V1.pois, buildings)).toEqual(layout);
    const other = generateLoot(SEED + 1, MAP_V1.pois, buildings);
    expect(other.items.map((i) => i.itemId)).not.toEqual(layout.items.map((i) => i.itemId));
  });

  it("doesn't reshuffle other buildings when one building changes", () => {
    const moved = buildings.map((b, i) => (i === 0 ? { ...b, position: [b.position[0] + 3, b.position[1], b.position[2]] as const } : b));
    const again = generateLoot(SEED, MAP_V1.pois, moved);
    const signature = (l: LootLayout, id: string) => l.piles.filter((p) => p.buildingId === id).map((p) => [p.roomId, p.items.map((i) => [i.itemId, i.quantity])]);
    for (const b of buildings.slice(1)) expect(signature(again, b.id)).toEqual(signature(layout, b.id));
  });

  it("places every pile on a room floor inside its building", () => {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    for (const pile of layout.piles) {
      const building = byId.get(pile.buildingId)!;
      if (!isBuildingPrefabId(building.prefab)) throw new Error(building.prefab);
      const room = getBuildingPrefab(building.prefab).rooms.find((r) => r.id === pile.roomId)!;
      const local = worldToLocal(building, pile.position);
      expect(local[1]).toBeCloseTo(room.floorY, 3);
      expect(local[0]).toBeGreaterThanOrEqual(room.min[0] - 1e-3);
      expect(local[0]).toBeLessThanOrEqual(room.max[0] + 1e-3);
      expect(local[2]).toBeGreaterThanOrEqual(room.min[1] - 1e-3);
      expect(local[2]).toBeLessThanOrEqual(room.max[1] + 1e-3);
      for (const item of pile.items) expect(item.position[1]).toBe(pile.position[1]);
    }
    expect(new Set(layout.items.map((i) => i.lootId)).size).toBe(layout.items.length);
  });

  it("gives every building loot, nearly every pile a gun, and plenty for 20 players on the 500 m map", () => {
    const withLoot = new Set(layout.piles.map((p) => p.buildingId));
    expect(withLoot.size).toBe(buildings.filter((b) => isBuildingPrefabId(b.prefab) && b.prefab !== "container_closed").length);
    expect(layout.piles.length).toBeGreaterThan(1050);
    expect(layout.piles.length).toBeLessThan(1200);
    expect(layout.items.length).toBeGreaterThan(2100);
    expect(layout.items.length).toBeLessThan(2400);
    for (const pile of layout.piles) {
      expect(pile.items.length).toBeGreaterThanOrEqual(1);
      expect(pile.items.length).toBeLessThanOrEqual(LOOT.maxItemsPerPile + 1);
      expect(pile.outdoor).toBeUndefined();
    }
    // Rolled piles (2+ items) nearly always hold a gun; single-item piles are the guaranteed heal/armor/throwable top-ups.
    const rolled = layout.piles.filter((p) => p.items.length > 1);
    const armed = rolled.filter((p) => p.items.some((i) => ITEMS[i.itemId].category === "weapon"));
    expect(armed.length / rolled.length).toBeGreaterThan(0.85);
    const counts = categoryCounts(layout);
    expect(counts.weapon).toBeGreaterThanOrEqual(380);
    expect(counts.ammo).toBeGreaterThanOrEqual(counts.weapon!);
    expect(counts.heal).toBeGreaterThanOrEqual(280);
    expect(counts.throwable).toBeGreaterThanOrEqual(590);
    expect((counts.helmet ?? 0) + (counts.vest ?? 0)).toBeGreaterThanOrEqual(280);
    expect(counts.backpack).toBeGreaterThanOrEqual(130);
    // Heals and gear are findable: a medkit in every few buildings, armor of every level (table v4).
    const ids = itemCounts(layout);
    expect(ids.medkit).toBeGreaterThanOrEqual(50);
    expect(ids.first_aid).toBeGreaterThanOrEqual(85);
    expect(ids.bandage).toBeGreaterThanOrEqual(115);
    // Throwables are plentiful (table v6): frag and smoke carry the category, flash and molotov are no longer scarce.
    expect(ids.frag).toBeGreaterThan(ids.smoke!);
    expect(ids.smoke).toBeGreaterThan(ids.flash!);
    expect(ids.flash).toBeGreaterThan(ids.molotov!);
    expect(ids.frag).toBeGreaterThanOrEqual(225);
    expect(ids.smoke).toBeGreaterThanOrEqual(205);
    expect(ids.flash).toBeGreaterThanOrEqual(80);
    expect(ids.molotov).toBeGreaterThanOrEqual(70);
    for (const slot of ["helmet", "vest", "backpack"] as const) {
      expect(ids[`${slot}_1`], `${slot}_1`).toBeGreaterThanOrEqual(60);
      expect(ids[`${slot}_2`], `${slot}_2`).toBeGreaterThanOrEqual(32);
      expect(ids[`${slot}_3`], `${slot}_3`).toBeGreaterThanOrEqual(10);
    }
    // Every building with loot spots holds at least one heal, and nearly every one a throwable (tables v5 and v6).
    const holders = (match: (id: ItemId) => boolean) =>
      new Set(layout.piles.filter((p) => p.items.some((i) => match(i.itemId))).map((p) => p.buildingId));
    const healBuildings = holders((id) => ITEMS[id].category === "heal");
    expect(healBuildings.size / withLoot.size).toBeGreaterThan(0.9);
    const throwableBuildings = holders((id) => ITEMS[id].category === "throwable");
    expect(throwableBuildings.size / withLoot.size).toBeGreaterThan(0.9);
    // Looting two or three buildings should turn up a frag and a smoke.
    for (const id of ["frag", "smoke"] as const) {
      const share = holders((item) => item === id).size / withLoot.size;
      expect(1 - (1 - share) ** 3, id).toBeGreaterThan(0.95);
    }
    // Every gun lies next to its ammo.
    for (const pile of layout.piles) {
      for (const item of pile.items) {
        const def = ITEMS[item.itemId];
        if (def.category === "weapon") expect(pile.items.some((o) => o.itemId === def.ammo && o.quantity >= ITEMS[def.ammo].lootQuantity * 2)).toBe(true);
      }
    }
  });

  it("puts several primary weapons with their ammo in big buildings", () => {
    const big = buildings.filter((b) => isBuildingPrefabId(b.prefab) && getPrefabLootSpots(b.prefab).length >= 3);
    const primaries = (id: string) =>
      layout.piles.filter((p) => p.buildingId === id).reduce((n, p) => n + p.items.filter((i) => {
        const def = ITEMS[i.itemId];
        return def.category === "weapon" && def.weaponClass === "primary" && p.items.some((o) => o.itemId === def.ammo && o.quantity >= ITEMS[def.ammo].lootQuantity * 2);
      }).length, 0);
    expect(big.filter((b) => primaries(b.id) > 0).length / big.length).toBeGreaterThan(0.95);
    const huge = big.filter((b) => isBuildingPrefabId(b.prefab) && getPrefabLootSpots(b.prefab).length >= 40);
    expect(huge.length).toBeGreaterThan(0);
    for (const b of huge) expect(primaries(b.id)).toBeGreaterThanOrEqual(3);
  });

  it("makes hot drops denser and better than outskirts", () => {
    const summary = (poi: string) => {
      const piles = layout.piles.filter((p) => p.poi === poi);
      const spots = buildings.filter((b) => b.poi === poi).reduce((n, b) => n + (isBuildingPrefabId(b.prefab) ? getBuildingPrefab(b.prefab).rooms.length : 0), 0);
      return { piles: piles.length, spots };
    };
    const layouts = [0, 1, 2, 3, 4, 5].map((k) => generateLoot(SEED + k, MAP_V1.pois, buildings));
    const share = (tier: number, predicate: (id: string) => boolean) => {
      let hits = 0;
      let total = 0;
      for (const l of layouts) {
        for (const item of l.items) {
          const poi = MAP_V1.pois.find((p) => p.id === l.piles[item.pileId]!.poi);
          if ((poi?.lootTier ?? 0) !== tier) continue;
          total++;
          if (predicate(item.itemId)) hits++;
        }
      }
      return hits / total;
    };
    const rare = (id: string) => id === "helmet_3" || id === "vest_3" || id === "backpack_3" || id === "weapon_sniper";
    expect(share(2, rare)).toBeGreaterThan(share(0, rare));
    expect(summary("town").piles).toBeGreaterThan(summary("forest").piles);
  });
});

describe("ground loot", () => {
  const items = generateLoot(SEED, MAP_V1.pois, buildings).items;

  it("takes whole and partial stacks, drops new items and bumps the version", () => {
    const ground = createGroundLoot(items);
    const ammo = items.find((i) => ITEMS[i.itemId].category === "ammo")!;
    const partial = takeGroundItem(ground, ammo.lootId, 5)!;
    expect(partial.quantity).toBe(5);
    expect(ground.items.get(ammo.lootId)!.quantity).toBe(ammo.quantity - 5);
    expect(takeGroundItem(ground, ammo.lootId)!.quantity).toBe(ammo.quantity - 5);
    expect(ground.items.has(ammo.lootId)).toBe(false);
    expect(takeGroundItem(ground, ammo.lootId)).toBeNull();

    const dropped = dropGroundItem(ground, { itemId: "frag", quantity: 2 }, [1, 2, 3]);
    expect(dropped.lootId).toBe(items.length);
    setGroundQuantity(ground, dropped.lootId, 1);
    expect(ground.items.get(dropped.lootId)!.quantity).toBe(1);
    setGroundQuantity(ground, dropped.lootId, 0);
    expect(ground.items.has(dropped.lootId)).toBe(false);
    expect(ground.version).toBe(5);
  });

  it("finds nearby items and picks the one being looked at", () => {
    const ground = createGroundLoot([]);
    const a = dropGroundItem(ground, { itemId: "bandage", quantity: 5 }, [0.5, 0, 1.5]);
    const b = dropGroundItem(ground, { itemId: "medkit", quantity: 1 }, [-1.5, 0, 0.3]);
    dropGroundItem(ground, { itemId: "frag", quantity: 1 }, [20, 0, 0]);
    const eye = { x: 0, y: 1.65, z: 0 };
    const near = queryGroundLoot(ground, { x: 0, y: 0, z: 0 }, 3);
    expect(near.map((i) => i.lootId)).toEqual([b.lootId, a.lootId]);
    const lookAtA = { x: 0.5 / 2.3, y: -1.65 / 2.3, z: 1.5 / 2.3 };
    expect(pickLootTarget(near, eye, lookAtA)?.lootId).toBe(a.lootId);
    // Looking at the sky offers the nearest reachable item instead.
    expect(pickLootTarget(near, eye, { x: 0, y: 1, z: 0 })?.lootId).toBe(b.lootId);
    expect(pickLootTarget(queryGroundLoot(ground, { x: 20, y: 0, z: 0 }, 3), eye, lookAtA)).toBeNull();
  });
});
