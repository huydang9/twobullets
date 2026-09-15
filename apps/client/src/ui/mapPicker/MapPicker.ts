import { DEFAULT_REAL_MAP_ID } from "@twobullets/shared/map/real/index";
import { mapChoices, type MapChoice } from "../../world/mapRuntime/maps";
import { el } from "../dom";
import { MAP_PICKER_STRINGS, type MapPickerStrings } from "./strings";
import "./mapPicker.css";

export interface MapPickerOptions {
  /** Maps to offer (default: `mapChoices()`, Map v1 then the real-world maps). */
  readonly choices?: readonly MapChoice[];
  /** Initially selected id (default: the recommended real-world map). */
  readonly selected?: string;
  /** Called whenever the selection changes. */
  onSelect?(id: string): void;
  /** Called when the player confirms (the button, Enter or a double click on a card). */
  onConfirm?(id: string): void;
  /** Text (default English); the i18n pass swaps in translated strings. */
  readonly strings?: MapPickerStrings;
}

/**
 * Map picker for the MVP location choice: one card per map with its preview, place and country, a few numbers and the
 * credits its data needs. Keeps no game state; it reports the chosen map id (`selected`, `onSelect`, `onConfirm`,
 * `confirmed`) and the play overlay decides what to do with it.
 */
export class MapPicker {
  readonly root: HTMLDivElement;
  /** Resolves with the id the player confirms. */
  readonly confirmed: Promise<string>;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly choices: readonly MapChoice[];
  private readonly options: MapPickerOptions;
  private readonly strings: MapPickerStrings;
  private readonly credits: HTMLDivElement;
  private current: string;
  private resolveConfirmed!: (id: string) => void;

  constructor(parent: HTMLElement, options: MapPickerOptions = {}) {
    this.options = options;
    this.strings = options.strings ?? MAP_PICKER_STRINGS;
    this.choices = options.choices ?? mapChoices();
    this.confirmed = new Promise((resolve) => (this.resolveConfirmed = resolve));
    const fallback = this.choices.find((c) => c.id === DEFAULT_REAL_MAP_ID) ?? this.choices[0];
    this.current = this.choices.some((c) => c.id === options.selected) ? options.selected! : (fallback?.id ?? "");

    const s = this.strings;
    this.root = el("div", "tb-mappicker", undefined, parent);
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", s.title);
    // Clicks and keys stay inside the picker (the play overlay under it requests pointer lock on click).
    this.root.addEventListener("click", (event) => event.stopPropagation());
    this.root.addEventListener("keydown", (event) => this.onKey(event));

    const header = el("div", "tb-mappicker__header", undefined, this.root);
    el("h2", "tb-mappicker__title", s.title, header);
    el("p", "tb-mappicker__subtitle", s.subtitle, header);

    const list = el("div", "tb-mappicker__list", undefined, this.root);
    list.setAttribute("role", "radiogroup");
    for (const choice of this.choices) this.cards.set(choice.id, this.card(choice, list));

    const footer = el("div", "tb-mappicker__footer", undefined, this.root);
    this.credits = el("div", "tb-mappicker__credits", undefined, footer);
    const confirm = el("button", "tb-mappicker__confirm", s.confirm, footer);
    confirm.type = "button";
    confirm.addEventListener("click", () => this.confirm());
    this.select(this.current, false);
  }

  get selected(): string {
    return this.current;
  }

  select(id: string, notify = true): void {
    if (!this.cards.has(id)) return;
    this.current = id;
    for (const [cardId, card] of this.cards) {
      const on = cardId === id;
      card.setAttribute("aria-checked", String(on));
      card.tabIndex = on ? 0 : -1;
    }
    this.renderCredits();
    if (notify) this.options.onSelect?.(id);
  }

  confirm(): void {
    if (!this.current) return;
    this.options.onConfirm?.(this.current);
    this.resolveConfirmed(this.current);
  }

  dispose(): void {
    this.root.remove();
  }

  private card(choice: MapChoice, parent: HTMLElement): HTMLButtonElement {
    const s = this.strings;
    const card = el("button", "tb-mappicker__card", undefined, parent);
    card.type = "button";
    card.setAttribute("role", "radio");
    card.dataset.mapId = choice.id;
    card.addEventListener("click", () => this.select(choice.id));
    card.addEventListener("dblclick", () => {
      this.select(choice.id);
      this.confirm();
    });

    const figure = el("div", "tb-mappicker__preview", undefined, card);
    const img = el("img", "tb-mappicker__image", undefined, figure);
    img.src = choice.previewUrl;
    img.alt = s.previewAlt(this.displayName(choice));
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    if (choice.id === DEFAULT_REAL_MAP_ID) el("span", "tb-mappicker__badge", s.recommended, figure);

    const body = el("div", "tb-mappicker__body", undefined, card);
    el("div", "tb-mappicker__name", this.displayName(choice), body);
    el("div", "tb-mappicker__place", choice.fictional ? s.fictionalPlace : (s.countries[choice.countryCode] ?? choice.country), body);
    const stats = [s.stats.pois(choice.pois), s.stats.buildings(choice.buildings)];
    if (choice.roadsKm !== null) stats.push(s.stats.roads(choice.roadsKm));
    if (!choice.fictional) stats.push(choice.reliefMeters !== null ? s.stats.relief(choice.reliefMeters) : s.stats.flat);
    el("div", "tb-mappicker__stats", stats.join(" · "), body);
    return card;
  }

  private displayName(choice: MapChoice): string {
    return choice.fictional ? this.strings.fictionalName : choice.name;
  }

  private renderCredits(): void {
    const s = this.strings;
    const choice = this.choices.find((c) => c.id === this.current);
    this.credits.replaceChildren();
    if (!choice || choice.credits.length === 0) return;
    const link = el("a", "tb-mappicker__credit-link", choice.credits.map((id) => s.credits[id]).join(" · "), this.credits);
    link.href = s.creditsLink;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (choice.snapshot) el("span", "tb-mappicker__snapshot", s.snapshot(choice.snapshot), this.credits);
  }

  private onKey(event: KeyboardEvent): void {
    event.stopPropagation();
    const ids = this.choices.map((c) => c.id);
    const index = ids.indexOf(this.current);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      this.select(ids[(index + 1) % ids.length]!);
      this.cards.get(this.current)?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      this.select(ids[(index - 1 + ids.length) % ids.length]!);
      this.cards.get(this.current)?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.confirm();
    }
  }
}
