import { remoteLifeCode } from "@twobullets/netcode/replication";
import { LifeCode } from "@twobullets/protocol/codes";
import { MAX_ENTITY_SLOTS } from "@twobullets/protocol/messages/snapshot";
import { RemoteFlags, StanceCode } from "@twobullets/protocol/quantize";
import { poseHitboxes, RIG_BUFFER_LENGTH, segmentNearRig, segmentVsRigInto, type HitPose, type MutableRigHit } from "@twobullets/shared/hitreg/rig";
import type { HitZone, Projectile, WeaponId } from "@twobullets/shared/weapons/types";
import type { RemoteRoster } from "./RemoteRoster";

/** Stance blend of the shared rig from remote flags: 0 stand, 1 crouch, 2 prone (the knocked crawl). */
export function stanceBlendOfFlags(flags: number): number {
  if (remoteLifeCode(flags) === LifeCode.downed) return 2;
  const stance = (flags & RemoteFlags.stanceMask) >> RemoteFlags.stanceShift;
  return stance === StanceCode.crouch ? 1 : stance === StanceCode.prone ? 2 : 0;
}

/**
 * The shared procedural rig (ADR 0206) posed from each remote player's interpolated state: what the server's hit
 * registration tests, as this client renders it. Used for cosmetic hit prediction and the `?debug=hitboxes` overlay.
 * No Babylon; allocation-free.
 */
export class RemoteHitboxes {
  /** Posed shapes per slot (`poseHitboxes` layout); valid where `posed[slot]` is 1. */
  readonly shapes: Float64Array[] = [];
  readonly posed = new Uint8Array(MAX_ENTITY_SLOTS);
  private readonly pose: HitPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, stanceBlend: 0 };
  private readonly feet = new Float64Array(MAX_ENTITY_SLOTS * 3);
  private readonly hit: MutableRigHit = { t: 0, shape: -1, zone: "body" };

  constructor() {
    for (let i = 0; i < MAX_ENTITY_SLOTS; i++) this.shapes.push(new Float64Array(RIG_BUFFER_LENGTH));
  }

  /** After `roster.sample(renderTick)`: poses every visible remote that isn't dead. */
  update(roster: RemoteRoster): void {
    const pose = this.pose;
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      const p = roster.poses[slot]!;
      if (roster.visible[slot] !== 1 || remoteLifeCode(p.flags) === LifeCode.dead) {
        this.posed[slot] = 0;
        continue;
      }
      pose.x = p.x;
      pose.y = p.y;
      pose.z = p.z;
      pose.yaw = p.yaw;
      pose.pitch = p.pitch;
      pose.stanceBlend = stanceBlendOfFlags(p.flags);
      poseHitboxes(pose, this.shapes[slot]!);
      this.feet[slot * 3] = p.x;
      this.feet[slot * 3 + 1] = p.y;
      this.feet[slot * 3 + 2] = p.z;
      this.posed[slot] = 1;
    }
  }

  /** Nearest posed rig hit along a→b: the slot (−1 = none); `out` gets t (0..1 along the segment) and the zone. */
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: MutableRigHit): number {
    let best = -1;
    let bestT = 2;
    const hit = this.hit;
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      if (this.posed[slot] !== 1) continue;
      const f = slot * 3;
      if (!segmentNearRig(this.feet[f]!, this.feet[f + 1]!, this.feet[f + 2]!, ax, ay, az, bx, by, bz)) continue;
      if (!segmentVsRigInto(this.shapes[slot]!, ax, ay, az, bx, by, bz, hit) || hit.t >= bestT) continue;
      best = slot;
      bestT = hit.t;
      out.t = hit.t;
      out.shape = hit.shape;
      out.zone = hit.zone;
    }
    return best;
  }
}

export interface PredictedHitSink {
  /** A local bullet crossed a remote rig (cosmetic: a subtle sound, never damage, blood or a marker). */
  predictedHit(slot: number, zone: HitZone, x: number, y: number, z: number, weaponId: WeaponId): void;
}

const SEEN_RING = 64;

/**
 * Cosmetic hit prediction (netcode.md §5.7): after each local weapon tick, every bullet's segment for that tick is
 * tested against the posed remote rigs; the first crossing per bullet is reported once. The server's `HitConfirm` is
 * what counts.
 */
export class CosmeticHitPredictor {
  predictedHits = 0;
  private readonly hitboxes: RemoteHitboxes;
  private readonly sink: PredictedHitSink;
  private readonly seen = new Float64Array(SEEN_RING).fill(-1);
  private seenHead = 0;
  private readonly hit: MutableRigHit = { t: 0, shape: -1, zone: "body" };

  constructor(hitboxes: RemoteHitboxes, sink: PredictedHitSink) {
    this.hitboxes = hitboxes;
    this.sink = sink;
  }

  /** `projectiles` after this tick's flight step (positions at the end of the tick). */
  tick(projectiles: readonly Projectile[], dt: number): void {
    let lastShot = -1;
    let lastSlot = -1;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i]!;
      if (this.wasSeen(p.id)) continue;
      const b = p.position;
      const v = p.velocity;
      const ax = b.x - v.x * dt;
      const ay = b.y - v.y * dt;
      const az = b.z - v.z * dt;
      const slot = this.hitboxes.segment(ax, ay, az, b.x, b.y, b.z, this.hit);
      if (slot < 0) continue;
      this.seen[this.seenHead] = p.id;
      this.seenHead = (this.seenHead + 1) % SEEN_RING;
      // Pellets of one shot on one body sound once.
      if (p.shotId === lastShot && slot === lastSlot) continue;
      lastShot = p.shotId;
      lastSlot = slot;
      this.predictedHits++;
      const t = this.hit.t;
      this.sink.predictedHit(slot, this.hit.zone, ax + (b.x - ax) * t, ay + (b.y - ay) * t, az + (b.z - az) * t, p.weaponId);
    }
  }

  private wasSeen(id: number): boolean {
    for (let i = 0; i < SEEN_RING; i++) if (this.seen[i] === id) return true;
    return false;
  }
}
