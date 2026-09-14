import { spawnProjectiles, stepProjectiles } from "@twobullets/shared/weapons/ballistics";
import type { FiredShot, Projectile } from "@twobullets/shared/weapons/types";
import { describe, expect, it } from "vitest";
import { ProjectilePool } from "../../src/match/projectiles";

describe("ProjectilePool", () => {
  it("flies bit-identically to shared stepProjectiles until max range", () => {
    const shot: FiredShot = {
      weaponId: "pistol",
      shotId: 7,
      origin: { x: 1.5, y: 1.65, z: -3 },
      directions: [
        { x: 0.1, y: 0.05, z: Math.sqrt(1 - 0.01 - 0.0025) },
        { x: -0.2, y: 0.1, z: Math.sqrt(1 - 0.04 - 0.01) },
      ],
      recoilUp: 0,
      recoilRight: 0,
    };
    let id = 0;
    let reference: readonly Projectile[] = spawnProjectiles(shot, () => id++);
    const pool = new ProjectilePool(1);
    pool.spawnShot(shot, 3);
    expect(pool.count).toBe(2);
    const seg = new Float64Array(7);
    const dt = 1 / 60;
    for (let step = 0; step < 400 && pool.count > 0; step++) {
      const result = stepProjectiles(reference, dt, () => null);
      for (let i = pool.count - 1; i >= 0; i--) {
        const max = pool.integrate(i, dt, seg);
        if (!pool.advance(i, seg, max)) pool.remove(i);
      }
      reference = result.alive;
      expect(pool.count).toBe(reference.length);
      // Removal order differs (swap-remove); compare as sets of positions.
      const ours = Array.from({ length: pool.count }, (_, i) => [pool.position[i * 3], pool.position[i * 3 + 1], pool.position[i * 3 + 2], pool.distance[i]]).sort((a, b) => a[0]! - b[0]!);
      const theirs = reference.map((p) => [p.position.x, p.position.y, p.position.z, p.distance]).sort((a, b) => a[0]! - b[0]!);
      expect(ours).toEqual(theirs);
    }
    expect(pool.count).toBe(0);
  });

  it("packs ids as slot << 20 | shotCounter << 4 | pellet", () => {
    const pool = new ProjectilePool();
    pool.spawnShot({ weaponId: "shotgun", shotId: 5, origin: { x: 0, y: 0, z: 0 }, directions: [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }], recoilUp: 0, recoilRight: 0 }, 9);
    expect(pool.id[1]).toBe((9 << 20) | (5 << 4) | 1);
    expect(pool.weaponId(0)).toBe("shotgun");
  });
});
