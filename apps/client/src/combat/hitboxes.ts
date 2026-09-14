import type { PhysicsBody, Vector3 } from "@babylonjs/core";
import type { ArmorSlot, DamageKind, HitZone } from "@twobullets/shared";
import { CollisionLayer } from "@twobullets/sim";

/** Shape filter membership bits (hitbox, blocker, player), shared with the server through packages/sim. */
export { CollisionLayer };

/**
 * Bullet raycast filter: everything except blockers and character capsules, including trigger (hitbox) shapes. Capsules
 * (the local player's, offline bots') are movement proxies; the bone hitboxes inside them take the bullets.
 */
export const BULLET_COLLIDE_MASK = ~(CollisionLayer.blocker | CollisionLayer.player);

export interface DamageHit {
  readonly colliderId: string;
  readonly zone: HitZone;
  /** Damage after armor. */
  readonly amount: number;
  /** What caused it (bullet when omitted): explosion deaths, no blood spray for fire. */
  readonly kind?: DamageKind;
  /** World-space hit point. */
  readonly point: Vector3;
  /** Unit bullet (or blast) direction, world space. */
  readonly direction: Vector3;
  /** Attacker entity id (match slot) when known: grenades and fire from the equipment world. Bullets are the local player's. */
  readonly sourceId?: number;
}

export interface DamageResult {
  readonly amount: number;
  readonly remainingHealth: number;
  readonly killed: boolean;
  /** Armor the owner soaked itself (match bots wear looted armor); CombatSystem prefers it over TargetArmor. */
  readonly armorAbsorbed?: number;
  readonly armorSlot?: ArmorSlot | null;
  readonly armorDestroyed?: boolean;
  /** The hit knocked the owner down instead of killing it. */
  readonly knocked?: boolean;
}

/** Anything bullets can hurt: practice soldiers now, remote players later. */
export interface Damageable {
  readonly id: string;
  /** Human-readable name for kill feeds, e.g. "Soldier" or a player name. */
  readonly displayName?: string;
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
