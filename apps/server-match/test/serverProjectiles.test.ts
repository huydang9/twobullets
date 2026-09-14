import { clampViewDelayTicks, LagCompHistory, MAX_REWIND_TICKS } from "@twobullets/netcode";
import type { HitPose } from "@twobullets/shared/hitreg/rig";
import type { Vec3 } from "@twobullets/shared/movement/types";
import type { AimedShot, HitZone, RayHit, RaycastFn, WeaponId } from "@twobullets/shared/weapons/types";
import { describe, expect, it } from "vitest";
import { ServerProjectiles, type ProjectileHitSink } from "../src/hitreg/ServerProjectiles";
import { ViewDelayEstimator } from "../src/hitreg/ViewDelay";

// Deterministic server projectiles against scripted pose histories and an analytic world (architecture.md §7.4 test
// strategy): rewind at the shooter's D, the MAX_REWIND edge, walls, no self-hits, present-time death.

const DT = 1 / 60;
const SHOOTER = 0;
const TARGET = 3;

/** Static world: an infinite wall slab x ∈ [wallX, wallX + 0.5] for z ≥ wallMinZ (null = no wall). */
function worldWithWall(wallX: number | null, wallMinZ = -Infinity): RaycastFn {
  return (from: Vec3, to: Vec3): RayHit | null => {
    if (wallX === null) return null;
    const dx = to.x - from.x;
    if (Math.abs(dx) < 1e-12) return null;
    const t = (wallX - from.x) / dx;
    if (t < 0 || t > 1) return null;
    const z = from.z + (to.z - from.z) * t;
    if (z < wallMinZ) return null;
    return { point: { x: wallX, y: from.y + (to.y - from.y) * t, z }, normal: { x: -Math.sign(dx), y: 0, z: 0 }, fraction: t, colliderId: null };
  };
}

function shotAt(origin: Vec3, target: Vec3, weaponId: WeaponId = "rifle", shotId = 1): AimedShot {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return {
    weaponId,
    shotId,
    origin,
    directions: [{ x: dx / len, y: dy / len, z: dz / len }],
    recoilUp: 0,
    recoilRight: 0,
    yaw: Math.atan2(dx, dz),
    pitch: -Math.asin(dy / len),
    spreadDegrees: 0,
  };
}

interface Hit {
  shooter: number;
  victim: number;
  zone: HitZone;
  distance: number;
}

function sink(): ProjectileHitSink & { hits: Hit[]; world: number } {
  const s = {
    hits: [] as Hit[],
    world: 0,
    playerHit(shooter: number, _shotId: number, _w: WeaponId, victim: number, zone: HitZone, distance: number) {
      s.hits.push({ shooter, victim, zone, distance });
    },
    worldHit() {
      s.world++;
    },
  };
  return s;
}

const pose = (x: number, z: number, yaw = Math.PI): HitPose => ({ x, y: 0, z, yaw, pitch: 0, stanceBlend: 0 });

/** Records `slot` for ticks [from, to] at the pose `at(tick)`; with `teleports`, a change of position is a teleport. */
function record(h: LagCompHistory, slot: number, from: number, to: number, at: (tick: number) => HitPose, teleports = true): void {
  let prev: HitPose | null = null;
  for (let t = from; t <= to; t++) {
    const p = at(t);
    h.record(t, slot, p, !teleports || prev === null || (prev.x === p.x && prev.z === p.z));
    prev = p;
  }
}

