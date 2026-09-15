import { prepareAnimation, replay, setText } from "../anim";
import { el, textNode } from "../dom";

const NOTICE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, easing: "ease-out" },
  { opacity: 1, offset: 0.06 },
  { opacity: 1, offset: 0.8, easing: "ease-in" },
  { opacity: 0 },
];
const DENIED_KEYFRAMES: Keyframe[] = [
  { transform: "none" },
  { transform: "translate3d(-3px,0,0)", offset: 0.25 },
  { transform: "translate3d(2px,0,0)", offset: 0.6 },
  { transform: "none" },
];

/**
 * "F  Nhặt AR-4" / "F  Hồi sinh" beside the crosshair, plus a short amber notice underneath for refused actions
 * ("Không đủ chỗ"). The prompt text is rewritten only when it changes.
 */
export class InteractionPrompt {
  private readonly prompt: HTMLDivElement;
  private readonly verb: Text;
  private readonly name: Text;
  private readonly notice: HTMLDivElement;
  private readonly noticeText: Text;
  private readonly noticeAnim: Animation;
  private readonly deniedAnim: Animation;
  private shown = "";

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-prompt", undefined, parent);
    this.prompt = el("div", "tb-prompt__line", undefined, root);
    el("kbd", "tb-key", "F", this.prompt);
    this.verb = textNode(el("span", "tb-prompt__verb", undefined, this.prompt));
    this.name = textNode(el("span", "tb-prompt__name", undefined, this.prompt));
    this.prompt.hidden = true;

    this.notice = el("div", "tb-prompt__notice", undefined, root);
    this.noticeText = textNode(this.notice);
    this.noticeAnim = prepareAnimation(this.notice, NOTICE_KEYFRAMES, { duration: 1800, fill: "forwards" });
    this.deniedAnim = prepareAnimation(this.prompt, DENIED_KEYFRAMES, { duration: 200 });
  }

  /**
   * @param verb translated "Pick up" | "Swap" | "Equip" | "Revive", or null to hide.
   * @param blocked F would fail right now (no space): the prompt is dimmed.
   */
  update(verb: string | null, name = "", blocked = false): void {
    const key = verb === null ? "" : `${verb}\n${name}\n${blocked}`;
    if (key === this.shown) return;
    this.shown = key;
    this.prompt.hidden = verb === null;
    if (verb === null) return;
    setText(this.verb, verb);
    setText(this.name, name);
    this.prompt.toggleAttribute("data-blocked", blocked);
  }

  refuse(message: string): void {
    setText(this.noticeText, message);
    replay(this.noticeAnim);
    if (!this.prompt.hidden) replay(this.deniedAnim);
  }
}
