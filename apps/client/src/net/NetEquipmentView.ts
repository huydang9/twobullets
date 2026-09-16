import { Observable } from "@babylonjs/core";
import { AMMO_COUNT, AMMO_IDS, CONSUMABLE_COUNT, CONSUMABLE_IDS_BY_CODE, consumableCode, consumableIdOfCode } from "@twobullets/protocol/codes";
import { encodePickupArg, NetInventoryOp } from "@twobullets/protocol/messages/loot";
import type { OwnerItemsBlock } from "@twobullets/protocol/messages/snapshot";
import type { ArmorPiece } from "@twobullets/shared/equipment/armor";
import {
  countItem,
  drop,
  inventoryCapacity,
  inventoryWeight,
  pickUp,
  swapWeapons,
  wantsAutoPickup,
  type DropTarget,
  type InventoryStack,
  type InventoryState,
  type ItemInstance,
  type WeaponItemState,
  type WeaponSlot,
} from "@twobullets/shared/equipment/inventory";
import type { UseRejectReason } from "@twobullets/shared/equipment/itemUse";
import { ITEM_IDS, ITEMS, itemCode, type ArmorLevel, type ConsumableItemId } from "@twobullets/shared/equipment/items";
import { INTERACT, pickLootTarget, queryGroundLoot, type GroundLoot, type LootItem } from "@twobullets/shared/equipment/loot";
import { createNetStartingInventory } from "@twobullets/shared/equipment/presets";
import { consumableBlock, VITALS, type Vitals } from "@twobullets/shared/equipment/vitals";
import { PlayerActionType, type PlayerAction } from "@twobullets/shared/input";
import { encodeDropArg } from "@twobullets/shared/match/rules";
import type { Vec3 } from "@twobullets/shared/movement/types";
import type { ThrowRelease } from "@twobullets/shared/equipment/throw";
import type { RaycastFn, WeaponState } from "@twobullets/shared/weapons/types";
import type { EquipmentOptions } from "../equipment/EquipmentSystem";
import type { EquipmentView, ItemEvent, ItemUseView, UseEvent, VitalsViewEvent } from "../equipment/types";
import type { NetOwnerVitals } from "./NetCombat";
import { NetLoot } from "./NetLoot";

/** Stands in for "someone" in `Vitals.reviverId` while the owner block reports revive progress. */
const REMOTE_REVIVER_ID = 1;
/** A sent use the server hasn't shown yet keeps the hands for this long (lost or refused: they free up again), ms. */
export const USE_PENDING_MS = 1000;
/** A sent throw the server hasn't acknowledged holds the local grenade counts for at most this long, ms. */
export const THROW_PENDING_MS = 1000;
/** After a cancel, the server's (older) use state is ignored until it reports idle or this long passed, ms. */
const CANCEL_HOLD_MS = 1000;
/** The boost hotkey takes the first carried of these (EquipmentSystem's USE_ACTIONS). */
const BOOSTS: readonly ConsumableItemId[] = ["energy_drink", "painkiller"];
/** A sent pickup waits this long for the server to take the item (then it may be sent again), ms. */
export const PICKUP_PENDING_MS = 1000;
/** Ticks between nearby-loot refreshes and auto pickup (EquipmentSystem's LOOT_QUERY_TICKS). */
const LOOT_QUERY_TICKS = 6;
/** Items lying within this horizontal radius of the feet (and height band) are auto-picked up (EquipmentSystem). */
const AUTO_PICKUP = { radius: 1.1, below: 0.6, above: 0.4 } as const;
/** Line-of-sight target on a ground item, m above its floor point. */
const ITEM_SIGHT_HEIGHT = 0.15;
/** Largest stack quantity one `drop` action carries (shared `encodeDropArg`: 8 bits, 0 = the whole stack). */
const DROP_ARG_MAX = 255;

/**
 * The local equipment's inventory in networked play, shown until the server's first items group: the networked starting
 * kit (AR-4, P-9, their spare rounds, one frag, one smoke, a level 1 backpack). Heals come from loot; the grenade
 * counts are replaced by the server's as soon as its first owner items group arrives (protocol v9).
 */
export function createNetLocalInventory(): InventoryState {
  return createNetStartingInventory();
}

/**
 * The local `EquipmentSystem`'s options in networked play: the starting kit, no local ground loot, and throwables owned
 * by the server (a release only goes to `onThrowRelease`, which sends it; nothing spawns or detonates locally).
 */
