# fuel-code Repository Index

> **Generated**: 2026-02-20
> **Codebase state**: Phases 1-3 implemented, Phases 4-7 planned
> **Master spec**: `tasks/CORE.md`

---

## 1. Complete Source File Tree

### packages/shared/

```
packages/shared/
  package.json                              # @fuel-code/shared — zod, ulidx
  tsconfig.json
  src/
    index.ts                                # Barrel export: types, schemas, ulid, canonical, s3-keys, errors
    canonical.ts                            # normalizeGitRemote(), deriveCanonicalId() — workspace ID derivation
    errors.ts                               # FuelCodeError, ConfigError, NetworkError, ValidationError, StorageError
    s3-keys.ts                              # S3 key construction (transcripts/{workspace}/{session}/raw.jsonl)
    ulid.ts                                 # ULID generation (ulidx), validation, timestamp extraction
    schemas/
      index.ts                              # Barrel + validateEventPayload() + payload registry
      event-base.ts                         # Base event Zod schema (shared fields)
      session-start.ts                      # session.start payload schema
      session-end.ts                        # session.end payload schema
      session-compact.ts                    # session.compact payload schema
      session-query.ts                      # GET /sessions query param schema
      timeline-query.ts                     # GET /timeline query param schema
      git-commit.ts                         # git.commit payload schema
      git-push.ts                           # git.push payload schema
      git-checkout.ts                       # git.checkout payload schema
      git-merge.ts                          # git.merge payload schema
      payload-registry.ts                   # Map<EventType, ZodSchema> for runtime validation
    types/
      index.ts                              # Barrel: event, workspace, device, session, transcript, git-activity
      event.ts                              # Event, EventType (14 types), EVENT_TYPES[], IngestRequest/Response, BlobRef
      workspace.ts                          # Workspace interface
      device.ts                             # Device interface
      session.ts                            # Session interface
      transcript.ts                         # TranscriptMessage, ContentBlock interfaces
      git-activity.ts                       # GitActivity, GitActivityType interfaces
    __tests__/
      canonical.test.ts
      s3-keys.test.ts
      schemas.test.ts
      session-compact-schema.test.ts
```

### packages/core/

```
packages/core/
  package.json                              # @fuel-code/core — @anthropic-ai/sdk, pino, postgres
  tsconfig.json
  src/
    index.ts                                # Barrel export: all resolvers, processor, handlers, lifecycle, pipeline, recovery, backfill
    workspace-resolver.ts                   # resolveOrCreateWorkspace(), getWorkspaceByCanonicalId(), getWorkspaceById()
    device-resolver.ts                      # resolveOrCreateDevice(), updateDeviceLastSeen()
    workspace-device-link.ts                # ensureWorkspaceDeviceLink()
    event-processor.ts                      # processEvent(), EventHandlerRegistry, EventHandler, EventHandlerContext
    git-correlator.ts                       # correlateGitEventToSession() — heuristic session-git matching
    session-lifecycle.ts                    # TRANSITIONS map, transitionSession(), failSession(), resetSessionForReparse(), findStuckSessions()
    transcript-parser.ts                    # parseTranscript() — JSONL -> structured messages + content blocks
    summary-generator.ts                    # generateSummary(), renderTranscriptForSummary(), extractInitialPrompt()
    summary-config.ts                       # loadSummaryConfig() — reads ANTHROPIC_API_KEY, model, etc.
    session-pipeline.ts                     # runSessionPipeline(), createPipelineQueue(), PipelineDeps, S3Client
    session-recovery.ts                     # recoverStuckSessions(), recoverUnsummarizedSessions()
    session-backfill.ts                     # scanForSessions(), ingestBackfillSessions() — historical session discovery
    backfill-state.ts                       # loadBackfillState(), saveBackfillState() — backfill run persistence
    handlers/
      index.ts                              # createHandlerRegistry() — factory, pre-registers all 6 handlers
      session-start.ts                      # handleSessionStart — inserts/updates session row, sets lifecycle
      session-end.ts                        # handleSessionEnd — updates session, triggers pipeline via enqueueSession
      git-commit.ts                         # handleGitCommit — inserts git_activity row, correlates to session
      git-push.ts                           # handleGitPush — inserts git_activity row, correlates to session
      git-checkout.ts                       # handleGitCheckout — inserts git_activity row, correlates to session
      git-merge.ts                          # handleGitMerge — inserts git_activity row, correlates to session
    __tests__/
      device-resolver.test.ts
      event-processor.test.ts
      git-correlator.test.ts
      git-handlers.test.ts
      session-backfill.test.ts
      session-lifecycle.test.ts
      session-pipeline.test.ts
      session-recovery.test.ts
      session-start-git-prompt.test.ts
      summary-generator.test.ts
      transcript-parser.test.ts
      workspace-resolver.test.ts
```

### packages/server/

