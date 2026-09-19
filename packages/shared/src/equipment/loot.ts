import type { Vec3Tuple } from "../level/types";
import type { Vec3 } from "../movement/types";
import { getBuildingPrefab, getPrefabLootSpots, isBuildingPrefabId, localToWorld } from "../map/buildings/index";
import type { ResolvedBuilding } from "../map/layout/buildings";
import { distanceToRect, SpatialHash } from "../map/layout/geometry";
import type { PropInstanceSet } from "../map/layout/mapLayout";
import { getMapProp } from "../map/layout/props";
import { mapPaths } from "../map/layout/roads";
import { INSTANCE_STRIDE } from "../map/layout/scatter";
import type { FlattenRegion, PadLoot, PointOfInterest } from "../map/types";
import type { ItemInstance } from "./inventory";
import { ITEMS, type ItemCategory, type ItemId } from "./items";
import { createRng, hash32, hashString, len2, len3, pickWeighted } from "./math";

/** Bump when tables or generation change; part of the match content hash (netcode §8.3). */
export const LOOT_TABLE_VERSION = 6;

type Tier = 0 | 1 | 2;
type TierTable<K extends string> = readonly [Readonly<Partial<Record<K, number>>>, Readonly<Partial<Record<K, number>>>, Readonly<Partial<Record<K, number>>>];
type LootCategory = Exclude<ItemCategory, "helmet" | "vest"> | "armor";
/** Categories a building is topped up with (`guaranteedSupplies`). Appended to, so older kinds keep their RNG draws. */
const SUPPLY_KINDS = ["heal", "armor", "backpack", "throwable"] as const;
type SupplyKind = (typeof SUPPLY_KINDS)[number];

