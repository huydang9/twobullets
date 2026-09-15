import { describe, expect, it } from "vitest";
import { buildPrefabLayer } from "../../bots/nav/prefabLayer";
import { MOVEMENT } from "../../constants";
import { buildPrefabGeometry } from "./geometry";
import { KIT, subtractRects } from "./kit";
import { getPrefabCollision, getPrefabLootSpots, localToWorld, prefabLevelBlocks, worldToLocal } from "./placement";
import { BUILDING_PREFAB_IDS, getBuildingPrefab } from "./prefabs";
import { PartBvh, boxesOverlap } from "./raycast";
import type { Vec3Tuple } from "../../level/types";

const prefabs = BUILDING_PREFAB_IDS.map((id) => [id, getBuildingPrefab(id)] as const);
/** Controller skin (CharacterBody KEEP_DISTANCE) on each side of the capsule. */
const SKIN = 0.05;

describe.each(prefabs)("%s", (id, prefab) => {
  const bvh = new PartBvh(prefab.parts);

  it("has no overlapping parts", () => {
    const overlaps: string[] = [];
    prefab.parts.forEach((a, i) => {
      for (let j = i + 1; j < prefab.parts.length; j++) {
        const b = prefab.parts[j]!;
        if (boxesOverlap(a.min, a.max, b.min, b.max)) overlaps.push(`${a.role}[${a.min}]-[${a.max}] × ${b.role}[${b.min}]-[${b.max}]`);
      }
    });
    expect(overlaps).toEqual([]);
  });

  it("exposes one collision shape per part, matching the part bounds", () => {
    const shapes = getPrefabCollision(id);
    expect(shapes).toHaveLength(prefab.parts.length);
    shapes.forEach((shape, i) => {
      const part = prefab.parts[i]!;
      expect(shape.kind).toBe(part.kind);
      for (let a = 0; a < 3; a++) {
        expect(shape.center[a]! - shape.size[a]! / 2).toBeCloseTo(part.min[a]!, 6);
        expect(shape.center[a]! + shape.size[a]! / 2).toBeCloseTo(part.max[a]!, 6);
      }
    });
  });

  it("keeps stair rises within the controller's step height", () => {
    for (const flight of prefab.stairs) {
      const tops = [flight.fromY, ...flight.treads.map((t) => t.max[1]), flight.toY];
      for (let k = 1; k < tops.length; k++) {
        const rise = tops[k]! - tops[k - 1]!;
        expect(rise).toBeGreaterThan(0);
        expect(rise).toBeLessThanOrEqual(KIT.stairs.maxRise + 1e-6);
      }
      for (const tread of flight.treads) {
        expect(Math.min(tread.max[0] - tread.min[0], tread.max[2] - tread.min[2])).toBeGreaterThanOrEqual(KIT.stairs.run - 1e-6);
        expect(Math.max(tread.max[0] - tread.min[0], tread.max[2] - tread.min[2])).toBeGreaterThanOrEqual(2 * (MOVEMENT.capsuleRadius + SKIN));
      }
    }
  });

  it("leaves standing headroom above every tread", () => {
    const headroom = MOVEMENT.standHeight + 2 * SKIN;
    for (const flight of prefab.stairs) {
      for (const t of flight.treads) {
        const blocked = bvh.overlapsBox([t.min[0] + 0.01, t.max[1] + 0.01, t.min[2] + 0.01], [t.max[0] - 0.01, t.max[1] + headroom, t.max[2] - 0.01]);
        expect(blocked, `tread at y=${t.max[1]} [${t.min}]`).toBe(false);
      }
    }
  });

  it("fits a standing capsule over the middle of every tread", () => {
    const structure = new PartBvh(prefab.parts.filter((p) => p.role !== "stairs" && p.role !== "railing"));
    const r = MOVEMENT.capsuleRadius;
    for (const flight of prefab.stairs) {
      for (const t of flight.treads) {
        const [cx, cz] = [(t.min[0] + t.max[0]) / 2, (t.min[2] + t.max[2]) / 2];
        const y = t.max[1];
        expect(structure.overlapsBox([cx - r, y + MOVEMENT.maxStepHeight + 0.01, cz - r], [cx + r, y + MOVEMENT.standHeight + SKIN, cz + r]), `tread at y=${y} [${t.min}]`).toBe(false);
      }
    }
  });

  it("has doorways a standing player fits through", () => {
    const passage = 2 * (MOVEMENT.capsuleRadius + SKIN);
    const crouchOnly = (min: Vec3Tuple, max: Vec3Tuple) => prefab.crouchPassages.some((c) => boxesOverlap(c.min, c.max, min, max));
    for (const o of prefab.openings.filter((o) => o.kind === "door")) {
      expect(o.u[1] - o.u[0]).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(o.y[1] - o.y[0]).toBeGreaterThanOrEqual(2.2 - 1e-6);
      // Clear column through the wall plus a player's depth either side.
      const [t0, t1] = [o.through[0] - passage, o.through[1] + passage];
      const min: Vec3Tuple = o.axis === "x" ? [o.u[0] + 0.01, o.y[0] + 0.01, t0] : [t0, o.y[0] + 0.01, o.u[0] + 0.01];
      const max: Vec3Tuple = o.axis === "x" ? [o.u[1] - 0.01, o.y[0] + MOVEMENT.standHeight + SKIN, t1] : [t1, o.y[0] + MOVEMENT.standHeight + SKIN, o.u[1] - 0.01];
      if (!crouchOnly(min, max)) expect(bvh.overlapsBox(min, max), `door at [${o.u}] on ${o.axis}`).toBe(false);
    }
  });

  it("lets bullets through the middle of every opening and stops them at solid wall", () => {
    for (const o of prefab.openings.filter((o) => o.kind !== "hole")) {
      const u = (o.u[0] + o.u[1]) / 2;
      const y = (o.y[0] + o.y[1]) / 2;
      const from = o.through[0] - 0.3;
      const length = o.through[1] - o.through[0] + 0.6;
      const origin: Vec3Tuple = o.axis === "x" ? [u, y, from] : [from, y, u];
      const dir: Vec3Tuple = o.axis === "x" ? [0, 0, 1] : [1, 0, 0];
      expect(bvh.raycast(origin, dir, length), `${o.kind} at [${o.u}]`).toBeNull();
      if (o.kind === "window") {
        // Just below the sill: a crouched player's eyes are covered by the wall.
        const low: Vec3Tuple = o.axis === "x" ? [u, o.y[0] - 0.12, from] : [from, o.y[0] - 0.12, u];
        expect(bvh.raycast(low, dir, length), `below window at [${o.u}]`).not.toBeNull();
      }
    }
  });

  it("offers loot spots in every sizeable room, clear of geometry and on a floor", () => {
    const spots = getPrefabLootSpots(id);
    for (const room of prefab.rooms) {
      const area = (room.max[0] - room.min[0]) * (room.max[1] - room.min[1]);
      if (area >= 4) expect(spots.some((s) => s.roomId === room.id), room.id).toBe(true);
    }
    for (const { position: [x, y, z] } of spots) {
      expect(bvh.overlapsBox([x - 0.25, y + 0.01, z - 0.25], [x + 0.25, y + 0.9, z + 0.25])).toBe(false);
    }
  });

  it("fits crouched players, but not standing ones, through crouch passages", () => {
    for (const { min, max } of prefab.crouchPassages) {
      const [cx, cz] = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
      const r = MOVEMENT.capsuleRadius;
      const crouched = MOVEMENT.crouchHeight + 2 * SKIN;
      expect(max[1] - min[1]).toBeGreaterThanOrEqual(crouched);
      expect(bvh.overlapsBox([cx - r, min[1] + 0.01, cz - r], [cx + r, min[1] + crouched, cz + r])).toBe(false);
      expect(bvh.overlapsBox([cx - r, min[1] + 0.01, cz - r], [cx + r, min[1] + MOVEMENT.standHeight, cz + r])).toBe(true);
    }
  });

  it("keeps entrances clear for a standing player", () => {
    for (const [x, y, z] of prefab.entrances) {
      const r = MOVEMENT.capsuleRadius;
      expect(bvh.overlapsBox([x - r, y + 0.01, z - r], [x + r, y + MOVEMENT.standHeight, z + r]), `entrance ${[x, y, z]}`).toBe(false);
    }
  });

  it("keeps within the nav grid's walkable levels per column", () => {
    expect(buildPrefabLayer(prefab, 0.25, 0.3).overflowColumns).toBe(0);
  });

  it("generates deterministic geometry with baked visibility in range", () => {
    const a = buildPrefabGeometry(prefab, { aoRays: 8 });
    const b = buildPrefabGeometry(prefab, { aoRays: 8 });
    expect(a.triangles).toBeGreaterThan(0);
    expect(a.triangles).toBe(b.triangles);
    a.groups.forEach((group, i) => {
      expect(group.positions).toEqual(b.groups[i]!.positions);
      expect(group.shade).toEqual(b.groups[i]!.shade);
      expect(group.indices.length % 3).toBe(0);
      for (let v = 0; v < group.shade.length; v += 2) expect(group.shade[v]).toBeGreaterThanOrEqual(0);
      for (let v = 0; v < group.shade.length; v += 2) expect(group.shade[v]).toBeLessThanOrEqual(1);
    });
  });
});

