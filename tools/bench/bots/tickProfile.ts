/**
 * Per-tick CPU breakdown of a headless MatchSim on any map (the offline match's sim cost without rendering): brains,
 * nav.update, bot character bodies, Havok queries (raycasts and shape casts, inside and outside brains), loot queries,
 * and the rest of the tick. Optionally also times a Havok world step with the match's bodies plus client-like bone hitbox
 * triggers (what the browser's `scene.render` physics step pays).
 *
 *   node tools/bench/bots/tickProfile.ts [--map vn-hangxanh] [--players 20] [--teams duo] [--difficulty normal] [--seed 1]
 *        [--skip 900] [--ticks 1800] [--loadout starting|armed|empty] [--physics 1] [--fast 1] [--statics 0] [--out file.json]
 *
 * `--fast 0` turns off CharacterBody's bit-identical shortcuts (the before/after baseline; `checksum` must match).
 * `--statics N` adds N static boxes to the world-step bench to see how the step scales with static bodies.
 *
 * Skips `--skip` ticks of combat first (bots looting and moving out), then measures `--ticks`. Add `node --cpu-prof` for
 * hot functions. One heavy process at a time; check `sysctl vm.swapusage` first. Self-terminates after 10 minutes.
 */
import "../runtime/lib/resolve.ts";
import { existsSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

const SHARED_SRC = new URL("../../../packages/shared/src/", import.meta.url);
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@twobullets/shared/")) return { url: new URL(`${specifier.slice("@twobullets/shared/".length)}.ts`, SHARED_SRC).href, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.includes("/packages/sim/test/")) {
      const base = new URL(specifier, context.parentURL);
      return nextResolve(existsSync(fileURLToPath(`${base.href}.ts`)) ? `${specifier}.ts` : `${specifier}/index.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

setTimeout(() => {
  console.error("[bots/tickProfile] watchdog: aborted after 10 minutes");
  process.exit(2);
}, 10 * 60_000).unref();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const mapId = arg("map", "vn-hangxanh");
const players = Number(arg("players", "20"));
const teamMode = arg("teams", "duo") as "solo" | "duo" | "squad";
const difficulty = arg("difficulty", "normal") as "easy" | "normal" | "hard";
const seed = Number(arg("seed", "1"));
const skip = Number(arg("skip", "900"));
const measure = Number(arg("ticks", "1800"));
const loadout = arg("loadout", "starting") as "starting" | "armed" | "empty";
const physics = arg("physics", "1") !== "0";
const fastPaths = arg("fast", "1") !== "0";
const out = arg("out", "");
const extraStatics = Number(arg("statics", "0"));

const { loadHavok } = await import("../../../packages/sim/src/node/loadHavok.ts");
const { CharacterBody } = await import("../../../packages/sim/src/CharacterBody.ts");
const { HavokPlugin } = await import("@babylonjs/core/Physics/v2/Plugins/havokPlugin.js");
const { createBotBrain } = (await import("@twobullets/shared/bots/brain/brain")) as typeof import("../../../packages/shared/src/bots/brain/brain.ts");
const mapMatch = await import("./lib/mapMatch.ts");
CharacterBody.fastPaths = fastPaths;

type BotBrainFactory = import("@twobullets/shared/bots/types").BotBrainFactory;
type BotWorldView = import("@twobullets/shared/bots/types").BotWorldView;

// ---- Instrumentation --------------------------------------------------------------------------------------------

const acc = { brain: 0, body: 0, rayIn: 0, rayOut: 0, raysIn: 0, raysOut: 0, castIn: 0, castOut: 0, castsIn: 0, castsOut: 0, loot: 0, loots: 0, nav: 0, navCalls: 0, path: 0, paths: 0 };
let inBrain = false;

const bodyProto = CharacterBody.prototype as unknown as { step: (...a: unknown[]) => unknown };
const originalStep = bodyProto.step;
bodyProto.step = function (this: unknown, ...a: unknown[]) {
  const t = performance.now();
  const r = originalStep.apply(this, a);
  acc.body += performance.now() - t;
  return r;
};
const pluginProto = HavokPlugin.prototype as unknown as { raycast: (...a: unknown[]) => unknown; shapeCast: (...a: unknown[]) => unknown };
const originalRaycast = pluginProto.raycast;
pluginProto.raycast = function (this: unknown, ...a: unknown[]) {
  const t = performance.now();
  const r = originalRaycast.apply(this, a);
  const dt = performance.now() - t;
  if (inBrain) {
    acc.rayIn += dt;
    acc.raysIn++;
  } else {
    acc.rayOut += dt;
    acc.raysOut++;
  }
  return r;
};
const originalShapeCast = pluginProto.shapeCast;
pluginProto.shapeCast = function (this: unknown, ...a: unknown[]) {
  const t = performance.now();
  const r = originalShapeCast.apply(this, a);
  const dt = performance.now() - t;
  if (inBrain) {
    acc.castIn += dt;
    acc.castsIn++;
  } else {
    acc.castOut += dt;
    acc.castsOut++;
  }
  return r;
};

const wrappedViews = new WeakSet<object>();
function instrumentView(view: BotWorldView): void {
  if (wrappedViews.has(view)) return;
  wrappedViews.add(view);
  const mutable = view as { -readonly [K in keyof BotWorldView]: BotWorldView[K] };
  const queryLoot = view.queryLoot;
  mutable.queryLoot = (center, radius, list) => {
    const t = performance.now();
    const n = queryLoot(center, radius, list);
    acc.loot += performance.now() - t;
    acc.loots++;
    return n;
  };
  const nav = view.nav;
  const timed = <K extends keyof typeof nav>(key: K, path = false) =>
    ((...a: unknown[]) => {
      const t = performance.now();
      const r = (nav[key] as (...a: unknown[]) => unknown).apply(nav, a);
      const dt = performance.now() - t;
      if (path) {
        acc.path += dt;
        acc.paths++;
      } else {
        acc.nav += dt;
        acc.navCalls++;
      }
      return r;
    }) as (typeof nav)[K];
  mutable.nav = {
    grid: nav.grid,
    nearest: timed("nearest"),
    flagsAt: nav.flagsAt.bind(nav),
    reachable: nav.reachable.bind(nav),
    lineWalkable: timed("lineWalkable"),
    requestPath: timed("requestPath", true),
    readPath: nav.readPath.bind(nav),
    releasePath: nav.releasePath.bind(nav),
    update: nav.update.bind(nav),
    sampleRing: timed("sampleRing"),
  };
}

const brains: BotBrainFactory = (options) => {
  const brain = createBotBrain(options);
  const tick = brain.tick.bind(brain);
  brain.tick = (view, output) => {
    instrumentView(view);
    inBrain = true;
    const t = performance.now();
    tick(view, output);
    acc.brain += performance.now() - t;
    inBrain = false;
  };
  return brain;
};

// ---- Match ------------------------------------------------------------------------------------------------------

const havok = await loadHavok();
const loaded = await mapMatch.loadMap(mapId);
const match = await mapMatch.createMapHeadlessMatch(havok, mapId, { seed, brains, difficulty, loadout, profile: true, config: { maxPlayers: players, teamMode } });
const { sim, world } = match;
const stats = world.collision.stats;
console.info(`[tickProfile] ${mapId}: ${loaded.layout.buildings.length} buildings, ${stats.propBodies} prop bodies in ${stats.propShapes} shapes, loot ${match.ground.items.size}, nav ${match.navMs.toFixed(0)} ms`);

let guard = 0;
while (sim.state.phase !== "combat" && guard++ < 100_000) sim.tick();
for (let i = 0; i < skip; i++) sim.tick();
for (const key of Object.keys(acc) as (keyof typeof acc)[]) acc[key] = 0;
const navPort = (sim as unknown as { ports: { nav: { expansions?: number } } }).ports.nav;
const expansionsBefore = navPort.expansions ?? 0;

const tickTimes: number[] = [];
const brainPhaseTimes: number[] = [];
const brainTimes: number[] = [];
let brainPhase = 0;
const wall = performance.now();
for (let i = 0; i < measure && !sim.finished; i++) {
  const t = performance.now();
  const brainBefore = acc.brain;
  sim.tick();
  tickTimes.push(performance.now() - t);
  brainPhase += sim.stats.brainMs;
  brainPhaseTimes.push(sim.stats.brainMs);
  brainTimes.push(acc.brain - brainBefore);
}
const wallMs = performance.now() - wall;
const n = tickTimes.length;
const sorted = [...tickTimes].sort((a, b) => a - b);
const per = (v: number) => Math.round((v / n) * 1000) / 1000;
const alive = sim.state.actors.filter((a) => a && a.life !== "dead").length;
const result: Record<string, unknown> = {
  map: mapId,
  players,
  teamMode,
  difficulty,
  seed,
  loadout,
  ticks: n,
  aliveAtEnd: alive,
  shots: sim.stats.shots,
  tickMs: { mean: per(wallMs), p50: round(sorted[Math.floor(n * 0.5)]!), p95: round(sorted[Math.floor(n * 0.95)]!), p99: round(sorted[Math.floor(n * 0.99)]!), max: round(sorted[n - 1]!) },
  brainPhaseMs: percentiles(brainPhaseTimes),
  brainsOnlyMs: percentiles(brainTimes),
  navUpdateMs: percentiles(brainPhaseTimes.map((v, i) => v - brainTimes[i]!)),
  perTickMs: {
    brainPhase: per(brainPhase),
    brains: per(acc.brain),
    navUpdate: per(brainPhase - acc.brain),
    bodies: per(acc.body),
    rest: per(wallMs - brainPhase - acc.body),
    brainRaycasts: per(acc.rayIn),
    brainShapeCasts: per(acc.castIn),
    brainLootQueries: per(acc.loot),
    brainNavQueries: per(acc.nav),
    brainPathRequests: per(acc.path),
    simRaycasts: per(acc.rayOut),
    simShapeCasts: per(acc.castOut),
  },
  perTickCount: {
    navExpansions: per(((navPort.expansions ?? 0) - expansionsBefore) * 1000) / 1000,
    brainRaycasts: per(acc.raysIn),
    brainShapeCasts: per(acc.castsIn),
    lootQueries: per(acc.loots),
    navQueries: per(acc.navCalls),
    pathRequests: per(acc.paths),
    simRaycasts: per(acc.raysOut),
    simShapeCasts: per(acc.castsOut),
  },
};

{
  let restSkips = 0;
  let proximityQueries = 0;
  let proximitySkipped = 0;
  for (const actor of sim.state.actors) {
    const body = actor ? (sim.bodyOf(actor.slot) as InstanceType<typeof CharacterBody> | null) : null;
    if (!body) continue;
    const q = body.queryStats;
    restSkips += q.restSkips;
    proximityQueries += q.proximityQueries;
    proximitySkipped += q.proximitySkipped;
  }
  result.fastPaths = fastPaths;
  result.bodyQueries = { restSkipsTotal: restSkips, proximityQueriesTotal: proximityQueries, proximitySkippedTotal: proximitySkipped };
  result.checksum = sim.state.actors.reduce((h, a) => (a ? h + a.feet.x * 1.1 + a.feet.y * 2.3 + a.feet.z * 3.7 + a.health : h), 0);
}

// ---- Havok world step (what the client's scene.render pays) ------------------------------------------------------

if (physics) result.worldStepMs = await benchWorldStep();

console.info(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
match.dispose();
process.exit(0);

function percentiles(values: number[]): { p50: number; p95: number; p99: number; max: number } {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => round(v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(v.at(-1) ?? 0) };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

async function benchWorldStep(): Promise<Record<string, number>> {
  const { TransformNode } = await import("@babylonjs/core/Meshes/transformNode.js");
  const { Quaternion, Vector3 } = await import("@babylonjs/core/Maths/math.vector.js");
  const { PhysicsBody } = await import("@babylonjs/core/Physics/v2/physicsBody.js");
  const { PhysicsMotionType } = await import("@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js");
  const { PhysicsShapeBox, PhysicsShapeCapsule } = await import("@babylonjs/core/Physics/v2/physicsShape.js");
  const { CollisionLayer } = await import("../../../packages/sim/src/collisionLayers.ts");
  const scene = world.scene;
  const engine = scene.getPhysicsEngine()! as unknown as { _step(delta: number): void };
  const time = (steps: number, before?: () => void) => {
    for (let i = 0; i < 30; i++) {
      before?.();
      engine._step(1 / 60);
    }
    const t = performance.now();
    for (let i = 0; i < steps; i++) {
      before?.();
      engine._step(1 / 60);
    }
    return round((performance.now() - t) / steps);
  };
  const steps = 300;
  const withBodies = time(steps);
  // Client-like bone hitboxes: 13 animated trigger bodies per living bot, inside its capsule, teleported every step.
  const hitboxes: { node: InstanceType<typeof TransformNode>; slot: number; dy: number; body: InstanceType<typeof PhysicsBody> }[] = [];
  const shapes: InstanceType<typeof PhysicsShapeBox>[] = [];
  const living = sim.state.actors.filter((a) => a && a.life !== "dead");
  for (const actor of living) {
    for (let k = 0; k < 13; k++) {
      const shape = k % 2 === 0 ? new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(0.3, 0.2, 0.3), scene) : new PhysicsShapeCapsule(new Vector3(0, -0.15, 0), new Vector3(0, 0.15, 0), 0.07, scene);
      shape.isTrigger = true;
      shape.filterMembershipMask = CollisionLayer.hitbox;
      const node = new TransformNode(`hb_${actor.slot}_${k}`, scene);
      node.rotationQuaternion = Quaternion.Identity();
      const dy = 0.1 + (k / 13) * 1.6;
      node.position.set(actor.feet.x, actor.feet.y + dy, actor.feet.z);
      const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
      body.shape = shape;
      body.disablePreStep = false;
      body.disableSync = true;
      hitboxes.push({ node, slot: actor.slot, dy, body });
      shapes.push(shape as InstanceType<typeof PhysicsShapeBox>);
    }
  }
  const follow = () => {
    for (const h of hitboxes) {
      const a = sim.state.actors[h.slot]!;
      h.node.position.set(a.feet.x, a.feet.y + h.dy, a.feet.z);
    }
  };
  const withHitboxes = time(steps, follow);
  // Capsules that don't pair with hitbox triggers in the world step (queries never hit triggers either way).
  const capsuleMasks: { shape: { filterCollideMask: number }; mask: number }[] = [];
  for (const actor of living) {
    const body = sim.bodyOf(actor.slot) as unknown as { capsules: Record<string, { filterCollideMask: number }> } | null;
    if (!body) continue;
    for (const shape of Object.values(body.capsules)) {
      capsuleMasks.push({ shape, mask: shape.filterCollideMask });
      shape.filterCollideMask = shape.filterCollideMask & ~CollisionLayer.hitbox;
    }
  }
  const capsulesSkipHitboxes = time(steps, follow);
  for (const { shape, mask } of capsuleMasks) shape.filterCollideMask = mask;
  for (const s of shapes) s.filterCollideMask = 0;
  const hitboxesNoCollide = time(steps, follow);
  for (const h of hitboxes) {
    h.body.dispose();
    h.node.dispose();
  }
  for (const s of shapes) s.dispose();
  const bodiesOnly = time(steps);
  const result: Record<string, number> = { characterBodies: withBodies, withHitboxTriggers: withHitboxes, capsulesSkipHitboxes, hitboxCollideMask0: hitboxesNoCollide, afterRemovingHitboxes: bodiesOnly, hitboxBodies: hitboxes.length };
  if (extraStatics > 0) {
    // Does the step scale with static bodies? Extra thin-instanced static boxes scattered over the map.
    const { Mesh } = await import("@babylonjs/core/Meshes/mesh.js");
    await import("@babylonjs/core/Meshes/thinInstanceMesh.js");
    const matrices = new Float32Array(extraStatics * 16);
    const bounds = loaded.map.bounds as unknown as { minX?: number; maxX?: number; minZ?: number; maxZ?: number };
    const size = (bounds.maxX ?? 500) - (bounds.minX ?? -500);
    for (let i = 0; i < extraStatics; i++) {
      const x = (bounds.minX ?? -500) + ((i * 7919) % 1000) / 1000 * size;
      const z = (bounds.minZ ?? -500) + ((i * 104729) % 997) / 997 * size;
      const o = i * 16;
      matrices[o] = matrices[o + 5] = matrices[o + 10] = matrices[o + 15] = 1;
      matrices[o + 12] = x;
      matrices[o + 13] = loaded.terrain.sampleHeight(x, z) + 0.5;
      matrices[o + 14] = z;
    }
    const mesh = new Mesh("extraStatics", scene);
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
    const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
    body.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(0.5, 1, 0.5), scene);
    result.extraStatics = extraStatics;
    result.withExtraStatics = time(steps);
  }
  return result;
}
