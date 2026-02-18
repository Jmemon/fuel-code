# Phase 3: Git Tracking — Task Dependency DAG

## Overview

Phase 3 wires git activity alongside Claude Code sessions. After Phase 3, every git commit, push, checkout, and merge is captured, associated with the active CC session when applicable, and queryable via a unified timeline API. The user gets full visibility into what happened in each session — both the AI conversation and the code changes it produced.

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Git Hook Script Templates | A | — |
| 2 | Git Hook Installer + Chaining | B | 1 |
| 3 | Git Event Handlers + git_activity Population | A | — |
| 4 | Auto-Prompt for Git Hook Installation | C | 2, 3 |
| 5 | Timeline API Endpoint | C | 3 |
| 6 | Phase 3 E2E Tests | D | 2, 3, 4, 5 |

## Dependency Graph

```
Group A ─── Task 1: Hook script templates     Task 3: Git event handlers
               │                                  │
               ▼                                  │
Group B ─── Task 2: Installer + chaining          │
               │                                  │
        ┌──────┴──────────────────────────────────┤
        │                                         │
        ▼                                         ▼
Group C ─── Task 4: Auto-prompt          Task 5: Timeline API
               │                            │
               └────────────┬───────────────┘
                            ▼
Group D ─── Task 6: E2E integration tests
```

## Parallel Groups

- **A**: Tasks 1, 3 (independent: hook script content and server-side event handlers)
- **B**: Task 2 (installs the scripts from Task 1 to disk)
- **C**: Tasks 4, 5 (independent: auto-prompt needs installer+handlers, timeline needs handlers)
- **D**: Task 6 (final verification)

## Critical Path

Task 1 → Task 2 → Task 4 → Task 6

(4 sequential stages)

## Key Design Decisions

### Git Hook Architecture: Pure Bash
Git hooks are pure bash scripts (not bash wrapper → TS helper like CC hooks). Reasons:
1. CORE.md specifies "each hook is a bash script"
2. No bun startup overhead — git hooks should be near-instant
3. Metadata extraction is naturally shell commands (`git log`, `git diff-tree`)
4. Workspace resolution (normalize git remote URL) is simple enough in bash
5. Calls `fuel-code emit` with `&` — the emit command handles queuing/transport

### Global core.hooksPath (with Safety Checks)
`git config --global core.hooksPath ~/.fuel-code/git-hooks/` makes ALL repos tracked automatically. This is opt-out (per-repo) rather than opt-in (per-repo). Matches CORE.md.

**IMPORTANT (audit #3)**: Global core.hooksPath will silently break Husky, Lefthook, and Python's pre-commit framework for ALL repos on the machine. The installer MUST detect competing hook managers before overriding:
- If Husky detected (repo-level `core.hooksPath` set to `.husky/`): warn and abort unless `--force`
- If Lefthook detected (`lefthook.yml` exists): warn and abort unless `--force`
- If pre-commit detected (`.pre-commit-config.yaml` exists): warn and abort unless `--force`

A `--per-repo` mode is available as a safe alternative that installs hooks to `.git/hooks/` without touching global config. Safer but requires per-repo setup.

### Hook Chaining
If the user has existing git hooks (via a prior `core.hooksPath`), fuel-code:
1. Backs up existing hooks to `~/.fuel-code/git-hooks-backup/<timestamp>/`
2. Copies existing hook scripts as `<hook-name>.user` alongside fuel-code hooks
3. Each fuel-code hook runs the `.user` variant first, then the fuel-code logic
4. User hooks run with their original exit code; fuel-code logic always exits 0

### Session-Git Correlation Heuristic
When a git event arrives for workspace W on device D:
1. Find active session: `WHERE workspace_id = W AND device_id = D AND lifecycle = 'capturing' ORDER BY started_at DESC LIMIT 1`
2. If found: set `git_activity.session_id` and `events.session_id`
3. If not found: `session_id` stays NULL (workspace-level activity, not tied to a session)

### Safety Guarantees
Every git hook script enforces these invariants:
1. `exit 0` always — never blocks git operations
2. `command -v fuel-code` check — exits silently if binary missing
3. `&` on emit call — fire-and-forget, non-blocking
4. `>/dev/null 2>&1` — no output to terminal
5. Per-repo opt-out via `.fuel-code/config.yaml` grep check

## What Already Exists (from Phase 1)
- Event pipeline: hooks → `fuel-code emit` → HTTP POST → Redis → Processor → Postgres
- Handler registry pattern (`registry.register("type", handler)`)
- CC hooks (SessionStart, Stop) with `fuel-code hooks install` command
- `workspace_devices` table with `git_hooks_installed` boolean column
- `git_activity` table (exists but empty — no handlers populate it yet)
- All git event Zod schemas defined in `shared/schemas/`
- `normalizeGitRemote()` in `shared/src/canonical.ts`
- `resolveWorkspace()` helper in `hooks/claude/_helpers/resolve-workspace.ts`