```
packages/server/
  package.json                              # @fuel-code/server — express, ioredis, @aws-sdk/client-s3, ws, etc.
  tsconfig.json
  src/
    index.ts                                # Server entry point: startup sequence, graceful shutdown
    app.ts                                  # createApp() — Express factory with full middleware stack
    logger.ts                               # Pino logger instance
    middleware/
      auth.ts                               # createAuthMiddleware() — Bearer token validation
      error-handler.ts                      # errorHandler() — catch-all Express error handler
      __tests__/
        auth.test.ts
    db/
      postgres.ts                           # createDb() — postgres.js pool factory
      migrator.ts                           # runMigrations() — sequential SQL file runner
      migrations/
        001_initial.sql                     # workspaces, devices, workspace_devices, sessions, events (5 tables, 8 indexes)
        002_transcript_tables.sql           # transcript_messages, content_blocks (6 indexes, 1 recovery index)
        003_create_git_activity.sql         # git_activity (5 indexes)
        004_add_git_hooks_prompt_columns.sql # pending_git_hooks_prompt, git_hooks_prompted on workspace_devices
      __tests__/
        migrator.test.ts
    redis/
      index.ts                              # Barrel for Redis modules
      client.ts                             # createRedisClient() — ioredis factory
      stream.ts                             # ensureConsumerGroup(), publishEvent() — Redis Streams helpers
      __tests__/
        stream.test.ts
    aws/
      s3-config.ts                          # loadS3Config() — reads S3_BUCKET, S3_REGION, S3_ENDPOINT env vars
      s3.ts                                 # createS3Client(), FuelCodeS3Client interface — upload, download, presign
      __tests__/
        s3.test.ts
    pipeline/
      wire.ts                               # createEventHandler() — wiring layer: registry + bound process function
      consumer.ts                           # startConsumer() — Redis Stream XREADGROUP loop, event dispatch
      __tests__/
        consumer.test.ts
    routes/
      health.ts                             # GET /api/health — Postgres + Redis connectivity check
      events.ts                             # POST /api/events/ingest — batch event ingestion
      transcript-upload.ts                  # POST /api/sessions/:id/transcript/upload — S3 + pipeline trigger
      session-actions.ts                    # POST /api/sessions/:id/reparse — re-trigger parsing pipeline
      sessions.ts                           # GET /sessions, GET /sessions/:id, GET /sessions/:id/transcript, etc.
      timeline.ts                           # GET /api/timeline — session-grouped activity feed
      prompts.ts                            # GET /api/prompts/pending, POST /api/prompts/:workspace_id/dismiss
      __tests__/
        events.test.ts
        prompts.test.ts
        session-reparse.test.ts
        sessions.test.ts
        timeline.test.ts
        transcript-upload.test.ts
    __tests__/
      e2e/
        pipeline.test.ts                    # Phase 1 E2E: hook -> emit -> ingest -> Redis -> processor -> Postgres
        phase2-pipeline.test.ts             # Phase 2 E2E: session lifecycle, transcript, parse, summarize
        phase3-git-tracking.test.ts         # Phase 3 E2E: git hooks, event handlers, timeline, auto-prompt
```

### packages/cli/

```
packages/cli/
  package.json                              # @fuel-code/cli — commander, pino, yaml, zod
  tsconfig.json
  src/
    index.ts                                # Commander entry point: init, status, emit, queue, hooks, transcript, backfill
    commands/
      init.ts                               # fuel-code init — generate config, register device
      status.ts                             # fuel-code status — device info, queue depth, connectivity
      emit.ts                               # fuel-code emit — emit event with local queue fallback
      queue.ts                              # fuel-code queue — status/drain/dead-letter subcommands
      hooks.ts                              # fuel-code hooks — install/status subcommands (CC hooks + git hooks)
      transcript.ts                         # fuel-code transcript upload — POST transcript to server
      backfill.ts                           # fuel-code backfill — scan + ingest historical sessions
      __tests__/
        backfill.test.ts
        emit.test.ts
        hooks.test.ts
        hooks-git.test.ts
        transcript.test.ts
    lib/
      api-client.ts                         # createApiClient() — HTTP client for server API (ingest, health methods)
      config.ts                             # loadConfig(), saveConfig(), configExists() — ~/.fuel-code/config.yaml
      drain.ts                              # drainQueue() — batch event drain with retry
      drain-background.ts                   # Background drain worker
      queue.ts                              # enqueue(), list(), read(), remove(), moveToDeadLetter(), depths()
      git-hook-installer.ts                 # installGitHooks() — global core.hooksPath setup
      git-hook-status.ts                    # getGitHookStatus() — check if git hooks are installed
      git-hooks-prompt.ts                   # showGitHooksPrompt() — interactive Y/n prompt
      prompt-checker.ts                     # checkPendingPrompts(), dismissPrompt() — server prompt API
      __tests__/
        config.test.ts
        drain.test.ts
        git-hook-installer.test.ts
        prompt-checker.test.ts
        queue.test.ts
```

### packages/hooks/

