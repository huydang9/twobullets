import { ITEM_IDS, ITEMS, type ItemId } from "@twobullets/shared/equipment/items";
import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { describeMessage } from "../src/debug/describe";
import {
  createLootUpdateBuffer,
  decodeLootUpdate,
  decodeLootUpdateInto,
  decodePickupArg,
  dequantizeLootXZ,
  dequantizeLootY,
  encodePickupArg,
  LOOT_CELL_M,
  LOOT_GRID_CELLS,
  LOOT_OP_MAX_BYTES,
  LOOT_UPDATE_SOFT_BYTES,
  lootCellDistance,
  lootCellOf,
  lootCellOfQ,
  LootOpCode,
  LootUpdateWriter,
  NET_LOOT_ID_LIMIT,
  quantizeLootXZ,
  type LootSpawnItem,
} from "../src/messages/loot";
import { MsgId } from "../src/messages/ids";
import { createTestRng, randInt } from "./rng";

type Rng = () => number;

// Protocol v7 LootUpdate: spawn/remove/quantity/forget/clear ops round-trip, bad bytes never throw or half-apply, and
// wire sizes stay inside the loot budget (docs/backend/netcode.md §8.3).

const log = (...args: unknown[]) => {
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PROTOCOL_SIZES) console.log(...args);
};

function randomItem(rng: Rng, lootId = randInt(rng, 0, NET_LOOT_ID_LIMIT - 1)): LootSpawnItem {
  const itemId: ItemId = ITEM_IDS[randInt(rng, 0, ITEM_IDS.length - 1)]!;
  const def = ITEMS[itemId];
  const stack = def.category === "ammo" || def.category === "throwable" || def.category === "heal" || def.category === "boost";
  return {
    lootId,
    itemId,
    quantity: stack ? randInt(rng, 1, def.maxStack) : 1,
    position: [randInt(rng, -60000, 60000) / 100, randInt(rng, -2000, 30000) / 100, randInt(rng, -60000, 60000) / 100],
    ...(def.category === "weapon" ? { magazine: randInt(rng, 0, 30) } : {}),
    ...(def.category === "helmet" || def.category === "vest" ? { durability: randInt(rng, 0, 1500) / 10 } : {}),
    pileId: rng() < 0.2 ? -1 : randInt(rng, 0, 400),
  };
}

