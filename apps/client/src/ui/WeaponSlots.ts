import { getWeaponDef, type WeaponId, type WeaponState } from "@twobullets/shared";
import { el } from "./dom";

interface SlotView {
  readonly node: HTMLDivElement;
  active: boolean;
  empty: boolean;
}

/** Compact 1–4 weapon strip; the active slot is outlined, slots with no ammo at all are dimmed. */
export class WeaponSlots {
  private readonly strip: HTMLDivElement;
  private readonly ids: WeaponId[] = [];
  private views: SlotView[] = [];

  constructor(parent: HTMLElement) {
    this.strip = el("div", "tb-slots", undefined, parent);
  }

  update(state: WeaponState): void {
    this.sync(state);
    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i]!;
      const slot = state.slots[i]!;
      const active = i === state.activeIndex;
      const empty = slot.magazine + slot.reserve === 0;
      if (active !== view.active) {
        view.active = active;
        view.node.toggleAttribute("data-active", active);
      }
      if (empty !== view.empty) {
        view.empty = empty;
        view.node.toggleAttribute("data-empty", empty);
      }
    }
  }

  /** Rebuilds the strip only when the loadout itself changes. */
  private sync(state: WeaponState): void {
    const slots = state.slots;
    let same = slots.length === this.ids.length;
    for (let i = 0; same && i < slots.length; i++) same = slots[i]!.id === this.ids[i];
    if (same) return;

    this.strip.replaceChildren();
    this.ids.length = 0;
    this.views = slots.map((slot) => {
      const def = getWeaponDef(slot.id);
      this.ids.push(slot.id);
      const node = el("div", "tb-slot", undefined, this.strip);
      el("span", "tb-slot__key", def.slot.toString(), node);
      el("span", "tb-slot__name", def.name, node);
      return { node, active: false, empty: false };
    });
  }
}
