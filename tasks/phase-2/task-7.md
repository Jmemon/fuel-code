# Task 7: Session Pipeline Orchestrator + Session.end Handler Upgrade

## Parallel Group: D

## Description

Build the post-processing pipeline orchestrator and upgrade the Phase 1 `session.end` handler to trigger it. The pipeline runs after a session ends: upload transcript to S3 → parse JSONL → persist messages/blocks to Postgres → compute stats → generate summary → advance lifecycle through `ended → parsed → summarized`.

The pipeline orchestrator is the central coordination point. It is called by:
1. The session.end handler (after a live session ends, triggered by transcript upload)
2. The reparse endpoint (Task 10)
3. The backfill scanner (Task 11)

### Files to Create

**`packages/core/src/session-pipeline.ts`**:

```typescript
interface PipelineDeps {
  sql: postgres.Sql;
  s3: FuelCodeS3Client;
  summaryConfig: SummaryConfig;
  logger: pino.Logger;
}

interface PipelineResult {
  sessionId: string;
  parseSuccess: boolean;
  summarySuccess: boolean;
  errors: string[];
  stats?: TranscriptStats;
}

// Run the parse + summarize pipeline for a session whose transcript is already in S3.
// Assumes session is in 'ended' lifecycle with transcript_s3_key set.
async function runSessionPipeline(
  deps: PipelineDeps,
  sessionId: string
): Promise<PipelineResult>
```

**Pipeline steps in `runSessionPipeline`**:

1. **Fetch session**: `SELECT id, lifecycle, transcript_s3_key, workspace_id FROM sessions WHERE id = $1`.
   - If not found: return error.
   - If `transcript_s3_key` is null: return error "No transcript in S3".
   - If lifecycle is not `ended`: return error "Session not in 'ended' state" (another process already moved it).

2. **Set parse_status = 'parsing'**: `UPDATE sessions SET parse_status = 'parsing', updated_at = now() WHERE id = $1`.

3. **Download transcript from S3**: `s3.download(transcript_s3_key)`. On failure: `failSession(sql, sessionId, "S3 download failed: " + error)`. Return.

4. **Parse transcript**: `parseTranscript(sessionId, transcriptContent)`. This produces `ParseResult` with messages, contentBlocks, stats, errors.
   - If parser returns line-level errors: log warnings but continue (partial parse is better than no parse).

5. **Persist parsed data** (in a transaction):
   ```sql
   BEGIN;
   -- Delete existing parsed data (for reparse idempotency)
   DELETE FROM content_blocks WHERE session_id = $1;
   DELETE FROM transcript_messages WHERE session_id = $1;
   -- Batch insert messages (500 at a time to avoid param limits)
   INSERT INTO transcript_messages (...) VALUES ...;
   -- Batch insert content blocks (500 at a time)
   INSERT INTO content_blocks (...) VALUES ...;
   COMMIT;
   ```
   On failure: `failSession(sql, sessionId, "Persist failed: " + error)`. Return.

6. **Advance lifecycle to 'parsed'**: `transitionSession(sql, sessionId, "ended", "parsed", { parse_status: "completed", parse_error: null, initial_prompt: stats.initial_prompt, ...all stats columns })`.
   - If transition fails (concurrent modification): log and return. Another process won.

7. **Generate summary**: `generateSummary(messages, contentBlocks, summaryConfig)`.
   - On success: `transitionSession(sql, sessionId, "parsed", "summarized", { summary })`.
   - On failure: log error. Session stays at `parsed`. This is acceptable — the session is fully queryable without a summary. **Do NOT transition to failed** — parsing succeeded.

8. **Upload parsed backup to S3** (best-effort): `s3.upload(buildParsedBackupKey(...), JSON.stringify(parseResult), "application/json")`. Log and ignore errors.

