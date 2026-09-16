import { el } from "../dom";
import { MapProjection, drawMapImage, drawRunLine, drawTeammates, drawViewer, drawZone, fitCanvas } from "./mapDraw";
import type { MapImage } from "./mapImage";
import type { MapFrameData } from "./MapScreen";

/** Visible world side of the minimap, m (a bit over a third of the 500 m square). */
const MINIMAP_SPAN = 180;

/** Small north-up minimap, bottom right, centred on the viewer: same image, zone and markers as the big map. */
export class Minimap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly proj = new MapProjection();
  private image: MapImage | null = null;
  private wanted = false;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-minimap", undefined, parent);
    this.canvas = el("canvas", "tb-minimap__canvas", undefined, this.root);
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("[map] 2D canvas unavailable");
    this.ctx = ctx;
    this.proj.span = MINIMAP_SPAN;
    this.root.hidden = true;
  }

  /** Shown while playing, once the image is ready. */
  set visible(visible: boolean) {
    this.wanted = visible;
    this.root.hidden = !visible || !this.image;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setImage(image: MapImage): void {
    this.image = image;
    this.visible = this.wanted;
  }

  draw(data: MapFrameData, now: number): void {
    const image = this.image;
    if (!image || this.root.hidden) return;
    const size = this.canvas.clientWidth;
    if (size <= 0) return;
    const proj = this.proj;
    proj.size = size;
    proj.cx = data.viewer.x;
    proj.cz = data.viewer.z;
    fitCanvas(this.canvas, size);
    const ctx = this.ctx;
    const dpr = this.canvas.width / size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1a1f22";
    ctx.fillRect(0, 0, size, size);
    drawMapImage(ctx, image, proj);
    drawZone(ctx, proj, data.zone, 0.8);
    drawRunLine(ctx, proj, data.viewer, data.zone);
    drawTeammates(ctx, proj, data.teammates, data.teammateCount, 5, now);
    drawViewer(ctx, proj, data.viewer, 7, true);
  }

  dispose(): void {
    this.root.remove();
  }
}
