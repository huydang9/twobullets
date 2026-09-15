import { createBitReader, createLootUpdateBuffer, decodeLootUpdateInto, LootOpCode, lootCellOfQ, NET_LOOT_ID_LIMIT, type LootOp } from "@twobullets/protocol";
import { createInventory, type InventoryState } from "@twobullets/shared/equipment/inventory";
import type { LootItem } from "@twobullets/shared/equipment/loot";
import { createNetStartingInventory } from "@twobullets/shared/equipment/presets";
import type { RaycastFn } from "@twobullets/shared/weapons/types";
import { describe, expect, it } from "vitest";
import { resolveServerLevel } from "../src/level/serverLevel";
import type { Player } from "../src/match/Player";
import { LOOT_BYTES_PER_TICK, LootViewer, ServerLoot } from "../src/match/ServerLoot";

// ServerLoot without a match: area-of-interest streaming, change fan-out, id limits, sight checks and bandwidth with 20
// clients on Map v1's real loot layout.

interface FakeClient {
  readonly player: Player;
  /** The player's feet (mutable). */
  readonly feet: { x: number; y: number; z: number };
  readonly items: Map<number, LootOp>;
  bytes: number;
  messages: number;
}

const decodeBuffer = createLootUpdateBuffer();

function fakePlayer(slot: number, x: number, z: number, inventory: InventoryState = createNetStartingInventory()): FakeClient {
  const items = new Map<number, LootOp>();
  const feet = { x, y: 0, z };
  const client: FakeClient = { player: null as unknown as Player, feet, items, bytes: 0, messages: 0 };
  const session = {
    sendStream(bytes: Uint8Array) {
      client.bytes += bytes.length;
      client.messages++;
      expect(decodeLootUpdateInto(createBitReader(bytes), decodeBuffer)).toBe(true);
      for (let i = 0; i < decodeBuffer.count; i++) {
        const op = decodeBuffer.ops[i]!;
        if (op.op === LootOpCode.spawn) items.set(op.lootId, { ...op });
        else if (op.op === LootOpCode.remove) items.delete(op.lootId);
        else if (op.op === LootOpCode.quantity) items.get(op.lootId)!.quantity = op.quantity;
        else if (op.op === LootOpCode.clear) items.clear();
        else if (op.op === LootOpCode.forgetCell) for (const [id, item] of items) if (lootCellOfQ(item.xCm, item.zCm) === op.cell) items.delete(id);
      }
    },
  };
  const player = {
    slot,
    session,
    body: { feet },
    get feet() {
      return this.body.feet;
    },
    lootView: new LootViewer(),
    life: "alive",
    reviveTarget: -1,
    bot: null,
    yawQ: 0,
    state: { move: { stance: "stand" }, weapon: { activeIndex: 0 } },
    inventory,
    armor: { helmet: null, vest: null },
  };
  (client as { player: Player }).player = player as unknown as Player;
  return client;
}

const item = (lootId: number, x: number, z: number, itemId: LootItem["itemId"] = "bandage", pileId = lootId): LootItem => ({ lootId, pileId, itemId, quantity: 5, position: [x, 0, z] });
const noWalls: RaycastFn = () => null;

