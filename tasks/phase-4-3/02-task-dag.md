# Phase 4-3 Task DAG: Self-Hosted Distribution & Update System

## Overview

6 tasks across 3 layers. Foundation (version stamping), deployment artifacts (Dockerfile, Docker Compose, Railway), and operational concerns (update checker, CI).

## Dependency Graph

```
T1 ──→ T2 ──→ T3
 │      └────→ T4
 └────→ T5
T6 (independent)
```

```
Layer 1: [T1]           Foundation (version stamping)
Layer 2: [T2]           Build artifact (Dockerfile)
Layer 3: [T3, T4]       Deployment targets (Docker Compose, Railway)
Layer 2: [T5]           Update checker (depends on T1 only)
Layer 1: [T6]           CI pipeline (fully independent)
```

**Parallelism**: T1 and T6 can run in parallel. After T1: T2 and T5 can run in parallel. After T2: T3 and T4 can run in parallel.

---

## T1: Version Stamping & Build Info

**Depends on**: none
**Blocks**: T2, T5

**Description**: Embed git commit SHA and build timestamp into the application at build time so the running app knows what version it is. This is foundational — the Dockerfile (T2) runs the stamp during build, and the update checker (T5) uses it to compare against upstream.

**Deliverables**:

1. **`scripts/stamp-version.ts`** — A bun script that generates build metadata:
   ```typescript
   // Reads git SHA and writes to packages/shared/src/build-info.generated.ts
   // Run: bun run scripts/stamp-version.ts
   //
   // Output file contents:
   // export const BUILD_INFO = {
   //   commitSha: "abc1234def5678...",
   //   commitShort: "abc1234",
   //   buildDate: "2026-02-28T12:00:00Z",
   //   branch: "main",
   // } as const;
   ```
   - Gets SHA from `git rev-parse HEAD`
   - Gets short SHA from `git rev-parse --short HEAD`
   - Gets branch from `git rev-parse --abbrev-ref HEAD`
   - Build date from `new Date().toISOString()`
   - Writes to `packages/shared/src/build-info.generated.ts`
   - Add `build-info.generated.ts` to `.gitignore` (generated file, not committed)

2. **`packages/shared/src/build-info.ts`** — Stable import that re-exports the generated file with a fallback:
   ```typescript
   // If the generated file doesn't exist (dev mode, not stamped), use defaults
   export const BUILD_INFO = (() => {
     try {
       return require("./build-info.generated.js");
     } catch {
       return {
         commitSha: "development",
         commitShort: "dev",
         buildDate: new Date().toISOString(),
         branch: "unknown",
       };
     }
   })();
   ```
   The fallback means the app works fine in dev without running the stamp script.

3. **Update `packages/cli/src/index.ts`**: Change `.version("0.1.0")` to use `BUILD_INFO.commitShort`:
   ```
   fuel-code dev (2026-02-28)         # in dev
   fuel-code abc1234 (2026-02-28)     # after stamping
   ```

4. **Update `fuel-code status` command**: Add version line to status output:
   ```
   Version:  abc1234 (2026-02-28, main)
   Server:   http://localhost:3020 (healthy)
   ...
   ```

5. **Update server health endpoint**: Add version to `/api/health` response:
   ```json
   {
     "status": "ok",
     "version": { "commit": "abc1234", "date": "2026-02-28T12:00:00Z" },
     "postgres": "connected",
     "redis": "connected"
   }
   ```

6. **Package.json script**: Add `"stamp"` script to root `package.json`:
   ```json
   "stamp": "bun run scripts/stamp-version.ts"
   ```

**Acceptance criteria**:
- `bun run stamp && bun run packages/cli/src/index.ts --version` shows the current git SHA
- In dev (without stamping), version shows "dev" — no crash
- `/api/health` includes version info
- Generated file is in `.gitignore`

---

## T2: Production Dockerfile

**Depends on**: T1
**Blocks**: T3, T4

**Description**: Multi-stage Dockerfile at the repo root that builds the entire monorepo and runs the server. Used by both Docker Compose (T3) and Railway (T4).

**Deliverables**:

