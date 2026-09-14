// Lag compensation cost benchmark for docs/backend/netcode.md §5.
//
// Server-side projectile hit registration against REWOUND procedural capsule hitboxes:
//   - per-player pose history ring (feet xyz, yaw, pitch, stance) at 60 Hz, 32 frames (533 ms)
//   - each projectile carries its shooter's rewind D (ticks, fractional); every tick its swept segment is tested
//     against each other player's bounding capsule sampled at (now - D), and on overlap against 11 posed capsules
//   - pose evaluation is cached per (player, rewind) per tick, since all bullets of one shooter share D
// Excludes the Havok world raycast each segment also needs (static world, no rewind) — see Runtime benchmarks.
//
// Usage: node tools/bench/netcode/lagcomp.mjs [--projectiles=150] [--seconds=10]
// Node built-ins only. Self-terminates after 120 s.

setTimeout(() => {
  console.error("bench timed out");
  process.exit(2);
}, 120_000).unref();

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const PROJECTILES = Number(args.projectiles ?? 150);
const SECONDS = Number(args.seconds ?? 10);
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const PLAYERS = 10;
const FRAMES = 32;
const FRAME_STRIDE = 6; // x y z yaw pitch crouch
const MAX_REWIND_TICKS = 12; // 200 ms

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(42);

// ---------------------------------------------------------------------------------------------------------------
// Procedural hitbox rig: capsules in the player's local frame (feet origin, facing +Z). zone 0 head, 1 body, 2 limb.
// [ax, ay, az, bx, by, bz, radius, zone, pitchPivot(0 none, 1 shoulders)]
const RIG = [
  [0, 1.6, 0.03, 0, 1.6, 0.03, 0.13, 0, 0],
  [0, 1.18, 0, 0, 1.42, 0, 0.2, 1, 0],
  [0, 0.9, 0, 0, 1.08, 0, 0.18, 1, 0],
  [-0.2, 1.42, 0, -0.16, 1.22, 0.2, 0.065, 2, 1],
  [0.2, 1.42, 0, 0.16, 1.22, 0.2, 0.065, 2, 1],
  [-0.16, 1.22, 0.2, -0.04, 1.35, 0.45, 0.05, 2, 1],
  [0.16, 1.22, 0.2, 0.04, 1.35, 0.45, 0.05, 2, 1],
  [-0.1, 0.88, 0, -0.11, 0.48, 0.03, 0.085, 2, 0],
  [0.1, 0.88, 0, 0.11, 0.48, 0.03, 0.085, 2, 0],
  [-0.11, 0.48, 0.03, -0.11, 0.08, 0, 0.065, 2, 0],
  [0.11, 0.48, 0.03, 0.11, 0.08, 0, 0.065, 2, 0],
];
const CAPS = RIG.length;
const BOUND_A = 0.25;
const BOUND_B = 1.55;
const BOUND_R = 0.62;

const history = new Float32Array(PLAYERS * FRAMES * FRAME_STRIDE);
let head = 0; // frame index of "now"

function writeFrame(player, frame, x, y, z, yaw, pitch, crouch) {
  const o = (player * FRAMES + frame) * FRAME_STRIDE;
  history[o] = x;
  history[o + 1] = y;
  history[o + 2] = z;
  history[o + 3] = yaw;
  history[o + 4] = pitch;
  history[o + 5] = crouch;
}

const sample = new Float64Array(FRAME_STRIDE);
/** Interpolated pose `rewind` ticks (fractional) before now. */
function samplePose(player, rewind) {
  const whole = Math.floor(rewind);
  const frac = rewind - whole;
  const f0 = (head - whole + FRAMES) % FRAMES; // newer
  const f1 = (f0 - 1 + FRAMES) % FRAMES; // older
  const o0 = (player * FRAMES + f0) * FRAME_STRIDE;
  const o1 = (player * FRAMES + f1) * FRAME_STRIDE;
  for (let i = 0; i < FRAME_STRIDE; i++) {
    let a = history[o0 + i];
    let b = history[o1 + i];
    if (i === 3) {
      // shortest-path yaw
      let d = b - a;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      b = a + d;
    }
    sample[i] = a + (b - a) * frac;
  }
  return sample;
}