export function netEquipmentOptions(onThrowRelease: (release: ThrowRelease) => void): EquipmentOptions {
  return { loot: [], inventory: createNetLocalInventory(), serverThrowables: true, onThrowRelease };
}

/** What the loot interaction reads each tick (NetGame: the predicted player). */
export interface NetLootTick {
  readonly eye: Vec3;
  readonly viewDir: Vec3;
  readonly feet: Vec3;
  /** Owner alive on the server. */
  readonly alive: boolean;
  /** F pressed since the last tick. */
  readonly interactPressed: boolean;
  /** A downed teammate is in revive reach: F revives instead (no loot prompt). */
  readonly reviveCandidate: boolean;
  /** Static world ray (sight lines to items). */
  readonly raycast: RaycastFn;
}

/**
 * The equipment HUD's and inventory screen's view in networked play: the offline equipment view with the server's owner
 * vitals (health, knocked bleed-out pool and revive progress, boost), armor, inventory and item use swapped in.
 * - Consumables (protocol v6): the local equipment's use attempts (hotkeys and inventory clicks show up as its
 *   `started`/`rejected` use events) become a `use` input action, checked first against the server's vitals and counts;
 *   `usingItem` holds the hands from the send until the server's use ends.
 * - Loot (protocol v7, B5): ground loot is the server's (`NetLoot`, streamed by area of interest); nearby items, the F
 *   prompt target and auto pickup work as offline against it. Pickups, drops and swaps are checked locally with the
 *   shared inventory rules against the server's inventory (failures show at once) and sent as input actions; the server
 *   decides, and `picked`/`dropped` events fire when its loot stream shows the result. Nothing is applied optimistically.
 * - The inventory: weapons and magazines from the predicted weapon state (reconciled against the server's weapon group),
 *   armor from the vitals group, backpack, ammo and consumables from the items group.
 * Objects are rebuilt only when the server values change.
 */
export class NetEquipmentView {
  readonly view: EquipmentView;
  readonly loot: NetLoot;
  private readonly base: EquipmentView;
  private readonly onVitals = new Observable<VitalsViewEvent>();
  private readonly onUse = new Observable<UseEvent>();
  private readonly onItem = new Observable<ItemEvent>();
  private readonly now: () => number;
  private readonly weapons: (() => WeaponState | null) | null;
  private vitals: Vitals;
  private armor: { readonly helmet: ArmorPiece | null; readonly vest: ArmorPiece | null } = { helmet: null, vest: null };
  private inventory: InventoryState | null = null;
  private inventoryBase: InventoryState | null = null;
  /** Server consumable counts by code − 1 (−1 before the first items group: the local counts show). */
  private readonly counts = new Int16Array(CONSUMABLE_COUNT).fill(-1);
  /** Server gear part (v7): backpack level (−1 before the first) and rounds per ammo type. */
  private backpack = -1;
  private readonly ammo = new Int16Array(AMMO_COUNT);
  /** Weapon ids and magazines the cached inventory was built from. */
  private readonly shownWeapons: (WeaponItemState | null)[] = [null, null, null];
  private serverUse: ConsumableItemId | null = null;
  private serverUseTicks = 0;
  private useView: ItemUseView | null = null;
  private pendingItem: ConsumableItemId | null = null;
  private pendingAtMs = 0;
  private cancelAtMs = -Infinity;
  private action: PlayerAction | null = null;
  /** A throw waiting for the next input tick (protocol v9); it jumps the loot queue. */
  private throwAction: PlayerAction | null = null;
  /** Input tick and time of the newest sent throw (−1: none). */
  private throwSentTick = -1;
  private throwSentAtMs = -Infinity;
  /** Loot actions for the next ticks, one per tick after any use/cancel. */
  private readonly actions: PlayerAction[] = [];
  /** Loot id → when its pickup was sent. */
  private readonly pendingPickups = new Map<number, number>();
  private pendingDrops = 0;
  private nearby: readonly LootItem[] = [];
  private target: LootItem | null = null;
  private tickCount = 0;
  private alive = true;
  private readonly sightTo = { x: 0, y: 0, z: 0 };

