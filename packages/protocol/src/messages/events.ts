import type { BitReader, BitWriter } from "../bits";
import { ACTOR_BITS, DAMAGE_KINDS_BY_CODE, KILL_CAUSES_BY_CODE, MAX_PLAYER_SLOTS, SLOT_BITS, WEAPON_CODE_BITS, WEAPON_IDS_BY_CODE } from "../codes";
import { AIM_PITCH_BITS, AIM_YAW_BITS } from "../quantize";
import type { Mutable } from "./snapshot";

// Snapshot events (netcode.md §6.2, §6.5). Tier U (`Shot`, `PlayerHit`) is sent once and may be dropped by the size
// cap; tier R (`HitConfirm`, `DamageTaken`, `Kill`) carries a 12-bit seq and is resent by netcode's reliable queue until
// acked. Decoded structs carry quantized integers; quantize.ts and codes.ts map them to gameplay values.

// ---- Tier U -----------------------------------------------------------------------------------------------------

/** Shots per snapshot (6-bit count). */
export const MAX_SHOTS_PER_SNAPSHOT = 63;
/** PlayerHits per snapshot (5-bit count). */
export const MAX_HITS_PER_SNAPSHOT = 31;

/**
 * Remote tracer source: the shooter's quantized input aim and the spread the pellets were drawn with, so a client
 * rebuilds the pellets with `shotDirections(WEAPONS[weapon], shotId, dequantizeYaw(yawQ), dequantizePitch(pitchQ),
 * spreadQ / 64)`: exact seed and aim, spread within 1/128° (cosmetically exact, not bit-identical). The origin (the eye
 * the step fired from) is an offset from the shooter's feet in the snapshot carrying the event, in 1 cm steps.
 */
export interface ShotEvent {
  /** Slot 0..MAX_PLAYER_SLOTS-1. */
  readonly shooter: number;
  /** `weaponCode` 1..4. */
  readonly weapon: number;
  /** Snapshot tick − fire tick, 0..3 (snapshots at 20 Hz carry up to 3 ticks of shots). */
  readonly tickOffset: number;
  /** Low 16 bits of the shooter's `shotCounter` (the spread/recoil RNG seed); unwrap against the last seen value. */
  readonly shotId: number;
  /** 20-bit input yaw (shared/aim). */
  readonly yawQ: number;
  /** 18-bit input pitch (shared/aim). */
  readonly pitchQ: number;
  /** Spread half-angle in 1/64° (11 bits, ≤ 31.98°). */
  readonly spreadQ: number;
  /** Eye − shooter entity feet in this snapshot, cm: x/z zigzag 8 bits (±1.27 m), y zigzag 9 bits (±2.55 m). */
  readonly originDxCm: number;
  readonly originDyCm: number;
  readonly originDzCm: number;
}

export const SHOT_SPREAD_BITS = 11;
export const SHOT_ORIGIN_XZ_BITS = 8;
export const SHOT_ORIGIN_Y_BITS = 9;
/** 100 bits. */
export const SHOT_EVENT_BITS =
  SLOT_BITS + WEAPON_CODE_BITS + 2 + 16 + AIM_YAW_BITS + AIM_PITCH_BITS + SHOT_SPREAD_BITS + 2 * SHOT_ORIGIN_XZ_BITS + SHOT_ORIGIN_Y_BITS;

/** Bystander hit FX within 50 m. */
export interface PlayerHitEvent {
  readonly victim: number;
  /** `HitZoneCode` 0..3. */
  readonly zone: number;
  readonly armor: boolean;
  /** Direction the bullet travelled, 5-bit yaw steps. */
  readonly dirYawQ: number;
}

export const PLAYER_HIT_DIR_BITS = 5;
/** 13 bits. */
export const PLAYER_HIT_EVENT_BITS = SLOT_BITS + 2 + 1 + PLAYER_HIT_DIR_BITS;

export function writeShotEvent(w: BitWriter, e: ShotEvent): void {
  w.write(e.shooter, SLOT_BITS);
  w.write(e.weapon, WEAPON_CODE_BITS);
  w.write(e.tickOffset, 2);
  w.write(e.shotId, 16);
  w.write(e.yawQ, AIM_YAW_BITS);
  w.write(e.pitchQ, AIM_PITCH_BITS);
  w.write(e.spreadQ, SHOT_SPREAD_BITS);
  w.writeSigned(e.originDxCm, SHOT_ORIGIN_XZ_BITS);
  w.writeSigned(e.originDyCm, SHOT_ORIGIN_Y_BITS);
  w.writeSigned(e.originDzCm, SHOT_ORIGIN_XZ_BITS);
}

