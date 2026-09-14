import type { BitReader, BitWriter } from "../bits";
import {
  AUDIBLE_XZ_BITS,
  AUDIBLE_Y_BITS,
  audibleXZFromMm,
  audibleXZToMm,
  audibleYFromMm,
  audibleYToMm,
  OWNER_VEL_BITS,
  POS_XZ_BITS,
  POS_Y_BITS,
  REMOTE_FLAG_BITS,
  REMOTE_PITCH_BITS,
  REMOTE_VEL_BITS,
  REMOTE_YAW_BITS,
} from "../quantize";
import { decodeOptionalTick16, encodeOptionalTick16, unwrapTick16 } from "../ticks";
import { MsgId } from "./ids";

// 0x10, S→C datagram (netcode.md §6.5). M3 scope: header, owner move block, entity list; events arrive in M4.
// Decoded structs carry quantized integers (mm, mm/s, angle steps) so baselines and deltas compare exactly;
// dequantization lives in quantize.ts.

/** Payload cap: min(SNAPSHOT_MAX_BYTES, session maxDatagramSize). */
export const SNAPSHOT_MAX_BYTES = 1000;
/** Per-client baseline ring (D9). */
export const BASELINE_RING = 128;
/** Player slots 0..15. */
export const MAX_ENTITY_SLOTS = 16;

export const SnapshotSection = { owner: 1, entities: 2, shots: 4, reliable: 8, throwables: 16, versions: 32 } as const;

export interface SnapshotHeader {
  /** u32 after unwrap (u16 on the wire). */
  readonly serverTick: number;
  /** Tick of the baseline this delta is encoded against, or null for a full snapshot. */
  readonly baselineTick: number | null;
  /** Recipient's newest simulated real input tick; `NO_TICK` (−1) before any input arrived. */
  readonly lastProcessedInputTick: number;
  /** `clientTimeMs` of the newest input received. */
  readonly clientTimeEcho: number;
  /** Receipt of that input → this send, ms (0..255). */
  readonly serverHoldMs: number;
  /** Signed, quarter ticks (time dilation feedback), −128..127. */
  readonly inputBufferDepthQ: number;
  /** `SnapshotSection` bits. The encoder derives them from the content; decoded snapshots carry what was sent. */
  readonly sections: number;
}

export interface OwnerMoveBlock {
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
  readonly vxMmS: number;
  readonly vyMmS: number;
  readonly vzMmS: number;
  /** 0 stand, 1 crouch, 2 prone. */
  readonly stance: number;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  readonly jumpHeld: boolean;
  /** 0 ground (M5 adds freefall/parachute). */
  readonly moveMode: number;
  readonly coyoteTicks: number;
  readonly jumpBufferTicks: number;
  readonly groundIgnoreTicks: number;
}

export const EntityPresence = { absent: 0, full: 1, audibleOnly: 2, removed: 3 } as const;
export type EntityPresence = (typeof EntityPresence)[keyof typeof EntityPresence];

export interface EntityState {
  /** Player slot 0..15. */
  readonly slot: number;
  readonly presence: EntityPresence;
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
  /** 12-bit yaw steps. */
  readonly yawQ: number;
  /** 10-bit pitch steps. */
  readonly pitchQ: number;
  /** 0.125 m/s steps. */
  readonly vxQ: number;
  readonly vyQ: number;
  readonly vzQ: number;
  /** 18-bit remote flags (stance, moveMode, grounded, sprint, ads, weaponSlot, …). */
  readonly flags: number;
  /** Audible-only entities: 3-bit noise class (M5). Absent/0 otherwise. */
  readonly noiseClass?: number;
}

export interface Snapshot {
  readonly header: SnapshotHeader;
  readonly owner: OwnerMoveBlock | null;
  /** Sorted by slot, unique slots; `absent` entries are not listed. */
  readonly entities: readonly EntityState[];
}

