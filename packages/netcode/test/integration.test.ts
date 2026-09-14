import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import { MsgId } from "@twobullets/protocol/messages/ids";
import { createInputPacketBuffer, decodeInputPacketInto, encodeInputPacket } from "@twobullets/protocol/messages/input";
import { decodePing, encodePing, pingRttMs } from "@twobullets/protocol/messages/ping";
import { EntityPresence, encodeSnapshot, type Snapshot } from "@twobullets/protocol/messages/snapshot";
import {
  dequantizeOwnerVel,
  dequantizePosXZ,
  quantizeOwnerVel,
  quantizePosXZ,
  quantizePosY,
  quantizeRemoteVel,
  RemoteFlags,
} from "@twobullets/protocol/quantize";
import type { PlayerInput } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import { ClientSnapshotStore, ServerSnapshotBaselines } from "../src/baselines";
import { ServerInputBuffer } from "../src/inputBuffer";
import { createInterpolatedPose, EntityInterpolator, InterpolationDelay } from "../src/interpolation";
import { createReconcileResult, PredictionHistory, reconcile, ReconcileKind, type ReplayHooks } from "../src/prediction";
import { DilatedTickClock, TimeDilation } from "../src/timeDilation";
import { TimeSync } from "../src/timeSync";
import { ManualClock } from "../src/testing/clock";
import { LinkConditioner } from "../src/testing/LinkConditioner";
import { createMemorySessionPair } from "../src/testing/memorySession";
import { NETWORK_PROFILES, type NetworkProfile } from "../src/testing/profiles";
import { createSeededRng } from "../src/testing/rng";

// Toy 1D movement over the real codecs and a conditioned link: server (input buffer, baselines, snapshots) and client
// (clock sync, time dilation, prediction + reconciliation, remote interpolation).

const TICK_MS = 1000 / 60;
const SPEED = 5;
const ACCEL = 40;
/** WSS head-of-line stalls need a deeper input buffer (target 1 → ~26% synthetic ticks on tcp-fallback, 3 → ~1%). */
const WS_BUFFER_TICKS = 3;

interface Toy {
  readonly x: number;
  readonly v: number;
}

function toyStep(s: Toy, forward: number): Toy {
  const target = forward * SPEED;
  const dv = target - s.v;
  const max = ACCEL / 60;
  const v = Math.abs(dv) <= max ? target : s.v + Math.sign(dv) * max;
  return { x: s.x + v / 60, v };
}

