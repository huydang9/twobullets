import { setText } from "../anim";
import { el, textNode } from "../dom";
import { ProgressRing } from "./ProgressRing";

/** Fuse left (s) where the ring turns amber, then red and blinking (explode-in-hand is close). */
const WARN_SECONDS = 2;
const DANGER_SECONDS = 1;

type FuseLevel = "ok" | "warn" | "danger";

/** Circular fuse timer around the crosshair while a frag is cooked: the arc drains as the fuse burns. */
export class CookIndicator {
  private readonly root: HTMLDivElement;
  private readonly ring: ProgressRing;
  private readonly seconds: Text;
  private active = false;
  private level: FuseLevel | undefined;
  private tenths = -1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-cook", undefined, parent);
    this.ring = new ProgressRing(this.root, "tb-cook__ring", 26, 2);
    this.seconds = textNode(el("div", "tb-cook__seconds", undefined, this.root));
    this.root.hidden = true;
  }

  /** @param fuseRemaining seconds left on a cooked fuse, or null when not cooking. */
  update(fuseRemaining: number | null, cookProgress: number): void {
    const active = fuseRemaining !== null;
    if (active !== this.active) {
      this.active = active;
      this.root.hidden = !active;
      this.tenths = -1;
    }
    if (fuseRemaining === null) return;

    this.ring.set(1 - cookProgress);
    const level: FuseLevel = fuseRemaining <= DANGER_SECONDS ? "danger" : fuseRemaining <= WARN_SECONDS ? "warn" : "ok";
    if (level !== this.level) {
      this.level = level;
      this.root.dataset.level = level;
    }
    const tenths = Math.max(0, Math.ceil(fuseRemaining * 10));
    if (tenths !== this.tenths) {
      this.tenths = tenths;
      setText(this.seconds, (tenths / 10).toFixed(1));
    }
  }
}
