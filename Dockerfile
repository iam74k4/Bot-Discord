# syntax=docker/dockerfile:1

# Node is pinned to an exact release so every environment runs the runtime CI
# tested. better-sqlite3 13 crashes (SIGSEGV) on Node 22.12, and a builder that
# picks "some 22.x" would make that a production lottery. Keep this in step
# with .nvmrc, package.json "engines" and the node-version in .github/workflows.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Toolchain for a native module that has no prebuilt binary for this platform
# and has to compile from source.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Exec form: node is PID 1 and receives SIGTERM itself, so a redeploy runs the
# graceful shutdown (final backup, closing VC sessions). The data volume is
# mounted at /app/data.
CMD ["node", "dist/index.js"]
