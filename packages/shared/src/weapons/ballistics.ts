import type {
  FiredShot,
  HitZone,
  Projectile,
  ProjectileImpact,
  ProjectileStepResult,
  RaycastFn,
  WeaponDef,
} from "./types";
import { ProjectileBuffer, projectileWeaponIndex, type ProjectileSink } from "./projectileBuffer";
import { WEAPONS } from "./weapons";

/** Creates one projectile per pellet direction of a fired shot. `nextId` supplies unique projectile ids. */
export function spawnProjectiles(shot: FiredShot, nextId: () => number): Projectile[] {
  const speed = WEAPONS[shot.weaponId].muzzleVelocity;
  return shot.directions.map((dir) => ({
    id: nextId(),
    shotId: shot.shotId,
    weaponId: shot.weaponId,
    position: { x: shot.origin.x, y: shot.origin.y, z: shot.origin.z },
    velocity: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed },
    distance: 0,
    age: 0,
  }));
}

/** Adapter scratch: the object API runs the buffer's arithmetic so both stay bit-identical. */
const scratch = new ProjectileBuffer(64);

/**
 * Advances projectiles by dt with gravity, casting a segment per projectile per step so fast bullets never
 * tunnel. Pure apart from the injected raycast.
 *
 * Semi-implicit Euler: velocity is updated first, then position with the new velocity. The segment is
 * clipped at max range so nothing is hit beyond it.
 *
 * Buffer form (R7, hot path): steps a `ProjectileBuffer` in place with zero allocations, reporting to `sink`.
 * Object form: a thin adapter over the same arithmetic that returns new objects (tests, offline client).
 */
export function stepProjectiles(buffer: ProjectileBuffer, dt: number, raycast: RaycastFn, sink: ProjectileSink): void;
export function stepProjectiles(projectiles: readonly Projectile[], dt: number, raycast: RaycastFn): ProjectileStepResult;
export function stepProjectiles(
  projectiles: ProjectileBuffer | readonly Projectile[],
  dt: number,
  raycast: RaycastFn,
  sink?: ProjectileSink,
): ProjectileStepResult | undefined {
  if (projectiles instanceof ProjectileBuffer) {
    if (!sink) throw new Error("stepProjectiles(buffer) needs a sink");
    projectiles.step(dt, raycast, sink);
    return undefined;
  }

  const alive: Projectile[] = [];
  const impacts: ProjectileImpact[] = [];
  const expired: Projectile[] = [];
  const buffer = scratch;
  buffer.clear();
  for (const p of projectiles) {
    const { position: q, velocity: v } = p;
    buffer.add(0, 0, 0, projectileWeaponIndex(p.weaponId), q.x, q.y, q.z, v.x, v.y, v.z, p.distance, p.age);
  }

  // In input order and without removal, so the result lists keep the caller's order.
  const seg = buffer.segment;
  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i]!;
    const reachesMaxRange = buffer.integrate(i, dt, seg);
    const i3 = i * 3;
    const velocity = { x: buffer.velocity[i3]!, y: buffer.velocity[i3 + 1]!, z: buffer.velocity[i3 + 2]! };
    const age = buffer.age[i]!;
    const end = { x: seg[3]!, y: seg[4]!, z: seg[5]! };
    const hit = seg[6]! > 0 ? raycast(p.position, end) : null;

    if (hit) {
      buffer.commitHit(i, seg, hit.point, hit.fraction);
      const distance = buffer.distance[i]!;
      impacts.push({ projectile: { ...p, position: hit.point, velocity, distance, age }, hit, distance });
      continue;
    }

    const flying = buffer.advance(i, seg, reachesMaxRange);
    const next: Projectile = { ...p, position: end, velocity, distance: buffer.distance[i]!, age };
    if (flying) alive.push(next);
    else expired.push(next);
  }
  buffer.clear();

  return { alive, impacts, expired };
}

/**
 * Damage for one pellet hitting `zone` after travelling `distance` meters: base × zone × falloff, where falloff
 * is 1 up to startMeters, linear down to minMultiplier at endMeters, and flat beyond.
 * Rounded to one decimal so client and server display and compare the same value.
 */
export function computeDamage(def: WeaponDef, zone: HitZone, distance: number): number {
  const { startMeters, endMeters, minMultiplier } = def.falloff;
  let falloff = 1;
  if (distance >= endMeters) falloff = minMultiplier;
  else if (distance > startMeters) falloff = 1 + ((distance - startMeters) / (endMeters - startMeters)) * (minMultiplier - 1);
  return Math.round(def.damage * def.zoneMultipliers[zone] * falloff * 10) / 10;
}
