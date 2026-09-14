/**
 * Pure gameplay code cost (no physics engine): what the authoritative server pays per tick for 10 players.
 *  1. computeDesiredVelocity ×10
 *  2. stepWeapon ×10 (auto rifle, trigger held → shots, bloom, reloads)
 *  3. spawnProjectiles + stepProjectiles for 50 projectiles with a no-hit raycast (pure math + allocation)
 *  4. The same projectile integration written SoA/allocation-free (Float64Array), to price the immutable style
 *  5. Synthetic 69-bone skeleton sampling (2 clips blended, local→world 4×4) ×10 players — server-side hitbox posing
 *  6. Analytic lag-compensation hit test: 50 rays × 10 players × 20 capsules with a per-player AABB reject
 *  7. Hitbox history ring buffer write (10×20×7 floats per tick)
 *  8. Micro: Math.hypot vs Math.sqrt
 *
 *   node tools/bench/runtime/shared-code.ts [--batches=40] [--out=file.json]
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, GcTracker, machineInfo, parseArgs, round, summarize, createRng } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ batches: 40, out: "" });

const { computeDesiredVelocity, createMoveState } = await import("../../../packages/shared/src/movement/movement.ts");
const { createWeaponState, stepWeapon } = await import("../../../packages/shared/src/weapons/weaponStep.ts");
const { spawnProjectiles, stepProjectiles } = await import("../../../packages/shared/src/weapons/ballistics.ts");
const { DEFAULT_LOADOUT, WEAPONS, BALLISTICS } = await import("../../../packages/shared/src/weapons/weapons.ts");
type MoveState = import("../../../packages/shared/src/movement/types.ts").MoveState;
type MoveInput = import("../../../packages/shared/src/movement/types.ts").MoveInput;
type WeaponState = import("../../../packages/shared/src/weapons/types.ts").WeaponState;
type Projectile = import("../../../packages/shared/src/weapons/types.ts").Projectile;

const DT = 1 / 60;
const PLAYERS = 10;
const rng = createRng(42);

interface CaseResult {
  /** Nanoseconds per call of the unit named in `unit`. */
  nsPerOp: ReturnType<typeof summarize>;
  unit: string;
  opsPerTick: number;
  /** ms per server tick (nsPerOp.p50 × opsPerTick). */
  msPerTickP50: number;
  bytesPerOp: number | null;
  gc: Awaited<ReturnType<InstanceType<typeof GcTracker>["stop"]>>;
}

/** Runs `fn(i)` in timed batches after a warmup; also estimates heap bytes allocated per op from GC-free batches. */
async function measure(name: string, unit: string, opsPerTick: number, fn: (i: number) => void, opsPerBatch: number): Promise<CaseResult> {
  for (let i = 0; i < opsPerBatch * 5; i++) fn(i);
  const samples: number[] = [];
  const allocations: number[] = [];
  const gc = new GcTracker();
  gc.start();
  let counter = 0;
  for (let b = 0; b < Number(args.batches); b++) {
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < opsPerBatch; i++) fn(counter++);
    const t1 = process.hrtime.bigint();
    const heapAfter = process.memoryUsage().heapUsed;
    samples.push(Number(t1 - t0) / opsPerBatch);
    if (heapAfter > heapBefore) allocations.push((heapAfter - heapBefore) / opsPerBatch);
    await new Promise((r) => setImmediate(r));
  }
  const gcReport = await gc.stop();
  const nsPerOp = summarize(samples);
  allocations.sort((a, b) => a - b);
  const result: CaseResult = {
    unit,
    opsPerTick,
    nsPerOp,
    msPerTickP50: round((nsPerOp.p50 * opsPerTick) / 1e6, 5),
    bytesPerOp: allocations.length > 0 ? round(allocations[Math.floor(allocations.length / 2)]!, 1) : null,
    gc: gcReport,
  };
  console.error(`${name}: ${round(nsPerOp.p50, 1)} ns/${unit} (p95 ${round(nsPerOp.p95, 1)}), ${result.msPerTickP50} ms/tick, ~${result.bytesPerOp} B/op`);
  return result;
}

const results: Record<string, CaseResult> = {};

