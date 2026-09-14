import { prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";

const SHOW_KEYFRAMES: Keyframe[] = [
  { transform: "translate3d(0,14px,0) scale(1.35)", opacity: 0, easing: "cubic-bezier(.2,1.5,.4,1)" },
  { transform: "none", opacity: 1, offset: 0.1 },
  { transform: "none", opacity: 1, offset: 0.82, easing: "ease-in" },
  { transform: "translate3d(0,-6px,0)", opacity: 0 },
];
const STRIPE_KEYFRAMES: Keyframe[] = [
  { transform: "scaleX(0)", easing: "cubic-bezier(.2,.8,.2,1)" },
  { transform: "scaleX(1)", offset: 0.25 },
  { transform: "scaleX(1)" },
];

const HEADSHOT_ICON =
  '<svg class="tb-killnotice__icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="10" r="6.5"/><path d="M8 20.5c1-2.4 7-2.4 8 0"/>' +
  '<path class="tb-killnotice__icon-aim" d="M12 0.5v5M12 14.5v5M1.5 10h5M17.5 10h5"/></svg>';

export interface KillInfo {
  readonly targetId: string;
  readonly headshot: boolean;
  readonly weaponName: string;
  readonly distance: number;
}

/** Center-lower "ELIMINATED <TARGET>" banner; one reused element replayed per kill. */
export class KillNotice {
  private readonly card: HTMLDivElement;
  private readonly name: Text;
  private readonly meta: Text;
  private readonly show: Animation;
  private readonly stripe: Animation;

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-killnotice", undefined, parent);
    this.card = el("div", "tb-killnotice__card", undefined, root);
    const stripe = el("div", "tb-killnotice__stripe", undefined, this.card);
    this.card.insertAdjacentHTML("beforeend", HEADSHOT_ICON);
    const text = el("div", "tb-killnotice__text", undefined, this.card);
    const title = el("div", "tb-killnotice__title", "ELIMINATED ", text);
    this.name = textNode(el("span", "tb-killnotice__name", undefined, title));
    this.meta = textNode(el("div", "tb-killnotice__meta", undefined, text));

    this.show = prepareAnimation(this.card, SHOW_KEYFRAMES, { duration: 1800 });
    this.stripe = prepareAnimation(stripe, STRIPE_KEYFRAMES, { duration: 1800 });
  }

  notify(kill: KillInfo): void {
    this.card.toggleAttribute("data-headshot", kill.headshot);
    setText(this.name, targetLabel(kill.targetId));
    const detail = `${kill.weaponName} · ${Math.round(kill.distance)} M`;
    setText(this.meta, kill.headshot ? `HEADSHOT · ${detail}` : detail);
    replay(this.show);
    replay(this.stripe);
  }
}

/** "dummy-3" / "target_dummy#12" → "DUMMY" / "TARGET DUMMY". */
function targetLabel(targetId: string): string {
  const label = targetId
    .replace(/[-_#:.]*\d+$/, "")
    .replace(/[-_#:.]+/g, " ")
    .trim()
    .toUpperCase();
  return label || "TARGET";
}
