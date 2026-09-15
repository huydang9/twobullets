#!/usr/bin/env bash
# Deploy (or roll back) a tagged release to the VPS over SSH. Runs from your laptop or GitHub Actions.
#   infra/scripts/deploy.sh v0.2.0                 deploy tag v0.2.0
#   infra/scripts/deploy.sh rollback               go back to the previously deployed tag
#   infra/scripts/deploy.sh v0.2.0 --force         deploy even while matches are running (they are cut off)
# Env: TB_DEPLOY_SSH (e.g. deploy@play.example.com, required), TB_DEPLOY_DIR (default /opt/twobullets).
# The server keeps .env (with TB_TAG) and .deploy-history (one tag per line) in TB_DEPLOY_DIR.
set -euo pipefail

TARGET="${TB_DEPLOY_SSH:?set TB_DEPLOY_SSH, e.g. deploy@play.example.com}"
DIR="${TB_DEPLOY_DIR:-/opt/twobullets}"
TAG="${1:?usage: deploy.sh <tag>|rollback [--force]}"
FORCE="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ "$TAG" != "rollback" && ! "$TAG" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)?|sha-[0-9a-f]{7,40})$ ]]; then
  echo "tag must look like v1.2.3 or sha-abc1234" >&2
  exit 2
fi

echo "→ uploading docker-compose.yml to $TARGET:$DIR"
scp -q "$HERE/../docker-compose.yml" "$TARGET:$DIR/docker-compose.yml"

# shellcheck disable=SC2087
ssh "$TARGET" bash -s -- "$DIR" "$TAG" "$FORCE" <<'REMOTE'
set -euo pipefail
DIR="$1"; TAG="$2"; FORCE="$3"
cd "$DIR"
touch .deploy-history
CURRENT="$(grep -E '^TB_TAG=' .env | cut -d= -f2-)"

if [[ "$TAG" == "rollback" ]]; then
  TAG="$(grep -vx "$CURRENT" .deploy-history | tail -n 1 || true)"
  [[ -n "$TAG" ]] || { echo "no previous tag in .deploy-history" >&2; exit 1; }
  echo "→ rolling back $CURRENT → $TAG"
fi

if [[ "$FORCE" != "--force" ]] && docker compose ps --status running --services 2>/dev/null | grep -qx server; then
  LIVE="$(docker compose exec -T server node -e "fetch('http://127.0.0.1:8080/metrics',{headers:{authorization:'Bearer '+(process.env.TB_METRICS_TOKEN||'')}}).then(r=>r.text()).then(t=>{const m=t.match(/tb_matches_live\{status=\"running\"\} (\d+)/);console.log(m?m[1]:0)},()=>console.log(0))" || echo 0)"
  if [[ "${LIVE:-0}" != "0" ]]; then
    echo "✗ $LIVE match(es) running. Wait for them to end, or re-run with --force." >&2
    exit 1
  fi
fi

sed -i.bak "s/^TB_TAG=.*/TB_TAG=$TAG/" .env
echo "→ pulling $TAG"
docker compose pull --quiet
echo "→ starting"
docker compose up -d --remove-orphans

DOMAIN="$(grep -E '^TB_DOMAIN=' .env | cut -d= -f2-)"
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/readyz" >/dev/null 2>&1; then
    echo "✓ $TAG is live at https://$DOMAIN"
    [[ "$(tail -n 1 .deploy-history)" == "$TAG" ]] || echo "$TAG" >> .deploy-history
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done
echo "✗ https://$DOMAIN/readyz did not come up in 60 s. Logs: docker compose logs --tail=100 server web" >&2
echo "  Roll back with: infra/scripts/deploy.sh rollback" >&2
exit 1
REMOTE