  constructor(base: EquipmentView, now: () => number = () => performance.now(), weapons: (() => WeaponState | null) | null = null) {
    this.base = base;
    this.now = now;
    this.weapons = weapons;
    this.loot = new NetLoot();
    this.loot.listener = {
      onTaken: (item, remaining) => this.onTaken(item, remaining),
      onOwnDrop: (item) => this.onOwnDrop(item),
    };
    this.vitals = { ...base.vitals, life: "alive", health: VITALS.maxHealth, downedHealth: 0, reviveProgress: 0, reviverId: -1, boost: 0 };
    const overrides: Partial<Record<keyof EquipmentView | "useItem" | "pickUp" | "drop" | "swapPrimaries" | "activeWeaponSlot", () => unknown>> = {
      vitals: () => this.vitals,
      maxHealth: () => VITALS.maxHealth,
      armor: () => this.armor,
      inventory: () => this.currentInventory(),
      capacity: () => this.capacity,
      onVitals: () => this.onVitals,
      onUse: () => this.onUse,
      onItem: () => this.onItem,
      use: () => this.currentUse(),
      useItem: () => this.requestUse,
      pickUp: () => this.pickUp,
      drop: () => this.drop,
      swapPrimaries: () => this.swapPrimaries,
      activeWeaponSlot: () => this.activeWeaponSlot,
      revive: () => null,
      groundLoot: () => this.groundLoot,
      lootTarget: () => this.target,
      nearbyLoot: () => this.nearby,
    };
    this.view = new Proxy(base, {
      get: (target, property, _receiver) => {
        const override = overrides[property as keyof typeof overrides];
        return override ? override() : Reflect.get(target, property, target);
      },
    });
    // The local equipment still reads the use hotkeys and inventory clicks; its own attempt is only the intent.
    base.onUse.add((event) => {
      if (event.type === "started" || event.type === "rejected") this.requestUse(event.itemId);
      else if (event.type === "cancelled" && (event.reason === "interrupted" || event.reason === "sprint")) this.interrupt();
    });
  }

  get groundLoot(): GroundLoot {
    return this.loot.ground;
  }

  get nearbyLoot(): readonly LootItem[] {
    return this.nearby;
  }

  get lootTarget(): LootItem | null {
    return this.target;
  }

  /** Weapon slot in hand by the predicted weapons, or null while unarmed. */
  get activeWeaponSlot(): WeaponSlot | null {
    const state = this.weapons?.() ?? null;
    if (state === null) return null;
    const index = state.activeIndex;
    return (index === 0 || index === 1 || index === 2) && state.slots[index] ? index : null;
  }

  get capacity(): { readonly used: number; readonly max: number } {
    const inventory = this.currentInventory();
    return { used: inventoryWeight(inventory), max: inventoryCapacity(inventory) };
  }

  /** Server vitals changed (NetCombat). */
  setVitals(v: Readonly<NetOwnerVitals>): void {
    this.vitals = {
      ...this.vitals,
      life: v.life,
      health: v.health,
      downedHealth: v.downedHealth,
      boost: v.boost,
      reviveProgress: v.reviveSeconds,
      reviverId: v.reviveSeconds > 0 ? REMOTE_REVIVER_ID : -1,
    };
    const helmet = this.armor.helmet;
    const vest = this.armor.vest;
    if (!samePiece(helmet, v.helmetLevel, v.helmetDurability) || !samePiece(vest, v.vestLevel, v.vestDurability)) {
      this.armor = { helmet: pieceOf(v.helmetLevel, v.helmetDurability), vest: pieceOf(v.vestLevel, v.vestDurability) };
      this.inventory = null;
    }
  }

  /** The newest owner items group (NetClient.ownerItems): counts, gear, use progress and the use events it implies. */
  setItems(items: OwnerItemsBlock): void {
    let countsChanged = false;
    const previousUse = this.serverUse;
    const previousCount = previousUse !== null ? this.counts[consumableCode(previousUse) - 1]! : -1;
    for (let i = 0; i < CONSUMABLE_COUNT; i++) {
      const count = items.counts[i] ?? 0;
      if (this.counts[i] === count) continue;
      this.counts[i] = count;
      countsChanged = true;
    }
    if (items.ammo !== undefined) {
      const backpack = items.backpack ?? 0;
      if (backpack !== this.backpack) {
        this.backpack = backpack;
        countsChanged = true;
      }
      for (let i = 0; i < AMMO_COUNT; i++) {
        const rounds = items.ammo[i] ?? 0;
        if (this.ammo[i] === rounds) continue;
        this.ammo[i] = rounds;
        countsChanged = true;
      }
    }
    if (countsChanged) this.inventory = null;
    const use = consumableIdOfCode(items.useItem);
    this.serverUseTicks = use !== null ? items.useTicks : 0;
    if (use === previousUse) return;
    this.serverUse = use;
    if (previousUse !== null) {
      const used = this.counts[consumableCode(previousUse) - 1]! < previousCount;
      this.onUse.notifyObservers(used ? { type: "completed", itemId: previousUse } : { type: "cancelled", itemId: previousUse, reason: "interrupted" });
    }
    if (use === null) {
      this.cancelAtMs = -Infinity;
      return;
    }
    if (use === this.pendingItem) this.pendingItem = null;
    if (!this.cancelled) this.onUse.notifyObservers({ type: "started", itemId: use, seconds: ITEMS[use].useSeconds });
  }

