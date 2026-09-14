import { Engine, HavokPlugin, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { ARENA_LEVEL, MOVEMENT, buildLevel } from "@twobullets/shared";
import { AssetLibrary, installAssetDevTools, type AssetLoadProgress, type Credit } from "../assets";
import { CombatSystem } from "../combat/CombatSystem";
import { installDebugTools } from "../debug/debugTools";
import { WeaponPresentation } from "../fx/WeaponPresentation";
import { InputManager } from "../input/InputManager";
import { PlayerController } from "../player/PlayerController";
import { Hud } from "../ui/Hud";
import { createEnvironment } from "../world/environment";
import { MAP_FAR_PLANE, MapOverlay, MapRuntime } from "../world/mapRuntime";

/** Top-level wiring: engine, physics, assets, world, player, combat, HUD. Owns the frame loop. */
export class Game {
  private constructor(
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly input: InputManager,
    private readonly player: PlayerController,
    private readonly combat: CombatSystem,
    private readonly presentation: WeaponPresentation,
    private readonly hud: Hud,
    private readonly world: MapRuntime | null,
  ) {}

  static async create(canvas: HTMLCanvasElement, hudRoot: HTMLDivElement): Promise<Game> {
    const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true);
    const scene = new Scene(engine);

    const havok = await HavokPhysics();
    // Gravity lives in our own movement code for the player; the world value affects dynamic props only.
    scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, havok));

    // DEV: `?map=v1` loads the full Map v1; no query (or `?map=arena`) keeps the blockout arena.
    const mapV1 = import.meta.env.DEV && new URLSearchParams(window.location.search).get("map") === "v1";
    const environment = createEnvironment(scene, { largeWorld: mapV1 });
    // Models download while the map builds (its terrain comes from a worker) and the environment textures load.
    const assetsLoading = loadAssets(scene);
    const world = mapV1
      ? await MapRuntime.load(scene, environment, { bakeUrl: `${import.meta.env.BASE_URL}assets/map/mapV1.terrain.bin`, overlay: new MapOverlay() })
      : null;
    const levelData = world?.level ?? ARENA_LEVEL;
    const level = buildLevel(scene, levelData);
    environment.decorateLevel(level);
    const [assets] = await Promise.all([assetsLoading, environment.ready, world?.ready]);

    const input = new InputManager(canvas);
    const spawn = levelData.spawnPoints[0];
    if (!spawn) throw new Error(`Level "${levelData.name}" has no spawn points`);
    const player = new PlayerController(scene, input, levelData);
    if (world) player.camera.maxZ = MAP_FAR_PLANE;
    scene.activeCamera = player.camera;

    // Combat subscribes to player.onTick, so weapons step in lockstep with movement.
    const combat = new CombatSystem(scene, input, player, levelData, environment, assets);
    const presentation = new WeaponPresentation(scene, player, combat, assets, environment);
    world?.attach(player, presentation.audio.probe);

    const hud = new Hud(hudRoot, { onPlayClick: () => input.requestLock() });
    input.onLockChange((locked) => hud.setLocked(locked));
    hud.setLocked(input.isLocked);
    hud.attachCombat(combat, scene);
    void loadCredits(assets).then((lines) => hud.setCredits(lines));

    installDebugTools(scene, input, { hud });

    const game = new Game(engine, scene, input, player, combat, presentation, hud, world);
    if (import.meta.env.DEV) {
      installAssetDevTools(assets);
      // Console/automation handle for debugging; stripped from production builds.
      Object.assign(window, { __twobullets: { engine, scene, input, player, combat, presentation, hud, assets, world } });
    }
    game.start();
    return game;
  }

  private start(): void {
    this.engine.runRenderLoop(() => {
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      this.player.update(dt);
      this.combat.update(dt);
      this.presentation.update(dt);
      this.world?.update(dt);
      this.scene.render();
      this.hud.update({ fps: this.engine.getFps(), player: this.player.getDebugState() });
      this.input.endFrame();
    });
    window.addEventListener("resize", () => this.engine.resize());
  }
}

/** Weapon and character models; the soldiers can't exist without them, so a failure stops startup. */
async function loadAssets(scene: Scene): Promise<AssetLibrary> {
  let reported = -1;
  const onProgress = ({ progress, loadedBytes, totalBytes }: AssetLoadProgress) => {
    const step = Math.floor(progress * 4);
    if (step === reported) return;
    reported = step;
    console.info(`[assets] ${Math.round(progress * 100)}% (${(loadedBytes / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB)`);
  };
  try {
    return await AssetLibrary.load(scene, onProgress);
  } catch (error) {
    console.error("[assets] failed to load weapon/character assets", error);
    throw error;
  }
}

interface EnvironmentCredits {
  readonly assets: readonly {
    readonly name: string;
    readonly authors: readonly { readonly name: string }[];
    readonly license: string;
    readonly url: string;
  }[];
}

/** "Title by Author (License) — URL" for every attributed model plus the environment textures and sky. */
async function loadCredits(assets: AssetLibrary): Promise<string[]> {
  const format = (title: string, author: string, license: string, url: string) => `${title} by ${author} (${license}) — ${url}`;
  const lines = assets.requiredCredits.map((c: Credit) => format(c.title, c.author, c.license, c.url));
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}assets/environment/credits.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const environment = (await response.json()) as EnvironmentCredits;
    for (const entry of environment.assets) {
      lines.push(format(entry.name, entry.authors.map((a) => a.name).join(", "), entry.license, entry.url));
    }
  } catch (error) {
    console.warn("[credits] environment credits unavailable", error);
  }
  return lines;
}
