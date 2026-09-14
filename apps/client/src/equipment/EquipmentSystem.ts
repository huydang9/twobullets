import { Observable, PhysicsRaycastResult, Vector3, type HavokPlugin, type IRaycastQuery, type Observer, type PhysicsBody, type Scene } from "@babylonjs/core";
import {
  INTERACT,
  ITEMS,
  MOVEMENT,
  SIMULATION,
  VITALS,
  applyDamage,
  armorCondition,
  armorLoadout,
  countItem,
  createEquipmentWorld,
  createGroundLoot,
  createOfflineInventory,
  createPlayerEquipment,
  createVitals,
  cookProgress,
  deriveEquipmentModifiers,
  drop,
  dropGroundItem,
  generateLoot,
  inventoryCapacity,
  inventoryWeight,
  itemUseProgress,
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
  swapWeapons,
  throwableCounts,
  throwLaunch,
  withArmor,
  type ConsumableItemId,
  type DamageRequest,
  type DropTarget,
  type EquipmentInput,
  type EquipmentModifiers,
  type EquipmentWorld,
  type EquipmentWorldEvent,
  type ExplosionHit,
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
  type ThrowableKind,
  type ThrowableSnapshot,
  type Vec3,
  type Vec3Tuple,
  type Vitals,
  type WeaponSlot,
  type WorldEntity,
} from "@twobullets/shared";
import { CollisionLayer, type Damageable } from "../combat/hitboxes";
import type { Action } from "../input/bindings";
import type { PlayerModifiers, PlayerTick } from "../player/PlayerController";
import {
  LOCAL_PLAYER_ID,
  type AreaDamageEvent,
  type ArmorEvent,
  type DetonationEvent,
  type EquipmentActions,
  type EquipmentView,
  type FireEvent,
  type FlashEvent,
  type ItemEvent,
  type ItemUseView,
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
  readonly modifiers: PlayerModifiers;
  getEyeToRef(result: Vector3): Vector3;
  getAim(): { readonly yaw: number; readonly pitch: number };
  respawn?(): void;
}

/** The parts of InputManager equipment reads. */
export interface EquipmentInputSource {
  readonly isLocked: boolean;
  isActionDown(action: Action): boolean;
  wasActionPressed(action: Action): boolean;
  wheelDelta(): number;
}

/** A non-player damageable that grenades and fire can reach (practice soldiers). */
export interface EquipmentTarget extends Damageable {
  /** Feet position, world space. */
  readonly feet: Vec3;
}

export interface EquipmentOptions {
  /** Match seed for loot and effect shapes. */
  readonly seed?: number;
  /** Map mode: spawns ground loot in these buildings. */
  readonly map?: { readonly pois: readonly PointOfInterest[]; readonly buildings: readonly LootBuilding[] };
  /** Called every tick for the current targets. */
  readonly targets?: () => readonly EquipmentTarget[];
  readonly inventory?: InventoryState;
}

const TICK_SECONDS = 1 / SIMULATION.tickRate;
/** Offline match seed until the match phase provides one. */
const DEFAULT_SEED = 0x2b0b;
const ARC_POINTS = 96;
/** Ticks between nearby-loot refreshes (10 Hz). */
const LOOT_QUERY_TICKS = 6;
const SMOKE_UPDATE_TICKS = 15;
/** Offline: seconds from elimination to respawn. */
const RESPAWN_SECONDS = 5;
/** Equipment rays see static world only: not hitbox triggers, not player blockers. */
const WORLD_COLLIDE_MASK = ~(CollisionLayer.hitbox | CollisionLayer.blocker);

/**
 * Local player's equipment: ticks the shared equipment rules in lockstep with movement (like CombatSystem), flies
 * throwables against Havok, resolves grenades and fire against the player and practice soldiers, and spawns ground
 * loot in map mode. Presentation, HUD and audio subscribe through {@link EquipmentView}; the inventory UI sends
 * {@link EquipmentActions}. Runs headless: nothing here draws.
 *
 * Frame order: player.update → combat.update → equipment.update (it multiplies its gates into player.modifiers
 * after CombatSystem has written them).
 */
