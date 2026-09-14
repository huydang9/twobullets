import { Color3, PBRMaterial, RenderTargetTexture, type AbstractEngine, type AnimationGroup, type Scene } from "@babylonjs/core";
import type { TargetRange } from "../targets/TargetRange";
import { setViewmodelSuppressed } from "../viewmodel/Viewmodel";
import type { Environment } from "../world/environment";
import type { MapRuntime } from "../world/mapRuntime";
import type { BenchVariant } from "./BenchRunner";
import { OPTIMIZATIONS } from "./flags";

export interface BenchSubsystems {
  readonly engine: AbstractEngine;
  readonly scene: Scene;
  readonly environment: Environment;
  readonly world: MapRuntime;
  readonly targets: TargetRange;
}

/**
 * Subsystem toggles for the A/B passes, in run order. Each removes (or changes) one cost so its delta against the
 * baseline shows what that subsystem takes. `only` selects a subset by id.
 */
export function createBenchVariants(s: BenchSubsystems, only?: readonly string[]): BenchVariant[] {
  const { engine, scene, environment, world } = s;
  const culling = OPTIMIZATIONS.shadowCascadeCulling;

  const variants: BenchVariant[] = [
    {
      id: "cascadeCulling",
      label: `shadow cascade culling ${culling ? "off" : "on"}`,
      apply: () => {
        OPTIMIZATIONS.shadowCascadeCulling = !culling;
        return () => (OPTIMIZATIONS.shadowCascadeCulling = culling);
      },
    },
    {
      id: "shadowMapsFrozen",
      label: "shadow maps not re-rendered (sampling kept)",
      apply: () => {
        const map = environment.shadowGenerator.getShadowMap();
        if (!map) return () => {};
        const refreshRate = map.refreshRate;
        map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
        return () => (map.refreshRate = refreshRate);
      },
    },
    toggle("shadowsOff", "shadows off (maps and sampling)", (off) => (scene.shadowsEnabled = !off)),
    toggle("grassOff", "grass off", (off) => world.grass.setEnabled(!off)),
    toggle("propsOff", "props + vegetation off", (off) => world.props.setEnabled(!off)),
    toggle("buildingsOff", "buildings off", (off) => world.buildingVisuals.setEnabled(!off)),
    toggle("fogPostOff", "fog + image processing off", (off) => {
      scene.fogEnabled = !off;
      scene.imageProcessingConfiguration.isEnabled = !off;
    }),
    toggle("viewmodelOff", "viewmodel off", setViewmodelSuppressed),
    { id: "soldiersOff", label: "soldiers off (hidden, animation paused)", apply: () => hideSoldiers(s.targets) },
    { id: "terrainPlain", label: "terrain: plain PBR instead of the splat shader", apply: () => plainTerrain(scene, world) },
    {
      id: "scale125",
      label: "hardware scaling ×1.25 (80% resolution)",
      apply: () => {
        const level = engine.getHardwareScalingLevel();
        engine.setHardwareScalingLevel(level * 1.25);
        return () => engine.setHardwareScalingLevel(level);
      },
    },
  ];
  return only ? variants.filter((v) => only.includes(v.id)) : variants;
}

function toggle(id: string, label: string, set: (off: boolean) => void): BenchVariant {
  return {
    id,
    label,
    apply: () => {
      set(true);
      return () => set(false);
    },
  };
}

/** Hides every practice soldier and freezes its animation and per-frame update (hitboxes, blending). */
function hideSoldiers(targets: TargetRange): () => void {
  const paused: AnimationGroup[] = [];
  for (const { soldier } of targets.dummies) {
    soldier.root.setEnabled(false);
    for (const group of soldier.model.animations.values()) {
      if (!group.isPlaying) continue;
      group.pause();
      paused.push(group);
    }
  }
  const update = targets.update;
  targets.update = () => {};
  return () => {
    targets.update = update;
    for (const group of paused) group.restart();
    for (const { soldier } of targets.dummies) soldier.root.setEnabled(true);
  };
}

/** Swaps the splat material on the terrain chunks and horizon for a flat grass-colored PBR material. */
function plainTerrain(scene: Scene, world: MapRuntime): () => void {
  const plain = new PBRMaterial("bench_terrainPlain", scene);
  plain.albedoColor = new Color3(0.12, 0.13, 0.05);
  plain.metallic = 0;
  plain.roughness = 0.95;
  const horizon = scene.getMeshByName("terrain_horizon");
  const meshes = [...world.renderer.meshes, ...(horizon ? [horizon] : [])];
  const originals = new Map(meshes.map((m) => [m, m.material] as const));
  for (const mesh of meshes) mesh.material = plain;
  return () => {
    for (const [mesh, material] of originals) mesh.material = material;
    plain.dispose();
  };
}