1. **`Dockerfile`** at repo root:

   ```dockerfile
   # Stage 1: Install dependencies and build
   FROM oven/bun:1 AS builder
   WORKDIR /app

   # Copy package files first for layer caching
   COPY package.json bun.lock ./
   COPY packages/shared/package.json packages/shared/
   COPY packages/core/package.json packages/core/
   COPY packages/server/package.json packages/server/
   COPY packages/cli/package.json packages/cli/
   RUN bun install --frozen-lockfile

   # Copy source and build
   COPY . .
   RUN bun run stamp

   # Stage 2: Production runtime
   FROM oven/bun:1-slim AS runtime
   WORKDIR /app

   COPY --from=builder /app /app

   # Server listens on this port
   EXPOSE 3020

   # Health check — hit the health endpoint
   HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
     CMD bun run packages/server/src/health-check.ts || exit 1

   # Start the server (migrations run automatically on startup)
   CMD ["bun", "run", "packages/server/src/index.ts"]
   ```

   Key decisions:
   - Uses `oven/bun:1` base image (official bun image)
   - No separate build step needed — bun runs TypeScript directly
   - The `stamp` script runs during build to embed the git SHA
   - Migrations run automatically via the server's startup sequence
   - Health check calls a lightweight script (or `curl` to `/api/health`)

