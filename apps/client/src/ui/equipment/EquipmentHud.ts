import type { IObserver } from "@babylonjs/core";
import { THROWABLE_KINDS, VITALS, type DamageKind, type InventoryState, type LootItem, type ThrowableKind, type Vec3, type WeaponSlot } from "@twobullets/shared";
import { previewLootAction, type LootActionPreview } from "../../equipment/loot/lootAction";
import {
  LOCAL_PLAYER_ID,
  type AreaDamageEvent,
  type ArmorEvent,
  type EquipmentItemsView,
  type EquipmentView,
  type ItemEvent,
  type ItemUseView,
  type UseEvent,
  type VitalsViewEvent,
} from "../../equipment/types";
import { onLanguageChange, t, type MessageKey } from "../../i18n";
import { el } from "../dom";
import type { HealthPanel } from "../HealthPanel";
import type { WeaponSlots } from "../WeaponSlots";
import { ArmorStatus } from "./ArmorStatus";
import { CookIndicator } from "./CookIndicator";
import { DeathRecap } from "./DeathRecap";
import { InteractionPrompt } from "./InteractionPrompt";
import { areaWeaponName, deathCauseText, inventoryErrorText, itemLabel, itemNameUpper, useCancelText, useRejectText } from "./labels";
import { PickupFeed } from "./PickupFeed";
import { UseIndicator } from "./UseIndicator";

/** Offline respawn delay (mirrors RESPAWN_SECONDS in player/PlayerLife.ts). */
export const OFFLINE_RESPAWN_SECONDS = 5;

const LOOT_VERB_KEY: Readonly<Record<LootActionPreview["verb"], MessageKey>> = {
  "Pick up": "prompt.pickUp",
  Swap: "prompt.swap",
  Equip: "prompt.equip",
};

/** The combat HUD parts the equipment HUD drives or reports into. */
export interface EquipmentHudHost {
  /** Full-screen layer for centre and side elements. */
  readonly layer: HTMLElement;
  /** Bottom dock (weapon slots, health, ammo); armor sits beside the health bar inside it. */
  readonly dock: HTMLElement;
  readonly health: HealthPanel;
  readonly slots: WeaponSlots;
  /** Camera position for death-recap distances, or null. */
  viewerPosition(): Vec3 | null;
  /** Grenade or fire kill of a target: kill feed, kill notice and hit marker. */
  showAreaKill(event: AreaDamageEvent, weaponName: string): void;
}

interface LifeStats {
  damage: number;
  hits: number;
  lastKind: DamageKind | null;
  lastPosition: Vec3 | null;
}

/**
 * Equipment-driven HUD: boost and knocked state on the health bar, armor, throwable slot, cook and use rings,
 * interaction prompt, pickup feed and death recap. DOM is built once; `update` writes only what changed, and events
 * (pickups, refusals, armor hits, elimination) arrive through the {@link EquipmentView} observables.
 */
export class EquipmentHud {
  private readonly armor: ArmorStatus;
  private readonly cook: CookIndicator;
  private readonly use: UseIndicator;
  private readonly prompt: InteractionPrompt;
  private readonly pickups: PickupFeed;
  private readonly death: DeathRecap;
  private view: EquipmentView | null = null;
  private observers: IObserver[] = [];
  private readonly life: LifeStats = { damage: 0, hits: 0, lastKind: null, lastPosition: null };
  private shownInventory: InventoryState | null = null;
  private shownTarget: LootItem | null | undefined;
  private shownSlot: WeaponSlot | null = null;
  private readonly unsubscribeLanguage: () => void;

  constructor(private readonly host: EquipmentHudHost) {
    const centre = el("div", "tb-equip", undefined, host.layer);
    this.cook = new CookIndicator(centre);
    this.use = new UseIndicator(centre);
    this.prompt = new InteractionPrompt(centre);
    this.pickups = new PickupFeed(host.layer);
    this.death = new DeathRecap(host.layer);
    this.armor = new ArmorStatus(host.dock);
    this.unsubscribeLanguage = onLanguageChange(() => {
      this.shownInventory = null;
      this.shownTarget = undefined;
    });
  }

