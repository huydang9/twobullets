import { clamp01, prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";

type HealthTier = "ok" | "low" | "critical";

const LOW_FRACTION = 0.3;
const CRITICAL_FRACTION = 0.12;
const BOOST_SEGMENTS = 4;

const HURT_KEYFRAMES: Keyframe[] = [{ opacity: 1, easing: "ease-out" }, { opacity: 0 }];

/**
 * Bottom-centre thin health bar. White fill that turns red when low; a pale trail eases down behind the fill after
 * damage (CSS transition with a delay). A persistent edge vignette pulses while health is low.
 */
export class HealthPanel {
  private readonly root: HTMLDivElement;
  private readonly value: Text;
  private readonly fill: HTMLDivElement;
  private readonly trail: HTMLDivElement;
  private readonly lowVignette: HTMLDivElement;
  private readonly hurtAnim: Animation;
  private health = Number.NaN;
  private tier: HealthTier | undefined;

  /** @param vignetteParent full-screen layer that receives the hurt flash and low-health vignette. */
  constructor(parent: HTMLElement, vignetteParent: HTMLElement) {
    this.root = el("div", "tb-health", undefined, parent);
    // Boost/energy placeholder (segmented, PUBG-style); hidden until boosts exist.
    const boost = el("div", "tb-boost", undefined, this.root);
    for (let i = 0; i < BOOST_SEGMENTS; i++) el("div", "tb-boost__segment", undefined, boost);
    boost.hidden = true;

    const bar = el("div", "tb-health__bar", undefined, this.root);
    this.trail = el("div", "tb-health__trail", undefined, bar);
    this.fill = el("div", "tb-health__fill", undefined, bar);
    this.value = textNode(el("span", "tb-health__value", undefined, bar));

    const hurt = el("div", "tb-vignette tb-vignette--hurt", undefined, vignetteParent);
    this.lowVignette = el("div", "tb-vignette tb-vignette--low", undefined, vignetteParent);
    this.hurtAnim = prepareAnimation(hurt, HURT_KEYFRAMES, { duration: 420 });
  }

  update(health: number, maxHealth: number): void {
    if (health === this.health) return;
    const dropped = health < this.health;
    this.health = health;

    const fraction = maxHealth > 0 ? clamp01(health / maxHealth) : 0;
    setText(this.value, Math.max(0, Math.ceil(health)).toString());
    this.fill.style.transform = `scaleX(${fraction})`;
    this.trail.style.transform = `scaleX(${fraction})`;
    // Healing shouldn't show a lagging trail.
    this.trail.classList.toggle("tb-health__trail--instant", !dropped);

    const tier: HealthTier = fraction > LOW_FRACTION ? "ok" : fraction > CRITICAL_FRACTION ? "low" : "critical";
    if (tier !== this.tier) {
      this.tier = tier;
      this.root.dataset.tier = tier;
      this.lowVignette.dataset.tier = tier;
    }

    if (dropped) replay(this.hurtAnim);
  }
}
