import type { Clock, Session } from "@twobullets/netcode";
import { isDatagramId, isStreamId } from "@twobullets/protocol";
import WebSocket from "ws";

// WebSocket fallback transport (netcode.md §6.2, §7.3): one protocol message per binary WS message, no length prefix.
// The message id range decides the class: 0x00–0x3F datagram (U tier), 0x40–0x7F control stream (S tier). Works for
// both ends (server-accepted and client `ws` sockets). Backpressure: `bufferedAmount` (C18).

export interface WsSessionOptions {
  /** Datagram-class sends are dropped (return false) above this many buffered bytes. */
  readonly maxBufferedBytes?: number;
}

/** WS close code for a DisconnectReason (4000–4999 is the application range). */
export function wsCloseCode(reason: number): number {
  return 4000 + (reason & 0xff);
}

export class WsSession implements Session {
  readonly kind = "websocket" as const;
  readonly maxDatagramSize = 0;
  private readonly ws: WebSocket;
  private readonly clock: Clock;
  private readonly maxBuffered: number;
  private readonly datagramCbs: ((bytes: Uint8Array, recvTimeMs: number) => void)[] = [];
  private readonly streamCbs: ((bytes: Uint8Array) => void)[] = [];
  bytesIn = 0;
  bytesOut = 0;

  constructor(ws: WebSocket, clock: Clock, options: WsSessionOptions = {}) {
    this.ws = ws;
    this.clock = clock;
    this.maxBuffered = options.maxBufferedBytes ?? 64 * 1024;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, "binary only");
        return;
      }
      const bytes = toBytes(data);
      if (bytes.length === 0) return;
      this.bytesIn += bytes.length;
      const id = bytes[0]!;
      if (isDatagramId(id)) {
        const t = this.clock.now();
        for (const cb of this.datagramCbs) cb(bytes, t);
      } else if (isStreamId(id)) {
        for (const cb of this.streamCbs) cb(bytes);
      }
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  sendDatagram(bytes: Uint8Array): boolean {
    if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > this.maxBuffered) return false;
    // Copy: callers reuse their writer buffers and the socket may hold the chunk until it drains.
    this.ws.send(Buffer.from(bytes));
    this.bytesOut += bytes.length;
    return true;
  }

  sendStream(bytes: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.from(bytes));
    this.bytesOut += bytes.length;
  }

  onDatagram(cb: (bytes: Uint8Array, recvTimeMs: number) => void): void {
    this.datagramCbs.push(cb);
  }

  onStream(cb: (bytes: Uint8Array) => void): void {
    this.streamCbs.push(cb);
  }

  queuedBytes(): number {
    return this.ws.bufferedAmount;
  }

  close(code: number): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(wsCloseCode(code));
  }
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