export function readShotEvent(r: BitReader, e: Mutable<ShotEvent>): boolean {
  e.shooter = r.read(SLOT_BITS);
  e.weapon = r.read(WEAPON_CODE_BITS);
  e.tickOffset = r.read(2);
  e.shotId = r.read(16);
  e.yawQ = r.read(AIM_YAW_BITS);
  e.pitchQ = r.read(AIM_PITCH_BITS);
  e.spreadQ = r.read(SHOT_SPREAD_BITS);
  e.originDxCm = r.readSigned(SHOT_ORIGIN_XZ_BITS);
  e.originDyCm = r.readSigned(SHOT_ORIGIN_Y_BITS);
  e.originDzCm = r.readSigned(SHOT_ORIGIN_XZ_BITS);
  return e.shooter < MAX_PLAYER_SLOTS && e.weapon !== 0 && e.weapon < WEAPON_IDS_BY_CODE.length;
}

export function writePlayerHitEvent(w: BitWriter, e: PlayerHitEvent): void {
  w.write(e.victim, SLOT_BITS);
  w.write(e.zone, 2);
  w.writeBool(e.armor);
  w.write(e.dirYawQ, PLAYER_HIT_DIR_BITS);
}

/** False when the victim is not a player slot. */
export function readPlayerHitEvent(r: BitReader, e: Mutable<PlayerHitEvent>): boolean {
  e.victim = r.read(SLOT_BITS);
  e.zone = r.read(2);
  e.armor = r.readBool();
  e.dirYawQ = r.read(PLAYER_HIT_DIR_BITS);
  return e.victim < MAX_PLAYER_SLOTS;
}

// ---- Tier R -----------------------------------------------------------------------------------------------------

/** 5-bit type. M5 appends ThrowStart, Detonate, AreaEffectStart/End, InventoryDelta, LootDelta, ZoneWarning. */
export const ReliableEventType = { HitConfirm: 1, DamageTaken: 2, Kill: 3 } as const;
export type ReliableEventType = (typeof ReliableEventType)[keyof typeof ReliableEventType];

export const RELIABLE_SEQ_BITS = 12;
export const RELIABLE_SEQ_MASK = (1 << RELIABLE_SEQ_BITS) - 1;
export const RELIABLE_TYPE_BITS = 5;
/** Reliable events per snapshot (6-bit count). */
export const MAX_RELIABLE_PER_SNAPSHOT = 63;
/** Worst-case per-event header: "next seq" bit + 12-bit seq + 5-bit type. */
export const RELIABLE_HEADER_MAX_BITS = 1 + RELIABLE_SEQ_BITS + RELIABLE_TYPE_BITS;
export const DAMAGE_BITS = 11;
export const KILL_DISTANCE_BITS = 10;
export const DAMAGE_DIR_BITS = 8;

/** To the shooter: one per (shotId, victim) per tick, pellets aggregated (§5.6). */
export interface HitConfirmEvent {
  readonly type: typeof ReliableEventType.HitConfirm;
  /** 12-bit wire seq (assigned by the reliable queue). */
  readonly seq: number;
  readonly victim: number;
  /** Pellets that hit, 0..15. */
  readonly pellets: number;
  /** `HitZoneMask` bits. */
  readonly zones: number;
  /** Total damage dealt, 0.1 HP (11 bits). */
  readonly damageQ: number;
  readonly killed: boolean;
  readonly downed: boolean;
  readonly armorHit: boolean;
  readonly armorBroken: boolean;
}

/** To the victim. */
export interface DamageTakenEvent {
  readonly type: typeof ReliableEventType.DamageTaken;
  readonly seq: number;
  /** `actorCode`: slot, or WORLD_SLOT_CODE. */
  readonly attacker: number;
  /** World yaw from the victim toward the damage source, 8-bit steps. */
  readonly dirYawQ: number;
  /** 0.1 HP (11 bits), after armor. */
  readonly amountQ: number;
  /** `HitZoneCode`. */
  readonly zone: number;
  /** Index into `DAMAGE_KINDS_BY_CODE`. */
  readonly kind: number;
}

/** Kill or knock, to everyone who needs it now (the killer, the victim, their teams); the kill feed is the stream copy. */
export interface KillEvent {
  readonly type: typeof ReliableEventType.Kill;
  readonly seq: number;
  /** `actorCode`: slot, or WORLD_SLOT_CODE. */
  readonly killer: number;
  readonly victim: number;
  /** Index into `KILL_CAUSES_BY_CODE`. */
  readonly cause: number;
  readonly headshot: boolean;
  /** Same team (friendly fire). */
  readonly friendlyFire: boolean;
  /** Knocked down rather than killed. */
  readonly knock: boolean;
  /** Whole metres, 0..1023. */
  readonly distanceM: number;
}

export type ReliableEvent = HitConfirmEvent | DamageTakenEvent | KillEvent;

