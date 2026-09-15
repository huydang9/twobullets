// Vietnamese street set (Saigon maps): models and props built by vn/build.mjs into public/assets/environment/vn/.
// Same model/prop spec as ../config.mjs (MODELS, PROPS), plus per-prop gameplay hints for the generated manifest.
// Catalog, licenses and the map integration plan: docs/assets-vietnam.md.
import path from "node:path";
import { SRC_DIR } from "../config.mjs";

/** Poly Haven 1K glTFs (vn/fetch.mjs). External GLBs live next to them under assets-src/environment/vn/<slug>/. */
export const VN_MODELS_DIR = path.join(SRC_DIR, "vn", "models");
/** Output folder, relative to the environment asset root. */
export const VN_URL_DIR = "vn";

function oga(slug, name, license) {
  return { id: `oga_${slug}`, name, type: "model", authors: [{ name: "Yughues (Nobiax)", role: "All" }], license, url: `https://opengameart.org/content/${slug}` };
}

function acg(id, name) {
  return { id: `acg_${id}`, name, type: "model", authors: [{ name: "ambientCG (Lennart Demes)", role: "All" }], license: "CC0", url: `https://ambientcg.com/a/${id}` };
}

const SMALL_TEX = { baseColor: 512, normal: 256, orm: 256 };
const MID_TEX = { baseColor: 1024, normal: 512, orm: 256 };

/**
 * `alpha` merges a Poly Haven opacity map into the base color (as in ../config.mjs). `textures` overrides the default
 * texture limits (1K color, 512 normal/ORM).
 */
