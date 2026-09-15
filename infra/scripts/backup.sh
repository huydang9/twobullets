#!/usr/bin/env bash
# Consistent SQLite backup, run ON the server (cron: 30 3 * * * <repo>/infra/scripts/backup.sh).
# Uses `VACUUM INTO` through Node's built-in sqlite inside the running container, so it is safe while players play.
# Keeps 14 daily copies in $DIR/backups. Copy them off the server too (see docs/release/runbook.md "Backups").
set -euo pipefail

DIR="${TB_DEPLOY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
KEEP_DAYS="${TB_BACKUP_KEEP_DAYS:-14}"
cd "$DIR"
mkdir -p backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="twobullets-$STAMP.sqlite"

docker compose exec -T server node -e "
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  fs.mkdirSync('/data/backups', { recursive: true });
  const db = new DatabaseSync('/data/twobullets.sqlite');
  db.exec(\"VACUUM INTO '/data/backups/$NAME'\");
  db.close();
"
docker compose cp "server:/data/backups/$NAME" "backups/$NAME"
docker compose exec -T server rm -f "/data/backups/$NAME"
gzip -9 "backups/$NAME"
find backups -name 'twobullets-*.sqlite.gz' -mtime "+$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: backups/$NAME.gz ($(du -h "backups/$NAME.gz" | cut -f1))"
