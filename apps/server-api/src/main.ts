// server-api entry point (MVP control plane, role "all": auth, lobby, queue, fleet, results).
//   pnpm --filter @twobullets/server-api dev
// Configuration: environment variables, see infra/.env.example. Signals: SIGHUP reloads the JWT key file,
// SIGTERM/SIGINT stop matches and exit.

import { createApi } from "./app";
import { KeyRing, readKeyFile, writeKeyFile } from "./auth/keyRing";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { FakeAllocator, type Allocator } from "./fleet/allocator";
import { LocalProcessAllocator } from "./fleet/localProcessAllocator";

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

const config = loadConfig();
const keyFile = readKeyFile(config.keysFile);
let keys: KeyRing;
if (keyFile !== null) {
  keys = new KeyRing(keyFile);
} else if (config.env === "production") {
  console.error(`[server-api] no JWT key file at ${config.keysFile}. Generate one: pnpm --filter @twobullets/server-api keys generate`);
  process.exit(2);
} else {
  keys = KeyRing.generate();
  writeKeyFile(config.keysFile, keys.toFile());
  log(`[keys] development: generated ${config.keysFile}`);
}

const db = openDb(config.dbFile);
const allocator: Allocator =
  config.allocator === "fake"
    ? new FakeAllocator({ max: config.match.maxMatches, urlTemplate: config.match.urlTemplate })
    : new LocalProcessAllocator({ ...config.match, log }, keys.agentJwks());

const app = createApi({ config, db, keys, allocator, log });
const port = await app.listen(config.port, config.host);
log(
  `[server-api] ${config.env} build ${config.build} on http://${config.host}:${port} | issuer ${config.publicUrl} | allocator ${config.allocator} ` +
    `(${config.match.maxMatches} matches, ports ${config.match.portMin}-${config.match.portMax}) | kid ${keys.activeKid}`,
);

process.on("SIGHUP", () => {
  try {
    const file = readKeyFile(config.keysFile);
    if (file === null) throw new Error("key file missing");
    app.reloadKeys(file);
  } catch (err) {
    log(`[keys] reload failed, keeping the old keys: ${err instanceof Error ? err.message : String(err)}`);
  }
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`[server-api] ${signal}: stopping matches and closing`);
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await app.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
