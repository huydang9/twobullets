#!/usr/bin/env bash
# JWT signing keys, run ON the server from /opt/twobullets. The key file lives in the tb_data volume
# (/data/keys/jwt-keys.json, mode 0600) and never leaves the server except in an encrypted backup.
#   ./keys.sh generate     first deploy only
#   ./keys.sh rotate       new signing key; old one keeps verifying; the API reloads it at once
#   ./keys.sh prune        drop retired keys older than 13 h (after a rotate)
#   ./keys.sh show
set -euo pipefail
cd "${TB_DEPLOY_DIR:-/opt/twobullets}"
CMD="${1:?usage: keys.sh generate|rotate|prune|show}"
CLI=(node --import ./apps/server-api/src/node/resolveHooks.ts apps/server-api/src/cli/keys.ts "$CMD")

if docker compose ps --status running --services 2>/dev/null | grep -qx server; then
  docker compose exec -T server "${CLI[@]}"
  if [[ "$CMD" == "rotate" || "$CMD" == "prune" ]]; then
    docker compose kill -s HUP server
    echo "sent SIGHUP: the API reloaded the keys and pushed the JWKS to running matches"
  fi
else
  docker compose run --rm --no-deps server "${CLI[@]}"
fi