// ---- Mutable storage (decode targets, baseline rings) -----------------------------------------------------------

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface MutableSnapshot {
  header: Mutable<SnapshotHeader>;
  owner: Mutable<OwnerMoveBlock> | null;
  entities: Mutable<EntityState>[];
  /** Preallocated storage behind `owner` and `entities`. */
  readonly ownerStore: Mutable<OwnerMoveBlock>;
  readonly entityPool: Mutable<EntityState>[];
}

function createOwner(): Mutable<OwnerMoveBlock> {
  return {
    xMm: 0,
    yMm: 0,
    zMm: 0,
    vxMmS: 0,
    vyMmS: 0,
    vzMmS: 0,
    stance: 0,
    grounded: false,
    sprinting: false,
    jumpHeld: false,
    moveMode: 0,
    coyoteTicks: 0,
    jumpBufferTicks: 0,
    groundIgnoreTicks: 0,
  };
}

function createEntity(): Mutable<EntityState> {
  return { slot: 0, presence: 0, xMm: 0, yMm: 0, zMm: 0, yawQ: 0, pitchQ: 0, vxQ: 0, vyQ: 0, vzQ: 0, flags: 0, noiseClass: 0 };
}

export function createSnapshotBuffer(): MutableSnapshot {
  const entityPool: Mutable<EntityState>[] = [];
  for (let i = 0; i < MAX_ENTITY_SLOTS; i++) entityPool.push(createEntity());
  return {
    header: {
      serverTick: 0,
      baselineTick: null,
      lastProcessedInputTick: -1,
      clientTimeEcho: 0,
      serverHoldMs: 0,
      inputBufferDepthQ: 0,
      sections: 0,
    },
    owner: null,
    entities: [],
    ownerStore: createOwner(),
    entityPool,
  };
}

export function copyOwnerMove(src: OwnerMoveBlock, dst: Mutable<OwnerMoveBlock>): void {
  dst.xMm = src.xMm;
  dst.yMm = src.yMm;
  dst.zMm = src.zMm;
  dst.vxMmS = src.vxMmS;
  dst.vyMmS = src.vyMmS;
  dst.vzMmS = src.vzMmS;
  dst.stance = src.stance;
  dst.grounded = src.grounded;
  dst.sprinting = src.sprinting;
  dst.jumpHeld = src.jumpHeld;
  dst.moveMode = src.moveMode;
  dst.coyoteTicks = src.coyoteTicks;
  dst.jumpBufferTicks = src.jumpBufferTicks;
  dst.groundIgnoreTicks = src.groundIgnoreTicks;
}

export function copyEntityState(src: EntityState, dst: Mutable<EntityState>): void {
  dst.slot = src.slot;
  dst.presence = src.presence;
  dst.xMm = src.xMm;
  dst.yMm = src.yMm;
  dst.zMm = src.zMm;
  dst.yawQ = src.yawQ;
  dst.pitchQ = src.pitchQ;
  dst.vxQ = src.vxQ;
  dst.vyQ = src.vyQ;
  dst.vzQ = src.vzQ;
  dst.flags = src.flags;
  dst.noiseClass = src.noiseClass ?? 0;
}

/** Deep copy into preallocated storage (no allocation once `dst.entities` has grown to its steady size). */
export function copySnapshot(src: Snapshot, dst: MutableSnapshot): void {
  const h = src.header;
  dst.header.serverTick = h.serverTick;
  dst.header.baselineTick = h.baselineTick;
  dst.header.lastProcessedInputTick = h.lastProcessedInputTick;
  dst.header.clientTimeEcho = h.clientTimeEcho;
  dst.header.serverHoldMs = h.serverHoldMs;
  dst.header.inputBufferDepthQ = h.inputBufferDepthQ;
  dst.header.sections = h.sections;
  if (src.owner === null) dst.owner = null;
  else {
    copyOwnerMove(src.owner, dst.ownerStore);
    dst.owner = dst.ownerStore;
  }
  const n = Math.min(src.entities.length, MAX_ENTITY_SLOTS);
  dst.entities.length = n;
  for (let i = 0; i < n; i++) {
    const e = dst.entityPool[i]!;
    copyEntityState(src.entities[i]!, e);
    dst.entities[i] = e;
  }
}