/** World-space capsules for a pose into out[k*7]. */
function poseCapsules(pose, out) {
  const [x, y, z, yaw, pitch, crouch] = pose;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const squash = 1 - 0.38 * crouch;
  for (let k = 0; k < CAPS; k++) {
    const r = RIG[k];
    for (let e = 0; e < 2; e++) {
      let lx = r[e * 3];
      let ly = r[e * 3 + 1];
      let lz = r[e * 3 + 2];
      if (r[8] === 1) {
        // Arms follow aim pitch around the shoulder line (+pitch = look down).
        const py = ly - 1.42;
        const nly = py * cp - lz * sp;
        const nlz = py * sp + lz * cp;
        ly = nly + 1.42;
        lz = nlz;
      }
      ly *= squash;
      out[k * 7 + e * 3] = x + lx * c + lz * s;
      out[k * 7 + e * 3 + 1] = y + ly;
      out[k * 7 + e * 3 + 2] = z - lx * s + lz * c;
    }
    out[k * 7 + 6] = r[6];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry

/** Squared distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segSegDistSq(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  const c = d1x * rx + d1y * ry + d1z * rz;
  const b = d1x * d2x + d1y * d2y + d1z * d2z;
  const denom = a * e - b * b;
  s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
  t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = Math.min(1, Math.max(0, -c / a));
  } else if (t > 1) {
    t = 1;
    s = Math.min(1, Math.max(0, (b - c) / a));
  }
  const dx = p1x + d1x * s - (p2x + d2x * t);
  const dy = p1y + d1y * s - (p2y + d2y * t);
  const dz = p1z + d1z * s - (p2z + d2z * t);
  return dx * dx + dy * dy + dz * dz;
}

/** Ray (unit rd) vs capsule; distance along the ray or -1 (after Inigo Quilez, capIntersect). */
function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  if (baba > 1e-9 && a > 1e-9) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return -1;
    const t = (-b - Math.sqrt(h)) / a;
    const yy = baoa + t * bard;
    if (yy > 0 && yy < baba) return t;
    // fall through to caps
    const cx = yy <= 0 ? oax : ox - bx;
    const cy = yy <= 0 ? oay : oy - by;
    const cz = yy <= 0 ? oaz : oz - bz;
    return raySphereLocal(cx, cy, cz, dx, dy, dz, r);
  }
  // sphere, or ray parallel to the axis: test both caps
  const t0 = raySphereLocal(oax, oay, oaz, dx, dy, dz, r);
  const t1 = raySphereLocal(ox - bx, oy - by, oz - bz, dx, dy, dz, r);
  if (t0 < 0) return t1;
  if (t1 < 0) return t0;
  return Math.min(t0, t1);
}
function raySphereLocal(ocx, ocy, ocz, dx, dy, dz, r) {
  const b = dx * ocx + dy * ocy + dz * ocz;
  const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  return -b - Math.sqrt(h);
}

// ---------------------------------------------------------------------------------------------------------------
// World state: players strafing in an 80 m arena so bullets actually pass near them.

const players = Array.from({ length: PLAYERS }, (_, i) => ({
  x: 460 + R() * 80,
  y: 30,
  z: 460 + R() * 80,
  vx: 0,
  vz: 0,
  yaw: R() * 6.28,
  pitch: 0,
  crouch: 0,
  rewind: 2 + R() * (MAX_REWIND_TICKS - 2), // shooter's view delay in ticks
}));

function stepPlayers(tick) {
  head = (head + 1) % FRAMES;
  players.forEach((p, i) => {
    if (tick % 30 === i) {
      const a = R() * 6.28;
      p.vx = Math.sin(a) * 6.5;
      p.vz = Math.cos(a) * 6.5;
      p.crouch = R() < 0.2 ? 1 : 0;
    }
    p.x += p.vx * DT;
    p.z += p.vz * DT;
    p.yaw += (R() - 0.5) * 0.05;
    p.pitch = Math.max(-1.2, Math.min(1.2, p.pitch + (R() - 0.5) * 0.02));
    writeFrame(i, head, p.x, p.y, p.z, p.yaw, p.pitch, p.crouch);
  });
}

function spawnProjectile(pr) {
  const shooter = Math.floor(R() * PLAYERS);
  let target = Math.floor(R() * PLAYERS);
  if (target === shooter) target = (target + 1) % PLAYERS;
  const t = players[target];
  const dist = 30 + R() * 250;
  const ang = R() * 6.28;
  pr.x = t.x + Math.sin(ang) * dist;
  pr.y = 31.5;
  pr.z = t.z + Math.cos(ang) * dist;
  const tx = t.x + (R() - 0.5) * 3;
  const ty = 30 + 0.5 + R() * 1.4;
  const tz = t.z + (R() - 0.5) * 3;
  const len = Math.hypot(tx - pr.x, ty - pr.y, tz - pr.z);
  pr.vx = ((tx - pr.x) / len) * 620;
  pr.vy = ((ty - pr.y) / len) * 620;
  pr.vz = ((tz - pr.z) / len) * 620;
  pr.traveled = 0;
  pr.shooter = shooter;
}

