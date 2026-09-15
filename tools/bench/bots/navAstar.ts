/**
 * A* throughput and result checksum on a map's nav grid: random short and long path requests (with and without cover,
 * zone and avoid options) run through the time-sliced query. Prints µs per expansion and a checksum over every result
 * point, so a nav optimization can be checked for identical paths.
 *
 *   node tools/bench/bots/navAstar.ts [--map vn-hangxanh] [--queries 300] [--seed 1] [--repeat 3]
 *
 * One heavy process at a time. Self-terminates after 5 minutes.
 */
import "../runtime/lib/resolve.ts";
import * as nodeModule from "node:module";

const SHARED_SRC = new URL("../../../packages/shared/src/", import.meta.url);
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@twobullets/shared/")) return { url: new URL(`${specifier.slice("@twobullets/shared/".length)}.ts`, SHARED_SRC).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
setTimeout(() => {
  console.error("[bots/navAstar] watchdog: aborted after 5 minutes");
  process.exit(2);
}, 5 * 60_000).unref();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const mapId = arg("map", "vn-hangxanh");
const queries = Number(arg("queries", "300"));
const seed = Number(arg("seed", "1"));
const repeat = Number(arg("repeat", "3"));

const { loadMap } = await import("./lib/loadMap.ts");
const nav = await import("../../../packages/shared/src/bots/nav/index.ts");
const { hash32 } = await import("../../../packages/shared/src/equipment/math.ts");
type NavPath = import("../../../packages/shared/src/bots/types.ts").NavPath;
type PathOptions = import("../../../packages/shared/src/bots/types.ts").PathOptions;

const { map, terrain, layout } = await loadMap(mapId);
const grid = nav.buildNavGrid({ map, terrain, layout });
const data = nav.asNavGridData(grid);
const scratch = { x: 0, y: 0, z: 0 };
const probe = nav.createNavQuery(grid);
const half = map.terrain.playableHalfExtent * 0.95;

function randomWalkable(k: number): { x: number; y: number; z: number } | null {
  for (let attempt = 0; attempt < 50; attempt++) {
    const x = -half + (hash32(seed, k, attempt) / 4294967296) * 2 * half;
    const z = -half + (hash32(seed, k, attempt + 1000) / 4294967296) * 2 * half;
    const ref = probe.nearest({ x, y: terrain.sampleHeight(x, z), z }, 3, scratch);
    if (ref >= 0 && data.componentOf(ref) === data.layout.mainComponent) return { ...scratch };
  }
  return null;
}

const pairs: { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number }; options: PathOptions | null }[] = [];
for (let k = 0; pairs.length < queries && k < queries * 200; ) {
  const a = randomWalkable(k++);
  const b = randomWalkable(k++);
  if (!a || !b) continue;
  const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
  if (d < 20 || d > 600) continue;
  const variant = pairs.length % 3;
  const options: PathOptions | null =
    variant === 0
      ? null
      : variant === 1
        ? ({ preferCover: 0.8, allowCrouchOnly: true, partial: true } as unknown as PathOptions)
        : ({ zone: { x: a.x, z: a.z, radius: 150 }, avoid: [{ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, radius: 12, cost: 3 }] } as unknown as PathOptions);
  pairs.push({ a, b, options });
}

const bitsView = new DataView(new ArrayBuffer(8));
function bitsOf(v: number): number {
  bitsView.setFloat64(0, v);
  return (bitsView.getUint32(0) ^ bitsView.getUint32(4)) >>> 0;
}

const path: NavPath = { points: new Float32Array(256 * 3), flags: new Uint8Array(256), count: 0, length: 0 };
for (let r = 0; r < repeat; r++) {
  const query = nav.createNavQuery(grid) as InstanceType<typeof nav.GridNavQuery>;
  let checksum = 0;
  let expansions = 0;
  const statuses: Record<string, number> = {};
  const started = performance.now();
  for (const { a, b, options } of pairs) {
    const handle = query.requestPath(a, b, options);
    let status = query.readPath(handle, path);
    while (status === "pending") {
      query.update(1500);
      status = query.readPath(handle, path);
    }
    statuses[status] = (statuses[status] ?? 0) + 1;
    for (let i = 0; i < path.count * 3; i++) checksum = Math.imul(checksum ^ bitsOf(path.points[i]!), 16777619) >>> 0;
    checksum = Math.imul(checksum ^ bitsOf(path.length), 16777619) >>> 0;
    checksum = Math.imul(checksum ^ path.count ^ (path.flags[0]! << 16), 16777619) >>> 0;
    query.releasePath(handle);
  }
  const ms = performance.now() - started;
  expansions = query.expansions;
  console.info(JSON.stringify({ map: mapId, queries: pairs.length, statuses, expansions, ms: Math.round(ms), usPerExpansion: Math.round((ms * 1e6) / expansions) / 1000, checksum }));
}
process.exit(0);
