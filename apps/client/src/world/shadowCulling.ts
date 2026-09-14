import {
  Frustum,
  Matrix,
  Vector3,
  type AbstractMesh,
  type CascadedShadowGenerator,
  type EventState,
  type Immutable,
  type Nullable,
  type Plane,
  type RenderTargetTexture,
} from "@babylonjs/core";
import { OPTIMIZATIONS } from "../perf/flags";

const staticCasters = new WeakSet<AbstractMesh>();
let staticVersion = 0;

/** Marks a caster that never moves on its own (buildings, level blocks, prop batches); changes go through invalidation. */
export function markStaticShadowCaster(mesh: AbstractMesh): void {
  staticCasters.add(mesh);
}

/** A static caster changed (instances rebucketed, shown or hidden): cached cascades must re-render. */
export function invalidateStaticShadows(): void {
  staticVersion++;
}

/** Cascades from this index on may be cached; the nearest one is cheap and moves the most. */
const FIRST_CACHED_CASCADE = 1;
/** Cached cascades render this much larger than their frustum slice so the view can drift before a re-render. */
const CACHE_MARGIN = 0.12;
/** Cached content is refreshed at least this often, frames (bounds staleness from casters that weren't ready). */
const MAX_CACHE_AGE = 30;

/** Private CascadedShadowGenerator state the cache reads and restores (Babylon 9.26). */
interface CsmInternals {
  _computeCascadeFrustum(cascade: number): void;
  readonly _frustumCenter: Vector3[];
  readonly _cascadeMinExtents: Vector3[];
  readonly _cascadeMaxExtents: Vector3[];
  readonly _viewMatrices: Matrix[];
  readonly _projectionMatrices: Matrix[];
  readonly _transformMatrices: Matrix[];
  readonly _transformMatricesAsArray: Float32Array;
}

class CascadeCache {
  valid = false;
  version = -1;
  casters = -1;
  age = 0;
  /** A caster not marked static was drawn: the content can't be reused. */
  dynamic = false;
  /** Half extent the cascade was rendered with, m. */
  radius = 0;
  readonly view = new Matrix();
  readonly projection = new Matrix();
  readonly transform = new Matrix();
  readonly min = new Vector3();
  readonly max = new Vector3();
}

/**
 * Per-cascade shadow caster culling, plus an optional static cache for the outer cascades.
 *
 * Culling: Babylon renders a cascaded shadow map as one 2D-array render target and, with a plain render list, draws
 * every enabled caster into every layer. This supplies a custom list per layer with only the casters whose world bounds
 * touch that cascade's light-space box. The near plane is not tested: with depth clamping, casters between the light
 * and the cascade still land in the map.
 *
 * Cache (`shadowStaticCache`): outer cascades render with a margin. On later frames a layer is skipped (no clear, no
 * draws, previous matrices restored) while the new frustum slice still fits inside it, it drew and touches no dynamic
 * caster, and no static caster changed.
 */
export class CascadeCasterCulling {
  /** Casters drawn into each cascade on the last shadow render (0 for reused layers). */
  counts: number[] = [];
  /** Enabled casters in the render list on the last shadow render. */
  candidates = 0;
  /** Layers reused from the cache on the last shadow render. */
  cachedLayers = 0;

  private map: RenderTargetTexture | null = null;
  private lists: AbstractMesh[][] = [];
  private caches: CascadeCache[] = [];
  private skip: boolean[] = [];
  private readonly sliceCenters: Vector3[] = [];
  private readonly sliceRadii: number[] = [];
  private currentLayer = 0;
  private readonly planes = Frustum.GetPlanes(Matrix.Identity());
  private readonly testPlanes: Plane[];
  private readonly internals: CsmInternals;
  private readonly lightSpace = new Vector3();

  constructor(private readonly generator: CascadedShadowGenerator) {
    this.internals = generator as unknown as CsmInternals;
    // Frustum.GetPlanes order: near, far, left, right, top, bottom. A reversed depth buffer swaps near and far.
    const nearIndex = generator.getLight().getScene().getEngine().useReverseDepthBuffer ? 1 : 0;
    this.testPlanes = this.planes.filter((_, i) => i !== nearIndex);
    this.wrapCascadeFrustum();
    this.attach();
  }

  /** Hooks the generator's current shadow map; call again after anything that recreates it (cascade count, size). */
  attach(): void {
    const map = this.generator.getShadowMap();
    if (!map || map === this.map) return;
    this.map = map;
    const cascades = this.generator.numCascades;
    this.counts = new Array<number>(cascades).fill(0);
    this.lists = Array.from({ length: cascades }, () => []);
    this.caches = Array.from({ length: cascades }, () => new CascadeCache());
    this.skip = new Array<boolean>(cascades).fill(false);
    map.getCustomRenderList = (layer, renderList, length) => this.select(layer, renderList, length);
    // Added after the generator's own observer, so the cascade matrices for this frame are already computed.
    map.onBeforeBindObservable.add(() => this.beforeShadowRender());
    // First in line, so a reused layer can skip the generator's clear.
    map.onClearObservable.add((_engine, state) => this.beforeClear(state), undefined, true);
  }

