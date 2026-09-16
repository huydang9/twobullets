import { encodeThrowArg, ReliableEventType, type OwnerItemsBlock } from "@twobullets/protocol";
import { EXPLOSION } from "@twobullets/shared/equipment/explosion";
import { FIRE } from "@twobullets/shared/equipment/fire";
import { SMOKE } from "@twobullets/shared/equipment/smoke";
import { countItem, createInventory } from "@twobullets/shared/equipment/inventory";
import { THROWABLE_KINDS, throwableDef, type ThrowableKind } from "@twobullets/shared/equipment/items";
import { Btn, PlayerActionType, type PlayerAction } from "@twobullets/shared/input";
import { createBotBrain } from "@twobullets/shared/bots/brain/brain";
import type { BotBrainFactory } from "@twobullets/shared/bots/types";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import type { HeadlessClient } from "../src/dev/HeadlessClient";
import type { Player } from "../src/match/Player";
import { createHarness, type Harness } from "./harness";

// Server-authoritative throwables (protocol v9): a `throwItem` action spawns a grenade into the match's shared
// EquipmentWorld, which flies it, detonates it and runs the shared blast / smoke / fire / flash rules; clients hear
// the grenade and the effects through `ThrowableUpdate` inside their area of interest.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

/** Arena floor corner well outside every blast and flash range used below (the interior is x, z ∈ [−35, 35]). */
const FAR_CORNER = { x: -30, y: 0, z: -30 } as const;

interface Controlled {
  readonly client: HeadlessClient;
  player: Player;
  act(action: PlayerAction): void;
  items(): OwnerItemsBlock | null;
}

async function setup(
  count = 2,
  options: Parameters<typeof createHarness>[1] = {},
  teamOf: (index: number) => number = (index) => index,
): Promise<{ h: Harness; players: Controlled[] }> {
  const h = await createHarness(havok, options);
  const players: Controlled[] = [];
  for (let i = 0; i < count; i++) {
    const client = h.connect({ team: teamOf(i), seed: 70 + i, interpDelayMs: 25 });
    let pending: PlayerAction | null = null;
    let items: OwnerItemsBlock | null = null;
    const c: Controlled = {
      client,
      player: null as unknown as Player,
      act: (action: PlayerAction) => {
        pending = action;
      },
      items: () => items,
    };
    client.script = (_tick, e) => {
      e.forward = 0;
      e.right = 0;
      e.buttons = 0;
      e.select = 0;
      e.action = pending;
      pending = null;
    };
    client.onSnapshot = (snap) => {
      if (snap.items) items = { ...snap.items, counts: [...snap.items.counts], throwables: [...(snap.items.throwables ?? [])] };
    };
    players.push(c);
  }
  h.run(400);
  for (const c of players) c.player = h.match.player(c.client.playerSlot)!;
  return { h, players };
}

/** Gives `p` a bag of throwables (and nothing else to get in the way). */
function armWithThrowables(p: Player, quantity = 9): void {
  p.inventory = createInventory({ stacks: THROWABLE_KINDS.map((itemId) => ({ itemId, quantity })) });
}

/**
 * `c` drops a grenade of `kind` at `at` (style `dropped`: it leaves the hand with no speed and lands at the feet),
 * then walks to `retreat` so its own blast doesn't decide the test. The fuse runs while the caller ticks on.
 */
function dropAt(h: Harness, c: Controlled, kind: ThrowableKind, at: { x: number; y: number; z: number }, retreat: { x: number; y: number; z: number } | null = FAR_CORNER): void {
  h.match.debugPlace(c.player.slot, at);
  c.act({ type: PlayerActionType.throwItem, arg: encodeThrowArg(kind, "dropped", throwableDef(kind).fuseSeconds) });
  // Let the action reach the server and the grenade spawn at the thrower's feet.
  h.run(300);
  if (retreat !== null) h.match.debugPlace(c.player.slot, retreat);
}

