# Phase 6: Hardening — Task Dependency DAG

## Overview

Phase 6 makes fuel-code production-ready by systematically hardening every data path, state transition, and external service interaction. The phase introduces a shared retry abstraction used by both CLI and server, hardens the local event queue against edge cases and data loss, adds session archival with integrity verification, improves EC2 orphan detection with atomic tagging and multi-check verification, surfaces cost estimation and comprehensive error messages throughout the CLI, and adds progress indicators and graceful Ctrl-C handling to all long operations.

**What Phase 6 delivers:**
- Shared `withRetry()` utility with exponential backoff, jitter, configurable predicates, and AbortSignal support — used by AWS API calls, HTTP transport, S3 operations, and archival
- Hardened queue drain with per-event batch isolation, dead-letter metadata envelopes, retry/purge subcommands, and corruption recovery
- Comprehensive CLI error messages with Error/Cause/Fix format, adapted for TTY/piped/JSON modes
- Session archival: periodic pruning of parsed transcript data from Postgres with S3 backup integrity verification, transactional deletes, and restore capability
- EC2 atomic tagging (via TagSpecifications at launch) + multi-check orphan verification with grace period
- Graceful Ctrl-C via a shutdown manager with cleanup stack for all long operations (remote up, drain, backfill, archival)
- Progress indicators with spinner/elapsed time (TTY) or timestamped lines (piped) for provisioning, drain, backfill, archival
- Cost estimation in `blueprint show`, `remote up` confirmation, and `remote ls` output

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Shared Retry Utility with Exponential Backoff | A | — |
| 2 | Comprehensive Error Message Framework | A | — |
| 3 | Instance Type Cost Lookup Table | A | — |
| 4 | Progress Indicator Utility | A | — |
| 5 | Retrofit AWS EC2+S3 Clients with Shared Retry + Atomic Tagging | B | 1 |
| 6 | Retrofit CLI HTTP Transport with Shared Retry | B | 1, 2 |
| 7 | Queue Drain Robustness: Batch Isolation + Dead Letter Diagnostics | B | 1, 2 |
| 8 | Session Archival Engine with Integrity Verification | C | 1 |
| 9 | EC2 Orphan Detection Hardening | C | 5 |
| 10 | Graceful Ctrl-C Hardening for All Long Operations | D | 6 |
| 11 | Cost Estimation in Blueprint + Remote Output | D | 3 |
| 12 | Progress Integration for Long Operations | D | 4, 6 |
| 13 | Session Archival: API + CLI + Archival-Aware Display | E | 8, 12 |
| 14 | Phase 6 E2E Integration Tests | F | 5, 6, 7, 8, 9, 10, 11, 12, 13 |

## Dependency Graph

```
Group A ─── Task 1: Retry    Task 2: Error    Task 3: Cost    Task 4: Progress
            utility          messages          lookup          utility
               │   │            │                 │               │
               │   │            │                 │               │
               │   └───┐    ┌──┘                  │               │
               │       │    │                     │               │
               ▼       ▼    ▼                     │               │
Group B ─── Task 5    Task 6        Task 7        │               │
            AWS       HTTP          Queue drain   │               │
            retry     retry         robustness    │               │
               │         │              │         │               │
               │    ┌────┤              │         │               │
               │    │    │              │         │               │
               ▼    │    │              │         ▼               │
Group C ─── Task 9  │    │              │    Task 8              │
            EC2     │    │              │    Session              │
            orphan  │    │              │    archival             │
               │    │    │              │    engine               │
               │    ▼    │              │         │               │
Group D ────│── Task 10  │    Task 11   │    ┌────┘    Task 12 ◄─┘
            │   Ctrl-C   │    Cost in   │    │         Progress
            │   hardening│    blueprint │    │         integration
            │       │    │       │      │    │              │
            │       │    │       │      │    │              │
            │       │    │       │      │    ▼              │
Group E ────│───────│────│───────│──────│── Task 13 ◄──────┘
            │       │    │       │      │   Archival CLI +
            │       │    │       │      │   display
            │       │    │       │      │        │
            └───────┴────┴───────┴──────┴────────┘
                                │
                                ▼
Group F ─── Task 14: Phase 6 E2E Integration Tests
```

## Parallel Groups

