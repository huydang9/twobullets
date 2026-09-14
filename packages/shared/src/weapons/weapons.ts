import type { WeaponDef, WeaponId } from "./types";

export const BALLISTICS = {
  /** Bullet gravity, m/s². Scaled per weapon by gravityScale. */
  gravity: 9.81,
  /** Hard lifetime cap for any projectile, s. */
  maxLifetimeSeconds: 3,
} as const;

// Tuned against 100 HP. Damage ≥ health kills, so e.g. 5 × 20 is a 5-shot kill.
// Base camera FOV is 90°; ADS sensitivity roughly tracks the zoom ratio so aim feels consistent.

const rifle: WeaponDef = {
  id: "rifle",
  name: "AR-4",
  slot: 1,
  fireMode: "auto",
  roundsPerMinute: 700,
  magazineSize: 30,
  reserveAmmo: 120,
  reloadSeconds: 2.2,
  equipSeconds: 0.55,
  // 5 body / 3 head inside 40 m; one extra body shot at long range.
  damage: 22,
  zoneMultipliers: { head: 2, body: 1, limb: 0.75 },
  pellets: 1,
  falloff: { startMeters: 40, endMeters: 120, minMultiplier: 0.75 },
  muzzleVelocity: 620,
  gravityScale: 1,
  maxRangeMeters: 500,
  spread: { hip: 2.2, ads: 0.15, moving: 1.4, airborne: 4, bloomPerShot: 0.22, maxBloom: 2.2, bloomRecovery: 5, pelletCone: 0 },
  // ~0.45° per shot: a full uncompensated mag climbs ~13°, so long sprays need pull-down.
  recoil: { up: 0.45, yaw: 0.18, adsMultiplier: 0.65 },
  ads: { fovDegrees: 62, seconds: 0.18, moveSpeedScale: 0.6, sensitivityScale: 0.68, scoped: false },
  moveSpeedScale: 0.95,
};

const shotgun: WeaponDef = {
  id: "shotgun",
  name: "S-12",
  slot: 2,
  fireMode: "semi",
  roundsPerMinute: 70,
  magazineSize: 7,
  reserveAmmo: 28,
  reloadSeconds: 2.6,
  equipSeconds: 0.7,
  // 6 of 8 pellets to the body kills point blank; falloff plus the wide cone make it useless past ~15 m.
  damage: 17,
  zoneMultipliers: { head: 1.5, body: 1, limb: 0.75 },
  pellets: 8,
  falloff: { startMeters: 6, endMeters: 18, minMultiplier: 0.15 },
  muzzleVelocity: 350,
  gravityScale: 1,
  maxRangeMeters: 60,
  // ADS barely tightens a shotgun; the pellet cone (≈0.4 m radius at 5 m) dominates.
  spread: { hip: 1.2, ads: 0.6, moving: 0.8, airborne: 2, bloomPerShot: 0.6, maxBloom: 1.2, bloomRecovery: 2, pelletCone: 4.5 },
  recoil: { up: 3, yaw: 0.8, adsMultiplier: 0.8 },
  ads: { fovDegrees: 75, seconds: 0.2, moveSpeedScale: 0.7, sensitivityScale: 0.82, scoped: false },
  moveSpeedScale: 0.95,
};

const pistol: WeaponDef = {
  id: "pistol",
  name: "P-9",
  slot: 3,
  fireMode: "semi",
  // Cap for spam-clicking; real tap rate is usually slower.
  roundsPerMinute: 400,
  magazineSize: 12,
  reserveAmmo: 48,
  reloadSeconds: 1.4,
  equipSeconds: 0.3,
  // 5 body / 3 head up close, 6 body past 20 m.
  damage: 20,
  zoneMultipliers: { head: 2, body: 1, limb: 0.75 },
  pellets: 1,
  falloff: { startMeters: 20, endMeters: 50, minMultiplier: 0.6 },
  muzzleVelocity: 380,
  gravityScale: 1,
  maxRangeMeters: 200,
  spread: { hip: 1.1, ads: 0.35, moving: 0.8, airborne: 2.5, bloomPerShot: 0.45, maxBloom: 2, bloomRecovery: 6, pelletCone: 0 },
  recoil: { up: 1, yaw: 0.35, adsMultiplier: 0.75 },
  ads: { fovDegrees: 72, seconds: 0.12, moveSpeedScale: 0.8, sensitivityScale: 0.8, scoped: false },
  moveSpeedScale: 1,
};

const sniper: WeaponDef = {
  id: "sniper",
  name: "K-98",
  slot: 4,
  fireMode: "bolt",
  // 1.2 s bolt cycle.
  roundsPerMinute: 50,
  magazineSize: 5,
  reserveAmmo: 20,
  reloadSeconds: 3,
  equipSeconds: 0.9,
  // Body 80 (72 past 500 m); head never drops below 115, so headshots always kill.
  damage: 80,
  zoneMultipliers: { head: 1.6, body: 1, limb: 0.7 },
  pellets: 1,
  falloff: { startMeters: 200, endMeters: 500, minMultiplier: 0.9 },
  // Slow, heavy round: ~0.4 m drop at 100 m, ~3.6 m at 300 m (PUBG-style holdover).
  muzzleVelocity: 400,
  gravityScale: 1.3,
  maxRangeMeters: 1000,
  // Scoped is pinpoint, hip is a gamble; moving still punishes quickscopes.
  spread: { hip: 8, ads: 0, moving: 2.5, airborne: 8, bloomPerShot: 1.5, maxBloom: 1.5, bloomRecovery: 2, pelletCone: 0 },
  recoil: { up: 4, yaw: 0.8, adsMultiplier: 0.6 },
  ads: { fovDegrees: 27, seconds: 0.3, moveSpeedScale: 0.45, sensitivityScale: 0.3, scoped: true },
  moveSpeedScale: 0.9,
};

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = { pistol, rifle, shotgun, sniper };

export const DEFAULT_LOADOUT: readonly WeaponId[] = ["rifle", "shotgun", "pistol", "sniper"];

export function getWeaponDef(id: WeaponId): WeaponDef {
  return WEAPONS[id];
}
