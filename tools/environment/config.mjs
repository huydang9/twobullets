// Shared configuration for the environment asset pipeline (fetch.mjs → process.mjs).
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Raw Poly Haven downloads (gitignored). */
export const SRC_DIR = path.join(REPO_ROOT, "assets-src/environment");
/** Web-ready outputs served by Vite from /assets/environment/. */
export const OUT_DIR = path.join(REPO_ROOT, "apps/client/public/assets/environment");
/** Props and vegetation GLBs. */
export const PROPS_OUT_DIR = path.join(OUT_DIR, "props");
/** Encoded texture cache for props.mjs (KTX2 encodes are slow). */
export const CACHE_DIR = path.join(SRC_DIR, ".cache");
/** Generated TypeScript manifest consumed by apps/client/src/world. */
export const MANIFEST_TS = path.join(REPO_ROOT, "apps/client/src/world/environmentManifest.ts");

export const POLY_HAVEN_API = "https://api.polyhaven.com";

/**
 * Poly Haven map key → local suffix. `arm` is Poly Haven's packed AO (R) / roughness (G) / metalness (B)
 * texture, which maps 1:1 onto Babylon's PBR metallicTexture channel flags.
 */
export const TEXTURE_MAPS = { Diffuse: "diff", nor_gl: "nor_gl", arm: "arm" };

/** Derived maps and the source maps they are built from. */
export const DERIVED_MAPS = {
  /** Terrain splat layers: normal X (R), normal Y (G), AO (B); Z is reconstructed and roughness is the set mean. */
  nxa: ["nor_gl", "arm"],
};

/**
 * Textures to ship. `sizes` are output resolutions per map (keys: diff, nor_gl, arm, nxa); only the sources those
 * maps need are fetched. `macroOnly` marks a small albedo used for large-scale color variation. `desaturate` stores
 * albedo as luminance so materials can tint it to any paint color. `meters` is the real-world tile size from Poly
 * Haven's scan dimensions.
 */
export const TEXTURES = [
  // Arena and shared surfaces.
  { id: "forrest_ground_01", meters: 2, sizes: { diff: 2048, nor_gl: 1024, arm: 1024 } },
  { id: "aerial_grass_rock", meters: 15, sizes: { diff: 512 }, macroOnly: true },
  { id: "concrete_wall_008", meters: 2.71, sizes: { diff: 2048, nor_gl: 2048, arm: 1024 } },
  { id: "concrete_floor_worn_001", meters: 3, sizes: { diff: 2048, nor_gl: 1024, arm: 1024 } },
  { id: "asphalt_02", meters: 3, sizes: { diff: 1024, nor_gl: 1024, arm: 1024, nxa: 1024 } },
  { id: "weathered_planks", meters: 2, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },
  { id: "corrugated_iron_02", meters: 2.7, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },
  { id: "rusty_metal_02", meters: 1, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },

  // Terrain splat layers (Map v1).
  { id: "sparse_grass", meters: 2, sizes: { diff: 2048, nxa: 1024 } },
  { id: "forest_ground_04", meters: 3.15, sizes: { diff: 1024, nxa: 1024 } },
  { id: "rock_face_03", meters: 2.7, sizes: { diff: 2048, nxa: 1024 } },
  { id: "rocky_trail", meters: 2, sizes: { diff: 1024 } },

  // Buildings kit (Map v1).
  { id: "white_plaster_02", meters: 1, sizes: { diff: 1024, nor_gl: 512, arm: 512 } },
  { id: "painted_plaster_wall", meters: 2, sizes: { diff: 1024, nor_gl: 512, arm: 512 } },
  { id: "damaged_plaster", meters: 1.85, sizes: { diff: 1024, nor_gl: 1024, arm: 512 } },
  { id: "red_brick_03", meters: 1, sizes: { diff: 1024, nor_gl: 1024, arm: 512 } },
  { id: "whitewashed_brick", meters: 2, sizes: { diff: 1024, nor_gl: 1024, arm: 512 } },
  { id: "clay_roof_tiles_02", meters: 2.5, sizes: { diff: 1024, nor_gl: 1024, arm: 512 } },
  { id: "wood_floor_worn", meters: 2, sizes: { diff: 1024, nor_gl: 1024, arm: 512 } },
  { id: "weathered_plank_siding", meters: 1.57, sizes: { diff: 1024, nor_gl: 1024, arm: 512 } },
  { id: "box_profile_metal_sheet", meters: 2, sizes: { diff: 1024, nor_gl: 1024, arm: 512 }, desaturate: true },
  { id: "container_side", meters: 1.94, sizes: { diff: 1024, nor_gl: 1024, arm: 512 }, desaturate: true },
];