// ---- Codec ------------------------------------------------------------------------------------------------------

/** Shared-bucket vector delta widths (zigzag); bucket 3 = absolute. */
const POS_BUCKET_BITS = [8, 12, 16] as const;
const POS_BUCKET_MAX = [127, 2047, 32767] as const;

function writeAbsolutePos(w: BitWriter, x: number, y: number, z: number): void {
  w.write(x, POS_XZ_BITS);
  w.write(y, POS_Y_BITS);
  w.write(z, POS_XZ_BITS);
}

/** Position group: with a base, a changed bit then a bucket code; without, absolute. */
function writePos(w: BitWriter, x: number, y: number, z: number, base: { xMm: number; yMm: number; zMm: number } | null): void {
  if (base === null) {
    writeAbsolutePos(w, x, y, z);
    return;
  }
  const dx = x - base.xMm;
  const dy = y - base.yMm;
  const dz = z - base.zMm;
  if (dx === 0 && dy === 0 && dz === 0) {
    w.writeBool(false);
    return;
  }
  w.writeBool(true);
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  for (let b = 0; b < 3; b++) {
    if (m <= POS_BUCKET_MAX[b]!) {
      const bits = POS_BUCKET_BITS[b]!;
      w.write(b, 2);
      w.writeSigned(dx, bits);
      w.writeSigned(dy, bits);
      w.writeSigned(dz, bits);
      return;
    }
  }
  w.write(3, 2);
  writeAbsolutePos(w, x, y, z);
}

type PosTarget = { xMm: number; yMm: number; zMm: number };

function readPos(r: BitReader, out: PosTarget, base: PosTarget | null): boolean {
  if (base !== null) {
    if (!r.readBool()) {
      out.xMm = base.xMm;
      out.yMm = base.yMm;
      out.zMm = base.zMm;
      return true;
    }
    const bucket = r.read(2);
    if (bucket < 3) {
      const bits = POS_BUCKET_BITS[bucket]!;
      const x = base.xMm + r.readSigned(bits);
      const y = base.yMm + r.readSigned(bits);
      const z = base.zMm + r.readSigned(bits);
      if (x < 0 || y < 0 || z < 0 || x >= 1 << POS_XZ_BITS || y >= 1 << POS_Y_BITS || z >= 1 << POS_XZ_BITS) return false;
      out.xMm = x;
      out.yMm = y;
      out.zMm = z;
      return true;
    }
  }
  out.xMm = r.read(POS_XZ_BITS);
  out.yMm = r.read(POS_Y_BITS);
  out.zMm = r.read(POS_XZ_BITS);
  return true;
}

function ownerFlagsEqual(a: OwnerMoveBlock, b: OwnerMoveBlock): boolean {
  return (
    a.stance === b.stance &&
    a.grounded === b.grounded &&
    a.sprinting === b.sprinting &&
    a.jumpHeld === b.jumpHeld &&
    a.moveMode === b.moveMode &&
    a.coyoteTicks === b.coyoteTicks &&
    a.jumpBufferTicks === b.jumpBufferTicks &&
    a.groundIgnoreTicks === b.groundIgnoreTicks
  );
}

function writeOwner(w: BitWriter, o: OwnerMoveBlock, base: OwnerMoveBlock | null): void {
  writePos(w, o.xMm, o.yMm, o.zMm, base);
  const velSame = base !== null && o.vxMmS === base.vxMmS && o.vyMmS === base.vyMmS && o.vzMmS === base.vzMmS;
  if (base !== null) w.writeBool(!velSame);
  if (!velSame) {
    w.writeSigned(o.vxMmS, OWNER_VEL_BITS);
    w.writeSigned(o.vyMmS, OWNER_VEL_BITS);
    w.writeSigned(o.vzMmS, OWNER_VEL_BITS);
  }
  const flagsSame = base !== null && ownerFlagsEqual(o, base);
  if (base !== null) w.writeBool(!flagsSame);
  if (!flagsSame) {
    w.write(o.stance, 2);
    w.writeBool(o.grounded);
    w.writeBool(o.sprinting);
    w.writeBool(o.jumpHeld);
    w.write(o.moveMode, 2);
    w.write(o.coyoteTicks, 4);
    w.write(o.jumpBufferTicks, 4);
    w.write(o.groundIgnoreTicks, 4);
  }
}