```
packages/hooks/
  package.json                              # @fuel-code/hooks
  claude/
    SessionStart.sh                         # Bash wrapper -> TypeScript helper -> fuel-code emit
    SessionEnd.sh                           # Bash wrapper -> TypeScript helper -> fuel-code emit
    _helpers/
      session-start.ts                      # Parse CC session start data, emit session.start event
      session-end.ts                        # Parse CC session end data, emit session.end event
      resolve-workspace.ts                  # Resolve workspace canonical ID from git remote
      __tests__/
        resolve-workspace.test.ts
  git/
    resolve-workspace.sh                    # Pure bash workspace ID resolution (normalizes git remote)
    post-commit                             # Bash: fire-and-forget fuel-code emit git.commit
    post-checkout                           # Bash: fire-and-forget fuel-code emit git.checkout
    post-merge                              # Bash: fire-and-forget fuel-code emit git.merge
    pre-push                                # Bash: fire-and-forget fuel-code emit git.push
    __tests__/
      hook-scripts.test.ts
      resolve-workspace.test.ts
```

### Non-Package Files

```
tasks/
  CORE.md                                   # Master specification (1506 lines)
  downstream-template.md                    # Template for downstream impact reviews
  repo-index.md                             # (this file)
  phase-1/                                  # DAG + task specs + __implementation-review.md, __downstream-review.md
  phase-2/                                  # DAG + task specs + __implementation-review.md, __downstream-review.md, __post-impl-updates-review.md
  phase-3/                                  # DAG + task specs + __implementation-review.md, __downstream-review.md
  phase-4/ through phase-7/                 # DAGs + per-task spec files
docker-compose.test.yml                     # Postgres + Redis + LocalStack for E2E tests
package.json                                # Root workspace: { "workspaces": ["packages/*"] }
```

---

## 2. Per-Package Capability Summary

### @fuel-code/shared (Contract Layer)

**What it does today:**
- Defines all TypeScript types for the 5 core abstractions: Event, Workspace, Device, Session, Blueprint (type-only for Blueprint, not yet populated)
- Defines `GitActivity` and `GitActivityType` types
- Defines `TranscriptMessage` and `ContentBlock` types
- Provides Zod validation schemas for 8 event payload types: `session.start`, `session.end`, `session.compact`, `git.commit`, `git.push`, `git.checkout`, `git.merge`, plus query schemas for sessions and timeline
- `validateEventPayload(type, data)` dispatches to per-type Zod schema
- `normalizeGitRemote(url)` normalizes SSH/HTTPS git URLs to canonical form
- `deriveCanonicalId(remote)` derives deterministic workspace ID from git remote
- `generateUlid()`, `isValidUlid()`, `extractTimestamp()` for ULID operations
- `buildTranscriptS3Key()`, `buildParsedJsonS3Key()` for S3 key construction
- Error hierarchy: `FuelCodeError(message, code, context)` with subclasses `ConfigError`, `NetworkError`, `ValidationError`, `StorageError`
- Defines all 14 `EventType` values and the `EVENT_TYPES` runtime array

**Dependencies:** zod, ulidx

### @fuel-code/core (Domain Logic)

**What it does today:**
- **Workspace resolution**: `resolveOrCreateWorkspace()` upserts workspace from canonical ID, returns ULID
- **Device resolution**: `resolveOrCreateDevice()` upserts device from client device ID
- **Workspace-device linking**: `ensureWorkspaceDeviceLink()` upserts junction record
- **Event processing**: `processEvent()` resolves entities, inserts event row (dedup via ON CONFLICT), validates payload, dispatches to handler
- **Handler registry**: `EventHandlerRegistry.register(type, handler)` with `createHandlerRegistry()` factory pre-registering 6 handlers: session.start, session.end, git.commit, git.push, git.checkout, git.merge
- **Session lifecycle state machine**: 7 states (detected, capturing, ended, parsed, summarized, archived, failed), guarded transitions with optimistic locking, `transitionSession()`, `failSession()`, `resetSessionForReparse()`, `findStuckSessions()`
- **Git-session correlation**: `correlateGitEventToSession()` matches git events to active CC sessions by workspace+device+lifecycle
- **Transcript parser**: `parseTranscript()` reads JSONL from S3, produces `TranscriptMessage[]` and `ContentBlock[]`, batch-inserts to Postgres (500/batch)
- **Summary generator**: `generateSummary()` using Anthropic Claude API, `renderTranscriptForSummary()`, `extractInitialPrompt()`
- **Session pipeline**: `runSessionPipeline()` orchestrates parse+summarize after session.end, `createPipelineQueue()` bounds concurrency (3 concurrent, 50 max)
- **Session recovery**: `recoverStuckSessions()` finds sessions stuck >10min, `recoverUnsummarizedSessions()` retries summary generation
- **Session backfill**: `scanForSessions()` discovers historical sessions in `~/.claude/projects/`, `ingestBackfillSessions()` uploads + processes them

**Dependencies:** @fuel-code/shared, @anthropic-ai/sdk, pino, postgres

### @fuel-code/server (HTTP Server + Event Consumer)

