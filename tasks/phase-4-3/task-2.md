# Task 2: Production Dockerfile

## parallel-group: B
## depends-on: T1
## blocks: T3, T4

---

## Description

Create a multi-stage Dockerfile at the repo root that builds the entire monorepo and runs the server. Used by both Docker Compose (T3) and Railway (T4). Also creates a lightweight health check script for Docker's HEALTHCHECK directive.

**Critical edge case**: `.dockerignore` excludes `.git`, so `git rev-parse HEAD` cannot run inside the Docker build. The Dockerfile accepts git metadata as build args (`ARG GIT_SHA`, etc.) which are passed to the stamp script via environment variables.

---

## Relevant Files

### Create

**`Dockerfile`** — Multi-stage bun production build at repo root.

```dockerfile
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

# Stamp version using build args (env vars override git commands in the script)
RUN GIT_SHA=${GIT_SHA} GIT_SHORT=${GIT_SHORT} GIT_BRANCH=${GIT_BRANCH} BUILD_DATE=${BUILD_DATE} \
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
```

Key decisions:
- `oven/bun:1` (full) for builder, `oven/bun:1-slim` for runtime — smaller production image.
- `packages/hooks/package.json` is included because `hooks` is a workspace member (`workspaces: ["packages/*"]` in root `package.json`). Without it, `bun install --frozen-lockfile` fails on workspace resolution.
- `bun.lock` is explicitly copied for layer caching. Without it, `--frozen-lockfile` fails.
- No turbo needed — `stamp` is the only build-time script, and bun runs TypeScript directly at runtime.
- Build args default to `"unknown"` — the stamp script uses env var overrides when set.

---

**`.dockerignore`** — Controls what enters the Docker build context.

```
node_modules
.git
.claude
.turbo
logs
*.log
.env
.env.*
!.env.example
.DS_Store
*.tsbuildinfo
tasks
docs
human-resources
```

Key decisions:
- `.git` excluded — reduces build context size significantly. Git metadata is passed via build args instead.
- `node_modules` excluded — `bun install --frozen-lockfile` creates a clean install inside the container. This is the biggest win for build context size.
- Test files (`*.test.ts`, `__tests__/`) are NOT excluded — they're small and excluding them complicates COPY patterns. The runtime doesn't execute them.
- `tasks/`, `docs/`, `human-resources/` excluded — documentation, not needed at runtime.
- `.env.*` excluded with `!.env.example` exception — matches the `.gitignore` fix from T1.

---

**`packages/server/src/health-check.ts`** — Lightweight health check for Docker HEALTHCHECK.

```typescript
/**
 * Lightweight Docker HEALTHCHECK script.
 *
 * Hits /api/health and exits 0 (healthy) or 1 (unhealthy).
 * Used by the Dockerfile's HEALTHCHECK directive — must be fast and dependency-free.
 * fetch() is built into Bun — no imports needed.
 */
const port = process.env.PORT || "3020";
try {
  const res = await fetch(`http://localhost:${port}/api/health`);
  process.exit(res.ok ? 0 : 1);
} catch {
  // Server not ready yet (connection refused) or network error
  process.exit(1);
}
```

This is a standalone script, not imported by any module. Zero dependencies — `fetch` is built into Bun. The `try/catch` handles the startup period when the server isn't listening yet.

---

### Modify

None. The PORT default change (3000 → 3020) is done in T1.

---

### Read (for context)

- `packages/server/src/index.ts` — server startup sequence, PORT reading
- `package.json` (root) — workspace members, confirm all 5 packages
- `packages/hooks/package.json` — verify it exists (needed in Dockerfile COPY)
- `docker-compose.test.yml` — reference for service versions

---

## Success Criteria

### Happy Path
- `docker build --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg GIT_SHORT=$(git rev-parse --short HEAD) --build-arg GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) -t fuel-code .` succeeds.
- `docker run --rm fuel-code bun run packages/cli/src/index.ts --version` shows the stamped SHA and date.
- The health check script exists and runs: `bun run packages/server/src/health-check.ts` exits 0 when a healthy server is running (with DB/Redis accessible), exits 1 otherwise.

### Without Build Args
- `docker build -t fuel-code .` succeeds with no build args (SHA defaults to "unknown").
- `docker run --rm fuel-code bun run packages/cli/src/index.ts --version` shows `unknown (unknown)` — no crash.

### Image Verification
- Image size is reasonable: `docker images fuel-code --format '{{.Size}}'` shows < 600MB (bun images are larger than node-alpine but this is acceptable).
- No `.git` directory inside the image: `docker run --rm fuel-code ls -la .git 2>&1` fails (directory doesn't exist).
- `node_modules` is present (installed by bun during build): `docker run --rm fuel-code ls node_modules | head -5` shows packages.

### Integration with T3/T4
- The container starts and listens on the port specified by `PORT` env var (default 3020).
- The `HEALTHCHECK` passes when the server has valid DB/Redis connections.
- The container command `CMD ["bun", "run", "packages/server/src/index.ts"]` starts the server correctly.

### Edge Cases
- `.dockerignore` excludes `.git` but NOT source files — verify with `docker build` output showing correct COPY.
- The `minio-init` service in T3 will depend on the app being built from this Dockerfile — ensure the build is deterministic.
- If `bun install --frozen-lockfile` fails, it's because `bun.lock` is out of sync with `package.json` — this is intentional (CI safety).
