import { el } from "./dom";

// Geometry in CSS px. Keep SIZE even and THICKNESS even so the arms straddle the exact screen centre.
const GAP = 5;
const LENGTH = 8;
const THICKNESS = 2;
const SIZE = 2 * (GAP + LENGTH) + THICKNESS;

/** Static DOM crosshair, snapped to whole device pixels so its edges stay crisp. */
export class Crosshair {
  private readonly node: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.node = el("div", "tb-crosshair", undefined, parent);
    this.node.style.width = this.node.style.height = `${SIZE}px`;
    const mid = GAP + LENGTH;
    this.arm(0, mid, LENGTH, THICKNESS); // left
    this.arm(mid + THICKNESS + GAP, mid, LENGTH, THICKNESS); // right
    this.arm(mid, 0, THICKNESS, LENGTH); // top
    this.arm(mid, mid + THICKNESS + GAP, THICKNESS, LENGTH); // bottom
    this.arm(mid, mid, THICKNESS, THICKNESS); // centre dot

    this.layout();
    window.addEventListener("resize", this.layout);
  }

  set visible(visible: boolean) {
    this.node.hidden = !visible;
  }

  private arm(x: number, y: number, w: number, h: number): void {
    const arm = el("div", "tb-crosshair__arm", undefined, this.node);
    arm.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  }

  private readonly layout = (): void => {
    // Snap the top-left corner to the device pixel grid (handles fractional devicePixelRatio).
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    this.node.style.left = `${snap((window.innerWidth - SIZE) / 2)}px`;
    this.node.style.top = `${snap((window.innerHeight - SIZE) / 2)}px`;
  };
}
