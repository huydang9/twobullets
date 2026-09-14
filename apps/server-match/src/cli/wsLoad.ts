// Local load driver: N headless WebSocket clients against a running match server, random movement at 60 Hz.
//   pnpm --filter @twobullets/server-match load -- [--url=http://localhost:7350] [--clients=10] [--seconds=20] [--lead=3]
// The driver has no clock sync: with --fake-net on the server, raise --lead above RTT/16.7 ms or inputs arrive late.
// Exits on its own; prints per-client downstream bytes/s and snapshot counts. Server-side metrics are on its stdout.

import type { DevJoinTokenResponse } from "@twobullets/contracts";
import WebSocket from "ws";
import { HeadlessClient } from "../dev/HeadlessClient";
import { WsSession } from "../transport/WsSession";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [[m[1]!, m[2]!]] : [];
  }),
) as Record<string, string>;
const base = args.url ?? "http://localhost:7350";
const clientCount = Number(args.clients ?? 10);
const seconds = Number(args.seconds ?? 20);
const leadTicks = Number(args.lead ?? 3);
const clock = { now: () => performance.now() };

const hardStop = setTimeout(() => {
  console.error("[load] watchdog: forcing exit");
  process.exit(1);
}, (seconds + 15) * 1000);

const clients: { client: HeadlessClient; ws: WebSocket; session: WsSession }[] = [];
for (let i = 0; i < clientCount; i++) {
  const res = await fetch(`${base}/dev/token?sub=load-${i}&team=${Math.floor(i / 2) % 5}`);
  const dev = (await res.json()) as DevJoinTokenResponse;
  const ws = new WebSocket(dev.url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const session = new WsSession(ws, clock);
  const client = new HeadlessClient({ session, clock, token: dev.token, seed: 1000 + i, leadTicks });
  client.hello();
  clients.push({ client, ws, session });
}

const startMs = performance.now();
const loop = setInterval(() => {
  for (const c of clients) c.client.update();
}, 4);

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(loop);
const elapsed = (performance.now() - startMs) / 1000;
let totalIn = 0;
for (const [i, { client, ws }] of clients.entries()) {
  totalIn += client.bytesIn;
  console.log(
    `[load] client ${i} slot=${client.playerSlot} snapshots=${client.snapshotsReceived} (${(client.snapshotsReceived / elapsed).toFixed(1)}/s) dropped=${client.snapshotsDropped}` +
      ` down=${(client.bytesIn / elapsed).toFixed(0)} B/s up=${(client.bytesOut / elapsed).toFixed(0)} B/s lastInput=${client.lastProcessedInputTick}` +
      (client.disconnect ? ` disconnect=${client.disconnect.reason}` : ""),
  );
  ws.close(1000);
}
console.log(`[load] ${clientCount} clients, ${elapsed.toFixed(1)} s: mean down ${(totalIn / elapsed / clientCount).toFixed(0)} B/s per client (payload only)`);
clearTimeout(hardStop);
setTimeout(() => process.exit(0), 200);
