import { MOVEMENT } from "../../constants";
import { getBuildingPrefab } from "../buildings/prefabs";
import type { Terrain } from "../terrain/terrain";
import type { MapData } from "../types";
import { terrainRangeUnder } from "./buildings";
import { distance, distanceToRect, offsetPoint, rectsOverlap, segmentDistance, type OrientedRect } from "./geometry";
import type { MapLayout } from "./mapLayout";
import type { LineOpening } from "./placement";
import { getMapProp, type MapPropDef } from "./props";
import { mapPaths } from "./roads";
import { ENTRANCE_CLEARANCE, INSTANCE_STRIDE } from "./scatter";

export type MapIssueKind =
  | "building-overlap"
  | "building-on-road"
  | "building-not-on-pad"
  | "building-entrance"
  | "building-out-of-bounds"
  | "poi-spacing"
  | "spawn"
  | "prop-on-road"
  /** A collidable prop within ENTRANCE_CLEARANCE of a building entrance. */
  | "prop-at-entrance"
  /** A collidable prop in or next to a fence gate or wall breach (`ValidationOptions.openings`). */
  | "prop-in-opening";

export interface MapIssue {
  readonly kind: MapIssueKind;
  readonly message: string;
}

export interface ValidationOptions {
  /** Minimum distance between major POI centers, m (default 120: the maps are a 500 m square). */
  readonly poiSpacing?: number;
  /** Minimum distance between a minor POI's center and any other POI center, m (also at least both radii + 40 m). */
  readonly minorPoiSpacing?: number;
  /** POIs with a radius up to this are minor (hamlets, camps), m. */
  readonly minorPoiRadius?: number;
  /** Gap kept between building outlines, m. */
  readonly buildingGap?: number;
  /** Gap kept between building outlines and road edges, m. */
  readonly roadGap?: number;
  /** Fence gates and wall breaches to keep clear (PoiFrame.openings). */
  readonly openings?: readonly LineOpening[];
}

/** Fence and wall pieces line the openings themselves. */
const LINE_PROPS = new Set(["fence_wood", "fence_chainlink", "wall_concrete"]);

const MAX_SPAWN_SLOPE_TAN = 0.577; // 30°

