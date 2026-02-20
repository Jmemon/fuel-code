# fuel-code Repository Index

> **Generated**: 2026-02-20
> **Codebase state**: Phases 1-4 implemented, Phases 5-7 planned
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
      index.ts                              # Barrel: event, workspace, device, session, transcript, git-activity, ws
      event.ts                              # Event, EventType (14 types), EVENT_TYPES[], IngestRequest/Response, BlobRef
      workspace.ts                          # Workspace interface
      device.ts                             # Device interface
      session.ts                            # Session interface, SessionLifecycle type
      transcript.ts                         # TranscriptMessage, ContentBlock, ParsedContentBlock interfaces
      git-activity.ts                       # GitActivity, GitActivityType interfaces
      ws.ts                                 # WebSocket protocol types: ClientMessage, ServerMessage, SessionStats (Phase 4)
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
      fixtures/
        sample-transcript.jsonl
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
    ws/                                     # (Phase 4) WebSocket real-time update system
      index.ts                              # createWsServer() — WS server on /api/ws, auth, subscriptions, keepalive
      broadcaster.ts                        # createBroadcaster() — fan-out events/session updates/remote updates to clients
      types.ts                              # ConnectedClient, re-exports shared WS types
      __tests__/
        ws-server.test.ts
    pipeline/
      wire.ts                               # createEventHandler() — wiring layer: registry + bound process function
      consumer.ts                           # startConsumer() — Redis Stream XREADGROUP loop, event dispatch, WS broadcast
      __tests__/
        consumer.test.ts
    routes/
      health.ts                             # GET /api/health — Postgres + Redis connectivity + ws_clients count
      events.ts                             # POST /api/events/ingest — batch event ingestion
      transcript-upload.ts                  # POST /api/sessions/:id/transcript/upload — S3 + pipeline trigger
      session-actions.ts                    # POST /api/sessions/:id/reparse — re-trigger parsing pipeline
      sessions.ts                           # GET /sessions, GET /sessions/:id, GET /sessions/:id/transcript, etc.
      timeline.ts                           # GET /api/timeline — session-grouped activity feed
      prompts.ts                            # GET /api/prompts/pending, POST /api/prompts/:workspace_id/dismiss
      workspaces.ts                         # (Phase 4) GET /api/workspaces, GET /api/workspaces/:id — aggregated workspace data
      devices.ts                            # (Phase 4) GET /api/devices, GET /api/devices/:id — device data with associations
      __tests__/
        events.test.ts
        prompts.test.ts
        session-reparse.test.ts
        sessions.test.ts
        timeline.test.ts
        transcript-upload.test.ts
        workspaces.test.ts                  # (Phase 4) 28 tests
        devices.test.ts                     # (Phase 4) 12 tests
    __tests__/
      e2e/
        pipeline.test.ts                    # Phase 1 E2E: hook -> emit -> ingest -> Redis -> processor -> Postgres
        phase2-pipeline.test.ts             # Phase 2 E2E: session lifecycle, transcript, parse, summarize
        phase3-git-tracking.test.ts         # Phase 3 E2E: git hooks, event handlers, timeline, auto-prompt
        fixtures/
          test-transcript.jsonl
