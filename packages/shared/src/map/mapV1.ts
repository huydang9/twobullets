import { getBuildingPrefab, type BuildingPrefabId } from "./buildings/prefabs";
import type { LayoutBuilding } from "./layout/buildings";
import { bandAlong, catmullRom, offsetPoint, round3, segmentDistance } from "./layout/geometry";
import { PoiFrame, rectLoop, type LineOpening } from "./layout/placement";
import { roadFlatten, type RoadSpec } from "./layout/roads";
import { seedFromId, type ScatterRule } from "./layout/scatter";
import { TERRAIN_V1 } from "./terrain/presets";
import type { FlattenRegion, MapData, MapSpawn, PointOfInterest, TerrainSurface, Vec2Tuple } from "./types";

/**
 * Map v1 layout: seven points of interest and four minor ones (hamlets, camps) on the v1 terrain, joined by asphalt and
 * dirt roads, with lone buildings, forests, groves, tree lines and field cover in between. See docs/map/layout.md (and
 * the generated docs/map/mapV1.svg).
 *
 * Coordinates: meters, +X east, +Z north. Every POI is authored in its own frame (PoiFrame), so a POI can move or turn
 * as a whole. Buildings snap to their pads; the validation tests in layout/mapV1.test.ts keep the whole thing honest.
 */

const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------------------------------------------
// Points of interest
// ---------------------------------------------------------------------------------------------------------------

export const MAP_V1_POIS: readonly PointOfInterest[] = [
  { id: "town", name: "Central Town", kind: "town", center: [0, 20], radius: 80, lootTier: 2 },
  { id: "farm", name: "Farm", kind: "farm", center: [300, 290], radius: 75, lootTier: 1 },
  { id: "military", name: "Military Compound", kind: "military", center: [320, -270], radius: 70, lootTier: 2 },
  { id: "radar", name: "Radar Hill", kind: "radar", center: [-300, 255], radius: 45, lootTier: 1 },
  { id: "quarry", name: "Quarry", kind: "quarry", center: [-60, -340], radius: 95, lootTier: 1 },
  { id: "forest", name: "Forest Cabins", kind: "forest", center: [-340, -120], radius: 50, lootTier: 0 },
  { id: "training", name: "Training Yard", kind: "training", center: [340, 10], radius: 55, lootTier: 0 },
  // Minor POIs (radius ≤ 40 m): hamlets and camps in the biggest empty stretches, ≥ 150 m from any other POI.
  { id: "millbrook", name: "Millbrook", kind: "town", center: [-150, -50], radius: 38, lootTier: 1 },
  { id: "truckstop", name: "Truck Stop", kind: "town", center: [135, -412], radius: 32, lootTier: 1 },
  { id: "camp", name: "Hunter's Camp", kind: "forest", center: [-290, -380], radius: 30, lootTier: 0 },
  { id: "orchard", name: "Orchard", kind: "farm", center: [350, 445], radius: 32, lootTier: 0 },
];