/** Pool storage able to hold any reliable event; exposed as `ReliableEvent` after `type` is set. */
export interface ReliableEventStore {
  type: ReliableEventType;
  seq: number;
  victim: number;
  pellets: number;
  zones: number;
  damageQ: number;
  killed: boolean;
  downed: boolean;
  armorHit: boolean;
  armorBroken: boolean;
  attacker: number;
  dirYawQ: number;
  amountQ: number;
  zone: number;
  kind: number;
  killer: number;
  cause: number;
  headshot: boolean;
  friendlyFire: boolean;
  knock: boolean;
  distanceM: number;
}

export function createReliableEventStore(): ReliableEventStore {
  return {
    type: ReliableEventType.HitConfirm,
    seq: 0,
    victim: 0,
    pellets: 0,
    zones: 0,
    damageQ: 0,
    killed: false,
    downed: false,
    armorHit: false,
    armorBroken: false,
    attacker: 0,
    dirYawQ: 0,
    amountQ: 0,
    zone: 0,
    kind: 0,
    killer: 0,
    cause: 0,
    headshot: false,
    friendlyFire: false,
    knock: false,
    distanceM: 0,
  };
}

/** Copies the fields of `src`'s type into `dst` (other fields keep stale values). Returns `dst` as a ReliableEvent. */
export function copyReliableEvent(src: ReliableEvent, dst: ReliableEventStore): ReliableEvent {
  dst.type = src.type;
  dst.seq = src.seq;
  switch (src.type) {
    case ReliableEventType.HitConfirm:
      dst.victim = src.victim;
      dst.pellets = src.pellets;
      dst.zones = src.zones;
      dst.damageQ = src.damageQ;
      dst.killed = src.killed;
      dst.downed = src.downed;
      dst.armorHit = src.armorHit;
      dst.armorBroken = src.armorBroken;
      break;
    case ReliableEventType.DamageTaken:
      dst.attacker = src.attacker;
      dst.dirYawQ = src.dirYawQ;
      dst.amountQ = src.amountQ;
      dst.zone = src.zone;
      dst.kind = src.kind;
      break;
    case ReliableEventType.Kill:
      dst.killer = src.killer;
      dst.victim = src.victim;
      dst.cause = src.cause;
      dst.headshot = src.headshot;
      dst.friendlyFire = src.friendlyFire;
      dst.knock = src.knock;
      dst.distanceM = src.distanceM;
      break;
  }
  return dst as ReliableEvent;
}

/** Payload bits after the per-event header. */
export function reliablePayloadBits(type: ReliableEventType): number {
  switch (type) {
    case ReliableEventType.HitConfirm:
      return SLOT_BITS + 4 + 3 + DAMAGE_BITS + 4;
    case ReliableEventType.DamageTaken:
      return ACTOR_BITS + DAMAGE_DIR_BITS + DAMAGE_BITS + 2 + 3;
    case ReliableEventType.Kill:
      return ACTOR_BITS + SLOT_BITS + 5 + 3 + KILL_DISTANCE_BITS;
  }
}

/** Worst-case encoded bits of one reliable event (budgeting). */
export function reliableEventMaxBits(type: ReliableEventType): number {
  return RELIABLE_HEADER_MAX_BITS + reliablePayloadBits(type);
}

function writeReliablePayload(w: BitWriter, e: ReliableEvent): void {
  switch (e.type) {
    case ReliableEventType.HitConfirm:
      w.write(e.victim, SLOT_BITS);
      w.write(e.pellets, 4);
      w.write(e.zones, 3);
      w.write(e.damageQ, DAMAGE_BITS);
      w.writeBool(e.killed);
      w.writeBool(e.downed);
      w.writeBool(e.armorHit);
      w.writeBool(e.armorBroken);
      return;
    case ReliableEventType.DamageTaken:
      w.write(e.attacker, ACTOR_BITS);
      w.write(e.dirYawQ, DAMAGE_DIR_BITS);
      w.write(e.amountQ, DAMAGE_BITS);
      w.write(e.zone, 2);
      w.write(e.kind, 3);
      return;
    case ReliableEventType.Kill:
      w.write(e.killer, ACTOR_BITS);
      w.write(e.victim, SLOT_BITS);
      w.write(e.cause, 5);
      w.writeBool(e.headshot);
      w.writeBool(e.friendlyFire);
      w.writeBool(e.knock);
      w.write(e.distanceM, KILL_DISTANCE_BITS);
      return;
    default:
      throw new RangeError("unknown reliable event type");
  }
}

