# Task 1: Git Hook Script Templates

## Parallel Group: A

## Description

Create the 4 git hook bash scripts (post-commit, post-checkout, post-merge, pre-push) and the shared workspace resolution helper. These scripts extract git metadata, resolve workspace canonical ID, and call `fuel-code emit` in fire-and-forget mode. Every script must uphold the safety invariant: **never block git operations**.

### Shared Helper

**`packages/hooks/git/resolve-workspace.sh`**:

Resolves workspace canonical ID from the current repo's git remote URL. Same normalization logic as `normalizeGitRemote()` in `packages/shared/src/canonical.ts`, but in pure bash (no bun/node dependency).

```bash
#!/usr/bin/env bash
# resolve-workspace.sh
# Outputs workspace canonical ID to stdout.
# Exits 1 if no remote found (not a git repo, no origin remote, etc.)

REMOTE_URL=$(git remote get-url origin 2>/dev/null)

# No origin? Try first remote alphabetically.
if [ -z "$REMOTE_URL" ]; then
  FIRST_REMOTE=$(git remote 2>/dev/null | sort | head -1)
  if [ -n "$FIRST_REMOTE" ]; then
    REMOTE_URL=$(git remote get-url "$FIRST_REMOTE" 2>/dev/null)
  fi
fi

if [ -z "$REMOTE_URL" ]; then
  # No remote at all. Check if it's a git repo with commits (local-only repo).
  FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD 2>/dev/null | head -1)
  if [ -n "$FIRST_COMMIT" ]; then
    # local:<sha256 of first commit hash> — deterministic per repo
    echo "local:$(echo -n "$FIRST_COMMIT" | shasum -a 256 | cut -d' ' -f1)"
    exit 0
  fi
  # Not a git repo or empty repo
  exit 1
fi

# Normalize SSH: git@github.com:user/repo.git → github.com/user/repo
if [[ "$REMOTE_URL" =~ ^[a-zA-Z0-9._-]+@([^:]+):(.+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  PATH_PART="${BASH_REMATCH[2]}"
  # Strip .git suffix
  PATH_PART="${PATH_PART%.git}"
  echo "${HOST}/${PATH_PART}"
  exit 0
fi

# Normalize HTTPS: https://github.com/user/repo.git → github.com/user/repo
if [[ "$REMOTE_URL" =~ ^https?://([^/]+)/(.+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  PATH_PART="${BASH_REMATCH[2]}"
  PATH_PART="${PATH_PART%.git}"
  # Strip trailing slash
  PATH_PART="${PATH_PART%/}"
  echo "${HOST}/${PATH_PART}"
  exit 0
fi

# Unknown format — use as-is (e.g., file:// URLs)
echo "$REMOTE_URL"
exit 0
```

### Shared Opt-Out Check

Each hook script includes this check near the top:

```bash
# Per-repo opt-out: check .fuel-code/config.yaml in repo root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.fuel-code/config.yaml" ]; then
  if grep -q "git_enabled: false" "$REPO_ROOT/.fuel-code/config.yaml" 2>/dev/null; then
    exit 0
  fi
fi
```

### Files to Create

**`packages/hooks/git/post-commit`**:

