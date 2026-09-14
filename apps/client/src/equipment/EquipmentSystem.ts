import { Observable, PhysicsRaycastResult, Vector3, type HavokPlugin, type IRaycastQuery, type Observer, type PhysicsBody, type Scene } from "@babylonjs/core";
import {
  ARENA_LEVEL,
  INTERACT,
  ITEMS,
  SIMULATION,
  VITALS,
  applyDamage,
  armorCondition,
  armorLoadout,
  countItem,
  createEquipmentWorld,
  createGroundLoot,
  createOfflineInventory,
  createInventory,
  createPlayerEquipment,
  createTestLoot,
  cookProgress,
  deriveEquipmentModifiers,
  drop,
  dropGroundItem,
  eyeHeightFor,
  generateLoot,
  inventoryCapacity,
  inventoryWeight,
  itemUseProgress,
  len2,
  len3,
  pickLootTarget,
  pickUp,
  predictThrowArc,
  queryGroundLoot,
  resolveThrowOrigin,
  setGroundQuantity,
  snapshotThrowables,
  spawnRelease,
  stepEquipmentWorld,
  stepPlayerEquipment,
  stepRevive,
  swapWeapons,
  throwableCounts,
  throwLaunch,
  wantsAutoPickup,
  withArmor,
  type ConsumableItemId,
  type DamageOutcome,
  type DamageRequest,
  type DropTarget,
  type EquipmentInput,
  type EquipmentModifiers,
  type EquipmentWorld,
  type EquipmentWorldEvent,
  type FlashExposure,
  type GroundLoot,
  type InventoryState,
  type ItemInstance,
  type LootBuilding,
  type LootItem,
  type MoveState,
  type PlayerEquipmentEvent,
  type PlayerEquipmentState,
  type PointOfInterest,
  type RayHit,
  type RaycastFn,
  type ThrowEvent,
  type ThrowRelease,
  type ThrowableKind,
  type ThrowableSnapshot,
  type Vec3,
  type Vec3Tuple,
  type Vitals,
  type VitalsHit,
  type WeaponSlot,
  type WorldEntity,
} from "@twobullets/shared";
import { CollisionLayer, type Damageable } from "../combat/hitboxes";
import type { TargetArmor } from "../combat/TargetArmor";
import type { CombatEquipmentLink } from "../combat/types";
import type { Action } from "../input/bindings";
import type { PlayerModifiers, PlayerTick } from "../player/PlayerController";
import {
  LOCAL_PLAYER_ID,
  type AreaDamageEvent,
  type ArmorEvent,
  type DetonationEvent,
  type EquipmentItemActions,
  type EquipmentItemsView,
  type EquipmentPlayerControl,
  type FireEvent,
  type FlashEvent,
  type ItemEvent,
  type ItemUseView,
  type PlayerDamage,
  type ReviveActionEvent,
  type ReviveTarget,
  type ReviveView,
  type SmokeEvent,
  type ThrowableBounceEvent,
  type ThrowArcView,
  type UseEvent,
  type VitalsViewEvent,
} from "./types";

/** The parts of PlayerController equipment needs, so headless checks can drive it with a stand-in. */
export interface EquipmentPlayer {
  readonly onTick: Observable<PlayerTick>;
  readonly moveState: MoveState;
  readonly physicsBody?: PhysicsBody;
  /** Unused: gates reach movement through `modifiers` at tick time (PlayerController.setMoveGates). */
  readonly modifiers?: PlayerModifiers;
  getEyeToRef(result: Vector3): Vector3;
  getAim(): { readonly yaw: number; readonly pitch: number };
}

/** The parts of InputManager equipment reads. */
export interface EquipmentInputSource {
  readonly isLocked: boolean;
  isActionDown(action: Action): boolean;
  wasActionPressed(action: Action): boolean;
  wheelDelta(): number;
}

/**
 * A non-player damageable that grenades and fire can reach (practice soldiers, offline match bots). Its equipment
 * entity id is its index in `targets()` + 1, so match bots list every slot 1..n in slot order (index = slot − 1).
 */
export interface EquipmentTarget extends Damageable {
  /** Feet position, world space. */
  readonly feet: Vec3;
  /** Team for area effects (default: its own team, index + 1). */
  readonly team?: number;
  /** Posture for blast exposure (default stand). */
  readonly posture?: WorldEntity["posture"];
  /** Eye position and view direction for flashbang exposure (default: standing eye height, facing +Z). */
  readonly eye?: Vec3;
  readonly viewDir?: Vec3;
  /** Flashbang exposure on this target (bots go blind and deaf). */
  applyFlash?(exposure: FlashExposure): void;
}

export interface EquipmentOptions {
  /** Match seed for loot and effect shapes. */
  readonly seed?: number;
  /** Map mode: spawns ground loot in these buildings. */
  readonly map?: { readonly pois: readonly PointOfInterest[]; readonly buildings: readonly LootBuilding[] };
  /** Ground loot outside map mode. Default: a test pile in front of every arena spawn; `[]` for none. */
  readonly loot?: readonly LootItem[];
  /** Called every tick for the current targets. */
  readonly targets?: () => readonly EquipmentTarget[];
  /** Teammates the local player can revive (DEV teammate, squad bots later). */
  readonly teammates?: () => readonly ReviveTarget[];
  readonly inventory?: InventoryState;
}

