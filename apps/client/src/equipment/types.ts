import type { Observable } from "@babylonjs/core";
import type {
  ArmorPiece,
  ArmorSlot,
  ConsumableItemId,
  DamageKind,
  DropTarget,
  EquipmentModifiers,
  FirePatch,
  FlashExposure,
  GroundLoot,
  HitZone,
  InventoryError,
  InventoryState,
  ItemInstance,
  LootItem,
  SmokeCloud,
  ThrowableKind,
  ThrowableSnapshot,
  ThrowEvent,
  ThrowState,
  UseCancelReason,
  UseRejectReason,
  Vec3,
  Vitals,
  WeaponSlot,
} from "@twobullets/shared";

// Client contract for equipment presentation, HUD, audio and loot UI (docs/equipment/design.md §9).
// Events fire during the fixed 60 Hz tick, in simulation order. State getters are safe to read every render frame.
// Positions are plain shared Vec3 (world space, meters); copy them into Babylon vectors where needed.

/** A throwable touched the world (not rolling contacts). Drives bounce sounds and dust puffs. */
export interface ThrowableBounceEvent {
  readonly id: number;
  readonly kind: ThrowableKind;
  readonly position: Vec3;
  readonly normal: Vec3;
  /** Speed into the surface, m/s: scale bounce volume by it. */
  readonly impactSpeed: number;
}

export interface DetonationEvent {
  readonly id: number;
  readonly kind: ThrowableKind;
  /** Entity that threw it (LOCAL_PLAYER_ID for the local player). */
  readonly ownerId: number;
  readonly position: Vec3;
  /** Contact normal, or up when it went off in the air. */
  readonly normal: Vec3;
  readonly reason: "fuse" | "impact";
  /** Frag cooked too long and went off in the thrower's hand. */
  readonly inHand: boolean;
}

export type SmokeEvent =
  | { readonly type: "spawned"; readonly cloud: SmokeCloud }
  /** Periodic (4 Hz) snapshot for systems that don't poll `smokes`. Use smokePuffs(cloud) for the volume. */
  | { readonly type: "updated"; readonly cloud: SmokeCloud }
  | { readonly type: "expired"; readonly id: number };

export type FireEvent =
  | { readonly type: "spawned"; readonly patch: FirePatch }
  | { readonly type: "expired"; readonly id: number };

/** The local player was caught by a flashbang. Whiteout and ringing durations are already in `vitals`. */
export interface FlashEvent {
  readonly position: Vec3;
  readonly exposure: FlashExposure;
}

export type ItemEvent =
  | { readonly type: "picked"; readonly item: ItemInstance; readonly lootId: number; readonly taken: number }
  | { readonly type: "pickupFailed"; readonly item: ItemInstance; readonly lootId: number; readonly error: InventoryError }
  /** An item left the inventory onto the ground (drop, or swapped-out gear). */
  | { readonly type: "dropped"; readonly item: LootItem }
  | { readonly type: "dropFailed"; readonly target: DropTarget; readonly error: InventoryError }
  | { readonly type: "throwableSelected"; readonly kind: ThrowableKind | null };

export type UseEvent =
  | { readonly type: "started"; readonly itemId: ConsumableItemId; readonly seconds: number }
  /** Every tick while using. */
  | { readonly type: "progress"; readonly itemId: ConsumableItemId; readonly progress: number }
  | { readonly type: "cancelled"; readonly itemId: ConsumableItemId; readonly reason: UseCancelReason }
  | { readonly type: "completed"; readonly itemId: ConsumableItemId }
  | { readonly type: "rejected"; readonly itemId: ConsumableItemId; readonly reason: UseRejectReason };

export type ArmorEvent =
  | { readonly type: "damaged"; readonly slot: ArmorSlot; readonly level: number; readonly absorbed: number; readonly durability: number; readonly condition: number }
  | { readonly type: "destroyed"; readonly slot: ArmorSlot; readonly level: number };