  /**
   * Hands busy with an item (NetHandsGate): a sent use not yet answered, or the server's use in progress (unless we
   * cancelled it and the server hasn't caught up).
   */
  get usingItem(): boolean {
    if (this.pendingItem !== null && this.now() - this.pendingAtMs >= USE_PENDING_MS) this.pendingItem = null;
    return this.pendingItem !== null || (this.serverUse !== null && !this.cancelled);
  }

  /** Starts a consumable on the server (next tick's input), unless the server's vitals or counts refuse it. */
  readonly requestUse = (requested: ConsumableItemId): void => {
    let itemId = requested;
    if (this.countOf(itemId) <= 0 && BOOSTS.includes(itemId)) itemId = BOOSTS.find((id) => this.countOf(id) > 0) ?? itemId;
    if (itemId === this.pendingItem || (itemId === this.serverUse && !this.cancelled)) return;
    const reason: UseRejectReason | null = this.countOf(itemId) <= 0 ? "notCarried" : consumableBlock(this.vitals, itemId);
    if (reason !== null) {
      this.onUse.notifyObservers({ type: "rejected", itemId, reason });
      return;
    }
    this.action = { type: PlayerActionType.use, arg: itemCode(itemId) };
    this.pendingItem = itemId;
    this.pendingAtMs = this.now();
    this.cancelAtMs = -Infinity;
  };

  /** Fire, reload, a throwable or holster pressed while using: cancel on the server and free the hands now. */
  interrupt(): void {
    if (!this.usingItem) return;
    this.action = { type: PlayerActionType.cancel, arg: 0 };
    this.pendingItem = null;
    this.cancelAtMs = this.now();
  }

  // ---- Loot actions (EquipmentActions) -----------------------------------------------------------------------------

  /**
   * Picks up a ground item on the server. The shared rule runs first on the server's inventory (with the replace slot
   * the server will use: the drag target, else the primary in hand), so a full bag fails at once without a round trip.
   */
  readonly pickUp = (lootId: number, replaceSlot?: WeaponSlot): void => {
    this.requestPickUp(lootId, replaceSlot, false);
  };

  readonly drop = (target: DropTarget): void => {
    const inventory = this.currentInventory();
    const result = drop(inventory, target);
    if (!result.ok) {
      this.onItem.notifyObservers({ type: "dropFailed", target, error: result.error });
      return;
    }
    if (target.kind === "stack") {
      const code = ITEM_IDS.indexOf(target.itemId);
      const carried = countItem(inventory, target.itemId);
      if (target.quantity >= carried) {
        this.queue({ type: PlayerActionType.drop, arg: encodeDropArg({ kind: "stack", code, quantity: 0 }) });
      } else {
        // One action carries at most 255: larger splits go out over several ticks (as several ground stacks).
        for (let left = target.quantity; left > 0; left -= DROP_ARG_MAX) {
          this.queue({ type: PlayerActionType.drop, arg: encodeDropArg({ kind: "stack", code, quantity: Math.min(DROP_ARG_MAX, left) }) });
        }
      }
    } else {
      this.queue({ type: PlayerActionType.drop, arg: encodeDropArg(target.kind === "weapon" ? { kind: "weapon", slot: target.slot } : target.kind === "armor" ? { kind: "armor", slot: target.slot } : { kind: "backpack" }) });
    }
    this.pendingDrops++;
  };

  readonly swapPrimaries = (): void => {
    if (!swapWeapons(this.currentInventory(), 0, 1).ok) return;
    this.queue({ type: PlayerActionType.equipAttach, arg: NetInventoryOp.swapPrimaries });
  };

