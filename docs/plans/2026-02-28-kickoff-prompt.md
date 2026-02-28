# Kickoff Prompt — Claude Code Full Capability Support

> Copy everything below the line into a fresh Claude Code session from the `/Users/johnmemon/Desktop/fuel-code` directory.

---

## The Prompt

Use `superpowers:subagent-driven-development` to implement the 13-task plan at `docs/plans/2026-02-28-claude-code-full-support.md`.

The design doc with full rationale, schema details, and research findings is at `tasks-greenfield/phase-4-2/01-claude-code-full-support.md`. Read both files before starting.

### What this implements

Claude Code tracks sessions as flat, independent units today. This plan adds support for sub-agent relationships, agent teams, session chains, skill invocations, and worktree lifecycle — via both real-time CC hooks and retroactive transcript parsing. It's a full-stack change: DB migration, shared types, event schemas, event handlers, transcript parser, session pipeline, CLI hooks, API endpoints, and TUI views.

### DAG (task dependencies)

```
Group A (no deps):     Task 1 (migration), Task 2 (shared types)
Group B (after 1):     Task 3 (event types + schemas), Task 4 (git hooks worktree)
Group C (after 2,3):   Task 5 (handlers), Task 6 (parser), Task 10 (API)
Group D (after 5):     Task 7 (hook CLI), Task 8 (hook registration)
Group E (after 6):     Task 9 (pipeline)
Group F (after 10):    Task 11 (TUI session detail), Task 12 (TUI teams view)
Standalone (after 6):  Task 13 (backfill scanner)
```

Tasks within the same group can run in parallel. Tasks in later groups depend on earlier groups completing first. Follow the DAG strictly.

### Key codebase files for implementer context

When dispatching implementer subagents, they will need to read the relevant existing files to follow patterns. Here's the reference map:

**Task 1 — DB Migration:**
- Existing migrations for style: `packages/server/src/db/migrations/001_initial.sql` through `004_add_git_hooks_prompt_columns.sql`
- Next migration number: `005`

**Task 2 — Shared Types:**
- Existing types to match style: `packages/shared/src/types/session.ts`, `packages/shared/src/types/event.ts`
- Barrel export: `packages/shared/src/types/index.ts`

**Task 3 — Event Types + Zod Schemas:**
- Event type union: `packages/shared/src/types/event.ts`
- Schema pattern to follow: `packages/shared/src/schemas/session-start.ts`
- Git schema to extend: `packages/shared/src/schemas/git-commit.ts` (and git-checkout, git-push, git-merge)
- Registry: `packages/shared/src/schemas/payload-registry.ts`

**Task 4 — Git Hooks Worktree Detection:**
- All 4 hooks: `packages/hooks/git/post-commit`, `pre-push`, `post-checkout`, `post-merge`
- Workspace resolver: `packages/hooks/git/resolve-workspace.sh`
- Detection method: `git rev-parse --git-dir` vs `--git-common-dir`

**Task 5 — Event Handlers:**
- Handler pattern: `packages/core/src/handlers/session-start.ts`, `git-commit.ts`
- Handler registry: `packages/core/src/handlers/index.ts`
- Test pattern: `packages/core/src/__tests__/git-handlers.test.ts`

**Task 6 — Transcript Parser:**
- Parser to extend: `packages/core/src/transcript-parser.ts`
- Parser tests: `packages/core/src/__tests__/transcript-parser.test.ts`
- Test fixtures: `packages/core/src/__tests__/fixtures/`

**Task 7 — Hook CLI Commands:**
- Existing hook commands: `packages/cli/src/commands/cc-hook.ts`
- Event emitter: `packages/cli/src/commands/emit.ts`

**Task 8 — Hook Registration:**
- Hook installer: `packages/cli/src/commands/hooks.ts`

**Task 9 — Session Pipeline:**
- Pipeline to extend: `packages/core/src/session-pipeline.ts`
- Pipeline tests: `packages/core/src/__tests__/session-pipeline.test.ts`

**Task 10 — API Endpoints:**
- Route pattern: `packages/server/src/routes/sessions.ts`
- Route mounting: `packages/server/src/app.ts`

**Task 11 — TUI Session Detail:**
- Session detail: `packages/cli/src/tui/SessionDetailView.tsx`
- Components: `packages/cli/src/tui/components/`
- TUI app routing: `packages/cli/src/tui/App.tsx`

**Task 12 — TUI Teams View:**
- Dashboard pattern: `packages/cli/src/tui/Dashboard.tsx`
- App routing for new views: `packages/cli/src/tui/App.tsx`

**Task 13 — Backfill Scanner:**
- Scanner: `packages/core/src/session-backfill.ts` (especially `scanForSessions()` around line 317, `isSessionActive()` around line 266, subdirectory skip at line 388-391)
- Backfill tests: `packages/core/src/__tests__/session-backfill.test.ts`

### Rules

- Do NOT include "Co-Authored-By" in any commit messages.
- Always use `bun` (not npm/yarn/pnpm).
- Run tests with output piped through grep to save context: `bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`
- Follow existing codebase patterns exactly — read the reference files before writing code.
- Each implementer subagent should commit its own work. One commit per task.
- The design doc has exact SQL, TypeScript interfaces, and code patterns. Use them as the source of truth.
- Be defensive in hook handlers — CC hook input schemas aren't fully documented, so log and skip unknown fields, don't crash on missing optional fields.
