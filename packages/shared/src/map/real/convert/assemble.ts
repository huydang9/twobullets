import { buildNavGrid } from "../../../bots/nav/buildNavGrid";
import { mapNavProbes, resolveProbes } from "../../../bots/nav/mapProbes";
import { createNavQuery } from "../../../bots/nav/navQuery";
import type { LayoutBuilding } from "../../layout/buildings";
import { buildMapLayout, type MapLayout } from "../../layout/mapLayout";
import type { LineOpening } from "../../layout/placement";
import { mapPaths, roadFlatten, type RoadSpec } from "../../layout/roads";
import { seedFromId, type ScatterRule } from "../../layout/scatter";
import { validateMapLayout, type MapIssue, type ValidationOptions } from "../../layout/validate";
import { buildTerrain, type Terrain } from "../../terrain/terrain";
import { distanceToRect } from "../../layout/geometry";
import type { FlattenRegion, MapData, MapSpawn, PointOfInterest, PropPlacement, RoadLabel, TerrainSpec } from "../../types";
import { findBridges, type BridgeSite } from "./bridges";
import { buildingCandidates, DEFAULT_BUILDING_CAP, PlacementSpace, placeBuildings, type PlacedBuilding, type PlacementReport } from "./buildings";
import { realTerrainSpec, type ElevationReport } from "./elevation";
import { convertLanduse, insideAny, trimRoadsAtWater, waterEdges, waterPolygons, type LanduseReport } from "./landuse";
import { buildingPads } from "./pads";
import { isPoliticalName } from "./names";
import { parseOsm } from "./parse";
import { convertPois, REAL_POI_SPACING, type PoiReport } from "./pois";
import { createProjection } from "./projection";
import { convertCreeks, convertRoads, type RoadReport } from "./roads";
import { convertRoadLabels, type RoadLabelReport } from "./roadLabels";
import { pickSpawns, spawnKey } from "./spawns";
import { frontageCandidates, rankFootprints, urbanDefaults } from "./urban";
import type { ElevationSamples, OsmDocument, PlaceConfig, Polygon } from "./types";
import { fenceOpenings, fenceProps, type FenceLine } from "../fences";

export interface ConvertInput {
  readonly osm: OsmDocument;
  /** Elevation samples around the center (ignored when the place is flat). */
  readonly elevation: ElevationSamples | null;
  readonly config: PlaceConfig;
}

export interface ConvertOptions {
  /** Run the nav-grid reachability pass (default true). */
  readonly navCheck?: boolean;
  readonly maxIterations?: number;
  readonly log?: (message: string) => void;
}

export interface ReachabilityReport {
  readonly pois: string;
  readonly spawns: string;
  readonly entrances: string;
  /** Reachable loot spots / all. */
  readonly loot: string;
  readonly lootRatio: number;
}

export interface ConvertReport {
  readonly id: string;
  readonly osmTimestamp: string | null;
  readonly elevation: ElevationReport;
  readonly roads: RoadReport;
  readonly roadLabels: RoadLabelReport;
  readonly placement: PlacementReport;
  /** Buildings removed by the terrain validation and reachability passes. */
  readonly droppedByValidation: number;
  readonly buildings: number;
  readonly buildingsByPrefab: Readonly<Record<string, number>>;
  /** City maps: bridges laid over water and creek crossings (kept after validation). */
  readonly bridges?: readonly { readonly id: string; readonly prefab: string; readonly road: string; readonly span: number; readonly at: readonly [number, number] }[];
  readonly pois: PoiReport & { readonly count: number };
  readonly spawns: number;
  readonly landuse: LanduseReport;
  readonly waterFenceMeters: number;
  readonly iterations: number;
  readonly issues: readonly MapIssue[];
  readonly reachability: ReachabilityReport | null;
  readonly layoutChecksum: string;
  readonly terrainChecksum: string;
}

/** The generated map and the pieces the code generator writes out. */
export interface ConvertResult {
  readonly map: MapData;
  readonly parts: {
    readonly terrain: TerrainSpec;
    readonly pads: readonly FlattenRegion[];
    readonly creeks: readonly FlattenRegion[];
    readonly roads: readonly RoadSpec[];
    readonly pois: readonly PointOfInterest[];
    readonly buildings: readonly LayoutBuilding[];
    readonly props: readonly PropPlacement[];
    readonly fences: readonly FenceLine[];
    readonly scatters: readonly ScatterRule[];
    readonly spawns: readonly MapSpawn[];
    /** Map-screen road names (may be empty). */
    readonly roadLabels: readonly RoadLabel[];
  };
  readonly water: readonly Polygon[];
  readonly openings: readonly LineOpening[];
  readonly validation: ValidationOptions;
  readonly terrain: Terrain;
  readonly layout: MapLayout;
  readonly report: ConvertReport;
}

