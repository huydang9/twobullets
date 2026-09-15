import { describe, expect, it } from "vitest";
import { getPrefabLootSpots, isBuildingPrefabId } from "../map/buildings/index";
import { MAP_V1 } from "../map/mapV1";
import { loadRealMap } from "../map/real/index";
import type { PointOfInterest } from "../map/types";
import { ITEMS } from "./items";
import { generateLoot, type LootBuilding } from "./loot";

// Weapon availability per map. `LOOT_STATS=1 pnpm --filter @twobullets/shared exec vitest run src/equipment/lootStats.test.ts`
// prints the table. Loot ignores building Y, so the real maps use their unresolved layout buildings (no terrain build).

const SEEDS = [0xc0ffee, 1, 2, 3, 4, 5, 6, 7];
const print = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LOOT_STATS === "1";

interface Stats {
  piles: number;
  items: number;
  categories: Record<string, number>;
  weapons: Record<string, number>;
  /** Buildings with loot spots. */
  buildings: number;
  anyGun: number;
  primary: number;
  /** Buildings with >= 3 loot spots, and how many of them hold a primary. */
  big: number;
  bigPrimary: number;
  /** Primary weapons whose pile also holds its ammo. */
  primaryWithAmmo: number;
}

function measure(pois: readonly PointOfInterest[], buildings: readonly LootBuilding[]): Stats {
  const total: Stats = { piles: 0, items: 0, categories: {}, weapons: {}, buildings: 0, anyGun: 0, primary: 0, big: 0, bigPrimary: 0, primaryWithAmmo: 0 };
  const spotCount = new Map(buildings.flatMap((b) => (isBuildingPrefabId(b.prefab) ? [[b.id, getPrefabLootSpots(b.prefab).length] as const] : [])));
  for (const seed of SEEDS) {
    const layout = generateLoot(seed, pois, buildings);
    total.piles += layout.piles.length;
    total.items += layout.items.length;
    const gun = new Set<string>();
    const primary = new Set<string>();
    for (const pile of layout.piles) {
      for (const item of pile.items) {
        const def = ITEMS[item.itemId];
        total.categories[def.category] = (total.categories[def.category] ?? 0) + 1;
        if (def.category !== "weapon") continue;
        total.weapons[item.itemId] = (total.weapons[item.itemId] ?? 0) + 1;
        gun.add(pile.buildingId);
        if (def.weaponClass === "primary") {
          primary.add(pile.buildingId);
          if (pile.items.some((other) => other.itemId === def.ammo)) total.primaryWithAmmo++;
        }
      }
    }
    for (const [id, spots] of spotCount) {
      if (spots === 0) continue;
      total.buildings++;
      if (gun.has(id)) total.anyGun++;
      if (primary.has(id)) total.primary++;
      if (spots >= 3) {
        total.big++;
        if (primary.has(id)) total.bigPrimary++;
      }
    }
  }
  return total;
}

function report(name: string, s: Stats): { primaryShare: number; bigPrimaryShare: number; threeBuildings: number } {
  const n = SEEDS.length;
  const avg = (v: number) => Math.round((v / n) * 10) / 10;
  const primaryShare = s.primary / s.buildings;
  const bigPrimaryShare = s.bigPrimary / Math.max(1, s.big);
  const threeBuildings = 1 - (1 - primaryShare) ** 3;
  if (print) {
    const table = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} ${avg(v)}`).join(", ");
    const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
    console.log(
      [
        `${name} (avg of ${n} seeds): ${avg(s.piles)} piles, ${avg(s.items)} items, ${avg(s.buildings)} buildings (${avg(s.big)} with >= 3 spots)`,
        `  categories: ${table(s.categories)}`,
        `  weapons: ${table(s.weapons)}; primaries with ammo in the pile ${pct(s.primaryWithAmmo / Math.max(1, (s.weapons.weapon_rifle ?? 0) + (s.weapons.weapon_shotgun ?? 0) + (s.weapons.weapon_sniper ?? 0)))}`,
        `  building has a gun ${pct(s.anyGun / s.buildings)}, a primary ${pct(primaryShare)}; >= 3 spots has a primary ${pct(bigPrimaryShare)}`,
        `  3 random buildings hold a primary ${pct(threeBuildings)}`,
      ].join("\n"),
    );
  }
  return { primaryShare, bigPrimaryShare, threeBuildings };
}

describe("loot weapon availability", () => {
  it("Map v1", () => {
    const r = report("Map v1", measure(MAP_V1.pois, MAP_V1.buildings));
    expect(r.bigPrimaryShare).toBeGreaterThan(0.85);
    expect(r.threeBuildings).toBeGreaterThan(0.97);
  });

  it("vn-hangxanh", async () => {
    const { map } = await loadRealMap("vn-hangxanh");
    const r = report("vn-hangxanh", measure(map.pois, map.buildings));
    expect(r.bigPrimaryShare).toBeGreaterThan(0.85);
    expect(r.threeBuildings).toBeGreaterThan(0.97);
  }, 60_000);
});
