/**
 * Per-call cost of Havok queries through Babylon's HavokPlugin wrappers vs raw HP_* calls, on the same benchmark
 * world (built by BabylonMatch, so the broadphase contents are identical for both paths):
 *   - segment raycast (10 m bullet segment, mix of hits and misses)
 *   - capsule shape cast (ground-snap style, 0.4 m down)
 *   - kinematic body teleport (TransformNode + prestep vs HP_Body_SetQTransform)
 *   - an empty HP call (HP_QueryCollector_GetNumHits) = embind crossing floor
 *
 *   node tools/bench/runtime/havok-queries.ts [--calls=20000] [--batches=20]
 * (BabylonMatch now loads packages/sim, which is erasable-syntax only, so plain type stripping is enough.)
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, machineInfo, parseArgs, round, summarize, createRng } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ calls: 20_000, batches: 20, out: "" });
const { DEFAULT_SCENARIO, LAYER, BULLET_COLLIDE, TOWNS, terrainHeight } = await import("./lib/scenario.ts");
const { BabylonMatch } = await import("./lib/babylonMatch.ts");

const match = new BabylonMatch(DEFAULT_SCENARIO, false);
await match.setup();
const out = new Float64Array(5);
for (let i = 0; i < 120; i++) match.tick(out);

/* eslint-disable @typescript-eslint/no-explicit-any */
const m = match as any;
const B = m.B;
const scene = m.scene;
const plugin = scene.getPhysicsEngine().getPhysicsPlugin();
const hk = plugin._hknp;
const world = plugin.world;
const rng = createRng(99);

// Query inputs: segments in towns at chest height, random direction, 10 m long (a 600 m/s bullet at 60 Hz).
const N = 1024;
const seg = new Float64Array(N * 6);
for (let i = 0; i < N; i++) {
  const [tx, tz] = TOWNS[i % TOWNS.length]!;
  const x = tx + (rng() - 0.5) * 160;
  const z = tz + (rng() - 0.5) * 160;
  const y = terrainHeight(x, z) + 1.3;
  const a = rng() * Math.PI * 2;
  seg.set([x, y, z, x + Math.sin(a) * 10, y + (rng() - 0.5), z + Math.cos(a) * 10], i * 6);
}

function bench(name: string, fn: (i: number) => void, calls = Number(args.calls)): ReturnType<typeof summarize> {
  for (let i = 0; i < calls; i++) fn(i);
  const samples: number[] = [];
  let k = 0;
  for (let b = 0; b < Number(args.batches); b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < calls; i++) fn(k++);
    samples.push(Number(process.hrtime.bigint() - t0) / calls);
  }
  const s = summarize(samples);
  console.error(`${name}: ${round(s.p50, 0)} ns/call (p95 ${round(s.p95, 0)})`);
  return s;
}

const results: Record<string, unknown> = {};
let hits = 0;

