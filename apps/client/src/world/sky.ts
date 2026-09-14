import { Color3, CreateSphere, Mesh, StandardMaterial, VertexBuffer, type Scene } from "@babylonjs/core";

export interface SkyColors {
  readonly zenith: Color3;
  readonly horizon: Color3;
  /** Below the horizon; normally hidden by walls, visible from out of bounds. */
  readonly nadir: Color3;
}

/** Unlit gradient dome following the camera. Colors are baked into vertex colors, so no textures or shaders. */
export function createSkyDome(scene: Scene, colors: SkyColors): Mesh {
  // Big enough to enclose the arena, small enough to survive a modest camera.maxZ.
  const radius = 250;
  const dome = CreateSphere("skyDome", { diameter: radius * 2, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
  dome.infiniteDistance = true;
  dome.applyFog = false;
  dome.isPickable = false;

  const positions = dome.getVerticesData(VertexBuffer.PositionKind) ?? [];
  const vertexColors = new Float32Array((positions.length / 3) * 4);
  const tmp = new Color3();
  for (let v = 0; v < positions.length / 3; v++) {
    const h = (positions[v * 3 + 1] ?? 0) / radius;
    if (h >= 0) Color3.LerpToRef(colors.horizon, colors.zenith, Math.pow(h, 0.55), tmp);
    else Color3.LerpToRef(colors.horizon, colors.nadir, Math.min(1, -h * 4), tmp);
    vertexColors.set([tmp.r, tmp.g, tmp.b, 1], v * 4);
  }
  dome.setVerticesData(VertexBuffer.ColorKind, vertexColors, false, 4);

  const material = new StandardMaterial("mat_sky", scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  dome.material = material;

  return dome;
}
