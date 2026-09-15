import type { Scene, Vector3 } from "@babylonjs/core";
import {
  MAP_V1,
  MAP_V1_TRAINING_YARD,
  ScatterContext,
  detailRules,
  loadMapWorld,
  type LevelData,
  type MapData,
  type MapLayout,
  type MapWorld,
  type MapWorldStage,
  type Terrain,
} from "@twobullets/shared";
import { buildBuilding, createTerrainBody, type BuiltBuilding, type TerrainBody } from "@twobullets/sim";
import type { AudioWorldProbe } from "../../audio/AudioWorldProbe";
import { t, type MessageKey } from "../../i18n";
import { terrainSurfaceProvider } from "../../audio/surfaces";
import { BuildingVisuals } from "../buildings";
import type { Environment } from "../environment";
import type { PropLibraryOptions } from "../propAssets";
import { PropColliders, PropInstances, PropVisuals } from "../props";
import { TerrainMaterial, TerrainRenderer, createHorizonMesh } from "../terrain";
import { StreetSigns } from "../streetSigns";
import { GrassField } from "../vegetation";
import { BuildingAcoustics } from "./buildingAcoustics";
import type { MapOverlay } from "./MapOverlay";
import { MapSpawns, type Respawnable } from "./MapSpawns";
import { OutOfBounds } from "./OutOfBounds";
import { createTrainingYard, type TrainingYardPlacement } from "./trainingYard";

/** Camera far plane for 1 km views plus the horizon mountains, m. */
export const MAP_FAR_PLANE = 4000;

/** Load options; spread a `MapDefinition` (maps.ts) into them: `{ ...definition, overlay }`. */
export interface MapRuntimeOptions {
  readonly map?: MapData;
  /** The Training Yard arena; null for none (real-world maps). Default: Map v1's yard when `map` is omitted or Map v1. */
  readonly trainingYard?: TrainingYardPlacement | null;
  /** Baked terrain for `map` (tools/map/build.ts). Stale or missing bakes fall back to generating in the worker. */
  readonly bakeUrl?: string;
  /** Already built terrain and layout (headless tools); skips the worker. */
  readonly world?: MapWorld;
  readonly overlay?: MapOverlay;
  /** Environment prop asset loading (PropLibrary options), or false for procedural stand-ins only. */
  readonly propAssets?: Omit<PropLibraryOptions, "ids"> | false;
}

/** The player the runtime keeps in bounds. */
export interface MapPlayer extends Respawnable {
  getDebugState(): { readonly position: readonly [number, number, number] };
}

/** Stage labels and the share of the loading bar each takes. */
const STAGES: Readonly<Record<MapWorldStage | "scene", { label: MessageKey; from: number; to: number }>> = {
  download: { label: "mapLoad.stage.download", from: 0, to: 0.35 },
  decode: { label: "mapLoad.stage.decode", from: 0.35, to: 0.45 },
  generate: { label: "mapLoad.stage.generate", from: 0, to: 0.55 },
  layout: { label: "mapLoad.stage.layout", from: 0.55, to: 0.65 },
  scene: { label: "mapLoad.stage.scene", from: 0.65, to: 1 },
};

/**
 * Full map mode: terrain (worker-built or baked) with physics, chunked rendering and horizon; buildings; instanced props
 * and their colliders; grass around the camera; the Training Yard arena (Map v1); spawns; out-of-bounds enforcement; and the
 * audio hooks (terrain and building surfaces, room enclosure).
 */
export class MapRuntime {
  readonly level: LevelData;
  readonly buildingAcoustics: BuildingAcoustics;
  readonly outOfBounds: OutOfBounds;
  private player: MapPlayer | null = null;

