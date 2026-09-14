import { Color3, Vector3 } from "@babylonjs/core";
import { SIMULATION, type FiredShot, type Projectile, type WeaponId } from "@twobullets/shared";
import { VIEWMODEL_PROFILES } from "../viewmodel/weaponProfiles";
import { FxCell } from "./fxAtlas";
import type { FxBatch } from "./FxBatch";

const SLOT_CAPACITY = 64;
const SHOT_HISTORY = 32;
const IMPACT_CAPACITY = 32;
/** Over this many meters the drawn path converges from the gun muzzle onto the true (eye-origin) bullet path. */
const MUZZLE_BLEND_METERS = 6;
/** How long a tracer takes to collapse into its end point once its bullet is gone, s. */
const FADE_SECONDS = 0.08;
/** Impacts whose bullet never showed up as a projectile (hit within its first tick) still get a streak if this recent, s. */
const ORPHAN_SHOT_WINDOW = 0.3;
const TICK_SECONDS = 1 / SIMULATION.tickRate;

const COLOR: Readonly<Record<WeaponId, Color3>> = {
  rifle: Color3.FromHexString("#ffd23f"),
  pistol: Color3.FromHexString("#ffe066"),
  shotgun: Color3.FromHexString("#ffb13b"),
  sniper: Color3.FromHexString("#ff9f1c"),
};

class ShotRecord {
  shotId = -1;
  weaponId: WeaponId = "rifle";
  readonly origin = new Vector3();
  /** Muzzle world position minus the shot origin at the frame the shot was presented. */
  readonly offset = new Vector3();
  time = -Infinity;
  orphanCount = 0;
}

class Slot {
  active = false;
  dying = false;
  projectileId = -1;
  weaponId: WeaponId = "rifle";
  seenFrame = -1;
  fade = 0;
  readonly offset = new Vector3();
  readonly head = new Vector3();
  readonly tail = new Vector3();
  /** Tail position when the slot started dying; the tail collapses from here onto the head. */
  readonly tailStart = new Vector3();
  readonly dir = new Vector3();
  speed = 0;
}

class PendingImpact {
  weaponId: WeaponId = "rifle";
  readonly point = new Vector3();
  used = false;
}

/** Glowing streaks for bullets in flight, visually launched from the viewmodel muzzle. */
export class Tracers {
  private readonly slots = Array.from({ length: SLOT_CAPACITY }, () => new Slot());
  private readonly shots = Array.from({ length: SHOT_HISTORY }, () => new ShotRecord());
  private readonly impacts = Array.from({ length: IMPACT_CAPACITY }, () => new PendingImpact());
  private nextShot = 0;
  private impactCount = 0;
  private frame = 0;
  private time = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  constructor(private readonly batch: FxBatch) {}

  recordShot(shot: FiredShot, muzzle: Vector3): void {
    const record = this.shots[this.nextShot] as ShotRecord;
    this.nextShot = (this.nextShot + 1) % SHOT_HISTORY;
    record.shotId = shot.shotId;
    record.weaponId = shot.weaponId;
    record.origin.set(shot.origin.x, shot.origin.y, shot.origin.z);
    muzzle.subtractToRef(record.origin, record.offset);
    record.time = this.time;
    record.orphanCount = 0;
  }

  noteImpact(weaponId: WeaponId, point: Vector3): void {
    if (this.impactCount >= IMPACT_CAPACITY) return;
    const impact = this.impacts[this.impactCount++] as PendingImpact;
    impact.weaponId = weaponId;
    impact.point.copyFrom(point);
    impact.used = false;
  }

  update(dt: number, cameraPosition: Vector3, projectiles: readonly Projectile[], extra: readonly Projectile[]): void {
    this.time += dt;
    this.frame++;
    this.trackProjectiles(projectiles);
    this.trackProjectiles(extra);

    // Bullets that vanished this frame: end their streak on the matching impact point, if any.
    for (const slot of this.slots) {
      if (!slot.active || slot.dying || slot.seenFrame === this.frame) continue;
      this.matchImpact(slot);
      slot.dying = true;
      slot.fade = 0;
      slot.tailStart.copyFrom(slot.tail);
    }
    for (let i = 0; i < this.impactCount; i++) {
      const impact = this.impacts[i] as PendingImpact;
      if (!impact.used) this.spawnOrphan(impact);
    }
    this.impactCount = 0;

    for (const slot of this.slots) {
      if (!slot.active) continue;
      let alpha = 1;
      if (slot.dying) {
        slot.fade += dt / FADE_SECONDS;
        if (slot.fade >= 1) {
          slot.active = false;
          continue;
        }
        Vector3.LerpToRef(slot.tailStart, slot.head, slot.fade * (2 - slot.fade), slot.tail);
        alpha = 1 - slot.fade * slot.fade;
      }
      const profile = VIEWMODEL_PROFILES[slot.weaponId].tracer;
      Vector3.LerpToRef(slot.tail, slot.head, 0.5, this.tmp);
      const distance = Vector3.Distance(this.tmp, cameraPosition);
      const halfWidth = profile.width * Math.min(2.5, Math.max(0.35, distance / 12));
      this.batch.streak(slot.tail, slot.head, halfWidth, FxCell.streak, COLOR[slot.weaponId], alpha, 0, 1.1);
    }
  }

  clear(): void {
    for (const slot of this.slots) slot.active = false;
    this.impactCount = 0;
  }

