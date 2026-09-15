import type { Snapshot } from "@twobullets/protocol";
import { describe, expect, it } from "vitest";
import { ClientReplication, TEAMMATE_KEYFRAME_SNAPSHOTS } from "../src/snapshot/SnapshotBuilder";

// When the builder puts the teammate vitals group in a recipient's snapshot: from a change until the client acks a
// snapshot that carried it (lost datagrams can't leave a stale bar), on full snapshots, and as a keyframe.

function sent(net: ClientReplication, tick: number, carried: boolean): void {
  const snap: Snapshot = { header: { serverTick: tick, baselineTick: null, lastProcessedInputTick: -1, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 }, owner: null, entities: [] };
  net.baselines.record(snap);
  net.teammateKeyframeIn = carried ? TEAMMATE_KEYFRAME_SNAPSHOTS : net.teammateKeyframeIn - 1;
}

describe("teammate vitals scheduling", () => {
  it("resends a change until an ack at or after it, then only keyframes; a reset starts over", () => {
    const net = new ClientReplication();
    const mate = net.teammatePool[0]!;
    Object.assign(mate, { slot: 3, life: 0, health: 100 });
    expect(net.teammatesDue(10, 1, true)).toBe(true);
    sent(net, 10, true);
    net.baselines.ack(10);
    expect(net.teammatesDue(11, 1, false)).toBe(false);
    sent(net, 11, false);

    // Damage at tick 12: carried by 12 and 13 (both lost), still carried while the newest ack is older.
    mate.health = 78;
    for (let tick = 12; tick <= 14; tick++) {
      expect(net.teammatesDue(tick, 1, false)).toBe(true);
      sent(net, tick, true);
    }
    net.baselines.ack(11);
    expect(net.teammatesDue(15, 1, false)).toBe(true);
    sent(net, 15, true);
    net.baselines.ack(14);
    expect(net.teammatesDue(16, 1, false)).toBe(false);

    // Keyframe after TEAMMATE_KEYFRAME_SNAPSHOTS sent snapshots without the group.
    let tick = 16;
    for (let i = 0; i < TEAMMATE_KEYFRAME_SNAPSHOTS; i++, tick++) {
      expect(net.teammatesDue(tick, 1, false)).toBe(false);
      sent(net, tick, false);
    }
    expect(net.teammatesDue(tick, 1, false)).toBe(true);

    // Revive progress is a change too; no teammates means no group.
    sent(net, tick, true);
    net.baselines.ack(tick);
    Object.assign(mate, { life: 1, health: 0, downedHealth: 80, reviveQ: 5, reviverIsMe: true });
    expect(net.teammatesDue(tick + 1, 1, false)).toBe(true);
    expect(net.teammatesDue(tick + 2, 0, false)).toBe(false);

    net.reset(tick + 2);
    expect(net.teammatesDue(tick + 3, 1, false)).toBe(true);
  });
});
