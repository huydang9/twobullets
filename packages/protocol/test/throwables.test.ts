import { FLASH } from "@twobullets/shared/equipment/flash";
import { THROWABLE_KINDS, throwableDef, type ThrowableKind } from "@twobullets/shared/equipment/items";
import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { describeMessage } from "../src/debug/describe";
import { MsgId } from "../src/messages/ids";
import {
  createThrowableUpdateBuffer,
  decodeThrowableUpdate,
  decodeThrowableUpdateInto,
  decodeThrowArg,
  dequantizeThrowFuse,
  encodeThrowArg,
  flashSecondsOf,
  quantizeThrowFuse,
  THROW_STYLES,
  THROWABLE_OP_MAX_BYTES,
  THROWABLE_UPDATE_SOFT_BYTES,
  ThrowableOpCode,
  ThrowableUpdateWriter,
  throwableKindCode,
  throwableKindOfCode,
} from "../src/messages/throwables";
import { createTestRng, randInt } from "./rng";

type Rng = () => number;

const kinds = THROWABLE_KINDS;
const read = (bytes: Uint8Array) => decodeThrowableUpdate(createBitReader(bytes));

function randomPosition(rng: Rng): { x: number; y: number; z: number } {
  return { x: Math.round((rng() * 1000 - 500) * 100) / 100, y: Math.round((rng() * 60 - 10) * 100) / 100, z: Math.round((rng() * 1000 - 500) * 100) / 100 };
}

function randomVelocity(rng: Rng): { x: number; y: number; z: number } {
  const axis = () => Math.round((rng() * 60 - 30) * 16) / 16;
  return { x: axis(), y: axis(), z: axis() };
}

