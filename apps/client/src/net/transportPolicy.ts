import type { Session } from "@twobullets/netcode/transport/Session";
import { WebSocketTransport } from "./WebSocketTransport";

// Transport selection (netcode.md §7.3). M3 tonight: WebSocket only. The WebTransport path is a stub so the policy's
// shape is fixed: try WT for 3 s, verify datagrams with 10 pings, otherwise fall back to WSS and remember the choice
// per network for 24 h.

export type TransportChoice = "websocket" | "webtransport";

export interface OpenedTransport {
  readonly session: Session;
  readonly kind: TransportChoice;
  /** Registers the close notification (code). */
  onClose(cb: (code: number) => void): void;
  /** Why WT wasn't used, for telemetry ("" when WT won). */
  readonly fallbackReason: string;
}

export const WT_CONNECT_TIMEOUT_MS = 3000;

/** Opens the best available transport for `wsUrl`. */
export async function openTransport(wsUrl: string): Promise<OpenedTransport> {
  // TODO(M3 WT): when server-match serves WebTransport, try `new WebTransport(https://host:port/m/{id})` first when
  // `"WebTransport" in globalThis`, with `serverCertificateHashes` from the token response, and fall back here on
  // timeout or when the datagram ping check fails ("wt_datagram_blocked").
  const ws = await WebSocketTransport.connect(wsUrl);
  return { session: ws, kind: "websocket", onClose: (cb) => ws.onClose(cb), fallbackReason: "wt_not_implemented" };
}