- **A**: Tasks 1, 2, 3, 4 (fully independent foundational utilities: retry, errors, costs, progress)
- **B**: Tasks 5, 6, 7 (transport hardening: AWS, HTTP, queue — all need retry utility from Task 1)
- **C**: Tasks 8, 9 (domain hardening: archival engine needs retry for S3; EC2 orphan needs hardened AWS calls)
- **D**: Tasks 10, 11, 12 (user-facing composition: Ctrl-C needs hardened HTTP for cleanup; cost needs lookup table; progress needs utility + HTTP client)
- **E**: Task 13 (archival CLI/API wires the engine into user-facing endpoints)
- **F**: Task 14 (E2E verification of all Phase 6 work)

## Critical Path

Task 1 → Task 6 → Task 10 → Task 14

(4 sequential stages. Parallel paths: Task 1 → Task 8 → Task 13 → Task 14 for archival; Task 1 → Task 5 → Task 9 → Task 14 for EC2.)

## Dependency Edges (precise)

- Task 1 → Tasks 5, 6, 7, 8 (retry utility consumed by all transport + archival)
- Task 2 → Tasks 6, 7 (error formatter used in HTTP retry errors and queue dead-letter display)
- Task 3 → Task 11 (cost lookup needed for blueprint/remote cost display)
- Task 4 → Task 12 (progress utility needed for progress integration into commands)
- Task 5 → Task 9 (hardened AWS calls needed for orphan detection)
- Task 6 → Tasks 10, 12 (hardened HTTP needed for Ctrl-C cleanup calls and progress polling)
- Task 8 → Task 13 (archival engine needed by archival CLI/API)
- Task 12 → Task 13 (progress integration provides utilities archival CLI uses)
- Tasks 5, 6, 7, 8, 9, 10, 11, 12, 13 → Task 14 (E2E tests verify everything)
- **Cross-phase (RESOLVED)**: ~~Task 7 requires per-event `results` array from Phase 1's ingest endpoint.~~ **Already done.** Phase 1's `POST /api/events/ingest` already returns `{ ingested, duplicates, rejected, results: [{ index, status }, ...], errors: [...] }`. No modification needed.

## Key Design Decisions

### 1. Single `withRetry()` in `packages/shared/` (not per-module)

The retry utility belongs in `packages/shared/` because both `packages/cli/` (HTTP transport, queue drain) and `packages/server/` (EC2 client, S3 client, archival) need it. It is a pure higher-order function with zero side effects. The key extensibility point is the `shouldRetry` predicate: callers configure what errors are retryable. Pre-built predicates are exported for AWS errors, HTTP errors, and network errors. The `onRetry` callback enables logging without the retry utility knowing about pino. The `signal` parameter (AbortSignal) enables cancellation for Ctrl-C handling.

### 2. EC2 Tags Applied Atomically via TagSpecifications at Launch

Phase 5 applied tags via a separate `createTags` call after `launchInstance`. This creates a window where a newly-launched instance has no tags, making orphan detection miss it. Phase 6 moves tags into the `RunInstances` API's `TagSpecifications` parameter, making tagging atomic with launch. A `fuel-code:created-at` tag with ISO timestamp enables the orphan sweep to enforce a grace period without additional API calls.

### 3. Archival Uses S3 Backup Integrity Verification

Before deleting any parsed data from Postgres, the archival engine: (1) ensures a `parsed.json` backup exists in S3 (creating it if needed), (2) downloads the backup and compares message counts against Postgres, (3) only proceeds if counts match. The lifecycle transition and data deletion happen in a single Postgres transaction. This makes archival safe against data loss: the backup is verified before deletes, and crash-during-delete rolls back the transaction.

### 4. Queue Drain Per-Event Batch Isolation

The Phase 1 drainer stops on first batch failure. Phase 6 uses the server's per-event response to selectively remove only accepted events. Failed events get individual attempt increments. This prevents a single bad event from blocking the entire queue. Dead-lettered events get metadata envelopes with attempt count, last error, and timestamps.

### 5. Ctrl-C via Shutdown Manager with Cleanup Stack

Rather than per-command SIGINT handlers, a `ShutdownManager` provides a cleanup action stack (LIFO). Commands push cleanup functions (e.g., "terminate EC2 instance", "stop drain") and pop them on completion. On SIGINT, the stack unwinds. On double-SIGINT, force exit. This generalizes the Phase 5 abort handler.

### 6. Orphan Detection Requires Multiple Verification Checks

