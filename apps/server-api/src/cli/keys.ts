// JWT signing key management (docs/release/runbook.md "Rotate keys").
//   pnpm --filter @twobullets/server-api keys generate [--file=path] [--force]
//   pnpm --filter @twobullets/server-api keys rotate   [--file=path]
//   pnpm --filter @twobullets/server-api keys prune    [--file=path] [--min-age-hours=13]
//   pnpm --filter @twobullets/server-api keys show     [--file=path]
// The file defaults to $TB_JWT_KEYS_FILE, else $TB_DATA_DIR/keys/jwt-keys.json. After rotate/prune, send SIGHUP to the
// API (docker compose kill -s HUP server) so it reloads and pushes the JWKS to running matches.

import { ACCESS_TOKEN_TTL_SEC } from "@twobullets/contracts/claims";
import { KeyRing, readKeyFile, writeKeyFile } from "../auth/keyRing";
import { loadConfig } from "../config";

const [command, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.map((a) => /^--([^=]+)(?:=(.*))?$/.exec(a)).filter((m) => m !== null).map((m) => [m[1]!, m[2] ?? "true"]));
const file = flags.file ?? loadConfig().keysFile;

function load(): KeyRing {
  const f = readKeyFile(file);
  if (f === null) {
    console.error(`no key file at ${file}; run "keys generate" first`);
    process.exit(2);
  }
  return new KeyRing(f);
}

function show(ring: KeyRing): void {
  for (const k of ring.toFile().keys) {
    const age = ((Date.now() - k.createdAt) / 86_400_000).toFixed(1);
    console.log(`${k.status.padEnd(7)} ${k.kid}  created ${new Date(k.createdAt).toISOString()} (${age} d)${k.retiredAt ? `  retired ${new Date(k.retiredAt).toISOString()}` : ""}`);
  }
}

switch (command) {
  case "generate": {
    if (readKeyFile(file) !== null && flags.force !== "true") {
      console.error(`${file} already exists; use "rotate", or --force to overwrite (breaks every issued token)`);
      process.exit(2);
    }
    const ring = KeyRing.generate();
    writeKeyFile(file, ring.toFile());
    console.log(`wrote ${file}`);
    show(ring);
    break;
  }
  case "rotate": {
    const ring = load();
    const kid = ring.rotate();
    writeKeyFile(file, ring.toFile());
    console.log(`new active key ${kid}; reload the API (SIGHUP), then prune after ${Math.ceil(ACCESS_TOKEN_TTL_SEC / 3600)} h`);
    show(ring);
    break;
  }
  case "prune": {
    const ring = load();
    const hours = Number(flags["min-age-hours"] ?? String(Math.ceil(ACCESS_TOKEN_TTL_SEC / 3600) + 1));
    const removed = ring.prune(hours * 3_600_000);
    writeKeyFile(file, ring.toFile());
    console.log(removed.length ? `removed ${removed.join(", ")}; reload the API (SIGHUP)` : "nothing to prune");
    show(ring);
    break;
  }
  case "show":
    show(load());
    break;
  default:
    console.error("usage: keys generate|rotate|prune|show [--file=path]");
    process.exit(2);
}
