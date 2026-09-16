/**
 * Bot navigation bench (docs/bots/design.md §3.4). Builds the Map v1 NavGrid headless and prints:
 *  1. build time per stage, memory (grid bytes + query scratch), cell/span/link/component counts
 *  2. probe reachability from the town square: spawns, POIs, entrances, rooms (upper floors separately), loot spots
 *  3. a POI × POI path matrix (status, length, expansions) through the time-sliced query
 *  4. path queries to every upper-floor room
 *  5. random short (20–150 m) and long (150–800 m) queries: expansions, ms, ticks at 1,500 expansions per tick
 *  6. serialize/deserialize round trip and (with --twice) a second build to confirm the checksum
 *
 *   node tools/bench/bots/nav.ts [--queries=200] [--seed=1] [--twice] [--out=file.json]
 *
 * One heavy process at a time (≈ 200 MB peak including the terrain build).
 */
import "../runtime/lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, memoryMb, parseArgs, round, summarize } = await import("../runtime/lib/stats.ts");
installWatchdog(240_000);
const args = parseArgs({ queries: 200, seed: 1, twice: false, out: "" });

const { MAP_V1 } = await import("../../../packages/shared/src/map/mapV1.ts");
const { buildTerrain } = await import("../../../packages/shared/src/map/terrain/terrain.ts");
const { buildMapLayout } = await import("../../../packages/shared/src/map/layout/mapLayout.ts");
const { hash32 } = await import("../../../packages/shared/src/equipment/math.ts");
const nav = await import("../../../packages/shared/src/bots/nav/index.ts");
type NavPath = import("../../../packages/shared/src/bots/types.ts").NavPath;
type PathOptions = import("../../../packages/shared/src/bots/types.ts").PathOptions;
type PathStatus = import("../../../packages/shared/src/bots/types.ts").PathStatus;

const EXPANSIONS_PER_TICK = 1500;
const log = (...parts: unknown[]) => console.log(...parts);

let t0 = performance.now();
const terrain = buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
const terrainMs = performance.now() - t0;
t0 = performance.now();
const layout = buildMapLayout(MAP_V1, terrain);
const layoutMs = performance.now() - t0;
log(`terrain ${round(terrainMs, 0)} ms, layout ${round(layoutMs, 0)} ms (inputs, not nav)`);

const before = memoryMb();
const grid = nav.buildNavGrid({ map: MAP_V1, terrain, layout });
const after = memoryMb();
const stats = nav.navStats(grid);
const query = nav.createNavQuery(grid) as InstanceType<typeof nav.GridNavQuery>;
const data = nav.asNavGridData(grid);
const scratchBytes = (320 * 320 + data.buildingNodes) * (4 + 4 + 2 + 4 + 4 + 4) + data.arrays.regionRep.length * 22 + 16384 * 4 + 64 * 256 * 13;

log("\n== Build ==");
log(`build ${stats.build!.buildMs} ms`, stats.build!.stageMs);
log(`grid ${stats.megabytes} MB (${grid.info.byteLength} B), query scratch ${round(scratchBytes / 1048576, 2)} MB, arrayBuffers +${round(after.arrayBuffers - before.arrayBuffers, 1)} MB`);
log(`terrain ${grid.info.width}×${grid.info.depth} = ${grid.info.terrainNodes} cells, walkable ${stats.build!.terrainWalkable} (${round((100 * stats.build!.terrainWalkable) / grid.info.terrainNodes, 1)} %), slope-blocked ${stats.build!.terrainSlopeBlocked}, prop-blocked ${stats.build!.terrainPropBlocked}, building-blocked ${stats.build!.terrainBuildingBlocked}`);
log(`buildings: ${data.layers.length} prefab layers, ${stats.build!.prefabSpans} prefab spans, ${grid.info.buildingNodes} placed spans (${stats.build!.buildingWalkable} walkable), ${stats.build!.links} links, overflow columns ${stats.build!.overflowColumns}`);
log(`components ${grid.info.components}, main #${stats.build!.mainComponent} ${round(stats.build!.mainComponentArea / 1e6, 3)} km², islands cleared ${stats.build!.clearedIslands} (${stats.build!.clearedIslandArea} m²)`);
log(`coarse ${data.layout.coarseWidth}×${data.layout.coarseDepth}, checksum ${grid.info.checksum}`);
for (const layer of data.layers) {
  let walk = 0;
  let crouch = 0;
  let stairs = 0;
  let door = 0;
  for (let k = 0; k < layer.spanFlags.length; k++) {
    const f = layer.spanFlags[k]!;
    if (f & 1) walk++;
    if (f & 2) crouch++;
    if (f & 32) stairs++;
    if (f & 64) door++;
  }
  log(`  ${layer.prefab.padEnd(20)} ${layer.cols}×${layer.rows} cols, spans ${layer.spanY.length}, crouch ${crouch}, stairs ${stairs}, door ${door}`);
}