**What it does today:**
- **Express app** with middleware: JSON parsing (1MB limit), helmet, CORS (disabled), pino-http logging, Bearer token auth, error handler
- **Startup sequence**: validate env -> Postgres -> migrations -> 2 Redis clients (blocking + non-blocking) -> consumer group -> S3 -> pipeline deps -> pipeline queue -> Express -> HTTP server -> consumer -> delayed recovery (5s)
- **Graceful shutdown**: stop HTTP -> drain pipeline queue -> stop consumer -> disconnect Redis -> close Postgres (30s timeout)
- **API endpoints**:
  - `GET /api/health` (unauthenticated) -- Postgres + Redis check
  - `POST /api/events/ingest` -- batch event ingestion, per-event results array
  - `POST /api/sessions/:id/transcript/upload` -- stream to S3, trigger pipeline
  - `POST /api/sessions/:id/reparse` -- re-trigger parsing
  - `GET /api/sessions` -- list with cursor pagination, filtering (workspace, device, lifecycle, date range, tag)
  - `GET /api/sessions/:id` -- full session detail with stats
  - `GET /api/sessions/:id/transcript` -- parsed messages + content blocks
  - `GET /api/sessions/:id/transcript/raw` -- S3 presigned URL redirect
  - `GET /api/sessions/:id/events` -- events within session
  - `GET /api/sessions/:id/git` -- git activity during session
  - `PATCH /api/sessions/:id` -- update tags, summary
  - `GET /api/timeline` -- session-grouped activity feed with git highlights and orphan events, returns `{ items, next_cursor, has_more }` where items are discriminated union `{ type: "session", session, git_activity }` or `{ type: "git_activity", workspace_id, device_id, git_activity, started_at }`
  - `GET /api/prompts/pending` -- pending prompts for current device
  - `POST /api/prompts/:workspace_id/dismiss` -- dismiss prompt (accepted/declined)
- **Redis Stream consumer**: blocking XREADGROUP on dedicated Redis client, dispatches to event processor
- **Pipeline wiring**: `createEventHandler()` creates registry + bound process function
- **Database**: 4 SQL migrations, 7 tables (workspaces, devices, workspace_devices, sessions, events, transcript_messages, content_blocks), 1 auxiliary table (git_activity)
- **S3**: transcript storage, presigned URL generation

**Dependencies:** @fuel-code/core, @fuel-code/shared, express, ioredis, postgres, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, ws (installed but unused -- Phase 4), helmet, cors, pino, pino-http, dotenv, zod

### @fuel-code/cli (Command-Line Interface)

**What it does today:**
- **Commander entry point** with 7 commands: init, status, emit, queue, hooks, transcript, backfill
- `fuel-code init` -- generate config at `~/.fuel-code/config.yaml`, register device
- `fuel-code status` -- device info, queue depth, server connectivity
- `fuel-code emit` -- emit event to server, with `--workspace-id` and `--data-stdin` flags, local queue fallback on failure
- `fuel-code queue status|drain|dead-letter` -- queue management
- `fuel-code hooks install|status` -- install CC hooks + git hooks, check status
- `fuel-code transcript upload` -- POST transcript file to server for pipeline processing
- `fuel-code backfill` -- scan `~/.claude/projects/` for historical sessions, upload, process
- **API client**: `createApiClient()` with `ingest()` and `health()` methods for HTTP transport
- **Local event queue**: `~/.fuel-code/queue/` with ULID-named JSON files, atomic writes (tmp+rename)
- **Queue drainer**: batch processing with attempt tracking, dead-letter at 100 attempts
- **Git hook installer**: `installGitHooks()` with global `core.hooksPath`, competing hook manager detection, `--per-repo` mode, backup + chaining
- **Prompt system**: `checkPendingPrompts()` polls server before interactive commands, `showGitHooksPrompt()` interactive Y/n
- **Config management**: `~/.fuel-code/config.yaml` with `loadConfig()`, `saveConfig()`, `configExists()`
- **Pre-action hook**: checks pending prompts on interactive commands (sessions, session, timeline, workspaces, status, hooks, backfill)

**Dependencies:** @fuel-code/shared, commander, pino, yaml, zod

### @fuel-code/hooks (Hook Scripts)

**What it does today:**
- **Claude Code hooks** (bash wrapper -> TypeScript helper -> `fuel-code emit`):
  - `SessionStart.sh` + `_helpers/session-start.ts` -- emit session.start with workspace ID, device ID, git branch, cwd
  - `SessionEnd.sh` + `_helpers/session-end.ts` -- emit session.end, trigger background transcript upload
  - `_helpers/resolve-workspace.ts` -- resolve workspace canonical ID from git remote URL
- **Git hooks** (pure bash, fire-and-forget):
  - `post-commit` -- emit git.commit with SHA, message, branch, diff stats
  - `pre-push` -- emit git.push with refs, remote
  - `post-checkout` -- emit git.checkout with old/new refs, branch flag
  - `post-merge` -- emit git.merge with squash flag
  - `resolve-workspace.sh` -- bash implementation of git remote normalization
- **Safety invariants**: all hooks exit 0, check `command -v fuel-code`, background emit with `&`, no terminal output

**Dependencies:** @fuel-code/shared

---

## 3. Database Schema (As-Built)

### Tables (7 total across 4 migrations)

