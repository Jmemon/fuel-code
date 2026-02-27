# Phase 3 Implementation Review

## Overview

Phase 3 ("Git Activity Tracking") was implemented across 6 tasks in 12 commits (a26a9ba..55f9dd5, plus merge c86390e and 673d2b4). The phase adds git hook scripts that emit structured events on commit/push/checkout/merge, server-side handlers that correlate git activity to Claude Code sessions, a timeline API, and an auto-prompt system for hook installation.

**Stats**: 48 files changed, ~8,954 lines added, ~88 removed. 15 test files, ~6,001 test lines. All 618 tests pass (554 non-skipped), 0 failures.

---

## Task-by-Task Assessment

### Task 1: Git Hook Scripts + `emit --data-stdin` — PASS

**Spec**: Bash hook scripts for post-commit, post-checkout, post-merge, pre-push. Shared `resolve-workspace.sh`. CLI `--data-stdin` flag.

**Implementation**:
- 5 bash scripts in `packages/hooks/git/` with consistent structure: chain to `.user` hook → check fuel-code in PATH → check per-repo opt-out → resolve workspace → extract metadata → background emit.
- `resolve-workspace.sh` normalizes SSH (`git@host:user/repo.git` → `host/user/repo`) and HTTPS remotes, handles local-only repos via `sha256(first_commit)`.
- `emit.ts` extended with `--data-stdin` flag; invalid JSON gracefully wrapped as `{ _raw: text }`.

**Review fixes applied** (49e7ce3):
- Replaced `grep -oP` (GNU-only) with `bash [[ =~ ]]` regex for macOS compatibility.
- Added `python3` JSON escaping for commit messages, author names/emails, file paths.
- Lowercased HOST in resolve-workspace.sh to match TS `normalizeGitRemote()`.
- Used `git rev-parse --git-dir` instead of hardcoded `.git/`.

**Verdict**: Complete. Safety invariant ("never block git") upheld — all hooks unconditionally exit 0, all emits are fire-and-forget background subshells. 23 tests including real git repo operations with mock CLI binary.

---

### Task 2: Git Hook Installer — PASS

**Spec**: `fuel-code hooks install/uninstall/status` with global (`core.hooksPath`) and per-repo (`.git/hooks/`) modes. Backup/restore, chaining, competing manager detection.

**Implementation**:
- `git-hook-installer.ts` (608 lines): installs hooks to `~/.fuel-code/git-hooks/`, sets `core.hooksPath`, detects Husky/Lefthook/pre-commit, backs up existing hooks as `.user` files, saves metadata to timestamped backup dir with `meta.json`.
- `git-hook-status.ts` (128 lines): reports installation state, hook existence/executability, chaining status.
- `hooks.ts` extended with `install --git-only/--cc-only/--per-repo/--force`, `uninstall --git-only/--cc-only/--restore`, and `status` subcommands.

**Review fixes applied** (5abeee6):
- Timestamped backup directories (ISO 8601 with ms) for multiple install/uninstall cycles.
- Added unit test file for installer internals.

**Verdict**: Complete. Idempotent installs, clean uninstalls, comprehensive 23+11 tests. Test isolation via override functions that redirect all filesystem ops to temp dirs.

---

### Task 3: Git Event Handlers + `git_activity` Table — PASS

**Spec**: Migration for `git_activity` table, Zod payload schemas, git-session correlator, 4 event handlers, wire into handler registry.

**Implementation**:
- `003_create_git_activity.sql`: table with CHECK constraint on `type`, nullable `session_id` for orphans, JSONB `data` column, 5 indexes (including partial index on `session_id WHERE NOT NULL` and composite `(workspace_id, timestamp DESC)`).
- 4 Zod schemas in `packages/shared/src/schemas/` registered in payload-registry.
- `git-correlator.ts`: queries `sessions` for active (`detected`/`capturing` lifecycle) session on same workspace+device with `started_at <= event_timestamp`, returns most-recently-started.
- 4 handlers (`git-commit.ts`, `git-push.ts`, `git-checkout.ts`, `git-merge.ts`): correlate → transaction { INSERT git_activity ON CONFLICT DO NOTHING + UPDATE events.session_id WHERE NULL } → log.
- Handler registry updated: 6 total handlers.

**Review fixes applied** (48b62b8):
- Wrapped git handler DB operations in `sql.begin()` transactions (was bare queries).
- Added `LIMIT 500` to `GET /sessions/:id/git` endpoint.

