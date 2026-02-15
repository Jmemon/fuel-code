# Task 10: CLI `emit` Command with Local Queue Fallback

## Parallel Group: E

## Description

Build the `fuel-code emit` command — the internal command called by hooks to send events to the backend. This is the most performance-critical CLI path. It MUST complete within 2 seconds in ALL cases. If the backend is slow, unreachable, or erroring, the event goes to the local queue. Zero data loss. Zero non-zero exit codes (hooks must never block Claude Code).

### Files to Create

**`packages/cli/src/lib/api-client.ts`**:

```typescript
/** HTTP client for the fuel-code backend API */
interface ApiClient {
  ingest(events: Event[]): Promise<IngestResponse>;
  health(): Promise<HealthResponse>;
}
```

- `createApiClient(config: FuelCodeConfig): ApiClient`:
  - `ingest(events)`:
    - `POST {config.backend.url}/api/events/ingest`
    - Headers: `Content-Type: application/json`, `Authorization: Bearer {config.backend.api_key}`
    - Body: `{ events }`
    - Timeout: `config.pipeline.post_timeout_ms` (default 2000ms) via `AbortSignal.timeout()`
    - On 2xx: parse and return `IngestResponse`
    - On non-2xx: throw `NetworkError` with status code and truncated body (max 200 chars)
    - On timeout: throw `NetworkError` with code `NETWORK_TIMEOUT`
    - On DNS/connection failure: throw `NetworkError` with code `NETWORK_UNREACHABLE`
  - `health()`:
    - `GET {config.backend.url}/api/health` with 5s timeout
    - Returns parsed response

**`packages/cli/src/lib/queue.ts`**:

Queue location: `~/.fuel-code/queue/` (from config `pipeline.queue_path`)
Dead letter location: `~/.fuel-code/dead-letter/`

- `enqueueEvent(event: Event, queueDir?: string): string`:
  - Default queueDir: QUEUE_DIR from config constants.
  - Write `JSON.stringify(event, null, 2)` to `{queueDir}/{event.id}.json`.
  - Use atomic write: write to `{queueDir}/{event.id}.json.tmp`, then rename to `{queueDir}/{event.id}.json`. Prevents corruption from interrupted writes.
  - Ensure queue directory exists (create if needed).
  - Return the file path.
  - **If writing to disk fails** (disk full, permissions): log error and return empty string. Do NOT throw — the emit command must never crash.

- `listQueuedEvents(queueDir?: string): Array<{ id: string; path: string }>`:
  - Read `.json` files from queue dir (exclude `.tmp` files).
  - Sort by filename (ULID = chronological order).
  - Return array of `{ id: filename-without-ext, path: full-path }`.

- `readQueuedEvent(filePath: string): Event | null`:
  - Read and parse JSON. On parse failure: return null (corrupted file).

- `removeQueuedEvent(filePath: string): void`:
  - Delete the file. On failure: log warning, don't throw.

- `moveToDeadLetter(filePath: string, deadLetterDir?: string): void`:
  - Move file from queue to dead-letter directory.

- `getQueueDepth(queueDir?: string): number`:
  - Count `.json` files in queue dir.

- `getDeadLetterDepth(deadLetterDir?: string): number`:
  - Count files in dead-letter dir.

**`packages/cli/src/commands/emit.ts`**:

`fuel-code emit <event-type> --data <json> [--session-id <id>] [--workspace-id <id>]`

This command is registered on the commander program. It is NOT user-facing (called by hooks).

Flow:
1. **Load config**. If config missing/corrupted:
   - Try to still queue the event using hardcoded QUEUE_DIR path.
   - Log warning to stderr.
   - Exit 0 (never crash).
2. **Parse `--data`**. If not valid JSON:
   - Wrap raw string as `{ _raw: theString }` and log warning.
   - Do NOT crash. Proceed with the wrapped data.