// 1. Movement.
{
  const inputs: MoveInput[] = Array.from({ length: 256 }, () => ({
    forward: [1, 1, 0, -1][Math.floor(rng() * 4)]!,
    right: [-1, 0, 1][Math.floor(rng() * 3)]!,
    jump: rng() < 0.05,
    sprint: rng() < 0.5,
    crouch: rng() < 0.1,
    speedScale: rng() < 0.3 ? 0.6 : 1,
    yaw: rng() * 6.28,
    pitch: 0,
  }));
  const envs = [
    { supported: true, groundNormal: { x: 0, y: 1, z: 0 }, canStand: true },
    { supported: true, groundNormal: { x: 0.2, y: 0.97, z: 0.1 }, canStand: true },
    { supported: false, groundNormal: { x: 0, y: 1, z: 0 }, canStand: true },
  ];
  const states: MoveState[] = Array.from({ length: PLAYERS }, () => createMoveState());
  results.computeDesiredVelocity = await measure(
    "computeDesiredVelocity",
    "player",
    PLAYERS,
    (i) => {
      const p = i % PLAYERS;
      states[p] = computeDesiredVelocity(states[p]!, inputs[i & 255]!, envs[i % 3]!, DT);
    },
    100_000,
  );
}

// 2. Weapons.
{
  const states: WeaponState[] = Array.from({ length: PLAYERS }, () => createWeaponState(DEFAULT_LOADOUT));
  const inputs = [
    { fire: true, aim: true, reload: false, selectIndex: null },
    { fire: true, aim: false, reload: false, selectIndex: null },
    { fire: false, aim: false, reload: false, selectIndex: null },
    { fire: false, aim: false, reload: true, selectIndex: null },
  ];
  const ctx = { eye: { x: 0, y: 1.65, z: 0 }, yaw: 0.3, pitch: -0.05, horizontalSpeed: 4, grounded: true, sprinting: false };
  let shots = 0;
  results.stepWeapon = await measure(
    "stepWeapon",
    "player",
    PLAYERS,
    (i) => {
      const p = i % PLAYERS;
      const r = stepWeapon(states[p]!, inputs[(i >> 6) & 3]!, ctx, DT);
      states[p] = r.state;
      shots += r.shots.length;
    },
    100_000,
  );
  console.error(`  (shots fired during stepWeapon bench: ${shots})`);
}

// 3. Projectiles, immutable style (shared code).
{
  const COUNT = 50;
  let nextId = 1;
  const allocId = (): number => nextId++;
  const fresh = (): Projectile[] => {
    const list: Projectile[] = [];
    for (let k = 0; k < COUNT; k++) {
      const a = rng() * 6.28;
      list.push(...spawnProjectiles({ weaponId: "rifle", shotId: k, origin: { x: 0, y: 1.6, z: 0 }, directions: [{ x: Math.sin(a), y: 0.01, z: Math.cos(a) }], recoilUp: 0, recoilRight: 0 }, allocId));
    }
    return list;
  };
  let list: readonly Projectile[] = fresh();
  const noHit = (): null => null;
  results.stepProjectiles50 = await measure(
    "stepProjectiles(50)",
    "tick",
    1,
    () => {
      const r = stepProjectiles(list, DT, noHit);
      list = r.alive.length < COUNT ? fresh() : r.alive;
    },
    2_000,
  );
}

// 4. Projectiles, SoA / allocation-free equivalent (same semi-implicit Euler, max range, lifetime).
{
  const COUNT = 50;
  const px = new Float64Array(COUNT);
  const py = new Float64Array(COUNT);
  const pz = new Float64Array(COUNT);
  const vx = new Float64Array(COUNT);
  const vy = new Float64Array(COUNT);
  const vz = new Float64Array(COUNT);
  const dist = new Float64Array(COUNT);
  const age = new Float64Array(COUNT);
  const def = WEAPONS.rifle;
  const reset = (k: number): void => {
    const a = rng() * 6.28;
    px[k] = 0;
    py[k] = 1.6;
    pz[k] = 0;
    vx[k] = Math.sin(a) * def.muzzleVelocity;
    vy[k] = 0.01 * def.muzzleVelocity;
    vz[k] = Math.cos(a) * def.muzzleVelocity;
    dist[k] = 0;
    age[k] = 0;
  };
  for (let k = 0; k < COUNT; k++) reset(k);
  const g = BALLISTICS.gravity * def.gravityScale;
  results.stepProjectiles50SoA = await measure(
    "stepProjectiles(50) SoA",
    "tick",
    1,
    () => {
      for (let k = 0; k < COUNT; k++) {
        const nvy = vy[k]! - g * DT;
        let dx = vx[k]! * DT;
        let dy = nvy * DT;
        let dz = vz[k]! * DT;
        let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const remaining = Math.max(0, def.maxRangeMeters - dist[k]!);
        const clip = len >= remaining;
        if (clip && len > 0) {
          const s = remaining / len;
          dx *= s;
          dy *= s;
          dz *= s;
          len = remaining;
        }
        vy[k] = nvy;
        px[k] = px[k]! + dx;
        py[k] = py[k]! + dy;
        pz[k] = pz[k]! + dz;
        dist[k] = dist[k]! + len;
        age[k] = age[k]! + DT;
        if (clip || age[k]! >= BALLISTICS.maxLifetimeSeconds) reset(k);
      }
    },
    20_000,
  );
}

