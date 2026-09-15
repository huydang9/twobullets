import { isBotAccountId } from "@twobullets/contracts/claims";
import type { MatchConfig, MatchResult } from "@twobullets/contracts/match";
import type { MatchHistoryEntry, MatchResultResponse, MatchSettings } from "@twobullets/contracts/rest";
import type { Db } from "../db";

// Results ingest (platform.md §5.1 `matches` + `match_participants`). The match process reports a `MatchResult` over
// IPC; this writes it in one transaction. Postgres later: same tables, `INSERT … ON CONFLICT` instead of
// `INSERT OR REPLACE`, run the same statements through a pool.

export interface MatchRow {
  readonly id: string;
  readonly source: "lobby" | "queue";
  readonly settings: MatchSettings;
  readonly config: MatchConfig;
  readonly region: string;
  readonly build: string;
  readonly createdAt: number;
  readonly humanCount: number;
}

interface ResultRow {
  id: string;
  mode: string;
  max_players: number;
  map_id: string;
  fill_with_bots: number;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  winning_team: number | null;
}

interface ParticipantRow {
  account_id: string;
  nickname: string;
  team_id: number;
  bot: number;
  placement: number;
  kills: number;
  knocks: number;
  revives: number;
  damage_dealt: number;
  survived_ms: number;
}

function settingsOf(row: Pick<ResultRow, "mode" | "max_players" | "map_id" | "fill_with_bots">): MatchSettings {
  return { mode: row.mode as MatchSettings["mode"], maxPlayers: row.max_players, mapId: row.map_id, fillWithBots: row.fill_with_bots === 1 };
}

export class ResultsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  insertMatch(m: MatchRow): void {
    const botCount = m.config.teams.reduce((n, t) => n + t.accountIds.filter(isBotAccountId).length, 0);
    this.db
      .prepare(
        `INSERT INTO matches (id, source, mode, max_players, map_id, fill_with_bots, region, host_id, protocol_version, content_hash, build, status, created_at, human_count, bot_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocating', ?, ?, ?)`,
      )
      .run(
        m.id,
        m.source,
        m.settings.mode,
        m.settings.maxPlayers,
        m.settings.mapId,
        m.settings.fillWithBots ? 1 : 0,
        m.region,
        m.config.hostId,
        m.config.protocolVersion,
        m.config.contentHash >>> 0,
        m.build,
        m.createdAt,
        m.humanCount,
        botCount,
      );
  }

  markRunning(matchId: string, startedAt: number): void {
    this.db.prepare("UPDATE matches SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'allocating'").run(startedAt, matchId);
  }

  /** Marks a match that ended without a result (crash, allocation failure, hard cap). No-op once a result exists. */
  markAborted(matchId: string, reason: string, endedAt: number): void {
    this.db
      .prepare("UPDATE matches SET status = 'aborted', abort_reason = ?, ended_at = ? WHERE id = ? AND status IN ('allocating','running')")
      .run(reason.slice(0, 200), endedAt, matchId);
  }

  /** Idempotent: a repeated result for the same match replaces the participant rows. */
  ingestResult(result: MatchResult, nicknameOf: (accountId: string) => string): void {
    const status = result.outcome;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE matches SET status = ?, started_at = COALESCE(started_at, ?), ended_at = ?, winning_team = ?, abort_reason = NULL WHERE id = ?")
        .run(status, result.startedAt, result.endedAt, result.winningTeamId, result.matchId);
      this.db.prepare("DELETE FROM match_participants WHERE match_id = ?").run(result.matchId);
      const insert = this.db.prepare(
        `INSERT INTO match_participants (match_id, account_id, nickname, team_id, bot, placement, kills, knocks, revives, damage_dealt, survived_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of result.players) {
        insert.run(
          result.matchId,
          p.accountId,
          nicknameOf(p.accountId),
          p.teamId,
          p.bot ? 1 : 0,
          p.placement,
          p.kills,
          p.knocks,
          p.revives,
          Math.round(p.damageDealt),
          Math.round(p.survivedMs),
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getResult(matchId: string): MatchResultResponse | null {
    const row = this.db
      .prepare("SELECT id, mode, max_players, map_id, fill_with_bots, status, started_at, ended_at, winning_team FROM matches WHERE id = ?")
      .get(matchId) as ResultRow | undefined;
    if (row === undefined || (row.status !== "completed" && row.status !== "cancelled" && row.status !== "aborted")) return null;
    const participants = this.db
      .prepare(
        "SELECT account_id, nickname, team_id, bot, placement, kills, knocks, revives, damage_dealt, survived_ms FROM match_participants WHERE match_id = ? ORDER BY placement, team_id, account_id",
      )
      .all(matchId) as unknown as ParticipantRow[];
    return {
      matchId: row.id,
      outcome: row.status,
      settings: settingsOf(row),
      startedAt: row.started_at ?? 0,
      endedAt: row.ended_at ?? 0,
      winningTeamId: row.winning_team,
      participants: participants.map((p) => ({
        accountId: p.account_id,
        nickname: p.nickname,
        teamId: p.team_id,
        bot: p.bot === 1,
        placement: p.placement,
        kills: p.kills,
        knocks: p.knocks,
        revives: p.revives,
        damageDealt: p.damage_dealt,
        survivedMs: p.survived_ms,
      })),
    };
  }

  /** True when the account played in the match (or the match has no participants yet and is known). */
  isParticipant(matchId: string, accountId: string): boolean {
    return this.db.prepare("SELECT 1 AS ok FROM match_participants WHERE match_id = ? AND account_id = ?").get(matchId, accountId) !== undefined;
  }

  history(accountId: string, limit = 20): MatchHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.mode, m.max_players, m.map_id, m.fill_with_bots, m.status, m.ended_at, p.placement, p.kills,
                (SELECT COUNT(DISTINCT team_id) FROM match_participants q WHERE q.match_id = m.id) AS team_count
         FROM match_participants p JOIN matches m ON m.id = p.match_id
         WHERE p.account_id = ? ORDER BY m.ended_at DESC LIMIT ?`,
      )
      .all(accountId, Math.max(1, Math.min(100, limit))) as unknown as (ResultRow & { placement: number; kills: number; team_count: number })[];
    return rows.map((r) => ({
      matchId: r.id,
      outcome: r.status as MatchHistoryEntry["outcome"],
      settings: settingsOf(r),
      endedAt: r.ended_at ?? 0,
      placement: r.placement,
      kills: r.kills,
      teamCount: r.team_count,
    }));
  }
}