const TICK_SECONDS = 1 / SIMULATION.tickRate;
/** Offline match seed until the match phase provides one. */
const DEFAULT_SEED = 0x2b0b;
const ARC_POINTS = 96;
/** Ticks between nearby-loot refreshes (10 Hz). */
const LOOT_QUERY_TICKS = 6;
const SMOKE_UPDATE_TICKS = 15;
/** Equipment rays see static world only: not hitbox triggers, player blockers or character capsules. */
const WORLD_COLLIDE_MASK = ~(CollisionLayer.hitbox | CollisionLayer.blocker | CollisionLayer.player);
/** The client allows this much past INTERACT.reach for latency and eye jitter; the server re-checks. */
const PICKUP_SLACK = 0.4;
/** Items lying within this horizontal radius of the feet (and height band) are auto-picked up. */
const AUTO_PICKUP = { radius: 1.1, below: 0.6, above: 0.4 } as const;
/** Line-of-sight target on a ground item: this far above the floor point, m. */
const ITEM_SIGHT_HEIGHT = 0.15;
/** Drops land this far in front of the feet (when nothing is in the way), spread on a small ring. */
const DROP = { forward: 0.55, spread: 0.25 } as const;
/** Height band (above/below the feet) a downed teammate must be in for a revive. */
const REVIVE_HEIGHT = 1.2;

/**
 * Local player's equipment: ticks the shared equipment rules in lockstep with movement (like CombatSystem), flies
 * throwables against Havok, resolves grenades and fire against the player and practice soldiers, owns ground loot
 * (map loot or arena test piles) and its interaction (F pickup, auto pickup, hold-F revive), and holds the inventory
 * whose weapons and ammo CombatSystem mirrors. Presentation, HUD and audio subscribe through {@link EquipmentItemsView};
 * the inventory UI sends {@link EquipmentItemActions}; Game drives life events through {@link EquipmentPlayerControl}.
 * Runs headless: nothing here draws.
 *
 * Tick order: CombatSystem (reads the inventory and gates, writes magazines and spent ammo back) → EquipmentSystem.
 */
export class EquipmentSystem implements EquipmentItemsView, EquipmentItemActions, EquipmentPlayerControl, CombatEquipmentLink {
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
  readonly onReviveAction = new Observable<ReviveActionEvent>();

  readonly maxHealth = VITALS.maxHealth;
  readonly groundLoot: GroundLoot;
  nearbyLoot: readonly LootItem[] = [];
  lootTarget: LootItem | null = null;
  throwables: readonly ThrowableSnapshot[] = [];
  /** Reaching 0 HP knocks instead of eliminating (a teammate is standing). Offline solo: false. */
  canBeKnocked = false;
  autoPickup = true;
  activeWeaponSlot: WeaponSlot | null = null;
  loadoutVersion = 0;

  private state: PlayerEquipmentState;
  private readonly world: EquipmentWorld;
  private readonly raycaster: WorldRaycaster;
  private readonly inputQueue: EquipmentInputQueue;
  private readonly tickObserver: Observer<PlayerTick>;
  private readonly arc = { points: new Float32Array(ARC_POINTS * 3), count: 0, end: { x: 0, y: 0, z: 0 } as Vec3, visible: false };
  private readonly pendingActions: ((tick: TickContext) => void)[] = [];
  private readonly inHandThrows = new Set<number>();
  /** Items the player put down: auto pickup leaves them alone. */
  private readonly playerDropped = new Set<number>();
  private readonly eye = new Vector3();
  private readonly worldEvents: EquipmentWorldEvent[] = [];
  private tickCount = 0;
  /** Entity reviving the local player (Game/DEV), or null. */
  private reviverId: number | null = null;
  /** Teammate the local player is reviving, and one in reach for the prompt. */
  private revivingTarget: ReviveTarget | null = null;
  private reviveCandidate: ReviveTarget | null = null;
  /** Replace the constructor's `targets`/`teammates` options (offline match wiring after construction). */
  private targetsSource: (() => readonly EquipmentTarget[]) | null = null;
  private teammatesSource: (() => readonly ReviveTarget[]) | null = null;

  constructor(
    scene: Scene,
    input: EquipmentInputSource,
    private readonly player: EquipmentPlayer,
    private readonly options: EquipmentOptions = {},
  ) {
    const seed = options.seed ?? DEFAULT_SEED;
    this.state = createPlayerEquipment(options.inventory ?? createOfflineInventory());
    this.world = createEquipmentWorld(seed);
    this.raycaster = new WorldRaycaster(scene);
    this.inputQueue = new EquipmentInputQueue(input);
    const loot = options.map ? generateLoot(seed, options.map.pois, options.map.buildings).items : (options.loot ?? createTestLoot(ARENA_LEVEL.spawnPoints));
    this.groundLoot = createGroundLoot(loot);
    this.tickObserver = player.onTick.add((tick) => this.tick(tick));
  }

  // ---- EquipmentView state ----------------------------------------------------------------------------------------

  get inventory(): InventoryState {
    return this.state.inventory;
  }

  get capacity(): { readonly used: number; readonly max: number } {
    return { used: inventoryWeight(this.state.inventory), max: inventoryCapacity(this.state.inventory) };
  }

  get selectedThrowable(): ThrowableKind | null {
    return this.state.inventory.selectedThrowable;
  }

  get throwableCounts(): Readonly<Record<ThrowableKind, number>> {
    return throwableCounts(this.state.inventory);
  }

  get throwState() {
    return this.state.throw;
  }

  get cookProgress(): number {
    return cookProgress(this.state.throw);
  }

  get fuseRemaining(): number | null {
    return this.state.throw.phase === "cooking" ? this.state.throw.fuse : null;
  }

