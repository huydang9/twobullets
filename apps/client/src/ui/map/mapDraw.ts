import type { ZoneCircle } from "@twobullets/shared";
import type { MapImage } from "./mapImage";
import type { MapTeammate, MapViewer, MapZoneInfo } from "./types";

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;
/** PUBG-style team colours by position in the team (1-based index). */
export const TEAM_COLOURS = ["#f2f2ee", "#f2c230", "#f08a2c", "#3fa4f2", "#5ccf5a"] as const;
const NUMBER_TEXT = ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const DASH: number[] = [7, 6];
const SOLID: number[] = [];
export const MAP_FONT = '"Roboto Condensed", "Bahnschrift", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

/** Square viewport onto the map: world center, visible span and size in CSS px. */
export class MapProjection {
  cx = 0;
  cz = 0;
  /** Visible world side, m. */
  span = 1000;
  /** Viewport side, CSS px. */
  size = 1;

  get pixelsPerMeter(): number {
    return this.size / this.span;
  }

  sx(x: number): number {
    return (x - this.cx + this.span / 2) * (this.size / this.span);
  }

  sy(z: number): number {
    return (this.cz + this.span / 2 - z) * (this.size / this.span);
  }

  worldX(px: number): number {
    return this.cx - this.span / 2 + (px / this.size) * this.span;
  }

  worldZ(py: number): number {
    return this.cz + this.span / 2 - (py / this.size) * this.span;
  }
}

/** Sizes a canvas's backing store to its CSS box × devicePixelRatio; returns true when it changed. */
export function fitCanvas(canvas: HTMLCanvasElement, cssSize: number): boolean {
  const dpr = window.devicePixelRatio || 1;
  const pixels = Math.max(1, Math.round(cssSize * dpr));
  if (canvas.width === pixels && canvas.height === pixels) return false;
  canvas.width = pixels;
  canvas.height = pixels;
  return true;
}

/** Map image crop for the projection; outside the playable square stays the clear colour. */
export function drawMapImage(ctx: CanvasRenderingContext2D, image: MapImage, proj: MapProjection): void {
  const ippm = image.pixelsPerMeter;
  const sx = (proj.cx - proj.span / 2 + image.half) * ippm;
  const sy = (image.half - (proj.cz + proj.span / 2)) * ippm;
  const sw = proj.span * ippm;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.canvas, sx, sy, sw, sw, 0, 0, proj.size, proj.size);
}

/** Blue zone: translucent blue outside the current circle and its edge; the next safe circle in white. */
export function drawZone(ctx: CanvasRenderingContext2D, proj: MapProjection, zone: MapZoneInfo, lineScale = 1): void {
  const current = zone.current;
  if (current) {
    const x = proj.sx(current.cx);
    const y = proj.sy(current.cz);
    const r = current.r * proj.pixelsPerMeter;
    ctx.beginPath();
    ctx.rect(0, 0, proj.size, proj.size);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = "rgba(34, 72, 196, 0.34)";
    ctx.fill("evenodd");
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.lineWidth = 2 * lineScale;
    ctx.strokeStyle = "rgba(96, 150, 255, 0.95)";
    ctx.stroke();
  }
  const next = zone.next;
  if (next) {
    ctx.beginPath();
    ctx.arc(proj.sx(next.cx), proj.sy(next.cz), next.r * proj.pixelsPerMeter, 0, TAU);
    ctx.lineWidth = 1.6 * lineScale;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.stroke();
  }
}

/** Dashed line from the viewer to the nearest edge of the safe circle (next, else current) when outside it. */
export function drawRunLine(ctx: CanvasRenderingContext2D, proj: MapProjection, viewer: MapViewer, zone: MapZoneInfo): void {
  const target: ZoneCircle | null = zone.next ?? zone.current;
  if (!target) return;
  const dx = viewer.x - target.cx;
  const dz = viewer.z - target.cz;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance <= target.r || distance < 1e-3) return;
  const ex = target.cx + (dx / distance) * target.r;
  const ez = target.cz + (dz / distance) * target.r;
  ctx.beginPath();
  ctx.moveTo(proj.sx(viewer.x), proj.sy(viewer.z));
  ctx.lineTo(proj.sx(ex), proj.sy(ez));
  ctx.setLineDash(DASH);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
  ctx.setLineDash(SOLID);
}

