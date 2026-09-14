import { MOVEMENT } from "../constants";
import type { Vec3 } from "../movement/types";
import type { RaycastFn } from "../weapons/types";
import type { DamageKind } from "./armor";
import { blastOrigin, computeExplosionHits, EXPLOSION, type EntitySample, type ExplosionHit } from "./explosion";
import { createFirePatch, fireDamageTargets, FIRE, isFireExpired, stepFirePatch, type FirePatch } from "./fire";
import { flashExposure, type FlashExposure } from "./flash";
import { countItem, cycleThrowable, removeStack, type InventoryState } from "./inventory";
import type { ConsumableItemId } from "./items";
import { IDLE_ITEM_USE, stepItemUse, type ItemUseEvent, type ItemUseState } from "./itemUse";
import { hash32 } from "./math";
import { createSmokeCloud, isSmokeExpired, stepSmokeCloud, type SmokeCloud } from "./smoke";
import { createThrowState, stepThrow, type ThrowEvent, type ThrowRelease, type ThrowState } from "./throw";
import {
  createThrowableSet,
  resolveThrowOrigin,
  spawnThrowable,
  stepThrowables,
  throwId,
  type ThrowableSet,
  type ThrowableSimEvent,
} from "./throwables";
import { boostSpeedScale, createVitals, stepVitals, VITALS, type Vitals, type VitalsEvent } from "./vitals";

// ---------------------------------------------------------------------------------------------------------------
// Per player
// ---------------------------------------------------------------------------------------------------------------

/** Everything equipment-related one player carries between ticks. Plain data, like MoveState and WeaponState. */
export interface PlayerEquipmentState {
  readonly inventory: InventoryState;
  readonly throw: ThrowState;
  readonly use: ItemUseState;
  readonly vitals: Vitals;
}

/** One tick of equipment intent (sits next to MoveInput and CombatInput). Pressed = rising edge this tick. */
export interface EquipmentInput {
  readonly fire: boolean;
  readonly firePressed: boolean;
  readonly aim: boolean;
  /** R pressed: cooks a primed frag; interrupts item use. */
  readonly reloadPressed: boolean;
  readonly jumpPressed: boolean;
  /** Sprint key held while moving. */
  readonly sprint: boolean;
  /** Throwable key (5) pressed. */
  readonly equipThrowablePressed: boolean;
  /** Cycle throwable (G) pressed. */
  readonly cycleThrowablePressed: boolean;
  /** Holster (X) pressed. */
  readonly holsterPressed: boolean;
  /** A weapon slot key or wheel notch switched to a gun this tick. */
  readonly weaponSelectPressed: boolean;
  /** Quick-use hotkey (resolved to a carried item by the client), or an inventory click. */
  readonly useItem: ConsumableItemId | null;
}

export const IDLE_EQUIPMENT_INPUT: EquipmentInput = {
  fire: false,
  firePressed: false,
  aim: false,
  reloadPressed: false,
  jumpPressed: false,
  sprint: false,
  equipThrowablePressed: false,
  cycleThrowablePressed: false,
  holsterPressed: false,
  weaponSelectPressed: false,
  useItem: null,
};

export interface EquipmentContext {
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly velocity: Vec3;
}

export type PlayerEquipmentEvent =
  | ThrowEvent
  | ItemUseEvent
  | VitalsEvent
  | { readonly type: "throwableSelected"; readonly kind: InventoryState["selectedThrowable"] };

export interface PlayerEquipmentStepResult {
  readonly state: PlayerEquipmentState;
  /** Throwable that left the hand this tick (already removed from the inventory); spawn it with spawnRelease. */
  readonly release: ThrowRelease | null;
  readonly events: readonly PlayerEquipmentEvent[];
}

export function createPlayerEquipment(inventory: InventoryState): PlayerEquipmentState {
  return { inventory, throw: createThrowState(), use: IDLE_ITEM_USE, vitals: createVitals() };
}

/**
 * One player's equipment tick. Order: vitals (boost, bleed-out, flash timers) → throwable cycling → item use →
 * throw/cook. Item use and throwables exclude each other: starting a use puts an idle/ready throwable away, a pulled pin
 * blocks starting a use, and any throwable key/fire/reload/jump/switch interrupts a use.
 */
