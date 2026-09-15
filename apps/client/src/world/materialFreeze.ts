import type { Material } from "@babylonjs/core";
import { OPTIMIZATIONS } from "../perf/flags";

/** Babylon 9.26 internal every dirty path of a material goes through (textures, lights, fog, image processing, plugins). */
interface DirtyInternals {
  _markAllSubMeshesAsDirty(func: (defines: unknown) => void): void;
}

const frozen = new WeakSet<Material>();

/**
 * Freezes a world material whose properties don't change after load (`freezeStaticMaterials`). While frozen, Babylon
 * skips its readiness checks and material uniform uploads on rebinds, which is most of the per-draw CPU cost of PBR.
 *
 * A frozen material normally ignores dirty flags, so a later scene change (shadow cascade count, fog, image processing,
 * environment texture, plugin defines) would keep the old shader. Here every dirty mark also clears the "was ready"
 * state of its submeshes, so the next frame re-evaluates the shader once and freezes again. Direct property writes
 * that bypass dirty marking (`albedoColor.set`, `alpha`) are not picked up: don't freeze materials that animate.
 */
export function freezeStaticMaterial(material: Material | null | undefined): void {
  if (!material || !OPTIMIZATIONS.freezeStaticMaterials || frozen.has(material)) return;
  frozen.add(material);
  const internals = material as unknown as DirtyInternals;
  const markAllSubMeshesAsDirty = internals._markAllSubMeshesAsDirty.bind(material);
  internals._markAllSubMeshesAsDirty = (func) => {
    markAllSubMeshesAsDirty(func);
    if (material.isFrozen && !material.getScene().blockMaterialDirtyMechanism) material.markDirty();
  };
  material.freeze();
}
