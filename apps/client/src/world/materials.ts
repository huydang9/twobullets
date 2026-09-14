import { Color3, DynamicTexture, StandardMaterial, Texture, VertexBuffer, type Mesh, type Scene } from "@babylonjs/core";
import type { SurfaceKind } from "@twobullets/shared";

/** Flat, saturated blockout palette (sRGB hex). Kinds with several entries pick a variant per mesh. */
const PALETTE: Record<SurfaceKind, readonly string[]> = {
  ground: ["#dccfb2"],
  wall: ["#46b1d6"],
  platform: ["#9a86e8"],
  ramp: ["#ffc93c"],
  cover: ["#ff8a3d", "#ef476f", "#2ec4b6"],
  accent: ["#3d5afe"],
};

/** Grid tile size in meters; the texture holds a 2 × 2 checker of 1 m cells. */
const GRID_TILE_METERS = 2;

/** Vertex brightness at the bottom of a mesh, fading to 1 at its top: cheap fake ambient occlusion. */
const BOTTOM_SHADE = 0.8;
/** Max per-mesh brightness jitter (±), so repeated props don't look copy-pasted. */
const BRIGHTNESS_JITTER = 0.04;

export class LevelMaterials {
  private readonly materials: Record<SurfaceKind, readonly StandardMaterial[]>;

  constructor(scene: Scene) {
    const grid = createGridTexture(scene);
    const build = (kind: SurfaceKind) =>
      PALETTE[kind].map((hex, i) => {
        const mat = new StandardMaterial(`mat_${kind}_${i}`, scene);
        mat.diffuseColor = Color3.FromHexString(hex);
        mat.diffuseTexture = grid;
        mat.specularColor = new Color3(0.06, 0.06, 0.06);
        mat.specularPower = 48;
        return mat;
      });
    this.materials = {
      ground: build("ground"),
      wall: build("wall"),
      platform: build("platform"),
      ramp: build("ramp"),
      cover: build("cover"),
      accent: build("accent"),
    };
  }

  apply(mesh: Mesh, kind: SurfaceKind): void {
    const variants = this.materials[kind];
    const hash = hashString(mesh.name);
    mesh.material = variants[hash % variants.length] ?? null;
    applyVertexShading(mesh, 1 + (((hash >>> 8) % 1000) / 999 - 0.5) * 2 * BRIGHTNESS_JITTER);
  }
}

/** White-based tile multiplied by each material's diffuse color, so one texture serves every surface. */
function createGridTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const half = size / 2;
  const line = 3;
  const texture = new DynamicTexture("tex_blockoutGrid", { width: size, height: size }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = texture.getContext();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#ededed";
  ctx.fillRect(0, 0, half, half);
  ctx.fillRect(half, half, half, half);
  // Lines on tile edges are split across both sides so they stay seamless when wrapped.
  ctx.fillStyle = "#cdcdcd";
  for (const at of [0, half, size]) {
    ctx.fillRect(at - line, 0, line * 2, size);
    ctx.fillRect(0, at - line, size, line * 2);
  }
  texture.update();
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = 1 / GRID_TILE_METERS;
  texture.vScale = 1 / GRID_TILE_METERS;
  texture.anisotropicFilteringLevel = 8;
  return texture;
}

function applyVertexShading(mesh: Mesh, brightness: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const { minimum, maximum } = mesh.getBoundingInfo().boundingBox;
  const height = Math.max(maximum.y - minimum.y, 1e-3);
  const colors = new Float32Array((positions.length / 3) * 4);
  for (let v = 0; v < positions.length / 3; v++) {
    const t = ((positions[v * 3 + 1] ?? 0) - minimum.y) / height;
    const shade = (BOTTOM_SHADE + (1 - BOTTOM_SHADE) * t) * brightness;
    colors.set([shade, shade, shade, 1], v * 4);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
}

/** FNV-1a, for stable per-mesh variation derived from mesh names. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