```

### packages/cli/

```
packages/cli/
  package.json                              # @fuel-code/cli — commander, ink, react, picocolors, ws, pino, yaml, zod
  tsconfig.json
  src/
    index.ts                                # Commander entry point: init, status, emit, queue, hooks, transcript, backfill,
                                            #   sessions, session, timeline, workspaces, workspace (TUI on no subcommand)
    commands/
      init.ts                               # fuel-code init — generate config, register device
      status.ts                             # (Phase 4) fuel-code status — device, backend connectivity (latency), hooks, queue, today summary
      emit.ts                               # fuel-code emit — emit event with local queue fallback
      queue.ts                              # fuel-code queue — status/drain/dead-letter subcommands
      hooks.ts                              # fuel-code hooks — install/status subcommands (CC hooks + git hooks)
      transcript.ts                         # fuel-code transcript upload — POST transcript to server
      backfill.ts                           # fuel-code backfill — scan + ingest historical sessions
      sessions.ts                           # (Phase 4) fuel-code sessions — tabular list with filters, --json flag
      session-detail.ts                     # (Phase 4) fuel-code session <id> — detail card, --transcript, --events, --git, --export, --tag
      timeline.ts                           # (Phase 4) fuel-code timeline — session-grouped feed with date headers, relative dates
      workspaces.ts                         # (Phase 4) fuel-code workspaces / workspace <name> — list + detail with hook status
      __tests__/
        backfill.test.ts
        emit.test.ts
        hooks.test.ts
        hooks-git.test.ts
        transcript.test.ts
        status.test.ts                      # (Phase 4) 25 tests
        sessions.test.ts                    # (Phase 4) 24 tests
        session-detail.test.ts              # (Phase 4) 28 tests
        timeline.test.ts                    # (Phase 4) 23 tests
        workspaces.test.ts                  # (Phase 4) 28 tests
    lib/
      api-client.ts                         # (Phase 4) FuelApiClient class — full endpoint coverage, typed responses, error classes;
                                            #   createApiClient() compat shim for Phase 1 consumers (emit.ts, drain.ts)
      ws-client.ts                          # (Phase 4) WsClient — EventEmitter, auto-reconnect, subscription persistence, backoff
      config.ts                             # loadConfig(), saveConfig(), configExists() — ~/.fuel-code/config.yaml
      drain.ts                              # drainQueue() — batch event drain with retry
      drain-background.ts                   # Background drain worker
      queue.ts                              # enqueue(), list(), read(), remove(), moveToDeadLetter(), depths()
      resolvers.ts                          # (Phase 4) resolveWorkspaceName(), resolveDeviceName() — fuzzy name/ULID resolution
      session-resolver.ts                   # (Phase 4) resolveSessionId() — prefix match, ambiguity detection
      formatters.ts                         # (Phase 4) formatDuration/Cost/RelativeTime/Lifecycle/Tokens/Number, renderTable, outputResult
      transcript-renderer.ts                # (Phase 4) renderTranscript(), renderMessage(), renderToolUseTree(), formatToolSummary()
      git-hook-installer.ts                 # installGitHooks() — global core.hooksPath setup
      git-hook-status.ts                    # getGitHookStatus() — check if git hooks are installed
      git-hooks-prompt.ts                   # showGitHooksPrompt() — interactive Y/n prompt
      prompt-checker.ts                     # checkPendingPrompts(), dismissPrompt() — server prompt API
      __tests__/
        api-client.test.ts                  # (Phase 4) ~40 tests
        ws-client.test.ts                   # (Phase 4) 30 tests
        config.test.ts
        drain.test.ts
        git-hook-installer.test.ts
        prompt-checker.test.ts
        queue.test.ts
        resolvers.test.ts                   # (Phase 4) ~8 tests
        formatters.test.ts                  # (Phase 4) ~42 tests
        transcript-renderer.test.ts         # (Phase 4) 16 tests
    tui/                                    # (Phase 4) Ink/React TUI dashboard
      App.tsx                               # Root: view routing (dashboard/session-detail), global keybinds (q/b), launchTui()
      Dashboard.tsx                         # Two-column layout, WS debounce (500ms), polling fallback (10s)
      SessionDetailView.tsx                 # Header + TranscriptViewer (~65%) + Sidebar (~35%), tab switching (t/e/g)
      hooks/
        useWorkspaces.ts                    # Fetch workspaces from API
        useSessions.ts                      # Fetch sessions, updateSession/prependSession for WS updates
        useSessionDetail.ts                 # Parallel fetch session+transcript+git, WS subscription for live sessions
        useTodayStats.ts                    # Aggregate today's stats from workspaces data
        useWsConnection.ts                  # WsClient lifecycle, subscribe/unsubscribe
      components/
        Sidebar.tsx                         # Workspace + session list, extractToolCounts/extractModifiedFiles
        SessionRow.tsx                      # Single row: lifecycle icon, duration, cost, summary
        SessionHeader.tsx                   # Session metadata: model, branch, tokens, cost, dates
        GitActivityPanel.tsx                # Git commits within session
        FilesModifiedPanel.tsx              # Files changed (from git + tool use)
        ToolsUsedPanel.tsx                  # Tool usage counts
        MessageBlock.tsx                    # Single message with content blocks, tool input extraction, thinking collapse
        TranscriptViewer.tsx                # Windowed rendering (10-message window), auto-scroll for live sessions
        WorkspaceItem.tsx                   # Workspace entry in sidebar
        StatusBar.tsx                       # Footer: today stats, WS indicator, key hints
        FooterBar.tsx                       # Command help footer
        ErrorBanner.tsx                     # Error display
        Spinner.tsx                         # Loading spinner
      __tests__/
        Dashboard.test.tsx                  # 18 tests
        SessionDetail.test.tsx              # 27 tests
        TranscriptViewer.test.tsx           # 13 tests
        MessageBlock.test.tsx               # 6 tests
        Sidebar.test.tsx                    # 9 tests
        hooks.test.tsx                      # 10 tests
        components.test.tsx                 # 10 tests
    __tests__/
      e2e/                                  # (Phase 4) E2E tests against real Postgres + Redis + Express + WS
        setup.ts                            # Real infra setup, port 0 allocation, advisory lock for parallel seeding
        fixtures.ts                         # 3 workspaces, 2 devices, 8 sessions, 20+ events, 5 git_activity, transcript data
        helpers.ts                          # Test utilities
        phase4-cli.test.ts                  # 14 tests: sessions, session detail, timeline, workspaces, status
        phase4-ws.test.ts                   # 4 tests: connect, subscribe-all, workspace filter, session updates
        phase4-tui.test.tsx                 # 3 tests: dashboard render, session list, selection
        phase4-errors.test.ts               # 3 tests: backend unreachable, 404, 401
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
  phase-1/                                  # DAG + task specs + review docs
  phase-2/                                  # DAG + task specs + review docs
  phase-3/                                  # DAG + task specs + review docs
  phase-4/                                  # DAG + task specs + review docs
  phase-5/ through phase-7/                 # DAGs + per-task spec files
