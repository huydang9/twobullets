import { el } from "./dom";

const CONTROLS: ReadonlyArray<readonly [keys: readonly string[], action: string]> = [
  [["W", "A", "S", "D"], "Move"],
  [["Mouse"], "Look"],
  [["Space"], "Jump"],
  [["Shift"], "Sprint"],
  [["C"], "Crouch"],
  [["Esc"], "Release mouse"],
  [["F3"], "Debug stats"],
  [["F8"], "Physics debug"],
  [["F9"], "Inspector"],
];

/** If pointer lock hasn't arrived this long after a click, assume the browser refused it. */
const LOCK_TIMEOUT_MS = 300;

/** Full-screen "click to play" menu shown while the pointer is not locked. */
export class PlayOverlay {
  private readonly node: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private locked = false;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, onPlayClick: () => void) {
    this.node = el("div", "tb-overlay", undefined, parent);
    const panel = el("div", "tb-overlay__panel", undefined, this.node);

    const title = el("h1", "tb-title", undefined, panel);
    el("span", "tb-title__a", "TWO", title);
    el("span", "tb-title__b", "BULLETS", title);

    el("div", "tb-play", "CLICK TO PLAY", panel);
    this.hint = el("div", "tb-hint", "Mouse lock was blocked. Wait a moment, then click again.", panel);
    this.hint.hidden = true;

    const list = el("ul", "tb-controls", undefined, panel);
    for (const [keys, action] of CONTROLS) {
      const row = el("li", "tb-controls__row", undefined, list);
      const keyCell = el("span", "tb-controls__keys", undefined, row);
      for (const key of keys) el("kbd", "tb-key", key, keyCell);
      el("span", "tb-controls__action", action, row);
    }

    this.node.addEventListener("click", () => {
      this.hideHint();
      onPlayClick();
      this.hintTimer = setTimeout(() => {
        this.hintTimer = undefined;
        if (!this.locked && !this.node.hidden) this.hint.hidden = false;
      }, LOCK_TIMEOUT_MS);
    });
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.hideHint();
  }

  set visible(visible: boolean) {
    this.node.hidden = !visible;
    if (!visible) this.hideHint();
  }

  private hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.hint.hidden = true;
  }
}
