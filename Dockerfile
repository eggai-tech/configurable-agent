# syntax=docker/dockerfile:1.7
# Standalone build — configurable-agent has no workspace dependencies.
# Earlier versions of this Dockerfile assumed a sibling workspace package
# was required at build time; that is no longer the case (verify via
# `pnpm ls --depth -1` from this directory: no workspace siblings).
#
# Build command:
#   docker build -t eggai-configurable-agent:dev .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY package.json pnpm-lock.yaml ./
# pnpm-workspace.yaml is consulted by pnpm even in single-project mode for
# supply-chain settings (minimumReleaseAge); copy if present.
COPY pnpm-workspace.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_PATH=/etc/configurable-agent/config.yaml
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js", "serve"]
