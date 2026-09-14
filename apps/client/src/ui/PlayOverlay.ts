import { el } from "./dom";

type ControlRow = readonly [keys: readonly string[], action: string];

const CONTROLS: readonly ControlRow[] = [
  [["W", "A", "S", "D"], "Move"],
  [["Mouse"], "Look"],
  [["Space"], "Jump"],
  [["Shift"], "Sprint"],
  [["C"], "Crouch"],
  [["LMB"], "Fire"],
  [["RMB"], "Aim"],
  [["R"], "Reload"],
  [["1–3", "Wheel"], "Switch weapon"],
  [["5", "G"], "Throwable · cycle"],
  [["R"], "Cook frag (pin pulled)"],
  [["F"], "Pick up · revive"],
  [["7", "8", "9", "0"], "Heal · boost"],
];

const SYSTEM_CONTROLS: readonly ControlRow[] = [
  [["Esc"], "Release mouse"],
  [["F3"], "Debug stats"],
  [["F8"], "Physics debug"],
  [["F9"], "Inspector"],
];

const CREDITS_PLACEHOLDER = "No third-party asset credits yet.";

/** Offline bot match setup shown above "click to play" (`?bots=1`). */
export interface MatchSetup {
  readonly difficulties: readonly string[];
  readonly difficulty: string;
  onDifficulty(difficulty: string): void;
  /** Replaces "CLICK TO PLAY". */
  readonly playLabel?: string;
  /** Small line under the picker ("Map v1 · 5 teams × 2 · seed 1234"). */
  readonly details?: string;
}

/** If pointer lock hasn't arrived this long after a click, assume the browser refused it. */
const LOCK_TIMEOUT_MS = 300;

/** Full-screen title / "click to play" menu shown while the pointer is not locked. */
export class PlayOverlay {
  private readonly node: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly play: HTMLDivElement;
  private matchSetup: HTMLDivElement | null = null;
  private readonly creditsToggle: HTMLButtonElement;
  private readonly creditsSection: HTMLDivElement;
  private readonly creditsList: HTMLUListElement;
  private locked = false;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, onPlayClick: () => void) {
    this.node = el("div", "tb-overlay", undefined, parent);
    const panel = el("div", "tb-overlay__panel", undefined, this.node);

    const header = el("header", "tb-title", undefined, panel);
    el("h1", "tb-title__name", "TWOBULLETS", header);
    el("div", "tb-title__tagline", "Prototype · Battle Royale", header);

    this.play = el("div", "tb-play", "CLICK TO PLAY", panel);
    this.hint = el("div", "tb-hint", "Mouse lock was blocked. Wait a moment, then click again.", panel);
    this.hint.hidden = true;

    const controls = el("div", "tb-controls", undefined, panel);
    controlList(el("ul", "tb-controls__grid", undefined, controls), CONTROLS);
    controlList(el("ul", "tb-controls__system", undefined, controls), SYSTEM_CONTROLS);

    // Clicks inside the credits area must not start the game.
    const credits = el("div", "tb-credits", undefined, panel);
    credits.addEventListener("click", (event) => event.stopPropagation());
    this.creditsToggle = el("button", "tb-credits__toggle", "Credits", credits);
    this.creditsToggle.type = "button";
    this.creditsToggle.setAttribute("aria-expanded", "false");
    this.creditsSection = el("div", "tb-credits__section", undefined, credits);
    this.creditsSection.hidden = true;
    this.creditsList = el("ul", "tb-credits__list", undefined, this.creditsSection);
    this.setCredits([]);
    this.creditsToggle.addEventListener("click", () => {
      const open = this.creditsSection.hidden;
      this.creditsSection.hidden = !open;
      this.creditsToggle.setAttribute("aria-expanded", String(open));
    });

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
    if (!locked) return;
    this.hideHint();
    // A focused button would swallow Space (jump) once the game has the mouse.
    this.creditsToggle.blur();
  }

  set visible(visible: boolean) {
    this.node.hidden = !visible;
    if (!visible) this.hideHint();
  }

  /** Shows the difficulty picker for an offline bot match (null removes it). Clicks on it don't start the game. */
  setMatchSetup(setup: MatchSetup | null): void {
    this.matchSetup?.remove();
    this.matchSetup = null;
    this.play.textContent = setup?.playLabel ?? "CLICK TO PLAY";
    if (!setup) return;
    const root = el("div", "tb-matchsetup", undefined);
    root.addEventListener("click", (event) => event.stopPropagation());
    el("div", "tb-matchsetup__label", "Bot difficulty", root);
    const group = el("div", "tb-matchsetup__group", undefined, root);
    group.setAttribute("role", "radiogroup");
    const buttons: HTMLButtonElement[] = [];
    for (const difficulty of setup.difficulties) {
      const button = el("button", "tb-matchsetup__option", difficulty, group);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(difficulty === setup.difficulty));
      button.addEventListener("click", () => {
        for (const other of buttons) other.setAttribute("aria-checked", String(other === button));
        button.blur();
        setup.onDifficulty(difficulty);
      });
      buttons.push(button);
    }
    if (setup.details) el("div", "tb-matchsetup__details", setup.details, root);
    this.play.before(root);
    this.matchSetup = root;
  }

  /** Replaces the attribution lines (plain text). Rare, so the list is simply rebuilt. */
  setCredits(lines: readonly string[]): void {
    const items = lines.length > 0 ? lines : [CREDITS_PLACEHOLDER];
    this.creditsList.replaceChildren();
    for (const line of items) el("li", "tb-credits__line", line, this.creditsList);
    this.creditsList.toggleAttribute("data-empty", lines.length === 0);
  }

  private hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.hint.hidden = true;
  }
}

function controlList(list: HTMLUListElement, rows: readonly ControlRow[]): void {
  for (const [keys, action] of rows) {
    const row = el("li", "tb-controls__row", undefined, list);
    const keyCell = el("span", "tb-controls__keys", undefined, row);
    for (const key of keys) el("kbd", "tb-key", key, keyCell);
    el("span", "tb-controls__action", action, row);
  }
}
