# Task 6: Express Server Skeleton with Middleware

## Parallel Group: D

## Description

Create the Express server entry point with the full middleware stack: auth, error handling, request logging, and health endpoint. This is the HTTP shell that all routes plug into. On startup it runs migrations, connects Redis, and begins listening.

### Dependencies to install
```bash
cd packages/server && bun add express cors helmet pino-http ws
cd packages/server && bun add -d @types/express @types/cors
```

### Files to Create

**`packages/server/src/logger.ts`**:
- Create and export a pino logger instance.
- JSON format in production (`NODE_ENV=production`), pretty-print in development.
- Log level from env `LOG_LEVEL` (default: `"info"`).
- Do not log request/response bodies (may contain sensitive data).

**`packages/server/src/middleware/auth.ts`**:
- `createAuthMiddleware(apiKey: string): express.RequestHandler`:
  - Read `Authorization` header, expect `Bearer <token>`.
  - Compare token to `apiKey` using `crypto.timingSafeEqual` (constant-time to prevent timing attacks).
  - Handle edge cases: missing header → 401, malformed header (no "Bearer " prefix) → 401, wrong token → 401.
  - Response on failure: `401 { error: "Missing or invalid API key" }`.
  - On success: call `next()`.

**`packages/server/src/middleware/error-handler.ts`**:
- Express error handler (4 args: `err, req, res, next`).
- If `err` is `ZodError`: respond `400 { error: "Validation failed", details: err.issues }`.
- If `err` is `FuelCodeError`: map error code prefix to HTTP status:
  - `VALIDATION_*` → 400
  - `CONFIG_*` → 500
  - `NETWORK_*` → 502
  - `STORAGE_*` → 503
- Otherwise: respond `500 { error: "Internal server error" }`.
- Always log the full error (including stack) with pino at `error` level.
- Never leak stack traces to the client in production.

**`packages/server/src/routes/health.ts`**:
- `GET /api/health` — **no auth required** (Railway health checks must be unauthenticated).
- Response: `{ status: "ok" | "degraded" | "unhealthy", checks: { db: { ok, latency_ms }, redis: { ok, latency_ms } }, uptime_seconds: number, version: "0.1.0" }`.
- Logic:
  - `ok`: both DB and Redis healthy
  - `degraded`: DB healthy, Redis unhealthy (events accepted but not processing)
  - `unhealthy`: DB unhealthy
- HTTP status: 200 for ok/degraded, 503 for unhealthy.

**`packages/server/.env.example`**:
```
DATABASE_URL=postgresql://user:pass@host:5432/fuel_code
REDIS_URL=redis://default:pass@host:6379
API_KEY=fc_your_api_key_here
PORT=3000
LOG_LEVEL=info
NODE_ENV=development
```

**`packages/server/src/index.ts`** (entry point):

Startup sequence (order matters):
1. Load env vars via `dotenv/config`.
2. Validate required env vars: `DATABASE_URL`, `REDIS_URL`, `API_KEY`. If any missing, log error and `process.exit(1)` with a message specifying which var is missing.
3. Create Postgres connection via `createDb(DATABASE_URL)`.
4. Run migrations via `runMigrations(sql, migrationsDir)`. If migration fails, log error and `process.exit(1)`. **Do NOT start the server if DB is broken.**
5. Create Redis client via `createRedisClient(REDIS_URL)`. Connect.
6. Ensure consumer group via `ensureConsumerGroup(redis)`.
7. Create Express app.
8. Attach middleware in order:
   - `express.json({ limit: "1mb" })` — prevent OOM from oversized payloads
   - `helmet()` — security headers
   - `cors({ origin: false })` — disabled in Phase 1 (no web client)
   - pino-http request logger
   - Auth middleware on `/api/*` paths EXCEPT `/api/health`
9. Mount routes: `/api/health`, `/api/events` (Task 8 will add ingest).
10. Attach error handler middleware (must be last).
11. Start HTTP server: `app.listen(PORT)`.
12. Log: "Server started in {X}ms. DB: ok. Redis: ok. Port: {PORT}."
13. Start event consumer (Task 11 will wire this — for now, leave a comment `// Consumer started in Task 11`).

Graceful shutdown:
- On `SIGTERM` and `SIGINT`:
  1. Log "Shutting down..."
  2. Stop accepting new HTTP connections (`server.close()`)
  3. Stop consumer (Task 11)
  4. Close Redis connection
  5. Close Postgres pool (`sql.end()`)
  6. Exit 0
- Shutdown timeout: 30 seconds. If not clean by then, force `process.exit(1)`.

Export the Express app (not just start it) so integration tests can import it without starting the HTTP listener.

**`packages/server/src/app.ts`** (separate from index.ts for testability):
- Creates and configures the Express app with all middleware.
- Exports `createApp(deps: { sql, redis, apiKey }): express.Express`.
- `index.ts` calls `createApp()` and then `app.listen()`.
- Tests can call `createApp()` and use supertest without starting a real server.

### Tests

**`packages/server/src/middleware/__tests__/auth.test.ts`**:
- Valid bearer token → next() called
- Missing header → 401
- Wrong token → 401
- Malformed header (no "Bearer " prefix) → 401

## Relevant Files
- `packages/server/src/index.ts` (create)
- `packages/server/src/app.ts` (create)
- `packages/server/src/logger.ts` (create)
- `packages/server/src/middleware/auth.ts` (create)
- `packages/server/src/middleware/error-handler.ts` (create)
- `packages/server/src/routes/health.ts` (create)
- `packages/server/.env.example` (create)
- `packages/server/src/middleware/__tests__/auth.test.ts` (create)

## Success Criteria
1. `bun run packages/server/src/index.ts` starts without error (given valid env vars).
2. `GET /api/health` returns 200 with `{ status: "ok" }` when DB and Redis are up. No auth required.
3. `GET /api/health` returns 200 with `{ status: "degraded" }` when Redis is down.
4. `POST /api/events/ingest` without auth returns 401 `{ error: "Missing or invalid API key" }`.
5. `POST /api/events/ingest` with wrong token returns 401.
6. `POST /api/events/ingest` with correct token does not return 401 (will return 404 until Task 8 mounts the route).
7. Request body > 1MB returns 413.
8. Server logs are structured JSON with request method, path, status, and duration.
9. Missing `DATABASE_URL` env var causes immediate exit with clear error message.
10. SIGTERM triggers graceful shutdown (log message visible, exit code 0).
11. `createApp()` can be called from tests without starting the HTTP listener.
12. Auth middleware uses constant-time comparison (verify `crypto.timingSafeEqual` call in code).
