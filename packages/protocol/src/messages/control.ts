import type { BitReader, BitWriter } from "../bits";

// Control-stream messages for M3 (netcode.md §6.4–6.5, §7.3). Codecs write/read the id byte first.

export type TransportKind = "wt" | "ws";

/** 0x40, C→S, once. The join token is sent only here, never in a URL (ADR 0106). */
export interface Hello {
  /** u16 */
  readonly protocolVersion: number;
  /** u32 */
  readonly contentHash: number;
  /** Ed25519 join JWT (compact form). */
  readonly joinToken: string;
  /** `transport.datagrams.maxDatagramSize` on WT; 0 on WS. */
  readonly maxDatagramSize: number;
  readonly transport: TransportKind;
}

/** 0x41, S→C, once (40 B). */
export interface Welcome {
  readonly playerSlot: number;
  readonly teamId: number;
  /** u32 */
  readonly serverTick: number;
  readonly tickRate: number;
  readonly snapshotRate: number;
  /** u32 */
  readonly matchSeed: number;
  /** `PhaseCode` */
  readonly phase: number;
  /** u32 */
  readonly phaseEndTick: number;
  readonly maxRewindMs: number;
  readonly interpFloorMs: number;
  /** 16 bytes, HMAC-SHA256/128 (netcode.md §7.4). */
  readonly resumeToken: Uint8Array;
  /** u32 echo of the server's content hash. */
  readonly contentHash: number;
  readonly flags: number;
}

/** Wire codes for gameplay phases (C23). */
export const PhaseCode = { Warmup: 0, LandingSelect: 1, Glide: 2, Combat: 3, End: 4 } as const;
export type PhaseCode = (typeof PhaseCode)[keyof typeof PhaseCode];

export const DisconnectReason = {
  clientLeave: 0,
  versionMismatch: 1,
  badToken: 2,
  notAssigned: 3,
  matchFull: 4,
  replaced: 5,
  kicked: 6,
  rateLimited: 7,
  timeout: 8,
  matchEnded: 9,
  serverShutdown: 10,
  internalError: 11,
} as const;
export type DisconnectReason = (typeof DisconnectReason)[keyof typeof DisconnectReason];

/** 0x4F, both directions, once (3 B). */
export interface Disconnect {
  readonly reason: DisconnectReason;
  /** u8 reason-specific detail (0 when unused). */
  readonly detail: number;
}

/** `Resync` scope bits. */
export const ResyncScope = { state: 1, loot: 2, inventory: 4 } as const;

/** 0x4B, C→S request (2 B). */
export interface ResyncRequest {
  readonly scope: number;
}

/** 0x4B, S→C response: tick re-alignment; the next snapshot is full (baselines reset). */
export interface ResyncResponse {
  readonly scope: number;
  /** u32 */
  readonly serverTick: number;
}

export function encodeHello(w: BitWriter, m: Hello): void {
  throw new Error("not implemented");
}
export function decodeHello(r: BitReader): Hello {
  throw new Error("not implemented");
}
export function encodeWelcome(w: BitWriter, m: Welcome): void {
  throw new Error("not implemented");
}
export function decodeWelcome(r: BitReader): Welcome {
  throw new Error("not implemented");
}
export function encodeDisconnect(w: BitWriter, m: Disconnect): void {
  throw new Error("not implemented");
}
export function decodeDisconnect(r: BitReader): Disconnect {
  throw new Error("not implemented");
}
export function encodeResyncRequest(w: BitWriter, m: ResyncRequest): void {
  throw new Error("not implemented");
}
export function decodeResyncRequest(r: BitReader): ResyncRequest {
  throw new Error("not implemented");
}
export function encodeResyncResponse(w: BitWriter, m: ResyncResponse): void {
  throw new Error("not implemented");
}
export function decodeResyncResponse(r: BitReader): ResyncResponse {
  throw new Error("not implemented");
}
