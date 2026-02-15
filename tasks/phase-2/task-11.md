# Task 11: Historical Session Backfill Scanner + CLI Command

## Parallel Group: F

## Description

Build the backfill scanner that discovers all historical Claude Code sessions from `~/.claude/projects/`, and the `fuel-code backfill` CLI command with `--dry-run`, `--status`, and progress reporting. Also wire auto-trigger into `fuel-code init` and `fuel-code hooks install`.

Real-world observations from `~/.claude/projects/`:
- **~1,130 JSONL transcript files** totaling **~1.1 GB**
- Largest single file: **144 MB**
- Directory naming: `-Users-johnmemon-Desktop-contextual-clarity` (path with hyphens replacing slashes)
- Files are UUID-named: `5268c8d5-6db0-478c-bff2-b734662b3b0a.jsonl`
- **Subagent directories** exist: `{session_id}/subagents/agent-{hash}.jsonl` — skip these
- **`sessions-index.json`** files exist with pre-indexed metadata (session ID, project path, created/modified timestamps, git branch, first prompt, message count) — use when available
- Non-JSONL files: `sessions-index.json`, `.DS_Store` — skip

### Files to Create

**`packages/core/src/session-backfill.ts`**:

```typescript
interface DiscoveredSession {
  sessionId: string;
  transcriptPath: string;       // absolute path to JSONL file
  projectDir: string;           // Claude projects dir name
  resolvedCwd: string | null;   // decoded CWD from dir name
  workspaceCanonicalId: string; // resolved or _unassociated
  gitBranch: string | null;
  firstPrompt: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  fileSizeBytes: number;
  messageCount: number | null;  // from sessions-index.json if available
}

interface ScanResult {
  discovered: DiscoveredSession[];
  errors: Array<{ path: string; error: string }>;
  skipped: {
    subagents: number;
    nonJsonl: number;
    potentiallyActive: number;
  };
}

interface BackfillResult {
  ingested: number;
  skipped: number;          // already in backend
  failed: number;
  errors: Array<{ sessionId: string; error: string }>;
  totalSizeBytes: number;
  durationMs: number;
}

interface BackfillProgress {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  currentSession: string | null;
}
```

**`scanForSessions`**: Discover all historical sessions.

```typescript
async function scanForSessions(
  claudeProjectsDir?: string,  // default: ~/.claude/projects/
  options?: {
    skipActiveThresholdMs?: number;  // default: 300_000 (5 min) — skip recently modified
    onProgress?: (dirScanned: string) => void;
  }
): Promise<ScanResult>
```

Discovery algorithm:
1. Read `~/.claude/projects/` directory listing.
2. For each project directory:
   a. **Use `sessions-index.json` if present**: Parse it. Each entry has `sessionId`, `projectPath`, `created`, `modified`, `gitBranch`, `firstPrompt`, `messageCount`. Match entries to JSONL files.
   b. **Fall back to JSONL scanning**: List `.jsonl` files directly in the project dir. For each, extract session ID from filename (strip `.jsonl`). Read first 5 lines for metadata (`sessionId`, `cwd`, `version`, `gitBranch`, `timestamp`). Read last 5 lines for `lastTimestamp`.
   c. Skip subdirectories (subagent transcripts in `{session_id}/subagents/`). Count in `skipped.subagents`.
   d. Skip non-JSONL files (`sessions-index.json`, `.DS_Store`). Count in `skipped.nonJsonl`.
   e. Skip files modified within `skipActiveThresholdMs` (potentially active sessions). Count in `skipped.potentiallyActive`.
3. **Resolve workspace canonical ID** from project directory name:
   a. Convert dir name to path: `projectDirToPath(dirName)` (e.g., `-Users-john-Desktop-repo` → `/Users/john/Desktop/repo`).
   b. Check if path exists on disk and is a git repo: resolve canonical ID normally.
   c. If path doesn't exist or isn't a git repo: use `_unassociated`.
4. Sort by `firstTimestamp` ascending (oldest first).

**`projectDirToPath`**: Convert Claude projects directory name to filesystem path.

```typescript
function projectDirToPath(dirName: string): string
// "-Users-johnmemon-Desktop-contextual-clarity" → "/Users/johnmemon/Desktop/contextual-clarity"
// Leading "-" maps to leading "/"
```

**`ingestBackfillSessions`**: Ingest discovered sessions through the pipeline.

```typescript
async function ingestBackfillSessions(
  sessions: DiscoveredSession[],
  deps: {
    apiClient: ApiClient;       // from packages/cli/src/lib/api-client.ts
    uploadEndpoint: string;     // server URL for transcript upload
    apiKey: string;
    deviceId: string;
    onProgress?: (progress: BackfillProgress) => void;
    signal?: AbortSignal;
    batchSize?: number;         // default: 50 events per POST
    throttleMs?: number;        // default: 100ms between batches
  }
): Promise<BackfillResult>
```

Ingestion algorithm for each session:
1. **Dedup check**: `GET /api/sessions/{sessionId}`. If 200: mark as skipped.
2. **Upload transcript to server**: POST transcript file to `/api/sessions/{sessionId}/transcript/upload`. Uses streaming for large files.
3. **Emit synthetic session.start event** with data:
   ```
   type: "session.start"
   data: { cc_session_id, cwd, git_branch, git_remote: null, cc_version, model: null, source: "backfill", transcript_path }
   workspace_id: discovery.workspaceCanonicalId
   session_id: discovery.sessionId
   ```
