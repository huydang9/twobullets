import { dequantizePitch, dequantizeYaw } from "../../aim";
import { MOVEMENT } from "../../constants";
import { deriveEquipmentModifiers } from "../../equipment/equipmentStep";
import { createInventory, type InventoryStack, type WeaponItemState } from "../../equipment/inventory";
import { IDLE_ITEM_USE } from "../../equipment/itemUse";
import type { ItemId } from "../../equipment/items";
import type { LootItem } from "../../equipment/loot";
import type { SmokeCloud } from "../../equipment/smoke";
import { createThrowState } from "../../equipment/throw";
import { createVitals, type LifeState, type Vitals } from "../../equipment/vitals";
import { weaponStateFromInventory } from "../../equipment/weaponLoadout";
import { Btn } from "../../input";
import type { ZoneState } from "../../match/types";
import { createMoveState } from "../../movement/movement";
import type { MoveState, Stance } from "../../movement/types";
import type { RaycastFn, WeaponId, WeaponState } from "../../weapons/types";
import { WEAPONS } from "../../weapons/weapons";
import type { BotBrain, BotTickOutput, BotWorldView, DamageTakenEvent, NavQuery, NoiseEvent, ThrowableView } from "../types";
import { FakeNavQuery } from "./fakeNav";
import type { MutVec3 } from "./util";

// Hand-built BotWorldView fixtures for brain tests: mutable self/actors/teammates, a kinematic stand-in for the
// movement step (axes → velocity at walk/sprint/crouch speed) and helpers to place enemies, teammates and loot.

export interface TestActor {
  slot: number;
  team: number;
  life: LifeState;
  feet: MutVec3;
  eye: MutVec3;
  velocity: MutVec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  sprinting: boolean;
  adsBlend: number;
  weaponId: WeaponId | null;
  lastShotTick: number;
}

export interface TestTeammate extends TestActor {
  kind: "human" | "bot";
  health: number;
  downedHealth: number;
  reviverSlot: number;
  healCount: number;
}

export interface TestSelf {
  slot: number;
  team: number;
  feet: MutVec3;
  eye: MutVec3;
  velocity: MutVec3;
  move: MoveState;
  aimYaw: number;
  aimPitch: number;
  vitals: Vitals;
  inventory: ReturnType<typeof createInventory>;
  weapon: WeaponState;
  throwState: ReturnType<typeof createThrowState>;
  use: typeof IDLE_ITEM_USE;
  modifiers: ReturnType<typeof deriveEquipmentModifiers>;
}

export interface TestWorldOptions {
  readonly slot?: number;
  readonly team?: number;
  readonly x?: number;
  readonly z?: number;
  readonly yaw?: number;
  readonly weapons?: readonly (WeaponId | null)[];
  readonly stacks?: readonly InventoryStack[];
  readonly health?: number;
  readonly raycast?: RaycastFn;
  readonly nav?: NavQuery;
  readonly zone?: ZoneState;
}

export const OPEN_ZONE: ZoneState = { phaseIndex: 0, stage: "idle", current: { cx: 0, cz: 0, r: 355 }, next: null, dps: 0, ticksToChange: 0, phase: null };

export function eyeHeightFor(stance: Stance): number {
  return stance === "prone" ? MOVEMENT.proneEyeHeight : stance === "crouch" ? MOVEMENT.crouchEyeHeight : MOVEMENT.standEyeHeight;
}

export class TestWorld {
  readonly self: TestSelf;
  readonly actors: TestActor[] = [];
  readonly teammates: TestTeammate[] = [];
  readonly noises: NoiseEvent[] = [];
  readonly damageTaken: DamageTakenEvent[] = [];
  readonly throwables: ThrowableView[] = [];
  readonly smokes: SmokeCloud[] = [];
  readonly loot: LootItem[] = [];
  readonly nav: NavQuery;
  readonly out: BotTickOutput;
  /** Slot returned by actorOnSegment (friendly-fire tests), or a function. */
  segmentActor: (from: MutVec3, to: MutVec3) => number = () => -1;
  view: BotWorldView;
  tick = 0;
  raycast: RaycastFn;
  zone: ZoneState;
  phase: BotWorldView["phase"] = "combat";

  constructor(options: TestWorldOptions = {}) {
    const x = options.x ?? 0;
    const z = options.z ?? 0;
    const weapons = (options.weapons ?? ["rifle", null, null]).map((id): WeaponItemState | null => (id ? { weaponId: id, magazine: WEAPONS[id].magazineSize } : null));
    const inventory = createInventory({
      weapons: [weapons[0] ?? null, weapons[1] ?? null, weapons[2] ?? null],
      stacks: options.stacks ?? [{ itemId: "ammo_556", quantity: 120 }],
    });
    const vitals = { ...createVitals(), health: options.health ?? 100 };
    const equipment = { inventory, throw: createThrowState(), use: IDLE_ITEM_USE, vitals };
    this.self = {
      slot: options.slot ?? 2,
      team: options.team ?? 1,
      feet: { x, y: 0, z },
      eye: { x, y: MOVEMENT.standEyeHeight, z },
      velocity: { x: 0, y: 0, z: 0 },
      move: { ...createMoveState(), grounded: true },
      aimYaw: options.yaw ?? 0,
      aimPitch: 0,
      vitals,
      inventory,
      weapon: weaponStateFromInventory(inventory, { ammoFromInventory: true }),
      throwState: createThrowState(),
      use: IDLE_ITEM_USE,
      modifiers: deriveEquipmentModifiers(equipment),
    };
    this.raycast = options.raycast ?? (() => null);
    this.nav = options.nav ?? new FakeNavQuery();
    this.zone = options.zone ?? OPEN_ZONE;
    this.out = {
      input: { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null },
      intents: { cycleThrowable: false, holster: false, replaceSlot: -1, reviveSlot: -1 },
    };
    this.view = this.buildView();
  }