  /** True while a throwable is drawn (no weapon slot is active). */
  get throwableInHand(): boolean {
    return this.view !== null && this.view.throwState.phase !== "idle";
  }

  get bound(): boolean {
    return this.view !== null;
  }

  /** Switches the source (the real view, a DEV preview, or null to hide everything equipment-related). */
  bind(view: EquipmentView | null): void {
    for (const observer of this.observers) observer.remove();
    this.observers = [];
    this.view = view;
    this.shownInventory = null;
    this.shownTarget = undefined;
    this.resetLife();
    this.death.hide();
    this.host.health.boostVisible = view !== null;
    this.host.health.setDowned(false);
    if (!view) {
      this.armor.update(null, null, 0);
      this.cook.update(null, 0);
      this.use.update(null, "", 0);
      this.prompt.update(null);
      this.host.slots.setThrowable(null, 0, 0);
      return;
    }
    this.observers = [
      view.onItem.add(this.handleItem),
      view.onUse.add(this.handleUse),
      view.onArmor.add(this.handleArmor),
      view.onVitals.add(this.handleVitals),
      view.onAreaDamage.add(this.handleAreaDamage),
    ];
  }

  /**
   * Per frame while the combat layer is visible.
   * @param healthOverride DEV preview health (Hud.debugPreview "hurt"/"lowhealth").
   */
  update(now: number, healthOverride: number | null): void {
    const view = this.view;
    if (!view) return;
    const vitals = view.vitals;
    const downed = vitals.life === "downed";
    const health = this.host.health;
    health.setDowned(downed);
    if (downed) health.update(Math.ceil(vitals.downedHealth), VITALS.downedHealth);
    else health.update(healthOverride ?? vitals.health, view.maxHealth);
    health.setBoost(vitals.boost);

    const inventory = view.inventory;
    this.armor.update(inventory.helmet, inventory.vest, now);
    if (inventory !== this.shownInventory) {
      this.shownInventory = inventory;
      this.shownTarget = undefined;
      this.syncThrowable(inventory.selectedThrowable, view.throwableCounts);
    }

    this.cook.update(view.fuseRemaining, view.cookProgress);
    const use = view.use;
    this.updateProgress(view, use, downed);
    this.updatePrompt(view, use !== null);
    this.death.update(now);
  }

  dispose(): void {
    this.unsubscribeLanguage();
    this.bind(null);
  }

  private updateProgress(view: EquipmentView, use: ItemUseView | null, downed: boolean): void {
    if (use) {
      this.use.update(use.progress, itemNameUpper(use.itemId), use.seconds * (1 - use.progress));
      return;
    }
    const vitals = view.vitals;
    if (downed && vitals.reviverId >= 0) {
      const progress = vitals.reviveProgress / VITALS.reviveSeconds;
      this.use.update(progress, t("use.beingRevived"), VITALS.reviveSeconds - vitals.reviveProgress, "revive");
      return;
    }
    const revive = view.revive;
    if (revive && revive.progress !== null) {
      this.use.update(revive.progress, t("use.reviving"), VITALS.reviveSeconds * (1 - revive.progress), "revive");
      return;
    }
    this.use.update(null, "", 0);
  }

  private updatePrompt(view: EquipmentView, using: boolean): void {
    const phase = view.throwState.phase;
    if (view.vitals.life !== "alive" || using || phase === "primed" || phase === "cooking") {
      this.shownTarget = undefined;
      this.prompt.update(null);
      return;
    }
    const revive = view.revive;
    if (revive?.targetName) {
      this.shownTarget = undefined;
      this.prompt.update(revive.progress === null ? t("prompt.revive") : null, revive.targetName);
      return;
    }
    const target = view.lootTarget;
    const slot = activeWeaponSlot(view);
    if (target === this.shownTarget && slot === this.shownSlot) return;
    this.shownTarget = target;
    this.shownSlot = slot;
    if (!target) {
      this.prompt.update(null);
      return;
    }
    // Same inventory rule and replace slot as the pickup itself.
    const action = previewLootAction(view.inventory, target, slot);
    const name = action.replaces ? `${itemLabel(action.replaces)} → ${itemLabel(target)}` : itemLabel(target);
    this.prompt.update(t(LOOT_VERB_KEY[action.verb]), name, action.blocked !== null);
  }

