# Release runbook

One VPS, Docker Compose, built from this repo. The app listens on `127.0.0.1:8081`; the host's nginx handles TLS and proxies to it (WebSockets included).

- `web`: Caddy, serving the client plus `/v1` API and `/gs/<port>` match WebSockets, over plain HTTP.
- `server`: server-api, which forks one match process per match (ports 7400–7409, internal only).

## First deploy

**Prerequisites:**
- Docker and nginx are installed.
- DNS `A` record `twobullets.huydang.me` points to the VPS (Cloudflare proxy off).
- About 3 GB of free RAM for the build (the Vite build is heavy). Add swap on small hosts.

```bash
git clone https://github.com/huydang9/twobullets.git && cd twobullets/infra
cp .env.example .env && chmod 600 .env && $EDITOR .env     # TB_METRICS_TOKEN=$(openssl rand -hex 24), TB_INVITE_CODE
docker compose up -d --build
scripts/keys.sh generate && docker compose restart server
curl -s http://127.0.0.1:8081/readyz                        # {"ok":true,...}

cp nginx/twobullets.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/twobullets.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d twobullets.huydang.me
```

Then open https://twobullets.huydang.me, log in, create a room with bots, and start a match.

## Update

```bash
cd twobullets && git pull && cd infra && docker compose up -d --build
```

The restart ends any running matches and clears lobbies. Accounts and results survive in the `tb_data` volume.

To roll back: `git checkout <good-commit> && docker compose up -d --build`.

## Operate

| Task | Command |
|---|---|
| Logs | `docker compose logs -f --tail=200 server` (API and `[match …]` lines), `docker compose logs -f web` |
| Status | `docker compose ps`, `docker stats --no-stream` |
| Backup (cron) | `30 3 * * * /path/to/twobullets/infra/scripts/backup.sh` → `infra/backups/`, 14 days |
| Rotate keys | `scripts/keys.sh rotate`, then `scripts/keys.sh prune` after 13 h |

## Troubleshooting

| Symptom | Check |
|---|---|
| 502 from nginx | `docker compose ps`; `curl 127.0.0.1:8081/readyz` |
| Stuck on "Đang vào trận…" | `docker compose logs server \| grep -i 'allocation\|match'`; raise `TB_MATCH_READY_TIMEOUT_MS` on a slow host |
| WebSocket drops | Check that the nginx site has the `Upgrade`/`Connection` headers and `proxy_read_timeout 1h` |
| Out of memory | `dmesg \| grep -i oom`; lower `TB_MAX_MATCHES` or `TB_SERVER_MEMORY_LIMIT`, add swap |
| "Reload the page" loop | Rebuild both containers from the same commit (`up -d --build`) |

## Known MVP gaps

- No landing or glide.
- No loot online: everyone has a rifle and pistol.
- Teammates' health and revive progress aren't shown.
- Reconnect lands on the menu with "Vào lại trận".
