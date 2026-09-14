import { describe, expect, it } from "vitest";
import type { Vec3 } from "../movement/types";
import { computeDamage, spawnProjectiles, stepProjectiles } from "./ballistics";
import type { FiredShot, Projectile, RaycastFn, WeaponId } from "./types";
import { BALLISTICS, WEAPONS } from "./weapons";

const DT = 1 / 60;
const noHit: RaycastFn = () => null;
const round1 = (value: number): number => Math.round(value * 10) / 10;

function fire(weaponId: WeaponId, directions: Vec3[], origin: Vec3 = { x: 0, y: 0, z: 0 }): Projectile[] {
  let id = 0;
  const shot: FiredShot = { weaponId, shotId: 7, origin, directions, recoilUp: 0, recoilRight: 0 };
  return spawnProjectiles(shot, () => ++id);
}

/** Fake Havok: an axis-aligned slab of world geometry at z ∈ [zMin, zMax]. */
function wall(zMin: number, zMax: number): RaycastFn {
  return (from, to) => {
    const dz = to.z - from.z;
    if (dz === 0) return null;
    const enterZ = dz > 0 ? zMin : zMax;
    const exitZ = dz > 0 ? zMax : zMin;
    const tEnter = (enterZ - from.z) / dz;
    const tExit = (exitZ - from.z) / dz;
    // Start inside the slab counts as an immediate hit.
    const fraction = tEnter < 0 && tExit >= 0 ? 0 : tEnter;
    if (fraction < 0 || fraction > 1) return null;
    const point = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z + dz * fraction };
    return { point, normal: { x: 0, y: 0, z: dz > 0 ? -1 : 1 }, fraction, colliderId: null };
  };
}

describe("spawnProjectiles", () => {
  it("creates one projectile per direction at muzzle velocity", () => {
    const dirs = [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }];
    const [a, b] = fire("rifle", dirs, { x: 1, y: 2, z: 3 });
    const v = WEAPONS.rifle.muzzleVelocity;
    expect(a).toEqual({ id: 1, shotId: 7, weaponId: "rifle", position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: v }, distance: 0, age: 0 });
    expect(b!.id).toBe(2);
    expect(b!.velocity).toEqual({ x: v, y: 0, z: 0 });
  });
});

describe("stepProjectiles", () => {
  it("hits a wall and reports the travelled distance", () => {
    let projectiles = fire("pistol", [{ x: 0, y: 0, z: 1 }]);
    const raycast = wall(25, 26);
    for (let i = 0; i < 60 && projectiles.length > 0; i++) {
      const result = stepProjectiles(projectiles, DT, raycast);
      if (result.impacts.length > 0) {
        const impact = result.impacts[0]!;
        expect(impact.hit.point.z).toBeCloseTo(25);
        expect(impact.distance).toBeCloseTo(25, 1);
        expect(impact.projectile.distance).toBe(impact.distance);
        expect(result.alive).toHaveLength(0);
        return;
      }
      projectiles = [...result.alive];
    }
    throw new Error("projectile never hit the wall");
  });

  it("never tunnels through a 1 cm wall at 60 Hz", () => {
    for (const weaponId of ["rifle", "sniper", "pistol", "shotgun"] as const) {
      for (let k = 0; k < 50; k++) {
        const zMin = 5 + k * 0.37;
        let projectiles = fire(weaponId, [{ x: 0, y: 0, z: 1 }]);
        let hit = false;
        for (let i = 0; i < 30 && projectiles.length > 0 && !hit; i++) {
          const result = stepProjectiles(projectiles, DT, wall(zMin, zMin + 0.01));
          hit = result.impacts.length > 0;
          for (const p of result.alive) expect(p.position.z).toBeLessThan(zMin);
          projectiles = [...result.alive];
        }
        expect(hit, `${weaponId} vs wall at ${zMin}`).toBe(true);
      }
    }
  });

  it("drops like ½gt² over distance", () => {
    const def = WEAPONS.sniper;
    const g = BALLISTICS.gravity * def.gravityScale;
    const dropAt = (meters: number): number => {
      let projectiles = fire("sniper", [{ x: 0, y: 0, z: 1 }]);
      for (let i = 1; i < 600; i++) {
        projectiles = [...stepProjectiles(projectiles, DT, noHit).alive];
        const p = projectiles[0]!;
        if (p.position.z >= meters) {
          const t = i * DT;
          // Semi-implicit Euler overshoots the analytic drop by ½g·t·dt.
          expect(Math.abs(-p.position.y - 0.5 * g * t * t)).toBeLessThanOrEqual(0.5 * g * t * DT + 1e-9);
          return -p.position.y;
        }
      }
      throw new Error("never reached distance");
    };
    const at100 = dropAt(100);
    const at300 = dropAt(300);
    expect(at100).toBeGreaterThan(0.3);
    expect(at100).toBeLessThan(0.6);
    expect(at300).toBeGreaterThan(2.5);
  });

  it("expires at max range and lifetime", () => {
    // Shotgun: 60 m range at 350 m/s → expires on the 11th tick (5.83 m/tick).
    let projectiles = fire("shotgun", [{ x: 0, y: 0, z: 1 }]);
    let ticks = 0;
    let expired: readonly Projectile[] = [];
    while (projectiles.length > 0) {
      const result = stepProjectiles(projectiles, DT, noHit);
      projectiles = [...result.alive];
      expired = result.expired;
      ticks++;
    }
    expect(ticks).toBe(Math.ceil(WEAPONS.shotgun.maxRangeMeters / (WEAPONS.shotgun.muzzleVelocity * DT)));
    expect(expired[0]!.distance).toBeCloseTo(WEAPONS.shotgun.maxRangeMeters);

    const old: Projectile = { ...fire("sniper", [{ x: 0, y: 1, z: 0 }])[0]!, age: BALLISTICS.maxLifetimeSeconds - DT / 2 };
    const result = stepProjectiles([old], DT, noHit);
    expect(result.alive).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
  });

  it("does not hit geometry beyond max range", () => {
    const def = WEAPONS.shotgun;
    const near: Projectile = { ...fire("shotgun", [{ x: 0, y: 0, z: 1 }])[0]!, distance: def.maxRangeMeters - 1 };
    const result = stepProjectiles([near], DT, wall(2, 3));
    expect(result.impacts).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
  });
});

