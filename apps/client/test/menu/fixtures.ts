import type { ActiveMatchResponse, CatalogResponse, LobbyView, MatchResultResponse, MatchSummaryView, TicketView } from "@twobullets/contracts/rest";

export const catalog: CatalogResponse = {
  modes: [
    { mode: "solo", teamSize: 1, name: { vi: "Đơn", en: "Solo" } },
    { mode: "duo", teamSize: 2, name: { vi: "Đôi", en: "Duo" } },
    { mode: "squad", teamSize: 4, name: { vi: "Tổ đội", en: "Squad" } },
  ],
  minPlayers: 2,
  maxPlayers: 20,
  defaultPlayers: 10,
  defaultMode: "duo",
  maps: [
    { id: "v1", name: { vi: "Bản đồ v1", en: "Map v1" }, sizeM: 1000, available: true, kind: "handmade" },
    { id: "arena", name: { vi: "Sân tập", en: "Arena" }, sizeM: 120, available: true, kind: "dev" },
    { id: "cz-holasovice", name: { vi: "Holašovice (Séc)", en: "Holašovice (Czechia)" }, sizeM: 1000, available: false, kind: "realWorld" },
  ],
  defaultMapId: "v1",
  languages: ["vi", "en"],
  defaultLanguage: "vi",
  queueStartAfterSec: 30,
  inviteRequired: false,
};

export const settings = { mode: "duo", maxPlayers: 10, mapId: "v1", fillWithBots: true } as const;

export function lobby(patch: Partial<LobbyView> = {}): LobbyView {
  return {
    code: "ABCDEF",
    status: "open",
    visibility: "private",
    settings,
    teamCount: 5,
    teamSize: 2,
    members: [{ accountId: "g_TEST", nickname: "Huy", tag: "4821", teamId: 0, host: true }],
    botSlots: 9,
    matchId: null,
    createdAt: 1,
    ...patch,
  };
}

export function ticket(patch: Partial<TicketView> = {}): TicketView {
  return { id: "t_1", status: "queued", settings, createdAt: 1, playersWaiting: 1, startsBy: 30_001, matchId: null, ...patch };
}

export function match(patch: Partial<MatchSummaryView> = {}): MatchSummaryView {
  return { matchId: "m_1", status: "running", phase: "Warmup", settings, source: "lobby", teamId: 0, createdAt: 1, ...patch };
}

export function active(patch: Partial<ActiveMatchResponse> = {}): ActiveMatchResponse {
  return { match: null, ticket: null, lobbyCode: null, ...patch };
}

export function result(matchId = "m_1"): MatchResultResponse {
  return {
    matchId,
    outcome: "completed",
    settings,
    startedAt: 1,
    endedAt: 2,
    winningTeamId: 0,
    participants: [
      { accountId: "g_TEST", nickname: "Huy", teamId: 0, bot: false, placement: 1, kills: 3, knocks: 4, revives: 1, damageDealt: 512.4, survivedMs: 600_000 },
      { accountId: "bot:1", nickname: "Bot Kilo", teamId: 1, bot: true, placement: 2, kills: 1, knocks: 1, revives: 0, damageDealt: 90, survivedMs: 500_000 },
    ],
  };
}
