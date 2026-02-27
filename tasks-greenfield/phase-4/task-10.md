# Task 10: Phase 4 E2E Integration Tests

## Parallel Group: D

## Dependencies: Tasks 4, 5, 6, 8, 9

## Description

End-to-end tests verifying the complete Phase 4 user experience against a real test backend (Express + Postgres + Redis + WebSocket). These tests complement per-task unit tests by exercising the full stack: CLI commands spawn real processes that hit a real server with seeded test data, WebSocket broadcasts propagate correctly, and TUI components render with real API responses.

Tests run via `bun test`. All test files live under `packages/cli/src/__tests__/e2e/`.

### Test Infrastructure Setup (`packages/cli/src/__tests__/e2e/setup.ts`)

A shared setup module that:

1. **Starts a test Express server** (in-process, on a random available port) with Postgres, Redis, and WebSocket server.
2. **Seeds Postgres with fixture data** covering the full range of states Phase 4 must handle.
3. **Provides helper functions** for test assertions.
4. **Tears down cleanly** after all tests.

```typescript
// packages/cli/src/__tests__/e2e/setup.ts

import { createApp } from '@fuel-code/server/app';
import { createServer } from 'http';
import { createWsServer } from '@fuel-code/server/ws';
import { getAvailablePort } from './helpers';

// Fixture data to seed into the test database
export interface TestFixtures {
  workspaces: {
    fuelCode: { id: string; canonical_id: string; display_name: string };
    apiService: { id: string; canonical_id: string; display_name: string };
    unassociated: { id: string; canonical_id: string; display_name: string };
  };
  devices: {
    macbookPro: { id: string; name: string; type: 'local' };
    remoteAbc: { id: string; name: string; type: 'remote' };
  };
  sessions: {
    // 8 sessions with varied lifecycles
    liveFuelCode: { id: string; lifecycle: 'capturing'; workspace: 'fuelCode'; device: 'macbookPro' };
    doneFuelCode1: { id: string; lifecycle: 'summarized'; workspace: 'fuelCode'; device: 'macbookPro' };
    doneFuelCode2: { id: string; lifecycle: 'summarized'; workspace: 'fuelCode'; device: 'remoteAbc' };
    failedFuelCode: { id: string; lifecycle: 'failed'; workspace: 'fuelCode'; device: 'macbookPro' };
    doneApiService: { id: string; lifecycle: 'summarized'; workspace: 'apiService'; device: 'macbookPro' };
    parsedApiService: { id: string; lifecycle: 'parsed'; workspace: 'apiService'; device: 'macbookPro' };
    doneUnassociated1: { id: string; lifecycle: 'summarized'; workspace: 'unassociated'; device: 'macbookPro' };
    doneUnassociated2: { id: string; lifecycle: 'summarized'; workspace: 'unassociated'; device: 'macbookPro' };
  };
}
```

**Fixture seed data (inserted into Postgres)**:

- **3 workspaces**:
  - `fuel-code` (canonical: `github.com/user/fuel-code`, display: `fuel-code`)
  - `api-service` (canonical: `github.com/user/api-service`, display: `api-service`)
  - `_unassociated` (canonical: `_unassociated`, display: `_unassociated`)

- **2 devices**:
  - `macbook-pro` (type: local, hostname: Johns-MBP, os: darwin, arch: arm64)
  - `remote-abc` (type: remote, hostname: ip-10-0-1-42, os: linux, arch: x86_64)

- **8 sessions** across workspaces and devices, with a mix of lifecycles:
  - 1 `capturing` (live, fuel-code workspace, macbook-pro, started 12 minutes ago)
  - 3 `summarized` (fuel-code x2 + unassociated, various durations and costs)
  - 1 `failed` (fuel-code workspace, parse failed)
  - 1 `parsed` (api-service, not yet summarized)
  - 2 more `summarized` (api-service + unassociated)
  - Each session has realistic metadata: duration_ms, cost_estimate_usd, model, branch, tags, summary

- **20+ events** distributed across sessions:
  - `session.start` and `session.end` for each non-live session
  - `cc.session_start` events
  - `git.commit` events (5 total, associated with fuel-code sessions)
  - `git.push` events (2 total)
  - `git.checkout` events (1 total)

- **Parsed transcripts for 3 sessions** (fuel-code summarized sessions + the live session):
  - Each transcript has 4-8 messages (alternating Human/Assistant)
  - Assistant messages include content_blocks: text, tool_use (Read, Edit, Bash), thinking
  - Realistic content: file paths, bash commands, code snippets

