import type { FireMode, WeaponDef, WeaponPhase, WeaponSlotState } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";
import { FIRE_MODE_LABEL } from "./format";

/** Magazine at or below this fraction counts as low (amber count + reload hint). */
const LOW_AMMO_FRACTION = 0.25;

type AmmoLevel = "ok" | "low" | "empty";
type Hint = "none" | "reload" | "noammo";

const EQUIP_KEYFRAMES: Keyframe[] = [
  { opacity: 0.35, transform: "translate3d(0,3px,0)", easing: "ease-out" },
  { opacity: 1, transform: "none" },
];
const RELOADED_KEYFRAMES: Keyframe[] = [{ opacity: 0.4, easing: "ease-out" }, { opacity: 1 }];
const DRY_KEYFRAMES: Keyframe[] = [
  { transform: "none" },
  { transform: "translate3d(-3px,0,0)", offset: 0.25 },
  { transform: "translate3d(2px,0,0)", offset: 0.6 },
  { transform: "none" },
];

/** Magazine | reserve readout with weapon name, fire mode and a subtle reload / no-ammo hint. */
export class AmmoPanel {
  private readonly root: HTMLDivElement;
  private readonly counts: HTMLDivElement;
  private readonly name: Text;
  private readonly fireMode: Text;
  private readonly magazine: Text;
  private readonly reserve: Text;
  private readonly hints: Readonly<Record<Exclude<Hint, "none">, HTMLDivElement>>;
  private readonly equipAnim: Animation;
  private readonly reloadedAnim: Animation;
  private readonly dryAnim: Animation;

  private shownMagazine = -1;
  private shownReserve = -1;
  private shownMode: FireMode | undefined;
  private level: AmmoLevel | undefined;
  private hint: Hint = "none";
  private phase: WeaponPhase | undefined;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-ammo", undefined, parent);

    const hintRow = el("div", "tb-ammo__hints", undefined, this.root);
    const reload = el("div", "tb-ammo__hint", undefined, hintRow);
    el("kbd", "tb-key", "R", reload);
    el("span", "", "RELOAD", reload);
    this.hints = { reload, noammo: el("div", "tb-ammo__hint tb-ammo__hint--noammo", "NO AMMO", hintRow) };
    for (const node of Object.values(this.hints)) node.hidden = true;

    this.counts = el("div", "tb-ammo__counts", undefined, this.root);
    this.magazine = textNode(el("span", "tb-ammo__mag", undefined, this.counts));
    el("span", "tb-ammo__divider", undefined, this.counts);
    this.reserve = textNode(el("span", "tb-ammo__reserve", undefined, this.counts));

    const meta = el("div", "tb-ammo__meta", undefined, this.root);
    this.name = textNode(el("span", "tb-ammo__name", undefined, meta));
    this.fireMode = textNode(el("span", "tb-ammo__mode", undefined, meta));

    this.equipAnim = prepareAnimation(this.root, EQUIP_KEYFRAMES, { duration: 220 });
    this.reloadedAnim = prepareAnimation(this.counts, RELOADED_KEYFRAMES, { duration: 200 });
    this.dryAnim = prepareAnimation(this.counts, DRY_KEYFRAMES, { duration: 200 });
  }

  /** Hidden while unarmed (every weapon slot empty). */
  set visible(visible: boolean) {
    if (this.root.hidden === visible) this.root.hidden = !visible;
  }

  update(slot: WeaponSlotState, weapon: WeaponDef, phase: WeaponPhase): void {
    setText(this.name, weapon.name);
    if (weapon.fireMode !== this.shownMode) {
      this.shownMode = weapon.fireMode;
      setText(this.fireMode, FIRE_MODE_LABEL[weapon.fireMode]);
    }
    if (slot.magazine !== this.shownMagazine) {
      this.shownMagazine = slot.magazine;
      setText(this.magazine, slot.magazine.toString());
    }
    if (slot.reserve !== this.shownReserve) {
      this.shownReserve = slot.reserve;
      setText(this.reserve, slot.reserve.toString());
    }

    const low = slot.magazine <= Math.ceil(weapon.magazineSize * LOW_AMMO_FRACTION);
    const level: AmmoLevel = slot.magazine === 0 ? "empty" : low ? "low" : "ok";
    if (level !== this.level) {
      this.level = level;
      this.counts.dataset.level = level;
    }

    const hint: Hint =
      phase === "reloading"
        ? "none" // The reload ring near the crosshair takes over.
        : slot.magazine === 0 && slot.reserve === 0
          ? "noammo"
          : low && slot.reserve > 0
            ? "reload"
            : "none";
    if (hint !== this.hint) {
      if (this.hint !== "none") this.hints[this.hint].hidden = true;
      if (hint !== "none") this.hints[hint].hidden = false;
      this.hint = hint;
    }

    if (phase !== this.phase) {
      this.phase = phase;
      this.root.dataset.phase = phase;
    }
  }

  onEquip(): void {
    replay(this.equipAnim);
  }

  onReloadFinished(): void {
    this.dryAnim.cancel();
    replay(this.reloadedAnim);
  }

  onDryFire(): void {
    this.reloadedAnim.cancel();
    replay(this.dryAnim);
  }
}
