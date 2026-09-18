import { Engine, HavokPlugin, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { ARENA_LEVEL, MOVEMENT, type PlayerDebugState } from "@twobullets/shared";
import { buildLevel } from "@twobullets/sim";
import { AssetLibrary, installAssetDevTools, type AssetLoadProgress, type Credit } from "../assets";
import { CombatSystem } from "../combat/CombatSystem";
import { installDebugTools } from "../debug/debugTools";
import { EquipmentSystem, soldierTargets } from "../equipment/EquipmentSystem";
import { LootRenderer, presentationLootModels } from "../equipment/loot";
import { OfflineMatch, readOfflineMatchOptions } from "../match";
import { netEquipmentOptions } from "../net/NetEquipmentView";
import { NetGame } from "../net/NetGame";
import { WeaponPresentation } from "../fx/WeaponPresentation";
import { InputManager } from "../input/InputManager";
import { DynamicResolution } from "../perf/DynamicResolution";
import { OPTIMIZATIONS } from "../perf/flags";
import { graphicsOf, loadGraphicsSettings } from "../perf/graphicsSettings";
import { classifyGpu, type GpuInfo } from "../perf/gpuClass";
import { PerfWatchdog } from "../perf/perfWatchdog";
import type { PerfTools } from "../perf/PerfTools";
import { PlayerController } from "../player/PlayerController";
import { PlayerLife } from "../player/PlayerLife";
import { Hud } from "../ui/Hud";
import { showFatalError } from "../ui/FatalError";
import { InventoryScreen } from "../ui/inventory";
import { cameraMapSource } from "../ui/map";
import type { PerfWarning } from "../ui/PerfWarning";
import { createEnvironment } from "../world/environment";
import { MAP_FAR_PLANE, MapOverlay, MapRuntime, resolveMapDefinition } from "../world/mapRuntime";
import { resolveLaunch, type GameLaunch } from "./launch";

/** Opens the low-FPS guide. Polled through the InputManager like the other function keys (debug/debugTools.ts). */
const PERF_HELP_KEY = "F10";

/**
 * Top-level wiring: engine, physics, assets, world, player, combat, equipment, HUD. Owns the frame loop.
 *
 * The mode comes from a `GameLaunch` (game/launch.ts): a networked match or practice from the menu, or DEV URL flags.
 * Networked (`{ kind: "net" }`, DEV `?net=ws://localhost:7350/m/local[&map=v1]`, docs/release/local-stack.md): the
 * server is authoritative for movement, combat and the battle royale loop; the local player's movement and weapons are
 * predicted and reconciled, remote players are interpolated, and NetMatch draws phases, zone, names and results from
 * server messages. Ground loot, inventory, armor, heals and throwables are the server's (B5 and v9, through the net
 * equipment view and NetThrowables); local equipment still reads the use hotkeys and runs the throwing hands; practice
 * dummies are off.
 */
export class Game {
  private net: NetGame | null = null;
  /** Reused every frame; the player's debug state is rebuilt only while the F3 panel shows it. */
  private hudState: { fps: number; player: PlayerDebugState } | null = null;

  private constructor(
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly input: InputManager,
    private readonly player: PlayerController,
    private readonly combat: CombatSystem,
    private readonly equipment: EquipmentSystem,
    private readonly presentation: WeaponPresentation,
    private readonly hud: Hud,
    private readonly loot: LootRenderer | null,
    private readonly inventory: InventoryScreen,
    private readonly world: MapRuntime | null,
    private readonly perf: PerfTools | null,
    private readonly dynamicResolution: DynamicResolution | null,
    private readonly match: OfflineMatch | null,
    private readonly gpu: GpuInfo,
    private readonly perfWarning: PerfWarning | null,
    private readonly perfWatchdog: PerfWatchdog | null,
  ) {}

  static async create(canvas: HTMLCanvasElement, hudRoot: HTMLDivElement, launch: GameLaunch = { kind: "dev" }): Promise<Game> {
    const params = new URLSearchParams(window.location.search);
    // DEV: `?bench=v1` runs the Map v1 benchmark (docs/perf/benchmark.md); it implies `?map=v1`. `?net=` joins a
    // server-match on `?map=` (default arena); `?bots=1` implies `?map=v1` unless `map` names another map.
    const resolved = resolveLaunch(launch, window.location.search, import.meta.env.DEV, readOfflineMatchOptions);
    const benchmark = resolved.benchmark;
    // The canvas's multisampling can't change after creation, so the saved AA mode (or DEV `?aa=`) decides it here.
    // A benchmark keeps it on: its MSAA/FXAA variants switch the pass at runtime.
    const aa = import.meta.env.DEV ? params.get("aa") : null;
    const msaa = benchmark !== null || (aa === "msaa" || aa === "fxaa" ? aa : loadGraphicsSettings().antiAliasing) === "msaa";
    const engine = new Engine(canvas, msaa, { stencil: true, preserveDrawingBuffer: false }, true);
    // Which GPU the browser actually bound: a Windows laptop can end up on the integrated chip with the discrete card
    // idle. Read once — it never changes for the life of the context. Advice only; nothing warns on the class alone.
    const gpu = classifyGpu(engine.getGlInfo().renderer, navigator.userAgent);
    const scene = new Scene(engine);
    // Aiming uses pointer lock and Havok raycasts; Babylon's per-mousemove picking has nothing to find.
    scene.skipPointerMovePicking = OPTIMIZATIONS.skipPointerMovePicking;

    const havok = await HavokPhysics();
    // Gravity lives in our own movement code for the player; the world value affects dynamic props only.
    scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, havok));

    // `v1|<realMapId>` loads a full map; null (or `arena`) keeps the blockout arena.
    const netConfig = resolved.net;
    const matchOptions = resolved.practice;
    const botsMatch = matchOptions !== null;
    const mapId = resolved.mapId;
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
    // Networked: ground loot is the server's (no local loot here); everyone starts with the networked starting kit (AR-4,
    // P-9, spare rounds, a frag and a smoke, Lv1 backpack). The server owns throwables (v9): a release is sent, not spawned.
    const equipment = new EquipmentSystem(scene, input, player, {
      ...(world && !net ? { map: { pois: world.map.pois, buildings: world.layout.buildings, outdoor: { flatten: world.map.flatten, terrain: world.terrain, layout: world.layout } } } : {}),
      ...(net ? netEquipmentOptions((release) => net.onThrowRelease(release)) : {}),
      targets: () => targets,
    });
    // Networked movement ignores equipment gates (the M3 server doesn't simulate equipment).
    if (!net) player.setMoveGates(() => equipment.modifiers);
    combat.attachEquipment(equipment);

    // Owns the equipment presentation (hands, grenades, smoke, fire, flash) and the audio director.
    const presentation = new WeaponPresentation(scene, player, combat, assets, environment);
    presentation.attachEquipment(equipment);
    presentation.audio.attachEquipment(equipment);
    // Networked: the server owns out-of-bounds, so the map doesn't respawn the player locally.
    world?.attach(net ? null : player, presentation.audio.probe);
    // Ground loot shares the presentation's throwable and consumable meshes (and their materials). Networked: the server's
    // loot through the net equipment view (created in `net.attach`).
    const loot = new LootRenderer(scene, net ? net.equipmentFor(equipment) : equipment, { assets, skyFill: environment.skyFill, models: presentationLootModels(presentation.itemMeshes) });

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
    // Networked: counts and item use come from the server through the net equipment view (created in `net.attach`).
    const inventory = new InventoryScreen(hudRoot, net ? net.equipmentFor(equipment) : equipment, input, { icons: { scene, assets, models: presentationLootModels(presentation.itemMeshes) } });
    // Tab and M release the mouse themselves; the pause menu must not open behind them.
    hud.addOverlaySource(() => inventory.isOpen);
    // DEV: `?teammate=1` simulates a standing teammate, so 0 HP knocks (revive with `__twobullets.life.revive()`).
    const life = new PlayerLife(player, equipment, equipment, { teammate: import.meta.env.DEV && params.get("teammate") === "1", respawn: !botsMatch });

    installDebugTools(scene, input, { hud });
    // Builds the nav grid (≈0.5 s), pooled bot soldiers and the spawn plan; the match starts on the first pointer lock.
    const match = matchOptions && world ? await OfflineMatch.create({ scene, input, player, combat, equipment, life, presentation, hud, world, assets, environment }, matchOptions) : null;

    // DEV: F4 or `?perf=1` stats panel, `?bench=v1` benchmark. Loaded on demand so production builds leave it out.
    let perf: PerfTools | null = null;
    if (import.meta.env.DEV) {
      const { PerfTools, readPerfOptions } = await import("../perf/PerfTools");
      perf = new PerfTools({ engine, scene, camera: player.camera, environment, world, targets: combat.targets, hud }, readPerfOptions(window.location.search));
    }
    // Off by default (`?opt=dynamicResolution:1&fps=120`); never during a benchmark, which measures fixed resolutions.
    const dynamicResolution = OPTIMIZATIONS.dynamicResolution && !benchmark ? new DynamicResolution(engine, { targetFps: Number(params.get("fps")) || 120 }) : null;

    // Low-FPS banner and its F10 guide. Off during a benchmark, which measures fixed settings on purpose.
    const perfWarning = benchmark ? null : hud.mountPerfWarning({ onReduceQuality: () => graphicsOf(scene)?.update({ preset: "performance" }) });
    const perfWatchdog = perfWarning ? new PerfWatchdog() : null;
    if (perfWarning) {
      // The guide gives the mouse back itself, so the lost pointer lock must not also pause the match. The banner is
      // not an overlay: it never takes the pointer, and it stays up for minutes — Esc must still reach the pause menu.
      hud.addOverlaySource(() => hud.perfGuideOpen);
      // F10 would open the browser's menu bar; the key state itself is polled through the InputManager in frame().
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.code === PERF_HELP_KEY) event.preventDefault();
        },
        { capture: true },
      );
      // DEV `?perfwarn=1|hybrid|software|unknown|discrete`: shows it now, so every guide variant can be checked.
      if (import.meta.env.DEV) {
        const forced = forcedGpu(params.get("perfwarn"), gpu);
        if (forced) perfWarning.show({ gpu: forced, fps: FORCED_PERF_WARN_FPS });
      }
    }

    const game = new Game(engine, scene, input, player, combat, equipment, presentation, hud, loot, inventory, world, perf, dynamicResolution, match, gpu, perfWarning, perfWatchdog);
    if (net) {
      // Networked: no offline life (the server owns health, knocks, deaths and respawns), weapons without equipment.
      life.dispose();
      net.attach({ scene, player, input, hudRoot, hud, combat, presentation, equipment, soldiers: { assets, environment }, world, mapId: mapDefinition?.id ?? "arena" });
      game.net = net;
      hud.setNetStats(() => net.client?.stats ?? null);
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
    this.hudState = { fps: 0, player: this.player.getDebugState() };
    // A throwing frame would stop Babylon's loop silently (a frozen picture): stop on purpose and say what failed.
    this.engine.runRenderLoop(() => {
      try {
        this.frame();
      } catch (error) {
        this.engine.stopRenderLoop();
        showFatalError(error, "frame");
      }
    });
    window.addEventListener("resize", () => this.engine.resize());
  }

  private frame(): void {
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
    this.loot?.update();
    this.world?.update(dt);
    perf?.beforeRender();
    this.scene.render();
    perf?.afterRender();
    this.hud.setFlashWhiteout(this.presentation.equipment.flashWhiteout);
    const hudState = this.hudState!;
    hudState.fps = this.engine.getFps();
    if (this.hud.statsVisible) hudState.player = this.player.getDebugState();
    this.hud.update(hudState);
    this.inventory.update();
    const warning = this.perfWarning;
    const watchdog = this.perfWatchdog;
    if (warning !== null && watchdog !== null && !perf?.drivesCamera) {
      // F10 opens the guide the banner points at, and closes it again (with the banner) once it is up.
      if (this.input.wasPressed(PERF_HELP_KEY)) {
        if (this.hud.perfGuideOpen) warning.hide();
        else warning.openGuide();
      }
      // Only sustained slowness raises it (never the GPU class alone); the object is built on that one frame.
      if (watchdog.update(performance.now(), hudState.fps)) warning.show({ gpu: this.gpu, fps: watchdog.averageFps });
    }
    this.input.endFrame();
    this.dynamicResolution?.update(performance.now(), this.engine.getDeltaTime());
    perf?.endFrame();
  }
}

