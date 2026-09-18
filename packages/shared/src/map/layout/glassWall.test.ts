import { describe, expect, it } from "vitest";
import { COLLIDER_STRIDE, propColliderGroups } from "./collision";
import { getMapProp } from "./props";
import { INSTANCE_STRIDE, isHardCover } from "./scatter";

// wall_glass: the same panel as wall_concrete, on the movement-only collision layer (see-through, shoot-through,
// walk-into). Nothing breaks it; there is no destructible system.

const instance = (x: number, z: number) => [x, 0, z, 0, 1, 0, 0];

describe("wall_glass", () => {
  const glass = getMapProp("wall_glass");
  const concrete = getMapProp("wall_concrete");

  it("is dimensionally interchangeable with wall_concrete", () => {
    expect(glass.category).toBe(concrete.category);
    expect(glass.footprint).toBe(concrete.footprint);
    expect(glass.sink).toBe(concrete.sink);
    expect(glass.collision.kind).toBe("box");
    expect(glass.collision).toMatchObject({ size: [4, 2.6, 0.3] });
    if (concrete.collision.kind !== "box" || glass.collision.kind !== "box") throw new Error("both walls are boxes");
    expect(glass.collision.size).toEqual(concrete.collision.size);
    expect(glass.collision.offsetY).toBe(concrete.collision.offsetY);
  });

  it("stops movement only: bullets and sight pass", () => {
    expect(glass.collision).toMatchObject({ bulletproof: false });
    // Glass hides nobody, so it is not cover for placement rules that keep sight lines honest.
    expect(isHardCover(glass)).toBe(false);
    expect(isHardCover(concrete)).toBe(true);
  });

  it("builds movement-only collider groups the same shape as the concrete wall", () => {
    const layout = {
      props: [
        { prop: "wall_glass", data: new Float32Array([...instance(0, 0), ...instance(4, 0)]) },
        { prop: "wall_concrete", data: new Float32Array(instance(8, 0)) },
      ],
    };
    const groups = propColliderGroups(layout);
    expect(groups.map((g) => [g.prop, g.bulletproof])).toEqual([
      ["wall_glass", false],
      ["wall_concrete", true],
    ]);
    const [glassGroup, concreteGroup] = groups;
    expect(glassGroup!.shape).toEqual(concreteGroup!.shape);
    expect(glassGroup!.transforms.length / COLLIDER_STRIDE).toBe(2);
    expect(layout.props[0]!.data.length / INSTANCE_STRIDE).toBe(2);
  });
});
