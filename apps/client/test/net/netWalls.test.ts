import { createBitReader } from "@twobullets/protocol/bits";
import { WallUpdateWriter } from "@twobullets/protocol/messages/walls";
import { WallChange, type DestructibleWalls } from "@twobullets/shared/equipment/destructible";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { describe, expect, it } from "vitest";
import { NetWalls } from "../../src/net/NetWalls";

// The client side of protocol v10: the server's wall changes reach the two things that have to follow them — the prop
// colliders and the renderer, which reads the same `DestructibleWalls` the offline match writes.

function layout(mirrors: number): Pick<MapLayout, "props"> {
  const data: number[] = [];
  for (let i = 0; i < mirrors; i++) data.push(i * 10, 0, 0, 0, 1, 0, 0);
  return { props: [{ prop: "wall_mirror", data: new Float32Array(data) }] };
}

function setup(mirrors = 3) {
  const l = layout(mirrors);
  const removed: string[] = [];
  const bound: { walls: DestructibleWalls; layout: Pick<MapLayout, "props"> }[] = [];
  const walls = new NetWalls({
    layout: l,
    props: { bindWalls: (w, lay) => bound.push({ walls: w, layout: lay }) },
    colliders: {
      removeInstance: (prop, instance) => {
        removed.push(`${prop}/${instance}`);
        return true;
      },
    },
  });
  const send = (write: (w: WallUpdateWriter) => void): boolean => {
    const w = new WallUpdateWriter();
    write(w);
    const bytes = w.finish()!;
    return walls.apply(createBitReader(bytes), bytes.length);
  };
  return { walls, removed, bound, send, layout: l };
}

describe("NetWalls", () => {
  it("binds the renderer to the same state the server writes", () => {
    const { walls, bound, layout: l } = setup();
    expect(walls.empty).toBe(false);
    expect(walls.walls.count).toBe(3);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.walls).toBe(walls.walls);
    expect(bound[0]!.layout).toBe(l);
  });

  it("a map with nothing destructible is empty, so the client is never told anything", () => {
    const walls = new NetWalls({
      layout: { props: [{ prop: "rock_small", data: new Float32Array([0, 0, 0, 0, 1, 0, 0]) }] },
      props: { bindWalls: () => {} },
      colliders: { removeInstance: () => false },
    });
    expect(walls.empty).toBe(true);
  });

  it("a destroyed pane loses its collider and shows up in the log the renderer polls", () => {
    const { walls, removed, send } = setup();
    expect(send((w) => w.destroyed(2))).toBe(true);
    expect(removed).toEqual(["wall_mirror/2"]);
    expect(walls.walls.destroyed[2]).toBe(1);
    expect(walls.walls.logged).toBe(1);
    expect(walls.walls.changeAt(0)).toBe(2 * 2 + WallChange.destroyed);
  });

  it("a holed pane heals on the server's clock", () => {
    const { walls, send } = setup();
    send((w) => w.holed(0));
    expect(walls.walls.holedCount).toBe(1);
    send((w) => w.healing(0, 0.5));
    expect(walls.walls.ticks[0]).toBeGreaterThan(0);
    send((w) => w.repaired(0));
    expect(walls.walls.holedCount).toBe(0);
    expect(walls.stats.repaired).toBe(1);
  });

  it("a malformed message changes nothing", () => {
    const { walls, removed } = setup();
    const bad = Uint8Array.from([0x53, 0b1010_0000]);
    expect(walls.apply(createBitReader(bad), bad.length)).toBe(false);
    expect(removed).toHaveLength(0);
    expect(walls.stats.malformed).toBe(1);
  });
});