function poi(id: string): PointOfInterest {
  const found = MAP_V1_POIS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown POI ${id}`);
  return found;
}

/** The blockout arena on a pad as the Training Yard; the gate is cut into its north wall (arena-local). */
export const MAP_V1_TRAINING_YARD = {
  center: poi("training").center,
  padHalfExtent: 44,
  /** The arena ground slab sits this far above the pad. */
  floorClearance: 0.2,
  gateHalfWidth: 4,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Central Town: two crossing streets, a square with a bell tower, twelve houses with fenced back yards.
// ---------------------------------------------------------------------------------------------------------------

const town = new PoiFrame("town", poi("town").center);
town
  // North of the main street, facing it.
  .building("house_nw1", "house_two_story", -27, 13, Math.PI)
  .building("house_nw2", "house_small", -43, 12.5, Math.PI)
  .building("house_ne1", "house_small", 27, 12.5, Math.PI)
  .building("house_ne2", "house_two_story", 43, 13, Math.PI)
  // South of the main street.
  .building("house_sw1", "house_small", -27, -12.5, 0)
  .building("house_sw2", "house_two_story", -43, -13.5, 0)
  .building("house_se1", "house_small_ruined", 27, -12.5, 0)
  .building("house_se2", "house_small", 43, -12.5, 0)
  // Along the north-south street.
  .building("house_n_west", "house_two_story", -13, 33, HALF_PI)
  .building("house_n_east", "house_small", 13, 33, -HALF_PI)
  .building("house_s_west", "house_small_ruined", -13, -34, HALF_PI)
  .building("house_s_east", "house_two_story", 13, -34, -HALF_PI)
  // Outskirts: the cross street and the main street run on past the back yards.
  .building("house_n_west2", "house_small", -13, 56, HALF_PI)
  .building("house_s_east2", "house_small", 13, -56, -HALF_PI)
  .building("house_e_end", "house_small_ruined", 58, -13, 0)
  // Bell tower on the square's north-east corner: the town's silhouette and its best (and most exposed) perch.
  .building("bell_tower", "watchtower", 9, 9.5, Math.PI)
  // Back-yard fences, gaps as garden gates.
  .line("fence_wood", [[-50, 22], [-20, 22], [-20, 40]], { gaps: [[13, 16]] })
  .line("fence_wood", [[50, 22], [20, 22], [20, 42]], { gaps: [[20, 23]] })
  .line("fence_wood", [[-50, -22], [-20, -22], [-20, -42]], { gaps: [[8, 11]] })
  .line("fence_wood", [[50, -22], [20, -22], [20, -42]], { gaps: [[14, 17]] })
  // Square: a burnt-out car and a half-built checkpoint (sandbag walls, cable drums and a pipe stack).
  .prop("car_covered", -8, -7, 0.4)
  .prop("road_barrier", 7, -9, 0.2)
  .prop("road_barrier", -9, 7, 1.4)
  .prop("sandbag_barrier", 10, 4.5, 0)
  .prop("sandbag_barrier", 10.5, -13, 0)
  .prop("sandbag_barrier", -10.5, -13.5, 0.1)
  .prop("sandbag_barrier", -13, 7, HALF_PI)
  .prop("cable_spool", 12.5, -7)
  .prop("cable_spool", -6, 12.5)
  .prop("pipe_stack", -10, 12.5, 0)
  // Street clutter: wrecks on the street edges, clear of the carriageway.
  .prop("car_covered", -60, 6, 0.1)
  .prop("car_covered", 34, -5.2, Math.PI + 0.15)
  .prop("car_covered", 5.5, 44, HALF_PI - 0.2)
  .prop("car_wreck", -66, -6, HALF_PI + 0.3)
  .prop("car_wreck", 64, 6, HALF_PI - 0.25)
  .prop("car_wreck", -5.5, 67, 0.25)
  .prop("car_wreck", 6, -54, -0.3)
  .prop("car_wreck", -35.5, -5.3, HALF_PI + 0.12)
  .prop("log_fallen", -35, 30, 0.3)
  .prop("hay_bale_stack", 36, 30, 0.5)
  // Big oaks in two back gardens and off the square's south-west corner.
  .prop("tree_oak_large", -44, 33, 0.7)
  .prop("tree_oak_large", 42, -33, 2.3, 1.05)
  .prop("tree_oak_large", -17, -17, 4.1, 0.95);

// ---------------------------------------------------------------------------------------------------------------
// Farm: barn, farmhouse, cottage and sheds inside a paddock fence; a plowed field and a hay meadow.
// ---------------------------------------------------------------------------------------------------------------

const farm = new PoiFrame("farm", poi("farm").center, 0.25);
farm
  .building("barn", "barn", 0, 2, 0)
  .building("farmhouse", "house_two_story", -24, -15, HALF_PI)
  .building("cottage", "house_small", -24, 13, HALF_PI)
  .building("shed_red", "container_open", 16, -8, 0)
  .building("shed_blue", "container_open_blue", 21, -8, 0)
  // Outside the paddock: a farmhands' cottage west of the farmhouse and two grain sheds by the south track.
  .building("bunkhouse", "house_small", -54, -22, HALF_PI)
  .building("grain_red", "container_open", 24, -47, 0)
  .building("grain_blue", "container_open_blue", 27.8, -47, 0)
  // Paddock fence, walked from the south-west corner: gates south (track to the Training Yard), east (hay meadow) and
  // west (farm road).
  .line("fence_wood", rectLoop(0, 0, 36, 32), { gaps: [[40, 52], [96, 108], [210, 222]] })
  .prop("log_fallen", -34, 0, HALF_PI)
  .prop("car_covered", 24, 6, 1.2)
  .prop("car_wreck", -10.5, -2, 0.12)
  // Big oaks: one in the paddock, the rest round the yard and the field edges.
  .prop("tree_oak_large", 22, -22, 1.1)
  .prop("tree_oak_large", -48, -10, 2.9, 1.1)
  .prop("tree_oak_large", 52, 48, 0.4, 0.95)
  .prop("tree_oak_large", -36, 48, 5.2)
  .prop("tree_oak_large", 40, -44, 3.6, 1.05);
// Yard: small square bales stacked in groups of two or three.
const HAY_GROUPS: readonly [x: number, z: number, count: number, yaw: number][] = [[11, 18, 3, 0.1], [-10, -24, 2, 0.4], [26, 20, 3, -0.2], [-12, 24, 2, 1.2]];
for (const [x, z, count, yaw] of HAY_GROUPS) {
  const along = [Math.cos(yaw), -Math.sin(yaw)] as const;
  const back = [Math.sin(yaw), Math.cos(yaw)] as const;
  farm.prop("hay_bale_stack", x - along[0] * 0.5, z - along[1] * 0.5, yaw).prop("hay_bale_stack", x + along[0] * 0.5, z + along[1] * 0.5, yaw);
  if (count > 2) farm.prop("hay_bale_stack", x + back[0] * 1.6, z + back[1] * 1.6, yaw + 0.2);
}
// Hay meadow east of the yard: broken rows of bale walls, the rows 16 m apart, facing east-west crossings.
const MEADOW_WALLS: readonly Vec2Tuple[] = [[56, -22], [56, -6], [56, 10], [72, -14], [72, 2], [88, -22], [88, -6], [88, 10]];
MEADOW_WALLS.forEach(([x, z], i) => farm.prop("hay_bale_wall", x, z, -HALF_PI + ((i * 7) % 5 - 2) * 0.06));
// North field edge fence.
farm.line("fence_wood", [[-30, 40], [44, 40], [44, 84]], { gaps: [[30, 36]] });

// ---------------------------------------------------------------------------------------------------------------
// Military Compound: walled on the south and east, chain-link on the north and west with a gate; two barracks, two
// watchtowers, a container yard.
// ---------------------------------------------------------------------------------------------------------------

const military = new PoiFrame("military", poi("military").center, 0.3);
military
  .building("barracks_west", "barracks", -12, 24, Math.PI)
  .building("barracks_east", "barracks", 18, 24, Math.PI)
  .building("tower_sw", "watchtower", -43, -31, HALF_PI)
  .building("tower_ne", "watchtower", 43, 31, -HALF_PI)
  .building("gate_booth", "guard_booth", -43, 2.5, -HALF_PI)
  .building("container_1", "container_closed", 14, -26, HALF_PI)
  .building("container_1_top", "container_closed", 14, -26, HALF_PI, "container_1")
  .building("container_2", "container_open_blue", 14, -18.5, HALF_PI)
  .building("container_3", "container_open", 27, -26, -HALF_PI)
  .building("container_4", "container_closed", 27, -18.5, HALF_PI)
  .building("container_5", "container_open", 39, -14, 0)
  .building("container_6", "container_closed", -8, -24, 0.1)
  // Perimeter: the gate on the west side faces the road from town; a breach in the south wall faces the quarry.
  .line("wall_concrete", [[-50, -38], [50, -38], [50, 38]], { gaps: [[64, 70]] })
  .line("fence_chainlink", [[50, 38], [-50, 38], [-50, -38]], { segment: 2, gaps: [[124, 134]] })
  // Sandbag walls: inside the gate, at the tower bases, the container-yard lanes, the courtyard and the south breach.
  .prop("sandbag_barrier", -38, 13, HALF_PI)
  .prop("sandbag_barrier", -40, -24, 0)
  .prop("sandbag_barrier", -35, -30, HALF_PI)
  .prop("sandbag_barrier", 36, 24, 0)
  .prop("sandbag_barrier", 37, 31, HALF_PI)
  .prop("sandbag_barrier", 20.5, -12, 0)
  .prop("sandbag_barrier", 24, -31.5, 0)
  .prop("sandbag_barrier", 8, -31.5, 0)
  .prop("sandbag_barrier", -20, 5, 0.4)
  .prop("sandbag_barrier", 5, 8, -0.2)
  .prop("sandbag_barrier", 30, 5, 0.2)
  .prop("sandbag_barrier", -25, -30, 0)
  .prop("cable_spool", 4.5, -10.5)
  .prop("cable_spool", 36, -3)
  .prop("cable_spool", -30, 14)
  .prop("cable_spool", 44, -31)
  .prop("pipe_stack", -10, -34.5, 0)
  .prop("pipe_stack", 46.5, 10, HALF_PI)
  .prop("road_barrier", -58, 14, HALF_PI)
  .prop("road_barrier", -58, 4, HALF_PI)
  .prop("road_barrier", 0, 0, 0.1)
  .prop("road_barrier", 6, -4, 1.2)
  .prop("car_covered", -22, -6, 0.6)
  .prop("crate_military_long", 8, -12, 0.2)
  .prop("crate_military", 9, -9.5, 1.4)
  .prop("barrel_rusty", 33, -9, 0)
  .prop("barrel_rusty", 34, -8, 0)
  .prop("utility_box", -46, -4, HALF_PI);

// ---------------------------------------------------------------------------------------------------------------
// Radar Hill: radar station and a watchtower on the ridge crest, reached by a switchback road up the south-east flank.
// ---------------------------------------------------------------------------------------------------------------

// Frame X runs along the crest (north-east), +Z faces north-west, -Z down the flank toward town.
const radar = new PoiFrame("radar", poi("radar").center, -0.7);
radar
  .building("station", "radar_station", -6, 1, 0)
  .building("tower", "watchtower", 13, 2, 0)
  // Sandbag walls along the pad edge above the switchbacks.
  .prop("sandbag_barrier", 4, -7.5, 0)
  .prop("sandbag_barrier", 22, -6, 0.3)
  .prop("sandbag_barrier", -10, -7.5, 0)
  .prop("sandbag_barrier", 15, -7, 0.2)
  .prop("road_barrier", -18, -8, 0)
  .prop("car_covered", 24, 10, 1.8);
// Boulders on the crest approaches; fungus oaks on the lee slope below the pad.
for (const [x, z, yaw, scale] of [[-30, -2, 0.3, 1.2], [-38, 7, 1.9, 1], [-48, -4, 4.2, 1.35], [-57, 5, 2.6, 1.1], [32, 1, 5.1, 1.25], [40, -6, 0.8, 1], [48, 5, 3.3, 1.4], [58, -2, 1.5, 1.15]] as const) {
  radar.prop("rock_boulder_large", x, z, yaw, scale);
}
for (const [x, z, yaw] of [[35, -18, 0.4], [48, -11, 2.2], [-45, -13, 4.4], [-58, -6, 1.3]] as const) radar.prop("tree_oak_fungi", x, z, yaw);

// ---------------------------------------------------------------------------------------------------------------
// Quarry: a warehouse and containers on the pit floor, rock piles, the original north ramp and a second ramp east.
// ---------------------------------------------------------------------------------------------------------------

const quarry = new PoiFrame("quarry", poi("quarry").center);
quarry
  .building("warehouse", "warehouse", -12, -6, 0)
  .building("container_1", "container_open", 22, 18, 0.2)
  .building("container_2", "container_closed", 27, 16, 0.2)
  .building("container_3", "container_open_blue", 28, -22, -0.4)
  .building("container_4", "container_closed", 33, -18, -0.4)
  .building("container_4_top", "container_closed", 33, -18, -0.4, "container_4")
  .building("office", "house_small_ruined", -18, 26, 0.1)
  .prop("rock_pile", 8, 34, 0.3)
  .prop("rock_pile", 38, 2, 1.2, 1.2)
  .prop("rock_pile", -40, 20, 2.1)
  .prop("rock_pile", -36, -30, 0.8, 1.3)
  .prop("rock_pile", 5, -36, 2.6)
  .prop("log_fallen", 14, 4, 1.1)
  .prop("car_covered", 20, -4, 2.2)
  .prop("barrel_rusty", 1, 3, 0)
  .prop("crate_military", -1, 5, 0.5)
  .prop("tree_stump", -30, -40, 0)
  // Warehouse yard: concrete pipes and cable drums.
  .prop("pipe_stack", -30, -8, HALF_PI)
  .prop("pipe_stack", -18, 7, 0)
  .prop("pipe_stack", -14, -20, 0)
  .prop("cable_spool", 4, 9)
  .prop("cable_spool", -27, 4)
  .prop("cable_spool", 4, -16)
  .prop("cable_spool", -21, -19)
  // Wrecks at the feet of both ramps.
  .prop("car_wreck", -8, 38, -0.3)
  .prop("car_wreck", 38, -12, 1.3);
// Big boulders on the pit floor and beside the ramps.
for (const [x, z, yaw, scale] of [[-35, 8, 0.4, 1.2], [-28, -26, 2.1, 1], [14, 30, 1.2, 1.3], [28, 2, 3.9, 1.1], [-2, -32, 5.5, 1.25], [-38, -14, 0.9, 0.9], [9, 58, 2.7, 1], [-9, 76, 4.6, 1.2], [58, -8, 1.8, 1.1], [80, -28, 3.1, 1]] as const) {
  quarry.prop("rock_boulder_large", x, z, yaw, scale);
}

// ---------------------------------------------------------------------------------------------------------------
// Forest Cabins: four cabins in a clearing-less pine forest, on small pads, round a dirt loop.
// ---------------------------------------------------------------------------------------------------------------

const forest = new PoiFrame("forest", poi("forest").center);
/** Cabins ring a small clearing, facing it; the gaps at 60° and -100° are the road in and the track south. */
const CABIN_RING = 21;
const CABINS = [
  { id: "cabin_nw", prefab: "house_small", angle: 150 },
  { id: "cabin_e", prefab: "house_small", angle: 8 },
  { id: "cabin_se", prefab: "house_small_ruined", angle: -48 },
  { id: "cabin_sw", prefab: "house_small", angle: -152 },
] as const;
const cabinSpots = CABINS.map((cabin) => {
  const a = (cabin.angle * Math.PI) / 180;
  const x = round3(Math.cos(a) * CABIN_RING);
  const z = round3(Math.sin(a) * CABIN_RING);
  return { ...cabin, x, z, yaw: round3(Math.atan2(-x, -z)) };
});
for (const cabin of cabinSpots) forest.building(cabin.id, cabin.prefab, cabin.x, cabin.z, cabin.yaw);
forest.prop("log_fallen", -6, 4, 0.2).prop("car_covered", 5, -5, 1.9).prop("hay_bale_stack", -30, 20, 0).prop("log_fallen", 30, -26, 1.1);
const ring = (radius: number, degrees: number): Vec2Tuple => [round3(Math.cos((degrees * Math.PI) / 180) * radius), round3(Math.sin((degrees * Math.PI) / 180) * radius)];
// Fungus oaks ring the clearing edge (the road in at ~55° and the track south at ~-100° stay open).
[95, 125, 160, 190, 220, 235, -60, -30, 0, 28].forEach((degrees, i) => forest.prop("tree_oak_fungi", ...ring(33 + ((i * 5) % 7) - 3, degrees), i * 0.9));
// Stumps and mossy logs between the cabins, 8–12 m out from them.
[[16, 100], [30, 76], [15, -20], [31, -12], [16, 178], [30, -140]].forEach(([radius, degrees], i) => forest.prop("stump_boubin", ...ring(radius!, degrees!), i * 1.3));
[[12, 120], [27, 108], [13, -8], [27, -75], [13, -178], [32, 140]].forEach(([radius, degrees], i) => forest.prop("log_mossy", ...ring(radius!, degrees!), ((degrees! + 90) * Math.PI) / 180 + i * 0.2));

// ---------------------------------------------------------------------------------------------------------------
// Millbrook: a hamlet of five houses and a barn along a dirt lane that runs south from the west road to the quarry road.
// ---------------------------------------------------------------------------------------------------------------

const millbrook = new PoiFrame("millbrook", poi("millbrook").center);
millbrook
  // West of the lane, facing it.
  .building("house_w1", "house_small", -12, 30, HALF_PI)
  .building("house_w2", "house_two_story", -13, 8, HALF_PI)
  .building("house_w3", "house_small_ruined", -12, -14, HALF_PI)
  // East of the lane: two cottages and the barn, its big doors toward the lane.
  .building("house_e1", "house_small", 12, 26, -HALF_PI)
  .building("house_e2", "house_small", 12, 6, -HALF_PI)
  .building("barn", "barn", 21, -24, -HALF_PI)
  .building("shed", "container_open", -27, 24, 0)
  // Garden fences behind both rows, gates at the back.
  .line("fence_wood", [[-20, 41], [-36, 41], [-36, -24], [-20, -24]], { gaps: [[44, 49]] })
  .line("fence_wood", [[20, 38], [30, 38], [30, -4]], { gaps: [[22, 27]] })
  .prop("car_wreck", 6.5, -42, 0.2)
  .prop("car_covered", -6.5, 44, 3.3)
  .prop("hay_bale_stack", 35, -18, 0.2)
  .prop("hay_bale_stack", 35, -16.8, 0.2)
  .prop("hay_bale_stack", 36.4, -17.4, 0.4)
  .prop("log_fallen", -27, -8, 1.4)
  .prop("tree_oak_large", -28, -38, 1.2)
  .prop("tree_oak_large", 26, 50, 0.4, 0.95);

// ---------------------------------------------------------------------------------------------------------------
// Truck Stop: a roadside shop, kiosk, workshop ruin and container yard on the dirt road between the quarry and the
// compound. Frame X runs along the road, which passes ~21 m to the frame's +Z.
// ---------------------------------------------------------------------------------------------------------------

const truckstop = new PoiFrame("truckstop", poi("truckstop").center, 0.23);
truckstop
  .building("shop", "house_small", -16, 2, 0)
  .building("kiosk", "guard_booth", 0, 8, 0)
  .building("workshop", "house_small_ruined", -2, -12, 0)
  .building("container_1", "container_open", 16, 0, 0)
  .building("container_2", "container_open_blue", 19.8, 0, 0)
  .building("container_3", "container_closed", 23.6, 0, 0)
  .building("container_3_top", "container_closed", 23.6, 0, 0, "container_3")
  // Forecourt: wrecks, barrels and a barrier; pipes and drums behind the workshop.
  .prop("car_wreck", -6, 15, HALF_PI + 0.25)
  .prop("car_covered", -31, -4, 0.3)
  .prop("barrel_rusty", 8, 3.5, 0)
  .prop("barrel_rusty", 8.8, 4.3, 0)
  .prop("barrel_rusty", 29, 4, 0)
  .prop("utility_box", -9, 6.5, 0)
  .prop("road_barrier", 12, 14, 0.1)
  .prop("pipe_stack", 2, -25, 0.1)
  .prop("cable_spool", 30, -8)
  .prop("cable_spool", -14, -20);

// ---------------------------------------------------------------------------------------------------------------
// Hunter's Camp: two cabins, a hunting tower and a store container round a clearing in the southern woods.
// ---------------------------------------------------------------------------------------------------------------

const camp = new PoiFrame("camp", poi("camp").center);
camp
  .building("cabin", "house_small", -15, 2, HALF_PI)
  .building("cabin_ruin", "house_small_ruined", 14, -6, -HALF_PI)
  .building("tower", "watchtower", 6, -22, 0)
  .building("store", "container_open", -8, -18, 0.4)
  .prop("log_fallen", -3, 8, 0.1)
  .prop("stump_boubin", 20, 12, 0.6)
  .prop("log_mossy", -25, -14, 1.1)
  .prop("crate_military", -13, -12.5, 0.4)
  .prop("barrel_rusty", 19, 2, 0);
for (const [x, z, yaw] of [[27, 18, 0.3], [-29, 15, 2.1], [-25, -32, 4.0], [26, -30, 1.2], [-14, 33, 5.1]] as const) camp.prop("tree_oak_fungi", x, z, yaw);

// ---------------------------------------------------------------------------------------------------------------
// Orchard: a farmhouse, cottage, cider-house ruin and two sheds north of the farm, with fruit-tree rows east and south.
// ---------------------------------------------------------------------------------------------------------------

const orchard = new PoiFrame("orchard", poi("orchard").center);
orchard
  .building("farmhouse", "house_two_story", -16, 4, HALF_PI)
  .building("cottage", "house_small", 8, 16, Math.PI)
  .building("shed_1", "container_open", 16, -8, -HALF_PI)
  .building("shed_2", "container_open_blue", 16, -12, -HALF_PI)
  .building("cider_ruin", "house_small_ruined", -2, -22, 0)
  // Yard fence, west and south: the track gate on the west side, a garden gate south.
  .line("fence_wood", [[-30, 24], [-30, -32], [8, -32]], { gaps: [[31, 45], [70, 76]] })
  .prop("hay_bale_stack", 22, 2, 0.3)
  .prop("hay_bale_stack", 22.6, 3.1, 0.3)
  .prop("car_wreck", 0, 2, 1.2)
  .prop("tree_oak_large", -40, 30, 2.2);

// ---------------------------------------------------------------------------------------------------------------
// Countryside: field fences, hay and wrecks between POIs, so open crossings have something to run to.
// ---------------------------------------------------------------------------------------------------------------

const countryside = new PoiFrame("countryside", [0, 0]);
countryside
  .line("fence_wood", [[60, 118], [150, 122], [156, 190]], { gaps: [[40, 48], [110, 118]] })
  .line("fence_wood", [[-125, 150], [-60, 205], [-10, 214]], { gaps: [[52, 62]] })
  .line("fence_wood", [[118, -30], [205, -12], [236, -88]], { gaps: [[30, 38], [120, 130]] })
  .line("fence_wood", [[-205, -118], [-150, -190], [-110, -196]], { gaps: [[44, 52]] })
  .line("fence_wood", [[230, 380], [320, 400], [410, 390]], { gaps: [[70, 80]] })
  .prop("hay_bale_wall", 64, 152, 0.3)
  .prop("hay_bale_wall", 88, 164, 1.1)
  .prop("hay_bale_wall", 112, 150, 2.3)
  .prop("hay_bale_wall", 96, 136, 0.6)
  .prop("car_covered", 150, 36.5, 2.8)
  .prop("car_covered", 96, -155, 0.9)
  .prop("car_covered", -112, 21, 0.4)
  .prop("car_covered", 196, -397, 3.3)
  .prop("car_covered", -258, -236, 2.1)
  // Abandoned roadblock on the south highway.
  .prop("road_barrier", 166, -202, 0.45)
  .prop("road_barrier", 176, -222, 0.45)
  .prop("log_fallen", -120, 260, 0.7)
  .prop("log_fallen", 40, 330, 2.0);

// ---------------------------------------------------------------------------------------------------------------
// Pads (applied before roads)
// ---------------------------------------------------------------------------------------------------------------

const yard = MAP_V1_TRAINING_YARD;

const PADS: FlattenRegion[] = [
  { shape: "circle", center: town.center, radius: 66, falloff: 50, height: "auto" },
  // The square: paved, on the same level as the town pad.
  { shape: "rect", center: town.center, halfExtents: [15, 15], falloff: 1, height: "auto", surface: "road", surfaceFalloff: 1 },
  { shape: "circle", center: farm.at(-4, 0), radius: 42, falloff: 40, height: "auto" },
  { shape: "rect", center: farm.at(8, 62), halfExtents: [36, 18], yaw: farm.yaw, falloff: 18, height: "auto", surface: "dirt", surfaceFalloff: 3 },
  { shape: "rect", center: military.center, halfExtents: [54, 42], yaw: military.yaw, falloff: 28, height: "auto", surface: "dirt", surfaceFalloff: 4 },
  { shape: "rect", center: radar.at(3, 1), halfExtents: [24, 12], yaw: radar.yaw, falloff: 16, height: "auto", surface: "dirt", surfaceFalloff: 3 },
  { shape: "circle", center: quarry.center, radius: 44, falloff: 2, height: "auto", surface: "dirt", surfaceFalloff: 2 },
  { shape: "circle", center: forest.center, radius: 11, falloff: 8, height: "auto", surface: "dirt", surfaceFalloff: 3 },
  ...cabinSpots.map((cabin): FlattenRegion => ({ shape: "rect", center: forest.at(cabin.x, cabin.z), halfExtents: [7.5, 7], yaw: cabin.yaw, falloff: 7, height: "auto", surface: "dirt", surfaceFalloff: 2 })),
  {
    shape: "rect",
    center: yard.center,
    halfExtents: [yard.padHalfExtent, yard.padHalfExtent],
    falloff: 28,
    height: "auto",
    heightOffset: -yard.floorClearance,
    surface: "dirt",
    surfaceFalloff: 3,
  },
  // Minor POIs: one pad per settlement (Millbrook stays grass; the truck stop forecourt and the camp clearing are dirt).
  { shape: "rect", center: millbrook.at(0, 2), halfExtents: [40, 48], falloff: 25, height: "auto" },
  { shape: "rect", center: truckstop.at(4, -3), halfExtents: [38, 22], yaw: truckstop.yaw, falloff: 14, height: "auto", surface: "dirt", surfaceFalloff: 3 },
  { shape: "circle", center: camp.at(0, -2), radius: 16, falloff: 10, height: "auto", surface: "dirt", surfaceFalloff: 3 },
  { shape: "rect", center: orchard.at(-4, -3), halfExtents: [29, 32], falloff: 18, height: "auto" },
];

/** A rect pad under a whole building (roof and eaves included) plus `margin`, for buildings off the big POI pads. */
function buildingPad(building: LayoutBuilding, margin = 1.5, falloff = 8, surface?: TerrainSurface): FlattenRegion {
  const { min, max } = getBuildingPrefab(building.prefab as BuildingPrefabId).bounds;
  const [cx, cz] = offsetPoint([building.position[0], building.position[2]], building.yaw, (min[0] + max[0]) / 2, (min[2] + max[2]) / 2);
  return {
    shape: "rect",
    center: [round3(cx), round3(cz)],
    halfExtents: [round3((max[0] - min[0]) / 2 + margin), round3((max[2] - min[2]) / 2 + margin)],
    yaw: building.yaw,
    falloff,
    height: "auto",
    ...(surface ? { surface, surfaceFalloff: 2 } : {}),
  };
}

/** Buildings added after the first layout pass that sit off (or at the edge of) their POI pads. */
const PADDED_BUILDINGS = new Set(["town_house_n_west2", "town_house_s_east2", "town_house_e_end", "farm_bunkhouse", "farm_grain_red", "farm_grain_blue"]);
const POI_BUILDING_PADS: FlattenRegion[] = [
  ...[town, farm, millbrook, orchard].flatMap((frame) => frame.buildings.filter((b) => frame === millbrook || frame === orchard || PADDED_BUILDINGS.has(b.id)).map((b) => buildingPad(b))),
  ...[truckstop, camp].flatMap((frame) => frame.buildings.filter((b) => !b.stackOn).map((b) => buildingPad(b, 1.5, 7, "dirt"))),
];

// ---------------------------------------------------------------------------------------------------------------
// Roads: an asphalt spine (Training Yard → town → military), dirt spokes to the other POIs and a dirt ring road.
// ---------------------------------------------------------------------------------------------------------------

const yardGate: Vec2Tuple = [yard.center[0], yard.center[1] + 36];

export const MAP_V1_ROADS: readonly RoadSpec[] = [
  // Asphalt.
  { id: "town_main", kind: "asphalt", straight: true, points: [town.at(-80, 0), town.at(80, 0)] },
  { id: "town_cross", kind: "asphalt", straight: true, points: [town.at(0, -72), town.at(0, 76)] },
  { id: "highway_east", kind: "asphalt", points: [town.at(80, 0), [140, 26], [215, 52], [290, 78], [334, 76], [yardGate[0], yardGate[1] + 22], [yardGate[0], yardGate[1] + 12]] },
  { id: "highway_south", kind: "asphalt", points: [town.at(0, -72), [18, -115], [80, -168], [170, -212], [235, -236], military.at(-62, 9)] },
  // Dirt spokes.
  { id: "farm_road", kind: "dirt", points: [town.at(0, 76), [36, 140], [110, 205], [190, 250], farm.at(-58, 22), farm.at(-30, 26)] },
  { id: "west_road", kind: "dirt", points: [town.at(-80, 0), [-130, 12], [-175, 2], [-235, -45], forest.at(40, 52), forest.at(16, 22), forest.at(6, 8)] },
  { id: "radar_approach", kind: "dirt", points: [[-175, 2], [-208, 80], [-222, 150], [-216, 212]] },
  // Switchbacks up the south-east flank at about 8°: traced along the contours, then hairpins rounded by hand.
  {
    id: "radar_switchbacks",
    kind: "dirt",
    straight: true,
    points: [[-216, 212], [-210, 219], [-213, 225], [-223, 225], [-235, 223], [-247, 221], [-258, 218], [-269, 214], [-280, 208], [-289, 198], [-297, 184], [-305, 180], [-310, 187], [-310, 197], [-307, 210], [-303, 223], [-297, 233], [-293, 244], [-284, 252]],
  },
  { id: "quarry_road", kind: "dirt", points: [[18, -115], [-20, -150], [-50, -185], [-60, -205]] },
  // Dirt ring between neighbouring POIs.
  { id: "forest_quarry", kind: "dirt", points: [forest.at(-2, -8), forest.at(-6, -26), forest.at(10, -70), [-265, -225], [-200, -248], [-130, -228], [-66, -210]] },
  { id: "quarry_military", kind: "dirt", points: [[64, -372], [150, -392], [235, -368], military.at(-10, -62), military.at(17, -44)] },
  { id: "farm_yard", kind: "dirt", points: [farm.at(10, -26), farm.at(10, -44), [338, 190], [356, 128], [348, 92], [334, 76]] },
  // Minor POIs: Millbrook's lane runs on south to the quarry road; tracks to the camp and the orchard.
  { id: "millbrook_road", kind: "dirt", points: [[-150, 6], millbrook.at(0, 30), millbrook.at(0, -30), [-154, -150], [-166, -236]] },
  { id: "camp_track", kind: "dirt", points: [[-252, -232], [-262, -280], [-280, -330], camp.at(2, 18)] },
  { id: "orchard_track", kind: "dirt", points: [farm.at(-58, 22), [226, 360], [218, 392], [240, 420], [300, 428], orchard.at(-2, -8)] },
];

/**
 * A spot on a road shoulder: the centerline point nearest `near`, moved along the road by `along` and `side` m to the left
 * of travel (negative: right). `yaw` turns local X along the road.
 */
function shoulder(road: RoadSpec, near: Vec2Tuple, side: number, along = 0): { at: Vec2Tuple; yaw: number } {
  const points = road.straight ? road.points : catmullRom(road.points, 8);
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = segmentDistance(near[0], near[1], points[i]![0], points[i]![1], points[i + 1]![0], points[i + 1]![1]);
    if (d < bestDistance) [best, bestDistance] = [i, d];
  }
  const [ax, az] = points[best]!;
  const [bx, bz] = points[best + 1]!;
  const length = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
  const dx = (bx - ax) / length;
  const dz = (bz - az) / length;
  const t = Math.max(0, Math.min(length, (near[0] - ax) * dx + (near[1] - az) * dz)) + along;
  return { at: [round3(ax + dx * t - dz * side), round3(az + dz * t + dx * side)], yaw: round3(Math.atan2(-dz, dx)) };
}

const road = (id: string): RoadSpec => MAP_V1_ROADS.find((r) => r.id === id)!;
/** Wrecks on the highway and dirt-road shoulders, 80 m or more apart; cars sit along the road (their length is local Z). */
const SHOULDER_WRECKS: readonly [road: string, near: Vec2Tuple, side: number, skew: number][] = [
  ["highway_east", [200, 47], -7, 0.2],
  ["highway_east", [285, 78], 7, -0.25],
  ["highway_south", [55, -148], 7, 0.15],
  ["farm_road", [80, 178], -6, -0.3],
  ["farm_road", [165, 237], 6, 0.2],
  ["west_road", [-205, -22], -6, 0.25],
];
for (const [id, near, side, skew] of SHOULDER_WRECKS) {
  const { at, yaw } = shoulder(road(id), near, side);
  countryside.prop("car_wreck", at[0], at[1], yaw + HALF_PI + skew);
}
// South-highway roadblock: sandbag walls on both shoulders and two wrecks angled off the lanes.
{
  const south = road("highway_south");
  for (const [side, along] of [[7, -6], [7, 2], [-7, -2], [-7, 6]] as const) {
    const { at, yaw } = shoulder(south, [171, -212], side, along);
    countryside.prop("sandbag_barrier", at[0], at[1], yaw);
  }
  for (const [side, along, skew] of [[8, -16, 0.5], [-8.5, 15, -0.45]] as const) {
    const { at, yaw } = shoulder(south, [171, -212], side, along);
    countryside.prop("car_wreck", at[0], at[1], yaw + HALF_PI + skew);
  }
}

// Lone buildings along the roads and in the fields: sheds, cottages and ruins between the POIs (outskirts loot).
/** Faces the road: the building's center is `offset` m left of travel (negative: right) of the road point nearest `near`. */
function roadsideBuilding(id: string, prefab: BuildingPrefabId, roadId: string, near: Vec2Tuple, offset: number, along = 0): void {
  const { at, yaw } = shoulder(road(roadId), near, offset, along);
  countryside.building(id, prefab, at[0], at[1], round3(offset > 0 ? yaw + Math.PI : yaw));
}
roadsideBuilding("ruin_west_road", "house_small_ruined", "west_road", [-108, 16], -15);
roadsideBuilding("house_farm_road", "house_small", "farm_road", [58, 158], 15);
roadsideBuilding("shed_farm_road_1", "container_open", "farm_road", [150, 236], 10);
roadsideBuilding("shed_farm_road_2", "container_closed", "farm_road", [150, 236], 10, 3.8);
roadsideBuilding("house_highway_east", "house_small", "highway_east", [178, 40], 16);
roadsideBuilding("ruin_highway_south", "house_small_ruined", "highway_south", [100, -180], -16);
roadsideBuilding("house_quarry_road", "house_small", "quarry_road", [-8, -140], 15);
roadsideBuilding("shed_forest_quarry_1", "container_open_blue", "forest_quarry", [-105, -221], 10);
roadsideBuilding("shed_forest_quarry_2", "container_closed", "forest_quarry", [-105, -221], 10, 3.8);
roadsideBuilding("ruin_quarry_military", "house_small_ruined", "quarry_military", [210, -376], 16);
roadsideBuilding("house_farm_yard", "house_small", "farm_yard", [352, 112], 15);
countryside.building("ruin_north_field", "house_small_ruined", -60, 300, 0.6).building("ruin_east_field", "house_small_ruined", 440, 250, -1.2);

const OUTLYING_PADS: FlattenRegion[] = [...POI_BUILDING_PADS, ...countryside.buildings.map((b) => buildingPad(b, 2, 8))];

const RAMPS: FlattenRegion[] = [
  // North ramp (from the draft), rim to floor at ~16°.
  { shape: "polyline", points: [[-60, -205], [-60, -298]], width: 7, falloff: 6, height: "auto", profile: "linear", surface: "dirt", surfaceFalloff: 2 },
  // East ramp: a second way out, so the pit isn't a trap.
  { shape: "polyline", points: [[64, -372], [-16, -350]], width: 6, falloff: 5, height: "auto", profile: "linear", surface: "dirt", surfaceFalloff: 2 },
];

// ---------------------------------------------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------------------------------------------

const PLAYABLE_INSET = 490;
const PLAYABLE: Vec2Tuple[] = [
  [-PLAYABLE_INSET, -PLAYABLE_INSET],
  [PLAYABLE_INSET, -PLAYABLE_INSET],
  [PLAYABLE_INSET, PLAYABLE_INSET],
  [-PLAYABLE_INSET, PLAYABLE_INSET],
];

function circle(center: Vec2Tuple, radius: number, sides = 20): Vec2Tuple[] {
  return Array.from({ length: sides }, (_, i): Vec2Tuple => {
    const a = (i / sides) * Math.PI * 2;
    return [round3(center[0] + Math.cos(a) * radius), round3(center[1] + Math.sin(a) * radius)];
  });
}

/** POI cores kept free of field cover. */
const POI_CORES = MAP_V1_POIS.map((p) => circle(p.center, p.radius + 10));
/** Fence gates and wall breaches, widened by 3 m: every non-detail rule leaves them empty. */
const OPENING_ZONES = [town, farm, military, radar, quarry, forest, millbrook, truckstop, camp, orchard, countryside].flatMap((frame) => frame.openings).map((o) => circle(o.center, o.width / 2 + 3, 12));

const TREES = [
  { prop: "tree_fir_b", weight: 5 },
  { prop: "tree_fir_a", weight: 3 },
  { prop: "tree_broadleaf_a", weight: 1 },
  { prop: "tree_fir_young", weight: 0.4 },
];
const DECIDUOUS = [
  { prop: "tree_broadleaf_a", weight: 3 },
  { prop: "tree_broadleaf_b", weight: 2 },
  { prop: "tree_fir_b", weight: 1 },
];
const UNDERGROWTH = [
  { prop: "fern", weight: 4 },
  { prop: "bush_a", weight: 2 }, { prop: "bush_b", weight: 1 },
  { prop: "bush_c", weight: 1 },
  { prop: "rock_small", weight: 1 },
];

const WEST_FOREST: Vec2Tuple[] = [[-495, -330], [-300, -300], [-235, -265], [-205, -150], [-250, -40], [-330, 30], [-420, 70], [-495, 80]];
const RIDGE_WOODS: Vec2Tuple[] = [[-495, 110], [-400, 120], [-360, 250], [-330, 330], [-240, 380], [-160, 470], [-495, 495]];
const EAST_WOODS: Vec2Tuple[] = [[395, -110], [495, -100], [495, -495], [240, -495], [300, -420], [400, -360]];
const NORTH_GROVES: Vec2Tuple[] = [[-150, 180], [220, 160], [230, 400], [150, 495], [-120, 495], [-160, 360]];
const SOUTH_GROVES: Vec2Tuple[] = [[60, -290], [220, -150], [330, -130], [250, -30], [80, -80], [-160, -150], [-200, -210]];
const EAST_GROVES: Vec2Tuple[] = [[90, -60], [260, -100], [460, -60], [460, 200], [250, 190], [100, 110]];
const VALLEY: Vec2Tuple[] = [[90, 480], [150, 320], [120, 140], [200, -60], [160, -220], [210, -495]];
/** Conifer woods south of the western forest round Hunter's Camp and along the south edge. */
const SOUTH_WOODS: Vec2Tuple[] = [[-495, -345], [-300, -315], [-240, -290], [-195, -310], [-170, -400], [-110, -445], [0, -455], [80, -470], [110, -495], [-495, -495]];
/** Meadow groves between the western forest, Radar Hill and town (Millbrook); the woods themselves are excluded. */
const WEST_GROVES: Vec2Tuple[] = [[-495, 70], [-495, 118], [-400, 128], [-360, 240], [-200, 220], [-100, 195], [-85, -110], [-110, -300], [-235, -285]];
/** Groves in the empty north-east corner (Orchard), the east fields past the farm, and between the quarry and compound (Truck Stop). */
const NE_GROVES: Vec2Tuple[] = [[160, 340], [495, 330], [495, 495], [140, 495]];
const EAST_FIELDS: Vec2Tuple[] = [[370, 110], [495, 110], [495, 330], [390, 340]];
const SOUTH_EAST_GROVES: Vec2Tuple[] = [[-10, -295], [200, -300], [235, -475], [20, -480]];
/** Big-oak meadows stay open: solitary oaks only outside every wood and grove outline above. */
const WOODS = [WEST_FOREST, RIDGE_WOODS, EAST_WOODS, SOUTH_WOODS];

/** Orchard rows east and south of the yard, 8 m apart (jittered by the terrain tests only). */
const ORCHARD_SPOTS: readonly Vec2Tuple[] = Array.from({ length: 6 }, (_, i) => Array.from({ length: 8 }, (_, j) => orchard.at(34 + i * 8, -30 + j * 8)))
  .flat()
  .concat(Array.from({ length: 5 }, (_, i) => Array.from({ length: 2 }, (_, j) => orchard.at(-22 + i * 9, -42 - j * 8))).flat());

const farmRoad = MAP_V1_ROADS.find((r) => r.id === "farm_road")!;
const highwayEast = MAP_V1_ROADS.find((r) => r.id === "highway_east")!;
const highwaySouth = MAP_V1_ROADS.find((r) => r.id === "highway_south")!;
const roadside = (road: RoadSpec, side: 1 | -1): Vec2Tuple[] => bandAlong(catmullRom(road.points, 8), 6, 11, side);
/** Tree lines on both sides of the dirt roads (and the far side of both highways), broken up by a noise mask. */
const ROADSIDE_TREE_LINES: ScatterRule[] = (
  [
    ["west_road", [1, -1]], ["radar_approach", [1, -1]], ["quarry_road", [1, -1]], ["forest_quarry", [1, -1]], ["quarry_military", [1, -1]],
    ["farm_yard", [1, -1]], ["millbrook_road", [1, -1]], ["camp_track", [1, -1]], ["orchard_track", [1, -1]], ["highway_east", [1]], ["highway_south", [-1]],
  ] as const
).flatMap(([id, sides]) =>
  sides.map((side): ScatterRule => ({
    id: `${id}_trees_${side > 0 ? "r" : "l"}`,
    props: DECIDUOUS,
    area: roadside(road(id), side),
    density: 2.2,
    mask: { wavelength: 45, threshold: 0.4 },
    clearance: 1,
    maxSlopeDegrees: 30,
    exclude: POI_CORES,
    scaleRange: [0.85, 1.25],
  })),
);

/** Hand-picked slope spots for open rock faces (backs into the slope, see `faceDownhill`): Radar Hill's north flank, the quarry terrace walls. */
const RADAR_FACE_SPOTS: readonly Vec2Tuple[] = ([[-44, 40], [-28, 30], [-12, 24], [4, 34], [20, 24], [36, 30]] as const).map(([x, z]) => radar.at(x, z));
const QUARRY_FACE_SPOTS: readonly Vec2Tuple[] = (
  [
    // [angle°, radius]: inner wall, middle wall, outer wall; the ramps at 90° and ~-14° stay clear.
    [30, 56], [75, 56], [135, 61], [195, 56], [240, 52], [300, 63],
    [15, 74], [60, 70], [165, 78], [225, 70], [270, 71],
    [45, 84], [210, 86], [255, 84],
  ] as const
).map(([degrees, radius]) => quarry.at(round3(Math.cos((degrees * Math.PI) / 180) * radius), round3(Math.sin((degrees * Math.PI) / 180) * radius)));
const COVER_BAND = (center: Vec2Tuple) => circle(center, 170, 24);

const SCATTER_RULES: readonly ScatterRule[] = [
  // Big-trunk oaks and forest-floor cover first, so the conifers and undergrowth grow round them.
  { id: "forest_west_oaks", seed: seedFromId("forest_west"), props: [{ prop: "tree_oak_fungi", weight: 1 }], area: WEST_FOREST, density: 0.05, mask: { wavelength: 80, threshold: 0.32 }, edgeFade: 25, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, minDistance: 12, scaleRange: [0.9, 1.1] },
  { id: "forest_west_floor", props: [{ prop: "stump_boubin", weight: 1 }, { prop: "log_mossy", weight: 1 }], area: WEST_FOREST, density: 0.06, edgeFade: 15, maxSlopeDegrees: 25, excludeSurfaces: ["road"], exclude: POI_CORES, minDistance: 15, scaleRange: [0.9, 1.1] },
  { id: "ridge_edge_oaks", props: [{ prop: "tree_oak_fungi", weight: 1 }], area: RIDGE_WOODS, density: 0.03, edgeBand: 25, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, minDistance: 30, scaleRange: [0.9, 1.1] },
  { id: "east_edge_oaks", props: [{ prop: "tree_oak_fungi", weight: 1 }], area: EAST_WOODS, density: 0.03, edgeBand: 25, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, minDistance: 30, scaleRange: [0.9, 1.1] },
  { id: "valley_oaks", props: [{ prop: "tree_oak_large", weight: 1 }], area: bandAlong(VALLEY, -30, 30, 1), density: 0.04, maxSlopeDegrees: 20, excludeSurfaces: ["road"], exclude: POI_CORES, minDistance: 25, scaleRange: [0.85, 1.15] },
  { id: "south_woods_oaks", props: [{ prop: "tree_oak_fungi", weight: 1 }], area: SOUTH_WOODS, density: 0.04, edgeFade: 20, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [WEST_FOREST, POI_CORES[4]!], minDistance: 22, scaleRange: [0.9, 1.1] },
  { id: "field_oaks", props: [{ prop: "tree_oak_large", weight: 1 }], area: PLAYABLE, density: 0.012, maxSlopeDegrees: 14, excludeSurfaces: ["road", "dirt"], exclude: [...POI_CORES, ...WOODS], minDistance: 55, scaleRange: [0.85, 1.15] },
  // Orchard: fruit-tree rows (small broadleaf trees) on hand-picked spots.
  { id: "orchard_rows", props: [{ prop: "tree_broadleaf_a", weight: 2 }, { prop: "tree_broadleaf_b", weight: 1 }], area: PLAYABLE, density: 1, spots: ORCHARD_SPOTS, maxSlopeDegrees: 20, excludeSurfaces: ["road"], scaleRange: [0.7, 0.9] },
  // Forests: dense conifers with noise clearings, fading at their edges.
  { id: "forest_west", props: TREES, area: WEST_FOREST, density: 1.7, mask: { wavelength: 80, threshold: 0.3 }, edgeFade: 25, maxSlopeDegrees: 38, excludeSurfaces: ["road"], scaleRange: [0.75, 1.3] },
  { id: "forest_west_under", props: UNDERGROWTH, area: WEST_FOREST, density: 2.2, mask: { wavelength: 60, threshold: 0.3 }, edgeFade: 15, maxSlopeDegrees: 40, excludeSurfaces: ["road"], scaleRange: [0.7, 1.3] },
  { id: "ridge_woods", props: TREES, area: RIDGE_WOODS, density: 1.15, mask: { wavelength: 70, threshold: 0.36 }, edgeFade: 30, maxSlopeDegrees: 34, excludeSurfaces: ["road"], scaleRange: [0.7, 1.2] },
  { id: "east_woods", props: TREES, area: EAST_WOODS, density: 1.3, mask: { wavelength: 90, threshold: 0.36 }, edgeFade: 30, maxSlopeDegrees: 36, excludeSurfaces: ["road"], scaleRange: [0.75, 1.25] },
  { id: "east_woods_under", props: UNDERGROWTH, area: EAST_WOODS, density: 1.2, mask: { wavelength: 60, threshold: 0.35 }, edgeFade: 20, maxSlopeDegrees: 40, excludeSurfaces: ["road"], scaleRange: [0.7, 1.2] },
  { id: "south_woods", props: TREES, area: SOUTH_WOODS, density: 0.95, mask: { wavelength: 80, threshold: 0.42 }, edgeFade: 25, maxSlopeDegrees: 36, excludeSurfaces: ["road"], exclude: [WEST_FOREST, POI_CORES[4]!], scaleRange: [0.75, 1.25] },
  { id: "south_woods_under", props: UNDERGROWTH, area: SOUTH_WOODS, density: 0.8, mask: { wavelength: 60, threshold: 0.4 }, edgeFade: 20, maxSlopeDegrees: 40, excludeSurfaces: ["road"], exclude: [WEST_FOREST, POI_CORES[4]!], scaleRange: [0.7, 1.2] },
  // Groves: sparse, clumpy stands between POIs that break long sightlines.
  { id: "north_groves", props: DECIDUOUS, area: NORTH_GROVES, density: 1.25, mask: { wavelength: 110, threshold: 0.56, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], scaleRange: [0.8, 1.3] },
  { id: "south_groves", props: DECIDUOUS, area: SOUTH_GROVES, density: 1.4, mask: { wavelength: 100, threshold: 0.53, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, scaleRange: [0.8, 1.3] },
  { id: "east_groves", props: DECIDUOUS, area: EAST_GROVES, density: 1.4, mask: { wavelength: 90, threshold: 0.55, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, scaleRange: [0.8, 1.3] },
  { id: "valley_trees", props: DECIDUOUS, area: bandAlong(VALLEY, -30, 30, 1), density: 0.85, mask: { wavelength: 60, threshold: 0.4 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, scaleRange: [0.8, 1.35] },
  { id: "west_groves", props: DECIDUOUS, area: WEST_GROVES, density: 1.3, mask: { wavelength: 90, threshold: 0.55, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [...POI_CORES, WEST_FOREST, RIDGE_WOODS], scaleRange: [0.8, 1.3] },
  { id: "north_east_groves", props: DECIDUOUS, area: NE_GROVES, density: 1.3, mask: { wavelength: 100, threshold: 0.55, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [...POI_CORES, NORTH_GROVES], scaleRange: [0.8, 1.3] },
  { id: "east_field_groves", props: DECIDUOUS, area: EAST_FIELDS, density: 1.2, mask: { wavelength: 90, threshold: 0.56, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [...POI_CORES, EAST_GROVES], scaleRange: [0.8, 1.3] },
  { id: "south_east_groves", props: DECIDUOUS, area: SOUTH_EAST_GROVES, density: 1.3, mask: { wavelength: 90, threshold: 0.55, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [...POI_CORES, EAST_WOODS], scaleRange: [0.8, 1.3] },
  // Garden trees and hedges in town.
  { id: "town_gardens", props: [{ prop: "tree_broadleaf_b", weight: 1 }, { prop: "bush_c", weight: 2 }, { prop: "bush_a", weight: 2 }], area: circle(town.center, 60), density: 0.9, avoidPads: false, clearance: 2.5, excludeSurfaces: ["road"], scaleRange: [0.7, 1.1] },
  // Tree lines along the farm road and the highways outside town, then along the other roads.
  { id: "farm_road_trees_l", props: DECIDUOUS, area: roadside(farmRoad, -1), density: 3, mask: { wavelength: 40, threshold: 0.3 }, avoidPads: false, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.2] },
  { id: "farm_road_trees_r", props: DECIDUOUS, area: roadside(farmRoad, 1), density: 3, mask: { wavelength: 40, threshold: 0.3 }, avoidPads: false, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.2] },
  { id: "highway_east_trees", props: DECIDUOUS, area: roadside(highwayEast, -1), density: 2.5, mask: { wavelength: 50, threshold: 0.35 }, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.25] },
  { id: "highway_south_trees", props: DECIDUOUS, area: roadside(highwaySouth, 1), density: 2.5, mask: { wavelength: 50, threshold: 0.35 }, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.25] },
  ...ROADSIDE_TREE_LINES,
  // Field cover: small clusters of rocks, bushes and logs every ~50 m in the open, thinner in a few meadows.
  {
    id: "field_cover",
    props: [
      { prop: "rock_boulder_b", weight: 1 },
      { prop: "rock_moss_a", weight: 1 },
      { prop: "rock_boulder_a", weight: 1.5 },
      { prop: "rock_moss_b", weight: 1.5 },
      { prop: "bush_c", weight: 2.5 },
      { prop: "log_fallen", weight: 0.5 },
      { prop: "tree_fir_young", weight: 0.4 },
    ],
    area: PLAYABLE,
    exclude: POI_CORES,
    density: 0.04,
    // About one cluster in ten is anchored by a big boulder or mossy log (cover_fill below closes the remaining gaps).
    cluster: { count: [2, 4], radius: 7, anchor: { props: [{ prop: "rock_boulder_large", weight: 3 }, { prop: "log_mossy", weight: 2 }], chance: 0.1, scaleRange: [0.8, 1.3] } },
    mask: { wavelength: 160, threshold: 0.3, softness: 0.15 },
    maxSlopeDegrees: 30,
    excludeSurfaces: ["road"],
    scaleRange: [0.7, 1.2],
  },
  // Hay stacks in the fields round the farm and town.
  { id: "field_hay_farm", props: [{ prop: "hay_bale_stack", weight: 1 }], area: COVER_BAND(poi("farm").center), density: 0.01, maxSlopeDegrees: 12, excludeSurfaces: ["road", "rock"], exclude: POI_CORES, minDistance: 60 },
  { id: "field_hay_town", props: [{ prop: "hay_bale_stack", weight: 1 }], area: COVER_BAND(poi("town").center), density: 0.01, maxSlopeDegrees: 12, excludeSurfaces: ["road", "rock"], exclude: POI_CORES, minDistance: 60 },
  // Big slope rocks: boulders on hillsides, open rock faces only on steep ground with their backs into the slope.
  { id: "slope_boulders", props: [{ prop: "rock_boulder_large", weight: 1 }], area: PLAYABLE, density: 0.1, minSlopeDegrees: 18, maxSlopeDegrees: 35, exclude: POI_CORES, minDistance: 25, scaleRange: [0.9, 1.6] },
  { id: "slope_faces", props: [{ prop: "rock_face_large", weight: 1 }], area: PLAYABLE, density: 0.1, minSlopeDegrees: 25, maxSlopeDegrees: 45, exclude: [...POI_CORES, circle(poi("radar").center, 100)], minDistance: 40, faceDownhill: true, scaleRange: [0.9, 1.2] },
  { id: "radar_faces", props: [{ prop: "rock_face_large", weight: 1 }], area: PLAYABLE, density: 1, spots: RADAR_FACE_SPOTS, minSlopeDegrees: 25, faceDownhill: true, scaleRange: [0.95, 1.15] },
  { id: "quarry_faces", props: [{ prop: "rock_face_large", weight: 1 }], area: PLAYABLE, density: 1, spots: QUARRY_FACE_SPOTS, minSlopeDegrees: 25, faceDownhill: true, avoidPads: false, scaleRange: [0.9, 1.2] },
  { id: "slope_rocks", props: [{ prop: "rock_small", weight: 4 }, { prop: "rock_moss_b", weight: 1 }, { prop: "rock_boulder_a", weight: 1 }, { prop: "rock_moss_a", weight: 0.5 }, { prop: "rock_boulder_b", weight: 0.5 }], area: PLAYABLE, density: 0.8, minSlopeDegrees: 17, maxSlopeDegrees: 60, scaleRange: [0.7, 1.4] },
  {
    id: "quarry_rocks",
    props: [{ prop: "rock_small", weight: 4 }, { prop: "rock_boulder_a", weight: 2 }, { prop: "rock_boulder_b", weight: 0.6 }],
    area: circle(poi("quarry").center, 100),
    density: 0.6,
    avoidPads: false,
    clearance: 3,
    scaleRange: [0.6, 1.3],
  },
  // Gap filler: a big boulder wherever open ground still has no hard cover within 22 m.
  { id: "cover_fill", props: [{ prop: "rock_boulder_large", weight: 1 }], area: PLAYABLE, density: 0.06, bareRadius: 25, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [WEST_FOREST, RIDGE_WOODS, EAST_WOODS], scaleRange: [0.9, 1.3] },
  { id: "meadow_bushes", props: [{ prop: "bush_a", weight: 2 }, { prop: "bush_b", weight: 1 }, { prop: "bush_c", weight: 1 }], area: PLAYABLE, density: 0.1, mask: { wavelength: 70, threshold: 0.45 }, maxSlopeDegrees: 30, excludeSurfaces: ["road", "rock"], scaleRange: [0.7, 1.3] },
  // Grass clumps: expanded by the client around the viewer only.
  { id: "grass", props: [{ prop: "grass_clump_short", weight: 3 }, { prop: "grass_clump_medium", weight: 2 }, { prop: "grass_clump_tall", weight: 1 }], area: PLAYABLE, density: 30, mask: { wavelength: 28, threshold: 0.42, softness: 0.2 }, maxSlopeDegrees: 35, excludeSurfaces: ["road", "dirt", "rock"], scaleRange: [0.7, 1.3], detail: true },
];

export const MAP_V1_SCATTERS: readonly ScatterRule[] = SCATTER_RULES.map((rule) => (rule.detail ? rule : { ...rule, exclude: [...(rule.exclude ?? []), ...OPENING_ZONES] }));

// ---------------------------------------------------------------------------------------------------------------
// Spawns: two per POI (minor POIs included) on its outskirts until the landing phase exists.
// ---------------------------------------------------------------------------------------------------------------

const SPAWN_SPOTS: readonly { at: Vec2Tuple; face: Vec2Tuple }[] = [
  { at: town.at(-66, -44), face: town.center },
  { at: town.at(64, 50), face: town.center },
  { at: farm.at(-54, -40), face: farm.center },
  { at: farm.at(46, 30), face: farm.center },
  { at: military.at(-78, 30), face: military.center },
  { at: military.at(20, -60), face: military.center },
  { at: radar.at(-30, -30), face: radar.center },
  { at: radar.at(40, -40), face: radar.center },
  { at: quarry.at(0, 132), face: quarry.center },
  { at: quarry.at(100, -2), face: quarry.center },
  { at: forest.at(-4, -44), face: forest.center },
  { at: forest.at(48, 30), face: forest.center },
  { at: [yard.center[0] - 28, yard.center[1] + 62], face: yard.center },
  { at: [yard.center[0] + 60, yard.center[1] + 50], face: yard.center },
  { at: millbrook.at(-48, -40), face: millbrook.center },
  { at: millbrook.at(46, 30), face: millbrook.center },
  { at: truckstop.at(-45, -20), face: truckstop.center },
  { at: truckstop.at(48, -18), face: truckstop.center },
  { at: camp.at(-40, 20), face: camp.center },
  { at: camp.at(40, -30), face: camp.center },
  { at: orchard.at(-50, -30), face: orchard.center },
  { at: orchard.at(40, -45), face: orchard.center },
];

const SPAWNS: MapSpawn[] = SPAWN_SPOTS.map(({ at, face }) => ({ position: at, yaw: round3(Math.atan2(face[0] - at[0], face[1] - at[1])) }));

// ---------------------------------------------------------------------------------------------------------------

const POI_FRAMES = [town, farm, military, radar, quarry, forest, millbrook, truckstop, camp, orchard, countryside];

/** Fence gates and wall breaches, kept clear of collidable props (validated in layout/mapV1.test.ts). */
export const MAP_V1_OPENINGS: readonly LineOpening[] = POI_FRAMES.flatMap((frame) => frame.openings);

export const MAP_V1: MapData = {
  id: "v1",
  name: "Map v1",
  terrain: TERRAIN_V1,
  flatten: [...PADS, ...OUTLYING_PADS, ...RAMPS, ...MAP_V1_ROADS.map(roadFlatten)],
  bounds: { outOfBoundsGraceSeconds: 10, killY: -40, landingAltitude: 300 },
  pois: MAP_V1_POIS,
  buildings: POI_FRAMES.flatMap((frame) => frame.buildings),
  props: POI_FRAMES.flatMap((frame) => frame.props),
  scatters: MAP_V1_SCATTERS,
  spawns: SPAWNS,
};
