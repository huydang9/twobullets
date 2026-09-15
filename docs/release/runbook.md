# Runbook: deploy and operate the internal release

- **Setup:** one Ubuntu 24.04 VPS in Singapore, Docker Compose, two containers (`web` = Caddy + client, `server` = server-api + match processes). Why this shape: [plan.md](plan.md) §4.
- **Files on the server:** `/opt/twobullets/{docker-compose.yml, .env, backup.sh, keys.sh, backups/, .deploy-history}`.
- **Conventions:** `you@laptop$` runs on your computer, `deploy@vps$` on the server. Replace `play.example.com`, `ghcr.io/your-github-name` and IPs with yours. Never paste secrets into chats, issues or commits.

## 0. Local smoke (optional, on a machine with Docker and ≥ 8 GB free RAM)

```bash
you@laptop$ docker compose -f infra/compose.local.yml up --build     # first build takes several minutes
you@laptop$ curl http://localhost:8080/v1/version
you@laptop$ curl -X POST http://localhost:8080/v1/auth/guest -H 'content-type: application/json' -d '{"nickname":"Smoke"}'
you@laptop$ docker compose -f infra/compose.local.yml down           # add -v to wipe the local database
```

It uses `TB_ALLOCATOR=fake` (no game servers) until server-match has `--mode=agent`; then run with `TB_ALLOCATOR=process docker compose -f infra/compose.local.yml up --build` and play at http://localhost:8080.

Without Docker, the same API runs from sources: `TB_ALLOCATOR=fake pnpm --filter @twobullets/server-api dev` (data in `apps/server-api/.data`).

## 1. First deploy

### 1.1 Buy and reach the server

