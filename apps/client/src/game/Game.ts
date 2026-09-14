import { Engine, HavokPlugin, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { ARENA_LEVEL, MOVEMENT, buildLevel } from "@twobullets/shared";
import { CombatSystem } from "../combat/CombatSystem";
import { installDebugTools } from "../debug/debugTools";
import { WeaponPresentation } from "../fx/WeaponPresentation";
import { InputManager } from "../input/InputManager";
import { PlayerController } from "../player/PlayerController";
import { Hud } from "../ui/Hud";
import { createEnvironment } from "../world/environment";

/** Top-level wiring: engine, physics, world, player, combat, HUD. Owns the frame loop. */
export class Game {
  private constructor(
    private readonly engine: Engine,
    private readonly scene: Scene,
    private readonly input: InputManager,
    private readonly player: PlayerController,
    private readonly combat: CombatSystem,
    private readonly presentation: WeaponPresentation,
    private readonly hud: Hud,
  ) {}

  static async create(canvas: HTMLCanvasElement, hudRoot: HTMLDivElement): Promise<Game> {
    const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true);
    const scene = new Scene(engine);

    const havok = await HavokPhysics();
    // Gravity lives in our own movement code for the player; the world value affects dynamic props only.
    scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, havok));

    const environment = createEnvironment(scene);
    const level = buildLevel(scene, ARENA_LEVEL);
    environment.decorateLevel(level);

    const input = new InputManager(canvas);
    const spawn = ARENA_LEVEL.spawnPoints[0];
    if (!spawn) throw new Error(`Level "${ARENA_LEVEL.name}" has no spawn points`);
    const player = new PlayerController(scene, input, ARENA_LEVEL);
    scene.activeCamera = player.camera;

    // Combat subscribes to player.onTick, so weapons step in lockstep with movement.
    const combat = new CombatSystem(scene, input, player, ARENA_LEVEL, environment);
    const presentation = new WeaponPresentation(scene, player, combat);

    const hud = new Hud(hudRoot, { onPlayClick: () => input.requestLock() });
    input.onLockChange((locked) => hud.setLocked(locked));
    hud.setLocked(input.isLocked);
    hud.attachCombat(combat, scene);

    installDebugTools(scene, input, { hud });

    const game = new Game(engine, scene, input, player, combat, presentation, hud);
    if (import.meta.env.DEV) {
      // Console/automation handle for debugging; stripped from production builds.
      Object.assign(window, { __twobullets: { engine, scene, input, player, combat, presentation, hud } });
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
      this.scene.render();
      this.hud.update({ fps: this.engine.getFps(), player: this.player.getDebugState() });
      this.input.endFrame();
    });
    window.addEventListener("resize", () => this.engine.resize());
  }
}