/** Pure layout checks: nothing overlaps, buildings sit on their pads, POIs are spread out and spawns are safe. */
export function validateMapLayout(map: MapData, terrain: Terrain, layout: MapLayout, options: ValidationOptions = {}): MapIssue[] {
  const issues: MapIssue[] = [];
  const issue = (kind: MapIssueKind, message: string) => issues.push({ kind, message });
  const buildings = layout.buildings;
  const paths = mapPaths(map);
  const half = map.terrain.playableHalfExtent;

  // Buildings against each other.
  const gap = options.buildingGap ?? 1;
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const a = buildings[i]!;
      const b = buildings[j]!;
      if (a.stackOn === b.id || b.stackOn === a.id) continue;
      if (a.stackOn && a.stackOn === b.stackOn) continue;
      if (rectsOverlap(a.bounds, b.bounds, gap)) issue("building-overlap", `${a.id} and ${b.id} are closer than ${gap} m`);
    }
  }

  const roadGap = options.roadGap ?? 1;
  for (const b of buildings) {
    // Against roads: sample each path near the building. Bridges stand on the road they carry.
    for (const path of getBuildingPrefab(b.prefab).spansRoad ? [] : paths) {
      const clearance = path.halfWidth + roadGap;
      if (distanceToPath(b.bounds, path.points, clearance) < clearance) issue("building-on-road", `${b.id} is within ${roadGap} m of a ${path.kind} road (flatten #${path.index})`);
    }
    const [x, y, z] = b.position;
    if (Math.abs(x) > half - 10 || Math.abs(z) > half - 10) issue("building-out-of-bounds", `${b.id} is outside the playable area`);
    if (b.stackOn) continue;

    // On its pad: terrain under the base stays below the floor and above the bottom of the foundation.
    const range = terrainRangeUnder(terrain, b.base);
    if (range.max > y - 0.01) issue("building-not-on-pad", `${b.id}: terrain rises to ${(range.max - y).toFixed(2)} m relative to the floor`);
    if (range.min < y - b.baseDepth) issue("building-not-on-pad", `${b.id}: terrain drops ${(y - range.min).toFixed(2)} m below the floor (base reaches ${b.baseDepth} m)`);

    // Entrances can be stepped into from the ground outside.
    for (const [lx, ly, lz] of getBuildingPrefab(b.prefab).entrances) {
      const [ex, ez] = offsetPoint([x, z], b.yaw, lx, lz);
      const step = y + ly - terrain.sampleHeight(ex, ez);
      if (step > MOVEMENT.maxStepHeight) issue("building-entrance", `${b.id}: entrance at (${ex.toFixed(1)}, ${ez.toFixed(1)}) is a ${step.toFixed(2)} m step up`);
    }
  }

  // POI spacing: major POIs keep `poiSpacing` between them; a minor POI (hamlet, camp) keeps `minorPoiSpacing` from any POI.
  const spacing = options.poiSpacing ?? 120;
  const minorSpacing = options.minorPoiSpacing ?? 80;
  const minorRadius = options.minorPoiRadius ?? 40;
  for (const poi of map.pois) {
    for (const other of map.pois) {
      if (other === poi) continue;
      const d = distance(poi.center[0], poi.center[1], other.center[0], other.center[1]);
      const needed = poi.radius <= minorRadius || other.radius <= minorRadius ? Math.max(minorSpacing, poi.radius + other.radius + 20) : spacing;
      if (d < needed) issue("poi-spacing", `${poi.id} is ${d.toFixed(0)} m from ${other.id} (needs ${needed.toFixed(0)} m)`);
    }
  }

  // Collidable props on roads.
  for (const set of layout.props) {
    const def = getMapProp(set.prop);
    if (def.collision.kind === "none" || def.category === "prop") continue;
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const px = set.data[i]!;
      const pz = set.data[i + 2]!;
      for (const path of paths) {
        if (distanceToPoints(path.points, px, pz) < path.halfWidth + def.footprint * set.data[i + 4]!) {
          issue("prop-on-road", `${set.prop} at (${px.toFixed(1)}, ${pz.toFixed(1)}) blocks a ${path.kind} road`);
        }
      }
    }
  }

  // Collidable props clear of entrances and openings.
  const entrances: [number, number, string][] = [];
  for (const b of buildings) {
    if (b.stackOn) continue;
    getBuildingPrefab(b.prefab).entrances.forEach(([lx, , lz], i) => {
      const [ex, ez] = offsetPoint([b.position[0], b.position[2]], b.yaw, lx, lz);
      entrances.push([ex, ez, `${b.id} entrance ${i}`]);
    });
  }
  const openings = options.openings ?? [];
  for (const set of layout.props) {
    const def = getMapProp(set.prop);
    if (def.collision.kind === "none") continue;
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const px = set.data[i]!;
      const pz = set.data[i + 2]!;
      const where = `${set.prop} at (${px.toFixed(1)}, ${pz.toFixed(1)})`;
      for (const [ex, ez, name] of entrances) {
        if (Math.abs(ex - px) > 12 || Math.abs(ez - pz) > 12) continue;
        if (colliderDistance(def, set.data, i, ex, ez) < ENTRANCE_CLEARANCE) issue("prop-at-entrance", `${where} is within ${ENTRANCE_CLEARANCE} m of ${name}`);
      }
      if (LINE_PROPS.has(set.prop)) continue;
      for (const opening of openings) {
        const [ox, oz] = opening.center;
        if (Math.abs(ox - px) > 20 || Math.abs(oz - pz) > 20) continue;
        if (colliderDistance(def, set.data, i, ox, oz) < opening.width / 2 + ENTRANCE_CLEARANCE) issue("prop-in-opening", `${where} blocks the ${opening.width} m opening at (${ox}, ${oz})`);
      }
    }
  }

  // Spawns: inside, walkable, clear of buildings and collidable props.
  for (const [index, spawn] of map.spawns.entries()) {
    const [sx, sz] = spawn.position;
    const where = `spawn ${index} (${sx}, ${sz})`;
    if (Math.abs(sx) > half - 20 || Math.abs(sz) > half - 20) issue("spawn", `${where} is within 20 m of the playable edge`);
    if (terrain.slopeTanAt(sx, sz) > MAX_SPAWN_SLOPE_TAN) issue("spawn", `${where} is on a slope steeper than 30°`);
    if (terrain.sampleHeight(sx, sz) < map.bounds.killY + 5) issue("spawn", `${where} is near the kill height`);
    for (const b of buildings) if (distanceToRect(b.bounds, sx, sz) < 2) issue("spawn", `${where} is within 2 m of ${b.id}`);
    for (const set of layout.props) {
      if (getMapProp(set.prop).collision.kind === "none") continue;
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        if (distance(sx, sz, set.data[i]!, set.data[i + 2]!) < 2) issue("spawn", `${where} is within 2 m of a ${set.prop}`);
      }
    }
  }
  return issues;
}

/** Distance from a point to the collider footprint of the instance at `i`. */
function colliderDistance(def: MapPropDef, data: Float32Array, i: number, x: number, z: number): number {
  const scale = data[i + 4]!;
  const c = def.collision;
  if (c.kind === "cylinder") return Math.max(0, distance(x, z, data[i]!, data[i + 2]!) - c.radius * scale);
  if (c.kind === "box") return distanceToRect({ center: [data[i]!, data[i + 2]!], halfExtents: [(c.size[0] * scale) / 2, (c.size[2] * scale) / 2], yaw: data[i + 3]! }, x, z);
  return Infinity;
}

function distanceToPoints(points: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) best = Math.min(best, segmentDistance(x, z, points[i]![0], points[i]![1], points[i + 1]![0], points[i + 1]![1]));
  return best;
}

/** Shortest distance from a rectangle to a polyline (sampled every meter along the polyline), capped at `limit`. */
function distanceToPath(rect: OrientedRect, points: readonly (readonly [number, number])[], limit: number): number {
  const reach = Math.sqrt(rect.halfExtents[0] * rect.halfExtents[0] + rect.halfExtents[1] * rect.halfExtents[1]) + limit;
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    if (segmentDistance(rect.center[0], rect.center[1], ax, az, bx, bz) > reach) continue;
    const steps = Math.max(1, Math.ceil(distance(ax, az, bx, bz)));
    for (let k = 0; k <= steps; k++) best = Math.min(best, distanceToRect(rect, ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps));
  }
  return best;
}