  /**
   * Every predicted tick (NetGame): nearby items in reach and sight (10 Hz), auto pickup, the F prompt target, and F
   * itself. Dead or downed: nothing to loot.
   */
  tickLoot(t: NetLootTick): void {
    this.tickCount++;
    this.alive = t.alive;
    if (!t.alive) {
      this.nearby = [];
      this.target = null;
      return;
    }
    if (this.tickCount % LOOT_QUERY_TICKS === 0 || t.interactPressed) {
      const eye = t.eye;
      const raycast = t.raycast;
      const to = this.sightTo;
      this.nearby = queryGroundLoot(this.loot.ground, eye, INTERACT.reach).filter((item) => {
        to.x = item.position[0];
        to.y = item.position[1] + ITEM_SIGHT_HEIGHT;
        to.z = item.position[2];
        return raycast(eye, to) === null;
      });
      if (this.tickCount % LOOT_QUERY_TICKS === 0) this.autoPickUp(t.feet);
    }
    this.target = t.reviveCandidate ? null : pickLootTarget(this.nearby, t.eye, t.viewDir);
    if (t.interactPressed && this.target !== null) this.requestPickUp(this.target.lootId, undefined, false);
  }

  /**
   * A throwable left the hand (protocol v9): the server spawns it, flies it and owns the blast. `arg` is the
   * protocol's `encodeThrowArg` (kind, style, the fuse left at release).
   */
  queueThrow(arg: number): void {
    this.throwAction = { type: PlayerActionType.throwItem, arg };
  }

  /**
   * The server's grenade counts may replace the local ones (NetGame → `EquipmentSystem.setThrowableCounts`): no throw
   * waits to be sent, and the server has processed the input carrying the newest one (or it was sent long enough ago).
   * Until then its counts predate the throw and would put the grenade that just left the hand back in the bag.
   */
  throwCountsSettled(lastProcessedInputTick: number): boolean {
    if (this.throwAction !== null) return false;
    return lastProcessedInputTick >= this.throwSentTick || this.now() - this.throwSentAtMs >= THROW_PENDING_MS;
  }

  /** The action for input tick `tick` (once): a throw first, then a use or cancel, then queued loot actions. */
  takeAction(tick = -1): PlayerAction | null {
    const thrown = this.throwAction;
    if (thrown !== null) {
      this.throwAction = null;
      this.throwSentTick = tick;
      this.throwSentAtMs = this.now();
      return thrown;
    }
    const action = this.action;
    if (action !== null) {
      this.action = null;
      return action;
    }
    return this.actions.shift() ?? null;
  }

  // ---- Internals ---------------------------------------------------------------------------------------------------

  private get cancelled(): boolean {
    return this.now() - this.cancelAtMs < CANCEL_HOLD_MS;
  }

  private queue(action: PlayerAction): void {
    this.actions.push(action);
  }

  private requestPickUp(lootId: number, replaceSlot: WeaponSlot | undefined, silent: boolean): boolean {
    const item = this.loot.ground.items.get(lootId);
    if (!item || !this.alive) return false;
    const sentAt = this.pendingPickups.get(lootId);
    if (sentAt !== undefined && this.now() - sentAt < PICKUP_PENDING_MS) return false;
    const instance = toInstance(item);
    const active = this.activeWeaponSlot;
    const result = pickUp(this.currentInventory(), instance, replaceSlot ?? (active === 1 ? 1 : 0));
    if (!result.ok) {
      if (!silent) this.onItem.notifyObservers({ type: "pickupFailed", item: instance, lootId, error: result.error });
      return false;
    }
    this.pendingPickups.set(lootId, this.now());
    this.queue({ type: PlayerActionType.pickup, arg: encodePickupArg(lootId, replaceSlot ?? -1) });
    return true;
  }

  /** PUBG auto pickup (EquipmentSystem.autoPickUp) against the server's loot; the player's own drops stay put. */
  private autoPickUp(feet: Vec3): void {
    if (!(this.base as { autoPickup?: boolean }).autoPickup) return;
    const inventory = this.currentInventory();
    for (const item of this.nearby) {
      const dy = item.position[1] - feet.y;
      if (dy < -AUTO_PICKUP.below || dy > AUTO_PICKUP.above) continue;
      const dx = item.position[0] - feet.x;
      const dz = item.position[2] - feet.z;
      if (dx * dx + dz * dz > AUTO_PICKUP.radius * AUTO_PICKUP.radius) continue;
      if (this.loot.ownDrops.has(item.lootId) || !wantsAutoPickup(inventory, item.itemId)) continue;
      this.requestPickUp(item.lootId, undefined, true);
    }
  }