docker-compose.test.yml                     # Postgres + Redis + LocalStack for E2E tests
package.json                                # Root workspace: { "workspaces": ["packages/*"] }
tsconfig.base.json                          # Base TypeScript config (ESNext, strict, composite)
bunfig.toml                                 # Bun runtime config (peer=false)
CLAUDE.md                                   # Project instructions (no co-authored-by)
```

---

## 2. Per-Package Capability Summary

### @fuel-code/shared (Contract Layer)

**What it does today:**
- Defines all TypeScript types for the 5 core abstractions: Event, Workspace, Device, Session, Blueprint (type-only for Blueprint, not yet populated)
- Defines `GitActivity` and `GitActivityType` types
- Defines `TranscriptMessage`, `ContentBlock`, and `ParsedContentBlock` types
- Defines WebSocket protocol types: `ClientMessage`, `ServerMessage`, `SessionStats` (Phase 4)
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

### @fuel-code/server (HTTP Server + Event Consumer + WebSocket)

**What it does today:**
- **Express app** with middleware: JSON parsing (1MB limit), helmet, CORS (disabled), pino-http logging, Bearer token auth, error handler
- **Startup sequence**: validate env -> Postgres -> migrations -> 2 Redis clients (blocking + non-blocking) -> consumer group -> S3 -> pipeline deps -> pipeline queue -> Express -> HTTP server -> WebSocket server -> consumer -> delayed recovery (5s)
- **Graceful shutdown**: stop HTTP -> stop WS (close clients, 1s timeout) -> drain pipeline queue -> stop consumer -> disconnect Redis -> close Postgres (30s timeout)
- **WebSocket server** (Phase 4):
  - Attaches to HTTP server on `/api/ws?token=<api_key>`
  - Token validation on upgrade (close 4001 on auth fail)
  - ULID client IDs, subscription management via Set<string>
  - Subscribe scopes: `"all"`, `"workspace:<id>"`, `"session:<id>"`
  - Ping/pong keepalive: 30s interval, 10s pong timeout
  - Non-blocking broadcaster: `broadcastEvent()`, `broadcastSessionUpdate()`, `broadcastRemoteUpdate()`
  - Consumer calls broadcaster after event processing (broadcast on every ingested event + session lifecycle changes)
- **API endpoints**:
  - `GET /api/health` (unauthenticated) — Postgres + Redis check + `ws_clients` count
  - `POST /api/events/ingest` — batch event ingestion, per-event results array
  - `POST /api/sessions/:id/transcript/upload` — stream to S3, trigger pipeline
  - `POST /api/sessions/:id/reparse` — re-trigger parsing
  - `GET /api/sessions` — list with cursor pagination, filtering (workspace, device, lifecycle, date range, tag)
  - `GET /api/sessions/:id` — full session detail with stats
  - `GET /api/sessions/:id/transcript` — parsed messages + content blocks
  - `GET /api/sessions/:id/transcript/raw` — S3 presigned URL redirect
  - `GET /api/sessions/:id/events` — events within session
  - `GET /api/sessions/:id/git` — git activity during session
  - `PATCH /api/sessions/:id` — update tags, summary
  - `GET /api/timeline` — session-grouped activity feed with git highlights and orphan events
  - `GET /api/prompts/pending` — pending prompts for current device
  - `POST /api/prompts/:workspace_id/dismiss` — dismiss prompt (accepted/declined)
  - `GET /api/workspaces` (Phase 4) — paginated list with session/device/cost aggregates, keyset pagination
  - `GET /api/workspaces/:id` (Phase 4) — detail with recent sessions, devices, git summary, stats; ID resolution by ULID/name/canonical
  - `GET /api/devices` (Phase 4) — list with session/workspace counts (CTE-based to prevent cross-join inflation)
  - `GET /api/devices/:id` (Phase 4) — detail with workspace associations and recent sessions
- **Redis Stream consumer**: blocking XREADGROUP on dedicated Redis client, dispatches to event processor, broadcasts via WS after processing
- **Database**: 4 SQL migrations, 8 tables (workspaces, devices, workspace_devices, sessions, events, transcript_messages, content_blocks, git_activity)

**Dependencies:** @fuel-code/core, @fuel-code/shared, express (^5.2.1), ioredis (^5.9.3), postgres (^3.4.8), @aws-sdk/client-s3 (^3.993.0), @aws-sdk/s3-request-presigner (^3.993.0), ws (^8.19.0), helmet (^8.1.0), cors (^2.8.6), pino (^10.3.1), pino-http (^11.0.0), dotenv (^17.3.1), zod (3)

### @fuel-code/cli (Command-Line Interface + TUI)

**What it does today:**
- **Commander entry point** with 11 commands: init, status, emit, queue, hooks, transcript, backfill, sessions, session, timeline, workspaces/workspace
- **Default action (no subcommand)**: launches full-screen TUI dashboard via `launchTui()`
- **Phase 1-3 commands**:
  - `fuel-code init` — generate config at `~/.fuel-code/config.yaml`, register device
  - `fuel-code emit` — emit event to server, with `--workspace-id` and `--data-stdin` flags, local queue fallback on failure
  - `fuel-code queue status|drain|dead-letter` — queue management
  - `fuel-code hooks install|status` — install CC hooks + git hooks, check status
  - `fuel-code transcript upload` — POST transcript file to server for pipeline processing
  - `fuel-code backfill` — scan `~/.claude/projects/` for historical sessions, upload, process
- **Phase 4 CLI commands**:
  - `fuel-code status` — enriched: device info, backend connectivity (latency), active/recent sessions, queue depth, hook status (CC + git), today's summary; graceful degradation via `Promise.allSettled()`
  - `fuel-code sessions` — tabular list with filters: `--workspace`, `--device`, `--today`, `--live`, `--lifecycle`, `--tag`, `--limit`, `--cursor`, `--json`
  - `fuel-code session <id>` — detail card with flags: `--transcript` (rendered with tool tree), `--events` (table), `--git` (activity), `--export json|md`, `--tag <name>`, `--reparse`, `--json`. ID resolution: full ULID, 8+ char prefix, ambiguity detection with candidate list
  - `fuel-code timeline` — session-grouped feed with date headers, `--workspace`, `--after`/`--before` (supports relative dates: `-3d`, `-1w`, `-12h`), `--json`
  - `fuel-code workspaces` / `fuel-code workspace <name>` — list with session/device/cost aggregates; detail with devices (hook status ✓/✗), recent sessions, git activity. Name/canonical/ULID resolution with prefix matching.
- **Phase 4 TUI (Ink/React)**:
  - Dashboard: two-column (sidebar ~30%, sessions ~70%), WS-driven live updates with 500ms debounce (max 2 renders/sec), 10s polling fallback when WS disconnected
  - Session Detail: header + TranscriptViewer (~65%) + sidebar (~35%), tab switching (t=transcript, e=events, g=git), lazy event fetching, keyboard nav (j/k scroll, Space/PageDown/PageUp, x=export, b=back), WS subscription for live sessions
  - TranscriptViewer: windowed rendering (10-message window), auto-scroll for live sessions (preserves position if user scrolled up)
  - 13 components, 5 hooks
- **API client** (Phase 4): `FuelApiClient` class with ~15 endpoint methods (sessions, workspaces, devices, timeline, health, ingest). Structured errors: `ApiError` (HTTP status), `ApiConnectionError` (network). `createApiClient()` compat shim for emit.ts/drain.ts.
- **WS client** (Phase 4): `WsClient` EventEmitter. Auto-reconnect with exponential backoff (1s→30s cap, 10 max attempts, jitter). Subscription persistence across reconnects. Ping auto-response.
- **Output formatters** (Phase 4): `formatDuration()`, `formatCost()`, `formatRelativeTime()`, `formatLifecycle()` (colored icons), `formatTokens()`, `renderTable()` (ANSI-aware column alignment), `outputResult()` (JSON/text dispatch), `formatError()`.
- **Transcript renderer** (Phase 4): `renderTranscript()`, `renderMessage()`, `renderToolUseTree()`. Tool-specific summaries for Read/Edit/Write/Bash/Grep/Glob. Thinking block collapse. Word wrapping. Truncation footer.
- **Name resolvers** (Phase 4): `resolveWorkspaceName()`, `resolveDeviceName()` — case-insensitive exact + prefix matching, ambiguity detection.
- **Pre-action hook**: checks pending prompts on interactive commands (sessions, session, timeline, workspaces, workspace, status, hooks, backfill)

**Dependencies:** @fuel-code/shared, commander (^14.0.3), ink (^6.8.0), react (^19.2.4), picocolors (^1.1.1), ws (^8.19.0), pino (^10.3.1), yaml (^2.8.2), zod (3)
**Dev dependencies:** @types/node, @types/react, @types/ws, ink-testing-library

### @fuel-code/hooks (Hook Scripts)

**What it does today:**
- **Claude Code hooks** (bash wrapper -> TypeScript helper -> `fuel-code emit`):
  - `SessionStart.sh` + `_helpers/session-start.ts` — emit session.start with workspace ID, device ID, git branch, cwd
  - `SessionEnd.sh` + `_helpers/session-end.ts` — emit session.end, trigger background transcript upload
  - `_helpers/resolve-workspace.ts` — resolve workspace canonical ID from git remote URL
- **Git hooks** (pure bash, fire-and-forget):
  - `post-commit` — emit git.commit with SHA, message, branch, diff stats
  - `pre-push` — emit git.push with refs, remote
  - `post-checkout` — emit git.checkout with old/new refs, branch flag
  - `post-merge` — emit git.merge with squash flag
  - `resolve-workspace.sh` — bash implementation of git remote normalization
- **Safety invariants**: all hooks exit 0, check `command -v fuel-code`, background emit with `&`, no terminal output

**Dependencies:** @fuel-code/shared

---

## 3. Database Schema (As-Built)

### Tables (8 total across 4 migrations)

| Table | Migration | Columns (key) | Indexes |
|-------|-----------|---------------|---------|
| `workspaces` | 001 | id (TEXT PK), canonical_id (UNIQUE), display_name, default_branch, metadata (JSONB) | canonical_id unique |
| `devices` | 001 | id (TEXT PK), name, type (local/remote), hostname, os, arch, status | — |
| `workspace_devices` | 001+004 | workspace_id+device_id (composite PK), local_path, hooks_installed, git_hooks_installed, pending_git_hooks_prompt, git_hooks_prompted | partial index on pending_git_hooks_prompt |
| `sessions` | 001 | id (TEXT PK), workspace_id (FK), device_id (FK), remote_env_id (no FK yet), lifecycle (7 states), started_at, ended_at, transcript_s3_key, parse_status, summary, 10 metric columns, tags (TEXT[]), metadata (JSONB) | workspace, device, lifecycle, tags (GIN), needs_recovery |
| `events` | 001 | id (TEXT PK), type, timestamp, device_id (FK), workspace_id (FK), session_id (FK nullable), data (JSONB), blob_refs (JSONB) | workspace_time, session, type, device |
| `transcript_messages` | 002 | id (PK), session_id (FK CASCADE), role, content, turn_number, timestamp, token_count, cache_status, thinking_content | session+ordinal, session+compact_sequence |
| `content_blocks` | 002 | id (PK), message_id (FK CASCADE), session_id (FK), block_type, content, language, tool_name, tool_input, tool_result, is_error | message+block_order, session, tool_name, full-text on content_text |
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

### Phase 1: Foundation (14 tasks) — IMPLEMENTED

**Goal**: Events flow from hooks to Postgres. Hook fires, event emitted, reaches backend via Redis Streams, processed into Postgres, queryable.

**Tasks**: (1) Monorepo scaffold, (2) Shared types/schemas, (3) Postgres+schema, (4) Redis client, (5) CLI config+init, (6) Express server+middleware, (7) Core resolvers, (8) Ingest endpoint, (9) Event processor+handlers, (10) CLI emit+queue, (11) Wire consumer, (12) Queue drainer, (13) Hook scripts+install, (14) E2E integration test.

**Status**: Fully implemented. All 14 tasks complete. All source files exist. E2E tests pass.

### Phase 2: Session Lifecycle (12 tasks) — IMPLEMENTED

**Goal**: Turn sessions from records into fully processed, searchable, summarized objects with transcripts in S3, parsed messages in Postgres, aggregate stats, LLM summaries, and REST API.

**Tasks**: (1) DB migration (transcript tables), (2) Shared transcript types+S3 keys, (3) S3 client, (4) Session lifecycle state machine, (5) Transcript parser, (6) Summary generator, (7) Session pipeline orchestrator, (8) Transcript upload endpoint, (9) Session API endpoints, (10) Reparse+recovery, (11) Backfill scanner+CLI, (12) E2E integration test.

**Status**: Fully implemented. All 12 tasks complete.

### Phase 3: Git Tracking (6 tasks) — IMPLEMENTED

**Goal**: Capture git activity alongside CC sessions. Commits, pushes, checkouts, merges are tracked, correlated to sessions, and queryable via timeline API.

**Tasks**: (1) Git hook script templates, (2) Git hook installer+chaining, (3) Git event handlers+git_activity table, (4) Auto-prompt for git hook installation, (5) Timeline API endpoint, (6) E2E integration test.

**Status**: Fully implemented. All 6 tasks complete. 4 git event handlers registered. Timeline endpoint returns discriminated union. Git-session correlation heuristic working. Auto-prompt system functional.

### Phase 4: CLI + TUI (10 tasks) — IMPLEMENTED

**Goal**: Primary user interface. CLI query commands and interactive TUI dashboard with live WebSocket updates.

**Tasks**: (1) Workspace+device REST endpoints, (2) WebSocket server, (3) API client+formatting, (4) `fuel-code sessions`+timeline commands, (5) `fuel-code session <id>` detail, (6) `fuel-code workspaces`+status commands, (7) WebSocket client library, (8) TUI dashboard, (9) TUI session detail, (10) E2E integration test.

**Implementation highlights**:
- **Data/presentation separation**: every CLI command exports `fetchX()` (data) and `formatX()` (presentation) separately. TUI imports the data layer directly.
- **FuelApiClient class**: replaces Phase 1 minimal client. ~15 typed endpoint methods. `createApiClient()` shim preserved for backward compat.
- **WS stack**: non-blocking broadcaster (fire-and-forget), subscription matching (all/workspace/session), ping/pong keepalive. Consumer broadcasts after every processed event.
- **WsClient**: EventEmitter with auto-reconnect (exponential backoff), subscription persistence, 4001 auth rejection detection.
- **TUI**: Ink/React. 13 components, 5 hooks. 500ms debounce buffer for WS updates (max 2 renders/sec). 10s polling fallback. Windowed transcript rendering (10-message window). Auto-scroll for live sessions.
- **Output formatters**: consistent duration/cost/time/lifecycle/table formatting. `outputResult()` provides `--json` flag support on all commands.
- **E2E tests**: 24 tests across 4 suites (CLI, WS, TUI, errors) against real Postgres+Redis+Express+WS. Port 0 allocation, advisory locks for parallel execution.

**Stats**: 49 production files (+7,285 lines), 27 test files (+11,492 lines). ~450 Phase 4 tests, ~1,033 total tests pass.

**Status**: Fully implemented. All 10 tasks complete.

### Phase 5: Remote Dev Environments (15 tasks) — PLANNED

**Goal**: Disposable remote dev environments. Auto-detect project env, provision EC2+Docker, SSH in, remote events flow through existing pipeline.

**Key design decisions**: EC2 client as interface+mock, provisioning is server-side, user-data as bash template, ephemeral SSH keys (one-time S3 download), per-user security group, blueprint detection is pure (no I/O in detector), lifecycle enforcer with orphan detection, graceful Ctrl-C during provisioning.

**Status**: Not started. `remote_envs` and `blueprints` tables do NOT exist. `infra/` directory does NOT exist. Phase 5 creates all new infrastructure.

### Phase 6: Hardening (14 tasks) — PLANNED

**Goal**: Production readiness. Shared retry utility, hardened queue drain, comprehensive error messages, session archival, EC2 orphan detection, graceful Ctrl-C, progress indicators, cost estimation.

**Key design decisions**: Single `withRetry()` in shared, EC2 tags atomic via TagSpecifications, archival with S3 backup integrity verification, per-event batch isolation in drain, shutdown manager with cleanup stack, multi-check orphan verification with grace period.

**Status**: Not started.

### Phase 7: Slack Integration + Change Orchestration (8 tasks) — PLANNED

**Goal**: Slack-driven change request workflow. User messages Slack bot, fuel-code provisions remote env, runs headless Claude Code, deploys preview, sends Approve/Reject buttons.

**Key design decisions**: Change Request as 6th abstraction, EC2 is the preview, remote env TTL override for change requests, headless CC via `claude --task`, simple merge strategy (git merge --no-ff), Slack security via user ID verification.

**Status**: Not started. New `change_requests` table needed. New `change.*` event types NOT yet in EVENT_TYPES array.

---

## 5. Cross-Phase Assumptions Inventory

### Confirmed Working

| # | Assumption | Status | Evidence |
|---|-----------|--------|----------|
| 1 | GitActivity type exists in shared | OK | `packages/shared/src/types/git-activity.ts` |
| 2 | Timeline API returns `{ items, next_cursor, has_more }` | OK | `packages/server/src/routes/timeline.ts` |
| 3 | Git hooks on remote environments | OK | Phase 5 user-data.sh template includes `fuel-code hooks install` |
| 4 | Handler registry extensible post-creation | OK | `EventHandlerRegistry.register()` is public |
| 5 | EVENT_TYPES includes remote.* types | OK | `packages/shared/src/types/event.ts` includes all 4 remote event types |
| 6 | Pipeline queue used and wired | OK | `pipelineDeps.enqueueSession` wired in `packages/server/src/index.ts` |
| 7 | pipelineDeps passed through consumer | OK | `packages/server/src/pipeline/consumer.ts` passes pipelineDeps to processEvent |
| 8 | WsBroadcaster interface has broadcastRemoteUpdate() | OK | `packages/server/src/ws/broadcaster.ts` — all 3 methods exported |
| 9 | ServerRemoteUpdateMessage type in shared WS types | OK | `packages/shared/src/types/ws.ts` — type exists |
| 10 | WsClient handles incoming remote.update messages | OK | Generic dispatch in `ws-client.ts` emits all ServerMessage types |
| 11 | Consumer broadcasts after event processing | OK | `consumer.ts` broadcasts event + session lifecycle after processEvent() |
| 12 | FuelApiClient class extensible for new endpoint methods | OK | Class-based at `packages/cli/src/lib/api-client.ts` |
| 13 | Commander entry point supports new command registration | OK | `packages/cli/src/index.ts` uses `.addCommand()` pattern |
| 14 | TUI App.tsx view routing supports new views | OK | View enum pattern in `App.tsx` |
| 15 | Output formatters reusable for future commands | OK | All exported from `formatters.ts` |

### Known Drift / Issues Requiring Attention

#### [CROSS.1] FuelCodeError constructor signature mismatch — Severity: MEDIUM

**Phase 6 Task 2 spec assumes**: `new FuelCodeError(message, options?)` where options is `{ code, context }`
**Actual implementation**: `new FuelCodeError(message, code, context)` — three positional arguments
**File**: `packages/shared/src/errors.ts`
**Impact**: Phase 6 Task 2's error message framework must use the actual 3-arg constructor.

#### [CROSS.2] EventHandlerContext lacks extensibility for Phase 5-7 deps — Severity: MEDIUM

**Downstream phases assume**: Handlers can access remote-env-specific or change-request-specific dependencies
**Actual implementation**: `EventHandlerContext` has `{ sql, event, workspaceId, logger, pipelineDeps? }` (`packages/core/src/event-processor.ts`)
**Impact**: Phase 5 remote event handlers and Phase 7 change event handlers need access to EC2 client, SSH key manager, Slack client, etc. Workaround: closure capture (handlers are factory functions that close over extra deps). This pattern is already demonstrated by `createHandlerRegistry()`.

#### [CROSS.3] `change.*` event types missing from EVENT_TYPES — Severity: HIGH

**Phase 7 spec assumes**: 7 `change.*` event types exist
**Actual implementation**: EVENT_TYPES array contains only 14 types. No `change.*` types.
**Impact**: Phase 7 Task 1 must add these types to the EventType union and EVENT_TYPES array, plus create corresponding Zod payload schemas.

#### [CROSS.4] ApiError uses `statusCode`, Phase 6 spec expects `.status` — Severity: MEDIUM

**Phase 4 actual**: `ApiError` has `statusCode: number` property at `packages/cli/src/lib/api-client.ts`
**Phase 6 Task 6 spec**: `isRetryableHttpError` predicate checks `error.status`
**Impact**: Phase 6 must use `error.statusCode` (actual name), not `error.status`. If predicate checks `.status`, it will be `undefined`.

#### [CROSS.5] `archived` -> `summarized` backward transition not implemented — Severity: MEDIUM

**Phase 6 Task 13 requires**: `archived -> summarized` transition for `--restore` functionality
**Actual implementation**: `TRANSITIONS.archived` is `[]` (empty array) in `packages/core/src/session-lifecycle.ts`
**Impact**: Phase 6 must add `summarized` to the `archived` transitions array.

#### [CROSS.6] Dual workspace normalization (bash + TypeScript) — Severity: LOW

**Two implementations**: `packages/hooks/git/resolve-workspace.sh` (bash) and `packages/shared/src/canonical.ts` (TypeScript)
**Risk**: If one is updated without the other, workspace IDs from git hooks may not match. No cross-language test exists.

#### [CROSS.7] `sessions.remote_env_id` has no FK constraint — Severity: LOW

**Actual state**: `001_initial.sql` has `remote_env_id TEXT` with no FK. Phase 5 Task 6 migration must `ALTER TABLE` to add the FK.

#### [CROSS.8] TUI debounce buffer is session-specific, not generic — Severity: LOW

**Phase 5 Task 14 needs**: `remote.update` WS events handled in TUI with real-time updates
**Actual state**: Dashboard debounce buffer is specifically for session updates in `useSessions` hook
**Impact**: Phase 5's `useRemotes` hook must implement its own debounce buffer.

#### [CROSS.9] Phase 4 ApiClient timeout is already 10s — Severity: NONE (informational)

Phase 6 spec references "up from 2s" but Phase 4 already uses `AbortSignal.timeout(10000)`. No change needed.

#### [CROSS.10] TUI today's commits hardcoded to 0 — Severity: LOW

`useTodayStats.ts` returns `commits: 0` because counting commits requires a separate API call. StatusBar always shows "0 commits".

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
    v
Consumer post-processing (Phase 4)
    |-- broadcaster.broadcastEvent(event) -> WS clients
    |-- broadcaster.broadcastSessionUpdate() on lifecycle changes -> WS clients
```

