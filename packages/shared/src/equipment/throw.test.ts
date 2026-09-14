import { describe, expect, it } from "vitest";
import type { Vec3 } from "../movement/types";
import { IDLE_EQUIPMENT_INPUT, createPlayerEquipment, deriveEquipmentModifiers, stepPlayerEquipment, type EquipmentInput, type PlayerEquipmentState } from "./equipmentStep";
import { countItem, createInventory } from "./inventory";
import { ITEMS } from "./items";
import { len3 } from "./math";
import { createOfflineInventory } from "./presets";
import { createThrowState, stepThrow, THROW, throwLaunch, type ThrowContext, type ThrowEvent, type ThrowInput, type ThrowRelease, type ThrowState } from "./throw";

const DT = 1 / 60;
const EQUIP_TICKS = THROW.equipSeconds * 60;
const idle: ThrowInput = { equip: false, fire: false, aim: false, cook: false, holster: false };
const ctx: ThrowContext = { eye: { x: 0, y: 1.65, z: 0 }, yaw: 0, pitch: 0, velocity: { x: 0, y: 0, z: 0 }, selected: "frag", carried: 3, canAct: true };

interface Run {
  state: ThrowState;
  releases: { tick: number; release: ThrowRelease }[];
  events: { tick: number; event: ThrowEvent }[];
}

function run(ticks: number, input: (tick: number) => Partial<ThrowInput>, context: (tick: number) => Partial<ThrowContext> = () => ({}), state = createThrowState()): Run {
  const out: Run = { state, releases: [], events: [] };
  for (let t = 0; t < ticks; t++) {
    const step = stepThrow(out.state, { ...idle, ...input(t) }, { ...ctx, ...context(t) }, DT);
    out.state = step.state;
    if (step.release) out.releases.push({ tick: t, release: step.release });
    out.events.push(...step.events.map((event) => ({ tick: t, event })));
  }
  return out;
}

/** Equip on tick 0, pin pulled on `pin`, fire held until `release`, with optional cook tick. */
const script = (pin: number, release: number, cook?: number, extra: Partial<ThrowInput> = {}) => (t: number): Partial<ThrowInput> => ({
  equip: t === 0,
  fire: t >= pin && t < release,
  cook: t === cook,
  ...extra,
});

