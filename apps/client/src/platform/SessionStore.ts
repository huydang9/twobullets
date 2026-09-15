import type { AccountView, AuthResponse } from "@twobullets/contracts/rest";

// Guest session on this browser: the access token in memory plus sessionStorage (survives a reload of this tab), the
// rotating refresh secret in localStorage (stays logged in across tabs and restarts, per rest.ts RefreshRequest).

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredAccess {
  readonly accessToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly account: AccountView;
}

export const ACCESS_KEY = "tb.api.access";
export const REFRESH_KEY = "tb.api.refresh";
export const NICKNAME_KEY = "tb.api.nickname";

/** `window.sessionStorage` / `localStorage`, or null when blocked (private mode, sandboxed frames). */
export function browserStorage(kind: "session" | "local"): KeyValueStorage | null {
  try {
    const storage = kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export class SessionStore {
  private access: StoredAccess | null = null;
  private readonly session: KeyValueStorage | null;
  private readonly local: KeyValueStorage | null;

  constructor(session: KeyValueStorage | null = browserStorage("session"), local: KeyValueStorage | null = browserStorage("local")) {
    this.session = session;
    this.local = local;
    const raw = read(session, ACCESS_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StoredAccess;
        if (typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number" && parsed.account) this.access = parsed;
      } catch {
        // Corrupt entry: log in again.
      }
    }
  }

  get current(): StoredAccess | null {
    return this.access;
  }

  get account(): AccountView | null {
    return this.access?.account ?? null;
  }

  /** Read fresh each time: another tab may have rotated it. */
  get refreshToken(): string | null {
    return read(this.local, REFRESH_KEY);
  }

  /** The last nickname used on this browser (login prefill). */
  get lastNickname(): string | null {
    return read(this.local, NICKNAME_KEY);
  }

  save(auth: AuthResponse): void {
    this.access = { accessToken: auth.accessToken, expiresAt: auth.expiresAt, account: auth.account };
    write(this.session, ACCESS_KEY, JSON.stringify(this.access));
    write(this.local, REFRESH_KEY, auth.refreshToken);
    write(this.local, NICKNAME_KEY, auth.account.nickname);
  }

  updateAccount(account: AccountView): void {
    if (!this.access) return;
    this.access = { ...this.access, account };
    write(this.session, ACCESS_KEY, JSON.stringify(this.access));
    write(this.local, NICKNAME_KEY, account.nickname);
  }

  /** Drops the access token only (keeps the refresh secret). */
  dropAccess(): void {
    this.access = null;
    remove(this.session, ACCESS_KEY);
  }

  clear(): void {
    this.dropAccess();
    remove(this.local, REFRESH_KEY);
  }
}

function read(storage: KeyValueStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: KeyValueStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage full or blocked: memory only.
  }
}

function remove(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Ignore.
  }
}