describe("ThrowableUpdate", () => {
  it("roundtrips every op with its quantization", () => {
    const w = new ThrowableUpdateWriter();
    w.begin();
    w.clear();
    w.spawn({ id: 0x1234, owner: 7, kind: "frag", position: { x: -12.34, y: 3.5, z: 88.01 }, velocity: { x: 12.5, y: -4.25, z: 0 }, fuse: 4.5 });
    w.move(0x1234, 1.5, 2.25, -3.75, -1, 0.5, 2);
    w.detonate(0x1234, 7, "frag", 1.5, 2.25, -3.75, 0, 1, 0);
    w.smokeStart(0x2222, 5, 0, -5, 0xdeadbeef);
    w.smokeEnd(0x2222);
    w.fireStart(0x3333, 3, 5, 0, -5, 0, 1, 0, 0x01020304);
    w.fireEnd(0x3333);
    w.flash(0x4444, 0.5, 1);
    w.remove(0x5555);
    const bytes = w.finish()!;
    expect(bytes[0]).toBe(MsgId.ThrowableUpdate);
    const ops = read(bytes)!;
    expect(ops.map((op) => op.op)).toEqual([
      ThrowableOpCode.clear,
      ThrowableOpCode.spawn,
      ThrowableOpCode.move,
      ThrowableOpCode.detonate,
      ThrowableOpCode.smokeStart,
      ThrowableOpCode.smokeEnd,
      ThrowableOpCode.fireStart,
      ThrowableOpCode.fireEnd,
      ThrowableOpCode.flash,
      ThrowableOpCode.remove,
    ]);
    const spawn = ops[1]!;
    expect(throwableKindOfCode(spawn.kind)).toBe("frag");
    expect(spawn.owner).toBe(7);
    expect(spawn.x).toBeCloseTo(-12.34, 2);
    expect(spawn.y).toBeCloseTo(3.5, 2);
    expect(spawn.z).toBeCloseTo(88.01, 2);
    expect(spawn.vx).toBeCloseTo(12.5, 3);
    expect(spawn.vy).toBeCloseTo(-4.25, 3);
    expect(spawn.fuse).toBeCloseTo(4.5, 3);
    const boom = ops[3]!;
    expect(boom.ny).toBeCloseTo(1, 2);
    expect(ops[4]!.seed >>> 0).toBe(0xdeadbeef);
    expect(ops[6]!.seed >>> 0).toBe(0x01020304);
    expect(ops[6]!.owner).toBe(3);
    const flash = ops[8]!;
    expect(flash.blind).toBeCloseTo(0.5, 2);
    expect(flash.deaf).toBe(1);
    expect(flashSecondsOf(flash).blindSeconds).toBeCloseTo(0.5 * FLASH.maxBlindSeconds, 1);
    expect(flashSecondsOf(flash).deafSeconds).toBeCloseTo(FLASH.maxDeafSeconds, 5);
    expect(ops[9]!.id).toBe(0x5555);
    expect(describeMessage(bytes).error ?? null).toBeNull();
  });

  it("an empty message is nothing to send; a message with ops ends with `end`", () => {
    const w = new ThrowableUpdateWriter();
    w.begin();
    expect(w.finish()).toBeNull();
    w.begin();
    w.remove(1);
    expect(w.ops).toBe(1);
    const bytes = w.finish()!;
    expect(read(bytes)!.length).toBe(1);
    // Bytes after the `end` op are a malformed message.
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    extra[extra.length - 1] = 0xff;
    expect(read(extra)).toBeNull();
    // A truncated message (no `end`) too.
    expect(read(bytes.subarray(0, 1))).toBeNull();
  });

  it("roundtrips 20,000 random op lists with no allocation in the decode buffer", () => {
    const rng = createTestRng(909);
    const w = new ThrowableUpdateWriter();
    const buf = createThrowableUpdateBuffer();
    for (let i = 0; i < 20000; i++) {
      w.begin();
      const count = randInt(rng, 1, 12);
      const expected: { op: number; id: number }[] = [];
      for (let k = 0; k < count; k++) {
        const id = randInt(rng, 0, 0xffff);
        const kind = kinds[randInt(rng, 0, kinds.length - 1)]!;
        const owner = randInt(rng, 0, 19);
        const p = randomPosition(rng);
        const v = randomVelocity(rng);
        const op = randInt(rng, 0, 8);
        switch (op) {
          case ThrowableOpCode.spawn:
            w.spawn({ id, owner, kind, position: p, velocity: v, fuse: Math.round(rng() * 4.5 * 128) / 128 });
            break;
          case ThrowableOpCode.move:
            w.move(id, p.x, p.y, p.z, v.x, v.y, v.z);
            break;
          case ThrowableOpCode.remove:
            w.remove(id);
            break;
          case ThrowableOpCode.detonate:
            w.detonate(id, owner, kind, p.x, p.y, p.z, 0, 1, 0);
            break;
          case ThrowableOpCode.smokeStart:
            w.smokeStart(id, p.x, p.y, p.z, randInt(rng, 0, 0xffff) * 65537);
            break;
          case ThrowableOpCode.smokeEnd:
            w.smokeEnd(id);
            break;
          case ThrowableOpCode.fireStart:
            w.fireStart(id, owner, p.x, p.y, p.z, 0, 1, 0, randInt(rng, 0, 0xffff) * 65537);
            break;
          case ThrowableOpCode.fireEnd:
            w.fireEnd(id);
            break;
          default:
            w.flash(id, rng(), rng());
            break;
        }
        expected.push({ op, id });
      }
      const bytes = w.finish()!;
      expect(decodeThrowableUpdateInto(createBitReader(bytes), buf)).toBe(true);
      expect(buf.count).toBe(expected.length);
      for (let k = 0; k < buf.count; k++) {
        expect(buf.ops[k]!.op).toBe(expected[k]!.op);
        expect(buf.ops[k]!.id).toBe(expected[k]!.id);
      }
    }
    // The pool grew to the busiest message and stops there.
    expect(buf.ops.length).toBeLessThanOrEqual(12);
  });

  it("sizes: a spawn fits in THROWABLE_OP_MAX_BYTES and a full flight costs a couple of hundred bytes", () => {
    const w = new ThrowableUpdateWriter();
    const size = (build: (w: ThrowableUpdateWriter) => void): number => {
      w.begin();
      build(w);
      return w.finish()!.length;
    };
    const header = 1;
    const spawn = size((x) => x.spawn({ id: 1, owner: 1, kind: "frag", position: { x: 1, y: 2, z: 3 }, velocity: { x: 1, y: 2, z: 3 }, fuse: 4.5 }));
    const move = size((x) => x.move(1, 1, 2, 3, 1, 2, 3));
    const detonate = size((x) => x.detonate(1, 1, "frag", 1, 2, 3, 0, 1, 0));
    const smoke = size((x) => x.smokeStart(1, 1, 2, 3, 1));
    const fire = size((x) => x.fireStart(1, 1, 1, 2, 3, 0, 1, 0, 1));
    const flash = size((x) => x.flash(1, 1, 1));
    const remove = size((x) => x.remove(1));
    expect(spawn).toBeLessThanOrEqual(THROWABLE_OP_MAX_BYTES);
    expect(fire).toBeLessThanOrEqual(THROWABLE_OP_MAX_BYTES);
    expect(remove - header).toBeLessThanOrEqual(3);
    expect(flash - header).toBeLessThanOrEqual(5);
    // A frag: spawn + 4.5 s of 10 Hz corrections + the detonation, all inside one client's budget.
    const flight = spawn + 45 * (move - header) + detonate - header;
    expect(flight).toBeLessThan(700);
    // A smoke cloud and a molotov area cost the shape-free seed only.
    expect(smoke).toBeLessThanOrEqual(15);
    expect(fire).toBeLessThanOrEqual(18);
    // The writer stops well before its own capacity.
    expect(THROWABLE_UPDATE_SOFT_BYTES + THROWABLE_OP_MAX_BYTES).toBeLessThan(1000);
  });

  it("`full` says when the next op may not fit", () => {
    const w = new ThrowableUpdateWriter();
    w.begin();
    expect(w.full).toBe(false);
    let ops = 0;
    while (!w.full && ops < 2000) {
      w.spawn({ id: ops & 0xffff, owner: 1, kind: "frag", position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, fuse: 1 });
      ops++;
    }
    expect(w.byteLength + THROWABLE_OP_MAX_BYTES).toBeGreaterThan(THROWABLE_UPDATE_SOFT_BYTES);
    expect(read(w.finish()!)!.length).toBe(ops);
  });
});

