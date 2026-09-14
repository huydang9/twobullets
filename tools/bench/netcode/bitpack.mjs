// Minimal LSB-first bit writer/reader over a Uint8Array. Prototype of packages/shared/src/net/bits.ts.
// Values are unsigned integers up to 32 bits; signed values go through zigzag.

export class BitWriter {
  constructor(capacity = 2048) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.acc = 0;
    this.accBits = 0;
  }
  reset() {
    this.pos = 0;
    this.acc = 0;
    this.accBits = 0;
  }
  #w16(v, n) {
    this.acc |= v << this.accBits;
    this.accBits += n;
    while (this.accBits >= 8) {
      this.buf[this.pos++] = this.acc & 255;
      this.acc >>>= 8;
      this.accBits -= 8;
    }
  }
  write(value, bits) {
    if (bits <= 16) this.#w16(value & ((1 << bits) - 1), bits);
    else {
      this.#w16(value & 0xffff, 16);
      this.#w16((value >>> 16) & ((1 << (bits - 16)) - 1), bits - 16);
    }
  }
  bool(b) {
    this.#w16(b ? 1 : 0, 1);
  }
  signed(value, bits) {
    // zigzag: 0,-1,1,-2,... -> 0,1,2,3,...
    this.write(value >= 0 ? value * 2 : -value * 2 - 1, bits);
  }
  /** Bytes written so far including a partially filled trailing byte. */
  finish() {
    if (this.accBits > 0) {
      this.buf[this.pos++] = this.acc & 255;
      this.acc = 0;
      this.accBits = 0;
    }
    return this.pos;
  }
  get bitLength() {
    return this.pos * 8 + this.accBits;
  }
}

export class BitReader {
  constructor(buf, length = buf.length) {
    this.buf = buf;
    this.length = length;
    this.pos = 0;
    this.acc = 0;
    this.accBits = 0;
  }
  #r16(n) {
    while (this.accBits < n) {
      this.acc |= (this.pos < this.length ? this.buf[this.pos] : 0) << this.accBits;
      this.pos++;
      this.accBits += 8;
    }
    const v = this.acc & ((1 << n) - 1);
    this.acc >>>= n;
    this.accBits -= n;
    return v;
  }
  read(bits) {
    if (bits <= 16) return this.#r16(bits);
    const lo = this.#r16(16);
    return lo + this.#r16(bits - 16) * 65536;
  }
  bool() {
    return this.#r16(1) === 1;
  }
  signed(bits) {
    const z = this.read(bits);
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
}

/** Bits needed to zigzag-encode any value with |v| <= maxAbs. */
export function zigzagBits(maxAbs) {
  return Math.ceil(Math.log2(maxAbs * 2 + 2));
}