// 5. Skeleton sampling: 69 bones, 2 clips × 30 fps keys, blended, composed to world matrices.
{
  const BONES = 69;
  const KEYS = 32;
  const parent = Int16Array.from({ length: BONES }, (_, b) => (b === 0 ? -1 : Math.floor((b - 1) / 2)));
  const makeClip = (): { t: Float32Array; r: Float32Array } => {
    const t = new Float32Array(BONES * KEYS * 3);
    const r = new Float32Array(BONES * KEYS * 4);
    for (let i = 0; i < t.length; i++) t[i] = (rng() - 0.5) * 0.3;
    for (let b = 0; b < BONES * KEYS; b++) {
      let x = rng() - 0.5;
      let y = rng() - 0.5;
      let z = rng() - 0.5;
      let w = 2;
      const l = Math.hypot(x, y, z, w);
      r[b * 4] = x / l;
      r[b * 4 + 1] = y / l;
      r[b * 4 + 2] = z / l;
      r[b * 4 + 3] = w / l;
      x = y = z = w = 0;
    }
    return { t, r };
  };
  const clips = [makeClip(), makeClip()];
  const local = new Float32Array(BONES * 7);
  const world = new Float32Array(BONES * 16);
  const sample = (time: number, blend: number): void => {
    const f = (time * 30) % (KEYS - 1);
    const k0 = Math.floor(f);
    const a = f - k0;
    for (let b = 0; b < BONES; b++) {
      let tx = 0;
      let ty = 0;
      let tz = 0;
      let qx = 0;
      let qy = 0;
      let qz = 0;
      let qw = 0;
      for (let c = 0; c < 2; c++) {
        const clip = clips[c]!;
        const wgt = c === 0 ? 1 - blend : blend;
        const i0 = (b * KEYS + k0) * 3;
        const i1 = i0 + 3;
        tx += wgt * (clip.t[i0]! + (clip.t[i1]! - clip.t[i0]!) * a);
        ty += wgt * (clip.t[i0 + 1]! + (clip.t[i1 + 1]! - clip.t[i0 + 1]!) * a);
        tz += wgt * (clip.t[i0 + 2]! + (clip.t[i1 + 2]! - clip.t[i0 + 2]!) * a);
        const j0 = (b * KEYS + k0) * 4;
        const j1 = j0 + 4;
        qx += wgt * (clip.r[j0]! + (clip.r[j1]! - clip.r[j0]!) * a);
        qy += wgt * (clip.r[j0 + 1]! + (clip.r[j1 + 1]! - clip.r[j0 + 1]!) * a);
        qz += wgt * (clip.r[j0 + 2]! + (clip.r[j1 + 2]! - clip.r[j0 + 2]!) * a);
        qw += wgt * (clip.r[j0 + 3]! + (clip.r[j1 + 3]! - clip.r[j0 + 3]!) * a);
      }
      const l = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
      qx /= l;
      qy /= l;
      qz /= l;
      qw /= l;
      // Local matrix (column-major, rotation + translation).
      const o = b * 16;
      const m = world;
      const x2 = qx + qx;
      const y2 = qy + qy;
      const z2 = qz + qz;
      const l00 = 1 - (qy * y2 + qz * z2);
      const l01 = qx * y2 + qw * z2;
      const l02 = qx * z2 - qw * y2;
      const l10 = qx * y2 - qw * z2;
      const l11 = 1 - (qx * x2 + qz * z2);
      const l12 = qy * z2 + qw * x2;
      const l20 = qx * z2 + qw * y2;
      const l21 = qy * z2 - qw * x2;
      const l22 = 1 - (qx * x2 + qy * y2);
      const p = parent[b]!;
      if (p < 0) {
        m[o] = l00; m[o + 1] = l01; m[o + 2] = l02; m[o + 3] = 0;
        m[o + 4] = l10; m[o + 5] = l11; m[o + 6] = l12; m[o + 7] = 0;
        m[o + 8] = l20; m[o + 9] = l21; m[o + 10] = l22; m[o + 11] = 0;
        m[o + 12] = tx; m[o + 13] = ty; m[o + 14] = tz; m[o + 15] = 1;
      } else {
        const q = p * 16;
        for (let col = 0; col < 3; col++) {
          const c0 = col === 0 ? l00 : col === 1 ? l10 : l20;
          const c1 = col === 0 ? l01 : col === 1 ? l11 : l21;
          const c2 = col === 0 ? l02 : col === 1 ? l12 : l22;
          m[o + col * 4] = m[q]! * c0 + m[q + 4]! * c1 + m[q + 8]! * c2;
          m[o + col * 4 + 1] = m[q + 1]! * c0 + m[q + 5]! * c1 + m[q + 9]! * c2;
          m[o + col * 4 + 2] = m[q + 2]! * c0 + m[q + 6]! * c1 + m[q + 10]! * c2;
          m[o + col * 4 + 3] = 0;
        }
        m[o + 12] = m[q]! * tx + m[q + 4]! * ty + m[q + 8]! * tz + m[q + 12]!;
        m[o + 13] = m[q + 1]! * tx + m[q + 5]! * ty + m[q + 9]! * tz + m[q + 13]!;
        m[o + 14] = m[q + 2]! * tx + m[q + 6]! * ty + m[q + 10]! * tz + m[q + 14]!;
        m[o + 15] = 1;
      }
      local[b * 7] = tx;
    }
  };
  results.skeleton69 = await measure("skeleton 69 bones (2-clip blend)", "player", PLAYERS, (i) => sample(i * DT, 0.3), 5_000);
}

