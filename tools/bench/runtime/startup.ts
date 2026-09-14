/**
 * Cold-start cost of the server building blocks, each case measured in a fresh child process (sequentially):
 * time to complete and RSS / V8 heap afterwards.
 *
 *   node tools/bench/runtime/startup.ts [--repeat=3] [--out=file.json]
 *   (internal) node tools/bench/runtime/startup.ts --probe=<case>
 */
import "./lib/resolve.ts";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { installWatchdog, machineInfo, parseArgs, round } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ probe: "", repeat: 3, out: "" });

const CASES = {
  tsBaseline: "Node + this probe (TypeScript stripping loaded), nothing else",
  havok: "import @babylonjs/havok + instantiate WASM (from bytes)",
  babylonBarrel: 'import("@babylonjs/core") barrel',
  babylonDeep: "deep imports: NullEngine, Scene, HavokPlugin, physics v2 body/shape/aggregate/character controller, Mesh",
  sharedIndex: "import packages/shared/src/index.ts (pure since T3.1: buildLevel moved to packages/sim)",
  sharedSimOnly: "import shared movement + weapons modules only",
  directMatchReady: "direct match fully built (Havok + heightfield + 300 buildings + 10 players + 200 hitboxes)",
  babylonMatchReady: "babylon match fully built (barrel + NullEngine scene + sim buildLevel + CharacterBody)",
} as const;

if (args.probe) {
  const t0 = performance.now();
  const probe = String(args.probe) as keyof typeof CASES;
  switch (probe) {
    case "tsBaseline":
      break;
    case "havok": {
      const { loadHavok } = await import("./lib/havok.ts");
      await loadHavok();
      break;
    }
    case "babylonBarrel":
      await import("@babylonjs/core");
      break;
    case "babylonDeep":
      await Promise.all([
        import("@babylonjs/core/Engines/nullEngine.js"),
        import("@babylonjs/core/scene.js"),
        import("@babylonjs/core/Meshes/mesh.js"),
        import("@babylonjs/core/Physics/joinedPhysicsEngineComponent.js"),
        import("@babylonjs/core/Physics/v2/Plugins/havokPlugin.js"),
        import("@babylonjs/core/Physics/v2/physicsBody.js"),
        import("@babylonjs/core/Physics/v2/physicsShape.js"),
        import("@babylonjs/core/Physics/v2/physicsAggregate.js"),
        import("@babylonjs/core/Physics/v2/characterController.js"),
      ]);
      break;
    case "sharedIndex":
      await import("../../../packages/shared/src/index.ts");
      break;
    case "sharedSimOnly":
      await Promise.all([import("../../../packages/shared/src/movement/movement.ts"), import("../../../packages/shared/src/weapons/weaponStep.ts"), import("../../../packages/shared/src/weapons/ballistics.ts")]);
      break;
    case "directMatchReady":
    case "babylonMatchReady": {
      const { createMatch } = await import("./lib/match.ts");
      const { DEFAULT_SCENARIO } = await import("./lib/scenario.ts");
      const match = await createMatch(probe === "directMatchReady" ? "direct" : "babylon", DEFAULT_SCENARIO);
      await match.setup();
      match.tick(new Float64Array(5));
      break;
    }
  }
  const ms = performance.now() - t0;
  const mem = process.memoryUsage();
  console.log(JSON.stringify({ ms: round(ms, 1), processUptimeMs: round(process.uptime() * 1000, 1), rssMb: round(mem.rss / 1e6, 1), heapUsedMb: round(mem.heapUsed / 1e6, 1), externalMb: round(mem.external / 1e6, 1) }));
  process.exit(0);
}

const self = fileURLToPath(import.meta.url);
const results: Record<string, unknown> = {};
// Bare Node for reference.
{
  const runs = [];
  for (let r = 0; r < Number(args.repeat); r++) {
    const t0 = performance.now();
    const outp = execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({rssMb: process.memoryUsage().rss/1e6, heapUsedMb: process.memoryUsage().heapUsed/1e6}))"], { encoding: "utf8" });
    runs.push({ wallMs: round(performance.now() - t0, 1), ...JSON.parse(outp) });
  }
  results.bareNode = { description: "node -e (no TypeScript)", runs };
  console.error("bareNode", JSON.stringify(runs));
}
for (const [name, description] of Object.entries(CASES)) {
  const runs = [];
  for (let r = 0; r < Number(args.repeat); r++) {
    const flags = name === "babylonMatchReady" ? ["--experimental-transform-types", "--no-warnings"] : ["--no-warnings"];
    const t0 = performance.now();
    const outp = execFileSync(process.execPath, [...flags, self, `--probe=${name}`], { encoding: "utf8", timeout: 60_000 });
    runs.push({ wallMs: round(performance.now() - t0, 1), ...JSON.parse(outp.trim().split("\n").pop()!) });
  }
  results[name] = { description, runs };
  console.error(name, JSON.stringify(runs));
}

const report = { benchmark: "startup", date: new Date().toISOString(), machine: machineInfo(), args, results };
if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
