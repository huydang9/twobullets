import { ITEM_IDS, ITEMS, type ItemId } from "@twobullets/shared/equipment/items";
import type { BitReader, BitWriter } from "../bits";
import { createBitWriter } from "../bits";
import { MsgId } from "./ids";

// Ground loot on the control stream (protocol v7, plan.md B5). The server owns the loot; each client hears only the
// area of interest around it: a 64 × 64 grid of 32 m cells over ±1,024 m, where the server streams every item of a cell
// once it comes within LOOT_AOI_ENTER_CELLS (Chebyshev) of the player's cell, forgets it past LOOT_AOI_LEAVE_CELLS, and
// sends item changes (picked up, split, dropped) only to clients that know the cell. Messages are op lists ended by an
// `end` op; the stream is reliable and ordered, so ops apply in order and need no sequence numbers.

/** AOI cell edge, m. */
export const LOOT_CELL_M = 32;
/** Cells per axis; the grid starts at LOOT_GRID_ORIGIN_M on x and z (positions outside clamp to the edge cells). */
export const LOOT_GRID_CELLS = 64;
export const LOOT_GRID_ORIGIN_M = -1024;
export const LOOT_CELL_BITS = 12;
/** A cell enters a client's view within this many cells of its own cell (5 × 32 m: at least 160 m in every direction). */
export const LOOT_AOI_ENTER_CELLS = 5;
/** …and leaves beyond this many (one cell of hysteresis). */
export const LOOT_AOI_LEAVE_CELLS = 6;

export const LOOT_OP_BITS = 3;
export const LootOpCode = { spawn: 0, remove: 1, quantity: 2, forgetCell: 3, clear: 4, end: 7 } as const;
export type LootOpCode = (typeof LootOpCode)[keyof typeof LootOpCode];

export const LOOT_ID_BITS = 16;
/** Loot ids a `pickup` action can name: its 16-bit arg keeps 2 bits for the weapon slot (see `encodePickupArg`). */
export const NET_LOOT_ID_LIMIT = 1 << 14;
export const LOOT_ITEM_CODE_BITS = 6;
export const LOOT_QUANTITY_BITS = 10;
export const LOOT_MAGAZINE_BITS = 7;
/** Armor durability in 0.1 points (≤ 204.7). */
export const LOOT_DURABILITY_BITS = 11;
export const LOOT_PILE_BITS = 16;
/** 1 cm steps: x/z 17 bits over ±655.36 m, y 16 bits over [−64, 591.35] m. */
export const LOOT_POS_XZ_BITS = 17;
export const LOOT_POS_Y_BITS = 16;
const LOOT_XZ_OFFSET_CM = 65536;
const LOOT_Y_OFFSET_CM = 6400;
/** Pile id field value for "no pile". */
const NO_PILE = -1;

/** The server closes a message and starts another once it passes this size. */
export const LOOT_UPDATE_SOFT_BYTES = 1100;
/** Largest single op (a spawn with a new pile), bytes, rounded up. */
export const LOOT_OP_MAX_BYTES = 14;

/** One decoded op; fields outside the op's payload read 0 (pileId −1). */
export interface LootOp {
  op: LootOpCode;
  lootId: number;
  /** `ITEM_IDS` index. */
  itemCode: number;
  quantity: number;
  xCm: number;
  yCm: number;
  zCm: number;
  magazine: number;
  /** 0.1 points. */
  durabilityQ: number;
  /** −1 = not in a pile. */
  pileId: number;
  /** The recipient dropped (or swapped out) this item: auto pickup leaves it alone. */
  ownDrop: boolean;
  /** `forgetCell`: cell index. */
  cell: number;
}

/** What the server writes for a spawn (world metres, quantized here). Shared `LootItem` fits. */
export interface LootSpawnItem {
  readonly lootId: number;
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly position: readonly [number, number, number];
  readonly magazine?: number;
  readonly durability?: number;
  /** −1 or omitted = no pile. */
  readonly pileId?: number;
}

export function createLootOp(): LootOp {
  return { op: LootOpCode.spawn, lootId: 0, itemCode: 0, quantity: 0, xCm: 0, yCm: 0, zCm: 0, magazine: 0, durabilityQ: 0, pileId: NO_PILE, ownDrop: false, cell: 0 };
}