describe("LootUpdate", () => {
  it("round-trips every op with quantized positions, piles, magazines, durability and own-drop flags", () => {
    const rng = createTestRng(71);
    const w = new LootUpdateWriter();
    for (let round = 0; round < 300; round++) {
      w.begin();
      const expected: { op: number; item?: LootSpawnItem; ownDrop?: boolean; lootId?: number; quantity?: number; cell?: number }[] = [];
      let pile = randInt(rng, 0, 50);
      while (!w.full) {
        const roll = rng();
        if (roll < 0.6) {
          // Consecutive items often share a pile.
          if (rng() < 0.3) pile = rng() < 0.2 ? -1 : randInt(rng, 0, 60000);
          const item = { ...randomItem(rng), pileId: pile };
          const ownDrop = rng() < 0.1;
          w.spawn(item, ownDrop);
          expected.push({ op: LootOpCode.spawn, item, ownDrop });
        } else if (roll < 0.75) {
          const lootId = randInt(rng, 0, 65535);
          w.remove(lootId);
          expected.push({ op: LootOpCode.remove, lootId });
        } else if (roll < 0.9) {
          const lootId = randInt(rng, 0, 65535);
          const quantity = randInt(rng, 1, 999);
          w.quantity(lootId, quantity);
          expected.push({ op: LootOpCode.quantity, lootId, quantity });
        } else if (roll < 0.98) {
          const cell = randInt(rng, 0, LOOT_GRID_CELLS * LOOT_GRID_CELLS - 1);
          w.forgetCell(cell);
          expected.push({ op: LootOpCode.forgetCell, cell });
        } else {
          w.clear();
          expected.push({ op: LootOpCode.clear });
        }
      }
      const bytes = w.finish()!;
      expect(bytes.length).toBeLessThanOrEqual(LOOT_UPDATE_SOFT_BYTES + 1);
      const ops = decodeLootUpdate(createBitReader(bytes))!;
      expect(ops).not.toBeNull();
      expect(ops).toHaveLength(expected.length);
      ops.forEach((op, i) => {
        const e = expected[i]!;
        expect(op.op).toBe(e.op);
        if (e.item) {
          const item = e.item;
          expect(ITEM_IDS[op.itemCode]).toBe(item.itemId);
          expect(op.lootId).toBe(item.lootId);
          expect(op.quantity).toBe(item.quantity);
          expect(dequantizeLootXZ(op.xCm)).toBeCloseTo(item.position[0], 2);
          expect(dequantizeLootY(op.yCm)).toBeCloseTo(item.position[1], 2);
          expect(dequantizeLootXZ(op.zCm)).toBeCloseTo(item.position[2], 2);
          expect(op.magazine).toBe(item.magazine ?? 0);
          expect(op.durabilityQ).toBe(Math.round((item.durability ?? 0) * 10));
          expect(op.pileId).toBe(item.pileId);
          expect(op.ownDrop).toBe(e.ownDrop);
        }
        if (e.lootId !== undefined) expect(op.lootId).toBe(e.lootId);
        if (e.quantity !== undefined) expect(op.quantity).toBe(e.quantity);
        if (e.cell !== undefined) expect(op.cell).toBe(e.cell);
      });
    }
  });

  it("an empty message finishes as null; the decoder rejects unknown ops, quantity 0, bad items and trailing bytes", () => {
    const w = new LootUpdateWriter();
    expect(w.finish()).toBeNull();
    const buf = createLootUpdateBuffer();
    const bad = (build: (bw: ReturnType<typeof createBitWriter>) => void) => {
      const bw = createBitWriter(16);
      bw.write(MsgId.LootUpdate, 8);
      build(bw);
      return decodeLootUpdateInto(createBitReader(bw.bytes()), buf);
    };
    expect(bad((bw) => bw.write(5, 3))).toBe(false);
    expect(bad(() => {})).toBe(false);
    expect(bad((bw) => bw.write(LootOpCode.end, 3))).toBe(true);
    expect(bad((bw) => (bw.write(LootOpCode.end, 3), bw.write(0, 8)))).toBe(false);
    expect(bad((bw) => (bw.write(LootOpCode.quantity, 3), bw.write(9, 16), bw.write(0, 10), bw.write(LootOpCode.end, 3)))).toBe(false);
    expect(bad((bw) => (bw.write(LootOpCode.forgetCell, 3), bw.write(4095, 12), bw.write(LootOpCode.end, 3)))).toBe(true);
    w.begin();
    w.spawn({ lootId: 1, itemId: "bandage", quantity: 5, position: [0, 0, 0], pileId: 3 });
    const good = Uint8Array.from(w.finish()!);
    expect(decodeLootUpdateInto(createBitReader(good), buf)).toBe(true);
    expect(buf.count).toBe(1);
    // Truncations never decode.
    for (let n = 1; n < good.length; n++) expect(decodeLootUpdateInto(createBitReader(good.subarray(0, n)), buf)).toBe(false);
    expect(describeMessage(good)).toMatchObject({ name: "LootUpdate", ok: true });
  });

  it("random and mutated bytes never throw", () => {
    const rng = createTestRng(5150);
    const buf = createLootUpdateBuffer();
    const w = new LootUpdateWriter();
    for (let i = 0; i < 5000; i++) {
      let bytes: Uint8Array;
      if (i % 2 === 0) {
        bytes = new Uint8Array(randInt(rng, 1, 200));
        for (let k = 0; k < bytes.length; k++) bytes[k] = randInt(rng, 0, 255);
        bytes[0] = MsgId.LootUpdate;
      } else {
        w.begin();
        for (let k = randInt(rng, 1, 20); k > 0; k--) w.spawn(randomItem(rng));
        bytes = Uint8Array.from(w.finish()!);
        for (let k = randInt(rng, 1, 4); k > 0; k--) bytes[randInt(rng, 1, bytes.length - 1)]! ^= 1 << randInt(rng, 0, 7);
        if (rng() < 0.3) bytes = bytes.subarray(0, randInt(rng, 1, bytes.length));
      }
      expect(() => decodeLootUpdateInto(createBitReader(bytes), buf)).not.toThrow();
      expect(() => describeMessage(bytes)).not.toThrow();
    }
  });

  it("cells: server and client agree through quantization, including cell edges; Chebyshev distance", () => {
    for (const x of [-1024, -512.005, -0.004, 0, 31.995, 32, 63.999, 511.99, 1200, -5000]) {
      for (const z of [-0.005, 0.004, 95.996, 300]) {
        expect(lootCellOfQ(quantizeLootXZ(x), quantizeLootXZ(z))).toBe(lootCellOf(x, z));
      }
    }
    const a = lootCellOf(0, 0);
    expect(lootCellDistance(a, lootCellOf(LOOT_CELL_M * 3, -LOOT_CELL_M * 5))).toBe(5);
    expect(lootCellDistance(a, a)).toBe(0);
  });

  it("pickup arg: 14-bit loot id and an optional weapon slot; a bare id (bots) means no slot", () => {
    expect(decodePickupArg(encodePickupArg(1234))).toEqual({ lootId: 1234, replaceSlot: -1 });
    expect(decodePickupArg(encodePickupArg(NET_LOOT_ID_LIMIT - 1, 2))).toEqual({ lootId: NET_LOOT_ID_LIMIT - 1, replaceSlot: 2 });
    expect(decodePickupArg(encodePickupArg(7, 0))).toEqual({ lootId: 7, replaceSlot: 0 });
    expect(decodePickupArg(4321)).toEqual({ lootId: 4321, replaceSlot: -1 });
    expect(encodePickupArg(16383, 1)).toBeLessThan(65536);
  });

  it("wire sizes: spawn 10–13 B, remove 2.4 B, quantity 3.6 B; a 350-item area fits in ~4 KB", () => {
    const rng = createTestRng(8);
    const w = new LootUpdateWriter(64);
    const size = (fill: () => void) => {
      w.begin();
      fill();
      return w.writer.bitLength - 8;
    };
    const spawnBits = (itemId: ItemId, pileId: number) => size(() => w.spawn({ lootId: 100, itemId, quantity: 1, position: [1, 2, 3], magazine: 0, durability: 40, pileId }));
    const bandage = spawnBits("bandage", 1);
    const rifle = spawnBits("weapon_rifle", 1);
    const vest = spawnBits("vest_2", 1);
    const backpack = spawnBits("backpack_1", -1);
    log(`loot op bits: bandage ${bandage}, rifle ${rifle}, vest ${vest}, backpack (no pile) ${backpack}`);
    expect(bandage).toBe(3 + 16 + 6 + 10 + 50 + 2 + 16 + 1);
    expect(rifle).toBe(3 + 16 + 6 + 50 + 7 + 2 + 16 + 1);
    expect(vest).toBe(3 + 16 + 6 + 50 + 11 + 2 + 16 + 1);
    expect(backpack).toBe(3 + 16 + 6 + 50 + 2 + 1);
    expect(Math.ceil(vest / 8)).toBeLessThanOrEqual(LOOT_OP_MAX_BYTES);
    expect(size(() => w.remove(3))).toBe(19);
    expect(size(() => w.quantity(3, 25))).toBe(29);
    expect(size(() => w.forgetCell(99))).toBe(15);

    // A POI-dense area: piles of 2–5 items (loot table v3 averages about 2.6 items a pile).
    const big = new LootUpdateWriter();
    let bytes = 0;
    let messages = 0;
    let items = 0;
    let pile = 0;
    big.begin();
    while (items < 350) {
      const count = randInt(rng, 2, 5);
      pile++;
      for (let k = 0; k < count && items < 350; k++, items++) {
        if (big.full) {
          bytes += big.finish()!.length;
          messages++;
          big.begin();
        }
        big.spawn({ ...randomItem(rng, items), pileId: pile });
      }
    }
    bytes += big.finish()!.length;
    messages++;
    log(`350 items: ${bytes} B in ${messages} messages (${(bytes / 350).toFixed(1)} B/item)`);
    expect(bytes / 350).toBeLessThanOrEqual(11.5);
    expect(bytes).toBeLessThanOrEqual(4100);
  });
});