---

## 7. WebSocket Protocol (Phase 4)

### Connection

- Endpoint: `wss://<host>/api/ws?token=<api_key>`
- Auth: token validated on upgrade; close 4001 on failure
- Keepalive: server sends `ping` every 30s; client responds `pong` within 10s or is terminated

### Client -> Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `subscribe` | `{ scope: "all" }` or `{ workspace_id }` or `{ session_id }` | Subscribe to events |
| `unsubscribe` | `{ workspace_id? }` or `{ session_id? }` or `{}` (clear all) | Unsubscribe |
| `pong` | `{}` | Response to server ping |

### Server -> Client Messages

| Type | Fields | Description |
|------|--------|-------------|
| `event` | `{ event: Event }` | New event matching subscription |
| `session.update` | `{ session_id, lifecycle, summary?, stats? }` | Session lifecycle change |
| `remote.update` | `{ remote_env_id, status, public_ip? }` | Remote env status (Phase 5) |
| `ping` | `{}` | Keepalive ping |
| `error` | `{ message }` | Error message |
| `subscribed` | `{ subscription }` | Subscription acknowledgement |
| `unsubscribed` | `{ subscription }` | Unsubscription acknowledgement |

### Subscription Matching

A client receives a broadcast if any of:
- It has the `"all"` subscription
- It subscribes to the broadcast's `workspace_id`
- It subscribes to the broadcast's `session_id`

