import type { BitReader, BitWriter } from "../bits";
import { AMMO_COUNT, CONSUMABLE_CODE_BITS, CONSUMABLE_COUNT, MAX_PLAYER_SLOTS, SLOT_BITS, WEAPON_CODE_BITS, WEAPON_IDS_BY_CODE } from "../codes";
import {
  BLOOM_BITS,
  COOLDOWN_BITS,
  PHASE_TIMER_BITS,
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
import {
  copyPlayerHitEvent,
  copyReliableEvent,
  copyShotEvent,
  createPlayerHitEvent,
  createReliableEventStore,
  createShotEvent,
  MAX_HITS_PER_SNAPSHOT,
  MAX_SHOTS_PER_SNAPSHOT,
  PLAYER_HIT_EVENT_BITS,
  readPlayerHitEvent,
  readReliableSection,
  readShotEvent,
  SHOT_EVENT_BITS,
  writePlayerHitEvent,
  writeReliableSection,
  writeShotEvent,
  type PlayerHitEvent,
  type ReliableEvent,
  type ReliableEventStore,
  type ShotEvent,
} from "./events";
import { MsgId } from "./ids";

// 0x10, S→C datagram (netcode.md §6.5). Wire order: header, reliable events, shots, player hits, teammate vitals (v6),
// owner block (move, weapon, vitals, items (v6; gear part v7) groups), entity list. Events and teammate vitals come before the delta-coded body so
// they decode without the baseline.
// Decoded structs carry quantized integers (mm, mm/s, angle steps) so baselines and deltas compare exactly;
// dequantization lives in quantize.ts and codes.ts.

/** Payload cap: min(SNAPSHOT_MAX_BYTES, session maxDatagramSize). */
export const SNAPSHOT_MAX_BYTES = 1000;
/** Per-client baseline ring (D9). */
export const BASELINE_RING = 128;
/** Player slots 0..19 (v3; the 5-bit slot-limit field allows up to 31). */
export const MAX_ENTITY_SLOTS = MAX_PLAYER_SLOTS;

export const SnapshotSection = { owner: 1, entities: 2, shots: 4, reliable: 8, throwables: 16, versions: 32, hits: 64, teammates: 128 } as const;
/** Weapon slots in the owner ammo group (3-bit count). */
export const MAX_WEAPON_SLOTS = 7;

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

/** Owner weapon group (predicted; the client compares it after replay). */
export interface OwnerWeaponBlock {
  /** `WeaponPhaseCode`. */
  readonly phase: number;
  readonly activeIndex: number;
  /** Whole ticks, 9 bits. */
  readonly phaseTimerTicks: number;
  /** 1/64 tick, 13 bits. */
  readonly cooldownQ: number;
  readonly triggerHeld: boolean;
  /** 1/64°, 8 bits. */
  readonly bloomQ: number;
  /** adsBlend × 255. */
  readonly adsQ: number;
  /** Low 16 bits of `shotCounter`. */
  readonly shotCounter16: number;
  /** 0..MAX_WEAPON_SLOTS. */
  readonly slotCount: number;
  /** Per slot (first `slotCount` entries): `weaponCode` (0 empty), magazine (7 bits), reserve (10 bits). */
  readonly slotWeapon: readonly number[];
  readonly slotMagazine: readonly number[];
  readonly slotReserve: readonly number[];
}

/** Owner vitals and armor (server-owned, not predicted). */
export interface OwnerVitalsBlock {
  /** `LifeCode`. */
  readonly life: number;
  /** 0.1 HP, 10 bits. */
  readonly healthQ: number;
  /** Whole points (ceil), 7 bits. */
  readonly boost: number;
  /** Downed pool, 0.1 HP; only carried while downed (0 otherwise). */
  readonly downedHealthQ: number;
  /** Ticks of revive progress, 9 bits; only carried while downed. */
  readonly reviveTicks: number;
  /** 0 none, 1..3. */
  readonly helmetLevel: number;
  /** Whole points (ceil), 8 bits; 0 when no helmet. */
  readonly helmetDurability: number;
  readonly vestLevel: number;
  readonly vestDurability: number;
}

/**
 * Owner items group (v6, server-owned): the consumable in use and the carried consumable counts; v7 adds the gear part
 * (backpack level and rounds per ammo type). Weapons and magazines ride the weapon group, armor the vitals group.
 */
export interface OwnerItemsBlock {
  /** `consumableCode` of the item in use, 0 when idle. */
  readonly useItem: number;
  /** Whole ticks into the current use, 10 bits; 0 when idle. */
  readonly useTicks: number;
  /** Carried count per consumable (index = code − 1), 7 bits each (saturating). */
  readonly counts: readonly number[];
  /** v7: backpack level 0..3 (2 bits). Absent reads 0. */
  readonly backpack?: number;
  /** v7: carried rounds per `AMMO_IDS` entry, 10 bits each (≤ 999). Absent reads 0. */
  readonly ammo?: readonly number[];
  /** v9: carried count per `THROWABLE_KINDS` entry, 4 bits each (saturating at 15). Absent reads 0. */
  readonly throwables?: readonly number[];
}

export const USE_TICKS_BITS = 10;
export const CONSUMABLE_COUNT_BITS = 7;
export const AMMO_COUNT_BITS = 10;
/** v9: throwable kinds in the owner items group, and the bits per count. */
export const THROWABLE_KIND_COUNT = 4;
export const THROWABLE_COUNT_BITS = 4;

/** Teammates in one vitals group (squads of 4). */
export const MAX_TEAMMATES = 3;
/** Whole HP (rounded up), 0..100. */
export const TEAMMATE_HEALTH_BITS = 7;
/** Revive progress as a fraction of the revive time, 0..TEAMMATE_REVIVE_MAX. */
export const TEAMMATE_REVIVE_BITS = 6;
export const TEAMMATE_REVIVE_MAX = (1 << TEAMMATE_REVIVE_BITS) - 1;

/**
 * One teammate's vitals (protocol v6), sent only to members of the same team (never enemies: health is ESP). Absolute
 * values, no baseline: the server sends the group while the recipient hasn't acked its current values, and as a keyframe.
 */
export interface TeammateVitals {
  readonly slot: number;
  /** `LifeCode`. */
  readonly life: number;
  /** Whole HP rounded up, 7 bits (0 while downed or dead). */
  readonly health: number;
  /** Downed pool, whole HP rounded up, 7 bits; only carried while downed (0 otherwise). */
  readonly downedHealth: number;
  /** Revive progress × TEAMMATE_REVIVE_MAX / revive time (rounded up, so a started revive is ≥ 1); only while downed. */
  readonly reviveQ: number;
  /** The recipient is the one reviving this teammate; only while downed. */
  readonly reviverIsMe: boolean;
}

export const EntityPresence = { absent: 0, full: 1, audibleOnly: 2, removed: 3 } as const;
export type EntityPresence = (typeof EntityPresence)[keyof typeof EntityPresence];

export interface EntityState {
  /** Player slot 0..MAX_ENTITY_SLOTS-1. */
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
  /** 21-bit remote flags (stance, moveMode, grounded, sprint, ads, weaponSlot, phase, life, armor, weapon id). */
  readonly flags: number;
  /** Audible-only entities: 3-bit noise class (M5). Absent/0 otherwise. */
  readonly noiseClass?: number;
}

export interface Snapshot {
  readonly header: SnapshotHeader;
  readonly owner: OwnerMoveBlock | null;
  /** Sorted by slot, unique slots; `absent` entries are not listed. */
  readonly entities: readonly EntityState[];
  /** Owner weapon group; only sent with `owner`. Absent = not replicated. */
  readonly weapon?: OwnerWeaponBlock | null;
  /** Owner vitals group; only sent with `owner`. */
  readonly vitals?: OwnerVitalsBlock | null;
  /** Owner items group (v6); only sent with `owner`. */
  readonly items?: OwnerItemsBlock | null;
  /** Tier U, oldest first (the size cap drops from the front). */
  readonly shots?: readonly ShotEvent[];
  readonly hits?: readonly PlayerHitEvent[];
  /** Tier R, ascending seq (netcode ReliableEventSender.select). */
  readonly reliable?: readonly ReliableEvent[];
  /** Recipient's teammates (≤ MAX_TEAMMATES, sorted by slot). Absent = unchanged since the last group received. */
  readonly teammates?: readonly TeammateVitals[];
}

// ---- Mutable storage (decode targets, baseline rings) -----------------------------------------------------------

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface MutableOwnerWeaponBlock extends Omit<Mutable<OwnerWeaponBlock>, "slotWeapon" | "slotMagazine" | "slotReserve"> {
  readonly slotWeapon: number[];
  readonly slotMagazine: number[];
  readonly slotReserve: number[];
}

export interface MutableOwnerItemsBlock extends Omit<Mutable<OwnerItemsBlock>, "counts" | "backpack" | "ammo" | "throwables"> {
  readonly counts: number[];
  backpack: number;
  readonly ammo: number[];
  readonly throwables: number[];
}

export interface MutableSnapshot {
  header: Mutable<SnapshotHeader>;
  owner: Mutable<OwnerMoveBlock> | null;
  entities: Mutable<EntityState>[];
  weapon: MutableOwnerWeaponBlock | null;
  vitals: Mutable<OwnerVitalsBlock> | null;
  items: MutableOwnerItemsBlock | null;
  shots: Mutable<ShotEvent>[];
  hits: Mutable<PlayerHitEvent>[];
  reliable: ReliableEvent[];
  teammates: Mutable<TeammateVitals>[];
  /**
   * Set by the decoder once the event sections parsed, even if the body then failed (e.g. baseline unavailable), so a
   * client may still deliver `reliable` from an otherwise dropped snapshot.
   */
  eventsValid: boolean;
  /** Preallocated storage behind `owner` and `entities`. */
  readonly ownerStore: Mutable<OwnerMoveBlock>;
  readonly entityPool: Mutable<EntityState>[];
  readonly weaponStore: MutableOwnerWeaponBlock;
  readonly vitalsStore: Mutable<OwnerVitalsBlock>;
  readonly itemsStore: MutableOwnerItemsBlock;
  /** Event pools grow on demand (steady state allocates nothing). */
  readonly shotPool: Mutable<ShotEvent>[];
  readonly hitPool: Mutable<PlayerHitEvent>[];
  readonly reliablePool: ReliableEventStore[];
  /** MAX_TEAMMATES entries behind `teammates`. */
  readonly teammatePool: Mutable<TeammateVitals>[];
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

export function createOwnerWeaponBlock(): MutableOwnerWeaponBlock {
  const zeros = (): number[] => new Array<number>(MAX_WEAPON_SLOTS).fill(0);
  return {
    phase: 0,
    activeIndex: 0,
    phaseTimerTicks: 0,
    cooldownQ: 0,
    triggerHeld: false,
    bloomQ: 0,
    adsQ: 0,
    shotCounter16: 0,
    slotCount: 0,
    slotWeapon: zeros(),
    slotMagazine: zeros(),
    slotReserve: zeros(),
  };
}

export function createOwnerVitalsBlock(): Mutable<OwnerVitalsBlock> {
  return { life: 0, healthQ: 1000, boost: 0, downedHealthQ: 0, reviveTicks: 0, helmetLevel: 0, helmetDurability: 0, vestLevel: 0, vestDurability: 0 };
}

export function createOwnerItemsBlock(): MutableOwnerItemsBlock {
  return {
    useItem: 0,
    useTicks: 0,
    counts: new Array<number>(CONSUMABLE_COUNT).fill(0),
    backpack: 0,
    ammo: new Array<number>(AMMO_COUNT).fill(0),
    throwables: new Array<number>(THROWABLE_KIND_COUNT).fill(0),
  };
}

export function createTeammateVitals(): Mutable<TeammateVitals> {
  return { slot: 0, life: 0, health: 100, downedHealth: 0, reviveQ: 0, reviverIsMe: false };
}

function createEntity(): Mutable<EntityState> {
  return { slot: 0, presence: 0, xMm: 0, yMm: 0, zMm: 0, yawQ: 0, pitchQ: 0, vxQ: 0, vyQ: 0, vzQ: 0, flags: 0, noiseClass: 0 };
}

export function createSnapshotBuffer(): MutableSnapshot {
  const entityPool: Mutable<EntityState>[] = [];
  for (let i = 0; i < MAX_ENTITY_SLOTS; i++) entityPool.push(createEntity());
  const teammatePool: Mutable<TeammateVitals>[] = [];
  for (let i = 0; i < MAX_TEAMMATES; i++) teammatePool.push(createTeammateVitals());
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
    weapon: null,
    vitals: null,
    items: null,
    shots: [],
    hits: [],
    reliable: [],
    teammates: [],
    eventsValid: false,
    ownerStore: createOwner(),
    entityPool,
    weaponStore: createOwnerWeaponBlock(),
    vitalsStore: createOwnerVitalsBlock(),
    itemsStore: createOwnerItemsBlock(),
    shotPool: [],
    hitPool: [],
    reliablePool: [],
    teammatePool,
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

export function copyOwnerWeapon(src: OwnerWeaponBlock, dst: MutableOwnerWeaponBlock): void {
  dst.phase = src.phase;
  dst.activeIndex = src.activeIndex;
  dst.phaseTimerTicks = src.phaseTimerTicks;
  dst.cooldownQ = src.cooldownQ;
  dst.triggerHeld = src.triggerHeld;
  dst.bloomQ = src.bloomQ;
  dst.adsQ = src.adsQ;
  dst.shotCounter16 = src.shotCounter16;
  const n = Math.min(src.slotCount, MAX_WEAPON_SLOTS);
  dst.slotCount = n;
  for (let i = 0; i < MAX_WEAPON_SLOTS; i++) {
    dst.slotWeapon[i] = i < n ? src.slotWeapon[i]! : 0;
    dst.slotMagazine[i] = i < n ? src.slotMagazine[i]! : 0;
    dst.slotReserve[i] = i < n ? src.slotReserve[i]! : 0;
  }
}

export function copyOwnerVitals(src: OwnerVitalsBlock, dst: Mutable<OwnerVitalsBlock>): void {
  dst.life = src.life;
  dst.healthQ = src.healthQ;
  dst.boost = src.boost;
  dst.downedHealthQ = src.downedHealthQ;
  dst.reviveTicks = src.reviveTicks;
  dst.helmetLevel = src.helmetLevel;
  dst.helmetDurability = src.helmetDurability;
  dst.vestLevel = src.vestLevel;
  dst.vestDurability = src.vestDurability;
}

export function copyOwnerItems(src: OwnerItemsBlock, dst: MutableOwnerItemsBlock): void {
  dst.useItem = src.useItem;
  dst.useTicks = src.useItem !== 0 ? src.useTicks : 0;
  for (let i = 0; i < CONSUMABLE_COUNT; i++) dst.counts[i] = src.counts[i] ?? 0;
  dst.backpack = src.backpack ?? 0;
  for (let i = 0; i < AMMO_COUNT; i++) dst.ammo[i] = src.ammo?.[i] ?? 0;
  for (let i = 0; i < THROWABLE_KIND_COUNT; i++) dst.throwables[i] = src.throwables?.[i] ?? 0;
}

/** Use fields equal (ticks only count while an item is in use). */
export function ownerItemsUseEqual(a: OwnerItemsBlock, b: OwnerItemsBlock): boolean {
  return a.useItem === b.useItem && (a.useItem === 0 || a.useTicks === b.useTicks);
}

export function ownerItemsCountsEqual(a: OwnerItemsBlock, b: OwnerItemsBlock): boolean {
  for (let i = 0; i < CONSUMABLE_COUNT; i++) if ((a.counts[i] ?? 0) !== (b.counts[i] ?? 0)) return false;
  return true;
}

/** v7 gear part (backpack, ammo counts) equal. */
export function ownerItemsGearEqual(a: OwnerItemsBlock, b: OwnerItemsBlock): boolean {
  if ((a.backpack ?? 0) !== (b.backpack ?? 0)) return false;
  for (let i = 0; i < AMMO_COUNT; i++) if ((a.ammo?.[i] ?? 0) !== (b.ammo?.[i] ?? 0)) return false;
  return true;
}

/** v9 throwable part (carried grenades per kind) equal. */
export function ownerItemsThrowablesEqual(a: OwnerItemsBlock, b: OwnerItemsBlock): boolean {
  for (let i = 0; i < THROWABLE_KIND_COUNT; i++) if ((a.throwables?.[i] ?? 0) !== (b.throwables?.[i] ?? 0)) return false;
  return true;
}

export function copyTeammateVitals(src: TeammateVitals, dst: Mutable<TeammateVitals>): void {
  dst.slot = src.slot;
  dst.life = src.life;
  dst.health = src.health;
  dst.downedHealth = src.downedHealth;
  dst.reviveQ = src.reviveQ;
  dst.reviverIsMe = src.reviverIsMe;
}

/** Equality of what the wire carries (downed-only fields count only while downed). */
export function teammateVitalsEqual(a: TeammateVitals, b: TeammateVitals): boolean {
  return (
    a.slot === b.slot &&
    a.life === b.life &&
    a.health === b.health &&
    (a.life !== LIFE_DOWNED || (a.downedHealth === b.downedHealth && a.reviveQ === b.reviveQ && a.reviverIsMe === b.reviverIsMe))
  );
}

/** Core fields (phase, timers, trigger, bloom, ADS, shot counter) equal. */
export function ownerWeaponCoreEqual(a: OwnerWeaponBlock, b: OwnerWeaponBlock): boolean {
  return (
    a.phase === b.phase &&
    a.activeIndex === b.activeIndex &&
    a.phaseTimerTicks === b.phaseTimerTicks &&
    a.cooldownQ === b.cooldownQ &&
    a.triggerHeld === b.triggerHeld &&
    a.bloomQ === b.bloomQ &&
    a.adsQ === b.adsQ &&
    a.shotCounter16 === b.shotCounter16
  );
}

/** Slot weapons, magazines and reserves equal (empty slots ignore their ammo fields). */
export function ownerWeaponAmmoEqual(a: OwnerWeaponBlock, b: OwnerWeaponBlock): boolean {
  if (a.slotCount !== b.slotCount) return false;
  for (let i = 0; i < a.slotCount; i++) {
    const weapon = a.slotWeapon[i]!;
    if (weapon !== b.slotWeapon[i]) return false;
    if (weapon !== 0 && (a.slotMagazine[i] !== b.slotMagazine[i] || a.slotReserve[i] !== b.slotReserve[i])) return false;
  }
  return true;
}

export function ownerWeaponEqual(a: OwnerWeaponBlock, b: OwnerWeaponBlock): boolean {
  return ownerWeaponCoreEqual(a, b) && ownerWeaponAmmoEqual(a, b);
}

/** Equality of what the wire carries (downed-only fields count only while downed, durability only when worn). */
export function ownerVitalsEqual(a: OwnerVitalsBlock, b: OwnerVitalsBlock): boolean {
  return (
    a.life === b.life &&
    a.healthQ === b.healthQ &&
    a.boost === b.boost &&
    (a.life !== LIFE_DOWNED || (a.downedHealthQ === b.downedHealthQ && a.reviveTicks === b.reviveTicks)) &&
    a.helmetLevel === b.helmetLevel &&
    (a.helmetLevel === 0 || a.helmetDurability === b.helmetDurability) &&
    a.vestLevel === b.vestLevel &&
    (a.vestLevel === 0 || a.vestDurability === b.vestDurability)
  );
}

const LIFE_DOWNED = 1;

/**
 * Deep copy into preallocated storage (no allocation once `dst.entities` and the event pools have grown to their steady
 * size). `copyEvents = false` skips the event lists (server baseline rings don't need them).
 */
export function copySnapshot(src: Snapshot, dst: MutableSnapshot, copyEvents = true): void {
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
  if (src.weapon === null || src.weapon === undefined || src.owner === null) dst.weapon = null;
  else {
    copyOwnerWeapon(src.weapon, dst.weaponStore);
    dst.weapon = dst.weaponStore;
  }
  if (src.vitals === null || src.vitals === undefined || src.owner === null) dst.vitals = null;
  else {
    copyOwnerVitals(src.vitals, dst.vitalsStore);
    dst.vitals = dst.vitalsStore;
  }
  if (src.items === null || src.items === undefined || src.owner === null) dst.items = null;
  else {
    copyOwnerItems(src.items, dst.itemsStore);
    dst.items = dst.itemsStore;
  }
  dst.shots.length = 0;
  dst.hits.length = 0;
  dst.reliable.length = 0;
  dst.teammates.length = 0;
  dst.eventsValid = true;
  if (!copyEvents) return;
  const teammates = src.teammates;
  if (teammates !== undefined) {
    const count = Math.min(teammates.length, MAX_TEAMMATES);
    for (let i = 0; i < count; i++) {
      copyTeammateVitals(teammates[i]!, dst.teammatePool[i]!);
      dst.teammates.push(dst.teammatePool[i]!);
    }
  }
  const shots = src.shots;
  if (shots !== undefined) {
    for (let i = 0; i < shots.length; i++) {
      if (dst.shotPool.length <= i) dst.shotPool.push(createShotEvent());
      copyShotEvent(shots[i]!, dst.shotPool[i]!);
      dst.shots.push(dst.shotPool[i]!);
    }
  }
  const hits = src.hits;
  if (hits !== undefined) {
    for (let i = 0; i < hits.length; i++) {
      if (dst.hitPool.length <= i) dst.hitPool.push(createPlayerHitEvent());
      copyPlayerHitEvent(hits[i]!, dst.hitPool[i]!);
      dst.hits.push(dst.hitPool[i]!);
    }
  }
  const reliable = src.reliable;
  if (reliable !== undefined) {
    for (let i = 0; i < reliable.length; i++) {
      if (dst.reliablePool.length <= i) dst.reliablePool.push(createReliableEventStore());
      dst.reliable.push(copyReliableEvent(reliable[i]!, dst.reliablePool[i]!));
    }
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

// Weapon group: [changed 1 with a baseline] core: phase 2, activeIndex 3, phaseTimer 9, cooldown 13, triggerHeld 1,
// bloom 8, ads 8, shotCounter 16; [changed 1] ammo: slotCount 3, per slot weaponCode 3 (+ magazine 7, reserve 10).
export const MAGAZINE_BITS = 7;
export const RESERVE_BITS = 10;

function writeOwnerWeapon(w: BitWriter, o: OwnerWeaponBlock, base: OwnerWeaponBlock | null): void {
  const coreSame = base !== null && ownerWeaponCoreEqual(o, base);
  if (base !== null) w.writeBool(!coreSame);
  if (!coreSame) {
    w.write(o.phase, 2);
    w.write(o.activeIndex, 3);
    w.write(o.phaseTimerTicks, PHASE_TIMER_BITS);
    w.write(o.cooldownQ, COOLDOWN_BITS);
    w.writeBool(o.triggerHeld);
    w.write(o.bloomQ, BLOOM_BITS);
    w.write(o.adsQ, 8);
    w.write(o.shotCounter16, 16);
  }
  const ammoSame = base !== null && ownerWeaponAmmoEqual(o, base);
  if (base !== null) w.writeBool(!ammoSame);
  if (!ammoSame) {
    if (o.slotCount > MAX_WEAPON_SLOTS) throw new RangeError(`at most ${MAX_WEAPON_SLOTS} weapon slots`);
    w.write(o.slotCount, 3);
    for (let i = 0; i < o.slotCount; i++) {
      const weapon = o.slotWeapon[i]!;
      w.write(weapon, WEAPON_CODE_BITS);
      if (weapon !== 0) {
        w.write(o.slotMagazine[i]!, MAGAZINE_BITS);
        w.write(o.slotReserve[i]!, RESERVE_BITS);
      }
    }
  }
}

function readOwnerWeapon(r: BitReader, o: MutableOwnerWeaponBlock, base: OwnerWeaponBlock | null): boolean {
  if (base === null || r.readBool()) {
    o.phase = r.read(2);
    o.activeIndex = r.read(3);
    o.phaseTimerTicks = r.read(PHASE_TIMER_BITS);
    o.cooldownQ = r.read(COOLDOWN_BITS);
    o.triggerHeld = r.readBool();
    o.bloomQ = r.read(BLOOM_BITS);
    o.adsQ = r.read(8);
    o.shotCounter16 = r.read(16);
    if (o.phase === 3) return false;
  } else {
    o.phase = base.phase;
    o.activeIndex = base.activeIndex;
    o.phaseTimerTicks = base.phaseTimerTicks;
    o.cooldownQ = base.cooldownQ;
    o.triggerHeld = base.triggerHeld;
    o.bloomQ = base.bloomQ;
    o.adsQ = base.adsQ;
    o.shotCounter16 = base.shotCounter16;
  }
  if (base === null || r.readBool()) {
    const n = r.read(3);
    o.slotCount = n;
    for (let i = 0; i < MAX_WEAPON_SLOTS; i++) {
      const weapon = i < n ? r.read(WEAPON_CODE_BITS) : 0;
      if (weapon >= WEAPON_IDS_BY_CODE.length) return false;
      o.slotWeapon[i] = weapon;
      o.slotMagazine[i] = weapon !== 0 ? r.read(MAGAZINE_BITS) : 0;
      o.slotReserve[i] = weapon !== 0 ? r.read(RESERVE_BITS) : 0;
    }
  } else {
    copyAmmo(base, o);
  }
  return o.slotCount === 0 ? o.activeIndex === 0 : o.activeIndex < o.slotCount;
}

function copyAmmo(src: OwnerWeaponBlock, dst: MutableOwnerWeaponBlock): void {
  dst.slotCount = src.slotCount;
  for (let i = 0; i < MAX_WEAPON_SLOTS; i++) {
    dst.slotWeapon[i] = i < src.slotCount ? src.slotWeapon[i]! : 0;
    dst.slotMagazine[i] = i < src.slotCount ? src.slotMagazine[i]! : 0;
    dst.slotReserve[i] = i < src.slotCount ? src.slotReserve[i]! : 0;
  }
}

// Vitals group: [changed 1 with a baseline] life 2, health 10, boost 7, (downed: downedHealth 10, reviveTicks 9),
// helmetLevel 2 (+ durability 8), vestLevel 2 (+ durability 8).
function writeOwnerVitals(w: BitWriter, o: OwnerVitalsBlock, base: OwnerVitalsBlock | null): void {
  if (base !== null) {
    const changed = !ownerVitalsEqual(o, base);
    w.writeBool(changed);
    if (!changed) return;
  }
  w.write(o.life, 2);
  w.write(o.healthQ, 10);
  w.write(o.boost, 7);
  if (o.life === LIFE_DOWNED) {
    w.write(o.downedHealthQ, 10);
    w.write(o.reviveTicks, 9);
  }
  w.write(o.helmetLevel, 2);
  if (o.helmetLevel !== 0) w.write(o.helmetDurability, 8);
  w.write(o.vestLevel, 2);
  if (o.vestLevel !== 0) w.write(o.vestDurability, 8);
}

// Items group: [changed 1 with a baseline] use: item 3 (+ ticks 10 while in use); [changed 1 with a baseline] counts:
// 7 bits per consumable; (v7) [changed 1 with a baseline] gear: backpack 2, 10 bits per ammo type; (v9)
// [changed 1 with a baseline] throwables: 4 bits per kind.
function writeOwnerItems(w: BitWriter, o: OwnerItemsBlock, base: OwnerItemsBlock | null): void {
  const useSame = base !== null && ownerItemsUseEqual(o, base);
  if (base !== null) w.writeBool(!useSame);
  if (!useSame) {
    w.write(o.useItem, CONSUMABLE_CODE_BITS);
    if (o.useItem !== 0) w.write(o.useTicks, USE_TICKS_BITS);
  }
  const countsSame = base !== null && ownerItemsCountsEqual(o, base);
  if (base !== null) w.writeBool(!countsSame);
  if (!countsSame) for (let i = 0; i < CONSUMABLE_COUNT; i++) w.write(o.counts[i] ?? 0, CONSUMABLE_COUNT_BITS);
  const gearSame = base !== null && ownerItemsGearEqual(o, base);
  if (base !== null) w.writeBool(!gearSame);
  if (!gearSame) {
    w.write(o.backpack ?? 0, 2);
    for (let i = 0; i < AMMO_COUNT; i++) w.write(o.ammo?.[i] ?? 0, AMMO_COUNT_BITS);
  }
  const throwablesSame = base !== null && ownerItemsThrowablesEqual(o, base);
  if (base !== null) w.writeBool(!throwablesSame);
  if (!throwablesSame) for (let i = 0; i < THROWABLE_KIND_COUNT; i++) w.write(o.throwables?.[i] ?? 0, THROWABLE_COUNT_BITS);
}

function readOwnerItems(r: BitReader, o: MutableOwnerItemsBlock, base: OwnerItemsBlock | null): boolean {
  if (base === null || r.readBool()) {
    o.useItem = r.read(CONSUMABLE_CODE_BITS);
    o.useTicks = o.useItem !== 0 ? r.read(USE_TICKS_BITS) : 0;
    if (o.useItem > CONSUMABLE_COUNT) return false;
  } else {
    o.useItem = base.useItem;
    o.useTicks = base.useItem !== 0 ? base.useTicks : 0;
  }
  if (base === null || r.readBool()) {
    for (let i = 0; i < CONSUMABLE_COUNT; i++) o.counts[i] = r.read(CONSUMABLE_COUNT_BITS);
  } else {
    for (let i = 0; i < CONSUMABLE_COUNT; i++) o.counts[i] = base.counts[i] ?? 0;
  }
  if (base === null || r.readBool()) {
    o.backpack = r.read(2);
    for (let i = 0; i < AMMO_COUNT; i++) o.ammo[i] = r.read(AMMO_COUNT_BITS);
  } else {
    o.backpack = base.backpack ?? 0;
    for (let i = 0; i < AMMO_COUNT; i++) o.ammo[i] = base.ammo?.[i] ?? 0;
  }
  if (base === null || r.readBool()) {
    for (let i = 0; i < THROWABLE_KIND_COUNT; i++) o.throwables[i] = r.read(THROWABLE_COUNT_BITS);
  } else {
    for (let i = 0; i < THROWABLE_KIND_COUNT; i++) o.throwables[i] = base.throwables?.[i] ?? 0;
  }
  return true;
}

function readOwnerVitals(r: BitReader, o: Mutable<OwnerVitalsBlock>, base: OwnerVitalsBlock | null): boolean {
  if (base !== null && !r.readBool()) {
    copyOwnerVitals(base, o);
    return true;
  }
  o.life = r.read(2);
  o.healthQ = r.read(10);
  o.boost = r.read(7);
  const downed = o.life === LIFE_DOWNED;
  o.downedHealthQ = downed ? r.read(10) : 0;
  o.reviveTicks = downed ? r.read(9) : 0;
  o.helmetLevel = r.read(2);
  o.helmetDurability = o.helmetLevel !== 0 ? r.read(8) : 0;
  o.vestLevel = r.read(2);
  o.vestDurability = o.vestLevel !== 0 ? r.read(8) : 0;
  return o.life !== 3;
}

// Teammate vitals section: count 2 (1..3); per teammate slot 5, life 2, health 7, (downed: downedHealth 7, revive 6,
// reviverIsMe 1). Alive 14 bits, downed 28 bits.
function writeTeammateVitals(w: BitWriter, list: readonly TeammateVitals[]): void {
  if (list.length > MAX_TEAMMATES) throw new RangeError(`at most ${MAX_TEAMMATES} teammates per snapshot`);
  w.write(list.length, 2);
  for (let i = 0; i < list.length; i++) {
    const m = list[i]!;
    w.write(m.slot, SLOT_BITS);
    w.write(m.life, 2);
    w.write(m.health, TEAMMATE_HEALTH_BITS);
    if (m.life === LIFE_DOWNED) {
      w.write(m.downedHealth, TEAMMATE_HEALTH_BITS);
      w.write(m.reviveQ, TEAMMATE_REVIVE_BITS);
      w.writeBool(m.reviverIsMe);
    }
  }
}

function readTeammateVitals(r: BitReader, out: MutableSnapshot): boolean {
  const n = r.read(2);
  if (n === 0) return false;
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const m = out.teammatePool[i]!;
    m.slot = r.read(SLOT_BITS);
    m.life = r.read(2);
    m.health = r.read(TEAMMATE_HEALTH_BITS);
    const downed = m.life === LIFE_DOWNED;
    m.downedHealth = downed ? r.read(TEAMMATE_HEALTH_BITS) : 0;
    m.reviveQ = downed ? r.read(TEAMMATE_REVIVE_BITS) : 0;
    m.reviverIsMe = downed ? r.readBool() : false;
    if (r.overflowed || m.life === 3 || m.slot >= MAX_PLAYER_SLOTS || m.slot <= previous) return false;
    previous = m.slot;
    out.teammates.push(m);
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

/** Bit offsets recorded by `encodeSnapshot` for the size cap (optional, preallocated by the caller). */
export interface SnapshotEncodeStats {
  shotsBits: number;
  hitsBits: number;
  reliableBits: number;
  teammatesBits: number;
  ownerBits: number;
  /** Bits per entry of `snapshot.entities`, same order. */
  readonly entityBits: Int32Array;
}

export function createSnapshotEncodeStats(): SnapshotEncodeStats {
  return { shotsBits: 0, hitsBits: 0, reliableBits: 0, teammatesBits: 0, ownerBits: 0, entityBits: new Int32Array(MAX_ENTITY_SLOTS) };
}

/** Section bits the encoder derives from the content. */
export function snapshotSections(snapshot: Snapshot): number {
  return (
    (snapshot.owner !== null ? SnapshotSection.owner : 0) |
    (snapshot.entities.length > 0 ? SnapshotSection.entities : 0) |
    ((snapshot.shots?.length ?? 0) > 0 ? SnapshotSection.shots : 0) |
    ((snapshot.reliable?.length ?? 0) > 0 ? SnapshotSection.reliable : 0) |
    ((snapshot.hits?.length ?? 0) > 0 ? SnapshotSection.hits : 0) |
    ((snapshot.teammates?.length ?? 0) > 0 ? SnapshotSection.teammates : 0)
  );
}

/**
 * Encodes against `baseline` (null = full). Use `encodeSnapshotCapped` to enforce the size cap. Entities must be
 * sorted by slot with unique slots < MAX_ENTITY_SLOTS, and all values in their quantized ranges (use quantize.ts), or the stored
 * baseline and the client's decoded copy diverge. `header.baselineTick` must equal `baseline.header.serverTick` (or
 * null).
 */
export function encodeSnapshot(w: BitWriter, snapshot: Snapshot, baselineIn: Snapshot | null, stats?: SnapshotEncodeStats): void {
  // Tick 0xFFFF on the wire means "no baseline", so a baseline with those low bits can't be referenced.
  const baseline = baselineIn !== null && (baselineIn.header.serverTick & 0xffff) !== 0xffff ? baselineIn : null;
  const h = snapshot.header;
  const entities = snapshot.entities;
  const sections = snapshotSections(snapshot);
  w.write(MsgId.Snapshot, 8);
  w.write(h.serverTick, 16);
  w.write(baseline === null ? 0xffff : baseline.header.serverTick & 0xffff, 16);
  w.write(encodeOptionalTick16(h.lastProcessedInputTick), 16);
  w.write(h.clientTimeEcho, 16);
  w.write(Math.min(255, Math.max(0, Math.round(h.serverHoldMs))), 8);
  w.write(Math.min(127, Math.max(-128, Math.round(h.inputBufferDepthQ))) & 0xff, 8);
  w.write(sections, 8);

  let mark = w.bitLength;
  if ((sections & SnapshotSection.reliable) !== 0) writeReliableSection(w, snapshot.reliable!);
  if (stats) stats.reliableBits = w.bitLength - mark;
  mark = w.bitLength;
  if ((sections & SnapshotSection.shots) !== 0) {
    const shots = snapshot.shots!;
    if (shots.length > MAX_SHOTS_PER_SNAPSHOT) throw new RangeError(`at most ${MAX_SHOTS_PER_SNAPSHOT} shots per snapshot`);
    w.write(shots.length, 6);
    for (let i = 0; i < shots.length; i++) writeShotEvent(w, shots[i]!);
  }
  if (stats) stats.shotsBits = w.bitLength - mark;
  mark = w.bitLength;
  if ((sections & SnapshotSection.hits) !== 0) {
    const hits = snapshot.hits!;
    if (hits.length > MAX_HITS_PER_SNAPSHOT) throw new RangeError(`at most ${MAX_HITS_PER_SNAPSHOT} player hits per snapshot`);
    w.write(hits.length, 5);
    for (let i = 0; i < hits.length; i++) writePlayerHitEvent(w, hits[i]!);
  }
  if (stats) stats.hitsBits = w.bitLength - mark;
  mark = w.bitLength;
  if ((sections & SnapshotSection.teammates) !== 0) writeTeammateVitals(w, snapshot.teammates!);
  if (stats) stats.teammatesBits = w.bitLength - mark;

  mark = w.bitLength;
  if (snapshot.owner !== null) {
    writeOwner(w, snapshot.owner, baseline?.owner ?? null);
    const weapon = snapshot.weapon ?? null;
    w.writeBool(weapon !== null);
    if (weapon !== null) writeOwnerWeapon(w, weapon, baseline?.weapon ?? null);
    const vitals = snapshot.vitals ?? null;
    w.writeBool(vitals !== null);
    if (vitals !== null) writeOwnerVitals(w, vitals, baseline?.vitals ?? null);
    const items = snapshot.items ?? null;
    w.writeBool(items !== null);
    if (items !== null) writeOwnerItems(w, items, baseline?.items ?? null);
  }
  if (stats) stats.ownerBits = w.bitLength - mark;
  if (entities.length > 0) {
    const slotLimit = entities[entities.length - 1]!.slot + 1;
    if (slotLimit > MAX_ENTITY_SLOTS) throw new RangeError(`Snapshot entities must be sorted by unique slot < ${MAX_ENTITY_SLOTS}`);
    w.write(slotLimit, 5);
    let next = 0;
    for (let slot = 0; slot < slotLimit; slot++) {
      const e = next < entities.length && entities[next]!.slot === slot ? entities[next++]! : null;
      if (e === null) {
        w.write(EntityPresence.absent, 2);
        continue;
      }
      mark = w.bitLength;
      w.write(e.presence, 2);
      if (e.presence === EntityPresence.full) writeFullEntity(w, e, baselineEntity(baseline, slot));
      else if (e.presence === EntityPresence.audibleOnly) writeAudibleEntity(w, e);
      if (stats && next - 1 < stats.entityBits.length) stats.entityBits[next - 1] = w.bitLength - mark;
    }
    if (next !== entities.length) throw new RangeError(`Snapshot entities must be sorted by unique slot < ${MAX_ENTITY_SLOTS}`);
  }
}

/** A snapshot the capped encoder may trim in place (the builder's own lists). */
export interface CappableSnapshot extends Snapshot {
  readonly entities: EntityState[];
  readonly shots?: ShotEvent[];
  readonly hits?: PlayerHitEvent[];
}

export interface SnapshotCapResult {
  fits: boolean;
  droppedShots: number;
  droppedHits: number;
  droppedAudible: number;
  droppedFull: number;
}

export function createSnapshotCapResult(): SnapshotCapResult {
  return { fits: false, droppedShots: 0, droppedHits: 0, droppedAudible: 0, droppedFull: 0 };
}

const capStats = createSnapshotEncodeStats();

function removeAt<T>(list: T[], index: number): void {
  for (let i = index; i < list.length - 1; i++) list[i] = list[i + 1]!;
  list.length--;
}

/**
 * Encodes within `capBytes` (netcode.md §6.6: min(1,000 B, maxDatagramSize)). Over the cap it trims `snapshot` in
 * place and re-encodes, dropping in order: `Shot` events (oldest first), `PlayerHit`, audible-only entities, then full
 * entities farthest from the owner. Reliable events, teammate vitals, the header and the owner block are never dropped; `fits` is false
 * when they alone exceed the cap. Record the trimmed snapshot as the baseline (dropped entities then re-send in full).
 */
export function encodeSnapshotCapped(
  w: BitWriter,
  snapshot: CappableSnapshot,
  baseline: Snapshot | null,
  capBytes: number,
  out: SnapshotCapResult,
): SnapshotCapResult {
  out.fits = false;
  out.droppedShots = 0;
  out.droppedHits = 0;
  out.droppedAudible = 0;
  out.droppedFull = 0;
  const capBits = capBytes * 8;
  for (;;) {
    w.reset();
    encodeSnapshot(w, snapshot, baseline, capStats);
    let excess = w.byteLength * 8 - capBits;
    if (excess <= 0) {
      out.fits = true;
      return out;
    }
    let dropped = false;
    const shots = snapshot.shots;
    while (excess > 0 && shots !== undefined && shots.length > 0) {
      removeAt(shots, 0);
      excess -= SHOT_EVENT_BITS;
      out.droppedShots++;
      dropped = true;
    }
    const hits = snapshot.hits;
    while (excess > 0 && hits !== undefined && hits.length > 0) {
      removeAt(hits, 0);
      excess -= PLAYER_HIT_EVENT_BITS;
      out.droppedHits++;
      dropped = true;
    }
    const entities = snapshot.entities;
    for (let i = entities.length - 1; excess > 0 && i >= 0; i--) {
      if (entities[i]!.presence !== EntityPresence.audibleOnly) continue;
      excess -= capStats.entityBits[i]!;
      removeAt(entities, i);
      out.droppedAudible++;
      dropped = true;
    }
    if (excess > 0 && entities.length > 0) {
      // One at a time: entityBits indices are stale after a removal, so re-encode before the next.
      removeAt(entities, farthestEntity(snapshot));
      out.droppedFull++;
      dropped = true;
    }
    if (!dropped) return out;
  }
}

function farthestEntity(snapshot: Snapshot): number {
  const entities = snapshot.entities;
  const owner = snapshot.owner;
  if (owner === null) return entities.length - 1;
  let best = 0;
  let bestD = -1;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    const dx = e.xMm - owner.xMm;
    const dy = e.yMm - owner.yMm;
    const dz = e.zMm - owner.zMm;
    const d = dx * dx + dy * dy + dz * dz;
    if (d >= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const KNOWN_SECTIONS =
  SnapshotSection.owner | SnapshotSection.entities | SnapshotSection.shots | SnapshotSection.reliable | SnapshotSection.hits | SnapshotSection.teammates;

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

function readEventSections(r: BitReader, sections: number, out: MutableSnapshot): boolean {
  out.shots.length = 0;
  out.hits.length = 0;
  out.reliable.length = 0;
  out.teammates.length = 0;
  if ((sections & SnapshotSection.reliable) !== 0) {
    if (!readReliableSection(r, out.reliablePool, out.reliable) || out.reliable.length === 0) return false;
  }
  if ((sections & SnapshotSection.shots) !== 0) {
    const n = r.read(6);
    if (n === 0) return false;
    for (let i = 0; i < n; i++) {
      if (out.shotPool.length <= i) out.shotPool.push(createShotEvent());
      const e = out.shotPool[i]!;
      if (!readShotEvent(r, e) || r.overflowed) return false;
      out.shots.push(e);
    }
  }
  if ((sections & SnapshotSection.hits) !== 0) {
    const n = r.read(5);
    if (n === 0) return false;
    for (let i = 0; i < n; i++) {
      if (out.hitPool.length <= i) out.hitPool.push(createPlayerHitEvent());
      const e = out.hitPool[i]!;
      if (!readPlayerHitEvent(r, e) || r.overflowed) return false;
      out.hits.push(e);
    }
  }
  if ((sections & SnapshotSection.teammates) !== 0 && !readTeammateVitals(r, out)) return false;
  return !r.overflowed;
}

/**
 * Allocation-free decode into `out` (which must not be the baseline). Returns false when malformed, when the
 * baseline is unavailable, or when a section this build doesn't know is present. Events decode before the baseline is
 * looked up: see `MutableSnapshot.eventsValid`.
 */
export function decodeSnapshotInto(
  r: BitReader,
  referenceTick: number,
  baselineFor: (tick: number) => Snapshot | null,
  out: MutableSnapshot,
): boolean {
  const h = out.header;
  out.eventsValid = false;
  out.shots.length = 0;
  out.hits.length = 0;
  out.reliable.length = 0;
  out.teammates.length = 0;
  if (!decodeSnapshotHeader(r, referenceTick, h)) return false;
  if ((h.sections & ~KNOWN_SECTIONS) !== 0) return false;
  if (!readEventSections(r, h.sections, out)) return false;
  out.eventsValid = true;
  let baseline: Snapshot | null = null;
  if (h.baselineTick !== null) {
    baseline = baselineFor(h.baselineTick);
    if (baseline === null || baseline.header.serverTick !== h.baselineTick || baseline === out) return false;
  }
  out.weapon = null;
  out.vitals = null;
  out.items = null;
  if ((h.sections & SnapshotSection.owner) !== 0) {
    if (!readOwner(r, out.ownerStore, baseline?.owner ?? null)) return false;
    out.owner = out.ownerStore;
    if (r.readBool()) {
      if (!readOwnerWeapon(r, out.weaponStore, baseline?.weapon ?? null)) return false;
      out.weapon = out.weaponStore;
    }
    if (r.readBool()) {
      if (!readOwnerVitals(r, out.vitalsStore, baseline?.vitals ?? null)) return false;
      out.vitals = out.vitalsStore;
    }
    if (r.readBool()) {
      if (!readOwnerItems(r, out.itemsStore, baseline?.items ?? null)) return false;
      out.items = out.itemsStore;
    }
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
