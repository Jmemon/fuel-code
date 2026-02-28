# Phase 1: Foundation — Task Dependency DAG

## Goal
Get from zero to "events flow from hooks to Postgres." A Claude Code session starts, hooks fire, events are emitted, they reach the backend, pass through Redis Streams, get processed into Postgres, and are queryable.

## Technology Decisions (locked in)
- CLI framework: commander
- Logging: pino
- Testing: bun:test
- DB migrations: Raw sequential SQL files + custom runner
- Redis client: ioredis
- Build orchestration: bun workspaces only
- ULID generation: ulidx
- Hook format: Bash wrapper → TypeScript helper → fuel-code emit
- DB client: postgres.js
- Runtime: bun (always)

## Task Dependency Graph

```
Group A ─── Task 1: Monorepo scaffold
               │
               ▼
Group B ─── Task 2: Shared types, schemas, utils
               │
        ┌──────┼──────────┐
        ▼      ▼          ▼
Group C ─── Task 3     Task 4     Task 5
            Postgres    Redis     CLI config
            + schema    client    + init cmd
        │      │          │
        ├──────┘    ┌─────┘
        ▼           ▼
Group D ─── Task 6           Task 7
            Express server   Core resolvers
            + middleware     (workspace, device)
        │           │
        ├───────────┤─────────┐
        ▼           ▼         ▼
Group E ─── Task 8       Task 9       Task 10
            Ingest       Event        CLI emit
            endpoint     processor    + queue
                         + handlers
        │           │         │
        ├───────────┤─────────┤
        ▼           ▼         ▼
Group F ─── Task 11      Task 12     Task 13
            Wire         Queue       Hook scripts
            consumer     drainer     + install cmd
               │            │            │
               └────────────┼────────────┘
                            ▼
Group G ─── Task 14: End-to-end integration test
```

## Dependency Edges (precise)
- Task 1 → all others (monorepo must exist)
- Task 2 → Tasks 3-14 (types imported everywhere)
- Task 3 → Tasks 6, 7, 9, 11 (Postgres needed for server, resolvers, processor)
- Task 4 → Tasks 6, 8, 11 (Redis needed for server health, ingest publishing, consumer)
- Task 5 → Tasks 10, 12, 13 (config needed for emit, drain, hooks)
- Task 6 → Tasks 8, 11 (Express app needed for routes, consumer startup)
- Task 7 → Task 9 (resolvers needed by event processor)
- Task 8 → Task 14 (ingest endpoint needed for E2E test)
- Task 9 → Task 11 (processor needed by consumer)
- Task 10 → Tasks 12, 13, 14 (emit/queue needed for drain, hooks, E2E)
- Task 11 → Task 14 (consumer needed for E2E)
- Task 13 → Task 14 (hooks needed for E2E)

## Parallel Groups
- **A**: Task 1
- **B**: Task 2
- **C**: Tasks 3, 4, 5 (all independent, all need only A+B)
- **D**: Tasks 6, 7 (independent, need C)
- **E**: Tasks 8, 9, 10 (independent, need D)
- **F**: Tasks 11, 12, 13 (independent, need E)
- **G**: Task 14 (needs everything)

## Critical Path
Task 1 → Task 2 → Task 3 → Task 7 → Task 9 → Task 11 → Task 14
(7 sequential stages)

## Key Design Notes
1. **workspace_id translation**: The CLI sends canonical ID strings (e.g., "github.com/user/repo"). The event processor resolves these to Postgres ULIDs. The events table stores ULIDs.
2. **Handler registry**: The event processor uses an extensible handler registry. Phase 1 registers session.start and session.end handlers. Phase 2+ adds more by calling `registry.register(type, handler)`.
3. **Error hierarchy**: All packages use FuelCodeError subclasses (ConfigError, NetworkError, ValidationError, StorageError) for structured error handling.
4. **Atomic writes**: Queue files use write-to-tmp-then-rename pattern to prevent corruption.
5. **Hook architecture**: Bash wrapper → TS helper script → fuel-code emit. All parsing happens in TypeScript, not bash.

## Known Limitations and Early Validations

### TEXT Primary Keys (audit #11)
ULIDs are stored as TEXT in Postgres. At 100K+ events, string comparisons for foreign key joins will be measurably slower than binary UUID storage. This is a known tradeoff — acceptable for V1, but expensive to migrate later. All tables and indexes use this pattern.

### Database Connection Pool Sizing (audit #12)
postgres.js defaults to 10 connections. The event processor, API endpoints, and consumer all share the same pool. Under load, connection starvation is possible. No query timeout is configured. For Phase 1 this is acceptable (single-user, low concurrency), but should be addressed before production scale. Consider: explicit pool sizing (e.g., `max: 20`), query timeouts (e.g., `idle_timeout: 30, connect_timeout: 10`), and separate pools for the consumer vs API if contention arises.

### Bun + Ink Compatibility (audit #13)
Phase 4's TUI depends on Ink (React for terminals). Ink relies on Node.js's TTY stream handling internals. Bun's compatibility is good but not perfect — edge cases around raw mode, cursor positioning, and stdin handling can break Ink components. **Recommendation**: Add a minimal Ink smoke test to Phase 1 (or early Phase 4) that verifies basic rendering under bun, gating Phase 4's viability early.

### WebSocket Auth via Query Parameter (audit #14)
Phase 4's `wss://<backend>/api/ws?token=<api_key>` puts the key in the URL. This appears in server access logs, proxy logs, and error reporting. For single-user this is acceptable, but worth noting. Standard practice would be to authenticate via the first message after connection or a short-lived upgrade token.

### Performance Criteria (audit #8)
No phase specifies performance targets. Recommended baselines for future validation:
- Hook-to-Postgres latency: <5s
- Max transcript size without timeout: 144MB (observed max)
- Max concurrent WebSocket connections: 50+
- Queue drain should keep pace with ingestion rate under normal load
