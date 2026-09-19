import type { BitReader } from "@twobullets/protocol/bits";
import { createWallUpdateBuffer, decodeWallUpdateInto, WallOpCode, type WallUpdateBuffer } from "@twobullets/protocol/messages/walls";
import { WALL_DAMAGE, WallChange, WallKind, type DestructibleWalls } from "@twobullets/shared/equipment/destructible";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";

/**
 * A client's copy of the server's destructible walls (protocol v10 `WallUpdate`).
 *
 * The client never decides anything here. It holds its own `DestructibleWalls`, built from the same map layout with
 * the same `buildDestructibleWalls`, so an index off the wire names the same pane; every op the server sends is
 * written into it and then handed to whatever owns the consequences — the Havok collider, the mesh, the mirror's hole
 * mask. Applying an op twice is a no-op, so a resync costs nothing but the bytes.
 *
 * It lives here rather than in the client because the headless tests (and the bot client) need the same applier the
 * browser runs: a two-client test that asserts both ends agree is only worth anything if both ends run this code.
 */
export interface WallMirrorHooks {
  /**
   * A destroyed pane's collider has to leave the physics world. Hedges never have one, so this is only called for
   * panes. The offline match does exactly this through `MatchWalls.removeCollider`.
   */
  removeCollider?(prop: string, instance: number): void;
  /** After the collider went: nav patch, mesh, hole mask. Same shape as `MatchWalls.onChange`. */
  onChange?(index: number, prop: string, instance: number, change: WallChange): void;
}

export interface WallMirrorStats {
  messages: number;
  bytes: number;
  malformed: number;
  destroyed: number;
  repaired: number;
  holed: number;
  clears: number;
}

export class WallMirror {
  readonly walls: DestructibleWalls;
  readonly stats: WallMirrorStats = { messages: 0, bytes: 0, malformed: 0, destroyed: 0, repaired: 0, holed: 0, clears: 0 };
  private readonly layout: Pick<MapLayout, "props">;
  private readonly hooks: WallMirrorHooks;
  private readonly buffer: WallUpdateBuffer = createWallUpdateBuffer();
  /** Ticks a full heal takes, for turning a replicated progress back into the `ticks` the renderer reads. */
  private readonly repairTicks: number;

  constructor(walls: DestructibleWalls, layout: Pick<MapLayout, "props">, hooks: WallMirrorHooks = {}, tickSeconds = 1 / 60) {
    this.walls = walls;
    this.layout = layout;
    this.hooks = hooks;
    this.repairTicks = Math.max(1, Math.round(WALL_DAMAGE.repairSeconds / tickSeconds));
  }

  /** Applies one `WallUpdate` (the reader positioned at its id byte). Returns false when malformed (nothing applied). */
  apply(reader: BitReader, byteLength: number): boolean {
    this.stats.messages++;
    this.stats.bytes += byteLength;
    const buf = this.buffer;
    if (!decodeWallUpdateInto(reader, buf)) {
      this.stats.malformed++;
      return false;
    }
    for (let i = 0; i < buf.count; i++) {
      const op = buf.ops[i]!;
      switch (op.op) {
        case WallOpCode.destroyed:
          this.destroy(op.index);
          break;
        case WallOpCode.repaired:
          this.repair(op.index);
          break;
        case WallOpCode.holed:
          this.walls.addHole(op.index);
          if (op.index < this.walls.count) this.stats.holed++;
          break;
        case WallOpCode.healing:
          this.setHealing(op.index, op.progress);
          break;
        case WallOpCode.clear:
          this.clear();
          break;
        default:
          break;
      }
    }
    return true;
  }

  /** A pane or hedge is gone: the state, then the collider, then the owner's presentation and nav. Idempotent. */
  private destroy(index: number): void {
    const walls = this.walls;
    if (index >= walls.count || walls.destroyed[index] === 1) return;
    walls.destroyed[index] = 1;
    if (walls.holes[index]! > 0) walls.holedCount--;
    walls.holes[index] = 0;
    walls.ticks[index] = 0;
    walls.push(index, WallChange.destroyed);
    this.stats.destroyed++;
    const prop = this.propOf(index);
    const instance = walls.instance[index]!;
    if (walls.kind[index] === WallKind.pane) this.hooks.removeCollider?.(prop, instance);
    this.hooks.onChange?.(index, prop, instance, WallChange.destroyed);
  }

  /** A standing pane's apertures closed. Nothing about collision changes — a holed pane was never a hole in the world. */
  private repair(index: number): void {
    const walls = this.walls;
    if (index >= walls.count || walls.destroyed[index] === 1 || walls.holes[index] === 0) return;
    walls.holes[index] = 0;
    walls.ticks[index] = 0;
    walls.holedCount--;
    walls.push(index, WallChange.repaired);
    this.stats.repaired++;
    this.hooks.onChange?.(index, this.propOf(index), walls.instance[index]!, WallChange.repaired);
  }

  /**
   * How far through closing this pane is. Written back as the server's own tick count, because that is what the
   * renderer reads (`wallRepairProgress`): nothing has to know the progress arrived over a wire.
   */
  private setHealing(index: number, progress: number): void {
    const walls = this.walls;
    if (index >= walls.count || walls.destroyed[index] === 1 || walls.holes[index] === 0) return;
    walls.ticks[index] = Math.min(0xffff, Math.round(progress * this.repairTicks));
  }

  /**
   * Join, reconnect or match reset: drop the hole and heal state. `destroyed` stays — it is permanent and the full
   * state the server sends straight after restates it, so a pane that is already gone is never taken out twice.
   */
  private clear(): void {
    const walls = this.walls;
    for (let i = 0; i < walls.count; i++) {
      walls.holes[i] = 0;
      walls.ticks[i] = 0;
    }
    walls.holedCount = 0;
    this.stats.clears++;
  }

  private propOf(index: number): string {
    return this.layout.props[this.walls.set[index]!]?.prop ?? "";
  }
}
