// Compat key (architecture.md D10, netcode.md §6.8): exact match per match. Bump PROTOCOL_VERSION on any wire change.
// CONTENT_HASH is generated from shared tuning, equipment and loot tables plus the exact Babylon/Havok pins:
//   node --experimental-transform-types packages/protocol/scripts/content-hash.ts
// test/contentHash.test.ts fails when it is stale. TODO(R8): hitbox table + rig fit join the inputs when they move to shared.

export const PROTOCOL_VERSION = 1;
export const CONTENT_HASH = 0x662391e3;

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
