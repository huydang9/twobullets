import { Btn } from "@twobullets/shared/input";
import type { LevelData } from "@twobullets/shared/level/types";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { combatInputInto, createCombatInput, createWeaponContext, stepPlayerWeapon, weaponContextInto } from "@twobullets/shared/weapons/playerWeapon";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import { DEFAULT_LOADOUT, WEAPONS } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { createSimWorld, type SimWorld } from "@twobullets/sim/index";
import { createMapSimWorld, type MapSimWorld } from "@twobullets/sim/map/mapCollision";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMapV1 } from "../../../../packages/sim/test/match/mapV1World";
import { HoldToggles } from "../../src/input/holdToggle";
import type { InputManager } from "../../src/input/InputManager";
import { PlayerController } from "../../src/player/PlayerController";

// "Zoom flicker" regression: the rendered camera (FOV, position) must be smooth at high render rates across
// walk -> sprint -> stop and ADS in/out. On Map v1 terrain the tick speed dips for a tick or two while sprinting
// (collision contacts), which used to pump the sprint FOV and kick the step-smoothing camera offset.

const FLAT: LevelData = {
  name: "flat",
  killY: -20,
  spawnPoints: [{ position: [0, 0, -150], yaw: 0 }],
  blocks: [{ kind: "box", name: "floor", surface: "ground", position: [0, -0.5, 0], size: [400, 1, 400] }],
  targets: [],
};

/** Scripted keys by time, seconds. */
const SCRIPT = { forward: [0.5, 6], sprint: [2, 4], aim: [4.5, 5.5], end: 7 } as const;

interface Frame {
  t: number;
  dt: number;
  x: number;
  y: number;
  z: number;
  fov: number;
  tickSpeed: number;
  /** Tick feet y + stance eye height, without interpolation or the camera-only offsets. */
  baseEyeY: number;
}

function run(world: SimWorld, level: LevelData, fps: number, jitter: boolean): Frame[] {
  const held = new Set<string>();
  const source = {
    isLocked: true,
    isActionDown: (action: string) => held.has(action),
    wasActionPressed: () => false,
    lookDelta: () => ({ dx: 0, dy: 0 }),
  };
  const input = { ...source, holds: new HoldToggles(source as never) } as unknown as InputManager;
  const player = new PlayerController(world.scene, input, level);

  // Weapon tick + CombatSystem's render-side ADS chase and zoom (non-scoped rifle).
  let weapon: WeaponState = createWeaponState(DEFAULT_LOADOUT);
  const def = WEAPONS[DEFAULT_LOADOUT[0]!];
  const ctx = createWeaponContext();
  const combat = createCombatInput();
  player.setCombatLink({
    get weaponState() {
      return weapon;
    },
    takeCombatInput(out) {
      out.buttons = held.has("aim") ? Btn.aim : 0;
      out.select = 0;
    },
  });
  player.onTick.add((tick) => {
    const c = weaponContextInto(ctx, player.tickFeet, tick.state, tick.playerInput);
    weapon = stepPlayerWeapon(weapon, combatInputInto(combat, tick.playerInput), c, tick.dt, false).state;
  });
  let adsBlend = 0;

  const frames: Frame[] = [];
  let seed = 7;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let t = 0;
  while (t < SCRIPT.end) {
    held.clear();
    for (const key of ["forward", "sprint", "aim"] as const) if (t >= SCRIPT[key][0] && t < SCRIPT[key][1]) held.add(key);
    const dt = (1 / fps) * (jitter ? 0.85 + random() * 0.3 : 1);
    t += dt;
    player.update(dt);
    const maxStep = (1.25 * dt) / def.ads.seconds;
    adsBlend += Math.min(maxStep, Math.max(-maxStep, weapon.adsBlend - adsBlend));
    player.setZoom(def.ads.fovDegrees, adsBlend);

    const p = player.camera.position;
    const v = player.moveState.velocity;
    const eye = player.getEyeToRef(p.clone());
    frames.push({ t, dt, x: p.x, y: p.y, z: p.z, fov: player.camera.fov, tickSpeed: Math.sqrt(v.x * v.x + v.z * v.z), baseEyeY: eye.y });
  }
  player.dispose();
  return frames;
}

