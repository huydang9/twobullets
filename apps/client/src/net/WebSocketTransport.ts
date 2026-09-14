import { isDatagramId } from "@twobullets/protocol/messages/ids";
import type { Session } from "@twobullets/netcode/transport/Session";
import { CLOSE_CODE_CLIENT_LEAVE, CONNECT_TIMEOUT_MS } from "./handshake";

/** Datagram-class sends are dropped above this much unsent data (TCP is stalled; stale inputs are worthless). */
const MAX_BUFFERED_BYTES = 16 * 1024;

/**
 * WSS fallback `Session` (netcode.md §7.2): one protocol message per binary WS message, first byte the MsgId, no
 * length prefix. Datagram-class ids (0x00–0x3F) go to `onDatagram` with the arrival time, the rest to `onStream`.
 */
export class WebSocketTransport implements Session {
  readonly kind = "websocket" as const;
  readonly maxDatagramSize = 0;
  private readonly ws: WebSocket;
  private readonly datagramCbs: ((bytes: Uint8Array, recvTimeMs: number) => void)[] = [];
  private readonly streamCbs: ((bytes: Uint8Array) => void)[] = [];
  private readonly closeCbs: ((code: number) => void)[] = [];
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      const now = performance.now();
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length === 0) return;
      if (isDatagramId(bytes[0]!)) for (const cb of this.datagramCbs) cb(bytes, now);
      else for (const cb of this.streamCbs) cb(bytes);
    };
    ws.onclose = (event: CloseEvent) => this.finish(event.code);
    ws.onerror = () => {
      // A close event always follows.
    };
  }

  /** Opens the socket; rejects on error or after the timeout. */
  static connect(url: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connect timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new WebSocketTransport(ws));
      };
      ws.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket closed before opening (${event.code})`));
      };
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  sendDatagram(bytes: Uint8Array): boolean {
    if (!this.isOpen || this.ws.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    this.ws.send(bytes as Uint8Array<ArrayBuffer>);
    return true;
  }

  sendStream(bytes: Uint8Array): void {
    if (this.isOpen) this.ws.send(bytes as Uint8Array<ArrayBuffer>);
  }

  onDatagram(cb: (bytes: Uint8Array, recvTimeMs: number) => void): void {
    this.datagramCbs.push(cb);
  }

  onStream(cb: (bytes: Uint8Array) => void): void {
    this.streamCbs.push(cb);
  }

  /** Fires once when the socket closes (either side), with the close code. */
  onClose(cb: (code: number) => void): void {
    this.closeCbs.push(cb);
  }

  queuedBytes(): number {
    return this.ws.bufferedAmount;
  }

  close(code: number): void {
    if (this.closed) return;
    const wsCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : CLOSE_CODE_CLIENT_LEAVE;
    this.ws.close(wsCode);
    this.finish(wsCode);
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(code);
  }
}
