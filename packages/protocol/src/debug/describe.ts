import { createBitReader } from "../bits";
import { decodeDisconnect, decodeHello, decodeKillFeed, decodeResyncRequest, decodeResyncResponse, decodeWelcome } from "../messages/control";
import { MsgId, peekMsgId } from "../messages/ids";
import { decodeMatchEnd, decodePhaseChange, decodeZonePhase } from "../messages/match";
import { decodeInputPacket } from "../messages/input";
import { decodePing } from "../messages/ping";
import { createSnapshotBuffer, decodeSnapshotHeader, decodeSnapshotInto, type Snapshot } from "../messages/snapshot";

// Debug decoding of one message to JSON-friendly data (ADR 0204: "debugging needs a decoder tool").

export interface DescribeOptions {
  /** Receiver's current tick for u16 unwrap (default 0). */
  readonly referenceTick?: number;
  /** Baselines available to delta snapshots, keyed by unwrapped tick. */
  readonly baselines?: ReadonlyMap<number, Snapshot>;
}

const NAMES: Record<number, string> = Object.fromEntries(Object.entries(MsgId).map(([k, v]) => [v, k]));

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/^0x/i, "").replace(/[\s:,_-]/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? bytesToHex(v) : v)));
}

/** `{ id, name, bytes, ok, message | error }`; never throws on malformed bytes. */
export function describeMessage(bytes: Uint8Array, options: DescribeOptions = {}): Record<string, unknown> {
  const id = peekMsgId(bytes);
  const ref = options.referenceTick ?? 0;
  const base = { id, name: NAMES[id] ?? "unknown", bytes: bytes.length };
  const r = createBitReader(bytes);
  let message: unknown = null;
  let error: string | null = null;
  switch (id) {
    case MsgId.Input:
      message = decodeInputPacket(r, ref);
      break;
    case MsgId.Ping:
      message = decodePing(r);
      break;
    case MsgId.Snapshot: {
      const out = createSnapshotBuffer();
      const baselines = options.baselines;
      if (decodeSnapshotInto(r, ref, (tick) => baselines?.get(tick) ?? null, out)) message = out;
      else {
        r.reset(bytes);
        const header = createSnapshotBuffer().header;
        if (decodeSnapshotHeader(r, ref, header)) {
          message = { header };
          error = header.baselineTick !== null && !baselines?.has(header.baselineTick) ? "baseline unavailable: header only" : "malformed body";
        }
      }
      break;
    }
    case MsgId.Hello:
      message = decodeHello(r);
      break;
    case MsgId.Welcome:
      message = decodeWelcome(r);
      break;
    case MsgId.Disconnect:
      message = decodeDisconnect(r);
      break;
    case MsgId.KillFeed:
      message = decodeKillFeed(r);
      break;
    case MsgId.PhaseChange:
      message = decodePhaseChange(r);
      break;
    case MsgId.ZonePhase:
      message = decodeZonePhase(r);
      break;
    case MsgId.MatchEnd:
      message = decodeMatchEnd(r);
      break;
    case MsgId.Resync:
      message = bytes.length === 2 ? decodeResyncRequest(r) : decodeResyncResponse(r);
      break;
    default:
      error = "no decoder for this id";
  }
  if (message === null && error === null) error = "malformed";
  if (message !== null && typeof message === "object" && "entityPool" in message) {
    const { header, owner, entities, weapon, vitals, shots, hits, reliable } = message as unknown as Snapshot;
    message = { header, owner, weapon, vitals, entities, shots, hits, reliable };
  }
  return { ...base, ok: error === null, ...(message !== null ? { message: plain(message) } : {}), ...(error ? { error } : {}) };
}
