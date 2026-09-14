import type {
  FiredShot,
  HitZone,
  Projectile,
  ProjectileImpact,
  ProjectileStepResult,
  RaycastFn,
  WeaponDef,
} from "./types";
import { BALLISTICS, WEAPONS } from "./weapons";

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

/**
 * Advances projectiles by dt with gravity, casting a segment per projectile per step so fast bullets never
 * tunnel. Pure apart from the injected raycast.
 *
 * Semi-implicit Euler: velocity is updated first, then position with the new velocity. The segment is
 * clipped at max range so nothing is hit beyond it.
 */
export function stepProjectiles(projectiles: readonly Projectile[], dt: number, raycast: RaycastFn): ProjectileStepResult {
  const alive: Projectile[] = [];
  const impacts: ProjectileImpact[] = [];
  const expired: Projectile[] = [];

  for (const p of projectiles) {
    const def = WEAPONS[p.weaponId];
    const vx = p.velocity.x;
    const vy = p.velocity.y - BALLISTICS.gravity * def.gravityScale * dt;
    const vz = p.velocity.z;

    let dx = vx * dt;
    let dy = vy * dt;
    let dz = vz * dt;
    let length = Math.hypot(dx, dy, dz);
    const remaining = Math.max(0, def.maxRangeMeters - p.distance);
    const reachesMaxRange = length >= remaining;
    if (reachesMaxRange && length > 0) {
      const s = remaining / length;
      dx *= s;
      dy *= s;
      dz *= s;
      length = remaining;
    }

    const end = { x: p.position.x + dx, y: p.position.y + dy, z: p.position.z + dz };
    const velocity = { x: vx, y: vy, z: vz };
    const age = p.age + dt;
    const hit = length > 0 ? raycast(p.position, end) : null;

    if (hit) {
      const distance = p.distance + hit.fraction * length;
      impacts.push({ projectile: { ...p, position: hit.point, velocity, distance, age }, hit, distance });
      continue;
    }

    const next: Projectile = { ...p, position: end, velocity, distance: p.distance + length, age };
    if (reachesMaxRange || age >= BALLISTICS.maxLifetimeSeconds) expired.push(next);
    else alive.push(next);
  }

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
