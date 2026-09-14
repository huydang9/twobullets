import { killFeedLine, type MatchEvent } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "../anim";
import { el, textNode } from "../dom";

const POOL_SIZE = 6;
const LINE_MS = 7000;

const LINE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(6px,0,0)", easing: "ease-out" },
  { opacity: 1, transform: "none", offset: 0.03 },
  { opacity: 1, offset: 0.92, easing: "ease-in" },
  { opacity: 0 },
];

interface Line {
  readonly node: HTMLDivElement;
  readonly text: Text;
  readonly anim: Animation;
  bornAt: number;
}

/**
 * Match kill feed (design.md §8.4, §10): knocks, kills, bleed-outs, zone deaths and team eliminations for every actor.
 * Lines involving the viewer's team are brighter; knocks are lighter; team kills are marked. Fixed node pool.
 */
export class MatchFeed {
  private readonly root: HTMLDivElement;
  private readonly lines: Line[] = [];

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-feed tb-feed--match", undefined, parent);
    for (let i = 0; i < POOL_SIZE; i++) {
      const node = el("div", "tb-feed__line tb-mfeed__line", undefined, this.root);
      const text = textNode(node);
      node.hidden = true;
      const anim = prepareAnimation(node, LINE_KEYFRAMES, { duration: LINE_MS });
      anim.onfinish = () => (node.hidden = true);
      this.lines.push({ node, text, anim, bornAt: -Infinity });
    }
  }

  /** Adds the event's line, if it has one. `team(slot)` resolves teams for highlighting; `viewerTeam` may be null. */
  push(event: MatchEvent, nameOf: (slot: number) => string, team: (slot: number) => number, viewerTeam: number | null, now: number): void {
    const text = killFeedLine(event, nameOf);
    if (text === null) return;
    const line = this.acquire();
    setText(line.text, text);
    const node = line.node;
    node.toggleAttribute("data-knock", event.type === "knock");
    node.toggleAttribute("data-teamkill", event.type === "kill" && event.teamKill);
    let mine = false;
    let lost = false;
    if (viewerTeam !== null) {
      if (event.type === "kill" || event.type === "knock") {
        const attacker = event.type === "kill" ? event.killer : event.attacker;
        mine = attacker >= 0 && team(attacker) === viewerTeam;
        lost = team(event.victim) === viewerTeam;
      } else if (event.type === "teamEliminated") {
        lost = event.team === viewerTeam;
      }
    }
    node.toggleAttribute("data-mine", mine && !lost);
    node.toggleAttribute("data-lost", lost);
    line.bornAt = now;
    node.hidden = false;
    this.root.appendChild(node);
    replay(line.anim);
  }

  private acquire(): Line {
    let oldest = this.lines[0]!;
    for (const line of this.lines) {
      if (line.node.hidden) return line;
      if (line.bornAt < oldest.bornAt) oldest = line;
    }
    return oldest;
  }
}
