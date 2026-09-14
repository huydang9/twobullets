import type { Scene, Vector3 } from "@babylonjs/core";
import {
  MAP_V1,
  MAP_V1_TRAINING_YARD,
  ScatterContext,
  buildBuilding,
  createTerrainBody,
  detailRules,
  loadMapWorld,
  type BuiltBuilding,
  type LevelData,
  type MapData,
  type MapLayout,
  type MapWorld,
  type MapWorldStage,
  type Terrain,
  type TerrainBody,
} from "@twobullets/shared";
import type { AudioWorldProbe } from "../../audio/AudioWorldProbe";
import { terrainSurfaceProvider } from "../../audio/surfaces";
import { BuildingVisuals } from "../buildings";
import type { Environment } from "../environment";
import type { PropLibraryOptions } from "../propAssets";
import { PropColliders, PropInstances, PropVisuals } from "../props";
import { TerrainMaterial, TerrainRenderer, createHorizonMesh } from "../terrain";
import { GrassField } from "../vegetation";
import { BuildingAcoustics } from "./buildingAcoustics";
import type { MapOverlay } from "./MapOverlay";
import { MapSpawns, type Respawnable } from "./MapSpawns";
import { OutOfBounds } from "./OutOfBounds";
import { createTrainingYard, type TrainingYardPlacement } from "./trainingYard";

/** Camera far plane for 1 km views plus the horizon mountains, m. */
export const MAP_FAR_PLANE = 4000;

export interface MapRuntimeOptions {
  readonly map?: MapData;
  readonly trainingYard?: TrainingYardPlacement;
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
const STAGES: Readonly<Record<MapWorldStage | "scene", { label: string; from: number; to: number }>> = {
  download: { label: "Downloading terrain", from: 0, to: 0.35 },
  decode: { label: "Decoding terrain", from: 0.35, to: 0.45 },
  generate: { label: "Generating terrain (bake missing or stale)", from: 0, to: 0.55 },
  layout: { label: "Placing props", from: 0.55, to: 0.65 },
  scene: { label: "Building the world", from: 0.65, to: 1 },
};

/**
 * Full map mode: terrain (worker-built or baked) with physics, chunked rendering and horizon; buildings; instanced props
 * and their colliders; grass around the camera; the Training Yard arena; spawns; out-of-bounds enforcement; and the
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
    readonly spawns: MapSpawns,
    /** Resolves when terrain and building textures are loaded. */
    readonly ready: Promise<void>,
    private readonly overlay: MapOverlay | undefined,
    readonly timings: Readonly<Record<string, number>>,
    yard: ReturnType<typeof createTrainingYard>,
    yardPlacement: TrainingYardPlacement,
  ) {
    const spawnList = spawns;
    this.level = {
      name: map.name,
      blocks: yard.blocks,
      targets: yard.targets,
      killY: map.bounds.killY,
      get spawnPoints() {
        return spawnList.spawnPoints;
      },
    };
    const [yx, yz] = yardPlacement.center;
    const arena = 37;
    this.buildingAcoustics = new BuildingAcoustics(world.layout.buildings, [[yx - arena, yz - arena, yx + arena, yz + arena]]);
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
    const yardPlacement = options.trainingYard ?? MAP_V1_TRAINING_YARD;
    const overlay = options.overlay;
    const progress = (stage: keyof typeof STAGES, fraction: number, detail = "") => {
      const { label, from, to } = STAGES[stage];
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
    const buildings = await step("buildings", 0.3, () => layout.buildings.map((b) => buildBuilding(scene, b.prefab, { position: b.position, yaw: b.yaw }, buildingVisuals)));
    const detail = detailRules(map);
    const propIds = [...new Set([...layout.props.map((set) => set.prop), ...detail.flatMap((rule) => rule.props.map((p) => p.prop))])];
    const visuals = await step("prop assets", 0.6, () => PropVisuals.load(scene, propIds, options.propAssets ?? {}));
    const props = await step("prop instances", 0.75, () => new PropInstances(scene, visuals, environment, layout.props));
    const colliders = await step("prop colliders", 0.85, () => new PropColliders(scene, layout));
    const grass = await step("grass", 0.95, () => new GrassField(visuals, environment, detail, new ScatterContext(map, terrain, layout.buildings)));
    const spawns = new MapSpawns(map, terrain);
    const yard = createTrainingYard(terrain, yardPlacement);
    progress("scene", 1, "done");
    timings.total = performance.now() - started;

    const colliderStats = colliders.stats();
    console.info(
      `[map] ${map.name} ready in ${timings.total.toFixed(0)} ms (terrain ${world.terrainSource}, layout ${layout.checksum}): ` +
        Object.entries(timings)
          .filter(([key]) => key !== "total")
          .map(([key, ms]) => `${key} ${ms.toFixed(0)}`)
          .join(", ") +
        ` · ${buildings.length} buildings, ${props.instanceCount} prop instances, ${colliderStats.bodies} prop bodies / ${colliderStats.shapes} shapes`,
    );
    const ready = Promise.all([material.ready, buildingVisuals.whenLoaded()]).then(() => undefined);
    return new MapRuntime(scene, map, world, physics, renderer, material, buildings, buildingVisuals, props, colliders, grass, spawns, ready, overlay, timings, yard, yardPlacement);
  }

  /**
   * Hooks the local player (out-of-bounds respawns) and audio: building surfaces first, then the terrain mask, plus room
   * enclosure for indoor reverb. Also hides the loading card.
   */
  attach(player: MapPlayer, audio?: AudioWorldProbe): void {
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
  }

  stats() {
    return { terrain: this.renderer.getStats(), buildings: this.buildingVisuals.stats(), props: this.props.stats(), colliders: this.colliders.stats(), grass: this.grass.instances };
  }

  dispose(): void {
    this.grass.dispose();
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