For safety against false-positive termination, an instance must satisfy ALL of: (1) has `fuel-code:managed=true` tag, (2) has `fuel-code:remote-env-id` tag with valid ULID, (3) no matching DB record OR DB record with terminal status, (4) running for more than 15 minutes (grace period), (5) no active session (lifecycle='capturing') on matching device_id.

### 7. Archival is Reversible via `--restore`

`fuel-code session <id> --restore` re-downloads `parsed.json` from S3, re-inserts transcript_messages and content_blocks, and transitions the session from `archived` back to `summarized`. The `archived → summarized` transition is added to the lifecycle state machine.

### 8. Error Messages Follow Error/Cause/Fix Template

All user-facing errors follow: "Error: <what happened>" / "Cause: <why>" / "Fix: <what to do>". The formatter adapts to context: multi-line colored output in TTY, single-line in piped mode, structured JSON in `--json` mode. The error catalog maps all known error codes to human-readable guidance.

### 9. Cost Estimation is Static Lookup

The cost map covers ~20 common instance types with approximate US East on-demand prices. No AWS Pricing API calls. The map lives in `packages/shared/src/costs.ts` for use by both CLI and server. Clearly labeled as estimates.

### 10. Progress Indicators Adapt to Terminal Context

`createProgressReporter()` checks `process.stdout.isTTY` and `--json` to choose output strategy: spinner+elapsed for TTY, timestamped lines for piped, no output for `--json`. Used by provisioning, drain, backfill, and archival.

### 11. `_unassociated` Workspace Management (audit #15)
Sessions in the `_unassociated` workspace (canonical_id unknown at capture time) have no mechanism to be retrospectively assigned to a workspace. A future enhancement should allow `PATCH /api/sessions/:id` to accept a `workspace_id` change, moving sessions out of `_unassociated` when the user identifies which workspace they belong to.

### 12. Archived → Summarized Backward Transition (audit #16)
Phase 6 Task 13 introduces `archived → summarized` restoration, which is a backward lifecycle transition. All consumers that assume sessions only move forward (TUI lifecycle badges, query filters, future analysis) must handle this edge case. The lifecycle state machine in `packages/core/` should explicitly document this reverse transition and its implications.

## What Already Exists (from Phases 1-5)

### Retry Logic (scattered, to be unified)
- EC2 client: inline 3-attempt retry for `ThrottlingException`, `RequestLimitExceeded`, `InternalError`
- S3 client: AWS SDK built-in retries (opaque, non-configurable)
- CLI HTTP transport: no retry — single attempt with 2s timeout, queue fallback
- Queue drainer: `_attempts` tracking per file, dead-letter at 100 attempts
- Redis consumer: 3 retries per stream entry

### Error Handling (to be enhanced)
- Error hierarchy: `FuelCodeError` base with `ConfigError`, `NetworkError`, `ValidationError`, `StorageError`, `AwsError`
- CLI prints `error.message` on failure — no structured guidance
- Server has pino structured logging

### Queue System (to be hardened)
- `packages/cli/src/lib/queue.ts`: enqueue, list, read, remove, moveToDeadLetter, depths
- `packages/cli/src/lib/drain.ts`: batch processing, attempt tracking, stops on first failure
- Dead-letter at `~/.fuel-code/dead-letter/`
- Lockfile at `~/.fuel-code/.drain.lock`

### Session Lifecycle (archival to be added)
- `archived` state exists in schema CHECK constraint, no code transitions to it
- `transcript_messages` and `content_blocks` with ON DELETE CASCADE
- S3 transcripts at `transcripts/{workspace}/{session_id}/raw.jsonl`

### EC2 Tagging (to be upgraded)
- Tags: `fuel-code:managed`, `fuel-code:remote-env-id`, `fuel-code:workspace`, `Name`
- Applied via separate `createTags` call (non-atomic)
- Orphan sweep cross-references AWS instances with DB records

### Abort Handling (to be generalized)
- `packages/cli/src/lib/abort-handler.ts`: `withAbortHandler()` for `remote up` only
- Boolean flags for state tracking

### Cost Estimation (to be extracted)
- `COST_PER_HOUR` map with 8 instance types inlined in `remote-up.ts`
- `remote_envs.cost_per_hour_usd` column in Postgres

### Progress (minimal)
- `remote up` has polling with elapsed time
- No shared progress utility

## Dependencies Added in Phase 6

```bash
# No new runtime dependencies needed.
# The retry utility, error formatter, cost lookup, and progress utility
# are all pure TypeScript implementations using existing deps (picocolors, pino).
```