export type VitalsViewEvent =
  | { readonly type: "damaged"; readonly amount: number; readonly kind: DamageKind; readonly sourceId: number; readonly position: Vec3 }
  | { readonly type: "healed"; readonly amount: number; readonly source: "boost" | "item" | "revive" }
  | { readonly type: "knocked"; readonly byId: number }
  | { readonly type: "reviveStarted"; readonly reviverId: number }
  /** Every tick while being revived; 0..1. */
  | { readonly type: "reviveProgress"; readonly progress: number }
  | { readonly type: "reviveCancelled" }
  | { readonly type: "revived" }
  | { readonly type: "eliminated"; readonly killerId: number; readonly cause: DamageKind | "teamWipe" }
  | { readonly type: "respawned" };

/** Explosion or fire damage dealt to a non-player target (practice soldiers now, bots later). */
export interface AreaDamageEvent {
  readonly targetId: string;
  readonly targetName?: string;
  readonly kind: DamageKind;
  readonly amount: number;
  readonly remainingHealth: number;
  readonly killed: boolean;
  readonly sourceId: number;
  readonly point: Vec3;
}

export interface ThrowArcView {
  /** xyz triples; `count` points are valid. Reused between frames. */
  readonly points: Float32Array;
  readonly count: number;
  readonly end: Vec3;
  /** False when no pin is pulled (hide the arc). */
  readonly visible: boolean;
  /** Surface normal at `end` (landing marker orientation). Optional: presentation probes the world when absent. */
  readonly endNormal?: Vec3;
  /** Throw style the arc was predicted for (aim held = underhand). Optional: presentation infers it when absent. */
  readonly style?: "overhand" | "underhand";
}

export interface ItemUseView {
  readonly itemId: ConsumableItemId;
  /** 0..1. */
  readonly progress: number;
  /** Total use time. */
  readonly seconds: number;
}

/**
 * Read-only view of the local player's equipment for presentation (throwables, smoke, fire), HUD, audio and loot UI.
 * Mirrors CombatView: Observables for things that happen, getters for current state.
 */
export interface EquipmentView {
  // Throwables
  readonly onThrow: Observable<ThrowEvent>;
  readonly onThrowableBounce: Observable<ThrowableBounceEvent>;
  readonly onDetonate: Observable<DetonationEvent>;
  readonly onSmoke: Observable<SmokeEvent>;
  readonly onFire: Observable<FireEvent>;
  readonly onFlash: Observable<FlashEvent>;
  // Items and vitals
  readonly onItem: Observable<ItemEvent>;
  readonly onUse: Observable<UseEvent>;
  readonly onArmor: Observable<ArmorEvent>;
  readonly onVitals: Observable<VitalsViewEvent>;
  readonly onAreaDamage: Observable<AreaDamageEvent>;

  readonly inventory: InventoryState;
  /** Bag weight and capacity, PUBG capacity units. */
  readonly capacity: { readonly used: number; readonly max: number };
  readonly selectedThrowable: ThrowableKind | null;
  readonly throwableCounts: Readonly<Record<ThrowableKind, number>>;
  /** Throw/cook phase of the throwable in hand ("idle" when none). */
  readonly throwState: ThrowState;
  /** 0..1 of a cooked fuse burnt in hand; 0 when not cooking. */
  readonly cookProgress: number;
  /** Seconds left on a cooked fuse, or null. */
  readonly fuseRemaining: number | null;
  /** Predicted trajectory while the pin is pulled (same math as the flight). */
  readonly throwArc: ThrowArcView;
  readonly use: ItemUseView | null;

  readonly vitals: Vitals;
  readonly maxHealth: number;
  readonly armor: { readonly helmet: ArmorPiece | null; readonly vest: ArmorPiece | null };
  /** Movement and weapon gates from equipment state (healing, downed, holding a throwable, boost). */
  readonly modifiers: EquipmentModifiers;

  /** Throwables in flight or on the ground (every owner). */
  readonly throwables: readonly ThrowableSnapshot[];
  readonly smokes: readonly SmokeCloud[];
  readonly fires: readonly FirePatch[];

