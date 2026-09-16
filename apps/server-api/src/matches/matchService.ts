import { isBotAccountId } from "@twobullets/contracts/claims";
import type { MatchConfig, MatchMetrics, MatchPhase, MatchResult } from "@twobullets/contracts/match";
import type { ApiErrorCode, JoinMatchResponse, MatchSettings, MatchStatus, MatchSummaryView } from "@twobullets/contracts/rest";
import { randomBytes, randomInt } from "node:crypto";
import type { TokenService } from "../auth/tokens";
import { AllocationError, type Allocator, type AllocatorListener } from "../fleet/allocator";
import { HttpError } from "../http/errors";
import type { Metrics } from "../metrics";
import type { Push } from "../push/push";
import type { ResultsStore } from "../results/resultsStore";
import { buildMatchConfig, type SeatedPlayer } from "./matchConfig";

// Live match directory for this API process (platform.md §1.4 "Session / presence" + fleet glue): allocation, the
// active-match pointer per account (reconnect), join-token issue with epochs, and results. In-memory: an API restart
// forgets running matches (their processes are children and stop with it), which is acceptable for the MVP.

export interface HumanPlayer extends SeatedPlayer {
  readonly nickname: string;
}

export interface MatchRecord {
  readonly id: string;
  readonly source: "lobby" | "queue";
  readonly settings: MatchSettings;
  readonly config: MatchConfig;
  readonly createdAt: number;
  readonly humans: ReadonlyMap<string, HumanPlayer>;
  readonly lobbyCode: string | null;
  status: MatchStatus;
  phase: MatchPhase | null;
  wsUrl: string | null;
  readonly epochs: Map<string, number>;
  readonly connected: Set<string>;
  endedAt: number | null;
}

export interface MatchServiceOptions {
  readonly allocator: Allocator;
  readonly tokens: TokenService;
  readonly results: ResultsStore;
  readonly push: Push;
  readonly metrics: Metrics;
  readonly hostId: string;
  readonly region: string;
  readonly build: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Finished matches stay readable in memory this long (for late `active-match` polls). */
  readonly keepFinishedMs?: number;
}

export type MatchFinishedListener = (record: MatchRecord) => void;

