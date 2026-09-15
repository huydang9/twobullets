import type { JoinClaims, MatchConfig, MatchPhase, MatchResult } from "@twobullets/contracts";
import { isBotAccountId } from "@twobullets/contracts/claims";
import type { Clock, Session } from "@twobullets/netcode";
import { writeOwnerMove } from "@twobullets/netcode/replication";
import {
  CONTENT_HASH,
  copyPlayerInput,
  createBitReader,
  createBitWriter,
  createInputPacketBuffer,
  createMutablePlayerInput,
  decodeInputPacketInto,
  decodePing,
  decodeResyncRequest,
  DisconnectReason,
  encodePing,
  encodeResyncResponse,
  encodeRoster,
  encodeWelcome,
  MsgId,
  PhaseCode,
  RESUME_TOKEN_BYTES,
  type Mutable,
  type OwnerMoveBlock,
  type RosterPlayer,
} from "@twobullets/protocol";
import { MOVEMENT } from "@twobullets/shared/constants";
import { withArmor } from "@twobullets/shared/equipment/inventory";
import { IDLE_ITEM_USE } from "@twobullets/shared/equipment/itemUse";
import { createNetStartingInventory } from "@twobullets/shared/equipment/presets";
import { commitWeaponsToInventory, syncWeaponsFromInventory, weaponStateFromInventory, type WeaponLoadoutOptions } from "@twobullets/shared/equipment/weaponLoadout";
import { createVitals, VITALS } from "@twobullets/shared/equipment/vitals";
import { Btn, PlayerActionType, type MoveGates, type PlayerInput } from "@twobullets/shared/input";
import { createMoveState, fallDamage } from "@twobullets/shared/movement/movement";
import type { Stance, Vec3 } from "@twobullets/shared/movement/types";
import { createZoneState } from "@twobullets/shared/match/zone";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import type { BotBrainFactory } from "@twobullets/shared/bots/types";
import type { BrPhase } from "@twobullets/shared/match/types";
import { stepPlayer, type HavokModule, type ServerLevel, type SimWorld, type StepOptions } from "@twobullets/sim";
import { createHmac } from "node:crypto";
import type { AttachResult, Match } from "../host/MatchHost";
import { disconnectSession } from "../session/control";
import { ServerBots } from "../bots/ServerBots";
import { arenaMatchLevel, type MatchLevel, type MatchNav } from "../level/serverLevel";
import { SnapshotBuilder } from "../snapshot/SnapshotBuilder";
import { BrLifecycle, type BrLifecycleOptions, type LifecycleHost } from "./BrLifecycle";
import { freshPlayerState, Player } from "./Player";
import { ServerCombat, type CombatHost, type ServerCombatOptions } from "./ServerCombat";
import { ServerItems } from "./ServerItems";
import { ServerLoot } from "./ServerLoot";
import { chooseSlot, matchSlotCount, matchTeamCount, matchTeamSize } from "./slots";

// One match: slots/teams, per-client input rings, one Havok world, server-authoritative movement, weapons, hit
// registration and vitals (ServerCombat), and snapshots. Lifecycle (contracts MatchPhase): Booting (sim world loading) →
// Allocated (ready, accepting joins) → Warmup → Ended. With `lifecycle` (agent mode, `--flow=br`) the battle royale loop
// runs (BrLifecycle): Warmup → LandingSelect → Glide → Combat → Ended/Cancelled, then the match closes itself.
// Server bots (ServerBots) take the roster's `bot:<n>` seats when the world is ready and, with `rules.fillWithBots` in a BR
// match, every slot still empty when warmup ends; their brains write into the same input buffers humans' packets do.
// Loot and inventory (B5, ServerLoot): the level's generated loot minus throwables, replicated per client by area of
// interest; everyone (bots too) spawns with the networked starting kit, and weapon slots, magazines and reserves follow
// the inventory every tick. A death drops the inventory as a pile; BR glide start restores the generated loot.
// Roster: a joining session gets it right after Welcome; any other change (join, leave, bot fill, grace expiry) bumps a
// revision that is sent once at the end of the tick to every session behind it.