2. **`packages/server/src/health-check.ts`** — Tiny script for Docker HEALTHCHECK:
   ```typescript
   // Hits /api/health and exits 0 or 1
   const res = await fetch(`http://localhost:${process.env.PORT || 3020}/api/health`);
   process.exit(res.ok ? 0 : 1);
   ```

3. **`.dockerignore`**:
   ```
   node_modules
   .git
   .claude
   logs
   *.test.ts
   docker-compose.test.yml
   .env
   ```

**Acceptance criteria**:
- `docker build -t fuel-code .` succeeds
- `docker run --rm fuel-code bun run packages/cli/src/index.ts --version` shows the stamped version
- Health check passes when server is running with valid DB/Redis connections
- Image size is reasonable (< 500MB — bun images are larger than node alpine but that's fine)

---

## T3: Production Docker Compose

**Depends on**: T2
**Blocks**: none

**Description**: Production-ready `docker-compose.prod.yml` with persistent volumes. Unlike the test compose (tmpfs, non-standard ports, LocalStack), this uses named volumes, standard ports (configurable), and MinIO for S3-compatible storage.

**Deliverables**:

1. **`docker-compose.prod.yml`**:

   ```yaml
   # Production Docker Compose for fuel-code.
   # Usage:
   #   1. Copy .env.example to .env and configure
   #   2. docker compose -f docker-compose.prod.yml up -d
   #   3. Point your CLI at http://localhost:3020
   #
   # Update:
   #   git pull origin main
   #   docker compose -f docker-compose.prod.yml up --build -d

   services:
     postgres:
       image: postgres:16-alpine
       environment:
         POSTGRES_DB: fuel_code
         POSTGRES_USER: ${POSTGRES_USER:-fuel}
         POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
       volumes:
         - pgdata:/var/lib/postgresql/data
       ports:
         - "${POSTGRES_PORT:-5432}:5432"
       restart: unless-stopped
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-fuel}"]
         interval: 10s
         timeout: 5s
         retries: 5

     redis:
       image: redis:7-alpine
       volumes:
         - redisdata:/data
       ports:
         - "${REDIS_PORT:-6379}:6379"
       restart: unless-stopped
       healthcheck:
         test: ["CMD", "redis-cli", "ping"]
         interval: 10s
         timeout: 5s
         retries: 5

     minio:
       image: minio/minio:latest
       command: server /data --console-address ":9001"
       environment:
         MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
         MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
       volumes:
         - miniodata:/data
       ports:
         - "${MINIO_API_PORT:-9000}:9000"
         - "${MINIO_CONSOLE_PORT:-9001}:9001"
       restart: unless-stopped
       healthcheck:
         test: ["CMD", "mc", "ready", "local"]
         interval: 10s
         timeout: 5s
         retries: 5

     # Creates the S3 bucket on first startup
     minio-init:
       image: minio/mc:latest
       depends_on:
         minio:
           condition: service_healthy
       entrypoint: >
         /bin/sh -c "
         mc alias set local http://minio:9000 $${MINIO_ROOT_USER:-minioadmin} $${MINIO_ROOT_PASSWORD:-minioadmin};
         mc mb local/$${S3_BUCKET:-fuel-code-transcripts} --ignore-existing;
         exit 0;
         "

     app:
       build:
         context: .
         dockerfile: Dockerfile
       environment:
         DATABASE_URL: postgresql://${POSTGRES_USER:-fuel}:${POSTGRES_PASSWORD}@postgres:5432/fuel_code
         REDIS_URL: redis://redis:6379
         API_KEY: ${API_KEY:?Set API_KEY in .env}
         PORT: 3020
         NODE_ENV: production
         LOG_LEVEL: ${LOG_LEVEL:-info}
         S3_BUCKET: ${S3_BUCKET:-fuel-code-transcripts}
         S3_REGION: us-east-1
         S3_ENDPOINT: http://minio:9000
         S3_FORCE_PATH_STYLE: "true"
         S3_ACCESS_KEY_ID: ${MINIO_ROOT_USER:-minioadmin}
         S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:-minioadmin}
         ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
         FUEL_CODE_UPSTREAM_REPO: ${FUEL_CODE_UPSTREAM_REPO:-}
       ports:
         - "${APP_PORT:-3020}:3020"
       depends_on:
         postgres:
           condition: service_healthy
         redis:
           condition: service_healthy
         minio-init:
           condition: service_completed_successfully
       restart: unless-stopped

   volumes:
     pgdata:
     redisdata:
     miniodata:
   ```

2. **Update `.env.example`** — Consolidate all env vars with prod-oriented comments:
   ```bash
   # === Required ===
   API_KEY=fc_generate_a_random_key_here
   POSTGRES_PASSWORD=change_me_to_something_secure

   # === Optional (have sensible defaults) ===
   # POSTGRES_USER=fuel
   # POSTGRES_PORT=5432
   # REDIS_PORT=6379
   # APP_PORT=3020
   # LOG_LEVEL=info

   # === MinIO (S3-compatible storage, used by Docker Compose) ===
   # MINIO_ROOT_USER=minioadmin
   # MINIO_ROOT_PASSWORD=minioadmin
   # MINIO_API_PORT=9000
   # MINIO_CONSOLE_PORT=9001
   # S3_BUCKET=fuel-code-transcripts

   # === External S3 (use INSTEAD of MinIO for Railway or cloud deployments) ===
   # S3_BUCKET=your-bucket-name
   # S3_REGION=us-east-1
   # S3_ENDPOINT=https://your-r2-endpoint.r2.cloudflarestorage.com
   # S3_ACCESS_KEY_ID=your-access-key
   # S3_SECRET_ACCESS_KEY=your-secret-key
   # S3_FORCE_PATH_STYLE=false

   # === LLM-powered session summaries (optional) ===
   # ANTHROPIC_API_KEY=sk-ant-your-key-here

   # === Update checker (optional) ===
   # FUEL_CODE_UPSTREAM_REPO=owner/repo
   # FUEL_CODE_DISABLE_UPDATE_CHECK=false
   ```

3. **Verify S3 env var compatibility**: The server already reads `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`. Check if it also reads `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` or if it relies on AWS SDK default credential chain. If the latter, add `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env var passthrough (these are what the AWS SDK reads, MinIO is compatible).

**Acceptance criteria**:
- `cp .env.example .env` → fill in API_KEY + POSTGRES_PASSWORD → `docker compose -f docker-compose.prod.yml up -d` → all services healthy
- `fuel-code status` connects to the server at localhost:3020
- Events flow through the pipeline (ingest → Redis → Postgres)
- Transcripts upload to MinIO and are retrievable
- `docker compose -f docker-compose.prod.yml down` then `up -d` → all data still there
- MinIO console accessible at localhost:9001

---

## T4: Railway Deployment Config

