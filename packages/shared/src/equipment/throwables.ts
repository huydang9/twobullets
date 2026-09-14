import type { Vec3 } from "../movement/types";
import type { RaycastFn } from "../weapons/types";
import { THROWABLE_KINDS, throwableDef, type ThrowableKind } from "./items";
import { len3, TIMER_EPSILON } from "./math";

export const THROWABLE_PHYSICS = {
  /** Real gravity: grenades are thrown objects, not arcade bullets. m/s². */
  gravity: 9.81,
  /** Linear air drag, 1/s: about 2 % of the speed lost per second of flight. */
  drag: 0.02,
  /** Contact offset along the hit normal so the next segment starts outside the surface, m (≈ grenade radius). */
  skin: 0.04,
  /** Collision iterations per tick (a corner can take two bounces in one tick). */
  maxIterations: 3,
  /** Surfaces with normal.y above this count as ground for rolling and resting. */
  groundNormalY: 0.7,
  /** Impacts into the ground slower than this don't bounce; the grenade rolls instead. m/s. */
  rollContactSpeed: 1.5,
  /** Rolling resistance on ground, m/s². Also the static friction limit: a grenade can rest on slopes up to ~37°. */
  rollDeceleration: 6,
  /** Below this speed on the ground a grenade comes to rest. m/s. */
  restSpeed: 0.3,
  /** Molotov bottles break on impacts faster than this; slower touches roll. m/s. */
  shatterSpeed: 1,
} as const;

/** ThrowableSet.motion values. */
const FLYING = 0;
const ROLLING = 1;
const RESTING = 2;

// Reused segment endpoints: raycasters read them synchronously and must not keep references.
const segmentFrom = { x: 0, y: 0, z: 0 };
const segmentTo = { x: 0, y: 0, z: 0 };

/**
 * Throwables in flight or on the ground, struct-of-arrays so a server steps dozens per tick without allocating.
 * Vectors use three slots per item (x, y, z). Mutated in place by the functions below; order is spawn order with
 * swap-remove, identical on every machine that applies the same spawns.
 */
export interface ThrowableSet {
  readonly capacity: number;
  count: number;
  readonly id: Int32Array;
  readonly owner: Int32Array;
  /** Index into THROWABLE_KINDS. */
  readonly kind: Uint8Array;
  /** 0 flying, 1 rolling, 2 resting. */
  readonly motion: Uint8Array;
  readonly bounces: Uint16Array;
  readonly position: Float64Array;
  readonly velocity: Float64Array;
  /** Last contact normal (0, 1, 0 before the first contact). */
  readonly normal: Float64Array;
  /** Seconds until detonation. */
  readonly fuse: Float64Array;
  readonly age: Float64Array;
}

export function createThrowableSet(capacity = 64): ThrowableSet {
  return {
    capacity,
    count: 0,
    id: new Int32Array(capacity),
    owner: new Int32Array(capacity),
    kind: new Uint8Array(capacity),
    motion: new Uint8Array(capacity),
    bounces: new Uint16Array(capacity),
    position: new Float64Array(capacity * 3),
    velocity: new Float64Array(capacity * 3),
    normal: new Float64Array(capacity * 3),
    fuse: new Float64Array(capacity),
    age: new Float64Array(capacity),
  };
}

export interface ThrowableSpawn {
  /** Deterministic id: owner slot << 16 | throw counter (see throwId). */
  readonly id: number;
  readonly owner: number;
  readonly kind: ThrowableKind;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly fuse: number;
}

/** Appends a throwable; returns its index, or -1 when the set is full. */
export function spawnThrowable(set: ThrowableSet, spawn: ThrowableSpawn): number {
  if (set.count >= set.capacity) return -1;
  const i = set.count++;
  const i3 = i * 3;
  set.id[i] = spawn.id;
  set.owner[i] = spawn.owner;
  set.kind[i] = THROWABLE_KINDS.indexOf(spawn.kind);
  set.motion[i] = FLYING;
  set.bounces[i] = 0;
  set.position[i3] = spawn.position.x;
  set.position[i3 + 1] = spawn.position.y;
  set.position[i3 + 2] = spawn.position.z;
  set.velocity[i3] = spawn.velocity.x;
  set.velocity[i3 + 1] = spawn.velocity.y;
  set.velocity[i3 + 2] = spawn.velocity.z;
  set.normal[i3] = 0;
  set.normal[i3 + 1] = 1;
  set.normal[i3 + 2] = 0;
  set.fuse[i] = spawn.fuse;
  set.age[i] = 0;
  return i;
}