/** The client's scripted stick: a new direction every 0.75 s. */
function script(tick: number): -1 | 0 | 1 {
  const seg = Math.floor(tick / 45);
  const h = Math.imul(seg ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return ((h % 3) - 1) as -1 | 0 | 1;
}

function botAt(tickF: number): { x: number; z: number; vx: number; vz: number } {
  const t = tickF / 60;
  return { x: 10 * Math.sin(0.8 * t), z: 5 * Math.cos(0.5 * t), vx: 8 * Math.cos(0.8 * t), vz: -2.5 * Math.sin(0.5 * t) };
}

interface RunResult {
  startedAtMs: number;
  corrections: number;
  correctionsAfterWarmup: number;
  resyncsAfterWarmup: number;
  synthetic: number;
  late: number;
  consumed: number;
  interpMeanErr: number;
  interpP99Err: number;
  extrapolatedFrac: number;
  maxRenderStepDev: number;
  renderJumps: number;
  clockErrMs: number;
  finalPosErr: number;
  meanDelayMs: number;
  upBytesPerPacket: number;
  downBytesPerPacket: number;
}

function runMatch(profile: NetworkProfile, seconds: number, seed: number): RunResult {
  const clock = new ManualClock(10_000);
  const rng = createSeededRng(seed);
  const [clientEnd, serverEnd] = createMemorySessionPair({ clock });
  const link = new LinkConditioner(clientEnd, profile, clock, seed);

  // ---- Server ----
  const serverStart = clock.now();
  let serverTick = 0;
  let nextServerTickMs = serverStart;
  let serverState: Toy = { x: 0, v: 0 };
  const serverStates = new Map<number, Toy>();
  const inputBuffer = new ServerInputBuffer();
  const baselines = new ServerSnapshotBaselines();
  const sw = createBitWriter(1500);
  const sr = createBitReader(new Uint8Array(0));
  const packet = createInputPacketBuffer();
  let lastEcho = -1;
  let lastEchoTick = -1;
  let lastInputRecvMs = 0;
  let downBytes = 0;
  let downPackets = 0;
  let upBytes = 0;
  let upPackets = 0;

  serverEnd.onDatagram((bytes, recvMs) => {
    upBytes += bytes.length;
    upPackets++;
    sr.reset(bytes);
    if (bytes[0] === MsgId.Ping) {
      const ping = decodePing(sr);
      if (ping === null || ping.reply) return;
      sw.reset();
      encodePing(sw, { seq: ping.seq, originTimeMs: ping.originTimeMs, holdMs: clock.now() - recvMs, reply: true });
      serverEnd.sendDatagram(sw.bytes());
      return;
    }
    if (!decodeInputPacketInto(sr, serverTick, packet)) return;
    inputBuffer.insertPacket(packet.inputs, packet.count, serverTick);
    baselines.ack(packet.ackSnapshotTick);
    if (packet.newestTick > lastEchoTick) {
      lastEchoTick = packet.newestTick;
      lastEcho = packet.clientTimeMs;
      lastInputRecvMs = recvMs;
    }
  });

  function serverStep(): void {
    const input = inputBuffer.take(serverTick);
    serverState = toyStep(serverState, input.forward);
    serverStates.set(serverTick, serverState);
    const bot = botAt(serverTick);
    const snap: Snapshot = {
      header: {
        serverTick,
        baselineTick: null,
        lastProcessedInputTick: inputBuffer.lastProcessedInputTick,
        clientTimeEcho: lastEcho < 0 ? 0 : lastEcho,
        serverHoldMs: lastEcho < 0 ? 0 : clock.now() - lastInputRecvMs,
        inputBufferDepthQ: inputBuffer.depthQ,
        sections: 0,
      },
      owner: {
        xMm: quantizePosXZ(serverState.x),
        yMm: quantizePosY(0),
        zMm: quantizePosXZ(0),
        vxMmS: quantizeOwnerVel(serverState.v),
        vyMmS: 0,
        vzMmS: 0,
        stance: 0,
        grounded: true,
        sprinting: false,
        jumpHeld: false,
        moveMode: 0,
        coyoteTicks: 0,
        jumpBufferTicks: 0,
        groundIgnoreTicks: 0,
      },
      entities: [
        {
          slot: 1,
          presence: EntityPresence.full,
          xMm: quantizePosXZ(bot.x),
          yMm: quantizePosY(0),
          zMm: quantizePosXZ(bot.z),
          yawQ: 0,
          pitchQ: 512,
          vxQ: quantizeRemoteVel(bot.vx),
          vyQ: 0,
          vzQ: quantizeRemoteVel(bot.vz),
          flags: RemoteFlags.grounded,
        },
      ],
    };
    sw.reset();
    encodeSnapshot(sw, snap, baselines.baselineFor(serverTick));
    baselines.record(snap);
    downBytes += sw.byteLength;
    downPackets++;
    serverEnd.sendDatagram(sw.bytes());
    serverTick++;
  }

  // ---- Client ----
  const sync = new TimeSync();
  const dilation = new TimeDilation({ targetTicks: profile.kind === "websocket" ? WS_BUFFER_TICKS : 1 });
  const tickClock = new DilatedTickClock();
  const history = new PredictionHistory<Toy, number>();
  const store = new ClientSnapshotStore();
  const remote = new EntityInterpolator();
  const interpDelay = new InterpolationDelay();
  const pose = createInterpolatedPose();
  const reconcileOut = createReconcileResult<Toy>();
  const cw = createBitWriter(512);
  const cr = createBitReader(new Uint8Array(0));
  let started = false;
  let startedAtMs = -1;
  let clientState: Toy = { x: 0, v: 0 };
  let lastReconciled = -1;
  let lastProcessedInput = -1;
  let pings = 0;
  let pingSeq = 0;
  let corrections = 0;
  let correctionsAfterWarmup = 0;
  let resyncsAfterWarmup = 0;
  const warmupMs = serverStart + 3000;

  const hooks: ReplayHooks<Toy, number> = {
    step: (s, forward) => toyStep(s, forward),
    restore: () => {},
    withinTolerance: (p, a) =>
      Math.abs(quantizePosXZ(p.x) - quantizePosXZ(a.x)) <= 10 && Math.abs(quantizeOwnerVel(p.v) - quantizeOwnerVel(a.v)) <= 50,
  };

  link.onDatagram((bytes, recvMs) => {
    cr.reset(bytes);
    if (bytes[0] === MsgId.Ping) {
      const ping = decodePing(cr);
      if (ping?.reply) {
        sync.addRttSample(pingRttMs(ping, recvMs), recvMs);
        pings++;
      }
      return;
    }
    const snap = store.decode(cr, Math.max(0, sync.newestSnapshotTick));
    if (snap === null) return;
    const h = snap.header;
    sync.onSnapshot(h.serverTick, recvMs, h.lastProcessedInputTick >= 0 ? h.clientTimeEcho : -1, h.serverHoldMs);
    if (h.lastProcessedInputTick > lastProcessedInput) lastProcessedInput = h.lastProcessedInputTick;
    if (started && h.lastProcessedInputTick >= 0) dilation.onBufferDepth(h.inputBufferDepthQ / 4, recvMs);
    for (const e of snap.entities) remote.pushEntity(h.serverTick, e);
    if (!started || snap.owner === null || h.serverTick <= lastReconciled || history.newestTick < 0) return;
    lastReconciled = h.serverTick;
    const auth: Toy = { x: dequantizePosXZ(snap.owner.xMm), v: dequantizeOwnerVel(snap.owner.vxMmS) };
    const r = reconcile(history, h.serverTick, auth, hooks, reconcileOut);
    if (r.kind === ReconcileKind.replayed || r.kind === ReconcileKind.snapped) {
      corrections++;
      if (recvMs > warmupMs) correctionsAfterWarmup++;
      clientState = r.state!;
    }
  });

  function sendInputs(newest: number): void {
    const inputs: PlayerInput[] = [];
    for (let t = newest; t > lastProcessedInput && t > newest - 6; t--) {
      const forward = history.inputAt(t);
      if (forward === undefined) break;
      inputs.push({ tick: t, forward: forward as -1 | 0 | 1, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null });
    }
    if (inputs.length === 0) return;
    cw.reset();
    encodeInputPacket(cw, {
      newestTick: newest,
      ackSnapshotTick: store.newestTick,
      clientTimeMs: Math.floor(clock.now()) & 0xffff,
      interpDelayMs: interpDelay.delayMs,
      inputs,
    });
    link.sendDatagram(cw.bytes());
  }

  const interpErrors: number[] = [];
  let extrapolatedFrames = 0;
  let sampledFrames = 0;
  let lastRenderTick = NaN;
  let maxRenderStepDev = 0;
  let renderJumps = 0;
  let clockErr = 0;
  let delaySum = 0;

  function clientFrame(dtMs: number): void {
    const now = clock.now();
    if (!started) {
      cw.reset();
      encodePing(cw, { seq: pingSeq++ & 0xff, originTimeMs: Math.floor(now) & 0xffff, holdMs: 0, reply: false });
      link.sendDatagram(cw.bytes());
      if (sync.sampleCount >= 10 && pings >= 10) {
        tickClock.start(Math.ceil(sync.clientTargetTickAt(now, dilation.targetTicks)));
        started = true;
        startedAtMs = now - serverStart;
      }
      return;
    }
    dilation.setJitter(sync.jitterMs);
    const due = Math.min(5, tickClock.advance(dtMs, dilation.tickScale));
    for (let i = 0; i < due; i++) {
      const tick = tickClock.tick;
      const forward = script(tick);
      clientState = toyStep(clientState, forward);
      history.record(tick, forward, clientState);
      sendInputs(tick);
      tickClock.tick++;
    }
    const target = sync.clientTargetTickAt(now, dilation.targetTicks);
    if (Math.abs(tickClock.tick - target) > 10) {
      if (now > warmupMs) resyncsAfterWarmup++;
      tickClock.start(Math.round(target));
      history.clear();
      dilation.reset();
    }

    const delay = interpDelay.update(now, TICK_MS, sync.lossRatio(), sync.arrivalSpreadMs);
    const renderTick = sync.renderTickAt(now, delay);
    remote.sample(renderTick, pose);
    if (now > warmupMs && pose.valid) {
      const truth = botAt(renderTick);
      interpErrors.push(Math.sqrt((pose.x - truth.x) ** 2 + (pose.z - truth.z) ** 2));
      sampledFrames++;
      if (pose.extrapolated) extrapolatedFrames++;
      if (!Number.isNaN(lastRenderTick)) {
        const dev = Math.abs(renderTick - lastRenderTick - dtMs / TICK_MS);
        maxRenderStepDev = Math.max(maxRenderStepDev, dev);
        if (dev > 0.25) renderJumps++;
      }
      clockErr = Math.max(clockErr, now > warmupMs ? Math.abs(sync.serverTickAt(now) - (now - serverStart) / TICK_MS) * TICK_MS : 0);
      delaySum += delay;
    }
    lastRenderTick = renderTick;
  }

  // ---- Event loop: 1 ms steps; server ticks on schedule; client frames at ~144 Hz with frame-time jitter ----
  const endMs = serverStart + seconds * 1000;
  let nextFrameMs = serverStart + 3;
  let lastFrameMs = serverStart;
  while (clock.now() < endMs) {
    clock.advance(0.5);
    link.pump();
    while (clock.now() >= nextServerTickMs) {
      serverStep();
      nextServerTickMs += TICK_MS;
    }
    link.pump();
    if (clock.now() >= nextFrameMs) {
      clientFrame(clock.now() - lastFrameMs);
      lastFrameMs = clock.now();
      nextFrameMs += 1000 / 144 + (rng.next() - 0.5) * 2;
    }
  }

  // Compare the newest client prediction the server has also simulated.
  let finalPosErr = Infinity;
  for (let t = history.newestTick; t >= Math.max(0, history.oldestTick); t--) {
    const s = serverStates.get(t);
    const p = history.stateAt(t);
    if (s && p) {
      finalPosErr = Math.abs(s.x - p.x);
      break;
    }
  }

  interpErrors.sort((a, b) => a - b);
  return {
    startedAtMs,
    corrections,
    correctionsAfterWarmup,
    resyncsAfterWarmup,
    synthetic: inputBuffer.stats.synthetic,
    late: inputBuffer.stats.late,
    consumed: inputBuffer.stats.consumed,
    interpMeanErr: interpErrors.reduce((a, b) => a + b, 0) / interpErrors.length,
    interpP99Err: interpErrors[Math.floor(interpErrors.length * 0.99)]!,
    extrapolatedFrac: extrapolatedFrames / Math.max(1, sampledFrames),
    maxRenderStepDev,
    renderJumps,
    clockErrMs: clockErr,
    finalPosErr,
    meanDelayMs: delaySum / Math.max(1, sampledFrames),
    upBytesPerPacket: upBytes / Math.max(1, upPackets),
    downBytesPerPacket: downBytes / Math.max(1, downPackets),
  };
}

const log = (label: string, r: RunResult) => {
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.NETCODE_VERBOSE) console.log(label, r);
};

