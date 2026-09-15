# syntax=docker/dockerfile:1.7
# "web" image: the client build (Vite) served by Caddy, which is also the HTTPS front door for the API and the match
# WebSockets (infra/caddy/Caddyfile). One image, so a deploy swaps client files and proxy config together.
#   docker build -f infra/docker/web.Dockerfile -t twobullets-web .
# Alternative: host the same `apps/client/dist` on Cloudflare Pages (docs/release/plan.md §4) and keep Caddy for API/WSS.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@11.20.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json apps/bot/
COPY apps/client/package.json apps/client/
COPY apps/server-api/package.json apps/server-api/
COPY apps/server-match/package.json apps/server-match/
COPY packages/contracts/package.json packages/contracts/
COPY packages/netcode/package.json packages/netcode/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@twobullets/client..."
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/client ./apps/client
# Empty = same origin as the page (Caddy proxies /v1). The front-door wave reads it as import.meta.env.VITE_TB_API_URL.
ARG VITE_TB_API_URL=
ENV VITE_TB_API_URL=${VITE_TB_API_URL}
RUN pnpm --filter @twobullets/client build

FROM caddy:2-alpine AS web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/client/dist /srv/client
