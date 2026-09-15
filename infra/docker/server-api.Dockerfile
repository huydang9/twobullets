# syntax=docker/dockerfile:1.7
# server-api image: the control plane (auth, lobby, queue, results) AND the match runtime it forks, because on the
# single-host MVP server-api plays the host agent (apps/server-api/src/fleet/localProcessAllocator.ts).
#   docker build -f infra/docker/server-api.Dockerfile -t twobullets-server-api .      (from the repo root)
# Runs TypeScript sources with Node 24 type stripping, like `pnpm dev`. A rolldown bundle (ADR 0005) would shrink the
# image later; not needed for an internal release.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
RUN npm install -g pnpm@11.20.0
WORKDIR /repo
# Manifests first so dependency layers cache across source changes.
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
    pnpm install --frozen-lockfile --prod --filter "@twobullets/server-api..." --filter "@twobullets/server-match..."

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TB_ENV=production \
    TB_API_HOST=0.0.0.0 \
    TB_API_PORT=8080 \
    TB_MATCH_BIND_HOST=0.0.0.0 \
    TB_DATA_DIR=/data \
    TB_TRUST_PROXY=1
WORKDIR /repo
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server-match ./apps/server-match
COPY apps/server-api ./apps/server-api
ARG TB_BUILD=dev
ENV TB_BUILD=${TB_BUILD}
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080 7400-7419
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "--import", "./apps/server-api/src/node/resolveHooks.ts", "apps/server-api/src/main.ts"]
