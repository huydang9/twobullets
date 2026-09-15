import type { RoadLabel } from "@twobullets/shared";

/** A label's screen box: center, half extents along and across the text, rotation (rad, clockwise on screen). */
export interface LabelBox {
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  angle: number;
}

export interface PlacedRoadLabel extends LabelBox {
  readonly name: string;
}

/** World → screen (MapProjection satisfies it). */
export interface RoadLabelView {
  readonly size: number;
  readonly pixelsPerMeter: number;
  sx(x: number): number;
  sy(z: number): number;
}

export interface RoadLabelOptions {
  readonly fontPx: number;
  /** Text width at `fontPx`, px. */
  measure(text: string): number;
  /** Boxes labels keep clear of (POI names, grid labels, scale bar). */
  readonly obstacles: readonly LabelBox[];
  /** Highest `RoadLabel.rank` drawn. */
  readonly maxRank: number;
  /** One label per this much road, m. */
  readonly spacingMeters?: number;
}

/** A straight-ish stretch bends at most this much from its first segment, rad (≈20°). */
const MAX_BEND = 0.35;
/** Padding round the text in the collision box, px. */
const PAD = 4;
const SPACING_METERS = 400;

interface Candidate {
  readonly stretch: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/**
 * Places road names along their roads for one view: each name at its longest straight-ish stretches (at most one per
 * `spacingMeters` of road), rotated to the road and never upside down, skipped where it would leave the view or overlap
 * an obstacle or an earlier label. Labels come in priority order (rank, then length). Call on view changes only.
 */
export function placeRoadLabels(labels: readonly RoadLabel[], view: RoadLabelView, options: RoadLabelOptions): PlacedRoadLabel[] {
  const placed: PlacedRoadLabel[] = [];
  const spacing = (options.spacingMeters ?? SPACING_METERS) * view.pixelsPerMeter;
  const halfH = options.fontPx * 0.6 + PAD / 2;
  const candidates: Candidate[] = [];
  for (const label of labels) {
    if (label.rank > options.maxRank) continue;
    const width = options.measure(label.name);
    candidates.length = 0;
    for (const line of label.lines) collectCandidates(line, view, width + PAD * 2, spacing, candidates);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.stretch - a.stretch);
    const halfW = width / 2 + PAD;
    for (const c of candidates) {
      const box: PlacedRoadLabel = { name: label.name, x: c.x, y: c.y, halfW, halfH, angle: c.angle };
      if (!insideView(box, view.size)) continue;
      if (placed.some((p) => (p.name === label.name && distanceSquared(p, box) < spacing * spacing) || boxesOverlap(p, box))) continue;
      if (options.obstacles.some((o) => boxesOverlap(o, box))) continue;
      placed.push(box);
    }
  }
  return placed;
}

/** Candidates on one chain: stretches whose segments bend ≤ MAX_BEND, long enough for the text, split by `spacing`. */
function collectCandidates(line: readonly (readonly [number, number])[], view: RoadLabelView, need: number, spacing: number, out: Candidate[]): void {
  const n = line.length;
  if (n < 2) return;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = view.sx(line[i]![0]);
    ys[i] = view.sy(line[i]![1]);
  }
  let start = 0;
  while (start < n - 1) {
    const first = Math.atan2(ys[start + 1]! - ys[start]!, xs[start + 1]! - xs[start]!);
    let end = start + 1;
    while (end < n - 1 && Math.abs(angleDiff(Math.atan2(ys[end + 1]! - ys[end]!, xs[end + 1]! - xs[end]!), first)) <= MAX_BEND) end++;
    let length = 0;
    for (let i = start; i < end; i++) length += Math.sqrt((xs[i + 1]! - xs[i]!) ** 2 + (ys[i + 1]! - ys[i]!) ** 2);
    if (length >= need) {
      const count = Math.max(1, Math.floor(length / Math.max(spacing, need)));
      for (let k = 0; k < count; k++) {
        const along = ((k + 0.5) * length) / count;
        const [x, y] = pointAlong(xs, ys, start, end, along);
        const [ax, ay] = pointAlong(xs, ys, start, end, Math.max(0, along - need / 2));
        const [bx, by] = pointAlong(xs, ys, start, end, Math.min(length, along + need / 2));
        out.push({ stretch: length, x, y, angle: uprightAngle(Math.atan2(by - ay, bx - ax)) });
      }
    }
    start = end;
  }
}

function pointAlong(xs: Float64Array, ys: Float64Array, start: number, end: number, distance: number): [number, number] {
  let left = distance;
  for (let i = start; i < end; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    const dy = ys[i + 1]! - ys[i]!;
    const segment = Math.sqrt(dx * dx + dy * dy);
    if (left <= segment || i === end - 1) {
      const t = segment > 0 ? Math.min(1, left / segment) : 0;
      return [xs[i]! + dx * t, ys[i]! + dy * t];
    }
    left -= segment;
  }
  return [xs[end]!, ys[end]!];
}

/** Text rotation that reads left to right: folded into (-π/2, π/2]. */
export function uprightAngle(angle: number): number {
  let a = angleDiff(angle, 0);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Separating-axis test for two rotated boxes. */
export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ac = Math.cos(a.angle);
  const as = Math.sin(a.angle);
  const bc = Math.cos(b.angle);
  const bs = Math.sin(b.angle);
  return !(separated(dx, dy, ac, as, a, b, ac, as, bc, bs) || separated(dx, dy, -as, ac, a, b, ac, as, bc, bs) || separated(dx, dy, bc, bs, a, b, ac, as, bc, bs) || separated(dx, dy, -bs, bc, a, b, ac, as, bc, bs));
}

function separated(dx: number, dy: number, ux: number, uy: number, a: LabelBox, b: LabelBox, ac: number, as: number, bc: number, bs: number): boolean {
  const ra = a.halfW * Math.abs(ac * ux + as * uy) + a.halfH * Math.abs(-as * ux + ac * uy);
  const rb = b.halfW * Math.abs(bc * ux + bs * uy) + b.halfH * Math.abs(-bs * ux + bc * uy);
  return Math.abs(dx * ux + dy * uy) > ra + rb;
}

function insideView(box: LabelBox, size: number): boolean {
  const c = Math.abs(Math.cos(box.angle));
  const s = Math.abs(Math.sin(box.angle));
  const ex = box.halfW * c + box.halfH * s;
  const ey = box.halfW * s + box.halfH * c;
  return box.x - ex >= 0 && box.x + ex <= size && box.y - ey >= 0 && box.y + ey <= size;
}

function distanceSquared(a: LabelBox, b: LabelBox): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