describe("integration: toy 1D movement over LinkConditioner", () => {
  it("typical profile: prediction converges with few corrections, interpolation stays smooth", () => {
    const seconds = 120;
    const r = runMatch(NETWORK_PROFILES.typical, seconds, 2024);
    log("typical", r);
    expect(r.startedAtMs).toBeGreaterThan(0);
    expect(r.startedAtMs).toBeLessThan(1000);
    // Script changes direction ~80×/min; a correction needs a lost/late input exactly at a change.
    expect(r.correctionsAfterWarmup / (seconds / 60)).toBeLessThan(4);
    expect(r.resyncsAfterWarmup).toBe(0);
    expect(r.finalPosErr).toBeLessThan(0.01);
    expect(r.synthetic / (r.synthetic + r.consumed)).toBeLessThan(0.02);
    expect(r.interpMeanErr).toBeLessThan(0.01);
    expect(r.interpP99Err).toBeLessThan(0.02);
    expect(r.extrapolatedFrac).toBeLessThan(0.01);
    expect(r.maxRenderStepDev).toBeLessThan(1.5);
    expect(r.meanDelayMs).toBeGreaterThanOrEqual(25);
    expect(r.meanDelayMs).toBeLessThan(100);
    // Clock bias of the min-filter estimator under symmetric (netem-style) jitter; tick alignment is closed-loop.
    expect(r.clockErrMs).toBeLessThan(25);
  });

  it("lan, bad and tcp-fallback profiles stay stable", () => {
    const lan = runMatch(NETWORK_PROFILES.lan, 30, 7);
    log("lan", lan);
    expect(lan.corrections).toBe(0);
    expect(lan.extrapolatedFrac).toBe(0);
    const bad = runMatch(NETWORK_PROFILES.bad, 60, 8);
    log("bad", bad);
    expect(bad.resyncsAfterWarmup).toBe(0);
    expect(bad.finalPosErr).toBeLessThan(0.01);
    expect(bad.interpP99Err).toBeLessThan(0.5);
    const tcp = runMatch(NETWORK_PROFILES["tcp-fallback"], 60, 9);
    log("tcp-fallback", tcp);
    expect(tcp.resyncsAfterWarmup).toBe(0);
    expect(tcp.finalPosErr).toBeLessThan(0.01);
    expect(tcp.correctionsAfterWarmup).toBeLessThan(10);
  });
});
