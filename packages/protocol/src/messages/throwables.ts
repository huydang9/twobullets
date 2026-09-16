import { THROWABLE_KINDS, throwableDef, type ThrowableKind } from "@twobullets/shared/equipment/items";
import { FLASH } from "@twobullets/shared/equipment/flash";
import type { BitReader, BitWriter } from "../bits";
import { createBitWriter } from "../bits";
import { ACTOR_BITS, actorCode, actorFromCode } from "../codes";
import { dequantizeLootXZ, dequantizeLootY, lootCellOf, quantizeLootXZ, quantizeLootY } from "./loot";
import { MsgId } from "./ids";

// Server-authoritative throwables on the control stream (protocol v9). The server flies every grenade with the shared
// rules (`stepEquipmentWorld`) and tells each client what happens inside its area of interest: a grenade spawning,
// where it is (a low-rate correction on top of the client's own flight), and the effects a detonation leaves — a blast
// at a point, a smoke cloud, a fire area, and a flash for the player it blinded. Ops are listed in one message ended by
// `end`, exactly like `LootUpdate`; the stream is reliable and ordered, so no sequence numbers are needed.
//
// Cloud and fire *shapes* are not on the wire: the client rebuilds them from the id, the point and the server's seed
// with the same `createSmokeCloud` / `createFirePatch` the server ran, so 100 puffs and 40 fire cells cost 13 bytes.

/** A cell enters a client's throwable view within this many loot cells (5 × 32 m) of its own; one cell of hysteresis. */
export const THROWABLE_AOI_ENTER_CELLS = 5;
export const THROWABLE_AOI_LEAVE_CELLS = 6;

export const THROWABLE_OP_BITS = 4;
export const ThrowableOpCode = {
  spawn: 0,
  move: 1,
  remove: 2,
  detonate: 3,
  smokeStart: 4,
  smokeEnd: 5,
  fireStart: 6,
  fireEnd: 7,
  flash: 8,
  clear: 9,
  end: 15,
} as const;
export type ThrowableOpCode = (typeof ThrowableOpCode)[keyof typeof ThrowableOpCode];

/** Throwable and effect ids: the shared `throwId` (owner slot << 16 | counter) truncated to 16 bits. */
export const THROWABLE_ID_BITS = 16;
export const THROWABLE_KIND_BITS = 2;
/** Velocity per axis, 1/16 m/s zigzag (±63.9 m/s covers a throw plus the thrower's speed). */
export const THROWABLE_VEL_BITS = 12;
export const THROWABLE_VEL_SCALE = 16;
/** Fuse left, 1/128 s (≤ 7.99 s; the longest fuse is the frag's 4.5 s). */
export const THROWABLE_FUSE_BITS = 10;
export const THROWABLE_FUSE_SCALE = 128;
/** Contact normal per axis, 1/127 zigzag. */
export const THROWABLE_NORMAL_BITS = 8;
/** Flash blind/deaf strength, 1/255. */
export const FLASH_STRENGTH_BITS = 8;
export const EFFECT_SEED_BITS = 32;

/** The server closes a message and starts another once it passes this size. */
export const THROWABLE_UPDATE_SOFT_BYTES = 900;
/** Largest single op (`fireStart`), bytes, rounded up. */
export const THROWABLE_OP_MAX_BYTES = 18;

/** One decoded op; fields outside the op's payload read 0. */
export interface ThrowableOp {
  op: ThrowableOpCode;
  id: number;
  /** `THROWABLE_KINDS` index. */
  kind: number;
  /** Owner slot (−1 when the op carries none). */
  owner: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuse: number;
  nx: number;
  ny: number;
  nz: number;
  /** u32 effect seed (smoke, fire). */
  seed: number;
  /** Flash: 0..1. */
  blind: number;
  deaf: number;
}

export function createThrowableOp(): ThrowableOp {
  return { op: ThrowableOpCode.spawn, id: 0, kind: 0, owner: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fuse: 0, nx: 0, ny: 1, nz: 0, seed: 0, blind: 0, deaf: 0 };
}

// ---- Codes and quantization ---------------------------------------------------------------------------------------

export function throwableKindCode(kind: ThrowableKind): number {
  const i = THROWABLE_KINDS.indexOf(kind);
  return i < 0 ? 0 : i;
}

