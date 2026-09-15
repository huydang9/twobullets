// Match server entry point (T3.4).
//   pnpm --filter @twobullets/server-match dev -- [--mode=local|single-match|packed] [--port=7350] [--host=127.0.0.1]
//     [--fake-net=lan|good|typical|bad|awful|tcp-fallback] [--matches=2] [--metrics=text|json|off] [--exit-after=<s>]
//     [--max-players=2..20] [--team-mode=solo|duo|squad]
// Env: TB_DEV_JOIN_SECRET (dev HS256 join-token secret), TB_RESUME_SECRET.

import { clampMaxPlayers, DEFAULT_MATCH_PLAYERS, DEFAULT_TEAM_MODE, TEAM_MODES, teamCount, type AgentToMatch, type TeamMode } from "@twobullets/contracts";
import { NETWORK_PROFILES, type NetworkProfileName } from "@twobullets/netcode";
import { PerformanceObserver } from "node:perf_hooks";
import { sendToAgent, startServer, type ServerMode } from "./app";
import type { HostMetrics } from "./host/LocalMatchHost";

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]!] = m[2] ?? "true";
  }
  return out;
}

function fail(message: string): never {
  console.error(`[server-match] ${message}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const mode = (args.mode ?? "local") as ServerMode;
if (mode !== "local" && mode !== "single-match" && mode !== "packed") fail(`unknown --mode=${mode}`);
const port = Number(args.port ?? 7350);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`bad --port=${args.port}`);
const fakeNet = (args["fake-net"] ?? null) as NetworkProfileName | null;
if (fakeNet !== null && !(fakeNet in NETWORK_PROFILES)) fail(`unknown --fake-net=${fakeNet} (${Object.keys(NETWORK_PROFILES).join(", ")})`);
const metricsMode = args.metrics ?? "text";
const maxPlayers = args["max-players"] ? Number(args["max-players"]) : DEFAULT_MATCH_PLAYERS;
if (!Number.isInteger(maxPlayers) || clampMaxPlayers(maxPlayers) !== maxPlayers) fail(`bad --max-players=${args["max-players"]} (2..20)`);
const teamMode = (args["team-mode"] ?? DEFAULT_TEAM_MODE) as TeamMode;
if (!TEAM_MODES.includes(teamMode)) fail(`unknown --team-mode=${teamMode} (${TEAM_MODES.join(", ")})`);
const exitAfterSec = args["exit-after"] ? Number(args["exit-after"]) : 0;

let gcMaxMs = 0;
const gcObserver = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) if (e.duration > gcMaxMs) gcMaxMs = e.duration;
});
gcObserver.observe({ entryTypes: ["gc"] });

const startedAt = performance.now();
const server = await startServer({
  mode,
  host: args.host ?? "127.0.0.1",
  port,
  matches: args.matches ? Number(args.matches) : undefined,
  fakeNet,
  maxPlayers,
  teamMode,
  devJoinSecret: process.env.TB_DEV_JOIN_SECRET,
  resumeSecret: process.env.TB_RESUME_SECRET,
});
const addr = `ws://${args.host ?? "127.0.0.1"}:${server.port}`;
console.log(
  `[server-match] ${mode} ready in ${(performance.now() - startedAt).toFixed(0)} ms: ${server.matches.map((m) => `${addr}/m/${m.id}`).join(" ")}` +
    (mode === "single-match" ? "" : ` | dev token: http://localhost:${server.port}/dev/token?sub=<id>&team=<0..${teamCount(maxPlayers, teamMode) - 1}>`) +
    ` | ${maxPlayers} players, ${teamMode}` +
    (fakeNet ? ` | fake-net=${fakeNet}` : ""),
);

const kb = (bytes: number): string => (bytes / 1000).toFixed(1);
function formatMetrics(m: HostMetrics, gcMax: number): string {
  const perClient = m.connected > 0 ? m.bytesOutPerSec / m.connected : 0;
  return (
    `[metrics] tick=${m.tick} players=${m.connected}/${m.players}` +
    ` | work p50=${m.work.p50.toFixed(3)} p99=${m.work.p99.toFixed(3)} max=${m.work.max.toFixed(2)} ms` +
    ` | late p50=${m.lateness.p50.toFixed(3)} p99=${m.lateness.p99.toFixed(3)} ms overruns=${m.overruns} hitches=${m.hitches}` +
    ` | out=${kb(m.bytesOutPerSec)} kB/s (${perClient.toFixed(0)} B/s/client) snaps=${m.snapshotsPerSec.toFixed(0)}/s skipped=${m.snapshotsSkipped}` +
    ` | inputDrops=${m.inputsDropped} | gc max=${gcMax.toFixed(1)} ms | rss=${(m.rssBytes / 1e6).toFixed(0)} MB`
  );
}

const metricsTimer = setInterval(() => {
  const m = server.second();
  const gcMax = gcMaxMs;
  gcMaxMs = 0;
  if (metricsMode === "text") console.log(formatMetrics(m, gcMax));
  else if (metricsMode === "json") console.log(JSON.stringify({ ...m, gcPauseMaxMs: gcMax }));
  for (const pm of m.perMatch) sendToAgent({ t: "metrics", m: { ...pm, gcPauseMaxMs: gcMax } });
}, 1000);

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(metricsTimer);
  gcObserver.disconnect();
  await server.stop();
  sendToAgent({ t: "exit", code });
  console.log("[server-match] stopped");
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("message", (msg: AgentToMatch) => {
  if (msg?.t === "drain") void shutdown(0);
});
if (exitAfterSec > 0) setTimeout(() => void shutdown(0), exitAfterSec * 1000);
