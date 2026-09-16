import { describe, expect, it } from "vitest";
import { rectCorners, type OrientedRect } from "../../layout/geometry";
import { sampleWeightGrid } from "../../layout/scatter";
import type { RoadSpec } from "../../layout/roads";
import { createReliefFunction } from "../../terrain/generate";
import { realTerrainSpec } from "./elevation";
import { buildWilderness, COVERAGE_SPACING, measureWilderness, wildernessDefaults, withWilderness, type WildernessInput } from "./wilderness";

const TERRAIN = { size: 640, playableHalfExtent: 250 } as const;

/** A 100 m core of buildings in the middle of the square, one main street east-west, nothing else. */
function town(): WildernessInput {
  const buildings: OrientedRect[] = [];
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) buildings.push({ center: [-50 + i * 25, -50 + j * 25], halfExtents: [8, 6], yaw: 0 });
  }
  const road: RoadSpec = { id: "primary_1", kind: "asphalt", width: 8, points: [[-240, 0], [240, 0]] };
  return { seed: 0x1234_5678, terrain: TERRAIN, buildings, areas: [], roads: [road], creeks: [], water: [] };
}

const heightAt = (w: ReturnType<typeof measureWilderness>, x: number, z: number) => {
  const { origin, spacing, columns, heights } = w.feature;
  const i = Math.round((x - origin[0]) / spacing);
  const j = Math.round((z - origin[1]) / spacing);
  return heights[j * columns + i]!;
};

describe("wilderness coverage mask", () => {
  const w = measureWilderness(town());

  it("is zero over the buildings and the main street, and full out in the open", () => {
    expect(sampleWeightGrid(w.weights, 0, 0)).toBe(0);
    expect(sampleWeightGrid(w.weights, -50, -50)).toBe(0);
    // Just off the carriageway of the main street.
    expect(sampleWeightGrid(w.weights, 200, 6)).toBe(0);
    // Far from both: open country.
    expect(sampleWeightGrid(w.weights, 200, 200)).toBe(1);
    expect(sampleWeightGrid(w.weights, -210, -215)).toBe(1);
  });

  it("ramps up with distance instead of jumping", () => {
    const options = wildernessDefaults();
    const along = [0, 20, 40, 60, 100].map((d) => sampleWeightGrid(w.weights, 0, 70 + d));
    for (let i = 1; i < along.length; i++) expect(along[i]!).toBeGreaterThanOrEqual(along[i - 1]!);
    // The street verge is much shorter than the ramp out of town.
    expect(sampleWeightGrid(w.weights, 200, options.roadRamp + 20)).toBeGreaterThan(0.9);
    expect(sampleWeightGrid(w.weights, 0, 70 + options.ramp / 2)).toBeLessThan(0.9);
  });

  it("covers the whole square at the grid spacing", () => {
    expect(w.weights.spacing).toBe(COVERAGE_SPACING);
    expect(w.weights.columns).toBe(TERRAIN.size / COVERAGE_SPACING + 1);
    expect(w.weights.values.length).toBe(w.weights.columns * w.weights.rows);
    expect(w.weights.values).toMatch(/^[0-9]+$/);
  });

  it("reports the open ground it found", () => {
    expect(w.report.areaHa).toBeGreaterThan(10);
    expect(w.report.touchedHa).toBeGreaterThanOrEqual(w.report.areaHa);
    expect(w.report.cityRatio).toBeGreaterThan(0);
    expect(w.report.cityRatio).toBeLessThan(0.5);
  });

  it("leaves a square that is built up edge to edge alone", () => {
    const buildings: OrientedRect[] = [];
    for (let j = -10; j <= 10; j++) for (let i = -10; i <= 10; i++) buildings.push({ center: [i * 50, j * 50], halfExtents: [22, 22], yaw: 0 });
    expect(buildWilderness({ ...town(), buildings })).toBeNull();
  });
});

