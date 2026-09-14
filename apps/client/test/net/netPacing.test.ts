import { appendFileSync } from "node:fs";
import { ManualClock } from "@twobullets/netcode/testing/clock";
import { LinkConditioner } from "@twobullets/netcode/testing/LinkConditioner";
import { createMemorySessionPair } from "@twobullets/netcode/testing/memorySession";
import { NETWORK_PROFILES, type NetworkProfile } from "@twobullets/netcode/testing/profiles";
import { createSeededRng } from "@twobullets/netcode/testing/rng";
import type { Session } from "@twobullets/netcode/transport/Session";
import { PlayerInputRing } from "@twobullets/shared/inputRing";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createSimWorld, type SimWorld } from "@twobullets/sim/index";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPlayerNet } from "../../src/net/LocalPlayerNet";
import { NetClient } from "../../src/net/NetClient";
import { NetClock, WS_BUFFER_TICKS, WT_BUFFER_TICKS } from "../../src/net/NetClock";
import { RemoteRoster } from "../../src/net/RemoteRoster";
import { FakeMatchServer, HeadlessPlayer } from "./netHarness";

// Net clock under browser-like frame pacing: the real NetClient / NetClock / LocalPlayerNet against the harness server
// (the real ServerInputBuffer) over LinkConditioner. Frames pass `dt` capped at 0.1 s like Game.ts; a stall blocks the
// "main thread", so snapshots that land during it are handled after it with a late receive time, as in a browser.

const TICK_MS = 1000 / 60;

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

/** A browser main thread: messages that land while a frame is still running are handled when it ends. */
class MainThread implements Session {
  readonly kind: Session["kind"];
  readonly maxDatagramSize: number;
  busyUntilMs = -Infinity;
  private readonly queue: { bytes: Uint8Array; stream: boolean }[] = [];
  private datagramCb: ((bytes: Uint8Array, recvMs: number) => void) | null = null;
  private streamCb: ((bytes: Uint8Array) => void) | null = null;
  private readonly inner: LinkConditioner;
  private readonly clock: ManualClock;

  constructor(inner: LinkConditioner, clock: ManualClock) {
    this.inner = inner;
    this.clock = clock;
    this.kind = inner.kind;
    this.maxDatagramSize = inner.maxDatagramSize;
    inner.onDatagram((bytes, recvMs) => (this.busy ? this.queue.push({ bytes, stream: false }) : this.datagramCb?.(bytes, recvMs)));
    inner.onStream((bytes) => (this.busy ? this.queue.push({ bytes, stream: true }) : this.streamCb?.(bytes)));
  }

  private get busy(): boolean {
    return this.clock.now() < this.busyUntilMs;
  }

  release(): void {
    if (this.busy || this.queue.length === 0) return;
    const now = this.clock.now();
    for (const q of this.queue) {
      if (q.stream) this.streamCb?.(q.bytes);
      else this.datagramCb?.(q.bytes, now);
    }
    this.queue.length = 0;
  }

  sendDatagram(bytes: Uint8Array): boolean {
    return this.inner.sendDatagram(bytes);
  }
  sendStream(bytes: Uint8Array): void {
    this.inner.sendStream(bytes);
  }
  onDatagram(cb: (bytes: Uint8Array, recvMs: number) => void): void {
    this.datagramCb = cb;
  }
  onStream(cb: (bytes: Uint8Array) => void): void {
    this.streamCb = cb;
  }
  queuedBytes(): number {
    return this.inner.queuedBytes();
  }
  close(code: number): void {
    this.inner.close(code);
  }
}

interface Pacing {
  readonly name: string;
  /** Next frame interval, ms. */
  interval(rng: () => number): number;
  /** Stall (ms) to insert after the frame at `elapsedMs`, or 0. */
  stall(elapsedMs: number, rng: () => number): number;
  /** Frame dt multiplier (≠ 1 models a harness whose dt doesn't match wall time). */
  readonly dtScale?: number;
  /** Once, at this elapsed time, move the client clock by `shiftTicks` (a misaligned client). */
  readonly shiftAtMs?: number;
  readonly shiftTicks?: number;
}