export interface ServerMatchOptions {
  readonly config: MatchConfig;
  readonly havok: HavokModule;
  /** A match level (`resolveServerLevel`), or a blockout `LevelData` (the arena). */
  readonly level: MatchLevel | ServerLevel;
  readonly clock: Clock;
  /** Tick number the host will run next; inputs are unwrapped against it until the first tick. */
  readonly startTick: number;
  /** Key for Welcome.resumeToken (HMAC-SHA256/128, netcode.md §7.4). */
  readonly resumeSecret: Uint8Array;
  readonly tickRate?: number;
  /** No datagram or stream message for this long → Disconnect{timeout}. */
  readonly idleTimeoutMs?: number;
  /** A disconnected character stays in the world this long (join-token reconnect window, ADR 0106). */
  readonly reconnectGraceMs?: number;
  /** Datagrams per second above which extra datagrams are dropped (D18: 72/s), and the kick threshold (180/s). */
  readonly datagramRateLimit?: number;
  readonly datagramKickRate?: number;
  /** Combat overrides (tests): damage toggle, spawn armor. */
  readonly combat?: Partial<Pick<ServerCombatOptions, "damageEnabled" | "spawnArmor">>;
  readonly onPlayer?: (accountId: string, event: "joined" | "left") => void;
  /** Battle royale loop; omitted = M4 sandbox (endless warmup with damage and respawns). */
  readonly lifecycle?: BrLifecycleOptions | null;
  /** Every lifecycle phase change after Booting. */
  readonly onPhase?: (phase: MatchPhase) => void;
  /** BR only: the final result, once (completed, cancelled or aborted). */
  readonly onResult?: (result: MatchResult) => void;
  /** The match closed (end linger over, cancelled or aborted); every session is gone. */
  readonly onClosed?: () => void;
  /** Debug/test hook, runs at the end of every tick. */
  readonly onTickEnd?: (tick: number, match: ServerMatch) => void;
  /** Bot brain override (tests). Default: the shared `createBotBrain`. */
  readonly botBrainFactory?: BotBrainFactory;
}

export interface MatchStats {
  inputsMalformed: number;
  datagramsRateLimited: number;
  kicks: number;
}

/** Body blocking is a product rule, but T3.1's CharacterBody still excludes CollisionLayer.player from movement. */
const BODY_BLOCKING_SUPPORTED = false;
/** Alive: open gates, weapons on. */
const STEP_ALIVE: StepOptions = { replay: false, weapons: true };
/** Knocked: prone crawl, no sprint or jump; combat buttons are cleared before the step (client mirrors both). */
export const DOWNED_GATES: MoveGates = { speedScale: VITALS.crawlSpeed / MOVEMENT.walkSpeed, allowSprint: false, allowJump: false, crawl: true };
const STEP_DOWNED: StepOptions = { replay: false, weapons: true, gates: DOWNED_GATES };
const COMBAT_BUTTONS = Btn.fire | Btn.aim | Btn.reload;
const INTERP_FLOOR_WS_MS = 50;
const INTERP_FLOOR_WT_MS = 25;
const MAX_REWIND_MS = 200;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
/** Reserve = the weapon's ammo in the inventory; reloads consume it (offline MatchSim's LOADOUT). */
const NET_LOADOUT: WeaponLoadoutOptions = { ammoFromInventory: true };
const BOT_PHASE: Readonly<Record<BrLifecycle["phase"], BrPhase>> = { Warmup: "warmup", LandingSelect: "landing", Glide: "glide", Combat: "combat", End: "ended" };
const PHASE_CODES = { Warmup: PhaseCode.Warmup, LandingSelect: PhaseCode.LandingSelect, Glide: PhaseCode.Glide, Combat: PhaseCode.Combat, End: PhaseCode.End } as const;

