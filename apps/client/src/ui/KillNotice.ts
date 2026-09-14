import { prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";
import { targetName } from "./format";

const SHOW_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(0,4px,0)", easing: "ease-out" },
  { opacity: 1, transform: "none", offset: 0.07 },
  { opacity: 1, offset: 0.82, easing: "ease-in" },
  { opacity: 0 },
];

export interface KillInfo {
  readonly targetId: string;
  readonly headshot: boolean;
  readonly weaponName: string;
  readonly distance: number;
}

/** Brief centre-bottom "YOU KILLED DUMMY" line with weapon / distance / kill count; one element replayed per kill. */
export class KillNotice {
  private readonly card: HTMLDivElement;
  private readonly name: Text;
  private readonly weapon: Text;
  private readonly distance: Text;
  private readonly count: Text;
  private readonly show: Animation;
  private kills = 0;

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-killnotice", undefined, parent);
    this.card = el("div", "tb-killnotice__card", undefined, root);
    const title = el("div", "tb-killnotice__title", "YOU KILLED ", this.card);
    this.name = textNode(el("span", "tb-killnotice__name", undefined, title));

    const meta = el("div", "tb-killnotice__meta", undefined, this.card);
    el("span", "tb-killnotice__headshot", "HEADSHOT", meta);
    this.weapon = textNode(el("span", "tb-killnotice__weapon", undefined, meta));
    this.distance = textNode(el("span", "tb-killnotice__distance", undefined, meta));
    this.count = textNode(el("span", "tb-killnotice__count", undefined, meta));

    this.show = prepareAnimation(this.card, SHOW_KEYFRAMES, { duration: 2600 });
  }

  notify(kill: KillInfo): void {
    this.kills++;
    this.card.toggleAttribute("data-headshot", kill.headshot);
    setText(this.name, targetName(kill.targetId).toUpperCase());
    setText(this.weapon, kill.weaponName.toUpperCase());
    setText(this.distance, `${Math.round(kill.distance)} M`);
    setText(this.count, this.kills === 1 ? "1 KILL" : `${this.kills} KILLS`);
    replay(this.show);
  }
}