/**
 * Poly Haven models, fetched as 1K glTF. `alpha` maps a material to the Poly Haven map key holding its opacity (the
 * glTF exports reference plain JPG albedo, so cutouts are merged into the base color by props.mjs). `meshes` limits a
 * multi-tree file to some meshes; only their byte ranges of the .bin are downloaded.
 */
export const MODELS = [
  { id: "wooden_crate_01" },
  { id: "wooden_crate_02" },
  { id: "wooden_military_crate" },
  { id: "old_military_crate" },
  { id: "ammo_box" },
  { id: "metal_jerrycan_green" },
  { id: "Barrel_01" },
  { id: "barrel_03" },
  { id: "old_tyre" },
  { id: "utility_box_02" },
  { id: "concrete_road_barrier_02" },
  { id: "modular_chainlink_fence", alpha: { modular_chainlink_fence_wire: "wire_alpha" } },
  { id: "covered_car" },
  { id: "dead_tree_trunk_02" },
  { id: "tree_stump_01" },
  { id: "rock_moss_set_01" },
  { id: "rock_moss_set_02" },
  { id: "fern_02", alpha: { fern_02: "Alpha" } },
  { id: "grass_medium_01", alpha: { grass_medium_01: "Alpha" } },
  { id: "searsia_lucida", alpha: { searsia_lucida_leaves: "Alpha", searsia_lucida_twigs: "Alpha" }, atlas: 1024 },
  { id: "fir_sapling_medium", alpha: { fir_sapling_medium_twigs: "twigs_alpha" } },
  { id: "fir_tree_01", meshes: [1], alpha: { fir_tree_01_twig: "twig_alpha" } },
  { id: "tree_small_02", alpha: { tree_small_02_leaves: "leaves_alpha" } },
  { id: "island_tree_01", alpha: { island_tree_01_leaves: "leaves_alpha" } },

  // Cover props and big trees from outside fetch.mjs (external.mjs): Sketchfab GLBs (CC BY 4.0, downloaded 2026-09-15,
  // see assets-src/DOWNLOADS-2026-09-15.md) and Poly Haven 2K glTFs (DOWNLOADS-CC0-2026-09-15.md). `files` merge into
  // one document; `materials` renames/converts/tints by source material name; `credits` go into credits.json.
  {
    id: "oak_trees",
    files: ["large-oak-fungi/large_oak_tree_with_parasitic_fungi.glb", "oak-tree/oak_tree.glb"],
    materials: {
      material0: { name: "oak_fungi_bark", tint: [0.15, 0.125, 0.095] },
      bark: { name: "oak_bark", tint: [0.15, 0.125, 0.095] },
      branches_projection: { name: "oak_leaves", alpha: "mask", tint: [0.075, 0.1, 0.03] },
    },
    credits: [
      sketchfab("large_oak_tree_with_parasitic_fungi", "Large oak tree with parasitic fungi", "ZiemniaQ", "large-oak-tree-with-parasitic-fungi-1a475a11690d4bf5aa1af1850c628fff"),
      sketchfab("oak_tree", "Oak tree", "massive-graphisme", "oak-tree-3dc59560f2d24345bdbe65c44636453b"),
    ],
  },
  {
    id: "mossy_old_tree_log",
    files: ["mossy-log/mossy_old_tree_log.glb"],
    materials: { ForestLogMedium_1: { name: "mossy_log" } },
    credits: [sketchfab("mossy_old_tree_log", "Mossy old tree log", "Julian Malik", "mossy-old-tree-log-c65a00ca4a174653beb4c59cb42b9143")],
  },
  {
    id: "boubin_stump",
    files: ["boubin-stump/boubin_stump.glb"],
    materials: { boubin_stump: { name: "boubin_stump" } },
    credits: [sketchfab("boubin_stump", "Boubín Stump", "3dhdscan", "boubin-stump-b968b5dc462148989cb87b072885da85")],
  },
  {
    id: "destroyed_car_03",
    files: ["destroyed-car-03/destroyed_car_03__backrooms_car_gameready_ver.glb"],
    materials: { caprice_low_Material_u1_v1: { name: "car_wreck" } },
    credits: [sketchfab("destroyed_car_03", "Destroyed Car 03 / Backrooms Car (Gameready ver)", "Renafox", "destroyed-car-03-backrooms-car-gameready-ver-efc4dfe2c7284a64bc9281eb4f61d402")],
  },
  {
    id: "concrete_pipes",
    files: ["concrete-pipes/concrete_pipes_12_mb.glb"],
    materials: { material: { name: "concrete_pipes" } },
    credits: [sketchfab("concrete_pipes_12_mb", "Concrete Pipes_12_MB", "Mehdi Shahsavan", "concrete-pipes-12-mb-7b156401a8aa4f01880618c938a219f9")],
  },
  {
    id: "hay_bales",
    files: ["hay-bales/hay_bales.glb"],
    materials: { hay_bale_texture: { name: "hay_bale" } },
    credits: [sketchfab("hay_bales", "Hay bales", "Zbrojmistrz", "hay-bales-d6e087f9a2a9416c94918f0503943c17")],
  },
  {
    id: "sandbag_barrier",
    files: ["sandbag-barrier/sandbag_barrier_ready_for_unreal_engine.glb"],
    materials: { "Scene_-_Root": { name: "sandbag_barrier" } },
    credits: [sketchfab("sandbag_barrier", "Sandbag Barrier (Ready for Unreal Engine)", "G4AGamingLabs", "sandbag-barrier-ready-for-unreal-engine-593800671c8e45eca93b8b7c765c0f77")],
  },
  {
    id: "cable_spool",
    files: ["cable-spool/cable_spool.glb"],
    // Exported as BLEND with an opaque albedo.
    materials: { CableSpool: { name: "cable_spool", alpha: "opaque" } },
    credits: [sketchfab("cable_spool", "Cable Spool", "wolfgar74", "cable-spool-22ddb8e02f944fb7b5662f14fdc50e5e")],
  },
  {
    id: "rock_face_02",
    files: ["models/rock_face_02/rock_face_02_2k.gltf"],
    credits: [polyHaven("rock_face_02", "Rock Face 02", [["Dario Barresi", "All"], ["Rico Cilliers", "Processing"]])],
  },
  {
    id: "namaqualand_boulder_04",
    files: ["models/namaqualand_boulder_04/namaqualand_boulder_04_2k.gltf"],
    credits: [polyHaven("namaqualand_boulder_04", "Namaqualand Boulder 04", [["Jenelle van Heerden", "All"]])],
  },
];