```bash
#!/usr/bin/env bash
# fuel-code: post-commit hook
# Emits git.commit event with commit metadata.
# SAFETY: Always exits 0. Never blocks git. Fire-and-forget.

# Chain to user's existing hook if present
USER_HOOK="$(dirname "$0")/post-commit.user"
if [ -x "$USER_HOOK" ]; then
  "$USER_HOOK" "$@" || true
fi

# Check if fuel-code is available
if ! command -v fuel-code >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [post-commit] fuel-code binary not found in PATH" >> ~/.fuel-code/hook-errors.log 2>/dev/null
  exit 0
fi

# Per-repo opt-out
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.fuel-code/config.yaml" ]; then
  if grep -q "git_enabled: false" "$REPO_ROOT/.fuel-code/config.yaml" 2>/dev/null; then
    exit 0
  fi
fi

# Resolve workspace
WORKSPACE_ID=$("$(dirname "$0")/resolve-workspace.sh" 2>/dev/null)
if [ -z "$WORKSPACE_ID" ]; then
  exit 0
fi

# Extract commit metadata
HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
# Commit message: escape double quotes and collapse newlines for JSON
MESSAGE=$(git log -1 --pretty=%B HEAD 2>/dev/null | head -c 8192)
AUTHOR_NAME=$(git log -1 --pretty=%an HEAD 2>/dev/null || echo "unknown")
AUTHOR_EMAIL=$(git log -1 --pretty=%ae HEAD 2>/dev/null || echo "")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")

# Diff stats from the commit
INSERTIONS=0
DELETIONS=0
FILES_CHANGED=0

NUMSTAT=$(git diff-tree --no-commit-id --numstat -r HEAD 2>/dev/null)
if [ -n "$NUMSTAT" ]; then
  FILES_CHANGED=$(echo "$NUMSTAT" | wc -l | tr -d '[:space:]')
  # Sum insertions (col 1) and deletions (col 2). Binary files show "-", treat as 0.
  INSERTIONS=$(echo "$NUMSTAT" | awk '{if($1!="-") sum+=$1} END {print sum+0}')
  DELETIONS=$(echo "$NUMSTAT" | awk '{if($2!="-") sum+=$2} END {print sum+0}')
fi

# Build file list JSON array: [{"path":"file.txt","status":"M"}, ...]
FILE_LIST="["
FIRST=true
while IFS=$'\t' read -r status filepath; do
  [ -z "$status" ] && continue
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    FILE_LIST+=","
  fi
  FILE_LIST+="{\"path\":\"$filepath\",\"status\":\"$status\"}"
done < <(git diff-tree --no-commit-id --name-status -r HEAD 2>/dev/null)
FILE_LIST+="]"

# Emit event (fire-and-forget, background, no output)
# Use a heredoc piped to fuel-code emit --data-stdin to avoid shell escaping issues
(fuel-code emit git.commit \
  --workspace-id "$WORKSPACE_ID" \
  --data-stdin <<FUELCODE_EOF
{
  "hash": "$HASH",
  "message": $(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "author_name": $(printf '%s' "$AUTHOR_NAME" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "author_email": "$AUTHOR_EMAIL",
  "branch": "$BRANCH",
  "files_changed": $FILES_CHANGED,
  "insertions": $INSERTIONS,
  "deletions": $DELETIONS,
  "file_list": $FILE_LIST
}
FUELCODE_EOF
) 2>&1 | while read -r line; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [post-commit] $line" >> ~/.fuel-code/hook-errors.log 2>/dev/null
done &

exit 0
```

**Note on JSON escaping**: Commit messages can contain quotes, newlines, special characters. Using `python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'` is the safest portable way to JSON-escape a string in bash. Python3 is available on macOS and all common Linux distros. If python3 is missing, falls back to empty string.

**`packages/hooks/git/post-checkout`**:

```bash
#!/usr/bin/env bash
# fuel-code: post-checkout hook
# Emits git.checkout event on branch switches.
# Args: $1 = previous HEAD, $2 = new HEAD, $3 = branch flag (1=branch, 0=file)
# SAFETY: Always exits 0.

USER_HOOK="$(dirname "$0")/post-checkout.user"
if [ -x "$USER_HOOK" ]; then
  "$USER_HOOK" "$@" || true
fi

if ! command -v fuel-code >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [post-checkout] fuel-code binary not found in PATH" >> ~/.fuel-code/hook-errors.log 2>/dev/null
  exit 0
fi

# Only track branch checkouts, not file checkouts
if [ "${3:-0}" != "1" ]; then
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.fuel-code/config.yaml" ]; then
  if grep -q "git_enabled: false" "$REPO_ROOT/.fuel-code/config.yaml" 2>/dev/null; then
    exit 0
  fi
fi

WORKSPACE_ID=$("$(dirname "$0")/resolve-workspace.sh" 2>/dev/null)
if [ -z "$WORKSPACE_ID" ]; then
  exit 0
fi

FROM_REF="${1:-unknown}"
TO_REF="${2:-unknown}"

# Resolve branch names from refs
FROM_BRANCH=$(git name-rev --name-only "$FROM_REF" 2>/dev/null | sed 's|^remotes/[^/]*/||' || echo "")
TO_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Detached HEAD → null in JSON
FROM_BRANCH_JSON="null"
TO_BRANCH_JSON="null"
[ -n "$FROM_BRANCH" ] && [ "$FROM_BRANCH" != "undefined" ] && FROM_BRANCH_JSON="\"$FROM_BRANCH\""
[ -n "$TO_BRANCH" ] && [ "$TO_BRANCH" != "HEAD" ] && TO_BRANCH_JSON="\"$TO_BRANCH\""

(fuel-code emit git.checkout \
  --workspace-id "$WORKSPACE_ID" \
  --data-stdin <<FUELCODE_EOF
{
  "from_ref": "$FROM_REF",
  "to_ref": "$TO_REF",
  "from_branch": $FROM_BRANCH_JSON,
  "to_branch": $TO_BRANCH_JSON
}
FUELCODE_EOF
) 2>&1 | while read -r line; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [post-checkout] $line" >> ~/.fuel-code/hook-errors.log 2>/dev/null
done &

exit 0
```