export class EquipmentSystem implements EquipmentView, EquipmentActions {
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

  readonly maxHealth = VITALS.maxHealth;
  readonly groundLoot: GroundLoot | null;
  nearbyLoot: readonly LootItem[] = [];
  lootTarget: LootItem | null = null;
  throwables: readonly ThrowableSnapshot[] = [];

  private state: PlayerEquipmentState;
  private readonly world: EquipmentWorld;
  private readonly raycaster: WorldRaycaster;
  private readonly inputQueue: EquipmentInputQueue;
  private readonly tickObserver: Observer<PlayerTick>;
  private readonly arc = { points: new Float32Array(ARC_POINTS * 3), count: 0, end: { x: 0, y: 0, z: 0 } as Vec3, visible: false };
  private readonly pendingActions: ((tick: TickContext) => void)[] = [];
  private readonly inHandThrows = new Set<number>();
  private readonly eye = new Vector3();
  private readonly worldEvents: EquipmentWorldEvent[] = [];
  private tickCount = 0;
  private respawnTimer = 0;

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
    this.groundLoot = options.map ? createGroundLoot(generateLoot(seed, options.map.pois, options.map.buildings).items) : null;
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

  get modifiers(): EquipmentModifiers {
    return deriveEquipmentModifiers(this.state);
  }

  get smokes() {
    return this.world.smokes;
  }

  get fires() {
    return this.world.fires;
  }

  // ---- EquipmentActions --------------------------------------------------------------------------------------------

