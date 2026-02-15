# Task 3: Git Event Handlers + git_activity Population

## Parallel Group: A

## Description

Implement event handlers for `git.commit`, `git.push`, `git.checkout`, and `git.merge` that populate the `git_activity` table and correlate git events with active Claude Code sessions. Register all handlers in the existing handler registry from Phase 1. This is the server-side counterpart to the hook scripts — hooks emit events, handlers process them.

### Session-Git Correlation

**`packages/core/src/git-correlator.ts`**:

```typescript
// Find the active CC session for a git event.
// Correlation heuristic: find the most recently started session
// for the same workspace + device that is currently capturing.
//
// This works because CC sessions and git commits happen on the same
// device in the same workspace. The lifecycle window is well-defined
// by session.start and session.end events.

interface CorrelationResult {
  sessionId: string | null;
  confidence: 'active' | 'none';
}

async function correlateGitEventToSession(
  sql: postgres.Sql,
  workspaceId: string,  // resolved ULID
  deviceId: string,     // resolved ULID
  eventTimestamp: Date
): Promise<CorrelationResult>
```

Query:
```sql
SELECT id FROM sessions
WHERE workspace_id = $1
  AND device_id = $2
  AND lifecycle = 'capturing'
  AND started_at <= $3
ORDER BY started_at DESC
LIMIT 1
```

- If found: return `{ sessionId: row.id, confidence: 'active' }`
- If not found: return `{ sessionId: null, confidence: 'none' }`

**Design note**: CORE.md explicitly defines this as a heuristic. If no active session exists, the git event is workspace-level activity with `session_id = NULL`. This is expected for commits made outside CC sessions (e.g., from terminal).

### Event Handlers

All handlers follow the same pattern established by Phase 1's `handleSessionStart` and `handleSessionEnd`. They receive `EventHandlerContext` and populate `git_activity`.

**`packages/core/src/handlers/git-commit.ts`**:

