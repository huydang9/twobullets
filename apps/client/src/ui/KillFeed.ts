import { renderTemplate, t } from "../i18n";
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
  readonly you: HTMLSpanElement;
  readonly victim: Text;
  readonly victimNode: HTMLSpanElement;
  readonly weapon: Text;
  readonly headshot: HTMLSpanElement;
  readonly anim: Animation;
  bornAt: number;
}

/** Top-right kill feed ("Bạn đã hạ gục Dummy bằng AR-4 (Headshot)"). Fixed pool; the newest line is moved to the bottom. */
export class KillFeed {
  private readonly root: HTMLDivElement;
  private readonly lines: FeedLine[] = [];

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-feed", undefined, parent);
    for (let i = 0; i < POOL_SIZE; i++) {
      const node = el("div", "tb-feed__line", undefined, this.root);
      const you = el("span", "tb-feed__you");
      const victimNode = el("span", "tb-feed__victim");
      const victim = textNode(victimNode);
      const weapon = document.createTextNode("");
      const headshot = el("span", "tb-feed__headshot");
      node.hidden = true;

      const anim = prepareAnimation(node, LINE_KEYFRAMES, { duration: LINE_MS });
      anim.onfinish = () => (node.hidden = true);
      this.lines.push({ node, you, victim, victimNode, weapon, headshot, anim, bornAt: -Infinity });
    }
    this.resetText();
  }

  /** Lays the lines out for the current language (the name and weapon nodes are kept). */
  resetText(): void {
    const template = t("feed.localKill");
    for (const line of this.lines) {
      line.you.textContent = t("common.you");
      line.headshot.textContent = t("feed.headshot");
      renderTemplate(line.node, template, { you: line.you, victim: line.victimNode, weapon: line.weapon, headshot: line.headshot });
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
