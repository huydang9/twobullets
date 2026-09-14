// Compat key (architecture.md D10, netcode.md §6.8): exact match per match. Bump PROTOCOL_VERSION on any wire change.
// CONTENT_HASH becomes generated at build time (tuning, hitbox table + fit, loot tables, Babylon/Havok versions); 0 until T3.2.

export const PROTOCOL_VERSION = 1;
export const CONTENT_HASH = 0;

export interface CompatKey {
  /** u16 */
  readonly protocolVersion: number;
  /** u32 */
  readonly contentHash: number;
}

export const COMPAT_KEY: CompatKey = { protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH };
