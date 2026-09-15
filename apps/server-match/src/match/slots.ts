import { clampMaxPlayers, matchTeamMode, TEAM_MODE_SIZE, type JoinClaims, type MatchConfig } from "@twobullets/contracts";
import { createRng } from "@twobullets/shared/equipment/math";
import type { SpawnPoint } from "@twobullets/shared/level/types";
import type { Vec3 } from "@twobullets/shared/movement/types";

// Slots, teams and server-owned spawns (netcode.md §1.4 #4, R12), driven by MatchConfig: slot = teamId · maxTeamSize +
// index in team, slots 0..maxPlayers-1 (≤ 20), teams 0..ceil(maxPlayers / maxTeamSize)-1. A player's slot is stable
// for the whole match; the last team may be short (10 players in squads = 4, 4, 2).

/** Extra back offset per additional team on a shared spawn point, m. */
export const SHARED_SPAWN_BACK = 3;

export type SlotChoice = { readonly ok: true; readonly teamId: number; readonly slot: number } | { readonly ok: false; readonly reason: "notAssigned" | "matchFull" };

/** Player slots of a match: maxPlayers clamped to 2..MAX_MATCH_PLAYERS (the wire limit). */
export function matchSlotCount(config: Pick<MatchConfig, "maxPlayers">): number {
  return clampMaxPlayers(config.maxPlayers);
}

/** Team size of a match: maxTeamSize, else the team mode's size; 1..4. */
export function matchTeamSize(config: Pick<MatchConfig, "maxTeamSize" | "teamMode">): number {
  const size = config.maxTeamSize > 0 ? config.maxTeamSize : TEAM_MODE_SIZE[matchTeamMode(config)];
  return Math.min(4, Math.max(1, Math.floor(size)));
}

/** Teams of a match: ceil(slots / team size). */
export function matchTeamCount(config: Pick<MatchConfig, "maxPlayers" | "maxTeamSize" | "teamMode">): number {
  return Math.ceil(matchSlotCount(config) / matchTeamSize(config));
}

/**
 * Picks a slot for a new account. With a roster (`config.teams` non-empty) the account must be listed and gets its
 * team; an open local match puts the player on the requested team when it has room, else the first team with room.
 * `taken(slot)` reports occupied slots.
 */
export function chooseSlot(config: MatchConfig, claims: JoinClaims, taken: (slot: number) => boolean): SlotChoice {
  const teamSize = matchTeamSize(config);
  const slots = matchSlotCount(config);
  const teams = matchTeamCount(config);
  const freeIn = (teamId: number): number => {
    if (teamId < 0 || teamId >= teams) return -1;
    for (let i = 0; i < teamSize; i++) {
      const slot = teamId * teamSize + i;
      if (slot < slots && !taken(slot)) return slot;
    }
    return -1;
  };
  if (config.teams.length > 0) {
    const assignment = config.teams.find((t) => t.accountIds.includes(claims.sub));
    if (assignment === undefined) return { ok: false, reason: "notAssigned" };
    const slot = freeIn(assignment.teamId);
    return slot < 0 ? { ok: false, reason: "matchFull" } : { ok: true, teamId: assignment.teamId, slot };
  }
  const preferred = claims.team >= 0 && claims.team < teams ? claims.team : 0;
  for (let k = 0; k < teams; k++) {
    const teamId = (preferred + k) % teams;
    const slot = freeIn(teamId);
    if (slot >= 0) return { ok: true, teamId, slot };
  }
  return { ok: false, reason: "matchFull" };
}

/**
 * Team spawn assignment from the match seed: team t uses spawn point `order[t % points]`; teams sharing a point (more
 * teams than points) stand `SHARED_SPAWN_BACK` m further back per extra team. Teammates stand 1.2 m apart, two per row.
 */
export class SpawnPlanner {
  private readonly order: number[];
  private readonly points: readonly SpawnPoint[];
  private readonly teamSize: number;

  constructor(points: readonly SpawnPoint[], matchSeed: number, teamSize: number) {
    if (points.length === 0) throw new Error("level has no spawn points");
    this.points = points;
    this.teamSize = teamSize;
    const random = createRng(matchSeed);
    this.order = points.map((_, i) => i);
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j]!, this.order[i]!];
    }
  }

  spawnFor(slot: number): { readonly feet: Vec3; readonly yaw: number } {
    const teamId = Math.floor(slot / this.teamSize);
    const index = slot % this.teamSize;
    const point = this.points[this.order[teamId % this.order.length]!]!;
    const [x, y, z] = point.position;
    // Offsets relative to the spawn facing (yaw 0 = +Z: right (cos, 0, −sin), forward (sin, 0, cos)).
    const rowWidth = Math.min(2, this.teamSize - Math.floor(index / 2) * 2);
    const side = ((index % 2) - (rowWidth - 1) / 2) * 1.2;
    const back = Math.floor(index / 2) * 1.2 + Math.floor(teamId / this.order.length) * SHARED_SPAWN_BACK;
    const rx = Math.cos(point.yaw);
    const rz = -Math.sin(point.yaw);
    const fx = Math.sin(point.yaw);
    const fz = Math.cos(point.yaw);
    return { feet: { x: x + rx * side - fx * back, y, z: z + rz * side - fz * back }, yaw: point.yaw };
  }
}