/** Row houses in a city stand this close to each other (frontage rows pack them `ROW_GAP` apart), m. */
export const URBAN_BUILDING_GAP = 0.1;

/** Validation options for a real map with its fence openings (city maps allow row houses side by side). */
export function realValidationOptions(openings: readonly LineOpening[], urban = false): ValidationOptions {
  return urban ? { ...REAL_POI_SPACING, buildingGap: URBAN_BUILDING_GAP, openings } : { ...REAL_POI_SPACING, openings };
}

/**
 * OSM + elevation → MapData, fixed until it validates: roads, creeks and water first, then buildings placed around
 * them, POIs, pads, terrain, spawns and scatter. Every pass that finds a problem (building off its pad, a steep entrance,
 * an unreachable door or spawn) removes the offender and rebuilds, so the result passes `validateMapLayout` and the nav
 * reachability checks. Pure and deterministic for the same inputs.
 */
export function convertRealMap(input: ConvertInput, options: ConvertOptions = {}): ConvertResult {
  const { config } = input;
  const log = options.log ?? (() => {});
  for (const name of [config.name, config.localName]) {
    if (name && isPoliticalName(name)) throw new Error(`${config.id}: "${name}" is a political name; pick a neutral map name (see convert/names.ts)`);
  }
  const projection = createProjection(config.lat, config.lon);
  const parsed = parseOsm(input.osm, projection, 640);
  const { spec, report: elevation } = realTerrainSpec(config.seed ?? seedFromId(config.id), input.elevation, config.elevation);

  const urban = config.urban;
  const converted = convertRoads(parsed.lines, urban !== undefined);
  const roadReport = converted.report;
  const water = waterPolygons(parsed.areas);
  const roads = trimRoadsAtWater(converted.roads, water);
  const roadLabels = convertRoadLabels(parsed.lines, urban !== undefined);
  const creeks = convertCreeks(parsed.lines, (x, z) => insideAny(water, x, z));
  const bridges: readonly BridgeSite[] = urban ? findBridges(roads, water, parsed.lines) : [];
  const edges = urban ? waterEdges(water, roads, (x, z) => bridges.some((b) => distanceToRect(b.bounds, x, z) === 0)) : waterEdges(water, roads);
  const fences = edges.fences;
  const props = fenceProps(fences);
  const openings = fenceOpenings(fences);
  const flattenPaths = mapPaths({ flatten: [...creeks, ...roads.map(roadFlatten)] });
  const isolated = water.length > 0 ? isolatedLand(config, spec, creeks, roads, props) : () => false;
  const footprints = buildingCandidates(parsed.buildings, urban !== undefined, urban ? parsed.amenities : []).filter((c) => !isolated(c.centroid[0], c.centroid[1]));
  const candidates = urban ? [...rankFootprints(footprints, roads), ...frontageCandidates(roads, parsed.buildings, parsed.areas, urban).filter((c) => !isolated(c.centroid[0], c.centroid[1]))] : footprints;
  const cap = config.buildingCap ?? DEFAULT_BUILDING_CAP;
  log(`${config.id}: ${roads.length} roads (${roadReport.asphaltKm} km asphalt, ${roadReport.dirtKm} km dirt), ${creeks.length} creek beds, ${water.length} water areas (${edges.length} m of fence), ${candidates.length} building candidates${urban ? ` (${footprints.length} OSM footprints, ${candidates.length - footprints.length} frontage slots)` : ""}`);

  const excluded = new Set<string>();
  const blockedSpawns = new Set<string>();
  const maxIterations = options.maxIterations ?? 12;
  let result: ConvertResult | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const space = new PlacementSpace(flattenPaths, water);
    const keptBridges = bridges.filter((b) => !excluded.has(b.id));
    for (const b of keptBridges) space.addPlaced(b.bounds);
    const placed = placeBuildings(candidates, space, urban ? { cap, excluded, cellQuota: urbanDefaults(urban).cellQuota } : { cap, excluded });
    const poiResult = convertPois(placed.buildings, config, parsed.points, parsed.areas, parsed.buildings, water, isolated);
    const pads = buildingPads(placed.buildings, spec);
    const flatten: FlattenRegion[] = [...pads, ...creeks, ...roads.map(roadFlatten)];
    const terrain = buildTerrain(spec, flatten);
    const buildings: LayoutBuilding[] = placed.buildings.map((b) => {
      const poi = poiResult.membership.get(b.id);
      return { id: b.id, prefab: b.prefab, position: b.position, yaw: b.yaw, snapToTerrain: true, ...(poi ? { poi } : {}) };
    });
    for (const b of keptBridges) buildings.push({ id: b.id, prefab: b.prefab, position: b.position, yaw: b.yaw, snapToTerrain: true });
    const { spawns, short } = pickSpawns(poiResult.pois, terrain, placed.buildings, props, space, blockedSpawns, isolated);
    const { scatters, report: landuse } = convertLanduse(parsed.areas, parsed.lines, roads, poiResult.pois, water, openings, config);
    const map: MapData = {
      id: config.id,
      name: config.name,
      terrain: spec,
      flatten,
      bounds: { outOfBoundsGraceSeconds: 10, killY: -40, landingAltitude: 300 },
      pois: poiResult.pois,
      buildings,
      props,
      scatters,
      spawns,
      ...(roadLabels.labels.length > 0 ? { roadLabels: roadLabels.labels } : {}),
    };
    const layout = buildMapLayout(map, terrain);
    const validation = realValidationOptions(openings, urban !== undefined);
    const issues = validateMapLayout(map, terrain, layout, validation);
    const before = excluded.size + blockedSpawns.size;
    const unhandled = handleIssues(issues, [...placed.buildings, ...keptBridges], excluded, blockedSpawns);
    log(`${config.id} pass ${iteration}: ${placed.buildings.length} buildings, ${poiResult.pois.length} POIs, ${spawns.length} spawns${short.length ? ` (short: ${short.join(", ")})` : ""}, ${issues.length} issues`);

    let reachability: ReachabilityReport | null = null;
    if (excluded.size + blockedSpawns.size === before && unhandled.length === 0 && options.navCheck !== false) {
      reachability = checkReachability(map, terrain, layout, placed.buildings, excluded, blockedSpawns, log);
    }
    const changed = excluded.size + blockedSpawns.size !== before;
    const byPrefab: Record<string, number> = {};
    for (const b of buildings) byPrefab[b.prefab] = (byPrefab[b.prefab] ?? 0) + 1;
    result = {
      map,
      parts: { terrain: spec, pads, creeks, roads, pois: poiResult.pois, buildings, props, fences, scatters, spawns, roadLabels: roadLabels.labels },
      water,
      openings,
      validation,
      terrain,
      layout,
      report: {
        id: config.id,
        osmTimestamp: parsed.timestamp,
        elevation,
        roads: roadReport,
        roadLabels: roadLabels.report,
        placement: placed.report,
        droppedByValidation: excluded.size,
        buildings: buildings.length,
        buildingsByPrefab: byPrefab,
        ...(urban ? { bridges: keptBridges.map((b) => ({ id: b.id, prefab: b.prefab, road: b.road, span: b.span, at: [b.position[0], b.position[2]] as const })) } : {}),
        pois: { ...poiResult.report, count: poiResult.pois.length },
        spawns: spawns.length,
        landuse,
        waterFenceMeters: edges.length,
        iterations: iteration,
        issues: changed ? issues : unhandled,
        reachability,
        layoutChecksum: layout.checksum,
        terrainChecksum: terrain.checksum(),
      },
    };
    if (!changed) break;
  }
  return result!;
}