- **5 git activity records** linked to fuel-code sessions:
  - 3 commits (with hash, message, author, branch, file_list, insertions, deletions)
  - 1 push (with branch, remote, commit_count)
  - 1 checkout (with from_branch, to_branch)

**Setup lifecycle**:

```typescript
// Before all tests: start server, seed data
export async function setupE2E(): Promise<{
  baseUrl: string;
  wsUrl: string;
  apiKey: string;
  fixtures: TestFixtures;
  cleanup: () => Promise<void>;
}>

// Seeds all fixture data via direct Postgres inserts (not via API, for speed).
// Returns fixture references (IDs) so tests can assert against known values.
```

**Config file for CLI tests**: Write a temporary `~/.fuel-code/config.yaml` pointing to the test server. Restore the original after tests. Or pass config via environment variables that the `ApiClient` reads.

### CLI Command E2E Tests (`packages/cli/src/__tests__/e2e/phase4-cli.test.ts`)

Each test runs the CLI binary via `Bun.spawn` and captures stdout. The CLI binary is invoked with environment variables pointing to the test server.

```typescript
// Helper to run a CLI command and capture output
async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(['bun', 'run', 'packages/cli/src/index.ts', ...args], {
    env: {
      ...process.env,
      FUEL_CODE_API_URL: testBaseUrl,
      FUEL_CODE_API_KEY: testApiKey,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Read stdout/stderr, wait for exit
}
```

**Test cases**:

1. **`fuel-code sessions`** — outputs a table with rows matching the 8 seeded sessions. Assert: table contains session IDs or workspace names from fixtures; status icons (● LIVE, ✓ DONE, ✗ FAIL) appear; columns include WORKSPACE, DEVICE, DURATION, COST, SUMMARY.

2. **`fuel-code sessions --workspace fuel-code`** — outputs only sessions for the fuel-code workspace. Assert: exactly 4 sessions (live + 2 summarized + 1 failed); no api-service or _unassociated sessions appear.

3. **`fuel-code sessions --today`** — outputs only sessions started today. Assert: all seeded sessions have today's dates, so all should appear (or verify with a session seeded with yesterday's date that it gets excluded).

4. **`fuel-code sessions --json`** — outputs valid JSON. Assert: `JSON.parse(stdout)` succeeds; result is an array of session objects; each has required fields (id, workspace_id, lifecycle, etc.).

5. **`fuel-code session <id>`** — using a summarized session ID from fixtures. Assert: output contains session summary card with Workspace, Device, Duration, Cost, Status, Summary, Tools, Tokens, Commits counts.

6. **`fuel-code session <id> --transcript`** — using a session with a parsed transcript. Assert: output contains conversation turns with `[1] Human:`, `[2] Assistant:`; tool usage lines with `├` and `└` characters; content from seeded transcript messages.

7. **`fuel-code session <id> --git`** — using a session with git activity. Assert: output contains commit hashes and messages from seeded git_activity records; shows insertions/deletions.

8. **`fuel-code session <id> --export json`** — Assert: writes a file `session-<id>.json` to current directory; file contains valid JSON with session, transcript, events, and git_activity keys; clean up the file after test.

9. **`fuel-code session <id> --tag test-e2e`** — Assert: stdout shows confirmation message "Tag \"test-e2e\" added to session ..."; verify via API (`GET /api/sessions/:id`) that the tag now exists on the session.

10. **`fuel-code timeline`** — Assert: output contains session-grouped timeline entries for today; shows session summaries and git events; uses box-drawing characters (┌─ │ └─).

11. **`fuel-code workspaces`** — Assert: output table lists all 3 workspaces (fuel-code, api-service, _unassociated); shows session counts, last activity.

12. **`fuel-code workspace fuel-code`** — Assert: output shows workspace detail: canonical ID, branch, devices, recent sessions, recent git activity, aggregate stats.

13. **`fuel-code status`** — Assert: output shows device info, backend connectivity ("Connected"), active sessions count (1, the live session), queue depth.

14. **`fuel-code session nonexistent-id-12345`** — Assert: exit code is non-zero; stderr or stdout contains "not found" or similar error message; no stack trace in output.

### WebSocket E2E Tests (`packages/cli/src/__tests__/e2e/phase4-ws.test.ts`)

Tests that verify WebSocket connectivity and message flow between the test server and the `WsClient`.

```typescript
import { WsClient } from '../../lib/ws-client';
```

15. **WS connect with valid token** — Create a `WsClient` pointing to the test server. Call `connect()`. Assert: resolves without error; `client.connected` is `true`.

