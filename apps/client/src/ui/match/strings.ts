import type { TeamMode } from "@twobullets/shared";

// Match setup and match HUD text in one place for translation. Keep entries short; format functions take plain values.

export const MATCH_STRINGS = {
  setup: {
    difficulty: "Bot difficulty",
    players: "Players",
    teamMode: "Mode",
    start: "START MATCH",
    modes: { solo: "Solo", duo: "Duo", squad: "Squad" } satisfies Record<TeamMode, string>,
    /** "Map v1 · 20 players · 5 squads · seed 1234". */
    details: (p: { players: number; teams: number; mode: TeamMode; teammate: boolean; zoneScale: number; seed: number }): string =>
      [
        "Map v1",
        `${p.players} players`,
        p.mode === "solo" ? "solo" : `${p.teams} ${p.mode === "squad" ? "squads" : "duos"}`,
        p.teammate || p.mode === "solo" ? "" : "no teammates",
        p.zoneScale !== 1 ? `zone ×${p.zoneScale}` : "",
        `seed ${p.seed}`,
      ]
        .filter(Boolean)
        .join(" · "),
  },
  hud: {
    alive: "Alive",
    teams: "Teams",
    kills: "Kills",
  },
  screens: {
    spectateTeammate: "Spectate teammate",
    spectate: "Spectate",
    newMatch: "New match",
    teamStillFighting: "Your team is still in the fight",
  },
} as const;
