import { describe, expect, it } from "vitest";
import { MOVEMENT } from "../constants";
import type { CombatInput, FiredShot, WeaponContext, WeaponEvent, WeaponId, WeaponState } from "./types";
import { createWeaponState, currentSpreadDegrees, stepWeapon } from "./weaponStep";
import { WEAPONS } from "./weapons";

const DT = 1 / 60;

const idle: CombatInput = { fire: false, aim: false, reload: false, selectIndex: null };
const ctx: WeaponContext = { eye: { x: 1, y: 1.65, z: -3 }, yaw: 0.3, pitch: -0.1, horizontalSpeed: 0, grounded: true, sprinting: false };

function withInput(partial: Partial<CombatInput>): CombatInput {
  return { ...idle, ...partial };
}

/** State holding `id` as the only weapon, with overridden ammo. */
function stateFor(id: WeaponId, ammo: { magazine?: number; reserve?: number } = {}): WeaponState {
  const state = createWeaponState([id]);
  const slot = state.slots[0]!;
  return { ...state, slots: [{ ...slot, ...ammo }] };
}

interface Run {
  state: WeaponState;
  shots: FiredShot[];
  events: WeaponEvent[];
  shotTicks: number[];
}

function run(state: WeaponState, ticks: number, input: CombatInput | ((tick: number) => CombatInput), context = ctx): Run {
  const result: Run = { state, shots: [], events: [], shotTicks: [] };
  for (let i = 0; i < ticks; i++) {
    const step = stepWeapon(result.state, typeof input === "function" ? input(i) : input, context, DT);
    result.state = step.state;
    if (step.shots.length > 0) result.shotTicks.push(i);
    result.shots.push(...step.shots);
    result.events.push(...step.events);
  }
  return result;
}

describe("fire rate", () => {
  it("matches RPM over time for auto fire at 60 Hz", () => {
    const seconds = 10;
    const { shots } = run(stateFor("rifle", { magazine: 10_000 }), seconds * 60, withInput({ fire: true }));
    const interval = 60 / WEAPONS.rifle.roundsPerMinute;
    expect(Math.abs(shots.length - (Math.floor(seconds / interval) + 1))).toBeLessThanOrEqual(1);
  });

  it("fires at most one shot per tick", () => {
    const { shots, shotTicks } = run(stateFor("rifle", { magazine: 10_000 }), 120, withInput({ fire: true }));
    expect(new Set(shotTicks).size).toBe(shots.length);
    // 700 RPM = 5.14 ticks: gaps alternate between 5 and 6.
    for (let i = 1; i < shotTicks.length; i++) expect([5, 6]).toContain(shotTicks[i]! - shotTicks[i - 1]!);
  });

  it("semi needs the trigger released between shots", () => {
    const held = run(stateFor("pistol"), 120, withInput({ fire: true }));
    expect(held.shots).toHaveLength(1);

    // Tap every 12 ticks (0.2 s > 0.15 s cooldown).
    const tapped = run(stateFor("pistol"), 120, (t) => withInput({ fire: t % 12 < 2 }));
    expect(tapped.shots).toHaveLength(10);
  });

  it("semi presses during cooldown are dropped, not queued", () => {
    // Pistol interval 0.15 s = 9 ticks; tap every 4 ticks.
    const { shotTicks } = run(stateFor("pistol"), 40, (t) => withInput({ fire: t % 4 === 0 }));
    for (let i = 1; i < shotTicks.length; i++) expect(shotTicks[i]! - shotTicks[i - 1]!).toBeGreaterThanOrEqual(9);
  });

  it("bolt waits for the bolt cycle and a fresh press", () => {
    const cycleTicks = Math.round((60 / WEAPONS.sniper.roundsPerMinute) * 60);
    const spam = run(stateFor("sniper"), cycleTicks * 3, (t) => withInput({ fire: t % 2 === 0 }));
    expect(spam.shotTicks).toEqual([0, cycleTicks, cycleTicks * 2]);

    const held = run(stateFor("sniper"), cycleTicks * 3, withInput({ fire: true }));
    expect(held.shots).toHaveLength(1);
  });
});

