# Task 7: SessionSeed + computeGap() Implementation

## Phase: C — Reconcile Pattern
## Dependencies: T2, T4
## Parallelizable With: None (T8 depends on this)

---

## Description

Implement the `SessionSeed` construction helpers and `computeGap()` function. The seed is the universal normalized input — both hooks and backfill construct one. `computeGap()` compares current DB state against desired state to determine what work remains.

## Files

- **Create**: `packages/core/src/reconcile/session-seed.ts` — `buildSeedFromHook(event)`, `buildSeedFromFilesystem(discoveredSession)`, `buildSeedFromRecovery(sessionRow)`
- **Create**: `packages/core/src/reconcile/compute-gap.ts` — `computeGap(session, seed): SessionGap`
- **Create**: `packages/core/src/reconcile/index.ts` — barrel export

## Key Implementation Details

**`buildSeedFromHook(event)`**: Extracts from Redis stream event data. Has rich data (model, gitRemote, ccVersion from CC's hook payload).

**`buildSeedFromFilesystem(discoveredSession)`**: Extracts from the `DiscoveredSession` type already used by backfill scanner. Less rich — model/ccVersion may be null if not in JSONL header.

**`buildSeedFromRecovery(sessionRow)`**: Constructs from an existing DB row for re-processing. `transcriptRef` is `{ type: 's3', key: session.transcript_s3_key }`.

**`computeGap(session, seed)`**: Compares the session's current `lifecycle` against the full pipeline to determine what's missing:
- `needsTranscriptUpload`: `transcript_s3_key IS NULL AND transcriptRef?.type === 'disk'`
- `needsParsing`: `lifecycle IN ('transcript_ready')`
- `needsSubagentParsing`: `lifecycle IN ('transcript_ready')` (parsed alongside main)
- `needsTeamDetection`: `lifecycle IN ('transcript_ready')` (detected during persistRelationships)
- `needsStats`: `lifecycle IN ('transcript_ready')`
- `needsSummary`: `lifecycle IN ('parsed')`
- `needsTeammateSummaries`: `lifecycle IN ('parsed', 'summarized')`
- `needsLifecycleAdvance`: `lifecycle NOT IN ('complete', 'failed')`
- `staleStartedAt`: `session.started_at === session.ended_at AND seed.startedAt !== seed.endedAt`
- `staleDurationMs`: `session.duration_ms === 0 AND seed.durationMs > 0`
- `staleSubagentCount`: always recomputed from DB

## How to Test

```bash
cd packages/core && bun test reconcile 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write unit tests for:
- `buildSeedFromHook` with a mock event
- `buildSeedFromFilesystem` with a mock DiscoveredSession
- `computeGap` with sessions at various lifecycle stages

## Success Criteria

1. All three `buildSeed*` functions produce valid `SessionSeed` objects
2. `computeGap` correctly identifies work needed at each lifecycle stage
3. `computeGap` for a `complete` session returns all-false gap
4. `computeGap` for a `transcript_ready` session returns needsParsing=true
5. Stale field detection works for backfill edge cases
