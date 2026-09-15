import type { BotDifficulty, BrEndReason, MatchEvent, TeamMode } from "@twobullets/shared";
import { t } from "../../i18n";
import { killCauseLabel } from "../equipment/labels";

// Match setup, screen and kill feed text. The strings live in the i18n catalogs (src/i18n/vi.ts, en.ts); these getters
// read the current language each time, so callers can rebuild after `onLanguageChange`.

const optional = (on: boolean, text: string): string => (on ? text : "");

export const MATCH_STRINGS = {
  setup: {
    get difficulty(): string {
      return t("setup.difficulty");
    },
    difficultyName: (difficulty: BotDifficulty): string => t(`setup.difficulty.${difficulty}`),
    get players(): string {
      return t("setup.players");
    },
    get teamMode(): string {
      return t("setup.mode");
    },
    get start(): string {
      return t("setup.start");
    },
    modeName: (mode: TeamMode): string => t(`setup.mode.${mode}`),
    /** "Map v1 · 20 người chơi · 5 tổ đội · seed 1234". */
    details: (p: { mapName?: string; players: number; teams: number; mode: TeamMode; teammate: boolean; zoneScale: number; seed: number }): string =>
      [
        p.mapName ?? t("setup.details.map"),
        t("setup.details.players", { count: p.players }),
        p.mode === "solo" ? t("setup.details.solo") : t(p.mode === "squad" ? "setup.details.squads" : "setup.details.duos", { count: p.teams }),
        p.teammate || p.mode === "solo" ? "" : t("setup.details.noTeammates"),
        p.zoneScale !== 1 ? t("setup.details.zoneScale", { scale: p.zoneScale }) : "",
        t("setup.details.seed", { seed: p.seed }),
      ]
        .filter(Boolean)
        .join(" · "),
  },
  screens: {
    get spectateTeammate(): string {
      return t("screens.spectateTeammate");
    },
    get spectate(): string {
      return t("screens.spectate");
    },
    get newMatch(): string {
      return t("screens.newMatch");
    },
    get close(): string {
      return t("screens.close");
    },
    get teamStillFighting(): string {
      return t("screens.teamStillFighting");
    },
    get died(): string {
      return t("death.cause.died");
    },
    endReason: (reason: BrEndReason): string => t(`result.reason.${reason}`),
  },
};

type KillEvent = Extract<MatchEvent, { type: "kill" }>;

/** The local player's death line for the death screen: "Bot Kilo đã hạ gục bạn bằng AR-4 (Headshot)". */
export function deathCauseText(kill: KillEvent, nameOf: (slot: number) => string): string {
  switch (kill.cause) {
    case "zone":
      return t("death.cause.zone");
    case "fall":
      return t("death.cause.fall");
    case "outOfBounds":
      return t("death.cause.outOfBounds");
    case "bleedOut":
      return kill.knockedBy >= 0 ? t("death.cause.bleedOutAfter", { name: nameOf(kill.knockedBy) }) : t("death.cause.bleedOut");
    case "teamWipe":
      return kill.killer >= 0 ? t("death.cause.teamWipedBy", { name: nameOf(kill.killer) }) : t("death.cause.teamWiped");
    default:
      if (kill.killer < 0) return t("death.cause.died");
      if (kill.killer === kill.victim) return t("death.cause.suicide", { weapon: killCauseLabel(kill.cause) });
      return t("death.cause.killedBy", {
        killer: nameOf(kill.killer),
        weapon: killCauseLabel(kill.cause),
        headshot: optional(kill.headshot, t("feed.headshot")),
        teamKill: optional(kill.teamKill, t("feed.teamKill")),
      });
  }
}

/** Match kill feed line (mirrors shared `killFeedLine`, translated): knocks, kills, bleed-outs, team eliminations. */
export function killFeedText(event: MatchEvent, nameOf: (slot: number) => string): string | null {
  switch (event.type) {
    case "knock": {
      if (event.attacker < 0 || event.attacker === event.victim) return t("feed.knockedBy", { victim: nameOf(event.victim), cause: killCauseLabel(event.cause) });
      return t("feed.knock", { attacker: nameOf(event.attacker), victim: nameOf(event.victim), weapon: killCauseLabel(event.cause), headshot: optional(event.headshot, t("feed.headshot")) });
    }
    case "kill": {
      const victim = nameOf(event.victim);
      if (event.cause === "bleedOut") return t("feed.bleedOut", { victim });
      if (event.cause === "zone") return t("feed.zone", { victim });
      if (event.cause === "fall") return t("feed.fall", { victim });
      if (event.cause === "outOfBounds") return t("feed.outOfBounds", { victim });
      if (event.cause === "teamWipe") return event.killer >= 0 ? t("feed.finished", { killer: nameOf(event.killer), victim }) : t("feed.eliminated", { victim });
      if (event.killer < 0) return t("feed.died", { victim });
      if (event.killer === event.victim) return t("feed.suicide", { victim, weapon: killCauseLabel(event.cause) });
      return t("feed.kill", {
        killer: nameOf(event.killer),
        victim,
        weapon: killCauseLabel(event.cause),
        headshot: optional(event.headshot, t("feed.headshot")),
        teamKill: optional(event.teamKill, t("feed.teamKill")),
      });
    }
    case "teamEliminated":
      return t("feed.teamEliminated", { team: event.team + 1, place: event.placement });
    default:
      return null;
  }
}
