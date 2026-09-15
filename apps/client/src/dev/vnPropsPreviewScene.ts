/**
 * Render-agnostic bootstrap of the vn-props.html preview (vnPropsPreview.ts), kept apart so it runs headless in tests:
 * Havok physics (the ground comes from sim's buildLevel, which attaches static bodies), the group-row layout, and
 * sequential prop loading that yields to the event loop between models so the page stays responsive.
 */
import { HavokPlugin, Mesh, Vector3, type AbstractMesh, type AssetContainer, type Scene } from "@babylonjs/core";
import { MOVEMENT } from "@twobullets/shared";
import { buildLevel, type BuiltLevel, type HavokModule } from "@twobullets/sim";
import { VN_PROP_IDS, VN_PROP_MANIFEST, type VnPropId } from "../assets/vnPropsManifest";

export const GAP = 2.5;
export const GROUP_SPACING = 16;
export const LEVEL_SPACING = 4;

export interface PlacedVnProp {
  readonly id: VnPropId;
  readonly position: Vector3;
  /** Meshes per LOD level; level i sits `i * LEVEL_SPACING` behind LOD0. */
  readonly levels: Mesh[][];
}

export interface VnPreviewOptions {
  readonly havok: HavokModule;
  readonly ids?: readonly VnPropId[];
  /** Loads one GLB (URL relative to the environment asset root) into the scene. */
  readonly loadFile: (url: string) => Promise<AssetContainer>;
  /** Called after each prop is placed (and before each yield). */
  readonly onProgress?: (done: number, total: number, id: VnPropId) => void;
  /** Hands control back to the event loop between props; default a macrotask. */
  readonly yieldToLoop?: () => Promise<void>;
  /** Visual treatment of the ground and props (the browser page's environment). */
  readonly decorateLevel?: (level: BuiltLevel) => void;
  readonly addShadowCaster?: (mesh: AbstractMesh) => void;
}

export interface VnPreview {
  readonly ground: BuiltLevel;
  readonly placed: PlacedVnProp[];
  readonly fileCount: number;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One row (z) per group, props side by side along x; returns positions and the row extent. */
export function layoutVnProps(ids: readonly VnPropId[] = VN_PROP_IDS): { positions: Map<VnPropId, Vector3>; groups: string[]; width: number } {
  const groups = [...new Set(ids.map((id) => VN_PROP_MANIFEST[id].group))];
  const positions = new Map<VnPropId, Vector3>();
  let width = 0;
  groups.forEach((group, row) => {
    let x = 0;
    for (const id of ids.filter((i) => VN_PROP_MANIFEST[i].group === group)) {
      const { min, max } = VN_PROP_MANIFEST[id].bounds;
      const size = Math.max(max[0] - min[0], 0.5);
      positions.set(id, new Vector3(x + size / 2 - (min[0] + max[0]) / 2, 0, -row * GROUP_SPACING));
      x += size + GAP;
    }
    width = Math.max(width, x);
  });
  return { positions, groups, width };
}

export async function createVnPreview(scene: Scene, options: VnPreviewOptions): Promise<VnPreview> {
  const ids = options.ids ?? VN_PROP_IDS;
  const yieldToLoop = options.yieldToLoop ?? macrotask;
  if (!scene.isPhysicsEnabled()) scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, options.havok));

  const { positions, groups, width } = layoutVnProps(ids);
  const ground = buildLevel(scene, {
    name: "vn props preview ground",
    blocks: [{ kind: "box", name: "ground", surface: "ground", position: [width / 2, -1, (-(groups.length - 1) * GROUP_SPACING) / 2 - 4], size: [width + 40, 2, groups.length * GROUP_SPACING + 30] }],
    spawnPoints: [],
    targets: [],
    killY: -30,
  });
  options.decorateLevel?.(ground);

  // One file at a time: parsing a GLB and transcoding its KTX2 textures is main-thread work, so parallel loads of
  // 50 files starve rendering and input for tens of seconds.
  const files = new Map<string, AssetContainer>();
  const placed: PlacedVnProp[] = [];
  for (const id of ids) {
    const asset = VN_PROP_MANIFEST[id];
    const position = positions.get(id)!;
    const levels: Mesh[][] = [];
    for (const [level, lod] of asset.lods.entries()) {
      let container = files.get(lod.url);
      if (!container) {
        container = await options.loadFile(lod.url);
        files.set(lod.url, container);
      }
      const root = [...container.transformNodes, ...container.meshes].find((n) => n.name === lod.node);
      if (!root) throw new Error(`${id}: node ${lod.node} not found in ${lod.url}`);
      const meshes = [...(root instanceof Mesh ? [root] : []), ...root.getChildMeshes(false)].filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
      levels.push(
        meshes.map((mesh) => {
          // Bake the glTF node transforms (and the handedness flip) like PropLibrary, then move the level into place.
          mesh.setParent(null);
          mesh.bakeCurrentTransformIntoVertices();
          mesh.position.set(position.x, 0, position.z - level * LEVEL_SPACING);
          mesh.receiveShadows = true;
          if (asset.castShadow && !lod.billboard) options.addShadowCaster?.(mesh);
          return mesh;
        }),
      );
    }
    placed.push({ id, position, levels });
    options.onProgress?.(placed.length, ids.length, id);
    await yieldToLoop();
  }
  return { ground, placed, fileCount: files.size };
}