| Table | Migration | Columns (key) | Indexes |
|-------|-----------|---------------|---------|
| `workspaces` | 001 | id (TEXT PK), canonical_id (UNIQUE), display_name, default_branch, metadata (JSONB) | canonical_id unique |
| `devices` | 001 | id (TEXT PK), name, type (local/remote), hostname, os, arch, status | -- |
| `workspace_devices` | 001+004 | workspace_id+device_id (composite PK), local_path, hooks_installed, git_hooks_installed, pending_git_hooks_prompt, git_hooks_prompted | -- |
| `sessions` | 001 | id (TEXT PK), workspace_id (FK), device_id (FK), remote_env_id (no FK yet), lifecycle (7 states), started_at, ended_at, transcript_s3_key, parse_status, summary, 10 metric columns, tags (TEXT[]), metadata (JSONB) | workspace, device, lifecycle, tags (GIN) |
| `events` | 001 | id (TEXT PK), type, timestamp, device_id (FK), workspace_id (FK), session_id (FK nullable), data (JSONB), blob_refs (JSONB) | workspace_time, session, type, device |
| `transcript_messages` | 002 | id (PK), session_id (FK CASCADE), role, content, turn_number, timestamp, token_count, cache_status, thinking_content | session+turn, session+role, session+timestamp |
| `content_blocks` | 002 | id (PK), message_id (FK CASCADE), session_id (FK), block_type, content, language, tool_name, tool_input, tool_result, is_error | session+block_type, session+tool_name, session (recovery) |
| `git_activity` | 003 | id (TEXT PK), workspace_id (FK), device_id (FK), session_id (FK nullable), type (commit/push/checkout/merge), branch, commit_sha, message, files_changed, insertions, deletions, timestamp, data (JSONB) | workspace, session, timestamp, type, workspace_time |

### Session Lifecycle States

```
detected -> capturing -> ended -> parsed -> summarized -> archived
    \                     \         \          \
     +-> ended (skip)      +-> failed +-> failed +-> failed
     +-> failed
```

`failed` and `archived` are terminal states. `resetSessionForReparse()` can move `failed` back to `ended`.

---

## 4. Phase Specs and Implementation Status

### Phase 1: Foundation (14 tasks) -- IMPLEMENTED

**Goal**: Events flow from hooks to Postgres. Hook fires, event emitted, reaches backend via Redis Streams, processed into Postgres, queryable.

**Tasks**: (1) Monorepo scaffold, (2) Shared types/schemas, (3) Postgres+schema, (4) Redis client, (5) CLI config+init, (6) Express server+middleware, (7) Core resolvers, (8) Ingest endpoint, (9) Event processor+handlers, (10) CLI emit+queue, (11) Wire consumer, (12) Queue drainer, (13) Hook scripts+install, (14) E2E integration test.

**Status**: Fully implemented. All 14 tasks complete. All source files exist. E2E tests pass.

### Phase 2: Session Lifecycle (12 tasks) -- IMPLEMENTED

**Goal**: Turn sessions from records into fully processed, searchable, summarized objects with transcripts in S3, parsed messages in Postgres, aggregate stats, LLM summaries, and REST API.

**Tasks**: (1) DB migration (transcript tables), (2) Shared transcript types+S3 keys, (3) S3 client, (4) Session lifecycle state machine, (5) Transcript parser, (6) Summary generator, (7) Session pipeline orchestrator, (8) Transcript upload endpoint, (9) Session API endpoints, (10) Reparse+recovery, (11) Backfill scanner+CLI, (12) E2E integration test.

**Status**: Fully implemented. All 12 tasks complete. Pipeline queue wired correctly (fixed post-implementation). Summary retry via `recoverUnsummarizedSessions()` added. Backfill ordering fixed (events emitted before transcript upload). Upload streams directly to S3 (no buffering).

### Phase 3: Git Tracking (6 tasks) -- IMPLEMENTED

**Goal**: Capture git activity alongside CC sessions. Commits, pushes, checkouts, merges are tracked, correlated to sessions, and queryable via timeline API.

**Tasks**: (1) Git hook script templates, (2) Git hook installer+chaining, (3) Git event handlers+git_activity table, (4) Auto-prompt for git hook installation, (5) Timeline API endpoint, (6) E2E integration test.

**Status**: Fully implemented. All 6 tasks complete. 4 git event handlers registered. Timeline endpoint returns discriminated union `{ items, next_cursor, has_more }`. Git-session correlation heuristic working. Auto-prompt system functional with known minor bug (see Cross-Phase Assumptions).

### Phase 4: CLI + TUI (10 tasks) -- PLANNED

**Goal**: Primary user interface. CLI query commands and interactive TUI dashboard with live WebSocket updates.

**Tasks**: (1) Workspace+device REST endpoints, (2) WebSocket server, (3) API client+formatting, (4) `fuel-code sessions`+timeline commands, (5) `fuel-code session <id>` detail, (6) `fuel-code workspaces`+status commands, (7) WebSocket client library, (8) TUI dashboard, (9) TUI session detail, (10) E2E integration test.

**Key design decisions**: Single ApiClient class, CLI output as plain text tables (no Ink for non-interactive), commands export data-fetching for TUI reuse, `--json` flag on all query commands, WebSocket as additive enhancement (falls back to polling).

**Status**: Not started. No source files created for Phase 4 tasks. `ws` package already installed in server. `packages/server/src/ws/` directory does NOT exist yet.

