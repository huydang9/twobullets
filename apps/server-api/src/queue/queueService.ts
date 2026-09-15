import type { AccountView, CreateTicketRequest, MatchSettings, TicketView } from "@twobullets/contracts/rest";
import { randomBytes } from "node:crypto";
import { HttpError } from "../http/errors";
import type { Metrics } from "../metrics";
import { parseSettings, seatInOrder } from "../matches/matchConfig";
import type { MatchService } from "../matches/matchService";
import type { Push } from "../push/push";

// Quick queue (platform.md §2 simplified for an internal release). Tickets are solo players bucketed by
// (mode, size, map). Every tick, per bucket:
//   1. a full match's worth of humans waiting → start a match with the oldest `maxPlayers`;
//   2. else when the oldest ticket has waited `startAfterSec` and ≥ `minHumans` wait → start with everyone waiting,
//      bots fill the empty seats (platform.md §2.6).
// Humans are seated fill-style (team 0 first). A failed allocation puts the tickets back with their original times.

interface Ticket {
  readonly id: string;
  readonly accountId: string;
  readonly nickname: string;
  readonly settings: MatchSettings;
  readonly bucket: string;
  readonly createdAt: number;
  status: TicketView["status"];
  matchId: string | null;
  forming: boolean;
  failure?: TicketView["failure"];
  finishedAt: number | null;
}

export interface QueueServiceOptions {
  readonly matches: MatchService;
  readonly push: Push;
  readonly metrics: Metrics;
  readonly startAfterSec: number;
  readonly minHumans: number;
  readonly isInLobby: (accountId: string) => boolean;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

function bucketOf(s: MatchSettings): string {
  return `${s.mode}:${s.maxPlayers}:${s.mapId}`;
}

export class QueueService {
  private readonly o: QueueServiceOptions;
  private readonly now: () => number;
  private readonly tickets = new Map<string, Ticket>();
  private readonly byAccount = new Map<string, string>();
  private ticking = false;

  constructor(options: QueueServiceOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    options.metrics.gauge("tb_queue_tickets_waiting", "Quick-queue tickets waiting", () => [...this.tickets.values()].filter((t) => t.status === "queued").length);
  }

  isQueued(accountId: string): boolean {
    const id = this.byAccount.get(accountId);
    return id !== undefined && this.tickets.get(id)?.status === "queued";
  }

  private waiting(bucket: string): Ticket[] {
    return [...this.tickets.values()].filter((t) => t.bucket === bucket && t.status === "queued" && !t.forming).sort((a, b) => a.createdAt - b.createdAt);
  }

  view(ticket: Ticket): TicketView {
    const waiting = this.waiting(ticket.bucket);
    const oldest = waiting[0]?.createdAt ?? ticket.createdAt;
    return {
      id: ticket.id,
      status: ticket.status,
      settings: ticket.settings,
      createdAt: ticket.createdAt,
      playersWaiting: ticket.status === "queued" ? Math.max(1, waiting.length) : 0,
      startsBy: ticket.status === "queued" ? oldest + this.o.startAfterSec * 1000 : null,
      matchId: ticket.matchId,
      ...(ticket.failure ? { failure: ticket.failure } : {}),
    };
  }

  ticketOf(accountId: string): TicketView | null {
    const id = this.byAccount.get(accountId);
    const t = id === undefined ? undefined : this.tickets.get(id);
    return t === undefined || t.status !== "queued" ? null : this.view(t);
  }

