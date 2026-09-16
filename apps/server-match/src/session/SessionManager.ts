import type { Clock, Session } from "@twobullets/netcode";
import { createBitReader, decodeHello, DisconnectReason, isCompatible, MsgId } from "@twobullets/protocol";
import type { JoinTokenVerifier } from "../auth/joinToken";
import type { ServerMatch } from "../match/ServerMatch";
import { disconnectSession, DisconnectReasonName } from "./control";

// Connection admission (architecture.md §2.3): wait for Hello on the control stream → compat key → join token (same
// verifier path as production) → match lookup by `mid` → Match.attach (which sends Welcome). Runs on the I/O path,
// between ticks. Transports call `accept` per connection and `transportClosed` when the socket goes away.

export interface MatchDirectory {
  readonly hostId: string;
  findMatch(matchId: string): ServerMatch | undefined;
  readonly accepting: boolean;
}

export interface AcceptInfo {
  /** Match id from the connection URL (`/m/{matchId}`), checked against the token's `mid` when present. */
  readonly pathMatchId?: string | null;
  readonly remote?: string;
}

export interface ConnectionHandle {
  transportClosed(): void;
}

export interface SessionManagerOptions {
  readonly directory: MatchDirectory;
  readonly verifier: JoinTokenVerifier;
  readonly clock: Clock;
  readonly helloTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface SessionStats {
  accepted: number;
  attached: number;
  resumed: number;
  rejected: Record<string, number>;
}

type State = "hello" | "admitting" | "attached" | "closed";

interface Connection {
  readonly session: Session;
  readonly info: AcceptInfo;
  readonly acceptedAtMs: number;
  state: State;
  match: ServerMatch | null;
}

export class SessionManager {
  readonly stats: SessionStats = { accepted: 0, attached: 0, resumed: 0, rejected: {} };
  private readonly options: SessionManagerOptions;
  private readonly pending = new Set<Connection>();
  private readonly reader = createBitReader(new Uint8Array(0));
  private readonly helloTimeoutMs: number;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5000;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  accept(session: Session, info: AcceptInfo = {}): ConnectionHandle {
    this.stats.accepted++;
    const conn: Connection = { session, info, acceptedAtMs: this.options.clock.now(), state: "hello", match: null };
    this.pending.add(conn);
    session.onStream((bytes) => this.onStream(conn, bytes));
    return {
      transportClosed: () => {
        if (conn.state === "attached") conn.match?.detach(session);
        conn.state = "closed";
        this.pending.delete(conn);
      },
    };
  }

  /** Shutdown: connections still before attach (no Hello yet, or waiting for the match) get `Disconnect{reason}` and a clean close. */
  closePending(reason: DisconnectReason): void {
    for (const conn of [...this.pending]) if (conn.state === "hello" || conn.state === "admitting") this.reject(conn, reason, "shutting down");
  }

  /** Hello timeouts; call about once per second. */
  sweep(nowMs: number): void {
    for (const conn of this.pending) {
      if (conn.state === "hello" && nowMs - conn.acceptedAtMs > this.helloTimeoutMs) this.reject(conn, DisconnectReason.timeout, "no Hello");
    }
  }

  private onStream(conn: Connection, bytes: Uint8Array): void {
    if (conn.state !== "hello") return;
    if (bytes[0] !== MsgId.Hello) {
      this.reject(conn, DisconnectReason.internalError, `expected Hello, got 0x${(bytes[0] ?? 0).toString(16)}`);
      return;
    }
    const r = this.reader;
    r.reset(bytes);
    const hello = decodeHello(r);
    if (hello === null) {
      this.reject(conn, DisconnectReason.internalError, "malformed Hello");
      return;
    }
    if (!isCompatible(hello.protocolVersion, hello.contentHash)) {
      this.reject(conn, DisconnectReason.versionMismatch, `pv ${hello.protocolVersion} ch 0x${(hello.contentHash >>> 0).toString(16)}`);
      return;
    }
    const directory = this.options.directory;
    if (!directory.accepting) {
      this.reject(conn, DisconnectReason.serverShutdown, "draining");
      return;
    }
    const result = this.options.verifier.verify(hello.joinToken);
    if (!result.ok) {
      this.reject(conn, result.reason, result.detail);
      return;
    }
    const claims = result.claims;
    if (claims.pv !== hello.protocolVersion || claims.ch >>> 0 !== hello.contentHash >>> 0) {
      this.reject(conn, DisconnectReason.versionMismatch, "Hello and token compat keys differ");
      return;
    }
    if (claims.hid !== directory.hostId) {
      this.reject(conn, DisconnectReason.badToken, "hid");
      return;
    }
    const path = conn.info.pathMatchId;
    if (path !== undefined && path !== null && path !== claims.mid) {
      this.reject(conn, DisconnectReason.notAssigned, "path match id");
      return;
    }
    const match = directory.findMatch(claims.mid);
    if (match === undefined) {
      this.reject(conn, DisconnectReason.notAssigned, `no match ${claims.mid}`);
      return;
    }
    conn.state = "admitting";
    const attach = (): void => {
      if (conn.state !== "admitting") return;
      const res = match.attach(conn.session, claims);
      if (!res.ok) {
        this.reject(conn, res.reason, "attach");
        return;
      }
      conn.state = "attached";
      conn.match = match;
      this.pending.delete(conn);
      this.stats.attached++;
      if (res.resumed) this.stats.resumed++;
      this.options.log?.(`[session] ${claims.sub} → match ${match.id} slot ${res.slot} team ${res.teamId}${res.resumed ? " (resumed)" : ""}`);
    };
    if (match.phase === "Booting") match.ready.then(attach, () => this.reject(conn, DisconnectReason.internalError, "match failed to boot"));
    else attach();
  }

  private reject(conn: Connection, reason: DisconnectReason, detail: string): void {
    if (conn.state === "closed" || conn.state === "attached") return;
    conn.state = "closed";
    this.pending.delete(conn);
    const name = DisconnectReasonName[reason] ?? String(reason);
    this.stats.rejected[name] = (this.stats.rejected[name] ?? 0) + 1;
    this.options.log?.(`[session] rejected ${conn.info.remote ?? ""} ${name}: ${detail}`);
    disconnectSession(conn.session, reason);
  }
}
