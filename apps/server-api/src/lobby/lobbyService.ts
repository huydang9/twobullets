import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, type AccountView, type CreateLobbyRequest, type LobbyStatus, type LobbyView, type MatchSettings, type UpdateLobbyRequest } from "@twobullets/contracts/rest";
import { randomInt } from "node:crypto";
import { HttpError } from "../http/errors";
import type { Metrics } from "../metrics";
import type { MatchRecord, MatchService } from "../matches/matchService";
import { parseSettings, teamCapacity, teamsOf } from "../matches/matchConfig";
import type { Push } from "../push/push";

// Custom matches: a host creates a lobby (mode, size, map, bots), friends join by code, pick teams, the host starts.
// After the match the lobby opens again so the group can play another round.

interface Member {
  readonly accountId: string;
  nickname: string;
  tag: string;
  teamId: number;
  readonly joinedAt: number;
}

interface Lobby {
  readonly code: string;
  status: LobbyStatus;
  visibility: "private" | "public";
  settings: MatchSettings;
  hostId: string;
  readonly members: Map<string, Member>;
  matchId: string | null;
  readonly createdAt: number;
  touchedAt: number;
}

export interface LobbyServiceOptions {
  readonly matches: MatchService;
  readonly push: Push;
  readonly metrics: Metrics;
  readonly idleMs: number;
  /** Tells the queue an account entered a lobby (their ticket is cancelled). */
  readonly isQueued: (accountId: string) => boolean;
  readonly now?: () => number;
}

export class LobbyService {
  private readonly o: LobbyServiceOptions;
  private readonly now: () => number;
  private readonly lobbies = new Map<string, Lobby>();
  private readonly memberOf = new Map<string, string>();

  constructor(options: LobbyServiceOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    options.matches.onFinished((record) => this.onMatchFinished(record));
    options.metrics.gauge("tb_lobbies", "Lobbies by status", () => {
      const counts: Record<string, number> = { open: 0, starting: 0, inMatch: 0 };
      for (const l of this.lobbies.values()) if (l.status in counts) counts[l.status]!++;
      return Object.entries(counts).map(([status, n]) => [{ status }, n] as const);
    });
  }