function sketchfab(id, name, author, slug) {
  return { id, name, type: "model", authors: [{ name: author, role: "All" }], license: "CC-BY-4.0", url: `https://sketchfab.com/3d-models/${slug}` };
}

function polyHaven(id, name, authors) {
  return {
    id,
    name,
    type: "model",
    authors: authors.map(([author, role]) => ({ name: author, role })),
    license: "CC0",
    url: `https://polyhaven.com/a/${id}`,
    sourceFiles: [`https://dl.polyhaven.org/file/ph-assets/Models/gltf/2k/${id}/${id}_2k.gltf`],
  };
}

/**
 * Props built by props.mjs, one GLB per source model (props sharing a model share its file and textures).
 *
 * - `nodes`: source node names (default: every mesh node), each optionally offset with `translate` (source units).
 * - `rotate` (degrees XYZ) and `scale` are applied after the node transforms; the result is re-centered on XZ and
 *   grounded at its lowest point (`ground: "min"`) or kept at the source origin (`"origin"`, for embedded rocks/roots).
 * - `lods`: `{ distance, maxTriangles }` for LOD0, `{ distance, ratio, error }` for simplified levels (ratio of LOD0).
 * - `collision`: shape kind; dimensions are measured from LOD0.
 * - `foliage`: vegetation built by foliage.mjs (clustered cards + impostor) instead of plain simplification.
 */