describe("ammo and reload", () => {
  it("dry fires once per press and auto-reloads when reserve remains", () => {
    const result = run(stateFor("pistol", { magazine: 0, reserve: 20 }), 3, withInput({ fire: true }));
    expect(result.shots).toHaveLength(0);
    expect(result.events.filter((e) => e.type === "dryFire")).toHaveLength(1);
    expect(result.events.filter((e) => e.type === "reloadStarted")).toHaveLength(1);
    expect(result.state.phase).toBe("reloading");
  });

  it("dry fires without reloading when reserve is empty", () => {
    const result = run(stateFor("pistol", { magazine: 0, reserve: 0 }), 6, (t) => withInput({ fire: t % 2 === 0 }));
    expect(result.events.map((e) => e.type)).toEqual(["dryFire", "dryFire", "dryFire"]);
    expect(result.state.phase).toBe("ready");
  });

  it("auto-reloads when an auto weapon empties while the trigger is held", () => {
    const result = run(stateFor("rifle", { magazine: 3, reserve: 60 }), 30, withInput({ fire: true }));
    expect(result.shots).toHaveLength(3);
    expect(result.events.some((e) => e.type === "dryFire")).toBe(false);
    expect(result.state.phase).toBe("reloading");
  });

  it("refills the magazine from a partial reserve after reloadSeconds", () => {
    const def = WEAPONS.rifle;
    const reloadTicks = Math.round(def.reloadSeconds * 60);
    const start = run(stateFor("rifle", { magazine: 10, reserve: 12 }), 1, withInput({ reload: true }));
    expect(start.events).toEqual([{ type: "reloadStarted", weaponId: "rifle", seconds: def.reloadSeconds }]);

    const almost = run(start.state, reloadTicks - 1, idle);
    expect(almost.state.phase).toBe("reloading");
    expect(almost.state.slots[0]).toMatchObject({ magazine: 10, reserve: 12 });

    const done = run(almost.state, 1, idle);
    expect(done.events).toEqual([{ type: "reloadFinished", weaponId: "rifle" }]);
    expect(done.state.phase).toBe("ready");
    expect(done.state.slots[0]).toMatchObject({ magazine: 22, reserve: 0 });
  });

  it("ignores reload with a full magazine or no reserve", () => {
    expect(run(stateFor("rifle"), 1, withInput({ reload: true })).state.phase).toBe("ready");
    expect(run(stateFor("rifle", { magazine: 5, reserve: 0 }), 1, withInput({ reload: true })).state.phase).toBe("ready");
  });

  it("cannot fire while reloading", () => {
    const start = run(stateFor("rifle", { magazine: 10 }), 1, withInput({ reload: true }));
    expect(run(start.state, 60, withInput({ fire: true })).shots).toHaveLength(0);
  });
});

