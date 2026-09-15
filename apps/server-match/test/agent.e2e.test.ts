import type { AuthResponse } from "@twobullets/contracts/rest";
import { DisconnectReason, MatchEndReason, PhaseCode } from "@twobullets/protocol";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
// The real control plane (not a copy): server-api's HTTP app and process allocator spawn this package's `--mode=agent`.
import { createApi, type ApiApp, type AppConfig } from "../../server-api/src/app";
import { KeyRing } from "../../server-api/src/auth/keyRing";
import { openDb } from "../../server-api/src/db";
import { LocalProcessAllocator } from "../../server-api/src/fleet/localProcessAllocator";
import { HeadlessClient } from "../src/dev/HeadlessClient";
import { WsSession } from "../src/transport/WsSession";

// P3 end to end on localhost: guest login → lobby → start (server-api spawns a real server-match process, pushes JWKS and
// the config) → join token → WebSocket Hello/Welcome → phases → result stored → process gone. Each test starts one match
// process and waits for it to exit.

const MATCH_DIR = fileURLToPath(new URL("..", import.meta.url));

const CONFIG: AppConfig = {
  publicUrl: "https://play.test",
  build: "e2e",
  region: "sg",
  hostId: "sg-e2e",
  inviteCode: null,
  metricsToken: null,
  corsOrigins: [],
  trustProxy: false,
  rateAuthPerMin: 1000,
  rateApiPerMin: 1000,
  queue: { startAfterSec: 30, minHumans: 1, tickMs: 1000 },
  lobbyIdleMinutes: 30,
};

interface Rig {
  readonly app: ApiApp;
  readonly base: string;
  readonly lines: string[];
  call<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: T }>;
  guest(nickname: string): Promise<AuthResponse>;
}

let rig: Rig | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await rig?.app.close();
  rig = null;
});

