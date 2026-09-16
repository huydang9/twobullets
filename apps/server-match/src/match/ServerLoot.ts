import {
  decodePickupArg,
  LOOT_AOI_ENTER_CELLS,
  LOOT_AOI_LEAVE_CELLS,
  LOOT_GRID_CELLS,
  lootCellDistance,
  lootCellOf,
  LootUpdateWriter,
  NET_LOOT_ID_LIMIT,
  NetInventoryOp,
} from "@twobullets/protocol";
import { dequantizeYaw } from "@twobullets/shared/aim";
import { armorLoadout, createInventory, drop, inventoryItems, pickUp, swapWeapons, type InventoryState, type ItemInstance, type WeaponSlot } from "@twobullets/shared/equipment/inventory";
import { ITEM_IDS, ITEMS } from "@twobullets/shared/equipment/items";
import { createGroundLoot, dropGroundItem, INTERACT, LOOT, queryGroundLoot, setGroundQuantity, type GroundLoot, type LootItem } from "@twobullets/shared/equipment/loot";
import { hash32 } from "@twobullets/shared/equipment/math";
import { PlayerActionType, type PlayerInput } from "@twobullets/shared/input";
import { decodeDropArg } from "@twobullets/shared/match/rules";
import { eyeHeightFor } from "@twobullets/shared/movement/movement";
import type { Vec3 } from "@twobullets/shared/movement/types";
import type { RaycastFn } from "@twobullets/shared/weapons/types";
import type { Player } from "./Player";

// Server-authoritative ground loot (plan.md B5, protocol v7). The match's loot is the offline generator's for the level
// and seed: practice's exact piles and ids, throwables included since v9 (ServerThrowables). Players act through
// `pickup` (loot id + weapon slot), `drop` (shared drop arg) and `equipAttach` (swap primaries) input actions, checked
// against reach, line of sight and the shared inventory rules; a death drops the whole inventory as a pile at the body.
// Replication is per client and area-of-interest based (protocol loot.ts): each tick every connected player's view
// follows its 32 m cell, queued cells stream nearest first within a byte budget, and item changes go only to clients
// that know the cell. All ops of a tick leave in as few `LootUpdate` stream messages as fit.

/** Eye-to-item reach the server accepts: the offline reach, its client slack, and a margin for prediction error. */
export const NET_PICKUP_REACH = INTERACT.reach + 0.4 + 0.5;
/** Line-of-sight target on a ground item: this far above the floor point, m (EquipmentSystem's ITEM_SIGHT_HEIGHT). */
const ITEM_SIGHT_HEIGHT = 0.15;
/** Drops land this far in front of the feet, spread on a small ring (EquipmentSystem's DROP). */
const DROP = { forward: 0.55, spread: 0.25 } as const;
/** Death piles: pile id base (+ slot), fits the 16-bit wire field. */
export const NET_DEATH_PILE_BASE = 0xff00;
const CELL_COUNT = LOOT_GRID_CELLS * LOOT_GRID_CELLS;
const CELL_UNKNOWN = 0;
const CELL_QUEUED = 1;
const CELL_KNOWN = 2;
/** Stream bytes per client per tick while cells are queued (a join or a fast move streams over a few ticks). */
export const LOOT_BYTES_PER_TICK = 1500;

export type PickupReject = "gone" | "notAlive" | "reach" | "sight" | "busy" | "inventory";

export interface ServerLootStats {
  /** Items on the ground now. */
  items: number;
  /** Items the generator made that the match left out (ids past the wire limit). */
  filtered: number;
  pickups: number;
  pickupsRejected: number;
  /** Refusals by reason. */
  rejected: Record<PickupReject, number>;
  drops: number;
  deathDrops: number;
  swaps: number;
  resets: number;
  /** Items that couldn't get a loot id (every wire id in use). */
  idExhausted: number;
  messagesOut: number;
  bytesOut: number;
  spawnsOut: number;
}

/** One client's area of interest (lives on `Player.lootView`). */
export class LootViewer {
  /** Cell the view is centred on, −1 before the first update. */
  center = -1;
  readonly state = new Uint8Array(CELL_COUNT);
  /** Cells not CELL_UNKNOWN. */
  readonly active: number[] = [];
  /** Cells to stream, nearest first from `head`. */
  readonly queue: number[] = [];
  head = 0;
  /** The next replicate starts with a `clear` (join, reconnect, loot reset). */
  clearPending = true;
  readonly out = new LootUpdateWriter();
  /** Bytes sent in the current tick (budget). */
  sentThisTick = 0;
  bytesOut = 0;
  messagesOut = 0;
  spawnsOut = 0;

