import { getWeaponDef, type ThrowableKind, type WeaponId, type WeaponState } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";
import { throwableShort } from "./equipment/labels";

interface SlotView {
  readonly node: HTMLDivElement;
  active: boolean;
  empty: boolean;
}

const THROWABLE_KEY = "5";
const CYCLE_KEYFRAMES: Keyframe[] = [
  { opacity: 0.3, transform: "translate3d(0,-3px,0)", easing: "ease-out" },
  { opacity: 1, transform: "none" },
];

/**
 * Compact weapon strip: key 1–3 slots (vacant slots show a dash), the active slot outlined, slots with no ammo at
 * all dimmed, and a throwable slot on key 5 with the selected kind, its count and a G hint while more kinds are carried.
 */
export class WeaponSlots {
  private readonly strip: HTMLDivElement;
  private readonly weapons: HTMLDivElement;
  private readonly ids: (WeaponId | null)[] = [];
  private views: SlotView[] = [];
  private readonly throwable: HTMLDivElement;
  private readonly throwableName: Text;
  private readonly throwableCount: Text;
  private readonly cycleHint: HTMLElement;
  private readonly cycleAnim: Animation;
  private throwableShown = "";
  private throwableActive = false;

  constructor(parent: HTMLElement) {
    this.strip = el("div", "tb-slots", undefined, parent);
    this.weapons = el("div", "tb-slots__weapons", undefined, this.strip);
    this.throwable = el("div", "tb-slot tb-slot--throwable", undefined, this.strip);
    el("span", "tb-slot__key", THROWABLE_KEY, this.throwable);
    const label = el("span", "tb-slot__name", undefined, this.throwable);
    this.throwableName = textNode(label);
    this.throwableCount = textNode(el("span", "tb-slot__count", undefined, this.throwable));
    this.cycleHint = el("kbd", "tb-key tb-slot__hint", "G", this.throwable);
    this.throwable.hidden = true;
    this.cycleAnim = prepareAnimation(label, CYCLE_KEYFRAMES, { duration: 240 });
  }

  /** @param throwableInHand a throwable is drawn, so no weapon slot is active. */
  update(state: WeaponState, throwableInHand = false): void {
    this.sync(state);
    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i]!;
      const slot = state.slots[i];
      const active = !throwableInHand && slot !== null && i === state.activeIndex;
      const empty = slot !== null && slot !== undefined && slot.magazine + slot.reserve === 0;
      if (active !== view.active) {
        view.active = active;
        view.node.toggleAttribute("data-active", active);
      }
      if (empty !== view.empty) {
        view.empty = empty;
        view.node.toggleAttribute("data-empty", empty);
      }
    }
    if (throwableInHand !== this.throwableActive) {
      this.throwableActive = throwableInHand;
      this.throwable.toggleAttribute("data-active", throwableInHand);
    }
  }

  /**
   * Slot 5: the selected throwable and how many are carried (hidden when none). `kinds` is the number of carried
   * kinds; the G hint shows only when there is something to cycle to.
   */
  setThrowable(kind: ThrowableKind | null, count: number, kinds: number): void {
    const key = kind === null ? "" : `${kind}:${count}:${kinds > 1 ? 1 : 0}`;
    if (key === this.throwableShown) return;
    this.throwableShown = key;
    this.throwable.hidden = kind === null;
    if (kind === null) return;
    setText(this.throwableName, throwableShort(kind));
    setText(this.throwableCount, count > 1 ? ` ×${count}` : "");
    this.cycleHint.hidden = kinds < 2;
  }

  /** The language changed: rewrite the throwable name on the next update. */
  resetText(): void {
    this.throwableShown = "";
  }

  /** G cycled the selection. */
  cycled(): void {
    replay(this.cycleAnim);
  }

  /** Rebuilds the weapon slots only when the loadout itself changes. */
  private sync(state: WeaponState): void {
    const slots = state.slots;
    let same = slots.length === this.ids.length;
    for (let i = 0; same && i < slots.length; i++) same = (slots[i]?.id ?? null) === this.ids[i];
    if (same) return;

    this.weapons.replaceChildren();
    this.ids.length = 0;
    this.views = slots.map((slot, index) => {
      this.ids.push(slot?.id ?? null);
      const node = el("div", "tb-slot", undefined, this.weapons);
      el("span", "tb-slot__key", String(index + 1), node);
      el("span", "tb-slot__name", slot ? getWeaponDef(slot.id).name : "—", node);
      node.toggleAttribute("data-vacant", slot === null);
      return { node, active: false, empty: false };
    });
  }
}
