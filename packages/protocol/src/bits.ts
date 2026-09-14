// Bit packing (netcode.md §6.5): LSB-first within bytes, multi-bit fields little-endian. Codecs write through these
// interfaces so the builder can reuse one writer per client (no per-tick allocation).

export interface BitWriter {
  /** Writes the low `bits` (1..32) of `value`. */
  write(value: number, bits: number): void;
  writeBool(value: boolean): void;
  /** Zigzag-encodes a signed integer into `bits` (1..32): 0, -1, 1, -2, … → 0, 1, 2, 3, … */
  writeSigned(value: number, bits: number): void;
  writeBytes(bytes: Uint8Array): void;
  /** Bits written since the last reset. */
  readonly bitLength: number;
  /** Whole bytes needed for `bitLength`. */
  readonly byteLength: number;
  /** View of the written bytes (valid until the next write or reset). Cached while the length is unchanged. */
  bytes(): Uint8Array;
  /** The whole backing buffer, for transports that take (buffer, byteLength) with no view allocation. */
  readonly buffer: Uint8Array;
  reset(): void;
}

export interface BitReader {
  /** Reads `bits` (1..32) as an unsigned number. */
  read(bits: number): number;
  readBool(): boolean;
  /** Reads a zigzag-encoded signed integer of `bits` (1..32). */
  readSigned(bits: number): number;
  /** A view into the source (no copy); empty after overflow. */
  readBytes(length: number): Uint8Array;
  readonly bitsLeft: number;
  /** True after any read past the end; decoders check this instead of throwing per field. */
  readonly overflowed: boolean;
  /** Re-targets the reader at a new message, clearing position and overflow. */
  reset(bytes: Uint8Array): void;
}

const EMPTY = new Uint8Array(0);

class BitWriterImpl implements BitWriter {
  private readonly buf: Uint8Array;
  private pos = 0;
  private view: Uint8Array = EMPTY;

  constructor(capacityBytes: number) {
    this.buf = new Uint8Array(capacityBytes);
  }

  get buffer(): Uint8Array {
    return this.buf;
  }

  get bitLength(): number {
    return this.pos;
  }

  get byteLength(): number {
    return (this.pos + 7) >>> 3;
  }

  write(value: number, bits: number): void {
    const end = this.pos + bits;
    if (end > this.buf.length * 8) throw new RangeError(`BitWriter capacity ${this.buf.length} B exceeded`);
    let v = bits === 32 ? value >>> 0 : (value & ((1 << bits) - 1)) >>> 0;
    const buf = this.buf;
    let pos = this.pos;
    while (pos < end) {
      const index = pos >>> 3;
      const offset = pos & 7;
      const take = Math.min(8 - offset, end - pos);
      const mask = (1 << take) - 1;
      buf[index] = (buf[index]! & ((1 << offset) - 1)) | ((v & mask) << offset);
      v = v >>> take;
      pos += take;
    }
    this.pos = end;
  }

  writeBool(value: boolean): void {
    this.write(value ? 1 : 0, 1);
  }

  writeSigned(value: number, bits: number): void {
    this.write(value >= 0 ? value * 2 : -value * 2 - 1, bits);
  }

  writeBytes(bytes: Uint8Array): void {
    if ((this.pos & 7) === 0) {
      const at = this.pos >>> 3;
      if (at + bytes.length > this.buf.length) throw new RangeError(`BitWriter capacity ${this.buf.length} B exceeded`);
      this.buf.set(bytes, at);
      this.pos += bytes.length * 8;
      return;
    }
    for (let i = 0; i < bytes.length; i++) this.write(bytes[i]!, 8);
  }

  bytes(): Uint8Array {
    const length = this.byteLength;
    if (this.view.length !== length || this.view.buffer !== this.buf.buffer) this.view = this.buf.subarray(0, length);
    return this.view;
  }

  reset(): void {
    this.pos = 0;
  }
}

class BitReaderImpl implements BitReader {
  private buf: Uint8Array;
  private pos = 0;
  private end: number;
  private over = false;

  constructor(bytes: Uint8Array) {
    this.buf = bytes;
    this.end = bytes.length * 8;
  }

  get bitsLeft(): number {
    return this.end - this.pos;
  }

  get overflowed(): boolean {
    return this.over;
  }

  reset(bytes: Uint8Array): void {
    this.buf = bytes;
    this.end = bytes.length * 8;
    this.pos = 0;
    this.over = false;
  }

  read(bits: number): number {
    const end = this.pos + bits;
    if (end > this.end) {
      this.over = true;
      this.pos = this.end;
      return 0;
    }
    const buf = this.buf;
    let pos = this.pos;
    let result = 0;
    let shift = 0;
    while (pos < end) {
      const offset = pos & 7;
      const take = Math.min(8 - offset, end - pos);
      const chunk = (buf[pos >>> 3]! >>> offset) & ((1 << take) - 1);
      result += (chunk << shift) >>> 0;
      shift += take;
      pos += take;
    }
    this.pos = end;
    return result;
  }

  readBool(): boolean {
    return this.read(1) === 1;
  }

  readSigned(bits: number): number {
    const z = this.read(bits);
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  readBytes(length: number): Uint8Array {
    if (length <= 0) return EMPTY;
    if ((this.pos & 7) !== 0 || this.pos + length * 8 > this.end) {
      // Non-aligned byte strings never occur in our layouts; treat them like a truncated message.
      this.over = true;
      this.pos = this.end;
      return EMPTY;
    }
    const at = this.pos >>> 3;
    this.pos += length * 8;
    return this.buf.subarray(at, at + length);
  }
}

export function createBitWriter(capacityBytes: number): BitWriter {
  return new BitWriterImpl(capacityBytes);
}

export function createBitReader(bytes: Uint8Array): BitReader {
  return new BitReaderImpl(bytes);
}

/** Bits needed to zigzag-encode any integer with |v| ≤ maxAbs. */
export function zigzagBits(maxAbs: number): number {
  return Math.ceil(Math.log2(maxAbs * 2 + 2));
}
