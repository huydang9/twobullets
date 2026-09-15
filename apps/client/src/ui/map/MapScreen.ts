import type { MapData } from "@twobullets/shared";
import { KEY_BINDINGS } from "../../input/bindings";
import { setText } from "../anim";
import { el, elT, textNode } from "../dom";
import { formatClock } from "../match/MatchHud";
import { MapProjection, drawMapImage, drawRunLine, drawTeammates, drawViewer, drawZone, fitCanvas, markerFont } from "./mapDraw";
import type { MapImage } from "./mapImage";
import { placeRoadLabels, type LabelBox } from "./roadLabels";
import type { MapInput, MapTeammate, MapViewer, MapZoneInfo } from "./types";

/** N cycles through these; the wheel zooms continuously between the first and MAX_ZOOM. */
const ZOOM_LEVELS = [1, 2, 4] as const;
const MAX_ZOOM = 8;
const WHEEL_STEP = 1.25;
/** Grid cell, m (A–J columns, 1–10 rows on Map v1). */
const GRID_CELL = 100;
const SCALE_LENGTHS = [10, 25, 50, 100, 200, 250, 500] as const;
const COLUMN_NAMES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAP_KEYS: readonly string[] = KEY_BINDINGS.map;
/** Below this zoom only trunk, primary and secondary road names show, so the whole-map view stays readable. */
const ALL_ROAD_NAMES_ZOOM = 2;
const ZOOM_KEYS: readonly string[] = KEY_BINDINGS.mapZoom;

/** The frame's data for one overlay pass, read once by MapHud and shared with the minimap. */
export interface MapFrameData {
  readonly viewer: MapViewer;
  readonly teammates: readonly MapTeammate[];
  teammateCount: number;
  readonly zone: MapZoneInfo;
}

/**
 * Full-screen PUBG-style map (M): the cached map image with grid, road names, POI names and scale bar on the base layer, redrawn only
 * when the view changes; zone, run line and markers on the overlay layer at the MapHud rate. N cycles 1×/2×/4× centred
 * on the player, the wheel zooms at the cursor and drag pans. Releases pointer lock while open, like the inventory.
 */
export class MapScreen {
  readonly root: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly loading: HTMLDivElement;
  private readonly zoneStrip: HTMLDivElement;
  private readonly zoneLabel: Text;
  private readonly zoneTime: Text;
  private readonly zoneBar: HTMLDivElement;
  private readonly zoneFill: HTMLDivElement;
  private readonly zoomText: Text;
  private readonly proj = new MapProjection();
  private readonly half: number;
  private readonly events = new AbortController();
  private image: MapImage | null = null;
  private open = false;
  private zoom = 1;
  private baseDirty = true;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private shown = { label: "?", seconds: -2, progress: -2, zoom: -1 };
  private readonly nameWidths = new Map<string, Map<string, number>>();

