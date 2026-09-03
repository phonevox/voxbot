# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS base
WORKDIR /app

# ---- all deps (dev + prod), needed to compile ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- compile TypeScript, rewrite @/ aliases to relative paths ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN bun run build

# ---- production-only deps for the final image ----
FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# su-exec: lets the entrypoint start as root (needed to fix /app/logs ownership if it's a
# bind-mounted host directory), then drop to the unprivileged "node" user to actually run the app.
RUN apk add --no-cache su-exec

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Deliberately no USER here - the container starts as root so the entrypoint can chown
# /app/logs, then it execs the app as "node" itself. Don't run application code as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
