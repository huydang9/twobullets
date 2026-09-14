/**
 * Snapshot serialization cost for a realistic 10-player battle-royale snapshot (+ projectiles-in-flight summary and
 * a handful of events). Compares, in ns/op and bytes:
 *   json            JSON.stringify / JSON.parse (+ UTF-8 encode, since that is what goes on the wire)
 *   binaryFloat     DataView, full-precision float32 fields
 *   binaryQuant     DataView, quantized fields (1/64 m positions, cm/s velocity, 16-bit angles)
 *   binaryDelta     quantized + per-player field mask against a baseline snapshot (~60% of fields unchanged)
 *
 *   node tools/bench/runtime/serialization.ts [--batches=30] [--out=file.json]
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, machineInfo, parseArgs, round, summarize, createRng } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ batches: 30, out: "" });
const rng = createRng(7);

interface PlayerSnap {
  id: number;
  team: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  flags: number; // alive, grounded, crouch, sprint, ads, reloading, firing, knocked
  weapon: number;
  magazine: number;
  reserve: number;
  anim: number;
  animTime: number;
}
interface EventSnap {
  type: number; // 0 shot, 1 damage, 2 kill
  a: number;
  b: number;
  x: number;
  y: number;
  z: number;
  value: number;
}
interface Snapshot {
  tick: number;
  ackInput: number;
  zone: { x: number; z: number; radius: number; nextRadius: number; timer: number };
  players: PlayerSnap[];
  events: EventSnap[];
}

function makeSnapshot(tick: number): Snapshot {
  const players: PlayerSnap[] = [];
  for (let i = 0; i < 10; i++) {
    players.push({
      id: i,
      team: Math.floor(i / 2),
      x: (rng() - 0.5) * 1000,
      y: rng() * 40,
      z: (rng() - 0.5) * 1000,
      vx: (rng() - 0.5) * 12,
      vy: (rng() - 0.5) * 4,
      vz: (rng() - 0.5) * 12,
      yaw: rng() * Math.PI * 2,
      pitch: (rng() - 0.5) * 3,
      health: Math.floor(rng() * 101),
      armor: Math.floor(rng() * 101),
      flags: Math.floor(rng() * 256),
      weapon: Math.floor(rng() * 4),
      magazine: Math.floor(rng() * 31),
      reserve: Math.floor(rng() * 121),
      anim: Math.floor(rng() * 20),
      animTime: rng() * 2,
    });
  }
  const events: EventSnap[] = [];
  for (let i = 0; i < 6; i++) {
    events.push({ type: i % 3, a: Math.floor(rng() * 10), b: Math.floor(rng() * 10), x: (rng() - 0.5) * 1000, y: rng() * 40, z: (rng() - 0.5) * 1000, value: Math.round(rng() * 1000) / 10 });
  }
  return { tick, ackInput: tick - 3, zone: { x: 12.5, z: -40.25, radius: 350.5, nextRadius: 180, timer: 42.5 }, players, events };
}

/** Next snapshot: positions/velocities/aim change for moving players, the rest mostly stays the same. */
function evolve(prev: Snapshot): Snapshot {
  // Explicit literal copies keep one hidden class per record type (structuredClone output has different maps,
  // which makes the encoders' property accesses polymorphic).
  const next: Snapshot = { tick: prev.tick, ackInput: prev.ackInput, zone: { ...prev.zone }, players: prev.players.map((p) => ({ ...p })), events: prev.events.map((e) => ({ ...e })) };
  next.tick++;
  next.ackInput++;
  for (const p of next.players) {
    if (rng() < 0.7) {
      p.x += p.vx / 30;
      p.z += p.vz / 30;
      p.yaw += (rng() - 0.5) * 0.1;
      p.pitch += (rng() - 0.5) * 0.02;
      p.animTime += 1 / 30;
    }
    if (rng() < 0.1) p.health = Math.max(0, p.health - 10);
    if (rng() < 0.1) p.magazine = Math.max(0, p.magazine - 1);
  }
  next.events = next.events.slice(0, Math.floor(rng() * 6));
  return next;
}

// ---- Binary float32 ----
const PLAYER_FLOAT_BYTES = 1 + 1 + 4 * 3 + 4 * 3 + 4 + 4 + 1 + 1 + 1 + 1 + 1 + 2 + 1 + 4; // 46
const EVENT_FLOAT_BYTES = 1 + 1 + 1 + 12 + 4;
const HEADER_BYTES = 4 + 4 + 4 * 5 + 1 + 1;