**Depends on**: T2 (uses same Dockerfile)
**Blocks**: none

**Description**: Configuration for deploying fuel-code on Railway. Railway provides managed Postgres and Redis — no need for MinIO (users provide their own S3/R2 bucket). The Dockerfile from T2 is used as the build method.

**Deliverables**:

1. **`railway.toml`** at repo root:
   ```toml
   [build]
   builder = "dockerfile"
   dockerfilePath = "Dockerfile"

   [deploy]
   healthcheckPath = "/api/health"
   healthcheckTimeout = 30
   restartPolicyType = "on_failure"
   restartPolicyMaxRetries = 3
   ```

   Railway auto-detects the Dockerfile. The healthcheck path tells Railway how to verify the service is running. Postgres and Redis are added as Railway plugins — their connection strings are injected as env vars automatically.

2. **Railway env var mapping notes** (in the task file, not a separate doc):
   - `DATABASE_URL` — auto-injected by Railway Postgres plugin
   - `REDIS_URL` — auto-injected by Railway Redis plugin
   - `API_KEY` — set manually in Railway dashboard
   - `PORT` — auto-injected by Railway (Railway expects the app to listen on `$PORT`)
   - `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — set manually, pointing at external S3/R2
   - `S3_FORCE_PATH_STYLE` — `false` for real S3/R2, `true` for MinIO
   - `ANTHROPIC_API_KEY` — set manually if using LLM summaries
   - `NODE_ENV` — set to `production`

3. **PORT flexibility**: Verify the server reads `PORT` from env (it does — see `.env.example`). Railway injects a random port and expects the app to bind to it. This should already work.

4. **Railway Postgres plugin note**: Railway's Postgres plugin injects `DATABASE_URL` in the format `postgresql://user:pass@host:port/db`. This matches our expected format. No changes needed.

**Acceptance criteria**:
- Deploying to Railway with Postgres + Redis plugins + env vars configured → server starts → health check passes
- CLI can connect to the Railway-hosted server via the public URL
- Migrations run on first deploy and on subsequent deploys with new migrations

**Note**: This task cannot be fully E2E tested in CI — it requires a Railway account. Acceptance testing is manual against a real Railway project.

---

## T5: Update Notification System

**Depends on**: T1 (needs BUILD_INFO to compare versions)
**Blocks**: none

**Description**: Passive update checker that compares the running build's git SHA against the latest commit on the upstream `main` branch. Non-blocking, cached, and disableable.

**Deliverables**:

1. **`packages/cli/src/update-checker.ts`**:

   ```typescript
   // Checks GitHub API for the latest commit on main.
   // Caches the result for 1 hour in ~/.fuel-code/update-check.json.
   // Returns null if check is disabled, cached, or fails.
   //
   // Usage:
   //   const update = await checkForUpdate();
   //   if (update) console.log(`Update available: ${update.currentSha} → ${update.latestSha}`);

   interface UpdateInfo {
     currentSha: string;
     latestSha: string;
     latestDate: string;
     behindBy?: number;  // if available from API
   }

   export async function checkForUpdate(): Promise<UpdateInfo | null>;
   ```

   Implementation details:
   - Read `FUEL_CODE_UPSTREAM_REPO` env var (format: `owner/repo`). If not set, derive from the git remote if possible, otherwise skip.
   - If `FUEL_CODE_DISABLE_UPDATE_CHECK=true`, return null
   - Check cache file `~/.fuel-code/update-check.json` — if last check was < 1 hour ago, use cached result
   - Hit `GET https://api.github.com/repos/{owner}/{repo}/commits/main` (no auth needed for public repos, rate limit is 60/hr which is plenty)
   - Compare response SHA to `BUILD_INFO.commitSha`
   - If different, write result to cache and return `UpdateInfo`
   - If same, write "up to date" to cache and return null
   - On any error (network, API rate limit, etc.), silently return null — never block the user
   - Ensure `~/.fuel-code/` directory exists (create if needed)