const FRAME_60 = 1000 / 60;
const steady = (dtScale = 1): Pacing => ({ name: dtScale === 1 ? "steady" : `steady dt×${dtScale}`, interval: () => FRAME_60, stall: () => 0, dtScale });
const oneStall = (atMs: number, stallMs = 1000): Pacing => {
  let done = false;
  return {
    name: `stall ${stallMs} ms`,
    interval: () => FRAME_60,
    stall: (elapsed) => {
      if (done || elapsed < atMs) return 0;
      done = true;
      return stallMs;
    },
  };
};
/** 60 fps with a 120–260 ms hitch (each shorter than the 0.1 s dt cap + 10 ticks) every 2–4 s. */
const hitches = (): Pacing => {
  let nextMs = 5000;
  return {
    name: "hitches",
    interval: () => FRAME_60,
    stall: (elapsed, rng) => {
      if (elapsed < nextMs) return 0;
      nextMs = elapsed + 2000 + rng() * 2000;
      return 120 + rng() * 140;
    },
  };
};
/** Frames every 5–60 ms, and a 200–1000 ms stall every 6–12 s. */
const irregular = (): Pacing => {
  let nextMs = 8000;
  return {
    name: "irregular",
    interval: (rng) => 5 + rng() * 55,
    stall: (elapsed, rng) => {
      if (elapsed < nextMs) return 0;
      nextMs = elapsed + 6000 + rng() * 6000;
      return 200 + rng() * 800;
    },
  };
};
const shifted = (ticks: number): Pacing => ({ name: `shift ${ticks > 0 ? "+" : ""}${ticks} t`, interval: () => FRAME_60, stall: () => 0, shiftAtMs: 10_000, shiftTicks: ticks });

interface PacingResult {
  profile: string;
  pacing: string;
  seed: number;
  resyncs: number;
  /** Stalls, and those long enough (> dt cap + 10 ticks) to justify a resync. */
  stalls: number;
  longStalls: number;
  /** ResyncRequests the server answered (each drops its baselines and unacked reliable events). */
  serverResyncs: number;
  corrections: number;
  synthetic: number;
  depth: number;
  target: number;
  tickScale: number;
  lead: number;
  maxJitterMs: number;
  frameTimePct: number;
  /** Mean |depth − target| over the last 10 s. */
  meanDepthError: number;
  /**
   * Worst time from the start of play, a stall's end or a clock shift until |depth − target| ≤ 1 held for 1 s, ms
   * (episodes cut short by the next stall within 5 s aren't measured; Infinity = one never settled).
   */
  settleMs: number;
  /** Frames with |depth − target| ≤ 1, from 5 s after the start and after each stall, %. */
  inBandPct: number;
  /** tickScale extremes in the 2 s after the clock shift. */
  shiftMinScale: number;
  shiftMaxScale: number;
  targetChanges: number;
  state: string;
}

