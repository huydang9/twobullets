// Bit packing (netcode.md §6.5): LSB-first within bytes, multi-bit fields little-endian. Codecs write through these
// interfaces so the builder can reuse one writer per client (no per-tick allocation).

export interface BitWriter {
  /** Writes the low `bits` (1..32) of `value`. */
  write(value: number, bits: number): void;
  writeBool(value: boolean): void;
  writeBytes(bytes: Uint8Array): void;
  /** Bits written since the last reset. */
  readonly bitLength: number;
  /** View of the written bytes (valid until the next write or reset). */
  bytes(): Uint8Array;
  reset(): void;
}

export interface BitReader {
  /** Reads `bits` (1..32) as an unsigned number. */
  read(bits: number): number;
  readBool(): boolean;
  readBytes(length: number): Uint8Array;
  readonly bitsLeft: number;
  /** True after any read past the end; decoders check this instead of throwing per field. */
  readonly overflowed: boolean;
}

export function createBitWriter(capacityBytes: number): BitWriter {
  throw new Error("not implemented");
}

export function createBitReader(bytes: Uint8Array): BitReader {
  throw new Error("not implemented");
}
