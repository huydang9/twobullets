import {
  decodeThrowArg,
  lootCellDistance,
  THROWABLE_AOI_ENTER_CELLS,
  THROWABLE_AOI_LEAVE_CELLS,
  throwableCellOf,
  ThrowableUpdateWriter,
} from "@twobullets/protocol";
import { dequantizePitch, dequantizeYaw } from "@twobullets/shared/aim";
import type { DestructibleWalls } from "@twobullets/shared/equipment/destructible";
import { createEquipmentWorld, stepEquipmentWorld, type EquipmentWorld, type EquipmentWorldEvent, type WorldEntity } from "@twobullets/shared/equipment/equipmentStep";
import { countItem, cycleThrowable, removeStack, type InventoryState } from "@twobullets/shared/equipment/inventory";
import { THROWABLE_KINDS, throwableDef } from "@twobullets/shared/equipment/items";
import { hash32 } from "@twobullets/shared/equipment/math";
import { isSmokeExpired, SMOKE_BASE_LIFT, smokeRadius, type SmokeCloud } from "@twobullets/shared/equipment/smoke";
import { createThrowState, stepThrow, throwLaunch, type ThrowRelease, type ThrowState } from "@twobullets/shared/equipment/throw";
import { resolveThrowOrigin, spawnThrowable, throwId, type ThrowableSnapshot } from "@twobullets/shared/equipment/throwables";
import type { ThrowableView } from "@twobullets/shared/bots/types";
import { Btn, PlayerActionType, type PlayerInput } from "@twobullets/shared/input";
import { eyeHeightFor } from "@twobullets/shared/movement/movement";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import type { RaycastFn } from "@twobullets/shared/weapons/types";
import type { Player } from "./Player";

// Server-authoritative throwables (protocol v9). The match owns one shared `EquipmentWorld`: grenades fly against the
// static world with `stepThrowables`, detonations run the shared rules (frag blast with line-of-sight exposure and
// armor, smoke clouds, molotov fire patches, flash exposure per player), and everything a client needs is replicated
// through `ThrowableUpdate` inside its area of interest — the same 32 m cell grid the loot uses.
//
// Humans throw with the `throwItem` input action: the client's hands run the shared `stepThrow` locally (cook timer,
// arc, sounds) and send kind + style + the fuse left at release; the server checks the item is carried, the player is
// alive with free hands and the fuse is sane, then rebuilds the hand position and launch velocity from its own view of
// the thrower with the same `throwLaunch`, so nothing about the flight is client-controlled.
//
// Bots have no wire: their `stepThrow` runs here from the brain's input (select 5 = take a throwable out, fire, aim,
// reload to cook, and the cycle/holster intents), exactly as the offline MatchSim drives it.

/** Grenades in flight get a position correction this often (they are simulated locally in between). */
export const THROWABLE_MOVE_TICKS = 6;
/** Stream bytes per client per tick (a joining client streams a busy area over a few ticks). */
export const THROWABLE_BYTES_PER_TICK = 1200;
/** A smoke cloud or fire patch is relevant this far outside its own radius, m. */
const EFFECT_MARGIN_M = 12;

export type ThrowReject = "badArg" | "notAlive" | "busy" | "notCarried" | "full";

export interface ServerThrowableStats {
  throws: number;
  rejected: number;
  rejects: Record<ThrowReject, number>;
  detonations: number;
  damageEvents: number;
  flashes: number;
  smokes: number;
  fires: number;
  botThrows: number;
  messagesOut: number;
  bytesOut: number;
}

/** One client's throwable area of interest (lives on `Player.throwView`). */
export class ThrowableViewer {
  readonly out = new ThrowableUpdateWriter();
  /** Throwable / smoke / fire ids the client holds. */
  readonly throwables = new Set<number>();
  readonly smokes = new Set<number>();
  readonly fires = new Set<number>();
  /** The next replicate starts with a `clear` (join, reconnect, match reset). */
  clearPending = true;
  sentThisTick = 0;
  bytesOut = 0;
  messagesOut = 0;

