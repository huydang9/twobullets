import { VITALS } from "@twobullets/shared";
import { clamp01, prepareAnimation, replay, setText } from "./anim";
import { el, textNode } from "./dom";

type HealthTier = "ok" | "low" | "critical";

const LOW_FRACTION = 0.3;
const CRITICAL_FRACTION = 0.12;

const HURT_KEYFRAMES: Keyframe[] = [{ opacity: 1, easing: "ease-out" }, { opacity: 0 }];
const PULSE_KEYFRAMES: Keyframe[] = [{ opacity: 0.35, easing: "ease-out" }, { opacity: 1 }];

interface BoostSegment {
  readonly fill: HTMLDivElement;
  /** Boost range this segment covers. */
  readonly from: number;
  readonly to: number;
  shown: number;
}

/**
 * Bottom-centre thin health bar. White fill that turns red when low; a pale trail eases down behind the fill after
 * damage (CSS transition with a delay). A persistent edge vignette pulses while health is low. Above it, the PUBG
 * boost bar: four segments sized to the boost heal tiers. While knocked the bar becomes the red bleed-out pool.
 */
export class HealthPanel {
  private readonly root: HTMLDivElement;
  private readonly value: Text;
  private readonly fill: HTMLDivElement;
  private readonly trail: HTMLDivElement;
  private readonly boost: HTMLDivElement;
  private readonly segments: BoostSegment[] = [];
  private readonly lowVignette: HTMLDivElement;
  private readonly hurtAnim: Animation;
  private readonly boostPulse: Animation;
  private health = Number.NaN;
  private tier: HealthTier | undefined;
  private downed = false;

  /** @param vignetteParent full-screen layer that receives the hurt flash and low-health vignette. */
  constructor(parent: HTMLElement, vignetteParent: HTMLElement) {
    this.root = el("div", "tb-health", undefined, parent);
    el("div", "tb-health__knocked", "KNOCKED", this.root);

    // Segment widths follow the tiers (0–20, 20–60, 60–90, 90–100), so a segment filling up is a tier reached.
    this.boost = el("div", "tb-boost", undefined, this.root);
    const tiers = VITALS.boost.tiers;
    tiers.forEach((tier, i) => {
      const to = tiers[i + 1]?.above ?? VITALS.maxBoost;
      const segment = el("div", "tb-boost__segment", undefined, this.boost);
      segment.style.flexGrow = String(to - tier.above);
      this.segments.push({ fill: el("div", "tb-boost__fill", undefined, segment), from: tier.above, to, shown: -1 });
    });
    this.boost.hidden = true;
    this.boostPulse = prepareAnimation(this.boost, PULSE_KEYFRAMES, { duration: 500 });

    const bar = el("div", "tb-health__bar", undefined, this.root);
    this.trail = el("div", "tb-health__trail", undefined, bar);
    this.fill = el("div", "tb-health__fill", undefined, bar);
    this.value = textNode(el("span", "tb-health__value", undefined, bar));

    const hurt = el("div", "tb-vignette tb-vignette--hurt", undefined, vignetteParent);
    this.lowVignette = el("div", "tb-vignette tb-vignette--low", undefined, vignetteParent);
    this.hurtAnim = prepareAnimation(hurt, HURT_KEYFRAMES, { duration: 420 });
  }

  /** Health, or the bleed-out pool while knocked (see {@link setDowned}). */
  update(health: number, maxHealth: number): void {
    if (health === this.health) return;
    const dropped = health < this.health;
    this.health = health;

    const fraction = maxHealth > 0 ? clamp01(health / maxHealth) : 0;
    setText(this.value, Math.max(0, Math.ceil(health)).toString());
    this.fill.style.transform = `scaleX(${fraction})`;
    this.trail.style.transform = `scaleX(${fraction})`;
    // Healing and bleeding out shouldn't show a lagging trail.
    this.trail.classList.toggle("tb-health__trail--instant", !dropped || this.downed);

    const tier: HealthTier = this.downed ? "critical" : fraction > LOW_FRACTION ? "ok" : fraction > CRITICAL_FRACTION ? "low" : "critical";
    if (tier !== this.tier) {
      this.tier = tier;
      this.root.dataset.tier = tier;
      this.lowVignette.dataset.tier = tier;
    }

    // The steady bleed-out drain isn't a hit.
    if (dropped && !this.downed) replay(this.hurtAnim);
  }

  /** Shows the boost bar (hidden until an equipment view drives it). */
  set boostVisible(visible: boolean) {
    this.boost.hidden = !visible;
  }

  setBoost(boost: number): void {
    for (const segment of this.segments) {
      // Quantised to 1 % of the segment so the slow decay restyles rarely.
      const fill = Math.round(clamp01((boost - segment.from) / (segment.to - segment.from)) * 100);
      if (fill === segment.shown) continue;
      segment.shown = fill;
      segment.fill.style.transform = `scaleX(${fill / 100})`;
    }
  }

  /** A boost heal pulse landed. */
  pulseBoost(): void {
    replay(this.boostPulse);
  }

  setDowned(downed: boolean): void {
    if (downed === this.downed) return;
    this.downed = downed;
    this.root.toggleAttribute("data-downed", downed);
    this.health = Number.NaN;
    this.tier = undefined;
  }
}
