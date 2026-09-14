import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/testing/clock";
import { LinkConditioner } from "../src/testing/LinkConditioner";
import { createMemorySessionPair } from "../src/testing/memorySession";
import { NETWORK_PROFILES, type LinkParams } from "../src/testing/profiles";

function harness(link: LinkParams, seed = 1, kind: "webtransport" | "websocket" = "webtransport") {
  const clock = new ManualClock();
  const [a, b] = createMemorySessionPair({ clock, kind });
  const client = new LinkConditioner(a, { up: link, down: link }, clock, seed);
  const atServer: { seq: number; t: number }[] = [];
  const atClient: { seq: number; t: number }[] = [];
  b.onDatagram((bytes, t) => atServer.push({ seq: bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16), t }));
  client.onDatagram((bytes, t) => atClient.push({ seq: bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16), t }));
  const sentAt: number[] = [];
  const sendBoth = (seq: number) => {
    sentAt[seq] = clock.now();
    const bytes = new Uint8Array([seq & 255, (seq >> 8) & 255, (seq >> 16) & 255]);
    client.sendDatagram(bytes);
    b.sendDatagram(bytes);
  };
  return { clock, client, server: b, atServer, atClient, sendBoth, sentAt };
}

function drive(h: ReturnType<typeof harness>, count: number, intervalMs = 1000 / 60) {
  for (let i = 0; i < count; i++) {
    h.sendBoth(i);
    const until = h.clock.now() + intervalMs;
    while (h.clock.now() < until) {
      h.clock.advance(1);
      h.client.pump();
    }
  }
  for (let i = 0; i < 2000; i++) {
    h.clock.advance(1);
    h.client.pump();
  }
}

describe("LinkConditioner", () => {
  it("typical profile: ~1% bursty loss, 30 ms ± 8 ms one-way, FIFO", () => {
    const h = harness(NETWORK_PROFILES.typical.up, 42);
    const n = 30000;
    drive(h, n);
    const loss = 1 - h.atServer.length / n;
    expect(loss).toBeGreaterThan(0.006);
    expect(loss).toBeLessThan(0.015);
    const bursts: number[] = [];
    let run = 0;
    let expected = 0;
    for (const p of h.atServer) {
      const gap = p.seq - expected;
      if (gap > 0) bursts.push(gap);
      expected = p.seq + 1;
      run++;
    }
    const meanBurst = bursts.reduce((a, b) => a + b, 0) / bursts.length;
    expect(meanBurst).toBeGreaterThan(2);
    expect(run).toBe(h.atServer.length);
    const delays = h.atServer.map((p) => p.t - h.sentAt[p.seq]!);
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
    expect(mean).toBeGreaterThan(28);
    expect(mean).toBeLessThan(40);
    for (let i = 1; i < h.atServer.length; i++) expect(h.atServer[i]!.seq).toBeGreaterThan(h.atServer[i - 1]!.seq);
    expect(h.atClient.length / n).toBeGreaterThan(0.98);
  });

  it("reorders and duplicates when asked", () => {
    const h = harness({ latencyMs: 20, jitterMs: 5, lossRate: 0, reorderRate: 0.05, duplicateRate: 0.02 }, 7);
    drive(h, 5000);
    let inversions = 0;
    for (let i = 1; i < h.atServer.length; i++) if (h.atServer[i]!.seq < h.atServer[i - 1]!.seq) inversions++;
    expect(inversions).toBeGreaterThan(50);
    expect(h.atServer.length).toBeGreaterThan(5050);
  });

  it("outages, MTU and bandwidth", () => {
    const h = harness({ latencyMs: 10, jitterMs: 0, lossRate: 0, outages: [{ startMs: 1000, durationMs: 500 }], mtuBytes: 2 }, 1);
    drive(h, 120);
    expect(h.atServer.length).toBe(0); // 3-byte datagrams exceed the 2-byte MTU up
    expect(h.atClient.length).toBeGreaterThan(80);
    expect(h.atClient.length).toBeLessThan(95); // ~30 dropped by the outage down
    const bw = harness({ latencyMs: 1, jitterMs: 0, lossRate: 0, bandwidthBytesPerSec: 30, bandwidthBurstBytes: 30 });
    let accepted = 0;
    for (let i = 0; i < 20; i++) if (bw.client.sendDatagram(new Uint8Array(3))) accepted++;
    expect(accepted).toBe(10);
  });

  it("tcp-fallback: nothing lost, losses become head-of-line delays", () => {
    const h = harness(NETWORK_PROFILES["tcp-fallback"].up, 3, "websocket");
    drive(h, 6000);
    expect(h.atServer.length).toBe(6000);
    for (let i = 1; i < h.atServer.length; i++) expect(h.atServer[i]!.seq).toBe(i);
    expect(h.client.upStats.retransmits).toBeGreaterThan(20);
    const delays = h.atServer.map((p) => p.t - h.sentAt[p.seq]!);
    expect(Math.max(...delays)).toBeGreaterThan(70);
  });

  it("streams are reliable and ordered through the conditioner; close propagates", () => {
    const clock = new ManualClock();
    const [a, b] = createMemorySessionPair({ clock });
    const c = new LinkConditioner(a, NETWORK_PROFILES.bad, clock, 5);
    const got: number[] = [];
    b.onStream((bytes) => got.push(bytes[0]!));
    for (let i = 0; i < 100; i++) {
      c.sendStream(new Uint8Array([i]));
      clock.advance(3);
      c.pump();
    }
    clock.advance(1000);
    c.pump();
    expect(got).toEqual(Array.from({ length: 100 }, (_, i) => i));
    c.close(7);
    expect(b.closed).toBe(true);
    expect(b.closeCode).toBe(7);
  });

  it("is deterministic for a seed", () => {
    const a = harness(NETWORK_PROFILES.bad.up, 11);
    const b = harness(NETWORK_PROFILES.bad.up, 11);
    drive(a, 2000);
    drive(b, 2000);
    expect(a.atServer).toEqual(b.atServer);
  });
});

describe("memory session pair", () => {
  it("delivers in order without recursion when handlers reply", () => {
    const clock = new ManualClock(5);
    const [a, b] = createMemorySessionPair({ clock });
    const log: string[] = [];
    b.onDatagram((bytes, t) => {
      log.push(`b${bytes[0]}@${t}`);
      if (bytes[0]! < 3) b.sendDatagram(new Uint8Array([bytes[0]! + 1]));
    });
    a.onDatagram((bytes) => {
      log.push(`a${bytes[0]}`);
      a.sendDatagram(new Uint8Array([bytes[0]! + 1]));
    });
    a.sendDatagram(new Uint8Array([0]));
    expect(log).toEqual(["b0@5", "a1", "b2@5", "a3", "b4@5"]);
    expect(a.sendDatagram(new Uint8Array(2000))).toBe(false);
  });
});