---

## 8. Key Architecture Patterns

1. **Dependency Injection**: Every module accepts deps via constructor/factory params (`createApp(deps)`, `createEventsRouter({redis})`, `processEvent(sql, event, registry, logger, pipelineDeps)`)

2. **Handler Registry**: `EventHandlerRegistry` is a Map<EventType, EventHandler>. New phases register handlers via `registry.register()`. The `createHandlerRegistry()` factory pre-registers current handlers but returns the mutable registry.

3. **Optimistic Locking**: All lifecycle transitions use `UPDATE ... WHERE lifecycle = $expected RETURNING ...`. Failed transitions return empty result (no error thrown).

4. **Three-Layer Idempotency**: (a) Event INSERT ON CONFLICT DO NOTHING by ULID, (b) Handler-level ON CONFLICT in individual handlers, (c) Correlation guard in git-correlator.

5. **Pipeline Wiring**: `wire.ts` creates a closure-bound `process(event)` function that captures `sql`, `registry`, `logger`, `pipelineDeps`. The consumer only needs the registry and process function.

6. **Graceful Degradation**: CLI falls back to local queue on network failure. Pipeline queue bounds concurrency. Recovery runs on startup for stuck sessions.

7. **Data/Presentation Separation** (Phase 4): Every CLI command exports `fetchX()` (data-fetching) and `formatX()` (presentation) separately. TUI imports data functions directly, avoiding duplication.