**`packages/hooks/git/post-merge`**:

```bash
#!/usr/bin/env bash
# fuel-code: post-merge hook
# Emits git.merge event after merge completes.
# Args: $1 = squash flag (1 if squash merge, 0 otherwise)
# SAFETY: Always exits 0.

USER_HOOK="$(dirname "$0")/post-merge.user"
if [ -x "$USER_HOOK" ]; then
  "$USER_HOOK" "$@" || true
fi

if ! command -v fuel-code >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [post-merge] fuel-code binary not found in PATH" >> ~/.fuel-code/hook-errors.log 2>/dev/null
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.fuel-code/config.yaml" ]; then
  if grep -q "git_enabled: false" "$REPO_ROOT/.fuel-code/config.yaml" 2>/dev/null; then
    exit 0
  fi
fi

WORKSPACE_ID=$("$(dirname "$0")/resolve-workspace.sh" 2>/dev/null)
if [ -z "$WORKSPACE_ID" ]; then
  exit 0
fi

MERGE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
MESSAGE=$(git log -1 --pretty=%B HEAD 2>/dev/null | head -c 4096)
INTO_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")

# Determine merged branch: try MERGE_HEAD first, then parse commit message
MERGED_BRANCH="unknown"
if [ -f ".git/MERGE_HEAD" ]; then
  MERGE_HEAD=$(cat .git/MERGE_HEAD 2>/dev/null | head -1)
  if [ -n "$MERGE_HEAD" ]; then
    MERGED_BRANCH=$(git name-rev --name-only "$MERGE_HEAD" 2>/dev/null | sed 's|^remotes/[^/]*/||' || echo "unknown")
  fi
fi
# Fallback: parse "Merge branch 'feature'" from commit message
if [ "$MERGED_BRANCH" = "unknown" ]; then
  PARSED=$(echo "$MESSAGE" | grep -oP "Merge branch '\\K[^']+" 2>/dev/null || echo "")
  [ -n "$PARSED" ] && MERGED_BRANCH="$PARSED"
fi

# Diff stats: compare HEAD^1 to HEAD
FILES_CHANGED=0
PARENT=$(git rev-parse HEAD^1 2>/dev/null)
if [ -n "$PARENT" ]; then
  NUMSTAT=$(git diff --numstat "$PARENT" HEAD 2>/dev/null)
  if [ -n "$NUMSTAT" ]; then
    FILES_CHANGED=$(echo "$NUMSTAT" | wc -l | tr -d '[:space:]')
  fi
fi

# Conflict detection: check MERGE_MSG for "Conflicts:" section
HAD_CONFLICTS=false
if [ -f ".git/MERGE_MSG" ]; then
  if grep -q "^Conflicts:" ".git/MERGE_MSG" 2>/dev/null; then
    HAD_CONFLICTS=true
  fi
fi

(fuel-code emit git.merge \
  --workspace-id "$WORKSPACE_ID" \
  --data-stdin <<FUELCODE_EOF
{
  "merge_commit": "$MERGE_COMMIT",
  "message": $(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "merged_branch": "$MERGED_BRANCH",
  "into_branch": "$INTO_BRANCH",
  "files_changed": $FILES_CHANGED,
  "had_conflicts": $HAD_CONFLICTS
}
FUELCODE_EOF
) 2>&1 | while read -r line; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [post-merge] $line" >> ~/.fuel-code/hook-errors.log 2>/dev/null
done &

exit 0
```

**`packages/hooks/git/pre-push`**:

```bash
#!/usr/bin/env bash
# fuel-code: pre-push hook
# Emits git.push event before push executes.
# Args: $1 = remote name, $2 = remote URL
# Stdin: lines of "<local ref> <local sha> <remote ref> <remote sha>"
# SAFETY: Always exits 0. This is a PRE-push hook — exiting non-zero blocks the push.
#         fuel-code MUST NEVER prevent a push.

# IMPORTANT: Read all stdin first (git expects it to be consumed)
PUSH_REFS=""
while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
  PUSH_REFS+="${local_ref} ${local_sha} ${remote_ref} ${remote_sha}\n"
done

# Chain user hook — pipe stdin to it. User hook CAN block the push.
USER_HOOK="$(dirname "$0")/pre-push.user"
if [ -x "$USER_HOOK" ]; then
  # Re-feed the refs to the user hook
  printf '%b' "$PUSH_REFS" | "$USER_HOOK" "$@"
  USER_EXIT=$?
  if [ $USER_EXIT -ne 0 ]; then
    # User's hook blocked the push. Respect that. Don't emit event.
    exit $USER_EXIT
  fi
fi

if ! command -v fuel-code >/dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [pre-push] fuel-code binary not found in PATH" >> ~/.fuel-code/hook-errors.log 2>/dev/null
  exit 0
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.fuel-code/config.yaml" ]; then
  if grep -q "git_enabled: false" "$REPO_ROOT/.fuel-code/config.yaml" 2>/dev/null; then
    exit 0
  fi
fi

WORKSPACE_ID=$("$(dirname "$0")/resolve-workspace.sh" 2>/dev/null)
if [ -z "$WORKSPACE_ID" ]; then
  exit 0
fi

REMOTE_NAME="${1:-origin}"

# Process each pushed ref
printf '%b' "$PUSH_REFS" | while IFS=' ' read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$local_ref" ] && continue

  # Skip branch deletions (local_sha is all zeros)
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # Extract branch name from ref
  BRANCH="$local_ref"
  if [[ "$local_ref" =~ ^refs/heads/(.+)$ ]]; then
    BRANCH="${BASH_REMATCH[1]}"
  fi

  # Get commit list
  COMMIT_COUNT=0
  COMMITS_JSON="[]"
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch: count all commits (cap at 100 for sanity)
    COMMIT_LIST=$(git rev-list --max-count=100 "$local_sha" 2>/dev/null)
    COMMIT_COUNT=$(echo "$COMMIT_LIST" | grep -c . 2>/dev/null || echo 0)
  else
    # Existing branch: new commits only
    COMMIT_LIST=$(git rev-list --max-count=100 "$remote_sha..$local_sha" 2>/dev/null)
    COMMIT_COUNT=$(echo "$COMMIT_LIST" | grep -c . 2>/dev/null || echo 0)
  fi

  # Build commits JSON array
  if [ -n "$COMMIT_LIST" ]; then
    COMMITS_JSON="["
    FIRST=true
    while read -r sha; do
      [ -z "$sha" ] && continue
      if [ "$FIRST" = true ]; then
        FIRST=false
      else
        COMMITS_JSON+=","
      fi
      COMMITS_JSON+="\"$sha\""
    done <<< "$COMMIT_LIST"
    COMMITS_JSON+="]"
  fi

  (fuel-code emit git.push \
    --workspace-id "$WORKSPACE_ID" \
    --data-stdin <<FUELCODE_EOF
{
  "branch": "$BRANCH",
  "remote": "$REMOTE_NAME",
  "commit_count": $COMMIT_COUNT,
  "commits": $COMMITS_JSON
}
FUELCODE_EOF
  ) 2>&1 | while read -r line; do
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [pre-push] $line" >> ~/.fuel-code/hook-errors.log 2>/dev/null
  done &
done

exit 0
```

### CLI: `--data-stdin` and `--workspace-id` Flags for Emit Command

The hook scripts use `--data-stdin` to avoid shell escaping hell with commit messages containing quotes, backticks, etc., and `--workspace-id` to pass the resolved workspace canonical ID. Both require additions to the existing `fuel-code emit` command.

> **Note (Phase 1 context):** Phase 1's `fuel-code emit` command accepts `<event-type>` and `--data <json>` but does NOT have `--data-stdin` or `--workspace-id` flags. Phase 1's CC hooks resolve the workspace inside the TS helper and pass it in the event data payload. The git hooks (being pure bash) need these flags on the emit command itself.

**Modify `packages/cli/src/commands/emit.ts`**:

Add `--data-stdin` and `--workspace-id` options:
```typescript
// --workspace-id: Override the workspace canonical ID
// (normally resolved from config, but git hooks resolve it from the repo's remote URL)
.option('--workspace-id <id>', 'Workspace canonical ID')

// --data-stdin: Read JSON event data from stdin instead of --data argument
.option('--data-stdin', 'Read event data JSON from stdin')
```