export const LOOT = {
  /** Chance that a building loot spot (1.5 m grid) holds a pile, by POI tier. Outdoor rooms (balconies, roofs) get less. */
  spotChance: [0.17, 0.22, 0.28],
  outdoorChanceScale: 0.6,
  /** Buildings outside any POI use tier 0 at this scale. */
  outskirtsChanceScale: 0.8,
  /** A building gets at least ceil(sqrt(spots) × this) piles (extra piles on seeded free spots), so small houses get several. */
  minPilesPerSqrtSpot: 1.1,
  /** Chance that a pile starts with a gun and its ammo, by tier; its other rolls follow. */
  pileWeaponChance: [0.88, 0.92, 0.95],
  /** Chance of each further roll after the first (up to `maxRolls`). */
  extraItemChance: [0.45, 0.55, 0.62],
  maxRolls: 4,
  /** A pile stops rolling once it holds this many items (a gun and its ammo are two). */
  maxItemsPerPile: 6,
  /** Items in a pile sit on a ring of this radius around the spot, m; piles of 4+ items use the wide ring. */
  pileRadius: 0.3,
  widePileRadius: 0.5,

  /** Rolls after a pile's gun (the weapon weight is a second gun). */
  category: [
    { weapon: 8, ammo: 14, heal: 33, boost: 9, throwable: 17, armor: 34, backpack: 14, attachment: 0 },
    { weapon: 9, ammo: 14, heal: 31, boost: 9, throwable: 18, armor: 35, backpack: 14, attachment: 0 },
    { weapon: 10, ammo: 13, heal: 28, boost: 10, throwable: 19, armor: 37, backpack: 13, attachment: 0 },
  ] satisfies TierTable<LootCategory>,
  weapon: [
    { weapon_pistol: 18, weapon_shotgun: 30, weapon_rifle: 42, weapon_sniper: 10 },
    { weapon_pistol: 14, weapon_shotgun: 24, weapon_rifle: 46, weapon_sniper: 16 },
    { weapon_pistol: 10, weapon_shotgun: 20, weapon_rifle: 48, weapon_sniper: 22 },
  ] satisfies TierTable<ItemId>,
  /** Military POIs multiply sniper weight. */
  militarySniperScale: 1.5,
  /**
   * A building with at least `minSpots` loot spots should hold 1 + floor(spots / spotsPerPrimary) primary weapons; each
   * missing one is added (from the tier's weapon table without pistols) with this chance by tier, on a free spot as a
   * new pile, else joining a pile with room.
   */
  guaranteedPrimary: { minSpots: 3, spotsPerPrimary: 8, chance: [0.9, 0.95, 1] },
  /**
   * Medicine, gear and throwables live in buildings, so every building with at least `minSpots` loot spots should hold
   * base (default 1) + floor(spots / spotsPer) of each kind; each missing one is rolled from the building's tier tables
   * with `chance` and placed on a free spot as a new pile, else joined to a pile with room. Throwables use base 2 (table
   * v6) so the small houses of real maps hold a few, not one.
   */
  guaranteedSupplies: {
    chance: [0.85, 0.92, 1],
    heal: { minSpots: 1, spotsPer: 5 },
    armor: { minSpots: 2, spotsPer: 5 },
    backpack: { minSpots: 3, spotsPer: 11 },
    throwable: { minSpots: 1, spotsPer: 2.2, base: 2 },
  } as Readonly<{ chance: readonly number[] } & Record<SupplyKind, { minSpots: number; spotsPer: number; base?: number }>>,
  /** A loose ammo roll picks the ammo of a gun already found in the same building with this chance. */
  matchingAmmoChance: 0.6,
  ammo: [
    { ammo_9mm: 30, ammo_12g: 25, ammo_556: 33, ammo_762: 12 },
    { ammo_9mm: 22, ammo_12g: 22, ammo_556: 40, ammo_762: 16 },
    { ammo_9mm: 16, ammo_12g: 18, ammo_556: 45, ammo_762: 21 },
  ] satisfies TierTable<ItemId>,
  heal: [
    { bandage: 50, first_aid: 34, medkit: 16 },
    { bandage: 45, first_aid: 35, medkit: 20 },
    { bandage: 40, first_aid: 35, medkit: 25 },
  ] satisfies TierTable<ItemId>,
  boost: [{ energy_drink: 65, painkiller: 35 }, { energy_drink: 60, painkiller: 40 }, { energy_drink: 55, painkiller: 45 }] satisfies TierTable<ItemId>,
  throwable: [
    { frag: 34, smoke: 30, flash: 19, molotov: 17 },
    { frag: 34, smoke: 30, flash: 19, molotov: 17 },
    { frag: 35, smoke: 29, flash: 19, molotov: 17 },
  ] satisfies TierTable<ItemId>,
  /**
   * Tables for the guaranteed throwable, cycled by how many the building already holds: the first is nearly always a
   * frag and the second a smoke (table v5), so looting two or three buildings reliably turns up one of each; the third
   * leans to flash and molotov and the fourth is frag or smoke again (table v6).
   */
  supplyThrowable: [
    { frag: 84, smoke: 9, flash: 4, molotov: 3 },
    { frag: 15, smoke: 78, flash: 4, molotov: 3 },
    { frag: 16, smoke: 14, flash: 37, molotov: 33 },
    { frag: 50, smoke: 38, flash: 7, molotov: 5 },
  ] satisfies readonly Readonly<Partial<Record<ItemId, number>>>[],
  /** Armor and backpack level weights (L1, L2, L3). */
  level: [
    { 1: 68, 2: 26, 3: 6 },
    { 1: 58, 2: 32, 3: 10 },
    { 1: 46, 2: 38, 3: 16 },
  ] satisfies TierTable<"1" | "2" | "3">,
  /** Units per ground item for stackables other than ammo (ammo uses AmmoItemDef.lootQuantity). */
  quantity: { bandage: 5 } as Readonly<Partial<Record<ItemId, number>>>,
  /** A weapon comes with this many stacks of its ammo. */
  weaponAmmoStacks: [2, 3],

  /**
   * Ground piles outside buildings (only when `generateLoot` gets an `OutdoorLootWorld`): a gun and its ammo, unless
   * the pad asks for a full pile (`FlattenRegion.loot`).
   */
  outdoor: {
    /** Roadside stations along painted roads, m apart, each on a seeded side of the road. */
    roadSpacing: 20,
    /** Distance past the road edge, m. */
    roadShoulder: 1.2,
    /** Pile chance per road station inside a POI, by tier; stations outside every POI use `outskirtsChance`. */
    roadChance: [0.35, 0.5, 0.65],
    outskirtsChance: 0.2,
    /**
     * Grid step over POI pads (flatten circles and rects whose center is inside a POI), m, and chance per point. A pad
     * may scale its own chance and roll fuller piles with `FlattenRegion.loot` (map/types.ts `PadLoot`); these are what
     * a pad that says nothing gets.
     */
    padStep: 9,
    padChance: [0.2, 0.3, 0.4],
    /** Chance of one more roll after the gun (`cache` pads and roadsides). */
    extraItemChance: 0.5,
    /** Clear distance from building bounds, prop footprints and other outdoor piles, m. */
    buildingClearance: 2.5,
    propClearance: 0.6,
    pileSpacing: 6,
    maxSlopeTan: 0.25,
    /** Max height difference to the road center line (ditches, banks, embankments), m. */
    maxStep: 0.35,
  },
} as const;

