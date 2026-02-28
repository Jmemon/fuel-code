# Task 4: Auto-Prompt for Git Hook Installation

## Parallel Group: C

## Dependencies: Tasks 2, 3

## Description

When a `session.start` event is processed for a workspace that is a git repo but doesn't have git hooks installed on that device, record the need for a prompt. The next time the user runs `fuel-code` interactively, they're prompted: "Install git tracking for \<workspace\>?" This ensures users discover git tracking naturally through their workflow.

### Server-Side: Detect and Record Prompt Need

**Modify `packages/core/src/handlers/session-start.ts`**:

After creating the session record (existing Phase 1 logic), add git hook detection:

```typescript
async function handleSessionStart(ctx: EventHandlerContext): Promise<void> {
  // ... existing session creation logic (Phase 1) ...

  // Phase 3: Check if git hooks should be suggested
  await checkGitHooksPrompt(ctx);
}

async function checkGitHooksPrompt(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Only prompt for workspaces that look like git repos
  // (canonical IDs with "/" are from git remotes, "local:" are local repos)
  const workspace = await sql`
    SELECT canonical_id FROM workspaces WHERE id = ${workspaceId}
  `;
  if (!workspace[0]) return;
  const canonicalId = workspace[0].canonical_id;
  if (canonicalId === '_unassociated') return;

  // Check if git hooks already installed for this workspace+device
  const wd = await sql`
    SELECT git_hooks_installed, git_hooks_prompted
    FROM workspace_devices
    WHERE workspace_id = ${workspaceId} AND device_id = ${event.device_id}
  `;

  if (!wd[0]) return; // workspace_devices row should exist (created by event processor)
  if (wd[0].git_hooks_installed) return; // already installed
  if (wd[0].git_hooks_prompted) return;  // already prompted (user declined)

  // Record that we should prompt
  await sql`
    UPDATE workspace_devices
    SET pending_git_hooks_prompt = true, updated_at = now()
    WHERE workspace_id = ${workspaceId} AND device_id = ${event.device_id}
  `;

  logger.debug({ workspaceId, deviceId: event.device_id }, 'Flagged workspace for git hooks prompt');
}
```

### Database: Add Prompt Tracking Columns

**`packages/server/src/migrations/NNNN_add_git_hooks_prompt_columns.sql`**:

```sql
-- Track git hook prompt state per workspace-device pair.
-- pending_git_hooks_prompt: true when we should prompt user next interactive session.
-- git_hooks_prompted: true after user has been prompted (regardless of answer).
-- This prevents repeated prompting.

ALTER TABLE workspace_devices
ADD COLUMN IF NOT EXISTS pending_git_hooks_prompt BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workspace_devices
ADD COLUMN IF NOT EXISTS git_hooks_prompted BOOLEAN NOT NULL DEFAULT false;
```

### Server-Side: API for Prompt State

**Add to `packages/server/src/routes/sessions.ts`** (or create `packages/server/src/routes/prompts.ts`):

**`GET /api/prompts/pending`**:

Returns pending prompts for the calling device.

```sql
SELECT wd.workspace_id, w.canonical_id, w.display_name, wd.device_id
FROM workspace_devices wd
JOIN workspaces w ON w.id = wd.workspace_id
WHERE wd.device_id = $1
  AND wd.pending_git_hooks_prompt = true
  AND wd.git_hooks_installed = false
  AND wd.git_hooks_prompted = false
```

Response:
```json
{
  "prompts": [
    {
      "type": "git_hooks_install",
      "workspace_id": "01ABC...",
      "workspace_name": "fuel-code",
      "workspace_canonical_id": "github.com/user/fuel-code"
    }
  ]
}
```

**`POST /api/prompts/dismiss`**:

Dismisses a prompt (user declined or accepted).

Request body:
```json
{
  "workspace_id": "01ABC...",
  "action": "accepted" | "declined"
}
```

Handler:
- If `accepted`: set `git_hooks_installed = true`, `pending_git_hooks_prompt = false`, `git_hooks_prompted = true`.
- If `declined`: set `pending_git_hooks_prompt = false`, `git_hooks_prompted = true`.

### CLI-Side: Check and Display Prompts

**`packages/cli/src/lib/prompt-checker.ts`**:

```typescript
// Check for pending prompts from the backend.
// Called at CLI startup for interactive commands.
// Non-interactive commands (emit, transcript upload) skip this.

interface PendingPrompt {
  type: 'git_hooks_install';
  workspaceId: string;
  workspaceName: string;
  workspaceCanonicalId: string;
}

async function checkPendingPrompts(config: FuelCodeConfig): Promise<PendingPrompt[]>
```

**Modify `packages/cli/src/index.ts`**:

At CLI startup, before running the user's command, check for prompts:

```typescript
// Only check prompts for interactive commands (not emit, not transcript upload, not --help)
const interactiveCommands = ['sessions', 'session', 'timeline', 'workspaces', 'status', 'hooks', 'backfill'];
const isInteractive = interactiveCommands.includes(command);

if (isInteractive) {
  const prompts = await checkPendingPrompts(config);
  for (const prompt of prompts) {
    if (prompt.type === 'git_hooks_install') {
      await showGitHooksPrompt(prompt, config);
    }
  }
}
```

