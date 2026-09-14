import type { BitReader, BitWriter } from "../bits";

// 0x10, S→C datagram (netcode.md §6.5). M3 scope: header, owner move block, entity list; events arrive in M4.
// Decoded structs carry quantized integers (mm, mm/s, angle steps) so baselines and deltas compare exactly;
// dequantization lives in quantize.ts.

/** Payload cap: min(SNAPSHOT_MAX_BYTES, session maxDatagramSize). */
export const SNAPSHOT_MAX_BYTES = 1000;
/** Per-client baseline ring (D9). */
export const BASELINE_RING = 128;

export const SnapshotSection = { owner: 1, entities: 2, shots: 4, reliable: 8, throwables: 16, versions: 32 } as const;

export interface SnapshotHeader {
  /** u32 after unwrap (u16 on the wire). */
  readonly serverTick: number;
  /** Tick of the baseline this delta is encoded against, or null for a full snapshot. */
  readonly baselineTick: number | null;
  /** Recipient's newest simulated input tick. */
  readonly lastProcessedInputTick: number;
  /** `clientTimeMs` of the newest input received. */
  readonly clientTimeEcho: number;
  /** Receipt of that input → this send, ms. */
  readonly serverHoldMs: number;
  /** Signed, quarter ticks (time dilation feedback). */
  readonly inputBufferDepthQ: number;
  /** `SnapshotSection` bits. */
  readonly sections: number;
}

export interface OwnerMoveBlock {
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
  readonly vxMmS: number;
  readonly vyMmS: number;
  readonly vzMmS: number;
  /** 0 stand, 1 crouch, 2 prone. */
  readonly stance: number;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  readonly jumpHeld: boolean;
  /** 0 ground (M5 adds freefall/parachute). */
  readonly moveMode: number;
  readonly coyoteTicks: number;
  readonly jumpBufferTicks: number;
  readonly groundIgnoreTicks: number;
}

export const EntityPresence = { absent: 0, full: 1, audibleOnly: 2, removed: 3 } as const;
export type EntityPresence = (typeof EntityPresence)[keyof typeof EntityPresence];

export interface EntityState {
  /** Player slot 0..15. */
  readonly slot: number;
  readonly presence: EntityPresence;
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
  /** 12-bit yaw steps. */
  readonly yawQ: number;
  /** 10-bit pitch steps. */
  readonly pitchQ: number;
  /** 0.125 m/s steps. */
  readonly vxQ: number;
  readonly vyQ: number;
  readonly vzQ: number;
  /** 18-bit remote flags (stance, moveMode, grounded, sprint, ads, weaponSlot, …). */
  readonly flags: number;
}

export interface Snapshot {
  readonly header: SnapshotHeader;
  readonly owner: OwnerMoveBlock | null;
  readonly entities: readonly EntityState[];
}

/** Encodes against `baseline` (null = full). The caller enforces the size cap. */
export function encodeSnapshot(w: BitWriter, snapshot: Snapshot, baseline: Snapshot | null): void {
  throw new Error("not implemented");
}

/** `baselineFor(tick)` returns a stored decoded snapshot, or null when unavailable (the snapshot is then dropped). */
export function decodeSnapshot(
  r: BitReader,
  referenceTick: number,
  baselineFor: (tick: number) => Snapshot | null,
): Snapshot | null {
  throw new Error("not implemented");
}
