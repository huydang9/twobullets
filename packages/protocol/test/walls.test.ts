import { describe, expect, it } from "vitest";
import { createBitReader } from "../src/bits";
import { describeMessage } from "../src/debug/describe";
import { MsgId } from "../src/messages/ids";
import { PROTOCOL_VERSION } from "../src/version";
import {
  createWallUpdateBuffer,
  decodeWallUpdate,
  decodeWallUpdateInto,
  WALL_HEAL_LEVELS,
  WALL_UPDATE_SOFT_BYTES,
  WallOpCode,
  WallUpdateWriter,
} from "../src/messages/walls";

// `WallUpdate` (0x53, protocol v10): the server's destructible walls on the control stream. A change is a wall index
// and what happened to it — both ends number the walls from the map layout, so nothing else has to travel.

describe("WallUpdate", () => {
  it("arrived in protocol v10", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(10);
    expect(MsgId.WallUpdate).toBe(0x53);
  });

  it("round-trips every op", () => {
    const w = new WallUpdateWriter();
    w.clear();
    w.destroyed(0);
    w.destroyed(65535);
    w.repaired(7);
    w.holed(1234);
    w.healing(1234, 0.5);
    const bytes = w.finish()!;
    const ops = decodeWallUpdate(createBitReader(bytes))!;
    expect(ops.map((op) => op.op)).toEqual([
      WallOpCode.clear,
      WallOpCode.destroyed,
      WallOpCode.destroyed,
      WallOpCode.repaired,
      WallOpCode.holed,
      WallOpCode.healing,
    ]);
    expect(ops.map((op) => op.index)).toEqual([0, 0, 65535, 7, 1234, 1234]);
    // 1/15 steps: 0.5 lands on 8/15.
    expect(ops[5]!.progress).toBeCloseTo(Math.round(0.5 * WALL_HEAL_LEVELS) / WALL_HEAL_LEVELS, 6);
  });

  it("a frag's worth of ops is a handful of bytes", () => {
    const w = new WallUpdateWriter();
    w.destroyed(12);
    w.destroyed(13);
    w.destroyed(40);
    expect(w.finish()!.length).toBeLessThanOrEqual(9);
  });

  it("finish is null without an op, and the writer is reusable", () => {
    const w = new WallUpdateWriter();
    expect(w.finish()).toBeNull();
    w.begin();
    w.holed(3);
    expect(w.finish()).not.toBeNull();
    w.begin();
    expect(w.ops).toBe(0);
    expect(w.finish()).toBeNull();
  });

  it("reports full before it can overrun a message", () => {
    const w = new WallUpdateWriter();
    let ops = 0;
    while (!w.full) {
      w.destroyed(ops % 65536);
      ops++;
    }
    w.destroyed(0);
    expect(w.finish()!.length).toBeLessThanOrEqual(WALL_UPDATE_SOFT_BYTES + 4);
    expect(ops).toBeGreaterThan(100);
  });

  it("rejects a wrong id, an unknown op and trailing bytes", () => {
    const buf = createWallUpdateBuffer();
    const w = new WallUpdateWriter();
    w.destroyed(5);
    const bytes = w.finish()!;

    const wrongId = Uint8Array.from(bytes);
    wrongId[0] = MsgId.LootUpdate;
    expect(decodeWallUpdateInto(createBitReader(wrongId), buf)).toBe(false);

    const trailing = new Uint8Array(bytes.length + 2);
    trailing.set(bytes);
    expect(decodeWallUpdateInto(createBitReader(trailing), buf)).toBe(false);

    // Op code 5 is unassigned (`clear` is 4, `end` is 7).
    const unknown = Uint8Array.from([MsgId.WallUpdate, 0b1010_0000]);
    expect(decodeWallUpdateInto(createBitReader(unknown), buf)).toBe(false);

    // Truncated payload: the index runs past the end.
    expect(decodeWallUpdateInto(createBitReader(bytes.subarray(0, 2)), buf)).toBe(false);
  });

  it("describes for the debug tooling", () => {
    const w = new WallUpdateWriter();
    w.destroyed(9);
    const described = describeMessage(w.finish()!);
    expect(described.ok).toBe(true);
    expect(described.name).toContain("WallUpdate");
  });
});