  private constructor(
    private readonly scene: Scene,
    readonly map: MapData,
    readonly world: MapWorld,
    readonly physics: TerrainBody,
    readonly renderer: TerrainRenderer,
    readonly terrainMaterial: TerrainMaterial,
    readonly buildings: readonly BuiltBuilding[],
    readonly buildingVisuals: BuildingVisuals,
    readonly props: PropInstances,
    readonly colliders: PropColliders,
    readonly grass: GrassField,
    /** Street name signs and landmark boards (real-world maps; empty on Map v1). */
    readonly streetSigns: StreetSigns,
    readonly spawns: MapSpawns,
    /** Resolves when terrain and building textures are loaded. */
    readonly ready: Promise<void>,
    private readonly overlay: MapOverlay | undefined,
    readonly timings: Readonly<Record<string, number>>,
    yard: ReturnType<typeof createTrainingYard> | null,
    yardPlacement: TrainingYardPlacement | null,
  ) {
    const spawnList = spawns;
    this.level = {
      name: map.name,
      blocks: yard?.blocks ?? [],
      targets: yard?.targets ?? [],
      killY: map.bounds.killY,
      get spawnPoints() {
        return spawnList.spawnPoints;
      },
    };
    const arena = 37;
    // The yard arena roofs the listener with level blocks, not buildings, so the probe's rays decide there.
    const rayZones: [number, number, number, number][] = yardPlacement ? [[yardPlacement.center[0] - arena, yardPlacement.center[1] - arena, yardPlacement.center[0] + arena, yardPlacement.center[1] + arena]] : [];
    this.buildingAcoustics = new BuildingAcoustics(world.layout.buildings, rayZones);
    this.outOfBounds = new OutOfBounds(map.terrain.playableHalfExtent, map.bounds.outOfBoundsGraceSeconds);
  }

  get terrain(): Terrain {
    return this.world.terrain;
  }

  get layout(): MapLayout {
    return this.world.layout;
  }

  static async load(scene: Scene, environment: Environment, options: MapRuntimeOptions = {}): Promise<MapRuntime> {
    const map = options.map ?? MAP_V1;
    const yardPlacement = options.trainingYard !== undefined ? options.trainingYard : map === MAP_V1 ? MAP_V1_TRAINING_YARD : null;
    const overlay = options.overlay;
    const progress = (stage: keyof typeof STAGES, fraction: number, detail = "") => {
      const { label: key, from, to } = STAGES[stage];
      const label = t(key);
      overlay?.setProgress(detail ? `${label}: ${detail}` : label, from + (to - from) * fraction);
    };
    const timings: Record<string, number> = {};
    const started = performance.now();

    const world =
      options.world ??
      (await loadMapWorld(map, {
        ...(options.bakeUrl ? { bakeUrl: options.bakeUrl } : {}),
        onProgress: (stage, fraction) => progress(stage, fraction),
      }));
    timings.world = performance.now() - started;
    Object.assign(timings, Object.fromEntries(Object.entries(world.timings).map(([k, v]) => [`world.${k}`, v])));
    if (world.bakeProblem) console.warn(`[map] terrain bake not used (${world.bakeProblem}); run \`node --experimental-transform-types tools/map/build.ts\``);

    const step = async <T>(name: string, fraction: number, run: () => T | Promise<T>): Promise<T> => {
      progress("scene", fraction, name);
      if (overlay) await nextFrame();
      const t = performance.now();
      const result = await run();
      timings[name] = performance.now() - t;
      return result;
    };

    const { terrain, layout } = world;
    const physics = await step("terrain physics", 0, () => createTerrainBody(scene, terrain.field));
    const { renderer, material } = await step("terrain meshes", 0.1, () => {
      const material = new TerrainMaterial(scene, terrain);
      const renderer = new TerrainRenderer(scene, terrain, material.material);
      const horizon = createHorizonMesh(scene, terrain, material.material);
      environment.skyFill.excludedMeshes.push(...renderer.meshes, horizon);
      return { renderer, material };
    });
    const buildingVisuals = new BuildingVisuals(scene, environment);
    const buildings = await step("buildings", 0.3, () => {
      const built = layout.buildings.map((b) => buildBuilding(scene, b.prefab, { position: b.position, yaw: b.yaw }, buildingVisuals));
      buildingVisuals.flush();
      return built;
    });
    const streetSigns = await step("street signs", 0.55, () => StreetSigns.create(scene, environment, map, layout, terrain));
    const detail = detailRules(map);
    const propIds = [...new Set([...layout.props.map((set) => set.prop), ...detail.flatMap((rule) => rule.props.map((p) => p.prop))])];
    const visuals = await step("prop assets", 0.6, () => PropVisuals.load(scene, propIds, options.propAssets ?? {}));
    const props = await step("prop instances", 0.75, () => new PropInstances(scene, visuals, environment, layout.props));
    const colliders = await step("prop colliders", 0.85, () => new PropColliders(scene, layout));
    const grass = await step("grass", 0.95, () => new GrassField(visuals, environment, detail, new ScatterContext(map, terrain, layout.buildings)));
    const spawns = new MapSpawns(map, terrain);
    const yard = yardPlacement ? createTrainingYard(terrain, yardPlacement) : null;
    progress("scene", 1, "done");
    timings.total = performance.now() - started;

    const colliderStats = colliders.stats();
    console.info(
      `[map] ${map.name} ready in ${timings.total.toFixed(0)} ms (terrain ${world.terrainSource}, layout ${layout.checksum}): ` +
        Object.entries(timings)
          .filter(([key]) => key !== "total")
          .map(([key, ms]) => `${key} ${ms.toFixed(0)}`)
          .join(", ") +
        ` · ${buildings.length} buildings, ${streetSigns.signs.length} street signs, ${props.instanceCount} prop instances, ${colliderStats.bodies} prop bodies / ${colliderStats.shapes} shapes`,
    );
    const ready = Promise.all([material.ready, buildingVisuals.whenLoaded()]).then(() => undefined);
    return new MapRuntime(scene, map, world, physics, renderer, material, buildings, buildingVisuals, props, colliders, grass, streetSigns, spawns, ready, overlay, timings, yard, yardPlacement);
  }

