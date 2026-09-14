import { el } from "./dom";

/** Horizontal/upper mil-dot positions and bullet-drop ticks below centre, in reticle units (scope radius = 500). */
const MIL_DOTS = [60, 120, 180, 240];
const DROP_TICKS: ReadonlyArray<readonly [y: number, halfWidth: number, label: string]> = [
  [55, 70, "1"],
  [115, 55, "2"],
  [185, 42, "3"],
  [265, 30, "4"],
];

function reticleSvg(): string {
  const parts: string[] = [];
  // Thick outer posts, thin inner cross with a small centre gap.
  parts.push(
    '<g class="tb-scope__posts">',
    '<path d="M-500 0H-300M300 0H500M0 -500V-300M0 300V500"/>',
    "</g>",
    '<g class="tb-scope__lines">',
    '<path d="M-300 0H-8M8 0H300M0 -300V-8M0 8V300"/>',
  );
  for (const d of MIL_DOTS) {
    parts.push(`<path d="M${-d} -6V6M${d} -6V6M-6 ${-d}H6"/>`);
  }
  for (const [y, w] of DROP_TICKS) parts.push(`<path d="M${-w} ${y}H${w}"/>`);
  parts.push("</g>", '<g class="tb-scope__labels">');
  for (const [y, w, label] of DROP_TICKS) parts.push(`<text x="${w + 10}" y="${y + 7}">${label}</text>`);
  parts.push(
    "</g>",
    '<circle class="tb-scope__dot" r="2.5"/>',
    '<circle class="tb-scope__rim" r="497"/>',
  );
  return `<svg class="tb-scope__reticle" viewBox="-500 -500 1000 1000" aria-hidden="true">${parts.join("")}</svg>`;
}

/** Full-screen sniper scope: black mask with a circular lens, vignette and a mil-dot / bullet-drop reticle. */
export class ScopeOverlay {
  private readonly node: HTMLDivElement;
  private active = false;

  constructor(parent: HTMLElement) {
    this.node = el("div", "tb-scope", undefined, parent);
    el("div", "tb-scope__lens", undefined, this.node);
    this.node.insertAdjacentHTML("beforeend", reticleSvg());
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.node.toggleAttribute("data-active", active);
  }
}
