import { onLanguageChange, t } from "../../i18n";
import { el } from "../dom";
import type { PauseOption } from "./pauseOptions";

// Pause / escape menu (docs/release/quit-match.md). Esc is reserved by the browser for leaving pointer lock, so the
// match owners open this when the pointer is released while a match is running; "Resume" (or Esc again) asks for the
// pointer back. Destructive actions ask once, in place, with a plain explanation.

export interface PauseMenuConfirm {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
}

export interface PauseMenuAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Hint under the button (why it is disabled, what it does). */
  readonly hint?: string;
  /** Asks first; `run` fires only after the player confirms. */
  readonly confirm?: PauseMenuConfirm;
  run(): void;
}

export interface PauseMenuOptions {
  /**
   * Back to the game: the owner asks for pointer lock. The menu stays up until the lock actually arrives (the owner
   * calls `close`), because a browser can refuse a lock requested within about a second of the Esc that released it —
   * closing first would leave the player with no menu and no mouse.
   */
  readonly onResume: () => void;
  /** Rebuilt every time the menu is shown, after each action and on a language switch. */
  readonly actions: () => readonly PauseMenuAction[];
  /** Optional line under the title (map, mode, "you are the host"). */
  readonly subtitle?: () => string;
}

/** Translates a `PauseOption` (pure data) into a menu button that calls `run`. */
export function toPauseAction(option: PauseOption, run: () => void): PauseMenuAction {
  return {
    label: t(option.labelKey),
    ...(option.hintKey ? { hint: t(option.hintKey) } : {}),
    ...(option.danger ? { danger: true } : {}),
    ...(option.confirm ? { confirm: { title: t(option.confirm.titleKey), body: t(option.confirm.bodyKey), confirmLabel: t(option.confirm.confirmKey) } } : {}),
    run,
  };
}

export class PauseMenu {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly options: PauseMenuOptions;
  private readonly unsubscribeLanguage: () => void;
  private pending: PauseMenuAction | null = null;

  constructor(parent: HTMLElement, options: PauseMenuOptions) {
    this.options = options;
    this.root = el("div", "tb-pause", undefined, parent);
    this.root.setAttribute("role", "dialog");
    this.root.addEventListener("click", (event) => event.stopPropagation());
    this.root.addEventListener("mousedown", (event) => event.stopPropagation());
    this.title = el("div", "tb-pause__title", undefined, this.root);
    this.subtitle = el("div", "tb-pause__subtitle", undefined, this.root);
    this.body = el("div", "tb-pause__body", undefined, this.root);
    this.root.hidden = true;
    this.unsubscribeLanguage = onLanguageChange(() => {
      if (!this.root.hidden) this.render();
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** True while the "are you sure?" step is showing. */
  get confirming(): boolean {
    return this.pending !== null;
  }

  open(): void {
    this.pending = null;
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.pending = null;
    this.root.hidden = true;
  }

  /** Refreshes the buttons in place (host changes, a teammate leaving). No-op while hidden. */
  refresh(): void {
    if (!this.root.hidden && this.pending === null) this.render();
  }

  /**
   * Esc while the menu is open: steps back from a confirmation, else asks to resume. Returns true when it handled the
   * key.
   */
  handleEscape(): boolean {
    if (this.root.hidden) return false;
    if (this.pending !== null) {
      this.pending = null;
      this.render();
      return true;
    }
    this.resume();
    return true;
  }

  private resume(): void {
    this.pending = null;
    this.options.onResume();
  }

  dispose(): void {
    this.unsubscribeLanguage();
    this.root.remove();
  }

  private render(): void {
    const pending = this.pending;
    this.title.textContent = pending?.confirm ? pending.confirm.title : t("pause.title");
    const subtitle = pending?.confirm ? pending.confirm.body : (this.options.subtitle?.() ?? "");
    this.subtitle.textContent = subtitle;
    this.subtitle.hidden = subtitle === "";
    this.subtitle.classList.toggle("tb-pause__subtitle--warn", pending !== null);
    this.body.replaceChildren();
    if (pending?.confirm) {
      const row = el("div", "tb-pause__row", undefined, this.body);
      this.button(row, pending.confirm.confirmLabel, "danger", () => {
        const action = pending;
        this.pending = null;
        this.close();
        action.run();
      });
      this.button(row, t("pause.cancel"), "", () => {
        this.pending = null;
        this.render();
      });
      return;
    }
    this.button(this.body, t("pause.resume"), "primary", () => this.resume());
    for (const action of this.options.actions()) {
      const button = this.button(this.body, action.label, action.danger ? "danger" : action.primary ? "primary" : "", () => {
        if (action.confirm) {
          this.pending = action;
          this.render();
          return;
        }
        this.close();
        action.run();
      });
      button.disabled = action.disabled === true;
      if (action.hint) el("div", "tb-pause__hint", action.hint, this.body);
    }
    el("div", "tb-pause__hint tb-pause__hint--key", t("pause.escHint"), this.body);
  }

  private button(parent: HTMLElement, label: string, modifier: string, run: () => void): HTMLButtonElement {
    const button = el("button", `tb-pause__button${modifier ? ` tb-pause__button--${modifier}` : ""}`, label, parent);
    button.type = "button";
    button.addEventListener("click", () => {
      button.blur();
      run();
    });
    return button;
  }
}