// 6. Analytic lag-comp hit test: rays vs per-player AABB, then vs 20 capsules (segment–segment distance).
{
  const HB = 20;
  const cap = new Float64Array(PLAYERS * HB * 7); // ax, ay, az, bx, by, bz, r
  const aabb = new Float64Array(PLAYERS * 6);
  for (let p = 0; p < PLAYERS; p++) {
    const cx = (rng() - 0.5) * 60;
    const cz = (rng() - 0.5) * 60;
    for (let h = 0; h < HB; h++) {
      const o = (p * HB + h) * 7;
      const y = 0.1 + (h / HB) * 1.6;
      cap[o] = cx + (rng() - 0.5) * 0.4;
      cap[o + 1] = y;
      cap[o + 2] = cz + (rng() - 0.5) * 0.3;
      cap[o + 3] = cap[o]! + 0.05;
      cap[o + 4] = y + 0.15;
      cap[o + 5] = cap[o + 2]!;
      cap[o + 6] = 0.08;
    }
    aabb.set([cx - 0.6, 0, cz - 0.6, cx + 0.6, 1.9, cz + 0.6], p * 6);
  }
  const rays = new Float64Array(50 * 6);
  for (let k = 0; k < 50; k++) {
    const a = rng() * 6.28;
    rays.set([(rng() - 0.5) * 60, 1.2, (rng() - 0.5) * 60, Math.sin(a) * 10, (rng() - 0.5) * 0.2, Math.cos(a) * 10], k * 6);
  }
  const segSegDistSq = (o: number, sx: number, sy: number, sz: number, dx: number, dy: number, dz: number): number => {
    const ax = cap[o]!;
    const ay = cap[o + 1]!;
    const az = cap[o + 2]!;
    const ex = cap[o + 3]! - ax;
    const ey = cap[o + 4]! - ay;
    const ez = cap[o + 5]! - az;
    const rx = sx - ax;
    const ry = sy - ay;
    const rz = sz - az;
    const a = dx * dx + dy * dy + dz * dz;
    const e = ex * ex + ey * ey + ez * ez;
    const f = ex * rx + ey * ry + ez * rz;
    const c = dx * rx + dy * ry + dz * rz;
    const b = dx * ex + dy * ey + dz * ez;
    const denom = a * e - b * b;
    let s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
    let t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else if (t > 1) {
      t = 1;
      s = Math.min(1, Math.max(0, (b - c) / a));
    }
    const qx = sx + dx * s - (ax + ex * t);
    const qy = sy + dy * s - (ay + ey * t);
    const qz = sz + dz * s - (az + ez * t);
    return qx * qx + qy * qy + qz * qz;
  };
  let hits = 0;
  results.lagCompRaysVsCapsules = await measure(
    "analytic rays(50) × players(10) × capsules(20)",
    "tick",
    1,
    () => {
      for (let k = 0; k < 50; k++) {
        const o = k * 6;
        const sx = rays[o]!;
        const sy = rays[o + 1]!;
        const sz = rays[o + 2]!;
        const dx = rays[o + 3]!;
        const dy = rays[o + 4]!;
        const dz = rays[o + 5]!;
        for (let p = 0; p < PLAYERS; p++) {
          // Slab test against the player's AABB; only survivors test capsules. Worst case: test all capsules anyway.
          const q = p * 6;
          let tmin = 0;
          let tmax = 1;
          let skip = false;
          for (let axis = 0; axis < 3 && !skip; axis++) {
            const s0 = axis === 0 ? sx : axis === 1 ? sy : sz;
            const d0 = axis === 0 ? dx : axis === 1 ? dy : dz;
            if (Math.abs(d0) < 1e-9) {
              if (s0 < aabb[q + axis]! || s0 > aabb[q + 3 + axis]!) skip = true;
            } else {
              let t1 = (aabb[q + axis]! - s0) / d0;
              let t2 = (aabb[q + 3 + axis]! - s0) / d0;
              if (t1 > t2) {
                const swap = t1;
                t1 = t2;
                t2 = swap;
              }
              tmin = Math.max(tmin, t1);
              tmax = Math.min(tmax, t2);
              if (tmin > tmax) skip = true;
            }
          }
          // Price the narrow phase as if every player survived the AABB test (worst case).
          for (let h = 0; h < HB; h++) {
            const c = (p * HB + h) * 7;
            if (segSegDistSq(c, sx, sy, sz, dx, dy, dz) <= cap[c + 6]! * cap[c + 6]! && !skip) hits++;
          }
        }
      }
    },
    2_000,
  );
}

