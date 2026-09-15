import { encodePickupArg, NetInventoryOp, type OwnerItemsBlock } from "@twobullets/protocol";
import { NET_RESPAWN_SECONDS } from "@twobullets/contracts";
import { createInventory } from "@twobullets/shared/equipment/inventory";
import { ITEM_IDS, ITEMS, type ItemId } from "@twobullets/shared/equipment/items";
import { createTestLoot } from "@twobullets/shared/equipment/presets";
import { encodeDropArg } from "@twobullets/shared/match/rules";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { Btn, PlayerActionType, type PlayerAction } from "@twobullets/shared/input";
import { computeDamage } from "@twobullets/shared/weapons/ballistics";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import type { HeadlessClient } from "../src/dev/HeadlessClient";
import { resolveServerLevel } from "../src/level/serverLevel";
import type { Player } from "../src/match/Player";
import { NET_DEATH_PILE_BASE } from "../src/match/ServerLoot";
import { createHarness, type Harness } from "./harness";

// plan.md B5 on the arena: the server's loot is the offline test piles minus throwables, streamed to clients; pickups,
// drops and swaps go through input actions with reach, sight and inventory checks; ammo drives reloads, armor soaks
// bullets, and a death drops the whole inventory as a pile someone else can loot.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

interface Controlled {
  readonly client: HeadlessClient;
  player: Player;
  /** Sends `action` on the next input tick (once). */
  act(action: PlayerAction): void;
  buttons: number;
  select: number;
  items(): OwnerItemsBlock | null;
}

async function setup(count = 1): Promise<{ h: Harness; players: Controlled[] }> {
  const h = await createHarness(havok);
  const players: Controlled[] = [];
  for (let i = 0; i < count; i++) {
    const client = h.connect({ team: i, seed: 60 + i, interpDelayMs: 25 });
    let pending: PlayerAction | null = null;
    let items: OwnerItemsBlock | null = null;
    const c = {
      client,
      player: null as unknown as Player,
      buttons: 0,
      select: 0,
      act: (action: PlayerAction) => (pending = action),
      items: () => items,
    };
    client.script = (_tick, e) => {
      e.forward = 0;
      e.right = 0;
      e.buttons = c.buttons;
      e.select = c.select;
      e.action = pending;
      pending = null;
    };
    client.onSnapshot = (snap) => {
      if (snap.items) items = { ...snap.items, counts: [...snap.items.counts], ammo: [...(snap.items.ammo ?? [])] };
    };
    players.push(c);
  }
  h.run(400);
  for (const c of players) c.player = h.match.player(c.client.playerSlot)!;
  return { h, players };
}

/** The ground item of `itemId` nearest to the arena spawn `pile`. */
function groundItem(h: Harness, itemId: ItemId, pile = 0) {
  const items = [...h.match.loot!.ground.items.values()].filter((item) => item.itemId === itemId && item.pileId === pile);
  expect(items.length).toBeGreaterThan(0);
  return items[0]!;
}

/** Stands `p` 1 m beside a ground position (same floor). */
function standBeside(h: Harness, p: Player, position: readonly [number, number, number], dx = -1): void {
  h.match.debugPlace(p.slot, { x: position[0] + dx, y: position[1], z: position[2] });
}