const { auditBuildingLinks } = await import("../../../packages/shared/src/bots/nav/linkAudit.ts");
const violations = auditBuildingLinks(grid);
log(`link audit (controller capsule sweep): ${violations.length} links through walls${violations.length ? `: ${JSON.stringify(violations.slice(0, 5))}` : ""}`);

// Probes.
const probes = nav.mapNavProbes(MAP_V1, terrain, layout);
const scratch = { x: 0, y: 0, z: 0 };
const town = query.nearest({ x: 0, y: terrain.sampleHeight(0, 20), z: 20 }, 5, scratch);
const results = nav.resolveProbes(query, probes, town);
log("\n== Reachability from the town square ==");
const byKind = new Map<string, { total: number; snapped: number; reachable: number; failures: string[] }>();
for (const r of results) {
  const key = r.probe.kind + (r.probe.upper ? " (upper)" : "");
  let entry = byKind.get(key);
  if (!entry) byKind.set(key, (entry = { total: 0, snapped: 0, reachable: 0, failures: [] }));
  entry.total++;
  if (r.ref >= 0) entry.snapped++;
  if (r.reachable) entry.reachable++;
  else entry.failures.push(`${r.probe.name}${r.ref < 0 ? " (no node)" : ` (comp ${query.flagsAt(r.ref) & 2 ? "crouch " : ""}${data.componentOf(r.ref)})`}`);
}
for (const [kind, e] of byKind) {
  log(`${kind.padEnd(16)} ${e.reachable}/${e.total} reachable (${e.snapped} snapped)${e.failures.length ? `\n    missing: ${e.failures.slice(0, 40).join(", ")}${e.failures.length > 40 ? ` … +${e.failures.length - 40}` : ""}` : ""}`);
}

const path: NavPath = { points: new Float32Array(256 * 3), flags: new Uint8Array(256), count: 0, length: 0 };
function runPath(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, options: PathOptions | null) {
  const expansionsBefore = query.expansions;
  const started = performance.now();
  const handle = query.requestPath(from, to, options);
  let ticks = 0;
  let status: PathStatus = query.readPath(handle, path);
  while (status === "pending" && ticks < 100_000) {
    query.update(EXPANSIONS_PER_TICK);
    ticks++;
    status = query.readPath(handle, path);
  }
  const ms = performance.now() - started;
  const result = { status, length: path.length, points: path.count, ticks, ms, expansions: query.expansions - expansionsBefore, maxY: 0, flags: 0 };
  if (status === "found" || status === "partial") {
    for (let i = 0; i < path.count; i++) {
      result.maxY = Math.max(result.maxY, path.points[i * 3 + 1]!);
      result.flags |= path.flags[i]!;
    }
  }
  query.releasePath(handle);
  return result;
}

log("\n== POI path matrix (status / length m / expansions) ==");
const poiProbes = results.filter((r) => r.probe.kind === "poi");
const matrix: Record<string, Record<string, string>> = {};
for (const a of poiProbes) {
  const row: Record<string, string> = {};
  for (const b of poiProbes) {
    if (a === b) {
      row[b.probe.poi!] = "-";
      continue;
    }
    const r = runPath(a.probe, b.probe, null);
    row[b.probe.poi!] = `${r.status[0]}/${round(r.length, 0)}/${r.expansions}`;
  }
  matrix[a.probe.poi!] = row;
}
console.table(matrix);

