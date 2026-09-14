import {
  Color3,
  CreateBoxVertexData,
  CreateSphereVertexData,
  Matrix,
  Mesh,
  Quaternion,
  Vector3,
  type Material,
  type Scene,
  type TransformNode,
  type VertexData,
} from "@babylonjs/core";
import { capsule, extrudeProfile, lathe, roundedBox, type LatheRing, type ProfilePoint } from "./geometry";
import { SURFACES, type Surface } from "./materials";

export type Vec3Tuple = readonly [number, number, number];

const NO_ROTATION: Vec3Tuple = [0, 0, 0];

/**
 * Accumulates parts authored in one model space and builds one mesh per surface (material), with per-part vertex
 * colors, parented to a pivot node. `group()` nests a local transform, e.g. to build a hand in grip-aligned space.
 */
export class MeshKit {
  private readonly parts = new Map<Surface, VertexData[]>();
  private current = Matrix.Identity();

  /** `pivot` is the model-space position of the node the built meshes are parented to. */
  constructor(private readonly pivot: Vec3Tuple = [0, 0, 0]) {}

  group(position: Vec3Tuple, rotation: Vec3Tuple, build: (kit: this) => void): this {
    const previous = this.current;
    this.current = compose(position, rotation).multiply(previous);
    build(this);
    this.current = previous;
    return this;
  }

  box(center: Vec3Tuple, size: Vec3Tuple, color: string, surface: Surface, rotation: Vec3Tuple = NO_ROTATION): this {
    return this.add(CreateBoxVertexData({ width: size[0], height: size[1], depth: size[2] }), center, rotation, color, surface);
  }

  rounded(center: Vec3Tuple, size: Vec3Tuple, radius: number, color: string, surface: Surface, rotation: Vec3Tuple = NO_ROTATION): this {
    return this.add(roundedBox(size, radius), center, rotation, color, surface);
  }

  /** Side silhouette ([z, y] points in model space) extruded to `width`, centered at `x`. */
  profile(points: readonly ProfilePoint[], width: number, bevel: number, color: string, surface: Surface, x = 0): this {
    return this.add(extrudeProfile(points, width, bevel), [x, 0, 0], NO_ROTATION, color, surface);
  }

  /** Turned part around an axis through `center`; ring z values are relative to center, axis +Z before `rotation`. */
  lathe(center: Vec3Tuple, rings: readonly LatheRing[], color: string, surface: Surface, rotation: Vec3Tuple = NO_ROTATION, segments = 18): this {
    return this.add(lathe(rings, segments), center, rotation, color, surface);
  }

  /** Plain closed cylinder along +Z (before `rotation`). */
  cylinder(center: Vec3Tuple, radius: number, length: number, color: string, surface: Surface, rotation: Vec3Tuple = NO_ROTATION, segments = 16): this {
    const h = length / 2;
    const rings: LatheRing[] = [
      [0, -h],
      [radius, -h],
      [radius, h],
      [0, h],
    ];
    return this.lathe(center, rings, color, surface, rotation, segments);
  }

  sphere(center: Vec3Tuple, radius: number, color: string, surface: Surface): this {
    return this.add(CreateSphereVertexData({ diameter: radius * 2, segments: 8 }), center, NO_ROTATION, color, surface);
  }

  /** Capsule spanning two points (fingers, trigger guard loops). */
  capsule(from: Vec3Tuple, to: Vec3Tuple, radius: number, color: string, surface: Surface): this {
    const { center, rotation, length } = span(from, to);
    return this.add(capsule(length + radius * 2, radius), center, rotation, color, surface);
  }

  /** Tapered, capped tube spanning two points (forearms, sleeves). */
  taper(from: Vec3Tuple, to: Vec3Tuple, radiusFrom: number, radiusTo: number, color: string, surface: Surface): this {
    const { center, rotation, length } = span(from, to);
    const h = length / 2;
    const rings: LatheRing[] = [
      [0, -h],
      [radiusFrom * 0.8, -h],
      [radiusFrom, -h + radiusFrom * 0.25],
      [radiusTo, h - radiusTo * 0.25],
      [radiusTo * 0.8, h],
      [0, h],
    ];
    return this.lathe(center, rings, color, surface, rotation, 14);
  }

  build(name: string, scene: Scene, materials: Readonly<Record<Surface, Material>>, parent: TransformNode): Mesh[] {
    const meshes: Mesh[] = [];
    for (const surface of SURFACES) {
      const [first, ...rest] = this.parts.get(surface) ?? [];
      if (!first) continue;
      const merged = rest.length > 0 ? first.merge(rest, true) : first;
      const mesh = new Mesh(`${name}_${surface}`, scene);
      merged.applyToMesh(mesh);
      mesh.material = materials[surface];
      mesh.parent = parent;
      meshes.push(mesh);
    }
    return meshes;
  }

  private add(data: VertexData, center: Vec3Tuple, rotation: Vec3Tuple, color: string, surface: Surface): this {
    const transform = compose(center, rotation).multiply(this.current).multiply(Matrix.Translation(-this.pivot[0], -this.pivot[1], -this.pivot[2]));
    data.transform(transform);
    const vertexCount = (data.positions?.length ?? 0) / 3;
    const rgb = Color3.FromHexString(color);
    const colors = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 4] = rgb.r;
      colors[i * 4 + 1] = rgb.g;
      colors[i * 4 + 2] = rgb.b;
      colors[i * 4 + 3] = 1;
    }
    data.colors = colors;
    // Only positions, normals, colors and indices are used; keeping the set uniform lets parts merge.
    data.uvs = null;
    data.tangents = null;
    let list = this.parts.get(surface);
    if (!list) this.parts.set(surface, (list = []));
    list.push(data);
    return this;
  }
}

function compose(position: Vec3Tuple, rotation: Vec3Tuple): Matrix {
  return Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(rotation[1], rotation[0], rotation[2]), new Vector3(...position));
}

/** Center, orientation (+Z toward `to`) and length of a segment. */
function span(from: Vec3Tuple, to: Vec3Tuple): { center: Vec3Tuple; rotation: Vec3Tuple; length: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  return {
    center: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
    rotation: [-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0],
    length: Math.hypot(dx, dy, dz),
  };
}
