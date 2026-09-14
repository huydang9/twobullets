import { getWeaponDef, type WeaponDef, type WeaponId, type WeaponState } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";

/** Magazine at or below this fraction counts as low (color change + reload prompt). */
const LOW_AMMO_FRACTION = 0.25;

type AmmoLevel = "ok" | "low" | "empty";
type Prompt = "none" | "reload" | "reloading" | "noammo";

const POP_KEYFRAMES: Keyframe[] = [
  { transform: "translate3d(0,10px,0) scale(1.14)", opacity: 0.3, easing: "cubic-bezier(.2,1.6,.4,1)" },
  { transform: "none", opacity: 1 },
];
const FLASH_KEYFRAMES: Keyframe[] = [{ transform: "scale(1.18)", easing: "ease-out" }, { transform: "none" }];
const SHAKE_KEYFRAMES: Keyframe[] = [
  { transform: "none" },
  { transform: "translate3d(-6px,0,0)", offset: 0.2 },
  { transform: "translate3d(5px,0,0)", offset: 0.45 },
  { transform: "translate3d(-3px,0,0)", offset: 0.7 },
  { transform: "none" },
];

interface SlotView {
  readonly node: HTMLDivElement;
  active: boolean;
  empty: boolean;
}

/** Bottom-right magazine/reserve readout, weapon name, reload prompt/progress and the 1–4 slot strip. */
export class AmmoPanel {
  private readonly slotStrip: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly counts: HTMLDivElement;
  private readonly name: Text;
  private readonly magazine: Text;
  private readonly reserve: Text;
  private readonly bar: HTMLDivElement;
  private readonly barFill: HTMLDivElement;
  private readonly prompts: Readonly<Record<Exclude<Prompt, "none">, HTMLDivElement>>;
  private readonly popAnim: Animation;
  private readonly flashAnim: Animation;
  private readonly shakeAnim: Animation;

  private slots: SlotView[] = [];
  private readonly slotIds: WeaponId[] = [];
  private shownMagazine = -1;
  private shownReserve = -1;
  private level: AmmoLevel | undefined;
  private prompt: Prompt = "none";
  private phase = "";
  private progress = -1;

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-ammo", undefined, parent);

    const promptRow = el("div", "tb-ammo__prompts", undefined, root);
    const reload = el("div", "tb-prompt tb-prompt--reload", undefined, promptRow);
    el("kbd", "tb-key", "R", reload);
    el("span", "", "RELOAD", reload);
    this.prompts = {
      reload,
      reloading: el("div", "tb-prompt tb-prompt--reloading", "RELOADING", promptRow),
      noammo: el("div", "tb-prompt tb-prompt--noammo", "NO AMMO", promptRow),
    };
    for (const node of Object.values(this.prompts)) node.hidden = true;

    this.panel = el("div", "tb-ammo__panel", undefined, root);
    this.name = textNode(el("div", "tb-ammo__name", undefined, this.panel));
    this.counts = el("div", "tb-ammo__counts", undefined, this.panel);
    this.magazine = textNode(el("span", "tb-ammo__mag", undefined, this.counts));
    this.reserve = textNode(el("span", "tb-ammo__reserve", undefined, this.counts));
    this.bar = el("div", "tb-ammo__bar", undefined, this.panel);
    this.barFill = el("div", "tb-ammo__bar-fill", undefined, this.bar);
    this.bar.hidden = true;

    this.slotStrip = el("div", "tb-slots", undefined, root);

    this.popAnim = prepareAnimation(this.panel, POP_KEYFRAMES, { duration: 220 });
    this.flashAnim = prepareAnimation(this.counts, FLASH_KEYFRAMES, { duration: 180 });
    this.shakeAnim = prepareAnimation(this.counts, SHAKE_KEYFRAMES, { duration: 260 });
  }

  update(state: WeaponState, weapon: WeaponDef, phaseProgress: number | null): void {
    this.syncSlots(state);
    const active = state.slots[state.activeIndex];
    if (!active) return;

    setText(this.name, weapon.name);
    if (active.magazine !== this.shownMagazine) {
      this.shownMagazine = active.magazine;
      setText(this.magazine, active.magazine.toString());
    }
    if (active.reserve !== this.shownReserve) {
      this.shownReserve = active.reserve;
      setText(this.reserve, `/${active.reserve}`);
    }

    const low = active.magazine <= Math.ceil(weapon.magazineSize * LOW_AMMO_FRACTION);
    const level: AmmoLevel = active.magazine === 0 ? "empty" : low ? "low" : "ok";
    if (level !== this.level) {
      this.level = level;
      this.counts.dataset.level = level;
    }

    const reloading = state.phase === "reloading";
    const prompt: Prompt = reloading
      ? "reloading"
      : active.magazine === 0 && active.reserve === 0
        ? "noammo"
        : low && active.reserve > 0
          ? "reload"
          : "none";
    if (prompt !== this.prompt) {
      if (this.prompt !== "none") this.prompts[this.prompt].hidden = true;
      if (prompt !== "none") this.prompts[prompt].hidden = false;
      this.prompt = prompt;
    }

    if (state.phase !== this.phase) {
      this.phase = state.phase;
      this.panel.dataset.phase = state.phase;
      this.bar.hidden = !reloading;
      this.progress = -1;
    }
    if (reloading) {
      const progress = Math.round((phaseProgress ?? 0) * 200) / 200;
      if (progress !== this.progress) {
        this.progress = progress;
        this.barFill.style.transform = `scaleX(${progress})`;
      }
    }

    for (let i = 0; i < this.slots.length; i++) {
      const view = this.slots[i]!;
      const slot = state.slots[i]!;
      const isActive = i === state.activeIndex;
      const empty = slot.magazine + slot.reserve === 0;
      if (isActive !== view.active) {
        view.active = isActive;
        view.node.toggleAttribute("data-active", isActive);
      }
      if (empty !== view.empty) {
        view.empty = empty;
        view.node.toggleAttribute("data-empty", empty);
      }
    }
  }

  /** Weapon switch started: pop the panel. */
  onEquip(): void {
    replay(this.popAnim);
  }

  onReloadFinished(): void {
    this.shakeAnim.cancel();
    replay(this.flashAnim);
  }

  onDryFire(): void {
    this.flashAnim.cancel();
    replay(this.shakeAnim);
  }

  /** Rebuilds the slot strip only when the loadout itself changes. */
  private syncSlots(state: WeaponState): void {
    const slots = state.slots;
    let same = slots.length === this.slotIds.length;
    for (let i = 0; same && i < slots.length; i++) same = slots[i]!.id === this.slotIds[i];
    if (same) return;

    this.slotStrip.replaceChildren();
    this.slotIds.length = 0;
    this.slots = slots.map((slot) => {
      const def = getWeaponDef(slot.id);
      this.slotIds.push(slot.id);
      const node = el("div", "tb-slot", undefined, this.slotStrip);
      el("span", "tb-slot__key", def.slot.toString(), node);
      el("span", "tb-slot__name", def.name, node);
      return { node, active: false, empty: false };
    });
  }
}
