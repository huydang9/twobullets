import { describe, expect, it } from "vitest";
import type { Vec2Tuple } from "../../types";
import { isPoliticalName } from "./names";
import { convertRoadLabels, joinChains } from "./roadLabels";
import type { LineFeature } from "./types";

let nextId = 1;
function way(name: string | undefined, highway: string, points: Vec2Tuple[]): LineFeature {
  return { id: nextId++, tags: { highway, ...(name ? { name } : {}) }, points };
}

describe("road labels", () => {
  it("joins same-name pieces end to end, in either direction", () => {
    const chains = joinChains([
      [[0, 0], [100, 0]],
      [[250, 0], [100, 0]],
      [[-80, 0], [0, 0]],
      [[0, 500], [100, 500]],
    ]);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toEqual([[-80, 0], [0, 0], [100, 0], [250, 0]]);
  });

  it("merges a name's ways into one label and keeps its most used spelling", () => {
    const { labels } = convertRoadLabels([
      way("Bạch Đằng", "primary", [[-300, 10], [0, 10]]),
      way("Bạch Đằng", "primary", [[0, 10], [300, 10]]),
      way("Bạch đằng", "primary", [[-300, -10], [-200, -10]]),
      way("Bạch Đằng", "primary_link", [[0, 10], [0, 60]]),
    ]);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.name).toBe("Bạch Đằng");
    expect(labels[0]!.rank).toBe(0);
    expect(labels[0]!.lines).toHaveLength(2);
    expect(labels[0]!.length).toBe(700);
  });

  it("labels big roads when short and other named roads only from about 300 m", () => {
    const { labels } = convertRoadLabels([
      way("Đường Lớn", "secondary", [[0, 0], [120, 0]]),
      way("Đường Ba", "tertiary", [[0, 50], [150, 50]]),
      way("Đường Nhỏ", "residential", [[0, 100], [250, 100]]),
      way("Đường Dài", "residential", [[0, 200], [200, 200]]),
      way("Đường Dài", "residential", [[200, 200], [200, 320]]),
      way(undefined, "primary", [[0, 300], [400, 300]]),
      way("Đường Xa", "primary", [[600, 0], [900, 0]]),
    ]);
    expect(labels.map((l) => l.name)).toEqual(["Đường Lớn", "Đường Dài"]);
    // Clipped to the road edge: nothing of "Đường Xa" is inside the map.
    expect(labels.every((l) => l.lines.every((line) => line.every(([x, z]) => Math.abs(x) <= 492 && Math.abs(z) <= 492)))).toBe(true);
  });

  it("labels roads by their real name, political ones included, but never alleys", () => {
    const { labels, report } = convertRoadLabels([
      way("Xô Viết Nghệ Tĩnh", "primary", [[-400, 0], [400, 0]]),
      way("Điện Biên Phủ", "primary", [[0, -400], [0, 400]]),
      way("Hẻm 181/7 Phan Xích Long", "residential", [[-400, 100], [400, 100]]),
      way("Phan Xích Long", "tertiary", [[-400, 200], [400, 200]]),
    ]);
    expect(labels.map((l) => l.name)).toEqual(["Xô Viết Nghệ Tĩnh", "Điện Biên Phủ", "Phan Xích Long"]);
    expect(report.labeled).toEqual(["Xô Viết Nghệ Tĩnh", "Điện Biên Phủ", "Phan Xích Long"]);
    // POI and map names still go through the filter.
    expect(isPoliticalName("Xô Viết Nghệ Tĩnh")).toBe(true);
  });
});