function runPacing(profile: NetworkProfile, pacing: Pacing, seconds: number, seed: number): PacingResult {
  const clock = new ManualClock(10_000);
  const rngState = createSeededRng(seed);
  const rng = () => rngState.next();
  const [clientEnd, serverEnd] = createMemorySessionPair({ clock, kind: profile.kind });
  const link = new LinkConditioner(clientEnd, profile, clock, seed);
  const thread = new MainThread(link, clock);
  const server = new FakeMatchServer(serverEnd, clock, serverWorld, ARENA_LEVEL, 0);
  let serverResyncs = 0;
  const baselineReset = server.baselines.reset.bind(server.baselines);
  server.baselines.reset = () => {
    serverResyncs++;
    baselineReset();
  };
  const [sx, sy, sz] = ARENA_LEVEL.spawnPoints[1]!.position;
  const player = new HeadlessPlayer(clientWorld, { x: sx, y: sy, z: sz });
  const netClock = new NetClock({ bufferTicks: profile.kind === "websocket" ? WS_BUFFER_TICKS : WT_BUFFER_TICKS });
  const ring = new PlayerInputRing();
  const local = new LocalPlayerNet(player);
  const client = new NetClient(thread, { clock, netClock, local, inputs: ring, roster: new RemoteRoster(), joinToken: "test" });
  client.start();

  const startMs = clock.now();
  const endMs = startMs + seconds * 1000;
  const dtScale = pacing.dtScale ?? 1;
  let nextServerTickMs = startMs;
  let nextFrameMs = startMs + 3;
  let lastFrameMs = startMs;
  let errSum = 0;
  let errN = 0;
  let stalls = 0;
  let longStalls = 0;
  let maxJitter = 0;
  let shiftDone = false;
  let shiftMs = -Infinity;
  let targetChanges = 0;
  let lastTarget = -1;
  let shiftMinScale = 1;
  let shiftMaxScale = 1;
  let episodeMs = -1;
  let bandSinceMs = -1;
  let settled = false;
  let settleMs = 0;
  let inBand = 0;
  let bandFrames = 0;
  const newEpisode = (at: number) => {
    if (episodeMs >= 0 && !settled && lastFrameMs - episodeMs >= 5000) settleMs = Infinity;
    episodeMs = at;
    settled = false;
    bandSinceMs = -1;
  };
  while (clock.now() < endMs) {
    clock.advance(0.5);
    link.pump();
    while (clock.now() >= nextServerTickMs) {
      server.step();
      nextServerTickMs += TICK_MS;
    }
    link.pump();
    thread.release();
    const now = clock.now();
    if (now < nextFrameMs || now < thread.busyUntilMs) continue;
    const dt = Math.min(((now - lastFrameMs) / 1000) * dtScale, 0.1);
    client.update(dt);
    player.frame(dt, netClock, ring, client, client.state === "playing" ? local : null);
    lastFrameMs = now;
    const elapsed = now - startMs;
    if (client.state === "playing") {
      if (episodeMs < 0) newEpisode(now);
      const dilation = netClock.dilation;
      if (lastTarget >= 0 && dilation.targetTicks !== lastTarget) targetChanges++;
      lastTarget = dilation.targetTicks;
      const ok = Math.abs(dilation.depthTicks - dilation.targetTicks) <= 1;
      if (!ok) bandSinceMs = -1;
      else if (bandSinceMs < 0) bandSinceMs = now;
      if (!settled && bandSinceMs >= 0 && now - bandSinceMs >= 1000) {
        settled = true;
        settleMs = Math.max(settleMs, bandSinceMs - episodeMs);
      }
      if (now - episodeMs > 5000) {
        bandFrames++;
        if (ok) inBand++;
      }
      if (elapsed > 3000) maxJitter = Math.max(maxJitter, client.sync.jitterMs);
      if (elapsed > (seconds - 10) * 1000) {
        errSum += Math.abs(dilation.depthTicks - dilation.targetTicks);
        errN++;
      }
      if (now - shiftMs <= 2000) {
        shiftMinScale = Math.min(shiftMinScale, dilation.tickScale);
        shiftMaxScale = Math.max(shiftMaxScale, dilation.tickScale);
      }
      if (!shiftDone && pacing.shiftAtMs !== undefined && elapsed >= pacing.shiftAtMs) {
        shiftDone = true;
        shiftMs = now;
        const ticks = pacing.shiftTicks ?? 0;
        if (ticks > 0) netClock.catchUp((ticks * TICK_MS) / 1000);
        else netClock.resync(netClock.currentTick + ticks);
        newEpisode(now);
      }
    }
    nextFrameMs = now + pacing.interval(rng);
    const stall = client.state === "playing" ? pacing.stall(elapsed, rng) : 0;
    if (stall > 0) {
      stalls++;
      if (stall - 100 > 10 * TICK_MS) longStalls++;
      thread.busyUntilMs = now + stall;
      nextFrameMs = now + stall;
      newEpisode(now + stall);
    }
  }
  if (!settled && lastFrameMs - episodeMs >= 5000) settleMs = Infinity;
  return {
    profile: profile.name,
    pacing: pacing.name,
    seed,
    resyncs: client.stats.resyncs,
    stalls,
    longStalls,
    serverResyncs,
    corrections: local.stats.corrections,
    synthetic: server.inputs.stats.synthetic,
    depth: netClock.dilation.depthTicks,
    target: netClock.dilation.targetTicks,
    tickScale: netClock.dilation.tickScale,
    lead: client.stats.leadTicks,
    maxJitterMs: maxJitter,
    frameTimePct: client.stats.frameTimePct,
    meanDepthError: errN > 0 ? errSum / errN : 0,
    settleMs,
    inBandPct: bandFrames > 0 ? (inBand * 100) / bandFrames : 0,
    shiftMinScale,
    shiftMaxScale,
    targetChanges,
    state: client.state,
  };
}

