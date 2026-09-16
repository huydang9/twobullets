import type { BitReader, BitWriter } from "../bits";
import { ACTOR_BITS, KILL_CAUSES_BY_CODE, MAX_PLAYER_SLOTS, SLOT_BITS, TEAM_BITS } from "../codes";
import { MsgId } from "./ids";

// Control-stream messages (netcode.md §6.4–6.5, §7.3): M3 session messages and the M4 kill feed. Codecs write/read
// the id byte first.

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

/** 0x41, S→C, once (42 B). */
export interface Welcome {
  /** 0..MAX_PLAYER_SLOTS-1. */
  readonly playerSlot: number;
  /** 0..teamCount-1; slot = teamId · teamSize + member. */
  readonly teamId: number;
  /** 1..4 (v3). Teammates are the slots with the same floor(slot / teamSize). */
  readonly teamSize: number;
  /** 1..20 (v3); slots are 0..maxPlayers-1. */
  readonly maxPlayers: number;
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

/**
 * 0x50, C→S (3 B), protocol v8: the player quits the match. `leave` takes this player out alone (the match runs on);
 * `endForAll` ends the whole match and is accepted only from the match host (the lobby host's account). The server
 * always answers with a `MatchCommandResult`.
 */
export const MatchCommandCode = { leave: 0, endForAll: 1 } as const;
export type MatchCommandCode = (typeof MatchCommandCode)[keyof typeof MatchCommandCode];

export interface MatchCommand {
  readonly command: number;
  /** Reserved for per-command arguments; 0 today. */
  readonly detail: number;
}

/**
 * `ok`: the server acted on it. `denied`: not allowed (a non-host asking to end for all). `unavailable`: the match
 * can't do it now (already ending, or a sandbox match with no lifecycle). `unknown`: command code this build doesn't
 * know.
 */
export const MatchCommandStatus = { ok: 0, denied: 1, unavailable: 2, unknown: 3 } as const;
export type MatchCommandStatus = (typeof MatchCommandStatus)[keyof typeof MatchCommandStatus];

/** 0x51, S→C (4 B), one per `MatchCommand`. */
export interface MatchCommandResult {
  readonly command: number;
  readonly status: number;
  /** Reserved (0). */
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

// Welcome (42 B): type 8, playerSlot 5, teamId 5, teamSize 3, maxPlayers 5, reserved 6, serverTick 32, tickRate 8,
// snapshotRate 8, matchSeed 32, phase 8, phaseEndTick 32, maxRewindMs/4 8, interpFloorMs 8, resumeToken 16 B,
// contentHash 32, flags 8.
export function encodeWelcome(w: BitWriter, m: Welcome): void {
  if (m.resumeToken.length !== RESUME_TOKEN_BYTES) throw new RangeError("resumeToken must be 16 bytes");
  w.write(MsgId.Welcome, 8);
  w.write(m.playerSlot, SLOT_BITS);
  w.write(m.teamId, TEAM_BITS);
  w.write(m.teamSize, 3);
  w.write(m.maxPlayers, 5);
  w.write(0, 6);
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
  const playerSlot = r.read(SLOT_BITS);
  const teamId = r.read(TEAM_BITS);
  const teamSize = r.read(3);
  const maxPlayers = r.read(5);
  r.read(6);
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
  if (!finished(r) || phase > PhaseCode.End || playerSlot >= MAX_PLAYER_SLOTS || teamSize === 0 || maxPlayers === 0 || maxPlayers > MAX_PLAYER_SLOTS) return null;
  return {
    playerSlot,
    teamId,
    teamSize,
    maxPlayers,
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

// MatchCommand (3 B): type 8, command 8, detail 8.
export function encodeMatchCommand(w: BitWriter, m: MatchCommand): void {
  w.write(MsgId.MatchCommand, 8);
  w.write(m.command, 8);
  w.write(m.detail, 8);
}
export function decodeMatchCommand(r: BitReader): MatchCommand | null {
  if (r.read(8) !== MsgId.MatchCommand) return null;
  const command = r.read(8);
  const detail = r.read(8);
  if (!finished(r)) return null;
  return { command, detail };
}

// MatchCommandResult (4 B): type 8, command 8, status 8, detail 8.
export function encodeMatchCommandResult(w: BitWriter, m: MatchCommandResult): void {
  w.write(MsgId.MatchCommandResult, 8);
  w.write(m.command, 8);
  w.write(m.status, 8);
  w.write(m.detail, 8);
}
export function decodeMatchCommandResult(r: BitReader): MatchCommandResult | null {
  if (r.read(8) !== MsgId.MatchCommandResult) return null;
  const command = r.read(8);
  const status = r.read(8);
  const detail = r.read(8);
  if (!finished(r) || status > MatchCommandStatus.unknown) return null;
  return { command, status, detail };
}

/**
 * 0x49, S→C stream, per kill or knock (10 B). The kill feed copy of a `Kill` reliable event, sent to everyone. Actor
 * fields are `actorCode` values (slot, or WORLD_SLOT_CODE); `cause` indexes `KILL_CAUSES_BY_CODE`.
 */
export interface KillFeed {
  /** u32 */
  readonly serverTick: number;
  readonly killer: number;
  readonly victim: number;
  readonly cause: number;
  /** Who knocked the victim before the kill, or WORLD_SLOT_CODE for none. */
  readonly knockedBy: number;
  readonly headshot: boolean;
  /** Same team. */
  readonly friendlyFire: boolean;
  /** A knock rather than a kill. */
  readonly knock: boolean;
  /** 0.1 m, u16. */
  readonly distanceDm: number;
}

// KillFeed: type 8, serverTick 32, killer 5, victim 5, cause 5, knockedBy 5, flags 4 (headshot, friendlyFire, knock,
// reserved), distance 16.
export function encodeKillFeed(w: BitWriter, m: KillFeed): void {
  w.write(MsgId.KillFeed, 8);
  w.write(m.serverTick, 32);
  w.write(m.killer, ACTOR_BITS);
  w.write(m.victim, ACTOR_BITS);
  w.write(m.cause, 5);
  w.write(m.knockedBy, ACTOR_BITS);
  w.write((m.headshot ? 1 : 0) | (m.friendlyFire ? 2 : 0) | (m.knock ? 4 : 0), 4);
  w.write(Math.min(0xffff, Math.max(0, Math.round(m.distanceDm))), 16);
}
export function decodeKillFeed(r: BitReader): KillFeed | null {
  if (r.read(8) !== MsgId.KillFeed) return null;
  const serverTick = r.read(32);
  const killer = r.read(ACTOR_BITS);
  const victim = r.read(ACTOR_BITS);
  const cause = r.read(5);
  const knockedBy = r.read(ACTOR_BITS);
  const flags = r.read(4);
  const distanceDm = r.read(16);
  if (!finished(r) || cause >= KILL_CAUSES_BY_CODE.length || victim >= MAX_PLAYER_SLOTS || flags > 7) return null;
  return {
    serverTick,
    killer,
    victim,
    cause,
    knockedBy,
    headshot: (flags & 1) !== 0,
    friendlyFire: (flags & 2) !== 0,
    knock: (flags & 4) !== 0,
    distanceDm,
  };
}
