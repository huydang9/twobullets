import { snapToDevicePixel, setText } from "./anim";
import { el, textNode } from "./dom";

const PX_PER_DEG = 4;
/** Half the widest compass window (CSS max width 440px), px: markers beyond it clamp to the edge. */
export const COMPASS_HALF_WIDTH_PX = 220;
/**
 * The tape covers one full turn plus a margin on both sides, so any heading in [0, 360) can be centred without
 * wrapping. The margin must exceed half the visible window (CSS max width 440px / 4 px/deg / 2 = 55°).
 */
const TAPE_START_DEG = -90;
const TAPE_END_DEG = 450;
const TICK_STEP_DEG = 5;
const LABELS: Readonly<Record<number, string>> = {
  0: "N",
  45: "NE",
  90: "E",
  135: "SE",
  180: "S",
  225: "SW",
  270: "W",
  315: "NW",
};

type TickKind = "minor" | "major" | "inter" | "cardinal";

/**
 * Top-centre heading tape. The ticks and labels are built once; a heading change is a single transform write on the
 * tape (plus the readout text when the whole-degree heading changes).
 */
export class Compass {
  private readonly tape: HTMLDivElement;
  private readonly heading: Text;
  private shownX = Number.NaN;
  private shownHeading = -1;

  constructor(parent: HTMLElement) {
    const root = el("div", "tb-compass", undefined, parent);
    const viewport = el("div", "tb-compass__window", undefined, root);
    this.tape = el("div", "tb-compass__tape", undefined, viewport);

    for (let deg = TAPE_START_DEG; deg <= TAPE_END_DEG; deg += TICK_STEP_DEG) {
      const bearing = normalizeDegrees(deg);
      const kind: TickKind =
        bearing % 90 === 0 ? "cardinal" : bearing % 45 === 0 ? "inter" : bearing % 15 === 0 ? "major" : "minor";
      const x = `${(deg - TAPE_START_DEG) * PX_PER_DEG}px`;
      el("div", `tb-compass__tick tb-compass__tick--${kind}`, undefined, this.tape).style.left = x;
      if (kind !== "minor") {
        const text = LABELS[bearing] ?? bearing.toString();
        el("div", `tb-compass__label tb-compass__label--${kind}`, text, this.tape).style.left = x;
      }
    }

    el("div", "tb-compass__marker", undefined, root);
    this.heading = textNode(el("div", "tb-compass__heading", undefined, root));
  }

  /** @param bearingDegrees 0 = north (+Z), 90 = east (+X). Any range; wrapped internally. */
  update(bearingDegrees: number): void {
    const bearing = normalizeDegrees(bearingDegrees);
    // The tape's left edge sits at the window centre, so shifting by the bearing's tape offset centres it.
    const x = snapToDevicePixel(-(bearing - TAPE_START_DEG) * PX_PER_DEG);
    if (x !== this.shownX) {
      this.shownX = x;
      this.tape.style.transform = `translate3d(${x}px,0,0)`;
    }
    const heading = Math.round(bearing) % 360;
    if (heading !== this.shownHeading) {
      this.shownHeading = heading;
      setText(this.heading, heading.toString());
    }
  }
}

/**
 * Horizontal offset from the compass centre, px, of a marker at `bearingDegrees` while the view heads `headingDegrees`
 * (both 0 = north, 90 = east), clamped to ±`maxPx` (the zone marker and later pings sit on the same scale as the tape).
 */
export function compassMarkerOffset(bearingDegrees: number, headingDegrees: number, maxPx = COMPASS_HALF_WIDTH_PX): number {
  let delta = normalizeDegrees(bearingDegrees - headingDegrees);
  if (delta > 180) delta -= 360;
  const px = delta * PX_PER_DEG;
  return px < -maxPx ? -maxPx : px > maxPx ? maxPx : px;
}

function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