export function removeThrowableAt(set: ThrowableSet, index: number): void {
  const last = set.count - 1;
  if (index < 0 || index > last) return;
  if (index !== last) {
    set.id[index] = set.id[last]!;
    set.owner[index] = set.owner[last]!;
    set.kind[index] = set.kind[last]!;
    set.motion[index] = set.motion[last]!;
    set.bounces[index] = set.bounces[last]!;
    set.fuse[index] = set.fuse[last]!;
    set.age[index] = set.age[last]!;
    set.position.copyWithin(index * 3, last * 3, last * 3 + 3);
    set.velocity.copyWithin(index * 3, last * 3, last * 3 + 3);
    set.normal.copyWithin(index * 3, last * 3, last * 3 + 3);
  }
  set.count = last;
}

export type ThrowableSimEvent =
  | { readonly type: "bounce"; readonly id: number; readonly kind: ThrowableKind; readonly position: Vec3; readonly normal: Vec3; readonly impactSpeed: number }
  | { readonly type: "rest"; readonly id: number; readonly kind: ThrowableKind; readonly position: Vec3 }
  | {
      readonly type: "detonate";
      readonly id: number;
      readonly owner: number;
      readonly kind: ThrowableKind;
      readonly position: Vec3;
      /** Contact normal at detonation; up when it went off in the air. */
      readonly normal: Vec3;
      readonly reason: "fuse" | "impact";
    };

/**
 * Advances every throwable by dt. Flying items integrate gravity and drag, then cast up to three segments per tick
 * against the injected world raycast: a hit moves the item to the contact point (plus skin), reflects the normal
 * velocity by the kind's restitution and removes `friction` of the tangential velocity. Slow ground contacts switch to
 * rolling: gravity projected on the ground, a constant rolling deceleration, and rest once slow on ground flat enough
 * for friction to hold it. Molotovs detonate on impact. Fuses count down in every state. Detonated items are
 * removed from the set; events are appended to `events` in item order.
 */
export function stepThrowables(set: ThrowableSet, dt: number, raycast: RaycastFn, events: ThrowableSimEvent[]): void {
  let i = 0;
  while (i < set.count) {
    let detonation: "fuse" | "impact" | null = null;
    if (set.motion[i] === ROLLING) {
      const rolled = rollItem(set, i, dt, raycast, events);
      if (rolled === "impact") detonation = "impact";
      else if (rolled === "airborne") set.motion[i] = FLYING;
    }
    if (set.motion[i] === FLYING && flyItem(set, i, dt, raycast, events)) detonation = "impact";

    set.age[i] = set.age[i]! + dt;
    set.fuse[i] = set.fuse[i]! - dt;
    if (detonation === null && set.fuse[i]! <= TIMER_EPSILON) detonation = "fuse";

    if (detonation !== null) {
      const i3 = i * 3;
      events.push({
        type: "detonate",
        id: set.id[i]!,
        owner: set.owner[i]!,
        kind: kindAt(set, i),
        position: { x: set.position[i3]!, y: set.position[i3 + 1]!, z: set.position[i3 + 2]! },
        normal: { x: set.normal[i3]!, y: set.normal[i3 + 1]!, z: set.normal[i3 + 2]! },
        reason: detonation,
      });
      removeThrowableAt(set, i);
      continue;
    }
    i++;
  }
}

function kindAt(set: ThrowableSet, i: number): ThrowableKind {
  return THROWABLE_KINDS[set.kind[i]!]!;
}

function castSegment(raycast: RaycastFn, px: number, py: number, pz: number, ex: number, ey: number, ez: number) {
  segmentFrom.x = px;
  segmentFrom.y = py;
  segmentFrom.z = pz;
  segmentTo.x = ex;
  segmentTo.y = ey;
  segmentTo.z = ez;
  return raycast(segmentFrom, segmentTo);
}