function encodeFloat(s: Snapshot, view: DataView): number {
  let o = 0;
  view.setUint32(o, s.tick, true); o += 4;
  view.setUint32(o, s.ackInput, true); o += 4;
  view.setFloat32(o, s.zone.x, true); o += 4;
  view.setFloat32(o, s.zone.z, true); o += 4;
  view.setFloat32(o, s.zone.radius, true); o += 4;
  view.setFloat32(o, s.zone.nextRadius, true); o += 4;
  view.setFloat32(o, s.zone.timer, true); o += 4;
  view.setUint8(o++, s.players.length);
  view.setUint8(o++, s.events.length);
  for (const p of s.players) {
    view.setUint8(o++, p.id);
    view.setUint8(o++, p.team);
    view.setFloat32(o, p.x, true); o += 4;
    view.setFloat32(o, p.y, true); o += 4;
    view.setFloat32(o, p.z, true); o += 4;
    view.setFloat32(o, p.vx, true); o += 4;
    view.setFloat32(o, p.vy, true); o += 4;
    view.setFloat32(o, p.vz, true); o += 4;
    view.setFloat32(o, p.yaw, true); o += 4;
    view.setFloat32(o, p.pitch, true); o += 4;
    view.setUint8(o++, p.health);
    view.setUint8(o++, p.armor);
    view.setUint8(o++, p.flags);
    view.setUint8(o++, p.weapon);
    view.setUint8(o++, p.magazine);
    view.setUint16(o, p.reserve, true); o += 2;
    view.setUint8(o++, p.anim);
    view.setFloat32(o, p.animTime, true); o += 4;
  }
  for (const e of s.events) {
    view.setUint8(o++, e.type);
    view.setUint8(o++, e.a);
    view.setUint8(o++, e.b);
    view.setFloat32(o, e.x, true); o += 4;
    view.setFloat32(o, e.y, true); o += 4;
    view.setFloat32(o, e.z, true); o += 4;
    view.setFloat32(o, e.value, true); o += 4;
  }
  return o;
}

function decodeFloat(view: DataView): Snapshot {
  let o = 0;
  const tick = view.getUint32(o, true); o += 4;
  const ackInput = view.getUint32(o, true); o += 4;
  const zone = { x: view.getFloat32(o, true), z: view.getFloat32(o + 4, true), radius: view.getFloat32(o + 8, true), nextRadius: view.getFloat32(o + 12, true), timer: view.getFloat32(o + 16, true) };
  o += 20;
  const np = view.getUint8(o++);
  const ne = view.getUint8(o++);
  const players: PlayerSnap[] = [];
  for (let i = 0; i < np; i++) {
    const p: PlayerSnap = {
      id: view.getUint8(o),
      team: view.getUint8(o + 1),
      x: view.getFloat32(o + 2, true),
      y: view.getFloat32(o + 6, true),
      z: view.getFloat32(o + 10, true),
      vx: view.getFloat32(o + 14, true),
      vy: view.getFloat32(o + 18, true),
      vz: view.getFloat32(o + 22, true),
      yaw: view.getFloat32(o + 26, true),
      pitch: view.getFloat32(o + 30, true),
      health: view.getUint8(o + 34),
      armor: view.getUint8(o + 35),
      flags: view.getUint8(o + 36),
      weapon: view.getUint8(o + 37),
      magazine: view.getUint8(o + 38),
      reserve: view.getUint16(o + 39, true),
      anim: view.getUint8(o + 41),
      animTime: view.getFloat32(o + 42, true),
    };
    o += PLAYER_FLOAT_BYTES;
    players.push(p);
  }
  const events: EventSnap[] = [];
  for (let i = 0; i < ne; i++) {
    events.push({ type: view.getUint8(o), a: view.getUint8(o + 1), b: view.getUint8(o + 2), x: view.getFloat32(o + 3, true), y: view.getFloat32(o + 7, true), z: view.getFloat32(o + 11, true), value: view.getFloat32(o + 15, true) });
    o += EVENT_FLOAT_BYTES;
  }
  return { tick, ackInput, zone, players, events };
}