  private buildView(): BotWorldView {
    const world = this;
    return {
      get tick() {
        return world.tick;
      },
      dt: 1 / 60,
      matchSeed: 1234,
      get phase() {
        return world.phase;
      },
      self: this.self,
      teammates: this.teammates,
      actors: this.actors,
      noises: this.noises,
      damageTaken: this.damageTaken,
      throwables: this.throwables,
      smokes: this.smokes,
      get zone() {
        return world.zone;
      },
      teamsInPlay: 5,
      actorsInPlay: 10,
      get raycast() {
        return world.raycast;
      },
      nav: this.nav,
      queryLoot(center, radius, out) {
        out.length = 0;
        const sorted = world.loot
          .map((item) => ({ item, d: Math.sqrt((item.position[0] - center.x) ** 2 + (item.position[1] - center.y) ** 2 + (item.position[2] - center.z) ** 2) }))
          .filter((e) => e.d <= radius)
          .sort((a, b) => a.d - b.d);
        for (const e of sorted) out.push(e.item);
        return out.length;
      },
      actorOnSegment(from, to) {
        return world.segmentActor(from as MutVec3, to as MutVec3);
      },
    };
  }

  addActor(slot: number, team: number, x: number, z: number, init: Partial<Omit<TestActor, "slot" | "team">> = {}): TestActor {
    const stance = init.stance ?? "stand";
    const actor: TestActor = {
      slot,
      team,
      life: init.life ?? "alive",
      feet: { x, y: 0, z },
      eye: { x, y: eyeHeightFor(stance), z },
      velocity: init.velocity ?? { x: 0, y: 0, z: 0 },
      yaw: init.yaw ?? 0,
      pitch: 0,
      stance,
      sprinting: init.sprinting ?? false,
      adsBlend: init.adsBlend ?? 0,
      weaponId: init.weaponId ?? "rifle",
      lastShotTick: init.lastShotTick ?? -1,
    };
    this.actors.push(actor);
    return actor;
  }

  addTeammate(slot: number, x: number, z: number, init: Partial<Omit<TestTeammate, "slot" | "team">> = {}): TestTeammate {
    const base = this.addActor(slot, this.self.team, x, z, init);
    const mate: TestTeammate = Object.assign(base, {
      kind: init.kind ?? "bot",
      health: init.health ?? 100,
      downedHealth: init.downedHealth ?? 0,
      reviverSlot: init.reviverSlot ?? -1,
      healCount: init.healCount ?? 0,
    });
    this.teammates.push(mate);
    return mate;
  }

  addLoot(lootId: number, itemId: ItemId, x: number, z: number, quantity = 1): LootItem {
    const item: LootItem = { lootId, pileId: lootId, itemId, quantity, position: [x, 0, z], ...(itemId.startsWith("weapon_") ? { magazine: 0 } : {}) };
    this.loot.push(item);
    return item;
  }

  moveActor(actor: TestActor, dt: number): void {
    actor.feet.x += actor.velocity.x * dt;
    actor.feet.z += actor.velocity.z * dt;
    actor.eye.x = actor.feet.x;
    actor.eye.z = actor.feet.z;
    actor.eye.y = actor.feet.y + eyeHeightFor(actor.stance);
  }

  /**
   * Runs `ticks` brain ticks. With `move`, the bot's feet follow its axes at walk/sprint/crouch speed and its aim
   * follows the quantized yaw/pitch (no collision). `onTick` runs before each brain tick.
   */
  run(brain: BotBrain, ticks: number, options: { move?: boolean; onTick?: (world: TestWorld) => void; nav?: boolean } = {}): void {
    const dt = this.view.dt;
    for (let i = 0; i < ticks; i++) {
      options.onTick?.(this);
      if (options.nav !== false && this.nav instanceof FakeNavQuery) this.nav.update(1500);
      brain.tick(this.view, this.out);
      const input = this.out.input;
      const self = this.self;
      self.aimYaw = dequantizeYaw(input.yawQ);
      self.aimPitch = dequantizePitch(input.pitchQ);
      if (options.move !== false) {
        const crouch = (input.buttons & Btn.crouch) !== 0;
        const sprint = (input.buttons & Btn.sprint) !== 0 && !crouch;
        const speed = crouch ? MOVEMENT.crouchSpeed : sprint ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
        let f: number = input.forward;
        let r: number = input.right;
        const len = Math.sqrt(f * f + r * r);
        if (len > 1) {
          f /= len;
          r /= len;
        }
        const s = Math.sin(self.aimYaw);
        const c = Math.cos(self.aimYaw);
        self.velocity.x = (f * s + r * c) * speed;
        self.velocity.z = (f * c - r * s) * speed;
        self.feet.x += self.velocity.x * dt;
        self.feet.z += self.velocity.z * dt;
        self.move = { ...self.move, stance: crouch ? "crouch" : "stand", velocity: self.velocity };
        self.eye.x = self.feet.x;
        self.eye.z = self.feet.z;
        self.eye.y = self.feet.y + eyeHeightFor(self.move.stance);
      }
      for (const actor of this.actors) this.moveActor(actor, dt);
      this.noises.length = 0;
      this.damageTaken.length = 0;
      this.tick++;
    }
  }
}
