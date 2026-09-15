import type { Vec3Tuple } from "../level/types";
import type { Vec3 } from "../movement/types";
import { getBuildingPrefab, getPrefabLootSpots, isBuildingPrefabId, localToWorld } from "../map/buildings/index";
import type { PointOfInterest } from "../map/types";
import type { ItemInstance } from "./inventory";
import { ITEMS, type ItemCategory, type ItemId } from "./items";
import { createRng, hash32, hashString, len2, len3, pickWeighted } from "./math";

/** Bump when tables or generation change; part of the match content hash (netcode §8.3). */
export const LOOT_TABLE_VERSION = 2;

type Tier = 0 | 1 | 2;
type TierTable<K extends string> = readonly [Readonly<Partial<Record<K, number>>>, Readonly<Partial<Record<K, number>>>, Readonly<Partial<Record<K, number>>>];
type LootCategory = Exclude<ItemCategory, "helmet" | "vest"> | "armor";

export const LOOT = {
  /** Chance that a building loot spot (1.5 m grid) holds a pile, by POI tier. Outdoor rooms (balconies, roofs) get less. */
  spotChance: [0.12, 0.165, 0.22],
  outdoorChanceScale: 0.6,
  /** Buildings outside any POI use tier 0 at this scale. */
  outskirtsChanceScale: 0.8,
  /** Chance of a second item in a pile, and of a third after that. */
  extraItemChance: [0.35, 0.45, 0.55],
  maxItemsPerPile: 3,
  /** Items in a pile sit on a ring of this radius around the spot, m. */
  pileRadius: 0.3,

  category: [
    { weapon: 19, ammo: 14, heal: 20, boost: 8, throwable: 10, armor: 14, backpack: 8, attachment: 0 },
    { weapon: 22, ammo: 14, heal: 18, boost: 9, throwable: 12, armor: 14, backpack: 8, attachment: 0 },
    { weapon: 25, ammo: 13, heal: 16, boost: 10, throwable: 13, armor: 15, backpack: 8, attachment: 0 },
  ] satisfies TierTable<LootCategory>,
  weapon: [
    { weapon_pistol: 30, weapon_shotgun: 34, weapon_rifle: 31, weapon_sniper: 5 },
    { weapon_pistol: 20, weapon_shotgun: 26, weapon_rifle: 42, weapon_sniper: 12 },
    { weapon_pistol: 12, weapon_shotgun: 20, weapon_rifle: 48, weapon_sniper: 20 },
  ] satisfies TierTable<ItemId>,
  /** Military POIs multiply sniper weight. */
  militarySniperScale: 1.5,
  /**
   * A building with at least `minSpots` loot spots that rolled no primary weapon gets one (from the tier's weapon
   * table without pistols) with this chance by tier. It joins one of the building's piles with room, else a new pile.
   */
  guaranteedPrimary: { minSpots: 3, chance: [0.8, 0.85, 0.9] },
  /** A loose ammo roll picks the ammo of a gun already found in the same building with this chance. */
  matchingAmmoChance: 0.6,
  ammo: [
    { ammo_9mm: 35, ammo_12g: 25, ammo_556: 30, ammo_762: 10 },
    { ammo_9mm: 25, ammo_12g: 22, ammo_556: 38, ammo_762: 15 },
    { ammo_9mm: 18, ammo_12g: 18, ammo_556: 44, ammo_762: 20 },
  ] satisfies TierTable<ItemId>,
  heal: [
    { bandage: 60, first_aid: 32, medkit: 8 },
    { bandage: 55, first_aid: 35, medkit: 10 },
    { bandage: 50, first_aid: 36, medkit: 14 },
  ] satisfies TierTable<ItemId>,
  boost: [{ energy_drink: 65, painkiller: 35 }, { energy_drink: 60, painkiller: 40 }, { energy_drink: 55, painkiller: 45 }] satisfies TierTable<ItemId>,
  throwable: [
    { frag: 35, smoke: 25, flash: 22, molotov: 18 },
    { frag: 35, smoke: 25, flash: 22, molotov: 18 },
    { frag: 38, smoke: 24, flash: 20, molotov: 18 },
  ] satisfies TierTable<ItemId>,
  /** Armor and backpack level weights (L1, L2, L3). */
  level: [
    { 1: 70, 2: 26, 3: 4 },
    { 1: 60, 2: 32, 3: 8 },
    { 1: 50, 2: 38, 3: 12 },
  ] satisfies TierTable<"1" | "2" | "3">,
  /** Units per ground item for stackables other than ammo (ammo uses AmmoItemDef.lootQuantity). */
  quantity: { bandage: 5 } as Readonly<Partial<Record<ItemId, number>>>,
  /** A weapon comes with this many stacks of its ammo. */
  weaponAmmoStacks: [2, 3],
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
  readonly buildingId: string;
  readonly roomId: string;
  readonly poi: string | null;
  readonly items: readonly LootItem[];
}

export interface LootLayout {
  readonly seed: number;
  readonly version: number;
  readonly piles: readonly LootPile[];
  readonly items: readonly LootItem[];
}