export class ServerMatch implements Match, CombatHost {
  readonly id: string;
  readonly config: MatchConfig;
  readonly ready: Promise<void>;
  readonly stats: MatchStats = { inputsMalformed: 0, datagramsRateLimited: 0, kicks: 0 };
  readonly snapshots: SnapshotBuilder;
  /** Consumable use and boost (humans carry the offline kit's heals and boosts). */
  readonly items = new ServerItems(TICK_SECONDS);
  /** Null until the sim world is ready. */
  combat: ServerCombat | null = null;
  /** Ground loot and inventory actions; null until the sim world is ready. */
  loot: ServerLoot | null = null;
  /** Null in the sandbox and until the world is ready. */
  lifecycle: BrLifecycle | null = null;
  /** Null when the match has no bot seats (and can't fill any), and until the world is ready. */
  bots: ServerBots | null = null;
  /** Bot nav built for this match (grid build ms, or a cached/fake nav); null without bots. */
  navInfo: Omit<MatchNav, "nav"> | null = null;
  readonly level: MatchLevel;
  private phaseValue: MatchPhase = "Booting";
  private closed = false;
  private world: SimWorld | null = null;
  private readonly options: ServerMatchOptions;
  private readonly clock: Clock;
  readonly slots: (Player | null)[];
  /** Dense, sorted by slot; rebuilt only on join/leave. */
  private active: Player[] = [];
  private readonly byAccount = new Map<string, Player>();
  private readonly bySession = new Map<Session, Player>();
  private readonly spawnPlans: readonly { readonly feet: readonly Vec3[]; readonly yaw: number }[];
  private readonly reader = createBitReader(new Uint8Array(0));
  private readonly packet = createInputPacketBuffer();
  private readonly gatedInput = createMutablePlayerInput();
  private readonly gatedAction: { type: PlayerActionType; arg: number } = { type: PlayerActionType.pickup, arg: 0 };
  private readonly datagramWriter = createBitWriter(64);
  private readonly controlWriter = createBitWriter(128);
  /** Roster: 2 B + ≤ 27 B per slot. */
  private readonly rosterWriter = createBitWriter(600);
  private rosterRevision = 0;
  private readonly idleTimeoutMs: number;
  private readonly graceMs: number;
  private readonly rateLimit: number;
  private readonly kickRate: number;
  private readonly tickMs: number;
  private next: number;
  private lastTickStartMs = NaN;
  private lastSweepMs = 0;

  constructor(options: ServerMatchOptions) {
    this.options = options;
    this.config = options.config;
    this.id = options.config.matchId;
    this.clock = options.clock;
    this.next = options.startTick;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
    this.graceMs = options.reconnectGraceMs ?? 60_000;
    this.rateLimit = options.datagramRateLimit ?? 72;
    this.kickRate = options.datagramKickRate ?? 180;
    this.tickMs = 1000 / (options.tickRate ?? 60);
    const maxSlots = matchSlotCount(options.config);
    const teamSize = matchTeamSize(options.config);
    const teamCount = matchTeamCount(options.config);
    this.level = "createWorld" in options.level ? options.level : arenaMatchLevel(options.level);
    this.slots = new Array<Player | null>(maxSlots).fill(null);
    this.snapshots = new SnapshotBuilder(maxSlots);
    this.spawnPlans = this.level.planTeamSpawns(options.config.matchSeed, teamCount, teamSize);
    this.ready = this.level.createWorld(options.havok).then((world) => {
      this.world = world;
      const combat = new ServerCombat({ ...options.combat, rules: options.config.rules, maxSlots, raycastWorld: world.raycastWorld, tickRate: options.tickRate });
      combat.attach(this, teamCount, teamSize);
      this.combat = combat;
      const loot = new ServerLoot({ items: this.level.createLoot?.(options.config.matchSeed >>> 0) ?? [], raycastWorld: world.raycastWorld, players: () => this.active, seed: options.config.matchSeed >>> 0 });
      this.loot = loot;
      combat.onKilled = (victim) => loot.dropInventory(victim);
      if (this.phaseValue !== "Booting") return;
      if (this.needsBots()) this.startBots(world, combat);
      if (options.lifecycle) {
        this.lifecycle = new BrLifecycle(this.lifecycleHost(combat, teamCount, teamSize), options.lifecycle, this.clock.now(), this.next);
        this.setPhase("Warmup");
      } else {
        this.setPhase("Allocated");
      }
    });
  }

  get phase(): MatchPhase {
    return this.phaseValue;
  }

  /** Next tick to simulate (inputs for earlier ticks are late). */
  get nextTick(): number {
    return this.next;
  }

