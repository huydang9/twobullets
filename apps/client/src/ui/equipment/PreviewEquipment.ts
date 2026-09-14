import { Observable } from "@babylonjs/core";
import {
  ITEMS,
  THROWABLE_KINDS,
  VITALS,
  armorCondition,
  createArmorPiece,
  createInventory,
  createVitals,
  throwableCounts,
  type ArmorPiece,
  type ConsumableItemId,
  type EquipmentModifiers,
  type FirePatch,
  type InventoryState,
  type ItemInstance,
  type LootItem,
  type SmokeCloud,
  type ThrowableKind,
  type ThrowableSnapshot,
  type ThrowEvent,
  type ThrowState,
  type Vitals,
} from "@twobullets/shared";
import type {
  AreaDamageEvent,
  ArmorEvent,
  DetonationEvent,
  EquipmentView,
  FireEvent,
  FlashEvent,
  ItemEvent,
  ItemUseView,
  ReviveView,
  SmokeEvent,
  ThrowableBounceEvent,
  UseEvent,
  VitalsViewEvent,
} from "../../equipment/types";

export type EquipmentPreview = "boost" | "armor" | "knocked" | "revive" | "cook" | "use" | "pickup" | "death";

const IDLE_THROW: ThrowState = { phase: "idle", kind: null, phaseTimer: 0, fuse: 0, fireHeld: false, throwCounter: 0 };
const MODIFIERS: EquipmentModifiers = { speedScale: 1, allowSprint: true, allowJump: true, allowWeapons: true, crawl: false };

/**
 * DEV-only scripted {@link EquipmentView}: plays a short scenario (boost filling, armor breaking, knocked, a cooked
 * frag…) through the same state and events the real EquipmentSystem produces, so the HUD can be previewed offline.
 */
export class PreviewEquipment implements EquipmentView {
  readonly onThrow = new Observable<ThrowEvent>();
  readonly onThrowableBounce = new Observable<ThrowableBounceEvent>();
  readonly onDetonate = new Observable<DetonationEvent>();
  readonly onSmoke = new Observable<SmokeEvent>();
  readonly onFire = new Observable<FireEvent>();
  readonly onFlash = new Observable<FlashEvent>();
  readonly onItem = new Observable<ItemEvent>();
  readonly onUse = new Observable<UseEvent>();
  readonly onArmor = new Observable<ArmorEvent>();
  readonly onVitals = new Observable<VitalsViewEvent>();
  readonly onAreaDamage = new Observable<AreaDamageEvent>();

  inventory: InventoryState = createInventory({
    weapons: [{ weaponId: "rifle", magazine: 30 }, null, { weaponId: "pistol", magazine: 12 }],
    helmet: createArmorPiece("helmet", 2),
    vest: createArmorPiece("vest", 2),
    backpack: 2,
    stacks: [
      { itemId: "frag", quantity: 3 },
      { itemId: "smoke", quantity: 1 },
      { itemId: "bandage", quantity: 5 },
      { itemId: "first_aid", quantity: 1 },
    ],
  });
  readonly capacity = { used: 60, max: 300 };
  readonly maxHealth = VITALS.maxHealth;
  readonly modifiers = MODIFIERS;
  readonly throwArc = { points: new Float32Array(0), count: 0, end: { x: 0, y: 0, z: 0 }, visible: false };
  readonly throwables: readonly ThrowableSnapshot[] = [];
  readonly smokes: readonly SmokeCloud[] = [];
  readonly fires: readonly FirePatch[] = [];
  readonly groundLoot = null;
  readonly nearbyLoot: readonly LootItem[] = [];
  throwState: ThrowState = IDLE_THROW;
  cookProgress = 0;
  fuseRemaining: number | null = null;
  use: ItemUseView | null = null;
  vitals: Vitals = { ...createVitals(), health: 64, boost: 0 };
  lootTarget: LootItem | null = null;
  revive: ReviveView | null = null;

  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private disposed = false;