  pickUp(lootId: number, replaceSlot?: WeaponSlot): void {
    this.pendingActions.push((tick) => this.pickUpLoot(lootId, tick, replaceSlot));
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

  // ---- Frame and tick ----------------------------------------------------------------------------------------------

  /** Per render frame, after combat.update: queues untaken input and applies equipment gates to the player. */
  update(): void {
    this.inputQueue.endFrame(this.state.inventory);
    const gates = this.modifiers;
    const modifiers = this.player.modifiers;
    modifiers.speedScale *= gates.speedScale;
    modifiers.allowSprint &&= gates.allowSprint;
  }

  dispose(): void {
    this.tickObserver.remove();
    for (const observable of [this.onThrow, this.onThrowableBounce, this.onDetonate, this.onSmoke, this.onFire, this.onFlash, this.onItem, this.onUse, this.onArmor, this.onVitals, this.onAreaDamage]) observable.clear();
  }

  private tick({ dt, state: move }: PlayerTick): void {
    this.tickCount++;
    this.raycaster.ignoreBody = this.player.physicsBody;
    const raycast = this.raycaster.cast;
    const eye = this.player.getEyeToRef(this.eye);
    const aim = this.player.getAim();
    const ctx: TickContext = {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      feet: { x: eye.x, y: eye.y - (move.stance === "crouch" ? MOVEMENT.crouchEyeHeight : MOVEMENT.standEyeHeight), z: eye.z },
      viewDir: viewDirection(aim.yaw, aim.pitch),
      yaw: aim.yaw,
      pitch: aim.pitch,
      move,
    };

    for (const action of this.pendingActions.splice(0)) action(ctx);

    const input = this.inputQueue.take(this.state.inventory, move);
    const step = stepPlayerEquipment(this.state, input, { eye: ctx.eye, yaw: aim.yaw, pitch: aim.pitch, velocity: move.velocity }, dt);
    const previousVitals = this.state.vitals;
    this.state = step.state;
    this.emitPlayerEvents(step.events, previousVitals);

    if (step.release) {
      const id = spawnRelease(this.world, step.release, LOCAL_PLAYER_ID, LOCAL_PLAYER_ID, raycast);
      if (id >= 0 && step.release.style === "inHand") this.inHandThrows.add(id);
    }

    if (input.interactPressed && this.state.vitals.life === "alive" && this.lootTarget) this.pickUpLoot(this.lootTarget.lootId, ctx);

    const targets = this.options.targets?.() ?? [];
    const entities = this.worldEntities(ctx, targets);
    this.worldEvents.length = 0;
    stepEquipmentWorld(this.world, dt, raycast, entities, this.worldEvents);
    for (const event of this.worldEvents) this.handleWorldEvent(event, ctx, targets);
    this.throwables = snapshotThrowables(this.world.throwables);

    if (this.state.use.itemId !== null) {
      this.onUse.notifyObservers({ type: "progress", itemId: this.state.use.itemId, progress: itemUseProgress(this.state.use) ?? 0 });
    }
    if (this.tickCount % SMOKE_UPDATE_TICKS === 0) for (const cloud of this.world.smokes) this.onSmoke.notifyObservers({ type: "updated", cloud });
    if (this.tickCount % LOOT_QUERY_TICKS === 0) this.refreshNearbyLoot(ctx);
    this.updateArc(ctx, move, raycast);
    this.updateRespawn(dt);
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
      entities.push({ id: index + 1, team: index + 1, feet: { x, y, z }, posture: "stand", eye: { x, y: y + MOVEMENT.standEyeHeight, z }, viewDir: { x: 0, y: 0, z: 1 } });
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
          this.respawnTimer = RESPAWN_SECONDS;
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
        break;
      case "damage":
        if (event.request.targetId === LOCAL_PLAYER_ID) this.damageLocal(event.request, event.explosion);
        else this.damageTarget(event.request, targets[event.request.targetId - 1]);
        break;
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

  private damageLocal(request: DamageRequest, explosion: ExplosionHit | null): void {
    const before = this.state.vitals;
    const worn = armorLoadout(this.state.inventory);
    // Offline the local player is a team of one, so reaching 0 HP eliminates (see findTeamWipes for squads).
    const outcome = applyDamage(before, worn, { amount: request.amount, kind: request.kind, zone: explosion ? "body" : null, sourceId: request.sourceId }, { canBeKnocked: false });
    if (outcome.dealt <= 0 && outcome.armorResult.absorbed <= 0) return;
    this.state = { ...this.state, vitals: outcome.vitals, inventory: withArmor(this.state.inventory, outcome.armor) };

    const armor = outcome.armorResult;
    if (armor.slot && armor.absorbed > 0) {
      const level = worn[armor.slot]?.level ?? 0;
      if (armor.destroyed) this.onArmor.notifyObservers({ type: "destroyed", slot: armor.slot, level });
      else this.onArmor.notifyObservers({ type: "damaged", slot: armor.slot, level, absorbed: armor.absorbed, durability: armor.durabilityAfter, condition: armorCondition(armor.slot, this.state.inventory[armor.slot]) });
    }
    if (outcome.dealt > 0) this.onVitals.notifyObservers({ type: "damaged", amount: outcome.dealt, kind: request.kind, sourceId: request.sourceId, position: request.position });
    if (outcome.knocked) this.onVitals.notifyObservers({ type: "knocked", byId: request.sourceId });
    if (outcome.killed) {
      this.onVitals.notifyObservers({ type: "eliminated", killerId: outcome.killerId, cause: request.kind });
      this.respawnTimer = RESPAWN_SECONDS;
    }
  }

  private damageTarget(request: DamageRequest, target: EquipmentTarget | undefined): void {
    if (!target?.alive) return;
    const feet = target.feet;
    const point = new Vector3(feet.x, feet.y + 1, feet.z);
    const direction = point.subtract(new Vector3(request.position.x, request.position.y, request.position.z)).normalize();
    const result = target.applyDamage({ colliderId: `${target.id}/area`, zone: "body", amount: request.amount, point, direction });
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

  private pickUpLoot(lootId: number, ctx: TickContext, replaceSlot?: WeaponSlot): void {
    const ground = this.groundLoot;
    const item = ground?.items.get(lootId);
    if (!ground || !item || this.state.vitals.life !== "alive") return;
    const [x, y, z] = item.position;
    if (len3(x - ctx.eye.x, y - ctx.eye.y, z - ctx.eye.z) > INTERACT.reach + 0.4) return;

    const instance = toInstance(item);
    // Until weapons come from the inventory (phase 2), a primary pickup with both primaries full replaces primary 1.
    const result = pickUp(this.state.inventory, instance, replaceSlot ?? 0);
    if (!result.ok) {
      this.onItem.notifyObservers({ type: "pickupFailed", item: instance, lootId, error: result.error });
      return;
    }
    this.setInventory(result.inventory);
    setGroundQuantity(ground, lootId, result.remainder?.quantity ?? 0);
    this.onItem.notifyObservers({ type: "picked", item: instance, lootId, taken: result.taken });
    for (const dropped of result.dropped) this.putOnGround(dropped, item.position);
    this.refreshNearbyLoot(ctx);
  }

  private dropItem(target: DropTarget, ctx: TickContext): void {
    const result = drop(this.state.inventory, target);
    if (!result.ok) {
      this.onItem.notifyObservers({ type: "dropFailed", target, error: result.error });
      return;
    }
    this.setInventory(result.inventory);
    this.putOnGround(result.dropped, [ctx.feet.x, ctx.feet.y, ctx.feet.z]);
    this.refreshNearbyLoot(ctx);
  }

  private putOnGround(instance: ItemInstance, position: Vec3Tuple): void {
    if (!this.groundLoot) return;
    // Settle onto whatever is below, so drops on stairs or balconies don't float.
    const below = this.raycaster.cast({ x: position[0], y: position[1] + 0.5, z: position[2] }, { x: position[0], y: position[1] - 3, z: position[2] });
    const y = below ? below.point.y : position[1];
    const item = dropGroundItem(this.groundLoot, instance, [position[0], y, position[2]]);
    this.onItem.notifyObservers({ type: "dropped", item });
  }

  private setInventory(inventory: InventoryState): void {
    this.state = { ...this.state, inventory };
  }

  private refreshNearbyLoot(ctx: TickContext): void {
    if (!this.groundLoot || this.state.vitals.life !== "alive") {
      this.nearbyLoot = [];
      this.lootTarget = null;
      return;
    }
    this.nearbyLoot = queryGroundLoot(this.groundLoot, ctx.eye, INTERACT.reach);
    this.lootTarget = pickLootTarget(this.nearbyLoot, ctx.eye, ctx.viewDir);
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

  private updateRespawn(dt: number): void {
    if (this.state.vitals.life !== "dead" || this.respawnTimer <= 0) return;
    this.respawnTimer -= dt;
    if (this.respawnTimer > 0) return;
    this.state = { ...this.state, vitals: createVitals() };
    this.player.respawn?.();
    this.onVitals.notifyObservers({ type: "respawned" });
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
 * Static-world segment queries for throwables and area effects: like HavokRaycaster, but hitbox triggers and player
 * blockers are invisible, and the thrower's own capsule is ignored.
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

/** Adapts practice soldiers (TargetDummy) to equipment targets. */
export function soldierTargets(dummies: readonly (Damageable & { readonly soldier: { readonly root: { readonly position: Vec3 } } })[]): EquipmentTarget[] {
  return dummies.map((dummy) => ({
    id: dummy.id,
    ...(dummy.displayName ? { displayName: dummy.displayName } : {}),
    get alive() {
      return dummy.alive;
    },
    get feet() {
      return dummy.soldier.root.position;
    },
    applyDamage: (hit) => dummy.applyDamage(hit),
  }));
}