describe("throw and cook", () => {
  it("equips, pulls the pin on a fresh press and throws on release with the full fuse", () => {
    const pin = EQUIP_TICKS + 5;
    const result = run(pin + 60, script(pin, pin + 30));
    // Still carrying more: the next one is drawn after the throw animation.
    expect(result.events.map((e) => e.event.type)).toEqual(["throwEquipStarted", "pinPulled", "throwReleased", "throwEquipStarted"]);
    expect(result.releases).toHaveLength(1);
    const { tick, release } = result.releases[0]!;
    expect(tick).toBe(pin + 30);
    expect(release).toMatchObject({ kind: "frag", style: "overhand", fuse: ITEMS.frag.fuseSeconds, cooked: false, throwCounter: 0 });
    expect(result.state.throwCounter).toBe(1);
  });

  it("can't pull the pin while still equipping", () => {
    const result = run(EQUIP_TICKS + 30, script(1, EQUIP_TICKS + 20));
    expect(result.releases).toHaveLength(0);
    expect(result.state.phase).toBe("ready");
  });

  it("cooking starts the fuse in hand; the release carries the remaining time", () => {
    const pin = EQUIP_TICKS + 1;
    const result = run(pin + 200, script(pin, pin + 70, pin + 10));
    const cook = result.events.find((e) => e.event.type === "cookStarted")!;
    expect(cook.tick).toBe(pin + 10);
    const { release } = result.releases[0]!;
    expect(release.cooked).toBe(true);
    // 60 ticks after the cook tick = 1 s burnt.
    expect(release.fuse).toBeCloseTo(ITEMS.frag.fuseSeconds - 1, 6);
  });

  it("explodes in hand exactly when a cooked fuse runs out, even on a release tick", () => {
    const pin = EQUIP_TICKS + 1;
    const cookTick = pin + 5;
    const fuseTicks = ITEMS.frag.fuseSeconds * 60;
    const held = run(cookTick + fuseTicks + 30, script(pin, 10_000, cookTick));
    expect(held.releases).toHaveLength(1);
    expect(held.releases[0]!.tick).toBe(cookTick + fuseTicks);
    expect(held.releases[0]!.release).toMatchObject({ style: "inHand", fuse: 0 });
    expect(len3(held.releases[0]!.release.velocity.x, held.releases[0]!.release.velocity.y, held.releases[0]!.release.velocity.z)).toBe(0);

    const late = run(cookTick + fuseTicks + 5, script(pin, cookTick + fuseTicks, cookTick));
    expect(late.releases[0]!.release.style).toBe("inHand");
  });

  it("ignores cook for smokes, flashes and molotovs", () => {
    const pin = EQUIP_TICKS + 1;
    const result = run(pin + 100, script(pin, pin + 90, pin + 3), () => ({ selected: "smoke" }));
    expect(result.events.some((e) => e.event.type === "cookStarted")).toBe(false);
    expect(result.releases[0]!.release).toMatchObject({ kind: "smoke", fuse: ITEMS.smoke.fuseSeconds, cooked: false });
  });

  it("throws underhand while aiming, slower and flatter", () => {
    const pin = EQUIP_TICKS + 1;
    const over = run(pin + 20, script(pin, pin + 10)).releases[0]!.release;
    const under = run(pin + 20, script(pin, pin + 10, undefined, { aim: true })).releases[0]!.release;
    expect(under.style).toBe("underhand");
    const speed = (v: Vec3) => len3(v.x, v.y, v.z);
    expect(speed(over.velocity)).toBeCloseTo(THROW.overhand.speed, 6);
    expect(speed(under.velocity)).toBeCloseTo(THROW.underhand.speed, 6);
    expect(under.hand.y).toBeLessThan(over.hand.y);
  });

  it("adds most of the thrower's velocity", () => {
    const moving = throwLaunch({ ...ctx, velocity: { x: 5, y: 0, z: 0 } }, "overhand").velocity;
    const still = throwLaunch(ctx, "overhand").velocity;
    expect(moving.x - still.x).toBeCloseTo(5 * THROW.inheritVelocity, 6);
  });

  it("returns the pin when holstered before cooking, but drops a cooking grenade", () => {
    const pin = EQUIP_TICKS + 1;
    const returned = run(pin + 20, (t) => ({ ...script(pin, 10_000)(t), holster: t === pin + 10 }));
    expect(returned.releases).toHaveLength(0);
    expect(returned.events.map((e) => e.event.type)).toEqual(["throwEquipStarted", "pinPulled", "pinReturned", "throwableHolstered"]);
    expect(returned.state.phase).toBe("idle");

    const dropped = run(pin + 40, (t) => ({ ...script(pin, 10_000, pin + 2)(t), holster: t === pin + 32 }));
    expect(dropped.releases[0]!.release).toMatchObject({ style: "dropped", cooked: true });
    // Cooked on pin + 2; the fuse burnt on the 29 ticks before the holster tick.
    expect(dropped.releases[0]!.release.fuse).toBeCloseTo(ITEMS.frag.fuseSeconds - 29 / 60, 6);
    expect(dropped.state.phase).toBe("idle");
  });

  it("drops a cooking grenade when the thrower is knocked", () => {
    const pin = EQUIP_TICKS + 1;
    const result = run(pin + 30, script(pin, 10_000, pin + 1), (t) => ({ canAct: t < pin + 20 }));
    expect(result.releases[0]!.release.style).toBe("dropped");
    expect(result.state.phase).toBe("idle");
  });

  it("draws the next grenade after the throw animation, or reports depletion", () => {
    const pin = EQUIP_TICKS + 1;
    const releaseTick = pin + 5;
    const nextTicks = THROW.releaseSeconds * 60;
    const more = run(releaseTick + nextTicks + 2, script(pin, releaseTick), (t) => ({ carried: t > releaseTick ? 2 : 3 }));
    expect(more.events.at(-1)).toMatchObject({ tick: releaseTick + nextTicks, event: { type: "throwEquipStarted" } });

    const last = run(releaseTick + nextTicks + 2, script(pin, releaseTick), (t) => ({ carried: t > releaseTick ? 0 : 1, selected: t > releaseTick ? null : "frag" }));
    expect(last.events.at(-1)).toMatchObject({ event: { type: "throwablesDepleted", kind: "frag" } });
    expect(last.state.phase).toBe("idle");
  });

  it("re-equips when the selection changes under a ready hand", () => {
    const result = run(EQUIP_TICKS + 10, (t) => ({ equip: t === 0 }), (t) => ({ selected: t < EQUIP_TICKS + 5 ? "frag" : "flash" }));
    expect(result.state).toMatchObject({ phase: "equipping", kind: "flash" });
  });
});