### Phase 5: Remote Dev Environments (15 tasks) -- PLANNED

**Goal**: Disposable remote dev environments. Auto-detect project env, provision EC2+Docker, SSH in, remote events flow through existing pipeline.

**Tasks**: (1) Blueprint detector, (2) Blueprint schema+I/O, (3) AWS EC2 client, (4) SSH key lifecycle, (5) User-data script+Dockerfile.remote, (6) Remote API+DB migration, (7) Remote event handlers, (8) Provisioning orchestrator, (9) Lifecycle enforcer, (10) Blueprint CLI commands, (11) `remote up`, (12) `remote ssh`, (13) `remote ls`+`remote down`, (14) TUI remote panel, (15) E2E integration test.

**Key design decisions**: EC2 client as interface+mock, provisioning is server-side, user-data as bash template, ephemeral SSH keys (one-time S3 download), per-user security group, blueprint detection is pure (no I/O in detector), lifecycle enforcer with orphan detection, graceful Ctrl-C during provisioning.

**Status**: Not started. `remote_envs` and `blueprints` tables do NOT exist. `infra/` directory does NOT exist. Phase 5 creates all new infrastructure.

### Phase 6: Hardening (14 tasks) -- PLANNED

**Goal**: Production readiness. Shared retry utility, hardened queue drain, comprehensive error messages, session archival, EC2 orphan detection, graceful Ctrl-C, progress indicators, cost estimation.

**Tasks**: (1) Shared retry utility, (2) Error message framework, (3) Cost lookup table, (4) Progress indicator, (5) Retrofit AWS clients with retry+atomic tagging, (6) Retrofit CLI HTTP with retry, (7) Queue drain robustness, (8) Session archival engine, (9) EC2 orphan hardening, (10) Ctrl-C hardening, (11) Cost estimation in blueprint+remote, (12) Progress integration, (13) Archival CLI+display, (14) E2E integration test.

**Key design decisions**: Single `withRetry()` in shared, EC2 tags atomic via TagSpecifications, archival with S3 backup integrity verification, per-event batch isolation in drain, shutdown manager with cleanup stack, multi-check orphan verification with grace period.

**Status**: Not started.

### Phase 7: Slack Integration + Change Orchestration (8 tasks) -- PLANNED

**Goal**: Slack-driven change request workflow. User messages Slack bot, fuel-code provisions remote env, runs headless Claude Code, deploys preview, sends Approve/Reject buttons.

**Tasks**: (1) Change request entity+DB migration, (2) Change orchestrator state machine, (3) Server API endpoints for changes, (4) Headless CC invocation over SSH, (5) Preview URL+app runner, (6) Slack bot (Bolt framework), (7) CLI `changes` commands, (8) E2E integration test.

**Key design decisions**: Change Request as 6th abstraction, EC2 is the preview, remote env TTL override for change requests, headless CC via `claude --task`, simple merge strategy (git merge --no-ff), Slack security via user ID verification.

**Status**: Not started. New `change_requests` table needed. New `change.*` event types NOT yet in EVENT_TYPES array.

---

## 5. Cross-Phase Assumptions Inventory

### Confirmed Working

| # | Assumption | Status | Evidence |
|---|-----------|--------|----------|
| 1 | GitActivity type exists in shared | OK | `packages/shared/src/types/git-activity.ts` -- added in Phase 3 |
| 2 | Timeline API returns `{ items, next_cursor, has_more }` | OK | `packages/server/src/routes/timeline.ts` lines 370-374 |
| 3 | Git hooks on remote environments | OK | Phase 5 user-data.sh template includes `fuel-code hooks install` which installs both CC hooks and git hooks inside Docker container |
| 4 | Handler registry extensible post-creation | OK | `EventHandlerRegistry.register()` is public, Phases 5/7 can call it after `createHandlerRegistry()` |
| 5 | EVENT_TYPES includes remote.* types | OK | `packages/shared/src/types/event.ts` lines 23-26 include all 4 remote event types |
| 6 | Pipeline queue used and wired | OK | Fixed post-Phase 2: `pipelineDeps.enqueueSession` wired in `packages/server/src/index.ts` line 142 |
| 7 | pipelineDeps passed through consumer | OK | Fixed: `packages/server/src/pipeline/consumer.ts` passes pipelineDeps to processEvent |

### Known Drift / Issues Requiring Attention

#### [CROSS.1] FuelCodeError constructor signature mismatch -- Severity: MEDIUM

**Phase 6 Task 2 spec assumes**: `new FuelCodeError(message, options?)` where options is `{ code, context }`
**Actual implementation**: `new FuelCodeError(message, code, context)` -- three positional arguments
**File**: `packages/shared/src/errors.ts` lines 27-31
**Impact**: Phase 6 Task 2's error message framework must use the actual 3-arg constructor, not the 2-arg form from the spec. Trivial to adapt during implementation.

#### [CROSS.2] EventHandlerContext lacks extensibility for Phase 5-7 deps -- Severity: MEDIUM

