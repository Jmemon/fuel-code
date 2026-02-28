# =============================================================================
# Stage 1: Install dependencies and stamp build info
# =============================================================================
FROM oven/bun:1 AS builder
WORKDIR /app

# Accept git metadata as build args — .git is excluded by .dockerignore,
# so the stamp script cannot run git commands. The caller passes these:
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) ...
ARG GIT_SHA=unknown
ARG GIT_SHORT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown

# Railway auto-injects these during builds — declare as ARG so the stamp
# script can use them as fallbacks when GIT_SHA/GIT_BRANCH aren't set.
ARG RAILWAY_GIT_COMMIT_SHA
ARG RAILWAY_GIT_BRANCH

# Copy package manifests + lockfile first for layer caching.
# All workspace members must be listed so bun install resolves workspace: refs.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/hooks/package.json packages/hooks/
RUN bun install --frozen-lockfile

# Copy all source (respects .dockerignore — no .git, no node_modules)
COPY . .

# Stamp version using build args (env vars override git commands in the script).
# RAILWAY_GIT_COMMIT_SHA and RAILWAY_GIT_BRANCH are passed through as fallbacks
# for Railway deployments where GIT_SHA/GIT_BRANCH aren't explicitly set.
RUN GIT_SHA=${GIT_SHA} GIT_SHORT=${GIT_SHORT} GIT_BRANCH=${GIT_BRANCH} BUILD_DATE=${BUILD_DATE} \
    RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA} RAILWAY_GIT_BRANCH=${RAILWAY_GIT_BRANCH} \
    bun run scripts/stamp-version.ts

# =============================================================================
# Stage 2: Production runtime (slim image)
# =============================================================================
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Copy the full workspace from builder (bun runs TS directly, no compile step needed)
COPY --from=builder /app /app

EXPOSE 3020

# Health check hits the lightweight health-check script.
# bun is available in the slim image. fetch() is built into bun — no curl needed.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun run packages/server/src/health-check.ts || exit 1

# Start the server — migrations run automatically on startup (see db/migrator.ts)
CMD ["bun", "run", "packages/server/src/index.ts"]
