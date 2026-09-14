import type { Projectile } from "@twobullets/shared";
import { closestApproach, type Vec3Like } from "./acoustics";
import type { GameAudio } from "./GameAudio";

/** Bullets passing within this distance of the listener's head crack or whiz (netcode.md §10.1: ≤ 3 m). */
const NEAR_MISS_RADIUS = 3;
/** Bullets first seen this close are the listener's own and never crack. */
const OWN_SHOT_RADIUS = 4;

interface Track {
  x: number;
  y: number;
  z: number;
  /** Own shot or already reported. */
  done: boolean;
  seen: number;
}

/**
 * Watches bullets in flight frame to frame and reports the ones that fly past the listener. Works on any projectile
 * list: local combat now, and the client-side tracer simulation of remote `Shot` events later.
 */
export class NearMissDetector {
  private readonly tracks = new Map<number, Track>();
  private frame = 0;

  constructor(private readonly audio: GameAudio) {}

  /** Scans one frame of bullets. `own` lists hold the listener's own shots, which never crack. */
  update(lists: readonly { readonly projectiles: readonly Projectile[]; readonly own: boolean }[], head: Vec3Like): void {
    this.frame++;
    for (const list of lists) {
      for (const projectile of list.projectiles) this.observe(projectile, head, list.own);
    }
    for (const [id, track] of this.tracks) if (track.seen !== this.frame) this.tracks.delete(id);
  }

  private observe(projectile: Projectile, head: Vec3Like, own: boolean): void {
    const { position: p } = projectile;
    let track = this.tracks.get(projectile.id);
    if (!track) {
      const near = Math.hypot(p.x - head.x, p.y - head.y, p.z - head.z) < OWN_SHOT_RADIUS;
      track = { x: p.x, y: p.y, z: p.z, done: own || near, seen: this.frame };
      this.tracks.set(projectile.id, track);
      return;
    }
    track.seen = this.frame;
    if (!track.done) {
      const approach = closestApproach(track.x, track.y, track.z, p.x, p.y, p.z, head);
      // t < 1: the closest point is behind the bullet's current position, i.e. it has actually passed.
      if (approach.distance <= NEAR_MISS_RADIUS && approach.t < 1) {
        track.done = true;
        this.audio.playNearMiss({ position: approach, velocity: projectile.velocity, weaponId: projectile.weaponId });
      }
    }
    track.x = p.x;
    track.y = p.y;
    track.z = p.z;
  }
}
