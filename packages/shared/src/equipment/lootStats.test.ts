import { describe, expect, it } from "vitest";
import { getPrefabLootSpots, isBuildingPrefabId } from "../map/buildings/index";
import { distanceToRect } from "../map/layout/geometry";
import { buildMapLayout } from "../map/layout/mapLayout";
import { MAP_V1 } from "../map/mapV1";
import { loadRealMap } from "../map/real/index";
import { buildTerrain } from "../map/terrain/terrain";
import type { MapData, PointOfInterest } from "../map/types";
import { ITEMS } from "./items";
import { generateLoot, LOOT, type LootBuilding, type OutdoorLootWorld } from "./loot";

// Weapon availability per map. `LOOT_STATS=1 pnpm --filter @twobullets/shared exec vitest run --silent=false
// --reporter=verbose src/equipment/lootStats.test.ts` prints the table. Building loot ignores building Y, so the
// building-only rows use the unresolved layout buildings; the outdoor rows build the terrain and layout.

const SEEDS = [0xc0ffee, 1, 2, 3, 4, 5, 6, 7];
const print = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LOOT_STATS === "1";

interface Stats {
  piles: number;
  items: number;
  categories: Record<string, number>;
  weapons: Record<string, number>;
  /** Piles holding a gun. */
  armedPiles: number;
  outdoorPiles: number;
  outdoorGuns: number;
  /** Buildings with loot spots. */
  buildings: number;
  anyGun: number;
  primary: number;
  /** Buildings with >= 3 loot spots, and how many of them hold a primary. */
  big: number;
  bigPrimary: number;
  /** Guns whose pile also holds their ammo. */
  gunsWithAmmo: number;
}

