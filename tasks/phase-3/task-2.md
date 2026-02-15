# Task 2: Git Hook Installer + Chaining

## Parallel Group: B

## Dependencies: Task 1

## Description

Extend the existing `fuel-code hooks install` command to support git hook installation. Implements the global `core.hooksPath` approach, hook chaining for existing user hooks, backup/restore, and extends `fuel-code hooks status` and adds `fuel-code hooks uninstall`.

### Extending `fuel-code hooks install`

**Modify `packages/cli/src/commands/hooks.ts`**:

The current `fuel-code hooks install` only handles CC hooks (writing to `~/.claude/settings.json`). Extend it:

```
fuel-code hooks install              # Install both CC hooks and git hooks
fuel-code hooks install --cc-only    # Install only CC hooks (Phase 1 behavior)
fuel-code hooks install --git-only   # Install only git hooks
```

Default behavior (no flags): install both CC and git hooks. This is the recommended path for new users.

### Git Hook Installation Flow

**`packages/cli/src/lib/git-hook-installer.ts`**:

```typescript
interface GitHookInstallResult {
  hooksDir: string;              // ~/.fuel-code/git-hooks/
  previousHooksPath: string | null; // existing core.hooksPath value before install
  backedUp: string[];            // hook names that were backed up
  installed: string[];           // hook names installed
  chained: string[];             // hook names that chain to existing user hooks
}

async function installGitHooks(options?: {
  force?: boolean;               // overwrite without chaining
  hooksDir?: string;             // override for testing
}): Promise<GitHookInstallResult>
```

Algorithm:
1. **Check prerequisites**:
   - `git --version` works. If not: error "Git is not installed."
   - `~/.fuel-code/` exists. If not: error "Run `fuel-code init` first."
2. **Create hooks directory**: `~/.fuel-code/git-hooks/`. Ensure exists with `mkdir -p`.
3. **Detect existing `core.hooksPath`**:
   ```typescript
   const existing = execSync('git config --global core.hooksPath', { encoding: 'utf8' }).trim();
   ```
   - If empty/unset: no existing hooks to chain. Proceed.
   - If set to `~/.fuel-code/git-hooks/`: already installed. Check if hook files are current (compare content). Update if needed. Return early.
   - If set to another path: hooks exist. Proceed to backup and chain.
4. **Backup existing hooks** (if `core.hooksPath` was set to another dir):
   - Create backup dir: `~/.fuel-code/git-hooks-backup/<ISO-timestamp>/`
   - Copy all files from existing hooks path to backup dir.
   - For each of the 4 hook names (post-commit, post-checkout, post-merge, pre-push):
     - If existing hook file exists and is executable: copy to `~/.fuel-code/git-hooks/<hook-name>.user`
     - Mark as chained.
   - Log: `Backed up existing hooks from <path> to <backup-dir>`
5. **Write hook scripts**:
   - Copy the 4 hook scripts from `packages/hooks/git/` to `~/.fuel-code/git-hooks/`.
   - Copy `resolve-workspace.sh` to `~/.fuel-code/git-hooks/`.
   - `chmod +x` all scripts.
6. **Set `core.hooksPath`**:
   ```bash
   git config --global core.hooksPath ~/.fuel-code/git-hooks/
   ```
7. **Update workspace_devices** (best-effort):
   - If currently in a git repo: resolve workspace, POST to backend to set `git_hooks_installed = true`.
   - If not in a git repo or backend unreachable: skip (will be set on next session.start).
8. **Print success**:
   ```
   Git hooks installed globally!
     Hooks directory:  ~/.fuel-code/git-hooks/
     Hooks installed:  post-commit, post-checkout, post-merge, pre-push
     Chained hooks:    post-commit (from /usr/share/git-core/hooks/)
     Previous hooksPath: /usr/share/git-core/hooks/ (backed up)

   All git repos on this machine will now report activity.
   To opt out a specific repo: create .fuel-code/config.yaml with git_enabled: false
   ```

### Extending `fuel-code hooks status`

```
fuel-code hooks status

Claude Code hooks:
  SessionStart: ✓ Installed (/path/to/SessionStart.sh)
  Stop:         ✓ Installed (/path/to/SessionEnd.sh)

Git hooks:
  core.hooksPath: ~/.fuel-code/git-hooks/
  post-commit:    ✓ Installed (chained: post-commit.user)
  post-checkout:  ✓ Installed
  post-merge:     ✓ Installed
  pre-push:       ✓ Installed
```

**`packages/cli/src/lib/git-hook-status.ts`**:

```typescript
interface GitHookStatus {
  installed: boolean;
  hooksPath: string | null;       // current core.hooksPath value
  isFuelCode: boolean;            // true if hooksPath points to our dir
  hooks: Record<string, {
    exists: boolean;
    chained: boolean;             // has .user variant
    executable: boolean;
  }>;
}

async function getGitHookStatus(): Promise<GitHookStatus>
```