  get selectedThrowable(): ThrowableKind | null {
    return this.inventory.selectedThrowable;
  }

  get throwableCounts(): Readonly<Record<ThrowableKind, number>> {
    return throwableCounts(this.inventory);
  }

  get armor(): { readonly helmet: ArmorPiece | null; readonly vest: ArmorPiece | null } {
    return { helmet: this.inventory.helmet, vest: this.inventory.vest };
  }

  /** Runs a scenario; `done` is called when it has finished (the caller rebinds the real view). */
  play(kind: EquipmentPreview, done: () => void): void {
    const end = (ms: number) => this.at(ms, () => done());
    switch (kind) {
      case "boost":
        this.animate(2500, (t) => this.setVitals({ boost: 100 * t }));
        for (const ms of [800, 1600, 2400]) this.at(ms, () => this.onVitals.notifyObservers({ type: "healed", amount: 2, source: "boost" }));
        this.at(2700, () => this.cycleThrowable());
        end(4000);
        break;
      case "armor":
        for (const [ms, absorbed] of [[300, 30], [900, 30], [1500, 30]] as const) this.at(ms, () => this.hitArmor("vest", absorbed));
        this.at(2100, () => this.hitArmor("helmet", 50));
        this.at(2700, () => this.hitArmor("vest", 30));
        end(6500);
        break;
      case "knocked":
        this.at(200, () => {
          this.setVitals({ life: "downed", health: 0, downedHealth: VITALS.downedHealth, knockCount: 1 });
          this.onVitals.notifyObservers({ type: "knocked", byId: 1 });
        });
        this.animate(4000, (t) => this.setVitals({ downedHealth: VITALS.downedHealth * (1 - 0.6 * t) }), 200);
        this.at(4600, () => this.setVitals({ life: "alive", health: 64, downedHealth: 0 }));
        end(4800);
        break;
      case "revive":
        this.setVitals({ life: "downed", health: 0, downedHealth: 55, knockCount: 1 });
        this.at(500, () => {
          this.setVitals({ reviverId: 1 });
          this.onVitals.notifyObservers({ type: "reviveStarted", reviverId: 1 });
        });
        this.animate(VITALS.reviveSeconds * 1000, (t) => this.setVitals({ reviveProgress: VITALS.reviveSeconds * t }), 500);
        this.at(500 + VITALS.reviveSeconds * 1000, () => {
          this.setVitals({ life: "alive", health: VITALS.reviveHealth, downedHealth: 0, reviveProgress: 0, reviverId: -1 });
          this.onVitals.notifyObservers({ type: "revived" });
        });
        end(1500 + VITALS.reviveSeconds * 1000);
        break;
      case "cook": {
        const fuse = ITEMS.frag.fuseSeconds;
        this.throwState = { ...IDLE_THROW, phase: "cooking", kind: "frag", fuse };
        this.animate(fuse * 1000, (t) => {
          this.cookProgress = t;
          this.fuseRemaining = fuse * (1 - t);
        });
        this.at(fuse * 1000, () => {
          this.throwState = IDLE_THROW;
          this.cookProgress = 0;
          this.fuseRemaining = null;
        });
        end(fuse * 1000 + 200);
        break;
      }
      case "use":
        this.runUse("bandage", 1);
        this.at(4600, () => this.runUse("first_aid", 0.4));
        end(8000);
        break;
      case "pickup":
        this.lootTarget = { itemId: "weapon_sniper", quantity: 1, magazine: 5, lootId: 1, pileId: 0, position: [0, 0, 0] };
        this.at(900, () => {
          this.pick({ itemId: "ammo_556", quantity: 60 }, 60);
          this.lootTarget = { itemId: "bandage", quantity: 5, lootId: 2, pileId: 0, position: [0, 0, 0] };
        });
        this.at(1300, () => this.pick({ itemId: "ammo_556", quantity: 30 }, 30));
        this.at(1900, () => {
          this.pick({ itemId: "bandage", quantity: 5 }, 5);
          this.lootTarget = { itemId: "vest_3", quantity: 1, durability: 90, lootId: 3, pileId: 0, position: [0, 0, 0] };
        });
        this.at(2700, () => this.pick({ itemId: "weapon_sniper", quantity: 1 }, 1));
        this.at(3400, () => this.onItem.notifyObservers({ type: "pickupFailed", item: { itemId: "medkit", quantity: 1 }, lootId: 4, error: "full" }));
        this.at(4600, () => (this.lootTarget = null));
        end(5000);
        break;
      case "death": {
        const blast = { x: 4, y: 1, z: 6 };
        for (const [ms, amount] of [[100, 34], [250, 22]] as const) {
          this.at(ms, () => {
            this.setVitals({ health: Math.max(0, this.vitals.health - amount) });
            this.onVitals.notifyObservers({ type: "damaged", amount, kind: "explosion", sourceId: 0, position: blast });
          });
        }
        this.at(400, () => {
          this.onVitals.notifyObservers({ type: "damaged", amount: 8, kind: "explosion", sourceId: 0, position: blast });
          this.setVitals({ life: "dead", health: 0 });
          this.onVitals.notifyObservers({ type: "eliminated", killerId: 0, cause: "explosion" });
        });
        this.at(5400, () => {
          this.setVitals({ ...createVitals() });
          this.onVitals.notifyObservers({ type: "respawned" });
        });
        end(5600);
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
  }

  /** Uses an item up to `until` (1 = completes, less = cancelled there). */
  private runUse(itemId: ConsumableItemId, until: number): void {
    const seconds = ITEMS[itemId].useSeconds;
    this.onUse.notifyObservers({ type: "started", itemId, seconds });
    this.animate(seconds * until * 1000, (t) => (this.use = { itemId, progress: t * until, seconds }));
    this.at(seconds * until * 1000, () => {
      this.use = null;
      if (until >= 1) this.onUse.notifyObservers({ type: "completed", itemId });
      else this.onUse.notifyObservers({ type: "cancelled", itemId, reason: "sprint" });
    });
  }

  private hitArmor(slot: "helmet" | "vest", absorbed: number): void {
    const piece = this.inventory[slot];
    if (!piece) return;
    const durability = Math.max(0, piece.durability - absorbed);
    const next = durability > 0 ? { level: piece.level, durability } : null;
    this.inventory = { ...this.inventory, [slot]: next };
    if (next) this.onArmor.notifyObservers({ type: "damaged", slot, level: piece.level, absorbed, durability, condition: armorCondition(slot, next) });
    else this.onArmor.notifyObservers({ type: "destroyed", slot, level: piece.level });
  }

  private pick(item: ItemInstance, taken: number): void {
    this.onItem.notifyObservers({ type: "picked", item, lootId: 0, taken });
  }

  private cycleThrowable(): void {
    const carried = THROWABLE_KINDS.filter((kind) => this.throwableCounts[kind] > 0);
    const next = carried[(carried.indexOf(this.inventory.selectedThrowable ?? carried[0]!) + 1) % carried.length] ?? null;
    this.inventory = { ...this.inventory, selectedThrowable: next };
    this.onItem.notifyObservers({ type: "throwableSelected", kind: next });
  }

  private setVitals(patch: Partial<Vitals>): void {
    this.vitals = { ...this.vitals, ...patch };
  }

  private at(ms: number, action: () => void): void {
    this.timers.push(setTimeout(action, ms));
  }

  /** Calls `step(t)` every frame for `ms`, t from 0 to 1, starting after `delayMs`. */
  private animate(ms: number, step: (t: number) => void, delayMs = 0): void {
    this.at(delayMs, () => {
      const start = performance.now();
      const tick = (): void => {
        const t = Math.min(1, (performance.now() - start) / ms);
        if (this.disposed) return;
        step(t);
        if (t < 1) requestAnimationFrame(tick);
      };
      tick();
    });
  }
}