function run(profile: NetworkProfile, pacing: Pacing, seconds: number, seed = 7): PacingResult {
  const r = runPacing(profile, pacing, seconds, seed);
  const out = process.env.NET_VERBOSE;
  if (out) appendFileSync(out, `${JSON.stringify(r)}\n`);
  expect(r.state).toBe("playing");
  return r;
}

const { lan, typical } = NETWORK_PROFILES;
const tcp = NETWORK_PROFILES["tcp-fallback"];

describe("net clock under browser-like frame pacing", () => {
  it("steady 60 fps: no resyncs, the buffer settles within ±1 tick of its target in under 5 s", () => {
    for (const profile of [lan, typical, tcp]) {
      const r = run(profile, steady(), 30);
      expect(r.resyncs).toBe(0);
      expect(r.serverResyncs).toBe(0);
      expect(r.settleMs).toBeLessThan(5000);
      expect(r.meanDepthError).toBeLessThan(1);
      expect(Math.abs(r.frameTimePct - 100)).toBeLessThan(2);
    }
  }, 120_000);

  it("one 1 s stall: at most one resync, local only, and the buffer settles again within 5 s", () => {
    for (const profile of [lan, typical, tcp]) {
      const r = run(profile, oneStall(10_000), 30);
      expect(r.stalls).toBe(1);
      expect(r.resyncs).toBeLessThanOrEqual(1);
      expect(r.serverResyncs).toBe(0);
      expect(r.settleMs).toBeLessThan(5000);
      // Snapshots handled after the stall don't count as network jitter (it read 325 ms, raising the buffer target).
      expect(r.maxJitterMs).toBeLessThan(40);
    }
  }, 120_000);

  it("hitches shorter than the dt cap + 10 ticks every 2–4 s: the clock gets the time back, no resyncs", () => {
    // Before the catch-up: 14 (lan) and 9 (typical) resyncs in 60 s, each deficit dilated away at ≤ 3 ticks/s.
    for (const profile of [lan, typical]) {
      const r = run(profile, hitches(), 60);
      expect(r.stalls).toBeGreaterThan(10);
      expect(r.longStalls).toBe(0);
      expect(r.resyncs).toBe(0);
      expect(r.meanDepthError).toBeLessThan(1);
      expect(Math.abs(r.frameTimePct - 100)).toBeLessThan(5);
    }
  }, 120_000);

  it("frames every 5–60 ms with 200–1000 ms stalls: at most one resync per long stall, buffer in band between stalls", () => {
    for (const profile of [lan, typical]) {
      for (const seed of [7, 8]) {
        const r = run(profile, irregular(), 60, seed);
        expect(r.longStalls).toBeGreaterThan(2);
        expect(r.resyncs).toBeLessThanOrEqual(r.longStalls);
        expect(r.serverResyncs).toBe(0);
        expect(r.settleMs).toBeLessThan(5000);
        expect(r.inBandPct).toBeGreaterThan(90);
      }
    }
  }, 240_000);

  it("dilation sign: a client 6 ticks too far ahead slows down (tickScale > 1), one 6 ticks behind speeds up, no resync", () => {
    // inputBufferDepthQ is quarter ticks of inputs the server holds beyond the tick it simulates: deeper than the target
    // means the client runs ahead, and a tickScale > 1 lengthens its tick.
    const ahead = run(lan, shifted(6), 20);
    expect(ahead.shiftMaxScale).toBeGreaterThan(1.03);
    expect(ahead.shiftMinScale).toBeGreaterThanOrEqual(0.995);
    const behind = run(lan, shifted(-6), 20);
    expect(behind.shiftMinScale).toBeLessThan(0.97);
    expect(behind.shiftMaxScale).toBeLessThanOrEqual(1.005);
    for (const r of [ahead, behind]) {
      expect(r.resyncs).toBe(0);
      expect(r.settleMs).toBeLessThan(5000);
    }
  }, 120_000);

  it("a frame dt 10% faster than wall time (a harness artifact) saturates dilation and resyncs every ~3.4 s; frameTimePct shows it", () => {
    // The browser F6 signature: buffer 7/3 t, dilation +5.0%, resyncs rising ~9 per 30 s.
    const r = run(tcp, steady(1.1), 30);
    expect(r.frameTimePct).toBeGreaterThan(105);
    expect(r.meanDepthError).toBeGreaterThan(2);
    expect(r.resyncs).toBeGreaterThan(5);
    expect(r.serverResyncs).toBe(0);
  }, 120_000);
});
