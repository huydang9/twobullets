import { createBitReader } from "@twobullets/protocol/bits";
import { MsgId } from "@twobullets/protocol/messages/ids";
import { WallUpdateWriter } from "@twobullets/protocol/messages/walls";
import { buildDestructibleWalls, wallRepairProgress, WallChange, WallKind } from "@twobullets/shared/equipment/destructible";
import { INSTANCE_STRIDE } from "@twobullets/shared/map/layout/scatter";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { describe, expect, it } from "vitest";
import { WallMirror } from "../src/walls";

// The client's copy of the server's destructible walls (protocol v10). Nothing here decides anything: every change is
// applied from the wire, and applying one twice is a no-op, which is what makes a resync free.

const TICK = 1 / 60;

/** Two mirror panes and one grass hedge, in layout order, so wall 0/1 are panes and wall 2 a hedge. */
function layout(): Pick<MapLayout, "props"> {
  const instance = (x: number, z: number, yaw: number): number[] => [x, 0, z, yaw, 1, 0, 0];
  expect(instance(0, 0, 0)).toHaveLength(INSTANCE_STRIDE);
  return {
    props: [
      { prop: "wall_mirror", data: new Float32Array([...instance(0, 0, 0), ...instance(10, 0, 0)]) },
      { prop: "wall_grass", data: new Float32Array([...instance(0, 20, 0)]) },
    ],
  };
}

interface Applied {
  index: number;
  prop: string;
  instance: number;
  change: WallChange;
}

function mirror() {
  const l = layout();
  const walls = buildDestructibleWalls(l);
  const removed: { prop: string; instance: number }[] = [];
  const changes: Applied[] = [];
  const m = new WallMirror(
    walls,
    l,
    {
      removeCollider: (prop, instance) => removed.push({ prop, instance }),
      onChange: (index, prop, instance, change) => changes.push({ index, prop, instance, change }),
    },
    TICK,
  );
  const send = (write: (w: WallUpdateWriter) => void): boolean => {
    const w = new WallUpdateWriter();
    write(w);
    const bytes = w.finish()!;
    return m.apply(createBitReader(bytes), bytes.length);
  };
  return { walls, mirror: m, removed, changes, send };
}

describe("WallMirror", () => {
  it("numbers the walls the way the layout does", () => {
    const { walls } = mirror();
    expect(walls.count).toBe(3);
    expect([...walls.kind]).toEqual([WallKind.pane, WallKind.pane, WallKind.hedge]);
  });

  it("a destroyed pane takes its collider with it, a hedge does not", () => {
    const { walls, removed, changes, send } = mirror();
    expect(send((w) => w.destroyed(1))).toBe(true);
    expect(walls.destroyed[1]).toBe(1);
    expect(removed).toEqual([{ prop: "wall_mirror", instance: 1 }]);
    expect(changes).toEqual([{ index: 1, prop: "wall_mirror", instance: 1, change: WallChange.destroyed }]);

    send((w) => w.destroyed(2));
    expect(walls.destroyed[2]).toBe(1);
    // The hedge never had a collider.
    expect(removed).toHaveLength(1);
    expect(changes[1]).toMatchObject({ prop: "wall_grass", change: WallChange.destroyed });
  });

  it("a change the client already has costs nothing", () => {
    const { removed, changes, send } = mirror();
    send((w) => w.destroyed(0));
    send((w) => w.destroyed(0));
    send((w) => w.destroyed(0));
    expect(removed).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  it("apertures and the heal the server drives", () => {
    const { walls, changes, send } = mirror();
    send((w) => w.holed(0));
    expect(walls.holes[0]).toBe(1);
    expect(walls.holedCount).toBe(1);

    // Progress arrives as the tick count the renderer reads, so nothing downstream knows it came off a wire.
    send((w) => w.healing(0, 0.5));
    // 1/15 steps on the wire, which is finer than the renderer redraws on.
    expect(wallRepairProgress(walls, 0, TICK)).toBeCloseTo(8 / 15, 2);

    send((w) => w.repaired(0));
    expect(walls.holes[0]).toBe(0);
    expect(walls.holedCount).toBe(0);
    expect(walls.ticks[0]).toBe(0);
    expect(changes.at(-1)).toMatchObject({ index: 0, change: WallChange.repaired });

    // A repair with nothing to repair is silent.
    const before = changes.length;
    send((w) => w.repaired(0));
    expect(changes).toHaveLength(before);
  });

  it("a destroyed pane never heals or holes again", () => {
    const { walls, send } = mirror();
    send((w) => w.holed(0));
    send((w) => w.destroyed(0));
    expect(walls.holedCount).toBe(0);
    send((w) => {
      w.holed(0);
      w.healing(0, 1);
      w.repaired(0);
    });
    expect(walls.holes[0]).toBe(0);
    expect(walls.ticks[0]).toBe(0);
    expect(walls.destroyed[0]).toBe(1);
  });

  it("a late join rebuilds from the state, not the history", () => {
    // What the server would send a client that connects with pane 1 gone and pane 0 shot up and healing.
    const { walls, removed, send } = mirror();
    expect(
      send((w) => {
        w.clear();
        w.destroyed(1);
        w.holed(0);
        w.healing(0, 0.25);
      }),
    ).toBe(true);
    expect([...walls.destroyed]).toEqual([0, 1, 0]);
    expect(walls.holes[0]).toBe(1);
    expect(walls.holedCount).toBe(1);
    expect(wallRepairProgress(walls, 0, TICK)).toBeCloseTo(4 / 15, 2);
    expect(removed).toEqual([{ prop: "wall_mirror", instance: 1 }]);
    // The renderer catches up off the log, which the mirror appended to as it applied.
    expect(walls.logged).toBe(1);
    expect(walls.changeAt(0)).toBe(1 * 2 + WallChange.destroyed);
  });

  it("a clear drops the hole state and keeps what is gone", () => {
    const { walls, removed, send } = mirror();
    send((w) => {
      w.destroyed(0);
      w.holed(1);
    });
    send((w) => {
      w.clear();
      w.destroyed(0);
    });
    expect(walls.destroyed[0]).toBe(1);
    expect(walls.holes[1]).toBe(0);
    expect(walls.holedCount).toBe(0);
    // Not removed twice: the collider left the world the first time.
    expect(removed).toHaveLength(1);
  });

  it("an index past the end, and a malformed message, change nothing", () => {
    const { walls, changes, mirror: m, send } = mirror();
    send((w) => {
      w.destroyed(9000);
      w.holed(9000);
      w.repaired(9000);
      w.healing(9000, 1);
    });
    expect(changes).toHaveLength(0);
    expect([...walls.destroyed]).toEqual([0, 0, 0]);

    const bad = Uint8Array.from([MsgId.WallUpdate, 0b1010_0000]);
    expect(m.apply(createBitReader(bad), bad.length)).toBe(false);
    expect(m.stats.malformed).toBe(1);
    expect(changes).toHaveLength(0);
  });
});