**Downstream phases assume**: Handlers can access remote-env-specific or change-request-specific dependencies
**Actual implementation**: `EventHandlerContext` has `{ sql, event, workspaceId, logger, pipelineDeps? }` (`packages/core/src/event-processor.ts` lines 32-43)
**Impact**: Phase 5 remote event handlers and Phase 7 change event handlers need access to EC2 client, SSH key manager, Slack client, etc. These are NOT in EventHandlerContext. The workaround (already implied by codebase patterns) is closure capture: handlers are factory functions that close over extra deps, then the inner function matches the EventHandler signature. The `createHandlerRegistry()` factory in `packages/core/src/handlers/index.ts` already demonstrates this pattern.

#### [CROSS.3] `change.*` event types missing from EVENT_TYPES -- Severity: HIGH

**Phase 7 spec assumes**: `change.requested`, `change.implementing`, `change.deployed`, `change.approved`, `change.rejected`, `change.merged`, `change.failed` event types exist
**Actual implementation**: EVENT_TYPES array in `packages/shared/src/types/event.ts` contains only 14 types. No `change.*` types.
**Impact**: Phase 7 Task 1 must add these 7 new event types to the `EventType` union and `EVENT_TYPES` array, plus create corresponding Zod payload schemas. This is a prerequisite for the entire Phase 7 event pipeline.

#### [CROSS.4] Prompt dismiss bug: reports "accepted" on install failure -- Severity: LOW

**Expected behavior**: If `installGitHooks()` throws, the prompt should be dismissed as "declined" (or "failed")
**Actual behavior**: Line 66 of `packages/cli/src/lib/git-hooks-prompt.ts` correctly dismisses as "declined" on failure. However, line 65 logs "Failed to install git hooks" but the word "accepted" at line 62 only runs on success. So there is no bug in the dismiss logic itself -- the code path is correct.
**Note**: Previous review documents flagged this as a bug but the implementation is actually correct: success -> "accepted" (line 62), failure -> "declined" (line 66), user decline -> "declined" (line 70).

#### [CROSS.5] Orphan git activity query is bounded -- Severity: NONE (resolved)

**Previous concern**: Orphan git activity query had no LIMIT and could return unbounded rows
**Actual state**: `packages/server/src/routes/timeline.ts` line 291 has `LIMIT 200` on the orphan query.
**Status**: Already handled.

#### [CROSS.6] `archived` -> `summarized` backward transition not implemented -- Severity: MEDIUM

**Phase 6 Task 13 requires**: `archived -> summarized` transition for `--restore` functionality
**Actual implementation**: `TRANSITIONS.archived` is `[]` (empty array) in `packages/core/src/session-lifecycle.ts` line 64
**Impact**: Phase 6 must add `summarized` to the `archived` transitions array. This is a one-line change but downstream consumers (TUI lifecycle badges, query filters) that assume sessions only move forward must handle this edge case.

#### [CROSS.7] Dual workspace normalization (bash + TypeScript) -- Severity: LOW

**Two implementations**: `packages/hooks/git/resolve-workspace.sh` (bash) and `packages/shared/src/canonical.ts` (TypeScript)
**Risk**: If one is updated without the other, workspace IDs from git hooks may not match workspace IDs from CC hooks or the server. No cross-language test exists to verify parity.
**Impact**: Could cause workspace fragmentation (same repo appearing as two different workspaces). Low probability if neither implementation changes, but worth noting.

#### [CROSS.8] `sessions.remote_env_id` has no FK constraint -- Severity: LOW

**Actual state**: `packages/server/src/db/migrations/001_initial.sql` line 71: `remote_env_id TEXT` with comment "FK to remote_envs added in Phase 5 migration"
**Impact**: Phase 5 Task 6 migration must `ALTER TABLE sessions ADD CONSTRAINT` to create the FK. Already documented in Phase 5 DAG.

#### [CROSS.9] No `ws/` directory exists on server -- Severity: LOW

**Phase 4 Task 2 requires**: Creating `packages/server/src/ws/` directory with WebSocket server, connection manager, subscription handling, broadcast
**Actual state**: Directory does not exist. `ws` npm package IS already installed in server.
**Impact**: Phase 4 must create the entire directory structure. Already documented in Phase 4 DAG.

#### [CROSS.10] CLI ApiClient is minimal -- Severity: MEDIUM

**Phase 4 Task 3 spec**: Replaces existing `createApiClient()` with comprehensive `ApiClient` class with methods for sessions, workspaces, timeline, health, etc.
**Actual state**: `packages/cli/src/lib/api-client.ts` has `createApiClient()` with `ingest()` and `health()` methods
**Impact**: Phase 4 must expand this significantly while maintaining backward compatibility for `emit.ts` and `drain.ts` which import `createApiClient`. The spec explicitly calls this out.

#### [CROSS.11] `capturing` lifecycle state transition -- Severity: NONE (resolved)

**Previous concern**: No code transitions sessions to `capturing` state
**Actual state**: `session.start` handler sets lifecycle to `detected`. The `capturing` state is in the transition map but only reached if a future mechanism explicitly transitions `detected -> capturing`.
**Impact**: Git-session correlation correctly queries `lifecycle IN ('detected', 'capturing')` so this does not affect correlation. The `detected -> ended` path (skipping capturing) is valid and used for all sessions currently.

