import { setText } from "./anim";
import { el, textNode } from "./dom";

const RADIUS = 17;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Progress is quantised so the ring restyles at most this many times per reload. */
const STEPS = 120;

/**
 * Thin circular reload timer around the crosshair with the seconds remaining underneath. Updates are quantised
 * (ring) and change-only (text); the ring is a tiny SVG so its dash repaint stays cheap.
 */
export class ReloadIndicator {
  private readonly root: HTMLDivElement;
  private readonly arc: SVGCircleElement;
  private readonly seconds: Text;
  private active = false;
  private shownStep = -1;
  private shownTenths = -1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-reload", undefined, parent);
    const size = (RADIUS + 2) * 2;
    this.root.insertAdjacentHTML(
      "beforeend",
      `<svg class="tb-reload__ring" viewBox="${-size / 2} ${-size / 2} ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">` +
        `<circle class="tb-reload__track" r="${RADIUS}"/>` +
        `<circle class="tb-reload__arc" r="${RADIUS}" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}"/>` +
        "</svg>",
    );
    this.arc = this.root.querySelector<SVGCircleElement>(".tb-reload__arc")!;
    this.seconds = textNode(el("div", "tb-reload__seconds", undefined, this.root));
    this.root.hidden = true;
  }

  /**
   * @param progress 0..1 while reloading, null otherwise.
   * @param secondsLeft remaining reload time.
   */
  update(progress: number | null, secondsLeft: number): void {
    const active = progress !== null;
    if (active !== this.active) {
      this.active = active;
      this.root.hidden = !active;
      this.shownStep = this.shownTenths = -1;
    }
    if (progress === null) return;

    const step = Math.round(progress * STEPS);
    if (step !== this.shownStep) {
      this.shownStep = step;
      this.arc.style.strokeDashoffset = `${CIRCUMFERENCE * (1 - step / STEPS)}`;
    }
    const tenths = Math.max(0, Math.ceil(secondsLeft * 10));
    if (tenths !== this.shownTenths) {
      this.shownTenths = tenths;
      setText(this.seconds, (tenths / 10).toFixed(1));
    }
  }
}
