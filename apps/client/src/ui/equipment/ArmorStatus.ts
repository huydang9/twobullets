import { armorCondition, type ArmorPiece, type ArmorSlot } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "../anim";
import { el, textNode } from "../dom";

/** How long a destroyed piece stays on screen (red, crossed out) before its slot empties. */
const DESTROYED_MS = 3000;
const LOW_CONDITION = 0.3;

const ICONS: Readonly<Record<ArmorSlot, string>> = {
  helmet: '<path d="M3 13.5C3 7.7 6.9 3.5 12 3.5s9 4.2 9 10v1.5H3z M1.5 15h21v2.5h-21z"/>',
  vest: '<path d="M8 2.5h2.2c.4 1.6 1 2.4 1.8 2.4s1.4-.8 1.8-2.4H16l4 3.5-1.6 4.2v11.3H5.6V10.2L4 6z"/>',
};

const HIT_KEYFRAMES: Keyframe[] = [
  { opacity: 0.35, transform: "scale(1.2)", easing: "ease-out" },
  { opacity: 1, transform: "none" },
];

type PieceState = "worn" | "empty" | "destroyed";
type Condition = "ok" | "low";

interface PieceView {
  readonly slot: ArmorSlot;
  readonly node: HTMLDivElement;
  readonly level: Text;
  readonly fill: HTMLDivElement;
  readonly hit: Animation;
  state: PieceState | undefined;
  shownLevel: number;
  shownPercent: number;
  condition: Condition | undefined;
  destroyedUntil: number;
}

/**
 * Helmet and vest indicators beside the health bar: icon, level and a thin durability bar. They flash when armor
 * absorbs a hit and show a crossed-out red state for a moment when a piece breaks.
 */
export class ArmorStatus {
  private readonly pieces: Readonly<Record<ArmorSlot, PieceView>>;

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-armor", undefined, parent);
    this.pieces = { helmet: this.piece(root, "helmet"), vest: this.piece(root, "vest") };
  }

  update(helmet: ArmorPiece | null, vest: ArmorPiece | null, now: number): void {
    this.sync(this.pieces.helmet, helmet, now);
    this.sync(this.pieces.vest, vest, now);
  }

  damaged(slot: ArmorSlot): void {
    replay(this.pieces[slot].hit);
  }

  destroyed(slot: ArmorSlot, level: number, now: number): void {
    const view = this.pieces[slot];
    view.destroyedUntil = now + DESTROYED_MS;
    this.setState(view, "destroyed");
    this.setLevel(view, level);
    this.setPercent(view, 0);
    replay(view.hit);
  }

  private sync(view: PieceView, piece: ArmorPiece | null, now: number): void {
    if (piece) {
      view.destroyedUntil = 0;
      this.setState(view, "worn");
      this.setLevel(view, piece.level);
      const condition = armorCondition(view.slot, piece);
      this.setPercent(view, Math.ceil(condition * 100));
      const tier: Condition = condition <= LOW_CONDITION ? "low" : "ok";
      if (tier !== view.condition) {
        view.condition = tier;
        view.node.dataset.condition = tier;
      }
      return;
    }
    if (view.state === "destroyed" && now < view.destroyedUntil) return;
    this.setState(view, "empty");
  }

  private setState(view: PieceView, state: PieceState): void {
    if (state === view.state) return;
    view.state = state;
    view.node.dataset.state = state;
    view.node.hidden = state === "empty";
  }

  private setLevel(view: PieceView, level: number): void {
    if (level === view.shownLevel) return;
    view.shownLevel = level;
    setText(view.level, level.toString());
  }

  private setPercent(view: PieceView, percent: number): void {
    if (percent === view.shownPercent) return;
    view.shownPercent = percent;
    view.fill.style.transform = `scaleX(${percent / 100})`;
  }

  private piece(parent: HTMLElement, slot: ArmorSlot): PieceView {
    const node = el("div", "tb-armor__piece", undefined, parent);
    const badge = el("div", "tb-armor__badge", undefined, node);
    badge.insertAdjacentHTML("beforeend", `<svg class="tb-armor__icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[slot]}</svg>`);
    const level = textNode(el("span", "tb-armor__level", undefined, badge));
    const bar = el("div", "tb-armor__bar", undefined, node);
    const fill = el("div", "tb-armor__fill", undefined, bar);
    node.hidden = true;
    const hit = prepareAnimation(badge, HIT_KEYFRAMES, { duration: 260 });
    return { slot, node, level, fill, hit, state: undefined, shownLevel: -1, shownPercent: -1, condition: undefined, destroyedUntil: 0 };
  }
}
