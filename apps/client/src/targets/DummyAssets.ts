import {
  Color3,
  CreateBoxVertexData,
  CreateCylinderVertexData,
  Matrix,
  Mesh,
  StandardMaterial,
  type Scene,
  type VertexData,
} from "@babylonjs/core";
import type { Vec3Tuple } from "@twobullets/shared";
import { HUMANOID_PARTS, type Piece, type Tint } from "./humanoid";

export type DummyScheme = "static" | "strafe";

/** Flat, saturated colors in the level palette's style (sRGB hex). Strafers get their own team color. */
const SCHEME_COLORS: Record<DummyScheme, Record<Tint, string>> = {
  static: { team: "#ff4757", dark: "#2a2d3e", visor: "#6af2ff" },
  strafe: { team: "#ffb020", dark: "#2a2d3e", visor: "#6af2ff" },
};
const STAND_COLORS = { plate: "#3a3f55", ring: "#ffd23f" };

/** Top of the stand the dummy's feet rest on, m. */
export const STAND_HEIGHT = 0.06;
const STAND_DIAMETER = 0.9;

/**
 * Materials and geometry shared by every dummy. Parts are vertex-colored, so one material covers all schemes and
 * one flash material (emissive, multiplied by the vertex colors) brightens whichever part was hit.
 */
export class DummyAssets {
  readonly material: StandardMaterial;
  readonly flashMaterial: StandardMaterial;
  private readonly templates = new Map<string, Mesh>();

  constructor(private readonly scene: Scene) {
    this.material = new StandardMaterial("mat_dummy", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = new Color3(0.08, 0.08, 0.08);
    this.material.specularPower = 32;

    this.flashMaterial = new StandardMaterial("mat_dummyFlash", scene);
    this.flashMaterial.diffuseColor = Color3.White();
    this.flashMaterial.emissiveColor = new Color3(0.85, 0.85, 0.85);
    this.flashMaterial.specularColor = Color3.Black();

    for (const scheme of Object.keys(SCHEME_COLORS) as DummyScheme[]) {
      for (const part of HUMANOID_PARTS) {
        this.addTemplate(`${scheme}_${part.name}`, mergePieces(part.pieces, SCHEME_COLORS[scheme]));
      }
    }
    this.addTemplate("stand", standVertexData());
  }

  /** New mesh sharing a template's geometry. */
  createPart(scheme: DummyScheme, partName: string, name: string): Mesh {
    return this.instantiate(`${scheme}_${partName}`, name);
  }

  createStand(name: string): Mesh {
    return this.instantiate("stand", name);
  }

  dispose(): void {
    for (const template of this.templates.values()) template.dispose();
    this.templates.clear();
    this.material.dispose();
    this.flashMaterial.dispose();
  }

  private addTemplate(key: string, data: VertexData): void {
    const mesh = new Mesh(`dummyTemplate_${key}`, this.scene);
    data.applyToMesh(mesh);
    mesh.convertToFlatShadedMesh();
    mesh.material = this.material;
    mesh.setEnabled(false);
    mesh.isPickable = false;
    this.templates.set(key, mesh);
  }

  private instantiate(key: string, name: string): Mesh {
    const template = this.templates.get(key);
    if (!template) throw new Error(`Unknown dummy template "${key}"`);
    const mesh = template.clone(name, null, true);
    mesh.setEnabled(true);
    return mesh;
  }
}

function mergePieces(pieces: readonly Piece[], colors: Record<Tint, string>): VertexData {
  const parts = pieces.map((piece) => {
    const [width, height, depth] = piece.size;
    return colorize(translate(CreateBoxVertexData({ width, height, depth }), piece.at), colors[piece.tint]);
  });
  const [first, ...rest] = parts;
  if (!first) throw new Error("Dummy part has no pieces");
  return rest.length ? first.merge(rest) : first;
}

function standVertexData(): VertexData {
  const plate = CreateCylinderVertexData({ diameter: STAND_DIAMETER, height: STAND_HEIGHT - 0.012, tessellation: 10 });
  const ring = CreateCylinderVertexData({ diameter: STAND_DIAMETER * 0.8, height: 0.012, tessellation: 10 });
  translate(plate, [0, (STAND_HEIGHT - 0.012) / 2, 0]);
  translate(ring, [0, STAND_HEIGHT - 0.006, 0]);
  return colorize(plate, STAND_COLORS.plate).merge(colorize(ring, STAND_COLORS.ring));
}

function translate(data: VertexData, [x, y, z]: Vec3Tuple): VertexData {
  return data.transform(Matrix.Translation(x, y, z));
}

function colorize(data: VertexData, hex: string): VertexData {
  const { r, g, b } = Color3.FromHexString(hex);
  const count = (data.positions?.length ?? 0) / 3;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([r, g, b, 1], i * 4);
  data.colors = colors;
  return data;
}