log("\n== Upper floors (path from the building's POI center) ==");
const upperRooms = results.filter((r) => r.probe.kind === "room" && r.probe.upper);
const upperResults: Record<string, unknown>[] = [];
for (const r of upperRooms) {
  const origin = poiProbes.find((p) => p.probe.poi === r.probe.poi) ?? poiProbes[0]!;
  const res = runPath(origin.probe, r.probe, null);
  upperResults.push({ room: r.probe.name, status: res.status, length: round(res.length, 1), topY: round(res.maxY - r.probe.y, 2), stairs: (res.flags & 32) !== 0, door: (res.flags & 64) !== 0, expansions: res.expansions });
}
console.table(upperResults);

log("\n== Random queries ==");
function randomWalkable(k: number): { x: number; y: number; z: number } | null {
  for (let attempt = 0; attempt < 50; attempt++) {
    const x = -240 + (hash32(Number(args.seed), k, attempt) / 4294967296) * 480;
    const z = -240 + (hash32(Number(args.seed), k, attempt + 1000) / 4294967296) * 480;
    const ref = query.nearest({ x, y: terrain.sampleHeight(x, z), z }, 3, scratch);
    if (ref >= 0 && data.componentOf(ref) === data.layout.mainComponent) return { ...scratch };
  }
  return null;
}
const bands = [
  { name: "short 20-100 m", min: 20, max: 100 },
  { name: "long 100-450 m", min: 100, max: 450 },
];
const report: Record<string, unknown> = {};
for (const band of bands) {
  const expansions: number[] = [];
  const ms: number[] = [];
  const ticks: number[] = [];
  const points: number[] = [];
  const statuses: Record<string, number> = {};
  let k = 0;
  let done = 0;
  while (done < Number(args.queries) && k < Number(args.queries) * 200) {
    const a = randomWalkable(k++);
    const b = randomWalkable(k++);
    if (!a || !b) continue;
    const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
    if (d < band.min || d > band.max) continue;
    const r = runPath(a, b, null);
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    expansions.push(r.expansions);
    ms.push(r.ms);
    ticks.push(r.ticks);
    points.push(r.points);
    done++;
  }
  const summary = { queries: done, statuses, expansions: summarize(expansions), ms: summarize(ms), ticks: summarize(ticks), points: summarize(points), usPerExpansion: round((1000 * ms.reduce((s, v) => s + v, 0)) / Math.max(1, expansions.reduce((s, v) => s + v, 0)), 3) };
  report[band.name] = summary;
  log(band.name, JSON.stringify({ ...summary, expansions: pick(summary.expansions), ms: pick(summary.ms), ticks: pick(summary.ticks), points: pick(summary.points) }));
}

function pick(s: { p50: number; p95: number; max: number }) {
  return { p50: round(s.p50, 2), p95: round(s.p95, 2), max: round(s.max, 2) };
}

log("\n== Serialize ==");
t0 = performance.now();
const bytes = nav.serializeNavGrid(grid);
const serMs = performance.now() - t0;
t0 = performance.now();
const restored = nav.deserializeNavGrid(bytes);
log(`${round(bytes.byteLength / 1048576, 2)} MB, serialize ${round(serMs, 0)} ms, deserialize+verify ${round(performance.now() - t0, 0)} ms, checksum ${restored.info.checksum === grid.info.checksum ? "match" : "MISMATCH"}`);

if (args.twice) {
  const second = nav.buildNavGrid({ map: MAP_V1, terrain, layout });
  log(`second build ${nav.navStats(second).build!.buildMs} ms, checksum ${second.info.checksum === grid.info.checksum ? "match" : "MISMATCH"}`);
}
log("memory", memoryMb());

if (args.out) {
  writeFileSync(String(args.out), JSON.stringify({ build: stats, probes: Object.fromEntries(byKind), matrix, upper: upperResults, random: report }, null, 2));
  log(`wrote ${args.out}`);
}