8. **Non-Blocking WS Broadcasting** (Phase 4): Broadcaster checks `readyState` before send, catches send errors, and removes failed clients. A slow or dead WS client never blocks the event processing pipeline.

9. **Debounced TUI Updates** (Phase 4): Dashboard buffers WS updates with 500ms flush interval (max 2 renders/sec). Falls back to 10s polling when WS is disconnected.

10. **Consistent Error UX** (Phase 4): All CLI commands provide context-specific error messages. No stack traces leak to users. `formatError()` classifies ApiError (HTTP) vs ApiConnectionError (network) vs generic Error.

---

## 9. Test Summary

### Test Counts by Package

| Package | Unit Test Files | E2E Test Files | Approximate Tests |
|---------|----------------|----------------|-------------------|
| shared | 4 | 0 | ~30 |
| core | 12 | 0 | ~70 |
| server (routes/middleware/redis/aws/ws/pipeline) | 11 | 3 (phases 1-3) | ~180 |
| cli (commands) | 10 | 0 | ~200 |
| cli (lib) | 10 | 0 | ~150 |
| cli (tui) | 7 | 0 | ~95 |
| cli (e2e) | 0 | 4 (phase 4) | ~24 |
| hooks | 3 | 0 | ~20 |
| **Total** | **~57** | **~7** | **~770+** |

