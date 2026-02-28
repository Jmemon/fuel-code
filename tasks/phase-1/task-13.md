# Task 13: Claude Code Hook Scripts and `hooks install` Command

## Parallel Group: F

## Description

Create the Claude Code hook scripts (SessionStart, SessionEnd) and the `fuel-code hooks install` command that registers them in `~/.claude/settings.json`. The hooks are the bridge between Claude Code and fuel-code — they fire on session lifecycle events and call `fuel-code emit`.

Architecture: Bash wrapper → TypeScript helper → `fuel-code emit`. All JSON parsing and workspace resolution happens in TypeScript (not bash), eliminating shell parsing fragility.

### Files to Create

**`packages/hooks/claude/SessionStart.sh`**:
```bash
#!/usr/bin/env bash
# fuel-code: Claude Code SessionStart hook
# Delegates all logic to the TS helper. Must exit in <1s. Must never fail CC.
set -euo pipefail

# Pipe stdin (hook context JSON) to the TS helper
# Run in background so we don't block Claude Code startup
bun run "$(dirname "$0")/_helpers/session-start.ts" &

# Exit immediately — do not wait for the helper
exit 0
```

**`packages/hooks/claude/SessionEnd.sh`**:
```bash
#!/usr/bin/env bash
# fuel-code: Claude Code SessionEnd/Stop hook
# Delegates all logic to the TS helper.
set -euo pipefail
bun run "$(dirname "$0")/_helpers/session-end.ts" &
exit 0
```

**`packages/hooks/claude/_helpers/session-start.ts`**:

Reads CC hook context from stdin, resolves workspace identity, calls `fuel-code emit`.

```typescript
// Read hook context from stdin
// CC provides JSON with: session_id, cwd, transcript_path, source, model
const input = await Bun.stdin.text();
```