#### [CROSS.12] Phase 4 needs Ink + React + picocolors -- Severity: LOW

**Phase 4 DAG specifies**:
```bash
cd packages/cli && bun add picocolors ws ink react
cd packages/cli && bun add -d @types/react @types/ws ink-testing-library
```
**Actual state**: None of these are in `packages/cli/package.json` yet.
**Impact**: Phase 4 must install these dependencies. The Phase 1 DAG notes a potential Bun+Ink compatibility concern (audit #13) that should be smoke-tested early.

---

## 6. Event Pipeline Summary

```
Hook fires (CC or Git)
    |
    v
fuel-code emit --type <type> --data-stdin < payload
    |
    v
HTTP POST /api/events/ingest (batch)
    |  (on failure: queue to ~/.fuel-code/queue/)
    v
Redis Stream XADD (fuel-code:events)
    |
    v
Consumer XREADGROUP (blocking on dedicated Redis client)
    |
    v
processEvent(sql, event, registry, logger, pipelineDeps)
    |-- resolveOrCreateWorkspace (canonical ID -> ULID)
    |-- resolveOrCreateDevice
    |-- ensureWorkspaceDeviceLink
    |-- INSERT event (ON CONFLICT DO NOTHING)
    |-- validateEventPayload (Zod schema check)
    |-- dispatch to handler via registry.getHandler(event.type)
    v
Handler (e.g., handleSessionEnd)
    |-- Updates session row
    |-- Triggers pipeline via pipelineDeps.enqueueSession(sessionId)
    v
Pipeline Queue (bounded: 3 concurrent, 50 max)
    |
    v
runSessionPipeline(sessionId, deps)
    |-- Download transcript from S3
    |-- parseTranscript() -> transcript_messages + content_blocks
    |-- transitionSession(ended -> parsed)
    |-- generateSummary() via Anthropic API
    |-- transitionSession(parsed -> summarized)
```

---

## 7. Key Architecture Patterns

1. **Dependency Injection**: Every module accepts deps via constructor/factory params (`createApp(deps)`, `createEventsRouter({redis})`, `processEvent(sql, event, registry, logger, pipelineDeps)`)

2. **Handler Registry**: `EventHandlerRegistry` is a Map<EventType, EventHandler>. New phases register handlers via `registry.register()`. The `createHandlerRegistry()` factory pre-registers current handlers but returns the mutable registry.

3. **Optimistic Locking**: All lifecycle transitions use `UPDATE ... WHERE lifecycle = $expected RETURNING ...`. Failed transitions return empty result (no error thrown).

4. **Three-Layer Idempotency**: (a) Event INSERT ON CONFLICT DO NOTHING by ULID, (b) Handler-level ON CONFLICT in individual handlers, (c) Correlation guard in git-correlator.

5. **Pipeline Wiring**: `wire.ts` creates a closure-bound `process(event)` function that captures `sql`, `registry`, `logger`, `pipelineDeps`. The consumer only needs the registry and process function.

6. **Graceful Degradation**: CLI falls back to local queue on network failure. Pipeline queue bounds concurrency. Recovery runs on startup for stuck sessions.

---

## 8. Task Files Index

### Phase 1 (`tasks/phase-1/`)
- `dag.md` -- DAG + design decisions
- `task-1.md` through `task-14.md` -- Individual task specs

### Phase 2 (`tasks/phase-2/`)
- `dag.md` -- DAG + design decisions
- `task-1.md` through `task-12.md` -- Individual task specs

### Phase 3 (`tasks/phase-3/`)
- `dag.md` -- DAG + design decisions
- `task-1.md` through `task-6.md` -- Individual task specs

### Phase 4 (`tasks/phase-4/`)
- `dag.md` -- DAG + design decisions + timeline response shape amendment
- `task-1.md` through `task-10.md` -- Individual task specs

### Phase 5 (`tasks/phase-5/`)
- `dag.md` -- DAG + design decisions
- `task-1.md` through `task-15.md` -- Individual task specs

### Phase 6 (`tasks/phase-6/`)
- `dag.md` -- DAG + design decisions
- `task-1.md` through `task-14.md` -- Individual task specs

### Phase 7 (`tasks/phase-7/`)
- `dag.md` -- DAG + design decisions
- `task-1.md` through `task-8.md` -- Individual task specs

### Review Documents (`tasks/`)
- `phase-1-implementation-review.md` -- Post-implementation review of Phase 1
- `phase-1-downstream-review.md` -- Phase 1 impact on Phases 2-7
- `phase-2-implementation-review.md` -- Post-implementation review of Phase 2
- `phase-2-downstream-review.md` -- Phase 2 impact on Phases 3-7
- `phase-2-post-impl-updates-review.md` -- Review of Phase 2 post-implementation fixes
- `phase-3-implementation-review.md` -- Post-implementation review of Phase 3
- `phase-3-downstream-review.md` -- Phase 3 impact on Phases 4-7 (includes retracted git-hooks-on-remote finding)
- `downstream-template.md` -- Template for future downstream impact reviews