describe("computeDamage", () => {
  it("applies zone multipliers and linear falloff", () => {
    const def = WEAPONS.rifle;
    const { startMeters, endMeters, minMultiplier } = def.falloff;
    expect(computeDamage(def, "body", 0)).toBe(def.damage);
    expect(computeDamage(def, "head", startMeters)).toBe(def.damage * def.zoneMultipliers.head);
    expect(computeDamage(def, "limb", 10)).toBe(round1(def.damage * def.zoneMultipliers.limb));
    const mid = (startMeters + endMeters) / 2;
    expect(computeDamage(def, "body", mid)).toBe(round1((def.damage * (1 + minMultiplier)) / 2));
    expect(computeDamage(def, "body", endMeters)).toBe(round1(def.damage * minMultiplier));
    expect(computeDamage(def, "body", endMeters * 10)).toBe(round1(def.damage * minMultiplier));
    const shotgun = WEAPONS.shotgun;
    const quarter = shotgun.falloff.startMeters + (shotgun.falloff.endMeters - shotgun.falloff.startMeters) / 4;
    expect(computeDamage(shotgun, "head", quarter)).toBe(
      round1(shotgun.damage * shotgun.zoneMultipliers.head * (1 - (1 - shotgun.falloff.minMultiplier) / 4)),
    );
  });

  it("meets the design kill thresholds against 100 HP", () => {
    const shotsToKill = (id: WeaponId, zone: "head" | "body", distance: number) => Math.ceil(100 / computeDamage(WEAPONS[id], zone, distance));
    expect(shotsToKill("rifle", "body", 10)).toBe(5);
    expect(shotsToKill("pistol", "body", 10)).toBe(5);
    expect(shotsToKill("pistol", "body", 60)).toBeLessThanOrEqual(9);
    expect(shotsToKill("sniper", "head", 10_000)).toBe(1);
    expect(computeDamage(WEAPONS.sniper, "body", 100)).toBeGreaterThanOrEqual(75);
    // Point-blank shotgun: 6 of 8 pellets kill; at 20 m even all 8 don't.
    expect(6 * computeDamage(WEAPONS.shotgun, "body", 2)).toBeGreaterThanOrEqual(100);
    expect(8 * computeDamage(WEAPONS.shotgun, "body", 20)).toBeLessThan(100);
  });
});