  get throwArc(): ThrowArcView {
    return this.arc;
  }

  get use(): ItemUseView | null {
    const { itemId } = this.state.use;
    if (itemId === null) return null;
    return { itemId, progress: itemUseProgress(this.state.use) ?? 0, seconds: ITEMS[itemId].useSeconds };
  }

  get vitals() {
    return this.state.vitals;
  }

  get armor() {
    return armorLoadout(this.state.inventory);
  }

  /** Gates for movement (read at tick time by the player) and weapons (read by CombatSystem). Reviving roots the player. */
  get modifiers(): EquipmentModifiers {
    const gates = deriveEquipmentModifiers(this.state);
    return this.revivingTarget ? { ...gates, speedScale: 0, allowSprint: false, allowJump: false, allowWeapons: false } : gates;
  }

  get revive(): ReviveView | null {
    const target = this.revivingTarget ?? this.reviveCandidate;
    if (!target) return null;
    return {
      targetName: target.displayName ?? "Teammate",
      progress: this.revivingTarget ? Math.min(1, this.revivingTarget.vitals.reviveProgress / VITALS.reviveSeconds) : null,
    };
  }

  get smokes() {
    return this.world.smokes;
  }

  get fires() {
    return this.world.fires;
  }

  // ---- EquipmentActions --------------------------------------------------------------------------------------------

  pickUp(lootId: number, replaceSlot?: WeaponSlot): void {
    this.pendingActions.push((tick) => void this.pickUpLoot(lootId, tick, { replaceSlot }));
  }

  drop(target: DropTarget): void {
    this.pendingActions.push((tick) => this.dropItem(target, tick));
  }

  useItem(itemId: ConsumableItemId): void {
    this.inputQueue.queueUse(itemId);
  }

  swapPrimaries(): void {
    this.pendingActions.push(() => {
      const result = swapWeapons(this.state.inventory, 0, 1);
      if (result.ok) this.setInventory(result.inventory);
    });
  }

  selectThrowable(kind: ThrowableKind): void {
    this.pendingActions.push(() => {
      const { inventory, throw: held } = this.state;
      const pinPulled = held.phase === "primed" || held.phase === "cooking";
      if (pinPulled || inventory.selectedThrowable === kind || countItem(inventory, kind) <= 0) return;
      this.setInventory({ ...inventory, selectedThrowable: kind });
      this.onItem.notifyObservers({ type: "throwableSelected", kind });
    });
  }

  // ---- EquipmentPlayerControl --------------------------------------------------------------------------------------

  damagePlayer(hit: PlayerDamage): void {
    this.damageLocal({ amount: hit.amount, kind: hit.kind, zone: hit.zone ?? null, sourceId: hit.sourceId }, hit.position);
  }

  setReviver(reviverId: number | null): void {
    this.reviverId = reviverId;
  }

  /** Same as `damagePlayer`, returning the vitals outcome (null when nothing was dealt or absorbed). */
  applyPlayerDamage(hit: PlayerDamage): DamageOutcome | null {
    return this.damageLocal({ amount: hit.amount, kind: hit.kind, zone: hit.zone ?? null, sourceId: hit.sourceId }, hit.position);
  }

  /** Overrides the `targets` option: area-effect targets read every tick (offline match bots). Null restores it. */
  setTargetsSource(source: (() => readonly EquipmentTarget[]) | null): void {
    this.targetsSource = source;
  }

  /** Overrides the `teammates` option: downed teammates the local player can revive. Null restores it. */
  setTeammatesSource(source: (() => readonly ReviveTarget[]) | null): void {
    this.teammatesSource = source;
  }

  /** A throwable released by an actor the client doesn't step here (an offline match bot); `slot` is its entity id. */
  spawnExternalRelease(release: ThrowRelease, slot: number): number {
    return spawnRelease(this.world, release, slot, slot, this.raycaster.cast);
  }

  /**
   * Death drop: the whole inventory (weapons with magazines, armor, backpack, stacks) as one ground pile around
   * `position`, settled on the floor; the inventory is emptied. Returns the number of ground items.
   */
  dropInventoryAt(position: Vec3, pileId = -1): number {
    const inv = this.state.inventory;
    const items: ItemInstance[] = [];
    for (const weapon of inv.weapons) if (weapon) items.push({ itemId: `weapon_${weapon.weaponId}`, quantity: 1, magazine: weapon.magazine });
    if (inv.helmet) items.push({ itemId: `helmet_${inv.helmet.level}`, quantity: 1, durability: inv.helmet.durability });
    if (inv.vest) items.push({ itemId: `vest_${inv.vest.level}`, quantity: 1, durability: inv.vest.durability });
    if (inv.backpack > 0) items.push({ itemId: `backpack_${inv.backpack as 1 | 2 | 3}`, quantity: 1 });
    for (const stack of inv.stacks) if (stack.quantity > 0) items.push({ itemId: stack.itemId, quantity: stack.quantity });
    this.raycaster.ignoreBody = this.player.physicsBody;
    const below = this.raycaster.cast({ x: position.x, y: position.y + 0.5, z: position.z }, { x: position.x, y: position.y - 30, z: position.z });
    const floorY = below ? below.point.y : position.y;
    items.forEach((item, k) => {
      const angle = (k / Math.max(1, items.length)) * Math.PI * 2;
      const r = items.length > 1 ? 0.35 + 0.05 * (k % 3) : 0;
      dropGroundItem(this.groundLoot, item, [position.x + Math.sin(angle) * r, floorY, position.z + Math.cos(angle) * r], pileId);
    });
    this.cancelTeammateRevive();
    this.state = { ...this.state, inventory: createInventory() };
    this.inHandThrows.clear();
    this.arc.visible = false;
    this.arc.count = 0;
    this.loadoutVersion++;
    return items.length;
  }