/** Teammate dots with their team number; knocked ones pulse red, dead ones are a grey cross. */
export function drawTeammates(ctx: CanvasRenderingContext2D, proj: MapProjection, teammates: readonly MapTeammate[], count: number, radius: number, now: number): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = markerFont(radius);
  for (let i = 0; i < count; i++) {
    const mate = teammates[i]!;
    const x = proj.sx(mate.x);
    const y = proj.sy(mate.z);
    if (mate.state === "dead") {
      const s = radius * 0.7;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(200, 200, 196, 0.95)";
      ctx.stroke();
      continue;
    }
    const colour = TEAM_COLOURS[mate.number] ?? TEAM_COLOURS[0];
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.stroke();
    if (mate.state === "downed") {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
      ctx.beginPath();
      ctx.arc(x, y, radius + 2 + pulse * 2, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(224, 74, 60, 0.95)";
      ctx.stroke();
    } else {
      // Heading tick.
      const a = mate.headingDegrees * DEG_TO_RAD;
      ctx.beginPath();
      ctx.moveTo(x + Math.sin(a) * radius, y - Math.cos(a) * radius);
      ctx.lineTo(x + Math.sin(a) * (radius + 5), y - Math.cos(a) * (radius + 5));
      ctx.lineWidth = 2;
      ctx.strokeStyle = colour;
      ctx.stroke();
    }
    ctx.fillStyle = "#111";
    ctx.fillText(NUMBER_TEXT[mate.number] ?? "", x, y + 0.5);
  }
}

/** Viewer arrow with a faint view cone. */
export function drawViewer(ctx: CanvasRenderingContext2D, proj: MapProjection, viewer: MapViewer, size: number, cone: boolean): void {
  const x = proj.sx(viewer.x);
  const y = proj.sy(viewer.z);
  const a = viewer.headingDegrees * DEG_TO_RAD;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  if (cone) {
    const reach = size * 4.5;
    const half = 32 * DEG_TO_RAD;
    ctx.beginPath();
    ctx.moveTo(x, y);
    // Canvas angles run clockwise from +x; heading 0 (north) is -90°.
    ctx.arc(x, y, reach, a - Math.PI / 2 - half, a - Math.PI / 2 + half);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.fill();
  }
  // Arrow in local coords (tip forward at (0, -size), notch at the back), rotated clockwise by the heading.
  ctx.beginPath();
  ctx.moveTo(x + size * sin, y - size * cos);
  arrowPoint(ctx, x, y, sin, cos, size * 0.72, size * 0.8);
  arrowPoint(ctx, x, y, sin, cos, 0, size * 0.38);
  arrowPoint(ctx, x, y, sin, cos, -size * 0.72, size * 0.8);
  ctx.closePath();
  ctx.fillStyle = TEAM_COLOURS[viewer.number] ?? TEAM_COLOURS[0];
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.stroke();
}

function arrowPoint(ctx: CanvasRenderingContext2D, x: number, y: number, sin: number, cos: number, lx: number, ly: number): void {
  ctx.lineTo(x + lx * cos - ly * sin, y + lx * sin + ly * cos);
}

const fonts = new Map<number, string>();

/** Cached canvas font strings, so redraws don't build strings. */
export function markerFont(pixels: number, weight = 700): string {
  const key = Math.round(pixels) * 1000 + weight;
  let font = fonts.get(key);
  if (!font) fonts.set(key, (font = `${weight} ${Math.round(pixels)}px ${MAP_FONT}`));
  return font;
}
