import { createBitReader, createBitWriter, decodeRoster, DisconnectReason, encodeDisconnect, MsgId, type Roster } from "@twobullets/protocol";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness";

// Roster (protocol v5) on the control stream: right after Welcome, then once per change (join, leave) to everyone else.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

/** Stream message ids and decoded rosters the server sent to client `index` (tap installed before Hello is handled). */
function tap(h: Harness, index: number): { ids: number[]; rosters: Roster[] } {
  const out = { ids: [] as number[], rosters: [] as Roster[] };
  const end = h.serverEnds[index]!;
  const send = end.sendStream.bind(end);
  end.sendStream = (bytes: Uint8Array) => {
    out.ids.push(bytes[0]!);
    if (bytes[0] === MsgId.Roster) {
      const roster = decodeRoster(createBitReader(bytes));
      expect(roster).not.toBeNull();
      out.rosters.push(roster!);
    }
    send(bytes);
  };
  return out;
}

describe("Roster", () => {
  it("after Welcome and on joins and leaves; nicknames from the token, bots by seat index", async () => {
    const h = await createHarness(havok, {
      maxPlayers: 4,
      teamMode: "duo",
      configure: (c) => ({ ...c, teams: [{ teamId: 0, accountIds: ["a0", "bot:3"] }, { teamId: 1, accountIds: ["b0", "b1"] }] }),
    });
    h.connect({ token: h.token({ sub: "a0", team: 0, nick: "Huy Đặng" }) });
    const a0 = tap(h, 0);
    h.run(100);
    expect(a0.ids.slice(0, 2)).toEqual([MsgId.Welcome, MsgId.Roster]);
    expect(a0.rosters).toEqual([
      {
        players: [
          { slot: 0, team: 0, name: "Huy Đặng", isBot: false, botIndex: -1, connected: true },
          { slot: 1, team: 0, name: "", isBot: true, botIndex: 3, connected: true },
        ],
      },
    ]);

    h.connect({ token: h.token({ sub: "b0", team: 1 }) });
    const b0 = tap(h, 1);
    h.run(100);
    // The joiner gets exactly one roster (no second copy at tick end); the others get the change once.
    expect(b0.rosters).toHaveLength(1);
    expect(a0.rosters).toHaveLength(2);
    expect(a0.rosters[1]).toEqual(b0.rosters[0]);
    expect(b0.rosters[0]!.players.map((p) => [p.slot, p.name, p.connected])).toEqual([
      [0, "Huy Đặng", true],
      [1, "", true],
      [2, "b0", true],
    ]);

    // b0 leaves: a0 sees it disconnected (the slot stays for the reconnect grace).
    const w = createBitWriter(8);
    encodeDisconnect(w, { reason: DisconnectReason.clientLeave, detail: 0 });
    h.links[1]!.sendStream(w.bytes());
    h.run(100);
    expect(a0.rosters).toHaveLength(3);
    expect(a0.rosters[2]!.players.find((p) => p.slot === 2)).toMatchObject({ name: "b0", connected: false });
    h.run(200);
    expect(a0.rosters).toHaveLength(3);
    await h.dispose();
  }, 60_000);
});
