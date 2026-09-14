/**
 * Havok shape filter membership bits shared by client and server. World geometry keeps Havok's default (all bits).
 * Hitboxes are trigger shapes, so movement queries (which skip triggers) never see them; bullet raycasts opt in.
 */
export const CollisionLayer = {
  hitbox: 1 << 1,
  /** Solid proxies that stop players walking through targets but are invisible to bullets. */
  blocker: 1 << 2,
  /** Player character capsules. Movement queries skip it until player body blocking lands (see CharacterBody). */
  player: 1 << 3,
} as const;

/** Static-world queries: no hitbox triggers, blockers or players. */
export const WORLD_ONLY_MASK = ~(CollisionLayer.hitbox | CollisionLayer.blocker | CollisionLayer.player);