export function throwableKindOfCode(code: number): ThrowableKind | null {
  return THROWABLE_KINDS[code] ?? null;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (v !== v) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

const VEL_LIMIT = (1 << (THROWABLE_VEL_BITS - 1)) - 1;

export function quantizeThrowVelocity(mps: number): number {
  return clampInt(Math.round(mps * THROWABLE_VEL_SCALE), -VEL_LIMIT, VEL_LIMIT);
}
export function dequantizeThrowVelocity(q: number): number {
  return q / THROWABLE_VEL_SCALE;
}
export function quantizeThrowFuse(seconds: number): number {
  return clampInt(Math.round(seconds * THROWABLE_FUSE_SCALE), 0, (1 << THROWABLE_FUSE_BITS) - 1);
}
export function dequantizeThrowFuse(q: number): number {
  return q / THROWABLE_FUSE_SCALE;
}
function quantizeNormal(n: number): number {
  return clampInt(Math.round(n * 127), -127, 127);
}
function dequantizeNormal(q: number): number {
  return q / 127;
}

/** AOI cell of a world point (the loot grid, so both systems agree at cell edges). */
export const throwableCellOf = lootCellOf;

// ---- Throw action -------------------------------------------------------------------------------------------------

export const THROW_STYLES = ["overhand", "underhand", "dropped", "inHand"] as const;
export type ThrowStyle = (typeof THROW_STYLES)[number];

/**
 * `throwItem` action arg (v9): kind 2 | style 2 | fuse left in 1/128 s, 10 bits. The server rebuilds the hand position
 * and launch velocity from its own view of the thrower with the shared `throwLaunch`, so only the intent travels.
 */
export function encodeThrowArg(kind: ThrowableKind, style: ThrowStyle, fuseSeconds: number): number {
  const styleCode = Math.max(0, THROW_STYLES.indexOf(style));
  return throwableKindCode(kind) | (styleCode << 2) | (quantizeThrowFuse(fuseSeconds) << 4);
}

export interface DecodedThrowArg {
  readonly kind: ThrowableKind;
  readonly style: ThrowStyle;
  readonly fuseSeconds: number;
}

/** Null when the arg names no kind/style, or a fuse longer than the kind's own. */
export function decodeThrowArg(arg: number): DecodedThrowArg | null {
  const kind = throwableKindOfCode(arg & 3);
  const style = THROW_STYLES[(arg >>> 2) & 3];
  if (kind === null || style === undefined) return null;
  const fuseSeconds = dequantizeThrowFuse((arg >>> 4) & ((1 << THROWABLE_FUSE_BITS) - 1));
  if (fuseSeconds > throwableDef(kind).fuseSeconds + 1 / THROWABLE_FUSE_SCALE) return null;
  return { kind, style, fuseSeconds };
}

// ---- Writer -------------------------------------------------------------------------------------------------------

export interface ThrowableSpawnOp {
  readonly id: number;
  readonly owner: number;
  readonly kind: ThrowableKind;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  readonly fuse: number;
}

/**
 * Builds one `ThrowableUpdate` (0x52, S→C stream): id 8, then ops (op 4 + payload) until `end`.
 * Reuse one writer per recipient: `begin`, ops, `finish` (null when no op was written).
 */
export class ThrowableUpdateWriter {
  readonly writer: BitWriter;
  private opCount = 0;

  constructor(capacityBytes = THROWABLE_UPDATE_SOFT_BYTES + 64) {
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
    return this.writer.byteLength + THROWABLE_OP_MAX_BYTES > THROWABLE_UPDATE_SOFT_BYTES;
  }

  begin(): void {
    this.writer.reset();
    this.writer.write(MsgId.ThrowableUpdate, 8);
    this.opCount = 0;
  }

  spawn(e: ThrowableSpawnOp): void {
    const w = this.writer;
    w.write(ThrowableOpCode.spawn, THROWABLE_OP_BITS);
    w.write(e.id, THROWABLE_ID_BITS);
    w.write(throwableKindCode(e.kind), THROWABLE_KIND_BITS);
    w.write(actorCode(e.owner), ACTOR_BITS);
    this.position(e.position.x, e.position.y, e.position.z);
    this.velocity(e.velocity.x, e.velocity.y, e.velocity.z);
    w.write(quantizeThrowFuse(e.fuse), THROWABLE_FUSE_BITS);
    this.opCount++;
  }

  move(id: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.writer.write(ThrowableOpCode.move, THROWABLE_OP_BITS);
    this.writer.write(id, THROWABLE_ID_BITS);
    this.position(x, y, z);
    this.velocity(vx, vy, vz);
    this.opCount++;
  }

  remove(id: number): void {
    this.writer.write(ThrowableOpCode.remove, THROWABLE_OP_BITS);
    this.writer.write(id, THROWABLE_ID_BITS);
    this.opCount++;
  }

  detonate(id: number, owner: number, kind: ThrowableKind, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    const w = this.writer;
    w.write(ThrowableOpCode.detonate, THROWABLE_OP_BITS);
    w.write(id, THROWABLE_ID_BITS);
    w.write(throwableKindCode(kind), THROWABLE_KIND_BITS);
    w.write(actorCode(owner), ACTOR_BITS);
    this.position(x, y, z);
    this.normal(nx, ny, nz);
    this.opCount++;
  }

  smokeStart(id: number, x: number, y: number, z: number, seed: number): void {
    this.writer.write(ThrowableOpCode.smokeStart, THROWABLE_OP_BITS);
    this.writer.write(id, THROWABLE_ID_BITS);
    this.position(x, y, z);
    this.writer.write(seed >>> 0, EFFECT_SEED_BITS);
    this.opCount++;
  }

  smokeEnd(id: number): void {
    this.writer.write(ThrowableOpCode.smokeEnd, THROWABLE_OP_BITS);
    this.writer.write(id, THROWABLE_ID_BITS);
    this.opCount++;
  }

  fireStart(id: number, owner: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, seed: number): void {
    const w = this.writer;
    w.write(ThrowableOpCode.fireStart, THROWABLE_OP_BITS);
    w.write(id, THROWABLE_ID_BITS);
    w.write(actorCode(owner), ACTOR_BITS);
    this.position(x, y, z);
    this.normal(nx, ny, nz);
    w.write(seed >>> 0, EFFECT_SEED_BITS);
    this.opCount++;
  }

  fireEnd(id: number): void {
    this.writer.write(ThrowableOpCode.fireEnd, THROWABLE_OP_BITS);
    this.writer.write(id, THROWABLE_ID_BITS);
    this.opCount++;
  }

  /** Only to the blinded player: strengths 0..1 (the seconds follow from FLASH). */
  flash(id: number, blind: number, deaf: number): void {
    const w = this.writer;
    w.write(ThrowableOpCode.flash, THROWABLE_OP_BITS);
    w.write(id, THROWABLE_ID_BITS);
    w.write(clampInt(Math.round(blind * 255), 0, 255), FLASH_STRENGTH_BITS);
    w.write(clampInt(Math.round(deaf * 255), 0, 255), FLASH_STRENGTH_BITS);
    this.opCount++;
  }

  /** Drop every throwable and effect the client holds (join, reconnect, match reset). */
  clear(): void {
    this.writer.write(ThrowableOpCode.clear, THROWABLE_OP_BITS);
    this.opCount++;
  }

  /** Ends the message: its bytes (valid until the next `begin`), or null when it holds no op. */
  finish(): Uint8Array | null {
    if (this.opCount === 0) return null;
    this.writer.write(ThrowableOpCode.end, THROWABLE_OP_BITS);
    return this.writer.bytes();
  }

  private position(x: number, y: number, z: number): void {
    this.writer.write(quantizeLootXZ(x), 17);
    this.writer.write(quantizeLootY(y), 16);
    this.writer.write(quantizeLootXZ(z), 17);
  }

  private velocity(x: number, y: number, z: number): void {
    this.writer.writeSigned(quantizeThrowVelocity(x), THROWABLE_VEL_BITS);
    this.writer.writeSigned(quantizeThrowVelocity(y), THROWABLE_VEL_BITS);
    this.writer.writeSigned(quantizeThrowVelocity(z), THROWABLE_VEL_BITS);
  }

  private normal(x: number, y: number, z: number): void {
    this.writer.writeSigned(quantizeNormal(x), THROWABLE_NORMAL_BITS);
    this.writer.writeSigned(quantizeNormal(y), THROWABLE_NORMAL_BITS);
    this.writer.writeSigned(quantizeNormal(z), THROWABLE_NORMAL_BITS);
  }
}

// ---- Reader -------------------------------------------------------------------------------------------------------

/** Decode target: `ops[0..count)` are valid; storage is pooled. */
export interface ThrowableUpdateBuffer {
  count: number;
  readonly ops: ThrowableOp[];
}

export function createThrowableUpdateBuffer(): ThrowableUpdateBuffer {
  return { count: 0, ops: [] };
}

/**
 * Decodes a whole `ThrowableUpdate` into `out` (never throws). False when malformed: unknown op, owner out of range,
 * missing `end`, or bytes left after it. Validate-then-apply: nothing is applied from a message that fails.
 */
export function decodeThrowableUpdateInto(r: BitReader, out: ThrowableUpdateBuffer): boolean {
  out.count = 0;
  if (r.read(8) !== MsgId.ThrowableUpdate) return false;
  for (;;) {
    const code = r.read(THROWABLE_OP_BITS);
    if (r.overflowed) return false;
    if (code === ThrowableOpCode.end) break;
    if (out.ops.length <= out.count) out.ops.push(createThrowableOp());
    const op = out.ops[out.count]!;
    op.op = code as ThrowableOpCode;
    op.id = 0;
    op.kind = 0;
    op.owner = -1;
    op.x = op.y = op.z = 0;
    op.vx = op.vy = op.vz = 0;
    op.fuse = 0;
    op.nx = 0;
    op.ny = 1;
    op.nz = 0;
    op.seed = 0;
    op.blind = 0;
    op.deaf = 0;
    switch (code) {
      case ThrowableOpCode.spawn:
        op.id = r.read(THROWABLE_ID_BITS);
        op.kind = r.read(THROWABLE_KIND_BITS);
        op.owner = actorFromCode(r.read(ACTOR_BITS));
        readPosition(r, op);
        readVelocity(r, op);
        op.fuse = dequantizeThrowFuse(r.read(THROWABLE_FUSE_BITS));
        break;
      case ThrowableOpCode.move:
        op.id = r.read(THROWABLE_ID_BITS);
        readPosition(r, op);
        readVelocity(r, op);
        break;
      case ThrowableOpCode.remove:
      case ThrowableOpCode.smokeEnd:
      case ThrowableOpCode.fireEnd:
        op.id = r.read(THROWABLE_ID_BITS);
        break;
      case ThrowableOpCode.detonate:
        op.id = r.read(THROWABLE_ID_BITS);
        op.kind = r.read(THROWABLE_KIND_BITS);
        op.owner = actorFromCode(r.read(ACTOR_BITS));
        readPosition(r, op);
        readNormal(r, op);
        break;
      case ThrowableOpCode.smokeStart:
        op.id = r.read(THROWABLE_ID_BITS);
        readPosition(r, op);
        op.seed = r.read(EFFECT_SEED_BITS) >>> 0;
        break;
      case ThrowableOpCode.fireStart:
        op.id = r.read(THROWABLE_ID_BITS);
        op.owner = actorFromCode(r.read(ACTOR_BITS));
        readPosition(r, op);
        readNormal(r, op);
        op.seed = r.read(EFFECT_SEED_BITS) >>> 0;
        break;
      case ThrowableOpCode.flash:
        op.id = r.read(THROWABLE_ID_BITS);
        op.blind = r.read(FLASH_STRENGTH_BITS) / 255;
        op.deaf = r.read(FLASH_STRENGTH_BITS) / 255;
        break;
      case ThrowableOpCode.clear:
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
export function decodeThrowableUpdate(r: BitReader): ThrowableOp[] | null {
  const out = createThrowableUpdateBuffer();
  if (!decodeThrowableUpdateInto(r, out)) return null;
  return out.ops.slice(0, out.count).map((op) => ({ ...op }));
}

/** Blind and deaf seconds of a decoded `flash` op (the shared FLASH tuning). */
export function flashSecondsOf(op: Pick<ThrowableOp, "blind" | "deaf">): { readonly blindSeconds: number; readonly deafSeconds: number } {
  return { blindSeconds: op.blind * FLASH.maxBlindSeconds, deafSeconds: op.deaf * FLASH.maxDeafSeconds };
}

function readPosition(r: BitReader, op: ThrowableOp): void {
  op.x = dequantizeLootXZ(r.read(17));
  op.y = dequantizeLootY(r.read(16));
  op.z = dequantizeLootXZ(r.read(17));
}

function readVelocity(r: BitReader, op: ThrowableOp): void {
  op.vx = dequantizeThrowVelocity(r.readSigned(THROWABLE_VEL_BITS));
  op.vy = dequantizeThrowVelocity(r.readSigned(THROWABLE_VEL_BITS));
  op.vz = dequantizeThrowVelocity(r.readSigned(THROWABLE_VEL_BITS));
}

function readNormal(r: BitReader, op: ThrowableOp): void {
  op.nx = dequantizeNormal(r.readSigned(THROWABLE_NORMAL_BITS));
  op.ny = dequantizeNormal(r.readSigned(THROWABLE_NORMAL_BITS));
  op.nz = dequantizeNormal(r.readSigned(THROWABLE_NORMAL_BITS));
}