/** A building as the generator needs it: MapLayout's ResolvedBuilding fits (Y must be resolved). */
export interface LootBuilding {
  readonly id: string;
  readonly prefab: string;
  readonly poi?: string;
  readonly position: Vec3Tuple;
  readonly yaw: number;
}

export interface LootItem extends ItemInstance {
  readonly lootId: number;
  readonly pileId: number;
  /** World position on the floor. */
  readonly position: Vec3Tuple;
}

export interface LootPile {
  readonly id: number;
  /** World floor position of the loot spot. */
  readonly position: Vec3Tuple;
  /** Building of the spot; "" for outdoor piles. */
  readonly buildingId: string;
  /** Room of the spot; "road" or "pad" for outdoor piles. */
  readonly roomId: string;
  readonly poi: string | null;
  readonly items: readonly LootItem[];
  /** Set on piles outside buildings. */
  readonly outdoor?: "road" | "pad";
}

export interface LootLayout {
  readonly seed: number;
  readonly version: number;
  readonly piles: readonly LootPile[];
  readonly items: readonly LootItem[];
}

/** Terrain queries outdoor piles need (map Terrain fits). */
export interface OutdoorLootTerrain {
  /** Physics surface height. */
  sampleHeight(x: number, z: number): number;
  slopeTanAt(x: number, z: number): number;
  isPlayable(x: number, z: number): boolean;
}

/** What outdoor piles are placed against: roads and pads from the map, the built terrain and the resolved layout. */
export interface OutdoorLootWorld {
  readonly flatten: readonly FlattenRegion[];
  readonly terrain: OutdoorLootTerrain;
  readonly layout: { readonly buildings: readonly ResolvedBuilding[]; readonly props: readonly PropInstanceSet[] };
}

/**
 * Deterministic ground loot for a match: every building loot spot rolls for a pile with a chance by its POI tier;
 * nearly every pile starts with a gun and its ammo, then 1–3 rolls from tier tables. Every spot is seeded from
 * (seed, building id, spot index), so adding or moving one building never reshuffles the others. Buildings get a
 * minimum number of piles by size and are topped up with primary weapons by size. With `outdoor`, roadsides and POI
 * pads get piles too (after all building piles) — gun caches, or full piles where the pad asks for them (`PadLoot`).
 * Pure data; the same result in the browser, the server and tests.
 */
