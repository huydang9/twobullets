import type { BitReader, BitWriter } from "../bits";
import { MAX_PLAYER_SLOTS, SLOT_BITS, TEAM_BITS, WORLD_SLOT_CODE } from "../codes";
import { PhaseCode } from "./control";
import { MsgId } from "./ids";

// Battle royale lifecycle messages on the control stream (netcode.md §6.4, §8; protocol v4): PhaseChange, ZonePhase and
// MatchEnd. Codecs write/read the id byte first; every message is byte-aligned.

/** 0x43, S→C, per phase change and once after Welcome (12 B). */
export interface PhaseChange {
  /** `PhaseCode`. */
  readonly phase: number;
  /** u32: tick the phase started. */
  readonly startTick: number;
  /** u32: tick the phase is scheduled to end, or 0 when open-ended (combat, a warmup still waiting for players). */
  readonly endTick: number;
  /** Teams with a member alive or knocked (u8). */
  readonly teamsAlive: number;
  /** Players alive or knocked (u8). */
  readonly playersAlive: number;
}

/** Zone circle on the wire: centers u16 over [−512, 512) m and radius u16 over [0, 1024) m, 1/64 m (1.6 cm). */
export interface WireZoneCircle {
  readonly cx: number;
  readonly cz: number;
  readonly r: number;
}

/**
 * 0x46, S→C, when a zone phase is announced and on (re)join for every phase so far (27 B). Field for field the shared
 * `ZonePhase` (packages/shared/src/match/types.ts), so the client runs `zoneAt(tick)` on the same data. The server
 * simulates the quantized values (`quantizeZonePhase`), so both sides agree exactly.
 */
export interface ZonePhaseMessage {
  /** 1-based, u8. */
  readonly index: number;
  readonly waitStartTick: number;
  readonly shrinkStartTick: number;
  readonly shrinkEndTick: number;
  readonly from: WireZoneCircle;
  readonly to: WireZoneCircle;
  /** Damage per second outside the circle; 0.1 steps, ≤ 25.5. */
  readonly dps: number;
}

/** MatchEnd reason codes (u8). `hostEnded` (v8): the match host ended it for everyone. */
export const MatchEndReason = { lastTeam: 0, allDead: 1, timeCap: 2, cancelled: 3, aborted: 4, hostEnded: 5 } as const;
export type MatchEndReason = (typeof MatchEndReason)[keyof typeof MatchEndReason];

export interface MatchEndPlayer {
  readonly slot: number;
  readonly teamId: number;
  /** 1 = winning team; 0 = unknown (aborted). Up to 31. */
  readonly placement: number;
  readonly bot: boolean;
  /** u8 each (saturating). */
  readonly kills: number;
  readonly knocks: number;
  readonly revives: number;
  /** Whole HP, u16. */
  readonly damageDealt: number;
  /** Seconds from combat start, u16. */
  readonly survivedSec: number;
}

/** 0x4A, S→C, once when the match ends (8 B + 9 B per player, ≤ 188 B). */
export interface MatchEnd {
  /** u32 */
  readonly serverTick: number;
  readonly reason: MatchEndReason;
  /** Winning team, or -1. */
  readonly winningTeam: number;
  readonly players: readonly MatchEndPlayer[];
}

const ZONE_Q = 64;
const ZONE_CENTER_OFFSET_M = 512;
const U16 = 0xffff;

function clampRound(v: number, max: number): number {
  const q = Math.round(v);
  return q !== q || q < 0 ? 0 : q > max ? max : q;
}

export function quantizeZoneCenter(m: number): number {
  return clampRound((m + ZONE_CENTER_OFFSET_M) * ZONE_Q, U16);
}
export function dequantizeZoneCenter(q: number): number {
  return q / ZONE_Q - ZONE_CENTER_OFFSET_M;
}
export function quantizeZoneRadius(m: number): number {
  return clampRound(m * ZONE_Q, U16);
}
export function dequantizeZoneRadius(q: number): number {
  return q / ZONE_Q;
}

function quantizeCircle(c: WireZoneCircle): WireZoneCircle {
  return { cx: dequantizeZoneCenter(quantizeZoneCenter(c.cx)), cz: dequantizeZoneCenter(quantizeZoneCenter(c.cz)), r: dequantizeZoneRadius(quantizeZoneRadius(c.r)) };
}

/** The phase exactly as the client decodes it (server uses this for its own zone). */
export function quantizeZonePhase<T extends ZonePhaseMessage>(phase: T): T {
  return { ...phase, from: quantizeCircle(phase.from), to: quantizeCircle(phase.to), dps: clampRound(phase.dps * 10, 255) / 10 };
}

function finished(r: BitReader): boolean {
  return !r.overflowed && r.bitsLeft === 0;
}

