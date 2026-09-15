/**
 * Headless bots-only battle royale on Map v1 (docs/bots/design.md §12.2): full matches through MatchSim, fast-forwarded,
 * with match length, kills, zone deaths, stuck incidents and per-tick CPU.
 *
 *   node tools/bench/bots/match.ts [--seed 1] [--matches 1] [--scale 1] [--brain fighter|wander|idle|real]
 *        [--difficulty normal] [--loadout armed|empty] [--nav grid|straight] [--players 10] [--teams solo|duo|squad]
 *        [--out file.json]
 *   node tools/bench/bots/match.ts --mode duel [--brain real] [--ranges 30,80] [--seconds 40]
 *
 * `--brain real` uses shared/bots createBotBrain; nav is the real Map v1 grid unless `--nav straight`. The scripted
 * fighter brains only exist to exercise the simulation. `--mode duel` runs the §6 tuning duels (bot with a rifle vs a
 * strafing unarmored target) per difficulty and range: hit rate, time to first shot, median time to kill. One heavy process at a time; check
 * `sysctl vm.swapusage` first. Self-terminates after 20 minutes.
 */
import "../runtime/lib/resolve.ts";
import { existsSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

// Deep `@twobullets/shared/*` imports from this script, and extensionless relative imports inside packages/sim/test (the
// shared harness), resolve like Vitest.
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
  console.error("[bots/match] watchdog: aborted after 20 minutes");
  process.exit(2);
}, 20 * 60_000).unref();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const seed = Number(arg("seed", "1"));
const matches = Number(arg("matches", "1"));
const scale = Number(arg("scale", "1"));
const brainName = arg("brain", "fighter");
const difficulty = arg("difficulty", "normal") as "easy" | "normal" | "hard";
const loadout = arg("loadout", brainName === "real" ? "empty" : "armed") as "armed" | "empty";
const navName = arg("nav", "grid");
const mode = arg("mode", "match");
const out = arg("out", "");
const players = Number(arg("players", "10"));
const teamMode = arg("teams", "duo") as "solo" | "duo" | "squad";

const { loadHavok } = await import("../../../packages/sim/src/node/loadHavok.ts");
const { createHeadlessMatch, runHeadlessMatch } = await import("../../../packages/sim/test/match/harness.ts");
const scripts = await import("../../../packages/sim/test/match/testBrains.ts");

type Factory = import("@twobullets/shared/bots/types").BotBrainFactory;

let brains: Factory;
if (brainName === "real") {
  const brainModule = (await import("@twobullets/shared/bots/brain/brain")) as { createBotBrain: Factory };
  brains = brainModule.createBotBrain;
} else {
  brains = brainName === "idle" ? scripts.idleScript : brainName === "wander" ? scripts.wanderScript : scripts.fighterScript;
}

const nav: "grid" | "straight" = navName === "straight" ? "straight" : "grid";
if (nav === "grid") {
  const { loadMapV1NavGrid } = await import("../../../packages/sim/test/match/mapV1World.ts");
  const built = await loadMapV1NavGrid();
  console.info(`[bots/match] nav grid ${built.grid.info.checksum} built in ${built.ms.toFixed(0)} ms`);
}

const havok = await loadHavok();
if (mode === "duel") {
  const { runDuel } = await import("../../../packages/sim/test/match/duel.ts");
  const ranges = arg("ranges", "30,80").split(",").map(Number);
  const seconds = Number(arg("seconds", "40"));
  const duels = [];
  for (const d of ["easy", "normal", "hard"] as const) {
    for (const range of ranges) {
      const result = await runDuel(havok, { brain: brains, difficulty: d, range, seconds, seed });
      const rounded = { ...result, hitRate: Math.round(result.hitRate * 1000) / 1000, targetSpeed: Math.round(result.targetSpeed * 100) / 100 };
      duels.push(rounded);
      console.info(JSON.stringify(rounded));
    }
  }
  if (out) writeFileSync(out, JSON.stringify(duels, null, 2));
  process.exit(0);
}
const results = [];
for (let m = 0; m < matches; m++) {
  const matchSeed = seed + m;
  const match = await createHeadlessMatch(havok, { seed: matchSeed, brains, timeScale: scale, difficulty, loadout, profile: true, nav, config: { maxPlayers: players, teamMode } });
  const capTicks = match.sim.schedule.timeCapTick + 60 * 20;
  const summary = runHeadlessMatch(match, capTicks);
  const alive = match.sim.state.actors.filter((a) => a && a.life !== "dead").map((a) => a.slot);
  match.dispose();
  const line = {
    seed: matchSeed,
    brain: brainName,
    players,
    teamMode,
    scale,
    combatMinutes: Math.round((summary.combatSeconds / 60) * 100) / 100,
    ticks: summary.ticks,
    reason: summary.reason,
    winnerTeam: summary.winnerTeam,
    survivors: alive,
    kills: summary.kills,
    knocks: summary.knocks,
    revives: summary.revives,
    zoneDeaths: summary.zoneDeaths,
    shots: summary.shots,
    placements: summary.placements,
    stuckIncidents: summary.stuck.length,
    longestStuckSeconds: summary.longestStuckSeconds,
    nanPositions: summary.nanPositions,
    tickMs: roundAll(summary.tickMs),
    brainMs: roundAll(summary.brainMs),
    wallSeconds: Math.round(summary.wallMs / 100) / 10,
  };
  results.push(line);
  console.info(JSON.stringify(line));
}
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(0);

function roundAll<T extends Record<string, number>>(value: T): T {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as T;
}
