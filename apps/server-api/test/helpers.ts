import type { AuthResponse } from "@twobullets/contracts/rest";
import { createApi, type ApiApp, type AppConfig } from "../src/app";
import { KeyRing } from "../src/auth/keyRing";
import { openDb } from "../src/db";
import { FakeAllocator } from "../src/fleet/allocator";
import { RecordingPush } from "../src/push/push";

export interface TestApi {
  readonly app: ApiApp;
  readonly allocator: FakeAllocator;
  readonly push: RecordingPush;
  readonly keys: KeyRing;
  readonly clock: { now: number };
  readonly base: string;
  call<T = any>(method: string, path: string, options?: { body?: unknown; token?: string; headers?: Record<string, string> }): Promise<{ status: number; body: T }>;
  guest(nickname: string): Promise<AuthResponse>;
  close(): Promise<void>;
}

export const TEST_CONFIG: AppConfig = {
  publicUrl: "https://play.test",
  build: "test",
  region: "sg",
  hostId: "sg-test",
  inviteCode: null,
  metricsToken: "metrics-secret",
  corsOrigins: [],
  trustProxy: false,
  rateAuthPerMin: 1000,
  rateApiPerMin: 1000,
  queue: { startAfterSec: 30, minHumans: 1, tickMs: 1000 },
  lobbyIdleMinutes: 30,
};

export async function startTestApi(overrides: Partial<AppConfig> = {}): Promise<TestApi> {
  const clock = { now: 1_800_000_000_000 };
  const keys = KeyRing.generate(clock.now);
  const allocator = new FakeAllocator({ max: 4 });
  const push = new RecordingPush();
  const app = createApi({ config: { ...TEST_CONFIG, ...overrides }, db: openDb(":memory:"), keys, allocator, push, now: () => clock.now, log: () => {}, autoTick: false });
  const port = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const call: TestApi["call"] = async (method, path, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  return {
    app,
    allocator,
    push,
    keys,
    clock,
    base,
    call,
    async guest(nickname) {
      const res = await call<AuthResponse>("POST", "/v1/auth/guest", { body: { nickname } });
      if (res.status !== 201) throw new Error(`guest login failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    close: () => app.close(),
  };
}
