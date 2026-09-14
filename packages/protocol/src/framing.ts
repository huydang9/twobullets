// Control-stream framing (netcode.md §6.2 tier S): WebTransport streams are byte streams, so every control message is
// prefixed with a u16 little-endian length. The WebSocket fallback sends one message per WS frame and skips this.

/** LootResync chunks are 4 KB; anything above this is a protocol violation. */
export const MAX_STREAM_FRAME_BYTES = 8192;

/** Writes `[len u16 LE][payload]` into `out` (length ≥ payload + 2); returns bytes written. */
export function writeStreamFrame(payload: Uint8Array, out: Uint8Array): number {
  if (payload.length > MAX_STREAM_FRAME_BYTES) throw new RangeError("stream frame too large");
  out[0] = payload.length & 0xff;
  out[1] = payload.length >>> 8;
  out.set(payload, 2);
  return payload.length + 2;
}

/**
 * Reassembles frames from arbitrary stream chunks. Frames are delivered as views into an internal buffer, valid only
 * during the callback. A length above MAX_STREAM_FRAME_BYTES marks the stream `corrupt` and stops delivery.
 */
export class StreamDeframer {
  private readonly buf = new Uint8Array(MAX_STREAM_FRAME_BYTES + 2);
  private fill = 0;
  private broken = false;

  get corrupt(): boolean {
    return this.broken;
  }

  push(chunk: Uint8Array, onFrame: (frame: Uint8Array) => void): void {
    let i = 0;
    while (i < chunk.length && !this.broken) {
      if (this.fill < 2) {
        this.buf[this.fill++] = chunk[i++]!;
        if (this.fill === 2 && this.frameLength() > MAX_STREAM_FRAME_BYTES) this.broken = true;
        continue;
      }
      const need = 2 + this.frameLength() - this.fill;
      const take = Math.min(need, chunk.length - i);
      this.buf.set(chunk.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === 2 + this.frameLength()) {
        const length = this.frameLength();
        this.fill = 0;
        onFrame(this.buf.subarray(2, 2 + length));
      }
    }
    // Zero-length frames complete as soon as their header arrives.
    if (!this.broken && this.fill === 2 && this.frameLength() === 0) {
      this.fill = 0;
      onFrame(this.buf.subarray(2, 2));
    }
  }

  private frameLength(): number {
    return this.buf[0]! | (this.buf[1]! << 8);
  }
}
