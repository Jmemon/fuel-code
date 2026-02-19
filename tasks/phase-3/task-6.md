# Task 6: Phase 3 E2E Integration Tests

## Parallel Group: D

## Dependencies: Tasks 2, 3, 4, 5

## Description

Build an integration test suite verifying the complete Phase 3 pipeline: git hook scripts emit events → event processor handles them → git_activity table populated → session-git correlation works → timeline API returns correct data. Also verify the auto-prompt flow, hook installation/uninstallation, and per-repo opt-out.

### Prerequisites
- Docker Compose for Postgres and Redis (from Phase 1/2 test infrastructure)
- All Phase 3 tasks (1–5) complete

### Test Infrastructure

Reuse `docker-compose.test.yml` from Phase 1/2 (Postgres, Redis, LocalStack already configured).

### Test Setup

- Use same test-specific env vars as Phase 2: `DATABASE_URL`, `REDIS_URL`, etc.
- `beforeAll`: run all migrations (including Phase 3 migration), flush Redis, start consumer.
- `afterAll`: stop consumer, close connections.
- `afterEach`: TRUNCATE `git_activity`, reset `workspace_devices` prompt columns. Preserve sessions created by setup.

### Test Fixtures

**Test git repo**: Create a temporary git repo in `beforeAll` with:
- `git init`, configure user.name and user.email
- `git remote add origin git@github.com:test/fixture-repo.git`
- A few initial commits for test data

### Files to Create

**`packages/server/src/__tests__/e2e/phase3-git-tracking.test.ts`**:

**Test 1: Full pipeline — git.commit event → git_activity + session correlation**:
1. POST `session.start` event with workspace + device IDs. Wait for session `lifecycle = 'detected'`.
2. Verify session is at `lifecycle = 'detected'` (sessions stay at `detected` from session.start until session.end — correlation matches both `detected` and `capturing`).
3. POST `git.commit` event with same workspace + device + commit metadata.
4. Wait for event to be processed.
5. Assert: `git_activity` row exists with correct type='commit', commit_sha, branch, message, files_changed, insertions, deletions.
6. Assert: `git_activity.session_id` matches the active session ID (correlation worked).
7. Assert: `events.session_id` is also set for the git.commit event.
8. Assert: `git_activity.data` contains author_name, author_email, file_list.

**Test 2: Git commit without active session → orphan**:
1. POST `git.commit` event (no active session for this workspace+device).
2. Wait for processing.
3. Assert: `git_activity` row exists with `session_id = NULL`.
4. Assert: no error logged.

**Test 3: Multiple git event types**:
1. Start a session (will be at `detected`).
2. POST `git.commit`, `git.checkout`, `git.merge`, `git.push` events — all same workspace+device.
3. Assert: 4 `git_activity` rows exist.
4. Assert: all have correct `type` values.
5. Assert: all correlated to the same session.
6. `GET /api/sessions/:id/git` returns all 4 items.

**Test 4: Session ends, then commit → no correlation**:
1. POST `session.start`, then `session.end`.
2. POST `git.commit` for same workspace+device.
3. Assert: commit has `session_id = NULL` (session is `ended`, not active).

**Test 5: Timeline API — sessions with git highlights**:
1. Create 3 sessions with events. For session 2, add 2 git.commit events.
2. `GET /api/timeline` → returns 3 items of type='session'.
3. Session 2's item has `git_activity` array with 2 commits.
4. Sessions 1 and 3 have empty `git_activity` arrays.

**Test 6: Timeline API — orphan git events**:
1. Create 1 session at 10:00.
2. POST `git.commit` at 09:30 (no session active, orphan).
3. Create 1 session at 09:00.
4. `GET /api/timeline` → items interleaved: [10:00 session, 9:30 orphan git, 9:00 session].

**Test 7: Timeline API — filtering**:
1. Create sessions in different workspaces.
2. `GET /api/timeline?workspace_id=<id>` returns only matching workspace.
3. `GET /api/timeline?types=commit` returns only commit highlights (not pushes).
4. `GET /api/timeline?after=<timestamp>` returns only sessions after timestamp.

**Test 8: Timeline API — pagination**:
1. Create 5 sessions.
2. `GET /api/timeline?limit=2` → 2 items + cursor + `has_more = true`.
3. Follow cursor → next 2 items.
4. Follow cursor → 1 item + `has_more = false`.
5. Total across pages = 5, no duplicates.

