import type { LevelData } from "@twobullets/shared/level/types";
import { createSimWorld, type SimWorld } from "@twobullets/sim/index";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CameraShake } from "../../src/equipment/presentation/support";
import { HoldToggles } from "../../src/input/holdToggle";
import type { InputManager } from "../../src/input/InputManager";
import { PlayerController } from "../../src/player/PlayerController";
import { Spring } from "../../src/viewmodel/Spring";

// "Tilted view" regression: Babylon's TargetCamera only re-derives `upVector` from the full rotation (yaw, pitch, roll)
// on frames where `rotation.z` changes. Once a punch/shake roll settled to a constant while the player looked up or
// down, the cached up vector kept that old pitch in the old heading; turning the mouse then rolled the whole view by
// up to that pitch. The rendered camera's roll must always equal the intended roll (punch), whatever the look history.

const FLAT: LevelData = {
  name: "flat",
  killY: -20,
  spawnPoints: [{ position: [0, 0, 0], yaw: 0.3 }],
  blocks: [{ kind: "box", name: "floor", surface: "ground", position: [0, -0.5, 0], size: [200, 1, 200] }],
  targets: [],
};

const FPS = 60;
const MAX_ROLL_ERROR = (0.5 * Math.PI) / 180;

/** Roll of the rendered camera from its world matrix (inverse view): right.y against up.y, radians. */
function renderedRoll(player: PlayerController): number {
  const m = player.camera.getWorldMatrix().m;
  return Math.atan2(m[1]!, m[5]!);
}

/**
 * Spawn, look down, take a roll punch that settles to exactly 0 (`settle` drives it each frame), then turn the mouse
 * horizontally. Returns the worst |rendered roll - intended roll| over the run, radians.
 */
function run(world: SimWorld, settle: (dt: number) => number, settleSeconds: number): { worst: number; turned: number } {
  let look = { dx: 0, dy: 0 };
  const source = {
    isLocked: true,
    isActionDown: () => false,
    wasActionPressed: () => false,
    lookDelta: () => look,
  };
  const input = { ...source, holds: new HoldToggles(source as never) } as unknown as InputManager;
  const player = new PlayerController(world.scene, input, FLAT);
  const dt = 1 / FPS;
  let worst = 0;
  const frame = (dx: number, dy: number, roll: number): void => {
    look = { dx, dy };
    player.update(dt);
    // As in the game: the punch is set in onBeforeRender, the view matrix is read when the scene renders.
    player.setCameraPunch(0, 0, roll);
    const intended = player.camera.rotation.z;
    worst = Math.max(worst, Math.abs(renderedRoll(player) - intended));
  };

  for (let i = 0; i < FPS / 2; i++) frame(0, 0, 0);
  // Look ~23° down.
  for (let i = 0; i < FPS / 2; i++) frame(0, 6, 0);
  const yaw0 = player.getAim().yaw;
  // Punch/shake roll while looking down, until it settles to exactly 0.
  let roll = 1;
  for (let t = 0; t < settleSeconds && roll !== 0; t += dt) frame(0, 0, (roll = settle(dt)));
  expect(roll).toBe(0);
  for (let i = 0; i < FPS / 4; i++) frame(0, 0, 0);
  // Turn right ~90° over a second, no roll input at all.
  for (let i = 0; i < FPS; i++) frame(12, 0, 0);
  const turned = player.getAim().yaw - yaw0;
  player.dispose();
  return { worst, turned };
}

describe("player camera roll", () => {
  let world: SimWorld;
  beforeAll(async () => {
    world = await createSimWorld(await loadHavok(), FLAT);
  });
  afterAll(() => world?.dispose());

  it("explosion shake that settles, then turning: rendered view has no roll", () => {
    const shake = new CameraShake();
    shake.add(0.8);
    const { worst, turned } = run(world, (dt) => shake.update(dt, true).z, 10);
    expect(turned).toBeGreaterThan(1.2);
    expect(worst).toBeLessThan(MAX_ROLL_ERROR);
  }, 60_000);

  it("weapon punch roll that decays to exactly 0, then turning: rendered view has no roll", () => {
    // Viewmodel punch spring (14 Hz, 0.55) after a heavy shotgun kick; it underflows to exactly 0 after ~15 s.
    const spring = new Spring(14, 0.55);
    spring.kick(0.05);
    const { worst, turned } = run(world, (dt) => spring.update(dt), 40);
    expect(turned).toBeGreaterThan(1.2);
    expect(worst).toBeLessThan(MAX_ROLL_ERROR);
  }, 60_000);
});
