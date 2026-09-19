import type { BitReader } from "@twobullets/protocol/bits";
import { WallMirror, type WallMirrorStats } from "@twobullets/netcode/walls";
import { buildDestructibleWalls, type DestructibleWalls } from "@twobullets/shared/equipment/destructible";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { SIMULATION } from "@twobullets/shared/constants";

/**
 * The server's destructible walls as this client sees them (protocol v10 `WallUpdate`).
 *
 * The maze's mirror panes and grass hedges are the one piece of map geometry a player can change, and online the
 * server decides all of it: a frag within reach takes a pane out for good, a molotov burns a hedge away, a smoke
 * cloud closes the apertures rounds punched through a pane that is still standing. This holds the client's copy —
 * built from the same layout with the same `buildDestructibleWalls`, so an index off the wire names the same pane —
 * and hands each change to the two things that have to follow it:
 *
 *  - the Havok collider (`PropColliders.removeInstance`), so you can walk and shoot through the corridor the blast
 *    opened rather than into an invisible wall,
 *  - the renderer (`PropInstances.bindWalls`), which is already written against this exact state: it polls the change
 *    log for panes to hide and hedges to wither, and reads `holes` and `ticks` to shrink a pane's apertures shut.
 *
 * Nothing here decides anything. A remote player's grenade opens the wall on your screen because the server said so,
 * on the tick it said so, and a client that joins in the middle of a match is sent the whole state rather than a
 * history it was not there for.
 */
export interface NetWallsDeps {
  /** The loaded map's layout — the same object the props and colliders were built from. */
  readonly layout: Pick<MapLayout, "props">;
  /** `MapRuntime.props`: binds the renderer to this state (meshes, mirror hole masks). */
  readonly props: { bindWalls(walls: DestructibleWalls, layout: Pick<MapLayout, "props">): void };
  /** `MapRuntime.colliders`: takes a destroyed pane's static body out of the world. */
  readonly colliders: { removeInstance(prop: string, instance: number): boolean };
}

export class NetWalls {
  readonly walls: DestructibleWalls;
  private readonly mirror: WallMirror;

  constructor(deps: NetWallsDeps) {
    this.walls = buildDestructibleWalls(deps.layout);
    this.mirror = new WallMirror(
      this.walls,
      deps.layout,
      { removeCollider: (prop, instance) => void deps.colliders.removeInstance(prop, instance) },
      1 / SIMULATION.tickRate,
    );
    // The renderer reads the same state the server writes: hidden panes, withered hedges, closing apertures.
    deps.props.bindWalls(this.walls, deps.layout);
  }

  /** True when this map has nothing a throwable can take out; the client then never has to be told anything. */
  get empty(): boolean {
    return this.walls.count === 0;
  }

  get stats(): WallMirrorStats {
    return this.mirror.stats;
  }

  /** Applies one `WallUpdate` (the reader positioned at its id byte). Returns false when malformed. */
  apply(reader: BitReader, byteLength: number): boolean {
    return this.mirror.apply(reader, byteLength);
  }
}
