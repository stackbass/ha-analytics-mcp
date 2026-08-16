# syntax=docker/dockerfile:1

# ─── Stage 1: Build ─────────────────────────────────────────────────────────
# Pure-JS dependency tree (no native addons), so no build toolchain
# (python3/make/g++) is required even on Alpine.
FROM node:24-alpine AS builder

WORKDIR /app

# Install all dependencies (dev + prod) so we can compile with tsc. Copying
# only the manifests first lets Docker cache this layer across source-only
# changes.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production-only dependencies, installed fresh (not copied from the builder)
# so the image never carries typescript/vitest/eslint or their transitive deps.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# npm is only needed for the install above; the runtime is `node dist/index.js`.
# The npm client bundles its own copy of undici, which periodically carries
# CVEs the base image is slow to pick up — remove the whole client from the
# final filesystem rather than track advisories for a tool we never run.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist
COPY NOTICE ./

# node:24-alpine ships an unprivileged "node" user (uid/gid 1000) — reuse it
# rather than creating a new one.
USER node

# stdio is the default transport (no listening socket needed). --http starts
# the streamable HTTP transport; the container-relevant bits are:
#
#   - HOST defaults to 127.0.0.1 (loopback), which is unreachable from outside
#     the container's own network namespace — i.e. useless when containerized.
#   - Binding to a non-loopback HOST (e.g. 0.0.0.0, required to publish the
#     port with `-p`) is refused unless MCP_HTTP_TOKEN is set — the server
#     enforces this itself, by design, to avoid an unauthenticated HA proxy
#     accidentally exposed on the network.
#
# So HTTP mode needs, at minimum:
#   docker run -p 3000:3000 -e HA_URL=... -e HA_TOKEN=... \
#     -e HOST=0.0.0.0 -e MCP_HTTP_TOKEN=$(openssl rand -hex 32) \
#     ghcr.io/ffleurey/ha-analytics-mcp --http
EXPOSE 3000

LABEL org.opencontainers.image.source="https://github.com/ffleurey/ha-analytics-mcp"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.description="Historical data analytics MCP server for Home Assistant: statistics, trends and session detection computed server-side, designed for small local models"

ENTRYPOINT ["node", "dist/index.js"]