  /** Forget everything; the next replicate clears the client and streams its area again. */
  reset(): void {
    this.clearPending = true;
  }

  /** Cells the client currently holds (tests, debug). */
  knows(cell: number): boolean {
    return this.state[cell] === CELL_KNOWN;
  }
}

export interface ServerLootOptions {
  /** The level's generated loot (`MatchLevel.createLoot`). */
  readonly items: readonly LootItem[];
  /** Static world rays: line of sight, drop placement. */
  readonly raycastWorld: RaycastFn;
  /** Dense players (the match's active list), read whenever an item changes. */
  readonly players: () => readonly Player[];
  readonly bytesPerTick?: number;
  readonly seed?: number;
}

export class ServerLoot {
  ground: GroundLoot;
  readonly stats: ServerLootStats = {
    items: 0,
    filtered: 0,
    pickups: 0,
    pickupsRejected: 0,
    rejected: { gone: 0, notAlive: 0, reach: 0, sight: 0, busy: 0, inventory: 0 },
    drops: 0,
    deathDrops: 0,
    swaps: 0,
    resets: 0,
    idExhausted: 0,
    messagesOut: 0,
    bytesOut: 0,
    spawnsOut: 0,
  };
  /** Last rejection reason (tests, debug). */
  lastReject: PickupReject | null = null;
  private readonly source: readonly LootItem[];
  private readonly raycast: RaycastFn;
  private readonly players: () => readonly Player[];
  private readonly bytesPerTick: number;
  private readonly seed: number;
  /** Loot ids per AOI cell. */
  private readonly cells: (Set<number> | undefined)[] = new Array<Set<number> | undefined>(CELL_COUNT);
  /** Loot id → slot that dropped or swapped it out. */
  private readonly droppedBy = new Map<number, number>();
  private idCursor = 0;
  private readonly eye: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly to: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

  constructor(options: ServerLootOptions) {
    const kept: LootItem[] = [];
    for (const item of options.items) {
      if (item.lootId >= NET_LOOT_ID_LIMIT) this.stats.filtered++;
      else kept.push(item);
    }
    this.source = kept;
    this.raycast = options.raycastWorld;
    this.players = options.players;
    this.bytesPerTick = options.bytesPerTick ?? LOOT_BYTES_PER_TICK;
    this.seed = options.seed ?? 0;
    this.ground = createGroundLoot([]);
    this.reset();
  }

  /** The generated loot again (BR glide start: warmup looting doesn't deplete the match). Every client re-streams. */
  reset(): void {
    this.ground = createGroundLoot(this.source);
    this.cells.fill(undefined);
    for (const item of this.source) this.cellSet(lootCellOf(item.position[0], item.position[2])).add(item.lootId);
    this.droppedBy.clear();
    this.idCursor = 0;
    this.stats.items = this.ground.items.size;
    this.stats.resets++;
    for (const p of this.players()) p.lootView.reset();
  }

  // ---- Actions ----------------------------------------------------------------------------------------------------

  /** A stepped (not dead, not frozen) player's input action for this tick. */
  act(p: Player, input: PlayerInput): void {
    const action = input.action;
    if (action === null) return;
    if (action.type === PlayerActionType.pickup) {
      const { lootId, replaceSlot } = decodePickupArg(action.arg);
      const botSlot = p.bot !== null ? p.bot.out.intents.replaceSlot : -1;
      this.pickUp(p, lootId, replaceSlot >= 0 ? replaceSlot : botSlot);
    } else if (action.type === PlayerActionType.drop) {
      this.dropFor(p, action.arg);
    } else if (action.type === PlayerActionType.equipAttach && action.arg === NetInventoryOp.swapPrimaries) {
      this.swapPrimaries(p);
    }
  }

