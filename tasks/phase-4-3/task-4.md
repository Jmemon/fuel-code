# Task 4: Railway Deployment Config

## parallel-group: C
## depends-on: T2
## blocks: none

---

## Description

Create a Railway deployment configuration file. Railway provides managed Postgres and Redis — no MinIO needed (users provide their own S3/R2 bucket). The Dockerfile from T2 is used as the build method.

This is the smallest task — a single config file plus documentation of the Railway deployment flow.

---

## Relevant Files

### Create

**`railway.toml`** — Railway service configuration at repo root.

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

That's the entire file. Railway auto-detects `railway.toml` and uses it to configure the service.

---

### Modify

None.

---

### Read (for context)

- `Dockerfile` (from T2) — Railway builds using this Dockerfile
- `packages/server/src/index.ts` — validates DATABASE_URL, REDIS_URL, API_KEY; reads PORT from env
- `packages/server/src/routes/health.ts` — health endpoint at `/api/health`, unauthenticated
- `packages/server/src/app.ts` — confirm health router is mounted at `/api/health`

---

## Railway Deployment Flow

### Auto-injected env vars (by Railway plugins)
- `DATABASE_URL` — Postgres plugin. Format: `postgresql://user:pass@host:port/db`. Matches the server's expected format.
- `REDIS_URL` — Redis plugin. Format: `redis://host:port`. Matches the server's expected format.
- `PORT` — Railway injects a random port and expects the app to bind to it. The server reads `process.env.PORT` (line 70 of `index.ts`, defaults to 3020). Railway's injected value overrides the default. This just works.

### Manually set env vars (in Railway dashboard)
- `API_KEY` — Required. Arbitrary string for CLI authentication.
- `NODE_ENV` — Set to `production`.
- `AWS_ACCESS_KEY_ID` — Required. External S3/R2 access key. **Use `AWS_ACCESS_KEY_ID`, NOT `S3_ACCESS_KEY_ID`** — the server's S3 client relies on the AWS SDK default credential chain.
- `AWS_SECRET_ACCESS_KEY` — Required. External S3/R2 secret key.
- `S3_BUCKET` — Required. External bucket name.
- `S3_REGION` — Required. e.g., `us-east-1` or `auto` for Cloudflare R2.
- `S3_ENDPOINT` — Required for non-AWS S3. e.g., `https://xxxx.r2.cloudflarestorage.com` for R2.
- `S3_FORCE_PATH_STYLE` — Set to `false` for real S3/R2, `true` for MinIO-compatible stores.
- `ANTHROPIC_API_KEY` — Optional. For LLM-powered session summaries.
- `LOG_LEVEL` — Optional. Defaults to `info`.

### Version stamping on Railway
Railway clones the repo and runs `docker build`. The `.dockerignore` excludes `.git`, so the stamp script cannot run `git rev-parse` inside the build. However:

1. Railway auto-sets `RAILWAY_GIT_COMMIT_SHA` and `RAILWAY_GIT_BRANCH` as environment variables during builds.
2. The stamp script (from T1) checks these as fallbacks after `GIT_SHA` env var.
3. Result: Railway deployments automatically get version stamping if the stamp script reads Railway's env vars.

If Railway does NOT pass build-time env vars as Docker build args by default, the version will show "unknown". This is acceptable — Railway's own deployment metadata provides version tracking, and users can manually set `GIT_SHA` as a Railway variable if they want version stamping.

### Health check
The `healthcheckPath = "/api/health"` tells Railway to probe this endpoint. The health endpoint (`packages/server/src/routes/health.ts`) is unauthenticated — Railway's health probes don't send auth headers. Returns HTTP 200 when DB and Redis are healthy, HTTP 503 when DB is down.

---

## Success Criteria

### File Validation
- `railway.toml` is valid TOML (parseable by any TOML parser).
- `builder = "dockerfile"` points to the correct Dockerfile.
- `healthcheckPath = "/api/health"` matches the actual health endpoint route.

### Manual Deployment Test
- Deploy to Railway with Postgres + Redis plugins + configured env vars → server starts → health check passes.
- CLI can connect to the Railway-hosted server via the public URL.
- Migrations run on first deploy and on subsequent deploys with new migrations.

### Integration with T2
- Railway uses the Dockerfile from T2. The Dockerfile's `ARG GIT_SHA=unknown` accepts build args.
- Railway's `PORT` injection overrides the server's default 3020.

### Edge Cases
- Missing S3 configuration causes server startup to fail at `s3.ensureBucket()` — the error is clear ("S3 bucket not found or inaccessible").
- Missing `API_KEY` causes server to exit immediately with a clear "Missing required environment variables" message.
- Railway auto-restarts on failure (up to 3 retries per `restartPolicyMaxRetries`).

### What Cannot Be CI-Tested
This task requires a Railway account for full E2E testing. Acceptance testing is manual against a real Railway project. The `railway.toml` file can only be syntax-validated in CI.