  resetLoadout(inventory: InventoryState = createOfflineInventory()): void {
    this.cancelTeammateRevive();
    this.state = createPlayerEquipment(inventory);
    this.reviverId = null;
    this.inHandThrows.clear();
    this.arc.visible = false;
    this.arc.count = 0;
    this.loadoutVersion++;
    this.onVitals.notifyObservers({ type: "respawned" });
  }

  // ---- CombatEquipmentLink -----------------------------------------------------------------------------------------

  commitWeapons(inventory: InventoryState, activeSlot: WeaponSlot | null): void {
    if (inventory !== this.state.inventory) this.setInventory(inventory);
    this.activeWeaponSlot = activeSlot;
  }

  // ---- Frame and tick ----------------------------------------------------------------------------------------------

  /** Per render frame, after combat.update: queues input no tick consumed this frame. */
  update(): void {
    this.inputQueue.endFrame(this.state.inventory);
  }

  dispose(): void {
    this.tickObserver.remove();
    for (const observable of [this.onThrow, this.onThrowableBounce, this.onDetonate, this.onSmoke, this.onFire, this.onFlash, this.onItem, this.onUse, this.onArmor, this.onVitals, this.onAreaDamage, this.onReviveAction]) {
      observable.clear();
    }
  }

  private tick({ dt, state: move }: PlayerTick): void {
    this.tickCount++;
    this.raycaster.ignoreBody = this.player.physicsBody;
    const raycast = this.raycaster.cast;
    const eye = this.player.getEyeToRef(this.eye);
    const aim = this.player.getAim();
    const ctx: TickContext = {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      feet: { x: eye.x, y: eye.y - eyeHeightFor(move.stance), z: eye.z },
      viewDir: viewDirection(aim.yaw, aim.pitch),
      yaw: aim.yaw,
      pitch: aim.pitch,
      move,
    };

    for (const action of this.pendingActions.splice(0)) action(ctx);

    this.stepBeingRevived(dt);
    const input = this.inputQueue.take(this.state.inventory, move);
    const step = stepPlayerEquipment(this.state, input, { eye: ctx.eye, yaw: aim.yaw, pitch: aim.pitch, velocity: move.velocity }, dt);
    const previousVitals = this.state.vitals;
    this.state = step.state;
    this.emitPlayerEvents(step.events, previousVitals);

    if (step.release) {
      const id = spawnRelease(this.world, step.release, LOCAL_PLAYER_ID, LOCAL_PLAYER_ID, raycast);
      if (id >= 0 && step.release.style === "inHand") this.inHandThrows.add(id);
    }

    this.stepInteraction(input, ctx, dt);

    const targets = (this.targetsSource ?? this.options.targets)?.() ?? [];
    const entities = this.worldEntities(ctx, targets);
    this.worldEvents.length = 0;
    stepEquipmentWorld(this.world, dt, raycast, entities, this.worldEvents);
    for (const event of this.worldEvents) this.handleWorldEvent(event, ctx, targets);
    this.throwables = snapshotThrowables(this.world.throwables);

    if (this.state.use.itemId !== null) {
      this.onUse.notifyObservers({ type: "progress", itemId: this.state.use.itemId, progress: itemUseProgress(this.state.use) ?? 0 });
    }
    if (this.tickCount % SMOKE_UPDATE_TICKS === 0) for (const cloud of this.world.smokes) this.onSmoke.notifyObservers({ type: "updated", cloud });
    if (this.tickCount % LOOT_QUERY_TICKS === 0) {
      this.refreshNearbyLoot(ctx);
      this.autoPickUp(ctx);
    }
    this.lootTarget = this.state.vitals.life === "alive" && !this.reviveCandidate ? pickLootTarget(this.nearbyLoot, ctx.eye, ctx.viewDir) : null;
    this.updateArc(ctx, move, raycast);
  }

  /** F: revive a downed teammate in reach (held), otherwise pick up the looked-at item (pressed). */
  private stepInteraction(input: QueuedEquipmentInput, ctx: TickContext, dt: number): void {
    const candidate = this.handsFree() ? this.findReviveCandidate(ctx) : null;
    this.reviveCandidate = candidate;

    const reviving = this.revivingTarget;
    if (reviving) {
      const active = input.interactHeld && this.handsFree() && this.inReviveReach(reviving, ctx);
      const step = stepRevive(reviving.vitals, LOCAL_PLAYER_ID, active, dt);
      reviving.setVitals(step.target);
      if (step.event?.type === "revived") {
        this.revivingTarget = null;
        this.onReviveAction.notifyObservers({ type: "completed", targetId: reviving.id });
      } else if (step.target.reviverId !== LOCAL_PLAYER_ID) {
        this.revivingTarget = null;
        this.onReviveAction.notifyObservers({ type: "cancelled", targetId: reviving.id });
      } else {
        this.onReviveAction.notifyObservers({ type: "progress", targetId: reviving.id, progress: Math.min(1, step.target.reviveProgress / VITALS.reviveSeconds) });
      }
      return;
    }

    if (!input.interactPressed || this.state.vitals.life !== "alive") return;
    if (candidate) {
      const step = stepRevive(candidate.vitals, LOCAL_PLAYER_ID, true, dt);
      // Someone else is already reviving them.
      if (step.target.reviverId !== LOCAL_PLAYER_ID) return;
      candidate.setVitals(step.target);
      this.revivingTarget = candidate;
      this.onReviveAction.notifyObservers({ type: "started", targetId: candidate.id });
      return;
    }
    const target = pickLootTarget(this.nearbyLoot, ctx.eye, ctx.viewDir);
    if (target) this.pickUpLoot(target.lootId, ctx);
  }

