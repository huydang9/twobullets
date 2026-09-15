import { ITEM_IDS, type ItemId } from "@twobullets/shared";
import { fallbackIconUrl } from "./fallbackIcons";
import { ICON_PIXELS, IconStudio, iconShape, type IconShape, type ItemIconSource, type StagedIcon } from "./IconStudio";

/** Frame time the baker may use per frame (building, copying, rendering, reading back). */
const FRAME_BUDGET_MS = 4;
/** Frames an icon may wait for its shaders before it is skipped (it keeps the fallback). */
const MAX_WAIT_FRAMES = 600;
/** Renders that came back empty (a shader not ready after all) before giving up on an icon. */
const MAX_EMPTY_RENDERS = 3;

interface Pending {
  readonly itemId: ItemId;
  staged: StagedIcon | null;
  waited: number;
  empty: number;
}

/**
 * Inventory icons for every catalog item, baked once per session from the real 3D models (`IconStudio`) a few ms per
 * frame, and cached as PNG object URLs. Until an icon lands (or without a model source) `url` returns an SVG silhouette;
 * `version` bumps whenever an icon changes so views refresh their images. The studio is disposed when the last icon is
 * done.
 */
export class ItemIcons {
  private readonly urls = new Map<ItemId, string>();
  private readonly queue: ItemId[] = [];
  private readonly retries: Pending[] = [];
  private studio: IconStudio | null = null;
  private current: Pending | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private inFlight = 0;
  private spentMs = 0;
  private frames = 0;
  private started = 0;
  private disposed = false;
  private _version = 0;

  constructor(private readonly source: ItemIconSource | null) {
    if (source) this.queue.push(...ITEM_IDS);
  }

  /** Bumps when any icon URL changes. */
  get version(): number {
    return this._version;
  }

  /** True while icons are still being baked. */
  get baking(): boolean {
    return this.queue.length > 0 || this.retries.length > 0 || this.current !== null || this.inFlight > 0;
  }

  url(itemId: ItemId): string {
    return this.urls.get(itemId) ?? fallbackIconUrl(itemId);
  }

  shape(itemId: ItemId): IconShape {
    return iconShape(itemId);
  }

  /** Per frame, after the game scene rendered. Does nothing once every icon is baked. */
  step(): void {
    if (this.disposed || !this.source || (!this.current && this.queue.length === 0 && this.retries.length === 0)) return;
    const start = performance.now();
    if (this.started === 0) this.started = start;
    this.frames++;
    try {
      this.studio ??= new IconStudio(this.source);
      while (performance.now() - start < FRAME_BUDGET_MS) {
        if (!this.current) {
          const retry = this.retries.shift();
          const itemId = retry ? undefined : this.queue.shift();
          if (retry) this.current = retry;
          else if (itemId) this.current = { itemId, staged: this.studio.stage(itemId), waited: 0, empty: 0 };
          else break;
        }
        const pending = this.current;
        if (!pending.staged) {
          this.current = null;
          continue;
        }
        if (!this.studio.isReady(pending.staged)) {
          if (++pending.waited > MAX_WAIT_FRAMES) {
            console.warn(`[icons] ${pending.itemId}: shaders never became ready; keeping the fallback icon`);
            this.finishCurrent();
          }
          // Shaders compile in parallel; try again next frame.
          break;
        }
        this.capture(pending);
      }
    } catch (error) {
      console.warn("[icons] baking stopped; remaining items keep their fallback icons", error);
      this.queue.length = 0;
      for (const pending of this.retries.splice(0)) if (pending.staged) this.studio?.release(pending.staged);
      this.finishCurrent();
    }
    this.spentMs += performance.now() - start;
    this.maybeFinish();
  }

  /** DEV: bakes every icon again (after tuning `ICON_VIEWS` / `ICON_LIGHTING`). */
  rebake(): void {
    if (!this.source || this.disposed) return;
    this.queue.length = 0;
    this.queue.push(...ITEM_IDS);
    this.spentMs = 0;
    this.frames = 0;
    this.started = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.finishCurrent();
    this.studio?.dispose();
    this.studio = null;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private capture(pending: Pending): void {
    const staged = pending.staged!;
    const [width, height] = ICON_PIXELS[staged.shape];
    const read = this.studio!.render(staged);
    if (!read) {
      this.finishCurrent();
      return;
    }
    // WebGL reads synchronously, so the next render can reuse the target at once.
    this.current = null;
    this.inFlight++;
    read
      .then(async (pixels) => {
        const url = await this.encode(pixels, width, height);
        if (this.disposed) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) {
          const old = this.urls.get(staged.itemId);
          if (old) URL.revokeObjectURL(old);
          this.urls.set(staged.itemId, url);
          this._version++;
          this.studio?.release(staged);
        } else if (++pending.empty < MAX_EMPTY_RENDERS && this.studio) {
          // Nothing was drawn: a shader for this pass wasn't ready after all. Render it again later.
          pending.waited = 0;
          this.retries.push(pending);
        } else {
          console.warn(`[icons] ${staged.itemId}: rendered empty; keeping the fallback icon`);
          this.studio?.release(staged);
        }
      })
      .catch((error: unknown) => {
        console.warn(`[icons] ${staged.itemId}: read back failed`, error);
        this.studio?.release(staged);
      })
      .finally(() => {
        this.inFlight--;
        this.maybeFinish();
      });
  }

  /**
   * Flips the bottom-up rows, un-premultiplies translucent pixels (glass on a transparent clear) and encodes a PNG.
   * Null when the render came back empty.
   */
  private async encode(pixels: ArrayBufferView, width: number, height: number): Promise<string | null> {
    const source = new Uint8Array(pixels.buffer, pixels.byteOffset, width * height * 4);
    const canvas = (this.canvas ??= document.createElement("canvas"));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const image = context.createImageData(width, height);
    const out = image.data;
    let covered = 0;
    for (let y = 0; y < height; y++) {
      let from = (height - 1 - y) * width * 4;
      let to = y * width * 4;
      for (let x = 0; x < width; x++, from += 4, to += 4) {
        const alpha = source[from + 3]!;
        if (alpha === 0) continue;
        covered++;
        const scale = alpha === 255 ? 1 : 255 / alpha;
        out[to] = source[from]! * scale;
        out[to + 1] = source[from + 1]! * scale;
        out[to + 2] = source[from + 2]! * scale;
        out[to + 3] = alpha;
      }
    }
    if (covered < 16) return null;
    context.putImageData(image, 0, 0);
    // toBlob snapshots the bitmap now, so the canvas can be reused for the next icon right away.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? URL.createObjectURL(blob) : null;
  }

  private finishCurrent(): void {
    if (this.current?.staged) this.studio?.release(this.current.staged);
    this.current = null;
  }

  private maybeFinish(): void {
    if (this.baking || !this.studio) return;
    this.studio.dispose();
    this.studio = null;
    this.canvas = null;
    console.info(`[icons] ${this.urls.size}/${ITEM_IDS.length} icons baked: ${this.spentMs.toFixed(0)} ms of frame time over ${this.frames} frames (${((performance.now() - this.started) / 1000).toFixed(1)} s)`);
  }
}
