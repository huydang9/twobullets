import { renderMapImage, type MapImage } from "./mapImage";
import { MapScreen, type MapFrameData } from "./MapScreen";
import { Minimap } from "./Minimap";
import type { MapInput, MapTeammate, MapViewSource, MapWorldData } from "./types";
import "./map.css";

/** Overlay redraw interval, ms (≈15 Hz). */
const OVERLAY_INTERVAL_MS = 66;
/** Teammate markers kept (teams are at most 2 today; 3 leaves room). */
const MAX_TEAMMATES = 3;

export interface MapHudOptions {
  readonly world: MapWorldData;
  readonly input: MapInput;
  /** Viewer, teammates and zone. `setSource` swaps it (e.g. the offline match once it starts). */
  readonly source: MapViewSource;
  /** Bottom-right minimap (default true). */
  readonly minimap?: boolean;
}

/**
 * Map HUD: renders the map image once (sliced, off the frame loop's back), then drives the full-screen map (M / N) and
 * the minimap from one data source read at ≈15 Hz into reused objects.
 */
export class MapHud {
  readonly screen: MapScreen;
  readonly minimap: Minimap | null;
  /** Resolves when the map image is ready. */
  readonly ready: Promise<MapImage>;
  private readonly defaultSource: MapViewSource;
  private source: MapViewSource;
  private readonly data: MapFrameData;
  private lastDraw = -Infinity;
  private image: MapImage | null = null;
  private disposed = false;

  constructor(parent: HTMLElement, options: MapHudOptions) {
    this.defaultSource = options.source;
    this.source = options.source;
    const teammates: MapTeammate[] = [];
    for (let i = 0; i < MAX_TEAMMATES; i++) teammates.push({ x: 0, z: 0, headingDegrees: 0, number: 0, state: "alive" });
    this.data = {
      viewer: { x: 0, z: 0, headingDegrees: 0, number: 1 },
      teammates,
      teammateCount: 0,
      zone: { current: null, next: null, label: "", seconds: -1, progress: -1 },
    };
    this.minimap = options.minimap === false ? null : new Minimap(parent);
    this.screen = new MapScreen(parent, options.world.map, options.input, this.data.viewer);
    this.screen.requestRedraw = () => this.screen.draw(this.data, performance.now());
    this.screen.onOpen = () => {
      this.read();
      this.lastDraw = -Infinity;
    };

    this.ready = renderMapImage(options.world);
    this.ready.then(
      (image) => {
        if (this.disposed) return;
        this.image = image;
        this.screen.setImage(image);
        this.minimap?.setImage(image);
        this.lastDraw = -Infinity;
      },
      (error: unknown) => console.error("[map] map image failed", error),
    );
  }

  get isOpen(): boolean {
    return this.screen.isOpen;
  }

  get imageStats(): MapImage["stats"] | null {
    return this.image?.stats ?? null;
  }

  /** Swaps the data source; null restores the one given at construction. */
  setSource(source: MapViewSource | null): void {
    this.source = source ?? this.defaultSource;
    this.lastDraw = -Infinity;
  }

  set minimapVisible(visible: boolean) {
    if (this.minimap) this.minimap.visible = visible;
  }

  /** Per frame; reads the source and redraws at ≈15 Hz, only while the map or minimap is visible. */
  update(now: number): void {
    const open = this.screen.isOpen;
    const mini = this.minimap?.visible === true;
    if (!open && !mini) return;
    if (now - this.lastDraw < OVERLAY_INTERVAL_MS) return;
    this.lastDraw = now;
    this.read();
    if (open) this.screen.draw(this.data, now);
    if (mini) this.minimap!.draw(this.data, now);
  }

  dispose(): void {
    this.disposed = true;
    this.screen.dispose();
    this.minimap?.dispose();
  }

  private read(): void {
    const { source, data } = this;
    source.readViewer(data.viewer);
    data.teammateCount = source.readTeammates ? source.readTeammates(data.teammates) : 0;
    const zone = data.zone;
    if (source.readZone) {
      source.readZone(zone);
    } else {
      zone.current = null;
      zone.next = null;
      zone.label = "";
      zone.seconds = -1;
      zone.progress = -1;
    }
  }
}