describe("ServerProjectiles", () => {
  const eye = { x: 0, y: 1.1, z: 0 };
  const open = { x: 0, y: 1.1, z: 8 };
  const hittable = new Uint8Array(16);

  function setup(wallX: number | null = null) {
    const history = new LagCompHistory();
    const projectiles = new ServerProjectiles(history, worldWithWall(wallX, 3));
    hittable.fill(0);
    hittable[SHOOTER] = 1;
    hittable[TARGET] = 1;
    return { history, projectiles };
  }

  it("hits a stationary target through the rewound pose, zone and distance from the rig", () => {
    const { history, projectiles } = setup();
    const present = 1000;
    record(history, TARGET, present - 20, present, () => pose(0, 8));
    record(history, SHOOTER, present - 20, present, () => pose(0, 0, 0));
    const s = sink();
    projectiles.spawn(shotAt(eye, open), SHOOTER, 6.5);
    projectiles.step(present, DT, hittable, s);
    expect(s.hits).toHaveLength(1);
    expect(s.hits[0]).toMatchObject({ shooter: SHOOTER, victim: TARGET, zone: "body" });
    expect(s.hits[0]!.distance).toBeGreaterThan(7.5);
    expect(s.hits[0]!.distance).toBeLessThan(8);
    expect(projectiles.count).toBe(0);
  });

  it("MAX_REWIND edge: the shooter's view at exactly MAX_REWIND hits, one tick beyond misses", () => {
    // The target stood in the open until `moved`, then teleported 3 m east behind a wall.
    const run = (present: number, claimedD: number): number => {
      const { history, projectiles } = setup(1.5);
      const moved = 2000;
      record(history, TARGET, present - 30, present, (t) => (t <= moved ? pose(0, 8) : pose(3, 8)));
      const s = sink();
      // Server expectation far above the claim so only MAX_REWIND limits it.
      const d = clampViewDelayTicks(claimedD, 30);
      projectiles.spawn(shotAt(eye, open), SHOOTER, d);
      for (let k = 0; k < 3 && projectiles.count > 0; k++) projectiles.step(present + k, DT, hittable, s);
      return s.hits.length;
    };
    expect(run(2000 + MAX_REWIND_TICKS, MAX_REWIND_TICKS)).toBe(1);
    expect(run(2000 + MAX_REWIND_TICKS + 1, MAX_REWIND_TICKS)).toBe(0);
    // Claiming more than MAX_REWIND gains nothing.
    expect(run(2000 + MAX_REWIND_TICKS + 1, MAX_REWIND_TICKS + 5)).toBe(0);
  });

  it("a target that moved behind a wall: rewound hits only within the shooter's delay, aiming at the new spot hits the wall", () => {
    const { history, projectiles } = setup(1.5);
    const moved = 3000;
    record(history, TARGET, moved - 20, moved + 20, (t) => (t <= moved ? pose(0, 8) : pose(3, 8)));
    const s = sink();
    // Fired 4 ticks after the move with D = 6: the shooter still saw the target in the open.
    projectiles.spawn(shotAt(eye, open, "rifle", 1), SHOOTER, 6);
    projectiles.step(moved + 4, DT, hittable, s);
    expect(s.hits.map((h) => h.victim)).toEqual([TARGET]);
    // Fired 8 ticks after with the same D: the rewound pose is behind the wall already, the bullet flies on.
    projectiles.spawn(shotAt(eye, open, "rifle", 2), SHOOTER, 6);
    projectiles.step(moved + 8, DT, hittable, s);
    expect(s.hits).toHaveLength(1);
    expect(projectiles.count).toBe(1);
    // Aimed at where the target is now: the wall stops it.
    projectiles.clear();
    projectiles.spawn(shotAt(eye, { x: 3, y: 1.1, z: 8 }, "rifle", 3), SHOOTER, 0);
    projectiles.step(moved + 9, DT, hittable, s);
    expect(s.hits).toHaveLength(1);
    expect(s.world).toBe(1);
  });

  it("interpolates fractional D between ticks for a crossing target", () => {
    const { history, projectiles } = setup();
    const present = 4000;
    // Walks east 0.25 m per tick; at tick present − 8 it is at x = 0.
    record(history, TARGET, present - 20, present, (t) => ({ x: (t - (present - 8)) * 0.25, y: 0, z: 8, yaw: Math.PI, pitch: 0, stanceBlend: 0 }), false);
    const hitsWith = (d: number): number => {
      const s = sink();
      projectiles.spawn(shotAt(eye, open), SHOOTER, d);
      projectiles.step(present, DT, hittable, s);
      projectiles.clear();
      return s.hits.length;
    };
    expect(hitsWith(8)).toBe(1);
    expect(hitsWith(7.5)).toBe(1);
    expect(hitsWith(0)).toBe(0);
    expect(hitsWith(2)).toBe(0);
  });

  it("never hits the shooter, skips players dead at present time, and flies on", () => {
    const { history, projectiles } = setup();
    const present = 5000;
    // Shooter's own rig straddles the muzzle.
    record(history, SHOOTER, present - 20, present, () => pose(0, 0.2, 0));
    record(history, TARGET, present - 20, present, () => pose(0, 8));
    hittable[TARGET] = 0;
    const s = sink();
    projectiles.spawn(shotAt(eye, open), SHOOTER, 3);
    projectiles.step(present, DT, hittable, s);
    expect(s.hits).toEqual([]);
    expect(projectiles.count).toBe(1);
    hittable[TARGET] = 1;
  });

  it("shotgun pellets keep the shooter's D and each reports its own hit", () => {
    const { history, projectiles } = setup();
    const present = 6000;
    record(history, TARGET, present - 20, present, () => pose(0, 3));
    const s = sink();
    const base = shotAt(eye, { x: 0, y: 1.2, z: 3 }, "shotgun", 9);
    const dirs = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const len = Math.sqrt(1 + 0.0009);
      dirs.push({ x: (Math.cos(a) * 0.03) / len, y: (Math.sin(a) * 0.03 - 0.03) / len, z: 1 / len });
    }
    projectiles.spawn({ ...base, directions: dirs }, SHOOTER, 4);
    expect(projectiles.count).toBe(8);
    projectiles.step(present, DT, hittable, s);
    expect(s.hits.length).toBe(8);
    expect(new Set(s.hits.map((h) => h.victim))).toEqual(new Set([TARGET]));
  });
});

describe("ViewDelayEstimator", () => {
  it("expects lead + RTT + interpolation, and clamps claims beyond ±2 ticks (backtrack) or MAX_REWIND", () => {
    const e = new ViewDelayEstimator(60);
    // 60 ms RTT, 50 ms interpolation, inputs arriving 2 ticks early.
    for (let i = 0; i < 200; i++) e.onInputPacket(1000 + i, 998 + i, 50, 900 + i, 10_000 + i * 16.67 - 60, 10_000 + i * 16.67);
    expect(e.rttMs).toBeCloseTo(60, 3);
    expect(e.expectedTicks).toBeCloseTo(2 + 3.6 + 3, 3);
    const honest = e.validate(Math.round(8.6 * 8));
    expect(honest).toBeCloseTo(8.625, 9);
    expect(e.stats.clamps).toBe(0);
    expect(e.validate(255)).toBeCloseTo(10.6, 3);
    expect(e.validate(0)).toBeCloseTo(6.6, 3);
    expect(e.stats.clamps).toBe(2);
    // Interp delay claims are clamped to [25, 150] ms; stale acks give no RTT sample.
    e.onInputPacket(2000, 1998, 510, 100, 0, 20_000);
    expect(e.interpDelayMs).toBe(150);
    expect(e.validate(255)).toBe(MAX_REWIND_TICKS);
  });
});