  reset(): void {
    this.clearPending = true;
  }
}

export interface ServerThrowablesOptions {
  readonly seed: number;
  /** Static world rays only (no capsules or hitboxes): flight, blast exposure, smoke and fire probes. */
  readonly raycastWorld: RaycastFn;
  /** Dense players (the match's active list). */
  readonly players: () => readonly Player[];
  /** Area damage into the combat pipeline (armor, knocks, kills, kill feed). */
  readonly damage: (victim: Player, amount: number, kind: "explosion" | "fire", attacker: number, position: Vec3) => void;
  /** Explosion noise for bot hearing; absent = no bots. */
  readonly noise?: (slot: number, position: Vec3) => void;
  readonly bytesPerTick?: number;
  readonly moveTicks?: number;
}

export class ServerThrowables {
  readonly world: EquipmentWorld;
  readonly stats: ServerThrowableStats = {
    throws: 0,
    rejected: 0,
    rejects: { badArg: 0, notAlive: 0, busy: 0, notCarried: 0, full: 0 },
    detonations: 0,
    damageEvents: 0,
    flashes: 0,
    smokes: 0,
    fires: 0,
    botThrows: 0,
    messagesOut: 0,
    bytesOut: 0,
  };
  /** Last rejection reason (tests, debug). */
  lastReject: ThrowReject | null = null;
  private readonly o: ServerThrowablesOptions;
  private readonly raycast: RaycastFn;
  private readonly bytesPerTick: number;
  private readonly moveTicks: number;
  private readonly entities: WorldEntity[] = [];
  private readonly entityPool: MutableEntity[] = [];
  private readonly events: EquipmentWorldEvent[] = [];
  /** Bot throw state per slot (humans keep theirs on the client). */
  private readonly botThrow = new Map<number, ThrowState>();
  private readonly botPrev = new Map<number, { buttons: number; select: number; cycle: boolean; holster: boolean }>();
  private readonly botViews: ThrowableView[] = [];
  private tickCount = 0;

  constructor(options: ServerThrowablesOptions) {
    this.o = options;
    this.raycast = options.raycastWorld;
    this.bytesPerTick = options.bytesPerTick ?? THROWABLE_BYTES_PER_TICK;
    this.moveTicks = options.moveTicks ?? THROWABLE_MOVE_TICKS;
    this.world = createEquipmentWorld(options.seed >>> 0);
  }

  get smokes(): readonly SmokeCloud[] {
    return this.world.smokes;
  }

  /**
   * Installs the match's destructible walls (`ServerWalls`) in this world. From here on a frag takes the mirror panes
   * in range out, a cloud closes a holed pane's apertures and a fire burns a hedge away — inside `stepEquipmentWorld`,
   * through the shared pure resolvers, exactly as the offline `MatchSim` drives them. The match owns what follows
   * (colliders, nav, the wire); this only lets the rules write.
   */
  setWalls(walls: DestructibleWalls): void {
    this.world.walls = walls;
  }

  /** Everything in flight, for bot perception (`BotWorldView.throwables`). Rebuilt in place each tick. */
  get throwableViews(): readonly ThrowableView[] {
    const set = this.world.throwables;
    const out = this.botViews;
    out.length = 0;
    for (let i = 0; i < set.count; i++) {
      const i3 = i * 3;
      out.push({
        id: set.id[i]!,
        ownerSlot: set.owner[i]!,
        kind: THROWABLE_KINDS[set.kind[i]!]!,
        position: { x: set.position[i3]!, y: set.position[i3 + 1]!, z: set.position[i3 + 2]! },
        velocity: { x: set.velocity[i3]!, y: set.velocity[i3 + 1]!, z: set.velocity[i3 + 2]! },
        atRest: set.motion[i] === 2,
      });
    }
    return out;
  }