export function stepPlayerEquipment(state: PlayerEquipmentState, input: EquipmentInput, ctx: EquipmentContext, dt: number): PlayerEquipmentStepResult {
  const events: PlayerEquipmentEvent[] = [];
  const vitalsStep = stepVitals(state.vitals, dt);
  events.push(...vitalsStep.events);
  let vitals = vitalsStep.vitals;
  let inventory = state.inventory;

  const pinPulled = state.throw.phase === "primed" || state.throw.phase === "cooking";
  if (input.cycleThrowablePressed && !pinPulled) {
    const cycled = cycleThrowable(inventory);
    if (cycled.selectedThrowable !== inventory.selectedThrowable) events.push({ type: "throwableSelected", kind: cycled.selectedThrowable });
    inventory = cycled;
  }

  const use = stepItemUse(
    state.use,
    {
      start: pinPulled ? null : input.useItem,
      interrupt: input.firePressed || input.reloadPressed || input.jumpPressed || input.equipThrowablePressed || input.holsterPressed || input.weaponSelectPressed,
      sprint: input.sprint,
    },
    inventory,
    vitals,
    dt,
  );
  events.push(...use.events);
  inventory = use.inventory;
  vitals = use.vitals;

  const selected = inventory.selectedThrowable;
  const throwStep = stepThrow(
    state.throw,
    {
      equip: input.equipThrowablePressed,
      fire: input.fire && use.state.itemId === null,
      aim: input.aim,
      cook: input.reloadPressed,
      holster: input.holsterPressed || input.weaponSelectPressed,
    },
    {
      eye: ctx.eye,
      yaw: ctx.yaw,
      pitch: ctx.pitch,
      velocity: ctx.velocity,
      selected,
      carried: selected ? countItem(inventory, selected) : 0,
      canAct: vitals.life === "alive" && use.state.itemId === null,
    },
    dt,
  );
  events.push(...throwStep.events);

  let release = throwStep.release;
  if (release) {
    const removed = removeStack(inventory, release.kind, 1);
    if (removed.ok) inventory = removed.inventory;
    else release = null;
  }

  return { state: { inventory, throw: throwStep.state, use: use.state, vitals }, release, events };
}

export interface EquipmentModifiers {
  /** Multiplier on ground speed (can exceed 1 with boost). */
  readonly speedScale: number;
  readonly allowSprint: boolean;
  readonly allowJump: boolean;
  /** Guns may fire and aim (false while downed, using an item or holding a throwable). */
  readonly allowWeapons: boolean;
  /** Downed: the movement code should use a prone/crawl capsule. */
  readonly crawl: boolean;
}

/**
 * Movement and weapon gates derived from tick state (not render state), so prediction and the server agree
 * (docs/backend/architecture.md R3).
 */
export function deriveEquipmentModifiers(state: PlayerEquipmentState): EquipmentModifiers {
  const { vitals } = state;
  if (vitals.life === "dead") return { speedScale: 0, allowSprint: false, allowJump: false, allowWeapons: false, crawl: false };
  if (vitals.life === "downed") {
    return { speedScale: VITALS.crawlSpeed / MOVEMENT.walkSpeed, allowSprint: false, allowJump: false, allowWeapons: false, crawl: true };
  }
  const boost = boostSpeedScale(vitals.boost);
  if (state.use.itemId !== null) return { speedScale: VITALS.useSpeedScale * boost, allowSprint: false, allowJump: false, allowWeapons: false, crawl: false };
  const phase = state.throw.phase;
  const pinPulled = phase === "primed" || phase === "cooking";
  return { speedScale: boost, allowSprint: !pinPulled, allowJump: true, allowWeapons: phase === "idle", crawl: false };
}

// ---------------------------------------------------------------------------------------------------------------
// World: throwables in flight, detonations and area effects
// ---------------------------------------------------------------------------------------------------------------

export interface EquipmentWorld {
  readonly throwables: ThrowableSet;
  smokes: readonly SmokeCloud[];
  fires: readonly FirePatch[];
  /** Match seed; smoke and fire shapes are seeded from it and the throwable id. */
  readonly seed: number;
}

export function createEquipmentWorld(seed: number, capacity = 64): EquipmentWorld {
  return { throwables: createThrowableSet(capacity), smokes: [], fires: [], seed };
}

/** An entity area effects can reach: feet/posture for damage, eye and look direction for flashes. */
export interface WorldEntity extends EntitySample {
  readonly eye: Vec3;
  readonly viewDir: Vec3;
}

/** Damage an area effect wants applied; route it through applyDamage (players) or the target's own handler. */
export interface DamageRequest {
  readonly targetId: number;
  readonly sourceId: number;
  readonly amount: number;
  readonly kind: DamageKind;
  readonly position: Vec3;
}

