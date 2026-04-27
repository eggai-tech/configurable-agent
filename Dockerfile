# syntax=docker/dockerfile:1.7

# Build context must be the repo root, not wally/, because wally now
# depends on the @eggai-tech/mo workspace package. Build command:
#
#   docker build -f wally/Dockerfile -t wally:dev .

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY mo/package.json ./mo/
COPY wally/package.json ./wally/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter wally... --filter @eggai-tech/mo...

FROM deps AS build
COPY mo ./mo
COPY wally ./wally
RUN pnpm --filter @eggai-tech/mo build \
 && pnpm --filter wally build
# Flatten wally + its prod workspace deps into a self-contained tree
# that doesn't need pnpm at runtime. inject-workspace-packages=true is
# required by pnpm v10 to deploy workspace deps (without it, only the
# --legacy code path works, which has known bin-linking quirks).
RUN pnpm --filter wally deploy \
      --prod \
      --config.inject-workspace-packages=true \
      /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_PATH=/etc/wally/config.yaml
COPY --from=build /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js", "serve"]