// Raycast via plugin (what HavokRaycaster does).
{
  const from = new B.Vector3();
  const to = new B.Vector3();
  const result = new B.PhysicsRaycastResult();
  const query = { membership: LAYER.bulletQuery, collideWith: BULLET_COLLIDE, shouldHitTriggers: true };
  results.raycastPlugin = bench("raycast: HavokPlugin.raycast", (i) => {
    const o = (i & (N - 1)) * 6;
    from.set(seg[o], seg[o + 1], seg[o + 2]);
    to.set(seg[o + 3], seg[o + 4], seg[o + 5]);
    plugin.raycast(from, to, result, query);
    if (result.hasHit) hits++;
  });
  console.error(`  hit rate ${round(hits / (Number(args.calls) * (Number(args.batches) + 1)), 3)}`);
}
// Raycast direct.
{
  const collector = hk.HP_QueryCollector_Create(1)[1];
  const f = [0, 0, 0];
  const t = [0, 0, 0];
  const q = [f, t, [LAYER.bulletQuery, BULLET_COLLIDE], true, [BigInt(0)]];
  results.raycastDirect = bench("raycast: HP_World_CastRayWithCollector (+ read hit)", (i) => {
    const o = (i & (N - 1)) * 6;
    f[0] = seg[o]!;
    f[1] = seg[o + 1]!;
    f[2] = seg[o + 2]!;
    t[0] = seg[o + 3]!;
    t[1] = seg[o + 4]!;
    t[2] = seg[o + 5]!;
    hk.HP_World_CastRayWithCollector(world, collector, q);
    if (hk.HP_QueryCollector_GetNumHits(collector)[1] > 0) hk.HP_QueryCollector_GetCastRayResult(collector, 0);
  });
}
// Shape cast via plugin (CharacterBody.snapToGround).
{
  const shape = new B.PhysicsShapeCapsule(new B.Vector3(0, 0.55, 0), new B.Vector3(0, -0.55, 0), 0.35, scene);
  shape.filterMembershipMask = LAYER.player;
  shape.filterCollideMask = LAYER.world | LAYER.player;
  const castInput = new B.ShapeCastResult();
  const castHit = new B.ShapeCastResult();
  const start = new B.Vector3();
  const end = new B.Vector3();
  const rotation = B.Quaternion.Identity();
  const query = { shape, rotation, startPosition: start, endPosition: end, shouldHitTriggers: false };
  results.shapeCastPlugin = bench("capsule cast: HavokPlugin.shapeCast", (i) => {
    const o = (i & (N - 1)) * 6;
    start.set(seg[o], seg[o + 1]! - 0.35, seg[o + 2]);
    end.set(seg[o], seg[o + 1]! - 0.75, seg[o + 2]);
    plugin.shapeCast(query, castInput, castHit);
  });
  const collector = hk.HP_QueryCollector_Create(1)[1];
  const s = [0, 0, 0];
  const e = [0, 0, 0];
  const q = [shape._pluginData, [0, 0, 0, 1], s, e, false, [BigInt(0)]];
  results.shapeCastDirect = bench("capsule cast: HP_World_ShapeCastWithCollector (+ read hit)", (i) => {
    const o = (i & (N - 1)) * 6;
    s[0] = seg[o]!;
    s[1] = seg[o + 1]! - 0.35;
    s[2] = seg[o + 2]!;
    e[0] = seg[o]!;
    e[1] = seg[o + 1]! - 0.75;
    e[2] = seg[o + 2]!;
    hk.HP_World_ShapeCastWithCollector(world, collector, q);
    if (hk.HP_QueryCollector_GetNumHits(collector)[1] > 0) hk.HP_QueryCollector_GetShapeCastResult(collector, 0);
  });
}
// Teleport one kinematic hitbox body.
{
  const node = m.players[0].hitboxes[0];
  const body = node.physicsBody;
  results.teleportPrestep = bench("teleport: node.position + plugin.setPhysicsBodyTransformation (prestep)", (i) => {
    node.position.set(seg[(i & (N - 1)) * 6], 5, 0);
    plugin.setPhysicsBodyTransformation(body, node);
  });
  const id = body._pluginData.hpBodyId;
  const tr = [[0, 0, 0], [0, 0, 0, 1]];
  results.teleportDirect = bench("teleport: HP_Body_SetQTransform", (i) => {
    tr[0]![0] = seg[(i & (N - 1)) * 6]!;
    tr[0]![1] = 5;
    hk.HP_Body_SetQTransform(id, tr);
  });
  const collector = hk.HP_QueryCollector_Create(1)[1];
  results.embindFloor = bench("embind floor: HP_QueryCollector_GetNumHits", () => {
    hk.HP_QueryCollector_GetNumHits(collector);
  });
}
// A world step with nothing moving (bodies are asleep/unchanged).
{
  results.worldStepIdle = bench("HP_World_Step (idle world)", () => hk.HP_World_Step(world, 1 / 60), 500);
}

const report = { benchmark: "havok-queries", date: new Date().toISOString(), machine: machineInfo(), args, results };
if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
