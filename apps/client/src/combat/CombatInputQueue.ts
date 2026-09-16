import { cycleWeaponSlot, type CombatInput, type WeaponSlotState } from "@twobullets/shared";
import type { Action } from "../input/bindings";
import type { InputManager } from "../input/InputManager";

const SLOT_ACTIONS: readonly Action[] = ["slot1", "slot2", "slot3", "slot4"];

const IDLE: CombatInput = { fire: false, aim: false, reload: false, selectIndex: null };

type Slots = readonly (WeaponSlotState | null)[];

/** The parts of InputManager the queue reads (a stand-in drives headless checks). */
export type CombatInputSource = Pick<InputManager, "isLocked" | "isActionDown" | "wasActionPressed" | "wheelDelta" | "holds">;

/**
 * Turns per-frame input into per-tick CombatInput. At high refresh rates most render frames run no tick, so
 * one-frame events (fire taps, reload, slot keys, wheel notches) are queued until a tick consumes them.
 */
export class CombatInputQueue {
  private fireQueued = false;
  private reloadQueued = false;
  private selectQueued: number | null = null;
  private polledThisFrame = false;

  constructor(private readonly input: CombatInputSource) {}

  get isFireHeld(): boolean {
    return this.input.isLocked && this.input.isActionDown("fire");
  }

  /** Aim for this tick: the button in hold mode, the latch in toggle mode. */
  get isAimHeld(): boolean {
    return this.input.holds.isDown("aim");
  }

  /** Ends a toggled aim (weapons blocked: a throwable in hand, an item in use, knocked, dead). */
  cancelAim(): void {
    this.input.holds.cancel("aim");
  }

  /**
   * Queues this frame's one-shot input exactly once, whether the first tick of the frame or the end-of-frame
   * update gets there first. Number keys only queue filled slots; wheel notches cycle over filled slots, relative to
   * any pending selection.
   */
  poll(activeIndex: number, slots: Slots): void {
    if (this.polledThisFrame) return;
    this.polledThisFrame = true;
    const input = this.input;
    if (!input.isLocked) {
      this.clear();
      return;
    }
    if (input.wasActionPressed("fire")) this.fireQueued = true;
    if (input.wasActionPressed("reload")) this.reloadQueued = true;

    let switched = false;
    SLOT_ACTIONS.forEach((action, index) => {
      if (slots[index] && input.wasActionPressed(action)) {
        this.selectQueued = index;
        switched ||= index !== activeIndex;
      }
    });
    const wheel = input.wheelDelta();
    if (wheel !== 0) {
      // +1 per notch scrolled down selects the next filled slot.
      const next = cycleWeaponSlot(slots, this.selectQueued ?? activeIndex, wheel);
      if (next !== null) {
        this.selectQueued = next;
        switched ||= next !== activeIndex;
      }
    }
    // A toggled aim ends where holding the button would stop mattering: taking out another weapon, and starting a
    // sprint (aiming blocks sprint, so without this the player could never run again without re-pressing aim).
    // Reloading is left alone: it drops the ADS blend for the reload and picks it back up, exactly as holding does.
    if (switched) input.holds.cancel("aim");
    if (input.wasActionPressed("sprint") && input.isActionDown("forward")) input.holds.cancel("aim");
  }

  /** Call once per render frame after the frame's ticks, before input.endFrame(). */
  endFrame(activeIndex: number, slots: Slots): void {
    this.poll(activeIndex, slots);
    this.polledThisFrame = false;
  }

  /** Builds and consumes the input for one tick. */
  take(activeIndex: number, slots: Slots): CombatInput {
    this.poll(activeIndex, slots);
    if (!this.input.isLocked) return IDLE;
    const select = this.selectQueued;
    const combat: CombatInput = {
      fire: this.fireQueued || this.isFireHeld,
      aim: this.isAimHeld,
      reload: this.reloadQueued,
      selectIndex: select !== null && select !== activeIndex ? select : null,
    };
    this.clear();
    return combat;
  }

  private clear(): void {
    this.fireQueued = false;
    this.reloadQueued = false;
    this.selectQueued = null;
  }
}