  constructor(
    parent: HTMLElement,
    private readonly map: MapData,
    private readonly input: MapInput,
    /** Latest viewer position, used to centre zoom levels. */
    private readonly viewer: MapViewer,
  ) {
    this.half = map.terrain.playableHalfExtent;
    this.proj.span = this.half * 2;

    this.root = el("div", "tb-map", undefined, parent);
    this.root.hidden = true;
    this.zoneStrip = el("div", "tb-map__zone", undefined, this.root);
    this.zoneLabel = textNode(el("span", "tb-map__zone-label", undefined, this.zoneStrip));
    this.zoneTime = textNode(el("span", "tb-map__zone-time", undefined, this.zoneStrip));
    this.zoneBar = el("div", "tb-map__zone-bar", undefined, this.zoneStrip);
    this.zoneFill = el("div", "tb-map__zone-bar-fill", undefined, this.zoneBar);
    this.zoneStrip.hidden = true;

    this.frame = el("div", "tb-map__frame", undefined, this.root);
    this.base = el("canvas", "tb-map__canvas", undefined, this.frame);
    this.overlay = el("canvas", "tb-map__canvas", undefined, this.frame);
    this.loading = elT("div", "tb-map__loading", "map.loading", this.frame);
    const baseCtx = this.base.getContext("2d", { alpha: false });
    const overlayCtx = this.overlay.getContext("2d");
    if (!baseCtx || !overlayCtx) throw new Error("[map] 2D canvas unavailable");
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;

    const footer = el("div", "tb-map__footer", undefined, this.root);
    this.zoomText = textNode(el("span", "tb-map__zoom", undefined, footer));
    footer.append(key("M"), " / ", key("Esc"), " ");
    elT("span", "", "map.close", footer);
    footer.append("   ", key("N"), " ");
    elT("span", "", "map.zoom", footer);
    footer.append("   ");
    elT("span", "", "map.mouseHint", footer);

    const options = { signal: this.events.signal };
    window.addEventListener("keydown", this.handleKey, { capture: true, signal: this.events.signal });
    window.addEventListener("resize", () => (this.baseDirty = true), options);
    this.root.addEventListener("contextmenu", (event) => event.preventDefault(), options);
    this.frame.addEventListener("wheel", this.handleWheel, { passive: false, signal: this.events.signal });
    this.frame.addEventListener("pointerdown", this.handlePointerDown, options);
    this.frame.addEventListener("pointermove", this.handlePointerMove, options);
    this.frame.addEventListener("pointerup", this.handlePointerUp, options);
    this.frame.addEventListener("pointercancel", this.handlePointerUp, options);
    input.onLockChange((locked) => {
      if (locked && this.open) this.setOpen(false);
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  setImage(image: MapImage): void {
    this.image = image;
    this.loading.hidden = true;
    this.baseDirty = true;
  }

  /** Opens or closes the map. Closing asks for pointer lock again unless `relock` is false (e.g. a death screen). */
  setOpen(open: boolean, relock = true): void {
    if (open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    this.dragging = false;
    if (open) {
      this.onOpen();
      if (this.zoom > 1) this.setZoom(this.zoom, this.viewer.x, this.viewer.z);
      this.baseDirty = true;
      if (this.input.isLocked) document.exitPointerLock();
    } else if (relock && !this.input.isLocked) {
      // Keydown is a user gesture, so this usually re-locks at once; if refused, the play overlay's click does.
      this.input.requestLock();
    }
  }

  /** Sets the zoom (1 = whole map) centred on world (x, z), clamped to the map. */
  setZoom(zoom: number, x = 0, z = 0): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
    this.proj.span = (this.half * 2) / this.zoom;
    this.proj.cx = x;
    this.proj.cz = z;
    this.clampView();
    this.baseDirty = true;
  }

  /** N: next zoom level centred on the player; after the last one, back to the whole map. */
  cycleZoom(): void {
    let next: number = ZOOM_LEVELS[0];
    for (const level of ZOOM_LEVELS) {
      if (level > this.zoom + 1e-3) {
        next = level;
        break;
      }
    }
    if (next === 1) this.setZoom(1);
    else this.setZoom(next, this.viewer.x, this.viewer.z);
  }

  /** Redraws the base layer if the view changed and the overlay from `data`. Only call while open. */
  draw(data: MapFrameData, now: number): void {
    const size = this.frame.clientWidth;
    if (size <= 0) return;
    if (size !== this.proj.size) {
      this.proj.size = size;
      this.baseDirty = true;
    }
    if (this.baseDirty) this.drawBase();
    this.drawOverlay(data, now);
    this.updateStrip(data.zone);
  }

  dispose(): void {
    this.events.abort();
    this.root.remove();
  }

  // ---- Drawing -------------------------------------------------------------------------------------------------------

  private drawBase(): void {
    this.baseDirty = false;
    const ctx = this.baseCtx;
    const proj = this.proj;
    const size = proj.size;
    fitCanvas(this.base, size);
    const dpr = this.base.width / size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1a1f22";
    ctx.fillRect(0, 0, size, size);
    const image = this.image;
    if (!image) return;
    drawMapImage(ctx, image, proj);

    const half = this.half;
    const cells = Math.round((half * 2) / GRID_CELL);
    // Grid lines, snapped to device pixels.
    ctx.beginPath();
    for (let i = 0; i <= cells; i++) {
      const v = -half + i * GRID_CELL;
      const x = Math.round(proj.sx(v) * dpr) / dpr + 0.5 / dpr;
      const y = Math.round(proj.sy(v) * dpr) / dpr + 0.5 / dpr;
      if (x >= 0 && x <= size) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size);
      }
      if (y >= 0 && y <= size) {
        ctx.moveTo(0, y);
        ctx.lineTo(size, y);
      }
    }
    ctx.lineWidth = 1 / dpr;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const poiSize = Math.min(20, 13 + this.zoom * 1.2);
    ctx.font = markerFont(poiSize, 700);
    const poiBoxes: LabelBox[] = [];
    for (const poi of this.map.pois) {
      const name = poi.name.toUpperCase();
      poiBoxes.push({ x: proj.sx(poi.center[0]), y: proj.sy(poi.center[1]), halfW: ctx.measureText(name).width / 2 + 3, halfH: poiSize * 0.6, angle: 0 });
    }
    this.drawRoadNames(poiBoxes, dpr);

    // POI names.
    ctx.font = markerFont(poiSize, 700);
    for (const poi of this.map.pois) {
      const x = proj.sx(poi.center[0]);
      const y = proj.sy(poi.center[1]);
      if (x < -120 || x > size + 120 || y < -20 || y > size + 20) continue;
      const name = poi.name.toUpperCase();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(10, 12, 14, 0.7)";
      ctx.strokeText(name, x, y);
      ctx.fillStyle = "rgba(250, 250, 244, 0.96)";
      ctx.fillText(name, x, y);
    }

    // Grid labels along the top and left edges, at the centre of each visible cell.
    ctx.font = markerFont(12, 600);
    ctx.lineWidth = 3;
    for (let i = 0; i < cells; i++) {
      const centre = -half + (i + 0.5) * GRID_CELL;
      const x = proj.sx(centre);
      if (x > 10 && x < size - 10) outlinedText(ctx, COLUMN_NAMES[i] ?? "", x, 11);
      const y = proj.sy(half - (i + 0.5) * GRID_CELL);
      if (y > 22 && y < size - 10) outlinedText(ctx, String(i + 1), 11, y);
    }

    // Scale bar, bottom left.
    const ppm = proj.pixelsPerMeter;
    let length: number = SCALE_LENGTHS[SCALE_LENGTHS.length - 1]!;
    for (const candidate of SCALE_LENGTHS) {
      if (candidate * ppm >= 70) {
        length = candidate;
        break;
      }
    }
    const barX = 16;
    const barY = size - 16;
    const barW = Math.round(length * ppm);
    ctx.beginPath();
    ctx.moveTo(barX, barY - 5);
    ctx.lineTo(barX, barY);
    ctx.lineTo(barX + barW, barY);
    ctx.lineTo(barX + barW, barY - 5);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(10, 12, 14, 0.7)";
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(250, 250, 244, 0.95)";
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = markerFont(12, 600);
    ctx.lineWidth = 3;
    outlinedText(ctx, `${length} m`, barX + barW + 6, barY + 1);
  }

  /** Road names along big roads (real-world maps), clear of POI names, grid labels and the scale bar. */
  private drawRoadNames(obstacles: LabelBox[], dpr: number): void {
    const labels = this.map.roadLabels;
    if (!labels || labels.length === 0) return;
    const ctx = this.baseCtx;
    const size = this.proj.size;
    const fontPx = Math.min(15, 10.5 + this.zoom * 0.8);
    const font = markerFont(fontPx, 600);
    ctx.font = font;
    const widths = this.roadNameWidths(font);
    obstacles.push(
      { x: size / 2, y: 11, halfW: size / 2, halfH: 11, angle: 0 },
      { x: 11, y: size / 2, halfW: 11, halfH: size / 2, angle: 0 },
      { x: 90, y: size - 18, halfW: 90, halfH: 14, angle: 0 },
    );
    const placed = placeRoadLabels(labels, this.proj, {
      fontPx,
      obstacles,
      maxRank: this.zoom < ALL_ROAD_NAMES_ZOOM ? 1 : 3,
      measure: (text) => {
        let width = widths.get(text);
        if (width === undefined) widths.set(text, (width = ctx.measureText(text).width));
        return width;
      },
    });
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(10, 12, 14, 0.72)";
    ctx.fillStyle = "rgba(238, 234, 220, 0.94)";
    for (const label of placed) {
      const cos = Math.cos(label.angle) * dpr;
      const sin = Math.sin(label.angle) * dpr;
      ctx.setTransform(cos, sin, -sin, cos, label.x * dpr, label.y * dpr);
      ctx.strokeText(label.name, 0, 0);
      ctx.fillText(label.name, 0, 0);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Measured road name widths per font, so pans and zooms don't re-measure. */
  private roadNameWidths(font: string): Map<string, number> {
    let widths = this.nameWidths.get(font);
    if (!widths) this.nameWidths.set(font, (widths = new Map()));
    return widths;
  }

  private drawOverlay(data: MapFrameData, now: number): void {
    const ctx = this.overlayCtx;
    const proj = this.proj;
    const size = proj.size;
    fitCanvas(this.overlay, size);
    const dpr = this.overlay.width / size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (!this.image) return;
    drawZone(ctx, proj, data.zone);
    drawRunLine(ctx, proj, data.viewer, data.zone);
    drawTeammates(ctx, proj, data.teammates, data.teammateCount, 7, now);
    drawViewer(ctx, proj, data.viewer, 9, true);
  }

  private updateStrip(zone: MapZoneInfo): void {
    const shown = this.shown;
    if (zone.label !== shown.label) {
      shown.label = zone.label;
      this.zoneStrip.hidden = zone.label === "";
      setText(this.zoneLabel, zone.label);
    }
    if (zone.seconds !== shown.seconds) {
      shown.seconds = zone.seconds;
      setText(this.zoneTime, zone.seconds >= 0 ? formatClock(zone.seconds) : "");
    }
    const progress = zone.progress < 0 ? -1 : Math.round(zone.progress * 200) / 200;
    if (progress !== shown.progress) {
      shown.progress = progress;
      this.zoneBar.hidden = progress < 0;
      if (progress >= 0) this.zoneFill.style.transform = `scaleX(${progress})`;
    }
    const zoom = Math.round(this.zoom * 10) / 10;
    if (zoom !== shown.zoom) {
      shown.zoom = zoom;
      setText(this.zoomText, `${zoom}×   `);
    }
  }

  private clampView(): void {
    const proj = this.proj;
    const limit = this.half - proj.span / 2;
    proj.cx = Math.min(limit, Math.max(-limit, proj.cx));
    proj.cz = Math.min(limit, Math.max(-limit, proj.cz));
  }

  // ---- Input ---------------------------------------------------------------------------------------------------------

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (this.open) {
      if (event.code === "Escape" || MAP_KEYS.includes(event.code)) {
        event.preventDefault();
        this.setOpen(false);
      } else if (ZOOM_KEYS.includes(event.code)) {
        event.preventDefault();
        this.cycleZoom();
      }
    } else if (MAP_KEYS.includes(event.code) && this.input.isLocked) {
      event.preventDefault();
      this.setOpen(true);
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (event.deltaY === 0) return;
    const rect = this.frame.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const proj = this.proj;
    const wx = proj.worldX(px);
    const wz = proj.worldZ(py);
    const zoom = Math.min(MAX_ZOOM, Math.max(1, this.zoom * (event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP)));
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    proj.span = (this.half * 2) / zoom;
    // Keep the world point under the cursor in place.
    proj.cx = wx - (px / proj.size - 0.5) * proj.span;
    proj.cz = wz + (py / proj.size - 0.5) * proj.span;
    this.clampView();
    this.baseDirty = true;
    this.requestRedraw();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.zoom <= 1) return;
    this.dragging = true;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.frame.setPointerCapture(event.pointerId);
    this.frame.toggleAttribute("data-dragging", true);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const proj = this.proj;
    const scale = proj.span / proj.size;
    proj.cx -= (event.clientX - this.dragX) * scale;
    proj.cz += (event.clientY - this.dragY) * scale;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.clampView();
    this.baseDirty = true;
    this.requestRedraw();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.frame.toggleAttribute("data-dragging", false);
    if (this.frame.hasPointerCapture(event.pointerId)) this.frame.releasePointerCapture(event.pointerId);
  };

  /** Set by MapHud: redraw now (with the last frame data) instead of waiting for the next overlay tick. */
  requestRedraw: () => void = () => {};
  /** Set by MapHud: refresh the frame data before the map opens (zoom centres on the viewer). */
  onOpen: () => void = () => {};
}

function key(label: string): HTMLSpanElement {
  return el("span", "tb-key", label);
}

function outlinedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.strokeStyle = "rgba(10, 12, 14, 0.7)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "rgba(250, 250, 244, 0.92)";
  ctx.fillText(text, x, y);
}