describe("player equipment step", () => {
  const context = { eye: { x: 0, y: 1.65, z: 0 }, yaw: 0, pitch: 0, velocity: { x: 0, y: 0, z: 0 } };

  function runPlayer(ticks: number, input: (tick: number) => Partial<EquipmentInput>, state: PlayerEquipmentState = createPlayerEquipment(createOfflineInventory())) {
    const releases: ThrowRelease[] = [];
    const events: string[] = [];
    for (let t = 0; t < ticks; t++) {
      const step = stepPlayerEquipment(state, { ...IDLE_EQUIPMENT_INPUT, ...input(t) }, context, DT);
      state = step.state;
      if (step.release) releases.push(step.release);
      events.push(...step.events.map((e) => e.type));
    }
    return { state, releases, events };
  }

  it("removes a thrown grenade from the inventory and gates weapons while holding one", () => {
    const pin = EQUIP_TICKS + 1;
    const holding = runPlayer(pin + 2, (t) => ({ equipThrowablePressed: t === 0, fire: t >= pin, firePressed: t === pin }));
    expect(deriveEquipmentModifiers(holding.state)).toMatchObject({ allowWeapons: false, allowSprint: false });
    const thrown = runPlayer(pin + 20, (t) => ({ equipThrowablePressed: t === 0, fire: t >= pin && t < pin + 10, firePressed: t === pin }));
    expect(thrown.releases).toHaveLength(1);
    expect(countItem(thrown.state.inventory, "frag")).toBe(2);
  });

  it("cycles throwables with G, and blocks using items while the pin is pulled", () => {
    const cycled = runPlayer(2, (t) => ({ cycleThrowablePressed: t === 0 }));
    expect(cycled.state.inventory.selectedThrowable).toBe("smoke");
    expect(cycled.events).toContain("throwableSelected");

    const hurt = createPlayerEquipment(createOfflineInventory());
    const start = { ...hurt, vitals: { ...hurt.vitals, health: 50 } };
    const pin = EQUIP_TICKS + 1;
    const blocked = runPlayer(pin + 5, (t) => ({ equipThrowablePressed: t === 0, fire: t >= pin, firePressed: t === pin, useItem: t === pin + 2 ? "bandage" : null }), start);
    expect(blocked.state.use.itemId).toBeNull();
  });

  it("using an item puts the throwable away, slows movement and blocks weapons", () => {
    const hurt = createPlayerEquipment(createOfflineInventory());
    const start = { ...hurt, vitals: { ...hurt.vitals, health: 50 } };
    const result = runPlayer(EQUIP_TICKS + 5, (t) => ({ equipThrowablePressed: t === 0, useItem: t === EQUIP_TICKS + 2 ? "bandage" : null }), start);
    expect(result.state.use.itemId).toBe("bandage");
    expect(result.state.throw.phase).toBe("idle");
    expect(deriveEquipmentModifiers(result.state)).toMatchObject({ speedScale: 0.5, allowSprint: false, allowWeapons: false });
  });

  it("gives crawl modifiers while downed", () => {
    const base = createPlayerEquipment(createInventory());
    const downed = { ...base, vitals: { ...base.vitals, life: "downed" as const, health: 0, downedHealth: 100 } };
    const modifiers = deriveEquipmentModifiers(downed);
    expect(modifiers.crawl).toBe(true);
    expect(modifiers.allowWeapons).toBe(false);
    expect(modifiers.speedScale).toBeLessThan(0.2);
  });
});