describe("throw action arg", () => {
  it("roundtrips every kind and style with the fuse, and refuses an impossible one", () => {
    for (const kind of kinds) {
      for (const style of THROW_STYLES) {
        const fuse = throwableDef(kind).fuseSeconds;
        const decoded = decodeThrowArg(encodeThrowArg(kind, style, fuse))!;
        expect(decoded.kind).toBe(kind);
        expect(decoded.style).toBe(style);
        expect(decoded.fuseSeconds).toBeCloseTo(fuse, 2);
      }
    }
    // A cooked frag: any fuse up to its own is fine.
    expect(decodeThrowArg(encodeThrowArg("frag", "overhand", 1.25))!.fuseSeconds).toBeCloseTo(1.25, 2);
    // Longer than the kind's own fuse can only come from a tampered client.
    expect(decodeThrowArg(encodeThrowArg("smoke", "overhand", 7.9))).toBeNull();
    expect(decodeThrowArg(encodeThrowArg("frag", "overhand", 7.9))).toBeNull();
    // The arg fits the 16-bit action field.
    for (const kind of kinds) expect(encodeThrowArg(kind, "inHand", throwableDef(kind).fuseSeconds)).toBeLessThan(1 << 16);
  });

  it("kind codes are stable and the fuse quantizes to 1/128 s", () => {
    expect(kinds.map((kind: ThrowableKind) => throwableKindCode(kind))).toEqual([0, 1, 2, 3]);
    expect(kinds.map((_, i) => throwableKindOfCode(i))).toEqual([...kinds]);
    expect(throwableKindOfCode(4)).toBeNull();
    expect(dequantizeThrowFuse(quantizeThrowFuse(4.5))).toBeCloseTo(4.5, 4);
    expect(quantizeThrowFuse(-1)).toBe(0);
    expect(quantizeThrowFuse(99)).toBe((1 << 10) - 1);
  });
});