  /** Alive with hands free (no item in use, no throwable out): needed to revive. Looting only needs to be alive. */
  private handsFree(): boolean {
    const { vitals, use, throw: held } = this.state;
    return vitals.life === "alive" && use.itemId === null && held.phase === "idle";
  }

  private findReviveCandidate(ctx: TickContext): ReviveTarget | null {
    let best: ReviveTarget | null = null;
    let bestDistance = Infinity;
    for (const mate of (this.teammatesSource ?? this.options.teammates)?.() ?? []) {
      if (mate.id === LOCAL_PLAYER_ID || mate.vitals.life !== "downed" || !this.inReviveReach(mate, ctx)) continue;
      const distance = len2(mate.feet.x - ctx.feet.x, mate.feet.z - ctx.feet.z);
      if (distance < bestDistance) {
        best = mate;
        bestDistance = distance;
      }
    }
    return best;
  }

  private inReviveReach(mate: ReviveTarget, ctx: TickContext): boolean {
    const { feet } = mate;
    return len2(feet.x - ctx.feet.x, feet.z - ctx.feet.z) <= VITALS.reviveRange && Math.abs(feet.y - ctx.feet.y) <= REVIVE_HEIGHT && mate.vitals.life === "downed";
  }

  private cancelTeammateRevive(): void {
    const target = this.revivingTarget;
    if (!target) return;
    this.revivingTarget = null;
    target.setVitals(stepRevive(target.vitals, LOCAL_PLAYER_ID, false, 0).target);
    this.onReviveAction.notifyObservers({ type: "cancelled", targetId: target.id });
  }

  /** The local player downed with a reviver set (setReviver): progress, pause the bleed, stand up after 5 s. */
  private stepBeingRevived(dt: number): void {
    const vitals = this.state.vitals;
    if (vitals.life !== "downed") {
      this.reviverId = null;
      return;
    }
    const reviver = this.reviverId ?? vitals.reviverId;
    if (reviver < 0) return;
    const step = stepRevive(vitals, reviver, this.reviverId !== null, dt);
    this.state = { ...this.state, vitals: step.target };
    switch (step.event?.type) {
      case "reviveStarted":
        this.onVitals.notifyObservers({ type: "reviveStarted", reviverId: reviver });
        break;
      case "reviveCancelled":
        this.onVitals.notifyObservers({ type: "reviveCancelled" });
        return;
      case "revived":
        this.reviverId = null;
        this.onVitals.notifyObservers({ type: "revived" });
        this.onVitals.notifyObservers({ type: "healed", amount: step.target.health, source: "revive" });
        return;
    }
    if (step.target.reviverId === reviver) this.onVitals.notifyObservers({ type: "reviveProgress", progress: Math.min(1, step.target.reviveProgress / VITALS.reviveSeconds) });
  }

  private worldEntities(ctx: TickContext, targets: readonly EquipmentTarget[]): WorldEntity[] {
    const entities: WorldEntity[] = [];
    const vitals = this.state.vitals;
    if (vitals.life !== "dead") {
      const posture = vitals.life === "downed" ? "downed" : ctx.move.stance === "crouch" ? "crouch" : "stand";
      entities.push({ id: LOCAL_PLAYER_ID, team: 0, feet: ctx.feet, posture, eye: ctx.eye, viewDir: ctx.viewDir });
    }
    targets.forEach((target, index) => {
      if (!target.alive) return;
      const { x, y, z } = target.feet;
      const posture = target.posture ?? "stand";
      entities.push({
        id: index + 1,
        team: target.team ?? index + 1,
        feet: { x, y, z },
        posture,
        eye: target.eye ?? { x, y: y + eyeHeightFor(posture === "stand" ? "stand" : "crouch"), z },
        viewDir: target.viewDir ?? { x: 0, y: 0, z: 1 },
      });
    });
    return entities;
  }

  private emitPlayerEvents(events: readonly PlayerEquipmentEvent[], previousVitals: Vitals): void {
    for (const event of events) {
      switch (event.type) {
        case "useStarted":
          this.onUse.notifyObservers({ type: "started", itemId: event.itemId, seconds: event.seconds });
          break;
        case "useCancelled":
          this.onUse.notifyObservers({ type: "cancelled", itemId: event.itemId, reason: event.reason });
          break;
        case "useRejected":
          this.onUse.notifyObservers({ type: "rejected", itemId: event.itemId, reason: event.reason });
          break;
        case "useCompleted": {
          this.onUse.notifyObservers({ type: "completed", itemId: event.itemId });
          const healed = Math.round((this.state.vitals.health - previousVitals.health) * 10) / 10;
          if (healed > 0) this.onVitals.notifyObservers({ type: "healed", amount: healed, source: "item" });
          break;
        }
        case "boostHeal":
          this.onVitals.notifyObservers({ type: "healed", amount: event.amount, source: "boost" });
          break;
        case "bledOut":
          this.onVitals.notifyObservers({ type: "eliminated", killerId: event.killerId, cause: "bleed" });
          break;
        case "throwableSelected":
          this.onItem.notifyObservers({ type: "throwableSelected", kind: event.kind });
          break;
        default:
          this.onThrow.notifyObservers(event);
      }
    }
  }

