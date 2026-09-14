import { snapToDevicePixel } from "./anim";
import { el } from "./dom";

// Geometry in CSS px.
const LENGTH = 6;
const THICKNESS = 1;
const HALF = THICKNESS / 2;
/** Gap between the centre dot and the arms when spread is (near) zero. */
const MIN_GAP = 3;
const MAX_GAP = 120;
/** How much of the real spread cone the arms show; a full-size cone reads as noisy on a minimal HUD. */
const SPREAD_SCALE = 0.8;
/** Exponential follow rate toward the target gap, 1/s. */
const FOLLOW_RATE = 18;
const KICK_PX = 2.5;
const MAX_KICK_PX = 7;
const KICK_DECAY_RATE = 14;

/**
 * Thin DOM crosshair whose arms open with weapon spread. The node sits on the screen centre, snapped so a 1px line
 * lands on whole device pixels; the arms are offset by a single `--tb-gap` custom property, so a spread change is one
 * style write and a transform-only update.
 */
export class Crosshair {
  private readonly node: HTMLDivElement;
  private targetGap = MIN_GAP;
  private gap = MIN_GAP;
  private kickPx = 0;
  private opacity = 1;
  private shownGap = Number.NaN;
  private shownOpacity = 1;

  constructor(parent: HTMLElement) {
    this.node = el("div", "tb-crosshair", undefined, parent);
    this.arm(-HALF - LENGTH, -HALF, LENGTH, THICKNESS, "translate(calc(var(--tb-gap) * -1),0)"); // left
    this.arm(HALF, -HALF, LENGTH, THICKNESS, "translate(var(--tb-gap),0)"); // right
    this.arm(-HALF, -HALF - LENGTH, THICKNESS, LENGTH, "translate(0,calc(var(--tb-gap) * -1))"); // top
    this.arm(-HALF, HALF, THICKNESS, LENGTH, "translate(0,var(--tb-gap))"); // bottom
    this.arm(-HALF, -HALF, THICKNESS, THICKNESS, "none"); // centre dot

    this.layout();
    this.render();
    window.addEventListener("resize", this.layout);
  }

  set visible(visible: boolean) {
    this.node.hidden = !visible;
  }

  /** Distance from the screen centre to the edge of the spread cone, CSS px. */
  setSpreadPx(px: number): void {
    this.targetGap = Math.min(MAX_GAP, Math.max(MIN_GAP, px * SPREAD_SCALE - HALF));
  }

  /** Brief outward kick (on shot); decays on its own. */
  kick(): void {
    this.kickPx = Math.min(MAX_KICK_PX, this.kickPx + KICK_PX);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }

  update(dt: number): void {
    this.gap += (this.targetGap - this.gap) * (1 - Math.exp(-FOLLOW_RATE * dt));
    this.kickPx *= Math.exp(-KICK_DECAY_RATE * dt);
    if (this.kickPx < 0.05) this.kickPx = 0;
    if (!this.node.hidden) this.render();
  }

  private render(): void {
    const gap = snapToDevicePixel(this.gap + this.kickPx);
    if (gap !== this.shownGap) {
      this.shownGap = gap;
      this.node.style.setProperty("--tb-gap", `${gap}px`);
    }
    const opacity = Math.round(this.opacity * 20) / 20;
    if (opacity !== this.shownOpacity) {
      this.shownOpacity = opacity;
      this.node.style.opacity = opacity.toString();
    }
  }

  private arm(x: number, y: number, w: number, h: number, transform: string): void {
    const arm = el("div", "tb-crosshair__arm", undefined, this.node);
    arm.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:${transform}`;
  }

  private readonly layout = (): void => {
    const dpr = window.devicePixelRatio || 1;
    // A line an odd number of device pixels thick must be centred on a half pixel to render crisp.
    const halfPixel = Math.round(THICKNESS * dpr) % 2 === 1 ? 0.5 / dpr : 0;
    this.node.style.left = `${snapToDevicePixel(window.innerWidth / 2) + halfPixel}px`;
    this.node.style.top = `${snapToDevicePixel(window.innerHeight / 2) + halfPixel}px`;
  };
}
