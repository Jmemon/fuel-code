# Task 8: Transcript Upload Endpoint + Hook Modifications

## Parallel Group: E

## Description

Build the server endpoint that receives transcript file uploads from CLI clients, and modify the session.end hook helper to upload the transcript in the background after emitting the session.end event. This solves the core problem: the transcript JSONL file lives on the user's local machine, but the server runs on Railway.

Two paths for transcript delivery:
1. **Live sessions** (this task): Hook fires → `fuel-code emit session.end` → hook helper spawns background `fuel-code transcript upload --session-id <id> --file <path>` → CLI reads local file, POSTs to server → server stores in S3, triggers parse pipeline.
2. **Backfill** (Task 11): Scanner reads file locally, uploads to S3 via the same endpoint, emits synthetic events with `transcript_s3_key` already set.

### Files to Create

**`packages/server/src/routes/transcript-upload.ts`**:

```typescript
// POST /api/sessions/:id/transcript/upload
// Accepts multipart form data with the transcript JSONL file.
// Stores it in S3 and triggers the parse+summarize pipeline.

function createTranscriptUploadRouter(deps: {
  sql: postgres.Sql;
  s3: FuelCodeS3Client;
  pipelineDeps: PipelineDeps;
  logger: pino.Logger;
}): Router
```

Endpoint: `POST /api/sessions/:id/transcript/upload`

Request:
- `Content-Type: multipart/form-data`
- Field `transcript`: the JSONL file (binary)
- OR `Content-Type: application/octet-stream` with body as the raw JSONL content (simpler for CLI, avoids multipart complexity)

Flow:
1. Validate session exists: `SELECT id, lifecycle, workspace_id, transcript_s3_key FROM sessions WHERE id = $1`.
2. If not found: 404.
3. If `transcript_s3_key` is already set: return `200 { status: "already_uploaded", s3_key: existingKey }`. Idempotent — don't re-upload.
4. If lifecycle is `detected` or `capturing`: the session hasn't ended yet. But we can still accept the upload (it may arrive before the session.end event). Store the file and set the s3_key. The pipeline will trigger when session.end fires and sees the s3_key.
5. Get workspace canonical ID: `SELECT canonical_id FROM workspaces WHERE id = $workspaceId`.
6. Build S3 key: `buildTranscriptKey(canonicalId, sessionId)`.
7. Read request body as a stream. Upload to S3: `s3.upload(key, body, "application/x-ndjson")`.
8. Update session: `UPDATE sessions SET transcript_s3_key = $1, updated_at = now() WHERE id = $2`.
9. If session lifecycle is `ended` (session.end already processed): trigger pipeline asynchronously.
   ```typescript
   runSessionPipeline(pipelineDeps, sessionId).catch(err => {
     logger.error({ sessionId, error: err.message }, "Pipeline trigger after upload failed");
   });
   ```
10. Return `202 { status: "uploaded", s3_key: key, size_bytes: size, pipeline_triggered: lifecycle === "ended" }`.

**Request size limit**: Configure Express body parser for this route to accept up to 200MB (transcripts can be very large). Use streaming — do NOT buffer the entire body in memory.

```typescript
// Use raw body parser with high limit, stream directly to S3
app.post("/api/sessions/:id/transcript/upload",
  express.raw({ type: "application/octet-stream", limit: "200mb" }),
  handler
);
```

**Mount** in `packages/server/src/app.ts`.

### CLI: Transcript Upload Command

**`packages/cli/src/commands/transcript.ts`**:

`fuel-code transcript upload --session-id <id> --file <path>`

Internal command called by hook helpers. NOT user-facing.

Flow:
1. Load config. If missing: exit 0 (never crash, same as emit).
2. Read the file at `--file` path. If file doesn't exist: log warning to stderr, exit 0.
3. Get file size. If > 200MB: log warning "Transcript very large ({size}MB), upload may be slow".
4. POST to `{config.backend.url}/api/sessions/{session-id}/transcript/upload` with:
   - `Content-Type: application/octet-stream`
   - `Authorization: Bearer {config.backend.api_key}`
   - Body: file content (streamed)
5. Timeout: 5 minutes (large files need time).
6. On success (200/202): exit 0 silently.
7. On 409/duplicate: exit 0 (already uploaded, fine).
8. On error: log warning to stderr, exit 0. The transcript stays on disk — backfill can pick it up later.

Register in `packages/cli/src/index.ts`.

### Hook Helper Modifications

**Modify `packages/hooks/claude/_helpers/session-end.ts`**:

After calling `fuel-code emit session.end`, spawn the transcript upload in the background:

```typescript
// Step 1: Emit session.end event (fast, <2s)
const emitProcess = Bun.spawn(["fuel-code", "emit", "session.end", ...]);
await emitProcess.exited;

// Step 2: Upload transcript in background (can take minutes for large files)
if (transcriptPath) {
  Bun.spawn(["fuel-code", "transcript", "upload",
    "--session-id", sessionId,
    "--file", transcriptPath
  ], {
    stdout: "ignore",
    stderr: "ignore",
    detached: true,  // don't wait for this, don't block CC shutdown
  });
}
// Exit immediately
```

The upload runs detached — the hook helper exits immediately as required by CC.

### Tests

**`packages/server/src/routes/__tests__/transcript-upload.test.ts`** (requires Postgres + S3):

1. Upload a transcript for an ended session: S3 key set, pipeline triggered.
2. Upload for a non-existent session: 404.
3. Upload when transcript already exists: 200 with "already_uploaded".
4. Upload for a detected session (session.end not yet processed): S3 key set, pipeline NOT triggered (waiting for session.end).
5. Upload a 1MB file: completes successfully.
6. Upload with wrong auth: 401.

**`packages/cli/src/commands/__tests__/transcript.test.ts`**:

1. Upload with valid config + running server: exit 0, no output.
2. Upload with missing file: exit 0, warning to stderr.
3. Upload with dead server: exit 0, warning to stderr (transcript stays on disk).

## Relevant Files
- `packages/server/src/routes/transcript-upload.ts` (create)
- `packages/server/src/app.ts` (modify — mount upload route, configure body limit)
- `packages/cli/src/commands/transcript.ts` (create)
- `packages/cli/src/index.ts` (modify — register transcript command)
- `packages/hooks/claude/_helpers/session-end.ts` (modify — add background upload spawn)
- `packages/server/src/routes/__tests__/transcript-upload.test.ts` (create)
- `packages/cli/src/commands/__tests__/transcript.test.ts` (create)

## Success Criteria
1. `POST /api/sessions/:id/transcript/upload` stores the transcript in S3 at the correct key.
2. If session is `ended`, the parse+summarize pipeline is triggered after upload.
3. If session is `detected` (upload arrives before session.end event), S3 key is set but pipeline waits.
4. Re-uploading the same transcript is idempotent (returns 200, no re-upload).
5. The endpoint accepts up to 200MB files.
6. The upload streams to S3 (no full-body buffering in server memory).
7. `fuel-code transcript upload` reads a local file and POSTs it, exit 0 in all cases.
8. `fuel-code transcript upload` with missing file exits 0 with warning (never crash).
9. Hook helper spawns upload as detached background process.
10. Hook helper exits immediately after spawning upload (does not wait).
11. Auth required on upload endpoint (401 without token).
12. Non-existent session returns 404.