**Verdict**: Complete. Three-layer idempotency (processEvent dedup → ON CONFLICT DO NOTHING → session_id IS NULL guard). 26 handler tests + 8 correlator tests.

---

### Task 4: Auto-Prompt for Git Hook Installation — PASS

**Spec**: When `session.start` fires for a git-repo workspace without hooks, flag for prompting. CLI checks on interactive commands and offers installation.

**Implementation**:
- `004_add_git_hooks_prompt_columns.sql`: adds `pending_git_hooks_prompt` and `git_hooks_prompted` booleans to `workspace_devices`.
- `session-start.ts` extended with `checkGitHooksPrompt()`: skips `_unassociated` workspaces, checks workspace_devices flags, sets pending prompt.
- `prompts.ts` route: `GET /api/prompts/pending` (filtered by device_id), `POST /api/prompts/dismiss` (accepted/declined).
- `prompt-checker.ts`: 2-second timeout, silent failure, returns `[]` on any error.
- `git-hooks-prompt.ts`: interactive Y/n prompt (auto-dismiss if already installed, non-TTY defaults to "n").
- `index.ts` preAction hook: checks prompts on interactive commands (sessions, status, hooks, backfill).

**Verdict**: Complete. Non-blocking design — prompt check never prevents CLI usage. 7 session-start-prompt tests + 8 prompts route tests + 7 prompt-checker tests.

---

### Task 5: Timeline API — PASS

**Spec**: `GET /api/timeline` — unified session + git activity feed with pagination, filtering, orphan events.

**Implementation**:
- `timeline.ts` (381 lines): 4-step query strategy — validate → fetch paginated sessions → batch-fetch git_activity for those sessions → fetch orphan git_activity (session_id IS NULL) → merge and sort chronologically.
- `timeline-query.ts` Zod schema: workspace_id, device_id, after/before (ISO 8601), types (comma-separated → array), limit (default 20, capped at 100), cursor.
- Cursor-based pagination using base64-encoded `{s: started_at, i: id}`.
- Dynamic WHERE clauses composed via postgres.js tagged template fragments (no string concatenation, no SQL injection).

**Review fixes applied** (0b2d747):
- Changed limit validation from reject-on-over-100 to clamp-at-100 (friendlier API behavior).

**Verdict**: Complete. All queries use postgres.js tagged templates — no SQL injection risk. 15 route tests + E2E coverage.

---

### Task 6: Phase 3 E2E Integration Tests — PASS

**Spec**: End-to-end tests covering the full git tracking pipeline.

**Implementation**: `phase3-git-tracking.test.ts` (1,287 lines, 13 tests):
1. Full pipeline: git.commit → Redis → consumer → git_activity with session correlation
2. Orphan git.commit (no active session) → session_id NULL
3. All 4 event types processed and correlated
4. Session end breaks correlation
5. Timeline API: sessions with embedded git_activity
6. Timeline API: orphan git events
7. Timeline API: filtering (workspace_id, types, after timestamp)
8. Timeline API: cursor-based pagination (3 pages)
9. Auto-prompt: session.start flags workspace
10. Auto-prompt: already-installed workspace skipped
11. Auto-prompt: dismiss prevents re-prompting
12. Idempotency: duplicate git.commit → ON CONFLICT DO NOTHING
13. Handler registry completeness

**Review fixes applied** (51176c7): Added `after=timestamp` filter assertion to Test 7.

**Verdict**: True E2E — real Postgres, real Redis, real Express, real consumer loop. Thorough coverage with `waitFor` polling for async processing. 30s timeouts for CI.

---

## Issues Found

### Issue #1: Branch Names Not JSON-Escaped in Hook Scripts

**Severity**: Low
**Location**: All 4 hook scripts in `packages/hooks/git/`

Commit messages, author names/emails, and file paths are JSON-escaped via `python3 -c 'import json,sys; ...'`. However, **branch names, remote names, and refs are injected raw** into JSON heredocs:

```bash
# post-commit line 79
"branch": "$BRANCH",

# pre-push line 85
"branch": "$BRANCH",
"remote": "$REMOTE_NAME",
```

A branch name containing a double-quote or backslash (technically valid in git) would produce malformed JSON. The `emit.ts` graceful fallback (`_raw` on parse failure) mitigates total data loss, but the structured payload would be lost.