// ---- Binary quantized (+ optional delta) ----
const qPos = (v: number): number => Math.max(0, Math.min(65535, Math.round((v + 512) * 64)));
const dqPos = (q: number): number => q / 64 - 512;
const qY = (v: number): number => Math.max(0, Math.min(65535, Math.round((v + 100) * 128)));
const dqY = (q: number): number => q / 128 - 100;
const qVel = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 100)));
const TAU = Math.PI * 2;
const qAngle = (v: number): number => Math.round((((v % TAU) + TAU) % TAU) * (65535 / TAU)) & 0xffff;
const qPitch = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 10000)));

// Field groups for the delta mask.
const F_POS = 1;
const F_VEL = 2;
const F_AIM = 4;
const F_VITALS = 8;
const F_STATE = 16;
const F_WEAPON = 32;
const F_ANIM = 64;

function playerMask(p: PlayerSnap, b: PlayerSnap | undefined): number {
  if (!b) return 127;
  let m = 0;
  if (qPos(p.x) !== qPos(b.x) || qY(p.y) !== qY(b.y) || qPos(p.z) !== qPos(b.z)) m |= F_POS;
  if (qVel(p.vx) !== qVel(b.vx) || qVel(p.vy) !== qVel(b.vy) || qVel(p.vz) !== qVel(b.vz)) m |= F_VEL;
  if (qAngle(p.yaw) !== qAngle(b.yaw) || qPitch(p.pitch) !== qPitch(b.pitch)) m |= F_AIM;
  if (p.health !== b.health || p.armor !== b.armor) m |= F_VITALS;
  if (p.flags !== b.flags || p.team !== b.team) m |= F_STATE;
  if (p.weapon !== b.weapon || p.magazine !== b.magazine || p.reserve !== b.reserve) m |= F_WEAPON;
  if (p.anim !== b.anim || Math.round(p.animTime * 1000) !== Math.round(b.animTime * 1000)) m |= F_ANIM;
  return m;
}

function encodeQuant(s: Snapshot, view: DataView, baseline: Snapshot | null): number {
  let o = 0;
  view.setUint32(o, s.tick, true); o += 4;
  view.setUint32(o, s.ackInput, true); o += 4;
  view.setUint32(o, baseline ? baseline.tick : 0, true); o += 4;
  view.setUint16(o, qPos(s.zone.x), true); o += 2;
  view.setUint16(o, qPos(s.zone.z), true); o += 2;
  view.setUint16(o, Math.round(s.zone.radius * 10), true); o += 2;
  view.setUint16(o, Math.round(s.zone.nextRadius * 10), true); o += 2;
  view.setUint16(o, Math.round(s.zone.timer * 10), true); o += 2;
  view.setUint8(o++, s.players.length);
  view.setUint8(o++, s.events.length);
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i]!;
    const mask = baseline ? playerMask(p, baseline.players[i]) : 127;
    view.setUint8(o++, p.id);
    view.setUint8(o++, mask);
    if (mask & F_POS) {
      view.setUint16(o, qPos(p.x), true);
      view.setUint16(o + 2, qY(p.y), true);
      view.setUint16(o + 4, qPos(p.z), true);
      o += 6;
    }
    if (mask & F_VEL) {
      view.setInt16(o, qVel(p.vx), true);
      view.setInt16(o + 2, qVel(p.vy), true);
      view.setInt16(o + 4, qVel(p.vz), true);
      o += 6;
    }
    if (mask & F_AIM) {
      view.setUint16(o, qAngle(p.yaw), true);
      view.setInt16(o + 2, qPitch(p.pitch), true);
      o += 4;
    }
    if (mask & F_VITALS) {
      view.setUint8(o++, p.health);
      view.setUint8(o++, p.armor);
    }
    if (mask & F_STATE) {
      view.setUint8(o++, p.flags);
      view.setUint8(o++, p.team);
    }
    if (mask & F_WEAPON) {
      view.setUint8(o++, p.weapon);
      view.setUint8(o++, p.magazine);
      view.setUint16(o, p.reserve, true);
      o += 2;
    }
    if (mask & F_ANIM) {
      view.setUint8(o++, p.anim);
      view.setUint16(o, Math.round(p.animTime * 1000) & 0xffff, true);
      o += 2;
    }
  }
  for (const e of s.events) {
    view.setUint8(o++, e.type);
    view.setUint8(o++, e.a);
    view.setUint8(o++, e.b);
    view.setUint16(o, qPos(e.x), true);
    view.setUint16(o + 2, qY(e.y), true);
    view.setUint16(o + 4, qPos(e.z), true);
    view.setUint16(o + 6, Math.round(e.value * 10), true);
    o += 8;
  }
  return o;
}

