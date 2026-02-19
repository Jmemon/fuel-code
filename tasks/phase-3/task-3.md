# Task 3: Git Event Handlers + git_activity Table + Zod Schemas

## Parallel Group: A

## Description

Create the `git_activity` database table (migration), define Zod payload schemas for all 4 git event types, implement event handlers for `git.commit`, `git.push`, `git.checkout`, and `git.merge` that populate the table and correlate git events with active Claude Code sessions. Register all handlers and payload schemas in the existing registries from Phase 1.

> **IMPORTANT (Phase 1 Correction):** Phase 1 did NOT create a `git_activity` table. The initial migration (`001_initial.sql`) only created: `workspaces`, `devices`, `workspace_devices`, `sessions`, `events`. This task MUST create the `git_activity` table via a new migration before the handlers can work.

> **IMPORTANT (Phase 1 Correction):** Phase 1 only created Zod payload schemas for `session.start` and `session.end`. This task MUST create Zod payload schemas for `git.commit`, `git.push`, `git.checkout`, `git.merge` and register them in `packages/shared/src/schemas/payload-registry.ts`.

### Database Migration

**Create `packages/server/src/db/migrations/NNN_create_git_activity.sql`** (use next sequential number):

```sql
-- git_activity: Stores processed git events with session correlation.
-- Populated by git event handlers (git.commit, git.push, git.checkout, git.merge).
-- session_id is nullable: git events outside an active CC session are "orphan" workspace-level activity.

CREATE TABLE git_activity (
  id TEXT PRIMARY KEY,                            -- same ULID as the event
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  session_id TEXT REFERENCES sessions(id),        -- nullable: orphan git events have NULL
  type TEXT NOT NULL CHECK (type IN ('commit', 'push', 'checkout', 'merge')),
  branch TEXT,
  commit_sha TEXT,
  message TEXT,
  files_changed INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_git_activity_workspace ON git_activity(workspace_id);
CREATE INDEX idx_git_activity_session ON git_activity(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_git_activity_timestamp ON git_activity(timestamp DESC);
CREATE INDEX idx_git_activity_type ON git_activity(type);
CREATE INDEX idx_git_activity_workspace_time ON git_activity(workspace_id, timestamp DESC);
```

### Git Event Payload Zod Schemas

**Create `packages/shared/src/schemas/git-commit.ts`**:

```typescript
import { z } from 'zod';

export const gitCommitPayloadSchema = z.object({
  hash: z.string(),
  message: z.string(),
  author_name: z.string(),
  author_email: z.string().optional(),
  branch: z.string(),
  files_changed: z.number().int().min(0),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  file_list: z.array(z.object({
    path: z.string(),
    status: z.string(),
  })).optional(),
});

export type GitCommitPayload = z.infer<typeof gitCommitPayloadSchema>;
```

**Create `packages/shared/src/schemas/git-push.ts`**:

```typescript
import { z } from 'zod';

export const gitPushPayloadSchema = z.object({
  branch: z.string(),
  remote: z.string(),
  commit_count: z.number().int().min(0),
  commits: z.array(z.string()).optional(),
});

export type GitPushPayload = z.infer<typeof gitPushPayloadSchema>;
```

**Create `packages/shared/src/schemas/git-checkout.ts`**:

```typescript
import { z } from 'zod';

export const gitCheckoutPayloadSchema = z.object({
  from_ref: z.string(),
  to_ref: z.string(),
  from_branch: z.string().nullable(),
  to_branch: z.string().nullable(),
});

export type GitCheckoutPayload = z.infer<typeof gitCheckoutPayloadSchema>;
```

**Create `packages/shared/src/schemas/git-merge.ts`**:

```typescript
import { z } from 'zod';

export const gitMergePayloadSchema = z.object({
  merge_commit: z.string(),
  message: z.string(),
  merged_branch: z.string(),
  into_branch: z.string(),
  files_changed: z.number().int().min(0),
  had_conflicts: z.boolean(),
});

export type GitMergePayload = z.infer<typeof gitMergePayloadSchema>;
```

**Modify `packages/shared/src/schemas/payload-registry.ts`**: Register the 4 new schemas:

```typescript
import { gitCommitPayloadSchema } from './git-commit';
import { gitPushPayloadSchema } from './git-push';
import { gitCheckoutPayloadSchema } from './git-checkout';
import { gitMergePayloadSchema } from './git-merge';

// In the registry initialization:
registry.set('git.commit', gitCommitPayloadSchema);
registry.set('git.push', gitPushPayloadSchema);
registry.set('git.checkout', gitCheckoutPayloadSchema);
registry.set('git.merge', gitMergePayloadSchema);
```

### Session-Git Correlation

**`packages/core/src/git-correlator.ts`**:

```typescript
// Find the active CC session for a git event.
// Correlation heuristic: find the most recently started session
// for the same workspace + device that is currently active (detected or capturing).
// Sessions stay at 'detected' from session.start until session.end — 'capturing'
// may be introduced later as a refinement for active-work detection.
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
  AND lifecycle IN ('detected', 'capturing')
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

1. Active session (`detected` or `capturing`) exists for (workspace, device): returns session ID.
2. No active session: returns `{ sessionId: null }`.
3. Session exists but lifecycle is `ended` (not active): returns null.
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
- `packages/server/src/db/migrations/NNN_create_git_activity.sql` (create — git_activity table migration)
- `packages/shared/src/schemas/git-commit.ts` (create — Zod payload schema)
- `packages/shared/src/schemas/git-push.ts` (create — Zod payload schema)
- `packages/shared/src/schemas/git-checkout.ts` (create — Zod payload schema)
- `packages/shared/src/schemas/git-merge.ts` (create — Zod payload schema)
- `packages/shared/src/schemas/payload-registry.ts` (modify — register 4 git schemas)
- `packages/shared/src/index.ts` (modify — re-export git schemas)
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
1. **Migration creates `git_activity` table** with all columns (id, workspace_id, device_id, session_id, type, branch, commit_sha, message, files_changed, insertions, deletions, timestamp, data) and indexes.
2. **Zod payload schemas exist** for `git.commit`, `git.push`, `git.checkout`, `git.merge` in `packages/shared/src/schemas/`.
3. **Payload schemas registered** in `payload-registry.ts` — events with these types now get payload validation at ingest.
4. All 4 git event types have handlers registered in the handler registry.
5. `handleGitCommit` inserts into `git_activity` with type='commit', correct commit_sha, branch, message, files_changed, insertions, deletions.
6. `handleGitPush` inserts with type='push', branch, and data containing remote, commit_count, commits.
7. `handleGitCheckout` inserts with type='checkout', branch set to `to_branch` (or `to_ref` for detached HEAD).
8. `handleGitMerge` inserts with type='merge', merge_commit, into_branch, files_changed, and data containing merged_branch, had_conflicts.
9. Session-git correlation works: active session (`detected` or `capturing`) for same (workspace, device) is found and linked.
10. Git events without an active session get `session_id = NULL` (no error).
11. `events.session_id` is updated when correlation is found.
12. Duplicate event IDs are handled gracefully (`ON CONFLICT DO NOTHING`).
13. `createHandlerRegistry()` returns registry with `session.start`, `session.end`, `git.commit`, `git.push`, `git.checkout`, `git.merge`.
