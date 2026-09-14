import { prepareAnimation, replay, setText } from "../anim";
import { el, textNode } from "../dom";
import { ProgressRing } from "./ProgressRing";

const MESSAGE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(-50%,2px,0)", easing: "ease-out" },
  { opacity: 1, transform: "translate3d(-50%,0,0)", offset: 0.08 },
  { opacity: 1, offset: 0.75, easing: "ease-in" },
  { opacity: 0, transform: "translate3d(-50%,0,0)" },
];

export type UseTone = "item" | "revive";

/**
 * Centre progress ring for timed actions (healing, boosting, being revived): the ring fills, the label names the
 * action and the time left counts down underneath. A short message replaces it when an action is cancelled.
 */
export class UseIndicator {
  private readonly root: HTMLDivElement;
  private readonly ring: ProgressRing;
  private readonly label: Text;
  private readonly seconds: Text;
  private readonly message: HTMLDivElement;
  private readonly messageText: Text;
  private readonly messageAnim: Animation;
  private active = false;
  private tone: UseTone | undefined;
  private tenths = -1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-use", undefined, parent);
    this.ring = new ProgressRing(this.root, "tb-use__ring", 34, 2);
    const text = el("div", "tb-use__text", undefined, this.root);
    this.label = textNode(el("div", "tb-use__label", undefined, text));
    this.seconds = textNode(el("div", "tb-use__seconds", undefined, text));
    this.root.hidden = true;

    this.message = el("div", "tb-use__message", undefined, parent);
    this.messageText = textNode(this.message);
    this.messageAnim = prepareAnimation(this.message, MESSAGE_KEYFRAMES, { duration: 1400, fill: "forwards" });
  }

  /** @param progress 0..1 while an action runs, null to hide. */
  update(progress: number | null, label: string, secondsLeft: number, tone: UseTone = "item"): void {
    const active = progress !== null;
    if (active !== this.active) {
      this.active = active;
      this.root.hidden = !active;
      this.tenths = -1;
      if (active) this.messageAnim.cancel();
    }
    if (progress === null) return;
    if (tone !== this.tone) {
      this.tone = tone;
      this.root.dataset.tone = tone;
    }
    this.ring.set(progress);
    setText(this.label, label);
    const tenths = Math.max(0, Math.ceil(secondsLeft * 10));
    if (tenths !== this.tenths) {
      this.tenths = tenths;
      setText(this.seconds, (tenths / 10).toFixed(1));
    }
  }

  /** Brief text in place of the ring ("CANCELLED · SPRINTING"). */
  flash(message: string): void {
    setText(this.messageText, message);
    replay(this.messageAnim);
  }
}