  private onTaken(item: LootItem, remaining: number): void {
    const sentAt = this.pendingPickups.get(item.lootId);
    if (sentAt === undefined) return;
    this.pendingPickups.delete(item.lootId);
    if (this.now() - sentAt > PICKUP_PENDING_MS * 3) return;
    this.onItem.notifyObservers({ type: "picked", item: toInstance(item), lootId: item.lootId, taken: item.quantity - remaining });
  }

  private onOwnDrop(item: LootItem): void {
    if (this.pendingDrops <= 0) return;
    this.pendingDrops--;
    this.onItem.notifyObservers({ type: "dropped", item });
  }

  private countOf(itemId: ConsumableItemId): number {
    const server = this.counts[consumableCode(itemId) - 1]!;
    return server >= 0 ? server : countItem(this.base.inventory, itemId);
  }

  private currentUse(): ItemUseView | null {
    const itemId = this.serverUse;
    if (itemId === null || this.cancelled) {
      this.useView = null;
      return null;
    }
    const seconds = ITEMS[itemId].useSeconds;
    const progress = Math.min(1, this.serverUseTicks / 60 / seconds);
    const shown = this.useView;
    if (shown === null || shown.itemId !== itemId || shown.progress !== progress) this.useView = { itemId, progress, seconds };
    return this.useView;
  }

  private currentInventory(): InventoryState {
    const base = this.base.inventory;
    const weapons = this.weapons?.() ?? null;
    if (this.inventory !== null && this.inventoryBase === base && !this.weaponsChanged(weapons)) return this.inventory;
    this.inventoryBase = base;
    let stacks = base.stacks;
    if (this.counts[0]! >= 0) {
      const merged: InventoryStack[] = base.stacks.filter((s) => !CONSUMABLE_IDS_BY_CODE.includes(s.itemId as ConsumableItemId) && (this.backpack < 0 || ITEMS[s.itemId].category !== "ammo"));
      for (let i = 0; i < CONSUMABLE_COUNT; i++) if (this.counts[i]! > 0) merged.push({ itemId: CONSUMABLE_IDS_BY_CODE[i + 1]!, quantity: this.counts[i]! });
      if (this.backpack >= 0) for (let i = 0; i < AMMO_COUNT; i++) if (this.ammo[i]! > 0) merged.push({ itemId: AMMO_IDS[i]!, quantity: this.ammo[i]! });
      stacks = merged.sort((a, b) => ITEM_IDS.indexOf(a.itemId) - ITEM_IDS.indexOf(b.itemId));
    }
    let carried = base.weapons;
    if (weapons !== null) {
      const list: (WeaponItemState | null)[] = [null, null, null];
      for (let i = 0; i < 3; i++) {
        const slot = weapons.slots[i] ?? null;
        list[i] = slot ? { weaponId: slot.id, magazine: slot.magazine } : null;
        this.shownWeapons[i] = list[i]!;
      }
      carried = list as unknown as InventoryState["weapons"];
    }
    this.inventory = {
      ...base,
      weapons: carried,
      stacks,
      helmet: this.armor.helmet,
      vest: this.armor.vest,
      backpack: this.backpack >= 0 ? (this.backpack as InventoryState["backpack"]) : base.backpack,
      selectedThrowable: base.selectedThrowable,
    };
    return this.inventory;
  }

  private weaponsChanged(weapons: WeaponState | null): boolean {
    if (weapons === null) return false;
    for (let i = 0; i < 3; i++) {
      const slot = weapons.slots[i] ?? null;
      const shown = this.shownWeapons[i] ?? null;
      if (slot === null ? shown !== null : shown === null || shown.weaponId !== slot.id || shown.magazine !== slot.magazine) return true;
    }
    return false;
  }
}

function pieceOf(level: number, durability: number): ArmorPiece | null {
  return level > 0 ? { level: level as ArmorLevel, durability } : null;
}

function samePiece(piece: ArmorPiece | null, level: number, durability: number): boolean {
  return piece === null ? level === 0 : piece.level === level && piece.durability === durability;
}

function toInstance(item: LootItem): ItemInstance {
  const { itemId, quantity, durability, magazine } = item;
  return { itemId, quantity, ...(durability !== undefined ? { durability } : {}), ...(magazine !== undefined ? { magazine } : {}) };
}