**Impact**: Near-zero in practice — git branch naming conventions rarely include special characters, and most git hosting providers reject them. But the inconsistency with other fields is worth noting.

**Fix**: Apply the same `python3` JSON escaping to `$BRANCH`, `$REMOTE_NAME`, `$FROM_BRANCH_JSON`, `$TO_BRANCH_JSON`, `$INTO_BRANCH`, `$MERGED_BRANCH`.

---

### Issue #2: `MERGE_HEAD` May Not Exist When post-merge Runs

**Severity**: Low
**Location**: `packages/hooks/git/post-merge` lines 36-41

The primary merged-branch detection reads `.git/MERGE_HEAD`, but git typically deletes this file after creating the merge commit — which happens *before* the post-merge hook fires. The fallback (parsing "Merge branch 'name'" from the commit message) is the actual code path used in most cases.

**Impact**: The fallback works for standard merges. It fails for: non-English git locales, custom merge messages, and squash merges (where there is no merge commit at all). In these cases `merged_branch` will be `"unknown"`.

**Fix**: Accept as known limitation. Document that `merged_branch = "unknown"` is expected for squash merges and custom merge messages.

---

### Issue #3: `shasum` Portability on Linux

**Severity**: Low
**Location**: `packages/hooks/git/resolve-workspace.sh` line 22

Uses `shasum -a 256` for local-only repo workspace IDs. This is available on macOS but not on minimal Linux images (Alpine, Debian-slim) where `sha256sum` is the standard equivalent.

**Impact**: Only affects repos with no git remote (local-only repos) on Linux without Perl installed. The hook would produce an empty workspace ID and skip emitting.

**Fix**: `shasum -a 256 2>/dev/null || sha256sum`

---

### Issue #4: `python3` Soft Dependency Silently Degrades Data

**Severity**: Low
**Location**: `packages/hooks/git/post-commit`, `packages/hooks/git/post-merge`

If `python3` is not installed, JSON escaping falls back to `echo '""'`, meaning commit messages, author names, and emails are silently replaced with empty strings. The event is emitted but with lost metadata.

**Impact**: Minimal on macOS/typical dev machines (python3 ships with Xcode CLI tools). Could affect CI containers or minimal Linux environments.

**Fix**: Accept as known limitation. The error path logs to `~/.fuel-code/hook-errors.log`, which could be surfaced in `fuel-code hooks status`.

---

### Issue #5: `git-hooks-prompt.ts` Dismisses as "accepted" on Install Failure

**Severity**: Medium
**Location**: `packages/cli/src/lib/git-hooks-prompt.ts` line 66

When the user accepts the git hooks prompt but `installGitHooks()` throws, the catch block prints the error but still calls `dismissPrompt(config, prompt.workspaceId, "accepted")`. This permanently suppresses the prompt for that workspace even though hooks were never installed.

```typescript
} catch (e: any) {
  process.stderr.write(`  Failed to install: ${e.message}\n`);
}
// Always dismisses as "accepted" after the try/catch
await dismissPrompt(config, prompt.workspaceId, "accepted");
```

**Impact**: A workspace with a failed install will never be prompted again. The user would need to manually run `fuel-code hooks install --git-only` to recover.

**Fix**: Move the dismiss call inside the try block, or dismiss as `"declined"` in the catch block to allow re-prompting on next session.start.

---

### Issue #6: Per-Repo Hook Status Not Detected

**Severity**: Low
**Location**: `packages/cli/src/lib/git-hook-status.ts`

`getGitHookStatus()` only checks the global `core.hooksPath`. Hooks installed via `--per-repo` (into `.git/hooks/`) are not detected. This means:
- `fuel-code hooks status` shows "not installed" for per-repo installs.
- The auto-prompt system may re-prompt for workspaces with per-repo hooks.
- `showGitHooksPrompt` won't auto-dismiss for per-repo installs.

**Impact**: Users who choose per-repo installs get a degraded experience with phantom prompts.

**Fix**: Extend `getGitHookStatus()` to also check `$(git rev-parse --git-dir)/hooks/` for fuel-code markers when global hooks aren't detected.

---

### Issue #7: No LIMIT on Orphan Git Activity in Timeline

**Severity**: Medium
**Location**: `packages/server/src/routes/timeline.ts`

The session query respects the `limit` parameter for pagination, but the orphan git_activity query has no limit:

