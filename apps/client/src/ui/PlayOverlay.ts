import { bindText, getLanguage, LANGUAGES, onLanguageChange, setLanguage, t, unbindText, type Language, type MessageKey } from "../i18n";
import { el, elT } from "./dom";

/** A key cap: printed as is ("W", "Esc") or a translated word ({ t: "key.mouse" }). */
type KeyCap = string | { readonly t: MessageKey };
type ControlRow = readonly [keys: readonly KeyCap[], action: MessageKey];

const CONTROLS: readonly ControlRow[] = [
  [["W", "A", "S", "D"], "controls.move"],
  [[{ t: "key.mouse" }], "controls.look"],
  [["Space"], "controls.jump"],
  [["Shift"], "controls.sprint"],
  [["C"], "controls.crouch"],
  [[{ t: "key.lmb" }], "controls.fire"],
  [[{ t: "key.rmb" }], "controls.aim"],
  [["R"], "controls.reload"],
  [["1–3", { t: "key.wheel" }], "controls.switchWeapon"],
  [["5", "G"], "controls.throwable"],
  [["R"], "controls.cook"],
  [["F"], "controls.interact"],
  [["7", "8", "9", "0"], "controls.heal"],
];

const SYSTEM_CONTROLS: readonly ControlRow[] = [
  [["Esc"], "controls.releaseMouse"],
  [["F3"], "controls.debugStats"],
  [["F8"], "controls.physicsDebug"],
  [["F9"], "controls.inspector"],
  [["F10"], "controls.perfHelp"],
];

const LANGUAGE_SHORT: Readonly<Record<Language, string>> = { vi: "VI", en: "EN" };

/** One labelled radio row of the match setup; `labels[i]` is shown for `options[i]` (default: the value). */
export interface MatchSetupChoice {
  readonly label: string;
  readonly options: readonly string[];
  readonly labels?: readonly string[];
  readonly value: string;
  onChange(value: string): void;
}

/**
 * Offline bot match setup shown above "click to play" (`?bots=1`). Labels arrive translated; the owner calls
 * `setMatchSetup` again after a language switch.
 */
