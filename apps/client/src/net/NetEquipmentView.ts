import { Observable } from "@babylonjs/core";
import type { ArmorPiece } from "@twobullets/shared/equipment/armor";
import type { ArmorLevel } from "@twobullets/shared/equipment/items";
import type { InventoryState } from "@twobullets/shared/equipment/inventory";
import { VITALS, type Vitals } from "@twobullets/shared/equipment/vitals";
import type { EquipmentView, VitalsViewEvent } from "../equipment/types";
import type { NetOwnerVitals } from "./NetCombat";

/** Stands in for "someone" in `Vitals.reviverId` while the owner block reports revive progress. */
const REMOTE_REVIVER_ID = 1;

/**
 * The equipment HUD's view in networked play: the offline equipment view with the server's owner vitals (health,
 * knocked bleed-out pool and revive progress, boost) and armor swapped in, and no local loot, item-use or reviving
 * prompts (M4 doesn't network equipment). The HUD keeps reading it exactly as offline, so the health bar, KNOCKED state,
 * BEING REVIVED ring and armor icons come from the server. Objects are rebuilt only when the server values change.
 */
export class NetEquipmentView {
  readonly view: EquipmentView;
  private readonly base: EquipmentView;
  private readonly onVitals = new Observable<VitalsViewEvent>();
  private vitals: Vitals;
  private armor: { readonly helmet: ArmorPiece | null; readonly vest: ArmorPiece | null } = { helmet: null, vest: null };
  private inventory: InventoryState | null = null;
  private inventoryBase: InventoryState | null = null;

  constructor(base: EquipmentView) {
    this.base = base;
    this.vitals = { ...base.vitals, life: "alive", health: VITALS.maxHealth, downedHealth: 0, reviveProgress: 0, reviverId: -1, boost: 0 };
    const overrides: Partial<Record<keyof EquipmentView, () => unknown>> = {
      vitals: () => this.vitals,
      maxHealth: () => VITALS.maxHealth,
      armor: () => this.armor,
      inventory: () => this.currentInventory(),
      onVitals: () => this.onVitals,
      use: () => null,
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

  private currentInventory(): InventoryState {
    const base = this.base.inventory;
    if (this.inventory === null || this.inventoryBase !== base) {
      this.inventoryBase = base;
      this.inventory = { ...base, helmet: this.armor.helmet, vest: this.armor.vest };
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