/**
 * Land that water fences cut off from the rest of the map (no bridge inside the square): a nav grid over terrain, roads
 * and fences alone, before any building exists. Buildings, landmark POIs and spawns stay off it.
 */
function isolatedLand(config: PlaceConfig, spec: TerrainSpec, creeks: readonly FlattenRegion[], roads: readonly RoadSpec[], props: readonly PropPlacement[]): (x: number, z: number) => boolean {
  const map: MapData = {
    id: config.id,
    name: config.name,
    terrain: spec,
    flatten: [...creeks, ...roads.map(roadFlatten)],
    bounds: { outOfBoundsGraceSeconds: 10, killY: -40, landingAltitude: 300 },
    pois: [],
    buildings: [],
    props,
    scatters: [],
    spawns: [],
  };
  const terrain = buildTerrain(spec, map.flatten);
  const grid = buildNavGrid({ map, terrain, layout: buildMapLayout(map, terrain) });
  const nav = createNavQuery(grid);
  const scratch = { x: 0, y: 0, z: 0 };
  return (x, z) => {
    const ref = nav.nearest({ x, y: terrain.sampleHeight(x, z), z }, 3, scratch);
    return ref >= 0 && grid.componentOf(ref) !== grid.layout.mainComponent;
  };
}

const ID_PATTERN = /\b(bld_r?\d+)\b/g;

/**
 * Turns validation issues into exclusions: the lower-priority building of an overlapping pair (placed later), any building
 * with a pad, entrance, road or prop problem, and spawns that fail. Returns issues it could not attribute.
 */
