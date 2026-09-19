import type { LagCompHistory } from "@twobullets/netcode";
import { worldPhaseClock, type MapCollision } from "@twobullets/sim";
import type { MutableRigHit } from "@twobullets/shared/hitreg/rig";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { ProjectileBuffer } from "@twobullets/shared/weapons/projectileBuffer";
import type { AimedShot, HitZone, RaycastFn, WeaponId } from "@twobullets/shared/weapons/types";

// Server bullets with shooter-time rewind (netcode.md §5.2–5.3, ADR 0205). Every bullet carries its shooter's validated
// view delay D; at server tick P its flight segment is tested against the static world (one Havok ray, world-only mask)
// and against every hittable player's rig sampled at P − D from the lag-comp history, nearest hit wins. D is constant
// for the whole flight, so history depth depends only on MAX_REWIND. Bullets spawn and take their first segment on the
// fire tick. Structure of arrays on top of the shared ProjectileBuffer; no allocation per tick apart from Havok hits.

export interface ProjectileHitSink {
  /**
   * Bullet `index` (still in `buffer` during the call) struck `victim` in `zone` after `distance` metres, at the hit
   * point with unit travel direction. The victim's life may change inside the call: `hittable` is read live.
   */
  playerHit(shooter: number, shotId: number, weaponId: WeaponId, victim: number, zone: HitZone, distance: number, point: Vec3, dir: Vec3, viewDelayTicks: number): void;
  worldHit?(shooter: number, weaponId: WeaponId, point: Vec3): void;
}

/** Every flight segment (bot hearing: near misses). `tEnd` is the fraction flown, `struck` whether it hit something. */
export type ProjectileSegmentListener = (shooter: number, weaponId: WeaponId, from: Vec3, to: Vec3, tEnd: number, struck: boolean) => void;

export interface ServerProjectileStats {
  spawned: number;
  segments: number;
  worldRays: number;
  playerHits: number;
  worldHits: number;
  expired: number;
  /** Segments where a target's rewound pose wasn't in history (just joined or respawned). */
  historyMisses: number;
}

export class ServerProjectiles {
  readonly buffer: ProjectileBuffer;
  readonly stats: ServerProjectileStats = { spawned: 0, segments: 0, worldRays: 0, playerHits: 0, worldHits: 0, expired: 0, historyMisses: 0 };
  /** Optional per-segment hook (null = no cost). */
  onSegment: ProjectileSegmentListener | null = null;
  private readonly history: LagCompHistory;
  private readonly raycastWorld: RaycastFn;
  /** The map collision behind `raycastWorld`, when the level has one (`worldPhaseClock`); null on the arena. */
  private readonly phaseClock: MapCollision | null;
  private viewDelay: Float64Array;
  private readonly from: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly to: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly point: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly dir: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly rigHit: MutableRigHit = { t: 0, shape: 0, zone: "body" };

  constructor(history: LagCompHistory, raycastWorld: RaycastFn, capacity = 256) {
    this.history = history;
    this.raycastWorld = raycastWorld;
    this.phaseClock = worldPhaseClock(raycastWorld);
    this.buffer = new ProjectileBuffer(capacity);
    this.viewDelay = new Float64Array(this.buffer.capacity);
  }

  get count(): number {
    return this.buffer.count;
  }

  /** One bullet per pellet of `shot`, all with the shooter's validated view delay (ticks, already clamped). */
  spawn(shot: AimedShot, shooter: number, viewDelayTicks: number): void {
    const b = this.buffer;
    const before = b.count;
    b.spawnShot(shot, shooter);
    if (this.viewDelay.length < b.capacity) {
      const grown = new Float64Array(b.capacity);
      grown.set(this.viewDelay);
      this.viewDelay = grown;
    }
    for (let i = before; i < b.count; i++) this.viewDelay[i] = viewDelayTicks;
    this.stats.spawned += b.count - before;
  }

  /** Removes the bullets of a slot that left the match. */
  clearShooter(slot: number): void {
    const b = this.buffer;
    let i = 0;
    while (i < b.count) {
      if (b.shooter[i] === slot) this.remove(i);
      else i++;
    }
  }

  clear(): void {
    this.buffer.clear();
  }

