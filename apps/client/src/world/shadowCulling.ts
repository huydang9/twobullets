import { Frustum, Matrix, type AbstractMesh, type CascadedShadowGenerator, type Immutable, type Nullable, type Plane, type Vector3 } from "@babylonjs/core";
import { OPTIMIZATIONS } from "../perf/flags";

/**
 * Per-cascade shadow caster culling. Babylon renders a cascaded shadow map as one 2D-array render target and, with a
 * plain render list, draws every enabled caster into every cascade layer. This supplies a custom list per layer with
 * only the casters whose world bounds touch that cascade's light-space box.
 *
 * The near plane is not tested: with depth clamping, casters between the light and the cascade still land in the map.
 * The far plane and the four sides are: anything beyond them can't cover a texel of the cascade.
 */
export class CascadeCasterCulling {
  /** Casters drawn into each cascade on the last shadow render. */
  readonly counts: number[];
  /** Enabled casters in the render list on the last shadow render. */
  candidates = 0;

  private readonly lists: AbstractMesh[][];
  private readonly planes = Frustum.GetPlanes(Matrix.Identity());
  private readonly testPlanes: Plane[];

  constructor(private readonly generator: CascadedShadowGenerator) {
    const shadowMap = generator.getShadowMap();
    if (!shadowMap) throw new Error("Cascaded shadow generator has no shadow map");
    const cascades = generator.numCascades;
    this.counts = new Array<number>(cascades).fill(0);
    this.lists = Array.from({ length: cascades }, () => []);
    // Frustum.GetPlanes order: near, far, left, right, top, bottom. A reversed depth buffer swaps near and far.
    const nearIndex = shadowMap.getScene()?.getEngine().useReverseDepthBuffer ? 1 : 0;
    this.testPlanes = this.planes.filter((_, i) => i !== nearIndex);
    shadowMap.getCustomRenderList = (layer, renderList, length) => this.select(layer, renderList, length);
  }

  private select(layer: number, renderList: Nullable<Immutable<AbstractMesh[]>>, length: number): AbstractMesh[] | null {
    const list = this.lists[layer];
    const matrix = this.generator.getCascadeTransformMatrix(layer);
    if (!renderList || !list) return null;

    // Disabled: keep Babylon's default path (one shared list for all layers) and only count.
    if (!OPTIMIZATIONS.shadowCascadeCulling || !matrix) {
      let enabled = 0;
      for (let i = 0; i < length; i++) if (isDrawable(renderList[i])) enabled++;
      this.candidates = enabled;
      this.counts[layer] = enabled;
      return null;
    }

    Frustum.GetPlanesToRef(matrix, this.planes);
    list.length = 0;
    let candidates = 0;
    for (let i = 0; i < length; i++) {
      const mesh = renderList[i];
      if (!isDrawable(mesh)) continue;
      candidates++;
      if (touchesAll(mesh.getBoundingInfo().boundingBox.vectorsWorld, this.testPlanes)) list.push(mesh);
    }
    this.candidates = candidates;
    this.counts[layer] = list.length;
    return list;
  }
}

/** True unless every corner lies behind one of the planes (BoundingBox.IsInFrustum assumes exactly six planes). */
function touchesAll(corners: readonly Vector3[], planes: readonly Plane[]): boolean {
  for (let p = 0; p < planes.length; p++) {
    const plane = planes[p]!;
    let inside = false;
    for (let c = 0; c < corners.length && !inside; c++) inside = plane.dotCoordinate(corners[c]!) >= 0;
    if (!inside) return false;
  }
  return true;
}

function isDrawable(mesh: AbstractMesh | undefined): mesh is AbstractMesh {
  return mesh !== undefined && mesh.isEnabled() && mesh.isVisible;
}
