import { getControlSettings, TOGGLE_ACTIONS, type HoldToggleMode, type ToggleAction } from "./controlSettings";

/** The parts of InputManager the toggles read (a stand-in drives headless checks). */
export interface HoldToggleSource {
  readonly isLocked: boolean;
  isActionDown(action: ToggleAction): boolean;
  wasActionPressed(action: ToggleAction): boolean;
}

/**
 * Hold-vs-toggle state for aim, crouch and sprint (controlSettings.ts). In hold mode `isDown` is just the button; in
 * toggle mode the first read of a frame consumes the press and flips a latch, and every later read that frame sees the
 * same answer — a frame can run several ticks, and both the combat and the equipment queues ask.
 *
 * Nothing may leave the player stuck aiming: losing pointer lock (the bag, the map, the pause menu, Esc, a finished
 * match) drops every latch here, and the gameplay owners call `cancel` for the rest — a weapon switch, a sprint start,
 * a throwable in hand or an item in use, knocked and dead. After any of those the player is not aiming until they
 * press again.
 */
export class HoldToggles {
  private readonly latched: Record<ToggleAction, boolean> = { aim: false, crouch: false, sprint: false };
  /** Whether this frame's press edge has already been folded into the latch. */
  private readonly consumed: Record<ToggleAction, boolean> = { aim: false, crouch: false, sprint: false };

  constructor(private readonly source: HoldToggleSource) {}

  mode(action: ToggleAction): HoldToggleMode {
    return getControlSettings()[action];
  }

  /** Whether the action counts as held this frame. */
  isDown(action: ToggleAction): boolean {
    if (!this.source.isLocked) {
      this.latched[action] = false;
      return false;
    }
    if (this.mode(action) === "hold") return this.source.isActionDown(action);
    if (!this.consumed[action]) {
      this.consumed[action] = true;
      if (this.source.wasActionPressed(action)) this.latched[action] = !this.latched[action];
    }
    return this.latched[action];
  }

  /** Ends a toggled action. No-op in hold mode, where the button alone decides. */
  cancel(action: ToggleAction): void {
    this.latched[action] = false;
  }

  cancelAll(): void {
    for (const action of TOGGLE_ACTIONS) this.latched[action] = false;
  }

  /** Once per render frame, after the frame's ticks: folds in a press no consumer read, then clears the frame guard. */
  endFrame(): void {
    for (const action of TOGGLE_ACTIONS) {
      this.isDown(action);
      this.consumed[action] = false;
    }
  }
}