function decodeQuant(view: DataView, baseline: Snapshot | null): Snapshot {
  let o = 0;
  const tick = view.getUint32(o, true); o += 4;
  const ackInput = view.getUint32(o, true); o += 4;
  o += 4; // baseline tick
  const zone = { x: dqPos(view.getUint16(o, true)), z: dqPos(view.getUint16(o + 2, true)), radius: view.getUint16(o + 4, true) / 10, nextRadius: view.getUint16(o + 6, true) / 10, timer: view.getUint16(o + 8, true) / 10 };
  o += 10;
  const np = view.getUint8(o++);
  const ne = view.getUint8(o++);
  const players: PlayerSnap[] = [];
  for (let i = 0; i < np; i++) {
    const b = baseline?.players[i];
    const id = view.getUint8(o++);
    const mask = view.getUint8(o++);
    const p: PlayerSnap = b ? { ...b, id } : { id, team: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, health: 0, armor: 0, flags: 0, weapon: 0, magazine: 0, reserve: 0, anim: 0, animTime: 0 };
    if (mask & F_POS) {
      p.x = dqPos(view.getUint16(o, true));
      p.y = dqY(view.getUint16(o + 2, true));
      p.z = dqPos(view.getUint16(o + 4, true));
      o += 6;
    }
    if (mask & F_VEL) {
      p.vx = view.getInt16(o, true) / 100;
      p.vy = view.getInt16(o + 2, true) / 100;
      p.vz = view.getInt16(o + 4, true) / 100;
      o += 6;
    }
    if (mask & F_AIM) {
      p.yaw = (view.getUint16(o, true) * TAU) / 65535;
      p.pitch = view.getInt16(o + 2, true) / 10000;
      o += 4;
    }
    if (mask & F_VITALS) {
      p.health = view.getUint8(o++);
      p.armor = view.getUint8(o++);
    }
    if (mask & F_STATE) {
      p.flags = view.getUint8(o++);
      p.team = view.getUint8(o++);
    }
    if (mask & F_WEAPON) {
      p.weapon = view.getUint8(o++);
      p.magazine = view.getUint8(o++);
      p.reserve = view.getUint16(o, true);
      o += 2;
    }
    if (mask & F_ANIM) {
      p.anim = view.getUint8(o++);
      p.animTime = view.getUint16(o, true) / 1000;
      o += 2;
    }
    players.push(p);
  }
  const events: EventSnap[] = [];
  for (let i = 0; i < ne; i++) {
    events.push({ type: view.getUint8(o), a: view.getUint8(o + 1), b: view.getUint8(o + 2), x: dqPos(view.getUint16(o + 3, true)), y: dqY(view.getUint16(o + 5, true)), z: dqPos(view.getUint16(o + 7, true)), value: view.getUint16(o + 9, true) / 10 });
    o += 11;
  }
  return { tick, ackInput, zone, players, events };
}

// ---- Harness ----
const SNAPSHOTS = 64;
const snaps: Snapshot[] = [makeSnapshot(1000)];
for (let i = 1; i < SNAPSHOTS; i++) snaps.push(evolve(snaps[i - 1]!));
// Delta baselines lag 3 snapshots behind (typical ack delay at 30 Hz send and ~100 ms RTT).
const baselineOf = (i: number): Snapshot => snaps[(i - 3 + SNAPSHOTS) % SNAPSHOTS]!;

const buffer = new ArrayBuffer(2048);
const view = new DataView(buffer);
const encoder = new TextEncoder();

function bench(name: string, fn: (i: number) => number, opsPerBatch = 20_000): { nsPerOp: ReturnType<typeof summarize>; bytes: number } {
  let bytes = 0;
  for (let i = 0; i < opsPerBatch * 3; i++) fn(i);
  const samples: number[] = [];
  let counter = 0;
  for (let b = 0; b < Number(args.batches); b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < opsPerBatch; i++) bytes = fn(counter++) || bytes;
    samples.push(Number(process.hrtime.bigint() - t0) / opsPerBatch);
  }
  const nsPerOp = summarize(samples);
  console.error(`${name}: ${round(nsPerOp.p50, 0)} ns/op (p95 ${round(nsPerOp.p95, 0)})`);
  return { nsPerOp, bytes };
}

