/**
 * Downloads the raw data for a real-world place, once, into gitignored `assets-src/map/osm/<id>/`:
 * - `overpass.json`: roads, buildings, land use, water, names (Overpass API `out geom`, © OpenStreetMap contributors, ODbL);
 * - `dem/<z>-<x>-<y>.png`: AWS Terrain Tiles (terrarium encoding) covering the terrain square;
 * - `fetch.json`: when, from where, the bbox and the OSM snapshot time.
 *
 *   node --experimental-transform-types tools/map/osm/fetch.ts <placeId> [--refresh]
 *
 * Polite by design: one request at a time, a generic User-Agent with no personal info, at least 5 s between Overpass
 * calls, exponential backoff over the public mirrors on 429/504. Cached files are never re-downloaded unless --refresh.
 */
import "../lib/resolve.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OsmDocument, PlaceConfig } from "../../../packages/shared/src/map/real/convert/types.ts";
import { REPO_ROOT } from "../lib/resolve.ts";

// Shared sources use extensionless imports, which need the resolve hook registered first.
const { bboxAround } = await import("../../../packages/shared/src/map/real/convert/projection.ts");
export const USER_AGENT = "twobullets-dev/0.1";
export const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"] as const;
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
/** Half side of the fetched square, m: the 1280 m terrain plus a margin, so edge roads and woods keep their shape. */
export const FETCH_HALF = 660;
export const DEM_ZOOM = 14;

export function cacheDir(id: string): string {
  return join(REPO_ROOT, "assets-src/map/osm", id);
}

export interface FetchRecord {
  readonly id: string;
  readonly fetchedAt: string;
  readonly endpoint: string;
  readonly bbox: readonly number[];
  readonly osmTimestamp: string | null;
  readonly demTiles: readonly string[];
}

export interface FetchedPlace {
  readonly osm: OsmDocument;
  readonly record: FetchRecord;
  /** Absolute paths of the DEM tiles with their tile coordinates. */
  readonly tiles: readonly { readonly path: string; readonly x: number; readonly y: number; readonly z: number }[];
}

export function overpassQuery(bbox: readonly number[]): string {
  return `[out:json][timeout:120][maxsize:134217728][bbox:${bbox.join(",")}];
(
  way["highway"];
  way["building"];
  relation["building"];
  way["landuse"];
  relation["landuse"];
  way["natural"~"^(wood|water|scrub|grassland|heath|wetland|tree_row|bare_rock)$"];
  relation["natural"~"^(wood|water|scrub|grassland|heath|wetland)$"];
  way["leisure"~"^(park|pitch|garden|recreation_ground)$"];
  way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"];
  relation["waterway"="riverbank"];
  way["amenity"]["name"];
  node["amenity"]["name"];
  node["place"];
  node["historic"]["name"];
  node["tourism"]["name"];
);
out geom qt;`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastOverpassCall = 0;

async function overpass(query: string): Promise<{ json: OsmDocument; endpoint: string }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length]!;
    const wait = lastOverpassCall + 5000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastOverpassCall = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160).replace(/\s+/g, " ")}`);
      const json = (await response.json()) as OsmDocument;
      if (!Array.isArray(json.elements)) throw new Error("response has no elements");
      return { json, endpoint };
    } catch (error) {
      lastError = error;
      const backoff = 5000 * 2 ** attempt;
      console.warn(`[osm] ${endpoint} failed (${String(error).slice(0, 120)}); retrying in ${backoff / 1000} s`);
      await sleep(backoff);
    }
  }
  throw new Error(`Overpass failed after retries: ${String(lastError)}`);
}

/** Slippy-map tile covering a lat/lon at `zoom`. */
export function tileOf(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const rad = (lat * Math.PI) / 180;
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n) };
}

async function download(url: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= 3) throw new Error(`${url}: ${String(error)}`);
      await sleep(2000 * 2 ** attempt);
    }
  }
}

export async function fetchPlace(place: PlaceConfig, options: { refresh?: boolean } = {}): Promise<FetchedPlace> {
  const dir = cacheDir(place.id);
  mkdirSync(join(dir, "dem"), { recursive: true });
  const bbox = bboxAround(place.lat, place.lon, FETCH_HALF);
  const osmPath = join(dir, "overpass.json");
  const recordPath = join(dir, "fetch.json");

  let osm: OsmDocument;
  let endpoint = "cache";
  if (existsSync(osmPath) && !options.refresh) {
    osm = JSON.parse(readFileSync(osmPath, "utf8")) as OsmDocument;
  } else {
    console.info(`[osm] ${place.id}: querying Overpass for bbox ${bbox.join(",")}`);
    const result = await overpass(overpassQuery(bbox));
    osm = result.json;
    endpoint = result.endpoint;
    writeFileSync(osmPath, JSON.stringify(osm));
    console.info(`[osm] ${place.id}: ${osm.elements.length} elements (${(readFileSync(osmPath).length / 1024).toFixed(0)} KB)`);
  }

  // Terrarium tiles over the whole terrain square (the DEM also shapes the border foothills).
  const sw = tileOf(bbox[0], bbox[1], DEM_ZOOM);
  const ne = tileOf(bbox[2], bbox[3], DEM_ZOOM);
  const tiles: { path: string; x: number; y: number; z: number }[] = [];
  for (let x = sw.x; x <= ne.x; x++) {
    for (let y = ne.y; y <= sw.y; y++) {
      const path = join(dir, "dem", `${DEM_ZOOM}-${x}-${y}.png`);
      if (!existsSync(path) || options.refresh) {
        writeFileSync(path, await download(`${TERRARIUM}/${DEM_ZOOM}/${x}/${y}.png`));
        console.info(`[osm] ${place.id}: DEM tile ${DEM_ZOOM}/${x}/${y}`);
        await sleep(300);
      }
      tiles.push({ path, x, y, z: DEM_ZOOM });
    }
  }

  const previous = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as FetchRecord) : null;
  const record: FetchRecord =
    endpoint === "cache" && previous
      ? previous
      : {
          id: place.id,
          fetchedAt: new Date().toISOString(),
          endpoint,
          bbox,
          osmTimestamp: osm.osm3s?.timestamp_osm_base ?? null,
          demTiles: tiles.map((t) => `${t.z}/${t.x}/${t.y}`),
        };
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  return { osm, record, tiles };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setTimeout(() => {
    console.error("[osm] watchdog: fetch took longer than 15 minutes");
    process.exit(2);
  }, 900_000).unref();
  const { findPlace } = await import("./places.ts");
  const id = process.argv[2];
  const place = id ? findPlace(id) : undefined;
  if (!place) {
    console.error(`usage: fetch.ts <placeId> [--refresh]  (known: ${(await import("./places.ts")).PLACES.map((p) => p.id).join(", ")})`);
    process.exit(1);
  }
  const fetched = await fetchPlace(place, { refresh: process.argv.includes("--refresh") });
  console.info(`[osm] ${place.id}: ${fetched.osm.elements.length} elements, ${fetched.tiles.length} DEM tiles, snapshot ${fetched.record.osmTimestamp}`);
  process.exit(0);
}
