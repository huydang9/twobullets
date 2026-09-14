import type { Session } from "../transport/Session";
import type { Clock } from "./clock";

// In-memory Session pair: whatever one end sends, the other receives immediately (in send order, trampolined so a
// handler that replies doesn't recurse). Bytes are copied because senders reuse their writer buffers.

export interface MemorySessionOptions {
  readonly clock: Clock;
  readonly kind?: Session["kind"];
  readonly maxDatagramSize?: number;
}

export interface MemorySession extends Session {
  readonly closed: boolean;
  readonly closeCode: number;
}

interface Delivery {
  target: MemorySessionImpl;
  stream: boolean;
  bytes: Uint8Array;
}

class Trampoline {
  private readonly queue: Delivery[] = [];
  private draining = false;

  push(d: Delivery): void {
    this.queue.push(d);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i]!;
        q.target.receive(q.stream, q.bytes);
      }
    } finally {
      this.queue.length = 0;
      this.draining = false;
    }
  }
}

class MemorySessionImpl implements MemorySession {
  readonly kind: Session["kind"];
  readonly maxDatagramSize: number;
  peer: MemorySessionImpl | null = null;
  closed = false;
  closeCode = 0;
  private readonly datagramCbs: ((bytes: Uint8Array, recvTimeMs: number) => void)[] = [];
  private readonly streamCbs: ((bytes: Uint8Array) => void)[] = [];
  private readonly clock: Clock;
  private readonly trampoline: Trampoline;

  constructor(options: MemorySessionOptions, trampoline: Trampoline) {
    this.kind = options.kind ?? "webtransport";
    this.maxDatagramSize = options.maxDatagramSize ?? (this.kind === "websocket" ? 0 : 1200);
    this.clock = options.clock;
    this.trampoline = trampoline;
  }

  sendDatagram(bytes: Uint8Array): boolean {
    if (this.closed || this.peer === null) return false;
    if (this.maxDatagramSize > 0 && bytes.length > this.maxDatagramSize) return false;
    this.trampoline.push({ target: this.peer, stream: false, bytes: bytes.slice() });
    return true;
  }

  sendStream(bytes: Uint8Array): void {
    if (this.closed || this.peer === null) return;
    this.trampoline.push({ target: this.peer, stream: true, bytes: bytes.slice() });
  }

  onDatagram(cb: (bytes: Uint8Array, recvTimeMs: number) => void): void {
    this.datagramCbs.push(cb);
  }

  onStream(cb: (bytes: Uint8Array) => void): void {
    this.streamCbs.push(cb);
  }

  queuedBytes(): number {
    return 0;
  }

  close(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    const peer = this.peer;
    if (peer !== null && !peer.closed) peer.close(code);
  }

  receive(stream: boolean, bytes: Uint8Array): void {
    if (this.closed) return;
    if (stream) for (const cb of this.streamCbs) cb(bytes);
    else {
      const t = this.clock.now();
      for (const cb of this.datagramCbs) cb(bytes, t);
    }
  }
}

/** `[client, server]` ends of one connection. */
export function createMemorySessionPair(options: MemorySessionOptions): [MemorySession, MemorySession] {
  const trampoline = new Trampoline();
  const a = new MemorySessionImpl(options, trampoline);
  const b = new MemorySessionImpl(options, trampoline);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