Flow:
1. Parse stdin JSON. If parse fails: exit 0 silently.
2. Extract `session_id`. If empty/missing: exit 0 (can't track without ID).
3. Extract `cwd` (default: `process.cwd()`), `transcript_path`, `source` (default: `"startup"`), `model`.
4. **Resolve workspace canonical ID from CWD**:
   a. Check if CWD is a git repo: `git -C <cwd> rev-parse --is-inside-work-tree`
   b. Get remote URL: prefer `origin`, fall back to first remote alphabetically.
   c. If remote found: normalize using `normalizeGitRemote()` from `@fuel-code/shared`.
   d. If no remote but has commits: `local:<sha256(first-commit-hash)>`.
   e. If not a git repo: `_unassociated`.
   f. All `execSync` calls use `{ cwd, stdio: "pipe" }` and are wrapped in try/catch.
5. Get CC version: `claude --version` (try/catch, default `"unknown"`).
6. Get git branch: `git symbolic-ref --short HEAD` (try/catch, default null).
7. Construct payload JSON matching `SessionStartPayload`.
8. Call `fuel-code emit session.start --data <json> --workspace-id <id> --session-id <id>`.
   - Use `Bun.spawn(["fuel-code", "emit", ...])` with stdout/stderr ignored.
   - Wait for the process to exit.
9. Exit 0 regardless of outcome.

**`packages/hooks/claude/_helpers/session-end.ts`**:

Similar structure. Reads CC hook context, emits `session.end`.

1. Parse stdin, extract `session_id`, `cwd`, `transcript_path`.
2. Extract or determine `end_reason`:
   - CC hook names map: `Stop` → `"exit"`, `clear` context → `"clear"`.
   - Default: `"exit"`.
3. `duration_ms`: set to 0 (server computes from session.start timestamp).
4. Resolve workspace (same logic as session-start).
5. Call `fuel-code emit session.end --data <json> --workspace-id <id> --session-id <id>`.
6. Exit 0.

**Both helper scripts must**:
- Produce NO stdout/stderr output (could confuse CC).
- Handle ALL errors silently (never crash, never block CC).
- Complete within 2-3 seconds (emit has a 2s timeout).

**`packages/hooks/claude/_helpers/resolve-workspace.ts`**:
Shared utility used by both helpers:
```typescript
export async function resolveWorkspace(cwd: string): Promise<{
  workspaceId: string;
  gitBranch: string | null;
  gitRemote: string | null;
}>
```
Extracts the workspace resolution logic into a reusable function to avoid duplication between session-start and session-end helpers.

**`packages/cli/src/commands/hooks.ts`**:

`fuel-code hooks` command group:

**`fuel-code hooks install`**:
1. Determine hook script paths (relative to the installed hooks package).
2. Read `~/.claude/settings.json`. If file doesn't exist: create it with `{ "hooks": {} }`. If file exists but isn't valid JSON: error "~/.claude/settings.json is corrupted. Fix it manually or backup and delete it." Exit 1.
3. Ensure `settings.hooks` object exists.
4. For `SessionStart` hook:
   - Build hook config: `{ "matcher": "", "hooks": [{ "type": "command", "command": "/absolute/path/to/SessionStart.sh" }] }`
   - Upsert: if `settings.hooks.SessionStart` exists, find any existing fuel-code hook (by checking if command path includes "fuel-code" or "SessionStart.sh"), replace it. Preserve other hooks from other tools.
   - If no existing fuel-code hook: append to the array.
5. For `Stop` hook (CC uses "Stop" for session end, not "SessionEnd"):
   - Same upsert logic with `SessionEnd.sh`.
6. Write `~/.claude/settings.json` atomically (tmp + rename).
7. Make hook scripts executable: `chmod +x SessionStart.sh SessionEnd.sh`.
8. Print:
   ```
   Claude Code hooks installed!
     SessionStart: /path/to/SessionStart.sh
     Stop:         /path/to/SessionEnd.sh
     Settings:     ~/.claude/settings.json

   Hooks will take effect on your next Claude Code session.
   ```

**`fuel-code hooks status`**:
- Read `~/.claude/settings.json`.
- Check for fuel-code hooks in SessionStart and Stop arrays.
- Print installed/not-installed status for each.

**`fuel-code hooks test`**:
- Emit a synthetic `session.start` event with test data.
- Check if it reaches the backend (or is queued).
- Print result: "Test event sent successfully" or "Test event queued (backend unreachable)".

### Edge Cases
- `~/.claude/` directory doesn't exist: create it.
- `~/.claude/settings.json` doesn't exist: create with default structure.
- User has other hooks registered (e.g., from another tool): preserve them.
- Running `hooks install` twice: idempotent (replaces fuel-code hooks, no duplicates).
- `fuel-code` binary not in PATH when hook fires: hook exits 0 silently (bash `set -e` catches the error, but `exit 0` at end ensures clean exit... actually, need to handle this. Use `command -v fuel-code` check or `|| true` on the bun spawn).

### Tests

**`packages/cli/src/commands/__tests__/hooks.test.ts`**:
- `hooks install` creates/updates `~/.claude/settings.json` with correct structure
- Running twice is idempotent (no duplicate hook entries)
- Existing non-fuel-code hooks are preserved
- `hooks status` correctly reports installed/not-installed

## Relevant Files
- `packages/hooks/claude/SessionStart.sh` (create)
- `packages/hooks/claude/SessionEnd.sh` (create)
- `packages/hooks/claude/_helpers/session-start.ts` (create)
- `packages/hooks/claude/_helpers/session-end.ts` (create)
- `packages/hooks/claude/_helpers/resolve-workspace.ts` (create)
- `packages/cli/src/commands/hooks.ts` (create)
- `packages/cli/src/index.ts` (modify — register hooks command)
- `packages/cli/src/commands/__tests__/hooks.test.ts` (create)

## Success Criteria
1. `fuel-code hooks install` adds hook entries to `~/.claude/settings.json`.
2. Settings file preserves existing non-fuel-code hooks.
3. SessionStart hook registered under `hooks.SessionStart` key.
4. SessionEnd hook registered under `hooks.Stop` key (CC uses "Stop").
5. Running `hooks install` twice is idempotent (no duplicates).
6. `fuel-code hooks status` shows INSTALLED for both hooks after install.
7. `SessionStart.sh` is executable and exits in < 1 second.
8. `SessionEnd.sh` is executable and exits in < 1 second.
9. Hook scripts exit 0 even when backend is unreachable (emit queues locally).
10. Hook scripts exit 0 when `fuel-code` is not initialized (no config).
11. Hook scripts produce no stdout/stderr output.
12. TS helpers correctly resolve workspace from git remote in CWD.
13. TS helpers handle non-git directories (workspace = `_unassociated`).
14. TS helpers handle repos with no remote (workspace = `local:<hash>`).
15. `fuel-code hooks test` emits a test event and reports success or queued status.
16. Missing `~/.claude/` directory is created by install.