function measure(pois: readonly PointOfInterest[], buildings: readonly LootBuilding[], outdoor?: OutdoorLootWorld): Stats {
  const total: Stats = { piles: 0, items: 0, categories: {}, weapons: {}, armedPiles: 0, outdoorPiles: 0, outdoorGuns: 0, buildings: 0, anyGun: 0, primary: 0, big: 0, bigPrimary: 0, gunsWithAmmo: 0 };
  const spotCount = new Map(buildings.flatMap((b) => (isBuildingPrefabId(b.prefab) ? [[b.id, getPrefabLootSpots(b.prefab).length] as const] : [])));
  for (const seed of SEEDS) {
    const layout = generateLoot(seed, pois, buildings, outdoor);
    total.piles += layout.piles.length;
    total.items += layout.items.length;
    const gun = new Set<string>();
    const primary = new Set<string>();
    for (const pile of layout.piles) {
      if (pile.outdoor) total.outdoorPiles++;
      let armed = false;
      for (const item of pile.items) {
        const def = ITEMS[item.itemId];
        total.categories[def.category] = (total.categories[def.category] ?? 0) + 1;
        if (def.category !== "weapon") continue;
        armed = true;
        total.weapons[item.itemId] = (total.weapons[item.itemId] ?? 0) + 1;
        if (pile.outdoor) total.outdoorGuns++;
        if (pile.items.some((other) => other.itemId === def.ammo)) total.gunsWithAmmo++;
        gun.add(pile.buildingId);
        if (def.weaponClass === "primary") primary.add(pile.buildingId);
      }
      if (armed) total.armedPiles++;
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

interface Report {
  guns: number;
  items: number;
  piles: number;
  outdoorGuns: number;
  armedPileShare: number;
  gunsWithAmmoShare: number;
  bigPrimaryShare: number;
  threeBuildings: number;
  avg: (category: string) => number;
  weapon: (id: string) => number;
}

function report(name: string, s: Stats): Report {
  const n = SEEDS.length;
  const avg = (v: number) => Math.round((v / n) * 10) / 10;
  const guns = Object.values(s.weapons).reduce((a, b) => a + b, 0);
  const primaryShare = s.primary / s.buildings;
  const bigPrimaryShare = s.bigPrimary / Math.max(1, s.big);
  const threeBuildings = 1 - (1 - primaryShare) ** 3;
  const r: Report = {
    guns: avg(guns),
    items: avg(s.items),
    piles: avg(s.piles),
    outdoorGuns: avg(s.outdoorGuns),
    armedPileShare: s.armedPiles / s.piles,
    gunsWithAmmoShare: s.gunsWithAmmo / Math.max(1, guns),
    bigPrimaryShare,
    threeBuildings,
    avg: (category) => avg(category === "armor" ? (s.categories.helmet ?? 0) + (s.categories.vest ?? 0) : (s.categories[category] ?? 0)),
    weapon: (id) => avg(s.weapons[id] ?? 0),
  };
  if (print) {
    const table = (t: Record<string, number>) => Object.entries(t).map(([k, v]) => `${k} ${avg(v)}`).join(", ");
    const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
    console.log(
      [
        `${name} (avg of ${n} seeds): ${r.piles} piles, ${r.items} items, ${avg(s.buildings)} buildings (${avg(s.big)} with >= 3 spots)`,
        `  categories: ${table(s.categories)}`,
        `  guns ${r.guns}: ${table(s.weapons)}; piles with a gun ${pct(r.armedPileShare)}; guns with ammo in the pile ${pct(r.gunsWithAmmoShare)}`,
        `  outdoor piles ${avg(s.outdoorPiles)} with ${r.outdoorGuns} guns`,
        `  building has a gun ${pct(s.anyGun / s.buildings)}, a primary ${pct(primaryShare)}; >= 3 spots has a primary ${pct(bigPrimaryShare)}`,
        `  3 random buildings hold a primary ${pct(threeBuildings)}`,
      ].join("\n"),
    );
  }
  return r;
}

/** Table version 1 (before the weapon passes): heals, throwables and armor must not drop below it. */
const V1_LEVELS = {
  "Map v1": { heal: 94, throwable: 66, armor: 80, boost: 51, backpack: 46 },
  "vn-hangxanh": { heal: 81, throwable: 55, armor: 68, boost: 38, backpack: 35 },
} as const;

function expectPlenty(name: keyof typeof V1_LEVELS, r: Report, minGuns: number): void {
  expect(r.guns).toBeGreaterThanOrEqual(minGuns);
  expect(r.armedPileShare).toBeGreaterThan(0.85);
  expect(r.gunsWithAmmoShare).toBe(1);
  expect(r.bigPrimaryShare).toBeGreaterThan(0.95);
  expect(r.threeBuildings).toBeGreaterThan(0.99);
  // Rifle most common, then shotgun, sniper, pistol.
  expect(r.weapon("weapon_rifle")).toBeGreaterThan(r.weapon("weapon_shotgun"));
  expect(r.weapon("weapon_shotgun")).toBeGreaterThan(r.weapon("weapon_sniper"));
  expect(r.weapon("weapon_sniper")).toBeGreaterThan(r.weapon("weapon_pistol"));
  for (const [category, level] of Object.entries(V1_LEVELS[name])) expect(r.avg(category), category).toBeGreaterThanOrEqual(level);
}

/** Outdoor piles stand on playable, gentle terrain at its height, clear of buildings. */
function expectOutdoorPlacement(pois: readonly PointOfInterest[], buildings: readonly LootBuilding[], world: OutdoorLootWorld): void {
  const layout = generateLoot(SEEDS[0]!, pois, buildings, world);
  const outdoor = layout.piles.filter((p) => p.outdoor);
  expect(outdoor.length).toBeGreaterThan(0);
  for (const pile of outdoor) {
    const [x, y, z] = pile.position;
    expect(world.terrain.isPlayable(x, z)).toBe(true);
    expect(world.terrain.slopeTanAt(x, z)).toBeLessThanOrEqual(LOOT.outdoor.maxSlopeTan);
    expect(Math.abs(y - world.terrain.sampleHeight(x, z))).toBeLessThan(2e-3);
    for (const b of world.layout.buildings) expect(distanceToRect(b.bounds, x, z)).toBeGreaterThanOrEqual(LOOT.outdoor.buildingClearance - 1e-6);
    expect(pile.items.some((i) => ITEMS[i.itemId].category === "weapon")).toBe(true);
    for (const item of pile.items) expect(Math.abs(item.position[1] - world.terrain.sampleHeight(item.position[0], item.position[2]))).toBeLessThan(2e-3);
  }
}

function outdoorWorld(map: MapData): OutdoorLootWorld {
  const terrain = buildTerrain(map.terrain, map.flatten);
  return { flatten: map.flatten, terrain, layout: buildMapLayout(map, terrain) };
}

describe("loot weapon availability", () => {
  it("Map v1", () => {
    const r = report("Map v1", measure(MAP_V1.pois, MAP_V1.buildings));
    expectPlenty("Map v1", r, 450);
    expect(r.items).toBeLessThan(2400);
  });

  it("vn-hangxanh", async () => {
    const { map } = await loadRealMap("vn-hangxanh");
    const r = report("vn-hangxanh", measure(map.pois, map.buildings));
    expectPlenty("vn-hangxanh", r, 550);
    expect(r.items).toBeLessThan(2800);
  }, 60_000);

  it("Map v1 with outdoor piles", () => {
    const world = outdoorWorld(MAP_V1);
    const r = report("Map v1 + outdoor", measure(MAP_V1.pois, world.layout.buildings, world));
    expect(r.outdoorGuns).toBeGreaterThan(20);
    expectOutdoorPlacement(MAP_V1.pois, world.layout.buildings, world);
  }, 120_000);

  it("vn-hangxanh with outdoor piles", async () => {
    const { map } = await loadRealMap("vn-hangxanh");
    const world = outdoorWorld(map);
    const r = report("vn-hangxanh + outdoor", measure(map.pois, world.layout.buildings, world));
    expect(r.outdoorGuns).toBeGreaterThan(20);
    expectOutdoorPlacement(map.pois, world.layout.buildings, world);
  }, 180_000);
});