describe("ServerLoot area of interest", () => {
  it("streams only cells within ~160 m, forgets them past ~190 m, and fans changes out only to clients that know the cell", () => {
    const layout = [item(0, 2, 2), item(1, 3, 2, "weapon_rifle"), item(2, 120, 0), item(3, 400, 0), item(4, 410, 5, "frag"), item(5, -900, 900)];
    const a = fakePlayer(0, 0, 0);
    const b = fakePlayer(1, 400, 0);
    const players = [a.player, b.player];
    const loot = new ServerLoot({ items: layout, raycastWorld: noWalls, players: () => players });
    expect(loot.stats.filtered).toBe(1);
    loot.replicate(players);
    expect([...a.items.keys()].sort()).toEqual([0, 1, 2]);
    expect([...b.items.keys()].sort()).toEqual([3]);
    expect(a.items.get(1)).toMatchObject({ magazine: 0, pileId: 1, ownDrop: false });

    // B takes the bandage at 400 m: A (who doesn't know that cell) hears nothing.
    b.feet.x = 399;
    const aMessages = a.messages;
    expect(loot.pickUp(b.player, 3)).toBeNull();
    loot.replicate(players);
    expect(b.items.has(3)).toBe(false);
    expect(a.messages).toBe(aMessages);

    // A walks east: the 400 m cell streams in (without the taken bandage), the origin cells are forgotten.
    a.feet.x = 280;
    loot.replicate(players);
    expect([...a.items.keys()].sort()).toEqual([2]);
    a.feet.x = 420;
    loot.replicate(players);
    expect([...a.items.keys()]).toEqual([]);
    a.feet.x = 0;
    loot.replicate(players);
    expect([...a.items.keys()].sort()).toEqual([0, 1, 2]);

    // A drop by B in A's area: A hears it (not as its own), B too if it knows the cell.
    b.feet.x = 1;
    loot.replicate(players);
    expect([...b.items.keys()].sort()).toEqual([0, 1, 2]);
    expect(loot.dropFor(b.player, 0x80 | 4 | (10 << 8))).toBe(true);
    loot.replicate(players);
    const dropped = [...b.items.values()].find((op) => op.lootId > 5)!;
    expect(dropped).toMatchObject({ quantity: 10, ownDrop: true });
    expect(a.items.get(dropped.lootId)).toMatchObject({ quantity: 10, ownDrop: false });

    // A partial pickup keeps the id: clients get the new quantity. Pockets only (50), 92 rounds (46): room for 2 bandages.
    a.player.inventory = createInventory({ stacks: [{ itemId: "ammo_556", quantity: 92 }] });
    expect(loot.pickUp(a.player, 0)).toBeNull();
    loot.replicate(players);
    expect(a.items.get(0)).toMatchObject({ quantity: 3 });
    expect(b.items.get(0)).toMatchObject({ quantity: 3 });

    // Reset (glide start): everyone is cleared and re-streamed with the generated layout.
    loot.reset();
    loot.replicate(players);
    expect([...a.items.keys()].sort()).toEqual([0, 1, 2]);
    expect(a.items.has(dropped.lootId)).toBe(false);
  });

  it("refuses pickups without sight, when dead, out of reach or while reviving; ids past the wire limit are reused", () => {
    const a = fakePlayer(0, 0, 0);
    const players = [a.player];
    let wall = false;
    const loot = new ServerLoot({ items: [item(0, 1, 0), item(1, 1, 0.5), item(NET_LOOT_ID_LIMIT - 1, 1, 1), item(NET_LOOT_ID_LIMIT, 1, 1)], raycastWorld: (from, to) => (wall ? { point: to, normal: from, fraction: 0.5, colliderId: null } : null), players: () => players });
    wall = true;
    expect(loot.pickUp(a.player, 0)).toBe("sight");
    wall = false;
    (a.player as { reviveTarget: number }).reviveTarget = 3;
    expect(loot.pickUp(a.player, 0)).toBe("busy");
    (a.player as { reviveTarget: number }).reviveTarget = -1;
    a.feet.x = 8;
    expect(loot.pickUp(a.player, 0)).toBe("reach");
    a.feet.x = 0;
    expect(loot.pickUp(a.player, 99)).toBe("gone");
    // An id past the 14-bit pickup field was filtered; drops still get wire ids (reused below the limit).
    expect(loot.stats.filtered).toBe(1);
    expect(loot.pickUp(a.player, 0)).toBeNull();
    expect(loot.dropFor(a.player, 0x80 | 12 | (1 << 8))).toBe(true);
    const ids = [...loot.ground.items.keys()];
    expect(Math.max(...ids)).toBeLessThan(NET_LOOT_ID_LIMIT);
    // The taken bandage's id 0 was free again.
    expect(loot.ground.items.get(0)).toMatchObject({ itemId: "bandage", quantity: 1 });
  });

  it("a join into a dense area streams within the per-tick byte budget, nearest cells first", () => {
    const layout: LootItem[] = [];
    for (let i = 0; i < 3000; i++) layout.push(item(i, ((i * 37) % 300) - 150, ((i * 53) % 300) - 150, i % 3 === 0 ? "weapon_rifle" : "ammo_556", Math.floor(i / 3)));
    const a = fakePlayer(0, 0, 0);
    const players = [a.player];
    const loot = new ServerLoot({ items: layout, raycastWorld: noWalls, players: () => players });
    loot.replicate(players);
    expect(a.bytes).toBeLessThanOrEqual(LOOT_BYTES_PER_TICK + 1200);
    expect(a.items.size).toBeGreaterThan(0);
    expect(a.items.size).toBeLessThan(3000);
    // Nearest first: the first tick's items are all near the player.
    for (const op of a.items.values()) expect(Math.abs(op.xCm - 65536)).toBeLessThan(6500);
    let ticks = 1;
    while (a.player.lootView.queue.length > 0 && ticks < 200) {
      loot.replicate(players);
      ticks++;
    }
    expect(a.items.size).toBe(3000);
    console.log(`[loot] dense join: 3000 items, ${a.bytes} B in ${a.messages} messages over ${ticks} ticks`);
  });

  it("bandwidth with 20 clients roaming Map v1's loot for 5 minutes (with pickups every 2 s)", async () => {
    const level = await resolveServerLevel("v1");
    const items = level.createLoot!(4242);
    const spawns = level.planTeamSpawns(4242, 5, 4).flatMap((plan) => plan.feet);
    const clients = spawns.map((feet, slot) => fakePlayer(slot, feet.x, feet.z));
    const players = clients.map((c) => c.player);
    const loot = new ServerLoot({ items, raycastWorld: noWalls, players: () => players, seed: 4242 });
    // Join: every client streams its area.
    for (let t = 0; t < 60; t++) loot.replicate(players);
    const join = clients.map((c) => c.bytes);
    const joinMs = 1000;
    const ticks = 5 * 60 * 60;
    let rng = 7;
    const random = () => ((rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) / 4294967296);
    const heading = clients.map(() => random() * Math.PI * 2);
    for (let t = 0; t < ticks; t++) {
      for (let i = 0; i < players.length; i++) {
        const feet = clients[i]!.feet;
        if (t % 300 === 0) heading[i] = random() * Math.PI * 2;
        // Sprint speed; turn back at the playable edge.
        feet.x += (Math.sin(heading[i]!) * 6.3) / 60;
        feet.z += (Math.cos(heading[i]!) * 6.3) / 60;
        if (Math.abs(feet.x) > 480 || Math.abs(feet.z) > 480) heading[i] = heading[i]! + Math.PI;
        if ((t + i * 7) % 120 === 0) {
          const near = [...loot.ground.items.values()].find((it) => Math.abs(it.position[0] - feet.x) < 25 && Math.abs(it.position[2] - feet.z) < 25);
          if (near) {
            feet.y = near.position[1];
            feet.x = near.position[0] - 1;
            feet.z = near.position[2];
            players[i]!.inventory = createNetStartingInventory();
            loot.pickUp(players[i]!, near.lootId);
          }
        }
      }
      loot.replicate(players);
    }
    const seconds = ticks / 60;
    const kbps = clients.map((c, i) => ((c.bytes - join[i]!) * 8) / 1000 / seconds);
    const mean = kbps.reduce((s, v) => s + v, 0) / kbps.length;
    const max = Math.max(...kbps);
    const joinMean = join.reduce((s, v) => s + v, 0) / join.length;
    console.log(
      `[loot] v1 20 clients: ${items.length} generated, join mean ${(joinMean / 1024).toFixed(1)} KB (max ${(Math.max(...join) / 1024).toFixed(1)} KB, within ${joinMs} ms); ` +
        `roaming ${seconds} s at 6.3 m/s with ${loot.stats.pickups} pickups: mean ${mean.toFixed(2)} kbps, max ${max.toFixed(2)} kbps per client`,
    );
    // Budget (docs/backend/netcode.md §8.3): ≤ 16 KB at join, ≤ 6 kbps while roaming.
    expect(Math.max(...join)).toBeLessThan(16 * 1024);
    expect(mean).toBeLessThan(6);
    for (const c of clients) expect(c.player.lootView.queue.length).toBe(0);
  }, 120_000);
});