  /** Plain view of everything in flight (tests, debug tooling). */
  snapshot(): ThrowableSnapshot[] {
    const set = this.world.throwables;
    const out: ThrowableSnapshot[] = [];
    for (let i = 0; i < set.count; i++) {
      const i3 = i * 3;
      out.push({
        id: set.id[i]!,
        owner: set.owner[i]!,
        kind: THROWABLE_KINDS[set.kind[i]!]!,
        position: { x: set.position[i3]!, y: set.position[i3 + 1]!, z: set.position[i3 + 2]! },
        velocity: { x: set.velocity[i3]!, y: set.velocity[i3 + 1]!, z: set.velocity[i3 + 2]! },
        resting: set.motion[i] === 2,
        rolling: set.motion[i] === 1,
        fuse: set.fuse[i]!,
        bounces: set.bounces[i]!,
      });
    }
    return out;
  }

  /** Everything in flight and every area effect is gone (BR glide start, match reset). Clients re-stream. */
  reset(): void {
    this.world.throwables.count = 0;
    this.world.smokes = [];
    this.world.fires = [];
    this.botThrow.clear();
    this.botPrev.clear();
    for (const p of this.o.players()) p.throwView.reset();
  }

  /** A slot left the match, respawned or died: its hands are empty again. */
  clearPlayer(p: Player): void {
    this.botThrow.delete(p.slot);
    this.botPrev.delete(p.slot);
  }

  // ---- Actions ------------------------------------------------------------------------------------------------------

  /** A stepped player's input action for this tick (`throwItem`). */
  act(p: Player, input: PlayerInput): void {
    const action = input.action;
    if (action === null || action.type !== PlayerActionType.throwItem) return;
    const reject = this.tryThrow(p, action.arg);
    if (reject === null) this.stats.throws++;
    else {
      this.stats.rejected++;
      this.stats.rejects[reject]++;
    }
    this.lastReject = reject;
  }

  /**
   * Throws for `p` (protocol `encodeThrowArg`). Refused when the arg is malformed, the player is knocked, dead or using
   * an item, the throwable is not carried, or the world is full. Returns null on success, else why it was refused.
   */
  tryThrow(p: Player, arg: number): ThrowReject | null {
    const decoded = decodeThrowArg(arg);
    if (decoded === null) return "badArg";
    if (p.life !== "alive") return "notAlive";
    if (p.use.itemId !== null || p.reviveTarget >= 0) return "busy";
    if (countItem(p.inventory, decoded.kind) <= 0) return "notCarried";
    // Only a cooked frag leaves with less than its full fuse; everything else starts at the item's own fuse.
    const def = throwableDef(decoded.kind);
    const fuse = decoded.style === "inHand" ? 0 : def.cookable ? Math.min(decoded.fuseSeconds, def.fuseSeconds) : def.fuseSeconds;
    const release: ThrowRelease = {
      kind: decoded.kind,
      throwCounter: p.throwCounter,
      eye: this.eyeOf(p),
      hand: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      fuse,
      style: decoded.style,
      cooked: fuse < def.fuseSeconds,
    };
    return this.spawn(p, release);
  }

  /** Bots: the brain's throw intent through the same shared `stepThrow` the client runs, then the same spawn path. */
  stepBot(p: Player, input: PlayerInput): void {
    const seat = p.bot;
    if (seat === null) return;
    const prev = this.botPrev.get(p.slot) ?? { buttons: 0, select: 0, cycle: false, holster: false };
    const intents = seat.out.intents;
    const buttons = input.buttons;
    const select = input.select;
    const pinPulled = seat.equip.throw.phase === "primed" || seat.equip.throw.phase === "cooking";
    let inventory = p.inventory;
    if (intents.cycleThrowable && !prev.cycle && !pinPulled) {
      const cycled = cycleThrowable(inventory);
      if (cycled !== inventory) this.setInventory(p, cycled);
      inventory = cycled;
    }
    const selected = inventory.selectedThrowable;
    const state = this.botThrow.get(p.slot) ?? seat.equip.throw;
    const eye = this.eyeOf(p);
    const step = stepThrow(
      state,
      {
        equip: select === 5 && prev.select !== 5,
        fire: (buttons & Btn.fire) !== 0,
        aim: (buttons & Btn.aim) !== 0,
        cook: (buttons & Btn.reload) !== 0 && (prev.buttons & Btn.reload) === 0,
        holster: (intents.holster && !prev.holster) || (select >= 1 && select <= 3 && select !== prev.select),
      },
      {
        eye,
        yaw: dequantizeYaw(p.yawQ),
        pitch: dequantizePitch(p.pitchQ),
        velocity: p.state.move.velocity,
        selected,
        carried: selected ? countItem(inventory, selected) : 0,
        canAct: p.life === "alive" && p.use.itemId === null,
      },
      TICK_SECONDS,
    );
    this.botThrow.set(p.slot, step.state);
    seat.equip = { ...seat.equip, throw: step.state };
    seat.self.throwState = step.state;
    prev.buttons = buttons;
    prev.select = select;
    prev.cycle = intents.cycleThrowable;
    prev.holster = intents.holster;
    this.botPrev.set(p.slot, prev);
    if (step.release !== null && this.spawn(p, step.release) === null) this.stats.botThrows++;
  }