/**
 * Deterministic ground loot for a match: every building loot spot rolls for a pile with a chance by its POI tier;
 * each pile holds 1–3 rolls drawn from tier tables (weapons bring their ammo). Every spot is seeded from
 * (seed, building id, spot index), so adding or moving one building never reshuffles the others. Buildings that
 * roll nothing get one pile on a seeded spot; most buildings with 3+ spots are topped up with a primary weapon.
 * Pure data; the same result in the browser, the server and tests.
 */
export function generateLoot(seed: number, pois: readonly PointOfInterest[], buildings: readonly LootBuilding[]): LootLayout {
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
    const context: RollContext = { tier, military, gunAmmo: [], hasPrimary: false };

    // Piles are drafted per building first so the primary top-up can join one before item ids are assigned.
    const drafts: { spotIndex: number; items: ItemInstance[] }[] = [];
    spots.forEach((spot, index) => {
      const random = createRng(hash32(buildingSeed, index));
      const chance = LOOT.spotChance[tier] * chanceScale * (outdoorRooms.has(spot.roomId) ? LOOT.outdoorChanceScale : 1);
      if (random() < chance) drafts.push({ spotIndex: index, items: rollPile(random, context) });
    });
    if (drafts.length === 0) {
      const random = createRng(hash32(buildingSeed, 0xffff));
      drafts.push({ spotIndex: Math.floor(random() * spots.length), items: rollPile(random, context) });
    }

    const guarantee = LOOT.guaranteedPrimary;
    const topUp = createRng(hash32(buildingSeed, 0xfffe));
    if (!context.hasPrimary && spots.length >= guarantee.minSpots && topUp() < guarantee.chance[tier]) {
      const weapon = rollWeapon(topUp, context, true);
      const roomy = drafts.filter((d) => d.items.length + weapon.length <= LOOT.maxItemsPerPile + 1);
      if (roomy.length > 0) {
        roomy[Math.floor(topUp() * roomy.length)]!.items.push(...weapon);
      } else {
        const used = new Set(drafts.map((d) => d.spotIndex));
        const free = spots.map((_, i) => i).filter((i) => !used.has(i));
        if (free.length > 0) drafts.push({ spotIndex: free[Math.floor(topUp() * free.length)]!, items: weapon });
      }
    }

    for (const draft of drafts) {
      const spot = spots[draft.spotIndex]!;
      const pileId = piles.length;
      const position = roundTuple(localToWorld(building, spot.position));
      const jitter = createRng(hash32(buildingSeed, draft.spotIndex, 0x6a17));
      const pileItems = draft.items.map((instance, k, all): LootItem => {
        const angle = (k / all.length) * Math.PI * 2 + jitter() * 0.6;
        const r = all.length > 1 ? LOOT.pileRadius : 0;
        const itemPosition = roundTuple([position[0] + Math.sin(angle) * r, position[1], position[2] + Math.cos(angle) * r]);
        return { ...instance, lootId: items.length + k, pileId, position: itemPosition };
      });
      items.push(...pileItems);
      piles.push({ id: pileId, position, buildingId: building.id, roomId: spot.roomId, poi: poi?.id ?? null, items: pileItems });
    }
  }
  return { seed, version: LOOT_TABLE_VERSION, piles, items };
}

interface RollContext {
  readonly tier: Tier;
  readonly military: boolean;
  /** Ammo of the guns rolled so far in this building. */
  readonly gunAmmo: ItemId[];
  hasPrimary: boolean;
}

function rollPile(random: () => number, context: RollContext): ItemInstance[] {
  const { tier } = context;
  const out: ItemInstance[] = [];
  let rolls = 1;
  while (rolls < LOOT.maxItemsPerPile && random() < LOOT.extraItemChance[tier]) rolls++;
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
  if (def.weaponClass === "primary") context.hasPrimary = true;
  if (!context.gunAmmo.includes(def.ammo)) context.gunAmmo.push(def.ammo);
  const [minStacks, maxStacks] = LOOT.weaponAmmoStacks;
  const stacks = minStacks + Math.floor(random() * (maxStacks - minStacks + 1));
  return [{ itemId: id, quantity: 1, magazine: 0 }, { itemId: def.ammo, quantity: ITEMS[def.ammo].lootQuantity * stacks }];
}

function rollCategory(category: LootCategory, random: () => number, context: RollContext): ItemInstance[] {
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
      const id = pickWeighted(LOOT[category][tier], random());
      return [{ itemId: id, quantity: LOOT.quantity[id] ?? 1 }];
    }
    case "armor": {
      const slot = random() < 0.5 ? "helmet" : "vest";
      const level = pickWeighted(LOOT.level[tier], random());
      const id: ItemId = `${slot}_${Number(level) as 1 | 2 | 3}`;
      const def = ITEMS[id];
      return [{ itemId: id, quantity: 1, durability: def.category === slot ? def.durability : 0 }];
    }
    case "backpack": {
      const level = pickWeighted(LOOT.level[tier], random());
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
