import { appendFileSync } from "node:fs";
import { ManualClock } from "@twobullets/netcode/testing/clock";
import { LinkConditioner } from "@twobullets/netcode/testing/LinkConditioner";
import { createMemorySessionPair } from "@twobullets/netcode/testing/memorySession";
import { NETWORK_PROFILES, type NetworkProfile } from "@twobullets/netcode/testing/profiles";
import { createSeededRng } from "@twobullets/netcode/testing/rng";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { PlayerInputRing } from "@twobullets/shared/inputRing";
import { createSimWorld, type SimWorld } from "@twobullets/sim/index";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPlayerNet } from "../../src/net/LocalPlayerNet";
import { NetClient } from "../../src/net/NetClient";
import { NetClock, WS_BUFFER_TICKS, WT_BUFFER_TICKS } from "../../src/net/NetClock";
import { RemoteRoster } from "../../src/net/RemoteRoster";
import { botX, FakeMatchServer, HeadlessPlayer } from "./netHarness";

// T3.5 acceptance: the real NetClient + LocalPlayerNet + NetClock against an in-process server over LinkConditioner,
// both sides stepping the shared stepPlayer on NullEngine + Havok (arena level).

const TICK_MS = 1000 / 60;
const WARMUP_MS = 3000;

let serverWorld: SimWorld;
let clientWorld: SimWorld;

beforeAll(async () => {
  const havok = await loadHavok();
  serverWorld = await createSimWorld(havok, ARENA_LEVEL);
  clientWorld = await createSimWorld(havok, ARENA_LEVEL);
});

afterAll(() => {
  serverWorld?.dispose();
  clientWorld?.dispose();
});

interface Result {
  startedAtMs: number;
  corrections: number;
  correctionsAfterWarmup: number;
  meanCorrectionCm: number;
  resyncs: number;
  synthetic: number;
  consumed: number;
  predictedTicks: number;
  finalPosErrMm: number;
  remoteErrMaxM: number;
  extrapolatedPct: number;
  distanceM: number;
  state: string;
}

function run(profile: NetworkProfile, seconds: number, seed: number): Result {
  const clock = new ManualClock(10_000);
  const rng = createSeededRng(seed);
  const [clientEnd, serverEnd] = createMemorySessionPair({ clock, kind: profile.kind });
  const link = new LinkConditioner(clientEnd, profile, clock, seed);
  const server = new FakeMatchServer(serverEnd, clock, serverWorld, ARENA_LEVEL, 0);

  // The client body starts at another spawn: the server owns placement.
  const [sx, sy, sz] = ARENA_LEVEL.spawnPoints[1]!.position;
  const player = new HeadlessPlayer(clientWorld, { x: sx, y: sy, z: sz });
  const netClock = new NetClock({ bufferTicks: profile.kind === "websocket" ? WS_BUFFER_TICKS : WT_BUFFER_TICKS });
  const ring = new PlayerInputRing();
  const local = new LocalPlayerNet(player);
  const roster = new RemoteRoster();
  const client = new NetClient(link, { clock, netClock, local, inputs: ring, roster, joinToken: "test" });
  client.start();

  const startMs = clock.now();
  const endMs = startMs + seconds * 1000;
  let nextServerTickMs = startMs;
  let nextFrameMs = startMs + 3;
  let lastFrameMs = startMs;
  let startedAtMs = -1;
  let correctionsAtWarmup = -1;
  let remoteErrMax = 0;
  let firstFeet: { x: number; z: number } | null = null;
  let distance = 0;
  let prevX = 0;
  let prevZ = 0;

  while (clock.now() < endMs) {
    clock.advance(0.5);
    link.pump();
    while (clock.now() >= nextServerTickMs) {
      server.step();
      nextServerTickMs += TICK_MS;
    }
    link.pump();
    if (clock.now() >= nextFrameMs) {
      const dt = (clock.now() - lastFrameMs) / 1000;
      client.update(dt);
      player.frame(dt, netClock, ring, client);
      lastFrameMs = clock.now();
      nextFrameMs += 1000 / 144 + (rng.next() - 0.5) * 2;
      if (client.state === "playing" && startedAtMs < 0) startedAtMs = clock.now() - startMs;
      if (correctionsAtWarmup < 0 && clock.now() - startMs > WARMUP_MS) correctionsAtWarmup = local.stats.corrections;
      const f = player.tickFeet;
      if (firstFeet === null && client.state === "playing") {
        firstFeet = { x: f.x, z: f.z };
        prevX = f.x;
        prevZ = f.z;
      } else if (firstFeet) {
        distance += Math.sqrt((f.x - prevX) ** 2 + (f.z - prevZ) ** 2);
        prevX = f.x;
        prevZ = f.z;
      }
      if (clock.now() - startMs > WARMUP_MS && roster.visible[5] === 1) {
        const pose = roster.poses[5]!;
        remoteErrMax = Math.max(remoteErrMax, Math.abs(pose.x - botX(client.renderTick / 60)));
      }
    }
  }

  // The newest prediction the server has also simulated.
  let finalPosErrMm = Infinity;
  for (let t = local.newestPredictedTick; t > local.newestPredictedTick - 60; t--) {
    const s = server.states.get(t);
    if (s) {
      // Re-simulate nothing: compare the server's feet with what the client predicted for that tick via the history.
      finalPosErrMm = predictedErrorMm(local, t, s.feet);
      if (Number.isFinite(finalPosErrMm)) break;
    }
  }

  const stats = client.stats;
  return {
    startedAtMs,
    corrections: local.stats.corrections,
    correctionsAfterWarmup: local.stats.corrections - Math.max(0, correctionsAtWarmup),
    meanCorrectionCm: stats.meanCorrectionCm,
    resyncs: stats.resyncs,
    synthetic: server.inputs.stats.synthetic,
    consumed: server.inputs.stats.consumed,
    predictedTicks: player.ticks,
    finalPosErrMm,
    remoteErrMaxM: remoteErrMax,
    extrapolatedPct: stats.extrapolatedPct,
    distanceM: distance,
    state: client.state,
  };
}