  /**
   * Picks up (part of) a ground item: alive, within NET_PICKUP_REACH of the eye with a clear line of sight, not reviving,
   * and the shared `pickUp` rule (weight, stack caps, slots). `replaceSlot` −1: an empty slot, else the primary in hand.
   * Swapped-out gear lands where the item lay. Returns null on success, else why it was refused.
   */
  pickUp(p: Player, lootId: number, replaceSlot: number = -1): PickupReject | null {
    const reject = this.tryPickUp(p, lootId, replaceSlot);
    if (reject === null) this.stats.pickups++;
    else {
      this.stats.pickupsRejected++;
      this.stats.rejected[reject]++;
    }
    this.lastReject = reject;
    return reject;
  }

  /** A `drop` action (shared `encodeDropArg`: quantity 0 drops the whole stack). Returns whether something dropped. */
  dropFor(p: Player, arg: number): boolean {
    if (p.life !== "alive") return false;
    const target = decodeDropArg(arg);
    if (target === null) return false;
    const inventory = p.inventory;
    let result;
    if (target.kind === "stack") {
      const itemId = ITEM_IDS[target.code];
      if (itemId === undefined) return false;
      const def = ITEMS[itemId];
      if (def.category !== "ammo" && def.category !== "throwable" && def.category !== "heal" && def.category !== "boost") return false;
      const carried = inventory.stacks.find((s) => s.itemId === itemId)?.quantity ?? 0;
      const quantity = target.quantity > 0 ? Math.min(target.quantity, carried) : carried;
      if (quantity <= 0) return false;
      result = drop(inventory, { kind: "stack", itemId: def.id, quantity });
    } else {
      result = drop(inventory, target);
    }
    if (!result.ok) return false;
    this.setInventory(p, result.inventory);
    this.placeDrop(p, result.dropped);
    this.stats.drops++;
    return true;
  }

  swapPrimaries(p: Player): boolean {
    if (p.life !== "alive") return false;
    const result = swapWeapons(p.inventory, 0, 1);
    if (!result.ok) return false;
    this.setInventory(p, result.inventory);
    this.stats.swaps++;
    return true;
  }

  /**
   * Death: the whole inventory as one pile around the feet, settled on the floor below (MatchSim's death pile). The
   * inventory and armor empty. Returns the number of ground items.
   */
  dropInventory(p: Player): number {
    const items = inventoryItems(p.inventory);
    if (items.length > 0) {
      const feet = p.body.feet;
      const below = this.raycast({ x: feet.x, y: feet.y + 0.5, z: feet.z }, { x: feet.x, y: feet.y - 30, z: feet.z });
      const floorY = below ? below.point.y : feet.y;
      const pileId = NET_DEATH_PILE_BASE + p.slot;
      for (let k = 0; k < items.length; k++) {
        const angle = (k / items.length) * Math.PI * 2 + hash32(this.seed, p.slot, k) / 0x100000000;
        const r = items.length > 1 ? LOOT.pileRadius + 0.05 * (k % 3) : 0;
        this.add(items[k]!, feet.x + Math.sin(angle) * r, floorY, feet.z + Math.cos(angle) * r, pileId, -1);
      }
      this.stats.deathDrops++;
    }
    this.setInventory(p, createInventory());
    return items.length;
  }

  /** Bots' `BotWorldView.queryLoot`: ground items within `radius`, nearest first. */
  queryLoot(center: Vec3, radius: number, out: LootItem[]): number {
    out.length = 0;
    const found = queryGroundLoot(this.ground, center, radius);
    for (let i = 0; i < found.length; i++) out.push(found[i]!);
    return out.length;
  }

  // ---- Replication ------------------------------------------------------------------------------------------------