  get playerCount(): number {
    return this.active.length;
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.active) if (p.session !== null) n++;
    return n;
  }

  get freeSlots(): number {
    return this.slots.length - this.active.length;
  }

  get players(): readonly Player[] {
    return this.active;
  }

  /** The player in `slot` (tests, debug tooling). */
  player(slot: number): Player | null {
    return this.slots[slot] ?? null;
  }

  attach(session: Session, claims: JoinClaims): AttachResult {
    if (this.world === null || this.closed) return { ok: false, reason: this.closed ? DisconnectReason.matchEnded : DisconnectReason.internalError };
    const existing = this.byAccount.get(claims.sub);
    if (existing !== undefined) {
      if (existing.session !== null) {
        if (claims.epoch < existing.epoch) return { ok: false, reason: DisconnectReason.replaced };
        const old = existing.session;
        this.unbind(existing);
        disconnectSession(old, DisconnectReason.replaced);
      }
      this.bind(existing, session, claims);
      return { ok: true, slot: existing.slot, teamId: existing.teamId, resumed: true };
    }

    // BR: the roster is fixed once warmup is over; only players already in the match reconnect.
    if (this.lifecycle !== null && !this.lifecycle.acceptsNewPlayers) return { ok: false, reason: this.lifecycle.ended ? DisconnectReason.matchEnded : DisconnectReason.notAssigned };
    const choice = chooseSlot(this.config, claims, (slot) => this.slots[slot] !== null);
    if (!choice.ok) return { ok: false, reason: choice.reason === "matchFull" ? DisconnectReason.matchFull : DisconnectReason.notAssigned };
    const spawn = this.spawnFor(choice.slot);
    const player = new Player(choice.slot, choice.teamId, claims.sub, this.world.createBody(spawn.feet), spawn);
    this.equip(player);
    this.slots[choice.slot] = player;
    this.byAccount.set(claims.sub, player);
    this.rebuildActive();
    this.bind(player, session, claims);
    return { ok: true, slot: player.slot, teamId: player.teamId, resumed: false };
  }

  /** The transport closed (or the client left): the character stays in the world for the reconnect grace. */
  detach(session: Session): void {
    const player = this.bySession.get(session);
    if (player !== undefined) this.unbind(player);
  }

  tick(tick: number): void {
    const world = this.world;
    const combat = this.combat;
    if (world === null || combat === null || this.closed) return;
    if (this.phaseValue === "Allocated") this.setPhase("Warmup");
    this.lastTickStartMs = this.clock.now();
    const lifecycle = this.lifecycle;
    lifecycle?.beginTick(tick);
    const players = this.active;
    const frozen = lifecycle !== null && lifecycle.frozen;
    combat.beginTick(tick);
    const bots = this.bots;
    if (bots !== null && !frozen) {
      const phase: BrPhase = lifecycle === null ? "combat" : BOT_PHASE[lifecycle.phase];
      bots.beginTick(tick, players, phase, phase !== "combat");
    }
    if (BODY_BLOCKING_SUPPORTED && this.config.rules.bodyBlocking) this.syncBodiesForBlocking();
    const killY = this.level.killY;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const input = p.inputs.take(tick);
      // The dead are frozen (spectating): inputs still drain the buffer and ack, but nothing moves or aims. After the
      // match ends everyone is.
      if (p.life === "dead" || frozen) {
        this.items.stop(p);
        continue;
      }
      p.yawQ = input.yawQ;
      p.pitchQ = input.pitchQ;
      p.buttons = input.buttons;
      this.step(p, input, combat);
      this.items.step(p, input);
      this.loot?.act(p, input);
      if (p.body.feet.y < killY) combat.outOfBounds(p);
    }
    if (!frozen) combat.endTick(tick);
    lifecycle?.endTick(tick);
    this.next = tick + 1;
    if (this.closed) return;
    this.flushRoster();
    this.loot?.replicate(players);
    const now = this.clock.now();
    this.snapshots.build(tick, now, players, combat);
    if (now - this.lastSweepMs >= 1000) {
      this.lastSweepMs = now;
      this.sweep(now);
    }
    this.options.onTickEnd?.(tick, this);
  }

  /** Quantized owner block of a slot's current state (tests, debug tooling). */
  ownerBlockOf(slot: number, out: Mutable<OwnerMoveBlock>): boolean {
    const p = this.slots[slot];
    if (p === null || p === undefined) return false;
    writeOwnerMove(p.body.feet, p.state.move, out);
    return true;
  }

  /** Teleports a player (tests, debug tooling); the lag-comp history snaps across it. */
  debugPlace(slot: number, feet: Vec3, stance: Stance = "stand"): void {
    const p = this.slots[slot];
    if (!p) return;
    p.body.restore(feet, ZERO, stance);
    p.state = { move: { ...createMoveState(), stance, grounded: true }, weapon: p.state.weapon };
    p.poseDiscontinuous = true;
  }

  /**
   * Ends a BR match now (drain, SIGTERM): MatchEnd + result with outcome `cancelled` (warmup) or `aborted`, then closes
   * with `reason`. Sandbox matches just close.
   */
  abort(reason: DisconnectReason = DisconnectReason.serverShutdown): void {
    if (this.closed) return;
    this.closeReason = reason;
    if (this.lifecycle !== null) this.lifecycle.abort();
    else this.end(reason);
  }

  /** Sends Disconnect{reason} to everyone, disposes the world. */
  end(reason: DisconnectReason = DisconnectReason.matchEnded): void {
    if (this.closed) return;
    this.closed = true;
    if (this.phaseValue !== "Ended" && this.phaseValue !== "Cancelled") this.setPhase("Ended");
    for (const p of this.active) {
      const s = p.session;
      if (s !== null) {
        this.unbind(p);
        disconnectSession(s, reason);
      }
    }
    for (const p of this.active) p.body.dispose();
    this.active = [];
    this.slots.fill(null);
    this.byAccount.clear();
    this.combat?.projectiles.clear();
    this.world?.dispose();
    this.world = null;
    this.options.onClosed?.();
  }

  /** True once the match closed (sessions gone, world disposed). */
  get isClosed(): boolean {
    return this.closed;
  }

  private closeReason: DisconnectReason = DisconnectReason.matchEnded;

  private setPhase(phase: MatchPhase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    this.options.onPhase?.(phase);
  }

  private spawnFor(slot: number): { feet: Vec3; yaw: number } {
    const teamSize = matchTeamSize(this.config);
    const plan = this.spawnPlans[Math.floor(slot / teamSize)];
    const feet = plan?.feet[slot % teamSize] ?? plan?.feet[0];
    if (plan === undefined || feet === undefined) throw new Error(`no spawn for slot ${slot}`);
    return { feet: { x: feet.x, y: feet.y, z: feet.z }, yaw: plan.yaw };
  }

  private lifecycleHost(combat: ServerCombat, teamCount: number, teamSize: number): LifecycleHost {
    const match = this;
    return {
      config: this.config,
      get slots() {
        return match.slots;
      },
      get players() {
        return match.active;
      },
      combat,
      teamCount,
      teamSize,
      zone: this.level.zone,
      isValidZoneCenter: this.level.isValidZoneCenter,
      placeAtStart: (p) => this.respawn(p),
      resetLoot: () => this.loot?.reset(),
      fillBots: () => this.fillEmptySlotsWithBots(),
      lifecyclePhase: (phase) => this.setPhase(phase),
      result: (result) => this.options.onResult?.(result),
      close: () => this.end(this.closeReason),
    };
  }

  /** Server spawn, fresh loadout and vitals (M4 warmup respawn; CombatHost). */
  respawn(p: Player): void {
    p.body.restore(p.spawn.feet, ZERO, "stand");
    p.state = freshPlayerState();
    p.vitals = createVitals();
    this.equip(p);
    p.use = IDLE_ITEM_USE;
    p.deathTick = -1;
    p.reviveTarget = -1;
    p.buttons = 0;
    p.poseDiscontinuous = true;
    this.combat!.history.clear(p.slot);
    this.bots?.reset(p);
  }

  /** Spawn armor (tests), the networked starting kit and a weapon state drawn from it. */
  private equip(p: Player): void {
    p.armor = this.combat!.armorForSpawn();
    p.inventory = withArmor(createNetStartingInventory(), p.armor);
    p.state = { move: p.state.move, weapon: weaponStateFromInventory(p.inventory, NET_LOADOUT) };
    p.weaponInventory = p.inventory;
  }

  private needsBots(): boolean {
    if (this.options.lifecycle && this.config.rules.fillWithBots) return true;
    for (const t of this.config.teams) for (const id of t.accountIds) if (isBotAccountId(id)) return true;
    return false;
  }

  /** Nav for this match, the bot driver, and the roster's bot seats (slot = team · size + index in the team list). */
  private startBots(world: SimWorld, combat: ServerCombat): void {
    const made = this.level.createNav?.() ?? arenaMatchLevel().createNav!();
    this.navInfo = { buildMs: made.buildMs, kind: made.kind };
    const lifecycleZone = (): BrLifecycle["zoneState"] | null => this.lifecycle?.zoneState ?? null;
    const idleZone = idleZoneState(this.level);
    const bots = new ServerBots({
      matchSeed: this.config.matchSeed,
      maxSlots: this.slots.length,
      difficulty: this.config.botDifficulty,
      nav: made.nav,
      raycastWorld: world.raycastWorld,
      history: combat.history,
      zone: () => lifecycleZone() ?? idleZone,
      brainFactory: this.options.botBrainFactory,
      queryLoot: (center, radius, out) => this.loot?.queryLoot(center, radius, out) ?? 0,
    });
    this.bots = bots;
    combat.onDamage = (victim, attacker, amount, kind, dirX, dirZ) => bots.onDamage(victim, attacker, amount, kind, dirX, dirZ);
    combat.projectiles.onSegment = (shooter, weaponId, from, to, tEnd, struck) => bots.onSegment(shooter, weaponId, from, to, tEnd, struck);
    const teamSize = matchTeamSize(this.config);
    for (const team of this.config.teams) {
      team.accountIds.forEach((id, index) => {
        const slot = team.teamId * teamSize + index;
        if (isBotAccountId(id) && index < teamSize && slot < this.slots.length && this.slots[slot] === null) this.addBot(slot, id);
      });
    }
  }

  /** A bot player in `slot`: body at the slot's spawn, M4 loadout, brain attached. Bots never have a session. */
  private addBot(slot: number, accountId: string): Player {
    const spawn = this.spawnFor(slot);
    const player = new Player(slot, Math.floor(slot / matchTeamSize(this.config)), accountId, this.world!.createBody(spawn.feet), spawn);
    this.equip(player);
    this.slots[slot] = player;
    this.byAccount.set(accountId, player);
    this.rebuildActive();
    this.bots!.attach(player);
    this.rosterRevision++;
    return player;
  }

  /** BR warmup is over: bots take every slot nobody joined (`rules.fillWithBots`). Returns the bots added. */
  fillEmptySlotsWithBots(): number {
    if (this.bots === null || !this.config.rules.fillWithBots || this.world === null) return 0;
    let next = 0;
    for (const p of this.active) {
      if (!isBotAccountId(p.accountId)) continue;
      const n = Number(p.accountId.slice(p.accountId.indexOf(":") + 1));
      if (Number.isInteger(n) && n >= next) next = n + 1;
    }
    for (const t of this.config.teams) {
      for (const id of t.accountIds) {
        const n = isBotAccountId(id) ? Number(id.slice(id.indexOf(":") + 1)) : NaN;
        if (Number.isInteger(n) && n >= next) next = n + 1;
      }
    }
    let added = 0;
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (this.slots[slot] !== null) continue;
      let id = `bot:${next++}`;
      while (this.byAccount.has(id)) id = `bot:${next++}`;
      this.addBot(slot, id);
      added++;
    }
    return added;
  }

  private step(p: Player, input: PlayerInput, combat: ServerCombat): void {
    let options = STEP_ALIVE;
    let effective = input;
    if (p.life === "downed") {
      options = STEP_DOWNED;
      const gated = this.gatedInput;
      copyPlayerInput(input, gated, this.gatedAction);
      gated.buttons &= ~COMBAT_BUTTONS;
      gated.select = 0;
      effective = gated;
      p.buttons = gated.buttons;
    }
    // Loot actions changed the inventory since the weapons last matched it: slots, magazines and reserves follow.
    if (p.inventory !== p.weaponInventory) {
      const synced = syncWeaponsFromInventory(p.state.weapon, p.inventory, NET_LOADOUT).state;
      if (synced !== p.state.weapon) p.state = { move: p.state.move, weapon: synced };
    }
    const before = p.state.weapon;
    const result = stepPlayer(p.body, p.state, effective, TICK_SECONDS, options);
    p.state = result.state;
    // Magazines and spent reserve go back to the inventory; a changed inventory re-syncs next tick (two guns sharing an
    // ammo type see the rounds a reload took).
    const committed = commitWeaponsToInventory(before, result.state.weapon, p.inventory, NET_LOADOUT);
    if (committed === p.inventory) p.weaponInventory = committed;
    p.inventory = committed;
    const shots = result.shots;
    for (let k = 0; k < shots.length; k++) combat.fire(p, shots[k]!, input.viewOffset8);
    const events = result.events;
    for (let k = 0; k < events.length; k++) {
      const e = events[k]!;
      if (e.type === "landed") combat.landed(p, fallDamage(e.fallSpeed));
    }
    this.bots?.afterStep(p, shots, events);
  }

  /**
   * Hook for player body blocking (product rule ON). CharacterBody's MOVEMENT_COLLIDE_MASK excludes
   * CollisionLayer.player until SimWorld syncs other bodies before each step (T3.1 TODO). When that lands: move every
   * other player's Havok body to its current feet here (or between each player's step) and flip
   * BODY_BLOCKING_SUPPORTED. Replay on clients must then restore remote bodies too (netcode.md §1.3).
   */
  private syncBodiesForBlocking(): void {}

  private bind(player: Player, session: Session, claims: JoinClaims): void {
    player.session = session;
    player.epoch = claims.epoch;
    player.disconnectedAtMs = -1;
    player.lastRecvMs = this.clock.now();
    player.rateWindowStartMs = player.lastRecvMs;
    player.rateWindowCount = 0;
    player.abusiveWindows = 0;
    player.inputs.reset();
    player.net.reset(this.next - 1);
    player.viewDelay.reset();
    player.lootView.reset();
    player.name = typeof claims.nick === "string" && claims.nick.length > 0 ? claims.nick : claims.sub;
    this.bySession.set(session, player);
    session.onDatagram((bytes, recvMs) => this.onDatagram(player, session, bytes, recvMs));
    session.onStream((bytes) => this.onStream(player, session, bytes));
    this.sendWelcome(player, session);
    this.rosterRevision++;
    this.sendRoster([session]);
    player.rosterSent = this.rosterRevision;
    this.lifecycle?.onBound(player, session);
    this.options.onPlayer?.(player.accountId, "joined");
  }

  private unbind(player: Player): void {
    const session = player.session;
    if (session === null) return;
    this.bySession.delete(session);
    player.session = null;
    player.disconnectedAtMs = this.clock.now();
    this.rosterRevision++;
    this.options.onPlayer?.(player.accountId, "left");
  }

  private sendWelcome(player: Player, session: Session): void {
    const nowMs = this.clock.now();
    const mac = createHmac("sha256", this.options.resumeSecret)
      .update(`${this.id}|${player.slot}|${player.epoch}|${Math.floor(nowMs)}`)
      .digest()
      .subarray(0, RESUME_TOKEN_BYTES);
    const w = this.controlWriter;
    w.reset();
    encodeWelcome(w, {
      playerSlot: player.slot,
      teamId: player.teamId,
      teamSize: matchTeamSize(this.config),
      maxPlayers: this.slots.length,
      serverTick: this.next,
      tickRate: this.options.tickRate ?? 60,
      snapshotRate: this.options.tickRate ?? 60,
      matchSeed: this.config.matchSeed >>> 0,
      phase: this.lifecycle ? PHASE_CODES[this.lifecycle.phase] : PhaseCode.Warmup,
      phaseEndTick: this.lifecycle?.phaseEndTick ?? 0,
      maxRewindMs: MAX_REWIND_MS,
      interpFloorMs: session.kind === "websocket" ? INTERP_FLOOR_WS_MS : INTERP_FLOOR_WT_MS,
      resumeToken: mac,
      contentHash: CONTENT_HASH,
      flags: 0,
    });
    session.sendStream(w.bytes());
  }

  /** Sends the current roster to every session that hasn't seen this revision (at most once per change). */
  private flushRoster(): void {
    const revision = this.rosterRevision;
    let targets: Session[] | null = null;
    for (const p of this.active) {
      if (p.session === null || p.rosterSent === revision) continue;
      (targets ??= []).push(p.session);
      p.rosterSent = revision;
    }
    if (targets !== null) this.sendRoster(targets);
  }

  private sendRoster(sessions: readonly Session[]): void {
    const players: RosterPlayer[] = [];
    for (const p of this.active) {
      const isBot = isBotAccountId(p.accountId);
      players.push({
        slot: p.slot,
        team: p.teamId,
        name: isBot ? "" : p.name,
        isBot,
        botIndex: isBot ? botIndexOf(p.accountId) : -1,
        connected: isBot || p.session !== null,
      });
    }
    const w = this.rosterWriter;
    w.reset();
    encodeRoster(w, { players });
    const bytes = w.bytes();
    for (const session of sessions) session.sendStream(bytes);
  }

  private onDatagram(player: Player, session: Session, bytes: Uint8Array, recvMs: number): void {
    if (player.session !== session || bytes.length === 0) return;
    player.lastRecvMs = recvMs;
    if (recvMs - player.rateWindowStartMs >= 1000) {
      if (player.rateWindowCount > this.kickRate) player.abusiveWindows++;
      else player.abusiveWindows = 0;
      player.rateWindowStartMs = recvMs;
      player.rateWindowCount = 0;
      if (player.abusiveWindows >= 3) {
        this.kick(player, DisconnectReason.rateLimited);
        return;
      }
    }
    if (++player.rateWindowCount > this.rateLimit) {
      this.stats.datagramsRateLimited++;
      return;
    }
    const id = bytes[0]!;
    if (id === MsgId.Input) {
      const r = this.reader;
      r.reset(bytes);
      const packet = this.packet;
      if (!decodeInputPacketInto(r, this.next, packet)) {
        this.stats.inputsMalformed++;
        return;
      }
      player.inputs.insertPacket(packet.inputs, packet.count, this.next);
      const net = player.net;
      net.baselines.ack(packet.ackSnapshotTick);
      net.events.onAck(packet.ackSnapshotTick, packet.ackEventSeq);
      net.onInputPacket(packet.newestTick, packet.clientTimeMs, recvMs);
      player.viewDelay.onInputPacket(packet.newestTick, this.arrivalTick(recvMs), packet.interpDelayMs, packet.ackSnapshotTick, net.sentTimeOf(packet.ackSnapshotTick), recvMs);
    } else if (id === MsgId.Ping) {
      const r = this.reader;
      r.reset(bytes);
      const ping = decodePing(r);
      if (ping === null || ping.reply) return;
      const w = this.datagramWriter;
      w.reset();
      encodePing(w, { seq: ping.seq, originTimeMs: ping.originTimeMs, holdMs: this.clock.now() - recvMs, reply: true });
      session.sendDatagram(w.bytes());
    }
  }

  /** Fractional server tick at `recvMs`: the last tick started plus the time since, capped at one tick. */
  private arrivalTick(recvMs: number): number {
    const start = this.lastTickStartMs;
    if (start !== start) return this.next;
    const frac = (recvMs - start) / this.tickMs;
    return this.next - 1 + (frac < 0 ? 0 : frac > 1 ? 1 : frac);
  }

  private onStream(player: Player, session: Session, bytes: Uint8Array): void {
    if (player.session !== session || bytes.length === 0) return;
    player.lastRecvMs = this.clock.now();
    const id = bytes[0]!;
    if (id === MsgId.Resync) {
      const r = this.reader;
      r.reset(bytes);
      const request = decodeResyncRequest(r);
      if (request === null) return;
      player.net.reset(this.next - 1);
      const w = this.controlWriter;
      w.reset();
      encodeResyncResponse(w, { scope: request.scope, serverTick: this.next });
      session.sendStream(w.bytes());
    } else if (id === MsgId.Disconnect) {
      this.unbind(player);
      session.close(DisconnectReason.clientLeave);
    }
    // Hello is handled by the SessionManager before attach; other control messages arrive in later milestones.
  }

  private kick(player: Player, reason: DisconnectReason): void {
    const session = player.session;
    if (session === null) return;
    this.stats.kicks++;
    this.unbind(player);
    disconnectSession(session, reason);
  }

  private sweep(now: number): void {
    let removed = false;
    const keep = this.lifecycle !== null && this.lifecycle.keepsDisconnected;
    for (const p of this.active) {
      if (p.session !== null) {
        if (now - p.lastRecvMs > this.idleTimeoutMs) this.kick(p, DisconnectReason.timeout);
      } else if (keep) {
        // BR after warmup: the slot stays for results and team rules; past the grace the character is out.
        if (p.disconnectedAtMs >= 0 && now - p.disconnectedAtMs > this.graceMs && p.life !== "dead") this.combat?.forfeit(p);
      } else if (p.disconnectedAtMs >= 0 && now - p.disconnectedAtMs > this.graceMs) {
        this.slots[p.slot] = null;
        this.byAccount.delete(p.accountId);
        this.combat?.removed(p.slot);
        p.body.dispose();
        removed = true;
      }
    }
    if (removed) {
      this.rebuildActive();
      this.rosterRevision++;
    }
    this.lifecycle?.sweep(now);
  }

  private rebuildActive(): void {
    const list: Player[] = [];
    for (const p of this.slots) if (p !== null) list.push(p);
    this.active = list;
  }
}

/** `n` of a `bot:<n>` account id (0 when it is not a number). */
function botIndexOf(accountId: string): number {
  const n = Number(accountId.slice(accountId.indexOf(":") + 1));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** The zone a bot sees outside BR combat: the level's initial circle, not shrinking. */
function idleZoneState(level: MatchLevel): BrLifecycle["zoneState"] {
  return createZoneState(level.zone);
}