/** One flying tick. Returns true when a molotov shattered. */
function flyItem(set: ThrowableSet, i: number, dt: number, raycast: RaycastFn, events: ThrowableSimEvent[]): boolean {
  const P = THROWABLE_PHYSICS;
  const i3 = i * 3;
  const kind = kindAt(set, i);
  const def = throwableDef(kind);
  const damping = 1 - P.drag * dt;
  let vx = set.velocity[i3]! * damping;
  let vy = (set.velocity[i3 + 1]! - P.gravity * dt) * damping;
  let vz = set.velocity[i3 + 2]! * damping;
  let px = set.position[i3]!;
  let py = set.position[i3 + 1]!;
  let pz = set.position[i3 + 2]!;
  let remaining = dt;
  let shattered = false;

  for (let iter = 0; iter < P.maxIterations && remaining > 1e-9; iter++) {
    const ex = px + vx * remaining;
    const ey = py + vy * remaining;
    const ez = pz + vz * remaining;
    const hit = castSegment(raycast, px, py, pz, ex, ey, ez);
    if (!hit) {
      px = ex;
      py = ey;
      pz = ez;
      break;
    }
    const { x: nx, y: ny, z: nz } = hit.normal;
    const vn = vx * nx + vy * ny + vz * nz;
    px = hit.point.x + nx * P.skin;
    py = hit.point.y + ny * P.skin;
    pz = hit.point.z + nz * P.skin;
    remaining *= 1 - hit.fraction;
    setNormal(set, i3, nx, ny, nz);
    if (vn >= 0) continue;

    const impactSpeed = -vn;
    if (def.detonateOnImpact && impactSpeed > P.shatterSpeed) {
      shattered = true;
      break;
    }
    const tx = vx - vn * nx;
    const ty = vy - vn * ny;
    const tz = vz - vn * nz;
    if (ny > P.groundNormalY && impactSpeed < P.rollContactSpeed) {
      vx = tx;
      vy = ty;
      vz = tz;
      set.motion[i] = ROLLING;
      break;
    }
    const keep = 1 - def.friction;
    vx = tx * keep - vn * def.restitution * nx;
    vy = ty * keep - vn * def.restitution * ny;
    vz = tz * keep - vn * def.restitution * nz;
    set.bounces[i] = set.bounces[i]! + 1;
    events.push({ type: "bounce", id: set.id[i]!, kind, position: { x: px, y: py, z: pz }, normal: { x: nx, y: ny, z: nz }, impactSpeed });
  }

  setVectors(set, i3, px, py, pz, vx, vy, vz);
  return shattered;
}