export function generateLoot(seed: number, pois: readonly PointOfInterest[], buildings: readonly LootBuilding[], outdoor?: OutdoorLootWorld): LootLayout {
  const piles: LootPile[] = [];
  const items: LootItem[] = [];

  for (const building of buildings) {
    if (!isBuildingPrefabId(building.prefab)) continue;
    const spots = getPrefabLootSpots(building.prefab);
    if (spots.length === 0) continue;
    const poi = poiFor(building, pois);
    const tier: Tier = poi?.lootTier ?? 0;
    const military = poi?.kind === "military";
    const chanceScale = poi ? 1 : LOOT.outskirtsChanceScale;
    const buildingSeed = hash32(seed, hashString(building.id), LOOT_TABLE_VERSION);
    const outdoorRooms = new Set(getBuildingPrefab(building.prefab).rooms.filter((room) => !room.indoor).map((room) => room.id));
    const context: RollContext = { tier, military, gunAmmo: [], primaries: 0, supplies: { heal: 0, armor: 0, backpack: 0, throwable: 0 } };
    const weaponChance = LOOT.pileWeaponChance[tier];

    // Piles are drafted per building first so top-ups can join one before item ids are assigned.
    const drafts: { spotIndex: number; items: ItemInstance[] }[] = [];
    spots.forEach((spot, index) => {
      const random = createRng(hash32(buildingSeed, index));
      const chance = LOOT.spotChance[tier] * chanceScale * (outdoorRooms.has(spot.roomId) ? LOOT.outdoorChanceScale : 1);
      if (random() < chance) drafts.push({ spotIndex: index, items: rollPile(random, context, weaponChance) });
    });
    const extra = createRng(hash32(buildingSeed, 0xffff));
    const freeSpot = (): number => {
      const used = new Set(drafts.map((d) => d.spotIndex));
      const free = spots.map((_, i) => i).filter((i) => !used.has(i));
      // Top-ups go indoors first: gear belongs in rooms, not on the balcony rail.
      const indoor = free.filter((i) => !outdoorRooms.has(spots[i]!.roomId));
      const pool = indoor.length > 0 ? indoor : free;
      return pool.length > 0 ? pool[Math.floor(extra() * pool.length)]! : -1;
    };
    const minPiles = Math.min(spots.length, Math.ceil(Math.sqrt(spots.length) * LOOT.minPilesPerSqrtSpot));
    while (drafts.length < minPiles) drafts.push({ spotIndex: freeSpot(), items: rollPile(extra, context, weaponChance) });

    const addTopUp = (instances: readonly ItemInstance[], random: () => number): void => {
      if (instances.length === 0) return;
      const free = freeSpot();
      if (free >= 0) {
        drafts.push({ spotIndex: free, items: [...instances] });
        return;
      }
      // A full building's top-ups join a pile with a gun where one has room, so they don't pile up on each other.
      const roomy = drafts.filter((d) => d.items.length + instances.length <= LOOT.maxItemsPerPile + 1);
      const armed = roomy.filter((d) => d.items.some((item) => ITEMS[item.itemId].category === "weapon"));
      const pool = armed.length > 0 ? armed : roomy;
      if (pool.length > 0) pool[Math.floor(random() * pool.length)]!.items.push(...instances);
    };

    const guarantee = LOOT.guaranteedPrimary;
    const topUp = createRng(hash32(buildingSeed, 0xfffe));
    const wanted = spots.length >= guarantee.minSpots ? 1 + Math.floor(spots.length / guarantee.spotsPerPrimary) : 0;
    for (let k = context.primaries; k < wanted; k++) {
      if (topUp() >= guarantee.chance[tier]) continue;
      addTopUp(rollWeapon(topUp, context, true), topUp);
    }

    const supplies = LOOT.guaranteedSupplies;
    const supplyRng = createRng(hash32(buildingSeed, 0xfffd));
    for (const kind of SUPPLY_KINDS) {
      const rule = supplies[kind];
      if (spots.length < rule.minSpots) continue;
      const want = (rule.base ?? 1) + Math.floor(spots.length / rule.spotsPer);
      for (let k = context.supplies[kind]; k < want; k++) {
        if (supplyRng() >= supplies.chance[tier]!) continue;
        addTopUp(rollCategory(kind, supplyRng, context, true), supplyRng);
      }
    }

    for (const draft of drafts) {
      const spot = spots[draft.spotIndex]!;
      const position = roundTuple(localToWorld(building, spot.position));
      const jitter = createRng(hash32(buildingSeed, draft.spotIndex, 0x6a17));
      pushPile(piles, items, draft.items, position, jitter, null, { buildingId: building.id, roomId: spot.roomId, poi: poi?.id ?? null });
    }
  }
  if (outdoor) generateOutdoorLoot(seed, pois, outdoor, piles, items);
  return { seed, version: LOOT_TABLE_VERSION, piles, items };
}

function pushPile(
  piles: LootPile[],
  items: LootItem[],
  instances: readonly ItemInstance[],
  position: Vec3Tuple,
  jitter: () => number,
  terrain: OutdoorLootTerrain | null,
  meta: Pick<LootPile, "buildingId" | "roomId" | "poi" | "outdoor">,
): void {
  const pileId = piles.length;
  const r = instances.length > 3 ? LOOT.widePileRadius : instances.length > 1 ? LOOT.pileRadius : 0;
  const pileItems = instances.map((instance, k): LootItem => {
    const angle = (k / instances.length) * Math.PI * 2 + jitter() * 0.6;
    const x = position[0] + Math.sin(angle) * r;
    const z = position[2] + Math.cos(angle) * r;
    const y = terrain ? terrain.sampleHeight(x, z) : position[1];
    return { ...instance, lootId: items.length + k, pileId, position: roundTuple([x, y, z]) };
  });
  items.push(...pileItems);
  piles.push({ id: pileId, position, ...meta, items: pileItems });
}