```typescript
async function handleGitCommit(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;
  const data = event.data as GitCommitPayload;

  // Correlate with active session
  const correlation = await correlateGitEventToSession(
    sql, workspaceId, event.device_id, new Date(event.timestamp)
  );

  // Insert into git_activity
  await sql`
    INSERT INTO git_activity (
      id, workspace_id, device_id, session_id, type,
      branch, commit_sha, message, files_changed, insertions, deletions,
      timestamp, data
    ) VALUES (
      ${event.id}, ${workspaceId}, ${event.device_id}, ${correlation.sessionId},
      'commit',
      ${data.branch}, ${data.hash}, ${data.message},
      ${data.files_changed}, ${data.insertions}, ${data.deletions},
      ${event.timestamp},
      ${JSON.stringify({
        author_name: data.author_name,
        author_email: data.author_email,
        file_list: data.file_list
      })}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  // Also set session_id on the event itself (for event-level queries)
  if (correlation.sessionId) {
    await sql`
      UPDATE events SET session_id = ${correlation.sessionId}
      WHERE id = ${event.id} AND session_id IS NULL
    `;
  }

  logger.info({
    commitSha: data.hash.slice(0, 7),
    branch: data.branch,
    sessionId: correlation.sessionId,
    filesChanged: data.files_changed
  }, 'Git commit processed');
}
```

**`packages/core/src/handlers/git-push.ts`**:

```typescript
async function handleGitPush(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;
  const data = event.data as GitPushPayload;

  const correlation = await correlateGitEventToSession(
    sql, workspaceId, event.device_id, new Date(event.timestamp)
  );

  await sql`
    INSERT INTO git_activity (
      id, workspace_id, device_id, session_id, type,
      branch, timestamp, data
    ) VALUES (
      ${event.id}, ${workspaceId}, ${event.device_id}, ${correlation.sessionId},
      'push',
      ${data.branch},
      ${event.timestamp},
      ${JSON.stringify({
        remote: data.remote,
        commit_count: data.commit_count,
        commits: data.commits
      })}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  if (correlation.sessionId) {
    await sql`
      UPDATE events SET session_id = ${correlation.sessionId}
      WHERE id = ${event.id} AND session_id IS NULL
    `;
  }

  logger.info({
    branch: data.branch,
    remote: data.remote,
    commitCount: data.commit_count,
    sessionId: correlation.sessionId
  }, 'Git push processed');
}
```

**`packages/core/src/handlers/git-checkout.ts`**:

```typescript
async function handleGitCheckout(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;
  const data = event.data as GitCheckoutPayload;

  const correlation = await correlateGitEventToSession(
    sql, workspaceId, event.device_id, new Date(event.timestamp)
  );

  await sql`
    INSERT INTO git_activity (
      id, workspace_id, device_id, session_id, type,
      branch, timestamp, data
    ) VALUES (
      ${event.id}, ${workspaceId}, ${event.device_id}, ${correlation.sessionId},
      'checkout',
      ${data.to_branch || data.to_ref},
      ${event.timestamp},
      ${JSON.stringify({
        from_ref: data.from_ref,
        to_ref: data.to_ref,
        from_branch: data.from_branch,
        to_branch: data.to_branch
      })}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  if (correlation.sessionId) {
    await sql`
      UPDATE events SET session_id = ${correlation.sessionId}
      WHERE id = ${event.id} AND session_id IS NULL
    `;
  }

  logger.info({
    fromBranch: data.from_branch,
    toBranch: data.to_branch,
    sessionId: correlation.sessionId
  }, 'Git checkout processed');
}
```

**`packages/core/src/handlers/git-merge.ts`**:

```typescript
async function handleGitMerge(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;
  const data = event.data as GitMergePayload;

  const correlation = await correlateGitEventToSession(
    sql, workspaceId, event.device_id, new Date(event.timestamp)
  );

  await sql`
    INSERT INTO git_activity (
      id, workspace_id, device_id, session_id, type,
      branch, commit_sha, message, files_changed, timestamp, data
    ) VALUES (
      ${event.id}, ${workspaceId}, ${event.device_id}, ${correlation.sessionId},
      'merge',
      ${data.into_branch}, ${data.merge_commit}, ${data.message},
      ${data.files_changed},
      ${event.timestamp},
      ${JSON.stringify({
        merged_branch: data.merged_branch,
        had_conflicts: data.had_conflicts
      })}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  if (correlation.sessionId) {
    await sql`
      UPDATE events SET session_id = ${correlation.sessionId}
      WHERE id = ${event.id} AND session_id IS NULL
    `;
  }

  logger.info({
    mergedBranch: data.merged_branch,
    intoBranch: data.into_branch,
    hadConflicts: data.had_conflicts,
    sessionId: correlation.sessionId
  }, 'Git merge processed');
}
```

### Handler Registration

**Modify `packages/core/src/handlers/index.ts`**:

```typescript
import { handleGitCommit } from './git-commit';
import { handleGitPush } from './git-push';
import { handleGitCheckout } from './git-checkout';
import { handleGitMerge } from './git-merge';

export function createHandlerRegistry(): EventHandlerRegistry {
  const registry = new EventHandlerRegistry();

  // Phase 1 handlers
  registry.register('session.start', handleSessionStart);
  registry.register('session.end', handleSessionEnd);

  // Phase 3 git handlers
  registry.register('git.commit', handleGitCommit);
  registry.register('git.push', handleGitPush);
  registry.register('git.checkout', handleGitCheckout);
  registry.register('git.merge', handleGitMerge);

  return registry;
}
```

### Tests

**`packages/core/src/__tests__/git-correlator.test.ts`** (requires Postgres):

1. Active `capturing` session exists for (workspace, device): returns session ID.
2. No active session: returns `{ sessionId: null }`.
3. Session exists but lifecycle is `ended` (not capturing): returns null.
4. Session exists but for different workspace: returns null.
5. Session exists but for different device: returns null.
6. Multiple active sessions (edge case): returns most recently started.
7. Event timestamp before session started_at: returns null (session hadn't started yet).

**`packages/core/src/__tests__/git-handlers.test.ts`** (requires Postgres):

1. `handleGitCommit`: inserts into git_activity with correct fields (branch, sha, message, stats).
2. `handleGitCommit` with active session: sets `session_id` on both `git_activity` and `events`.
3. `handleGitCommit` without active session: `session_id` is NULL, no error.
4. `handleGitCommit` duplicate event ID: `ON CONFLICT DO NOTHING`, no error.
5. `handleGitPush`: inserts with type='push', branch, data contains remote and commits.
6. `handleGitCheckout`: inserts with type='checkout', branch set to `to_branch`.
7. `handleGitCheckout` with detached HEAD (`to_branch` is null): branch set to `to_ref`.
8. `handleGitMerge`: inserts with type='merge', commit_sha, message, files_changed, data has had_conflicts.
9. All handlers: `ON CONFLICT (id) DO NOTHING` prevents duplicates.
10. All handlers: event.session_id updated only when correlation found AND session_id was previously NULL.
11. Handler registration: `registry.listRegisteredTypes()` includes all 4 git types.

## Relevant Files
- `packages/core/src/git-correlator.ts` (create)
- `packages/core/src/handlers/git-commit.ts` (create)
- `packages/core/src/handlers/git-push.ts` (create)
- `packages/core/src/handlers/git-checkout.ts` (create)
- `packages/core/src/handlers/git-merge.ts` (create)
- `packages/core/src/handlers/index.ts` (modify — register git handlers)
- `packages/core/src/index.ts` (modify — re-export git-correlator)
- `packages/core/src/__tests__/git-correlator.test.ts` (create)
- `packages/core/src/__tests__/git-handlers.test.ts` (create)

## Success Criteria
1. All 4 git event types have handlers registered in the handler registry.
2. `handleGitCommit` inserts into `git_activity` with type='commit', correct commit_sha, branch, message, files_changed, insertions, deletions.
3. `handleGitPush` inserts with type='push', branch, and data containing remote, commit_count, commits.
4. `handleGitCheckout` inserts with type='checkout', branch set to `to_branch` (or `to_ref` for detached HEAD).
5. `handleGitMerge` inserts with type='merge', merge_commit, into_branch, files_changed, and data containing merged_branch, had_conflicts.
6. Session-git correlation works: active `capturing` session for same (workspace, device) is found and linked.
7. Git events without an active session get `session_id = NULL` (no error).
8. `events.session_id` is updated when correlation is found.
9. Duplicate event IDs are handled gracefully (`ON CONFLICT DO NOTHING`).
10. `createHandlerRegistry()` returns registry with `session.start`, `session.end`, `git.commit`, `git.push`, `git.checkout`, `git.merge`.
