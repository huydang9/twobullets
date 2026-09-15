import type { BitReader } from "@twobullets/protocol/bits";
import {
  createLootUpdateBuffer,
  decodeLootUpdateInto,
  dequantizeLootXZ,
  dequantizeLootY,
  lootCellOf,
  LootOpCode,
} from "@twobullets/protocol/messages/loot";
import { ITEM_IDS, ITEMS } from "@twobullets/shared/equipment/items";
import { clearGroundLoot, createGroundLoot, putGroundItem, removeGroundItem, setGroundQuantity, type GroundLoot, type LootItem } from "@twobullets/shared/equipment/loot";

/** What a loot message did to one item the client was waiting on. */
export interface NetLootListener {
  /** An item left the ground (`remaining` 0) or shrank (a partial pickup): a pending pickup of ours may be done. */
  onTaken?(item: LootItem, remaining: number): void;
  /** An item we dropped (or swapped out) landed. */
  onOwnDrop?(item: LootItem): void;
}

export interface NetLootStats {
  messages: number;
  bytes: number;
  malformed: number;
  spawns: number;
}

/**
 * The server's ground loot as this client hears it (protocol v7 `LootUpdate`): the items in its area of interest, kept
 * in a shared `GroundLoot` so the loot renderer, interaction queries and the inventory screen work as offline. Only the
 * server changes it; a message that fails to decode changes nothing.
 */
export class NetLoot {
  readonly ground: GroundLoot = createGroundLoot([]);
  /** Loot ids the server flagged as our own drops (auto pickup skips them). */
  readonly ownDrops = new Set<number>();
  readonly stats: NetLootStats = { messages: 0, bytes: 0, malformed: 0, spawns: 0 };
  listener: NetLootListener | null = null;
  private readonly buffer = createLootUpdateBuffer();

  /** Applies one `LootUpdate` (the reader positioned at its id byte). Returns false when malformed. */
  apply(reader: BitReader, byteLength: number): boolean {
    this.stats.messages++;
    this.stats.bytes += byteLength;
    const buf = this.buffer;
    if (!decodeLootUpdateInto(reader, buf)) {
      this.stats.malformed++;
      return false;
    }
    const ground = this.ground;
    for (let i = 0; i < buf.count; i++) {
      const op = buf.ops[i]!;
      switch (op.op) {
        case LootOpCode.spawn: {
          const itemId = ITEM_IDS[op.itemCode]!;
          const category = ITEMS[itemId].category;
          const item: LootItem = {
            lootId: op.lootId,
            pileId: op.pileId,
            itemId,
            quantity: op.quantity,
            position: [dequantizeLootXZ(op.xCm), dequantizeLootY(op.yCm), dequantizeLootXZ(op.zCm)],
            ...(category === "weapon" ? { magazine: op.magazine } : {}),
            ...(category === "helmet" || category === "vest" ? { durability: op.durabilityQ / 10 } : {}),
          };
          putGroundItem(ground, item);
          this.stats.spawns++;
          if (op.ownDrop) {
            this.ownDrops.add(op.lootId);
            this.listener?.onOwnDrop?.(item);
          } else {
            this.ownDrops.delete(op.lootId);
          }
          break;
        }
        case LootOpCode.remove: {
          const item = removeGroundItem(ground, op.lootId);
          this.ownDrops.delete(op.lootId);
          if (item) this.listener?.onTaken?.(item, 0);
          break;
        }
        case LootOpCode.quantity: {
          const item = ground.items.get(op.lootId);
          if (!item) break;
          setGroundQuantity(ground, op.lootId, op.quantity);
          if (op.quantity < item.quantity) this.listener?.onTaken?.(item, op.quantity);
          break;
        }
        case LootOpCode.forgetCell: {
          for (const item of ground.items.values()) {
            if (lootCellOf(item.position[0], item.position[2]) !== op.cell) continue;
            removeGroundItem(ground, item.lootId);
            this.ownDrops.delete(item.lootId);
          }
          break;
        }
        case LootOpCode.clear:
          this.clear();
          break;
      }
    }
    return true;
  }

  clear(): void {
    clearGroundLoot(this.ground);
    this.ownDrops.clear();
  }
}