export const VN_MODELS = [
  // Sidewalk seating (quán cóc / trà đá).
  { id: "plastic_monobloc_chair_01", textures: SMALL_TEX },
  { id: "chinese_stool", textures: SMALL_TEX },
  { id: "chinese_tea_table", textures: SMALL_TEX },
  { id: "metal_stool_02", textures: SMALL_TEX },
  { id: "folding_wooden_stool", textures: SMALL_TEX },
  { id: "wooden_stool_01", textures: SMALL_TEX },
  { id: "outdoor_table_chair_set_01", textures: SMALL_TEX },
  // Shopfronts and walls.
  { id: "rollershutter_door", textures: MID_TEX },
  { id: "rollershutter_window_01", textures: MID_TEX },
  { id: "rollershutter_window_02", textures: MID_TEX },
  { id: "rollershutter_window_03", textures: MID_TEX },
  { id: "steel_frame_shelves_01", textures: SMALL_TEX },
  { id: "large_iron_gate", textures: MID_TEX },
  { id: "exterior_aircon_unit", alpha: { exterior_aircon_unit_02: "01_opacity", exterior_aircon_unit_rusted_02: "rusted_02_opacity" }, textures: SMALL_TEX },
  { id: "security_camera_01", textures: SMALL_TEX },
  // Street utilities.
  { id: "modular_electricity_poles", textures: MID_TEX },
  { id: "utility_box_01", textures: SMALL_TEX },
  { id: "street_lamp_01", textures: SMALL_TEX },
  { id: "street_lamp_02", textures: SMALL_TEX },
  { id: "water_manhole_cover", textures: SMALL_TEX },
  { id: "fire_hydrant", textures: SMALL_TEX },
  { id: "concrete_road_barrier", textures: MID_TEX },
  { id: "small_lpg_tank", textures: SMALL_TEX },
  { id: "propane_tank", textures: SMALL_TEX },
  { id: "metal_trash_can", textures: SMALL_TEX },
  { id: "trashbag", textures: SMALL_TEX },
  { id: "cardboard_box_01", textures: SMALL_TEX },
  // Market (chợ) goods.
  { id: "plastic_crate_01", skip: true }, // Brand label ("GALLER") baked into the albedo.
  { id: "plastic_crate_02", alpha: { plastic_crate_02: "opacity" }, textures: SMALL_TEX },
  { id: "plastic_crate_03", skip: true }, // Moulded lattice: 9k triangles after simplification, over the small-prop budget.
  { id: "wicker_basket_01", skip: true }, // Thin woven strips fall apart below ~8k triangles.
  { id: "wicker_basket_02", textures: SMALL_TEX },
  { id: "bananas", textures: SMALL_TEX },
  { id: "plastic_bottle_gallon", textures: SMALL_TEX },
  { id: "Barrel_02", textures: SMALL_TEX },
  { id: "plastic_jerrycan", textures: SMALL_TEX },
  { id: "cement_bag", textures: SMALL_TEX },
  { id: "hand_truck", textures: SMALL_TEX },
  // Potted plants and tropical ground plants.
  { id: "potted_plant_01", alpha: { potted_plant_01_leaves: "leaves_alpha" }, textures: SMALL_TEX },
  { id: "potted_plant_02", alpha: { potted_plant_02_leaves: "leaves_alpha" }, textures: SMALL_TEX },
  { id: "potted_plant_04", textures: SMALL_TEX },
  { id: "planter_pot_clay", textures: SMALL_TEX },
  { id: "ceramic_pot", textures: SMALL_TEX },
  { id: "pachira_aquatica_01", alpha: { pachira_aquatica_01_leaves: "leaves_alpha" }, textures: MID_TEX },
  { id: "calathea_orbifolia_01", alpha: { calathea_orbifolia_01: "Alpha" }, textures: SMALL_TEX },
  { id: "anthurium_botany_01", alpha: { anthurium_botany_01: "Alpha" }, textures: SMALL_TEX },
  { id: "planter_box_01", textures: SMALL_TEX },
  // Tropical trees and plants: OpenGameArt OBJ/TGA packs by Yughues (Nobiax), converted by vn/obj.mjs.
  { id: "vn_palms", files: ["vn/oga/palm-treez-v3/palm-treez-v3.glb"], atlas: 1024, textures: MID_TEX, credits: [oga("free-palm-treez-v3", "Free palm treeZ v3", "CC0")] },
  { id: "vn_bamboo", files: ["vn/oga/bamboo-v1/bamboo-v1.glb"], atlas: 1024, textures: MID_TEX, credits: [oga("free-bamboo-v1", "Free Bamboo v1", "CC0")] },
  { id: "vn_palm_plant", files: ["vn/oga/palm-plant/palm-plant.glb"], atlas: 512, textures: SMALL_TEX, credits: [oga("free-palm-plant", "Free Palm Plant", "CC-BY-4.0")] },
  { id: "vn_tropical_plant", files: ["vn/oga/tropical-plant-02/tropical-plant-02.glb"], atlas: 512, textures: MID_TEX, credits: [oga("tropical-plant-02-0", "Tropical plant 02", "CC0")] },
  {
    id: "vn_tropical_shrubs",
    files: [1, 2, 3, 4, 5].map((n) => `vn/oga/tropical-shrubs/tropical-shrub-0${n}.glb`),
    atlas: 1024,
    textures: SMALL_TEX,
    credits: [oga("tropical-shrubs", "Tropical shrubs", "CC0")],
  },
  { id: "vn_houseplants", files: ["vn/oga/houseplants/houseplants.glb"], atlas: 1024, textures: SMALL_TEX, credits: [oga("free-houseplants", "Free houseplants", "CC0")] },
  { id: "vn_mango", files: ["vn/ambientcg/3DMango001/mango.glb"], textures: SMALL_TEX, credits: [acg("3DMango001", "Mango 001")] },
  // 3DBread011 (a 15 cm roll) was tried as bánh mì loaves; the simplified scan looked crumpled. Converted, not built.
  { id: "vn_bread_roll", skip: true },
  // Downloaded, not built yet (kits that need hand assembly on buildings): modular_electric_cables, modular_metal_gutter.
  { id: "modular_electric_cables", skip: true },
  { id: "modular_metal_gutter", skip: true },
  { id: "shrub_03", skip: true },
];

