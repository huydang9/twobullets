// One client connection, transport-agnostic (netcode.md §7.2, ADR 0203). WebTransport: datagrams + one control
// stream. WebSocket fallback: same message ids, datagram-class messages become binary WS messages.

export interface Session {
  readonly kind: "webtransport" | "websocket";
  /** 0 for WS (message-sized). */
  readonly maxDatagramSize: number;
  /** false = dropped (congestion/backpressure). */
  sendDatagram(bytes: Uint8Array): boolean;
  /** Length-prefixed control frames. */
  sendStream(bytes: Uint8Array): void;
  onDatagram(cb: (bytes: Uint8Array, recvTimeMs: number) => void): void;
  onStream(cb: (bytes: Uint8Array) => void): void;
  /** Bytes queued but not yet sent (WT `desiredSize` / WS `bufferedAmount`), for backpressure (C18). */
  queuedBytes(): number;
  close(code: number): void;
}
