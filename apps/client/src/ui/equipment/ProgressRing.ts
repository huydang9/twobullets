import { clamp01 } from "../anim";

const STEPS = 180;

/**
 * Thin SVG progress circle starting at 12 o'clock (the reload ring's look, reusable at any radius). Progress is
 * quantised so a long timer restyles the arc at most STEPS times.
 */
export class ProgressRing {
  readonly svg: SVGSVGElement;
  private readonly arc: SVGCircleElement;
  private readonly circumference: number;
  private step = -1;

  constructor(parent: HTMLElement, className: string, radius: number, stroke = 1.5) {
    const size = (radius + stroke + 1) * 2;
    this.circumference = 2 * Math.PI * radius;
    parent.insertAdjacentHTML(
      "beforeend",
      `<svg class="tb-ring ${className}" viewBox="${-size / 2} ${-size / 2} ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">` +
        `<circle class="tb-ring__track" r="${radius}" stroke-width="${stroke}"/>` +
        `<circle class="tb-ring__arc" r="${radius}" stroke-width="${stroke}" stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}"/>` +
        "</svg>",
    );
    this.svg = parent.lastElementChild as SVGSVGElement;
    this.arc = this.svg.querySelector<SVGCircleElement>(".tb-ring__arc")!;
  }

  /** 0 = empty, 1 = full circle. */
  set(progress: number): void {
    const step = Math.round(clamp01(progress) * STEPS);
    if (step === this.step) return;
    this.step = step;
    this.arc.style.strokeDashoffset = `${this.circumference * (1 - step / STEPS)}`;
  }
}