### Adding `fuel-code hooks uninstall`

**`fuel-code hooks uninstall [--cc-only] [--git-only] [--restore]`**:

1. **`--git-only`** (or default includes git):
   a. Check `core.hooksPath`. If not pointing to fuel-code dir: warn "Git hooks not installed by fuel-code" and skip.
   b. If `--restore`: look for most recent backup in `~/.fuel-code/git-hooks-backup/`. If found, restore it as `core.hooksPath`. If not found: unset `core.hooksPath` entirely.
   c. If no `--restore`: check if there was a previous `core.hooksPath` (stored in `~/.fuel-code/git-hooks-backup/meta.json`). If yes, restore it. If no, unset `core.hooksPath`.
   d. Remove `~/.fuel-code/git-hooks/` directory.
   e. Update workspace_devices: set `git_hooks_installed = false` (best-effort).
   f. Print: `Git hooks uninstalled. Previous hooks restored: <path> (or: core.hooksPath unset)`

2. **`--cc-only`**: remove CC hooks from `~/.claude/settings.json` (reverse of Phase 1 install).

3. **Default (no flags)**: uninstall both.

### Backup Metadata

**`~/.fuel-code/git-hooks-backup/meta.json`**:

```json
{
  "previous_hooks_path": "/usr/share/git-core/hooks/",
  "backup_timestamp": "2026-02-14T10:30:00Z",
  "backed_up_hooks": ["post-commit", "pre-push"]
}
```

Stored during install, used during uninstall to know what to restore.

### Tests

**`packages/cli/src/commands/__tests__/hooks-git.test.ts`**:

All tests use a temp HOME directory to avoid modifying the real system.

1. `hooks install --git-only`: creates `~/.fuel-code/git-hooks/` with all 4 hooks + resolve-workspace.sh.
2. `hooks install --git-only`: sets `git config --global core.hooksPath` to hooks dir.
3. `hooks install --git-only`: all hook files are executable.
4. Running install twice: idempotent (no errors, hooks updated in place).
5. Install with existing `core.hooksPath` pointing elsewhere: backs up to `git-hooks-backup/`, chains `.user` files.
6. Install with existing `core.hooksPath` already pointing to fuel-code: no backup, updates hooks in place.
7. `hooks status`: shows installed/not-installed for each git hook.
8. `hooks status`: shows chained hooks when `.user` files exist.
9. `hooks uninstall --git-only`: removes hooks dir, unsets `core.hooksPath`.
10. `hooks uninstall --git-only --restore`: restores backed-up hooks path.
11. `hooks install` (no flags): installs both CC and git hooks.
12. Install when git is not available: errors clearly.
13. Install when fuel-code not initialized: errors "Run fuel-code init first."

**`packages/cli/src/lib/__tests__/git-hook-installer.test.ts`**:

Unit tests for the installer logic:
1. `backupExistingHooks()`: copies hooks and creates meta.json.
2. `writeHookScripts()`: writes all 4 scripts with correct content.
3. `getGitHookStatus()`: correctly detects installed/not-installed state.
4. `getGitHookStatus()`: detects chained hooks.

## Relevant Files
- `packages/cli/src/commands/hooks.ts` (modify — extend install, status, add uninstall)
- `packages/cli/src/lib/git-hook-installer.ts` (create)
- `packages/cli/src/lib/git-hook-status.ts` (create)
- `packages/cli/src/commands/__tests__/hooks-git.test.ts` (create)
- `packages/cli/src/lib/__tests__/git-hook-installer.test.ts` (create)

## Success Criteria
1. `fuel-code hooks install --git-only` creates `~/.fuel-code/git-hooks/` with all 4 hook scripts + resolve-workspace.sh.
2. Sets `git config --global core.hooksPath ~/.fuel-code/git-hooks/`.
3. All written hook scripts are executable (`chmod +x`).
4. Existing `core.hooksPath` hooks are backed up to `~/.fuel-code/git-hooks-backup/<timestamp>/`.
5. Existing hooks are chained via `<hook-name>.user` files in the hooks dir.
6. `meta.json` records previous hooks path and backed-up hook names.
7. Running install twice is idempotent (no duplicate backups, hooks updated in place).
8. `fuel-code hooks status` shows git hook installation state for each of the 4 hooks.
9. `fuel-code hooks status` shows chained hooks when `.user` files exist.
10. `fuel-code hooks uninstall --git-only` removes hooks dir and unsets `core.hooksPath`.
11. `fuel-code hooks uninstall --restore` restores previous `core.hooksPath` from backup.
12. Default `fuel-code hooks install` (no flags) installs both CC and git hooks.
13. Error message when git is not installed.
14. Error message when fuel-code not initialized (`~/.fuel-code/` doesn't exist).
15. `workspace_devices.git_hooks_installed` updated (best-effort, not required for success).