  private trackProjectiles(projectiles: readonly Projectile[]): void {
    for (const projectile of projectiles) {
      if (!wantsTracer(projectile.weaponId, projectile.shotId, projectile.id)) continue;
      const slot = this.findSlot(projectile.id) ?? this.allocateSlot();
      if (!slot) continue;
      if (slot.projectileId !== projectile.id || !slot.active) this.initSlot(slot, projectile);
      slot.seenFrame = this.frame;

      const v = projectile.velocity;
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < 1e-3) continue;
      slot.speed = speed;
      slot.dir.set(v.x / speed, v.y / speed, v.z / speed);
      const profile = VIEWMODEL_PROFILES[projectile.weaponId].tracer;
      // Long enough to span one tick of travel, so 60 Hz bullets read as continuous at high frame rates.
      const length = Math.min(projectile.distance, Math.max(profile.length, speed * TICK_SECONDS * 1.3));
      const p = projectile.position;
      const headBlend = Math.max(0, 1 - projectile.distance / MUZZLE_BLEND_METERS);
      const tailBlend = Math.max(0, 1 - (projectile.distance - length) / MUZZLE_BLEND_METERS);
      const o = slot.offset;
      slot.head.set(p.x + o.x * headBlend, p.y + o.y * headBlend, p.z + o.z * headBlend);
      slot.tail.set(
        p.x - slot.dir.x * length + o.x * tailBlend,
        p.y - slot.dir.y * length + o.y * tailBlend,
        p.z - slot.dir.z * length + o.z * tailBlend,
      );
    }
  }

  private initSlot(slot: Slot, projectile: Projectile): void {
    slot.active = true;
    slot.dying = false;
    slot.projectileId = projectile.id;
    slot.weaponId = projectile.weaponId;
    const shot = this.findShot(projectile.shotId);
    if (shot) slot.offset.copyFrom(shot.offset);
    else slot.offset.setAll(0);
  }

  private matchImpact(slot: Slot): void {
    const reach = slot.speed * TICK_SECONDS * 2 + 1;
    for (let i = 0; i < this.impactCount; i++) {
      const impact = this.impacts[i] as PendingImpact;
      if (impact.used || impact.weaponId !== slot.weaponId) continue;
      impact.point.subtractToRef(slot.head, this.tmp);
      const along = Vector3.Dot(this.tmp, slot.dir);
      if (along < -1 || along > reach) continue;
      const lateralSq = this.tmp.lengthSquared() - along * along;
      if (lateralSq > 0.6 * 0.6) continue;
      impact.used = true;
      slot.head.copyFrom(impact.point);
      return;
    }
  }

  /** The bullet hit something inside its first tick, so no projectile was ever visible: draw a brief zip to the hit. */
  private spawnOrphan(impact: PendingImpact): void {
    let shot: ShotRecord | null = null;
    for (const record of this.shots) {
      if (record.weaponId !== impact.weaponId || this.time - record.time > ORPHAN_SHOT_WINDOW) continue;
      if (!shot || record.time > shot.time) shot = record;
    }
    if (!shot) return;
    const index = shot.orphanCount++;
    if (!wantsTracer(shot.weaponId, shot.shotId, index)) return;
    const slot = this.allocateSlot();
    if (!slot) return;

    slot.active = true;
    slot.dying = true;
    slot.fade = 0;
    slot.projectileId = -1;
    slot.weaponId = shot.weaponId;
    slot.offset.copyFrom(shot.offset);
    impact.point.subtractToRef(shot.origin, this.tmp);
    const distance = this.tmp.length();
    if (distance < 0.5) {
      slot.active = false;
      return;
    }
    slot.dir.copyFrom(this.tmp).scaleInPlace(1 / distance);
    const length = Math.min(distance, VIEWMODEL_PROFILES[shot.weaponId].tracer.length * 1.5);
    const tailBlend = Math.max(0, 1 - (distance - length) / MUZZLE_BLEND_METERS);
    slot.head.copyFrom(impact.point);
    this.tmp2.copyFrom(slot.dir).scaleInPlace(-length).addInPlace(impact.point);
    slot.tail.set(
      this.tmp2.x + slot.offset.x * tailBlend,
      this.tmp2.y + slot.offset.y * tailBlend,
      this.tmp2.z + slot.offset.z * tailBlend,
    );
    slot.tailStart.copyFrom(slot.tail);
  }

  private findSlot(projectileId: number): Slot | null {
    for (const slot of this.slots) {
      if (slot.active && !slot.dying && slot.projectileId === projectileId) return slot;
    }
    return null;
  }

  private allocateSlot(): Slot | null {
    let fallback: Slot | null = null;
    for (const slot of this.slots) {
      if (!slot.active) return slot;
      if (slot.dying && (!fallback || slot.fade > fallback.fade)) fallback = slot;
    }
    return fallback;
  }

  private findShot(shotId: number): ShotRecord | null {
    for (const record of this.shots) {
      if (record.shotId === shotId) return record;
    }
    return null;
  }
}

/** Not every bullet needs a streak: full auto and pellets get thinned out so the screen doesn't turn to noise. */
function wantsTracer(weaponId: WeaponId, shotId: number, pelletIndex: number): boolean {
  switch (weaponId) {
    case "rifle":
      return shotId % 4 !== 3;
    case "shotgun":
      return pelletIndex % 3 === 0;
    default:
      return true;
  }
}
