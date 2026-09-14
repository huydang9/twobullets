import { Color3, Constants, RawCubeTexture, StandardMaterial, Texture, Vector3, type Scene } from "@babylonjs/core";

/** Physical finish of a viewmodel part; each gets one material, and per-part color comes from vertex colors. */
export type Surface = "metal" | "polymer" | "rubber" | "fabric" | "glove" | "glass" | "glow";

export const SURFACES: readonly Surface[] = ["metal", "polymer", "rubber", "fabric", "glove", "glass", "glow"];

export interface ViewmodelMaterials {
  readonly bySurface: Readonly<Record<Surface, StandardMaterial>>;
  dispose(): void;
}

const REFLECTION_SIZE = 16;

/**
 * Lit materials tuned for a grounded, realistic look: blued/anodized metal with a faint sky reflection and tight
 * highlights, matte polymer, soft fabric. All disable fog (the gun is centimeters from the eye).
 */
export function createViewmodelMaterials(scene: Scene): ViewmodelMaterials {
  const reflection = createSkyReflection(scene);

  const make = (surface: Surface, specular: number, power: number, emissive: number): StandardMaterial => {
    const material = new StandardMaterial(`vm_${surface}`, scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(specular, specular, specular);
    material.specularPower = power;
    // A low emissive floor (multiplied by vertex color) stops shadowed sides from going pitch black.
    material.emissiveColor = new Color3(emissive, emissive, emissive);
    material.fogEnabled = false;
    return material;
  };

  const metal = make("metal", 0.55, 72, 0.07);
  metal.reflectionTexture = reflection;
  const polymer = make("polymer", 0.16, 18, 0.08);
  const rubber = make("rubber", 0.05, 8, 0.08);
  const fabric = make("fabric", 0.02, 4, 0.12);
  const glove = make("glove", 0.1, 12, 0.1);
  const glass = make("glass", 1, 128, 0.05);
  glass.reflectionTexture = reflection;

  const glow = new StandardMaterial("vm_glow", scene);
  glow.disableLighting = true;
  glow.diffuseColor = Color3.Black();
  glow.specularColor = Color3.Black();
  glow.emissiveColor = Color3.White();
  glow.fogEnabled = false;

  const bySurface: Record<Surface, StandardMaterial> = { metal, polymer, rubber, fabric, glove, glass, glow };
  return {
    bySurface,
    dispose() {
      for (const surface of SURFACES) bySurface[surface].dispose();
      reflection.dispose();
    },
  };
}

/** Tiny procedural sky/ground cube map so metal picks up a believable sheen without an environment texture. */
function createSkyReflection(scene: Scene): RawCubeTexture {
  // Face order +X, -X, +Y, -Y, +Z, -Z; per face the world axes that texel columns/rows advance along.
  const faces: readonly (readonly [Vector3, Vector3, Vector3])[] = [
    [new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0)],
    [new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0)],
    [new Vector3(0, 1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1)],
    [new Vector3(0, -1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, -1)],
    [new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, -1, 0)],
    [new Vector3(0, 0, -1), new Vector3(-1, 0, 0), new Vector3(0, -1, 0)],
  ];
  const sky = Color3.FromHexString("#9fc6e6");
  const horizon = Color3.FromHexString("#e8e2d4");
  const ground = Color3.FromHexString("#3a342c");
  const color = new Color3();
  const direction = new Vector3();
  const data = faces.map(([normal, uAxis, vAxis]) => {
    const pixels = new Uint8Array(REFLECTION_SIZE * REFLECTION_SIZE * 4);
    for (let row = 0; row < REFLECTION_SIZE; row++) {
      for (let col = 0; col < REFLECTION_SIZE; col++) {
        const u = ((col + 0.5) / REFLECTION_SIZE) * 2 - 1;
        const v = ((row + 0.5) / REFLECTION_SIZE) * 2 - 1;
        direction.set(normal.x + uAxis.x * u + vAxis.x * v, normal.y + uAxis.y * u + vAxis.y * v, normal.z + uAxis.z * u + vAxis.z * v);
        direction.normalize();
        const elevation = direction.y;
        if (elevation >= 0) Color3.LerpToRef(horizon, sky, Math.pow(elevation, 0.6), color);
        else Color3.LerpToRef(horizon, ground, Math.min(1, -elevation * 3), color);
        const o = (row * REFLECTION_SIZE + col) * 4;
        pixels[o] = color.r * 255;
        pixels[o + 1] = color.g * 255;
        pixels[o + 2] = color.b * 255;
        pixels[o + 3] = 255;
      }
    }
    return pixels;
  });
  const texture = new RawCubeTexture(
    scene,
    data,
    REFLECTION_SIZE,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  texture.level = 0.22;
  return texture;
}