  private handleWorldEvent(event: EquipmentWorldEvent, ctx: TickContext, targets: readonly EquipmentTarget[]): void {
    switch (event.type) {
      case "bounce":
        this.onThrowableBounce.notifyObservers({ id: event.id, kind: event.kind, position: event.position, normal: event.normal, impactSpeed: event.impactSpeed });
        break;
      case "rest":
        break;
      case "detonate": {
        const inHand = this.inHandThrows.delete(event.id);
        this.onDetonate.notifyObservers({ id: event.id, kind: event.kind, ownerId: event.owner, position: event.position, normal: event.normal, reason: event.reason, inHand });
        break;
      }
      case "smokeSpawned":
        this.onSmoke.notifyObservers({ type: "spawned", cloud: event.cloud });
        break;
      case "smokeExpired":
        this.onSmoke.notifyObservers({ type: "expired", id: event.id });
        break;
      case "fireSpawned":
        this.onFire.notifyObservers({ type: "spawned", patch: event.patch });
        break;
      case "fireExpired":
        this.onFire.notifyObservers({ type: "expired", id: event.id });
        break;
      case "flashed":
        if (event.targetId === LOCAL_PLAYER_ID) this.flashLocal(event.exposure, ctx);
        else targets[event.targetId - 1]?.applyFlash?.(event.exposure);
        break;
      case "damage": {
        const { request } = event;
        if (request.targetId === LOCAL_PLAYER_ID) {
          this.damageLocal({ amount: request.amount, kind: request.kind, zone: event.explosion ? "body" : null, sourceId: request.sourceId }, request.position);
        } else {
          this.damageTarget(request, targets[request.targetId - 1]);
        }
        break;
      }
    }
  }

  private flashLocal(exposure: FlashEvent["exposure"], ctx: TickContext): void {
    const vitals = this.state.vitals;
    this.state = {
      ...this.state,
      vitals: { ...vitals, blindSeconds: Math.max(vitals.blindSeconds, exposure.blindSeconds), deafSeconds: Math.max(vitals.deafSeconds, exposure.deafSeconds) },
    };
    this.onFlash.notifyObservers({ position: ctx.eye, exposure });
  }

  /** Every hit on the local player (grenades, fire, falls, later bullets): armor → health → knocked/eliminated. */
  private damageLocal(hit: VitalsHit, position: Vec3): DamageOutcome | null {
    const before = this.state.vitals;
    const worn = armorLoadout(this.state.inventory);
    const outcome = applyDamage(before, worn, hit, { canBeKnocked: this.canBeKnocked });
    if (outcome.dealt <= 0 && outcome.armorResult.absorbed <= 0) return null;
    this.state = { ...this.state, vitals: outcome.vitals, inventory: withArmor(this.state.inventory, outcome.armor) };

    const armor = outcome.armorResult;
    if (armor.slot && armor.absorbed > 0) {
      const level = worn[armor.slot]?.level ?? 0;
      if (armor.destroyed) this.onArmor.notifyObservers({ type: "destroyed", slot: armor.slot, level });
      else this.onArmor.notifyObservers({ type: "damaged", slot: armor.slot, level, absorbed: armor.absorbed, durability: armor.durabilityAfter, condition: armorCondition(armor.slot, this.state.inventory[armor.slot]) });
    }
    if (outcome.dealt > 0) this.onVitals.notifyObservers({ type: "damaged", amount: outcome.dealt, kind: hit.kind, sourceId: hit.sourceId, position });
    if (outcome.knocked) {
      this.cancelTeammateRevive();
      this.onVitals.notifyObservers({ type: "knocked", byId: hit.sourceId });
    }
    if (outcome.killed) {
      this.cancelTeammateRevive();
      this.reviverId = null;
      this.onVitals.notifyObservers({ type: "eliminated", killerId: outcome.killerId, cause: hit.kind });
    }
    return outcome;
  }

  private damageTarget(request: DamageRequest, target: EquipmentTarget | undefined): void {
    if (!target?.alive) return;
    const feet = target.feet;
    const point = new Vector3(feet.x, feet.y + 1, feet.z);
    const direction = point.subtract(new Vector3(request.position.x, request.position.y, request.position.z)).normalize();
    const result = target.applyDamage({ colliderId: `${target.id}/area`, zone: "body", amount: request.amount, kind: request.kind, point, direction, sourceId: request.sourceId });
    if (!result) return;
    this.onAreaDamage.notifyObservers({
      targetId: target.id,
      ...(target.displayName ? { targetName: target.displayName } : {}),
      kind: request.kind,
      amount: result.amount,
      remainingHealth: result.remainingHealth,
      killed: result.killed,
      sourceId: request.sourceId,
      point: { x: point.x, y: point.y, z: point.z },
    });
  }

  /** Returns whether anything was taken. `silent` (auto pickup) skips failure events. */
  private pickUpLoot(lootId: number, ctx: TickContext, { replaceSlot, silent = false }: { replaceSlot?: WeaponSlot | undefined; silent?: boolean } = {}): boolean {
    const ground = this.groundLoot;
    const item = ground.items.get(lootId);
    if (!item || this.state.vitals.life !== "alive") return false;
    const [x, y, z] = item.position;
    if (len3(x - ctx.eye.x, y - ctx.eye.y, z - ctx.eye.z) > INTERACT.reach + PICKUP_SLACK) return false;

    const instance = toInstance(item);
    // F on a primary with both primaries full swaps the one in hand (primary 1 when holding the sidearm or unarmed).
    const active = this.activeWeaponSlot;
    const result = pickUp(this.state.inventory, instance, replaceSlot ?? (active === 1 ? 1 : 0));
    if (!result.ok) {
      if (!silent) this.onItem.notifyObservers({ type: "pickupFailed", item: instance, lootId, error: result.error });
      return false;
    }
    this.setInventory(result.inventory);
    setGroundQuantity(ground, lootId, result.remainder?.quantity ?? 0);
    if (!result.remainder) this.playerDropped.delete(lootId);
    this.onItem.notifyObservers({ type: "picked", item: instance, lootId, taken: result.taken });
    for (const dropped of result.dropped) this.putOnGround(dropped, ctx, item.position);
    this.refreshNearbyLoot(ctx);
    return true;
  }