function readOwner(r: BitReader, o: Mutable<OwnerMoveBlock>, base: OwnerMoveBlock | null): boolean {
  if (!readPos(r, o, base)) return false;
  if (base === null || r.readBool()) {
    o.vxMmS = r.readSigned(OWNER_VEL_BITS);
    o.vyMmS = r.readSigned(OWNER_VEL_BITS);
    o.vzMmS = r.readSigned(OWNER_VEL_BITS);
  } else {
    o.vxMmS = base.vxMmS;
    o.vyMmS = base.vyMmS;
    o.vzMmS = base.vzMmS;
  }
  if (base === null || r.readBool()) {
    o.stance = r.read(2);
    o.grounded = r.readBool();
    o.sprinting = r.readBool();
    o.jumpHeld = r.readBool();
    o.moveMode = r.read(2);
    o.coyoteTicks = r.read(4);
    o.jumpBufferTicks = r.read(4);
    o.groundIgnoreTicks = r.read(4);
    if (o.stance === 3) return false;
  } else {
    o.stance = base.stance;
    o.grounded = base.grounded;
    o.sprinting = base.sprinting;
    o.jumpHeld = base.jumpHeld;
    o.moveMode = base.moveMode;
    o.coyoteTicks = base.coyoteTicks;
    o.jumpBufferTicks = base.jumpBufferTicks;
    o.groundIgnoreTicks = base.groundIgnoreTicks;
  }
  return true;
}

function entityEqual(a: EntityState, b: EntityState): boolean {
  return (
    a.xMm === b.xMm &&
    a.yMm === b.yMm &&
    a.zMm === b.zMm &&
    a.yawQ === b.yawQ &&
    a.pitchQ === b.pitchQ &&
    a.vxQ === b.vxQ &&
    a.vyQ === b.vyQ &&
    a.vzQ === b.vzQ &&
    a.flags === b.flags
  );
}

function writeFullEntity(w: BitWriter, e: EntityState, base: EntityState | null): void {
  if (base !== null) {
    const changed = !entityEqual(e, base);
    w.writeBool(changed);
    if (!changed) return;
  }
  writePos(w, e.xMm, e.yMm, e.zMm, base);
  if (base !== null) w.writeBool(e.yawQ !== base.yawQ);
  if (base === null || e.yawQ !== base.yawQ) w.write(e.yawQ, REMOTE_YAW_BITS);
  if (base !== null) w.writeBool(e.pitchQ !== base.pitchQ);
  if (base === null || e.pitchQ !== base.pitchQ) w.write(e.pitchQ, REMOTE_PITCH_BITS);
  const velSame = base !== null && e.vxQ === base.vxQ && e.vyQ === base.vyQ && e.vzQ === base.vzQ;
  if (base !== null) w.writeBool(!velSame);
  if (!velSame) {
    w.writeSigned(e.vxQ, REMOTE_VEL_BITS);
    w.writeSigned(e.vyQ, REMOTE_VEL_BITS);
    w.writeSigned(e.vzQ, REMOTE_VEL_BITS);
  }
  if (base !== null) w.writeBool(e.flags !== base.flags);
  if (base === null || e.flags !== base.flags) w.write(e.flags, REMOTE_FLAG_BITS);
}

