import type { PlayerAction, PlayerInput } from "./input";

type MutableInput = { -readonly [K in keyof PlayerInput]: PlayerInput[K] };

/**
 * The last `capacity` sampled inputs by tick (refactor R4): what the client resends with redundancy and replays after
 * a correction. Entries are preallocated and overwritten in place, so `get` results are only valid until the tick
 * is overwritten.
 */
export class PlayerInputRing {
  private readonly entries: MutableInput[];
  private newest = -1;
  readonly capacity: number;

  constructor(capacity = 128) {
    this.capacity = capacity;
    this.entries = Array.from({ length: capacity }, () => ({
      tick: -1,
      forward: 0,
      right: 0,
      buttons: 0,
      select: 0,
      yawQ: 0,
      pitchQ: 0,
      viewOffset8: 0,
      action: null as PlayerAction | null,
    }));
  }

  /** Copies `input` into the ring slot for its tick and returns the stored entry. */
  push(input: PlayerInput): PlayerInput {
    const entry = this.entries[input.tick % this.capacity]!;
    entry.tick = input.tick;
    entry.forward = input.forward;
    entry.right = input.right;
    entry.buttons = input.buttons;
    entry.select = input.select;
    entry.yawQ = input.yawQ;
    entry.pitchQ = input.pitchQ;
    entry.viewOffset8 = input.viewOffset8;
    entry.action = input.action;
    this.newest = input.tick;
    return entry;
  }

  get(tick: number): PlayerInput | null {
    const entry = this.entries[tick % this.capacity]!;
    return entry.tick === tick ? entry : null;
  }

  /** Tick of the newest pushed input, or -1. */
  get newestTick(): number {
    return this.newest;
  }
}
