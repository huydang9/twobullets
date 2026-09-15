// Local stack for the front door and networked matches (docs/release/local-stack.md):
//   pnpm stack:dev [-- --fast] [-- --api-only]
// Starts server-api (process allocator: one `server-match --mode=agent` per match, dev JWT keys generated on first run)
// and the Vite dev server, prefixes their output, and stops both (and their match processes) on Ctrl+C or when either
// exits. No `timeout` on macOS: this script ends itself.
//   --fast       short warmup and a faster zone for quick local matches (server-match --warmup-seconds, --time-scale)
//   --api-only   server-api without Vite (run `pnpm dev` yourself)

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const fast = args.has("--fast");
const apiOnly = args.has("--api-only");
const API_PORT = process.env.TB_API_PORT ?? "8080";
const WEB_ORIGIN = "http://localhost:5173";
const STOP_GRACE_MS = 6000;

const FAST_MATCH_ARGS = "--warmup-seconds=20 --all-joined-seconds=5 --time-scale=0.35 --end-linger-seconds=6";

interface Child {
  readonly name: string;
  readonly process: ChildProcess;
  exited: boolean;
}

const children: Child[] = [];
let stopping = false;

function prefixLines(name: string, stream: NodeJS.ReadableStream, out: NodeJS.WriteStream): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) out.write(`[${name}] ${pending}\n`);
  });
}

function start(name: string, command: string, commandArgs: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Child {
  // Own process group, so a stop reaches grandchildren too (pnpm → vite, server-api → server-match).
  const child = spawn(command, commandArgs, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const entry: Child = { name, process: child, exited: false };
  prefixLines(name, child.stdout!, process.stdout);
  prefixLines(name, child.stderr!, process.stderr);
  child.on("exit", (code, signal) => {
    entry.exited = true;
    console.log(`[stack] ${name} exited (${signal ?? code})`);
    if (!stopping) void stop(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`[stack] ${name} failed to start: ${error.message}`);
    entry.exited = true;
    if (!stopping) void stop(1);
  });
  children.push(entry);
  return entry;
}

function signalGroup(child: Child, signal: NodeJS.Signals): void {
  if (child.exited || child.process.pid === undefined) return;
  try {
    process.kill(-child.process.pid, signal);
  } catch {
    // Already gone.
  }
}

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("[stack] stopping…");
  for (const child of children) signalGroup(child, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (children.some((c) => !c.exited) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const child of children) signalGroup(child, "SIGKILL");
  process.exit(code);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

const apiEnv: NodeJS.ProcessEnv = {
  ...process.env,
  TB_ENV: "development",
  TB_API_PORT: API_PORT,
  TB_ALLOCATOR: process.env.TB_ALLOCATOR ?? "process",
  TB_CORS_ORIGINS: process.env.TB_CORS_ORIGINS ?? WEB_ORIGIN,
  // Quick play starts with bots after this many seconds alone in the queue.
  TB_QUEUE_START_AFTER_SEC: process.env.TB_QUEUE_START_AFTER_SEC ?? (fast ? "5" : "15"),
  TB_MATCH_EXTRA_ARGS: [process.env.TB_MATCH_EXTRA_ARGS ?? "", fast ? FAST_MATCH_ARGS : ""].join(" ").trim(),
};
start("api", process.execPath, ["--import", "./src/node/resolveHooks.ts", "src/main.ts"], join(ROOT, "apps/server-api"), apiEnv);

if (!apiOnly) {
  start("web", process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@twobullets/client", "dev"], ROOT, { ...process.env, VITE_TB_API_URL: `http://localhost:${API_PORT}` });
}

console.log(
  `[stack] server-api http://localhost:${API_PORT} (allocator ${apiEnv.TB_ALLOCATOR}${fast ? ", fast matches" : ""})` +
    (apiOnly ? "" : ` · client ${WEB_ORIGIN}`) +
    " · Ctrl+C stops everything",
);
