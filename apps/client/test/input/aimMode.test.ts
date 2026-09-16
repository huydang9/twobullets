import { afterEach, beforeEach, describe, expect, it, vi as vitest } from "vitest";
import { CombatInputQueue, type CombatInputSource } from "../../src/combat/CombatInputQueue";
import type { Action } from "../../src/input/bindings";
import { resetControlSettings, setControlSettings, type ControlSettings, type HoldToggleMode, type ToggleAction } from "../../src/input/controlSettings";
import { HoldToggles } from "../../src/input/holdToggle";

// Aim mode (hold vs toggle) at the input layer: the toggle latch, every path that must leave the player un-aimed, and
// that hold mode is exactly what it was. Nothing here touches the wire — both modes produce the same `aim` bit, so the
// netcode contract is unchanged.

class FakeInput implements CombatInputSource {
  isLocked = true;
  readonly down = new Set<Action>();
  readonly pressed = new Set<Action>();
  wheel = 0;
  readonly holds = new HoldToggles(this);

  isActionDown(action: Action): boolean {
    return this.down.has(action);
  }

  wasActionPressed(action: Action): boolean {
    return this.pressed.has(action);
  }

  wheelDelta(): number {
    return this.wheel;
  }

  /** Presses an action this frame (down + the one-frame edge). */
  press(...actions: Action[]): void {
    for (const action of actions) {
      this.pressed.add(action);
      this.down.add(action);
    }
  }

  release(...actions: Action[]): void {
    for (const action of actions) this.down.delete(action);
  }

  /** InputManager.endFrame. */
  endFrame(): void {
    this.holds.endFrame();
    this.pressed.clear();
    this.wheel = 0;
  }

  /** Pointer lock lost: the bag, the map, the pause menu, Esc, a finished match. */
  unlock(): void {
    this.isLocked = false;
    this.down.clear();
    this.holds.cancelAll();
  }

  relock(): void {
    this.isLocked = true;
  }
}

const SLOTS = [{ id: "rifle" }, { id: "pistol" }, null, null] as unknown as Parameters<CombatInputQueue["take"]>[1];

let input: FakeInput;
let queue: CombatInputQueue;

/** The tick's aim bit, the way CombatSystem.takeCombatInput reads it. */
const aim = (): boolean => queue.take(0, SLOTS).aim;

/** End of a render frame: CombatSystem.update then InputManager.endFrame (Game.ts order). */
const endFrame = (): void => {
  queue.endFrame(0, SLOTS);
  input.endFrame();
};

const mode = (action: ToggleAction, value: HoldToggleMode): void => {
  setControlSettings({ [action]: value } as Partial<ControlSettings>);
};

beforeEach(() => {
  vitest.stubGlobal("localStorage", undefined);
  resetControlSettings();
  input = new FakeInput();
  queue = new CombatInputQueue(input);
});

afterEach(() => {
  resetControlSettings();
  vitest.unstubAllGlobals();
});

describe("aim mode: hold (the default, unchanged)", () => {
  it("aims only while the button is held", () => {
    expect(aim()).toBe(false);
    endFrame();
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    expect(aim()).toBe(true); // still held
    endFrame();
    input.release("aim");
    expect(aim()).toBe(false);
  });

  it("keeps aiming through a weapon switch, a reload and a sprint press", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    for (const press of ["slot2", "reload", "sprint"] as Action[]) {
      input.press(press);
      expect(aim(), press).toBe(true);
      endFrame();
      input.release(press);
    }
  });
});

describe("aim mode: toggle", () => {
  beforeEach(() => mode("aim", "toggle"));

  it("one press aims, the next stops, and letting the button go changes nothing", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");
    expect(aim()).toBe(true);
    endFrame();

    input.press("aim");
    expect(aim()).toBe(false);
    endFrame();
    input.release("aim");
    expect(aim()).toBe(false);
  });

  it("answers the same for every read in a frame, however many ticks run", () => {
    input.press("aim");
    expect([aim(), aim(), aim()]).toEqual([true, true, true]);
    endFrame();
  });

  it("counts a press on a frame that ran no tick", () => {
    input.press("aim");
    endFrame();
    input.release("aim");
    expect(aim()).toBe(true);
  });

  it("a weapon switch on a number key leaves the player un-aimed", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");

    input.press("slot2");
    expect(aim()).toBe(false);
    endFrame();
    input.release("slot2");
    expect(aim()).toBe(false); // and stays off until a fresh press
  });

  it("a weapon switch on the wheel leaves the player un-aimed", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");

    input.wheel = 1;
    expect(aim()).toBe(false);
    endFrame();
    expect(aim()).toBe(false);
  });

  it("starting a sprint leaves the player un-aimed (aiming blocks sprint, so nothing gets stuck)", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");

    input.down.add("forward");
    input.press("sprint");
    expect(aim()).toBe(false);
    endFrame();
    input.release("sprint");
    expect(aim()).toBe(false);
  });

  it("reloading keeps the toggle, exactly like holding the button through a reload", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");

    input.press("reload");
    expect(aim()).toBe(true);
    endFrame();
  });

  it("a throwable in hand, an item in use, knocked or dead (cancelAim) leaves the player un-aimed", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");

    queue.cancelAim();
    expect(aim()).toBe(false);
    endFrame();
    expect(aim()).toBe(false); // hands free / revived: still not aiming
    endFrame();
    input.press("aim");
    expect(aim()).toBe(true);
  });

  it("losing pointer lock (bag, map, pause menu, Esc, match end) leaves the player un-aimed", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");

    input.unlock();
    expect(aim()).toBe(false);
    endFrame();
    input.relock();
    expect(aim()).toBe(false);
    endFrame();
    input.press("aim");
    expect(aim()).toBe(true);
  });

  it("switching back to hold mid-session hands the button back", () => {
    input.press("aim");
    expect(aim()).toBe(true);
    endFrame();
    input.release("aim");
    mode("aim", "hold");
    expect(aim()).toBe(false);
  });
});

describe("crouch and sprint", () => {
  it("default to hold: the button alone decides", () => {
    expect(input.holds.isDown("crouch")).toBe(false);
    input.press("crouch");
    expect(input.holds.isDown("crouch")).toBe(true);
    input.endFrame();
    input.release("crouch");
    expect(input.holds.isDown("crouch")).toBe(false);
  });

  it("toggle crouch: press on, press off", () => {
    mode("crouch", "toggle");
    input.press("crouch");
    expect(input.holds.isDown("crouch")).toBe(true);
    input.endFrame();
    input.release("crouch");
    expect(input.holds.isDown("crouch")).toBe(true);
    input.endFrame();
    input.press("crouch");
    expect(input.holds.isDown("crouch")).toBe(false);
  });

  it("toggle sprint ends when the player stops running forward (PlayerController cancels it)", () => {
    mode("sprint", "toggle");
    input.press("sprint");
    expect(input.holds.isDown("sprint")).toBe(true);
    input.endFrame();
    input.release("sprint");
    expect(input.holds.isDown("sprint")).toBe(true);
    input.endFrame();
    // W released: PlayerController.sampleInput cancels the latch.
    input.holds.cancel("sprint");
    expect(input.holds.isDown("sprint")).toBe(false);
  });
});