/** One rolling tick. "airborne" = the ground fell away (fly this tick instead). */
function rollItem(set: ThrowableSet, i: number, dt: number, raycast: RaycastFn, events: ThrowableSimEvent[]): "rolled" | "airborne" | "impact" {
  const P = THROWABLE_PHYSICS;
  const i3 = i * 3;
  const kind = kindAt(set, i);
  let px = set.position[i3]!;
  let py = set.position[i3 + 1]!;
  let pz = set.position[i3 + 2]!;
  let nx = set.normal[i3]!;
  let ny = set.normal[i3 + 1]!;
  let nz = set.normal[i3 + 2]!;

  // Stay glued to the ground: probe back along the last ground normal.
  const reach = P.skin * 2 + 0.05;
  const ground = castSegment(raycast, px, py, pz, px - nx * reach, py - ny * reach, pz - nz * reach);
  if (!ground || ground.normal.y <= P.groundNormalY) return "airborne";
  ({ x: nx, y: ny, z: nz } = ground.normal);
  px = ground.point.x + nx * P.skin;
  py = ground.point.y + ny * P.skin;
  pz = ground.point.z + nz * P.skin;

  // Gravity along the surface, velocity kept in the surface plane, then rolling resistance.
  const g = P.gravity;
  const gx = g * ny * nx;
  const gy = -g + g * ny * ny;
  const gz = g * ny * nz;
  let vx = set.velocity[i3]!;
  let vy = set.velocity[i3 + 1]!;
  let vz = set.velocity[i3 + 2]!;
  const vn = vx * nx + vy * ny + vz * nz;
  vx += gx * dt - vn * nx;
  vy += gy * dt - vn * ny;
  vz += gz * dt - vn * nz;
  const speed = len3(vx, vy, vz);
  const slow = P.rollDeceleration * dt;
  const scale = speed > slow ? (speed - slow) / speed : 0;
  vx *= scale;
  vy *= scale;
  vz *= scale;

  if (speed - slow < P.restSpeed && len3(gx, gy, gz) < P.rollDeceleration) {
    setVectors(set, i3, px, py, pz, 0, 0, 0);
    setNormal(set, i3, nx, ny, nz);
    set.motion[i] = RESTING;
    events.push({ type: "rest", id: set.id[i]!, kind, position: { x: px, y: py, z: pz } });
    return "rolled";
  }

  const hit = castSegment(raycast, px, py, pz, px + vx * dt, py + vy * dt, pz + vz * dt);
  if (!hit) {
    px += vx * dt;
    py += vy * dt;
    pz += vz * dt;
  } else {
    const n = hit.normal;
    px = hit.point.x + n.x * P.skin;
    py = hit.point.y + n.y * P.skin;
    pz = hit.point.z + n.z * P.skin;
    if (n.y > P.groundNormalY) {
      // Rolled onto a steeper piece of ground; keep rolling on it.
      const into = vx * n.x + vy * n.y + vz * n.z;
      if (into < 0) {
        vx -= into * n.x;
        vy -= into * n.y;
        vz -= into * n.z;
      }
    } else {
      const def = throwableDef(kind);
      const into = vx * n.x + vy * n.y + vz * n.z;
      if (into < 0) {
        if (def.detonateOnImpact && -into > P.shatterSpeed) {
          setVectors(set, i3, px, py, pz, vx, vy, vz);
          setNormal(set, i3, n.x, n.y, n.z);
          return "impact";
        }
        const keep = 1 - def.friction;
        vx = (vx - into * n.x) * keep - into * def.restitution * n.x;
        vy = (vy - into * n.y) * keep - into * def.restitution * n.y;
        vz = (vz - into * n.z) * keep - into * def.restitution * n.z;
        set.bounces[i] = set.bounces[i]! + 1;
        events.push({ type: "bounce", id: set.id[i]!, kind, position: { x: px, y: py, z: pz }, normal: { x: n.x, y: n.y, z: n.z }, impactSpeed: -into });
      }
      set.motion[i] = FLYING;
      setVectors(set, i3, px, py, pz, vx, vy, vz);
      setNormal(set, i3, n.x, n.y, n.z);
      return "rolled";
    }
    nx = n.x;
    ny = n.y;
    nz = n.z;
  }
  setVectors(set, i3, px, py, pz, vx, vy, vz);
  setNormal(set, i3, nx, ny, nz);
  return "rolled";
}

function setVectors(set: ThrowableSet, i3: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number): void {
  set.position[i3] = px;
  set.position[i3 + 1] = py;
  set.position[i3 + 2] = pz;
  set.velocity[i3] = vx;
  set.velocity[i3 + 1] = vy;
  set.velocity[i3 + 2] = vz;
}

function setNormal(set: ThrowableSet, i3: number, nx: number, ny: number, nz: number): void {
  set.normal[i3] = nx;
  set.normal[i3 + 1] = ny;
  set.normal[i3 + 2] = nz;
}

/** Plain-object view of one throwable, for presentation and tests. */
export interface ThrowableSnapshot {
  readonly id: number;
  readonly owner: number;
  readonly kind: ThrowableKind;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly resting: boolean;
  readonly rolling: boolean;
  readonly fuse: number;
  readonly bounces: number;
}

export function snapshotThrowables(set: ThrowableSet): ThrowableSnapshot[] {
  const out: ThrowableSnapshot[] = [];
  for (let i = 0; i < set.count; i++) {
    const i3 = i * 3;
    out.push({
      id: set.id[i]!,
      owner: set.owner[i]!,
      kind: THROWABLE_KINDS[set.kind[i]!]!,
      position: { x: set.position[i3]!, y: set.position[i3 + 1]!, z: set.position[i3 + 2]! },
      velocity: { x: set.velocity[i3]!, y: set.velocity[i3 + 1]!, z: set.velocity[i3 + 2]! },
      resting: set.motion[i] === RESTING,
      rolling: set.motion[i] === ROLLING,
      fuse: set.fuse[i]!,
      bounces: set.bounces[i]!,
    });
  }
  return out;
}