/** Roadside and POI pad piles, placed clear of buildings, props and each other on gentle, playable ground. */
function generateOutdoorLoot(seed: number, pois: readonly PointOfInterest[], world: OutdoorLootWorld, piles: LootPile[], items: LootItem[]): void {
  const cfg = LOOT.outdoor;
  const { terrain } = world;
  const outdoorSeed = hash32(seed, 0x0d00, LOOT_TABLE_VERSION);
  const blockers = new SpatialHash<{ x: number; z: number; r: number }>(16);
  for (const set of world.layout.props) {
    const def = getMapProp(set.prop);
    if (def.category === "grass") continue;
    const base = def.category === "tree" && def.collision.kind === "cylinder" ? def.collision.radius : def.footprint;
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const r = base * set.data[i + 4]! + cfg.propClearance;
      blockers.insert({ x: set.data[i]!, z: set.data[i + 2]!, r }, set.data[i]!, set.data[i + 2]!, r);
    }
  }
  const buildingHash = new SpatialHash<ResolvedBuilding>(32);
  for (const b of world.layout.buildings) {
    const reach = Math.sqrt(b.bounds.halfExtents[0] ** 2 + b.bounds.halfExtents[1] ** 2) + cfg.buildingClearance;
    buildingHash.insert(b, b.bounds.center[0], b.bounds.center[1], reach);
  }
  const placed = new SpatialHash<{ x: number; z: number }>(cfg.pileSpacing * 2);

  const clear = (x: number, z: number): boolean => {
    if (!terrain.isPlayable(x, z) || terrain.slopeTanAt(x, z) > cfg.maxSlopeTan) return false;
    if (buildingHash.query(x, z, 0, (b) => distanceToRect(b.bounds, x, z) < cfg.buildingClearance)) return false;
    if (blockers.query(x, z, 0, (p) => (p.x - x) ** 2 + (p.z - z) ** 2 < p.r * p.r)) return false;
    return !placed.query(x, z, cfg.pileSpacing, (p) => (p.x - x) ** 2 + (p.z - z) ** 2 < cfg.pileSpacing * cfg.pileSpacing);
  };
  const place = (x: number, z: number, random: () => number, kind: "road" | "pad", pad?: PadLoot): void => {
    const poi = pois.find((p) => len2(x - p.center[0], z - p.center[1]) <= p.radius) ?? null;
    const context: RollContext = { tier: poi?.lootTier ?? 0, military: poi?.kind === "military", gunAmmo: [], primaries: 0, supplies: { heal: 0, armor: 0, backpack: 0, throwable: 0 } };
    // A `pile` pad rolls exactly what a building loot spot rolls, so ground loot on a map without buildings is not
    // guns and ammo alone; everything else stays the gun cache (`rollWeapon` then one more roll).
    let instances: ItemInstance[];
    if (pad?.style === "pile") {
      instances = rollPile(random, context, LOOT.pileWeaponChance[context.tier]);
    } else {
      instances = rollWeapon(random, context, false);
      if (random() < cfg.extraItemChance) instances.push(...rollCategory(pickWeighted<LootCategory>(LOOT.category[context.tier], random()), random, context));
    }
    placed.insert({ x, z }, x, z, 0);
    const position = roundTuple([x, terrain.sampleHeight(x, z), z]);
    pushPile(piles, items, instances, position, random, terrain, { buildingId: "", roomId: kind, poi: poi?.id ?? null, outdoor: kind });
  };

  for (const path of mapPaths(world)) {
    const points = path.points;
    let along = 0;
    let station = 0;
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1]!;
      const [bx, bz] = points[i]!;
      const length = len2(bx - ax, bz - az);
      if (length < 1e-6) continue;
      for (; (station + 0.5) * cfg.roadSpacing <= along + length; station++) {
        const random = createRng(hash32(outdoorSeed, path.index, station));
        const t = ((station + 0.5) * cfg.roadSpacing - along) / length;
        const cx = ax + (bx - ax) * t;
        const cz = az + (bz - az) * t;
        const poi = pois.find((p) => len2(cx - p.center[0], cz - p.center[1]) <= p.radius);
        if (random() >= (poi ? cfg.roadChance[poi.lootTier] : cfg.outskirtsChance)) continue;
        const side = random() < 0.5 ? -1 : 1;
        const offset = path.halfWidth + cfg.roadShoulder;
        const x = cx + (-(bz - az) / length) * offset * side;
        const z = cz + ((bx - ax) / length) * offset * side;
        if (Math.abs(terrain.sampleHeight(x, z) - terrain.sampleHeight(cx, cz)) > cfg.maxStep || !clear(x, z)) continue;
        place(x, z, random, "road");
      }
      along += length;
    }
  }

  world.flatten.forEach((region, index) => {
    if (region.shape === "polyline") return;
    const poi = pois.find((p) => len2(region.center[0] - p.center[0], region.center[1] - p.center[1]) <= p.radius);
    if (!poi) return;
    const reach = region.shape === "circle" ? region.radius : Math.max(region.halfExtents[0], region.halfExtents[1]);
    const cells = Math.floor(reach / cfg.padStep);
    const { sin, cos } = region.shape === "rect" ? { sin: Math.sin(region.yaw ?? 0), cos: Math.cos(region.yaw ?? 0) } : { sin: 0, cos: 1 };
    for (let gx = -cells; gx <= cells; gx++) {
      for (let gz = -cells; gz <= cells; gz++) {
        const lx = gx * cfg.padStep;
        const lz = gz * cfg.padStep;
        if (region.shape === "circle" ? lx * lx + lz * lz > (region.radius - 1) ** 2 : Math.abs(lx) > region.halfExtents[0] - 1 || Math.abs(lz) > region.halfExtents[1] - 1) continue;
        const random = createRng(hash32(outdoorSeed ^ 0x9ad, index, (gx + 512) * 1024 + gz + 512));
        if (random() >= cfg.padChance[poi.lootTier]! * (region.loot?.density ?? 1)) continue;
        const x = region.center[0] + lx * cos + lz * sin;
        const z = region.center[1] - lx * sin + lz * cos;
        if (clear(x, z)) place(x, z, random, "pad", region.loot);
      }
    }
  });
}

