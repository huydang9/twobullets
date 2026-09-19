import type { BitReader, BitWriter } from "../bits";
import { createBitWriter } from "../bits";
import { MsgId } from "./ids";

// Server-authoritative destructible walls on the control stream (protocol v10). The maze (`map/mazeBr.ts`) is the one
// map whose geometry a player can change: a frag takes a mirror pane out for good, a molotov burns a grass hedge away,
// and a smoke cloud closes the apertures rounds punched through a pane that is still standing
// (`shared/equipment/destructible.ts`). The server runs those rules — the same pure resolvers the offline match runs —
// and every client applies the answer.
//
// **Why an index is the whole payload.** Both ends build the same `DestructibleWalls` from the same map layout with
// `buildDestructibleWalls`, which walks `layout.props` in order, so wall 37 is the same pane on every machine. No
// position, prop id, instance or radius has to travel: a frag that takes three panes is three 19-bit ops.
//
// Not area-of-interest limited, unlike loot and throwables. A destroyed pane is map geometry — it changes routes, the
// minimap read and what a teammate three hundred metres away is looking at — and the whole match's worth of changes is
// a few dozen ops, so every client hears about every wall.
//
// Ordering: the stream is reliable and ordered, so no sequence numbers. A joining or resyncing client is sent `clear`
// followed by one op per destroyed and per holed wall — the state, not the history, because the change log is a ring
// (`DestructibleWalls.logCapacity`) and a client that was never there has nothing to replay from.

export const WALL_OP_BITS = 3;
export const WallOpCode = {
  /** A mirror pane a frag took out, or a hedge a molotov burnt away. Permanent. */
  destroyed: 0,
  /** A standing pane's bullet holes closed (a smoke cloud sat on it long enough). */
  repaired: 1,
  /** A standing pane went from no apertures to holed: a round crossed it. Only the 0 → 1 transition travels. */
  holed: 2,
  /** A cloud is `progress` of the way through closing a holed pane's apertures, so the glass grows back gradually. */
  healing: 3,
  /** Drop the hole and heal state; the ops that follow restate what is destroyed (join, reconnect, match reset). */
  clear: 4,
  end: 7,
} as const;
export type WallOpCode = (typeof WallOpCode)[keyof typeof WallOpCode];

/** Wall index in `buildDestructibleWalls(layout)` order. The maze carries about 150; 16 bits is room for any map. */
export const WALL_INDEX_BITS = 16;
/**
 * Heal progress, 1/15. The renderer redraws a healing pane on `MIRROR_HOLE.healSteps` (12) steps anyway, so 16 levels
 * is finer than anything that can be seen and one op covers a whole step.
 */
export const WALL_HEAL_BITS = 4;
export const WALL_HEAL_LEVELS = (1 << WALL_HEAL_BITS) - 1;

/** The server closes a message and starts another once it passes this size. */
export const WALL_UPDATE_SOFT_BYTES = 900;
/** Largest single op (`healing`), bytes, rounded up. */
export const WALL_OP_MAX_BYTES = 4;

/** One decoded op; fields outside the op's payload read 0. */
export interface WallOp {
  op: WallOpCode;
  /** Wall index (0 on `clear`). */
  index: number;
  /** `healing` only: 0..1. */
  progress: number;
}

export function createWallOp(): WallOp {
  return { op: WallOpCode.destroyed, index: 0, progress: 0 };
}

function clampInt(v: number, lo: number, hi: number): number {
  if (v !== v) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export function quantizeWallHeal(progress: number): number {
  return clampInt(Math.round(progress * WALL_HEAL_LEVELS), 0, WALL_HEAL_LEVELS);
}
export function dequantizeWallHeal(q: number): number {
  return q / WALL_HEAL_LEVELS;
}

// ---- Writer ---------------------------------------------------------------------------------------------------------

/**
 * Builds one `WallUpdate` (0x53, S→C stream): id 8, then ops (op 3 + payload) until `end`.
 * Reuse one writer per recipient: `begin`, ops, `finish` (null when no op was written).
 */
export class WallUpdateWriter {
  readonly writer: BitWriter;
  private opCount = 0;

  constructor(capacityBytes = WALL_UPDATE_SOFT_BYTES + 64) {
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
    return this.writer.byteLength + WALL_OP_MAX_BYTES > WALL_UPDATE_SOFT_BYTES;
  }

  begin(): void {
    this.writer.reset();
    this.writer.write(MsgId.WallUpdate, 8);
    this.opCount = 0;
  }

  destroyed(index: number): void {
    this.indexOp(WallOpCode.destroyed, index);
  }

  repaired(index: number): void {
    this.indexOp(WallOpCode.repaired, index);
  }

  holed(index: number): void {
    this.indexOp(WallOpCode.holed, index);
  }

  healing(index: number, progress: number): void {
    this.writer.write(WallOpCode.healing, WALL_OP_BITS);
    this.writer.write(index, WALL_INDEX_BITS);
    this.writer.write(quantizeWallHeal(progress), WALL_HEAL_BITS);
    this.opCount++;
  }

  clear(): void {
    this.writer.write(WallOpCode.clear, WALL_OP_BITS);
    this.opCount++;
  }

  /** Ends the message: its bytes (valid until the next `begin`), or null when it holds no op. */
  finish(): Uint8Array | null {
    if (this.opCount === 0) return null;
    this.writer.write(WallOpCode.end, WALL_OP_BITS);
    return this.writer.bytes();
  }

  private indexOp(op: WallOpCode, index: number): void {
    this.writer.write(op, WALL_OP_BITS);
    this.writer.write(index, WALL_INDEX_BITS);
    this.opCount++;
  }
}

// ---- Reader ---------------------------------------------------------------------------------------------------------

/** Decode target: `ops[0..count)` are valid; storage is pooled. */
export interface WallUpdateBuffer {
  count: number;
  readonly ops: WallOp[];
}

export function createWallUpdateBuffer(): WallUpdateBuffer {
  return { count: 0, ops: [] };
}

/**
 * Decodes a whole `WallUpdate` into `out` (never throws). False when malformed: unknown op, missing `end`, or bytes
 * left after it. Validate-then-apply: nothing is applied from a message that fails.
 */
export function decodeWallUpdateInto(r: BitReader, out: WallUpdateBuffer): boolean {
  out.count = 0;
  if (r.read(8) !== MsgId.WallUpdate) return false;
  for (;;) {
    const code = r.read(WALL_OP_BITS);
    if (r.overflowed) return false;
    if (code === WallOpCode.end) break;
    if (out.ops.length <= out.count) out.ops.push(createWallOp());
    const op = out.ops[out.count]!;
    op.op = code as WallOpCode;
    op.index = 0;
    op.progress = 0;
    switch (code) {
      case WallOpCode.destroyed:
      case WallOpCode.repaired:
      case WallOpCode.holed:
        op.index = r.read(WALL_INDEX_BITS);
        break;
      case WallOpCode.healing:
        op.index = r.read(WALL_INDEX_BITS);
        op.progress = dequantizeWallHeal(r.read(WALL_HEAL_BITS));
        break;
      case WallOpCode.clear:
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
export function decodeWallUpdate(r: BitReader): WallOp[] | null {
  const out = createWallUpdateBuffer();
  if (!decodeWallUpdateInto(r, out)) return null;
  return out.ops.slice(0, out.count).map((op) => ({ ...op }));
}
