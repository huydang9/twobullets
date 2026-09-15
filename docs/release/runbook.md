# Release runbook

Single Ubuntu 24.04 VPS (SG) running Docker Compose with two containers:
- `web`: Caddy (TLS, static client, `/v1` API and match WebSocket proxy)
- `server`: server-api, which forks one `server-match --mode=agent` process per match on ports 7400–7419

Server directory: `/opt/twobullets`. Images come from `ghcr.io/<owner>/twobullets-{server-api,web}`. The deploy files are untested (not built on a machine with Docker yet).

## First deploy

**Prerequisites:**
- Docker installed.
- Ports 80/tcp, 443/tcp and 443/udp open.
- DNS `A` record for `play.<domain>` → VPS IP (Cloudflare proxy **off**; WebSockets go straight to Caddy).
- Clock in sync (token expiry depends on it).

```bash
# laptop: build and push images (release workflow on tag)
git tag v0.1.0 && git push origin v0.1.0
scp infra/docker-compose.yml infra/.env.example infra/scripts/{backup,keys}.sh <vps>:/opt/twobullets/

# vps
cd /opt/twobullets && mv .env.example .env && chmod 600 .env
$EDITOR .env          # TB_REGISTRY, TB_TAG, TB_DOMAIN, TB_ACME_EMAIL, TB_INVITE_CODE, TB_METRICS_TOKEN
docker login ghcr.io  # only if the packages are private (read:packages token)
docker compose pull
./keys.sh generate    # JWT signing keys in the tb_data volume
docker compose up -d && echo v0.1.0 >> .deploy-history
curl -s https://play.<domain>/readyz      # {"ok":true,...}
```

**Smoke test:**
1. Log in with the invite code.
2. Create a lobby (Map v1, bots on) and start a match.
3. Reload mid-match and check **Vào lại trận** (rejoin).

**Nightly backup:** add `30 3 * * * /opt/twobullets/backup.sh >> /opt/twobullets/backup.log 2>&1` to crontab.

### Alternative: build on the server from the repo (no registry)

```bash
cd /opt/twobullets
git clone https://github.com/huydang9/twobullets.git src
cp src/infra/docker-compose.yml . && cp src/infra/compose.build.override.yml docker-compose.override.yml
cp src/infra/.env.example .env && chmod 600 .env   # TB_REGISTRY=local, TB_TAG=main (image tag label)
cp src/infra/scripts/{backup,keys}.sh . && chmod +x backup.sh keys.sh
docker compose build          # web build runs Vite: needs ~2–4 GB free RAM
./keys.sh generate && docker compose up -d
# update:  git -C src pull && docker compose build && docker compose up -d
# rollback: git -C src checkout <good-tag> && docker compose build && docker compose up -d
```

## Key `.env` settings

| Var | Meaning |
|---|---|
| `TB_TAG` | Image tag; `web` and `server` must run the same one, or clients get HTTP 426 "reload" |
| `TB_INVITE_CODE` | Required at guest login; empty means open |
| `TB_MAX_MATCHES` | Concurrent matches (~0.3 vCPU and ~250 MB per 20-player match); 4–6 on 4 vCPU / 8 GB |
| `TB_MATCH_PORT_MIN/MAX` | Must stay inside 7400–7499 (Caddyfile) and the compose `expose` range |
| `TB_SERVER_MEMORY_LIMIT` | Cap for the API plus all match processes |
| `TB_MATCH_READY_TIMEOUT_MS` | Raise on a slow VPS if allocation times out |
| `TB_CORS_ORIGINS` | Only if the client is served from another origin |

## Update / rollback

```bash
git tag v0.2.0 && git push origin v0.2.0
TB_DEPLOY_SSH=deploy@play.<domain> infra/scripts/deploy.sh v0.2.0     # refuses while a match runs unless --force
TB_DEPLOY_SSH=deploy@play.<domain> infra/scripts/deploy.sh rollback    # previous tag in .deploy-history
```

A restart ends running matches and clears lobbies and queues (they are in memory). Accounts and results persist in SQLite.

## Operate

```bash
docker compose logs -f --tail=200 server     # API + "[match m_…]" lines
docker compose logs -f web                   # Caddy, ACME
docker stats --no-stream
docker compose exec -T server node -e "fetch('http://127.0.0.1:8080/metrics',{headers:{authorization:'Bearer '+process.env.TB_METRICS_TOKEN}}).then(r=>r.text()).then(console.log)" | grep '^tb_'
```

Metrics to watch:
- `tb_matches_live`
- `tb_match_tick_work_p99_ms_max` (keep under ~8 ms)
- `tb_allocation_failures_total`
- `tb_allocator_slots`

For uptime monitoring, point a monitor at `/readyz`.

**Backups:**
- `backup.sh` does a `VACUUM INTO` of `/data/twobullets.sqlite` into `backups/`, gzipped, and keeps 14 days.
- To restore:
  1. `docker compose stop server`.
  2. Copy the unzipped file to `/data/twobullets.sqlite` in the `tb_data` volume (remove the `-wal`/`-shm` files, owner `node`).
  3. `docker compose up -d server`.

**Signing keys:**
- **Routine rotation:** `./keys.sh rotate` (reloads the API and pushes JWKS to matches), then `./keys.sh prune` after 13 h.
- **On a leak:**
  1. Rotate.
  2. Prune immediately with `--min-age-hours=0`.
  3. Send `docker compose kill -s HUP server`.
  4. Also change `TB_INVITE_CODE` and `TB_METRICS_TOKEN`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| TLS or site down | DNS points at this IP, proxy off; ports 80/443 open; `docker compose logs web \| grep -i acme` |
| "Servers busy" | `tb_allocator_slots`, `docker stats`; raise `TB_MAX_MATCHES` or use a bigger host |
| Start/queue fails (`internal`) | `logs server \| grep 'allocation failed'` and the `[match …]` lines; `TB_MATCH_READY_TIMEOUT_MS` |
| Rubber-banding | `tb_match_tick_work_p99_ms_max`, CPU steal (`top` `st`); fewer matches per host or dedicated vCPU |
| Mass disconnect | `docker compose ps` restarts, `dmesg \| grep -i oom`; tune `TB_MAX_MATCHES` or `TB_SERVER_MEMORY_LIMIT` |
| Reload loop (426) | `web` and `server` tags differ |

## Known MVP gaps (before inviting players)

- No landing or glide.
- No loot or networked equipment: everyone has a rifle and pistol.
- Teammate health and revive progress aren't replicated.
- Reconnect lands on the menu with rejoin.

See `plan.md` for milestones B3/B5/B7/B8.
