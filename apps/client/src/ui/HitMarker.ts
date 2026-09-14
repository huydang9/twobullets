import { prepareAnimation, replay } from "./anim";
import { el } from "./dom";

type MarkerKind = "hit" | "kill";

/** Hits right after a kill don't downgrade its marker (e.g. the rest of a shotgun blast). */
const KILL_PRIORITY_MS = 150;

const HIT_KEYFRAMES: Keyframe[] = [
  { opacity: 1, transform: "rotate(45deg) scale(1.12)", easing: "ease-out" },
  { opacity: 1, transform: "rotate(45deg) scale(1)", offset: 0.3, easing: "ease-in" },
  { opacity: 0, transform: "rotate(45deg) scale(1)" },
];

/** Small, thin X around the crosshair: white on hit, red on kill. Replays in place on rapid hits. */
export class HitMarker {
  private readonly node: HTMLDivElement;
  private readonly hit: Animation;
  private readonly kill: Animation;
  private kind: MarkerKind | undefined;
  private killedAt = -Infinity;

  constructor(parent: HTMLElement) {
    this.node = el("div", "tb-hitmarker", undefined, parent);
    const cross = el("div", "tb-hitmarker__cross", undefined, this.node);
    for (const side of ["l", "r", "t", "b"]) {
      el("div", `tb-hitmarker__arm tb-hitmarker__arm--${side}`, undefined, cross);
    }
    this.hit = prepareAnimation(cross, HIT_KEYFRAMES, { duration: 180 });
    this.kill = prepareAnimation(cross, HIT_KEYFRAMES, { duration: 380 });
  }

  /** @param now performance.now() timestamp, ms. */
  show(killed: boolean, now: number): void {
    if (!killed && now - this.killedAt < KILL_PRIORITY_MS) return;
    const kind: MarkerKind = killed ? "kill" : "hit";
    if (kind !== this.kind) {
      this.kind = kind;
      this.node.dataset.kind = kind;
    }
    if (killed) {
      this.killedAt = now;
      this.hit.cancel();
      replay(this.kill);
    } else {
      this.kill.cancel();
      replay(this.hit);
    }
  }
}
