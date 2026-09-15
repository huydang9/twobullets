import { createInventory, type InventoryState } from "@twobullets/shared/equipment/inventory";
import { IDLE_ITEM_USE, stepItemUse } from "@twobullets/shared/equipment/itemUse";
import { ITEM_IDS, ITEMS, type ConsumableItemId } from "@twobullets/shared/equipment/items";
import { createOfflineInventory } from "@twobullets/shared/equipment/presets";
import { stepVitals } from "@twobullets/shared/equipment/vitals";
import { Btn, PlayerActionType, type PlayerInput } from "@twobullets/shared/input";
import type { Player } from "./Player";

// Server consumables (plan.md B5, minimal slice): humans carry the offline kit's heals and boosts; the `use` input action
// (arg = u8 `itemCode`) starts the shared timed use, and the same interrupts as offline cancel it: the `cancel` action
// (fire, reload, throwable or holster pressed while the client's hands gate clears the wire buttons), a weapon select,
// fire/reload/jump pressed on the wire, or sprinting forward on the ground. Completion applies the effect to the server's
// vitals; boost decays and heals over time here too. The owner items group replicates use progress and counts.

export interface ServerItemStats {
  started: number;
  completed: number;
  cancelled: number;
  rejected: number;
}

const CONSUMABLE_KIT: ReadonlySet<string> = new Set<ConsumableItemId>(["bandage", "first_aid", "medkit", "energy_drink", "painkiller"]);
const PRESS_INTERRUPTS = Btn.fire | Btn.reload | Btn.jump;

/** The offline kit's consumables (the rest of the kit isn't networked yet), with its backpack for capacity. */
export function createNetConsumables(): InventoryState {
  const kit = createOfflineInventory();
  return createInventory({ backpack: kit.backpack, stacks: kit.stacks.filter((s) => CONSUMABLE_KIT.has(s.itemId)) });
}

/** A consumable's item id from the `use` action's u8 `itemCode` (MatchSim's table), or null. */
export function consumableOfItemCode(code: number): ConsumableItemId | null {
  const id = ITEM_IDS[code];
  if (!id) return null;
  const category = ITEMS[id].category;
  return category === "heal" || category === "boost" ? (id as ConsumableItemId) : null;
}

export class ServerItems {
  readonly stats: ServerItemStats = { started: 0, completed: 0, cancelled: 0, rejected: 0 };
  private readonly dt: number;

  constructor(dt: number) {
    this.dt = dt;
  }

  /** After the player's movement/weapon step, for players that stepped (not dead, not frozen). */
  step(p: Player, input: PlayerInput): void {
    const pressed = input.buttons & ~p.itemButtons;
    p.itemButtons = input.buttons;
    if (p.life === "alive" && p.vitals.boost > 0) p.vitals = stepVitals(p.vitals, this.dt).vitals;
    const action = input.action;
    const start = action !== null && action.type === PlayerActionType.use ? consumableOfItemCode(action.arg) : null;
    if (start === null && p.use.itemId === null) return;
    const interrupt = (action !== null && action.type === PlayerActionType.cancel) || input.select !== 0 || (pressed & PRESS_INTERRUPTS) !== 0;
    const sprint = (input.buttons & Btn.sprint) !== 0 && input.forward > 0 && p.state.move.grounded;
    const result = stepItemUse(p.use, { start, interrupt, sprint }, p.inventory, p.vitals, this.dt);
    p.use = result.state;
    p.inventory = result.inventory;
    p.vitals = result.vitals;
    const events = result.events;
    for (let i = 0; i < events.length; i++) {
      const type = events[i]!.type;
      if (type === "useStarted") this.stats.started++;
      else if (type === "useCompleted") this.stats.completed++;
      else if (type === "useCancelled") this.stats.cancelled++;
      else this.stats.rejected++;
    }
  }

  /** Dead or frozen: no use carries over. */
  stop(p: Player): void {
    if (p.use.itemId === null) return;
    p.use = IDLE_ITEM_USE;
    this.stats.cancelled++;
  }
}