  /**
   * Hooks the local player (out-of-bounds respawns) and audio: building surfaces first, then the terrain mask, plus room
   * enclosure for indoor reverb. Also hides the loading card. `player` null (networked play): no local out-of-bounds.
   */
  attach(player: MapPlayer | null, audio?: AudioWorldProbe): void {
    this.player = player;
    if (audio) {
      audio.surfaceProviders.push(this.buildingAcoustics.surface, terrainSurfaceProvider(this.terrain.surface));
      audio.enclosureProvider = this.buildingAcoustics.enclosure;
    }
    this.overlay?.hideLoading();
  }

  update(dt: number): void {
    const camera = this.scene.activeCamera?.globalPosition;
    if (camera) this.updateView(camera);
    if (!this.player) return;
    const [x, , z] = this.player.getDebugState().position;
    const event = this.outOfBounds.update(dt, x, z);
    if (event === "expired") {
      const spawn = this.spawns.respawnNear(this.player, x, z);
      console.info(`[map] out of bounds for ${this.map.bounds.outOfBoundsGraceSeconds} s: respawned at (${spawn.position[0]}, ${spawn.position[2]})`);
    } else if (event === "left") {
      console.info(`[map] left the play area at (${x.toFixed(0)}, ${z.toFixed(0)}): ${this.map.bounds.outOfBoundsGraceSeconds} s to return`);
    }
    this.overlay?.setOutOfBounds(this.outOfBounds.secondsLeft);
  }

  /** LOD, shadow band and grass around a view position (called by update with the active camera). */
  updateView(camera: Vector3): void {
    this.props.update(camera);
    this.grass.update(camera);
    this.streetSigns.update(camera);
  }

  stats() {
    return { terrain: this.renderer.getStats(), buildings: this.buildingVisuals.stats(), props: this.props.stats(), streetSigns: this.streetSigns.stats(), colliders: this.colliders.stats(), grass: this.grass.instances };
  }

  dispose(): void {
    this.grass.dispose();
    this.streetSigns.dispose();
    this.props.dispose();
    this.colliders.dispose();
    this.buildings.forEach((b) => b.dispose());
    this.buildingVisuals.dispose();
    this.renderer.dispose();
    this.physics.dispose();
    this.overlay?.dispose();
  }
}

/**
 * Yields so the overlay can repaint. Hidden tabs pause requestAnimationFrame and throttle timers to ~1 s, so rAF is only
 * used while visible (raced against a short timeout in case the tab is hidden mid-wait); otherwise a MessageChannel
 * task yields without throttling.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onHidden);
      resolve();
    };
    const yieldTask = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        finish();
      };
      channel.port2.postMessage(null);
    };
    const onHidden = () => {
      if (document.visibilityState !== "visible") yieldTask();
    };
    if (document.visibilityState !== "visible") {
      yieldTask();
      return;
    }
    document.addEventListener("visibilitychange", onHidden);
    requestAnimationFrame(finish);
    setTimeout(finish, 32);
  });
}
