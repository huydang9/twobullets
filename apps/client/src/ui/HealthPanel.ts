import { clamp01, prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";

type HealthTier = "high" | "mid" | "low";

const FLASH_KEYFRAMES: Keyframe[] = [{ opacity: 1, easing: "ease-out" }, { opacity: 0 }];
const SHAKE_KEYFRAMES: Keyframe[] = [
  { transform: "translate3d(-5px,2px,0) scale(1.12)" },
  { transform: "translate3d(4px,-1px,0)", offset: 0.3 },
  { transform: "translate3d(-2px,0,0)", offset: 0.6 },
  { transform: "none" },
];

/**
 * Bottom-left skewed health bar with number. Colour tier changes at 50% / 25%; a drop flashes the panel and
 * screen edges while a trailing "ghost" bar eases down behind the fill (CSS transition with a delay).
 */
export class HealthPanel {
  private readonly root: HTMLDivElement;
  private readonly value: Text;
  private readonly valueNode: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private readonly trail: HTMLDivElement;
  private readonly flashAnim: Animation;
  private readonly shakeAnim: Animation;
  private readonly hurtAnim: Animation;
  private health = Number.NaN;
  private tier: HealthTier | undefined;

  /** @param hurtOverlay full-screen element flashed when health drops. */
  constructor(parent: HTMLElement, hurtOverlay: HTMLElement) {
    this.root = el("div", "tb-health", undefined, parent);
    this.valueNode = el("span", "tb-health__value", undefined, this.root);
    this.value = textNode(this.valueNode);
    const column = el("div", "tb-health__column", undefined, this.root);
    el("div", "tb-health__label", "HEALTH", column);
    const bar = el("div", "tb-health__bar", undefined, column);
    this.trail = el("div", "tb-health__trail", undefined, bar);
    this.fill = el("div", "tb-health__fill", undefined, bar);
    el("div", "tb-health__ticks", undefined, bar);
    const flash = el("div", "tb-health__flash", undefined, this.root);

    this.flashAnim = prepareAnimation(flash, FLASH_KEYFRAMES, { duration: 360 });
    this.shakeAnim = prepareAnimation(this.valueNode, SHAKE_KEYFRAMES, { duration: 280 });
    this.hurtAnim = prepareAnimation(hurtOverlay, FLASH_KEYFRAMES, { duration: 520 });
  }

  update(health: number, maxHealth: number): void {
    if (health === this.health) return;
    const dropped = health < this.health;
    this.health = health;

    const fraction = maxHealth > 0 ? clamp01(health / maxHealth) : 0;
    setText(this.value, Math.max(0, Math.ceil(health)).toString());
    this.fill.style.transform = `scaleX(${fraction})`;
    this.trail.style.transform = `scaleX(${fraction})`;
    // Healing shouldn't show a lagging ghost bar.
    this.trail.classList.toggle("tb-health__trail--instant", !dropped);

    const tier: HealthTier = fraction > 0.5 ? "high" : fraction > 0.25 ? "mid" : "low";
    if (tier !== this.tier) {
      this.tier = tier;
      this.root.dataset.tier = tier;
    }

    if (dropped) {
      replay(this.flashAnim);
      replay(this.shakeAnim);
      replay(this.hurtAnim);
    }
  }
}