function window(frames: readonly Frame[], from: number, to: number): Frame[] {
  return frames.filter((f) => f.t >= from && f.t < to);
}

/** Largest step against the expected direction (+1 non-decreasing, -1 non-increasing), radians. */
function worstReversal(frames: readonly Frame[], direction: 1 | -1): number {
  let worst = 0;
  for (let i = 1; i < frames.length; i++) worst = Math.max(worst, -direction * (frames[i]!.fov - frames[i - 1]!.fov));
  return worst;
}

function cameraSpeeds(frames: readonly Frame[]): number[] {
  const speeds: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    speeds.push(Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / b.dt);
  }
  return speeds;
}

// A frame's zoom setting reaches the camera on the next frame (as in Game: player.update, then combat.update).
const FRAME_LAG = 0.05;
/** Reversals below this are float noise, radians (≈ 0.0006°; the pumping bug reversed by up to ~0.05 rad). */
const FOV_EPSILON = 1e-5;

function expectMonotonicFov(frames: readonly Frame[]): void {
  const [sprintOn, sprintOff] = SCRIPT.sprint;
  const [aimOn, aimOff] = SCRIPT.aim;
  expect(worstReversal(window(frames, sprintOn, sprintOff), 1)).toBeLessThan(FOV_EPSILON);
  expect(worstReversal(window(frames, sprintOff + FRAME_LAG, aimOn), -1)).toBeLessThan(FOV_EPSILON);
  expect(worstReversal(window(frames, aimOn + FRAME_LAG, aimOff), -1)).toBeLessThan(FOV_EPSILON);
  expect(worstReversal(window(frames, aimOff + FRAME_LAG, SCRIPT.end), 1)).toBeLessThan(FOV_EPSILON);
  // The sprint kick and the ADS zoom actually happened.
  const fovs = frames.map((f) => f.fov);
  expect(Math.max(...fovs) - fovs[0]!).toBeGreaterThan(0.1);
  expect(fovs[0]! - Math.min(...fovs)).toBeGreaterThan(0.2);
}

describe("player camera smoothness", () => {
  let flat: SimWorld;
  beforeAll(async () => {
    flat = await createSimWorld(await loadHavok(), FLAT);
  });
  afterAll(() => flat?.dispose());

  for (const [fps, jitter] of [[60, false], [125, false], [125, true], [144, false]] as const) {
    it(`flat ground at ${fps} fps${jitter ? " with frame jitter" : ""}: monotonic FOV, camera moves at the tick speed`, () => {
      const frames = run(flat, FLAT, fps, jitter);
      expectMonotonicFov(frames);
      // Steady walk and sprint: the interpolated camera moves at the simulated speed every frame (no 60 Hz steps).
      for (const [from, to] of [[1.5, 2], [3, 4]] as const) {
        const steady = window(frames, from, to);
        const speeds = cameraSpeeds(steady);
        const tick = steady[steady.length - 1]!.tickSpeed;
        for (const speed of speeds) expect(Math.abs(speed - tick)).toBeLessThan(0.05 * (jitter ? 2 : 1));
      }
    }, 60_000);
  }
});

describe("player camera smoothness on Map v1 terrain", () => {
  let map: MapSimWorld;
  let level: LevelData;
  beforeAll(async () => {
    map = createMapSimWorld(await loadHavok(), await loadMapV1());
    const spawn = MAP_V1.spawns[0]!;
    const feet = map.groundFeet(spawn.position[0], spawn.position[1]);
    level = { ...FLAT, killY: -1000, spawnPoints: [{ position: [feet.x, feet.y + 0.05, feet.z], yaw: spawn.yaw }] };
  }, 60_000);
  afterAll(() => map?.dispose());

  it("tick speed dips don't pump the sprint FOV or kick the camera height", () => {
    const frames = run(map, level, 125, false);
    expectMonotonicFov(frames);
    // Camera height stays within head bob of the eye (bob ≤ 1.5 × 0.018 m, plus a tick of slope) on this stretch.
    for (const f of window(frames, 1, 6)) expect(Math.abs(f.y - f.baseEyeY)).toBeLessThan(0.05);
  }, 60_000);
});
