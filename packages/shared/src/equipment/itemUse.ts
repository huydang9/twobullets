import { countItem, removeStack, type InventoryState } from "./inventory";
import { consumableDef, type ConsumableItemId } from "./items";
import { TIMER_EPSILON } from "./math";
import { applyConsumable, consumableBlock, type ConsumableBlock, type Vitals } from "./vitals";

export interface ItemUseState {
  /** Consumable being used, or null. */
  readonly itemId: ConsumableItemId | null;
  readonly elapsed: number;
}

export interface ItemUseInput {
  /** Hotkey or inventory click: start using this item. */
  readonly start: ConsumableItemId | null;
  /** Fire, weapon switch, holster, reload, jump or throwable key pressed this tick. */
  readonly interrupt: boolean;
  /** Sprint requested (key held while moving forward). */
  readonly sprint: boolean;
}

export type UseCancelReason = "interrupted" | "sprint" | "notAlive" | "itemGone";
export type UseRejectReason = ConsumableBlock | "notCarried";

export type ItemUseEvent =
  | { readonly type: "useStarted"; readonly itemId: ConsumableItemId; readonly seconds: number }
  | { readonly type: "useCancelled"; readonly itemId: ConsumableItemId; readonly reason: UseCancelReason }
  | { readonly type: "useCompleted"; readonly itemId: ConsumableItemId }
  | { readonly type: "useRejected"; readonly itemId: ConsumableItemId; readonly reason: UseRejectReason };

export interface ItemUseStepResult {
  readonly state: ItemUseState;
  readonly inventory: InventoryState;
  readonly vitals: Vitals;
  readonly events: readonly ItemUseEvent[];
}

export const IDLE_ITEM_USE: ItemUseState = { itemId: null, elapsed: 0 };

/**
 * Consumable use: a timed action that removes one item and applies its effect on completion (health is never
 * granted early, so a cancel race can't heal). Interrupts, sprinting, being downed or losing the item cancel it.
 * Starting a different item replaces the current one.
 */
export function stepItemUse(state: ItemUseState, input: ItemUseInput, inventory: InventoryState, vitals: Vitals, dt: number): ItemUseStepResult {
  const events: ItemUseEvent[] = [];
  let current = state;

  const cancel = (reason: UseCancelReason): void => {
    if (current.itemId === null) return;
    events.push({ type: "useCancelled", itemId: current.itemId, reason });
    current = IDLE_ITEM_USE;
  };

  if (current.itemId !== null) {
    if (vitals.life !== "alive") cancel("notAlive");
    else if (input.interrupt) cancel("interrupted");
    else if (input.sprint) cancel("sprint");
    else if (countItem(inventory, current.itemId) <= 0) cancel("itemGone");
  }

  const start = input.start;
  if (start !== null && start !== current.itemId && !input.interrupt && !input.sprint) {
    const reason: UseRejectReason | null = countItem(inventory, start) <= 0 ? "notCarried" : consumableBlock(vitals, start);
    if (reason !== null) {
      events.push({ type: "useRejected", itemId: start, reason });
    } else {
      cancel("interrupted");
      current = { itemId: start, elapsed: 0 };
      events.push({ type: "useStarted", itemId: start, seconds: consumableDef(start).useSeconds });
      // The start tick counts as the first tick of use, like weapon reloads.
    }
  }

  if (current.itemId === null) return { state: current, inventory, vitals, events };

  const elapsed = current.elapsed + dt;
  const def = consumableDef(current.itemId);
  if (elapsed < def.useSeconds - TIMER_EPSILON) return { state: { itemId: current.itemId, elapsed }, inventory, vitals, events };

  const removed = removeStack(inventory, current.itemId, 1);
  if (!removed.ok) {
    cancel("itemGone");
    return { state: current, inventory, vitals, events };
  }
  events.push({ type: "useCompleted", itemId: current.itemId });
  return { state: IDLE_ITEM_USE, inventory: removed.inventory, vitals: applyConsumable(vitals, current.itemId), events };
}

/** 0..1 progress of the current use, or null when idle. */
export function itemUseProgress(state: ItemUseState): number | null {
  if (state.itemId === null) return null;
  return Math.min(1, state.elapsed / consumableDef(state.itemId).useSeconds);
}