describe("building kit", () => {
  it("sizes windows so a crouched player can vault through and hide below the sill", () => {
    expect(KIT.window.head - KIT.window.sill).toBeGreaterThanOrEqual(MOVEMENT.crouchHeight + 2 * SKIN + 0.05);
    expect(KIT.window.sill).toBeGreaterThanOrEqual(MOVEMENT.crouchEyeHeight);
    expect(KIT.window.sill).toBeLessThan(MOVEMENT.standEyeHeight - 0.3);
  });

  it("subtracts holes without losing or duplicating area", () => {
    const outer = { u0: 0, u1: 10, v0: 0, v1: 3 };
    const holes = [
      { u0: 1, u1: 2.2, v0: 0, v1: 2.2 },
      { u0: 4, u1: 5.2, v0: 1, v1: 2.3 },
      { u0: 4.5, u1: 6, v0: 1.5, v1: 3 },
    ];
    const rects = subtractRects(outer, holes);
    const area = rects.reduce((sum, r) => sum + (r.u1 - r.u0) * (r.v1 - r.v0), 0);
    const holeArea = 1.2 * 2.2 + 1.2 * 1.3 + 1.5 * 1.5 - 0.7 * 0.8; // last hole overlaps the second
    expect(area).toBeCloseTo(30 - holeArea, 6);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i]!, rects[j]!];
        expect(boxesOverlap([a.u0, a.v0, 0], [a.u1, a.v1, 1], [b.u0, b.v0, 0], [b.u1, b.v1, 1])).toBe(false);
      }
    }
  });

  it("round-trips placement transforms and rotates the front toward the yaw", () => {
    const placement = { position: [120, 14.5, -40] as Vec3Tuple, yaw: 0.7 };
    const p: Vec3Tuple = [3, 1.2, -2];
    const back = worldToLocal(placement, localToWorld(placement, p));
    back.forEach((v, i) => expect(v).toBeCloseTo(p[i]!, 9));
    const front = localToWorld({ position: [0, 0, 0], yaw: Math.PI / 2 }, [0, 0, 1]);
    expect(front[0]).toBeCloseTo(1, 9);
    expect(front[2]).toBeCloseTo(0, 9);
  });

  it("converts prefabs to level blocks for LevelData consumers", () => {
    const blocks = prefabLevelBlocks("house_small", { position: [0, 0, 0], yaw: 0 });
    expect(blocks).toHaveLength(getBuildingPrefab("house_small").parts.length);
    expect(blocks.filter((b) => b.kind === "ramp")).toHaveLength(2);
  });

  it("darkens interiors and keeps roofs open to the sky", () => {
    const geometry = buildPrefabGeometry(getBuildingPrefab("house_small"), { aoRays: 16 });
    const visibilityAt = (material: string, test: (x: number, y: number, z: number, ny: number) => boolean): number[] => {
      const out: number[] = [];
      for (const g of geometry.groups.filter((g) => g.material === material)) {
        for (let v = 0; v < g.positions.length / 3; v++) {
          if (test(g.positions[v * 3]!, g.positions[v * 3 + 1]!, g.positions[v * 3 + 2]!, g.normals[v * 3 + 1]!)) out.push(g.shade[v * 2]!);
        }
      }
      return out;
    };
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const floor = visibilityAt("woodFloor", (x, y, z, ny) => ny > 0.9 && y === 0 && Math.abs(x) < 4 && Math.abs(z) < 3);
    const roof = visibilityAt("roofMetal", () => true);
    expect(floor.length).toBeGreaterThan(0);
    expect(mean(floor)).toBeLessThan(0.3);
    expect(mean(roof)).toBeGreaterThan(0.9);
  });
});