**`packages/cli/src/lib/git-hooks-prompt.ts`**:

```typescript
async function showGitHooksPrompt(
  prompt: PendingPrompt,
  config: FuelCodeConfig
): Promise<void> {
  // Check if already installed locally (user might have run `hooks install --git-only` manually)
  const status = await getGitHookStatus();
  if (status.installed && status.isFuelCode) {
    // Already installed, dismiss the prompt
    await dismissPrompt(config, prompt.workspaceId, 'accepted');
    return;
  }

  console.error(`\nGit tracking available for: ${prompt.workspaceName}`);
  console.error(`  Captures commits, pushes, checkouts, and merges.`);
  console.error(`  Install git tracking? (Y/n) `);

  // Read single character from stdin
  const answer = await readLine();
  const accepted = answer.trim().toLowerCase() !== 'n';

  if (accepted) {
    try {
      const result = await installGitHooks();
      console.error(`\n  Git hooks installed! (${result.installed.length} hooks)`);
      await dismissPrompt(config, prompt.workspaceId, 'accepted');
    } catch (err) {
      console.error(`\n  Failed to install git hooks: ${err.message}`);
      console.error(`  Run "fuel-code hooks install --git-only" manually.`);
      // Don't dismiss — will prompt again next time
    }
  } else {
    console.error(`\n  Skipped. Run "fuel-code hooks install --git-only" anytime.`);
    await dismissPrompt(config, prompt.workspaceId, 'declined');
  }
}
```

### Prompt Behavior Rules

1. **One prompt per workspace+device**: Once prompted (accepted or declined), don't ask again.
2. **Non-blocking**: If backend is unreachable, skip prompt check silently.
3. **Non-interactive commands skip prompts**: `emit`, `transcript upload`, `backfill`, `queue drain` never show prompts.
4. **Timeout**: If prompt check takes > 2 seconds, skip it. Don't slow down CLI startup.
5. **First-install experience**: After `fuel-code init`, if user hasn't installed git hooks, the first interactive command prompts.

### Tests

**`packages/core/src/__tests__/session-start-git-prompt.test.ts`** (requires Postgres):

1. session.start for git-repo workspace without git hooks: sets `pending_git_hooks_prompt = true`.
2. session.start for same workspace+device again: doesn't re-set (already pending).
3. session.start for `_unassociated` workspace: no prompt flag set.
4. session.start when `git_hooks_installed = true`: no prompt flag set.
5. session.start when `git_hooks_prompted = true` (user declined before): no prompt flag set.

**`packages/server/src/routes/__tests__/prompts.test.ts`** (requires Postgres):

1. `GET /api/prompts/pending` returns pending prompts for device.
2. `GET /api/prompts/pending` with no pending prompts: returns empty array.
3. `POST /api/prompts/dismiss` with `action: accepted`: sets git_hooks_installed, clears pending.
4. `POST /api/prompts/dismiss` with `action: declined`: clears pending, sets prompted.
5. Auth required on all endpoints.

**`packages/cli/src/lib/__tests__/prompt-checker.test.ts`**:

1. With pending prompts and mock API: returns prompt list.
2. With backend unreachable: returns empty array (no error).
3. With timeout (> 2s): returns empty array.

## Relevant Files
- `packages/core/src/handlers/session-start.ts` (modify — add git hooks prompt check)
- `packages/server/src/migrations/NNNN_add_git_hooks_prompt_columns.sql` (create)
- `packages/server/src/routes/prompts.ts` (create)
- `packages/server/src/app.ts` (modify — mount prompts router)
- `packages/cli/src/lib/prompt-checker.ts` (create)
- `packages/cli/src/lib/git-hooks-prompt.ts` (create)
- `packages/cli/src/index.ts` (modify — add prompt check at startup)
- `packages/core/src/__tests__/session-start-git-prompt.test.ts` (create)
- `packages/server/src/routes/__tests__/prompts.test.ts` (create)
- `packages/cli/src/lib/__tests__/prompt-checker.test.ts` (create)

## Success Criteria
1. `session.start` handler sets `pending_git_hooks_prompt = true` for git-repo workspaces without git hooks.
2. Non-git workspaces (`_unassociated`) never get prompted.
3. Already-installed workspaces never get prompted.
4. Already-prompted workspaces (user declined) never get re-prompted.
5. `GET /api/prompts/pending` returns pending prompts filtered by device.
6. `POST /api/prompts/dismiss` correctly updates state for both `accepted` and `declined`.
7. CLI checks for prompts on interactive commands only.
8. CLI skips prompt check for non-interactive commands (emit, transcript upload, etc.).
9. Prompt check has a 2-second timeout (doesn't slow CLI startup).
10. Backend unreachable: prompt check fails silently.
11. User accepting prompt triggers `installGitHooks()` and dismisses the prompt.
12. User declining prompt dismisses without installing (won't be asked again).
