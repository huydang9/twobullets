// Local load driver: N headless WebSocket clients against a match server, random movement at 60 Hz.
//   pnpm --filter @twobullets/server-match load -- [--url=http://localhost:7350] [--clients=10] [--seconds=20] [--lead=3]
//     [--fire] [--inproc] [--max-players=20] [--team-mode=solo|duo|squad] [--map=arena|v1] [--flow=sandbox|br]
// --max-players/--team-mode: size of the in-process match (--inproc), and how clients spread over teams.
// --fire: every client holds fire at the nearest remote player (rifle, then pistol taps when dry); kills and respawns run.
// --inproc: starts the match server in this process on a random port and prints its per-second tick work and combat
// counters (one heavy process instead of two). --map/--flow pick the in-process level and loop (plan.md B2 measurement:
// `--inproc --map=v1 --clients=20 --max-players=20 --fire`); boot time and RSS are printed.
// The driver has no clock sync: with --fake-net on the server, raise --lead above RTT/16.7 ms or inputs arrive late.
// Exits on its own; prints per-client downstream bytes/s and snapshot counts.

import { DEFAULT_TEAM_MODE, TEAM_MODE_SIZE, teamCount, type DevJoinTokenResponse, type TeamMode } from "@twobullets/contracts";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../app";
import { HeadlessClient } from "../dev/HeadlessClient";
import { WsSession } from "../transport/WsSession";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [[m[1]!, m[2] ?? "true"]] : [];
  }),
) as Record<string, string>;
const clientCount = Number(args.clients ?? 10);
const seconds = Number(args.seconds ?? 20);
const leadTicks = Number(args.lead ?? 3);
const fire = args.fire === "true";
const maxPlayers = Number(args["max-players"] ?? Math.max(10, clientCount));
const teamMode = (args["team-mode"] ?? DEFAULT_TEAM_MODE) as TeamMode;
const teamSize = TEAM_MODE_SIZE[teamMode] ?? 2;
const teams = teamCount(maxPlayers, teamMode);
const clock = { now: () => performance.now() };

const hardStop = setTimeout(() => {
  console.error("[load] watchdog: forcing exit");
  process.exit(1);
}, (seconds + 15) * 1000);

let server: RunningServer | null = null;
let base = args.url ?? "http://localhost:7350";
if (args.inproc === "true") {
  const rssBefore = process.memoryUsage.rss();
  const bootStart = performance.now();
  const flow = args.flow === "br" ? "br" : "sandbox";
  server = await startServer({ mode: "local", host: "127.0.0.1", port: 0, maxPlayers, teamMode, mapId: args.map ?? "arena", flow, lifecycle: { warmupSeconds: 5, allJoinedSeconds: 3 }, log: (l) => console.log(l) });
  base = `http://127.0.0.1:${server.port}`;
  console.log(`[load] server (${args.map ?? "arena"}, ${flow}) booted in ${(performance.now() - bootStart).toFixed(0)} ms, rss ${(rssBefore / 1e6).toFixed(0)} → ${(process.memoryUsage.rss() / 1e6).toFixed(0)} MB`);
}

const clients: { client: HeadlessClient; ws: WebSocket; session: WsSession }[] = [];
for (let i = 0; i < clientCount; i++) {
  const res = await fetch(`${base}/dev/token?sub=load-${i}&team=${Math.floor(i / teamSize) % teams}`);
  const dev = (await res.json()) as DevJoinTokenResponse;
  const ws = new WebSocket(dev.url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const session = new WsSession(ws, clock);
  const client = new HeadlessClient({ session, clock, token: dev.token, seed: 1000 + i, leadTicks, combat: fire ? "spray" : "none" });
  client.hello();
  clients.push({ client, ws, session });
}

const startMs = performance.now();
const loop = setInterval(() => {
  for (const c of clients) c.client.update();
}, 4);

const workP50: number[] = [];
const workP99: number[] = [];
let workMax = 0;
const metrics = server
  ? setInterval(() => {
      const m = server!.second();
      const match = server!.matches[0]!;
      const combat = match.combat;
      if (performance.now() - startMs > 2000) {
        workP50.push(m.work.p50);
        workP99.push(m.work.p99);
        workMax = Math.max(workMax, m.work.max);
      }
      console.log(
        `[load] tick work p50=${m.work.p50.toFixed(3)} p99=${m.work.p99.toFixed(3)} max=${m.work.max.toFixed(2)} ms | players=${m.connected} rss=${(m.rssBytes / 1e6).toFixed(0)} MB` +
          (match.lifecycle ? ` | ${match.lifecycle.phase}` : "") +
          (combat
            ? ` | in flight=${combat.projectiles.count} shots=${combat.stats.shotsFired} hits=${combat.stats.hits} knocks=${combat.stats.knocks} kills=${combat.stats.kills} respawns=${combat.stats.respawns} rays=${combat.projectiles.stats.worldRays} Dclamps=${combat.stats.viewDelayClamps}`
            : ""),
      );
    }, 1000)
  : null;

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(loop);
if (metrics) clearInterval(metrics);
const elapsed = (performance.now() - startMs) / 1000;
let totalIn = 0;
for (const [i, { client, ws }] of clients.entries()) {
  totalIn += client.bytesIn;
  console.log(
    `[load] client ${i} slot=${client.playerSlot} snapshots=${client.snapshotsReceived} (${(client.snapshotsReceived / elapsed).toFixed(1)}/s) dropped=${client.snapshotsDropped}` +
      ` down=${(client.bytesIn / elapsed).toFixed(0)} B/s up=${(client.bytesOut / elapsed).toFixed(0)} B/s lastInput=${client.lastProcessedInputTick}` +
      ` shots=${client.shotsSeen} hits=${client.hitsSeen} reliable=${client.reliableDelivered} feed=${client.killFeeds}` +
      (client.disconnect ? ` disconnect=${client.disconnect.reason}` : ""),
  );
  ws.close(1000);
}
console.log(`[load] ${clientCount} clients, ${elapsed.toFixed(1)} s: mean down ${(totalIn / elapsed / clientCount).toFixed(0)} B/s per client (payload only)`);
if (workP50.length > 0) {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`[load] server tick work (steady state): mean p50=${mean(workP50).toFixed(3)} ms, mean p99=${mean(workP99).toFixed(3)} ms, max=${workMax.toFixed(2)} ms`);
}
if (server) await server.stop();
clearTimeout(hardStop);
setTimeout(() => process.exit(0), 200);