4. **Emit synthetic session.end event** with data:
   ```
   type: "session.end"
   data: { cc_session_id, duration_ms, end_reason: "exit", transcript_path }
   ```
   The session.end handler sees the `transcript_s3_key` already set (from step 2) and triggers the pipeline.
5. Events are batched (50 per POST, =25 sessions per batch) and throttled between batches.
6. Report progress via callback.

### Backfill State Persistence

**`packages/core/src/backfill-state.ts`**:

```typescript
interface BackfillState {
  lastRunAt: string | null;
  lastRunResult: BackfillResult | null;
  isRunning: boolean;
  startedAt: string | null;
  ingestedSessionIds: string[];  // for resume after interruption
}

function loadBackfillState(stateDir?: string): BackfillState  // default ~/.fuel-code/
function saveBackfillState(state: BackfillState, stateDir?: string): void
```

### CLI Command

**`packages/cli/src/commands/backfill.ts`**:

`fuel-code backfill [--dry-run] [--status] [--force]`

**Default (no flags)**: Run backfill.
1. Load config. If not initialized: `"Run 'fuel-code init' first."` Exit 1.
2. Load backfill state. If `isRunning`: warn "A backfill may already be running."
3. Scan: `scanForSessions()`. Print discovery summary:
   ```
   Scanning ~/.claude/projects/...
   Found 477 sessions across 12 projects
   ```
4. Check existing sessions in backend. Print:
   ```
   New: 423 sessions to ingest (54 already tracked)
   ```
5. Ingest with progress bar:
   ```
   Backfilling: [████████████░░░░░░░░] 247/423  abc12345...
   ```
6. Print results:
   ```
   Backfill complete!
     Ingested:  410 sessions
     Skipped:   54 (already tracked)
     Failed:    13 (see errors below)
   Errors:
     session xyz789: Transcript file empty
     session def456: Upload failed: connection timeout
   ```

**`--dry-run`**: Scan and report without ingesting.
```
Would ingest:
  contextual-clarity       — 6 sessions (52 MB)
  aiod-agents-autolog     — 345 sessions (890 MB)
  _unassociated           — 12 sessions (8 MB)
Total: 477 sessions (1.1 GB)
Already tracked: 54
```

**`--status`**: Show last backfill state.
```
Last backfill: 2026-02-14 10:30:00
  Ingested: 410, Skipped: 54, Failed: 13
Currently running: No
```

### Auto-trigger from init and hooks install

**Modify `packages/cli/src/commands/init.ts`**: After successful init:
```typescript
console.error("Scanning for historical Claude Code sessions...");
const scanResult = await scanForSessions();
if (scanResult.discovered.length > 0) {
  console.error(`Found ${scanResult.discovered.length} historical sessions. Starting background backfill...`);
  // Spawn detached background process
  Bun.spawn(["fuel-code", "backfill"], {
    stdout: "ignore", stderr: "ignore", detached: true
  });
}
```

**Modify `packages/cli/src/commands/hooks.ts`**: Same pattern after hooks install.

### Tests

**`packages/core/src/__tests__/session-backfill.test.ts`**:

Create a temporary directory mimicking `~/.claude/projects/` structure:
1. `scanForSessions` discovers JSONL files in project dirs.
2. `scanForSessions` uses `sessions-index.json` when present.
3. Subagent files in subdirectories are skipped.
4. Non-JSONL files are skipped.
5. Files modified within 5 minutes are skipped (potentially active).
6. `projectDirToPath("-Users-john-Desktop-foo")` returns `"/Users/john/Desktop/foo"`.
7. Workspace resolution: existing git repo → canonical ID.
8. Workspace resolution: non-existent path → `_unassociated`.
9. Empty JSONL file: discovered but with `messageCount = 0`.
10. Backfill state load/save round-trips correctly.

**`packages/cli/src/commands/__tests__/backfill.test.ts`**:
1. `--dry-run` with test fixtures: prints summary without ingesting.
2. `--status` shows state from file.
3. Default run with mock API: reports progress and results.

## Relevant Files
- `packages/core/src/session-backfill.ts` (create)
- `packages/core/src/backfill-state.ts` (create)
- `packages/cli/src/commands/backfill.ts` (create)
- `packages/cli/src/index.ts` (modify — register backfill command)
- `packages/cli/src/commands/init.ts` (modify — add auto-trigger)
- `packages/cli/src/commands/hooks.ts` (modify — add auto-trigger)
- `packages/core/src/__tests__/session-backfill.test.ts` (create)
- `packages/cli/src/commands/__tests__/backfill.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export)

## Success Criteria
1. `scanForSessions` discovers all JSONL files in `~/.claude/projects/` subdirectories.
2. Session ID correctly extracted from filename (UUID from `{uuid}.jsonl`).
3. `sessions-index.json` used for metadata when available (avoids parsing every JSONL).
4. Subagent transcripts in subdirectories are skipped.
5. Files modified within 5 minutes are skipped as potentially active.
6. `projectDirToPath` correctly converts directory names to paths.
7. Workspace resolution works for existing git repos; falls back to `_unassociated`.
8. Already-ingested sessions are skipped (dedup by session ID).
9. Re-running backfill is idempotent.
10. `--dry-run` reports without modifying data.
11. `--status` shows last/current backfill state.
12. Progress callback fires, CLI shows progress bar.
13. Auto-trigger from init/hooks spawns background process.
14. Batched ingestion: events POSTed in batches of 50 with throttling.
15. Large transcripts uploaded via streaming.
16. AbortSignal (Ctrl-C) cancels cleanly.
17. Backfill state persists at `~/.fuel-code/backfill-state.json`.
