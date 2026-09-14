import {
  actorCode,
  damageKindCode,
  hitZoneCode,
  killCauseCode,
  lifeCode,
  weaponCode,
  weaponIdOfCode,
  weaponPhaseCode,
  weaponPhaseOfCode,
  type KillCause,
} from "@twobullets/protocol/codes";
import type { KillFeed } from "@twobullets/protocol/messages/control";
import {
  DAMAGE_DIR_BITS,
  PLAYER_HIT_DIR_BITS,
  ReliableEventType,
  SHOT_ORIGIN_XZ_BITS,
  SHOT_ORIGIN_Y_BITS,
  SHOT_SPREAD_BITS,
  type PlayerHitEvent,
  type ReliableEvent,
  type ReliableEventStore,
  type ShotEvent,
} from "@twobullets/protocol/messages/events";
import {
  EntityPresence,
  MAX_WEAPON_SLOTS,
  type EntityState,
  type Mutable,
  type MutableOwnerWeaponBlock,
  type OwnerMoveBlock,
  type OwnerVitalsBlock,
  type OwnerWeaponBlock,
} from "@twobullets/protocol/messages/snapshot";
import {
  BLOOM_BITS,
  dequantizeCooldown,
  dequantizeDegrees64,
  dequantizePosXZ,
  dequantizePosY,
  dequantizeUnit8,
  PHASE_TIMER_BITS,
  quantizeCooldown,
  quantizeDegrees64,
  quantizeHealth,
  quantizeOwnerVel,
  quantizePitch,
  quantizePointsCeil,
  quantizePosXZ,
  quantizePosY,
  quantizeRemoteVel,
  quantizeTicks,
  quantizeUnit8,
  quantizeYaw,
  REMOTE_PITCH_BITS,
  REMOTE_YAW_BITS,
  RemoteFlags,
  StanceCode,
} from "@twobullets/protocol/quantize";
import { dequantizePitch, dequantizeYaw } from "@twobullets/shared/aim";
import type { ArmorLoadout, DamageKind } from "@twobullets/shared/equipment/armor";
import type { LifeState, Vitals } from "@twobullets/shared/equipment/vitals";
import type { MoveState, Stance, Vec3 } from "@twobullets/shared/movement/types";
import type { HitZone, WeaponId, WeaponSlotState, WeaponState } from "@twobullets/shared/weapons/types";

// Sim state → quantized wire state (netcode.md §6.3, §6.5), shared by server-match (snapshot builder), client prediction
// (compare the predicted tick's quantized state with the owner block) and bots, so every side quantizes identically.
// Pure and allocation-free except `weaponStateFromOwner` and `killFeedOf`.

const OWNER_TIMER_BITS = 4;

export function stanceCode(stance: Stance): number {
  return stance === "prone" ? StanceCode.prone : stance === "crouch" ? StanceCode.crouch : StanceCode.stand;
}

/** Owner move block from the body's feet and the move state. */
export function writeOwnerMove(feet: Readonly<Vec3>, move: MoveState, out: Mutable<OwnerMoveBlock>): void {
  out.xMm = quantizePosXZ(feet.x);
  out.yMm = quantizePosY(feet.y);
  out.zMm = quantizePosXZ(feet.z);
  out.vxMmS = quantizeOwnerVel(move.velocity.x);
  out.vyMmS = quantizeOwnerVel(move.velocity.y);
  out.vzMmS = quantizeOwnerVel(move.velocity.z);
  out.stance = stanceCode(move.stance);
  out.grounded = move.grounded;
  out.sprinting = move.sprinting;
  out.jumpHeld = move.jumpHeld;
  out.moveMode = 0;
  out.coyoteTicks = quantizeTicks(move.coyoteTimer, OWNER_TIMER_BITS);
  out.jumpBufferTicks = quantizeTicks(move.jumpBufferTimer, OWNER_TIMER_BITS);
  out.groundIgnoreTicks = quantizeTicks(move.groundIgnoreTimer, OWNER_TIMER_BITS);
}

const AIM_BUTTON = 16;

/**
 * Remote (full relevance) entity from feet, move state and the aim/buttons of the input simulated this tick. The M4
 * arguments fill the weapon slot/phase/id, life and armor-level flags; omitted, they read as unarmed, alive, no armor.
 */