  private syncThrowable(selected: ThrowableKind | null, counts: Readonly<Record<ThrowableKind, number>>): void {
    let kinds = 0;
    for (const kind of THROWABLE_KINDS) if (counts[kind] > 0) kinds++;
    this.host.slots.setThrowable(selected, selected ? counts[selected] : 0, kinds);
  }

  private resetLife(): void {
    this.life.damage = 0;
    this.life.hits = 0;
    this.life.lastKind = null;
    this.life.lastPosition = null;
  }

  private readonly handleItem = (event: ItemEvent): void => {
    switch (event.type) {
      case "picked":
        this.pickups.push(event.item, event.taken, performance.now());
        break;
      case "pickupFailed":
      case "dropFailed":
        this.prompt.refuse(inventoryErrorText(event.error));
        break;
      case "throwableSelected":
        if (event.kind) this.host.slots.cycled();
        break;
      case "dropped":
        break;
    }
  };

  private readonly handleUse = (event: UseEvent): void => {
    if (event.type === "cancelled") this.use.flash(useCancelText(event.reason));
    else if (event.type === "rejected") this.prompt.refuse(useRejectText(event.reason));
  };

  private readonly handleArmor = (event: ArmorEvent): void => {
    if (event.type === "damaged") this.armor.damaged(event.slot);
    else this.armor.destroyed(event.slot, event.level, performance.now());
  };

  private readonly handleVitals = (event: VitalsViewEvent): void => {
    switch (event.type) {
      case "damaged":
        this.life.damage += event.amount;
        this.life.hits++;
        this.life.lastKind = event.kind;
        this.life.lastPosition = event.position;
        break;
      case "healed":
        if (event.source === "boost") this.host.health.pulseBoost();
        break;
      case "eliminated":
        this.showDeath(event.killerId, event.cause);
        break;
      case "respawned":
        this.death.hide();
        this.resetLife();
        break;
      case "knocked":
      case "reviveStarted":
      case "reviveProgress":
      case "reviveCancelled":
      case "revived":
        // The health bar and ring follow `vitals` each frame.
        break;
    }
  };

  private readonly handleAreaDamage = (event: AreaDamageEvent): void => {
    const weapon = areaWeaponName(event.kind);
    if (event.killed && event.sourceId === LOCAL_PLAYER_ID && weapon) this.host.showAreaKill(event, weapon);
  };

  private showDeath(killerId: number, cause: DamageKind | "teamWipe"): void {
    const { lastKind, lastPosition } = this.life;
    const viewer = this.host.viewerPosition();
    const weapon = lastKind && cause !== "bleed" && cause !== "fall" ? areaWeaponName(lastKind) : null;
    const distance = lastPosition && viewer && (lastKind === "explosion" || lastKind === "bullet") ? Math.hypot(lastPosition.x - viewer.x, lastPosition.y - viewer.y, lastPosition.z - viewer.z) : null;
    this.death.show({
      cause: deathCauseText(cause),
      killer: killerId === LOCAL_PLAYER_ID ? t("recap.yourself") : killerId > 0 ? t("recap.soldier", { id: killerId }) : null,
      weapon,
      distance,
      damageTaken: this.life.damage,
      hits: this.life.hits,
      respawnAt: performance.now() + OFFLINE_RESPAWN_SECONDS * 1000,
    });
  }
}

/** Weapon slot in hand, when the view is the full items view (F swaps that primary). */
function activeWeaponSlot(view: EquipmentView): WeaponSlot | null {
  return (view as Partial<EquipmentItemsView>).activeWeaponSlot ?? null;
}
