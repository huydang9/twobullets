# syntax=docker/dockerfile:1.7
# Standalone match server. Not used by the single-host production compose (server-api forks match processes itself);
# kept for the local arena smoke (`--mode=local`, dev tokens) and for a future remote game host / burst provider
# (`--mode=single-match`, later `--mode=agent`).
#   docker build -f infra/docker/server-match.Dockerfile -t twobullets-server-match .
#   docker run --rm -p 7350:7350 twobullets-server-match                          (local arena, NEVER expose publicly:
#                                                                                   /dev/token mints join tokens)

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
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
    pnpm install --frozen-lockfile --prod --filter "@twobullets/server-match..."

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server-match ./apps/server-match
USER node
EXPOSE 7350
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7350/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "--import", "./apps/server-match/src/node/resolveHooks.ts", "apps/server-match/src/main.ts"]
CMD ["--mode=local", "--host=0.0.0.0", "--port=7350", "--metrics=off"]