export interface ThrowArcOptions {
  /** Simulation step, s. Use the tick length so the arc matches the real flight. */
  readonly dt?: number;
  /** Record a point every this many steps. */
  readonly sampleEvery?: number;
  /** Stop at the first bounce (PUBG-style arc) instead of following the whole flight. */
  readonly stopAtFirstContact?: boolean;
  /** Longest simulated flight, s. */
  readonly maxSeconds?: number;
}

export interface ThrowArcResult {
  /** Points written to `out` (xyz triples). The first is the launch position, the last the end point. */
  readonly count: number;
  readonly end: Vec3;
  readonly endNormal: Vec3;
  readonly reason: "contact" | "rest" | "detonate" | "limit";
}

let arcScratch: ThrowableSet | null = null;

/**
 * Predicts a throw with the exact stepThrowables math, for the client's trajectory line. Writes up to
 * out.length / 3 points; `out` is reused by the caller between frames.
 */
export function predictThrowArc(spawn: Omit<ThrowableSpawn, "id" | "owner">, raycast: RaycastFn, out: Float32Array, options: ThrowArcOptions = {}): ThrowArcResult {
  const dt = options.dt ?? 1 / 60;
  const sampleEvery = Math.max(1, options.sampleEvery ?? 2);
  const stopAtFirstContact = options.stopAtFirstContact ?? true;
  const maxSteps = Math.ceil((options.maxSeconds ?? 6) / dt);
  const maxPoints = Math.floor(out.length / 3);
  const set = (arcScratch ??= createThrowableSet(1));
  set.count = 0;
  spawnThrowable(set, { ...spawn, id: 0, owner: -1 });

  let count = 0;
  const write = (p: Vec3): void => {
    const slot = Math.min(count, maxPoints - 1);
    if (slot < 0) return;
    out[slot * 3] = p.x;
    out[slot * 3 + 1] = p.y;
    out[slot * 3 + 2] = p.z;
    count = slot + 1;
  };
  write(spawn.position);

  const events: ThrowableSimEvent[] = [];
  let end: Vec3 = spawn.position;
  let endNormal: Vec3 = { x: 0, y: 1, z: 0 };
  let reason: ThrowArcResult["reason"] = "limit";

  for (let step = 1; step <= maxSteps && reason === "limit"; step++) {
    events.length = 0;
    stepThrowables(set, dt, raycast, events);
    for (const event of events) {
      if (event.type === "detonate") {
        [end, endNormal, reason] = [event.position, event.normal, "detonate"];
      } else if (event.type === "bounce" && stopAtFirstContact) {
        [end, endNormal, reason] = [event.position, event.normal, "contact"];
      } else if (event.type === "rest") {
        [end, reason] = [event.position, stopAtFirstContact ? "contact" : "rest"];
      }
      if (reason !== "limit") break;
    }
    if (reason === "limit") {
      end = { x: set.position[0]!, y: set.position[1]!, z: set.position[2]! };
      if (step % sampleEvery === 0 && count < maxPoints - 1) write(end);
    }
  }
  write(end);
  set.count = 0;
  return { count, end, endNormal, reason };
}

/**
 * Deterministic throwable id: the owner's slot in the high bits and their throw counter in the low 16 bits,
 * so client prediction and the server name the same grenade.
 */
export function throwId(ownerSlot: number, throwCounter: number): number {
  return ((ownerSlot & 0x7fff) << 16) | (throwCounter & 0xffff);
}

/**
 * Pulls a hand position back to the eye side of any wall between them, so a throw made facing a wall can't start
 * inside or behind it.
 */
export function resolveThrowOrigin(eye: Vec3, hand: Vec3, raycast: RaycastFn): Vec3 {
  const hit = raycast(eye, hand);
  if (!hit) return hand;
  const dx = hand.x - eye.x;
  const dy = hand.y - eye.y;
  const dz = hand.z - eye.z;
  const length = len3(dx, dy, dz);
  if (length <= 0) return eye;
  const back = Math.max(0, hit.fraction * length - THROWABLE_PHYSICS.skin * 2) / length;
  return { x: eye.x + dx * back, y: eye.y + dy * back, z: eye.z + dz * back };
}
