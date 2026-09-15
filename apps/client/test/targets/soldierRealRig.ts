import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LoadAssetContainerAsync, MeshoptCompression, NullEngine, Scene, Tools, TransformNode, type AssetContainer, type Node } from "@babylonjs/core";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type {} from "@babylonjs/loaders/glTF/glTFFileLoader.types";
import { MeshoptDecoder } from "meshoptimizer";
import { CharacterInstance } from "../../src/assets/CharacterInstance";
import type { AssetManifest } from "../../src/assets/manifest";
import { SoldierAnimator, createSoldierMotion, createUpperBodyMask, type SoldierMotion } from "../../src/targets/SoldierAnimator";
import { soldierScale, upperBodyWeights } from "../../src/targets/soldierRig";

// The real swat.glb on NullEngine: real Babylon AnimationGroups (absolute-time runtime animations, goToFrame, speedRatio
// resync, weight-0 skipping), so pose tests measure what the browser shows instead of a fake group's idea of it.

const ASSETS = fileURLToPath(new URL("../../public/assets/", import.meta.url));

export interface RealSoldier {
  readonly scene: Scene;
  readonly character: CharacterInstance;
  readonly animator: SoldierAnimator;
  readonly motion: SoldierMotion;
  /** One render frame: the animator, then Babylon's animation pass with `ms` (defaults to `dt`). */
  frame(dt: number, ms?: number): void;
  step(seconds: number, dt?: number): void;
  /** Hips height above the feet, world metres. */
  hipsHeight(): number;
  dispose(): void;
}

let container: Promise<{ engine: NullEngine; scene: Scene; container: AssetContainer; manifest: AssetManifest }> | null = null;

async function load() {
  await MeshoptDecoder.ready;
  Object.assign(globalThis, { MeshoptDecoder });
  Tools.LoadBabylonScriptAsync = async () => {};
  MeshoptCompression.prototype.decodeGltfBufferAsync = async (source, count, stride, mode, filter) => {
    const target = new Uint8Array(count * stride);
    MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode as never, filter as never);
    return target;
  };
  registerBuiltInLoaders();
  const manifest = JSON.parse(readFileSync(`${ASSETS}manifest.json`, "utf8")) as AssetManifest;
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const data = new Uint8Array(readFileSync(`${ASSETS}${manifest.characters.swat.url}`));
  const loaded = await LoadAssetContainerAsync(data, scene, { name: "swat", pluginExtension: ".glb", pluginOptions: { gltf: { animationStartMode: 0, skipMaterials: true } } });
  return { engine, scene, container: loaded, manifest };
}

export async function realSoldier(): Promise<RealSoldier> {
  const { scene, container: loaded, manifest } = await (container ??= load());
  const character = new CharacterInstance("swat", manifest.characters.swat, loaded, scene);
  const root = new TransformNode("soldier_root", scene);
  character.root.parent = root;
  character.root.scaling.scaleInPlace(soldierScale(character.asset));
  const weights = upperBodyWeights(character.bones);
  const motion = createSoldierMotion();
  const animator = new SoldierAnimator(character, motion, weights, createUpperBodyMask(weights));
  const animate = scene as unknown as { _animate(ms: number): void };
  const nodes: Node[] = [root, ...root.getDescendants(false)];
  const soldier: RealSoldier = {
    scene,
    character,
    animator,
    motion,
    frame(dt, ms = dt * 1000) {
      animator.update(dt);
      animate._animate(ms);
    },
    step(seconds, dt = 1 / 60) {
      for (let t = 0; t < seconds - 1e-9; t += dt) soldier.frame(dt);
    },
    hipsHeight() {
      for (const node of nodes) node.computeWorldMatrix(true);
      return character.bones.hips.getAbsolutePosition().y - root.position.y;
    },
    dispose() {
      character.dispose();
      root.dispose();
    },
  };
  return soldier;
}
