import { Observable } from "@babylonjs/core";
import { CONSUMABLE_COUNT, CONSUMABLE_IDS_BY_CODE, consumableCode, consumableIdOfCode } from "@twobullets/protocol/codes";
import type { OwnerItemsBlock } from "@twobullets/protocol/messages/snapshot";
import type { ArmorPiece } from "@twobullets/shared/equipment/armor";
import { countItem, createInventory, type InventoryStack, type InventoryState } from "@twobullets/shared/equipment/inventory";
import type { UseRejectReason } from "@twobullets/shared/equipment/itemUse";
import { ITEM_IDS, ITEMS, itemCode, type ArmorLevel, type ConsumableItemId } from "@twobullets/shared/equipment/items";
import { createOfflineInventory, createStartingInventory } from "@twobullets/shared/equipment/presets";
import { consumableBlock, VITALS, type Vitals } from "@twobullets/shared/equipment/vitals";
import { PlayerActionType, type PlayerAction } from "@twobullets/shared/input";
import type { EquipmentView, ItemUseView, UseEvent, VitalsViewEvent } from "../equipment/types";
import type { NetOwnerVitals } from "./NetCombat";

/** Stands in for "someone" in `Vitals.reviverId` while the owner block reports revive progress. */
const REMOTE_REVIVER_ID = 1;
/** A sent use the server hasn't shown yet keeps the hands for this long (lost or refused: they free up again), ms. */
export const USE_PENDING_MS = 1000;
/** After a cancel, the server's (older) use state is ignored until it reports idle or this long passed, ms. */
const CANCEL_HOLD_MS = 1000;
/** The boost hotkey takes the first carried of these (EquipmentSystem's USE_ACTIONS). */
const BOOSTS: readonly ConsumableItemId[] = ["energy_drink", "painkiller"];

/**
 * The local equipment's inventory in networked play, mirroring what the server gives: the starting kit's AR-4 and P-9
 * (NET_WEAPON_LOADOUT) and the offline kit's heals, boosts and backpack (server `createNetConsumables`). No grenades:
 * the server doesn't simulate throwables yet, so a local throw would hurt nobody and its smoke would hide nothing.
 */
export function createNetLocalInventory(): InventoryState {
  const kit = createOfflineInventory();
  const starting = createStartingInventory({ throwables: false });
  const consumables = kit.stacks.filter((s) => ITEMS[s.itemId].category === "heal" || ITEMS[s.itemId].category === "boost");
  return createInventory({ weapons: starting.weapons, backpack: kit.backpack, stacks: [...starting.stacks, ...consumables] });
}

/**
 * The equipment HUD's view in networked play: the offline equipment view with the server's owner vitals (health,
 * knocked bleed-out pool and revive progress, boost), armor, consumable counts and item use swapped in, and no local
 * loot or reviving prompts. Consumables are server-owned (protocol v6): the local equipment's use attempts (hotkeys and
 * inventory clicks show up as its `started`/`rejected` use events) become a `use` input action, checked first against
 * the server's vitals and counts; `usingItem` holds the hands from the send until the server's use ends; the use ring,
 * the use events the HUD reads and the counts come from the owner items group. Objects are rebuilt only when the server
 * values change.
 */
export class NetEquipmentView {
  readonly view: EquipmentView;
  private readonly base: EquipmentView;
  private readonly onVitals = new Observable<VitalsViewEvent>();
  private readonly onUse = new Observable<UseEvent>();
  private readonly now: () => number;
  private vitals: Vitals;
  private armor: { readonly helmet: ArmorPiece | null; readonly vest: ArmorPiece | null } = { helmet: null, vest: null };
  private inventory: InventoryState | null = null;
  private inventoryBase: InventoryState | null = null;
  /** Server consumable counts by code − 1 (−1 before the first items group: the local counts show). */
  private readonly counts = new Int16Array(CONSUMABLE_COUNT).fill(-1);
  private serverUse: ConsumableItemId | null = null;
  private serverUseTicks = 0;
  private useView: ItemUseView | null = null;
  private pendingItem: ConsumableItemId | null = null;
  private pendingAtMs = 0;
  private cancelAtMs = -Infinity;
  private action: PlayerAction | null = null;

  constructor(base: EquipmentView, now: () => number = () => performance.now()) {
    this.base = base;
    this.now = now;
    this.vitals = { ...base.vitals, life: "alive", health: VITALS.maxHealth, downedHealth: 0, reviveProgress: 0, reviverId: -1, boost: 0 };
    const overrides: Partial<Record<keyof EquipmentView | "useItem", () => unknown>> = {
      vitals: () => this.vitals,
      maxHealth: () => VITALS.maxHealth,
      armor: () => this.armor,
      inventory: () => this.currentInventory(),
      onVitals: () => this.onVitals,
      onUse: () => this.onUse,
      use: () => this.currentUse(),
      useItem: () => this.requestUse,
      revive: () => null,
      lootTarget: () => null,
      nearbyLoot: () => [],
    };
    this.view = new Proxy(base, {
      get: (target, property, _receiver) => {
        const override = overrides[property as keyof EquipmentView];
        return override ? override() : Reflect.get(target, property, target);
      },
    });
    // The local equipment still reads the use hotkeys and inventory clicks; its own attempt is only the intent.
    base.onUse.add((event) => {
      if (event.type === "started" || event.type === "rejected") this.requestUse(event.itemId);
      else if (event.type === "cancelled" && (event.reason === "interrupted" || event.reason === "sprint")) this.interrupt();
    });
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

  /** The newest owner items group (NetClient.ownerItems): counts, use progress and the use events it implies. */
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

  /** The action for the tick being sent (once). */
  takeAction(): PlayerAction | null {
    const action = this.action;
    this.action = null;
    return action;
  }

  private get cancelled(): boolean {
    return this.now() - this.cancelAtMs < CANCEL_HOLD_MS;
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
    if (this.inventory === null || this.inventoryBase !== base) {
      this.inventoryBase = base;
      let stacks = base.stacks;
      if (this.counts[0]! >= 0) {
        const merged: InventoryStack[] = base.stacks.filter((s) => !CONSUMABLE_IDS_BY_CODE.includes(s.itemId as ConsumableItemId));
        for (let i = 0; i < CONSUMABLE_COUNT; i++) if (this.counts[i]! > 0) merged.push({ itemId: CONSUMABLE_IDS_BY_CODE[i + 1]!, quantity: this.counts[i]! });
        stacks = merged.sort((a, b) => ITEM_IDS.indexOf(a.itemId) - ITEM_IDS.indexOf(b.itemId));
      }
      this.inventory = { ...base, stacks, helmet: this.armor.helmet, vest: this.armor.vest };
    }
    return this.inventory;
  }
}

function pieceOf(level: number, durability: number): ArmorPiece | null {
  return level > 0 ? { level: level as ArmorLevel, durability } : null;
}

function samePiece(piece: ArmorPiece | null, level: number, durability: number): boolean {
  return piece === null ? level === 0 : piece.level === level && piece.durability === durability;
}
