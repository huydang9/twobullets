import { DEFAULT_LANGUAGE, LANGUAGES, NICKNAME_MAX, NICKNAME_MIN, type AccountView, type Language } from "@twobullets/contracts/rest";
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Db } from "../db";

// Guest accounts: a nickname, a display tag and a hashed refresh secret. Nothing else is stored about a person (no
// email, no IP) — the only personal data of the internal release.

const NICKNAME_CHARS = /^[\p{L}\p{M}\p{N} _.-]+$/u;

/** NFC + trim + collapse inner spaces; null when the rule in rest.ts is broken. */
export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  const length = [...value].length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX) return null;
  if (!NICKNAME_CHARS.test(value)) return null;
  return value;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `g_` + 26 Crockford base32 chars: 48-bit time + 80 random bits (sortable, unguessable). */
export function newAccountId(nowMs: number): string {
  let out = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i]! % 32];
  return `g_${out}`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

interface AccountRow {
  id: string;
  nickname: string;
  tag: string;
  language: string;
  created_at: number;
}

function view(row: AccountRow): AccountView {
  return { id: row.id, nickname: row.nickname, tag: row.tag, language: isLanguage(row.language) ? row.language : DEFAULT_LANGUAGE, createdAt: row.created_at };
}

export class AccountStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  createGuest(nickname: string, language: Language): { account: AccountView; refreshToken: string } {
    const now = this.now();
    const refreshToken = randomBytes(32).toString("base64url");
    const row: AccountRow = { id: newAccountId(now), nickname, tag: String(randomInt(0, 10000)).padStart(4, "0"), language, created_at: now };
    this.db
      .prepare("INSERT INTO accounts (id, nickname, tag, language, refresh_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.nickname, row.tag, row.language, hashSecret(refreshToken), now, now);
    return { account: view(row), refreshToken };
  }

  /** Exchanges a refresh secret for the account and a rotated secret; null when unknown. */
  refresh(refreshToken: string): { account: AccountView; refreshToken: string } | null {
    if (typeof refreshToken !== "string" || refreshToken.length < 20 || refreshToken.length > 100) return null;
    const row = this.db.prepare("SELECT id, nickname, tag, language, created_at FROM accounts WHERE refresh_hash = ?").get(hashSecret(refreshToken)) as
      | AccountRow
      | undefined;
    if (row === undefined) return null;
    const next = randomBytes(32).toString("base64url");
    this.db.prepare("UPDATE accounts SET refresh_hash = ?, last_seen_at = ? WHERE id = ?").run(hashSecret(next), this.now(), row.id);
    return { account: view(row), refreshToken: next };
  }

  get(id: string): AccountView | null {
    const row = this.db.prepare("SELECT id, nickname, tag, language, created_at FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row === undefined ? null : view(row);
  }

  update(id: string, patch: { nickname?: string; language?: Language }): AccountView | null {
    if (patch.nickname !== undefined) this.db.prepare("UPDATE accounts SET nickname = ? WHERE id = ?").run(patch.nickname, id);
    if (patch.language !== undefined) this.db.prepare("UPDATE accounts SET language = ? WHERE id = ?").run(patch.language, id);
    this.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").run(this.now(), id);
    return this.get(id);
  }
}