  private autoPickUp(ctx: TickContext): void {
    if (!this.autoPickup || this.state.vitals.life !== "alive") return;
    for (const item of this.nearbyLoot) {
      const dy = item.position[1] - ctx.feet.y;
      if (dy < -AUTO_PICKUP.below || dy > AUTO_PICKUP.above || len2(item.position[0] - ctx.feet.x, item.position[2] - ctx.feet.z) > AUTO_PICKUP.radius) continue;
      if (this.playerDropped.has(item.lootId) || !wantsAutoPickup(this.state.inventory, item.itemId)) continue;
      this.pickUpLoot(item.lootId, ctx, { silent: true });
    }
  }

  private dropItem(target: DropTarget, ctx: TickContext): void {
    const result = drop(this.state.inventory, target);
    if (!result.ok) {
      this.onItem.notifyObservers({ type: "dropFailed", target, error: result.error });
      return;
    }
    this.setInventory(result.inventory);
    this.putOnGround(result.dropped, ctx);
    this.refreshNearbyLoot(ctx);
  }

  /**
   * Puts an item from the inventory on the ground: at `at` (a swap leaves the old gear where the new one lay), else a
   * little in front of the feet unless a wall is in the way. Settles onto whatever is below.
   */
  private putOnGround(instance: ItemInstance, ctx: TickContext, at?: Vec3Tuple): void {
    const ground = this.groundLoot;
    const ring = (ground.nextId * 2.399) % (Math.PI * 2);
    let [x, y, z] = at ?? [ctx.feet.x, ctx.feet.y, ctx.feet.z];
    if (!at) {
      const horizontal = Math.max(1e-6, len2(ctx.viewDir.x, ctx.viewDir.z));
      const tx = x + (ctx.viewDir.x / horizontal) * DROP.forward + Math.sin(ring) * DROP.spread;
      const tz = z + (ctx.viewDir.z / horizontal) * DROP.forward + Math.cos(ring) * DROP.spread;
      if (!this.raycaster.cast({ x, y: y + 0.3, z }, { x: tx, y: y + 0.3, z: tz })) {
        x = tx;
        z = tz;
      }
    }
    const below = this.raycaster.cast({ x, y: y + 0.5, z }, { x, y: y - 3, z });
    if (below) y = below.point.y;
    const item = dropGroundItem(ground, instance, [x, y, z]);
    this.playerDropped.add(item.lootId);
    this.onItem.notifyObservers({ type: "dropped", item });
  }

  private setInventory(inventory: InventoryState): void {
    this.state = { ...this.state, inventory };
  }

  /** Items within reach that the eye can see (no looting through walls or floors). */
  private refreshNearbyLoot(ctx: TickContext): void {
    if (this.state.vitals.life !== "alive") {
      this.nearbyLoot = [];
      this.lootTarget = null;
      return;
    }
    const eye = ctx.eye;
    this.nearbyLoot = queryGroundLoot(this.groundLoot, eye, INTERACT.reach).filter((item) => {
      const [x, y, z] = item.position;
      return this.raycaster.cast(eye, { x, y: y + ITEM_SIGHT_HEIGHT, z }) === null;
    });
  }

  private updateArc(ctx: TickContext, move: MoveState, raycast: RaycastFn): void {
    const { phase, kind, fuse } = this.state.throw;
    const arc = this.arc;
    arc.visible = kind !== null && (phase === "primed" || phase === "cooking");
    if (!arc.visible || kind === null) {
      arc.count = 0;
      return;
    }
    const style = this.inputQueue.isAimHeld ? "underhand" : "overhand";
    const launch = throwLaunch({ eye: ctx.eye, yaw: ctx.yaw, pitch: ctx.pitch, velocity: move.velocity }, style);
    const position = resolveThrowOrigin(ctx.eye, launch.hand, raycast);
    const result = predictThrowArc({ kind, position, velocity: launch.velocity, fuse: phase === "cooking" ? fuse : ITEMS[kind].fuseSeconds }, raycast, arc.points, { dt: TICK_SECONDS });
    arc.count = result.count;
    arc.end = result.end;
  }
}

interface TickContext {
  readonly eye: Vec3;
  readonly feet: Vec3;
  readonly viewDir: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly move: MoveState;
}

interface QueuedEquipmentInput extends EquipmentInput {
  readonly interactPressed: boolean;
  readonly interactHeld: boolean;
}

const WEAPON_SELECT_ACTIONS: readonly Action[] = ["slot1", "slot2", "slot3", "slot4"];
const USE_ACTIONS: readonly (readonly [Action, readonly ConsumableItemId[]])[] = [
  ["useBandage", ["bandage"]],
  ["useFirstAid", ["first_aid"]],
  ["useMedkit", ["medkit"]],
  ["useBoost", ["energy_drink", "painkiller"]],
];