function predictedErrorMm(local: LocalPlayerNet, tick: number, feet: { x: number; y: number; z: number }): number {
  const block = local.predictedBlock(tick);
  if (block === null) return Number.NaN;
  const dx = block.xMm - Math.round((feet.x + 524.288) * 1000);
  const dy = block.yMm - Math.round((feet.y + 12) * 1000);
  const dz = block.zMm - Math.round((feet.z + 524.288) * 1000);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** `NET_VERBOSE=/path/results.jsonl` appends one line per run. */
const log = (label: string, r: Result) => {
  const out = process.env.NET_VERBOSE;
  if (out) appendFileSync(out, `${JSON.stringify({ label, ...r })}\n`);
};

describe("LocalPlayerNet over LinkConditioner with the real stepPlayer", () => {
  it("lan: server-owned spawn, then zero corrections", () => {
    const r = run(NETWORK_PROFILES.lan, 30, 11);
    log("lan", r);
    expect(r.state).toBe("playing");
    expect(r.startedAtMs).toBeGreaterThan(0);
    expect(r.startedAtMs).toBeLessThan(1500);
    expect(r.distanceM).toBeGreaterThan(50);
    expect(r.synthetic / (r.synthetic + r.consumed)).toBeLessThan(0.05);
    expect(r.correctionsAfterWarmup).toBe(0);
    expect(r.resyncs).toBe(0);
    expect(r.finalPosErrMm).toBeLessThanOrEqual(10);
    expect(r.remoteErrMaxM).toBeLessThan(0.05);
  }, 120_000);

  it("typical: bounded corrections, no resyncs, converged prediction (3 seeds × 60 s)", () => {
    let corrections = 0;
    for (const seed of [12, 22, 32]) {
      const r = run(NETWORK_PROFILES.typical, 60, seed);
      log("typical", r);
      expect(r.state).toBe("playing");
      expect(r.resyncs).toBe(0);
      expect(r.finalPosErrMm).toBeLessThanOrEqual(10);
      expect(r.extrapolatedPct).toBeLessThan(2);
      corrections += r.correctionsAfterWarmup;
    }
    // Each correction is an input lost beyond what redundancy recovers in time (the server repeated the previous
    // input) while the aim was turning; the script turns every tick, so nearly every synthetic tick mispredicts.
    expect(corrections / 3).toBeLessThan(15);
  }, 180_000);

  it("tcp-fallback (the browser's WebSocket path): bounded corrections, no resyncs", () => {
    const r = run(NETWORK_PROFILES["tcp-fallback"], 60, 13);
    log("tcp-fallback", r);
    expect(r.state).toBe("playing");
    expect(r.resyncs).toBe(0);
    expect(r.correctionsAfterWarmup).toBeLessThan(10);
    expect(r.finalPosErrMm).toBeLessThanOrEqual(10);
  }, 180_000);
});
