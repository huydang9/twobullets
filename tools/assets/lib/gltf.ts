import { type Document, Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

export const QUIET_LOGGER = new Logger(Logger.Verbosity.WARN);

export async function createIO(): Promise<NodeIO> {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  return new NodeIO()
    .setLogger(QUIET_LOGGER)
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
}

/** Shared geometry/animation optimization; call after textures are final. */
export async function optimize(doc: Document): Promise<void> {
  await doc.transform(
    dedup(),
    resample({ tolerance: 1e-4 }),
    // keepLeaves: generated marker nodes (muzzle, ejection) are intentionally empty.
    prune({ keepLeaves: true, keepAttributes: false }),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );
}

export function countGeometry(doc: Document): { vertices: number; triangles: number } {
  let vertices = 0;
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getAttribute("POSITION")?.getCount() ?? 0;
      vertices += count;
      triangles += (prim.getIndices()?.getCount() ?? count) / 3;
    }
  }
  return { vertices, triangles };
}
