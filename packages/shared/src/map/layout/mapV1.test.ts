import { describe, expect, it } from "vitest";
import { MAP_V1, MAP_V1_TRAINING_YARD } from "../mapV1";
import { terrainInputsHash } from "../terrain/bake";
import { buildTerrain } from "../terrain/terrain";
import { distance, distanceToRect, polylineDistance } from "./geometry";
import { buildMapLayout } from "./mapLayout";
import { MAP_V1_BAKE } from "./mapV1Bake";
import { propColliderGroups } from "./collision";
import { getMapProp } from "./props";
import { mapPaths } from "./roads";
import { validateMapLayout, type MapIssueKind } from "./validate";

describe("Map v1 layout", () => {
  const terrain = buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
  const layout = buildMapLayout(MAP_V1, terrain);
  const issues = validateMapLayout(MAP_V1, terrain, layout);
  const of = (kind: MapIssueKind) => issues.filter((i) => i.kind === kind).map((i) => i.message);

  it("has no overlapping buildings, and none on roads", () => {
    expect(of("building-overlap")).toEqual([]);
    expect(of("building-on-road")).toEqual([]);
    expect(of("building-out-of-bounds")).toEqual([]);
  });

  it("sits every building on a flattened pad with steppable entrances", () => {
    expect(of("building-not-on-pad")).toEqual([]);
    expect(of("building-entrance")).toEqual([]);
  });

  it("spreads the seven POIs at least 250 m apart", () => {
    expect(MAP_V1.pois).toHaveLength(7);
    expect(of("poi-spacing")).toEqual([]);
  });

  it("puts spawns on walkable open ground, and keeps collidable props off roads", () => {
    expect(MAP_V1.spawns.length).toBeGreaterThanOrEqual(10);
    expect(of("spawn")).toEqual([]);
    expect(of("prop-on-road")).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("gives each POI its buildings and a road, on one connected network", () => {
    const paths = mapPaths(MAP_V1);
    for (const poi of MAP_V1.pois) {
      if (poi.kind !== "training") expect(layout.buildings.some((b) => b.poi === poi.id), poi.id).toBe(true);
      const nearest = Math.min(...paths.map((p) => polylineDistance(p.points, poi.center[0], poi.center[1])));
      expect(nearest, `${poi.id} road distance`).toBeLessThan(poi.radius);
    }
    // Roads join when they touch or cross, or meet on the same pad (farm yard, quarry floor, compound).
    const pads = MAP_V1.flatten.filter((r) => r.shape !== "polyline");
    const nodes = paths.length + pads.length;
    const parent = Array.from({ length: nodes }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const samples = paths.map((p) => p.points.flatMap(([ax, az], k) => {
      const [bx, bz] = p.points[k + 1] ?? [ax, az];
      const steps = Math.max(1, Math.ceil(distance(ax, az, bx, bz) / 4));
      return Array.from({ length: steps }, (_, t) => [ax + ((bx - ax) * t) / steps, az + ((bz - az) * t) / steps] as const);
    }));
    paths.forEach((a, i) => {
      paths.forEach((b, j) => {
        if (i !== j && samples[i]!.some(([x, z]) => polylineDistance(b.points, x, z) < a.halfWidth + b.halfWidth)) parent[find(i)] = find(j);
      });
      pads.forEach((pad, k) => {
        const inside = ([x, z]: readonly [number, number]) =>
          pad.shape === "circle" ? distance(x, z, pad.center[0], pad.center[1]) < pad.radius + 3 : distanceToRect({ center: pad.center, halfExtents: pad.halfExtents, yaw: pad.yaw ?? 0 }, x, z) < 3;
        if (samples[i]!.some(inside)) parent[find(i)] = find(paths.length + k);
      });
    });
    expect(new Set(paths.map((_, i) => find(i))).size).toBe(1);
  });

  it("leads a road to the Training Yard gate", () => {
    const [x, z] = MAP_V1_TRAINING_YARD.center;
    const gate = [x, z + 36] as const;
    const nearest = Math.min(...mapPaths(MAP_V1).map((p) => polylineDistance(p.points, gate[0], gate[1])));
    expect(nearest).toBeLessThan(15);
  });

  it("builds matching colliders for every collidable instance", () => {
    const groups = propColliderGroups(layout);
    const collidable = layout.props.filter((set) => getMapProp(set.prop).collision.kind !== "none").reduce((n, set) => n + set.data.length / 7, 0);
    expect(groups.reduce((n, g) => n + g.transforms.length / 4, 0)).toBe(collidable);
    // Quantized scales keep the shape count small.
    expect(groups.length).toBeLessThan(250);
  });

  it("matches the recorded bake and scatter checksums (rerun tools/map/build.ts after intentional changes)", () => {
    expect(terrainInputsHash(MAP_V1.terrain, MAP_V1.flatten)).toBe(MAP_V1_BAKE.inputsHash);
    expect(terrain.checksum()).toBe(MAP_V1_BAKE.terrainChecksum);
    expect(layout.checksum).toBe(MAP_V1_BAKE.layoutChecksum);
    expect(buildMapLayout(MAP_V1, terrain).checksum).toBe(layout.checksum);
  });

  it("keeps the yard pad flat under the arena", () => {
    const [x, z] = MAP_V1_TRAINING_YARD.center;
    const h = terrain.sampleHeight(x, z);
    for (const [dx, dz] of [[-40, -40], [40, 40], [-40, 36], [30, -20]] as const) {
      expect(terrain.sampleHeight(x + dx, z + dz)).toBeCloseTo(h, 3);
    }
    expect(distance(x, z, 0, 0)).toBeGreaterThan(250);
  });
});
