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
];

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