function handleIssues(issues: readonly MapIssue[], placed: readonly { readonly id: string }[], excluded: Set<string>, blockedSpawns: Set<string>): MapIssue[] {
  const order = new Map(placed.map((b, i) => [b.id, i] as const));
  const unhandled: MapIssue[] = [];
  for (const issue of issues) {
    const ids = [...issue.message.matchAll(ID_PATTERN)].map((m) => m[1]!).filter((id) => order.has(id));
    if (issue.kind === "spawn") {
      const match = /spawn \d+ \((-?[\d.]+), (-?[\d.]+)\)/.exec(issue.message);
      if (match) blockedSpawns.add(spawnKey(Number(match[1]), Number(match[2])));
      else unhandled.push(issue);
      continue;
    }
    if (ids.length === 0) {
      unhandled.push(issue);
      continue;
    }
    // Overlaps name two buildings: drop the one placed later (lower priority).
    const victim = ids.sort((a, b) => order.get(b)! - order.get(a)!)[0]!;
    excluded.add(victim);
  }
  return unhandled;
}

/**
 * Nav-grid pass: every POI, spawn, entrance and ground-floor room must be on the main component, and ≥ 97.5 % of loot
 * spots reachable. Buildings with an unreachable door or room (or mostly unreachable loot) are excluded; bad spawns blocked.
 */
function checkReachability(
  map: MapData,
  terrain: Terrain,
  layout: MapLayout,
  placed: readonly PlacedBuilding[],
  excluded: Set<string>,
  blockedSpawns: Set<string>,
  log: (message: string) => void,
): ReachabilityReport {
  const grid = buildNavGrid({ map, terrain, layout });
  const nav = createNavQuery(grid);
  const probes = mapNavProbes(map, terrain, layout);
  const scratch = { x: 0, y: 0, z: 0 };
  let from = -1;
  const byWeight = [...map.pois].sort((a, b) => b.lootTier - a.lootTier || b.radius - a.radius);
  for (const poi of byWeight) {
    const ref = nav.nearest({ x: poi.center[0], y: terrain.sampleHeight(poi.center[0], poi.center[1]), z: poi.center[1] }, 12, scratch);
    if (ref >= 0 && grid.componentOf(ref) === grid.layout.mainComponent) {
      from = ref;
      break;
    }
  }
  const results = resolveProbes(nav, probes, from);
  const ratio = (kind: string, filter: (r: (typeof results)[number]) => boolean = () => true) => {
    const list = results.filter((r) => r.probe.kind === kind && filter(r));
    return { all: list.length, ok: list.filter((r) => r.reachable).length, list };
  };
  const pois = ratio("poi");
  const spawns = ratio("spawn");
  const entrances = ratio("entrance");
  const rooms = ratio("room", (r) => !r.probe.upper);
  const loot = ratio("loot");

  const before = excluded.size + blockedSpawns.size;
  for (const r of [...entrances.list, ...rooms.list]) if (!r.reachable && r.probe.building) excluded.add(r.probe.building);
  for (const r of spawns.list) if (!r.reachable) blockedSpawns.add(spawnKey(r.probe.x, r.probe.z));
  const lootRatio = loot.all === 0 ? 1 : loot.ok / loot.all;
  if (lootRatio < 0.98) {
    const perBuilding = new Map<string, { all: number; ok: number }>();
    for (const r of loot.list) {
      const entry = perBuilding.get(r.probe.building!) ?? { all: 0, ok: 0 };
      entry.all++;
      if (r.reachable) entry.ok++;
      perBuilding.set(r.probe.building!, entry);
    }
    const worst = [...perBuilding].filter(([, e]) => e.ok / e.all < 0.85).sort((a, b) => a[1].ok / a[1].all - b[1].ok / b[1].all || (a[0] < b[0] ? -1 : 1));
    let missing = loot.all - loot.ok;
    for (const [id, e] of worst) {
      if (missing <= loot.all * 0.015) break;
      excluded.add(id);
      missing -= e.all - e.ok;
    }
  }
  const unreachablePois = pois.list.filter((r) => !r.reachable).map((r) => r.probe.name);
  if (unreachablePois.length > 0) log(`unreachable POIs: ${unreachablePois.join(", ")}`);
  if (excluded.size + blockedSpawns.size !== before) log(`reachability: excluded ${excluded.size} buildings, blocked ${blockedSpawns.size} spawns so far`);
  void placed;
  const fmt = (r: { all: number; ok: number }) => `${r.ok}/${r.all}`;
  return { pois: fmt(pois), spawns: fmt(spawns), entrances: fmt(entrances), loot: fmt(loot), lootRatio: Math.round(lootRatio * 10000) / 10000 };
}