  /**
   * Flies every bullet one tick at server tick `presentTick`. `hittable[slot]` = 1 for players that can take bullets
   * at present time (alive or downed, in the match); a bullet never hits its own shooter.
   */
  step(presentTick: number, dt: number, hittable: Uint8Array, sink: ProjectileHitSink): void {
    // The maze's glazed panes stop bullets for ten seconds and let them through for the next ten
    // (shared/map/glassPhase.ts), so the static world this tick's rays are cast against is only right once the clock
    // has been turned to this tick. Present time, not the shooter's rewound time: the rigs are rewound because the
    // shooter saw remote players late, but a client renders the static world at its own predicted tick — which is
    // this one. One call per tick, and it writes only where a group actually changed mode.
    //
    // Everything else that casts against this Havok world (bot sight, thrown items, loot drops) reads the same panes.
    // The ones that run earlier in the tick see the previous tick's modes, which is a 16 ms lag on a 10 s hold and
    // touches no hit decision — only this call decides whether a bullet was stopped.
    this.phaseClock?.setPhaseTick(presentTick);
    const b = this.buffer;
    const seg = b.segment;
    const from = this.from;
    const to = this.to;
    const history = this.history;
    const rigHit = this.rigHit;
    const slots = Math.min(hittable.length, history.maxSlots);
    let i = 0;
    while (i < b.count) {
      const reachesMaxRange = b.integrate(i, dt, seg);
      const length = seg[6]!;
      if (length <= 0) {
        if (b.advance(i, seg, reachesMaxRange)) i++;
        else this.expire(i);
        continue;
      }
      this.stats.segments++;
      from.x = seg[0]!;
      from.y = seg[1]!;
      from.z = seg[2]!;
      to.x = seg[3]!;
      to.y = seg[4]!;
      to.z = seg[5]!;
      this.stats.worldRays++;
      const worldHit = this.raycastWorld(from, to);
      let best = worldHit !== null ? worldHit.fraction : 2;
      let victim = -1;
      let zone: HitZone = "body";
      const shooter = b.shooter[i]!;
      const sampleTick = presentTick - this.viewDelay[i]!;
      for (let slot = 0; slot < slots; slot++) {
        if (slot === shooter || hittable[slot] !== 1) continue;
        if (!history.has(slot, Math.floor(sampleTick))) {
          this.stats.historyMisses++;
          continue;
        }
        if (history.segmentVsRig(slot, sampleTick, from.x, from.y, from.z, to.x, to.y, to.z, rigHit) && rigHit.t < best) {
          best = rigHit.t;
          victim = slot;
          zone = rigHit.zone;
        }
      }

      const listener = this.onSegment;
      if (victim < 0 && worldHit === null) {
        if (listener !== null) listener(shooter, b.weaponId(i), from, to, 1, false);
        if (b.advance(i, seg, reachesMaxRange)) i++;
        else this.expire(i);
        continue;
      }

      if (listener !== null) listener(shooter, b.weaponId(i), from, to, best, true);
      const p = this.point;
      p.x = from.x + (to.x - from.x) * best;
      p.y = from.y + (to.y - from.y) * best;
      p.z = from.z + (to.z - from.z) * best;
      b.commitHit(i, seg, p, best);
      const weaponId = b.weaponId(i);
      if (victim >= 0) {
        const i3 = i * 3;
        const vx = b.velocity[i3]!;
        const vy = b.velocity[i3 + 1]!;
        const vz = b.velocity[i3 + 2]!;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        const d = this.dir;
        d.x = vx / speed;
        d.y = vy / speed;
        d.z = vz / speed;
        this.stats.playerHits++;
        sink.playerHit(shooter, b.shotId[i]!, weaponId, victim, zone, b.distance[i]!, p, d, this.viewDelay[i]!);
      } else {
        this.stats.worldHits++;
        sink.worldHit?.(shooter, weaponId, p);
      }
      this.remove(i);
    }
  }

  private expire(i: number): void {
    this.stats.expired++;
    this.remove(i);
  }

  private remove(i: number): void {
    const last = this.buffer.count - 1;
    if (i !== last) this.viewDelay[i] = this.viewDelay[last]!;
    this.buffer.remove(i);
  }
}