  /** End of tick: every connected player's view follows its feet, queued cells stream, and the tick's ops go out. */
  replicate(players: readonly Player[]): void {
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.session === null) continue;
      const v = p.lootView;
      v.sentThisTick = 0;
      if (v.clearPending) this.clearView(v);
      const cell = lootCellOf(p.body.feet.x, p.body.feet.z);
      if (cell !== v.center) this.moveView(p, v, cell);
      this.drain(p, v);
      this.flush(p);
    }
  }

  // ---- Internals --------------------------------------------------------------------------------------------------

  private tryPickUp(p: Player, lootId: number, replaceSlot: number): PickupReject | null {
    const item = this.ground.items.get(lootId);
    if (item === undefined) return "gone";
    if (p.life !== "alive") return "notAlive";
    if (p.reviveTarget >= 0) return "busy";
    const feet = p.body.feet;
    const eye = this.eye;
    eye.x = feet.x;
    eye.y = feet.y + eyeHeightFor(p.state.move.stance);
    eye.z = feet.z;
    const [x, y, z] = item.position;
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dz = z - eye.z;
    if (dx * dx + dy * dy + dz * dz > NET_PICKUP_REACH * NET_PICKUP_REACH) return "reach";
    const to = this.to;
    to.x = x;
    to.y = y + ITEM_SIGHT_HEIGHT;
    to.z = z;
    if (this.raycast(eye, to) !== null) return "sight";
    const slot: WeaponSlot = replaceSlot === 0 || replaceSlot === 1 || replaceSlot === 2 ? replaceSlot : p.state.weapon.activeIndex === 1 ? 1 : 0;
    const instance: ItemInstance = {
      itemId: item.itemId,
      quantity: item.quantity,
      ...(item.durability !== undefined ? { durability: item.durability } : {}),
      ...(item.magazine !== undefined ? { magazine: item.magazine } : {}),
    };
    const result = pickUp(p.inventory, instance, slot);
    if (!result.ok) return "inventory";
    this.setInventory(p, result.inventory);
    this.setQuantity(item, result.remainder?.quantity ?? 0);
    for (const dropped of result.dropped) this.add(dropped, x, y, z, -1, p.slot);
    return null;
  }

  /** In front of the feet (unless a wall is in the way), settled onto whatever is below. */
  private placeDrop(p: Player, instance: ItemInstance): void {
    const feet = p.body.feet;
    const yaw = dequantizeYaw(p.yawQ);
    const ring = (this.ground.nextId * 2.399) % (Math.PI * 2);
    let x = feet.x;
    let z = feet.z;
    const tx = x + Math.sin(yaw) * DROP.forward + Math.sin(ring) * DROP.spread;
    const tz = z + Math.cos(yaw) * DROP.forward + Math.cos(ring) * DROP.spread;
    if (this.raycast({ x, y: feet.y + 0.3, z }, { x: tx, y: feet.y + 0.3, z: tz }) === null) {
      x = tx;
      z = tz;
    }
    const below = this.raycast({ x, y: feet.y + 0.5, z }, { x, y: feet.y - 3, z });
    this.add(instance, x, below ? below.point.y : feet.y, z, -1, p.slot);
  }

  private setInventory(p: Player, inventory: InventoryState): void {
    p.inventory = inventory;
    if (p.armor.helmet !== inventory.helmet || p.armor.vest !== inventory.vest) p.armor = armorLoadout(inventory);
  }

  /** A new ground item with a wire-sized loot id, told to every client that knows its cell. */
  private add(instance: ItemInstance, x: number, y: number, z: number, pileId: number, droppedBy: number): LootItem | null {
    const ground = this.ground;
    let item: LootItem;
    if (ground.nextId < NET_LOOT_ID_LIMIT) {
      item = dropGroundItem(ground, instance, [x, y, z], pileId);
    } else {
      // Past the wire limit: reuse a free id, then put `nextId` back so the next item searches again.
      const free = this.freeId();
      if (free < 0) {
        this.stats.idExhausted++;
        return null;
      }
      const next = ground.nextId;
      ground.nextId = free;
      item = dropGroundItem(ground, instance, [x, y, z], pileId);
      ground.nextId = next;
    }
    if (droppedBy >= 0) this.droppedBy.set(item.lootId, droppedBy);
    const cell = lootCellOf(item.position[0], item.position[2]);
    this.cellSet(cell).add(item.lootId);
    this.stats.items = ground.items.size;
    const players = this.players();
    for (let i = 0; i < players.length; i++) {
      const other = players[i]!;
      if (other.session === null || other.lootView.state[cell] !== CELL_KNOWN) continue;
      this.room(other);
      other.lootView.out.spawn(item, droppedBy === other.slot);
      other.lootView.spawnsOut++;
    }
    return item;
  }

  /** Quantity left on the ground (0 removes the item), told to every client that knows its cell. */
  private setQuantity(item: LootItem, quantity: number): void {
    setGroundQuantity(this.ground, item.lootId, quantity);
    const cell = lootCellOf(item.position[0], item.position[2]);
    if (quantity <= 0) {
      this.cells[cell]?.delete(item.lootId);
      this.droppedBy.delete(item.lootId);
    }
    this.stats.items = this.ground.items.size;
    const players = this.players();
    for (let i = 0; i < players.length; i++) {
      const other = players[i]!;
      if (other.session === null || other.lootView.state[cell] !== CELL_KNOWN) continue;
      this.room(other);
      if (quantity <= 0) other.lootView.out.remove(item.lootId);
      else other.lootView.out.quantity(item.lootId, quantity);
    }
  }

  /** Lowest loot id not on the ground, searched from a rotating cursor (ids past the wire limit are exhausted). */
  private freeId(): number {
    for (let n = 0; n < NET_LOOT_ID_LIMIT; n++) {
      const id = (this.idCursor + n) % NET_LOOT_ID_LIMIT;
      if (!this.ground.items.has(id)) {
        this.idCursor = (id + 1) % NET_LOOT_ID_LIMIT;
        return id;
      }
    }
    return -1;
  }

  private cellSet(cell: number): Set<number> {
    let set = this.cells[cell];
    if (set === undefined) this.cells[cell] = set = new Set();
    return set;
  }

  private clearView(v: LootViewer): void {
    v.clearPending = false;
    for (let i = 0; i < v.active.length; i++) v.state[v.active[i]!] = CELL_UNKNOWN;
    v.active.length = 0;
    v.queue.length = 0;
    v.head = 0;
    v.center = -1;
    v.out.begin();
    v.out.clear();
  }

  /** Forgets cells past the leave distance, queues cells within the enter distance, nearest first. */
  private moveView(p: Player, v: LootViewer, cell: number): void {
    v.center = cell;
    const active = v.active;
    let kept = 0;
    for (let i = 0; i < active.length; i++) {
      const c = active[i]!;
      if (lootCellDistance(c, cell) <= LOOT_AOI_LEAVE_CELLS) {
        active[kept++] = c;
        continue;
      }
      if (v.state[c] === CELL_KNOWN) {
        this.room(p);
        v.out.forgetCell(c);
      }
      v.state[c] = CELL_UNKNOWN;
    }
    active.length = kept;
    const cx = cell % LOOT_GRID_CELLS;
    const cz = Math.floor(cell / LOOT_GRID_CELLS);
    const r = LOOT_AOI_ENTER_CELLS;
    const queue = v.queue;
    // Drop consumed and no-longer-queued entries before adding.
    let q = 0;
    for (let i = v.head; i < queue.length; i++) if (v.state[queue[i]!] === CELL_QUEUED) queue[q++] = queue[i]!;
    queue.length = q;
    v.head = 0;
    for (let z = Math.max(0, cz - r); z <= Math.min(LOOT_GRID_CELLS - 1, cz + r); z++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(LOOT_GRID_CELLS - 1, cx + r); x++) {
        const c = z * LOOT_GRID_CELLS + x;
        if (v.state[c] !== CELL_UNKNOWN) continue;
        v.state[c] = CELL_QUEUED;
        active.push(c);
        queue.push(c);
      }
    }
    queue.sort((a, b) => lootCellDistance(a, cell) - lootCellDistance(b, cell));
  }

  /** Streams queued cells, nearest first, until this tick's byte budget is spent. */
  private drain(p: Player, v: LootViewer): void {
    const queue = v.queue;
    while (v.head < queue.length && v.sentThisTick + v.out.byteLength < this.bytesPerTick) {
      const cell = queue[v.head++]!;
      if (v.state[cell] !== CELL_QUEUED) continue;
      v.state[cell] = CELL_KNOWN;
      const ids = this.cells[cell];
      if (ids === undefined) continue;
      for (const id of ids) {
        const item = this.ground.items.get(id);
        if (item === undefined) continue;
        this.room(p);
        v.out.spawn(item, this.droppedBy.get(id) === p.slot);
        v.spawnsOut++;
        this.stats.spawnsOut++;
      }
    }
    if (v.head >= queue.length) {
      queue.length = 0;
      v.head = 0;
    }
  }

  /** Sends the pending message when the next op might not fit. */
  private room(p: Player): void {
    if (p.lootView.out.full) this.flush(p);
  }

  private flush(p: Player): void {
    const v = p.lootView;
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