  /** All ground loot (map loot or arena test piles); render it from `groundLoot.items` and watch `groundLoot.version`. */
  readonly groundLoot: GroundLoot | null;
  /** Ground items within reach, nearest first (refreshed at 10 Hz). */
  readonly nearbyLoot: readonly LootItem[];
  /** Item the interaction prompt offers ("F  Pick up Bandage ×5"), or null. */
  readonly lootTarget: LootItem | null;
  /** Reviving a downed teammate (HUD prompt and ring). Optional until squads or bots exist. */
  readonly revive?: ReviveView | null;
}

/** Commands for the inventory/loot UI; applied on the next tick, results arrive as ItemEvent/UseEvent. */
export interface EquipmentActions {
  pickUp(lootId: number, replaceSlot?: WeaponSlot): void;
  drop(target: DropTarget): void;
  useItem(itemId: ConsumableItemId): void;
  swapPrimaries(): void;
}

/** Entity id of the local player inside the equipment simulation. Practice targets use 1..n. */
export const LOCAL_PLAYER_ID = 0;

/** Damage from outside the equipment world (falls now, bot bullets later), routed through vitals and armor. */
export interface PlayerDamage {
  readonly amount: number;
  readonly kind: DamageKind;
  /** Bullet hit zone (decides helmet/vest); null or omitted for zone-less damage. */
  readonly zone?: HitZone | null;
  /** Attacker entity id, or -1 for the world. */
  readonly sourceId: number;
  /** Where the damage came from, for the directional hurt indicator. */
  readonly position: Vec3;
}

/**
 * Game-side control of the local player's life (Game.ts wiring): outside damage, knock rules, revive and loadout
 * resets. Events still arrive through {@link EquipmentView.onVitals}.
 */
export interface EquipmentPlayerControl {
  damagePlayer(hit: PlayerDamage): void;
  /** Reaching 0 HP knocks instead of eliminating (a teammate is standing). Offline solo: false. */
  canBeKnocked: boolean;
  /** Starts (id) or stops (null) a revive on the downed local player; progresses each tick via stepRevive. */
  setReviver(reviverId: number | null): void;
  /** Fresh kit: inventory (default: the match starting kit), idle throw/use state and full vitals. */
  resetLoadout(inventory?: InventoryState): void;
}

/** The local player's side of a revive: a downed teammate in reach, and progress while F is held on them. */
export interface ReviveView {
  /** Name for "F  Revive <name>", or null when nobody downed is in reach. */
  readonly targetName: string | null;
  /** 0..1 while reviving, else null. */
  readonly progress: number | null;
}

// ---- Items, loot and revive (phase 2) --------------------------------------------------------------------------

/** A downed teammate the local player can revive by holding F (the DEV teammate now, squad bots later). */
export interface ReviveTarget {
  readonly id: number;
  readonly displayName?: string;
  /** Feet position, world space. */
  readonly feet: Vec3;
  readonly vitals: Vitals;
  /** Receives each revive step (progress, cancel, revived). */
  setVitals(vitals: Vitals): void;
}

/** The local player reviving someone else (the local player being revived arrives as VitalsViewEvent). */
export type ReviveActionEvent =
  | { readonly type: "started"; readonly targetId: number }
  /** Every tick while reviving; 0..1. */
  | { readonly type: "progress"; readonly targetId: number; readonly progress: number }
  | { readonly type: "cancelled"; readonly targetId: number }
  | { readonly type: "completed"; readonly targetId: number };

/** Item/loot/revive state and commands beyond the phase 1 contract (inventory screen, loot renderer, interaction). */
export interface EquipmentItemsView extends EquipmentView {
  readonly onReviveAction: Observable<ReviveActionEvent>;
  /** Weapon slot in hand (null while unarmed or before combat is attached): F swaps this primary when both are full. */
  readonly activeWeaponSlot: WeaponSlot | null;
  /** Walking over ammo for a carried weapon, meds or throwables picks them up when they fit (PUBG auto pickup). */
  autoPickup: boolean;
}

export interface EquipmentItemActions extends EquipmentActions {
  /** Arms this throwable kind for key 5 (ignored while a pin is pulled or none are carried). */
  selectThrowable(kind: ThrowableKind): void;
}