const SMALL = [{ distance: 0, maxTriangles: 1500 }, { distance: 12, ratio: 0.3, error: 0.02 }];
const PROP = [{ distance: 0, maxTriangles: 5000 }, { distance: 25, ratio: 0.25, error: 0.03 }];
const LARGE = [{ distance: 0, maxTriangles: 8000 }, { distance: 35, ratio: 0.25, error: 0.02 }, { distance: 110, ratio: 0.06, error: 0.08 }];
const ROCK = [{ distance: 0, maxTriangles: 4000 }, { distance: 30, ratio: 0.25, error: 0.02 }, { distance: 100, ratio: 0.05, error: 0.1 }];
/** Cover never culls in the map (vegetation-stability.md): the last level is a cheap real mesh, a few hundred triangles. */
// `Permissive` (meshoptimizer) collapses across UV seams; scans and game-ready meshes are split at every seam and
// otherwise stall far above the target. `flags` on a level are passed to the simplifier.
const COVER = [{ distance: 0, maxTriangles: 8000 }, { distance: 35, ratio: 0.25, error: 0.02 }, { distance: 110, ratio: 0.06, error: 0.08, flags: ["Permissive"] }];
const BIG_ROCK = [{ distance: 0, maxTriangles: 8000 }, { distance: 40, ratio: 0.25, error: 0.02 }, { distance: 130, ratio: 0.05, error: 0.1, flags: ["Permissive"] }];

/** Loose straws are separate two-triangle islands: far levels prune them. */
const HAY = [{ distance: 0, maxTriangles: 8000 }, { distance: 30, ratio: 0.25, error: 0.03, flags: ["Prune", "Permissive"] }, { distance: 100, ratio: 0.06, error: 0.1, flags: ["Permissive"] }];

/** One of the two small square bales in hay_bales.glb (0.93 × 0.39 × 0.47 m), moved and turned into a stack slot. */
const bale = (which, [x, y, z], yaw = 0) => {
  // Bale "a" is centered at z = 0.435, "b" at z = -0.445; rotate first, then move that center to the slot.
  const cz = which === "a" ? 0.435 : -0.445;
  const [rx, rz] = yaw === 90 ? [cz, 0] : [0, cz];
  return {
    name: "Object_2",
    crop: which === "a" ? { min: [-1, -1, 0], max: [1, 1, 1] } : { min: [-1, -1, -1], max: [1, 1, 0] },
    rotate: [0, yaw, 0],
    translate: [x - rx, y, z - rz],
  };
};

/** [suffix, source x of the node, patch x, patch z] → node specs that move each tuft from its source slot into a patch. */
const grassPatch = (tufts) => tufts.map(([suffix, sourceX, x, z]) => ({ name: `grass_medium_01_${suffix}_LOD0`, translate: [x - sourceX, 0, z] }));

