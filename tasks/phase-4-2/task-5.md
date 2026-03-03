# Task 5: Git Hook Worktree Detection

## Parallel Group: B

## Dependencies: Task 1 (migration adds columns to git_activity)

## Description

Add worktree detection to all 4 git hooks and update the corresponding 4 git event handlers to store worktree context in `git_activity` rows.

### Git Hook Changes

Add the following worktree detection block to all 4 hook scripts (`packages/hooks/git/post-commit`, `pre-push`, `post-checkout`, `post-merge`):

```bash
# Worktree detection
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
IS_WORKTREE=false
WORKTREE_NAME=""
if [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  IS_WORKTREE=true
  WORKTREE_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
fi
```

Include in the JSON payload passed to `fuel-code emit`:
```json
{
  "is_worktree": true,
  "worktree_name": "agent-a3067cc4"
}
```

When not in a worktree: `is_worktree: false, worktree_name: null` (or omit both).

**Placement**: Add the detection block near the top of each hook (after the existing workspace resolution), and include the fields in the JSON data object that gets passed to `fuel-code emit`.

### Git Event Handler Changes

Update all 4 handlers in `packages/core/src/handlers/`:
- `git-commit.ts`
- `git-push.ts`
- `git-checkout.ts`
- `git-merge.ts`

Each handler already INSERTs into `git_activity`. Add `is_worktree` and `worktree_name` to the INSERT statement:

```typescript
// Extract from event data (with defaults for backward compat)
const isWorktree = event.data.is_worktree ?? false;
const worktreeName = event.data.worktree_name ?? null;

// Add to INSERT
await sql`
  INSERT INTO git_activity (...)
  VALUES (..., ${isWorktree}, ${worktreeName})
`;
```

### Why This Matters

- `post-checkout` fires when `git worktree add` runs (git does a checkout as part of worktree creation). This gives a git-level signal of worktree creation even without the CC WorktreeCreate hook.
- `post-commit` from a worktree means a sub-agent committed in isolation. The `worktree_name` follows the pattern `agent-<agentId>`, enabling correlation with the subagents table.
- All git activity inside worktrees is now visible and tagged in the session detail view.

### Backward Compatibility

Old events without `is_worktree`/`worktree_name` in their data payload will have these columns default to `false`/`null` in the handler (via the `?? false` / `?? null` defaults). No migration of existing data needed.

## Relevant Files
- Modify: `packages/hooks/git/post-commit`
- Modify: `packages/hooks/git/pre-push`
- Modify: `packages/hooks/git/post-checkout`
- Modify: `packages/hooks/git/post-merge`
- Modify: `packages/core/src/handlers/git-commit.ts`
- Modify: `packages/core/src/handlers/git-push.ts`
- Modify: `packages/core/src/handlers/git-checkout.ts`
- Modify: `packages/core/src/handlers/git-merge.ts`

## Success Criteria
1. A commit inside a git worktree produces `is_worktree: true` and correct `worktree_name` in the event payload.
2. A commit in the main working tree produces `is_worktree: false`.
3. `git_activity` rows have correct `is_worktree` and `worktree_name` values.
4. All 4 hooks work in both worktree and non-worktree contexts.
5. Hooks still exit 0 on any failure (worktree detection failure is swallowed).
6. Old events without worktree fields are handled gracefully (defaults applied).
7. Existing git hook tests pass.
8. Existing git handler tests pass.
