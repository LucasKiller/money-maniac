# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.12.0
ARG PNPM_VERSION=10.28.1

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain
ARG PNPM_VERSION

# Install the repository-pinned package manager directly. This avoids relying
# on the Corepack trust database shipped by a particular Node image.
RUN npm install --global "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force

WORKDIR /app

FROM toolchain AS build

# better-sqlite3 may need to compile when a prebuilt binary is unavailable.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json vitest.config.ts constitution.md ./
COPY src ./src
COPY packages ./packages
RUN pnpm build

FROM toolchain AS production-dependencies

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOME=/home/automaton \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# tini forwards shutdown signals correctly. Git is required by the runtime's
# state-versioning subsystem; no Docker or host socket is included.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 automaton \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin automaton \
    && mkdir -p /app /home/automaton/.automaton \
    && chown -R automaton:automaton /app /home/automaton

WORKDIR /app

COPY --from=production-dependencies --chown=automaton:automaton /app/node_modules ./node_modules
COPY --from=build --chown=automaton:automaton /app/dist ./dist
COPY --from=build --chown=automaton:automaton /app/package.json ./package.json
COPY --from=build --chown=automaton:automaton /app/constitution.md ./constitution.md

USER automaton

VOLUME ["/home/automaton/.automaton"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "dist/index.js", "--status"]

ENTRYPOINT ["/usr/bin/tini", "--"]

# Safe by default: building or starting the image does not initialize a wallet,
# provision an account, perform a topup, or start the autonomous loop.
CMD ["node", "-e", "console.log('Automaton container is in safe-idle mode. Run setup explicitly, then set AUTOMATON_START_MODE=run in Compose.'); setInterval(() => {}, 2147483647)"]