export const PROPS = [
  { id: "crate_wood_a", model: "wooden_crate_01", lods: SMALL, collision: "box" },
  { id: "crate_wood_b", model: "wooden_crate_02", lods: SMALL, collision: "box" },
  { id: "crate_military", model: "wooden_military_crate", lods: PROP, collision: "box" },
  {
    id: "crate_military_long",
    model: "old_military_crate",
    nodes: ["old_military_crate_a", "old_military_crate_lid_a", "old_military_crate_loop_a", "old_military_crate_latch_a", "old_military_crate_cloth_a"],
    lods: SMALL,
    collision: "box",
  },
  { id: "ammo_box", model: "ammo_box", lods: [{ distance: 0, maxTriangles: 800 }, { distance: 8, ratio: 0.25, error: 0.03 }], collision: "box" },
  { id: "jerrycan", model: "metal_jerrycan_green", lods: SMALL, collision: "box" },
  { id: "barrel_metal", model: "Barrel_01", lods: SMALL, collision: "cylinder" },
  { id: "barrel_rusty", model: "barrel_03", lods: SMALL, collision: "cylinder" },
  { id: "tyre", model: "old_tyre", rotate: [90, 0, 0], lods: SMALL, collision: "cylinder" },
  { id: "utility_box", model: "utility_box_02", lods: PROP, collision: "box" },
  { id: "road_barrier", model: "concrete_road_barrier_02", lods: LARGE, collision: "convexHull" },
  {
    id: "fence_chainlink",
    model: "modular_chainlink_fence",
    nodes: ["modular_chainlink_fence_double", { name: "modular_chainlink_post_middle", translate: [-1, 0, 1] }],
    lods: PROP,
    collision: "box",
  },
  { id: "car_covered", model: "covered_car", lods: LARGE, collision: "convexHull" },
  { id: "log_fallen", model: "dead_tree_trunk_02", ground: "origin", lods: LARGE, collision: "convexHull" },
  { id: "tree_stump", model: "tree_stump_01", ground: "origin", lods: LARGE, collision: "cylinder" },

  { id: "rock_boulder_a", model: "rock_moss_set_01", nodes: ["rock_moss_set_01_rock02"], ground: "origin", lods: ROCK, collision: "convexHull" },
  { id: "rock_boulder_b", model: "rock_moss_set_01", nodes: ["rock_moss_set_01_rock04"], ground: "origin", lods: ROCK, collision: "convexHull" },
  { id: "rock_moss_a", model: "rock_moss_set_02", nodes: ["rock_moss_set_02_rock11"], ground: "origin", lods: ROCK, collision: "convexHull" },
  { id: "rock_moss_b", model: "rock_moss_set_02", nodes: ["rock_moss_set_02_rock12"], ground: "origin", lods: ROCK, collision: "convexHull" },
  { id: "rock_small", model: "rock_moss_set_02", nodes: ["rock_moss_set_02_rock08"], ground: "origin", lods: ROCK, collision: "convexHull" },

  // Poly Haven's grass clumps are 15-30 cm tufts; each prop composes several (offsets cancel the source layout row).
  {
    id: "grass_clump_short",
    model: "grass_medium_01",
    nodes: grassPatch([["small_a", 0, 0, 0], ["small_b", 0.4, 0.2, 0.08], ["mid_c", -0.4, -0.16, 0.14], ["small_a", 0, 0.12, -0.2], ["tiny_a", 2.2, -0.2, -0.05]]),
    ground: "origin",
    lods: [{ distance: 0, maxTriangles: 700, thin: true }],
    collision: "none",
  },
  {
    id: "grass_clump_medium",
    model: "grass_medium_01",
    nodes: grassPatch([["large_c", -1.6, 0, 0], ["mid_a", -1.2, 0.26, 0.12], ["mid_b", -0.8, -0.24, 0.16], ["tall_b", 1.2, 0.06, -0.26], ["small_b", 0.4, -0.2, -0.2]]),
    ground: "origin",
    lods: [{ distance: 0, maxTriangles: 1000, thin: true }, { distance: 20, ratio: 0.4, thin: true }],
    collision: "none",
  },
  {
    id: "grass_clump_tall",
    model: "grass_medium_01",
    nodes: grassPatch([["tall_a", 0.8, 0, 0], ["tall_b", 1.2, 0.14, 0.1], ["tall_c", 1.6, -0.12, 0.13], ["mid_a", -1.2, 0.05, -0.17], ["tall_a", 0.8, -0.16, -0.1], ["tall_c", 1.6, 0.2, -0.12]]),
    ground: "origin",
    lods: [{ distance: 0, maxTriangles: 900, thin: true }, { distance: 20, ratio: 0.45, thin: true }],
    collision: "none",
  },
  { id: "fern", model: "fern_02", nodes: ["fern_02_b"], ground: "origin", lods: [{ distance: 0, maxTriangles: 2400 }, { distance: 25, ratio: 0.35, error: 0.05 }], collision: "none" },

  // Vegetation (foliage.mjs): trunk kept as geometry, everything else baked to cards, impostor far level.
  {
    id: "tree_fir_a",
    model: "fir_tree_01",
    nodes: ["fir_tree_01_b_LOD0"],
    ground: "origin",
    collision: "cylinder",
    foliage: { trunk: ["fir_tree_01_trunk_b"], lods: [{ distance: 0, trunk: 2500, cards: 450 }, { distance: 45, trunk: 400, cards: 70 }, { distance: 140, impostor: true }] },
  },
  {
    id: "tree_fir_b",
    model: "fir_sapling_medium",
    nodes: ["fir_sapling_medium_a_LOD0"],
    ground: "origin",
    collision: "cylinder",
    foliage: { trunk: ["fir_sapling_medium_branches"], lods: [{ distance: 0, trunk: 1500, cards: 180 }, { distance: 35, trunk: 250, cards: 45 }, { distance: 110, impostor: true }] },
  },
  {
    id: "tree_fir_young",
    model: "fir_sapling_medium",
    nodes: ["fir_sapling_medium_c_LOD0"],
    ground: "origin",
    collision: "cylinder",
    foliage: { trunk: ["fir_sapling_medium_branches"], lods: [{ distance: 0, trunk: 1000, cards: 120 }, { distance: 30, trunk: 200, cards: 30 }, { distance: 90, impostor: true }] },
  },
  {
    id: "tree_broadleaf_a",
    model: "tree_small_02",
    scale: 1.7,
    ground: "origin",
    collision: "cylinder",
    foliage: { trunk: ["tree_small_02_trunk"], lods: [{ distance: 0, trunk: 2500, cards: 420 }, { distance: 40, trunk: 400, cards: 60 }, { distance: 130, impostor: true }] },
  },
  {
    id: "tree_broadleaf_b",
    model: "island_tree_01",
    scale: 1.5,
    ground: "origin",
    collision: "cylinder",
    foliage: { trunk: ["island_tree_01"], lods: [{ distance: 0, trunk: 3000, cards: 420 }, { distance: 40, trunk: 500, cards: 70 }, { distance: 130, impostor: true }] },
  },
  // Big trees (oak_trees.glb). A 12 m open-grown oak, and the fungi-covered photogrammetry trunk (6 m) carrying the
  // oak's upper limbs and crown: the oak is cut below its fork and scaled so its trunk meets the scan's top. Beyond the
  // impostor distance a simplified trunk stays a real mesh under the impostor quads, since trunks are cover.
  {
    id: "tree_oak_large",
    model: "oak_trees",
    nodes: ["Object_3", "Object_4"],
    pivot: [-25900, -45243, 0],
    scale: 3.12e-4,
    collision: "cylinder",
    foliage: { trunk: ["oak_bark"], lods: [{ distance: 0, trunk: 5800, sourceCards: true }, { distance: 45, trunk: 1200, cards: 80 }, { distance: 150, impostor: true, trunk: 150, trunkBelow: 3.5 }] },
  },
  {
    id: "tree_oak_fungi",
    model: "oak_trees",
    nodes: [
      { name: "Model_material0_0", scale: 1.2, translate: [0, 0, -0.06] },
      { name: "Object_4", clipBelow: -37000, scale: 1.84e-4, translate: [4.449, 12.408, 0.256] },
      { name: "Object_3", clipBelow: -37500, scale: 1.84e-4, translate: [4.449, 12.408, 0.256] },
    ],
    pivot: [0, 0, 0],
    // The scan's leaf-litter disc and root mound sit below y = 0 (under the terrain); drop the disc outside the flare.
    trim: { radius: 0.9, below: -0.02 },
    collision: "cylinder",
    foliage: {
      trunk: ["oak_fungi_bark", "oak_bark"],
      lods: [{ distance: 0, trunk: 8500, sourceCards: true }, { distance: 45, trunk: 1500, cards: 60 }, { distance: 150, impostor: true, trunk: 200, trunkBelow: 5.5 }],
    },
  },

  // Cover props (Sketchfab CC BY 4.0, Poly Haven 2K).
  { id: "log_mossy", model: "mossy_old_tree_log", scale: 2.3, lods: COVER, collision: "convexHull" },
  // The scan stands on a ~15° slope: pivot on the trunk axis at the uphill ground, skirt trimmed to the root flare.
  { id: "stump_boubin", model: "boubin_stump", pivot: [-7, -1, -5], scale: 0.085, trim: { radius: 1.9, below: 0.4 }, lods: COVER, collision: "cylinder" },
  {
    id: "car_wreck",
    model: "destroyed_car_03",
    rotate: [0, 90, 0],
    scale: 1.65,
    // Seams everywhere (thin torn panels): LOD1 needs Permissive and holds up from 50 m.
    lods: [COVER[0], { ...COVER[1], distance: 50, flags: ["Permissive"] }, COVER[2]],
    collision: "convexHull",
  },
  // 22 stacked 0.3 m drainage pipes between four posts (not a walk-through culvert).
  { id: "pipe_stack", model: "concrete_pipes", ground: "origin", lods: COVER, collision: "box" },
  {
    id: "hay_bale_stack",
    model: "hay_bales",
    // Three layers of two bales, the middle layer crosswise: 0.94 × 1.16 × 0.94 m.
    nodes: [
      bale("a", [0, 0, -0.235]), bale("b", [0.03, 0, 0.235]),
      bale("b", [-0.235, 0.385, 0.02], 90), bale("a", [0.235, 0.385, 0], 90),
      bale("b", [-0.02, 0.77, -0.235]), bale("a", [0.01, 0.77, 0.235]),
    ],
    // Relative errors scale with the prop's extent; the compact stack needs a larger one to prune the straws.
    lods: [HAY[0], { ...HAY[1], error: 0.1 }, HAY[2]],
    collision: "box",
  },
  {
    id: "hay_bale_wall",
    model: "hay_bales",
    // Three layers of three bales end to end, middle layer offset: 2.9 × 1.16 × 0.47 m.
    nodes: [
      bale("a", [-0.94, 0, 0]), bale("b", [0, 0, 0.01]), bale("a", [0.94, 0, 0]),
      bale("b", [-0.84, 0.385, 0]), bale("a", [0.1, 0.385, -0.01]), bale("b", [1.04, 0.385, 0]),
      bale("a", [-0.97, 0.77, 0.01]), bale("b", [-0.02, 0.77, 0]), bale("a", [0.92, 0.77, 0]),
    ],
    lods: HAY,
    collision: "box",
  },
  { id: "sandbag_barrier", model: "sandbag_barrier", lods: COVER, collision: "box" },
  // A 0.89 m spool scaled to a 1.4 m drum, standing on a flange.
  { id: "cable_spool", model: "cable_spool", scale: 0.0158, lods: [{ distance: 0, maxTriangles: 8000 }, { distance: 25, ratio: 0.3, error: 0.02, flags: ["Permissive"] }, { distance: 90, ratio: 0.12, error: 0.08, flags: ["Permissive"] }], collision: "cylinder" },
  // rock_face_02 is an open scanned surface (no back): place it with its back into a slope or cliff.
  { id: "rock_face_large", model: "rock_face_02", scale: 1.6, lods: [{ distance: 0, maxTriangles: 12000 }, { distance: 40, ratio: 0.25, error: 0.02 }, { distance: 130, ratio: 0.05, error: 0.1 }], collision: "box" },
  { id: "rock_boulder_large", model: "namaqualand_boulder_04", ground: "origin", lods: BIG_ROCK, collision: "convexHull" },

  ...[
    ["bush_a", "searsia_lucida_b_LOD0", 90],
    ["bush_b", "searsia_lucida_d_LOD0", 60],
    ["bush_c", "searsia_lucida_a_LOD0", 110],
  ].map(([id, node, cards]) => ({
    id,
    model: "searsia_lucida",
    nodes: [node],
    ground: "origin",
    collision: "none",
    foliage: { trunk: [], lods: [{ distance: 0, trunk: 0, cards }, { distance: 30, trunk: 0, cards: Math.round(cards / 4) }, { distance: 80, impostor: true }] },
  })),
];