// ---- Quantization and cells -------------------------------------------------------------------------------------

function clampInt(v: number, lo: number, hi: number): number {
  if (v !== v) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export function quantizeLootXZ(m: number): number {
  return clampInt(Math.round(m * 100) + LOOT_XZ_OFFSET_CM, 0, (1 << LOOT_POS_XZ_BITS) - 1);
}
export function dequantizeLootXZ(q: number): number {
  return (q - LOOT_XZ_OFFSET_CM) / 100;
}
export function quantizeLootY(m: number): number {
  return clampInt(Math.round(m * 100) + LOOT_Y_OFFSET_CM, 0, (1 << LOOT_POS_Y_BITS) - 1);
}
export function dequantizeLootY(q: number): number {
  return (q - LOOT_Y_OFFSET_CM) / 100;
}
export function quantizeLootDurability(points: number): number {
  return clampInt(Math.round(points * 10), 0, (1 << LOOT_DURABILITY_BITS) - 1);
}

/** Cell coordinate (0..LOOT_GRID_CELLS−1) of a quantized x or z, so server and client agree at cell edges. */
export function lootCellCoordQ(q: number): number {
  return clampInt(Math.floor((q - LOOT_XZ_OFFSET_CM - LOOT_GRID_ORIGIN_M * 100) / (LOOT_CELL_M * 100)), 0, LOOT_GRID_CELLS - 1);
}

/** Cell index of quantized x/z (a decoded spawn's `xCm`, `zCm`). */
export function lootCellOfQ(xCm: number, zCm: number): number {
  return lootCellCoordQ(zCm) * LOOT_GRID_CELLS + lootCellCoordQ(xCm);
}

/** Cell index of a world position (through its wire quantization). */
export function lootCellOf(x: number, z: number): number {
  return lootCellOfQ(quantizeLootXZ(x), quantizeLootXZ(z));
}

/** Chebyshev distance between two cells, in cells. */
export function lootCellDistance(a: number, b: number): number {
  const dx = Math.abs((a % LOOT_GRID_CELLS) - (b % LOOT_GRID_CELLS));
  const dz = Math.abs(Math.floor(a / LOOT_GRID_CELLS) - Math.floor(b / LOOT_GRID_CELLS));
  return dx > dz ? dx : dz;
}

// ---- Item fields by category ------------------------------------------------------------------------------------

const ITEM_CODE = new Map<ItemId, number>(ITEM_IDS.map((id, code) => [id, code]));

type FieldKind = 0 | 1 | 2 | 3;
/** 0 single (gear, backpacks), 1 stack (quantity), 2 weapon (magazine), 3 armor (durability). */
const FIELD_KIND: readonly FieldKind[] = ITEM_IDS.map((id) => {
  const category = ITEMS[id].category;
  if (category === "weapon") return 2;
  if (category === "helmet" || category === "vest") return 3;
  if (category === "ammo" || category === "throwable" || category === "heal" || category === "boost") return 1;
  return 0;
});

// ---- Writer -----------------------------------------------------------------------------------------------------

/**
 * Builds one `LootUpdate` (0x4E, S→C stream): id 8, then ops (op 3 + payload) until `end`.
 * - spawn: lootId 16, item 6, [stack: quantity 10], x 17, y 16, z 17, [weapon: magazine 7], [armor: durability 11],
 *   samePile 1 (as the previous spawn in this message) [else hasPile 1 (+ pileId 16)], ownDrop 1 → 74–101 bits.
 * - remove: lootId 16. quantity: lootId 16, quantity 10. forgetCell: cell 12. clear: nothing (drop every known item).
 * Reuse one writer per recipient: `begin`, ops, `finish` (null when no op was written).
 */
export class LootUpdateWriter {
  readonly writer: BitWriter;
  private opCount = 0;
  private lastPile = -2;

  constructor(capacityBytes = LOOT_UPDATE_SOFT_BYTES + 64) {
    this.writer = createBitWriter(capacityBytes);
    this.begin();
  }

  get ops(): number {
    return this.opCount;
  }

  /** Bytes written so far (without the end op). */
  get byteLength(): number {
    return this.writer.byteLength;
  }

  /** True once the message should be finished before another op. */
  get full(): boolean {
    return this.writer.byteLength + LOOT_OP_MAX_BYTES > LOOT_UPDATE_SOFT_BYTES;
  }

  begin(): void {
    this.writer.reset();
    this.writer.write(MsgId.LootUpdate, 8);
    this.opCount = 0;
    this.lastPile = -2;
  }

  spawn(e: LootSpawnItem, ownDrop = false): void {
    const w = this.writer;
    const code = ITEM_CODE.get(e.itemId) ?? -1;
    if (code < 0) throw new RangeError(`item "${e.itemId}" has no wire code`);
    w.write(LootOpCode.spawn, LOOT_OP_BITS);
    w.write(e.lootId, LOOT_ID_BITS);
    w.write(code, LOOT_ITEM_CODE_BITS);
    const kind = FIELD_KIND[code]!;
    if (kind === 1) w.write(clampInt(e.quantity, 1, (1 << LOOT_QUANTITY_BITS) - 1), LOOT_QUANTITY_BITS);
    w.write(quantizeLootXZ(e.position[0]), LOOT_POS_XZ_BITS);
    w.write(quantizeLootY(e.position[1]), LOOT_POS_Y_BITS);
    w.write(quantizeLootXZ(e.position[2]), LOOT_POS_XZ_BITS);
    if (kind === 2) w.write(clampInt(e.magazine ?? 0, 0, (1 << LOOT_MAGAZINE_BITS) - 1), LOOT_MAGAZINE_BITS);
    if (kind === 3) w.write(quantizeLootDurability(e.durability ?? 0), LOOT_DURABILITY_BITS);
    const pile = e.pileId !== undefined && e.pileId >= 0 && e.pileId < 1 << LOOT_PILE_BITS ? e.pileId : NO_PILE;
    const same = pile === this.lastPile;
    w.writeBool(same);
    if (!same) {
      w.writeBool(pile !== NO_PILE);
      if (pile !== NO_PILE) w.write(pile, LOOT_PILE_BITS);
      this.lastPile = pile;
    }
    w.writeBool(ownDrop);
    this.opCount++;
  }

  remove(lootId: number): void {
    this.writer.write(LootOpCode.remove, LOOT_OP_BITS);
    this.writer.write(lootId, LOOT_ID_BITS);
    this.opCount++;
  }

  quantity(lootId: number, quantity: number): void {
    this.writer.write(LootOpCode.quantity, LOOT_OP_BITS);
    this.writer.write(lootId, LOOT_ID_BITS);
    this.writer.write(clampInt(quantity, 1, (1 << LOOT_QUANTITY_BITS) - 1), LOOT_QUANTITY_BITS);
    this.opCount++;
  }

  forgetCell(cell: number): void {
    this.writer.write(LootOpCode.forgetCell, LOOT_OP_BITS);
    this.writer.write(cell, LOOT_CELL_BITS);
    this.opCount++;
  }

  clear(): void {
    this.writer.write(LootOpCode.clear, LOOT_OP_BITS);
    this.opCount++;
    this.lastPile = -2;
  }

  /** Ends the message: its bytes (valid until the next `begin`), or null when it holds no op. */
  finish(): Uint8Array | null {
    if (this.opCount === 0) return null;
    this.writer.write(LootOpCode.end, LOOT_OP_BITS);
    return this.writer.bytes();
  }
}

// ---- Reader -----------------------------------------------------------------------------------------------------

/** Decode target: `ops[0..count)` are valid; storage is pooled. */
export interface LootUpdateBuffer {
  count: number;
  readonly ops: LootOp[];
}

export function createLootUpdateBuffer(): LootUpdateBuffer {
  return { count: 0, ops: [] };
}

/**
 * Decodes a whole `LootUpdate` into `out` (never throws). False when malformed: unknown op, bad item code, quantity 0,
 * missing `end`, or bytes left after it. Validate-then-apply: nothing is applied from a message that fails.
 */
export function decodeLootUpdateInto(r: BitReader, out: LootUpdateBuffer): boolean {
  out.count = 0;
  if (r.read(8) !== MsgId.LootUpdate) return false;
  let lastPile = NO_PILE;
  let sawPile = false;
  for (;;) {
    const code = r.read(LOOT_OP_BITS);
    if (r.overflowed) return false;
    if (code === LootOpCode.end) break;
    if (out.ops.length <= out.count) out.ops.push(createLootOp());
    const op = out.ops[out.count]!;
    op.op = code as LootOpCode;
    op.lootId = 0;
    op.itemCode = 0;
    op.quantity = 0;
    op.xCm = op.yCm = op.zCm = 0;
    op.magazine = 0;
    op.durabilityQ = 0;
    op.pileId = NO_PILE;
    op.ownDrop = false;
    op.cell = 0;
    switch (code) {
      case LootOpCode.spawn: {
        op.lootId = r.read(LOOT_ID_BITS);
        const item = r.read(LOOT_ITEM_CODE_BITS);
        const kind = FIELD_KIND[item];
        if (kind === undefined) return false;
        op.itemCode = item;
        op.quantity = kind === 1 ? r.read(LOOT_QUANTITY_BITS) : 1;
        if (op.quantity === 0 || op.quantity > ITEMS[ITEM_IDS[item]!].maxStack) return false;
        op.xCm = r.read(LOOT_POS_XZ_BITS);
        op.yCm = r.read(LOOT_POS_Y_BITS);
        op.zCm = r.read(LOOT_POS_XZ_BITS);
        if (kind === 2) op.magazine = r.read(LOOT_MAGAZINE_BITS);
        if (kind === 3) op.durabilityQ = r.read(LOOT_DURABILITY_BITS);
        if (r.readBool()) {
          if (!sawPile) return false;
        } else {
          lastPile = r.readBool() ? r.read(LOOT_PILE_BITS) : NO_PILE;
          sawPile = true;
        }
        op.pileId = lastPile;
        op.ownDrop = r.readBool();
        break;
      }
      case LootOpCode.remove:
        op.lootId = r.read(LOOT_ID_BITS);
        break;
      case LootOpCode.quantity:
        op.lootId = r.read(LOOT_ID_BITS);
        op.quantity = r.read(LOOT_QUANTITY_BITS);
        if (op.quantity === 0) return false;
        break;
      case LootOpCode.forgetCell:
        op.cell = r.read(LOOT_CELL_BITS);
        if (op.cell >= LOOT_GRID_CELLS * LOOT_GRID_CELLS) return false;
        break;
      case LootOpCode.clear:
        sawPile = false;
        lastPile = NO_PILE;
        break;
      default:
        return false;
    }
    if (r.overflowed) return false;
    out.count++;
  }
  return !r.overflowed && r.bitsLeft < 8;
}

/** Allocating decode (tests, tooling): the ops, or null when malformed. */
export function decodeLootUpdate(r: BitReader): LootOp[] | null {
  const out = createLootUpdateBuffer();
  if (!decodeLootUpdateInto(r, out)) return null;
  return out.ops.slice(0, out.count).map((op) => ({ ...op }));
}

// ---- Actions ----------------------------------------------------------------------------------------------------

/**
 * `pickup` action arg (v7): loot id in the low 14 bits, and 2 bits for the weapon slot a gun should go to (0 = the
 * server's default: an empty slot, else the primary in hand; 1..3 = slot 0..2, the inventory screen's drag target).
 * Bots send the bare loot id.
 */
export function encodePickupArg(lootId: number, replaceSlot: number = -1): number {
  const slot = replaceSlot >= 0 && replaceSlot <= 2 ? replaceSlot + 1 : 0;
  return (lootId & (NET_LOOT_ID_LIMIT - 1)) | (slot << 14);
}

export function decodePickupArg(arg: number): { readonly lootId: number; readonly replaceSlot: -1 | 0 | 1 | 2 } {
  return { lootId: arg & (NET_LOOT_ID_LIMIT - 1), replaceSlot: (((arg >>> 14) & 3) - 1) as -1 | 0 | 1 | 2 };
}

/** `equipAttach` action args (v7; attachments don't exist yet, so the type carries inventory ops). */
export const NetInventoryOp = { swapPrimaries: 1 } as const;