### E2E Test Infrastructure

- `docker-compose.test.yml`: Postgres 16 (port 5433), Redis 7 (port 6380), LocalStack S3 (port 4566)
- Phase 1-3 E2E: in `packages/server/src/__tests__/e2e/` — event pipeline, session lifecycle, git tracking
- Phase 4 E2E: in `packages/cli/src/__tests__/e2e/` — CLI commands, WS, TUI, error handling
  - Port 0 allocation (OS-assigned random ports)
  - Advisory lock for parallel-safe fixture seeding
  - Proper cleanup sequence (consumer → WS → HTTP → Redis → Postgres)

---

## 10. Task Files Index

### Phase 1 (`tasks/phase-1/`)
- `dag.md` — DAG + design decisions
- `task-1.md` through `task-14.md` — Individual task specs
- `__implementation-review.md` — Post-implementation review
- `__downstream-review.md` — Impact on Phases 2-7

### Phase 2 (`tasks/phase-2/`)
- `dag.md` — DAG + design decisions
- `task-1.md` through `task-12.md` — Individual task specs
- `__implementation-review.md` — Post-implementation review
- `__downstream-review.md` — Impact on Phases 3-7
- `__post-impl-updates-review.md` — Review of post-implementation fixes

### Phase 3 (`tasks/phase-3/`)
- `dag.md` — DAG + design decisions
- `task-1.md` through `task-6.md` — Individual task specs
- `__implementation-review.md` — Post-implementation review
- `__downstream-review.md` — Impact on Phases 4-7

### Phase 4 (`tasks/phase-4/`)
- `dag.md` — DAG + design decisions + timeline response shape amendment
- `task-1.md` through `task-10.md` — Individual task specs
- `__implementation-review.md` — Post-implementation review (10 issues, 3 medium)
- `__downstream-review.md` — Impact on Phases 5-7 (6 findings, 1 medium requiring spec fix)

### Phase 5 (`tasks/phase-5/`)
- `dag.md` — DAG + design decisions
- `task-1.md` through `task-15.md` — Individual task specs

### Phase 6 (`tasks/phase-6/`)
- `dag.md` — DAG + design decisions
- `task-1.md` through `task-14.md` — Individual task specs

### Phase 7 (`tasks/phase-7/`)
- `dag.md` — DAG + design decisions
- `task-1.md` through `task-8.md` — Individual task specs

### Other Documents (`tasks/`)
- `CORE.md` — Master specification
- `downstream-template.md` — Template for downstream impact reviews
- `repo-index.md` — This file