describe("switching", () => {
  it("cancels a reload, equips for equipSeconds and blocks firing meanwhile", () => {
    let state = createWeaponState(["rifle", "pistol"]);
    state = { ...state, slots: [{ ...state.slots[0]!, magazine: 5 }, state.slots[1]!], adsBlend: 1 };
    state = stepWeapon(state, withInput({ reload: true }), ctx, DT).state;
    expect(state.phase).toBe("reloading");

    const swap = stepWeapon(state, withInput({ selectIndex: 1 }), ctx, DT);
    expect(swap.events).toEqual([
      { type: "reloadCancelled", weaponId: "rifle" },
      { type: "equipStarted", weaponId: "pistol", seconds: WEAPONS.pistol.equipSeconds },
    ]);
    expect(swap.state).toMatchObject({ activeIndex: 1, phase: "equipping", adsBlend: 0 });
    expect(swap.state.slots[0]!.magazine).toBe(5);

    const equipTicks = Math.round(WEAPONS.pistol.equipSeconds * 60);
    const during = run(swap.state, equipTicks - 1, (t) => withInput({ fire: t % 2 === 1 }));
    expect(during.shots).toHaveLength(0);
    expect(during.state.phase).toBe("equipping");

    const after = run(during.state, 2, (t) => withInput({ fire: t === 0 }));
    expect(after.state.phase).toBe("ready");
    expect(after.shots).toHaveLength(1);
    expect(after.shots[0]!.weaponId).toBe("pistol");
  });

  it("ignores same and invalid indices", () => {
    const state = createWeaponState(["rifle", "pistol"]);
    for (const selectIndex of [0, 2, -1, 0.5]) {
      const step = stepWeapon(state, withInput({ selectIndex }), ctx, DT);
      expect(step.events).toHaveLength(0);
      expect(step.state.phase).toBe("ready");
      expect(step.state.activeIndex).toBe(0);
    }
  });
});

describe("ADS", () => {
  it("blends in over ads.seconds and back out", () => {
    const ticks = Math.round(WEAPONS.rifle.ads.seconds * 60);
    const half = run(stateFor("rifle"), Math.floor(ticks / 2), withInput({ aim: true }));
    expect(half.state.adsBlend).toBeGreaterThan(0.3);
    expect(half.state.adsBlend).toBeLessThan(0.7);

    const full = run(half.state, ticks, withInput({ aim: true }));
    expect(full.state.adsBlend).toBe(1);

    expect(run(full.state, ticks, idle).state.adsBlend).toBe(0);
  });

  it("is forced off while sprinting or reloading", () => {
    const aimed = run(stateFor("rifle", { magazine: 1 }), 30, withInput({ aim: true })).state;
    const sprint = run(aimed, 30, withInput({ aim: true }), { ...ctx, sprinting: true });
    expect(sprint.state.adsBlend).toBe(0);

    const reloading = run(aimed, 30, (t) => withInput({ aim: true, reload: t === 0 }));
    expect(reloading.state.phase).toBe("reloading");
    expect(reloading.state.adsBlend).toBe(0);
  });

  it("scales recoil down while aimed", () => {
    const hip = run(stateFor("rifle"), 1, withInput({ fire: true })).shots[0]!;
    const aimed = run(stateFor("rifle"), 30, (t) => withInput({ aim: true, fire: t === 29 })).shots[0]!;
    expect(hip.recoilUp).toBeCloseTo((WEAPONS.rifle.recoil.up * Math.PI) / 180);
    expect(aimed.recoilUp).toBeCloseTo(hip.recoilUp * WEAPONS.rifle.recoil.adsMultiplier);
  });
});

