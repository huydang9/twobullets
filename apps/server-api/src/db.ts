import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// SQLite through Node's built-in `node:sqlite` (no native addon). One file on a Docker volume; WAL mode so a backup can
// copy it while the API runs (`sqlite3 .backup`, see docs/release/runbook.md). Forward-only migrations; the schema
// follows platform.md §5.1 minus what an internal release doesn't need, so moving to Postgres is a table-for-table port.

const MIGRATIONS: readonly string[] = [
  // 1: accounts and results
  `
  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,
    nickname      TEXT NOT NULL,
    tag           TEXT NOT NULL,
    language      TEXT NOT NULL DEFAULT 'vi',
    refresh_hash  TEXT,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );
  CREATE INDEX accounts_refresh ON accounts(refresh_hash);

  CREATE TABLE matches (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL CHECK (source IN ('lobby','queue')),
    mode             TEXT NOT NULL,
    max_players      INTEGER NOT NULL,
    map_id           TEXT NOT NULL,
    fill_with_bots   INTEGER NOT NULL,
    region           TEXT NOT NULL,
    host_id          TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    content_hash     INTEGER NOT NULL,
    build            TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('allocating','running','completed','cancelled','aborted')),
    created_at       INTEGER NOT NULL,
    started_at       INTEGER,
    ended_at         INTEGER,
    winning_team     INTEGER,
    human_count      INTEGER NOT NULL DEFAULT 0,
    bot_count        INTEGER NOT NULL DEFAULT 0,
    abort_reason     TEXT
  );
  CREATE INDEX matches_created ON matches(created_at);

  CREATE TABLE match_participants (
    match_id      TEXT NOT NULL REFERENCES matches(id),
    account_id    TEXT NOT NULL,
    nickname      TEXT NOT NULL,
    team_id       INTEGER NOT NULL,
    bot           INTEGER NOT NULL,
    placement     INTEGER NOT NULL,
    kills         INTEGER NOT NULL,
    knocks        INTEGER NOT NULL,
    revives       INTEGER NOT NULL,
    damage_dealt  INTEGER NOT NULL,
    survived_ms   INTEGER NOT NULL,
    PRIMARY KEY (match_id, account_id)
  );
  CREATE INDEX participants_account ON match_participants(account_id);
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined;
  const current = row?.v ?? 0;
  for (let v = current + 1; v <= MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v - 1]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function dbHealthy(db: Db): boolean {
  try {
    return (db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}
