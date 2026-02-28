# Task 3: Production Docker Compose

## parallel-group: C
## depends-on: T2
## blocks: none

---

## Description

Create a production-ready Docker Compose configuration with persistent volumes. Unlike the test compose (`docker-compose.test.yml` — tmpfs, non-standard ports, LocalStack), this uses named volumes, standard ports (configurable via env vars), and MinIO for S3-compatible storage.

Also creates `.env.example` at the repo root as the definitive environment variable reference for self-hosted deployments.

---

## Relevant Files

### Create

**`docker-compose.prod.yml`** — Production compose at repo root.

```yaml
# Production Docker Compose for fuel-code self-hosted deployment.
#
# Usage:
#   1. Copy .env.example to .env and fill in required values
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
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5

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
      args:
        GIT_SHA: ${GIT_SHA:-unknown}
        GIT_SHORT: ${GIT_SHORT:-unknown}
        GIT_BRANCH: ${GIT_BRANCH:-unknown}
        BUILD_DATE: ${BUILD_DATE:-unknown}
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-fuel}:${POSTGRES_PASSWORD}@postgres:5432/fuel_code
      REDIS_URL: redis://redis:6379
      API_KEY: ${API_KEY:?Set API_KEY in .env}
      PORT: "3020"
      NODE_ENV: production
      LOG_LEVEL: ${LOG_LEVEL:-info}
      # S3 — points at the local MinIO instance
      S3_BUCKET: ${S3_BUCKET:-fuel-code-transcripts}
      S3_REGION: us-east-1
      S3_ENDPOINT: http://minio:9000
      S3_FORCE_PATH_STYLE: "true"
      # AWS SDK credential chain — MinIO is S3-compatible and accepts these.
      # The server's S3 client (packages/server/src/aws/s3.ts) creates S3Client
      # WITHOUT explicit credentials, relying on the default credential chain
      # which reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from env.
      AWS_ACCESS_KEY_ID: ${MINIO_ROOT_USER:-minioadmin}
      AWS_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:-minioadmin}
      # Optional LLM-powered session summaries
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
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

**CRITICAL details:**

1. **S3 credentials use `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`**, NOT `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`. The server's S3 client (`packages/server/src/aws/s3.ts:94-99`) creates `new S3Client({ region, maxAttempts, endpoint?, forcePathStyle? })` with NO explicit credentials parameter. It relies on the AWS SDK v3 default credential chain, which reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from environment variables. Using `S3_ACCESS_KEY_ID` would be silently ignored, causing S3 auth failures against MinIO.

2. **MinIO healthcheck uses `curl`**, NOT `mc ready local`. The `mc` CLI is NOT installed in the `minio/minio` image — it's only in `minio/mc` (used by `minio-init`). The MinIO server exposes a health endpoint at `/minio/health/live` that `curl` can hit.

3. **Build args for version stamping** are passed via the `build.args` section. Users can set `GIT_SHA` etc. in `.env` or pass on the command line. Defaulting to `"unknown"` is fine — version stamping is best-effort for self-hosted users.

4. **`$$` escaping in minio-init**: Docker Compose uses `$$` to produce a literal `$` in shell commands within YAML. `$${MINIO_ROOT_USER}` becomes `${MINIO_ROOT_USER}` when passed to `/bin/sh`.

5. **No `FUEL_CODE_UPSTREAM_REPO`** in the app service — the update checker is CLI-side only and irrelevant inside the server container.

6. **Postgres/Redis versions match** `docker-compose.test.yml`: `postgres:16-alpine` and `redis:7-alpine`.

---

**`.env.example`** — Environment variable reference at repo root.

```bash
# =============================================================================
# fuel-code — Production Environment Variables
# Copy to .env and fill in required values before running docker compose.
# =============================================================================

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
# AWS_ACCESS_KEY_ID=your-access-key
# AWS_SECRET_ACCESS_KEY=your-secret-key
# S3_BUCKET=your-bucket-name
# S3_REGION=us-east-1
# S3_ENDPOINT=https://your-r2-endpoint.r2.cloudflarestorage.com
# S3_FORCE_PATH_STYLE=false

# === LLM-powered session summaries (optional) ===
# ANTHROPIC_API_KEY=sk-ant-your-key-here

# === Update checker (CLI-side only, optional) ===
# FUEL_CODE_UPSTREAM_REPO=owner/repo
# FUEL_CODE_DISABLE_UPDATE_CHECK=false
```

Note: Uses `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` for the External S3 section — this matches what the AWS SDK actually reads. The MinIO section doesn't need these because Docker Compose automatically maps `MINIO_ROOT_USER` → `AWS_ACCESS_KEY_ID` in the `app` service environment.

---

### Modify

None. The `.gitignore` fix for `!.env.example` is done in T1.

---

### Read (for context)

- `docker-compose.test.yml` — existing test compose for reference (different ports, tmpfs, LocalStack)
- `packages/server/src/aws/s3-config.ts` — S3 env var names: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`
- `packages/server/src/aws/s3.ts` — S3Client creation (no explicit credentials, uses default chain)
- `packages/server/src/index.ts` — validates `DATABASE_URL`, `REDIS_URL`, `API_KEY`; PORT now defaults to 3020 (after T1)

---

## Success Criteria

### Happy Path
- `cp .env.example .env` → set `API_KEY` and `POSTGRES_PASSWORD` → `docker compose -f docker-compose.prod.yml up -d` → all 4 long-running services (postgres, redis, minio, app) reach healthy status.
- `docker compose -f docker-compose.prod.yml ps` shows all services as "healthy" or "running".
- `curl http://localhost:3020/api/health` returns HTTP 200 with `{ "status": "ok", ... }`.
- MinIO console accessible at `http://localhost:9001` with default credentials (`minioadmin`/`minioadmin`).
- CLI can connect: configure `fuel-code init` with backend URL `http://localhost:3020` and the same API_KEY → `fuel-code status` shows "Connected".

### S3 Integration
- The app container can upload to MinIO: emit events that trigger transcript uploads, verify objects appear in MinIO console.
- The `fuel-code-transcripts` bucket exists in MinIO (created by `minio-init` service).
- AWS SDK credential chain works: the app uses `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from env to authenticate with MinIO.

### Data Persistence
- `docker compose -f docker-compose.prod.yml down` then `docker compose -f docker-compose.prod.yml up -d` preserves all Postgres data, Redis streams, and MinIO objects.
- Named volumes (`pgdata`, `redisdata`, `miniodata`) persist across compose down/up cycles.
- Only `docker compose -f docker-compose.prod.yml down -v` destroys data.

### Configuration
- `.env.example` is tracked by git (not ignored by `.gitignore` — verified by T1's `!.env.example` fix).
- `.env.example` contains NO real credentials — only placeholder values.
- Missing required vars (`API_KEY`, `POSTGRES_PASSWORD`) cause compose to fail fast with clear error messages (Docker Compose `${VAR:?message}` syntax).

### Port Conflicts
- Default ports (5432, 6379, 9000, 9001, 3020) don't conflict with the test compose (5433, 6380, 4566). Both can theoretically run simultaneously.
- All ports are configurable via env vars.

### Edge Cases
- If `MINIO_ROOT_USER` is changed in `.env`, the compose automatically propagates it to both `minio` and `app` services (both reference `${MINIO_ROOT_USER:-minioadmin}`).
- If the user doesn't set `GIT_SHA` etc., the build args default to `"unknown"` and the version shows "unknown" — not a crash.
- `minio-init` runs to completion and exits — it's a one-shot service, not a long-running one. The `--ignore-existing` flag makes it idempotent on restarts.
