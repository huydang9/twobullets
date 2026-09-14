import type { JoinClaims, MatchConfig } from "@twobullets/contracts";
import { createRng } from "@twobullets/shared/equipment/math";
import type { SpawnPoint } from "@twobullets/shared/level/types";
import type { Vec3 } from "@twobullets/shared/movement/types";

// Slots, teams and server-owned spawns (netcode.md §1.4 #4, R12). Slot = teamId · maxTeamSize + index in team, so a
// player's slot is stable for the whole match and < 16 (5 teams × 2).

export const TEAM_COUNT = 5;

export type SlotChoice = { readonly ok: true; readonly teamId: number; readonly slot: number } | { readonly ok: false; readonly reason: "notAssigned" | "matchFull" };

/**
 * Picks a slot for a new account. With a roster (`config.teams` non-empty) the account must be listed and gets its
 * team; an open local match puts the player on the requested team when it has room, else the first team with room.
 * `taken(slot)` reports occupied slots.
 */
export function chooseSlot(config: MatchConfig, claims: JoinClaims, taken: (slot: number) => boolean): SlotChoice {
  const teamSize = config.maxTeamSize;
  const teams = Math.min(TEAM_COUNT, Math.ceil(config.maxPlayers / teamSize));
  const freeIn = (teamId: number): number => {
    for (let i = 0; i < teamSize; i++) {
      const slot = teamId * teamSize + i;
      if (slot < config.maxPlayers && !taken(slot)) return slot;
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

/** Team spawn assignment from the match seed: team t uses spawn point `order[t]`; teammates stand 1.2 m apart. */
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
    // Offset sideways relative to the spawn facing (yaw 0 = +Z, so the right vector is (cos, 0, −sin)).
    const side = (index - (this.teamSize - 1) / 2) * 1.2;
    return { feet: { x: x + Math.cos(point.yaw) * side, y, z: z - Math.sin(point.yaw) * side }, yaw: point.yaw };
  }
}
