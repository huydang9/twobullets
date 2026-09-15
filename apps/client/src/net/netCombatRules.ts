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
/** Presses that cancel an item use (with jump, sprint and weapon select, which the server sees on the wire itself). */
const INTERRUPT_BUTTONS = Btn.fire | Btn.reload;

/** While downed (or dead) the server clears fire, aim and reload before `stepPlayer`; the client sends them cleared. */
export function netInputButtons(buttons: number, life: number): number {
  return life === LifeCode.alive ? buttons : buttons & ~COMBAT_BUTTONS;
}

/** The hands are busy: a (local) throwable out in any phase, or a heal/boost in use on the server (or just requested). */
export function netHandsBusy(throwPhase: string, usingItem: boolean): boolean {
  return throwPhase !== "idle" || usingItem;
}

/**
 * The equipment weapon gate (shared `gateCombatInput`) applied to the wire buttons, so local prediction, the server and
 * replays all step the same cleared input: while the hands are busy fire, aim and reload are dropped, and fire stays
 * dropped after they free up until the trigger is released (the click that throws never also fires). One per player,
 * called once per live tick.
 */
export class NetHandsGate {
  private fireLatched = false;

  apply(buttons: number, handsBusy: boolean): number {
    if (handsBusy) {
      this.fireLatched = true;
      return buttons & ~COMBAT_BUTTONS;
    }
    if (this.fireLatched) {
      if ((buttons & Btn.fire) !== 0) return buttons & ~Btn.fire;
      this.fireLatched = false;
    }
    return buttons;
  }

  reset(): void {
    this.fireLatched = false;
  }
}

/** What the networked tick input reads besides the local weapons (NetGame wiring). */
export interface NetCombatInputSources {
  /** Local equipment has the hands (`netHandsBusy`). */
  handsBusy(): boolean;
  /** Interact held with pointer lock (revive). */
  interactHeld(): boolean;
  /** Owner life code from the server. */
  life(): number;
  /** Fire or reload pressed while the hands are busy (cancels an item use; the wire never carries those presses). */
  handsInterrupted?(): void;
}

/**
 * The player's combat link in networked play: the local weapons' tick input with the hands gate, the revive button and
 * the downed/dead clearing applied, in that order. The result is what the local prediction steps, what replays step and
 * what the server receives.
 */
export function netCombatLink(
  combat: { readonly weaponState: WeaponState; takeCombatInput(out: { buttons: number; select: number }): void },
  sources: NetCombatInputSources,
): { readonly weaponState: WeaponState; takeCombatInput(out: { buttons: number; select: number }): void } {
  const hands = new NetHandsGate();
  let previousRaw = 0;
  return {
    get weaponState() {
      return combat.weaponState;
    },
    takeCombatInput(out) {
      combat.takeCombatInput(out);
      const raw = out.buttons;
      const busy = sources.handsBusy();
      if (busy && (raw & ~previousRaw & INTERRUPT_BUTTONS) !== 0) sources.handsInterrupted?.();
      previousRaw = raw;
      out.buttons = hands.apply(raw, busy);
      if (sources.interactHeld()) out.buttons |= REVIVE_BUTTON;
      const life = sources.life();
      out.buttons = netInputButtons(out.buttons, life);
      out.select = netInputSelect(out.select, life);
    },
  };
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