  lobbyCodeOf(accountId: string): string | null {
    return this.memberOf.get(accountId) ?? null;
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = "";
      for (let i = 0; i < LOBBY_CODE_LENGTH; i++) code += LOBBY_CODE_ALPHABET[randomInt(0, LOBBY_CODE_ALPHABET.length)];
      if (!this.lobbies.has(code)) return code;
    }
    throw new HttpError("internal", "could not allocate a lobby code");
  }

  private find(code: string): Lobby {
    const lobby = typeof code === "string" ? this.lobbies.get(code.toUpperCase()) : undefined;
    if (lobby === undefined || lobby.status === "closed") throw new HttpError("notFound", "No lobby with this code");
    return lobby;
  }

  view(lobby: Lobby): LobbyView {
    const { teamCount, teamSize } = teamsOf(lobby.settings);
    const members = [...lobby.members.values()].sort((a, b) => a.teamId - b.teamId || a.joinedAt - b.joinedAt);
    return {
      code: lobby.code,
      status: lobby.status,
      visibility: lobby.visibility,
      settings: lobby.settings,
      teamCount,
      teamSize,
      members: members.map((m) => ({ accountId: m.accountId, nickname: m.nickname, tag: m.tag, teamId: m.teamId, host: m.accountId === lobby.hostId })),
      botSlots: lobby.settings.fillWithBots ? lobby.settings.maxPlayers - lobby.members.size : 0,
      matchId: lobby.matchId,
      createdAt: lobby.createdAt,
    };
  }

  get(code: string): LobbyView {
    return this.view(this.find(code));
  }

  listPublic(): LobbyView[] {
    return [...this.lobbies.values()].filter((l) => l.visibility === "public" && l.status === "open").map((l) => this.view(l)).slice(0, 50);
  }

  private broadcast(lobby: Lobby): void {
    const view = this.view(lobby);
    for (const id of lobby.members.keys()) this.o.push.send(id, { t: "lobby.updated", lobby: view });
  }

  private assertFree(accountId: string): void {
    if (this.o.matches.activeMatchOf(accountId) !== null) throw new HttpError("alreadyInMatch", "Finish or leave your current match first");
    if (this.o.isQueued(accountId)) throw new HttpError("conflict", "Leave the queue first");
  }

  private firstTeamWithRoom(lobby: Lobby, preferred?: number): number {
    const { teamCount } = teamsOf(lobby.settings);
    const used = (t: number): number => [...lobby.members.values()].filter((m) => m.teamId === t).length;
    const has = (t: number): boolean => used(t) < teamCapacity(lobby.settings, t);
    if (preferred !== undefined && Number.isInteger(preferred) && preferred >= 0 && preferred < teamCount && has(preferred)) return preferred;
    for (let t = 0; t < teamCount; t++) if (has(t)) return t;
    return -1;
  }

  create(account: AccountView, request: CreateLobbyRequest): LobbyView {
    this.assertFree(account.id);
    const settings = parseSettings(request);
    if (typeof settings === "string") throw new HttpError("badRequest", `invalid ${settings}`);
    const visibility = request.visibility ?? "private";
    if (visibility !== "private" && visibility !== "public") throw new HttpError("badRequest", "invalid visibility");
    this.leaveCurrent(account.id);
    const now = this.now();
    const lobby: Lobby = {
      code: this.newCode(),
      status: "open",
      visibility,
      settings,
      hostId: account.id,
      members: new Map(),
      matchId: null,
      createdAt: now,
      touchedAt: now,
    };
    lobby.members.set(account.id, { accountId: account.id, nickname: account.nickname, tag: account.tag, teamId: 0, joinedAt: now });
    this.lobbies.set(lobby.code, lobby);
    this.memberOf.set(account.id, lobby.code);
    this.o.metrics.inc("tb_lobbies_created_total", {}, 1, "Lobbies created");
    return this.view(lobby);
  }

  join(account: AccountView, code: string, teamId?: number): LobbyView {
    const lobby = this.find(code);
    const existing = lobby.members.get(account.id);
    if (existing) {
      existing.nickname = account.nickname;
      return this.view(lobby);
    }
    if (lobby.status !== "open") throw new HttpError("lobbyClosed", "This lobby's match has already started");
    this.assertFree(account.id);
    if (lobby.members.size >= lobby.settings.maxPlayers) throw new HttpError("lobbyFull", "The lobby is full");
    const team = this.firstTeamWithRoom(lobby, teamId);
    if (team < 0) throw new HttpError("lobbyFull", "The lobby is full");
    this.leaveCurrent(account.id);
    lobby.members.set(account.id, { accountId: account.id, nickname: account.nickname, tag: account.tag, teamId: team, joinedAt: this.now() });
    this.memberOf.set(account.id, lobby.code);
    lobby.touchedAt = this.now();
    this.broadcast(lobby);
    return this.view(lobby);
  }

  changeTeam(accountId: string, code: string, teamId: number): LobbyView {
    const lobby = this.find(code);
    const member = lobby.members.get(accountId);
    if (member === undefined) throw new HttpError("forbidden", "You are not in this lobby");
    if (lobby.status !== "open") throw new HttpError("lobbyClosed", "Teams are locked once the match starts");
    const { teamCount } = teamsOf(lobby.settings);
    if (!Number.isInteger(teamId) || teamId < 0 || teamId >= teamCount) throw new HttpError("badRequest", `teamId must be 0..${teamCount - 1}`);
    if (member.teamId !== teamId) {
      const used = [...lobby.members.values()].filter((m) => m.teamId === teamId).length;
      if (used >= teamCapacity(lobby.settings, teamId)) throw new HttpError("lobbyFull", "That team is full");
      member.teamId = teamId;
      lobby.touchedAt = this.now();
      this.broadcast(lobby);
    }
    return this.view(lobby);
  }

  update(accountId: string, code: string, patch: UpdateLobbyRequest): LobbyView {
    const lobby = this.find(code);
    if (lobby.hostId !== accountId) throw new HttpError("forbidden", "Only the host can change settings");
    if (lobby.status !== "open") throw new HttpError("lobbyClosed", "Settings are locked once the match starts");
    const settings = parseSettings(patch, lobby.settings);
    if (typeof settings === "string") throw new HttpError("badRequest", `invalid ${settings}`);
    if (settings.maxPlayers < lobby.members.size) throw new HttpError("conflict", "More players are in the lobby than the new size allows");
    if (patch.visibility !== undefined) {
      if (patch.visibility !== "private" && patch.visibility !== "public") throw new HttpError("badRequest", "invalid visibility");
      lobby.visibility = patch.visibility;
    }
    lobby.settings = settings;
    // Re-seat everyone in join order so teams fit the new mode and size.
    const ordered = [...lobby.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    for (const m of ordered) m.teamId = -1;
    for (const m of ordered) m.teamId = this.firstTeamWithRoomExcluding(lobby, m);
    lobby.touchedAt = this.now();
    this.broadcast(lobby);
    return this.view(lobby);
  }

  private firstTeamWithRoomExcluding(lobby: Lobby, member: Member): number {
    const { teamCount } = teamsOf(lobby.settings);
    for (let t = 0; t < teamCount; t++) {
      const used = [...lobby.members.values()].filter((m) => m !== member && m.teamId === t).length;
      if (used < teamCapacity(lobby.settings, t)) return t;
    }
    return 0;
  }

  leave(accountId: string, code: string): void {
    const lobby = this.find(code);
    if (!lobby.members.has(accountId)) return;
    this.removeMember(lobby, accountId);
  }

  private leaveCurrent(accountId: string): void {
    const code = this.memberOf.get(accountId);
    const lobby = code === undefined ? undefined : this.lobbies.get(code);
    if (lobby) {
      this.removeMember(lobby, accountId);
      this.o.push.send(accountId, { t: "lobby.left", code: lobby.code });
    }
  }

  private removeMember(lobby: Lobby, accountId: string): void {
    lobby.members.delete(accountId);
    this.memberOf.delete(accountId);
    lobby.touchedAt = this.now();
    if (lobby.members.size === 0) {
      this.close(lobby);
      return;
    }
    if (lobby.hostId === accountId) lobby.hostId = [...lobby.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0]!.accountId;
    this.broadcast(lobby);
  }

  private close(lobby: Lobby): void {
    lobby.status = "closed";
    for (const id of lobby.members.keys()) {
      this.memberOf.delete(id);
      this.o.push.send(id, { t: "lobby.left", code: lobby.code });
    }
    lobby.members.clear();
    this.lobbies.delete(lobby.code);
  }

  async start(accountId: string, code: string): Promise<LobbyView> {
    const lobby = this.find(code);
    if (lobby.hostId !== accountId) throw new HttpError("forbidden", "Only the host can start the match");
    if (lobby.status !== "open") throw new HttpError("lobbyClosed", "The match has already started");
    const humans = [...lobby.members.values()].map((m) => ({ accountId: m.accountId, teamId: m.teamId, nickname: m.nickname }));
    const teamsWithPlayers = new Set(humans.map((h) => h.teamId)).size;
    if (!lobby.settings.fillWithBots && teamsWithPlayers < 2) throw new HttpError("conflict", "Need players on at least two teams, or turn bots on");
    lobby.status = "starting";
    this.broadcast(lobby);
    try {
      // The lobby host is also the match host: the only account the match server lets end the match for everyone.
      const record = await this.o.matches.start("lobby", lobby.settings, humans, lobby.code, lobby.hostId);
      if (record.status === "running") {
        lobby.status = "inMatch";
        lobby.matchId = record.id;
      } else {
        lobby.status = "open";
      }
    } catch (err) {
      if (this.lobbies.get(lobby.code) === lobby) lobby.status = "open";
      this.broadcast(lobby);
      throw err;
    }
    lobby.touchedAt = this.now();
    this.broadcast(lobby);
    return this.view(lobby);
  }

  private onMatchFinished(record: MatchRecord): void {
    if (record.lobbyCode === null) return;
    const lobby = this.lobbies.get(record.lobbyCode);
    if (lobby === undefined || lobby.matchId !== record.id) return;
    lobby.status = "open";
    lobby.matchId = null;
    lobby.touchedAt = this.now();
    this.broadcast(lobby);
  }

  /** Closes open lobbies idle for `idleMs`. */
  sweep(): void {
    const now = this.now();
    for (const lobby of [...this.lobbies.values()]) if (lobby.status === "open" && now - lobby.touchedAt > this.o.idleMs) this.close(lobby);
  }
}
