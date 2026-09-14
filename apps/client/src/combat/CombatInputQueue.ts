import type { CombatInput } from "@twobullets/shared";
import type { Action } from "../input/bindings";
import type { InputManager } from "../input/InputManager";

const SLOT_ACTIONS: readonly Action[] = ["slot1", "slot2", "slot3", "slot4"];

const IDLE: CombatInput = { fire: false, aim: false, reload: false, selectIndex: null };

/**
 * Turns per-frame input into per-tick CombatInput. At high refresh rates most render frames run no tick, so
 * one-frame events (fire taps, reload, slot keys, wheel notches) are queued until a tick consumes them.
 */
export class CombatInputQueue {
  private fireQueued = false;
  private reloadQueued = false;
  private selectQueued: number | null = null;
  private polledThisFrame = false;

  constructor(private readonly input: InputManager) {}

  get isFireHeld(): boolean {
    return this.input.isLocked && this.input.isActionDown("fire");
  }

  get isAimHeld(): boolean {
    return this.input.isLocked && this.input.isActionDown("aim");
  }

  /**
   * Queues this frame's one-shot input exactly once, whether the first tick of the frame or the end-of-frame
   * update gets there first. `activeIndex`/`slotCount` resolve wheel cycling relative to any pending selection.
   */
  poll(activeIndex: number, slotCount: number): void {
    if (this.polledThisFrame) return;
    this.polledThisFrame = true;
    const input = this.input;
    if (!input.isLocked) {
      this.clear();
      return;
    }
    if (input.wasActionPressed("fire")) this.fireQueued = true;
    if (input.wasActionPressed("reload")) this.reloadQueued = true;

    SLOT_ACTIONS.forEach((action, index) => {
      if (index < slotCount && input.wasActionPressed(action)) this.selectQueued = index;
    });
    const wheel = input.wheelDelta();
    if (wheel !== 0 && slotCount > 0) {
      // +1 per notch scrolled down selects the next slot.
      const base = this.selectQueued ?? activeIndex;
      this.selectQueued = (((base + wheel) % slotCount) + slotCount) % slotCount;
    }
  }

  /** Call once per render frame after the frame's ticks, before input.endFrame(). */
  endFrame(activeIndex: number, slotCount: number): void {
    this.poll(activeIndex, slotCount);
    this.polledThisFrame = false;
  }

  /** Builds and consumes the input for one tick. */
  take(activeIndex: number, slotCount: number): CombatInput {
    this.poll(activeIndex, slotCount);
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