/** LOD presets. Street props stay cheap: most are seen by the hundred along a Saigon street. */
const TINY = [{ distance: 0, maxTriangles: 800 }, { distance: 8, ratio: 0.35, error: 0.03 }];
const SMALL = [{ distance: 0, maxTriangles: 2000 }, { distance: 12, ratio: 0.3, error: 0.02 }];
const MEDIUM = [{ distance: 0, maxTriangles: 4000 }, { distance: 25, ratio: 0.25, error: 0.03 }];
const LARGE = [{ distance: 0, maxTriangles: 8000 }, { distance: 35, ratio: 0.25, error: 0.02 }, { distance: 110, ratio: 0.06, error: 0.08, flags: ["Permissive"] }];
/** Flat panels (shutters): already a few hundred triangles; the far level only drops the slat bevels. */
const PANEL = [{ distance: 0, maxTriangles: 800 }, { distance: 30, ratio: 0.3, error: 0.02, flags: ["Permissive"] }];
/** Poles: a 14 cm pole under 8.7 m of height collapses at relative errors meant for compact props. */
// Far levels prune the small parts (bolts, then insulators) instead of collapsing the pole.
const POLE = [{ distance: 0, maxTriangles: 6000 }, { distance: 40, ratio: 0.3, error: 0.006, flags: ["Prune"] }, { distance: 120, ratio: 0.1, error: 0.009, flags: ["Prune"] }];
/** Game-ready meshes split at every UV seam (crates, hand truck): LOD0 needs Permissive to reach its cap. */
const SEAMED = [{ distance: 0, maxTriangles: 2000, flags: ["Permissive"] }, { distance: 12, ratio: 0.3, error: 0.02, flags: ["Permissive"] }];
/** Leafy pot plants: separate leaf islands, so far levels need Prune/Permissive. */
const PLANT = [{ distance: 0, maxTriangles: 5000, flags: ["Permissive"] }, { distance: 15, ratio: 0.3, error: 0.05, flags: ["Permissive"] }, { distance: 45, ratio: 0.08, error: 0.1, flags: ["Prune", "Permissive"] }];

/** Gameplay hints copied into the generated manifest (see PropAsset in apps/client/src/world/propAssets.ts). */
/**
 * `nodePrefix` selects every mesh node starting with it (Poly Haven kit presets). `collisionOverride` replaces the measured
 * collision with an upright cylinder on the pivot axis (poles: not the crossarm; pot plants: the pot, not the leaves);
 * a missing `height` means the prop's full height.
 */
const hint = (group, surface, cullDistance, use, extra = {}) => ({ group, surface, cullDistance, use, category: "prop", castShadow: true, scaleRange: [1, 1], ...extra });

/** One open plastic crate (plastic_crate_02, 0.51 × 0.25 × 0.41 m, cutout sides) moved into a stack slot. */
const crate = (x, y, z, yaw = 0) => ({ name: "plastic_crate_02", translate: [x, y, z], rotate: [0, yaw, 0] });

