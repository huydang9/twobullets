// Compat key (architecture.md D10, netcode.md §6.8): exact match per match. Bump PROTOCOL_VERSION on any wire change.
// CONTENT_HASH is generated from shared tuning, equipment and loot tables plus the exact Babylon/Havok pins:
//   node --experimental-transform-types packages/protocol/scripts/content-hash.ts
// test/contentHash.test.ts fails when it is stale. Inputs include the shared hitbox rig fit (ADR 0003).

/** v2 (M4): owner weapon/vitals groups, remote weapon id, Shot/PlayerHit/reliable sections, Input event ack, KillFeed. */
export const PROTOCOL_VERSION = 2;
export const CONTENT_HASH = 0xb1eab561;

export interface CompatKey {
  /** u16 */
  readonly protocolVersion: number;
  /** u32 */
  readonly contentHash: number;
}

export const COMPAT_KEY: CompatKey = { protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH };

export function isCompatible(protocolVersion: number, contentHash: number): boolean {
  return protocolVersion === PROTOCOL_VERSION && contentHash >>> 0 === CONTENT_HASH >>> 0;
}
