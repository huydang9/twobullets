import { createMemorySessionPair, NETWORK_PROFILES } from "@twobullets/netcode";
import { dequantizePosXZ, DisconnectReason, type Mutable, type OwnerMoveBlock } from "@twobullets/protocol";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import { createOwnerBlock } from "@twobullets/netcode/replication";
import { createHarness } from "./harness";

// Host + simulated clients on a virtual clock over memory sessions and LinkConditioners.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

const SECONDS = 8;

describe("match server in-process", () => {
  for (const [clientCount, profile] of [
    [2, "lan"],
    [10, "typical"],
  ] as const) {
    it(`${clientCount} clients on "${profile}": handshake, authoritative movement, snapshots whose owner blocks match the server`, async () => {
      const h = await createHarness(havok, { recordOwners: true });
      const lossy = profile !== "lan";
      for (let i = 0; i < clientCount; i++) h.connect({ profile: NETWORK_PROFILES[profile], seed: 7 + i, leadTicks: lossy ? 8 : 3 });
      h.run(250);
      for (const c of h.clients) {
        expect(c.welcome, "Welcome received").not.toBeNull();
        expect(c.disconnect).toBeNull();
      }
      expect(new Set(h.clients.map((c) => c.playerSlot)).size).toBe(clientCount);

      const scratch: Mutable<OwnerMoveBlock> = createOwnerBlock();
      const spawn = new Map<number, { x: number; z: number }>();
      for (const p of h.match.players) {
        h.match.ownerBlockOf(p.slot, scratch);
        spawn.set(p.slot, { x: dequantizePosXZ(scratch.xMm), z: dequantizePosXZ(scratch.zMm) });
      }

      let compared = 0;
      const mismatches: string[] = [];
      const entityCounts = new Set<number>();
      const received = new Array<number>(clientCount).fill(0);
      h.clients.forEach((client, i) => {
        client.onSnapshot = (snap) => {
          received[i]!++;
          const slot = client.playerSlot;
          entityCounts.add(snap.entities.length);
          const server = h.ownerHistory.get(snap.header.serverTick * 16 + slot);
          if (server === undefined || snap.owner === null) {
            mismatches.push(`client ${i} tick ${snap.header.serverTick}: no ${server === undefined ? "server record" : "owner block"}`);
            return;
          }
          compared++;
          const a = JSON.stringify(snap.owner);
          const b = JSON.stringify(server);
          if (a !== b) mismatches.push(`client ${i} tick ${snap.header.serverTick}: ${a} != ${b}`);
          if (snap.header.lastProcessedInputTick > snap.header.serverTick) mismatches.push(`client ${i}: processed input ahead of snapshot`);
          if (snap.entities.some((e) => e.slot === slot)) mismatches.push(`client ${i}: itself listed as a remote entity`);
        };
      });

      h.run(SECONDS * 1000);

      expect(mismatches.slice(0, 5)).toEqual([]);
      expect(compared).toBeGreaterThan(clientCount * SECONDS * 50);
      expect([...entityCounts]).toEqual([clientCount - 1]);
      for (const [i, c] of h.clients.entries()) {
        // 60 Hz minus downstream loss (typical: 1% bursty).
        expect(received[i], `client ${i} snapshots`).toBeGreaterThan(SECONDS * 60 * (lossy ? 0.9 : 0.98));
        expect(c.snapshotsDropped, `client ${i} undecodable snapshots`).toBe(0);
        expect(c.lastProcessedInputTick, `client ${i} input acks`).toBeGreaterThan(h.match.nextTick - 60);
        expect(c.disconnect).toBeNull();
      }

      // The server state advanced from client input: everyone walked away from spawn, most ticks used real input.
      let consumed = 0;
      let synthetic = 0;
      for (const p of h.match.players) {
        consumed += p.inputs.stats.consumed;
        synthetic += p.inputs.stats.synthetic;
        h.match.ownerBlockOf(p.slot, scratch);
        const s = spawn.get(p.slot)!;
        const moved = Math.sqrt((dequantizePosXZ(scratch.xMm) - s.x) ** 2 + (dequantizePosXZ(scratch.zMm) - s.z) ** 2);
        expect(moved, `slot ${p.slot} moved`).toBeGreaterThan(1);
      }
      expect(consumed / (consumed + synthetic)).toBeGreaterThan(lossy ? 0.85 : 0.95);

      // Acked baselines are in use: the mean snapshot is far below a full one.
      const stats = h.match.snapshots.stats;
      expect(stats.bytesOut / stats.sent).toBeLessThan(30 + 12 * clientCount);

      await h.dispose();
      h.run(200);
      for (const c of h.clients) expect(c.disconnect?.reason).toBe(DisconnectReason.serverShutdown);
    }, 120_000);
  }

  it("rejects a mismatched protocol version at Hello", async () => {
    const h = await createHarness(havok);
    const client = h.connect({ protocolVersion: 999 });
    h.run(50);
    expect(client.welcome).toBeNull();
    expect(client.disconnect?.reason).toBe(DisconnectReason.versionMismatch);
    expect(h.serverEnds[0]!.closed).toBe(true);
    expect(h.match.playerCount).toBe(0);
    await h.dispose();
  });

  it("rejects bad-signature, expired, replayed, wrong-host and foreign-match tokens", async () => {
    const h = await createHarness(havok);
    const badSig = h.connect({ token: h.token({ secret: "wrong" }) });
    const expired = h.connect({ token: h.token({ iat: 1_000, exp: 1_100 }) });
    const reused = h.token();
    const first = h.connect({ token: reused });
    const replay = h.connect({ token: reused });
    const foreign = h.connect({ token: h.token({ mid: "other-match" }) });
    const wrongHost = h.connect({ token: h.token({ hid: "someone-else" }) });
    h.run(50);
    expect(badSig.disconnect?.reason).toBe(DisconnectReason.badToken);
    expect(expired.disconnect?.reason).toBe(DisconnectReason.badToken);
    expect(first.welcome).not.toBeNull();
    expect(replay.disconnect?.reason).toBe(DisconnectReason.badToken);
    expect(foreign.disconnect?.reason).toBe(DisconnectReason.notAssigned);
    expect(wrongHost.disconnect?.reason).toBe(DisconnectReason.badToken);
    expect(h.match.playerCount).toBe(1);
    expect(h.sessions.stats.rejected).toEqual({ badToken: 4, notAssigned: 1 });
    await h.dispose();
  });

  it("newer epoch replaces a connection, older epoch is refused, silent and idle connections time out, 11th player is refused", async () => {
    const h = await createHarness(havok);
    const a = h.connect({ token: h.token({ sub: "dup", epoch: 0 }) });
    h.run(50);
    const slot = a.playerSlot;
    const b = h.connect({ token: h.token({ sub: "dup", epoch: 1 }) });
    h.run(50);
    expect(a.disconnect?.reason).toBe(DisconnectReason.replaced);
    expect(b.welcome?.playerSlot).toBe(slot);
    const stale = h.connect({ token: h.token({ sub: "dup", epoch: 0 }) });
    h.run(50);
    expect(stale.disconnect?.reason).toBe(DisconnectReason.replaced);
    expect(h.sessions.stats.resumed).toBe(1);

    for (let i = 0; i < 9; i++) h.connect();
    const eleventh = h.connect();
    h.run(100);
    expect(h.match.playerCount).toBe(10);
    expect(eleventh.disconnect?.reason).toBe(DisconnectReason.matchFull);

    const [, silent] = createMemorySessionPair({ clock: h.clock });
    h.acceptRaw(silent);
    const idle = h.clients[4]!;
    idle.paused = true;
    h.run(6000);
    expect(silent.closed).toBe(true);
    expect(idle.disconnect).toBeNull();
    h.run(6000);
    expect(idle.disconnect?.reason).toBe(DisconnectReason.timeout);
    expect(b.disconnect).toBeNull();
    // The idle player's character stays in the world for the reconnect grace.
    expect(h.match.playerCount).toBe(10);
    expect(h.match.connectedCount).toBe(9);
    await h.dispose();
  }, 60_000);
});