// Sizes (mean over the snapshot sequence).
const mean = (f: (i: number) => number): number => round(snaps.reduce((sum, _, i) => sum + f(i), 0) / SNAPSHOTS, 1);
const jsonStrings = snaps.map((s) => JSON.stringify(s));
const floatBytes = snaps.map((s) => new Uint8Array(buffer.slice(0, encodeFloat(s, view))));
const quantBytes = snaps.map((s) => new Uint8Array(buffer.slice(0, encodeQuant(s, view, null))));
const deltaBytes = snaps.map((s, i) => new Uint8Array(buffer.slice(0, encodeQuant(s, view, baselineOf(i)))));

// Round-trip check for the quantized delta path.
{
  const decoded = decodeQuant(new DataView(deltaBytes[10]!.buffer), baselineOf(10));
  const src = snaps[10]!.players[3]!;
  const got = decoded.players[3]!;
  const err = Math.max(Math.abs(src.x - got.x), Math.abs(src.z - got.z), Math.abs(src.y - got.y));
  if (err > 0.02 && playerMask(src, baselineOf(10).players[3]) & F_POS) throw new Error(`delta round-trip position error ${err}`);
  console.error(`delta round-trip max position error: ${round(err, 4)} m`);
}

const results = {
  sizesBytes: {
    json: mean((i) => encoder.encode(jsonStrings[i]!).byteLength),
    binaryFloat: mean((i) => floatBytes[i]!.byteLength),
    binaryQuant: mean((i) => quantBytes[i]!.byteLength),
    binaryDelta: mean((i) => deltaBytes[i]!.byteLength),
  },
  jsonStringify: bench("JSON.stringify", (i) => JSON.stringify(snaps[i % SNAPSHOTS]).length),
  jsonStringifyUtf8: bench("JSON.stringify + TextEncoder", (i) => encoder.encode(JSON.stringify(snaps[i % SNAPSHOTS])).byteLength),
  jsonParse: bench("JSON.parse", (i) => (JSON.parse(jsonStrings[i % SNAPSHOTS]!) as Snapshot).players.length),
  floatEncode: bench("DataView float32 encode", (i) => encodeFloat(snaps[i % SNAPSHOTS]!, view)),
  floatDecode: bench("DataView float32 decode", (i) => decodeFloat(new DataView(floatBytes[i % SNAPSHOTS]!.buffer)).players.length),
  quantEncode: bench("DataView quantized encode", (i) => encodeQuant(snaps[i % SNAPSHOTS]!, view, null)),
  quantDecode: bench("DataView quantized decode", (i) => decodeQuant(new DataView(quantBytes[i % SNAPSHOTS]!.buffer), null).players.length),
  deltaEncode: bench("DataView quantized delta encode", (i) => encodeQuant(snaps[i % SNAPSHOTS]!, view, baselineOf(i % SNAPSHOTS))),
  deltaDecode: bench("DataView quantized delta decode", (i) => decodeQuant(new DataView(deltaBytes[i % SNAPSHOTS]!.buffer), baselineOf(i % SNAPSHOTS)).players.length),
};

const report = {
  benchmark: "serialization",
  date: new Date().toISOString(),
  machine: machineInfo(),
  args,
  snapshotShape: { players: 10, eventsPerSnapshot: "0-6", playerFields: Object.keys(snaps[0]!.players[0]!), headerFloatBytes: HEADER_BYTES },
  results,
  perTick: {
    note: "Per-recipient delta encode ×10 clients, per server send",
    deltaEncodeFor10ClientsMs: round((results.deltaEncode.nsPerOp.p50 * 10) / 1e6, 4),
    jsonEncodeFor10ClientsMs: round((results.jsonStringifyUtf8.nsPerOp.p50 * 10) / 1e6, 4),
    bandwidthPerClientKbps30Hz: {
      json: round((results.sizesBytes.json * 8 * 30) / 1000, 1),
      binaryFloat: round((results.sizesBytes.binaryFloat * 8 * 30) / 1000, 1),
      binaryQuant: round((results.sizesBytes.binaryQuant * 8 * 30) / 1000, 1),
      binaryDelta: round((results.sizesBytes.binaryDelta * 8 * 30) / 1000, 1),
    },
  },
};
if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