export function newMatchId(): string {
  return `m_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

export class MatchService implements AllocatorListener {
  private readonly o: MatchServiceOptions;
  private readonly now: () => number;
  private readonly matches = new Map<string, MatchRecord>();
  private readonly activeByAccount = new Map<string, string>();
  private readonly finishedListeners: MatchFinishedListener[] = [];
  private readonly lastMetrics = new Map<string, MatchMetrics>();

  constructor(options: MatchServiceOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    options.allocator.setListener(this);
    options.metrics.gauge("tb_matches_live", "Matches allocating or running", () => {
      const counts: Record<string, number> = { allocating: 0, running: 0 };
      for (const m of this.matches.values()) if (m.status in counts) counts[m.status]!++;
      return Object.entries(counts).map(([status, n]) => [{ status }, n] as const);
    });
    options.metrics.gauge("tb_match_players_connected", "Humans connected to running matches", () => {
      let n = 0;
      for (const m of this.matches.values()) if (m.status === "running") n += m.connected.size;
      return n;
    });
    options.metrics.gauge("tb_match_tick_work_p99_ms_max", "Worst tick work p99 over running matches", () => {
      let worst = 0;
      for (const m of this.lastMetrics.values()) worst = Math.max(worst, m.tickWorkP99Ms);
      return worst;
    });
    options.metrics.gauge("tb_allocator_slots", "Match process slots on this host", () => {
      const c = options.allocator.capacity();
      return [
        [{ state: "used" }, c.used],
        [{ state: "max" }, c.max],
      ];
    });
  }

  onFinished(listener: MatchFinishedListener): void {
    this.finishedListeners.push(listener);
  }

  get(matchId: string): MatchRecord | undefined {
    return this.matches.get(matchId);
  }

  activeMatchOf(accountId: string): MatchRecord | null {
    const id = this.activeByAccount.get(accountId);
    const m = id === undefined ? undefined : this.matches.get(id);
    return m !== undefined && (m.status === "allocating" || m.status === "running") ? m : null;
  }

  summary(record: MatchRecord, accountId: string): MatchSummaryView {
    return {
      matchId: record.id,
      status: record.status,
      phase: record.phase,
      settings: record.settings,
      source: record.source,
      teamId: record.humans.get(accountId)?.teamId ?? -1,
      createdAt: record.createdAt,
    };
  }

  /**
   * Allocates a match for seated humans. Rejects with HttpError(noCapacity | internal) when allocation fails; the
   * accounts are free again by then.
   */
  async start(
    source: "lobby" | "queue",
    settings: MatchSettings,
    humans: readonly HumanPlayer[],
    lobbyCode: string | null = null,
    hostAccountId?: string,
  ): Promise<MatchRecord> {
    for (const h of humans) if (this.activeMatchOf(h.accountId) !== null) throw new HttpError("alreadyInMatch", `${h.accountId} is already in a match`);
    const matchId = newMatchId();
    const config = buildMatchConfig({ matchId, hostId: this.o.hostId, region: this.o.region, matchSeed: randomInt(0, 2 ** 32 - 1), settings, humans, hostAccountId });
    const record: MatchRecord = {
      id: matchId,
      source,
      settings,
      config,
      createdAt: this.now(),
      humans: new Map(humans.map((h) => [h.accountId, h])),
      lobbyCode,
      status: "allocating",
      phase: null,
      wsUrl: null,
      epochs: new Map(),
      connected: new Set(),
      endedAt: null,
    };
    this.matches.set(matchId, record);
    for (const h of humans) this.activeByAccount.set(h.accountId, matchId);
    this.o.results.insertMatch({ id: matchId, source, settings, config, region: this.o.region, build: this.o.build, createdAt: record.createdAt, humanCount: humans.length });
    this.o.metrics.inc("tb_matches_started_total", { source }, 1, "Matches sent to allocation");

    try {
      const allocated = await this.o.allocator.allocate(config);
      if (record.status !== "allocating") return record; // finished while allocating (exit raced the ack)
      record.wsUrl = allocated.wsUrl;
      record.status = "running";
      this.o.results.markRunning(matchId, this.now());
      for (const h of humans) this.o.push.send(h.accountId, { t: "match.assigned", match: this.summary(record, h.accountId) });
      this.o.log?.(`[match] ${matchId} running (${source}, ${settings.mode} ${settings.maxPlayers}p ${settings.mapId}, ${humans.length} humans)`);
      return record;
    } catch (err) {
      const reason = err instanceof AllocationError ? err.reason : "crashed";
      const code: ApiErrorCode = reason === "noCapacity" ? "noCapacity" : "internal";
      this.o.metrics.inc("tb_allocation_failures_total", { reason }, 1, "Failed match allocations");
      this.finish(record, "aborted", `allocation ${reason}`);
      for (const h of humans) this.o.push.send(h.accountId, { t: "match.failed", matchId, error: code });
      this.o.log?.(`[match] ${matchId} allocation failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new HttpError(code, reason === "noCapacity" ? "All match servers are busy; try again in a minute" : "The match server failed to start", reason === "noCapacity" ? 30 : undefined);
    }
  }

  /** A fresh single-use join token for a rostered human (first join or reconnect). */
  issueJoin(accountId: string, matchId: string): JoinMatchResponse {
    const record = this.matches.get(matchId);
    const human = record?.humans.get(accountId);
    if (record === undefined || human === undefined) throw new HttpError("notFound", "No such match for this account");
    if (record.status === "allocating") throw new HttpError("conflict", "The match is still starting; wait for match.assigned");
    if (record.status !== "running" || record.wsUrl === null) throw new HttpError("conflict", "The match has ended");
    const previous = record.epochs.get(accountId);
    const epoch = previous === undefined ? 0 : previous + 1;
    record.epochs.set(accountId, epoch);
    const { token, expiresAt } = this.o.tokens.issueJoin({ accountId, matchId, hostId: record.config.hostId, teamId: human.teamId, epoch, reconnect: previous !== undefined, nickname: human.nickname });
    this.o.metrics.inc("tb_join_tokens_total", { reconnect: String(previous !== undefined) }, 1, "Join tokens issued");
    return { wsUrl: record.wsUrl, joinToken: token, expiresAt, matchId, teamId: human.teamId, reconnect: previous !== undefined };
  }

  /**
   * "Abandon": the player gives a running match up from the front door (they are not connected to it any more, so there
   * is no socket to send `MatchCommand{leave}` on). The API forgets their active-match pointer, which is what frees them
   * to create a lobby or queue again and stops the rejoin offer, and retires any join token already issued so a stale
   * one cannot put them back in. The match itself carries on for the others and ends on the normal rules.
   */
  leave(accountId: string, matchId: string): void {
    const record = this.matches.get(matchId);
    if (record === undefined || record.humans.get(accountId) === undefined) throw new HttpError("notFound", "No such match for this account");
    if (this.activeByAccount.get(accountId) === matchId) this.activeByAccount.delete(accountId);
    const previous = record.epochs.get(accountId);
    record.epochs.set(accountId, previous === undefined ? 0 : previous + 1);
    record.connected.delete(accountId);
    this.o.metrics.inc("tb_match_abandons_total", {}, 1, "Running matches given up from the front door");
    this.o.log?.(`[match] ${matchId} abandoned by ${accountId}`);
  }

  /** Asks every running match to stop (maintenance). */
  releaseAll(): void {
    for (const m of this.matches.values()) if (m.status === "running") this.o.allocator.release(m.id);
  }

  /** Drops finished records older than `keepFinishedMs`. */
  sweep(): void {
    const keep = this.o.keepFinishedMs ?? 10 * 60_000;
    const now = this.now();
    for (const [id, m] of this.matches) if (m.endedAt !== null && now - m.endedAt > keep) this.matches.delete(id);
  }

  private finish(record: MatchRecord, status: "ended" | "aborted", reason: string): void {
    if (record.status === "ended" || record.status === "aborted") return;
    record.status = status;
    record.endedAt = this.now();
    this.lastMetrics.delete(record.id);
    if (status === "aborted") this.o.results.markAborted(record.id, reason, record.endedAt);
    for (const accountId of record.humans.keys()) {
      if (this.activeByAccount.get(accountId) === record.id) this.activeByAccount.delete(accountId);
      this.o.push.send(accountId, { t: "match.updated", match: this.summary(record, accountId) });
    }
    this.o.metrics.inc("tb_matches_finished_total", { status }, 1, "Matches that left the live directory");
    for (const l of this.finishedListeners) l(record);
  }

  // ─── AllocatorListener ─────────────────────────────────────────────────────────────────────────────────────────────

  onPhase(matchId: string, phase: MatchPhase, _freeSlots: number): void {
    const record = this.matches.get(matchId);
    if (record === undefined) return;
    record.phase = phase;
    if (record.status === "running") for (const id of record.humans.keys()) this.o.push.send(id, { t: "match.updated", match: this.summary(record, id) });
    // Ended/Reporting wait for the result message; Exited arrives as onExit.
    if (phase === "Crashed") this.finish(record, "aborted", "crashed");
    else if (phase === "Cancelled") this.finish(record, "ended", "cancelled");
  }

  onPlayer(matchId: string, accountId: string, event: "joined" | "left"): void {
    const record = this.matches.get(matchId);
    if (record === undefined || isBotAccountId(accountId)) return;
    if (event === "joined") record.connected.add(accountId);
    else record.connected.delete(accountId);
  }

  onMetrics(matchId: string, metrics: MatchMetrics): void {
    if (this.matches.get(matchId)?.status === "running") this.lastMetrics.set(matchId, metrics);
  }

  onResult(matchId: string, result: MatchResult): void {
    const record = this.matches.get(matchId);
    if (record === undefined || result.matchId !== matchId) return;
    try {
      this.o.results.ingestResult(result, (id) => record.humans.get(id)?.nickname ?? (isBotAccountId(id) ? `Bot ${id.slice(4)}` : id));
      this.o.metrics.inc("tb_results_ingested_total", { outcome: result.outcome }, 1, "Match results stored");
    } catch (err) {
      this.o.log?.(`[results] ${matchId} ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.finish(record, result.outcome === "aborted" ? "aborted" : "ended", `result ${result.outcome}`);
  }

  onExit(matchId: string, code: number, reason: string): void {
    const record = this.matches.get(matchId);
    if (record === undefined) return;
    // A clean exit after a result already finished the record; anything else is an abort (platform.md §3.4).
    this.finish(record, "aborted", `process ${reason} (code ${code})`);
  }
}
