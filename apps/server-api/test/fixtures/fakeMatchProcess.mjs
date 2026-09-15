// Stand-in for `server-match --mode=agent` in allocator tests: speaks the agent IPC contract without Havok.
// Behaviour switches: FAKE_MATCH=crash-on-allocate | never-ready | ignore-drain.

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const behaviour = process.env.FAKE_MATCH ?? "normal";
const send = (m) => process.send?.(m);

if (behaviour !== "never-ready") setTimeout(() => send({ t: "ready", udpPort: 0, wsPort: Number(args.port) }), 20);

let config = null;
process.on("message", (msg) => {
  if (msg.t === "jwks") console.log(`jwks ${msg.keys.map((k) => k.kid).join(",")}`);
  if (msg.t === "allocate") {
    if (behaviour === "crash-on-allocate") process.exit(3);
    config = msg.config;
    console.log(`allocated ${config.matchId} on ${args.host}:${args.port} env ${process.env.TB_MATCH_ID}`);
    send({ t: "phase", phase: "Warmup", freeSlots: config.maxPlayers });
    send({ t: "player", accountId: "g_player", event: "joined" });
  }
  if (msg.t === "drain" && behaviour !== "ignore-drain") finish();
});
process.on("SIGTERM", () => {
  if (behaviour !== "ignore-drain") finish();
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  if (config) {
    const now = Date.now();
    send({ t: "phase", phase: "Ended", freeSlots: 0 });
    send({
      t: "result",
      summary: { matchId: config.matchId, protocolVersion: config.protocolVersion, contentHash: config.contentHash, outcome: "completed", startedAt: now - 1000, endedAt: now, winningTeamId: 0, players: [] },
      files: [],
    });
    send({ t: "exit", code: 0 });
  }
  setTimeout(() => process.exit(0), 10);
}