export type EquipmentWorldEvent =
  | ThrowableSimEvent
  | { readonly type: "smokeSpawned"; readonly cloud: SmokeCloud }
  | { readonly type: "smokeExpired"; readonly id: number }
  | { readonly type: "fireSpawned"; readonly patch: FirePatch }
  | { readonly type: "fireExpired"; readonly id: number }
  | { readonly type: "damage"; readonly request: DamageRequest; readonly explosion: ExplosionHit | null }
  | { readonly type: "flashed"; readonly targetId: number; readonly sourceId: number; readonly exposure: FlashExposure };

/** Spawns a released throwable at the wall-resolved hand position. Returns its id, or -1 if the world is full. */
export function spawnRelease(world: EquipmentWorld, release: ThrowRelease, owner: number, ownerSlot: number, raycast: RaycastFn): number {
  const id = throwId(ownerSlot, release.throwCounter);
  const position = release.style === "inHand" ? release.hand : resolveThrowOrigin(release.eye, release.hand, raycast);
  const index = spawnThrowable(world.throwables, { id, owner, kind: release.kind, position, velocity: release.velocity, fuse: release.fuse });
  return index < 0 ? -1 : id;
}

/**
 * World equipment tick: flies throwables, resolves detonations (frag damage with occlusion, smoke clouds, flash
 * exposure, molotov fire patches), ages area effects and emits fire damage ticks. Friendly fire and self damage are on:
 * every entity in range gets a request. `raycast` must see static world geometry only (no player capsules or hitboxes).
 */
export function stepEquipmentWorld(world: EquipmentWorld, dt: number, raycast: RaycastFn, entities: readonly WorldEntity[], events: EquipmentWorldEvent[]): void {
  const simEvents: ThrowableSimEvent[] = [];
  stepThrowables(world.throwables, dt, raycast, simEvents);

  let smokes = world.smokes.map((cloud) => stepSmokeCloud(cloud, dt));
  let fires = world.fires;

  for (const event of simEvents) {
    events.push(event);
    if (event.type !== "detonate") continue;
    const seed = hash32(world.seed, event.id);
    switch (event.kind) {
      case "frag": {
        const origin = blastOrigin(event.position, event.normal);
        for (const hit of computeExplosionHits(origin, EXPLOSION.frag, entities, raycast)) {
          const request: DamageRequest = { targetId: hit.targetId, sourceId: event.owner, amount: hit.amount, kind: "explosion", position: origin };
          events.push({ type: "damage", request, explosion: hit });
        }
        break;
      }
      case "smoke": {
        const cloud = createSmokeCloud(event.id, event.position, seed, raycast);
        smokes = [...smokes, cloud];
        events.push({ type: "smokeSpawned", cloud });
        break;
      }
      case "flash": {
        const origin = blastOrigin(event.position, event.normal);
        for (const entity of entities) {
          const occluded = raycast(origin, entity.eye) !== null;
          const exposure = flashExposure(entity.eye, entity.viewDir, origin, occluded);
          if (exposure.blind > 0 || exposure.deaf > 0) events.push({ type: "flashed", targetId: entity.id, sourceId: event.owner, exposure });
        }
        break;
      }
      case "molotov": {
        const patch = createFirePatch(event.id, event.owner, event.position, event.normal, seed, raycast);
        if (patch) {
          fires = [...fires, patch];
          events.push({ type: "fireSpawned", patch });
        }
        break;
      }
    }
  }

  const liveSmokes: SmokeCloud[] = [];
  for (const cloud of smokes) {
    if (isSmokeExpired(cloud)) events.push({ type: "smokeExpired", id: cloud.id });
    else liveSmokes.push(cloud);
  }

  const liveFires: FirePatch[] = [];
  for (const existing of fires) {
    // Patches spawned this tick start aging next tick.
    const fresh = !world.fires.includes(existing);
    const { patch, damageTick } = fresh ? { patch: existing, damageTick: false } : stepFirePatch(existing, dt);
    if (damageTick) {
      for (const targetId of fireDamageTargets(patch, entities)) {
        const entity = entities.find((e) => e.id === targetId)!;
        const request: DamageRequest = { targetId, sourceId: patch.owner, amount: FIRE.damagePerTick, kind: "fire", position: entity.feet };
        events.push({ type: "damage", request, explosion: null });
      }
    }
    if (isFireExpired(patch)) events.push({ type: "fireExpired", id: patch.id });
    else liveFires.push(patch);
  }

  world.smokes = liveSmokes;
  world.fires = liveFires;
}
