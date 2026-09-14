import type { HitZone } from "@twobullets/shared";
import { prepareAnimation, replay } from "./anim";
import { el } from "./dom";

type MarkerKind = "body" | "head" | "kill";

const RANK: Readonly<Record<MarkerKind, number>> = { body: 0, head: 1, kill: 2 };
/** Weaker hits this soon after a stronger one don't downgrade its marker (e.g. the rest of a shotgun blast). */
const PRIORITY_MS = 120;

const FADE_KEYFRAMES: Keyframe[] = [{ opacity: 1 }, { opacity: 1, offset: 0.35, easing: "ease-in" }, { opacity: 0 }];
const POP_KEYFRAMES: Keyframe[] = [
  { transform: "rotate(45deg) scale(1.35)", easing: "ease-out" },
  { transform: "rotate(45deg) scale(1)" },
];
const PUNCH_KEYFRAMES: Keyframe[] = [
  { transform: "rotate(45deg) scale(0.6)", easing: "cubic-bezier(.2,2,.4,1)" },
  { transform: "rotate(45deg) scale(1)" },
];

/** X-shaped hit confirmation around the crosshair. Replays in place on rapid hits. */
export class HitMarker {
  private readonly node: HTMLDivElement;
  private readonly fade: Animation;
  private readonly killFade: Animation;
  private readonly pop: Animation;
  private readonly punch: Animation;
  private kind: MarkerKind | undefined;
  private shownAt = -Infinity;

  constructor(parent: HTMLElement) {
    this.node = el("div", "tb-hitmarker", undefined, parent);
    const cross = el("div", "tb-hitmarker__cross", undefined, this.node);
    for (const side of ["l", "r", "t", "b"]) {
      el("div", `tb-hitmarker__arm tb-hitmarker__arm--${side}`, undefined, cross);
    }

    this.fade = prepareAnimation(this.node, FADE_KEYFRAMES, { duration: 260 });
    this.killFade = prepareAnimation(this.node, FADE_KEYFRAMES, { duration: 520 });
    this.pop = prepareAnimation(cross, POP_KEYFRAMES, { duration: 110 });
    this.punch = prepareAnimation(cross, PUNCH_KEYFRAMES, { duration: 260 });
  }

  /** @param now performance.now() timestamp, ms. */
  show(zone: HitZone, killed: boolean, now: number): void {
    const kind: MarkerKind = killed ? "kill" : zone === "head" ? "head" : "body";
    if (this.kind && RANK[kind] < RANK[this.kind] && now - this.shownAt < PRIORITY_MS) return;
    this.shownAt = now;
    if (kind !== this.kind) {
      this.kind = kind;
      this.node.dataset.kind = kind;
    }
    if (killed) {
      play(this.killFade, this.fade);
      play(this.punch, this.pop);
    } else {
      play(this.fade, this.killFade);
      play(this.pop, this.punch);
    }
  }
}

/** Starts `animation` from the top, cancelling its sibling that drives the same property. */
function play(animation: Animation, sibling: Animation): void {
  sibling.cancel();
  replay(animation);
}