```typescript
// If --data-stdin is set, read JSON from stdin instead of --data argument
if (opts.dataStdin) {
  const stdinText = await Bun.stdin.text();
  data = JSON.parse(stdinText);
} else if (opts.data) {
  data = JSON.parse(opts.data);
}

// If --workspace-id is set, include it in the event envelope
// so the server can resolve the workspace without needing the device's config
if (opts.workspaceId) {
  event.data.workspace_canonical_id = opts.workspaceId;
}
```

### Tests

**`packages/hooks/git/__tests__/resolve-workspace.test.ts`**:

Run the bash script in a test harness:
1. SSH remote `git@github.com:user/repo.git` → `github.com/user/repo`.
2. HTTPS remote `https://github.com/user/repo.git` → `github.com/user/repo`.
3. SSH without `.git` suffix → same canonical ID.
4. HTTPS without `.git` suffix → same canonical ID.
5. GitLab SSH `git@gitlab.com:org/project.git` → `gitlab.com/org/project`.
6. No remote but has commits → `local:<sha256>`.
7. No remote, no commits (empty repo) → exit 1.
8. Not a git repo → exit 1.
9. First remote fallback when `origin` doesn't exist.

**`packages/hooks/git/__tests__/hook-scripts.test.ts`**:

Create a temp git repo and verify hook outputs:
1. post-commit: after `git commit`, emitted event has correct hash, message, author, branch, file stats.
2. post-commit: multiline commit message is JSON-escaped correctly.
3. post-commit: binary files don't break numstat parsing.
4. post-checkout: branch switch emits event with correct from/to branches.
5. post-checkout: file checkout (`$3 = 0`) does NOT emit event.
6. post-checkout: detached HEAD → `to_branch` is null.
7. post-merge: after merge, emitted event has correct merged_branch and into_branch.
8. pre-push: reads stdin refs correctly, emits per-ref events.
9. pre-push: new branch push (remote_sha = 0000...) calculates commit count.
10. pre-push: branch deletion (local_sha = 0000...) is skipped.
11. All hooks: exit 0 when `fuel-code` binary not in PATH.
12. All hooks: exit 0 when opt-out config present.
13. All hooks: chain to `.user` hook when present.

**Test approach**: Use `Bun.spawn` to run bash scripts in a temp git repo. Mock `fuel-code emit` with a simple script that writes received args to a file for assertion. This avoids needing the real backend.

## Relevant Files
- `packages/hooks/git/resolve-workspace.sh` (create)
- `packages/hooks/git/post-commit` (create)
- `packages/hooks/git/post-checkout` (create)
- `packages/hooks/git/post-merge` (create)
- `packages/hooks/git/pre-push` (create)
- `packages/cli/src/commands/emit.ts` (modify — add `--data-stdin` and `--workspace-id` flags)
- `packages/hooks/git/__tests__/resolve-workspace.test.ts` (create)
- `packages/hooks/git/__tests__/hook-scripts.test.ts` (create)

## Success Criteria
1. All 4 hook scripts are valid bash and executable (`chmod +x`).
2. `resolve-workspace.sh` normalizes SSH and HTTPS git remotes to canonical IDs matching `normalizeGitRemote()` from shared.
3. `resolve-workspace.sh` handles: no remote (local repo → `local:<hash>`), no git repo (exit 1), first-remote fallback.
4. `post-commit` extracts: hash, message, author_name, author_email, branch, files_changed, insertions, deletions, file_list.
5. `post-checkout` only fires on branch checkouts (`$3 = 1`), not file checkouts.
6. `post-checkout` handles detached HEAD (null branch names in JSON).
7. `post-merge` identifies merged branch from MERGE_HEAD or commit message.
8. `post-merge` detects conflicts from MERGE_MSG.
9. `pre-push` reads stdin refs correctly, handles new branch push, skips branch deletions.
10. `pre-push` chains user hook and respects its exit code (user hook CAN block push).
11. All hooks exit 0 when `fuel-code` not in PATH (graceful degradation).
12. All hooks exit 0 when per-repo opt-out is set.
13. All hooks chain to `.user` variant when present (run user hook first).
14. All hooks use fire-and-forget (`&`) for emit calls.
15. All hooks suppress stdout/stderr (`>/dev/null 2>&1`).
16. `--data-stdin` flag works on `fuel-code emit` command.
17. JSON payloads are valid even with special characters in commit messages.
18. When `fuel-code emit` fails (binary missing, bun not in PATH, or command error), append timestamp + error to `~/.fuel-code/hook-errors.log`. Do not block git operations.