describe("networked loot (arena)", () => {
  it("loot is the offline arena test piles without throwables, and a client hears the items around it", async () => {
    const { h, players } = await setup(1);
    const loot = h.match.loot!;
    const offline = createTestLoot(ARENA_LEVEL.spawnPoints);
    const expected = offline.filter((item) => ITEMS[item.itemId].category !== "throwable");
    expect(loot.stats.filtered).toBe(offline.length - expected.length);
    expect([...loot.ground.items.values()].sort((a, b) => a.lootId - b.lootId)).toEqual(expected);
    // The whole 120 m arena is inside the area of interest.
    const mirror = players[0]!.client.loot;
    expect(mirror.size).toBe(expected.length);
    const sample = mirror.get(expected[5]!.lootId)!;
    expect(ITEM_IDS[sample.itemCode]).toBe(expected[5]!.itemId);
    expect(sample.pileId).toBe(expected[5]!.pileId);
    expect(players[0]!.client.lootMalformed).toBe(0);
    await h.dispose();
  }, 60_000);

  it("pickup within reach takes the item (and nearby clients drop it); out of reach is refused (sight: serverLoot.test.ts)", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    const loot = h.match.loot!;
    const shotgun = groundItem(h, "weapon_shotgun");

    h.match.debugPlace(a.player.slot, { x: shotgun.position[0] + 10, y: shotgun.position[1], z: shotgun.position[2] });
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(shotgun.lootId) });
    h.run(100);
    expect(loot.lastReject).toBe("reach");
    expect(loot.ground.items.has(shotgun.lootId)).toBe(true);

    standBeside(h, a.player, shotgun.position);
    h.run(50);
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(shotgun.lootId) });
    h.run(150);
    expect(loot.lastReject).toBeNull();
    expect(loot.ground.items.has(shotgun.lootId)).toBe(false);
    // Primary 2 was empty: the shotgun goes there and its slot follows on the next step.
    expect(a.player.inventory.weapons[1]).toEqual({ weaponId: "shotgun", magazine: 0 });
    expect(a.player.state.weapon.slots[1]).toMatchObject({ id: "shotgun", magazine: 0, reserve: 0 });
    expect(a.client.loot.has(shotgun.lootId)).toBe(false);
    expect(b.client.loot.has(shotgun.lootId)).toBe(false);
    await h.dispose();
  }, 60_000);

  it("two clients racing for one item: only one gets it", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    const vest = groundItem(h, "vest_1", 3);
    standBeside(h, a.player, vest.position, -0.8);
    standBeside(h, b.player, vest.position, 0.8);
    h.run(50);
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(vest.lootId) });
    b.act({ type: PlayerActionType.pickup, arg: encodePickupArg(vest.lootId) });
    h.run(200);
    const winners = [a, b].filter((c) => c.player.inventory.vest !== null);
    expect(winners).toHaveLength(1);
    expect(h.match.loot!.stats.pickups).toBe(1);
    expect(h.match.loot!.stats.pickupsRejected).toBe(1);
    // The winner's armor is the looted piece (vitals group and damage read it).
    expect(winners[0]!.player.armor.vest).toEqual({ level: 1, durability: 60 });
    await h.dispose();
  }, 60_000);

  it("an ammo pickup enables a reload; the owner items group carries the ammo and backpack; drop and swap actions", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    const p = a.player;
    // Empty rifle, no spare 5.56.
    p.inventory = createInventory({ ...p.inventory, weapons: [{ weaponId: "rifle", magazine: 0 }, null, p.inventory.weapons[2]], stacks: p.inventory.stacks.filter((s) => s.itemId !== "ammo_556") });
    h.run(200);
    expect(p.state.weapon.slots[0]).toMatchObject({ id: "rifle", magazine: 0, reserve: 0 });
    a.buttons = Btn.reload;
    h.run(50);
    a.buttons = 0;
    h.run(3000);
    expect(p.state.weapon.slots[0]!.magazine).toBe(0);

    const ammo = groundItem(h, "ammo_556", 1);
    standBeside(h, p, ammo.position);
    h.run(50);
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(ammo.lootId) });
    h.run(150);
    expect(p.state.weapon.slots[0]).toMatchObject({ magazine: 0, reserve: 60 });
    expect(a.items()!.ammo).toEqual([60, 0, 24, 0]);
    expect(a.items()!.backpack).toBe(1);
    a.buttons = Btn.reload;
    h.run(50);
    a.buttons = 0;
    h.run(WEAPONS.rifle.reloadSeconds * 1000 + 300);
    expect(p.state.weapon.slots[0]).toMatchObject({ magazine: 30, reserve: 30 });
    expect(p.inventory.stacks.find((s) => s.itemId === "ammo_556")?.quantity).toBe(30);
    expect(a.items()!.ammo![0]).toBe(30);

    // Drop 10 rounds: they land in front, flagged as the dropper's own for auto pickup.
    const before = new Set(h.match.loot!.ground.items.keys());
    a.act({ type: PlayerActionType.drop, arg: encodeDropArg({ kind: "stack", code: ITEM_IDS.indexOf("ammo_556"), quantity: 10 }) });
    h.run(150);
    const dropped = [...h.match.loot!.ground.items.values()].find((item) => !before.has(item.lootId))!;
    expect(dropped).toMatchObject({ itemId: "ammo_556", quantity: 10 });
    expect(p.inventory.stacks.find((s) => s.itemId === "ammo_556")?.quantity).toBe(20);
    expect(a.client.loot.get(dropped.lootId)?.ownDrop).toBe(true);
    expect(b.client.loot.get(dropped.lootId)?.ownDrop).toBe(false);

    // Swap primaries once a second primary is carried.
    const shotgun = groundItem(h, "weapon_shotgun", 1);
    standBeside(h, p, shotgun.position);
    h.run(50);
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(shotgun.lootId) });
    h.run(150);
    expect(p.inventory.weapons.map((w) => w?.weaponId ?? null)).toEqual(["rifle", "shotgun", "pistol"]);
    a.act({ type: PlayerActionType.equipAttach, arg: NetInventoryOp.swapPrimaries });
    h.run(150);
    expect(p.inventory.weapons.map((w) => w?.weaponId ?? null)).toEqual(["shotgun", "rifle", "pistol"]);
    // A pistol dragged onto the sidearm slot swaps out the carried one where the new one lay.
    const pistol = groundItem(h, "weapon_pistol", 1);
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(pistol.lootId, 2) });
    h.run(150);
    expect(p.inventory.weapons[2]).toEqual({ weaponId: "pistol", magazine: 12 });
    const swappedOut = [...h.match.loot!.ground.items.values()].filter((item) => item.itemId === "weapon_pistol" && item.pileId === -1);
    expect(swappedOut).toHaveLength(1);
    await h.dispose();
  }, 60_000);

  it("armor reduces server bullet damage and loses durability; the inventory mirrors the worn piece", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    const combat = h.match.combat!;
    const hit = (victim: Player) => combat.playerHit(b.player.slot, 1, "rifle", victim.slot, "body", 10, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    const raw = computeDamage(WEAPONS.rifle, "body", 10);
    hit(a.player);
    expect(a.player.vitals.health).toBeCloseTo(100 - raw, 1);
    h.match.respawn(a.player);

    const vest = groundItem(h, "vest_1", 2);
    standBeside(h, a.player, vest.position);
    h.run(50);
    a.act({ type: PlayerActionType.pickup, arg: encodePickupArg(vest.lootId) });
    h.run(150);
    expect(a.player.armor.vest).toEqual({ level: 1, durability: 60 });
    hit(a.player);
    const absorbed = Math.round(raw * ITEMS.vest_1.reduction * 10) / 10;
    expect(a.player.vitals.health).toBeCloseTo(100 - (raw - absorbed), 1);
    expect(a.player.armor.vest!.durability).toBeCloseTo(60 - absorbed, 1);
    expect(a.player.inventory.vest).toEqual(a.player.armor.vest);
    await h.dispose();
  }, 60_000);

  it("death drops the whole inventory as a pile at the body; another player loots it; respawn gives the starting kit", async () => {
    const { h, players } = await setup(2);
    const [a, b] = players as [Controlled, Controlled];
    const loot = h.match.loot!;
    const feet = { ...a.player.feet };
    h.match.combat!.zoneDamage(a.player, 100);
    expect(a.player.life).toBe("dead");
    const pile = [...loot.ground.items.values()].filter((item) => item.pileId === NET_DEATH_PILE_BASE + a.player.slot);
    expect(pile.map((item) => item.itemId).sort()).toEqual(["ammo_556", "ammo_9mm", "backpack_1", "weapon_pistol", "weapon_rifle"]);
    for (const item of pile) expect(Math.sqrt((item.position[0] - feet.x) ** 2 + (item.position[2] - feet.z) ** 2)).toBeLessThan(0.6);
    expect(a.player.inventory.weapons).toEqual([null, null, null]);
    h.run(100);
    const ammo = pile.find((item) => item.itemId === "ammo_556")!;
    expect(b.client.loot.get(ammo.lootId)).toMatchObject({ quantity: 60 });

    standBeside(h, b.player, ammo.position);
    h.run(50);
    b.act({ type: PlayerActionType.pickup, arg: encodePickupArg(ammo.lootId) });
    h.run(150);
    expect(b.player.inventory.stacks.find((s) => s.itemId === "ammo_556")?.quantity).toBe(120);
    expect(b.client.loot.has(ammo.lootId)).toBe(false);

    h.run(NET_RESPAWN_SECONDS * 1000 + 300);
    expect(a.player.life).toBe("alive");
    expect(a.player.inventory.weapons.map((w) => w?.weaponId ?? null)).toEqual(["rifle", null, "pistol"]);
    await h.dispose();
  }, 60_000);
});

describe("loot generation on built maps", () => {
  it("Map v1: deterministic per seed, the offline generator's items minus throwables", async () => {
    const level = await resolveServerLevel("v1");
    const a = level.createLoot!(1234);
    const b = level.createLoot!(1234);
    const c = level.createLoot!(99);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    expect(a.length).toBeGreaterThan(1500);
    const kept = a.filter((item) => ITEMS[item.itemId].category !== "throwable");
    expect(kept.length).toBeLessThan(a.length);
    expect(Math.max(...a.map((item) => item.lootId))).toBeLessThan(1 << 14);
    console.log(`[loot] v1 seed 1234: ${a.length} items (${kept.length} without throwables)`);
  }, 120_000);
});