describe("wilderness hills", () => {
  const w = measureWilderness(town());

  it("adds nothing over the city, so the mapped ground keeps its elevation", () => {
    // Exactly zero over the built-up core and the ring of samples around it (the coverage margin is wider than one cell).
    for (const [x, z] of [[0, 0], [-50, -50], [50, 50]] as const) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) expect(heightAt(w, x + dx * 10, z + dz * 10), `${x + dx * 10}, ${z + dz * 10}`).toBe(0);
    }
    // And along the main street, which crosses the open ground.
    for (let x = -240; x <= 240; x += 20) expect(heightAt(w, x, 0), `${x}`).toBe(0);
  });

  it("never digs below the mapped ground", () => {
    expect(w.feature.heights.every((h) => h >= 0)).toBe(true);
  });

  it("raises real hills out in the open", () => {
    expect(w.report.peak).toBeGreaterThan(5);
    expect(heightAt(w, 200, 200) + heightAt(w, -200, 200) + heightAt(w, -200, -200) + heightAt(w, 200, -200)).toBeGreaterThan(6);
  });

  it("keeps every step inside the walk limit", () => {
    const { columns, rows, spacing, heights } = w.feature;
    const limit = Math.tan((wildernessDefaults().maxSlopeDegrees * Math.PI) / 180) * spacing;
    let worst = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const h = heights[j * columns + i]!;
        if (i + 1 < columns) worst = Math.max(worst, Math.abs(heights[j * columns + i + 1]! - h));
        if (j + 1 < rows) worst = Math.max(worst, Math.abs(heights[(j + 1) * columns + i]! - h));
      }
    }
    expect(worst).toBeLessThanOrEqual(limit + 0.02);
  });

  it("leaves the terrain relief untouched over the city and raises it in the open", () => {
    const { spec } = realTerrainSpec(1, null, { mode: "flat", scale: 1, maxRelief: 4 });
    const flat = createReliefFunction(spec);
    const hilly = createReliefFunction(withWilderness(spec, w));
    // On the buildings and the street the ground is unchanged to within a fifth of a meter. The grid samples over the
    // city are all exactly 0; what is left is the Catmull-Rom spline reaching two samples out, into the first meter of
    // hill 40 m away. Building pads and road flatten regions level far more than that.
    let onTown = 0;
    for (const b of town().buildings) {
      for (let dz = -12; dz <= 12; dz += 4) for (let dx = -12; dx <= 12; dx += 4) onTown = Math.max(onTown, Math.abs(hilly(b.center[0] + dx, b.center[1] + dz) - flat(b.center[0] + dx, b.center[1] + dz)));
    }
    for (let x = -240; x <= 240; x += 5) for (const z of [-6, 0, 6]) onTown = Math.max(onTown, Math.abs(hilly(x, z) - flat(x, z)));
    expect(onTown).toBeLessThan(0.2);
    // Out of town the ground climbs, and it climbs gradually: no step between samples 5 m apart.
    expect(hilly(200, 200)).toBeGreaterThan(flat(200, 200) + 2);
    let step = 0;
    let previous = hilly(0, 70);
    for (let z = 75; z <= 240; z += 5) {
      const here = hilly(0, z);
      step = Math.max(step, Math.abs(here - previous));
      previous = here;
    }
    expect(step).toBeLessThan(5 * Math.tan((wildernessDefaults().maxSlopeDegrees * Math.PI) / 180) + 0.3);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(measureWilderness(town()))).toBe(JSON.stringify(measureWilderness(town())));
  });

  it("scales with its options", () => {
    const tall = measureWilderness({ ...town(), options: { relief: 30, edgeRise: 0, maxSlopeDegrees: 25 } });
    expect(tall.report.peak).toBeGreaterThan(w.report.peak);
    const flat = measureWilderness({ ...town(), options: { relief: 0, edgeRise: 0 } });
    expect(flat.feature.heights.every((h) => h === 0)).toBe(true);
    // The mask is the same either way: only the hills change.
    expect(flat.weights.values).toBe(w.weights.values);
  });
});

describe("sampleWeightGrid", () => {
  it("reads the digits back, bilinearly, and clamps outside the grid", () => {
    const grid = { origin: [0, 0] as const, spacing: 10, columns: 3, rows: 3, values: "090" + "000" + "000" };
    expect(sampleWeightGrid(grid, 10, 0)).toBeCloseTo(1, 6);
    expect(sampleWeightGrid(grid, 0, 0)).toBe(0);
    expect(sampleWeightGrid(grid, 5, 0)).toBeCloseTo(0.5, 6);
    expect(sampleWeightGrid(grid, 10, 5)).toBeCloseTo(0.5, 6);
    // Outside: the edge samples extend.
    expect(sampleWeightGrid(grid, -50, -50)).toBe(0);
    expect(sampleWeightGrid(grid, 250, -50)).toBe(0);
  });
});

describe("wilderness rect coverage", () => {
  it("measures distance from the building outline, not its centre", () => {
    const wide = measureWilderness({ ...town(), buildings: [{ center: [0, 0], halfExtents: [120, 10], yaw: 0 }], roads: [] });
    // A long thin building: covered along its length, open just past its ends.
    for (const [x, z] of rectCorners({ center: [0, 0], halfExtents: [110, 6], yaw: 0 })) expect(sampleWeightGrid(wide.weights, x, z)).toBe(0);
    expect(sampleWeightGrid(wide.weights, 0, 300)).toBe(1);
  });
});
