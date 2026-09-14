import { bandAlong, catmullRom, round3 } from "./layout/geometry";
import { PoiFrame, rectLoop } from "./layout/placement";
import { roadFlatten, type RoadSpec } from "./layout/roads";
import type { ScatterRule } from "./layout/scatter";
import { TERRAIN_V1 } from "./terrain/presets";
import type { FlattenRegion, MapData, MapSpawn, PointOfInterest, Vec2Tuple } from "./types";

/**
 * Map v1 layout: seven points of interest on the v1 terrain, joined by asphalt and dirt roads, with forests, tree lines
 * and field cover in between. See docs/map/layout.md (and the generated docs/map/mapV1.svg).
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
  // Bell tower on the square's north-east corner: the town's silhouette and its best (and most exposed) perch.
  .building("bell_tower", "watchtower", 9, 9.5, Math.PI)
  // Back-yard fences, gaps as garden gates.
  .line("fence_wood", [[-50, 22], [-20, 22], [-20, 40]], { gaps: [[13, 16]] })
  .line("fence_wood", [[50, 22], [20, 22], [20, 42]], { gaps: [[20, 23]] })
  .line("fence_wood", [[-50, -22], [-20, -22], [-20, -42]], { gaps: [[8, 11]] })
  .line("fence_wood", [[50, -22], [20, -22], [20, -42]], { gaps: [[14, 17]] })
  // Square: a burnt-out car and a half-built checkpoint.
  .prop("car_covered", -8, -7, 0.4)
  .prop("road_barrier", 7, -9, 0.2)
  .prop("road_barrier", -9, 7, 1.4)
  .prop("sandbags", 10, 4.5, 0)
  // Street clutter.
  .prop("car_covered", -60, 6, 0.1)
  .prop("car_covered", 34, -5.2, Math.PI + 0.15)
  .prop("car_covered", 5.5, 55, HALF_PI - 0.2)
  .prop("log_fallen", -35, 30, 0.3)
  .prop("hay_bale", 36, 30, 0.5);

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
  // Paddock fence, walked from the south-west corner: gates south (track to the Training Yard), east (hay meadow) and
  // west (farm road).
  .line("fence_wood", rectLoop(0, 0, 36, 32), { gaps: [[40, 52], [96, 108], [210, 222]] })
  .prop("hay_stack", 11, 16, 0.1)
  .prop("hay_stack", 11, 20, 0.05)
  .prop("hay_bale", 14, 24, 0.9)
  .prop("log_fallen", -34, 0, HALF_PI)
  .prop("car_covered", 24, 6, 1.2);
// Hay meadow east of the yard: round bales in loose rows (cover for crossing the open field).
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 4; col++) farm.prop("hay_bale", 52 + col * 11 + (row % 2) * 4, -24 + row * 16, 0.3 * col + row);
}
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
  .prop("sandbags", -40, -24, 0)
  .prop("sandbags", 36, 24, 0)
  .prop("sandbags", -36, 10, HALF_PI)
  .prop("sandbags", -36, 16, HALF_PI)
  .prop("road_barrier", -58, 14, HALF_PI)
  .prop("road_barrier", -58, 4, HALF_PI)
  .prop("road_barrier", 0, 0, 0.1)
  .prop("road_barrier", 6, -4, 1.2)
  .prop("car_covered", -22, -6, 0.6)
  .prop("crate_military_long", 8, -12, 0.2)
  .prop("crate_military", 9, -9.5, 1.4)
  .prop("barrel_rusty", 33, -9, 0)
  .prop("barrel_rusty", 34, -8, 0)
  .prop("utility_box", -46, 10, HALF_PI);

// ---------------------------------------------------------------------------------------------------------------
// Radar Hill: radar station and a watchtower on the ridge crest, reached by a switchback road up the south-east flank.
// ---------------------------------------------------------------------------------------------------------------

// Frame X runs along the crest (north-east), +Z faces north-west, -Z down the flank toward town.
const radar = new PoiFrame("radar", poi("radar").center, -0.7);
radar
  .building("station", "radar_station", -6, 1, 0)
  .building("tower", "watchtower", 13, 2, 0)
  .prop("sandbags", 4, -8, 0)
  .prop("sandbags", 20, -7, 0.3)
  .prop("road_barrier", -18, -8, 0)
  .prop("car_covered", 24, 10, 1.8);

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
  .prop("tree_stump", -30, -40, 0);

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
forest.prop("log_fallen", -6, 4, 0.2).prop("car_covered", 5, -5, 1.9).prop("hay_bale", -30, 20, 0).prop("log_fallen", 30, -26, 1.1);

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
  .prop("hay_bale", 64, 152, 0.3)
  .prop("hay_bale", 88, 164, 1.1)
  .prop("hay_bale", 112, 150, 2.3)
  .prop("hay_bale", 96, 136, 0.6)
  .prop("car_covered", 150, 36.5, 2.8)
  .prop("car_covered", 96, -155, 0.9)
  .prop("car_covered", -112, 21, 0.4)
  .prop("car_covered", 196, -397, 3.3)
  .prop("car_covered", -258, -236, 2.1)
  // Abandoned roadblock on the south highway.
  .prop("road_barrier", 166, -202, 0.45)
  .prop("road_barrier", 176, -222, 0.45)
  .prop("sandbags", 160, -198, 0.45)
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
];

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
const VALLEY: Vec2Tuple[] = [[90, 495], [150, 320], [120, 140], [200, -60], [160, -220], [210, -495]];

const farmRoad = MAP_V1_ROADS.find((r) => r.id === "farm_road")!;
const highwayEast = MAP_V1_ROADS.find((r) => r.id === "highway_east")!;
const highwaySouth = MAP_V1_ROADS.find((r) => r.id === "highway_south")!;
const roadside = (road: RoadSpec, side: 1 | -1): Vec2Tuple[] => bandAlong(catmullRom(road.points, 8), 6, 11, side);

export const MAP_V1_SCATTERS: readonly ScatterRule[] = [
  // Forests: dense conifers with noise clearings, fading at their edges.
  { id: "forest_west", props: TREES, area: WEST_FOREST, density: 1.5, mask: { wavelength: 80, threshold: 0.32 }, edgeFade: 25, maxSlopeDegrees: 38, excludeSurfaces: ["road"], scaleRange: [0.75, 1.3] },
  { id: "forest_west_under", props: UNDERGROWTH, area: WEST_FOREST, density: 2.2, mask: { wavelength: 60, threshold: 0.3 }, edgeFade: 15, maxSlopeDegrees: 40, excludeSurfaces: ["road"], scaleRange: [0.7, 1.3] },
  { id: "ridge_woods", props: TREES, area: RIDGE_WOODS, density: 0.9, mask: { wavelength: 70, threshold: 0.4 }, edgeFade: 30, maxSlopeDegrees: 34, excludeSurfaces: ["road"], scaleRange: [0.7, 1.2] },
  { id: "east_woods", props: TREES, area: EAST_WOODS, density: 1.1, mask: { wavelength: 90, threshold: 0.36 }, edgeFade: 30, maxSlopeDegrees: 36, excludeSurfaces: ["road"], scaleRange: [0.75, 1.25] },
  { id: "east_woods_under", props: UNDERGROWTH, area: EAST_WOODS, density: 1.2, mask: { wavelength: 60, threshold: 0.35 }, edgeFade: 20, maxSlopeDegrees: 40, excludeSurfaces: ["road"], scaleRange: [0.7, 1.2] },
  // Groves: sparse, clumpy stands between POIs that break long sightlines.
  { id: "north_groves", props: DECIDUOUS, area: NORTH_GROVES, density: 1.1, mask: { wavelength: 110, threshold: 0.6, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], scaleRange: [0.8, 1.3] },
  { id: "south_groves", props: DECIDUOUS, area: SOUTH_GROVES, density: 1.1, mask: { wavelength: 100, threshold: 0.6, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, scaleRange: [0.8, 1.3] },
  { id: "east_groves", props: DECIDUOUS, area: EAST_GROVES, density: 1.1, mask: { wavelength: 90, threshold: 0.62, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, scaleRange: [0.8, 1.3] },
  { id: "valley_trees", props: DECIDUOUS, area: bandAlong(VALLEY, -30, 30, 1), density: 0.6, mask: { wavelength: 60, threshold: 0.45 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: POI_CORES, scaleRange: [0.8, 1.35] },
  // Garden trees and hedges in town.
  { id: "town_gardens", props: [{ prop: "tree_broadleaf_b", weight: 1 }, { prop: "bush_c", weight: 2 }, { prop: "bush_a", weight: 2 }], area: circle(town.center, 60), density: 0.9, avoidPads: false, clearance: 2.5, excludeSurfaces: ["road"], scaleRange: [0.7, 1.1] },
  // Tree lines along the farm road and the highways outside town.
  { id: "farm_road_trees_l", props: DECIDUOUS, area: roadside(farmRoad, -1), density: 3, mask: { wavelength: 40, threshold: 0.3 }, avoidPads: false, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.2] },
  { id: "farm_road_trees_r", props: DECIDUOUS, area: roadside(farmRoad, 1), density: 3, mask: { wavelength: 40, threshold: 0.3 }, avoidPads: false, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.2] },
  { id: "highway_east_trees", props: DECIDUOUS, area: roadside(highwayEast, -1), density: 2.5, mask: { wavelength: 50, threshold: 0.35 }, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.25] },
  { id: "highway_south_trees", props: DECIDUOUS, area: roadside(highwaySouth, 1), density: 2.5, mask: { wavelength: 50, threshold: 0.35 }, clearance: 1, exclude: POI_CORES, scaleRange: [0.9, 1.25] },
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
    cluster: { count: [2, 4], radius: 7 },
    mask: { wavelength: 160, threshold: 0.3, softness: 0.15 },
    maxSlopeDegrees: 30,
    excludeSurfaces: ["road"],
    scaleRange: [0.7, 1.2],
  },
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
  { id: "meadow_bushes", props: [{ prop: "bush_a", weight: 2 }, { prop: "bush_b", weight: 1 }, { prop: "bush_c", weight: 1 }], area: PLAYABLE, density: 0.1, mask: { wavelength: 70, threshold: 0.45 }, maxSlopeDegrees: 30, excludeSurfaces: ["road", "rock"], scaleRange: [0.7, 1.3] },
  // Grass clumps: expanded by the client around the viewer only.
  { id: "grass", props: [{ prop: "grass_clump_short", weight: 3 }, { prop: "grass_clump_medium", weight: 2 }, { prop: "grass_clump_tall", weight: 1 }], area: PLAYABLE, density: 30, mask: { wavelength: 28, threshold: 0.42, softness: 0.2 }, maxSlopeDegrees: 35, excludeSurfaces: ["road", "dirt", "rock"], scaleRange: [0.7, 1.3], detail: true },
];

// ---------------------------------------------------------------------------------------------------------------
// Spawns: two per POI on its outskirts until the landing phase exists.
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
];

const SPAWNS: MapSpawn[] = SPAWN_SPOTS.map(({ at, face }) => ({ position: at, yaw: round3(Math.atan2(face[0] - at[0], face[1] - at[1])) }));

// ---------------------------------------------------------------------------------------------------------------

const POI_FRAMES = [town, farm, military, radar, quarry, forest, countryside];

export const MAP_V1: MapData = {
  id: "v1",
  name: "Map v1",
  terrain: TERRAIN_V1,
  flatten: [...PADS, ...RAMPS, ...MAP_V1_ROADS.map(roadFlatten)],
  bounds: { outOfBoundsGraceSeconds: 10, killY: -40, landingAltitude: 300 },
  pois: MAP_V1_POIS,
  buildings: POI_FRAMES.flatMap((frame) => frame.buildings),
  props: POI_FRAMES.flatMap((frame) => frame.props),
  scatters: MAP_V1_SCATTERS,
  spawns: SPAWNS,
};