**Test 9: Auto-prompt — session.start flags workspace for git hooks prompt**:
1. Create a workspace+device pair with `git_hooks_installed = false`.
2. POST `session.start` for that workspace+device.
3. Assert: `workspace_devices.pending_git_hooks_prompt = true`.
4. `GET /api/prompts/pending?device_id=<id>` returns the prompt.

**Test 10: Auto-prompt — already installed workspace not prompted**:
1. Set `git_hooks_installed = true` on workspace_devices.
2. POST `session.start`.
3. Assert: `pending_git_hooks_prompt` is still false.

**Test 11: Auto-prompt — dismiss prompt**:
1. Create pending prompt (from Test 9).
2. `POST /api/prompts/dismiss { workspace_id, action: "declined" }`.
3. Assert: `pending_git_hooks_prompt = false`, `git_hooks_prompted = true`.
4. POST another `session.start`: prompt is NOT re-set.

**Test 12: Duplicate git.commit event handling**:
1. POST same `git.commit` event twice (same event ID).
2. Assert: only 1 `git_activity` row (ON CONFLICT DO NOTHING).
3. No error.

**Test 13: Handler registration verification**:
1. Check that `createHandlerRegistry().listRegisteredTypes()` includes: `session.start`, `session.end`, `git.commit`, `git.push`, `git.checkout`, `git.merge`.

### Hook Script Tests

**`packages/hooks/git/__tests__/e2e/hook-integration.test.ts`**:

These test the hook scripts end-to-end in a real git repo with a mock `fuel-code emit`.

1. **post-commit fires correctly**: Create temp repo, install hooks, make a commit. Assert mock emit was called with correct payload.
2. **post-checkout fires on branch switch**: Switch branches. Assert emit called. Switch back. Assert emit called again.
3. **post-checkout skips file checkout**: `git checkout -- file.txt`. Assert emit NOT called.
4. **post-merge fires**: Merge a branch. Assert emit called with merge metadata.
5. **pre-push fires**: Push to a test remote (local bare repo). Assert emit called.
6. **Opt-out respected**: Create `.fuel-code/config.yaml` with `git_enabled: false`. Make commit. Assert emit NOT called.
7. **Hook chaining**: Create a `.user` hook that writes a marker file. Make commit. Assert both the marker file exists AND emit was called.
8. **Graceful degradation**: Remove `fuel-code` from PATH. Make commit. Assert git commit succeeds (exit 0) and no errors printed.

### Helpers

Reuse the `waitFor` helper from Phase 1/2 E2E tests:
```typescript
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number = 10000,
  intervalMs: number = 500
): Promise<T>
```

Mock `fuel-code emit` script for hook tests:
```bash
#!/usr/bin/env bash
# Mock fuel-code emit — writes received args to a temp file for assertion
echo "$@" >> /tmp/fuel-code-emit-calls.txt
# If --data-stdin, also capture stdin
if [[ "$*" == *"--data-stdin"* ]]; then
  cat >> /tmp/fuel-code-emit-stdin.txt
fi
exit 0
```

### Test Runner Configuration

```toml
[test]
timeout = 60000  # 60s per test (git operations + event processing)
```

## Relevant Files
- `packages/server/src/__tests__/e2e/phase3-git-tracking.test.ts` (create)
- `packages/hooks/git/__tests__/e2e/hook-integration.test.ts` (create)

## Success Criteria
1. Test 1 verifies complete pipeline: git.commit → git_activity with session correlation.
2. Test 2 verifies orphan git events (no active session) get `session_id = NULL`.
3. Test 3 verifies all 4 git event types are handled and correlated.
4. Test 4 verifies correlation only works for active sessions (`detected`/`capturing`), not `ended`.
5. Tests 5-8 verify timeline API: session grouping, orphan events, filtering, pagination.
6. Tests 9-11 verify auto-prompt: flagging, skipping installed, dismissing.
7. Test 12 verifies duplicate event handling (idempotent).
8. Test 13 verifies handler registration includes all git types.
9. Hook integration tests verify scripts work in real git repos.
10. Hook opt-out test verifies `.fuel-code/config.yaml` check.
11. Hook chaining test verifies `.user` hooks are called.
12. Graceful degradation test verifies hooks exit 0 without `fuel-code` in PATH.
13. All Phase 1 and Phase 2 E2E tests still pass (backward compatible).
14. Tests are isolated: each test cleans up. Running twice produces same results.
15. All tests pass with `bun test packages/server/src/__tests__/e2e/phase3-git-tracking.test.ts`.
