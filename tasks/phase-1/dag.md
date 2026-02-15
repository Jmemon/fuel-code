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
