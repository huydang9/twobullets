import { Mesh, PhysicsAggregate, PhysicsShapeType, Quaternion, Vector3, VertexData, type Scene } from "@babylonjs/core";
import type { LevelBlock, LevelData, SurfaceKind, Vec3Tuple } from "./types";

export interface BuiltLevel {
  readonly meshes: readonly Mesh[];
  /** Surface kind per mesh, so the client can assign materials. Absent on headless servers is fine. */
  readonly surfaceOf: ReadonlyMap<Mesh, SurfaceKind>;
}

/**
 * Creates level geometry and static physics bodies. Must stay render-agnostic
 * (no materials, lights or textures) so a headless NullEngine server can call it.
 * Requires physics to be enabled on the scene first.
 */
export function buildLevel(scene: Scene, level: LevelData): BuiltLevel {
  const meshes: Mesh[] = [];
  const surfaceOf = new Map<Mesh, SurfaceKind>();

  level.blocks.forEach((block, i) => {
    const mesh = new Mesh(`level_${block.name ?? `${block.surface}_${block.kind}_${i}`}`, scene);
    blockVertexData(block).applyToMesh(mesh);
    mesh.position.set(...block.position);
    mesh.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), block.rotationY ?? 0);
    mesh.computeWorldMatrix(true);

    // Wedges are convex, so a hull matches the visual exactly and is cheaper than a triangle mesh.
    const shapeType = block.kind === "ramp" ? PhysicsShapeType.CONVEX_HULL : PhysicsShapeType.BOX;
    new PhysicsAggregate(mesh, shapeType, { mass: 0, friction: 0.6, restitution: 0 }, scene);

    mesh.freezeWorldMatrix();
    meshes.push(mesh);
    surfaceOf.set(mesh, block.surface);
  });

  return { meshes, surfaceOf };
}

type V3 = readonly [number, number, number];

interface Face {
  /** Convex polygon corners in local space, in order around the perimeter (either winding). */
  readonly corners: readonly V3[];
  readonly normal: V3;
}

function blockVertexData(block: LevelBlock): VertexData {
  const [hx, hy, hz] = [block.size[0] / 2, block.size[1] / 2, block.size[2] / 2];
  const faces = block.kind === "ramp" ? wedgeFaces(hx, hy, hz) : boxFaces(hx, hy, hz);
  return facesToVertexData(faces, block.position);
}

function boxFaces(hx: number, hy: number, hz: number): Face[] {
  return [
    { normal: [0, 1, 0], corners: [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { normal: [1, 0, 0], corners: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { normal: [-1, 0, 0], corners: [[-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [-hx, -hy, hz]] },
    { normal: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [0, 0, -1], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz]] },
  ];
}

/** Wedge rising along +Z: low edge at (y = -hy, z = -hz), high edge at (y = +hy, z = +hz). */
function wedgeFaces(hx: number, hy: number, hz: number): Face[] {
  const slope = normalize([0, hz, -hy]);
  return [
    { normal: slope, corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { normal: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [1, 0, 0], corners: [[hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz]] },
    { normal: [-1, 0, 0], corners: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz]] },
  ];
}

/**
 * Flat-shaded geometry with UVs in meters. UVs are offset by the block position so
 * adjacent axis-aligned blocks share a continuous world-space grid.
 */
function facesToVertexData(faces: readonly Face[], offset: Vec3Tuple): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const { corners, normal } of faces) {
    const uAxis: V3 = Math.abs(normal[0]) > 0.5 ? [0, 0, 1] : [1, 0, 0];
    const vAxis = normalize(cross(normal, uAxis));
    const base = positions.length / 3;
    for (const c of corners) {
      const world: V3 = [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]];
      positions.push(...c);
      normals.push(...normal);
      uvs.push(dot(world, uAxis), dot(world, vAxis));
    }
    // Babylon treats a triangle as front-facing when cross(p1 - p2, p3 - p2) points along its normal.
    const [p0, p1, p2] = corners as [V3, V3, V3];
    const flip = dot(cross(sub(p0, p1), sub(p2, p1)), normal) < 0;
    for (let k = 1; k < corners.length - 1; k++) {
      if (flip) indices.push(base, base + k + 1, base + k);
      else indices.push(base, base + k, base + k + 1);
    }
  }

  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / len, a[1] / len, a[2] / len];
}
