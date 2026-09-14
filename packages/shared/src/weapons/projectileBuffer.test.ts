import { describe, expect, it } from "vitest";
import { spawnProjectiles, stepProjectiles } from "./ballistics";
import {
  ProjectileBuffer,
  projectileId,
  projectilePelletOf,
  projectileShotOf,
  projectileSlotOf,
  type ProjectileSink,
} from "./projectileBuffer";
import type { FiredShot, Projectile, RaycastFn, WeaponId } from "./types";
import { WEAPONS } from "./weapons";

const DT = 1 / 60;

function shotOf(weaponId: WeaponId, shotId: number, count: number): FiredShot {
  const directions = Array.from({ length: count }, (_, i) => {
    const x = Math.sin(i * 1.7) * 0.2;
    const y = Math.cos(i * 0.9) * 0.3;
    const z = Math.sqrt(1 - x * x - y * y);
    return { x, y, z };
  });
  return { weaponId, shotId, origin: { x: 1.5, y: 1.65, z: -3 }, directions, recoilUp: 0, recoilRight: 0 };
}

/** Axis-aligned slab of world geometry at z ∈ [zMin, zMax] (same fake Havok as ballistics.test.ts). */
function wall(zMin: number, zMax: number): RaycastFn {
  return (from, to) => {
    const dz = to.z - from.z;
    if (dz === 0) return null;
    const tEnter = ((dz > 0 ? zMin : zMax) - from.z) / dz;
    const tExit = ((dz > 0 ? zMax : zMin) - from.z) / dz;
    const fraction = tEnter < 0 && tExit >= 0 ? 0 : tEnter;
    if (fraction < 0 || fraction > 1) return null;
    const point = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z + dz * fraction };
    return { point, normal: { x: 0, y: 0, z: -1 }, fraction, colliderId: null };
  };
}

interface Flat {
  id: number;
  values: number[];
}

class Recorder implements ProjectileSink {
  impacts: Flat[] = [];
  expiries: Flat[] = [];
  impact(buffer: ProjectileBuffer, i: number): void {
    this.impacts.push(flat(buffer, i));
  }
  expired(buffer: ProjectileBuffer, i: number): void {
    this.expiries.push(flat(buffer, i));
  }
}

function flat(b: ProjectileBuffer, i: number): Flat {
  const i3 = i * 3;
  return { id: b.id[i]!, values: [...b.position.subarray(i3, i3 + 3), ...b.velocity.subarray(i3, i3 + 3), b.distance[i]!, b.age[i]!] };
}

function flatObject(p: Projectile, id: number): Flat {
  return { id, values: [p.position.x, p.position.y, p.position.z, p.velocity.x, p.velocity.y, p.velocity.z, p.distance, p.age] };
}

const byId = (a: Flat, b: Flat) => a.id - b.id;

describe("ProjectileBuffer", () => {
  it("packs stable ids as slot << 20 | shotId << 4 | pellet", () => {
    const buffer = new ProjectileBuffer(1);
    buffer.spawnShot(shotOf("shotgun", 70_000, 8), 9);
    expect(buffer.count).toBe(8);
    for (let p = 0; p < 8; p++) {
      const id = buffer.id[p]!;
      expect(id).toBe((9 << 20) | ((70_000 & 0xffff) << 4) | p);
      expect(id).toBe(projectileId(9, 70_000, p));
      expect([projectileSlotOf(id), projectileShotOf(id), projectilePelletOf(id)]).toEqual([9, 70_000 & 0xffff, p]);
      expect(buffer.shotId[p]).toBe(70_000);
      expect(buffer.shooter[p]).toBe(9);
      expect(buffer.weaponId(p)).toBe("shotgun");
    }
    expect(buffer.indexOf(projectileId(9, 70_000, 5))).toBe(5);
    expect(buffer.indexOf(123)).toBe(-1);
    expect(projectileSlotOf(projectileId(2047, 0xffff, 15))).toBe(2047);
  });

  it("flies bit-identically to the object API, with the same hits and expiries", () => {
    for (const [weaponId, raycast] of [
      ["pistol", () => null],
      ["rifle", wall(40, 41)],
      ["shotgun", () => null],
      ["sniper", wall(300, 300.01)],
    ] as [WeaponId, RaycastFn][]) {
      const shot = shotOf(weaponId, 3, 6);
      let reference: readonly Projectile[] = spawnProjectiles(shot, (() => {
        let p = 0;
        return () => projectileId(4, shot.shotId, p++);
      })());
      const buffer = new ProjectileBuffer(2);
      buffer.spawnShot(shot, 4);
      const refImpacts: Flat[] = [];
      const refExpiries: Flat[] = [];
      const recorder = new Recorder();
      for (let step = 0; step < 400 && (buffer.count > 0 || reference.length > 0); step++) {
        const result = stepProjectiles(reference, DT, raycast);
        stepProjectiles(buffer, DT, raycast, recorder);
        reference = result.alive;
        for (const impact of result.impacts) refImpacts.push(flatObject(impact.projectile, impact.projectile.id));
        for (const p of result.expired) refExpiries.push(flatObject(p, p.id));
        const ours = Array.from({ length: buffer.count }, (_, i) => flat(buffer, i)).sort(byId);
        expect(ours).toEqual(reference.map((p) => flatObject(p, p.id)).sort(byId));
      }
      expect(buffer.count).toBe(0);
      expect(recorder.impacts.sort(byId)).toEqual(refImpacts.sort(byId));
      expect(recorder.expiries.sort(byId)).toEqual(refExpiries.sort(byId));
      expect(recorder.impacts.length + recorder.expiries.length).toBe(6);
      if (weaponId === "rifle" || weaponId === "sniper") expect(recorder.impacts.length).toBeGreaterThan(0);
    }
  });

  it("keeps data when it grows and swap-removes", () => {
    const buffer = new ProjectileBuffer(1);
    for (let s = 0; s < 5; s++) buffer.spawnShot(shotOf("rifle", s, 1), s);
    expect(buffer.capacity).toBeGreaterThanOrEqual(5);
    buffer.remove(1);
    expect(Array.from(buffer.id.subarray(0, buffer.count))).toEqual([0, 4, 2, 3].map((s) => projectileId(s, s, 0)));
    expect(buffer.shooter[1]).toBe(4);
  });

  it("spawns at muzzle velocity like spawnProjectiles", () => {
    const shot = shotOf("sniper", 11, 1);
    const buffer = new ProjectileBuffer();
    buffer.spawnShot(shot, 0);
    const [object] = spawnProjectiles(shot, () => 0);
    expect(flat(buffer, 0).values).toEqual(flatObject(object!, 0).values);
    expect(object!.velocity.z).toBeCloseTo(shot.directions[0]!.z * WEAPONS.sniper.muzzleVelocity);
  });
});
