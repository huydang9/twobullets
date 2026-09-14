import type { BitReader, BitWriter } from "../bits";
import { MsgId } from "./ids";

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

/** Join tokens longer than this are rejected by the decoder (a compact Ed25519 JWT is ~260 B). */
export const MAX_JOIN_TOKEN_BYTES = 2048;
export const RESUME_TOKEN_BYTES = 16;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** True when the reader consumed the whole message (control frames are byte-aligned, no padding). */
function finished(r: BitReader): boolean {
  return !r.overflowed && r.bitsLeft === 0;
}

// Hello: type 8, protocolVersion 16, contentHash 32, maxDatagramSize 16, transport 8 (0 wt, 1 ws), tokenLength 16,
// token bytes (UTF-8).
export function encodeHello(w: BitWriter, m: Hello): void {
  const token = textEncoder.encode(m.joinToken);
  if (token.length > MAX_JOIN_TOKEN_BYTES) throw new RangeError("join token too long");
  w.write(MsgId.Hello, 8);
  w.write(m.protocolVersion, 16);
  w.write(m.contentHash, 32);
  w.write(m.maxDatagramSize, 16);
  w.write(m.transport === "ws" ? 1 : 0, 8);
  w.write(token.length, 16);
  w.writeBytes(token);
}
export function decodeHello(r: BitReader): Hello | null {
  if (r.read(8) !== MsgId.Hello) return null;
  const protocolVersion = r.read(16);
  const contentHash = r.read(32);
  const maxDatagramSize = r.read(16);
  const transportCode = r.read(8);
  const length = r.read(16);
  if (r.overflowed || transportCode > 1 || length > MAX_JOIN_TOKEN_BYTES) return null;
  const token = r.readBytes(length);
  if (!finished(r)) return null;
  return {
    protocolVersion,
    contentHash,
    joinToken: textDecoder.decode(token),
    maxDatagramSize,
    transport: transportCode === 1 ? "ws" : "wt",
  };
}

// Welcome (40 B): type 8, playerSlot 4 + teamId 4, serverTick 32, tickRate 8, snapshotRate 8, matchSeed 32, phase 8,
// phaseEndTick 32, maxRewindMs/4 8, interpFloorMs 8, resumeToken 16 B, contentHash 32, flags 8.
export function encodeWelcome(w: BitWriter, m: Welcome): void {
  if (m.resumeToken.length !== RESUME_TOKEN_BYTES) throw new RangeError("resumeToken must be 16 bytes");
  w.write(MsgId.Welcome, 8);
  w.write(m.playerSlot, 4);
  w.write(m.teamId, 4);
  w.write(m.serverTick, 32);
  w.write(m.tickRate, 8);
  w.write(m.snapshotRate, 8);
  w.write(m.matchSeed, 32);
  w.write(m.phase, 8);
  w.write(m.phaseEndTick, 32);
  w.write(Math.min(255, Math.round(m.maxRewindMs / 4)), 8);
  w.write(m.interpFloorMs, 8);
  w.writeBytes(m.resumeToken);
  w.write(m.contentHash, 32);
  w.write(m.flags, 8);
}
export function decodeWelcome(r: BitReader): Welcome | null {
  if (r.read(8) !== MsgId.Welcome) return null;
  const playerSlot = r.read(4);
  const teamId = r.read(4);
  const serverTick = r.read(32);
  const tickRate = r.read(8);
  const snapshotRate = r.read(8);
  const matchSeed = r.read(32);
  const phase = r.read(8);
  const phaseEndTick = r.read(32);
  const maxRewindMs = r.read(8) * 4;
  const interpFloorMs = r.read(8);
  const resumeToken = r.readBytes(RESUME_TOKEN_BYTES).slice();
  const contentHash = r.read(32);
  const flags = r.read(8);
  if (!finished(r) || phase > PhaseCode.End) return null;
  return {
    playerSlot,
    teamId,
    serverTick,
    tickRate,
    snapshotRate,
    matchSeed,
    phase,
    phaseEndTick,
    maxRewindMs,
    interpFloorMs,
    resumeToken,
    contentHash,
    flags,
  };
}

// Disconnect (3 B): type 8, reason 8, detail 8.
export function encodeDisconnect(w: BitWriter, m: Disconnect): void {
  w.write(MsgId.Disconnect, 8);
  w.write(m.reason, 8);
  w.write(m.detail, 8);
}
export function decodeDisconnect(r: BitReader): Disconnect | null {
  if (r.read(8) !== MsgId.Disconnect) return null;
  const reason = r.read(8);
  const detail = r.read(8);
  if (!finished(r) || reason > DisconnectReason.internalError) return null;
  return { reason: reason as DisconnectReason, detail };
}

// Resync request (2 B): type 8, scope 8. Response (6 B): type 8, scope 8, serverTick 32. Same id; direction decides.
export function encodeResyncRequest(w: BitWriter, m: ResyncRequest): void {
  w.write(MsgId.Resync, 8);
  w.write(m.scope, 8);
}
export function decodeResyncRequest(r: BitReader): ResyncRequest | null {
  if (r.read(8) !== MsgId.Resync) return null;
  const scope = r.read(8);
  if (!finished(r) || scope === 0 || scope > 7) return null;
  return { scope };
}
export function encodeResyncResponse(w: BitWriter, m: ResyncResponse): void {
  w.write(MsgId.Resync, 8);
  w.write(m.scope, 8);
  w.write(m.serverTick, 32);
}
export function decodeResyncResponse(r: BitReader): ResyncResponse | null {
  if (r.read(8) !== MsgId.Resync) return null;
  const scope = r.read(8);
  const serverTick = r.read(32);
  if (!finished(r) || scope === 0 || scope > 7) return null;
  return { scope, serverTick };
}