// PhaseChange (12 B): type 8, phase 8, startTick 32, endTick 32, teamsAlive 8, playersAlive 8.
export function encodePhaseChange(w: BitWriter, m: PhaseChange): void {
  w.write(MsgId.PhaseChange, 8);
  w.write(m.phase, 8);
  w.write(m.startTick >>> 0, 32);
  w.write(m.endTick >>> 0, 32);
  w.write(Math.min(255, Math.max(0, m.teamsAlive)), 8);
  w.write(Math.min(255, Math.max(0, m.playersAlive)), 8);
}
export function decodePhaseChange(r: BitReader): PhaseChange | null {
  if (r.read(8) !== MsgId.PhaseChange) return null;
  const phase = r.read(8);
  const startTick = r.read(32);
  const endTick = r.read(32);
  const teamsAlive = r.read(8);
  const playersAlive = r.read(8);
  if (!finished(r) || phase > PhaseCode.End) return null;
  return { phase, startTick, endTick, teamsAlive, playersAlive };
}

function writeCircle(w: BitWriter, c: WireZoneCircle): void {
  w.write(quantizeZoneCenter(c.cx), 16);
  w.write(quantizeZoneCenter(c.cz), 16);
  w.write(quantizeZoneRadius(c.r), 16);
}
function readCircle(r: BitReader): WireZoneCircle {
  const cx = dequantizeZoneCenter(r.read(16));
  const cz = dequantizeZoneCenter(r.read(16));
  return { cx, cz, r: dequantizeZoneRadius(r.read(16)) };
}

// ZonePhase (27 B): type 8, index 8, waitStartTick 32, shrinkStartTick 32, shrinkEndTick 32, from {cx, cz, r} 48,
// to {cx, cz, r} 48, dps×10 8.
export function encodeZonePhase(w: BitWriter, m: ZonePhaseMessage): void {
  w.write(MsgId.ZonePhase, 8);
  w.write(Math.min(255, Math.max(0, m.index)), 8);
  w.write(m.waitStartTick >>> 0, 32);
  w.write(m.shrinkStartTick >>> 0, 32);
  w.write(m.shrinkEndTick >>> 0, 32);
  writeCircle(w, m.from);
  writeCircle(w, m.to);
  w.write(clampRound(m.dps * 10, 255), 8);
}
export function decodeZonePhase(r: BitReader): ZonePhaseMessage | null {
  if (r.read(8) !== MsgId.ZonePhase) return null;
  const index = r.read(8);
  const waitStartTick = r.read(32);
  const shrinkStartTick = r.read(32);
  const shrinkEndTick = r.read(32);
  const from = readCircle(r);
  const to = readCircle(r);
  const dps = r.read(8) / 10;
  if (!finished(r) || index === 0 || shrinkStartTick < waitStartTick || shrinkEndTick < shrinkStartTick) return null;
  return { index, waitStartTick, shrinkStartTick, shrinkEndTick, from, to, dps };
}

// MatchEnd: type 8, serverTick 32, reason 8, winningTeam 5 (31 = none), count 5, reserved 6; per player: slot 5, team 5,
// placement 5, bot 1, kills 8, knocks 8, revives 8, damageDealt 16, survivedSec 16.
export function encodeMatchEnd(w: BitWriter, m: MatchEnd): void {
  const count = Math.min(MAX_PLAYER_SLOTS, m.players.length);
  w.write(MsgId.MatchEnd, 8);
  w.write(m.serverTick >>> 0, 32);
  w.write(m.reason, 8);
  w.write(m.winningTeam < 0 ? WORLD_SLOT_CODE : m.winningTeam, TEAM_BITS);
  w.write(count, 5);
  w.write(0, 6);
  for (let i = 0; i < count; i++) {
    const p = m.players[i]!;
    w.write(p.slot, SLOT_BITS);
    w.write(p.teamId, TEAM_BITS);
    w.write(Math.min(31, Math.max(0, p.placement)), 5);
    w.write(p.bot ? 1 : 0, 1);
    w.write(clampRound(p.kills, 255), 8);
    w.write(clampRound(p.knocks, 255), 8);
    w.write(clampRound(p.revives, 255), 8);
    w.write(clampRound(p.damageDealt, U16), 16);
    w.write(clampRound(p.survivedSec, U16), 16);
  }
}
export function decodeMatchEnd(r: BitReader): MatchEnd | null {
  if (r.read(8) !== MsgId.MatchEnd) return null;
  const serverTick = r.read(32);
  const reason = r.read(8);
  const winning = r.read(TEAM_BITS);
  const count = r.read(5);
  r.read(6);
  if (r.overflowed || reason > MatchEndReason.hostEnded || count > MAX_PLAYER_SLOTS) return null;
  const players: MatchEndPlayer[] = [];
  for (let i = 0; i < count; i++) {
    const slot = r.read(SLOT_BITS);
    const teamId = r.read(TEAM_BITS);
    const placement = r.read(5);
    const bot = r.read(1) === 1;
    const kills = r.read(8);
    const knocks = r.read(8);
    const revives = r.read(8);
    const damageDealt = r.read(16);
    const survivedSec = r.read(16);
    if (slot >= MAX_PLAYER_SLOTS) return null;
    players.push({ slot, teamId, placement, bot, kills, knocks, revives, damageDealt, survivedSec });
  }
  if (!finished(r)) return null;
  return { serverTick, reason: reason as MatchEndReason, winningTeam: winning === WORLD_SLOT_CODE ? -1 : winning, players };
}
