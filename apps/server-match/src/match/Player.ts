import { NET_WEAPON_LOADOUT } from "@twobullets/contracts";
import { ServerInputBuffer, type Session } from "@twobullets/netcode";
import { quantizeYaw } from "@twobullets/shared/aim";
import { NO_ARMOR, type ArmorLoadout } from "@twobullets/shared/equipment/armor";
import { createInventory, type InventoryState } from "@twobullets/shared/equipment/inventory";
import { IDLE_ITEM_USE, type ItemUseState } from "@twobullets/shared/equipment/itemUse";
import { createVitals, type LifeState, type Vitals } from "@twobullets/shared/equipment/vitals";
import type { PlayerState } from "@twobullets/shared/input";
import { createMoveState } from "@twobullets/shared/movement/movement";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import type { PlayerBody } from "@twobullets/sim";
import { ViewDelayEstimator } from "../hitreg/ViewDelay";
import { ClientReplication, type ReplicatedPlayer } from "../snapshot/SnapshotBuilder";
import type { BotSeat } from "../bots/ServerBots";
import { LootViewer } from "./ServerLoot";
import { ThrowableViewer } from "./ServerThrowables";
import { WallViewer } from "./ServerWalls";

// One slot's character and connection state on the match server. Movement/weapon state is predicted by the client;
// vitals, armor and the inventory are server-owned (replicated in the owner vitals and items groups and remote flags).

export interface PlayerCombatStats {
  kills: number;
  knocks: number;
  damageDealt: number;
  deaths: number;
  revives: number;
}

/** 18-bit pitch of a level gaze (shared aim.ts: q = 2^17 − 1 is exactly 0). */
export const LEVEL_PITCH_Q = (1 << 17) - 1;

export function freshPlayerState(): PlayerState {
  return { move: createMoveState(), weapon: createWeaponState(NET_WEAPON_LOADOUT) };
}

export class Player implements ReplicatedPlayer {
  readonly slot: number;
  readonly teamId: number;
  readonly accountId: string;
  readonly body: PlayerBody;
  readonly spawn: { readonly feet: Vec3; readonly yaw: number };
  readonly inputs = new ServerInputBuffer();
  readonly net = new ClientReplication();
  readonly viewDelay = new ViewDelayEstimator();
  readonly combat: PlayerCombatStats = { kills: 0, knocks: 0, damageDealt: 0, deaths: 0, revives: 0 };
  state: PlayerState;
  vitals: Vitals = createVitals();
  armor: ArmorLoadout = NO_ARMOR;
  /**
   * Everything carried (B5): weapons with magazines, ammo, armor (mirrored in `armor`), backpack and consumables. Weapon
   * slots and reserves follow it every tick (`syncWeaponsFromInventory`); ServerLoot and ServerItems change it.
   */
  inventory: InventoryState = createInventory();
  /** The inventory object the weapon state last matched (synced or committed); a different one triggers a sync. */
  weaponInventory: InventoryState | null = null;
  /** Loot area of interest of this player's client (ServerLoot). */
  readonly lootView = new LootViewer();
  /** Throwable and area-effect area of interest of this player's client (ServerThrowables, protocol v9). */
  readonly throwView = new ThrowableViewer();
  /** Destructible walls this client has been told about (ServerWalls, protocol v10). */
  readonly wallView = new WallViewer();
  /** Names this player's throws (`throwId(slot, counter)`); wraps at 16 bits like the shared id. */
  throwCounter = 0;
  use: ItemUseState = IDLE_ITEM_USE;
  /** Buttons of the last input ServerItems saw (press edges). */
  itemButtons = 0;
  /** Server tick of death, −1 while alive or downed. */
  deathTick = -1;
  /** Downed teammate this player is reviving, or −1. */
  reviveTarget = -1;
  /** Last tick interact was held (revive grace for lost inputs). */
  lastInteractTick = -Infinity;
  /** The next lag-comp record is a teleport (spawn, respawn, debug placement). */
  poseDiscontinuous = true;
  epoch = 0;
  yawQ = 0;
  pitchQ = LEVEL_PITCH_Q;
  buttons = 0;
  session: Session | null = null;
  /** Server bot driving this slot's input buffer (never has a session), or null for a human. */
  bot: BotSeat | null = null;
  /** Roster name: the join token's nickname (else the account id); unused for bots. */
  name = "";
  /** Roster revision last sent to this player's session. */
  rosterSent = -1;
  lastRecvMs = 0;
  disconnectedAtMs = -1;
  rateWindowStartMs = 0;
  rateWindowCount = 0;
  abusiveWindows = 0;

  constructor(slot: number, teamId: number, accountId: string, body: PlayerBody, spawn: { feet: Vec3; yaw: number }) {
    this.slot = slot;
    this.teamId = teamId;
    this.accountId = accountId;
    this.body = body;
    this.spawn = spawn;
    this.state = freshPlayerState();
    this.yawQ = quantizeYaw(spawn.yaw);
  }

  get feet(): Readonly<Vec3> {
    return this.body.feet;
  }

  /** RulesActor (shared/match/rules). */
  get team(): number {
    return this.teamId;
  }

  get life(): LifeState {
    return this.vitals.life;
  }

  get health(): number {
    return this.vitals.health;
  }
}
