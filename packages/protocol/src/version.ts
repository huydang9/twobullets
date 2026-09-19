// Compat key (architecture.md D10, netcode.md §6.8): exact match per match. Bump PROTOCOL_VERSION on any wire change.
// CONTENT_HASH is generated from shared tuning, equipment and loot tables plus the exact Babylon/Havok pins:
//   node --experimental-transform-types packages/protocol/scripts/content-hash.ts
// test/contentHash.test.ts fails when it is stale. Inputs include the shared hitbox rig fit (ADR 0003).

/**
 * v2 (M4): owner weapon/vitals groups, remote weapon id, Shot/PlayerHit/reliable sections, Input event ack, KillFeed.
 * v3: up to 20 players: 5-bit slots in Shot/PlayerHit/HitConfirm/Kill, 20 entity slots, Welcome slot/team 5 bits plus
 * teamSize and maxPlayers.
 * v4: battle royale lifecycle on the control stream: PhaseChange (0x43), ZonePhase (0x46), MatchEnd (0x4A); Welcome
 * carries the live phase and its end tick.
 * v5: Roster (0x4D) on the control stream after Welcome and on every join, leave or bot fill.
 * v6: snapshot teammate vitals section (bit 128): health, life, downed health and revive progress of the recipient's
 * teammates only, sent on change until acked and as a keyframe. Owner items group after vitals (consumable in use, use
 * ticks, consumable counts); the `use`/`cancel` input actions are honoured.
 * v7: networked ground loot (plan.md B5): `LootUpdate` (0x4E) on the control stream streams the items in the client's
 * area of interest; the owner items group gains a gear part (backpack level, ammo counts); `pickup` (loot id + weapon
 * slot), `drop` (shared `encodeDropArg`) and `equipAttach` (inventory ops: swap primaries) input actions are honoured.
 * v8: quitting a match: `MatchCommand` (0x50, C→S `leave` / `endForAll`) and `MatchCommandResult` (0x51, S→C
 * ok/denied/unavailable/unknown); `Roster` players carry a `host` bit (who may end the match for everyone); `MatchEnd`
 * gains reason `hostEnded` (5).
 * v9: server-authoritative throwables: the `throwItem` input action (kind, style, cooked fuse), `ThrowableUpdate`
 * (0x52) on the control stream (grenades in flight, detonations, smoke and fire areas, and a flash for the player it
 * blinded, all area-of-interest limited like loot), and a throwable-count part in the owner items group. The starting
 * kit and the match's ground loot carry throwables again.
 * v10: server-authoritative destructible walls (the maze's mirror panes and grass hedges): `WallUpdate` (0x53) on the
 * control stream carries a wall index and what happened to it (destroyed, repaired, holed, healing), with both ends
 * numbering the walls from the map layout, plus a `clear` and a full-state replay on join and resync.
 */
export const PROTOCOL_VERSION = 10;
export const CONTENT_HASH = 0x4bc5f495;

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
