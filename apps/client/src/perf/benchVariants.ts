import { Color3, PBRMaterial, RenderTargetTexture, type AbstractEngine, type AnimationGroup, type Scene } from "@babylonjs/core";
import type { TargetRange } from "../targets/TargetRange";
import { setViewmodelSuppressed } from "../viewmodel/Viewmodel";
import type { Environment } from "../world/environment";
import type { MapRuntime } from "../world/mapRuntime";
import { setAntiAliasingPass } from "../world/postEffects";
import type { BenchVariant } from "./BenchRunner";
import { OPTIMIZATIONS, type RenderOptimizations } from "./flags";
import { RENDER_SCALE, graphicsOf, type QualityPreset } from "./graphicsSettings";

export interface BenchSubsystems {
  readonly engine: AbstractEngine;
  readonly scene: Scene;
  readonly environment: Environment;
  readonly world: MapRuntime;
  readonly targets: TargetRange;
}

export interface GroupedBenchVariant extends BenchVariant {
  /** resolution | shadows | terrain | shading | vegetation | scene */
  readonly group: string;
  /** Part of the default run (`?variants` absent). */
  readonly byDefault: boolean;
}

/**
 * A/B variants in run order. Each changes one thing so its delta against the baseline shows what it costs or saves.
 * `select` takes ids or group names; "all" includes the scene-content toggles that are off by default.
 */