async function startRig(extraArgs: string[], port: number): Promise<Rig> {
  const lines: string[] = [];
  const keys = KeyRing.generate();
  const allocator = new LocalProcessAllocator(
    {
      command: process.execPath,
      args: ["--import", `${MATCH_DIR}src/node/resolveHooks.ts`, `${MATCH_DIR}src/main.ts`, "--mode=agent", "--metrics=off", ...extraArgs],
      cwd: MATCH_DIR,
      bindHost: "127.0.0.1",
      portMin: port,
      portMax: port,
      maxMatches: 1,
      urlTemplate: "ws://127.0.0.1:{port}/m/{matchId}",
      readyTimeoutMs: 30_000,
      maxMinutes: 3,
      killGraceMs: 5000,
      log: (line) => lines.push(line),
    },
    keys.agentJwks(),
  );
  const app = createApi({ config: CONFIG, db: openDb(":memory:"), keys, allocator, log: (line) => lines.push(line), autoTick: false });
  const apiPort = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${apiPort}`;
  const call: Rig["call"] = async (method, path, token, body) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    app,
    base,
    lines,
    call,
    async guest(nickname) {
      const res = await call<AuthResponse>("POST", "/v1/auth/guest", undefined, { nickname });
      if (res.status !== 201) throw new Error(`guest ${res.status}`);
      return res.body;
    },
  };
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

async function connect(wsUrl: string, token: string, seed: number): Promise<{ client: HeadlessClient; stop: () => void }> {
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const clock = { now: () => performance.now() };
  const client = new HeadlessClient({ session: new WsSession(ws, clock), clock, token, seed });
  client.script = (_tick, e) => {
    e.forward = 0;
    e.right = 0;
    e.buttons = 0;
  };
  client.hello();
  const pump = setInterval(() => client.update(), 4);
  return { client, stop: () => clearInterval(pump) };
}

function matchExited(r: Rig): boolean {
  return r.lines.some((l) => /\] exited: /.test(l));
}

describe("server-api allocator → server-match --mode=agent (real processes)", () => {
  it("Map v1: login, lobby, start, join token, Hello/Welcome in warmup; API shutdown drains → cancelled result, process exits", async () => {
    const r = (rig = await startRig([], 47410));
    const host = await r.guest("Host");
    const lobby = (await r.call("POST", "/v1/lobbies", host.accessToken, { mode: "duo", maxPlayers: 4, mapId: "v1", fillWithBots: true })).body.lobby;
    const started = await r.call("POST", `/v1/lobbies/${lobby.code}/start`, host.accessToken);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const matchId: string = started.body.lobby.matchId;
    expect(r.app.matches.get(matchId)).toMatchObject({ status: "running", phase: "Warmup" });

    const join = await r.call("POST", `/v1/matches/${matchId}/join`, host.accessToken);
    expect(join.status).toBe(200);
    expect(join.body.wsUrl).toBe(`ws://127.0.0.1:47410/m/${matchId}`);
    const { client, stop } = await connect(join.body.wsUrl, join.body.joinToken, 1);
    try {
      expect(await until(() => client.welcome !== null || client.disconnect !== null, 10_000)).toBe(true);
      expect(client.disconnect).toBeNull();
      expect(client.welcome).toMatchObject({ playerSlot: 0, teamId: 0, teamSize: 2, maxPlayers: 4, phase: PhaseCode.Warmup });
      expect(await until(() => client.phase !== null && client.snapshotsReceived >= 10, 10_000)).toBe(true);
      expect(client.phase).toMatchObject({ phase: PhaseCode.Warmup, playersAlive: 1 });
      expect(await until(() => r.app.matches.get(matchId)!.connected.has(host.account.id), 5000)).toBe(true);

      // The same token again is refused (single use).
      const replay = await connect(join.body.wsUrl, join.body.joinToken, 2);
      expect(await until(() => replay.client.disconnect !== null, 5000)).toBe(true);
      expect(replay.client.disconnect!.reason).toBe(DisconnectReason.badToken);
      replay.stop();

      const closed = new Promise<void>((resolve) => sockets[0]!.once("close", () => resolve()));
      await r.app.close();
      await closed;
      expect(client.matchEnd?.reason).toBe(MatchEndReason.cancelled);
      expect(client.disconnect?.reason).toBe(DisconnectReason.serverShutdown);
    } finally {
      stop();
    }
    const result = r.app.results.getResult(matchId);
    expect(result).toMatchObject({ outcome: "cancelled" });
    expect(matchExited(r)).toBe(true);
    const log = r.lines.join("\n");
    expect(log).toMatch(/\[agent\] allocated .* on v1 \((bake|generated), map load \d+ ms, ready in \d+ ms\)/);
    if (process.env.E2E_LOG) writeFileSync(process.env.E2E_LOG, r.lines.join("\n"));
    rig = null;
  }, 60_000);

  it("arena solo with fast timings: two players play a full match to the time cap → completed result with placements", async () => {
    const r = (rig = await startRig(["--warmup-seconds=5", "--all-joined-seconds=0.3", "--time-scale=0.01", "--end-linger-seconds=0.3"], 47411));
    const a = await r.guest("Alpha");
    const b = await r.guest("Bravo");
    const lobby = (await r.call("POST", "/v1/lobbies", a.accessToken, { mode: "solo", maxPlayers: 2, mapId: "arena", fillWithBots: false })).body.lobby;
    expect((await r.call("POST", `/v1/lobbies/${lobby.code}/join`, b.accessToken, { teamId: 1 })).status).toBe(200);
    const matchId: string = (await r.call("POST", `/v1/lobbies/${lobby.code}/start`, a.accessToken)).body.lobby.matchId;
    const joins = [await r.call("POST", `/v1/matches/${matchId}/join`, a.accessToken), await r.call("POST", `/v1/matches/${matchId}/join`, b.accessToken)];
    const conns = [await connect(joins[0]!.body.wsUrl, joins[0]!.body.joinToken, 3), await connect(joins[1]!.body.wsUrl, joins[1]!.body.joinToken, 4)];
    try {
      expect(await until(() => conns.every((c) => c.client.matchEnd !== null), 40_000)).toBe(true);
      for (const { client } of conns) {
        expect(client.phases.map((p) => p.phase)).toEqual(expect.arrayContaining([PhaseCode.Warmup, PhaseCode.Combat, PhaseCode.End]));
        expect(client.zonePhases.length).toBeGreaterThan(0);
        expect([MatchEndReason.timeCap, MatchEndReason.lastTeam, MatchEndReason.allDead]).toContain(client.matchEnd!.reason);
      }
      expect(await until(() => matchExited(r), 20_000)).toBe(true);
      expect(conns[0]!.client.disconnect?.reason).toBe(DisconnectReason.matchEnded);
    } finally {
      for (const c of conns) c.stop();
    }
    const result = r.app.results.getResult(matchId)!;
    expect(result).toMatchObject({ outcome: "completed" });
    expect(result.participants.map((p) => p.placement).sort()).toEqual(result.winningTeamId === null ? [1, 1] : [1, 2]);
    expect(r.lines.some((l) => l.includes("exited: exit 0"))).toBe(true);
  }, 90_000);
});