function readFullEntity(r: BitReader, e: Mutable<EntityState>, base: EntityState | null): boolean {
  e.noiseClass = 0;
  if (base !== null && !r.readBool()) {
    e.xMm = base.xMm;
    e.yMm = base.yMm;
    e.zMm = base.zMm;
    e.yawQ = base.yawQ;
    e.pitchQ = base.pitchQ;
    e.vxQ = base.vxQ;
    e.vyQ = base.vyQ;
    e.vzQ = base.vzQ;
    e.flags = base.flags;
    return true;
  }
  if (!readPos(r, e, base)) return false;
  e.yawQ = base === null || r.readBool() ? r.read(REMOTE_YAW_BITS) : base.yawQ;
  e.pitchQ = base === null || r.readBool() ? r.read(REMOTE_PITCH_BITS) : base.pitchQ;
  if (base === null || r.readBool()) {
    e.vxQ = r.readSigned(REMOTE_VEL_BITS);
    e.vyQ = r.readSigned(REMOTE_VEL_BITS);
    e.vzQ = r.readSigned(REMOTE_VEL_BITS);
  } else {
    e.vxQ = base.vxQ;
    e.vyQ = base.vyQ;
    e.vzQ = base.vzQ;
  }
  e.flags = base === null || r.readBool() ? r.read(REMOTE_FLAG_BITS) : base.flags;
  return true;
}

function writeAudibleEntity(w: BitWriter, e: EntityState): void {
  w.write(audibleXZFromMm(e.xMm), AUDIBLE_XZ_BITS);
  w.write(audibleYFromMm(e.yMm), AUDIBLE_Y_BITS);
  w.write(audibleXZFromMm(e.zMm), AUDIBLE_XZ_BITS);
  w.write(e.noiseClass ?? 0, 3);
  w.write(e.flags & 0x3, 2);
}

function readAudibleEntity(r: BitReader, e: Mutable<EntityState>): void {
  e.xMm = audibleXZToMm(r.read(AUDIBLE_XZ_BITS));
  e.yMm = audibleYToMm(r.read(AUDIBLE_Y_BITS));
  e.zMm = audibleXZToMm(r.read(AUDIBLE_XZ_BITS));
  e.noiseClass = r.read(3);
  e.flags = r.read(2);
  e.yawQ = 0;
  e.pitchQ = 0;
  e.vxQ = 0;
  e.vyQ = 0;
  e.vzQ = 0;
}

function resetEntityFields(e: Mutable<EntityState>): void {
  e.xMm = 0;
  e.yMm = 0;
  e.zMm = 0;
  e.yawQ = 0;
  e.pitchQ = 0;
  e.vxQ = 0;
  e.vyQ = 0;
  e.vzQ = 0;
  e.flags = 0;
  e.noiseClass = 0;
}

function baselineEntity(baseline: Snapshot | null, slot: number): EntityState | null {
  if (baseline === null) return null;
  const list = baseline.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (e.slot === slot) return e.presence === EntityPresence.full ? e : null;
  }
  return null;
}

/**
 * Encodes against `baseline` (null = full). The caller enforces the size cap. Entities must be sorted by slot with
 * unique slots < 16, and all values in their quantized ranges (use quantize.ts), or the stored baseline and the
 * client's decoded copy diverge. `header.baselineTick` must equal `baseline.header.serverTick` (or null).
 */
export function encodeSnapshot(w: BitWriter, snapshot: Snapshot, baselineIn: Snapshot | null): void {
  // Tick 0xFFFF on the wire means "no baseline", so a baseline with those low bits can't be referenced.
  const baseline = baselineIn !== null && (baselineIn.header.serverTick & 0xffff) !== 0xffff ? baselineIn : null;
  const h = snapshot.header;
  const entities = snapshot.entities;
  const sections = (snapshot.owner !== null ? SnapshotSection.owner : 0) | (entities.length > 0 ? SnapshotSection.entities : 0);
  w.write(MsgId.Snapshot, 8);
  w.write(h.serverTick, 16);
  w.write(baseline === null ? 0xffff : baseline.header.serverTick & 0xffff, 16);
  w.write(encodeOptionalTick16(h.lastProcessedInputTick), 16);
  w.write(h.clientTimeEcho, 16);
  w.write(Math.min(255, Math.max(0, Math.round(h.serverHoldMs))), 8);
  w.write(Math.min(127, Math.max(-128, Math.round(h.inputBufferDepthQ))) & 0xff, 8);
  w.write(sections, 8);
  if (snapshot.owner !== null) writeOwner(w, snapshot.owner, baseline?.owner ?? null);
  if (entities.length > 0) {
    const slotLimit = entities[entities.length - 1]!.slot + 1;
    w.write(slotLimit, 5);
    let next = 0;
    for (let slot = 0; slot < slotLimit; slot++) {
      const e = next < entities.length && entities[next]!.slot === slot ? entities[next++]! : null;
      if (e === null) {
        w.write(EntityPresence.absent, 2);
        continue;
      }
      w.write(e.presence, 2);
      if (e.presence === EntityPresence.full) writeFullEntity(w, e, baselineEntity(baseline, slot));
      else if (e.presence === EntityPresence.audibleOnly) writeAudibleEntity(w, e);
    }
    if (next !== entities.length) throw new RangeError("Snapshot entities must be sorted by unique slot < 16");
  }
}