  create(account: AccountView, request: CreateTicketRequest): TicketView {
    if (this.o.matches.activeMatchOf(account.id) !== null) throw new HttpError("alreadyInMatch", "Finish or leave your current match first");
    if (this.o.isInLobby(account.id)) throw new HttpError("conflict", "Leave your lobby first");
    const settings = parseSettings({ mode: request.mode, maxPlayers: request.maxPlayers, mapId: request.mapId, fillWithBots: true });
    if (typeof settings === "string") throw new HttpError("badRequest", `invalid ${settings}`);
    const existing = this.ticketOf(account.id);
    if (existing !== null) {
      if (bucketOf(existing.settings) === bucketOf(settings)) return existing;
      throw new HttpError("conflict", "Already queued with different settings; cancel first");
    }
    const ticket: Ticket = {
      id: `t_${randomBytes(9).toString("base64url")}`,
      accountId: account.id,
      nickname: account.nickname,
      settings,
      bucket: bucketOf(settings),
      createdAt: this.now(),
      status: "queued",
      matchId: null,
      forming: false,
      finishedAt: null,
    };
    this.tickets.set(ticket.id, ticket);
    this.byAccount.set(account.id, ticket.id);
    this.o.metrics.inc("tb_queue_tickets_total", { mode: settings.mode }, 1, "Quick-queue tickets created");
    this.notifyBucket(ticket.bucket);
    return this.view(ticket);
  }

  get(accountId: string, ticketId: string): TicketView {
    const t = this.tickets.get(ticketId);
    if (t === undefined || t.accountId !== accountId) throw new HttpError("notFound", "No such ticket");
    return this.view(t);
  }

  cancel(accountId: string, ticketId: string): void {
    const t = this.tickets.get(ticketId);
    if (t === undefined || t.accountId !== accountId) throw new HttpError("notFound", "No such ticket");
    if (t.status !== "queued") return;
    if (t.forming) throw new HttpError("conflict", "A match is being created for this ticket");
    t.status = "cancelled";
    t.finishedAt = this.now();
    this.byAccount.delete(accountId);
    this.notifyBucket(t.bucket);
  }

  private notifyBucket(bucket: string): void {
    for (const t of this.tickets.values()) if (t.bucket === bucket && t.status === "queued") this.o.push.send(t.accountId, { t: "ticket.updated", ticket: this.view(t) });
  }

  /** One matchmaking pass; the app calls it every `TB_QUEUE_TICK_MS`. Returns the allocations it started. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = this.now();
      const buckets = new Set([...this.tickets.values()].filter((t) => t.status === "queued" && !t.forming).map((t) => t.bucket));
      const starts: Promise<void>[] = [];
      for (const bucket of buckets) {
        let waiting = this.waiting(bucket);
        const settings = waiting[0]!.settings;
        while (waiting.length >= settings.maxPlayers) {
          starts.push(this.form(waiting.slice(0, settings.maxPlayers)));
          waiting = waiting.slice(settings.maxPlayers);
        }
        if (waiting.length >= this.o.minHumans && waiting.length > 0 && now - waiting[0]!.createdAt >= this.o.startAfterSec * 1000) starts.push(this.form(waiting));
      }
      await Promise.all(starts);
      this.sweep(now);
      return starts.length;
    } finally {
      this.ticking = false;
    }
  }

  private async form(group: Ticket[]): Promise<void> {
    for (const t of group) t.forming = true;
    const settings = group[0]!.settings;
    // Seat in queue order: fill-style teams, strangers together.
    const humans = seatInOrder(
      settings,
      group.map((t) => t.accountId),
    ).map((seat, i) => ({ ...seat, nickname: group[i]!.nickname }));
    try {
      const record = await this.o.matches.start("queue", settings, humans);
      const now = this.now();
      for (const t of group) {
        t.forming = false;
        t.status = "matched";
        t.matchId = record.id;
        t.finishedAt = now;
        this.byAccount.delete(t.accountId);
        this.o.metrics.inc("tb_queue_wait_seconds_sum", { mode: settings.mode }, (now - t.createdAt) / 1000, "Total queue wait of matched tickets");
        this.o.metrics.inc("tb_queue_wait_seconds_count", { mode: settings.mode }, 1, "Matched tickets");
        this.o.push.send(t.accountId, { t: "ticket.updated", ticket: this.view(t) });
      }
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "internal";
      for (const t of group) {
        t.forming = false;
        t.failure = code;
      }
      this.o.log?.(`[queue] start failed for ${group.length} tickets: ${err instanceof Error ? err.message : String(err)}`);
      this.notifyBucket(group[0]!.bucket);
    }
  }

  private sweep(now: number): void {
    for (const [id, t] of this.tickets) if (t.finishedAt !== null && now - t.finishedAt > 10 * 60_000) this.tickets.delete(id);
  }
}