```sql
SELECT * FROM git_activity WHERE session_id IS NULL
  AND workspace_id = ${...} AND timestamp BETWEEN ...
```

The orphan time range is derived from the session page's timestamp span, which could be wide. A workspace with many orphan commits (e.g., commits made without Claude Code running) could produce an unbounded response.

**Impact**: Performance degradation for workspaces with heavy standalone git activity. The response payload could be very large.

**Fix**: Apply a reasonable limit to the orphan query (e.g., 100 orphan events per page) or include orphan events in the pagination cursor.

---

### Issue #8: No `device_id` Index on `git_activity`

**Severity**: Low
**Location**: `packages/server/src/db/migrations/003_create_git_activity.sql`

The timeline endpoint's orphan query filters `WHERE session_id IS NULL AND workspace_id = X AND device_id = X AND timestamp BETWEEN ...`. The migration has indexes on `(workspace_id)`, `(session_id)`, `(timestamp)`, `(type)`, and `(workspace_id, timestamp)`, but none covering `device_id`.

**Impact**: No issue at current scale. Could cause slow scans if git_activity grows large with many devices per workspace.

**Fix**: Add `CREATE INDEX idx_git_activity_device ON git_activity (device_id)` or extend the composite index to `(workspace_id, device_id, timestamp DESC)`.

---

### Issue #9: No Runtime Validation of `event.data` in Git Handlers

**Severity**: Low
**Location**: All 4 git handler files in `packages/core/src/handlers/`

All handlers extract fields from `event.data` using TypeScript `as` casts with no runtime validation:

```typescript
const hash = event.data.hash as string;
const filesChanged = event.data.files_changed as number;
```

Zod schemas exist in `packages/shared/` and are registered in the payload registry, but `processEvent` does not currently validate payloads before dispatching to handlers. A malformed payload would cause a Postgres type error at INSERT time.

**Impact**: The error is caught by `processEvent`'s handler error handling, so it doesn't crash the server. But the error message is a cryptic Postgres type error rather than a descriptive validation failure.

**Fix**: Add `validateEventPayload()` call in `processEvent` before handler dispatch. The infrastructure already exists — it just needs to be wired in.

---

### Issue #10: Dual Implementation of Workspace Normalization

**Severity**: Medium (long-term maintenance risk)
**Location**: `packages/hooks/git/resolve-workspace.sh` and `packages/shared/src/canonical.ts`

The same URL normalization logic exists in two languages:
- Bash: `resolve-workspace.sh` (SSH regex, HTTPS parsing, host lowercasing, `.git` stripping)
- TypeScript: `normalizeGitRemote()` in `canonical.ts`

Any drift between these implementations would cause workspace ID mismatches — git events emitted by hooks would reference a different workspace than the one resolved by the backend. The review fix (49e7ce3) already caught and fixed one such drift (host lowercasing).

**Impact**: Future changes to either implementation without updating the other would silently break git-session correlation.

**Fix**: Add a cross-language integration test that feeds the same set of URLs to both implementations and asserts identical output. Or generate the bash logic from the TS source at build time.

---

## Design Patterns Assessment

### Positive Patterns

1. **Three-Layer Idempotency**: Event dedup at `processEvent` → `ON CONFLICT DO NOTHING` at handler → `WHERE session_id IS NULL` guard on correlation. Belt, suspenders, and duct tape.

