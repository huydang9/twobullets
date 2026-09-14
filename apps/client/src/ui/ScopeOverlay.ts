import { el } from "./dom";

/** Reticle units: the lens radius is 500. */
const POST_INNER = 240;
/** Small windage marks on the horizontal line. */
const WIND_MARKS = [45, 90, 135, 180];
/** Bullet-drop marks below centre: [y, half width, label]. */
const DROP_MARKS: ReadonlyArray<readonly [y: number, halfWidth: number, label: string]> = [
  [38, 16, "2"],
  [82, 13, "3"],
  [132, 10, "4"],
  [188, 7, "5"],
];

function reticleSvg(): string {
  const thin: string[] = [
    // Continuous fine cross between the posts.
    `M${-POST_INNER} 0H${POST_INNER}M0 ${-POST_INNER}V${POST_INNER}`,
  ];
  for (const x of WIND_MARKS) thin.push(`M${-x} -4V4M${x} -4V4`);
  for (const [y, w] of DROP_MARKS) thin.push(`M${-w} ${y}H${w}`);
  const labels = DROP_MARKS.map(([y, w, label]) => `<text x="${w + 7}" y="${y + 4}">${label}</text>`).join("");

  return (
    '<svg class="tb-scope__reticle" viewBox="-500 -500 1000 1000" aria-hidden="true">' +
    `<path class="tb-scope__posts" d="M-500 0H${-POST_INNER}M${POST_INNER} 0H500M0 -500V${-POST_INNER}M0 ${POST_INNER}V500"/>` +
    `<path class="tb-scope__fine" d="${thin.join("")}"/>` +
    `<g class="tb-scope__labels">${labels}</g>` +
    "</svg>"
  );
}

/**
 * Full-screen optic: black surround with a soft circular edge, faint chromatic fringe, glass tint and a duplex
 * reticle with subtle drop marks. Static markup; toggling is a single attribute (opacity transition).
 */
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
