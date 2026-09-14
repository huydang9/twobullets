import { prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";
import { targetName } from "./format";
import type { KillInfo } from "./KillNotice";

const POOL_SIZE = 5;
const LINE_MS = 6000;

const LINE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(6px,0,0)", easing: "ease-out" },
  { opacity: 1, transform: "none", offset: 0.03 },
  { opacity: 1, offset: 0.92, easing: "ease-in" },
  { opacity: 0 },
];

interface FeedLine {
  readonly node: HTMLDivElement;
  readonly victim: Text;
  readonly weapon: Text;
  readonly headshot: HTMLSpanElement;
  readonly anim: Animation;
  bornAt: number;
}

/** Top-right kill feed ("You killed Dummy with AR-4 (Headshot)"). Fixed pool; the newest line is moved to the bottom. */
export class KillFeed {
  private readonly root: HTMLDivElement;
  private readonly lines: FeedLine[] = [];

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-feed", undefined, parent);
    for (let i = 0; i < POOL_SIZE; i++) {
      const node = el("div", "tb-feed__line", undefined, this.root);
      el("span", "tb-feed__you", "You", node);
      node.append(" killed ");
      const victim = textNode(el("span", "tb-feed__victim", undefined, node));
      node.append(" with ");
      const weapon = textNode(node);
      const headshot = el("span", "tb-feed__headshot", " (Headshot)", node);
      node.hidden = true;

      const anim = prepareAnimation(node, LINE_KEYFRAMES, { duration: LINE_MS });
      anim.onfinish = () => (node.hidden = true);
      this.lines.push({ node, victim, weapon, headshot, anim, bornAt: -Infinity });
    }
  }

  push(kill: KillInfo, now: number): void {
    const line = this.acquire();
    setText(line.victim, targetName(kill.targetId));
    setText(line.weapon, kill.weaponName);
    line.headshot.hidden = !kill.headshot;
    line.bornAt = now;
    line.node.hidden = false;
    this.root.appendChild(line.node);
    replay(line.anim);
  }

  /** A hidden line, or the oldest visible one when all are in use. */
  private acquire(): FeedLine {
    let oldest = this.lines[0]!;
    for (const line of this.lines) {
      if (line.node.hidden) return line;
      if (line.bornAt < oldest.bornAt) oldest = line;
    }
    return oldest;
  }
}