  /** Records each cascade's frustum slice and, for cacheable cascades, renders them with a margin. */
  private wrapCascadeFrustum(): void {
    const internals = this.internals;
    const compute = internals._computeCascadeFrustum.bind(this.generator);
    internals._computeCascadeFrustum = (cascade: number) => {
      compute(cascade);
      const radius = internals._cascadeMaxExtents[cascade]!.x;
      (this.sliceCenters[cascade] ??= new Vector3()).copyFrom(internals._frustumCenter[cascade]!);
      this.sliceRadii[cascade] = radius;
      if (this.caching && cascade >= FIRST_CACHED_CASCADE) {
        const enlarged = Math.ceil(radius * (1 + CACHE_MARGIN) * 16) / 16;
        internals._cascadeMaxExtents[cascade]!.setAll(enlarged);
        internals._cascadeMinExtents[cascade]!.setAll(-enlarged);
      }
    };
  }

  private get caching(): boolean {
    return OPTIMIZATIONS.shadowStaticCache && this.generator.stabilizeCascades;
  }

  private beforeShadowRender(): void {
    const renderList = this.map?.renderList ?? [];
    let cached = 0;
    for (let layer = 0; layer < this.caches.length; layer++) {
      const cache = this.caches[layer]!;
      const reuse =
        this.caching &&
        layer >= FIRST_CACHED_CASCADE &&
        cache.valid &&
        !cache.dynamic &&
        cache.age < MAX_CACHE_AGE &&
        cache.version === staticVersion &&
        cache.casters === renderList.length &&
        this.sliceInside(cache, layer) &&
        !this.dynamicCasterTouches(cache.transform, renderList);
      this.skip[layer] = reuse;
      if (reuse) {
        cache.age++;
        cached++;
        this.restore(cache, layer);
      } else {
        this.store(cache, layer, renderList.length);
      }
    }
    this.cachedLayers = cached;
  }

  private select(layer: number, renderList: Nullable<Immutable<AbstractMesh[]>>, length: number): AbstractMesh[] | null {
    this.currentLayer = layer;
    const list = this.lists[layer];
    const cache = this.caches[layer];
    const matrix = this.generator.getCascadeTransformMatrix(layer);
    if (!renderList || !list || !cache) return null;

    if (this.skip[layer]) {
      list.length = 0;
      this.counts[layer] = 0;
      return list;
    }

    const cull = OPTIMIZATIONS.shadowCascadeCulling && matrix !== null;
    if (cull) Frustum.GetPlanesToRef(matrix, this.planes);
    list.length = 0;
    let candidates = 0;
    let dynamic = false;
    for (let i = 0; i < length; i++) {
      const mesh = renderList[i];
      if (!isDrawable(mesh)) continue;
      candidates++;
      if (cull && !touchesAll(mesh.getBoundingInfo().boundingBox.vectorsWorld, this.testPlanes)) continue;
      list.push(mesh);
      dynamic ||= !staticCasters.has(mesh);
    }
    cache.dynamic = dynamic;
    this.candidates = candidates;
    this.counts[layer] = list.length;
    // Disabled culling keeps Babylon's default path (one shared list for all layers).
    return cull ? list : null;
  }

  private beforeClear(state: EventState): void {
    if (this.skip[this.currentLayer]) state.skipNextObservers = true;
  }

  /** The new frustum slice (sphere) lies inside the box the layer was rendered with, in light space. */
  private sliceInside(cache: CascadeCache, layer: number): boolean {
    const center = this.sliceCenters[layer];
    const radius = this.sliceRadii[layer];
    if (!center || radius === undefined) return false;
    // Cached view: origin radius behind the old slice center along the light, so the old center sits at z = radius.
    const p = Vector3.TransformCoordinatesToRef(center, cache.view, this.lightSpace);
    const r = cache.radius;
    return Math.abs(p.x) + radius <= r && Math.abs(p.y) + radius <= r && p.z - radius >= 0 && p.z + radius <= 2 * r;
  }

  private dynamicCasterTouches(transform: Matrix, renderList: Immutable<AbstractMesh[]>): boolean {
    Frustum.GetPlanesToRef(transform, this.planes);
    for (const mesh of renderList) {
      if (!isDrawable(mesh) || staticCasters.has(mesh)) continue;
      if (touchesAll(mesh.getBoundingInfo().boundingBox.vectorsWorld, this.testPlanes)) return true;
    }
    return false;
  }

  private store(cache: CascadeCache, layer: number, casters: number): void {
    const i = this.internals;
    cache.valid = true;
    cache.age = 0;
    cache.version = staticVersion;
    cache.casters = casters;
    cache.radius = i._cascadeMaxExtents[layer]!.x;
    cache.view.copyFrom(i._viewMatrices[layer]!);
    cache.projection.copyFrom(i._projectionMatrices[layer]!);
    cache.transform.copyFrom(i._transformMatrices[layer]!);
    cache.min.copyFrom(i._cascadeMinExtents[layer]!);
    cache.max.copyFrom(i._cascadeMaxExtents[layer]!);
  }

  private restore(cache: CascadeCache, layer: number): void {
    const i = this.internals;
    i._viewMatrices[layer]!.copyFrom(cache.view);
    i._projectionMatrices[layer]!.copyFrom(cache.projection);
    i._transformMatrices[layer]!.copyFrom(cache.transform);
    i._cascadeMinExtents[layer]!.copyFrom(cache.min);
    i._cascadeMaxExtents[layer]!.copyFrom(cache.max);
    cache.transform.copyToArray(i._transformMatricesAsArray, layer * 16);
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