9. **Summary retry gap (audit #9)**: If summary generation fails (e.g., Anthropic rate-limit during a burst of session.end events), the session stays at `parsed` permanently without a summary. Neither reparse nor any periodic job fills this gap. **Mitigation**: Add a periodic job (or extend the reparse endpoint in Task 10) that finds sessions with `lifecycle = 'parsed'` and `summary IS NULL` and `updated_at < now() - interval '10 minutes'`, then re-attempts summary generation only (no re-parse). This should be a lightweight background sweep, not a full pipeline re-run.

**Concurrency queue**: Use a bounded async work queue limiting concurrent active pipelines to 3. IMPORTANT: Do NOT use a blocking semaphore — if `acquire()` blocks inside the Redis consumer's event handler, it stalls ALL event processing (git events, session.start, everything), not just session.end events. Instead: the handler enqueues the session ID (fire-and-forget, returns immediately), and a separate worker loop consumes from the queue with a concurrency limit of 3. If the queue overflows (>50 pending), log a warning and drop — the recovery mechanism (Task 10) catches missed sessions on next startup.

```typescript
// Bounded async work queue for pipeline executions.
// IMPORTANT: Do NOT use a blocking semaphore — if acquire() blocks inside
// the Redis consumer's event handler, ALL event processing stalls (not just
// session.end events). Instead, use fire-and-forget with a bounded queue:
// the handler pushes to the queue, and a separate worker loop consumes
// from it with concurrency limiting.
function createPipelineQueue(maxConcurrent: number): {
  // Enqueue a pipeline run. Returns immediately. If the queue is full
  // (> 50 pending), logs a warning and drops (recovery mechanism catches it later).
  enqueue(sessionId: string): void;
  // Start the worker loop that processes enqueued items.
  start(deps: PipelineDeps): void;
  // Gracefully stop: finish in-flight pipelines, discard pending.
  stop(): Promise<void>;
  // Current queue depth (for monitoring).
  depth(): number;
}
```

### Modify Session.end Handler

**Modify `packages/core/src/handlers/session-end.ts`**:

The Phase 1 handler updates session to `lifecycle = 'ended'`. In Phase 2, after transitioning, check if a transcript S3 key is set on the session (it won't be for live sessions initially — the transcript upload endpoint sets it). If it IS set (backfill path), trigger the pipeline:

```typescript
async function handleSessionEnd(ctx: EventHandlerContext): Promise<void> {
  // Phase 1 logic: transition to 'ended'
  const { cc_session_id, duration_ms, end_reason, transcript_path } = ctx.event.data;
  const result = await transitionSession(ctx.sql, cc_session_id,
    ["detected", "capturing"], "ended",
    { ended_at: ctx.event.timestamp, end_reason, duration_ms });

  if (!result.success) {
    ctx.logger.warn({ sessionId: cc_session_id, reason: result.reason },
      "session.end: lifecycle transition failed");
    return;
  }

  // Phase 2: Check if transcript_s3_key is already set (backfill path)
  // For live sessions, the upload endpoint triggers the pipeline separately
  const state = await getSessionState(ctx.sql, cc_session_id);
  if (state) {
    const session = await ctx.sql`SELECT transcript_s3_key FROM sessions WHERE id = ${cc_session_id}`;
    if (session[0]?.transcript_s3_key) {
      // Transcript already in S3 (backfill). Trigger pipeline asynchronously.
      runSessionPipeline(ctx.pipelineDeps, cc_session_id).catch(err => {
        ctx.logger.error({ sessionId: cc_session_id, error: err.message },
          "session.end: pipeline trigger failed");
      });
    }
  }
}
```

### Extend Event Handler Context

**Modify `packages/core/src/event-processor.ts`**: Extend `EventHandlerContext` to include pipeline dependencies:

```typescript
// NOTE (audit #5): Adding pipelineDeps to EventHandlerContext means every handler
// receives S3 clients, summary config, etc. — even handlers that don't use them.
// This is the "growing context bag" anti-pattern. Consider migrating to per-handler
// dependency injection via the registry in a future refactor:
//   registry.register("session.end", handleSessionEnd, { pipelineDeps })
// For now this is acceptable — Phase 1+2 have only 2-3 handlers.
interface EventHandlerContext {
  sql: postgres.Sql;
  event: Event;
  workspaceId: string;
  logger: pino.Logger;
  pipelineDeps: PipelineDeps;  // added in Phase 2
}
```

### Wire Into Server

**Modify `packages/server/src/pipeline/wire.ts`**: Pass S3 client and summary config into the handler context.

**Modify `packages/server/src/index.ts`**:
- Create S3 client on startup from env vars.
- Load summary config from env vars.
- Pass both into `createEventHandler` / handler context.

### Tests

**`packages/core/src/__tests__/session-pipeline.test.ts`** (requires Postgres + S3):

1. Full pipeline: session with transcript in S3 → parse → persist → summarize. Session lifecycle: `ended → parsed → summarized`.
2. Missing S3 key: returns error, session unchanged.
3. S3 download fails: session transitions to `failed` with parse_error.
4. Parser returns partial errors (some corrupt lines): session still advances to `parsed`, stats reflect valid lines.
5. Summary generation fails: session stays at `parsed` (NOT `failed`). No summary, but data is intact.
6. Re-running pipeline on already-parsed session: `transitionSession` returns `{ success: false }`, pipeline exits cleanly.
7. Concurrent pipeline calls for same session: only one succeeds (optimistic locking).
8. Empty transcript (0 messages): session advances to `parsed` with zero stats.
9. Batch insert handles 1000+ messages without hitting Postgres param limits.
10. Semaphore limits concurrent executions (verify with mock delays).
11. Periodic summary retry: session stuck at `parsed` without summary for >10 min is found and summary is re-attempted.

## Relevant Files
- `packages/core/src/session-pipeline.ts` (create)
- `packages/core/src/handlers/session-end.ts` (modify — add pipeline trigger for backfill path)
- `packages/core/src/event-processor.ts` (modify — extend EventHandlerContext)
- `packages/server/src/pipeline/wire.ts` (modify — inject S3 + summary config)
- `packages/server/src/index.ts` (modify — create S3 client, load summary config)
- `packages/core/src/__tests__/session-pipeline.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export)

## Success Criteria
1. After pipeline runs, session has `lifecycle = 'summarized'` with all stats populated.
2. `transcript_messages` and `content_blocks` rows exist in Postgres for the session.
3. `parse_status = 'completed'` after successful parsing.
4. `initial_prompt` is populated from the first user message.
5. S3 download failure transitions session to `failed` with descriptive `parse_error`.
6. Summary failure does NOT cause `failed` — session stays at `parsed`.
7. Re-running pipeline on an already-processed session is a no-op.
8. Concurrent pipeline calls: only one succeeds.
9. DELETE before INSERT ensures reparse idempotency (no duplicate rows).
10. Batch insertion handles transcripts with 1000+ messages.
11. Concurrency semaphore limits active pipelines to configured max.
12. Phase 1 session.end tests still pass (backward compatible).
