# Phase 4-3 — Self-Hosted Distribution & Update System

## Date: 2026-02-28

## Motivation

fuel-code is open source and single-user by design. Every user runs their own deployment — we don't manage hosting, users, or multi-tenancy. Each deployment is completely isolated: your sessions, transcripts, and git activity belong to you alone.

This phase provides the infrastructure for two self-hosting paths:

1. **Docker Compose** — a single `docker compose up` on any machine with Docker. Postgres, Redis, and MinIO (S3-compatible) all run as containers with persistent volumes. Best for local/home-server setups.

2. **Railway** — PaaS deployment using Railway's managed Postgres and Redis plugins, with S3 via an external provider (Cloudflare R2, AWS S3, etc.). Best for "set it and forget it" cloud hosting where you don't want to manage infrastructure.

We also need an update notification system. When we push to main, users' instances should know an update is available. They pull and redeploy themselves — we don't push updates to anyone.

Finally, CI for the repo itself: lint, typecheck, and test before merging to main.

## Scope

**In scope:**
- Version stamping (git SHA + build timestamp embedded at build time)
- Production Dockerfile (multi-stage, bun-based)
- Production Docker Compose (Postgres, Redis, MinIO, app — all with persistent volumes)
- Railway deployment configuration
- Update notification system (check upstream for new commits, display in CLI/TUI)
- GitHub Actions CI pipeline (lint, typecheck, test on PR)

**Out of scope:**
- Multi-tenancy or user management (explicitly rejected — each deployment is single-user)
- Container registry publishing / Docker Hub (users build from source)
- Automatic updates / auto-pull (users control when they update)
- CD / deployment automation (users deploy themselves)
- Kubernetes, Helm charts, or other orchestrators (YAGNI)
- SSL/TLS termination (users handle this with their own reverse proxy if needed)

---

## Design Decisions

### 1. Build from source, not from registry

Users clone the repo and build locally (or Railway builds from the repo). We don't publish pre-built images to Docker Hub or GHCR. This keeps things simple:
- No registry credentials or publishing pipeline
- Users always have the source code for debugging
- `git pull && docker compose up --build -d` is the update flow

### 2. MinIO for self-hosted S3

The test compose uses LocalStack for S3. Production uses MinIO instead:
- MinIO is purpose-built for S3-compatible object storage
- Lightweight, production-ready, single binary
- Persistent volume for transcript/blob storage
- LocalStack is for testing (ephemeral, heavier, more services than needed)
- Railway users skip MinIO entirely and configure external S3/R2 via env vars

### 3. Version = git SHA

No semantic versioning ceremony. The version IS the git commit SHA:
- `fuel-code --version` → `fuel-code abc1234 (2026-02-28)`
- Update check: compare local SHA to remote `main` HEAD SHA
- Simple, unambiguous, no version bump commits needed
- If we ever want tagged releases, we layer that on top later

### 4. Update check is passive

The app checks for updates periodically (hourly) via GitHub API. It never auto-updates:
- Shows "Update available" in `fuel-code status` and TUI status bar
- Docker users: `git pull && docker compose up --build -d`
- Railway users: auto-deploy if connected to repo, or manual redeploy
- Check is non-blocking and cached — never slows down normal operations
- Can be disabled via `FUEL_CODE_DISABLE_UPDATE_CHECK=true`

### 5. CI only, no CD

GitHub Actions runs lint, typecheck, and tests on PRs. On push to main, same checks plus Docker build verification (ensures the Dockerfile isn't broken). No deployment step — users pull from main.

### 6. No separate migration command needed

The server already runs migrations automatically on startup with advisory locking (see `packages/server/src/db/migrator.ts`). This works perfectly for both Docker and Railway — just restart the service and migrations apply. No `fuel-code migrate` CLI command needed (YAGNI).

---

## Architecture: How the Two Paths Work

### Docker Compose Path

```
User's machine
├── fuel-code/                    (cloned repo)
│   ├── docker-compose.prod.yml
│   ├── Dockerfile
│   └── .env                      (created from .env.example)
│
└── Docker containers:
    ├── fuel-code-app              (the server, built from Dockerfile)
    │   ├── Runs migrations on startup
    │   ├── Serves API on PORT
    │   └── Connects to postgres, redis, minio
    ├── postgres                   (data on named volume)
    ├── redis                      (streams on named volume)
    └── minio                      (transcripts/blobs on named volume)
```

**Update flow:**
```bash
cd fuel-code
git pull origin main
docker compose -f docker-compose.prod.yml up --build -d
# Server restarts, migrations auto-apply, done
```

### Railway Path

```
Railway project
├── fuel-code service              (deployed from repo)
│   ├── Built by Railway (Dockerfile or Nixpacks)
│   ├── Runs migrations on startup
│   └── Env vars configured in Railway dashboard
├── Postgres plugin                (managed by Railway)
├── Redis plugin                   (managed by Railway)
└── S3 → external                  (Cloudflare R2 / AWS S3 via env vars)
```

**Update flow:**
- If Railway is connected to the repo: auto-deploys on push to main
- If not: manual redeploy from Railway dashboard
- Either way: migrations auto-apply on restart

---

## Files Created/Modified (Summary)

| File | Change |
|------|--------|
| `packages/shared/src/build-info.ts` | New — build metadata (SHA, timestamp) |
| `scripts/stamp-version.ts` | New — generates build-info at build time |
| `Dockerfile` | New — multi-stage bun production build |
| `docker-compose.prod.yml` | New — production compose with volumes |
| `.env.example` | Updated — consolidated env reference for prod |
| `railway.toml` | New — Railway service configuration |
| `.github/workflows/ci.yml` | New — CI pipeline |
| `packages/cli/src/index.ts` | Modified — version from build-info |
| `packages/cli/src/commands/status.ts` | Modified — show version + update status |
| `packages/server/src/routes/health.ts` | Modified — include version in health check |
| `packages/cli/src/update-checker.ts` | New — GitHub API update check with caching |
| `packages/cli/src/tui/components/StatusBar.tsx` | Modified — show update indicator |

---

## Success Criteria

1. **Docker path works end-to-end**: Clone repo → copy .env.example → `docker compose -f docker-compose.prod.yml up -d` → server is running → CLI can connect → events flow → data persists across restarts.

2. **Railway path works end-to-end**: Deploy to Railway with Postgres + Redis plugins → configure env vars → server starts → CLI can connect.

3. **Version is visible**: `fuel-code --version` shows git SHA and build date. `/api/health` includes the same info.

4. **Updates are detected**: After a new commit is pushed to main, `fuel-code status` shows "Update available" within an hour (or on next check).

5. **CI passes**: PRs trigger lint + typecheck + test. Pushes to main also verify Docker build.

6. **Data survives restarts**: Docker Compose `down` + `up` preserves all Postgres data, Redis streams, and MinIO objects.