2. **Transaction Wrapping in Handlers**: All git handlers wrap INSERT + UPDATE in `sql.begin()`. The correlation query is intentionally outside the transaction (read-only, doesn't need isolation with writes). Correct design.

3. **Fire-and-Forget with Safety**: Every hook script backgrounds the emit and exits 0 unconditionally. The `pre-push` hook correctly reads stdin upfront (git hangs if stdin isn't consumed) and respects user hook exit codes for the gating case.

4. **Consistent Hook Structure**: All 4 hooks follow identical patterns — chain → guard → resolve → extract → emit. Easy to audit and extend.

5. **Non-Blocking Prompt System**: 2-second timeout, silent failure on every error path, never prevents CLI usage. The preAction hook only fires on interactive commands.

6. **postgres.js Tagged Templates Throughout**: Zero SQL injection risk in the server codebase. Dynamic WHERE clauses in timeline.ts are composed via `sql` fragments, not string concatenation.

7. **Test Override Functions**: The installer's `overrideHooksDir`/`overrideBackupDir`/`overrideGitConfigFile`/`overrideHomeDir` pattern cleanly isolates tests from the real filesystem and git config. No mocking of `fs` needed.

### Patterns to Watch

1. **Orphan Events as First-Class Data**: Orphan git events (no active session) are stored and served via the timeline API. This is good design — git activity without Claude Code running is still valuable. But the orphan query path is less optimized than the session-correlated path (no index on device_id, no pagination).

2. **Cursor Duplication**: `encodeCursor`/`decodeCursor` are copy-pasted between `sessions.ts` and `timeline.ts`. Should be extracted to a shared utility.

3. **`any` Types in Route Handlers**: `sessionRows`, `sessionGitActivity`, `orphanRows` in timeline.ts are typed as `any`. This is common with postgres.js but loses compile-time safety for response shape.

4. **checkGitHooksPrompt Not Transactional with Session Insert**: The session INSERT commits independently. If the prompt check fails, the handler is recorded as failed but the session row exists. On replay, the event is deduplicated and the prompt check never re-runs. This is acceptable (prompt is best-effort) but means a transient error permanently skips the prompt for that workspace.

---

## Test Coverage Assessment

| Module | Files | Tests | Strategy |
|--------|-------|-------|----------|
| Hook scripts (bash) | 2 | ~23 | Real git repos + mock CLI binary |
| Git correlator | 1 | 8 | Mock SQL |
| Git handlers (4) | 1 | 18 | Mock SQL + mock transactions |
| Session-start prompt | 1 | 7 | Mock SQL (call count verification) |
| Hook installer | 1 | 11 | Real filesystem in temp dirs |
| Hooks CLI commands | 1 | 17 | Real filesystem + console capture |
| Prompt checker | 1 | 7 | Real HTTP servers on random ports |
| Timeline route | 1 | 15 | Fragment-aware mock SQL |
| Prompts route | 1 | 8 | Fragment-aware mock SQL |
| E2E integration | 1 | 13 | Real Postgres + Redis + Express |
| Pre-existing test fixes | 3 | updated | Schema example changes |
| **Total** | **15** | **~127** | |

### Test Gaps

1. **No schema validation rejection tests**: Zod schemas define constraints (`min(0)`, required fields) but no test feeds invalid payloads to verify rejection. The schemas are exercised only with valid data.

2. **No handler error-path tests**: SQL failures, transaction rollbacks, and malformed `event.data` are not tested in handler unit tests.

3. **No merge-with-conflicts test**: `post-merge` hook test only exercises conflict-free merges. The `had_conflicts: true` path (`.git/MERGE_MSG` contains `Conflicts:` line) is untested.

4. **No `pre-push` multi-ref test**: The `pre-push` loop handles multiple pushed refs, but tests only push a single branch.

5. **No timeline combined-filter tests**: Individual filters (workspace_id, types, after, before) are tested separately but not in combination.

6. **No cross-language normalization test**: `resolve-workspace.sh` and `normalizeGitRemote()` are not tested together for output consistency.

---

## Summary of Findings

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| 1 | Branch names not JSON-escaped in hooks | Low | Add python3 escaping |
| 2 | MERGE_HEAD may not exist in post-merge | Low | Document as known limitation |
| 3 | `shasum` not portable to Linux | Low | Fallback to `sha256sum` |
| 4 | `python3` dependency silently degrades | Low | Document as known limitation |
| 5 | Prompt dismissed as "accepted" on install failure | **Medium** | **Fix**: dismiss as "declined" in catch block |
| 6 | Per-repo hook status not detected | Low | Extend status check to `.git/hooks/` |
| 7 | No LIMIT on orphan git activity | **Medium** | **Fix**: add limit to orphan query |
| 8 | No device_id index on git_activity | Low | Add index when scaling |
| 9 | No runtime validation in git handlers | Low | Wire in `validateEventPayload()` |
| 10 | Dual workspace normalization implementations | **Medium** | Add cross-language test |

**Overall Verdict**: Phase 3 is well-executed. The hook scripts are robust (real-world portability was addressed in review fixes), the handler architecture is clean with excellent idempotency guarantees, and the timeline API is well-designed with safe SQL throughout. The auto-prompt system is thoughtfully non-blocking. The two medium-severity issues (#5 prompt dismiss bug, #7 orphan query unbounded) should be fixed before production use. Issue #10 (dual normalization) is a maintenance risk that a cross-language test would mitigate. The remaining issues are low-severity edge cases or future-proofing concerns.