describe("spread", () => {
  it("adds moving, airborne and bloom penalties", () => {
    const def = WEAPONS.rifle;
    const state = stateFor("rifle");
    expect(currentSpreadDegrees(state, ctx)).toBeCloseTo(def.spread.hip);
    expect(currentSpreadDegrees({ ...state, adsBlend: 1 }, ctx)).toBeCloseTo(def.spread.ads);
    expect(currentSpreadDegrees(state, { ...ctx, horizontalSpeed: MOVEMENT.walkSpeed })).toBeCloseTo(def.spread.hip + def.spread.moving);
    expect(currentSpreadDegrees(state, { ...ctx, horizontalSpeed: 100 })).toBeCloseTo(def.spread.hip + def.spread.moving * 1.5);
    expect(currentSpreadDegrees(state, { ...ctx, grounded: false })).toBeCloseTo(def.spread.hip + def.spread.airborne);

    const after = run(state, 1, withInput({ fire: true })).state;
    expect(after.bloom).toBeCloseTo(def.spread.bloomPerShot);
    const sprayed = run(state, 120, withInput({ fire: true })).state;
    expect(sprayed.bloom).toBeLessThanOrEqual(def.spread.maxBloom);
    expect(run(sprayed, 120, idle).state.bloom).toBe(0);
  });

  it("produces unit directions within the cone, spread across it", () => {
    const def = WEAPONS.rifle;
    const halfAngle = def.spread.hip;
    const forward = { x: Math.sin(ctx.yaw) * Math.cos(ctx.pitch), y: -Math.sin(ctx.pitch), z: Math.cos(ctx.yaw) * Math.cos(ctx.pitch) };
    let outer = 0;
    const samples = 400;
    for (let i = 0; i < samples; i++) {
      const shot = stepWeapon({ ...stateFor("rifle"), shotCounter: i }, withInput({ fire: true }), ctx, DT).shots[0]!;
      const d = shot.directions[0]!;
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10);
      const angle = (Math.acos(Math.min(1, d.x * forward.x + d.y * forward.y + d.z * forward.z)) * 180) / Math.PI;
      expect(angle).toBeLessThanOrEqual(halfAngle + 1e-6);
      if (angle > halfAngle * Math.SQRT1_2) outer++;
    }
    // Uniform over the disk puts half the samples outside radius r/√2; clustering at the center would not.
    expect(outer / samples).toBeGreaterThan(0.4);
    expect(outer / samples).toBeLessThan(0.6);
  });

  it("aims along yaw/pitch conventions with zero spread", () => {
    const state = stateFor("sniper");
    const aimed = { ...state, adsBlend: 1 };
    const shot = stepWeapon(aimed, withInput({ fire: true, aim: true }), { ...ctx, yaw: Math.PI / 2, pitch: 0.5 }, DT).shots[0]!;
    const d = shot.directions[0]!;
    expect(d.x).toBeCloseTo(Math.cos(0.5));
    expect(d.y).toBeCloseTo(-Math.sin(0.5));
    expect(d.z).toBeCloseTo(0);
    expect(shot.origin).toEqual(ctx.eye);
  });

  it("fires the shotgun's pellet count within spread + pellet cone", () => {
    const def = WEAPONS.shotgun;
    const shot = run(stateFor("shotgun"), 1, withInput({ fire: true }), { ...ctx, yaw: 0, pitch: 0 }).shots[0]!;
    expect(shot.directions).toHaveLength(def.pellets);
    const maxTan = Math.tan((def.spread.hip * Math.PI) / 180) + Math.tan((def.spread.pelletCone * Math.PI) / 180);
    const unique = new Set(shot.directions.map((d) => `${d.x},${d.y}`));
    expect(unique.size).toBe(def.pellets);
    for (const d of shot.directions) {
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10);
      expect(Math.hypot(d.x, d.y) / d.z).toBeLessThanOrEqual(maxTan + 1e-9);
    }
  });
});

describe("determinism", () => {
  it("replays an identical input sequence to identical results", () => {
    const script = (t: number): CombatInput => ({
      fire: t % 7 < 5,
      aim: t % 50 > 20,
      reload: t === 200,
      selectIndex: t === 120 ? 1 : t === 300 ? 0 : t === 400 ? 3 : null,
    });
    const moving = (t: number): WeaponContext => ({ ...ctx, yaw: t * 0.01, horizontalSpeed: (t % 30) / 3, grounded: t % 90 > 10 });
    const once = () => {
      let state = createWeaponState(["rifle", "shotgun", "pistol", "sniper"]);
      const out: unknown[] = [];
      for (let t = 0; t < 600; t++) {
        const step = stepWeapon(state, script(t), moving(t), DT);
        state = step.state;
        out.push(step);
      }
      return out;
    };
    const a = once();
    expect(a).toEqual(once());
    expect(JSON.stringify(a)).toContain("recoilUp");
  });

  it("does not mutate its input state", () => {
    const state = stateFor("rifle");
    const snapshot = structuredClone(state);
    stepWeapon(state, withInput({ fire: true, aim: true }), ctx, DT);
    expect(state).toEqual(snapshot);
  });
});
