// Message ids (netcode.md §6.4): the first byte of every datagram and every stream frame.
// 0x00–0x3F datagram (U tier), 0x40–0x7F control stream (S tier), 0x80+ reserved for extensions. Ids are never reused.

export const MsgId = {
  // Datagrams
  Input: 0x01,
  Ping: 0x02,
  Snapshot: 0x10,
  SnapshotAudioOnly: 0x11,
  // Control stream
  Hello: 0x40,
  Welcome: 0x41,
  MatchConfig: 0x42,
  PhaseChange: 0x43,
  LandingSelect: 0x44,
  TeamMarker: 0x45,
  ZonePhase: 0x46,
  InventorySnapshot: 0x47,
  LootResync: 0x48,
  KillFeed: 0x49,
  MatchEnd: 0x4a,
  Resync: 0x4b,
  Resume: 0x4c,
  /** v5: who is in the match (names, teams, bots, connection). */
  Roster: 0x4d,
  /** v7: ground loot in the client's area of interest (spawn, remove, quantity, forget cell, clear). */
  LootUpdate: 0x4e,
  Disconnect: 0x4f,
} as const;
export type MsgId = (typeof MsgId)[keyof typeof MsgId];

export function isDatagramId(id: number): boolean {
  return id >= 0x00 && id <= 0x3f;
}

export function isStreamId(id: number): boolean {
  return id >= 0x40 && id <= 0x7f;
}

/** Message id of a received datagram or stream frame, or -1 when empty. */
export function peekMsgId(bytes: Uint8Array): number {
  return bytes.length > 0 ? bytes[0]! : -1;
}
