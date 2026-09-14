import { createInterpolatedPose, EntityInterpolator, type InterpolatedPose } from "@twobullets/netcode/interpolation";
import { EntityPresence, MAX_ENTITY_SLOTS, type EntityState } from "@twobullets/protocol/messages/snapshot";

/** A slot missing from snapshots for this many ticks is hidden and its buffer dropped. */
const MISSING_TICKS = 30;

/**
 * Remote player buffers by slot (netcode.md §4): one `EntityInterpolator` per slot, fed from every decoded snapshot,
 * sampled once per frame at the render tick. No Babylon; `RemotePlayers` draws the poses.
 */
export class RemoteRoster {
  readonly poses: InterpolatedPose[] = [];
  /** Slot has data to draw this frame. */
  readonly visible = new Uint8Array(MAX_ENTITY_SLOTS);
  private readonly interpolators: EntityInterpolator[] = [];
  private readonly lastSeen = new Float64Array(MAX_ENTITY_SLOTS).fill(-1);
  private ownSlot = -1;
  private newestTick = -1;
  sampledFrames = 0;
  extrapolatedFrames = 0;

  constructor() {
    for (let i = 0; i < MAX_ENTITY_SLOTS; i++) {
      this.interpolators.push(new EntityInterpolator());
      this.poses.push(createInterpolatedPose());
    }
  }

  setOwnSlot(slot: number): void {
    this.ownSlot = slot;
  }

  onSnapshot(serverTick: number, entities: readonly EntityState[]): void {
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]!;
      const slot = e.slot;
      if (slot === this.ownSlot || slot < 0 || slot >= MAX_ENTITY_SLOTS) continue;
      if (e.presence === EntityPresence.full) {
        this.interpolators[slot]!.pushEntity(serverTick, e);
        if (serverTick > this.lastSeen[slot]!) this.lastSeen[slot] = serverTick;
      } else if (e.presence === EntityPresence.removed && serverTick >= this.lastSeen[slot]!) {
        this.interpolators[slot]!.clear();
        this.lastSeen[slot] = -1;
      }
    }
    if (serverTick > this.newestTick) this.newestTick = serverTick;
  }

  /** Samples every live slot at `renderTick`; returns how many are visible. */
  sample(renderTick: number): number {
    let count = 0;
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      const interp = this.interpolators[slot]!;
      const seen = this.lastSeen[slot]!;
      if (seen >= 0 && this.newestTick - seen > MISSING_TICKS) {
        interp.clear();
        this.lastSeen[slot] = -1;
      }
      if (interp.size === 0) {
        this.visible[slot] = 0;
        continue;
      }
      const pose = interp.sample(renderTick, this.poses[slot]!);
      this.visible[slot] = pose.valid ? 1 : 0;
      if (pose.valid) {
        count++;
        this.sampledFrames++;
        if (pose.extrapolated) this.extrapolatedFrames++;
      }
    }
    return count;
  }

  clear(): void {
    for (const interp of this.interpolators) interp.clear();
    this.lastSeen.fill(-1);
    this.visible.fill(0);
    this.newestTick = -1;
  }
}
