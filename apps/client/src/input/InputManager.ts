import { GAME_KEYS, KEY_BINDINGS, type Action } from "./bindings";
import { HoldToggles } from "./holdToggle";

/** Mouse events this soon after acquiring lock are dropped; some browsers report a bogus jump on lock. */
const LOCK_SETTLE_MS = 50;
/**
 * Some browsers occasionally emit one huge movementX/Y. Real flicks ramp up over several events, so an event is
 * dropped when it is both above SPIKE_MIN_PX and SPIKE_RATIO times larger than the previous event.
 */
const SPIKE_MIN_PX = 200;
const SPIKE_RATIO = 8;
/** The Babylon Inspector mounts this element while open; clicks in its viewport must not grab the mouse. */
const INSPECTOR_CONTAINER_ID = "babylon-inspector-container";

/**
 * Keyboard state (tracked whether or not the pointer is locked, so debug hotkeys work in menus),
 * pointer lock and mouse-look deltas (only while locked).
 */
export class InputManager {
  /** When true, clicking the canvas requests pointer lock. Also skipped while the Babylon Inspector is open. */
  lockOnCanvasClick = true;

  /** Hold-vs-toggle state for aim, crouch and sprint; gameplay asks this instead of the raw button. */
  readonly holds: HoldToggles;

  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly lockListeners: Array<(locked: boolean) => void> = [];
  private readonly events = new AbortController();
  private mouseDx = 0;
  private mouseDy = 0;
  private wheelSteps = 0;
  private lockedAt = 0;
  private lastMouseMagnitude = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.holds = new HoldToggles(this);
    const options = { signal: this.events.signal };
    window.addEventListener("keydown", this.handleKeyDown, options);
    window.addEventListener("keyup", this.handleKeyUp, options);
    window.addEventListener("blur", this.releaseKeys, options);
    document.addEventListener("visibilitychange", this.releaseKeys, options);
    document.addEventListener("pointerlockchange", this.handleLockChange, options);
    document.addEventListener("mousemove", this.handleMouseMove, options);
    document.addEventListener("mousedown", this.handleMouseDown, options);
    document.addEventListener("mouseup", this.handleMouseUp, options);
    document.addEventListener("wheel", this.handleWheel, { ...options, passive: false });
    document.addEventListener("contextmenu", this.handleContextMenu, options);
    canvas.addEventListener("click", this.handleCanvasClick, options);
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    if (!this.isLocked) void this.lockPointer();
  }

  /** Fires whenever pointer lock is gained or lost. */
  onLockChange(listener: (locked: boolean) => void): void {
    this.lockListeners.push(listener);
  }

  /** True while the key (KeyboardEvent.code) is held. */
  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** True only on the frame the key went down. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  isActionDown(action: Action): boolean {
    return KEY_BINDINGS[action].some((code) => this.held.has(code));
  }

  wasActionPressed(action: Action): boolean {
    return KEY_BINDINGS[action].some((code) => this.pressed.has(code));
  }

  /** Accumulated mouse movement since last frame, in pixels. Always zero while unlocked. */
  lookDelta(): { readonly dx: number; readonly dy: number } {
    return { dx: this.mouseDx, dy: this.mouseDy };
  }

  /** Mouse wheel notches since last frame: +1 per notch scrolled down/toward the user, -1 up. Zero while unlocked. */
  wheelDelta(): number {
    return this.wheelSteps;
  }

  /** Call once at the end of every frame to reset per-frame state. */
  endFrame(): void {
    // Before `pressed` is dropped: a toggle press on a frame no consumer read still counts.
    this.holds.endFrame();
    this.pressed.clear();
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.wheelSteps = 0;
  }

  dispose(): void {
    this.events.abort();
    this.lockListeners.length = 0;
    if (this.isLocked) document.exitPointerLock();
  }

  private async lockPointer(): Promise<void> {
    try {
      // Raw (unaccelerated) mouse input where supported. Some browsers return undefined instead of a promise.
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotSupportedError")) return; // e.g. re-lock too soon after Esc
      try {
        await this.canvas.requestPointerLock();
      } catch {
        // Refused; the HUD overlay tells the player to click again.
      }
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.isLocked && GAME_KEYS.has(event.code)) event.preventDefault();
    if (event.repeat) return;
    this.held.add(event.code);
    this.pressed.add(event.code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    // macOS swallows keyup for any key released while Cmd is held; drop everything to avoid stuck keys.
    if (event.key === "Meta") this.held.clear();
    this.held.delete(event.code);
  };

  private readonly releaseKeys = (): void => {
    this.held.clear();
  };

  private readonly handleLockChange = (): void => {
    const locked = this.isLocked;
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.lastMouseMagnitude = 0;
    if (locked) this.lockedAt = performance.now();
    else {
      this.held.clear();
      // The bag, the map, the pause menu, Esc and a finished match all release the pointer: never come back aiming.
      this.holds.cancelAll();
    }
    for (const listener of this.lockListeners) listener(locked);
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.isLocked || performance.now() - this.lockedAt < LOCK_SETTLE_MS) return;
    const { movementX, movementY } = event;
    const magnitude = Math.max(Math.abs(movementX), Math.abs(movementY));
    const spike = magnitude > SPIKE_MIN_PX && magnitude > this.lastMouseMagnitude * SPIKE_RATIO;
    this.lastMouseMagnitude = magnitude;
    if (spike) return;
    this.mouseDx += movementX;
    this.mouseDy += movementY;
  };

  // Buttons only count while locked, so the click that grabs the mouse doesn't also fire a shot.
  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.isLocked) return;
    const code = `Mouse${event.button}`;
    this.held.add(code);
    this.pressed.add(code);
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    this.held.delete(`Mouse${event.button}`);
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.isLocked) return;
    event.preventDefault();
    if (event.deltaY !== 0) this.wheelSteps += Math.sign(event.deltaY);
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (this.isLocked) event.preventDefault();
  };

  private readonly handleCanvasClick = (): void => {
    if (!this.lockOnCanvasClick || document.getElementById(INSPECTOR_CONTAINER_ID)) return;
    this.requestLock();
  };
}