  // ---- Tick ---------------------------------------------------------------------------------------------------------

  /** After every player stepped: fly grenades, detonate, damage, and age smoke and fire. */
  step(players: readonly Player[]): void {
    this.tickCount++;
    const entities = this.entities;
    entities.length = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.life === "dead") continue;
      entities.push(this.entityOf(p));
    }
    const events = this.events;
    events.length = 0;
    stepEquipmentWorld(this.world, TICK_SECONDS, this.raycast, entities, events);
    for (let i = 0; i < events.length; i++) this.handle(events[i]!, players);
  }

  /** End of tick: each connected client's view follows its feet, and the tick's ops go out. */
  replicate(players: readonly Player[]): void {
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.session === null) continue;
      const v = p.throwView;
      v.sentThisTick = 0;
      if (v.clearPending) {
        v.clearPending = false;
        v.throwables.clear();
        v.smokes.clear();
        v.fires.clear();
        v.out.begin();
        v.out.clear();
      }
      this.syncThrowables(p, v);
      this.syncSmokes(p, v);
      this.syncFires(p, v);
      this.flush(p);
    }
  }

  // ---- Internals ----------------------------------------------------------------------------------------------------

  /** Spawns a release into the world (hand resolved against walls), takes one from the bag and tells every client. */
  private spawn(p: Player, release: ThrowRelease): ThrowReject | null {
    const removed = removeStack(p.inventory, release.kind, 1);
    if (!removed.ok) return "notCarried";
    const launch = throwLaunch({ eye: release.eye, yaw: dequantizeYaw(p.yawQ), pitch: dequantizePitch(p.pitchQ), velocity: p.state.move.velocity }, release.style);
    const position = release.style === "inHand" ? launch.hand : resolveThrowOrigin(release.eye, launch.hand, this.raycast);
    const id = throwId(p.slot, release.throwCounter);
    const index = spawnThrowable(this.world.throwables, { id, owner: p.slot, kind: release.kind, position, velocity: launch.velocity, fuse: release.fuse });
    if (index < 0) return "full";
    this.setInventory(p, removed.inventory);
    p.throwCounter = (p.throwCounter + 1) & 0xffff;
    const cell = throwableCellOf(position.x, position.z);
    for (const other of this.o.players()) {
      if (other.session === null || !this.inRange(other, cell, THROWABLE_AOI_ENTER_CELLS)) continue;
      this.room(other);
      other.throwView.out.spawn({ id, owner: p.slot, kind: release.kind, position, velocity: launch.velocity, fuse: release.fuse });
      other.throwView.throwables.add(id);
    }
    return null;
  }

  private handle(event: EquipmentWorldEvent, players: readonly Player[]): void {
    switch (event.type) {
      case "detonate": {
        this.stats.detonations++;
        const cell = throwableCellOf(event.position.x, event.position.z);
        for (const other of players) {
          if (other.session === null || !this.inRange(other, cell, THROWABLE_AOI_ENTER_CELLS)) continue;
          this.room(other);
          other.throwView.out.detonate(event.id, event.owner, event.kind, event.position.x, event.position.y, event.position.z, event.normal.x, event.normal.y, event.normal.z);
          other.throwView.throwables.delete(event.id);
        }
        if (event.kind === "frag" || event.kind === "flash") this.o.noise?.(event.owner, event.position);
        break;
      }
      case "damage": {
        const request = event.request;
        const victim = players.find((p) => p.slot === request.targetId);
        if (victim === undefined || (request.kind !== "explosion" && request.kind !== "fire")) break;
        this.stats.damageEvents++;
        this.o.damage(victim, request.amount, request.kind, request.sourceId, request.position);
        break;
      }
      case "flashed": {
        const victim = players.find((p) => p.slot === event.targetId);
        if (victim === undefined) break;
        this.stats.flashes++;
        const v = victim.vitals;
        victim.vitals = {
          ...v,
          blindSeconds: Math.max(v.blindSeconds, event.exposure.blindSeconds),
          deafSeconds: Math.max(v.deafSeconds, event.exposure.deafSeconds),
        };
        if (victim.session !== null) {
          this.room(victim);
          victim.throwView.out.flash(event.sourceId & 0xffff, event.exposure.blind, event.exposure.deaf);
        }
        break;
      }
      case "smokeSpawned":
        this.stats.smokes++;
        break;
      case "fireSpawned":
        this.stats.fires++;
        break;
      default:
        break;
    }
  }

  /** Grenades in flight: spawn ops go out on the throw, so here only corrections, entries and exits. */
  private syncThrowables(p: Player, v: ThrowableViewer): void {
    const set = this.world.throwables;
    const due = this.tickCount % this.moveTicks === 0;
    const live = new Set<number>();
    for (let i = 0; i < set.count; i++) {
      const i3 = i * 3;
      const id = set.id[i]!;
      const x = set.position[i3]!;
      const y = set.position[i3 + 1]!;
      const z = set.position[i3 + 2]!;
      const near = this.inRange(p, throwableCellOf(x, z), v.throwables.has(id) ? THROWABLE_AOI_LEAVE_CELLS : THROWABLE_AOI_ENTER_CELLS);
      if (!near) continue;
      live.add(id);
      if (!v.throwables.has(id)) {
        this.room(p);
        v.out.spawn({
          id,
          owner: set.owner[i]!,
          kind: THROWABLE_KINDS[set.kind[i]!]!,
          position: { x, y, z },
          velocity: { x: set.velocity[i3]!, y: set.velocity[i3 + 1]!, z: set.velocity[i3 + 2]! },
          fuse: set.fuse[i]!,
        });
        v.throwables.add(id);
      } else if (due && set.motion[i] !== 2) {
        this.room(p);
        v.out.move(id, x, y, z, set.velocity[i3]!, set.velocity[i3 + 1]!, set.velocity[i3 + 2]!);
      }
    }
    for (const id of v.throwables) {
      if (live.has(id)) continue;
      this.room(p);
      v.out.remove(id);
      v.throwables.delete(id);
    }
  }

  private syncSmokes(p: Player, v: ThrowableViewer): void {
    const clouds = this.world.smokes;
    for (let i = 0; i < clouds.length; i++) {
      const cloud = clouds[i]!;
      if (v.smokes.has(cloud.id)) continue;
      if (!this.nearPoint(p, cloud.base, smokeRadius(cloud.age) + EFFECT_MARGIN_M)) continue;
      this.room(p);
      // The op carries the detonation point, so the client's `createSmokeCloud` lands on the same base.
      v.out.smokeStart(cloud.id, cloud.base.x, cloud.base.y - SMOKE_BASE_LIFT, cloud.base.z, cloud.seed);
      v.smokes.add(cloud.id);
    }
    for (const id of v.smokes) {
      if (clouds.some((c) => c.id === id && !isSmokeExpired(c))) continue;
      this.room(p);
      v.out.smokeEnd(id);
      v.smokes.delete(id);
    }
  }

  private syncFires(p: Player, v: ThrowableViewer): void {
    const fires = this.world.fires;
    for (let i = 0; i < fires.length; i++) {
      const patch = fires[i]!;
      if (v.fires.has(patch.id) || patch.cellCount === 0) continue;
      const origin = { x: patch.cells[0]!, y: patch.cells[1]!, z: patch.cells[2]! };
      if (!this.nearPoint(p, origin, EFFECT_MARGIN_M + 8)) continue;
      const seed = this.effectSeedOf(patch.id);
      this.room(p);
      v.out.fireStart(patch.id, patch.owner, origin.x, origin.y, origin.z, 0, 1, 0, seed);
      v.fires.add(patch.id);
    }
    for (const id of v.fires) {
      if (fires.some((f) => f.id === id)) continue;
      this.room(p);
      v.out.fireEnd(id);
      v.fires.delete(id);
    }
  }

  /** The seed `stepEquipmentWorld` gave an effect: the match seed hashed with the throwable id. */
  private effectSeedOf(id: number): number {
    return hash32(this.world.seed, id) >>> 0;
  }

  private inRange(p: Player, cell: number, cells: number): boolean {
    return lootCellDistance(throwableCellOf(p.body.feet.x, p.body.feet.z), cell) <= cells;
  }

  private nearPoint(p: Player, point: Vec3, radius: number): boolean {
    const dx = point.x - p.body.feet.x;
    const dz = point.z - p.body.feet.z;
    const reach = radius + THROWABLE_AOI_ENTER_CELLS * 32;
    return dx * dx + dz * dz <= reach * reach;
  }

  private eyeOf(p: Player): Vec3 {
    const feet = p.body.feet;
    return { x: feet.x, y: feet.y + eyeHeightFor(p.state.move.stance), z: feet.z };
  }

  private entityOf(p: Player): WorldEntity {
    let e = this.entityPool[p.slot];
    if (e === undefined) {
      e = { id: p.slot, team: p.teamId, feet: { x: 0, y: 0, z: 0 }, posture: "stand", eye: { x: 0, y: 0, z: 0 }, viewDir: { x: 0, y: 0, z: 1 } };
      this.entityPool[p.slot] = e;
    }
    const feet = p.body.feet;
    e.team = p.teamId;
    e.feet.x = feet.x;
    e.feet.y = feet.y;
    e.feet.z = feet.z;
    e.posture = p.life === "downed" ? "downed" : p.state.move.stance === "crouch" ? "crouch" : "stand";
    e.eye.x = feet.x;
    e.eye.y = feet.y + eyeHeightFor(p.state.move.stance);
    e.eye.z = feet.z;
    const yaw = dequantizeYaw(p.yawQ);
    const pitch = dequantizePitch(p.pitchQ);
    const cos = Math.cos(pitch);
    e.viewDir.x = Math.sin(yaw) * cos;
    e.viewDir.y = -Math.sin(pitch);
    e.viewDir.z = Math.cos(yaw) * cos;
    return e;
  }

  private setInventory(p: Player, inventory: InventoryState): void {
    p.inventory = inventory;
  }

  private room(p: Player): void {
    if (p.throwView.out.full || p.throwView.sentThisTick + p.throwView.out.byteLength > this.bytesPerTick) this.flush(p);
  }

  private flush(p: Player): void {
    const v = p.throwView;
    const bytes = v.out.finish();
    if (bytes !== null && p.session !== null) {
      p.session.sendStream(bytes);
      v.sentThisTick += bytes.length;
      v.bytesOut += bytes.length;
      v.messagesOut++;
      this.stats.bytesOut += bytes.length;
      this.stats.messagesOut++;
    }
    v.out.begin();
  }
}

interface MutableEntity {
  id: number;
  team: number;
  feet: { x: number; y: number; z: number };
  posture: WorldEntity["posture"];
  eye: { x: number; y: number; z: number };
  viewDir: { x: number; y: number; z: number };
}

/** A fresh throw state (respawn); exported for tests. */
export const IDLE_THROW: ThrowState = createThrowState();