16. **WS subscribe "all" and receive broadcast** — Connect and subscribe to `scope: "all"`. POST a new event to `/api/events/ingest` (a `session.start` event for a new session). Assert: the `WsClient` receives an `event` message within 5 seconds containing the ingested event.

17. **WS subscribe workspace and receive filtered events** — Subscribe to `workspace_id: fixtures.workspaces.fuelCode.id`. POST an event for that workspace. Assert: received. POST an event for a *different* workspace (`apiService`). Assert: NOT received within 2 seconds.

18. **WS session lifecycle change** — Subscribe to `session_id: fixtures.sessions.liveFuelCode.id`. Trigger a session lifecycle change by ingesting a `session.end` event for that session. Assert: the `WsClient` receives a `session.update` message with `lifecycle: 'ended'` for the correct session_id.

### TUI Smoke Tests (`packages/cli/src/__tests__/e2e/phase4-tui.test.tsx`)

Use `ink-testing-library` to render the TUI components with a mock `ApiClient` that returns the seeded fixture data (or a real `ApiClient` pointed at the test server). These are smoke tests — verify that the TUI renders without crashing and shows expected content.

```typescript
import { render } from 'ink-testing-library';
import { Dashboard } from '../../tui/Dashboard';
import { SessionDetailView } from '../../tui/SessionDetailView';
```

19. **Dashboard renders workspace list** — Render `<Dashboard>` with an `ApiClient` returning fixture workspaces. Assert: output string contains "fuel-code", "api-service", "_unassociated".

20. **Dashboard renders session list for selected workspace** — Render `<Dashboard>`. Assert: output string contains session data for the first workspace (fuel-code): the live session's summary, the summarized session summaries.

21. **Enter on session navigates to SessionDetail** — Render `<Dashboard>` with a spy `onSelectSession`. Simulate pressing `Enter`. Assert: `onSelectSession` was called with the ID of the first (selected) session.

### Error Handling Tests (`packages/cli/src/__tests__/e2e/phase4-errors.test.ts`)

22. **Backend unreachable — graceful error** — Run `fuel-code sessions` with `FUEL_CODE_API_URL` pointing to a port with no server. Assert: exit code is non-zero; output contains a user-friendly connection error message (e.g., "Cannot connect to backend"); no stack trace, no unhandled promise rejection.

23. **Invalid workspace name — "not found" with suggestions** — Run `fuel-code sessions --workspace nonexistent-workspace`. Assert: output contains "Workspace not found" or similar; if there are similar workspace names, output lists them as suggestions.

24. **Invalid API key — auth error** — Run `fuel-code sessions` with an invalid `FUEL_CODE_API_KEY`. Assert: output contains "Unauthorized" or "Invalid API key" message; exit code is non-zero.

### Test Organization and Running

```
packages/cli/src/__tests__/e2e/
├── setup.ts                  — test server setup, fixtures, helpers
├── fixtures.ts               — fixture data definitions (workspaces, devices, sessions, events, transcripts)
├── helpers.ts                — runCli helper, assertion utilities
├── phase4-cli.test.ts        — CLI command E2E tests (tests 1-14)
├── phase4-ws.test.ts         — WebSocket E2E tests (tests 15-18)
├── phase4-tui.test.tsx       — TUI smoke tests (tests 19-21)
└── phase4-errors.test.ts     — Error handling tests (tests 22-24)
```

**Test isolation**: Each test file uses `beforeAll` to start the test server and seed data, and `afterAll` to tear it down. Tests within a file share the server instance (for speed) but should not depend on ordering. Tests that mutate state (e.g., `--tag`) should either use unique session IDs or clean up after themselves.

**Timeout**: Set a generous timeout (30 seconds per test) for E2E tests since they involve real server startup, DB operations, and process spawning. The entire suite should complete in under 60 seconds.

**Port allocation**: Use `getAvailablePort()` helper (try binding to port 0, read assigned port) to avoid conflicts with other processes or parallel test runs.

### Tests

Summary of all 24 test cases:

**CLI Commands (tests 1-14)**:
1. `fuel-code sessions` → table with all 8 sessions
2. `fuel-code sessions --workspace fuel-code` → only fuel-code sessions
3. `fuel-code sessions --today` → today's sessions only
4. `fuel-code sessions --json` → valid JSON array
5. `fuel-code session <id>` → summary card with all metadata fields
6. `fuel-code session <id> --transcript` → conversation turns with tool trees
7. `fuel-code session <id> --git` → git activity table
8. `fuel-code session <id> --export json` → writes valid JSON file
9. `fuel-code session <id> --tag test-e2e` → tag added, verified via API
10. `fuel-code timeline` → session-grouped activity feed
11. `fuel-code workspaces` → workspace table with counts
12. `fuel-code workspace fuel-code` → workspace detail view
13. `fuel-code status` → status card with connectivity info
14. `fuel-code session nonexistent` → user-friendly error message