export function writeRemoteEntity(
  slot: number,
  feet: Readonly<Vec3>,
  move: MoveState,
  yawQ20: number,
  pitchQ18: number,
  buttons: number,
  out: Mutable<EntityState>,
  weapon: WeaponState | null = null,
  life: LifeState = "alive",
  armor: ArmorLoadout | null = null,
): void {
  out.slot = slot;
  out.presence = EntityPresence.full;
  out.xMm = quantizePosXZ(feet.x);
  out.yMm = quantizePosY(feet.y);
  out.zMm = quantizePosXZ(feet.z);
  out.yawQ = quantizeYaw(dequantizeYaw(yawQ20), REMOTE_YAW_BITS);
  out.pitchQ = quantizePitch(dequantizePitch(pitchQ18), REMOTE_PITCH_BITS);
  out.vxQ = quantizeRemoteVel(move.velocity.x);
  out.vyQ = quantizeRemoteVel(move.velocity.y);
  out.vzQ = quantizeRemoteVel(move.velocity.z);
  let flags = stanceCode(move.stance) << RemoteFlags.stanceShift;
  if (move.grounded) flags |= RemoteFlags.grounded;
  if (move.sprinting) flags |= RemoteFlags.sprint;
  if ((buttons & AIM_BUTTON) !== 0) flags |= RemoteFlags.ads;
  if (weapon !== null) {
    const active = weapon.slots[weapon.activeIndex] ?? null;
    flags |= (weapon.activeIndex & 3) << RemoteFlags.weaponSlotShift;
    flags |= weaponPhaseCode(weapon.phase) << RemoteFlags.weaponPhaseShift;
    flags |= weaponCode(active?.id) << RemoteFlags.weaponIdShift;
  }
  flags |= lifeCode(life) << RemoteFlags.lifeShift;
  if (armor !== null) {
    flags |= (armor.helmet?.level ?? 0) << RemoteFlags.helmetShift;
    flags |= (armor.vest?.level ?? 0) << RemoteFlags.vestShift;
  }
  out.flags = flags;
  out.noiseClass = 0;
}

/** Weapon in hand from remote flags, or null when unarmed. */
export function remoteWeaponId(flags: number): WeaponId | null {
  return weaponIdOfCode((flags & RemoteFlags.weaponIdMask) >>> RemoteFlags.weaponIdShift);
}

export function remoteLifeCode(flags: number): number {
  return (flags & RemoteFlags.lifeMask) >>> RemoteFlags.lifeShift;
}

