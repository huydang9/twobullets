import { Vector3, type TargetCamera } from "@babylonjs/core";
import type { MatchView, RaycastFn } from "@twobullets/shared";
import type { BotBodies, BotBody } from "./BotBodies";

/** Over-the-shoulder offsets from the followed eye, m. */
const BACK = 2.8;
const RIGHT = 0.55;
const UP = 0.3;
/** Keeps the camera this far in front of a wall it would clip through, m. */
const WALL_MARGIN = 0.25;
/** Spectated pitch is damped so a bot aiming at its feet doesn't flip the view. */
const PITCH_SCALE = 0.6;

/**
 * Follow camera for spectating a bot (death screen "Spectate teammate", DEV `?spectate=1`): writes the player camera
 * after PlayerController's own camera update, from the followed body's interpolated eye and aim. [ and ] cycle through
 * bots still in play.
 */
export class Spectator {
  private body: BotBody | null = null;
  private readonly eye = new Vector3();
  private readonly target = new Vector3();
  private readonly from = { x: 0, y: 0, z: 0 };
  private readonly to = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly camera: TargetCamera,
    private readonly bodies: BotBodies,
    private readonly view: MatchView,
    private readonly raycast: RaycastFn,
  ) {}

  get active(): boolean {
    return this.body !== null;
  }

  get slot(): number {
    return this.body?.slot ?? -1;
  }

  get name(): string | null {
    return this.body?.name ?? null;
  }

  /** Follows `slot` (a bot); returns false when there is no body for it. */
  follow(slot: number): boolean {
    const body = this.bodies.bySlot[slot];
    if (!body) return false;
    this.body = body;
    return true;
  }

  stop(): void {
    this.body = null;
  }

  /** Next (+1) or previous (−1) bot in play, preferring `team` first when given. Returns the new slot or -1. */
  cycle(direction: 1 | -1, team: number | null = null): number {
    const list = this.bodies.list;
    if (list.length === 0) return -1;
    const start = this.body ? list.indexOf(this.body) : -1;
    for (const sameTeamOnly of team === null ? [false] : [true, false]) {
      for (let step = 1; step <= list.length; step++) {
        const index = (((start + direction * step) % list.length) + list.length) % list.length;
        const candidate = list[index]!;
        const actor = this.view.state.actors[candidate.slot];
        if (!actor || actor.life === "dead" || (sameTeamOnly && actor.team !== team)) continue;
        this.body = candidate;
        return candidate.slot;
      }
    }
    return -1;
  }

  /** After PlayerController.update; `alpha` is the tick interpolation factor. */
  update(alpha: number): void {
    const body = this.body;
    const actor = body?.actor;
    if (!body || !actor) return;
    // The followed bot died: move on to someone still in play (its team first).
    if (actor.life === "dead" && this.view.state.phase !== "ended" && this.cycle(1, actor.team) < 0) return;
    const followed = this.body!;
    const eye = followed.eyeToRef(alpha, this.eye);
    const yaw = followed.renderYaw(alpha);
    const pitch = (followed.actor?.pitch ?? 0) * PITCH_SCALE;
    const cp = Math.cos(pitch);
    const fx = Math.sin(yaw) * cp;
    const fy = -Math.sin(pitch);
    const fz = Math.cos(yaw) * cp;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const target = this.target.set(eye.x - fx * BACK + rx * RIGHT, eye.y - fy * BACK + UP, eye.z - fz * BACK + rz * RIGHT);

    this.from.x = eye.x;
    this.from.y = eye.y + UP;
    this.from.z = eye.z;
    this.to.x = target.x;
    this.to.y = target.y;
    this.to.z = target.z;
    const hit = this.raycast(this.from, this.to);
    if (hit) {
      const keep = Math.max(0, hit.fraction - WALL_MARGIN / BACK);
      Vector3.LerpToRef(this.eye.set(this.from.x, this.from.y, this.from.z), target, keep, target);
    }
    this.camera.position.copyFrom(target);
    this.camera.rotation.set(pitch, yaw, 0);
  }
}