export function createBenchVariants(s: BenchSubsystems, select?: readonly string[]): BenchVariant[] {
  const { scene, environment, world } = s;
  const graphics = graphicsOf(scene);
  const refreshShadows = () => environment.refreshShadowQuality();
  const refreshTerrain = () => world.terrainMaterial.refreshOptimizations();

  const presets = (["high", "balanced", "performance"] as const satisfies readonly QualityPreset[])
    .filter((preset) => graphics && preset !== graphics.current.preset)
    .map(
      (preset): GroupedBenchVariant => ({
        id: `preset_${preset}`,
        group: "resolution",
        byDefault: true,
        label: `${preset} preset (render scale ${RENDER_SCALE[preset]})`,
        apply: () => {
          graphics?.setRenderScale(RENDER_SCALE[preset]);
          return () => graphics?.apply();
        },
      }),
    );
  const antiAliasing = graphics?.current.antiAliasing ?? "msaa";

  const variants: GroupedBenchVariant[] = [
    ...presets,
    {
      id: "aa_swap",
      group: "resolution",
      byDefault: true,
      label: antiAliasing === "msaa" ? "FXAA instead of MSAA" : "MSAA instead of FXAA",
      apply: () => {
        setAntiAliasingPass(scene, antiAliasing === "msaa" ? "fxaa" : "msaa");
        return () => setAntiAliasingPass(scene, antiAliasing);
      },
    },
    {
      id: "aa_none",
      group: "resolution",
      byDefault: true,
      label: "no anti-aliasing (single-sample target, plain copy)",
      apply: () => {
        setAntiAliasingPass(scene, "resolve");
        return () => setAntiAliasingPass(scene, antiAliasing);
      },
    },

    flag("shadowThreeCascades", "shadows", ["3 shadow cascades", "4 shadow cascades"], refreshShadows),
    flag("shadowMap1536", "shadows", ["shadow maps 1536²", "shadow maps 2048²"], refreshShadows),
    flag("shadowPcfLow", "shadows", ["PCF 1 tap", "PCF 4 taps"], refreshShadows),
    flag("shadowStaticCache", "shadows", ["static shadow cache on", "static shadow cache off"]),
    flag("shadowCascadeCulling", "shadows", ["cascade caster culling on", "cascade caster culling off"], undefined, false),
    flag("dynamicShadowsNearOnly", "shadows", ["soldier shadows in near cascades only", "soldier shadows in every cascade"]),
    flag("sortBySubMeshMaterial", "draws", ["opaque draws sorted by submesh material", "opaque draws sorted by mesh material"]),
    {
      id: "shadowMapsFrozen",
      group: "shadows",
      byDefault: false,
      label: "shadow maps not re-rendered (sampling kept)",
      apply: () => {
        const map = environment.shadowGenerator.getShadowMap();
        if (!map) return () => {};
        const refreshRate = map.refreshRate;
        map.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
        return () => (map.refreshRate = refreshRate);
      },
    },
    toggle("shadowsOff", "shadows", false, "shadows off (maps and sampling)", (off) => (scene.shadowsEnabled = !off)),

    flag("terrainWeightSkip", "terrain", ["terrain weight skip on", "terrain weight skip off"], refreshTerrain),
    flag("terrainBiplanarRock", "terrain", ["terrain rock biplanar", "terrain rock triplanar"], refreshTerrain),
    flag("terrainFarSimplify", "terrain", ["terrain far simplification on", "terrain far simplification off"], refreshTerrain),
    {
      id: "terrainLegacy",
      group: "terrain",
      byDefault: true,
      label: "terrain shader as before (all three terrain flags off)",
      apply: () => {
        const saved = { skip: OPTIMIZATIONS.terrainWeightSkip, biplanar: OPTIMIZATIONS.terrainBiplanarRock, far: OPTIMIZATIONS.terrainFarSimplify };
        OPTIMIZATIONS.terrainWeightSkip = OPTIMIZATIONS.terrainBiplanarRock = OPTIMIZATIONS.terrainFarSimplify = false;
        refreshTerrain();
        return () => {
          OPTIMIZATIONS.terrainWeightSkip = saved.skip;
          OPTIMIZATIONS.terrainBiplanarRock = saved.biplanar;
          OPTIMIZATIONS.terrainFarSimplify = saved.far;
          refreshTerrain();
        };
      },
    },
    { id: "terrainPlain", group: "terrain", byDefault: false, label: "terrain: plain PBR instead of the splat shader", apply: () => plainTerrain(scene, world) },

    toggle("fogOff", "shading", true, "fog off", (off) => (scene.fogEnabled = !off)),
    toggle("imageProcessingOff", "shading", true, "image processing off (ACES, contrast, dithering)", (off) => (scene.imageProcessingConfiguration.isEnabled = !off)),
    toggle("viewmodelOff", "shading", true, "viewmodel off", setViewmodelSuppressed),

    flag("lodCrossFade", "vegetation", ["LOD cross-fade on", "LOD cross-fade off"], undefined, false),
    flag("lodHysteresis", "vegetation", ["LOD hysteresis on", "LOD hysteresis off"], undefined, false),
    flag("foliageAlphaMipScale", "vegetation", ["foliage alpha mip scale on", "foliage alpha mip scale off"], undefined, false),

    toggle("grassOff", "scene", false, "grass off", (off) => world.grass.setEnabled(!off)),
    toggle("propsOff", "scene", false, "props + vegetation off", (off) => world.props.setEnabled(!off)),
    toggle("buildingsOff", "scene", false, "buildings off", (off) => world.buildingVisuals.setEnabled(!off)),
    { id: "soldiersOff", group: "scene", byDefault: false, label: "soldiers off (hidden, animation paused)", apply: () => hideSoldiers(s.targets) },
  ];

  if (!select) return variants.filter((v) => v.byDefault);
  if (select.includes("all")) return variants;
  return variants.filter((v) => select.includes(v.id) || select.includes(v.group));
}

/** Flips a runtime optimization flag for the pass; labels are [when on, when off]. */
function flag(name: keyof RenderOptimizations, group: string, labels: readonly [on: string, off: string], refresh?: () => void, byDefault = true): GroupedBenchVariant {
  const initial = OPTIMIZATIONS[name];
  return {
    id: name,
    group,
    byDefault,
    label: initial ? labels[1] : labels[0],
    apply: () => {
      OPTIMIZATIONS[name] = !initial;
      refresh?.();
      return () => {
        OPTIMIZATIONS[name] = initial;
        refresh?.();
      };
    },
  };
}

function toggle(id: string, group: string, byDefault: boolean, label: string, set: (off: boolean) => void): GroupedBenchVariant {
  return {
    id,
    group,
    byDefault,
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