interface RollContext {
  readonly tier: Tier;
  readonly military: boolean;
  /** Ammo of the guns rolled so far in this building. */
  readonly gunAmmo: ItemId[];
  /** Primary weapons rolled so far in this building. */
  primaries: number;
  /** Heals, armor pieces, backpacks and throwables rolled so far in this building (`guaranteedSupplies`). */
  readonly supplies: Record<SupplyKind, number>;
}

function rollPile(random: () => number, context: RollContext, weaponChance: number): ItemInstance[] {
  const { tier } = context;
  const out: ItemInstance[] = random() < weaponChance ? rollWeapon(random, context, false) : [];
  let rolls = 1;
  while (rolls < LOOT.maxRolls && random() < LOOT.extraItemChance[tier]) rolls++;
  for (let r = 0; r < rolls && out.length < LOOT.maxItemsPerPile; r++) {
    const category = pickWeighted<LootCategory>(LOOT.category[tier], random());
    out.push(...rollCategory(category, random, context));
  }
  return out;
}

function rollWeapon(random: () => number, context: RollContext, primaryOnly: boolean): ItemInstance[] {
  const weights: Partial<Record<ItemId, number>> = { ...LOOT.weapon[context.tier] };
  if (context.military) weights.weapon_sniper = (weights.weapon_sniper ?? 0) * LOOT.militarySniperScale;
  if (primaryOnly) weights.weapon_pistol = 0;
  const id = pickWeighted(weights, random());
  const def = ITEMS[id];
  if (def.category !== "weapon") return [];
  if (def.weaponClass === "primary") context.primaries++;
  if (!context.gunAmmo.includes(def.ammo)) context.gunAmmo.push(def.ammo);
  const [minStacks, maxStacks] = LOOT.weaponAmmoStacks;
  const stacks = minStacks + Math.floor(random() * (maxStacks - minStacks + 1));
  return [{ itemId: id, quantity: 1, magazine: 0 }, { itemId: def.ammo, quantity: ITEMS[def.ammo].lootQuantity * stacks }];
}