export const VN_PROPS = [
  // Sidewalk seating.
  { id: "vn_chair_plastic", model: "plastic_monobloc_chair_01", lods: SMALL, collision: "box", ...hint("sidewalk", "wood", 90, "quán cà phê / trà đá sidewalk chair") },
  { id: "vn_stool_wood_low", model: "chinese_stool", lods: SMALL, collision: "box", ...hint("sidewalk", "wood", 70, "low wooden stool at tea stalls, shop doors") },
  { id: "vn_tea_table_low", model: "chinese_tea_table", lods: SMALL, collision: "box", ...hint("sidewalk", "wood", 80, "low tea table (bàn trà) with stools") },
  { id: "vn_stool_metal", model: "metal_stool_02", lods: SMALL, collision: "box", ...hint("sidewalk", "metal", 70, "street food stall stool") },
  { id: "vn_stool_folding", model: "folding_wooden_stool", lods: SMALL, collision: "box", ...hint("sidewalk", "wood", 70, "vendor's folding stool") },
  { id: "vn_stool_wood", model: "wooden_stool_01", lods: SMALL, collision: "box", ...hint("sidewalk", "wood", 70, "shop stool") },
  { id: "vn_cafe_set", model: "outdoor_table_chair_set_01", lods: [{ ...MEDIUM[0], flags: ["Permissive"] }, MEDIUM[1]], collision: "box", ...hint("sidewalk", "metal", 120, "café table with two chairs") },
  // Shopfronts.
  { id: "vn_shutter_door", model: "rollershutter_door", nodes: ["rollershutter_door"], lods: PANEL, collision: "box", ...hint("shopfront", "metal", 250, "closed rolling shutter, narrow shop / garage") },
  { id: "vn_shutter_wide", model: "rollershutter_window_01", nodes: ["rollershutter_window_01"], lods: PANEL, collision: "box", ...hint("shopfront", "metal", 250, "closed shutter over a tube-house shopfront (nhà ống ground floor)") },
  { id: "vn_shutter_window_a", model: "rollershutter_window_02", nodes: ["rollershutter_window_02 "], lods: PANEL, collision: "box", ...hint("shopfront", "metal", 200, "shuttered window / kiosk") },
  { id: "vn_shutter_window_b", model: "rollershutter_window_03", nodes: ["rollershutter_window_03"], lods: PANEL, collision: "box", ...hint("shopfront", "metal", 200, "shuttered window / kiosk") },
  { id: "vn_shelves_steel", model: "steel_frame_shelves_01", scale: 0.1, lods: SMALL, collision: "box", ...hint("shopfront", "metal", 120, "shop shelves at open shopfronts, tạp hóa") },
  { id: "vn_gate_iron", model: "large_iron_gate", lods: LARGE, collision: "box", ...hint("shopfront", "metal", 300, "double iron gate of a house or alley (cổng sắt)") },
  // Walls and rooftops.
  { id: "vn_ac_unit", model: "exterior_aircon_unit", nodes: ["exterior_aircon_unit"], lods: SMALL, collision: "box", ...hint("wall", "metal", 150, "AC outdoor unit on facades, balconies, rooftops") },
  { id: "vn_ac_unit_rusted", model: "exterior_aircon_unit", nodes: ["exterior_aircon_unit_rusted"], lods: SMALL, collision: "box", ...hint("wall", "metal", 150, "weathered AC unit") },
  { id: "vn_security_camera", model: "security_camera_01", lods: TINY, collision: "none", ...hint("wall", "metal", 40, "camera over shop doors", { castShadow: false }) },
  // Street utilities.
  {
    id: "vn_power_pole_transformer",
    model: "modular_electricity_poles",
    nodePrefix: "preset_01_",
    pivot: [-2.5, 0, 0],
    scale: 1.45,
    lods: POLE,
    collision: "cylinder",
    collisionOverride: { kind: "cylinder", radius: 0.12 },
    ...hint("utility", "wood", 600, "8.7 m pole with crossarm, fuses and transformer (cột điện); hang cable bundles between poles"),
  },
  { id: "vn_power_pole", model: "modular_electricity_poles", nodePrefix: "preset_02_", pivot: [-4.5, 0, 0], scale: 1.45, lods: POLE, collision: "cylinder", collisionOverride: { kind: "cylinder", radius: 0.12 }, ...hint("utility", "wood", 600, "8.7 m distribution pole with crossarms") },
  { id: "vn_power_pole_fuse", model: "modular_electricity_poles", nodePrefix: "preset_03_", pivot: [-6.5, 0, 0], scale: 1.45, lods: POLE, collision: "cylinder", collisionOverride: { kind: "cylinder", radius: 0.12 }, ...hint("utility", "wood", 600, "8.7 m pole with offset crossarm, fuse and transformer") },
  { id: "vn_utility_box", model: "utility_box_01", nodes: ["utility_box_01_box"], lods: SMALL, collision: "box", ...hint("utility", "metal", 200, "telecom / electric cabinet on sidewalks") },
  { id: "vn_street_lamp", model: "street_lamp_01", lods: MEDIUM, collision: "cylinder", collisionOverride: { kind: "cylinder", radius: 0.12 }, ...hint("utility", "metal", 400, "3.9 m park / alley lamp post") },
  { id: "vn_wall_lamp", model: "street_lamp_02", lods: SMALL, collision: "none", ...hint("wall", "metal", 120, "wall-mounted lamp over gates and alleys") },
  { id: "vn_manhole", model: "water_manhole_cover", lods: TINY, collision: "none", ...hint("utility", "metal", 50, "manhole cover on roads and sidewalks", { castShadow: false }) },
  { id: "vn_fire_hydrant", model: "fire_hydrant", nodes: ["fire_hydrant_aged", "fire_hydrant_cap_01_aged", "fire_hydrant_cap_02_aged", "fire_hydrant_cap_03_aged", "fire_hydrant_chain_aged"], lods: SMALL, collision: "cylinder", ...hint("utility", "metal", 100, "hydrant at street corners") },
  { id: "vn_road_divider", model: "concrete_road_barrier", lods: LARGE, collision: "convexHull", ...hint("utility", "concrete", 400, "concrete median divider on main roads (Điện Biên Phủ, Xô Viết Nghệ Tĩnh)") },
  { id: "vn_gas_cylinder", model: "small_lpg_tank", lods: SMALL, collision: "cylinder", ...hint("sidewalk", "metal", 80, "12 kg LPG cylinder (bình gas) at food stalls and shop doors") },
  { id: "vn_gas_cylinder_small", model: "propane_tank", lods: SMALL, collision: "cylinder", ...hint("sidewalk", "metal", 70, "small gas cylinder") },
  { id: "vn_trash_can", model: "metal_trash_can", nodes: ["metal_trash_can_rust", "metal_trash_can_rust_handle_left", "metal_trash_can_rust_handle_right", "metal_trash_can_rust_lid"], lods: SMALL, collision: "box", ...hint("sidewalk", "metal", 120, "trash can; rotate lid side to the wall") },
  { id: "vn_trashbag", model: "trashbag", lods: SMALL, collision: "none", ...hint("sidewalk", "foliage", 60, "trash bags piled at the curb at night") },
  { id: "vn_cardboard_box", model: "cardboard_box_01", lods: TINY, collision: "box", ...hint("market", "wood", 60, "boxes at shop doors and market stalls") },
  // Market.
  { id: "vn_crate_plastic_b", model: "plastic_crate_02", lods: SMALL, collision: "box", ...hint("market", "wood", 70, "open plastic crate (sọt nhựa)") },
  {
    id: "vn_crate_stack",
    model: "plastic_crate_02",
    // Two layers of 2 × 2 crates (the upper one turned), one on top: 1.03 × 0.75 × 0.83 m.
    nodes: [0, 0.25].flatMap((y, layer) => [0, 0.52].flatMap((x) => [0, 0.42].map((z) => crate(x, y, z, layer === 1 ? 180 : 0)))).concat([crate(0.26, 0.5, 0.21, 90)]),
    lods: [{ distance: 0, maxTriangles: 6000, flags: ["Permissive"] }, { distance: 25, ratio: 0.5, error: 0.02 }],
    collision: "box",
    ...hint("market", "wood", 200, "stack of market crates at a chợ stall or behind a quán nhậu: low cover"),
  },
  { id: "vn_basket_lidded", model: "wicker_basket_02", lods: SMALL, collision: "none", ...hint("market", "wood", 50, "lidded basket") },
  { id: "vn_bananas", model: "bananas", nodes: ["bananas_bunch"], lods: SMALL, collision: "none", ...hint("market", "foliage", 35, "bananas on fruit stalls and altars", { castShadow: false }) },
  { id: "vn_water_jug", model: "plastic_bottle_gallon", lods: TINY, collision: "none", ...hint("market", "wood", 40, "water jug", { castShadow: false }) },
  { id: "vn_water_barrel", model: "Barrel_02", lods: SMALL, collision: "cylinder", ...hint("rooftop", "wood", 150, "blue plastic water barrel on rooftops and yards") },
  { id: "vn_jerrycan_plastic", model: "plastic_jerrycan", lods: TINY, collision: "box", ...hint("sidewalk", "wood", 50, "fuel/fish-sauce can at shops") },
  { id: "vn_cement_bag", model: "cement_bag", lods: TINY, collision: "box", ...hint("construction", "concrete", 60, "cement bags at house renovations (very common in Saigon alleys)") },
  { id: "vn_hand_truck", model: "hand_truck", lods: SEAMED, collision: "box", ...hint("market", "metal", 70, "delivery hand truck (xe đẩy hàng)") },
  // Plants.
  { id: "vn_potted_plant_large", model: "potted_plant_01", nodes: ["potted_plant_01_pot", "potted_plant_01_stem", "potted_plant_01_leaves"], lods: PLANT, collision: "cylinder", collisionOverride: { kind: "cylinder", radius: 0.24, height: 0.53 }, ...hint("plants", "concrete", 80, "large pot plant at shop doors and balconies", { category: "bush" }) },
  { id: "vn_potted_plant", model: "potted_plant_02", lods: PLANT, collision: "cylinder", collisionOverride: { kind: "cylinder", radius: 0.24, height: 0.34 }, ...hint("plants", "concrete", 70, "pot plant on steps, balconies, rooftops", { category: "bush" }) },
  { id: "vn_potted_succulent", model: "potted_plant_04", lods: TINY, collision: "none", ...hint("plants", "concrete", 35, "small pot on windowsills and stalls", { castShadow: false }) },
  { id: "vn_pot_clay", model: "planter_pot_clay", lods: TINY, collision: "none", ...hint("plants", "concrete", 50, "empty clay pot") },
  { id: "vn_pot_ceramic", model: "ceramic_pot", lods: SMALL, collision: "cylinder", ...hint("plants", "concrete", 80, "large glazed pot (chậu sứ) at house fronts") },
  { id: "vn_money_tree", model: "pachira_aquatica_01", nodes: ["pachira_aquatica_01_bark_d", "pachira_aquatica_01_leaves_d"], lods: PLANT, collision: "cylinder", collisionOverride: { kind: "cylinder", radius: 0.3, height: 0.6 }, ...hint("plants", "foliage", 120, "1.65 m potted money tree (cây kim ngân) at shop doors", { category: "bush" }) },
  { id: "vn_money_tree_small", model: "pachira_aquatica_01", nodes: ["pachira_aquatica_01_bark_c", "pachira_aquatica_01_leaves_c"], lods: PLANT, collision: "none", ...hint("plants", "foliage", 90, "1 m money tree", { category: "bush" }) },
  { id: "vn_plant_anthurium", model: "anthurium_botany_01", nodes: ["anthurium_botany_01_a"], lods: PLANT, collision: "none", ...hint("plants", "foliage", 60, "tropical leafy plant for planters and yards", { category: "bush" }) },
  { id: "vn_plant_calathea", model: "calathea_orbifolia_01", nodes: ["calathea_orbifolia_01_a"], lods: SMALL, collision: "none", ...hint("plants", "foliage", 50, "tropical ground plant", { category: "bush", castShadow: false }) },
  { id: "vn_planter_box", model: "planter_box_01", lods: SMALL, collision: "box", ...hint("plants", "wood", 80, "planter box on balconies and rooftops") },
  // Tropical trees and plants (foliage.mjs: source cards up close, baked cards, then impostors).
  ...[
    ["vn_palm_coconut", "palm_straight", 4.2, 1],
    ["vn_palm_coconut_bent", "palm_bend", 4, 1],
    ["vn_palm_coconut_pair", "palm_dual", 4, 2],
    ["vn_palm_coconut_trio", "palm_trio", 4, 3],
  ].map(([id, node, scale, trunks]) => ({
    id,
    model: "vn_palms",
    nodes: [node],
    scale,
    pivot: [0, 0, 0],
    collision: "cylinder",
    foliage: { trunk: ["palm_trunk"], lods: [{ distance: 0, trunk: 340 * trunks, sourceCards: true }, { distance: 50, trunk: 90 * trunks, cards: 30 * trunks }, { distance: 160, impostor: true, trunk: 40 * trunks, trunkBelow: 3 }] },
    ...hint("trees", "wood", 1200, "coconut palm (dừa): canals, riverside, parks, villa gardens", { category: "tree", scaleRange: [0.85, 1.2] }),
  })),
  {
    id: "vn_bamboo_clump",
    model: "vn_bamboo",
    scale: 2,
    ground: "origin",
    collision: "none",
    foliage: { trunk: [], lods: [{ distance: 0, trunk: 0, sourceCards: true }, { distance: 35, trunk: 0, cards: 50 }, { distance: 100, impostor: true }] },
    ...hint("trees", "foliage", 400, "young bamboo clump (tre): alley ends, temple yards, riverbanks", { category: "bush", scaleRange: [0.8, 1.3] }),
  },
  {
    id: "vn_banana_plant",
    model: "vn_palm_plant",
    scale: 1.5,
    ground: "origin",
    collision: "none",
    foliage: { trunk: [], lods: [{ distance: 0, trunk: 0, sourceCards: true }, { distance: 60, impostor: true }] },
    ...hint("plants", "foliage", 250, "2.9 m broad-leaf plant (young banana / bird-of-paradise look, no fruit) in yards, alleys, empty lots", { category: "bush", scaleRange: [0.8, 1.3] }),
  },
  {
    id: "vn_monstera",
    model: "vn_tropical_plant",
    ground: "origin",
    collision: "none",
    foliage: { trunk: [], lods: [{ distance: 0, trunk: 0, sourceCards: true }, { distance: 35, impostor: true }] },
    ...hint("plants", "foliage", 120, "big-leaf tropical ground plant in yards and planters", { category: "bush", scaleRange: [0.8, 1.3] }),
  },
  ...[1, 2, 3, 4, 5].map((n) => ({
    id: `vn_tropical_shrub_${n}`,
    model: "vn_tropical_shrubs",
    nodes: [`trop_shrub_0${n}`],
    ground: "origin",
    collision: "none",
    foliage: { trunk: [], lods: [{ distance: 0, trunk: 0, sourceCards: true }, { distance: 35, impostor: true }] },
    ...hint("plants", "foliage", 140, "tropical shrub (bromeliad, dracaena, fern palm) for yards, medians, parks", { category: "bush", scaleRange: [0.8, 1.3] }),
  })),
  ...["square_palm", "cylinder_bamboo", "square_shrub", "sphere_palm"].map((node) => ({
    id: `vn_planter_${node}`,
    model: "vn_houseplants",
    nodes: [node],
    pivot: [0, 0, 0],
    collision: "cylinder",
    collisionOverride: { kind: "cylinder", radius: 0.28, height: 1 },
    foliage: { trunk: ["planter", "planter_cover"], lods: [{ distance: 0, trunk: 600, sourceCards: true }, { distance: 50, impostor: true, trunk: 120 }] },
    ...hint("plants", "concrete", 200, "tall concrete planter with a plant at shopfronts, office and hotel entrances", { category: "bush" }),
  })),
  // Market food (ambientCG scan): a mango pile for fruit stalls.
  {
    id: "vn_mango_pile",
    model: "vn_mango",
    nodes: [[0, 0, 0, 0], [0.12, 0, 0.03, 70], [-0.1, 0, 0.08, 140], [0.04, 0, -0.12, 200], [-0.07, 0, -0.08, 300], [0.02, 0.1, 0, 30]].map(([x, y, z, yaw]) => ({ name: "mango", translate: [x, y, z], rotate: [0, yaw, 0] })),
    lods: [{ distance: 0, maxTriangles: 1500, flags: ["Permissive"] }, { distance: 10, ratio: 0.25, error: 0.05, flags: ["Permissive"] }],
    collision: "none",
    ...hint("market", "foliage", 30, "mango pile on a fruit stall tray (sạp trái cây)", { castShadow: false }),
  },
];