export interface MatchSetup {
  readonly difficulties: readonly string[];
  /** Shown for `difficulties[i]` (default: the value). */
  readonly difficultyLabels?: readonly string[];
  readonly difficulty: string;
  onDifficulty(difficulty: string): void;
  /** Heading of the difficulty row (default "Độ khó bot"). */
  readonly difficultyLabel?: string;
  /** More rows under the difficulty (match size, team mode). */
  readonly choices?: readonly MatchSetupChoice[];
  /** Replaces "NHẤP ĐỂ CHƠI". */
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
  private readonly languageButtons: HTMLButtonElement[] = [];
  private locked = false;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, onPlayClick: () => void) {
    this.node = el("div", "tb-overlay", undefined, parent);
    const panel = el("div", "tb-overlay__panel", undefined, this.node);
    this.languageSwitch(panel);

    const header = el("header", "tb-title", undefined, panel);
    el("h1", "tb-title__name", "TWOBULLETS", header);
    elT("div", "tb-title__tagline", "overlay.tagline", header);
    elT("div", "tb-title__byline", "menu.author", header);

    this.play = elT("div", "tb-play", "overlay.clickToPlay", panel);
    this.hint = elT("div", "tb-hint", "overlay.lockBlocked", panel);
    this.hint.hidden = true;

    const controls = el("div", "tb-controls", undefined, panel);
    controlList(el("ul", "tb-controls__grid", undefined, controls), CONTROLS);
    controlList(el("ul", "tb-controls__system", undefined, controls), SYSTEM_CONTROLS);

    // Clicks inside the credits area must not start the game.
    const credits = el("div", "tb-credits", undefined, panel);
    credits.addEventListener("click", (event) => event.stopPropagation());
    this.creditsToggle = elT("button", "tb-credits__toggle", "overlay.credits", credits);
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
    for (const button of this.languageButtons) button.blur();
  }

  set visible(visible: boolean) {
    this.node.hidden = !visible;
    if (!visible) this.hideHint();
  }

  /** Shows the difficulty picker for an offline bot match (null removes it). Clicks on it don't start the game. */
  setMatchSetup(setup: MatchSetup | null): void {
    this.matchSetup?.remove();
    this.matchSetup = null;
    if (setup?.playLabel !== undefined) unbindText(this.play, setup.playLabel);
    else bindText(this.play, "overlay.clickToPlay");
    if (!setup) return;
    const root = el("div", "tb-matchsetup", undefined);
    root.addEventListener("click", (event) => event.stopPropagation());
    radioRow(root, {
      label: setup.difficultyLabel ?? t("setup.difficulty"),
      options: setup.difficulties,
      ...(setup.difficultyLabels ? { labels: setup.difficultyLabels } : {}),
      value: setup.difficulty,
      onChange: (value) => setup.onDifficulty(value),
    });
    for (const choice of setup.choices ?? []) radioRow(root, choice);
    if (setup.details) el("div", "tb-matchsetup__details", setup.details, root);
    this.play.before(root);
    this.matchSetup = root;
  }

  /** Replaces the attribution lines (plain text). Rare, so the list is simply rebuilt. */
  setCredits(lines: readonly string[]): void {
    this.creditsList.replaceChildren();
    if (lines.length === 0) elT("li", "tb-credits__line", "overlay.creditsEmpty", this.creditsList);
    for (const line of lines) el("li", "tb-credits__line", line, this.creditsList);
    this.creditsList.toggleAttribute("data-empty", lines.length === 0);
  }

  /** VI | EN switch in the panel corner; applies at once (bound labels re-translate, owners of dynamic text rebuild). */
  private languageSwitch(panel: HTMLElement): void {
    const group = el("div", "tb-lang", undefined, panel);
    group.setAttribute("role", "radiogroup");
    group.addEventListener("click", (event) => event.stopPropagation());
    const sync = (language: Language): void => {
      group.setAttribute("aria-label", t("common.language"));
      LANGUAGES.forEach((code, i) => {
        const button = this.languageButtons[i]!;
        button.setAttribute("aria-checked", String(code === language));
        button.title = t(`common.languageName.${code}`);
      });
    };
    for (const code of LANGUAGES) {
      const button = el("button", "tb-lang__option", LANGUAGE_SHORT[code], group);
      button.type = "button";
      button.lang = code;
      button.setAttribute("role", "radio");
      button.addEventListener("click", () => {
        button.blur();
        setLanguage(code);
      });
      this.languageButtons.push(button);
    }
    sync(getLanguage());
    onLanguageChange(sync);
  }

  private hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.hint.hidden = true;
  }
}

function radioRow(parent: HTMLElement, choice: MatchSetupChoice): void {
  el("div", "tb-matchsetup__label", choice.label, parent);
  const group = el("div", "tb-matchsetup__group", undefined, parent);
  group.setAttribute("role", "radiogroup");
  const buttons: HTMLButtonElement[] = [];
  choice.options.forEach((value, i) => {
    const button = el("button", "tb-matchsetup__option", choice.labels?.[i] ?? value, group);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(value === choice.value));
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-checked", String(other === button));
      button.blur();
      choice.onChange(value);
    });
    buttons.push(button);
  });
}

function controlList(list: HTMLUListElement, rows: readonly ControlRow[]): void {
  for (const [keys, action] of rows) {
    const row = el("li", "tb-controls__row", undefined, list);
    const keyCell = el("span", "tb-controls__keys", undefined, row);
    for (const key of keys) {
      if (typeof key === "string") el("kbd", "tb-key", key, keyCell);
      else elT("kbd", "tb-key", key.t, keyCell);
    }
    elT("span", "tb-controls__action", action, row);
  }
}
