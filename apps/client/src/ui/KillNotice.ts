import { getLanguage, renderTemplate, t } from "../i18n";
import { prepareAnimation, replay, setText } from "./anim";
import { el, elT, textNode } from "./dom";
import { targetName } from "./format";

const SHOW_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(0,4px,0)", easing: "ease-out" },
  { opacity: 1, transform: "none", offset: 0.07 },
  { opacity: 1, offset: 0.82, easing: "ease-in" },
  { opacity: 0 },
];

export interface KillInfo {
  readonly targetId: string;
  /** Display name used as is (a player's nickname, "Bot 3"); else formatted from `targetId`. */
  readonly name?: string;
  readonly headshot: boolean;
  readonly weaponName: string;
  readonly distance: number;
}

/** Brief centre-bottom "BẠN ĐÃ HẠ GỤC DUMMY" line with weapon / distance / kill count; one element replayed per kill. */
export class KillNotice {
  private readonly card: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly nameNode: HTMLSpanElement;
  private readonly name: Text;
  private readonly weapon: Text;
  private readonly distance: Text;
  private readonly count: Text;
  private readonly show: Animation;
  private kills = 0;

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-killnotice", undefined, parent);
    this.card = el("div", "tb-killnotice__card", undefined, root);
    this.title = el("div", "tb-killnotice__title", undefined, this.card);
    this.nameNode = el("span", "tb-killnotice__name");
    this.name = textNode(this.nameNode);

    const meta = el("div", "tb-killnotice__meta", undefined, this.card);
    elT("span", "tb-killnotice__headshot", "killNotice.headshot", meta);
    this.weapon = textNode(el("span", "tb-killnotice__weapon", undefined, meta));
    this.distance = textNode(el("span", "tb-killnotice__distance", undefined, meta));
    this.count = textNode(el("span", "tb-killnotice__count", undefined, meta));

    this.show = prepareAnimation(this.card, SHOW_KEYFRAMES, { duration: 2600 });
    this.resetText();
  }

  /** Lays the title out for the current language (the name node is kept). */
  resetText(): void {
    renderTemplate(this.title, t("killNotice.youKilled"), { name: this.nameNode });
  }

  notify(kill: KillInfo): void {
    this.kills++;
    const locale = getLanguage();
    this.card.toggleAttribute("data-headshot", kill.headshot);
    setText(this.name, (kill.name ?? targetName(kill.targetId)).toLocaleUpperCase(locale));
    setText(this.weapon, kill.weaponName.toLocaleUpperCase(locale));
    setText(this.distance, t("killNotice.distance", { m: Math.round(kill.distance) }));
    setText(this.count, t("killNotice.kills", { count: this.kills }));
    replay(this.show);
  }
}