/** `supply` marks a `guaranteedSupplies` top-up: throwables then come from the frag/smoke-heavy `supplyThrowable` table. */
function rollCategory(category: LootCategory, random: () => number, context: RollContext, supply = false): ItemInstance[] {
  const { tier } = context;
  switch (category) {
    case "weapon":
      return rollWeapon(random, context, false);
    case "ammo": {
      const matching = context.gunAmmo.length > 0 && random() < LOOT.matchingAmmoChance;
      const id = matching ? context.gunAmmo[Math.floor(random() * context.gunAmmo.length)]! : pickWeighted(LOOT.ammo[tier], random());
      const def = ITEMS[id];
      return def.category === "ammo" ? [{ itemId: id, quantity: def.lootQuantity }] : [];
    }
    case "heal":
    case "boost":
    case "throwable": {
      const table = category === "throwable" && supply ? LOOT.supplyThrowable[context.supplies.throwable % LOOT.supplyThrowable.length]! : LOOT[category][tier];
      const id = pickWeighted<ItemId>(table, random());
      if (category === "heal") context.supplies.heal++;
      if (category === "throwable") context.supplies.throwable++;
      return [{ itemId: id, quantity: LOOT.quantity[id] ?? 1 }];
    }
    case "armor": {
      const slot = random() < 0.5 ? "helmet" : "vest";
      const level = pickWeighted(LOOT.level[tier], random());
      const id: ItemId = `${slot}_${Number(level) as 1 | 2 | 3}`;
      const def = ITEMS[id];
      context.supplies.armor++;
      return [{ itemId: id, quantity: 1, durability: def.category === slot ? def.durability : 0 }];
    }
    case "backpack": {
      const level = pickWeighted(LOOT.level[tier], random());
      context.supplies.backpack++;
      return [{ itemId: `backpack_${Number(level) as 1 | 2 | 3}`, quantity: 1 }];
    }
    case "attachment":
      return [];
  }
}

function poiFor(building: LootBuilding, pois: readonly PointOfInterest[]): PointOfInterest | null {
  if (building.poi) return pois.find((p) => p.id === building.poi) ?? null;
  const [x, , z] = building.position;
  return pois.find((p) => len2(x - p.center[0], z - p.center[1]) <= p.radius) ?? null;
}

function roundTuple(p: Vec3Tuple): Vec3Tuple {
  return [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000, Math.round(p[2] * 1000) / 1000];
}

// ---------------------------------------------------------------------------------------------------------------
// Ground loot at runtime
// ---------------------------------------------------------------------------------------------------------------

const GRID_CELL = 8;

/**
 * Items lying on the ground during a match, with a coarse spatial hash for interaction queries. Mutable (a server
 * holds thousands of items); every change bumps `version`, the netcode's loot consistency counter.
 */
export interface GroundLoot {
  readonly items: Map<number, LootItem>;
  readonly cells: Map<number, Set<number>>;
  nextId: number;
  version: number;
}

export function createGroundLoot(items: readonly LootItem[]): GroundLoot {
  const ground: GroundLoot = { items: new Map(), cells: new Map(), nextId: 0, version: 0 };
  for (const item of items) insert(ground, item);
  ground.nextId = items.reduce((max, item) => Math.max(max, item.lootId + 1), 0);
  return ground;
}

/** Removes `quantity` (default all) from a ground item; returns what was taken, or null if it's gone. */
export function takeGroundItem(ground: GroundLoot, lootId: number, quantity?: number): LootItem | null {
  const item = ground.items.get(lootId);
  if (!item) return null;
  const take = Math.min(item.quantity, quantity ?? item.quantity);
  if (take <= 0) return null;
  remove(ground, item);
  if (take < item.quantity) insert(ground, { ...item, quantity: item.quantity - take });
  ground.version++;
  return { ...item, quantity: take };
}

/** Puts an item on the ground (drops, pickup remainders, swapped gear). Returns the new ground item. */
export function dropGroundItem(ground: GroundLoot, instance: ItemInstance, position: Vec3Tuple, pileId = -1): LootItem {
  const item: LootItem = { ...instance, lootId: ground.nextId++, pileId, position: roundTuple(position) };
  insert(ground, item);
  ground.version++;
  return item;
}

/**
 * Puts an item with a known loot id on the ground (networked clients mirroring the server's loot); an item with the
 * same id is replaced. Keeps `nextId` above every id.
 */
export function putGroundItem(ground: GroundLoot, item: LootItem): void {
  const existing = ground.items.get(item.lootId);
  if (existing) remove(ground, existing);
  insert(ground, item);
  if (item.lootId >= ground.nextId) ground.nextId = item.lootId + 1;
  ground.version++;
}

/** Removes a ground item entirely; returns it, or null if it wasn't there. */
export function removeGroundItem(ground: GroundLoot, lootId: number): LootItem | null {
  const item = ground.items.get(lootId);
  if (!item) return null;
  remove(ground, item);
  ground.version++;
  return item;
}

