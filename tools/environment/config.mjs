// Shared configuration for the environment asset pipeline (fetch.mjs → process.mjs).
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Raw Poly Haven downloads (gitignored). */
export const SRC_DIR = path.join(REPO_ROOT, "assets-src/environment");
/** Web-ready outputs served by Vite from /assets/environment/. */
export const OUT_DIR = path.join(REPO_ROOT, "apps/client/public/assets/environment");
/** Generated TypeScript manifest consumed by apps/client/src/world. */
export const MANIFEST_TS = path.join(REPO_ROOT, "apps/client/src/world/environmentManifest.ts");

export const POLY_HAVEN_API = "https://api.polyhaven.com";

/**
 * Poly Haven map key → local suffix. `arm` is Poly Haven's packed AO (R) / roughness (G) / metalness (B)
 * texture, which maps 1:1 onto Babylon's PBR metallicTexture channel flags.
 */
export const TEXTURE_MAPS = { Diffuse: "diff", nor_gl: "nor_gl", arm: "arm" };

/**
 * Textures to ship. `sizes` are output resolutions per map; `macroOnly` ships a small albedo used for
 * large-scale color variation. `meters` is the real-world tile size from Poly Haven's scan dimensions.
 */
export const TEXTURES = [
  { id: "forrest_ground_01", meters: 2, sizes: { diff: 2048, nor_gl: 1024, arm: 1024 } },
  { id: "aerial_grass_rock", meters: 15, sizes: { diff: 512 }, macroOnly: true },
  { id: "concrete_wall_008", meters: 2.71, sizes: { diff: 2048, nor_gl: 2048, arm: 1024 } },
  { id: "concrete_floor_worn_001", meters: 3, sizes: { diff: 2048, nor_gl: 1024, arm: 1024 } },
  { id: "asphalt_02", meters: 3, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },
  { id: "weathered_planks", meters: 2, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },
  { id: "corrugated_iron_02", meters: 2.7, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },
  { id: "rusty_metal_02", meters: 1, sizes: { diff: 1024, nor_gl: 1024, arm: 1024 } },
];

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
