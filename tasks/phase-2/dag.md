# Phase 2: Session Lifecycle — Task Dependency DAG

## Overview

Phase 2 turns sessions from simple records into fully processed, searchable, summarized objects. After Phase 2, every Claude Code session has its raw transcript in S3, parsed messages in Postgres, aggregate stats, an LLM-generated summary, and is queryable via REST API. Historical sessions are backfilled from `~/.claude/projects/`.

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Phase 2 Database Migration | A | — |
| 2 | Shared Transcript Types + S3 Key Utilities | A | — |
| 3 | S3 Client Abstraction | B | 2 |
| 4 | Session Lifecycle State Machine | B | 1 |
| 5 | Transcript Parser | C | 1, 2 |
| 6 | Summary Generator | C | 2 |
| 7 | Session Pipeline Orchestrator + Session.end Handler Upgrade | D | 3, 4, 5, 6 |
| 8 | Transcript Upload Endpoint + Hook Modifications | E | 3, 7 |
| 9 | Session API Endpoints | E | 4, 7 |
| 10 | Reparse Endpoint + Stuck Session Recovery | E | 4, 7 |
| 11 | Historical Backfill Scanner + CLI Command | F | 3, 7, 8 |
| 12 | Phase 2 E2E Integration Tests | G | 8, 9, 10, 11 |

## Dependency Graph

```
Group A ─── Task 1: Phase 2 DB migration
            Task 2: Shared transcript types
               │
        ┌──────┼──────┐
        ▼      │      ▼
Group B ─── Task 3    Task 4
            S3 client  Lifecycle state machine
               │      │
        ┌──────┘      │
        ▼             │
Group C ─── Task 5    │     Task 6
            Transcript│     Summary generator
            parser    │        │
               │      │        │
               └──────┴────────┘
                      │
                      ▼
Group D ─── Task 7: Pipeline orchestrator + session.end handler
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
Group E ─── Task 8    Task 9         Task 10
            Upload     Session API   Reparse + recovery
            endpoint   endpoints
               │
               ▼
Group F ─── Task 11: Backfill scanner + CLI
                      │
                      ▼
Group G ─── Task 12: E2E integration tests
```

## Parallel Groups

- **A**: Tasks 1, 2 (independent foundations)
- **B**: Tasks 3, 4 (independent: S3 infra and lifecycle logic)
- **C**: Tasks 5, 6 (independent: parser needs DB+types, summarizer needs types)
- **D**: Task 7 (wires everything together)
- **E**: Tasks 8, 9, 10 (independent: upload transport, query API, mutation+recovery API)
- **F**: Task 11 (backfill needs upload endpoint + pipeline)
- **G**: Task 12 (final verification)

## Critical Path

Task 1 → Task 4 → Task 7 → Task 8 → Task 11 → Task 12

(6 sequential stages)

## Key Design Decisions

### Transcript Delivery to Server
The transcript file lives on the user's local machine, but the server runs on Railway. Two paths exist:
1. **Live sessions**: Hook helper spawns background `fuel-code transcript upload --session-id <id> --file <path>`. CLI reads file, POSTs to `POST /api/sessions/:id/transcript/upload`. Server stores in S3, triggers pipeline.
2. **Backfill**: Scanner reads file locally, uploads to S3 via API, then emits synthetic session.end with `transcript_s3_key` in event data. Server-side handler detects S3 key and triggers pipeline directly.

### Streaming for Large Transcripts
Real transcripts go up to 144MB (observed). All transcript handling MUST stream:
- S3 upload: `fs.createReadStream` → server → S3
- S3 download: streaming response → line-by-line parser
- JSONL parser: reads lines incrementally (never holds entire file in memory)
- Postgres batch insert: chunked (500 rows per INSERT)

### Lifecycle State Machine with Optimistic Locking
All lifecycle transitions use `UPDATE sessions SET lifecycle = $new WHERE id = $id AND lifecycle = $expected`. This prevents race conditions from duplicate events or concurrent reparse. Failed transitions are logged, not errored.

### Recovery Mechanism
On server startup, `recoverStuckSessions()` finds sessions stuck in intermediate states (ended with parse_status='parsing' for >10 minutes) and retries them. This handles server crashes mid-pipeline.

### Idempotency Everywhere
- Session records: `INSERT ... ON CONFLICT (id) DO NOTHING`
- S3 uploads: PUT overwrites silently
- Transcript parsing: DELETE old rows before INSERT new rows (within transaction)
- Backfill: checks for existing session IDs before processing
- Events: ULID-based dedup at event level

## Dependencies Added in Phase 2

```bash
# Server
cd packages/server && bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Core
cd packages/core && bun add @anthropic-ai/sdk
```

## Test Infrastructure

Extend `docker-compose.test.yml` with LocalStack for S3:
```yaml
localstack:
  image: localstack/localstack:latest
  environment:
    SERVICES: s3
    DEFAULT_REGION: us-east-1
  ports:
    - "4566:4566"
```