/** Empties the ground (a networked client's loot reset). */
export function clearGroundLoot(ground: GroundLoot): void {
  if (ground.items.size === 0) return;
  ground.items.clear();
  ground.cells.clear();
  ground.version++;
}

/** Replaces a ground item's quantity in place (partial pickups keep their loot id). */
export function setGroundQuantity(ground: GroundLoot, lootId: number, quantity: number): void {
  const item = ground.items.get(lootId);
  if (!item) return;
  remove(ground, item);
  if (quantity > 0) insert(ground, { ...item, quantity });
  ground.version++;
}

/** Ground items within `radius` of a point, nearest first. */
export function queryGroundLoot(ground: GroundLoot, center: Vec3, radius: number): LootItem[] {
  const out: { item: LootItem; d: number }[] = [];
  const minX = cellCoord(center.x - radius);
  const maxX = cellCoord(center.x + radius);
  const minZ = cellCoord(center.z - radius);
  const maxZ = cellCoord(center.z + radius);
  for (let cx = minX; cx <= maxX; cx++) {
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (const id of ground.cells.get(cellKey(cx, cz)) ?? []) {
        const item = ground.items.get(id)!;
        const d = len3(item.position[0] - center.x, item.position[1] - center.y, item.position[2] - center.z);
        if (d <= radius) out.push({ item, d });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d || a.item.lootId - b.item.lootId).map((e) => e.item);
}

/**
 * Calls `visit` for every ground item within `radius` of a point, in no particular order and without allocating
 * (renderers rebuilding instance buffers; use `queryGroundLoot` for nearest-first lists).
 */
export function forEachGroundLoot(ground: GroundLoot, center: Vec3, radius: number, visit: (item: LootItem) => void): void {
  const r2 = radius * radius;
  const minX = cellCoord(center.x - radius);
  const maxX = cellCoord(center.x + radius);
  const minZ = cellCoord(center.z - radius);
  const maxZ = cellCoord(center.z + radius);
  for (let cx = minX; cx <= maxX; cx++) {
    for (let cz = minZ; cz <= maxZ; cz++) {
      const cell = ground.cells.get(cellKey(cx, cz));
      if (!cell) continue;
      for (const id of cell) {
        const item = ground.items.get(id);
        if (!item) continue;
        const dx = item.position[0] - center.x;
        const dy = item.position[1] - center.y;
        const dz = item.position[2] - center.z;
        if (dx * dx + dy * dy + dz * dz <= r2) visit(item);
      }
    }
  }
}

export const INTERACT = {
  /** Max distance from the eye to an item, m. */
  reach: 2.6,
  /** Items inside this view cone are preferred by angle; outside it the nearest reachable item is offered. */
  coneCos: Math.cos((35 * Math.PI) / 180),
} as const;

/** The item an interaction prompt should offer: smallest view angle inside the cone, else the nearest. */
export function pickLootTarget(candidates: readonly LootItem[], eye: Vec3, viewDir: Vec3): LootItem | null {
  let best: LootItem | null = null;
  let bestCos = INTERACT.coneCos;
  let nearest: LootItem | null = null;
  let nearestDistance = Infinity;
  for (const item of candidates) {
    const dx = item.position[0] - eye.x;
    const dy = item.position[1] + 0.1 - eye.y;
    const dz = item.position[2] - eye.z;
    const d = len3(dx, dy, dz);
    if (d > INTERACT.reach) continue;
    const cos = d > 1e-6 ? (dx * viewDir.x + dy * viewDir.y + dz * viewDir.z) / d : 1;
    if (cos > bestCos) {
      bestCos = cos;
      best = item;
    }
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = item;
    }
  }
  return best ?? nearest;
}

function cellCoord(v: number): number {
  return Math.floor(v / GRID_CELL);
}

function cellKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
}

function insert(ground: GroundLoot, item: LootItem): void {
  ground.items.set(item.lootId, item);
  const key = cellKey(cellCoord(item.position[0]), cellCoord(item.position[2]));
  let cell = ground.cells.get(key);
  if (!cell) ground.cells.set(key, (cell = new Set()));
  cell.add(item.lootId);
}

function remove(ground: GroundLoot, item: LootItem): void {
  ground.items.delete(item.lootId);
  ground.cells.get(cellKey(cellCoord(item.position[0]), cellCoord(item.position[2])))?.delete(item.lootId);
}