1. Order an OVHcloud **VPS-2** in **Singapore** with **Ubuntu 24.04**, and paste your SSH public key (`cat ~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if missing).
2. Note the IPv4 address from the OVH panel.
3. `you@laptop$ ssh ubuntu@<IP>` (the OVH default user may be `ubuntu`).

### 1.2 Harden it (once)

```bash
ubuntu@vps$ sudo apt update && sudo apt -y upgrade && sudo apt -y install ufw unattended-upgrades fail2ban curl
ubuntu@vps$ sudo adduser --disabled-password --gecos "" deploy
ubuntu@vps$ sudo mkdir -p /home/deploy/.ssh && sudo cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && sudo chown -R deploy:deploy /home/deploy/.ssh && sudo chmod 700 /home/deploy/.ssh
# SSH: keys only, no root login
ubuntu@vps$ sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config && sudo systemctl restart ssh
# Firewall: SSH, HTTP (certificate challenge + redirect), HTTPS over TCP and UDP (HTTP/3)
ubuntu@vps$ sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw --force enable
ubuntu@vps$ sudo timedatectl set-timezone UTC && timedatectl   # "System clock synchronized: yes" matters for token expiry
```

Docker publishes ports by editing iptables directly and ignores ufw. That's fine here: compose publishes only 80 and 443.

### 1.3 Install Docker

```bash
ubuntu@vps$ curl -fsSL https://get.docker.com | sudo sh
ubuntu@vps$ sudo usermod -aG docker deploy
ubuntu@vps$ sudo mkdir -p /opt/twobullets && sudo chown deploy:deploy /opt/twobullets
ubuntu@vps$ exit
you@laptop$ ssh deploy@<IP> docker version        # works without sudo
```

### 1.4 Domain and DNS

1. In Cloudflare → your domain → DNS → **Add record**: type `A`, name `play`, IPv4 = the VPS IP, proxy status **DNS only** (grey cloud).
2. Wait until `you@laptop$ dig +short play.example.com` prints the IP.

### 1.5 Images

The `release` workflow pushes `ghcr.io/<owner>/twobullets-server-api` and `twobullets-web` when you push a tag:

```bash
you@laptop$ git tag v0.1.0 && git push origin v0.1.0
```

Watch GitHub → Actions → release. If the packages are **private**, create a GitHub token with only `read:packages` and log the server in once:

```bash
deploy@vps$ docker login ghcr.io -u <github-name>      # paste the read-only token when asked; it is stored in ~/.docker/config.json
```

### 1.6 Configuration and secrets

```bash
you@laptop$ scp infra/docker-compose.yml infra/.env.example infra/scripts/backup.sh infra/scripts/keys.sh deploy@<IP>:/opt/twobullets/
you@laptop$ ssh deploy@<IP>
deploy@vps$ cd /opt/twobullets && mv .env.example .env && chmod 600 .env && chmod +x backup.sh keys.sh
deploy@vps$ openssl rand -hex 24     # run twice: one value for TB_INVITE_CODE (or a friendlier word), one for TB_METRICS_TOKEN
deploy@vps$ nano .env                # set TB_REGISTRY, TB_TAG=v0.1.0, TB_DOMAIN, TB_ACME_EMAIL, TB_INVITE_CODE, TB_METRICS_TOKEN
deploy@vps$ docker compose pull
deploy@vps$ ./keys.sh generate       # creates /data/keys/jwt-keys.json in the tb_data volume (mode 600)
```

### 1.7 Start

```bash
deploy@vps$ docker compose up -d
deploy@vps$ docker compose ps                         # both "running", server "healthy"
deploy@vps$ echo v0.1.0 >> .deploy-history
deploy@vps$ curl -s https://play.example.com/readyz   # {"ok":true,...,"checks":{"db":true,"keys":true}}
```

Caddy gets the Let's Encrypt certificate on the first HTTPS request (a few seconds). If it fails, check that DNS points at this IP and ports 80/443 are open: `docker compose logs web | grep -i acme`.

### 1.8 Smoke test

1. Open `https://play.example.com` in Chrome, log in with a nickname and the invite code.
2. Create a lobby (duo, 10 players, Map v1, bots on) → Start → play a minute.
3. Reload the tab → you are back in the match (reconnect).
4. From a phone on mobile data, open the site and join your lobby by code.

### 1.9 Backups (install now)

```bash
deploy@vps$ crontab -e
30 3 * * * /opt/twobullets/backup.sh >> /opt/twobullets/backup.log 2>&1
deploy@vps$ ./backup.sh && ls -lh backups/
```

## 2. Update deploy

```bash
you@laptop$ git tag v0.2.0 && git push origin v0.2.0                   # wait for the release workflow to go green
you@laptop$ TB_DEPLOY_SSH=deploy@play.example.com infra/scripts/deploy.sh v0.2.0
```

What `deploy.sh` does: uploads `docker-compose.yml`; refuses if a match is running (add `--force` to override); sets `TB_TAG` in `.env`; `docker compose pull` and `up -d`; waits up to 60 s for `/readyz`; records the tag in `.deploy-history`.

Or: GitHub → Actions → release → **Run workflow** on the tag with "Deploy" ticked (needs the `production` environment secrets from plan.md §5).

**What players notice:** the `server` container restarts, so running matches end (the script prevents that unless forced) and lobbies/queue tickets are forgotten (they live in memory). Accounts and results are in SQLite and survive. Clients with an older protocol get "reload the page" (HTTP 426).

## 3. Everyday checks

```bash
deploy@vps$ cd /opt/twobullets
deploy@vps$ docker compose ps
deploy@vps$ docker stats --no-stream                              # CPU / memory per container
deploy@vps$ docker compose exec -T server node -e "fetch('http://127.0.0.1:8080/metrics',{headers:{authorization:'Bearer '+process.env.TB_METRICS_TOKEN}}).then(r=>r.text()).then(console.log)" | grep '^tb_'
```

Metrics worth a glance: `tb_matches_live`, `tb_match_players_connected`, `tb_match_tick_work_p99_ms_max` (keep under ~8 ms), `tb_allocation_failures_total`, `tb_http_requests_total{status="5xx"}`, `tb_allocator_slots`.

Free uptime check: point any free HTTP monitor (for example UptimeRobot or Better Stack) at `https://play.example.com/readyz`.

## 4. Rollback

```bash
you@laptop$ TB_DEPLOY_SSH=deploy@play.example.com infra/scripts/deploy.sh rollback      # previous tag from .deploy-history
```

By hand on the server: `nano .env` → set `TB_TAG` to the last good tag → `docker compose pull && docker compose up -d`.

If the bad release changed the database in a way the old version can't read (migrations are meant to be additive, so this should not happen): stop the server, restore the backup taken before the release (§6), then roll back.

## 5. Logs

```bash
deploy@vps$ docker compose logs -f --tail=200 server        # API + every match process ("[match m_…]" prefix)
deploy@vps$ docker compose logs -f --tail=200 web           # Caddy access log (JSON), TLS certificate events
deploy@vps$ docker compose logs --since=2h server | grep -E 'allocation failed|exited|ERR|failed'
```

Logs rotate at 5 × 10 MB per container. A match that crashed shows `exited: signal …` or `exit <code>` and is stored as `aborted`.

## 6. Backups and restore

- **What:** the SQLite database (`/data/twobullets.sqlite`: accounts, match results). Lobbies and queues are in memory and are not backed up. The JWT key file is a secret: if lost, generate a new one (everyone just logs in again with a new token; refresh secrets still work).
- **Nightly:** `backup.sh` makes a consistent copy with `VACUUM INTO` while the server runs, gzips it into `/opt/twobullets/backups/`, keeps 14 days.
- **Off the server** (weekly or before risky releases): `you@laptop$ scp 'deploy@play.example.com:/opt/twobullets/backups/*.gz' ~/twobullets-backups/`
- **Restore:**

  ```bash
  deploy@vps$ cd /opt/twobullets && docker compose stop server
  deploy@vps$ gunzip -k backups/twobullets-20260915T033000Z.sqlite.gz
  deploy@vps$ docker compose run --rm --no-deps --user root -v "$PWD/backups:/restore:ro" server sh -c \
    'cp /restore/twobullets-20260915T033000Z.sqlite /data/twobullets.sqlite && rm -f /data/twobullets.sqlite-wal /data/twobullets.sqlite-shm && chown node:node /data/twobullets.sqlite'
  deploy@vps$ docker compose up -d server && curl -s https://play.example.com/readyz
  ```

## 7. Rotate the signing keys

Every ~90 days, or immediately if the server or the key file may have leaked:

```bash
deploy@vps$ cd /opt/twobullets
deploy@vps$ ./keys.sh rotate      # new active key; the API reloads (SIGHUP) and pushes the JWKS to running matches
deploy@vps$ ./keys.sh show
# 13 hours later (all old access tokens have expired):
deploy@vps$ ./keys.sh prune
```

**Suspected leak:** `rotate`, then `prune` straight away with `docker compose exec -T server node --import ./apps/server-api/src/node/resolveHooks.ts apps/server-api/src/cli/keys.ts prune --min-age-hours=0` and `docker compose kill -s HUP server`. Everyone's access token stops working; the client logs them in again with the stored refresh secret. Also rotate `TB_INVITE_CODE` and `TB_METRICS_TOKEN` in `.env` and `docker compose up -d`.

## 8. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Site doesn't load / certificate error | `dig +short play.example.com`; `docker compose logs web \| grep -i acme` | DNS must point here, grey cloud; ports 80/443 open; wait out Let's Encrypt rate limits (1 h) |
| Login says "wrong invite code" | `.env` `TB_INVITE_CODE` | `docker compose up -d` after editing `.env` |
| "All servers are busy" | `tb_allocator_slots`, `docker stats` | Raise `TB_MAX_MATCHES` if CPU/RAM allow (and keep ports inside 7400–7419), or a bigger VPS |
| Start/queue fails with `internal` | `docker compose logs server \| grep 'allocation failed'` | Match process crashed or took > 30 s to boot: see its `[match …]` lines; raise `TB_MATCH_READY_TIMEOUT_MS` on a slow VPS |
| Players rubber-band | `tb_match_tick_work_p99_ms_max`, `docker stats`, `top` steal time (`st`) | Fewer matches per host, or dedicated vCPUs (plan.md §4.3) |
| Everyone disconnected at once | `docker compose ps` (restarts?), `dmesg \| grep -i oom` | Memory limit hit: lower `TB_MAX_MATCHES` or raise `TB_SERVER_MEMORY_LIMIT` below the VPS RAM |
| Disk full | `df -h`, `docker system df` | `docker image prune -a` (keeps running images), delete old backups |
| "Reload the page" loop | `/v1/version` vs the client build | `web` and `server` must run the same `TB_TAG` |
