import { decodeTerrainBake } from "../terrain/bake";
import { Terrain, buildTerrain, type TerrainSnapshot } from "../terrain/terrain";
import type { MapData } from "../types";
import { buildMapLayout, type MapLayout } from "./mapLayout";

export type MapWorldStage = "download" | "decode" | "generate" | "layout";

export interface MapWorldOptions {
  /** Baked terrain (see terrain/bake.ts). Missing, unreachable or stale bakes fall back to generating. */
  readonly bakeUrl?: string;
  readonly onProgress?: (stage: MapWorldStage, fraction: number) => void;
}

/** A map's built terrain and resolved layout, plus where the terrain came from. */
export interface MapWorld {
  readonly terrain: Terrain;
  readonly layout: MapLayout;
  readonly terrainSource: "bake" | "generated";
  /** Why the bake wasn't used, when it wasn't. */
  readonly bakeProblem?: string;
  /** Milliseconds per stage. */
  readonly timings: Readonly<Partial<Record<MapWorldStage, number>>>;
}

/** Everything a map needs before the engine touches it. Pure and async; runs in a worker, on a main thread or in Node. */
export async function buildMapWorld(map: MapData, options: MapWorldOptions = {}): Promise<MapWorld> {
  const report = options.onProgress ?? (() => {});
  const timings: Partial<Record<MapWorldStage, number>> = {};
  let terrain: Terrain | null = null;
  let bakeProblem: string | undefined;

  if (options.bakeUrl) {
    try {
      let started = performance.now();
      const bytes = await download(options.bakeUrl, (fraction) => report("download", fraction));
      timings.download = performance.now() - started;
      report("decode", 0);
      started = performance.now();
      const result = await decodeTerrainBake(bytes, map.terrain, map.flatten);
      timings.decode = performance.now() - started;
      if (result.ok) terrain = result.terrain;
      else bakeProblem = result.reason;
    } catch (error) {
      bakeProblem = error instanceof Error ? error.message : String(error);
    }
  }

  if (!terrain) {
    const started = performance.now();
    terrain = buildTerrain(map.terrain, map.flatten, { onProgress: (fraction) => report("generate", fraction) });
    timings.generate = performance.now() - started;
  }

  report("layout", 0);
  const started = performance.now();
  const layout = buildMapLayout(map, terrain);
  timings.layout = performance.now() - started;
  report("layout", 1);
  return { terrain, layout, terrainSource: bakeProblem === undefined && options.bakeUrl ? "bake" : "generated", ...(bakeProblem ? { bakeProblem } : {}), timings };
}

async function download(url: string, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  // content-length is the transfer size; with HTTP compression the body is larger, so progress is clamped.
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body || total === 0) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push(chunk.value);
    received += chunk.value.length;
    onProgress(Math.min(1, received / total));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Worker transport
// ---------------------------------------------------------------------------------------------------------------

export interface MapWorldRequest {
  readonly map: MapData;
  readonly bakeUrl?: string;
}

export type MapWorldMessage =
  | { readonly type: "progress"; readonly stage: MapWorldStage; readonly fraction: number }
  | {
      readonly type: "done";
      readonly snapshot: TerrainSnapshot;
      readonly layout: MapLayout;
      readonly terrainSource: MapWorld["terrainSource"];
      readonly bakeProblem?: string;
      readonly timings: MapWorld["timings"];
    }
  | { readonly type: "error"; readonly message: string };

/** Worker side: builds the world and posts it back with every large array transferred (see mapWorker.ts). */
export async function serveMapWorld(request: MapWorldRequest, post: (message: MapWorldMessage, transfer: Transferable[]) => void): Promise<void> {
  try {
    const world = await buildMapWorld(request.map, {
      ...(request.bakeUrl ? { bakeUrl: request.bakeUrl } : {}),
      onProgress: (stage, fraction) => post({ type: "progress", stage, fraction }, []),
    });
    const snapshot = world.terrain.snapshot();
    const transfer = [snapshot.heights.buffer, snapshot.weights.buffer, snapshot.paint.buffer, ...world.layout.props.map((set) => set.data.buffer)] as Transferable[];
    post({ type: "done", snapshot, layout: world.layout, terrainSource: world.terrainSource, ...(world.bakeProblem ? { bakeProblem: world.bakeProblem } : {}), timings: world.timings }, transfer);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) }, []);
  }
}

/**
 * Browser entry: builds the map world in a module worker so the main thread keeps rendering the loading screen, then
 * rebuilds the Terrain around the transferred arrays. Falls back to the calling thread where workers aren't available.
 */
export function loadMapWorld(map: MapData, options: MapWorldOptions = {}): Promise<MapWorld> {
  if (typeof Worker === "undefined") return buildMapWorld(map, options);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mapWorker.ts", import.meta.url), { type: "module", name: "map-world" });
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<MapWorldMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        options.onProgress?.(message.stage, message.fraction);
      } else if (message.type === "done") {
        finish();
        resolve({
          terrain: Terrain.fromSnapshot(map.terrain, message.snapshot),
          layout: message.layout,
          terrainSource: message.terrainSource,
          ...(message.bakeProblem ? { bakeProblem: message.bakeProblem } : {}),
          timings: message.timings,
        });
      } else {
        finish();
        reject(new Error(`map worker: ${message.message}`));
      }
    };
    worker.onerror = (event) => {
      finish();
      console.warn(`[map] worker failed (${event.message}); building on the main thread`);
      buildMapWorld(map, options).then(resolve, reject);
    };
    const request: MapWorldRequest = { map, ...(options.bakeUrl ? { bakeUrl: new URL(options.bakeUrl, globalThis.location?.href).href } : {}) };
    worker.postMessage(request);
  });
}
