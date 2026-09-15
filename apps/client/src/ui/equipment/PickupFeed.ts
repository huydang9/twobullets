import type { ItemId, ItemInstance } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "../anim";
import { el, textNode } from "../dom";
import { pickupLabel } from "./labels";

const POOL_SIZE = 5;
const LINE_MS = 3200;
/** A pickup of the same item within this window adds to the newest line instead of pushing a new one. */
const MERGE_MS = 1500;

const LINE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(8px,0,0)", easing: "ease-out" },
  { opacity: 1, transform: "none", offset: 0.06 },
  { opacity: 1, offset: 0.85, easing: "ease-in" },
  { opacity: 0 },
];

interface FeedLine {
  readonly node: HTMLDivElement;
  readonly text: Text;
  readonly anim: Animation;
  itemId: ItemId | null;
  taken: number;
  bornAt: number;
}

/** Right-side pickup feed ("+ 60 5.56mm", "+ Băng gạc ×5"). Fixed pool; the newest line goes to the bottom. */
export class PickupFeed {
  private readonly root: HTMLDivElement;
  private readonly lines: FeedLine[] = [];
  private newest: FeedLine | null = null;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-pickups", undefined, parent);
    for (let i = 0; i < POOL_SIZE; i++) {
      const node = el("div", "tb-pickups__line", undefined, this.root);
      el("span", "tb-pickups__plus", "+", node);
      const text = textNode(node);
      node.hidden = true;
      const anim = prepareAnimation(node, LINE_KEYFRAMES, { duration: LINE_MS });
      anim.onfinish = () => (node.hidden = true);
      this.lines.push({ node, text, anim, itemId: null, taken: 0, bornAt: -Infinity });
    }
  }

  push(item: ItemInstance, taken: number, now: number): void {
    const newest = this.newest;
    let line: FeedLine;
    if (newest && !newest.node.hidden && newest.itemId === item.itemId && now - newest.bornAt < MERGE_MS) {
      line = newest;
      line.taken += taken;
    } else {
      line = this.acquire();
      line.itemId = item.itemId;
      line.taken = taken;
      line.node.hidden = false;
      this.root.appendChild(line.node);
    }
    line.bornAt = now;
    setText(line.text, ` ${pickupLabel(item, line.taken)}`);
    this.newest = line;
    replay(line.anim);
  }

  private acquire(): FeedLine {
    let oldest = this.lines[0]!;
    for (const line of this.lines) {
      if (line.node.hidden) return line;
      if (line.bornAt < oldest.bornAt) oldest = line;
    }
    return oldest;
  }
}