describe("networked throwables (arena)", () => {
  it("a thrown frag damages an enemy through the shared rules, and both clients see the grenade and the blast", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    const at = { x: 20, y: 0, z: 20 };
    h.match.debugPlace(b.player.slot, { x: at.x + 1, y: 0, z: at.z });
    dropAt(h, a, "frag", at);
    // The frag's fuse is 4.5 s.
    h.run(5500);

    expect(h.match.throwables!.stats.throws).toBe(1);
    // Both clients heard the grenade and then its detonation at the same point.
    expect(a.client.detonations.length).toBe(1);
    expect(b.client.detonations.length).toBe(1);
    const boom = b.client.detonations[0]!;
    expect(THROWABLE_KINDS[boom.kind]).toBe("frag");
    expect(boom.owner).toBe(a.player.slot);
    expect(Math.abs(boom.x - at.x)).toBeLessThan(0.8);
    expect(Math.abs(boom.z - at.z)).toBeLessThan(0.8);
    // Nothing is left flying on either client.
    expect(a.client.throwables.size).toBe(0);
    expect(b.client.throwables.size).toBe(0);

    expect(b.player.health).toBeLessThan(100);
    expect(a.player.combat.damageDealt).toBeGreaterThan(0);
    // The thrower walked out of its own blast, so it is untouched.
    expect(a.player.health).toBe(100);
    // The grenade left the bag exactly once and the owner items group says so.
    expect(countItem(a.player.inventory, "frag")).toBe(8);
    expect(a.items()!.throwables![THROWABLE_KINDS.indexOf("frag")]).toBe(8);
    expect(b.client.throwableMalformed).toBe(0);
    await h.dispose();
  }, 60_000);

  it("friendly fire is on: a frag hurts a teammate and the thrower standing in it", async () => {
    const { h, players } = await setup(2, { teamMode: "duo", maxPlayers: 10 }, () => 0);
    const [a, b] = players as [Controlled, Controlled];
    expect(a.player.teamId).toBe(b.player.teamId);
    armWithThrowables(a.player);
    const at = { x: 20, y: 0, z: 20 };
    h.match.debugPlace(b.player.slot, { x: at.x + 1, y: 0, z: at.z });
    // The thrower stays put this time.
    dropAt(h, a, "frag", at, null);
    h.run(5500);
    expect(b.player.health).toBeLessThan(100);
    expect(a.player.life === "dead" || a.player.health < 100).toBe(true);
    await h.dispose();
  }, 60_000);

  it("a frag behind the arena's cover crate deals far less than the same blast in the open (shared line of sight)", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    const throwables = h.match.throwables!;
    // The arena's 2 m cover crate stands at (9, 9). Compare a 3.2 m blast across it with the same blast in the open.
    const crate = { x: 9, z: 9 };
    const open = { x: crate.x + 14, y: 0, z: crate.z };

    h.match.debugPlace(b.player.slot, { x: open.x + 3.2, y: 0, z: open.z });
    dropAt(h, a, "frag", open);
    h.run(5500);
    const clear = 100 - b.player.health;
    expect(clear).toBeGreaterThan(20);

    b.player.vitals = { ...b.player.vitals, health: 100 };
    h.match.debugPlace(b.player.slot, { x: crate.x + 1.6, y: 0, z: crate.z });
    dropAt(h, a, "frag", { x: crate.x - 1.6, y: 0, z: crate.z });
    h.run(5500);
    const shielded = 100 - b.player.health;
    expect(shielded).toBeLessThan(clear);
    expect(throwables.stats.detonations).toBe(2);

    // Past the outer radius nothing lands at all.
    b.player.vitals = { ...b.player.vitals, health: 100 };
    h.match.debugPlace(b.player.slot, { x: open.x, y: 0, z: open.z });
    dropAt(h, a, "frag", { x: open.x, y: 0, z: open.z - EXPLOSION.frag.outerRadius - 6 });
    h.run(5500);
    expect(b.player.health).toBe(100);
    await h.dispose();
  }, 60_000);

  it("a smoke grenade makes a cloud both clients see, with the server's seed so the puffs match", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    const at = { x: 20, y: 0, z: 20 };
    h.match.debugPlace(b.player.slot, at);
    // The smoke fuse is 2 s.
    dropAt(h, a, "smoke", at, null);
    h.run(3000);

    const throwables = h.match.throwables!;
    expect(throwables.smokes.length).toBe(1);
    const cloud = throwables.smokes[0]!;
    expect(a.client.smokes.size).toBe(1);
    expect(b.client.smokes.size).toBe(1);
    const op = b.client.smokes.get(cloud.id)!;
    expect(op.seed >>> 0).toBe(cloud.seed >>> 0);
    // The op carries the detonation point; the client's createSmokeCloud lifts it to the same base.
    expect(Math.abs(op.x - cloud.base.x)).toBeLessThan(0.05);
    expect(Math.abs(op.z - cloud.base.z)).toBeLessThan(0.05);
    // Smoke never damages anybody.
    expect(b.player.health).toBe(100);
    // It ends on its own, and both clients are told.
    h.run((SMOKE.lifetime + 2) * 1000);
    expect(throwables.smokes.length).toBe(0);
    expect(a.client.smokes.size).toBe(0);
    expect(b.client.smokes.size).toBe(0);
    await h.dispose();
  }, 180_000);

  it("a molotov burns: a fire area both clients see, and damage over time while standing in it", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    const at = { x: 20, y: 0, z: 20 };
    h.match.debugPlace(b.player.slot, at);
    // A molotov shatters on its first impact: dropped from the hand it breaks on the floor at once.
    dropAt(h, a, "molotov", at);
    h.run(2000);

    const throwables = h.match.throwables!;
    expect(throwables.stats.fires).toBe(1);
    expect(a.client.fires.size).toBe(1);
    expect(b.client.fires.size).toBe(1);
    const before = b.player.health;
    expect(before).toBeLessThan(100);
    h.run(1000);
    expect(b.player.health).toBeLessThan(before);
    expect(100 - b.player.health).toBeGreaterThan(FIRE.damagePerTick);
    // It burns out and both clients are told.
    h.run((FIRE.lifetime + 3) * 1000);
    expect(throwables.world.fires.length).toBe(0);
    expect(a.client.fires.size).toBe(0);
    await h.dispose();
  }, 180_000);

  it("a flashbang only blinds the player looking at it, and only that client gets the flash op", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    // B stands 3 m from the bang (the client script sends yaw 0, so it faces +Z, straight at it).
    const victim = { x: -20, y: 0, z: 20 };
    const at = { x: -20, y: 0, z: 23 };
    h.match.debugPlace(b.player.slot, victim);
    // A retreats 60 m away, well past FLASH.deafRange; the flash fuse is 2 s.
    dropAt(h, a, "flash", at, { x: 25, y: 0, z: -25 });
    h.run(3000);

    expect(h.match.throwables!.stats.flashes).toBeGreaterThan(0);
    expect(b.player.vitals.blindSeconds).toBeGreaterThan(0);
    expect(b.client.flashes.length).toBe(1);
    expect(b.client.flashes[0]!.blind).toBeGreaterThan(0);
    // A was out of range: no blind, no op.
    expect(a.player.vitals.blindSeconds).toBe(0);
    expect(a.client.flashes.length).toBe(0);
    // A flash never damages.
    expect(b.player.health).toBe(100);
    expect(a.player.health).toBe(100);
    await h.dispose();
  }, 60_000);

  it("the starting kit's grenades: each throw lowers the owner items counts the client receives, down to none", async () => {
    const { h, players } = await setup(1);
    const [a] = players as [Controlled];
    const frag = THROWABLE_KINDS.indexOf("frag");
    const smoke = THROWABLE_KINDS.indexOf("smoke");
    expect(a.items()!.throwables![frag]).toBe(1);
    expect(a.items()!.throwables![smoke]).toBe(1);
    dropAt(h, a, "frag", { x: 20, y: 0, z: 20 });
    expect(a.items()!.throwables![frag]).toBe(0);
    expect(a.items()!.throwables![smoke]).toBe(1);
    dropAt(h, a, "smoke", { x: -20, y: 0, z: 20 });
    expect(a.items()!.throwables![smoke]).toBe(0);
    expect(countItem(a.player.inventory, "frag") + countItem(a.player.inventory, "smoke")).toBe(0);
    // Nothing left: refused, and the counts stay at zero.
    dropAt(h, a, "frag", { x: 20, y: 0, z: -20 });
    expect(h.match.throwables!.lastReject).toBe("notCarried");
    expect(a.items()!.throwables).toEqual([0, 0, 0, 0]);
    await h.dispose();
  }, 60_000);

  it("a throw with nothing in the bag is refused, and so are a knocked thrower and a bogus fuse", async () => {
    const { h, players } = await setup(2, { teamMode: "duo", maxPlayers: 10 });
    const [a] = players as [Controlled, Controlled];
    const throwables = h.match.throwables!;
    const fullFuse = throwableDef("frag").fuseSeconds;
    a.player.inventory = createInventory();
    a.act({ type: PlayerActionType.throwItem, arg: encodeThrowArg("frag", "overhand", fullFuse) });
    h.run(300);
    expect(throwables.stats.throws).toBe(0);
    expect(throwables.lastReject).toBe("notCarried");

    // Carrying one, but knocked: the hands are out of action and the grenade stays in the bag.
    armWithThrowables(a.player);
    a.player.vitals = { ...a.player.vitals, life: "downed", downedHealth: 80 };
    a.act({ type: PlayerActionType.throwItem, arg: encodeThrowArg("frag", "overhand", fullFuse) });
    h.run(300);
    expect(throwables.stats.throws).toBe(0);
    expect(throwables.lastReject).toBe("notAlive");
    expect(countItem(a.player.inventory, "frag")).toBe(9);

    // A fuse longer than the frag's own can't come from an honest client.
    a.player.vitals = { ...a.player.vitals, life: "alive", health: 100, downedHealth: 0 };
    a.act({ type: PlayerActionType.throwItem, arg: encodeThrowArg("frag", "overhand", 7.9) });
    h.run(300);
    expect(throwables.stats.throws).toBe(0);
    expect(throwables.lastReject).toBe("badArg");

    // The same throw with a legal fuse goes through.
    a.act({ type: PlayerActionType.throwItem, arg: encodeThrowArg("frag", "overhand", fullFuse) });
    h.run(300);
    expect(throwables.stats.throws).toBe(1);
    expect(countItem(a.player.inventory, "frag")).toBe(8);
    await h.dispose();
  }, 60_000);

  it("a grenade kill credits the thrower: Kill event, kill feed and the victim's death", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    const kills: { killer: number; victim: number }[] = [];
    a.client.onReliable = (event) => {
      if (event.type === ReliableEventType.Kill && !event.knock) kills.push({ killer: event.killer, victim: event.victim });
    };
    const at = { x: 20, y: 0, z: 20 };
    h.match.debugPlace(b.player.slot, at);
    b.player.vitals = { ...b.player.vitals, health: 20 };
    dropAt(h, a, "frag", at);
    h.run(5500);

    expect(b.player.life).toBe("dead");
    expect(a.player.combat.kills).toBe(1);
    expect(kills.at(-1)).toMatchObject({ killer: a.player.slot, victim: b.player.slot });
    expect(a.client.killFeeds).toBeGreaterThan(0);
    await h.dispose();
  }, 60_000);

  it("a server bot throws through the same shared hands and the same spawn path", async () => {
    // A scripted brain: take a throwable out (select 5), pull the pin (fire), let go 1 s later.
    let tick = 0;
    const brainFactory: BotBrainFactory = (options) => {
      const brain = createBotBrain(options);
      return {
        get slot() {
          return brain.slot;
        },
        get profile() {
          return brain.profile;
        },
        get perception() {
          return brain.perception;
        },
        get memory() {
          return brain.memory;
        },
        kickAim: (up, right) => brain.kickAim(up, right),
        reset: (yaw) => brain.reset(yaw),
        debug: () => brain.debug(),
        tick: (_view, out) => {
          const input = out.input as { forward: number; right: number; buttons: number; select: number; action: unknown };
          input.forward = 0;
          input.right = 0;
          input.select = 5;
          // Draw for 0.6 s, hold fire for 1 s, then release.
          input.buttons = tick > 40 && tick < 100 ? Btn.fire : 0;
          input.action = null;
          tick++;
        },
      };
    };
    const { h } = await setup(1, {
      botBrainFactory: brainFactory,
      configure: (config) => ({ ...config, teams: [...config.teams.slice(0, 1), { teamId: 1, accountIds: ["bot:0"] }, ...config.teams.slice(2)] }),
    });
    const throwables = h.match.throwables!;
    const bot = h.match.players.find((p) => p.bot !== null)!;
    expect(bot).toBeDefined();
    expect(countItem(bot.inventory, "frag")).toBe(1);
    h.run(3000);
    expect(throwables.stats.botThrows).toBe(1);
    expect(countItem(bot.inventory, "frag")).toBe(0);
    // The grenade is the bot's, and it goes off on its own fuse.
    h.run(5000);
    expect(throwables.stats.detonations).toBe(1);
    await h.dispose();
  }, 60_000);

  it("bandwidth: a frag from spawn to detonation costs a nearby client a few hundred bytes", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    armWithThrowables(a.player);
    const at = { x: 20, y: 0, z: 20 };
    h.match.debugPlace(b.player.slot, { x: at.x + 4, y: 0, z: at.z });
    const before = b.client.throwableBytes;
    dropAt(h, a, "frag", at);
    h.run(5500);
    const spent = b.client.throwableBytes - before;
    console.log(`[throwables] one frag, spawn to detonation (4.5 s fuse, corrections at 10 Hz): ${spent} B to a nearby client`);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(600);
    expect(b.client.throwableMalformed).toBe(0);
    await h.dispose();
  }, 60_000);
});
