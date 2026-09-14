import type { PhysicsBody, Vector3 } from "@babylonjs/core";
import type { HitZone } from "@twobullets/shared";

/**
 * Shape filter membership bits. Level geometry keeps Havok's default (all bits).
 * Hitboxes are trigger shapes, so movement queries (which skip triggers) never see them; bullet raycasts opt in.
 */
export const CollisionLayer = {
  hitbox: 1 << 1,
  /** Solid proxies that stop players walking through targets but are invisible to bullets. */
  blocker: 1 << 2,
} as const;

/** Bullet raycast filter: everything except blockers, including trigger (hitbox) shapes. */
export const BULLET_COLLIDE_MASK = ~CollisionLayer.blocker;

export interface DamageHit {
  readonly colliderId: string;
  readonly zone: HitZone;
  readonly amount: number;
  /** World-space hit point. */
  readonly point: Vector3;
  /** Unit bullet direction, world space. */
  readonly direction: Vector3;
}

export interface DamageResult {
  readonly amount: number;
  readonly remainingHealth: number;
  readonly killed: boolean;
}

/** Anything bullets can hurt: target dummies now, remote players later. */
export interface Damageable {
  readonly id: string;
  readonly alive: boolean;
  /** Returns null when the hit is ignored (e.g. already dead). */
  applyDamage(hit: DamageHit): DamageResult | null;
}

export interface Hitbox {
  readonly colliderId: string;
  readonly owner: Damageable;
  readonly zone: HitZone;
}

/** Maps Havok bodies to hitboxes so raycast hits resolve to a damageable owner and zone. */
export class HitboxRegistry {
  private readonly byBody = new Map<PhysicsBody, Hitbox>();
  private readonly byId = new Map<string, Hitbox>();

  add(body: PhysicsBody, hitbox: Hitbox): void {
    if (this.byId.has(hitbox.colliderId)) throw new Error(`Duplicate collider id "${hitbox.colliderId}"`);
    this.byBody.set(body, hitbox);
    this.byId.set(hitbox.colliderId, hitbox);
  }

  remove(body: PhysicsBody): void {
    const hitbox = this.byBody.get(body);
    if (!hitbox) return;
    this.byBody.delete(body);
    this.byId.delete(hitbox.colliderId);
  }

  /** Collider id for a hit body, or null for world geometry. */
  colliderIdOf(body: PhysicsBody | undefined): string | null {
    return body ? (this.byBody.get(body)?.colliderId ?? null) : null;
  }

  get(colliderId: string): Hitbox | undefined {
    return this.byId.get(colliderId);
  }
}