export function createOwnerBlock(): Mutable<OwnerMoveBlock> {
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

export function createEntityState(): Mutable<EntityState> {
  return { slot: 0, presence: EntityPresence.full, xMm: 0, yMm: 0, zMm: 0, yawQ: 0, pitchQ: 0, vxQ: 0, vyQ: 0, vzQ: 0, flags: 0, noiseClass: 0 };
}

// ---- Owner weapon and vitals groups -----------------------------------------------------------------------------

/** Magazine and reserve saturate at their field widths (7 and 10 bits). */
const MAGAZINE_MAX = 127;
const RESERVE_MAX = 1023;

/** Owner weapon group from the predicted/authoritative weapon state. Slots beyond MAX_WEAPON_SLOTS are not replicated. */
export function writeOwnerWeapon(weapon: WeaponState, out: MutableOwnerWeaponBlock): void {
  out.phase = weaponPhaseCode(weapon.phase);
  out.activeIndex = weapon.activeIndex;
  out.phaseTimerTicks = quantizeTicks(weapon.phaseTimer, PHASE_TIMER_BITS);
  out.cooldownQ = quantizeCooldown(weapon.cooldown);
  out.triggerHeld = weapon.triggerHeld;
  out.bloomQ = quantizeDegrees64(weapon.bloom, BLOOM_BITS);
  out.adsQ = quantizeUnit8(weapon.adsBlend);
  out.shotCounter16 = weapon.shotCounter & 0xffff;
  const n = Math.min(weapon.slots.length, MAX_WEAPON_SLOTS);
  out.slotCount = n;
  for (let i = 0; i < MAX_WEAPON_SLOTS; i++) {
    const slot = i < n ? (weapon.slots[i] ?? null) : null;
    out.slotWeapon[i] = weaponCode(slot?.id);
    out.slotMagazine[i] = slot === null ? 0 : slot.magazine < 0 ? 0 : slot.magazine > MAGAZINE_MAX ? MAGAZINE_MAX : slot.magazine;
    out.slotReserve[i] = slot === null ? 0 : slot.reserve < 0 ? 0 : slot.reserve > RESERVE_MAX ? RESERVE_MAX : slot.reserve;
  }
}

/**
 * Authoritative weapon state from an owner weapon group (allocates; corrections only). Every float dequantizes within
 * `WEAPON_TOLERANCE` of the server's value (timers ≤ ½ tick, bloom ≤ 1/128°, ADS ≤ 1/510), so compare it with
 * `diffWeaponState(predicted, auth)` and restore with `restoreWeapon(auth, predicted)`. The 16-bit shot counter unwraps
 * against `referenceShotCounter` (the prediction for the same tick; −1 = none).
 */
export function weaponStateFromOwner(block: OwnerWeaponBlock, referenceShotCounter = -1): WeaponState {
  const slots: (WeaponSlotState | null)[] = [];
  for (let i = 0; i < block.slotCount; i++) {
    const id = weaponIdOfCode(block.slotWeapon[i]!);
    slots.push(id === null ? null : { id, magazine: block.slotMagazine[i]!, reserve: block.slotReserve[i]! });
  }
  return {
    slots,
    activeIndex: block.activeIndex,
    phase: weaponPhaseOfCode(block.phase),
    phaseTimer: block.phaseTimerTicks / 60,
    cooldown: dequantizeCooldown(block.cooldownQ),
    triggerHeld: block.triggerHeld,
    bloom: dequantizeDegrees64(block.bloomQ),
    adsBlend: dequantizeUnit8(block.adsQ),
    shotCounter: unwrapShotId(block.shotCounter16, referenceShotCounter),
  };
}

/** Owner vitals group (health and downed pool in 0.1 HP, boost and armor durability as whole points rounded up). */
export function writeOwnerVitals(vitals: Vitals, armor: ArmorLoadout | null, out: Mutable<OwnerVitalsBlock>): void {
  const life = lifeCode(vitals.life);
  out.life = life;
  out.healthQ = quantizeHealth(vitals.health, 10);
  out.boost = quantizePointsCeil(vitals.boost, 7);
  const downed = vitals.life === "downed";
  out.downedHealthQ = downed ? quantizeHealth(vitals.downedHealth, 10) : 0;
  out.reviveTicks = downed ? quantizeTicks(vitals.reviveProgress, 9) : 0;
  const helmet = armor?.helmet ?? null;
  const vest = armor?.vest ?? null;
  out.helmetLevel = helmet?.level ?? 0;
  out.helmetDurability = helmet === null ? 0 : quantizePointsCeil(helmet.durability, 8);
  out.vestLevel = vest?.level ?? 0;
  out.vestDurability = vest === null ? 0 : quantizePointsCeil(vest.durability, 8);
}

// ---- Events -----------------------------------------------------------------------------------------------------

/** Radians yaw of a horizontal direction (MoveInput convention: 0 = +Z, + toward +X). */
function yawOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

const SHOT_ORIGIN_XZ_MAX = (1 << (SHOT_ORIGIN_XZ_BITS - 1)) - 1;
const SHOT_ORIGIN_Y_MAX = (1 << (SHOT_ORIGIN_Y_BITS - 1)) - 1;

function clampCm(m: number, max: number): number {
  const cm = Math.round(m * 100);
  return cm < -max ? -max : cm > max ? max : cm + 0;
}

/**
 * `Shot` for remote tracers from the weapon step's `AimedShot` fields. `yawQ`/`pitchQ` are the fire tick's input aim
 * (what the sim dequantized); `shooterFeet` is the shooter's entity in the snapshot that carries the event (quantized
 * mm, the value the client decodes); `tickOffset` = snapshot tick − fire tick (0..3).
 */
export function writeShotEvent(
  shooter: number,
  tickOffset: number,
  weaponId: WeaponId,
  shotId: number,
  spreadDegrees: number,
  yawQ: number,
  pitchQ: number,
  origin: Readonly<Vec3>,
  shooterFeet: { readonly xMm: number; readonly yMm: number; readonly zMm: number },
  out: Mutable<ShotEvent>,
): void {
  out.shooter = shooter;
  out.weapon = weaponCode(weaponId);
  out.tickOffset = tickOffset < 0 ? 0 : tickOffset > 3 ? 3 : tickOffset;
  out.shotId = shotId & 0xffff;
  out.yawQ = yawQ;
  out.pitchQ = pitchQ;
  out.spreadQ = quantizeDegrees64(spreadDegrees, SHOT_SPREAD_BITS);
  out.originDxCm = clampCm(origin.x - dequantizePosXZ(shooterFeet.xMm), SHOT_ORIGIN_XZ_MAX);
  out.originDyCm = clampCm(origin.y - dequantizePosY(shooterFeet.yMm), SHOT_ORIGIN_Y_MAX);
  out.originDzCm = clampCm(origin.z - dequantizePosXZ(shooterFeet.zMm), SHOT_ORIGIN_XZ_MAX);
}

/** Client: the shot's origin from the event and the shooter's entity in the same snapshot. */
export function shotOriginInto(
  shot: ShotEvent,
  shooterFeet: { readonly xMm: number; readonly yMm: number; readonly zMm: number },
  out: { x: number; y: number; z: number },
): void {
  out.x = dequantizePosXZ(shooterFeet.xMm) + shot.originDxCm / 100;
  out.y = dequantizePosY(shooterFeet.yMm) + shot.originDyCm / 100;
  out.z = dequantizePosXZ(shooterFeet.zMm) + shot.originDzCm / 100;
}

/** Client: the spread (degrees) to pass to `shotDirections`. */
export function shotSpreadDegrees(shot: ShotEvent): number {
  return dequantizeDegrees64(shot.spreadQ);
}

/** Full shot counter from a `Shot` event's 16 bits and the last one seen for that shooter (−1 = none). */
export function unwrapShotId(shotId16: number, lastSeen: number): number {
  if (lastSeen < 0) return shotId16;
  const delta = ((((shotId16 - (lastSeen & 0xffff) + 0x8000) & 0xffff) - 0x8000) | 0);
  return Math.max(0, lastSeen + delta);
}

/** `PlayerHit` for bystander FX; `dirX`/`dirZ` is the bullet's travel direction. */
export function writePlayerHitEvent(victim: number, zone: HitZone | null, armor: boolean, dirX: number, dirZ: number, out: Mutable<PlayerHitEvent>): void {
  out.victim = victim;
  out.zone = hitZoneCode(zone);
  out.armor = armor;
  out.dirYawQ = quantizeYaw(yawOf(dirX, dirZ), PLAYER_HIT_DIR_BITS);
}

/** `HitConfirm` aggregated per (shotId, victim) per tick; `zonesMask` uses `HitZoneMask`. Seq is assigned on push. */
export function writeHitConfirm(
  victim: number,
  pellets: number,
  zonesMask: number,
  damage: number,
  killed: boolean,
  downed: boolean,
  armorHit: boolean,
  armorBroken: boolean,
  out: ReliableEventStore,
): ReliableEvent {
  out.type = ReliableEventType.HitConfirm;
  out.seq = 0;
  out.victim = victim;
  out.pellets = pellets < 0 ? 0 : pellets > 15 ? 15 : pellets;
  out.zones = zonesMask & 7;
  out.damageQ = quantizeHealth(damage, 11);
  out.killed = killed;
  out.downed = downed;
  out.armorHit = armorHit;
  out.armorBroken = armorBroken;
  return out as ReliableEvent;
}

/** `DamageTaken` to the victim; `dirX`/`dirZ` points from the victim toward the source (0, 0 for zone-less damage). */
export function writeDamageTaken(
  attacker: number,
  amount: number,
  zone: HitZone | null,
  kind: DamageKind,
  dirX: number,
  dirZ: number,
  out: ReliableEventStore,
): ReliableEvent {
  out.type = ReliableEventType.DamageTaken;
  out.seq = 0;
  out.attacker = actorCode(attacker);
  out.dirYawQ = quantizeYaw(yawOf(dirX, dirZ), DAMAGE_DIR_BITS);
  out.amountQ = quantizeHealth(amount, 11);
  out.zone = hitZoneCode(zone);
  out.kind = damageKindCode(kind);
  return out as ReliableEvent;
}

/** `Kill` (or knock) reliable event. `killer` −1 = the world. */
export function writeKill(
  killer: number,
  victim: number,
  cause: KillCause,
  headshot: boolean,
  friendlyFire: boolean,
  knock: boolean,
  distanceM: number,
  out: ReliableEventStore,
): ReliableEvent {
  out.type = ReliableEventType.Kill;
  out.seq = 0;
  out.killer = actorCode(killer);
  out.victim = victim;
  out.cause = killCauseCode(cause);
  out.headshot = headshot;
  out.friendlyFire = friendlyFire;
  out.knock = knock;
  out.distanceM = distanceM < 0 ? 0 : distanceM > 1023 ? 1023 : Math.round(distanceM);
  return out as ReliableEvent;
}

/** `KillFeed` stream message fields (allocates; once per kill). `knockedBy` −1 = none. */
export function killFeedOf(
  serverTick: number,
  killer: number,
  victim: number,
  cause: KillCause,
  knockedBy: number,
  headshot: boolean,
  friendlyFire: boolean,
  knock: boolean,
  distanceM: number,
): KillFeed {
  return {
    serverTick,
    killer: actorCode(killer),
    victim,
    cause: killCauseCode(cause),
    knockedBy: actorCode(knockedBy),
    headshot,
    friendlyFire,
    knock,
    distanceDm: Math.round(distanceM * 10),
  };
}