const projectiles = Array.from({ length: PROJECTILES }, () => {
  const p = {};
  spawnProjectile(p);
  return p;
});

// ---------------------------------------------------------------------------------------------------------------
// Run

const capsCache = new Float64Array(PLAYERS * PLAYERS * CAPS * 7); // per (shooter, target): shooters share rewind
const cacheTick = new Int32Array(PLAYERS * PLAYERS).fill(-1);

let broadTests = 0;
let broadHits = 0;
let poseEvals = 0;
let capsuleTests = 0;
let hits = 0;
let steps = 0;

// Warm up history.
for (let t = 0; t < FRAMES; t++) stepPlayers(t);

const TICKS = SECONDS * TICK_RATE;
const t0 = process.hrtime.bigint();
for (let tick = FRAMES; tick < FRAMES + TICKS; tick++) {
  stepPlayers(tick);
  for (const pr of projectiles) {
    steps++;
    const vy = pr.vy - 9.81 * DT;
    const ex = pr.x + pr.vx * DT;
    const ey = pr.y + vy * DT;
    const ez = pr.z + pr.vz * DT;
    const segLen = Math.hypot(ex - pr.x, ey - pr.y, ez - pr.z);
    const dx = (ex - pr.x) / segLen;
    const dy = (ey - pr.y) / segLen;
    const dz = (ez - pr.z) / segLen;
    const rewind = players[pr.shooter].rewind;
    let best = segLen;
    let hitPlayer = -1;

    for (let target = 0; target < PLAYERS; target++) {
      if (target === pr.shooter) continue;
      broadTests++;
      const pose = samplePose(target, rewind);
      const crouchScale = 1 - 0.38 * pose[5];
      const d2 = segSegDistSq(pr.x, pr.y, pr.z, ex, ey, ez, pose[0], pose[1] + BOUND_A, pose[2], pose[0], pose[1] + BOUND_B * crouchScale, pose[2]);
      if (d2 > BOUND_R * BOUND_R) continue;
      broadHits++;
      const key = pr.shooter * PLAYERS + target;
      const base = key * CAPS * 7;
      if (cacheTick[key] !== tick) {
        poseCapsules(pose, capsCache.subarray(base, base + CAPS * 7));
        cacheTick[key] = tick;
        poseEvals++;
      }
      for (let k = 0; k < CAPS; k++) {
        const o = base + k * 7;
        capsuleTests++;
        const t = rayCapsule(pr.x, pr.y, pr.z, dx, dy, dz, capsCache[o], capsCache[o + 1], capsCache[o + 2], capsCache[o + 3], capsCache[o + 4], capsCache[o + 5], capsCache[o + 6]);
        if (t >= 0 && t < best) {
          best = t;
          hitPlayer = target;
        }
      }
    }

    if (hitPlayer >= 0) {
      hits++;
      spawnProjectile(pr);
      continue;
    }
    pr.x = ex;
    pr.y = ey;
    pr.z = ez;
    pr.vy = vy;
    pr.traveled += segLen;
    if (pr.traveled > 500) spawnProjectile(pr);
  }
}
const elapsedNs = Number(process.hrtime.bigint() - t0);

const perStepNs = elapsedNs / steps;
const tickMs = elapsedNs / TICKS / 1e6;
console.log(`projectiles in flight=${PROJECTILES} players=${PLAYERS} ticks=${TICKS} history=${FRAMES} frames (${((FRAMES / TICK_RATE) * 1000).toFixed(0)} ms), ${history.byteLength} B`);
console.log(`segment steps: ${steps}, per projectile-step ${perStepNs.toFixed(0)} ns (all targets, incl. rewind sampling)`);
console.log(`per server tick: ${tickMs.toFixed(3)} ms for ${PROJECTILES} projectiles (budget at 60 Hz = 16.7 ms)`);
console.log(`broadphase tests ${broadTests}, overlaps ${broadHits} (${((broadHits / broadTests) * 100).toFixed(1)}%), pose evals ${poseEvals}, capsule tests ${capsuleTests}, hits ${hits}`);
console.log(`hits/s ${(hits / SECONDS).toFixed(0)}  (bullets are aimed at players, so this is a hot-path-heavy case)`);
console.log(`heap used ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)} MB`);