/** Fake frame rate for the DEV `?perfwarn=` preview, low enough to read like the real thing. */
const FORCED_PERF_WARN_FPS = 13;

/**
 * DEV only (`?perfwarn=1|hybrid|software|unknown|discrete`): the GPU the warning should pretend to have found, so all
 * four guide intros and both step orderings can be seen without owning the hardware. `1` uses the real one.
 * Referenced from a `import.meta.env.DEV` branch only, so production builds drop it.
 */
function forcedGpu(flag: string | null, real: GpuInfo): GpuInfo | null {
  switch (flag) {
    case "1":
      return real;
    case "hybrid":
      return { renderer: "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)", gpuClass: "integrated", name: "Intel UHD Graphics", hybridHint: true };
    case "software":
      return { renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", gpuClass: "software", name: "SwiftShader Device", hybridHint: true };
    case "unknown":
      return { renderer: "WebKit WebGL", gpuClass: "unknown", name: "WebKit WebGL", hybridHint: false };
    case "discrete":
      return { renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5050 Laptop GPU (0x00002D18) Direct3D11 vs_5_0 ps_5_0, D3D11)", gpuClass: "discrete", name: "NVIDIA GeForce RTX 5050 Laptop GPU", hybridHint: false };
    default:
      return null;
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
