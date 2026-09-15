import { DEFAULT_MATCH_PLAYERS } from "@twobullets/contracts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every setting comes from environment variables (infra/.env.example documents them). Secrets are never defaulted in
// production: the process refuses to start without a keys file.

export interface ApiConfig {
  readonly env: "development" | "production";
  readonly host: string;
  readonly port: number;
  /** JWT issuer and the public origin, e.g. https://play.example.com. */
  readonly publicUrl: string;
  readonly build: string;
  readonly region: string;
  readonly hostId: string;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly keysFile: string;
  readonly inviteCode: string | null;
  readonly metricsToken: string | null;
  readonly corsOrigins: readonly string[];
  /** Read the client IP from X-Forwarded-For (only behind Caddy). */
  readonly trustProxy: boolean;
  readonly rateAuthPerMin: number;
  readonly rateApiPerMin: number;
  readonly allocator: "process" | "fake";
  readonly match: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly bindHost: string;
    readonly portMin: number;
    readonly portMax: number;
    readonly maxMatches: number;
    /** `{port}` and `{matchId}` are replaced. */
    readonly urlTemplate: string;
    readonly readyTimeoutMs: number;
    readonly maxMinutes: number;
  };
  readonly queue: {
    readonly startAfterSec: number;
    readonly minHumans: number;
    readonly tickMs: number;
  };
  readonly lobbyIdleMinutes: number;
  readonly defaultPlayers: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** apps/server-match next to this app (monorepo checkout and the Docker image use the same layout). */
const DEFAULT_MATCH_DIR = resolve(here, "../../server-match");

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  return n;
}

function str(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const mode = str(env, "TB_ENV", "development");
  if (mode !== "development" && mode !== "production") throw new Error(`TB_ENV must be development or production, got "${mode}"`);
  const dataDir = resolve(str(env, "TB_DATA_DIR", ".data"));
  const matchDir = resolve(str(env, "TB_MATCH_DIR", DEFAULT_MATCH_DIR));
  const port = int(env, "TB_API_PORT", 8080, 0, 65535);
  const portMin = int(env, "TB_MATCH_PORT_MIN", 7400, 1024, 65535);
  const portMax = int(env, "TB_MATCH_PORT_MAX", 7419, portMin, 65535);
  const allocator = str(env, "TB_ALLOCATOR", "process");
  if (allocator !== "process" && allocator !== "fake") throw new Error(`TB_ALLOCATOR must be process or fake`);
  const extraArgs = str(env, "TB_MATCH_EXTRA_ARGS", "").split(/\s+/).filter(Boolean);
  return {
    env: mode,
    host: str(env, "TB_API_HOST", "127.0.0.1"),
    port,
    publicUrl: str(env, "TB_PUBLIC_URL", `http://localhost:${port}`),
    build: str(env, "TB_BUILD", "dev"),
    region: str(env, "TB_REGION", "sg"),
    hostId: str(env, "TB_HOST_ID", "sg-1"),
    dataDir,
    dbFile: str(env, "TB_DB_FILE", join(dataDir, "twobullets.sqlite")),
    keysFile: str(env, "TB_JWT_KEYS_FILE", join(dataDir, "keys", "jwt-keys.json")),
    inviteCode: env.TB_INVITE_CODE ? env.TB_INVITE_CODE : null,
    metricsToken: env.TB_METRICS_TOKEN ? env.TB_METRICS_TOKEN : null,
    corsOrigins: str(env, "TB_CORS_ORIGINS", "").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: str(env, "TB_TRUST_PROXY", "0") === "1",
    rateAuthPerMin: int(env, "TB_RATE_AUTH_PER_MIN", 10, 1),
    rateApiPerMin: int(env, "TB_RATE_API_PER_MIN", 120, 1),
    allocator,
    match: {
      command: str(env, "TB_MATCH_COMMAND", process.execPath),
      args: [
        "--import",
        join(matchDir, "src/node/resolveHooks.ts"),
        join(matchDir, "src/main.ts"),
        "--mode=agent",
        "--metrics=off",
        ...extraArgs,
      ],
      cwd: matchDir,
      bindHost: str(env, "TB_MATCH_BIND_HOST", "127.0.0.1"),
      portMin,
      portMax,
      maxMatches: int(env, "TB_MAX_MATCHES", 4, 1, portMax - portMin + 1),
      urlTemplate: str(env, "TB_MATCH_URL_TEMPLATE", "ws://localhost:{port}/m/{matchId}"),
      readyTimeoutMs: int(env, "TB_MATCH_READY_TIMEOUT_MS", 30_000, 1000),
      maxMinutes: int(env, "TB_MATCH_MAX_MINUTES", 25, 1),
    },
    queue: {
      startAfterSec: int(env, "TB_QUEUE_START_AFTER_SEC", 30, 0),
      minHumans: int(env, "TB_QUEUE_MIN_HUMANS", 1, 1),
      tickMs: int(env, "TB_QUEUE_TICK_MS", 1000, 50),
    },
    lobbyIdleMinutes: int(env, "TB_LOBBY_IDLE_MINUTES", 30, 1),
    defaultPlayers: DEFAULT_MATCH_PLAYERS,
  };
}