**WebSocket (tests 15-18)**:
15. WS connect with valid token → success
16. Subscribe "all" → receive broadcast events
17. Subscribe workspace → only matching events received
18. Session lifecycle change → `session.update` received

**TUI Smoke (tests 19-21)**:
19. Dashboard renders workspace list from seeded data
20. Dashboard renders session list for first workspace
21. Enter on session → `onSelectSession` called with correct ID

**Error Handling (tests 22-24)**:
22. Backend unreachable → graceful error message (no stack trace)
23. Invalid workspace name → "not found" with suggestions
24. Invalid API key → "Unauthorized" message

## Relevant Files

### Create
- `packages/cli/src/__tests__/e2e/setup.ts` — test server setup: start Express+Postgres+Redis+WS, seed fixtures, teardown
- `packages/cli/src/__tests__/e2e/fixtures.ts` — fixture data definitions: workspaces, devices, sessions, events, transcripts, git activity
- `packages/cli/src/__tests__/e2e/helpers.ts` — `runCli()` helper, port allocation, assertion utilities
- `packages/cli/src/__tests__/e2e/phase4-cli.test.ts` — CLI command E2E tests (14 test cases)
- `packages/cli/src/__tests__/e2e/phase4-ws.test.ts` — WebSocket E2E tests (4 test cases)
- `packages/cli/src/__tests__/e2e/phase4-tui.test.tsx` — TUI smoke tests with ink-testing-library (3 test cases)
- `packages/cli/src/__tests__/e2e/phase4-errors.test.ts` — error handling E2E tests (3 test cases)

### Modify
- None (all infrastructure from prior tasks should be sufficient)

## Success Criteria

1. Test server starts successfully on a random available port with Postgres, Redis, and WebSocket.
2. Fixture data is seeded correctly: 3 workspaces, 2 devices, 8 sessions (mix of lifecycles), 20+ events, parsed transcripts for 3 sessions, 5 git activity records.
3. `fuel-code sessions` produces a table with rows matching the seeded sessions (correct status icons, workspace names, device names).
4. `fuel-code sessions --workspace fuel-code` returns only the 4 fuel-code sessions.
5. `fuel-code sessions --json` returns valid JSON that can be parsed and contains all seeded session fields.
6. `fuel-code session <id>` renders a summary card with correct workspace, device, duration, cost, status, summary, tool counts, and token counts.
7. `fuel-code session <id> --transcript` shows conversation turns from the seeded transcript with tool usage tree formatting.
8. `fuel-code session <id> --git` shows git activity from seeded data with commit hashes and messages.
9. `fuel-code session <id> --export json` writes a valid JSON file to disk containing session + transcript + events + git data.
10. `fuel-code session <id> --tag test-e2e` adds the tag (verified by re-fetching the session via API).
11. `fuel-code timeline` shows session-grouped activity entries for today.
12. `fuel-code workspaces` lists all 3 workspaces with correct session counts.
13. `fuel-code workspace fuel-code` shows workspace detail with sessions, git, devices, and stats.
14. `fuel-code status` shows backend connectivity, active sessions, and queue depth.
15. `fuel-code session nonexistent-id` returns a user-friendly "not found" error (no stack trace).
16. WS client connects to test server with valid token and reports `connected: true`.
17. WS subscription to "all" receives broadcast events when new events are ingested via the API.
18. WS subscription to a specific workspace only receives events for that workspace (not others).
19. WS subscription to a session receives `session.update` when the session's lifecycle changes.
20. TUI Dashboard renders workspace list containing all 3 seeded workspace names.
21. TUI Dashboard renders session data for the first workspace.
22. TUI Dashboard's `onSelectSession` is called with the correct session ID when Enter is pressed.
23. Backend unreachable produces a user-friendly error message, not a stack trace or unhandled rejection.
24. Invalid workspace name produces a "not found" error with available workspace names listed.
25. All E2E tests pass within 60 seconds total (`bun test`).
26. Tests clean up after themselves: no leftover test files, no orphaned server processes, no leaked DB state.
27. Fixture data is isolated per test suite (no cross-test contamination).
