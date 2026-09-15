import { Engine, HavokPlugin, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { ARENA_LEVEL, MOVEMENT } from "@twobullets/shared";
import { buildLevel } from "@twobullets/sim";
import { AssetLibrary, installAssetDevTools, type AssetLoadProgress, type Credit } from "../assets";
import { CombatSystem } from "../combat/CombatSystem";
import { installDebugTools } from "../debug/debugTools";
import { EquipmentSystem, soldierTargets } from "../equipment/EquipmentSystem";
import { LootRenderer, presentationLootModels } from "../equipment/loot";
import { OfflineMatch, readOfflineMatchOptions } from "../match";
import { NetGame, readNetConfig } from "../net/NetGame";
import { WeaponPresentation } from "../fx/WeaponPresentation";
import { InputManager } from "../input/InputManager";
import { DynamicResolution } from "../perf/DynamicResolution";
import { OPTIMIZATIONS } from "../perf/flags";
import { loadGraphicsSettings } from "../perf/graphicsSettings";
import type { PerfTools } from "../perf/PerfTools";
import { PlayerController } from "../player/PlayerController";
import { PlayerLife } from "../player/PlayerLife";
import { Hud } from "../ui/Hud";
import { InventoryScreen } from "../ui/inventory";
import { cameraMapSource } from "../ui/map";
import { createEnvironment } from "../world/environment";
import { MAP_FAR_PLANE, MapOverlay, MapRuntime, resolveMapDefinition } from "../world/mapRuntime";

/**
 * Top-level wiring: engine, physics, assets, world, player, combat, equipment, HUD. Owns the frame loop.
 *
 * DEV `?net=ws://localhost:7350/m/local` joins a server-match (docs/backend/m4-local-run.md). The server is
 * authoritative for movement and combat (M4): the local player's movement and weapons are predicted and reconciled,
 * remote players are interpolated, hits, damage, knocks and kills come from the server. Equipment and loot stay local,
 * and there are no practice dummies in that mode. Without `?net` nothing changes.
 */
export class Game {
  private net: NetGame | null = null;

  private constructor(
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly input: InputManager,
    private readonly player: PlayerController,
    private readonly combat: CombatSystem,
    private readonly equipment: EquipmentSystem,
    private readonly presentation: WeaponPresentation,
    private readonly hud: Hud,
    private readonly loot: LootRenderer,
    private readonly inventory: InventoryScreen,
    private readonly world: MapRuntime | null,
    private readonly perf: PerfTools | null,
    private readonly dynamicResolution: DynamicResolution | null,
    private readonly match: OfflineMatch | null,
  ) {}

  static async create(canvas: HTMLCanvasElement, hudRoot: HTMLDivElement): Promise<Game> {
    const params = new URLSearchParams(window.location.search);
    // DEV: `?bench=v1` runs the Map v1 benchmark (docs/perf/benchmark.md); it implies `?map=v1`.
    const benchmark = import.meta.env.DEV ? params.get("bench") : null;
    // The canvas's multisampling can't change after creation, so the saved AA mode (or DEV `?aa=`) decides it here.
    // A benchmark keeps it on: its MSAA/FXAA variants switch the pass at runtime.
    const aa = import.meta.env.DEV ? params.get("aa") : null;
    const msaa = benchmark !== null || (aa === "msaa" || aa === "fxaa" ? aa : loadGraphicsSettings().antiAliasing) === "msaa";
    const engine = new Engine(canvas, msaa, { stencil: true, preserveDrawingBuffer: false }, true);
    const scene = new Scene(engine);
    // Aiming uses pointer lock and Havok raycasts; Babylon's per-mousemove picking has nothing to find.
    scene.skipPointerMovePicking = OPTIMIZATIONS.skipPointerMovePicking;

    const havok = await HavokPhysics();
    // Gravity lives in our own movement code for the player; the world value affects dynamic props only.
    scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, havok));

    // DEV: `?map=v1|<realMapId>` loads a full map; no query (or `?map=arena`) keeps the blockout arena.
    // DEV: `?bench=v1` implies `?map=v1`; `?bots=1` implies `?map=v1` unless `map` names another map. `?net=` runs the arena.
    const netConfig = import.meta.env.DEV && !benchmark ? readNetConfig(params) : null;
    const matchOptions = readOfflineMatchOptions(window.location.search);
    const botsMatch = import.meta.env.DEV && !benchmark && !netConfig && matchOptions.enabled;
    const mapId = !import.meta.env.DEV || netConfig ? null : benchmark === "v1" ? "v1" : (params.get("map") ?? (botsMatch ? "v1" : null));
    if (netConfig && params.get("map")) console.warn("[net] ?map= is ignored in networked play (the server runs the arena)");
    const mapDefinition = await resolveMapDefinition(mapId);
    const environment = createEnvironment(scene, { largeWorld: mapDefinition !== null });
    // Models download while the map builds (its terrain comes from a worker) and the environment textures load.
    const assetsLoading = loadAssets(scene);
    // Thousands of meshes and light exclusions are added while loading; resync materials once at the end instead.
    scene.blockMaterialDirtyMechanism = OPTIMIZATIONS.blockMaterialDirtyOnLoad;
    const world = mapDefinition ? await MapRuntime.load(scene, environment, { ...mapDefinition, overlay: new MapOverlay() }) : null;
    const levelData = world?.level ?? ARENA_LEVEL;
    const level = buildLevel(scene, levelData);
    environment.decorateLevel(level);
    const [assets] = await Promise.all([assetsLoading, environment.ready, world?.ready]);
    scene.blockMaterialDirtyMechanism = false;

    const input = new InputManager(canvas);
    const spawn = levelData.spawnPoints[0];
    if (!spawn) throw new Error(`Level "${levelData.name}" has no spawn points`);
    // Networked: the net clock drives ticks, the server places the player, movement uses the server's weapon/gates.
    const net = netConfig ? new NetGame(netConfig) : null;
    const player = new PlayerController(scene, input, levelData, net ? { clock: net.clock, spawnAuthority: "server", movement: net.movement } : {});
    if (world) player.camera.maxZ = MAP_FAR_PLANE;
    scene.activeCamera = player.camera;

    // Combat subscribes to player.onTick, so weapons step in lockstep with movement.
    const combat = new CombatSystem(scene, input, player, levelData, environment, assets, { targets: !botsMatch && !net });
    // Equipment ticks after combat. Its gates reach movement at tick time; vitals are the player's health.
    // Grenades go through the same soldier armor as bullets (`?targetArmor=1`).
    const targets = soldierTargets(combat.targets.dummies, combat.targetArmor);
    const equipment = new EquipmentSystem(scene, input, player, {
      ...(world ? { map: { pois: world.map.pois, buildings: world.layout.buildings } } : {}),
      targets: () => targets,
    });
    // Networked movement ignores equipment gates (the M3 server doesn't simulate equipment).
    if (!net) player.setMoveGates(() => equipment.modifiers);
    combat.attachEquipment(equipment);

    // Owns the equipment presentation (hands, grenades, smoke, fire, flash) and the audio director.
    const presentation = new WeaponPresentation(scene, player, combat, assets, environment);
    presentation.attachEquipment(equipment);
    presentation.audio.attachEquipment(equipment);
    world?.attach(player, presentation.audio.probe);
    // Ground loot shares the presentation's throwable and consumable meshes (and their materials).
    const loot = new LootRenderer(scene, equipment, { assets, skyFill: environment.skyFill, models: presentationLootModels(presentation.itemMeshes) });

    const hud = new Hud(hudRoot, { onPlayClick: () => input.requestLock() });
    input.onLockChange((locked) => hud.setLocked(locked));
    hud.setLocked(input.isLocked);
    hud.attachCombat(combat, scene);
    void loadCredits(assets).then((lines) => hud.setCredits(lines));

    // Equipment HUD (armor, boost, rings, prompts, pickup feed, death recap) lives in the combat HUD.
    hud.attachEquipment(equipment);
    // M: full-screen map (N zooms, wheel/drag), minimap bottom right; OfflineMatch swaps in zone and teammates.
    if (world && !benchmark) hud.attachMap({ world, input, source: cameraMapSource(player.camera) });
    // Tab: releases pointer lock while open and asks for it again on close (the play overlay's click is the fallback).
    const inventory = new InventoryScreen(hudRoot, equipment, input, { icons: { scene, assets, models: presentationLootModels(presentation.itemMeshes) } });
    // DEV: `?teammate=1` simulates a standing teammate, so 0 HP knocks (revive with `__twobullets.life.revive()`).
    const life = new PlayerLife(player, equipment, equipment, { teammate: import.meta.env.DEV && params.get("teammate") === "1", respawn: !botsMatch });

    installDebugTools(scene, input, { hud });
    // Builds the nav grid (≈0.5 s), pooled bot soldiers and the spawn plan; the match starts on the first pointer lock.
    const match = botsMatch && world ? await OfflineMatch.create({ scene, input, player, combat, equipment, life, presentation, hud, world, assets, environment }, matchOptions) : null;

    // DEV: F4 or `?perf=1` stats panel, `?bench=v1` benchmark. Loaded on demand so production builds leave it out.
    let perf: PerfTools | null = null;
    if (import.meta.env.DEV) {
      const { PerfTools, readPerfOptions } = await import("../perf/PerfTools");
      perf = new PerfTools({ engine, scene, camera: player.camera, environment, world, targets: combat.targets, hud }, readPerfOptions(window.location.search));
    }
    // Off by default (`?opt=dynamicResolution:1&fps=120`); never during a benchmark, which measures fixed resolutions.
    const dynamicResolution = OPTIMIZATIONS.dynamicResolution && !benchmark ? new DynamicResolution(engine, { targetFps: Number(params.get("fps")) || 120 }) : null;

    const game = new Game(engine, scene, input, player, combat, equipment, presentation, hud, loot, inventory, world, perf, dynamicResolution, match);
    if (net) {
      // Networked: no offline life (the server owns health, knocks, deaths and respawns), weapons without equipment.
      life.dispose();
      net.attach({ scene, player, input, hudRoot, hud, combat, presentation, equipment, soldiers: { assets, environment } });
      game.net = net;
      void net.connect();
    }
    if (import.meta.env.DEV) {
      installAssetDevTools(assets);
      // Console/automation handle for debugging; stripped from production builds.
      Object.assign(window, { __twobullets: { engine, scene, input, player, combat, equipment, life, presentation, hud, loot, inventory, assets, world, perf, net, match: match?.createDevHandle() ?? null } });
    }
    game.start();
    return game;
  }

  private start(): void {
    this.engine.runRenderLoop(() => {
      const perf = this.perf;
      perf?.beginFrame();
      const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
      // The benchmark poses the camera itself.
      this.net?.update(dt);
      if (!perf?.drivesCamera) this.player.update(dt);
      this.match?.update(dt);
      this.net?.lateUpdate(dt);
      this.combat.update(dt);
      this.equipment.update();
      this.presentation.update(dt);
      this.loot.update();
      this.world?.update(dt);
      perf?.beforeRender();
      this.scene.render();
      perf?.afterRender();
      this.hud.setFlashWhiteout(this.presentation.equipment.flashWhiteout);
      this.hud.update({ fps: this.engine.getFps(), player: this.player.getDebugState() });
      this.inventory.update();
      this.input.endFrame();
      this.dynamicResolution?.update(performance.now(), this.engine.getDeltaTime());
      perf?.endFrame();
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