const KNOWN_SECTIONS = SnapshotSection.owner | SnapshotSection.entities;

/** Reads only the header (tooling, and clients that must look up the baseline before decoding). */
export function decodeSnapshotHeader(r: BitReader, referenceTick: number, out: Mutable<SnapshotHeader>): boolean {
  if (r.read(8) !== MsgId.Snapshot) return false;
  const serverTick = unwrapTick16(r.read(16), referenceTick);
  const baseWire = r.read(16);
  out.serverTick = serverTick;
  out.baselineTick = baseWire === 0xffff ? null : unwrapTick16(baseWire, serverTick);
  out.lastProcessedInputTick = decodeOptionalTick16(r.read(16), serverTick);
  out.clientTimeEcho = r.read(16);
  out.serverHoldMs = r.read(8);
  const depth = r.read(8);
  out.inputBufferDepthQ = depth >= 128 ? depth - 256 : depth;
  out.sections = r.read(8);
  return !r.overflowed;
}

/**
 * Allocation-free decode into `out` (which must not be the baseline). Returns false when malformed, when the
 * baseline is unavailable, or when a section this build doesn't know is present.
 */
export function decodeSnapshotInto(
  r: BitReader,
  referenceTick: number,
  baselineFor: (tick: number) => Snapshot | null,
  out: MutableSnapshot,
): boolean {
  const h = out.header;
  if (!decodeSnapshotHeader(r, referenceTick, h)) return false;
  if ((h.sections & ~KNOWN_SECTIONS) !== 0) return false;
  let baseline: Snapshot | null = null;
  if (h.baselineTick !== null) {
    baseline = baselineFor(h.baselineTick);
    if (baseline === null || baseline.header.serverTick !== h.baselineTick || baseline === out) return false;
  }
  if ((h.sections & SnapshotSection.owner) !== 0) {
    if (!readOwner(r, out.ownerStore, baseline?.owner ?? null)) return false;
    out.owner = out.ownerStore;
  } else {
    out.owner = null;
  }
  out.entities.length = 0;
  if ((h.sections & SnapshotSection.entities) !== 0) {
    const slotLimit = r.read(5);
    if (slotLimit === 0 || slotLimit > MAX_ENTITY_SLOTS) return false;
    for (let slot = 0; slot < slotLimit; slot++) {
      const presence = r.read(2) as EntityPresence;
      if (presence === EntityPresence.absent) continue;
      const e = out.entityPool[out.entities.length]!;
      e.slot = slot;
      e.presence = presence;
      if (presence === EntityPresence.full) {
        if (!readFullEntity(r, e, baselineEntity(baseline, slot))) return false;
      } else if (presence === EntityPresence.audibleOnly) {
        readAudibleEntity(r, e);
      } else {
        resetEntityFields(e);
      }
      out.entities.push(e);
      if (r.overflowed) return false;
    }
    if (out.entities.length === 0) return false;
  }
  return !r.overflowed && r.bitsLeft < 8;
}

/** `baselineFor(tick)` returns a stored decoded snapshot, or null when unavailable (the snapshot is then dropped). */
export function decodeSnapshot(
  r: BitReader,
  referenceTick: number,
  baselineFor: (tick: number) => Snapshot | null,
): Snapshot | null {
  const out = createSnapshotBuffer();
  return decodeSnapshotInto(r, referenceTick, baselineFor, out) ? out : null;
}