2. **Update `fuel-code status` command**:
   ```
   Version:    abc1234 (2026-02-28, main)
   Update:     Available! def5678 (2026-03-01) — run: git pull && docker compose up --build -d
   Server:     http://localhost:3020 (healthy)
   ...
   ```
   Or if up to date:
   ```
   Version:    abc1234 (2026-02-28, main)
   Server:     http://localhost:3020 (healthy)
   ...
   ```
   The update message includes a short instruction appropriate to the deployment method. Since we can't know the method, just show the generic `git pull` approach.

3. **Update TUI dashboard StatusBar**:
   - If update available: show a subtle indicator, e.g., `↑ Update available` in the status bar
   - Non-blocking — check runs in background on dashboard mount, updates the status bar if result comes back
   - Don't check on every render, just once on mount (cached result is fast anyway)

4. **Server-side version in health endpoint** (from T1, but the update check is CLI-only):
   - The server doesn't check for updates itself — it just reports its version
   - The CLI checks for updates because it's the user-facing interface

**Acceptance criteria**:
- With `FUEL_CODE_UPSTREAM_REPO=owner/repo` set and a stale build: `fuel-code status` shows "Update available"
- With current build: no update message
- Cache works: second call within an hour doesn't hit GitHub API
- With `FUEL_CODE_DISABLE_UPDATE_CHECK=true`: no check, no network call
- Network failure: silently returns null, `fuel-code status` works normally
- TUI dashboard shows update indicator when available

---

## T6: CI Pipeline (GitHub Actions)

**Depends on**: none (fully independent)
**Blocks**: none

**Description**: GitHub Actions workflow for continuous integration. Runs on PRs and pushes to main. Validates code quality and build integrity.

**Deliverables**:

1. **`.github/workflows/ci.yml`**:

   ```yaml
   name: CI

   on:
     pull_request:
       branches: [main]
     push:
       branches: [main]

   jobs:
     lint-and-typecheck:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v2
         - run: bun install --frozen-lockfile
         - run: bun run lint        # if lint script exists
         - run: bun run typecheck   # if typecheck script exists

     test:
       runs-on: ubuntu-latest
       services:
         postgres:
           image: postgres:16-alpine
           env:
             POSTGRES_DB: fuel_code_test
             POSTGRES_USER: test
             POSTGRES_PASSWORD: test
           ports:
             - 5432:5432
           options: >-
             --health-cmd="pg_isready -U test"
             --health-interval=10s
             --health-timeout=5s
             --health-retries=5
         redis:
           image: redis:7-alpine
           ports:
             - 6379:6379
           options: >-
             --health-cmd="redis-cli ping"
             --health-interval=10s
             --health-timeout=5s
             --health-retries=5
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v2
         - run: bun install --frozen-lockfile
         - run: bun test
           env:
             DATABASE_URL: postgresql://test:test@localhost:5432/fuel_code_test
             REDIS_URL: redis://localhost:6379
             API_KEY: test-key
             S3_BUCKET: test-bucket
             S3_REGION: us-east-1
             S3_ENDPOINT: http://localhost:4566
             S3_FORCE_PATH_STYLE: "true"

     docker-build:
       runs-on: ubuntu-latest
       if: github.event_name == 'push' && github.ref == 'refs/heads/main'
       steps:
         - uses: actions/checkout@v4
         - run: docker build -t fuel-code .
   ```

   Notes:
   - `lint-and-typecheck` and `test` run in parallel on PRs
   - `docker-build` only runs on push to main (verify the Dockerfile isn't broken)
   - S3 tests may need LocalStack in CI — add it as a service if tests require it, or skip S3-dependent tests in CI
   - No publishing, no deployment, no CD

2. **Package.json scripts** (if not already present):
   - Verify `lint` and `typecheck` scripts exist in root `package.json`
   - If not, add them: `"lint": "bunx biome check ."` (or whatever linter the project uses), `"typecheck": "bun run --filter '*' typecheck"` (or `tsc --noEmit` per package)
   - Check what's already set up and adapt

**Acceptance criteria**:
- PR to main triggers lint + typecheck + test jobs
- Push to main also triggers Docker build verification
- All jobs pass on current main (or fix issues found)
- CI uses the same Postgres/Redis versions as docker-compose.test.yml
