import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter, zigzagBits } from "../src/bits";
import { createTestRng, randInt } from "./rng";

describe("BitWriter/BitReader", () => {
  it("roundtrips random unsigned and signed fields of every width", () => {
    const rng = createTestRng(1);
    const w = createBitWriter(4096);
    for (let round = 0; round < 50; round++) {
      w.reset();
      const fields: { bits: number; value: number; signed: boolean }[] = [];
      for (let i = 0; i < 200; i++) {
        const bits = randInt(rng, 1, 32);
        const signed = bits > 1 && rng() < 0.5;
        const value = signed
          ? randInt(rng, -(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
          : Math.floor(rng() * 2 ** bits);
        fields.push({ bits, value, signed });
        if (signed) w.writeSigned(value, bits);
        else w.write(value, bits);
      }
      const r = createBitReader(w.bytes());
      for (const f of fields) expect(f.signed ? r.readSigned(f.bits) : r.read(f.bits)).toBe(f.value);
      expect(r.overflowed).toBe(false);
      expect(r.bitsLeft).toBeLessThan(8);
    }
  });

  it("is LSB-first within bytes", () => {
    const w = createBitWriter(4);
    w.write(1, 1);
    w.write(0b101, 3);
    w.write(0xabc, 12);
    expect([...w.bytes()]).toEqual([0b1100_1011, 0xab]);
    expect(w.bitLength).toBe(16);
  });

  it("writes byte strings aligned and unaligned", () => {
    const w = createBitWriter(16);
    w.write(0xff, 8);
    w.writeBytes(new Uint8Array([1, 2, 3]));
    w.write(1, 3);
    w.writeBytes(new Uint8Array([0xaa]));
    const r = createBitReader(w.bytes());
    expect(r.read(8)).toBe(0xff);
    expect([...r.readBytes(3)]).toEqual([1, 2, 3]);
    expect(r.read(3)).toBe(1);
    expect(r.read(8)).toBe(0xaa);
  });

  it("flags overflow instead of throwing and never reads past the end", () => {
    const r = createBitReader(new Uint8Array([0xff]));
    expect(r.read(4)).toBe(15);
    expect(r.read(8)).toBe(0);
    expect(r.overflowed).toBe(true);
    expect(r.bitsLeft).toBe(0);
    expect(r.readBytes(4).length).toBe(0);
    r.reset(new Uint8Array([7]));
    expect(r.overflowed).toBe(false);
    expect(r.read(8)).toBe(7);
  });

  it("throws when writing beyond capacity (a sizing bug, not wire data)", () => {
    const w = createBitWriter(1);
    w.write(0, 8);
    expect(() => w.write(1, 1)).toThrow(RangeError);
  });

  it("reuses its buffer across resets", () => {
    const w = createBitWriter(8);
    w.write(0x1234, 16);
    const a = w.bytes();
    w.reset();
    w.write(0xffff, 16);
    const b = w.bytes();
    expect(b).toBe(a);
    expect([...b]).toEqual([0xff, 0xff]);
  });

  it("zigzagBits", () => {
    expect(zigzagBits(127)).toBe(8);
    expect(zigzagBits(65535)).toBe(17);
  });
});