3. **Construct Event object**:
   - `id`: `generateId()` (ULID from `@fuel-code/shared`)
   - `type`: from positional arg. No runtime validation here (the server validates).
   - `timestamp`: `new Date().toISOString()`
   - `device_id`: from config `device.id`
   - `workspace_id`: from `--workspace-id` (required, provided by hook scripts). Default: `_unassociated`.
   - `session_id`: from `--session-id` or null
   - `data`: parsed JSON from `--data`
   - `ingested_at`: null
   - `blob_refs`: `[]`
4. **Attempt HTTP POST** via `apiClient.ingest([event])`:
   - On success (202): exit 0 silently.
   - On 503: fall through to queue.
   - On 401: log warning "Invalid API key". Fall through to queue (still save event).
   - On timeout (AbortError): fall through to queue.
   - On network error: fall through to queue.
5. **Queue fallback**: `enqueueEvent(event)`. Exit 0.
6. **Spawn background drain** (Task 12 — leave comment here): After queuing, optionally start a background drain process. For now, just queue and exit.

**Critical constraints**:
- Exit code MUST be 0 in all cases (except `--help`). Non-zero exit from a hook breaks CC.
- Total wall-clock time MUST be < 2 seconds. The HTTP timeout is 2s; config loading and ULID generation are sub-millisecond.
- No output to stdout on success (hooks must be silent). Only stderr for warnings/errors.
- If everything fails (can't load config, can't POST, can't write to disk), exit 0 with a stderr warning.

### Tests

**`packages/cli/src/commands/__tests__/emit.test.ts`**:
- Emit with valid config + running backend: exit 0, no queue file created
- Emit with valid config + dead backend: exit 0, queue file created with valid JSON
- Emit with missing config: exit 0 (graceful degradation)
- Emit with invalid --data: exit 0, event created with `_raw` wrapper
- Emit wall-clock time with dead backend: < 2.5 seconds (2s timeout + overhead)
- Queue file is valid JSON matching Event schema

**`packages/cli/src/lib/__tests__/queue.test.ts`**:
- `enqueueEvent` + `readQueuedEvent` round-trip
- `listQueuedEvents` returns sorted by ULID (chronological)
- `removeQueuedEvent` deletes the file
- `moveToDeadLetter` moves file to dead-letter dir
- `getQueueDepth` returns correct count
- Atomic write: .tmp file doesn't persist after successful write

## Relevant Files
- `packages/cli/src/lib/api-client.ts` (create)
- `packages/cli/src/lib/queue.ts` (create)
- `packages/cli/src/commands/emit.ts` (create)
- `packages/cli/src/index.ts` (modify — register emit command)
- `packages/cli/src/commands/__tests__/emit.test.ts` (create)
- `packages/cli/src/lib/__tests__/queue.test.ts` (create)

## Success Criteria
1. `fuel-code emit session.start --data '{"cc_session_id":"x","cwd":"/tmp","git_branch":null,"git_remote":null,"cc_version":"1.0","model":null,"source":"startup","transcript_path":"/tmp/t.jsonl"}' --session-id x --workspace-id "github.com/user/repo"` against a running backend exits 0 with no output.
2. Same command against a dead backend exits 0 and creates `~/.fuel-code/queue/<ulid>.json`.
3. The queued file contains valid JSON matching the Event interface.
4. `fuel-code emit` with no config file exits 0 (does not crash).
5. `fuel-code emit` with invalid `--data` (not JSON) exits 0, wraps in `{ _raw: ... }`.
6. `fuel-code emit` completes in < 2.5 seconds with a dead backend.
7. No output to stdout on success.
8. `enqueueEvent` uses atomic write (tmp + rename).
9. `listQueuedEvents` returns events in ULID/chronological order.
10. Backend returning 401 still queues the event locally (event not lost).
11. Backend returning 503 queues the event locally.
12. All tests pass: `bun test packages/cli`.