// 8. Micro: Math.hypot vs Math.sqrt (the shared code uses Math.hypot in every hot path). Each op = 1,000 calls in a
//    local loop, so closure/context overhead of the harness doesn't dominate.
{
  const xs = Float64Array.from({ length: 1024 }, () => rng() * 10);
  const sink = new Float64Array(1);
  results.mathHypot3x1000 = await measure("1000 × Math.hypot(x, y, z)", "1000 calls", 0, (i) => {
    let acc = 0;
    for (let k = 0; k < 1000; k++) acc += Math.hypot(xs[(i + k) & 1023]!, xs[(i + k + 1) & 1023]!, xs[(i + k + 2) & 1023]!);
    sink[0] = acc;
  }, 2_000);
  results.mathSqrt3x1000 = await measure("1000 × Math.sqrt(x*x + y*y + z*z)", "1000 calls", 0, (i) => {
    let acc = 0;
    for (let k = 0; k < 1000; k++) {
      const x = xs[(i + k) & 1023]!;
      const y = xs[(i + k + 1) & 1023]!;
      const z = xs[(i + k + 2) & 1023]!;
      acc += Math.sqrt(x * x + y * y + z * z);
    }
    sink[0] = acc;
  }, 2_000);
  results.mathHypot2x1000 = await measure("1000 × Math.hypot(x, z)", "1000 calls", 0, (i) => {
    let acc = 0;
    for (let k = 0; k < 1000; k++) acc += Math.hypot(xs[(i + k) & 1023]!, xs[(i + k + 1) & 1023]!);
    sink[0] = acc;
  }, 2_000);
}

// 7. Hitbox history ring buffer (lag compensation): 1 s of 10 × 20 × (pos + quat) at 60 Hz.
{
  const HISTORY = 60;
  const STRIDE = PLAYERS * 20 * 7;
  const ring = new Float32Array(HISTORY * STRIDE);
  const current = new Float32Array(STRIDE).map(() => rng());
  let head = 0;
  results.historyRingWrite = await measure(
    "hitbox history ring write",
    "tick",
    1,
    () => {
      ring.set(current, head * STRIDE);
      head = (head + 1) % HISTORY;
    },
    50_000,
  );
  console.error(`  history ring: ${ring.byteLength} bytes for ${HISTORY} ticks`);
}

const report = { benchmark: "shared-code", date: new Date().toISOString(), machine: machineInfo(), args, results };
if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
