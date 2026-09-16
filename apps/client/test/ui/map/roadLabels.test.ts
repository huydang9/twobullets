import type { RoadLabel } from "@twobullets/shared";
import { describe, expect, it } from "vitest";
import { boxesOverlap, placeRoadLabels, uprightAngle, type LabelBox, type RoadLabelView } from "../../../src/ui/map/roadLabels";

/** Whole 500 m map in 800 px, north up. */
const VIEW: RoadLabelView = { size: 800, pixelsPerMeter: 0.8, sx: (x) => (x + 500) * 0.8, sy: (z) => (500 - z) * 0.8 };
const OPTIONS = { fontPx: 12, measure: (text: string) => text.length * 6, obstacles: [] as LabelBox[], maxRank: 3 };

function road(name: string, points: [number, number][], rank: RoadLabel["rank"] = 0): RoadLabel {
  return { name, rank, length: 0, lines: [points] };
}

describe("road label placement", () => {
  it("keeps text upright whichever way the road was drawn", () => {
    for (const angle of [0, 0.5, 1.5, Math.PI / 2, 2, Math.PI, -Math.PI, -2, -Math.PI / 2, 7]) {
      const upright = uprightAngle(angle);
      expect(upright).toBeGreaterThan(-Math.PI / 2 - 1e-9);
      expect(upright).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
      expect(Math.abs(Math.sin(upright - angle))).toBeLessThan(1e-9);
    }
    const east = placeRoadLabels([road("Đông", [[-300, 0], [300, 0]])], VIEW, OPTIONS);
    const west = placeRoadLabels([road("Tây", [[300, 0], [-300, 0]])], VIEW, OPTIONS);
    expect(east[0]!.angle).toBeCloseTo(0);
    expect(west[0]!.angle).toBeCloseTo(0);
    const diagonal = placeRoadLabels([road("Chéo", [[200, -200], [-200, 200]])], VIEW, OPTIONS);
    // North-west to south-east on screen: reads down to the right.
    expect(diagonal[0]!.angle).toBeCloseTo(Math.PI / 4);
  });

  it("places a name on the longest straight stretch, once per 400 m of road", () => {
    // A 100 m wiggle, then a straight 600 m run.
    const [label] = placeRoadLabels([road("Đường", [[-450, 0], [-400, 40], [-350, 0], [250, 0]])], VIEW, OPTIONS);
    expect(label!.x).toBeCloseTo(VIEW.sx(-50));
    expect(label!.y).toBeCloseTo(VIEW.sy(0));
    const long = placeRoadLabels([road("Dài", [[-480, 0], [480, 0]])], VIEW, OPTIONS);
    expect(long).toHaveLength(2);
    // A dual carriageway: two parallel chains still get one name per 400 m.
    const dual = placeRoadLabels([{ name: "Kép", rank: 0, length: 0, lines: [[[-150, 0], [150, 0]], [[150, 12], [-150, 12]]] }], VIEW, OPTIONS);
    expect(dual).toHaveLength(1);
  });

  it("skips spots that overlap obstacles or earlier labels, and ranks above the limit", () => {
    const poi: LabelBox = { x: VIEW.sx(0), y: VIEW.sy(0), halfW: 60, halfH: 10, angle: 0 };
    expect(placeRoadLabels([road("Đường", [[-100, 0], [100, 0]])], VIEW, { ...OPTIONS, obstacles: [poi] })).toHaveLength(0);
    const crossing = placeRoadLabels([road("Ngang", [[-100, 0], [100, 0]]), road("Dọc", [[0, -100], [0, 100]])], VIEW, OPTIONS);
    expect(crossing.map((l) => l.name)).toEqual(["Ngang"]);
    expect(placeRoadLabels([road("Nhỏ", [[-300, 0], [300, 0]], 3)], VIEW, { ...OPTIONS, maxRank: 1 })).toHaveLength(0);
  });

  it("tests rotated boxes by separating axes", () => {
    const a: LabelBox = { x: 0, y: 0, halfW: 50, halfH: 5, angle: Math.PI / 4 };
    expect(boxesOverlap(a, { x: 30, y: 30, halfW: 5, halfH: 5, angle: 0 })).toBe(true);
    // Inside a's axis-aligned bounds but clear of the rotated box.
    expect(boxesOverlap(a, { x: 30, y: -30, halfW: 5, halfH: 5, angle: 0 })).toBe(false);
  });
});