/** Per-model texture limits (default { baseColor: 1024, normal: 512, orm: 512 }). */
export const MODEL_TEXTURES = {
  ammo_box: { baseColor: 512, normal: 256, orm: 256 },
  metal_jerrycan_green: { baseColor: 512, normal: 256, orm: 256 },
  rock_moss_set_01: { baseColor: 1024, normal: 1024, orm: 512 },
  rock_moss_set_02: { baseColor: 1024, normal: 1024, orm: 512 },
  // Card atlases are 2K; trunks keep 1K color.
  fir_tree_01: { baseColor: 2048, normal: 512, orm: 256 },
  fir_sapling_medium: { baseColor: 2048, normal: 512, orm: 256 },
  tree_small_02: { baseColor: 2048, normal: 512, orm: 256 },
  island_tree_01: { baseColor: 2048, normal: 512, orm: 256 },
  searsia_lucida: { baseColor: 1024, normal: 256, orm: 256 },
  // 2K: the fungi trunk scan and the card atlas; the oak's painted bark stays 1K. `materials` limits win per material.
  oak_trees: { baseColor: 2048, normal: 1024, orm: 512, materials: { oak_bark: { baseColor: 1024, normal: 512 }, oak_leaves: { baseColor: 1024 } } },
  boubin_stump: { baseColor: 1024, normal: 1024, orm: 512 },
  destroyed_car_03: { baseColor: 1024, normal: 1024, orm: 512 },
  rock_face_02: { baseColor: 2048, normal: 1024, orm: 512 },
  namaqualand_boulder_04: { baseColor: 1024, normal: 1024, orm: 512 },
};

export const HDRI = {
  id: "kloofendal_48d_partly_cloudy_puresky",
  /** Source resolution; the sky faces are cut from it, the IBL panorama is downsampled from it. */
  resolution: "4k",
  /** Output sky cube face size (4K panorama ≈ 1024 px per 90°). */
  skyFaceSize: 1024,
  /** Output IBL panorama width (height = width / 2). */
  iblWidth: 1024,
  /**
   * Rotate the panorama so the sun sits at this azimuth, measured like SpawnPoint.yaw
   * (0 = +Z north, π/2 = +X east). −125° puts it south-west, behind the first spawn.
   */
  sunAzimuthDeg: -125,
  /**
   * Exposure calibration: after normalization, a horizontal sunlit Lambertian surface receives
   * (E_sun·cosθ + E_sky) / π = this value, so exposure 1.0 lands ~18% albedo near mid-grey with ACES.
   */
  horizontalRadianceTarget: 1.6,
};

/** JPEG qualities. Albedo tolerates 4:2:0 chroma; data maps (normal, ARM) are encoded 4:4:4. */
export const JPEG = { albedoQuality: 82, dataQscale: 3, skyQuality: 88 };