function readReliablePayload(r: BitReader, type: number, e: ReliableEventStore): boolean {
  switch (type) {
    case ReliableEventType.HitConfirm:
      e.victim = r.read(SLOT_BITS);
      e.pellets = r.read(4);
      e.zones = r.read(3);
      e.damageQ = r.read(DAMAGE_BITS);
      e.killed = r.readBool();
      e.downed = r.readBool();
      e.armorHit = r.readBool();
      e.armorBroken = r.readBool();
      if (e.victim >= MAX_PLAYER_SLOTS) return false;
      break;
    case ReliableEventType.DamageTaken:
      e.attacker = r.read(ACTOR_BITS);
      e.dirYawQ = r.read(DAMAGE_DIR_BITS);
      e.amountQ = r.read(DAMAGE_BITS);
      e.zone = r.read(2);
      e.kind = r.read(3);
      if (e.kind >= DAMAGE_KINDS_BY_CODE.length) return false;
      break;
    case ReliableEventType.Kill:
      e.killer = r.read(ACTOR_BITS);
      e.victim = r.read(SLOT_BITS);
      e.cause = r.read(5);
      e.headshot = r.readBool();
      e.friendlyFire = r.readBool();
      e.knock = r.readBool();
      e.distanceM = r.read(KILL_DISTANCE_BITS);
      if (e.cause >= KILL_CAUSES_BY_CODE.length || e.victim >= MAX_PLAYER_SLOTS) return false;
      break;
    default:
      return false;
  }
  e.type = type;
  return true;
}

/**
 * Reliable section: count 6, then per event [seq: 12 for the first; later ones 1 bit "previous seq + 1", else 0 + 12],
 * type 5, payload. The queue sends events in ascending seq order, so resends of a contiguous backlog cost 1 bit each.
 */
export function writeReliableSection(w: BitWriter, events: readonly ReliableEvent[]): void {
  const n = events.length;
  if (n > MAX_RELIABLE_PER_SNAPSHOT) throw new RangeError(`at most ${MAX_RELIABLE_PER_SNAPSHOT} reliable events per snapshot`);
  w.write(n, 6);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const seq = e.seq & RELIABLE_SEQ_MASK;
    if (i > 0) {
      const next = seq === ((prev + 1) & RELIABLE_SEQ_MASK);
      w.writeBool(next);
      if (!next) w.write(seq, RELIABLE_SEQ_BITS);
    } else {
      w.write(seq, RELIABLE_SEQ_BITS);
    }
    w.write(e.type, RELIABLE_TYPE_BITS);
    writeReliablePayload(w, e);
    prev = seq;
  }
}

/** Decodes into pooled stores (the pool grows on demand, so steady state allocates nothing). */
export function readReliableSection(r: BitReader, pool: ReliableEventStore[], out: ReliableEvent[]): boolean {
  const n = r.read(6);
  out.length = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (pool.length <= i) pool.push(createReliableEventStore());
    const e = pool[i]!;
    let seq: number;
    if (i > 0 && r.readBool()) seq = (prev + 1) & RELIABLE_SEQ_MASK;
    else seq = r.read(RELIABLE_SEQ_BITS);
    e.seq = seq;
    if (!readReliablePayload(r, r.read(RELIABLE_TYPE_BITS), e) || r.overflowed) return false;
    out.push(e as ReliableEvent);
    prev = seq;
  }
  return !r.overflowed;
}

/** Exact encoded size of a reliable section for `events` in order. */
export function reliableSectionBits(events: readonly ReliableEvent[]): number {
  let bits = 6;
  let prev = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const seq = e.seq & RELIABLE_SEQ_MASK;
    bits += i === 0 ? RELIABLE_SEQ_BITS : seq === ((prev + 1) & RELIABLE_SEQ_MASK) ? 1 : 1 + RELIABLE_SEQ_BITS;
    bits += RELIABLE_TYPE_BITS + reliablePayloadBits(e.type);
    prev = seq;
  }
  return bits;
}

export function createShotEvent(): Mutable<ShotEvent> {
  return { shooter: 0, weapon: 1, tickOffset: 0, shotId: 0, yawQ: 0, pitchQ: 0, spreadQ: 0, originDxCm: 0, originDyCm: 0, originDzCm: 0 };
}

export function createPlayerHitEvent(): Mutable<PlayerHitEvent> {
  return { victim: 0, zone: 0, armor: false, dirYawQ: 0 };
}

export function copyShotEvent(src: ShotEvent, dst: Mutable<ShotEvent>): void {
  dst.shooter = src.shooter;
  dst.weapon = src.weapon;
  dst.tickOffset = src.tickOffset;
  dst.shotId = src.shotId;
  dst.yawQ = src.yawQ;
  dst.pitchQ = src.pitchQ;
  dst.spreadQ = src.spreadQ;
  dst.originDxCm = src.originDxCm;
  dst.originDyCm = src.originDyCm;
  dst.originDzCm = src.originDzCm;
}

export function copyPlayerHitEvent(src: PlayerHitEvent, dst: Mutable<PlayerHitEvent>): void {
  dst.victim = src.victim;
  dst.zone = src.zone;
  dst.armor = src.armor;
  dst.dirYawQ = src.dirYawQ;
}