/** Queues one-frame equipment presses until a tick consumes them (the CombatInputQueue pattern). */
class EquipmentInputQueue {
  private readonly pressed = new Set<Action>();
  private wheel = false;
  private useQueued: ConsumableItemId | null = null;
  private uiUse: ConsumableItemId | null = null;
  private polledThisFrame = false;

  constructor(private readonly input: EquipmentInputSource) {}

  get isAimHeld(): boolean {
    return this.input.isLocked && this.input.isActionDown("aim");
  }

  queueUse(itemId: ConsumableItemId): void {
    this.uiUse = itemId;
  }

  endFrame(inventory: InventoryState): void {
    this.poll(inventory);
    this.polledThisFrame = false;
  }

  take(inventory: InventoryState, move: MoveState): QueuedEquipmentInput {
    this.poll(inventory);
    const input = this.input;
    const locked = input.isLocked;
    const was = (action: Action) => this.pressed.has(action);
    const held = (action: Action) => locked && input.isActionDown(action);
    const result: QueuedEquipmentInput = {
      fire: was("fire") || held("fire"),
      firePressed: was("fire"),
      aim: held("aim"),
      reloadPressed: was("reload"),
      jumpPressed: was("jump"),
      sprint: held("sprint") && held("forward") && move.grounded,
      equipThrowablePressed: was("throwable"),
      cycleThrowablePressed: was("cycleThrowable"),
      holsterPressed: was("holster"),
      weaponSelectPressed: this.wheel || WEAPON_SELECT_ACTIONS.some(was),
      useItem: this.uiUse ?? this.useQueued,
      interactPressed: was("interact"),
      interactHeld: was("interact") || held("interact"),
    };
    this.pressed.clear();
    this.wheel = false;
    this.useQueued = null;
    this.uiUse = null;
    return result;
  }

  private poll(inventory: InventoryState): void {
    if (this.polledThisFrame) return;
    this.polledThisFrame = true;
    const input = this.input;
    if (!input.isLocked) {
      this.pressed.clear();
      this.wheel = false;
      this.useQueued = null;
      return;
    }
    const actions: readonly Action[] = ["fire", "reload", "jump", "throwable", "cycleThrowable", "holster", "interact", ...WEAPON_SELECT_ACTIONS];
    for (const action of actions) if (input.wasActionPressed(action)) this.pressed.add(action);
    if (input.wheelDelta() !== 0) this.wheel = true;
    for (const [action, items] of USE_ACTIONS) {
      if (!input.wasActionPressed(action)) continue;
      this.useQueued = items.find((id) => countItem(inventory, id) > 0) ?? items[0]!;
    }
  }
}

/**
 * Static-world segment queries for throwables, area effects and loot sight lines: like HavokRaycaster, but hitbox
 * triggers and player blockers are invisible, and the local player's own capsule is ignored.
 */
class WorldRaycaster {
  private readonly plugin: HavokPlugin;
  private readonly result = new PhysicsRaycastResult();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly query: IRaycastQuery = { shouldHitTriggers: false, collideWith: WORLD_COLLIDE_MASK };

  constructor(scene: Scene) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    if (!plugin || !("raycast" in plugin) || plugin.getPluginVersion() !== 2) throw new Error("EquipmentSystem requires the Havok physics plugin (v2)");
    this.plugin = plugin as HavokPlugin;
  }

  set ignoreBody(body: PhysicsBody | undefined) {
    this.query.ignoreBody = body;
  }

  readonly cast: RaycastFn = (from: Vec3, to: Vec3): RayHit | null => {
    const start = this.from.set(from.x, from.y, from.z);
    const end = this.to.set(to.x, to.y, to.z);
    const result = this.result;
    this.plugin.raycast(start, end, result, this.query);
    if (!result.hasHit) return null;
    const length = Vector3.Distance(start, end);
    const { x: px, y: py, z: pz } = result.hitPointWorld;
    const { x: nx, y: ny, z: nz } = result.hitNormalWorld;
    return { point: { x: px, y: py, z: pz }, normal: { x: nx, y: ny, z: nz }, fraction: length > 0 ? Math.min(1, result.hitDistance / length) : 0, colliderId: null };
  };
}

function viewDirection(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return { x: Math.sin(yaw) * cosPitch, y: -Math.sin(pitch), z: Math.cos(yaw) * cosPitch };
}

function toInstance(item: LootItem): ItemInstance {
  const { itemId, quantity, durability, magazine } = item;
  return { itemId, quantity, ...(durability !== undefined ? { durability } : {}), ...(magazine !== undefined ? { magazine } : {}) };
}

/**
 * Adapts practice soldiers (TargetDummy) to equipment targets. With `armor` (CombatSystem.targetArmor), blasts are
 * reduced by a worn vest first, like bullets.
 */
export function soldierTargets(
  dummies: readonly (Damageable & { readonly soldier: { readonly root: { readonly position: Vec3 } } })[],
  armor?: TargetArmor,
): EquipmentTarget[] {
  return dummies.map((dummy) => ({
    id: dummy.id,
    ...(dummy.displayName ? { displayName: dummy.displayName } : {}),
    get alive() {
      return dummy.alive;
    },
    get feet() {
      return dummy.soldier.root.position;
    },
    applyDamage: (hit) => {
      if (!armor || !dummy.alive) return dummy.applyDamage(hit);
      return dummy.applyDamage({ ...hit, amount: armor.absorb(dummy.id, hit.amount, hit.kind ?? "bullet", hit.zone).amount });
    },
  }));
}
