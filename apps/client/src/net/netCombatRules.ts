import { NET_RESPAWN_SECONDS, NET_WEAPON_LOADOUT } from "@twobullets/contracts/netCombat";
import { LifeCode } from "@twobullets/protocol/codes";
import { MOVEMENT } from "@twobullets/shared/constants";
import { VITALS } from "@twobullets/shared/equipment/vitals";
import { Btn, OPEN_MOVE_GATES, type MoveGates } from "@twobullets/shared/input";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import type { WeaponState } from "@twobullets/shared/weapons/types";

// Every server-match combat rule (T4.3/T4.6 spec, relayed by the lead) client prediction and presentation depend on,
// in one place. If the server changes a rule, this file changes with it.

export { NET_RESPAWN_SECONDS, NET_WEAPON_LOADOUT };

/** Fresh spawn/respawn weapon state: rifle, empty primary 2, pistol; `select` = slot index + 1. */
export function createNetWeaponState(): WeaponState {
  return createWeaponState(NET_WEAPON_LOADOUT);
}

/** Knocked crawl gates (the server passes these to `stepPlayer` while the owner is downed). */
export const DOWNED_MOVE_GATES: MoveGates = {
  speedScale: VITALS.crawlSpeed / MOVEMENT.walkSpeed,
  allowSprint: false,
  allowJump: false,
  crawl: true,
};

/** Dead players aren't stepped by the server at all; the client holds the body still and stops predicting. */
export const DEAD_MOVE_GATES: MoveGates = { speedScale: 0, allowSprint: false, allowJump: false, crawl: false };

/** Owner vitals `life` code → the movement gates the server steps that tick with (no rooting while reviving). */
export function netMoveGates(life: number): MoveGates {
  return life === LifeCode.downed ? DOWNED_MOVE_GATES : life === LifeCode.dead ? DEAD_MOVE_GATES : OPEN_MOVE_GATES;
}

const COMBAT_BUTTONS = Btn.fire | Btn.aim | Btn.reload;

/** While downed (or dead) the server clears fire, aim and reload before `stepPlayer`; the client sends them cleared. */
export function netInputButtons(buttons: number, life: number): number {
  return life === LifeCode.alive ? buttons : buttons & ~COMBAT_BUTTONS;
}

/** While downed (or dead) the server steps `select = 0`. */
export function netInputSelect(select: number, life: number): number {
  return life === LifeCode.alive ? select : 0;
}

/** Revive: hold interact while alive within 2 m horizontally and 1.5 m vertically of a downed teammate (5 s). */
export const REVIVE_BUTTON = Btn.interact;
export const REVIVE_RANGE_M = VITALS.reviveRange;
export const REVIVE_VERTICAL_RANGE_M = 1.5;
export const REVIVE_SECONDS = VITALS.reviveSeconds;

/**
 * Event recipients (spec §6). `Shot`: everyone except the shooter. `PlayerHit`: everyone except the victim (blood,
 * including our own victims). `HitConfirm`: shooter only (hitmarker, damage number). `DamageTaken`: victim only (also
 * fall damage from the world). `Kill`: everyone (knock flag). `KillFeed` stream: everyone, kills and knocks.
 */
export const EVENT_RULES = {
  shotsIncludeOwn: false,
  playerHitsIncludeOwnVictim: false,
  /** Shots older than this many ticks at the snapshot are dropped by the server. */
  maxShotTickOffset: 3,
} as const;

/**
 * A `Resync` response resets the server's reliable event queue for that client, so the receiver resets too
 * (`ReliableEventSender.reset`: "the client's receiver must reset too").
 */
export const RESYNC_RESETS_RELIABLE_EVENTS = true;

/** `Input.viewOffset8` for an input with fire set: 8 × (input tick − rendered remote tick), clamped to the u8 field. */
export function viewOffset8(inputTick: number, renderTick: number): number {
  const q = Math.round(8 * (inputTick - renderTick));
  return q < 0 ? 0 : q > 255 ? 255 : q;
}
