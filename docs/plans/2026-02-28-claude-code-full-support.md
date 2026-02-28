# Claude Code Full Capability Support — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track sub-agent relationships, agent teams, session chains, skill invocations, and worktree lifecycle across the full fuel-code stack — via both real-time hooks and retroactive transcript parsing.

**Architecture:** New DB tables (subagents, teams, session_skills, session_worktrees) + new columns on sessions/git_activity/transcript_messages/content_blocks. New CC hooks (SubagentStart, SubagentStop, PostToolUse, WorktreeCreate, WorktreeRemove) emit events processed by new handlers. Transcript parser enhanced to extract the same data retroactively. New API endpoints and TUI views expose the data.

**Tech Stack:** TypeScript, Bun, postgres.js, Zod, Express, Ink (React TUI), S3

**Design doc:** `tasks-greenfield/phase-4-2/01-claude-code-full-support.md`

---

## DAG Overview

```
Task 1 (migration) ──┬──→ Task 3 (event types + schemas)
                      │         │
                      │         ├──→ Task 5 (handlers)
                      │         │         │
                      │         │         └──→ Task 7 (hook CLI commands)
                      │         │                    │
                      │         │                    └──→ Task 8 (hook registration)
                      │         │
                      │         └──→ Task 6 (transcript parser)
                      │                    │
                      │                    └──→ Task 9 (session pipeline)
                      │
                      ├──→ Task 2 (shared types)
                      │
                      ├──→ Task 4 (git hooks worktree detection)
                      │
                      └──→ Task 10 (API endpoints) ──→ Task 11 (TUI session detail)
                                                              │
                                                              └──→ Task 12 (TUI teams view)
```

**Parallel groups:**
- **Group A** (no deps): Tasks 1, 2
- **Group B** (after 1): Tasks 3, 4
- **Group C** (after 2, 3): Tasks 5, 6, 10
- **Group D** (after 5): Tasks 7, 8
- **Group E** (after 6): Task 9
- **Group F** (after 10): Tasks 11, 12

---

### Task 1: Database Migration

**Dependencies:** None

**Files:**
- Create: `packages/server/src/db/migrations/005_session_relationships.sql`
- Test: `packages/server/src/db/__tests__/migration-005.test.ts` (optional — migrations are tested via integration)

**Step 1: Write the migration file**

Create `packages/server/src/db/migrations/005_session_relationships.sql`:

```sql
-- 005_session_relationships.sql
-- Adds tables and columns for tracking sub-agents, teams, skills, worktrees,
-- and session chains. Part of Phase 4.2: Claude Code Full Capability Support.

-- New columns on sessions for session chains and team membership
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS resumed_from_session_id TEXT REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS team_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS team_role TEXT CHECK (team_role IN ('lead', 'member'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permission_mode TEXT;

-- Sub-agents: every Task tool spawn within a session
CREATE TABLE IF NOT EXISTS subagents (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL,
  agent_type            TEXT NOT NULL,
  agent_name            TEXT,
  model                 TEXT,
  spawning_tool_use_id  TEXT,
  team_name             TEXT,
  isolation             TEXT,
  run_in_background     BOOLEAN DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  transcript_s3_key     TEXT,
  metadata              JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_subagents_team ON subagents(team_name) WHERE team_name IS NOT NULL;

-- Teams: coordination units with a lead session + member sub-agents
CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  team_name       TEXT NOT NULL UNIQUE,
  description     TEXT,
  lead_session_id TEXT REFERENCES sessions(id),
  created_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  member_count    INTEGER DEFAULT 0,
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_teams_lead ON teams(lead_session_id);

-- Skill invocations within a session
CREATE TABLE IF NOT EXISTS session_skills (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_name    TEXT NOT NULL,
  invoked_at    TIMESTAMPTZ NOT NULL,
  invoked_by    TEXT,
  args          TEXT,
  metadata      JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_skills_session ON session_skills(session_id);
CREATE INDEX IF NOT EXISTS idx_session_skills_name ON session_skills(skill_name);

-- Worktree usage within a session
CREATE TABLE IF NOT EXISTS session_worktrees (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_name   TEXT,
  branch          TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  removed_at      TIMESTAMPTZ,
  had_changes     BOOLEAN,
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_worktrees_session ON session_worktrees(session_id);

-- Link transcript messages and content blocks to sub-agents
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS subagent_id TEXT REFERENCES subagents(id);
ALTER TABLE content_blocks ADD COLUMN IF NOT EXISTS subagent_id TEXT REFERENCES subagents(id);

CREATE INDEX IF NOT EXISTS idx_transcript_messages_subagent ON transcript_messages(subagent_id) WHERE subagent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_blocks_subagent ON content_blocks(subagent_id) WHERE subagent_id IS NOT NULL;

-- Add worktree context to git_activity
ALTER TABLE git_activity ADD COLUMN IF NOT EXISTS worktree_name TEXT;
ALTER TABLE git_activity ADD COLUMN IF NOT EXISTS is_worktree BOOLEAN DEFAULT false;
```

**Step 2: Verify migration applies cleanly**

Run: `bun run --cwd packages/server migrate` (or however migrations are applied)
Expected: Migration runs without errors. All tables and columns created.

**Step 3: Commit**

```bash
git add packages/server/src/db/migrations/005_session_relationships.sql
git commit -m "feat: add migration 005 for sub-agents, teams, skills, worktrees"
```

---

### Task 2: Shared Types

**Dependencies:** None (can run in parallel with Task 1)

**Files:**
- Create: `packages/shared/src/types/subagent.ts`
- Create: `packages/shared/src/types/team.ts`
- Create: `packages/shared/src/types/skill.ts`
- Create: `packages/shared/src/types/worktree.ts`
- Modify: `packages/shared/src/types/session.ts`
- Modify: `packages/shared/src/types/index.ts` (or wherever types are re-exported)

**Step 1: Create `packages/shared/src/types/subagent.ts`**

```typescript
/** Represents a sub-agent spawned via the Task tool within a session. */
export interface Subagent {
  id: string;
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  spawning_tool_use_id?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  status: "running" | "completed" | "failed";
  started_at?: string;
  ended_at?: string;
  transcript_s3_key?: string;
  metadata: Record<string, unknown>;
}
```

**Step 2: Create `packages/shared/src/types/team.ts`**

```typescript
import type { Subagent } from "./subagent.js";

/** Represents an agent team: one lead session + N member sub-agents. */
export interface Team {
  id: string;
  team_name: string;
  description?: string;
  lead_session_id?: string;
  created_at: string;
  ended_at?: string;
  member_count: number;
  members?: Subagent[];
  metadata: Record<string, unknown>;
}
```

**Step 3: Create `packages/shared/src/types/skill.ts`**

```typescript
/** Tracks a skill invocation within a session. */
export interface SessionSkill {
  id: string;
  session_id: string;
  skill_name: string;
  invoked_at: string;
  invoked_by?: "user" | "claude";
  args?: string;
}
```

**Step 4: Create `packages/shared/src/types/worktree.ts`**

```typescript
/** Tracks worktree lifecycle within a session. */
export interface SessionWorktree {
  id: string;
  session_id: string;
  worktree_name?: string;
  branch?: string;
  created_at: string;
  removed_at?: string;
  had_changes?: boolean;
}
```

**Step 5: Extend `packages/shared/src/types/session.ts`**

Add these fields to the existing `Session` interface:

```typescript
import type { Subagent } from "./subagent.js";
import type { SessionSkill } from "./skill.js";
import type { SessionWorktree } from "./worktree.js";
import type { Team } from "./team.js";

// Add to Session interface:
resumed_from_session_id?: string;
team_name?: string;
team_role?: "lead" | "member";
permission_mode?: string;

// Joined data (populated only by detail queries, not list queries)
subagents?: Subagent[];
skills?: SessionSkill[];
worktrees?: SessionWorktree[];
team?: Team;
resumed_from?: { id: string; started_at: string; initial_prompt?: string };
```

**Step 6: Re-export from index**

Add to `packages/shared/src/types/index.ts` (or wherever types barrel-export):

```typescript
export type { Subagent } from "./subagent.js";
export type { Team } from "./team.js";
export type { SessionSkill } from "./skill.js";
export type { SessionWorktree } from "./worktree.js";
```

**Step 7: Run type check**

Run: `bun run --cwd packages/shared tsc --noEmit 2>&1 | head -20`
Expected: No errors.

**Step 8: Commit**

```bash
git add packages/shared/src/types/subagent.ts packages/shared/src/types/team.ts packages/shared/src/types/skill.ts packages/shared/src/types/worktree.ts packages/shared/src/types/session.ts packages/shared/src/types/index.ts
git commit -m "feat: add shared types for subagents, teams, skills, worktrees"
```

---

### Task 3: Event Types + Zod Schemas

**Dependencies:** Task 1 (migration must exist so we know the table shapes)

**Files:**
- Modify: `packages/shared/src/types/event.ts` — add 7 new event types
- Create: `packages/shared/src/schemas/subagent-start.ts`
- Create: `packages/shared/src/schemas/subagent-stop.ts`
- Create: `packages/shared/src/schemas/team-create.ts`
- Create: `packages/shared/src/schemas/team-message.ts`
- Create: `packages/shared/src/schemas/skill-invoke.ts`
- Create: `packages/shared/src/schemas/worktree-create.ts`
- Create: `packages/shared/src/schemas/worktree-remove.ts`
- Modify: `packages/shared/src/schemas/payload-registry.ts` — register new schemas
- Modify: `packages/shared/src/schemas/git-commit.ts` — add worktree fields
- Modify: `packages/shared/src/schemas/git-checkout.ts` — add worktree fields
- Modify: `packages/shared/src/schemas/git-push.ts` — add worktree fields
- Modify: `packages/shared/src/schemas/git-merge.ts` — add worktree fields
- Test: `packages/shared/src/__tests__/schemas.test.ts` — add tests for new schemas

**Step 1: Add event types to `packages/shared/src/types/event.ts`**

Add to the `EventType` union and `EVENT_TYPES` array:

```typescript
// Add to EventType union:
| "subagent.start"
| "subagent.stop"
| "team.create"
| "team.message"
| "skill.invoke"
| "worktree.create"
| "worktree.remove"

// Add to EVENT_TYPES array:
"subagent.start",
"subagent.stop",
"team.create",
"team.message",
"skill.invoke",
"worktree.create",
"worktree.remove",
```

**Step 2: Write Zod schemas**

Follow the exact pattern from `packages/shared/src/schemas/session-start.ts`. Each file exports a schema + inferred type.

Create `packages/shared/src/schemas/subagent-start.ts`:

```typescript
/**
 * Zod schema for the subagent.start event payload.
 * Emitted when a sub-agent is spawned via the Task tool.
 */
import { z } from "zod";

export const subagentStartPayloadSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_type: z.string().min(1),
  agent_name: z.string().optional(),
  model: z.string().optional(),
  team_name: z.string().optional(),
  isolation: z.string().optional(),
  run_in_background: z.boolean().optional(),
});

export type SubagentStartPayload = z.infer<typeof subagentStartPayloadSchema>;
```

Create `packages/shared/src/schemas/subagent-stop.ts`:

```typescript
import { z } from "zod";

export const subagentStopPayloadSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_type: z.string().min(1),
});

export type SubagentStopPayload = z.infer<typeof subagentStopPayloadSchema>;
```

Create `packages/shared/src/schemas/team-create.ts`:

```typescript
import { z } from "zod";

export const teamCreatePayloadSchema = z.object({
  session_id: z.string().min(1),
  team_name: z.string().min(1),
  description: z.string().optional(),
});

export type TeamCreatePayload = z.infer<typeof teamCreatePayloadSchema>;
```

Create `packages/shared/src/schemas/team-message.ts`:

```typescript
import { z } from "zod";

export const teamMessagePayloadSchema = z.object({
  session_id: z.string().min(1),
  team_name: z.string().min(1),
  message_type: z.string().min(1),
  from: z.string().min(1),
  to: z.string().optional(),
});

export type TeamMessagePayload = z.infer<typeof teamMessagePayloadSchema>;
```

Create `packages/shared/src/schemas/skill-invoke.ts`:

```typescript
import { z } from "zod";

export const skillInvokePayloadSchema = z.object({
  session_id: z.string().min(1),
  skill_name: z.string().min(1),
  args: z.string().optional(),
  invoked_by: z.enum(["user", "claude"]).optional(),
});

export type SkillInvokePayload = z.infer<typeof skillInvokePayloadSchema>;
```

Create `packages/shared/src/schemas/worktree-create.ts`:

```typescript
import { z } from "zod";

export const worktreeCreatePayloadSchema = z.object({
  session_id: z.string().min(1),
  worktree_name: z.string().optional(),
  branch: z.string().optional(),
});

export type WorktreeCreatePayload = z.infer<typeof worktreeCreatePayloadSchema>;
```

Create `packages/shared/src/schemas/worktree-remove.ts`:

```typescript
import { z } from "zod";

export const worktreeRemovePayloadSchema = z.object({
  session_id: z.string().min(1),
  worktree_name: z.string().optional(),
  had_changes: z.boolean().optional(),
});

export type WorktreeRemovePayload = z.infer<typeof worktreeRemovePayloadSchema>;
```

**Step 3: Add worktree fields to git schemas**

For each of `git-commit.ts`, `git-push.ts`, `git-checkout.ts`, `git-merge.ts`, add these optional fields to the existing Zod object:

```typescript
  /** Whether this event occurred inside a git worktree */
  is_worktree: z.boolean().optional(),
  /** Name of the worktree directory (e.g., "agent-a3067cc4") */
  worktree_name: z.string().optional(),
```

**Step 4: Register in payload-registry.ts**

Add imports and entries to `packages/shared/src/schemas/payload-registry.ts`:

```typescript
import { subagentStartPayloadSchema } from "./subagent-start.js";
import { subagentStopPayloadSchema } from "./subagent-stop.js";
import { teamCreatePayloadSchema } from "./team-create.js";
import { teamMessagePayloadSchema } from "./team-message.js";
import { skillInvokePayloadSchema } from "./skill-invoke.js";
import { worktreeCreatePayloadSchema } from "./worktree-create.js";
import { worktreeRemovePayloadSchema } from "./worktree-remove.js";

// Add to PAYLOAD_SCHEMAS:
"subagent.start": subagentStartPayloadSchema,
"subagent.stop": subagentStopPayloadSchema,
"team.create": teamCreatePayloadSchema,
"team.message": teamMessagePayloadSchema,
"skill.invoke": skillInvokePayloadSchema,
"worktree.create": worktreeCreatePayloadSchema,
"worktree.remove": worktreeRemovePayloadSchema,
```

**Step 5: Write tests**

Add to `packages/shared/src/__tests__/schemas.test.ts`:

```typescript
describe("subagent.start schema", () => {
  test("valid payload", () => {
    const result = subagentStartPayloadSchema.safeParse({
      session_id: "abc-123",
      agent_id: "a834e7d",
      agent_type: "Explore",
      agent_name: "codebase-auditor",
      model: "claude-haiku-4-5-20251001",
      team_name: "research-team",
    });
    expect(result.success).toBe(true);
  });

  test("minimal payload (required fields only)", () => {
    const result = subagentStartPayloadSchema.safeParse({
      session_id: "abc-123",
      agent_id: "a834e7d",
      agent_type: "Explore",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing agent_type", () => {
    const result = subagentStartPayloadSchema.safeParse({
      session_id: "abc-123",
      agent_id: "a834e7d",
    });
    expect(result.success).toBe(false);
  });
});
```

Write similar tests for each new schema (valid, minimal, rejects missing required).

**Step 6: Run tests**

Run: `bun test --cwd packages/shared 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`
Expected: All pass.

**Step 7: Commit**

```bash
git add packages/shared/src/types/event.ts packages/shared/src/schemas/ packages/shared/src/__tests__/schemas.test.ts
git commit -m "feat: add event types and Zod schemas for subagents, teams, skills, worktrees"
```

---

### Task 4: Git Hooks Worktree Detection

**Dependencies:** Task 1 (migration adds worktree columns to git_activity)

**Files:**
- Modify: `packages/hooks/git/post-commit`
- Modify: `packages/hooks/git/pre-push`
- Modify: `packages/hooks/git/post-checkout`
- Modify: `packages/hooks/git/post-merge`
- Modify: `packages/core/src/handlers/git-commit.ts` — store worktree fields
- Modify: `packages/core/src/handlers/git-push.ts`
- Modify: `packages/core/src/handlers/git-checkout.ts`
- Modify: `packages/core/src/handlers/git-merge.ts`
- Test: `packages/hooks/git/__tests__/hook-scripts.test.ts` — add worktree tests
- Test: `packages/core/src/__tests__/git-handlers.test.ts` — add worktree tests

**Step 1: Add worktree detection snippet to all 4 git hooks**

Insert after the `WORKSPACE_ID` resolution, before the JSON payload construction, in each of the 4 hooks:

```bash
# Detect if running inside a git worktree
GIT_DIR_RESOLVED=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
IS_WORKTREE="false"
WORKTREE_NAME=""
if [ "$GIT_DIR_RESOLVED" != "$GIT_COMMON_DIR" ] && [ -n "$GIT_COMMON_DIR" ]; then
  IS_WORKTREE="true"
  WORKTREE_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
fi
```

Then add to the JSON payload of each hook:

```json
  "is_worktree": $IS_WORKTREE,
  "worktree_name": $([ -n "$WORKTREE_NAME" ] && echo "\"$WORKTREE_NAME\"" || echo "null")
```

**Step 2: Update git event handlers to store worktree context**

In each git handler (`git-commit.ts`, `git-push.ts`, `git-checkout.ts`, `git-merge.ts`), add these fields to the `git_activity` INSERT:

```typescript
const isWorktree = (event.data.is_worktree as boolean) ?? false;
const worktreeName = (event.data.worktree_name as string) ?? null;

// Add to the INSERT statement columns:
// worktree_name, is_worktree
// Values: worktreeName, isWorktree
```

**Step 3: Write tests for worktree detection in git handlers**

Add to `packages/core/src/__tests__/git-handlers.test.ts`:

```typescript
test("git.commit with worktree context stores worktree fields", async () => {
  const { sql, calls } = createMockSql([
    [{ id: "sess_1" }], // correlateGitEventToSession result
    [],                   // git_activity INSERT
    [],                   // events UPDATE
  ]);
  const event = makeGitEvent("git.commit", {
    hash: "abc123",
    message: "fix: something",
    author_name: "Test",
    branch: "worktree-agent-a3067cc4",
    files_changed: 1,
    insertions: 5,
    deletions: 2,
    is_worktree: true,
    worktree_name: "agent-a3067cc4",
  });
  await handleGitCommit({ sql, event, workspaceId: "ws_1", logger });
  // Verify the INSERT includes worktree fields
  const insertCall = calls.find(c => c.strings.join("").includes("git_activity"));
  expect(insertCall).toBeDefined();
  expect(insertCall!.values).toContain(true);           // is_worktree
  expect(insertCall!.values).toContain("agent-a3067cc4"); // worktree_name
});
```

**Step 4: Run tests**

Run: `bun test --cwd packages/core 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Run: `bun test --cwd packages/hooks 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All pass.

**Step 5: Commit**

```bash
git add packages/hooks/git/ packages/core/src/handlers/git-*.ts packages/core/src/__tests__/git-handlers.test.ts
git commit -m "feat: detect worktree context in git hooks and store in git_activity"
```

---

### Task 5: Event Handlers

**Dependencies:** Tasks 1, 3 (migration + event types)

**Files:**
- Create: `packages/core/src/handlers/subagent-start.ts`
- Create: `packages/core/src/handlers/subagent-stop.ts`
- Create: `packages/core/src/handlers/team-create.ts`
- Create: `packages/core/src/handlers/team-message.ts`
- Create: `packages/core/src/handlers/skill-invoke.ts`
- Create: `packages/core/src/handlers/worktree-create.ts`
- Create: `packages/core/src/handlers/worktree-remove.ts`
- Modify: `packages/core/src/handlers/index.ts` — register all 7 handlers
- Test: `packages/core/src/__tests__/relationship-handlers.test.ts`

**Step 1: Write `packages/core/src/handlers/subagent-start.ts`**

Follow the exact pattern of `session-start.ts`:

```typescript
import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";

export async function handleSubagentStart(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;
  const d = event.data;

  const id = generateId();
  const sessionId = d.session_id as string;
  const agentId = d.agent_id as string;
  const agentType = d.agent_type as string;
  const agentName = (d.agent_name as string) ?? null;
  const model = (d.model as string) ?? null;
  const teamName = (d.team_name as string) ?? null;
  const isolation = (d.isolation as string) ?? null;
  const runInBackground = (d.run_in_background as boolean) ?? false;

  await sql`
    INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model,
                           team_name, isolation, run_in_background, status, started_at)
    VALUES (${id}, ${sessionId}, ${agentId}, ${agentType}, ${agentName}, ${model},
            ${teamName}, ${isolation}, ${runInBackground}, 'running', ${event.timestamp})
    ON CONFLICT (id) DO NOTHING
  `;

  logger.info({ sessionId, agentId, agentType, agentName }, "subagent started");
}
```

**Step 2: Write remaining 6 handlers**

Each follows the same pattern. Key logic:

- `subagent-stop.ts`: UPDATE subagents SET status='completed', ended_at. Also UPDATE sessions SET subagent_count = (SELECT COUNT(*) FROM subagents WHERE session_id = $1).
- `team-create.ts`: INSERT INTO teams. UPDATE sessions SET team_name, team_role='lead'.
- `team-message.ts`: UPDATE teams metadata (increment message count in JSONB).
- `skill-invoke.ts`: INSERT INTO session_skills.
- `worktree-create.ts`: INSERT INTO session_worktrees.
- `worktree-remove.ts`: UPDATE session_worktrees SET removed_at, had_changes.

**Step 3: Register handlers in `packages/core/src/handlers/index.ts`**

```typescript
import { handleSubagentStart } from "./subagent-start.js";
import { handleSubagentStop } from "./subagent-stop.js";
import { handleTeamCreate } from "./team-create.js";
import { handleTeamMessage } from "./team-message.js";
import { handleSkillInvoke } from "./skill-invoke.js";
import { handleWorktreeCreate } from "./worktree-create.js";
import { handleWorktreeRemove } from "./worktree-remove.js";

// Add in createHandlerRegistry():
registry.register("subagent.start", handleSubagentStart);
registry.register("subagent.stop", handleSubagentStop);
registry.register("team.create", handleTeamCreate);
registry.register("team.message", handleTeamMessage);
registry.register("skill.invoke", handleSkillInvoke);
registry.register("worktree.create", handleWorktreeCreate);
registry.register("worktree.remove", handleWorktreeRemove);
```

**Step 4: Write tests in `packages/core/src/__tests__/relationship-handlers.test.ts`**

Use the same `createMockSql` pattern from `git-handlers.test.ts`. Test each handler for:
- Correct INSERT with expected columns/values
- Idempotency (ON CONFLICT DO NOTHING)
- Handler registration (verify all 7 are in the registry)

**Step 5: Run tests**

Run: `bun test --cwd packages/core 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All pass.

**Step 6: Commit**

```bash
git add packages/core/src/handlers/ packages/core/src/__tests__/relationship-handlers.test.ts
git commit -m "feat: add event handlers for subagents, teams, skills, worktrees"
```

---

### Task 6: Transcript Parser Enhancements

**Dependencies:** Tasks 2, 3 (shared types, event types)

**Files:**
- Modify: `packages/core/src/transcript-parser.ts`
- Test: `packages/core/src/__tests__/transcript-parser.test.ts`

**Step 1: Add extraction types to the parser**

Add to `transcript-parser.ts` (or import from shared):

```typescript
interface ParsedSubagent {
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  spawning_tool_use_id: string;
  started_at?: string;
}

interface ParsedTeam {
  team_name: string;
  description?: string;
  message_count: number;
}

interface ParsedSkill {
  skill_name: string;
  invoked_at: string;
  invoked_by: "user" | "claude";
  args?: string;
}

interface ParsedWorktree {
  worktree_name?: string;
  created_at: string;
}
```

**Step 2: Extend ParseResult**

Add to the existing `ParseResult` interface:

```typescript
subagents: ParsedSubagent[];
teams: ParsedTeam[];
skills: ParsedSkill[];
worktrees: ParsedWorktree[];
permission_mode?: string;
```

**Step 3: Add extraction logic**

In the existing parsing loop (or as a post-pass over `contentBlocks`), add extraction for:

1. **Sub-agents**: When `block.tool_name === "Task"`, extract fields from `block.tool_input` (`subagent_type`, `name`, `team_name`, `model`, `run_in_background`, `isolation`). Match the corresponding tool_result by `tool_use_id` to get `agent_id` from `toolUseResult.agent_id` or `toolUseResult.teammate_id`.

2. **Teams**: When `block.tool_name === "TeamCreate"`, extract `team_name`, `description` from `tool_input`. When `block.tool_name === "SendMessage"`, increment team message count.

3. **Skills**: When `block.tool_name === "Skill"`, extract `skill` (name), `args` from `tool_input`. Check if the previous user message started with `/<skill_name>` to determine `invoked_by`.

4. **Worktrees**: When `block.tool_name === "EnterWorktree"`, extract `name` from `tool_input`.

5. **Permission mode**: Extract from the first transcript line's `permissionMode` field.

The extraction should happen in the existing pass 2 (where messages and content blocks are built) to avoid a second iteration. Accumulate results in arrays and return them in ParseResult.

**Step 4: Write tests**

Add to `packages/core/src/__tests__/transcript-parser.test.ts`:

```typescript
describe("relationship extraction", () => {
  test("extracts sub-agent from Task tool call", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Research the codebase" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_001",
          model: "claude-opus-4-6",
          content: [{
            type: "tool_use",
            id: "toolu_01abc",
            name: "Task",
            input: {
              description: "Explore codebase",
              prompt: "Search for...",
              subagent_type: "Explore",
              model: "haiku",
            },
          }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "user",
        timestamp: "2025-05-10T10:00:02.000Z",
        message: {
          role: "user",
          content: [{
            tool_use_id: "toolu_01abc",
            type: "tool_result",
            content: "Found 5 files",
          }],
        },
        toolUseResult: {
          agent_id: "a834e7d",
          agent_type: "Explore",
          model: "claude-haiku-4-5-20251001",
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0].agent_type).toBe("Explore");
    expect(result.subagents[0].agent_id).toBe("a834e7d");
    expect(result.subagents[0].spawning_tool_use_id).toBe("toolu_01abc");
  });

  test("extracts skill invocation", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "/commit" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_001",
          model: "claude-opus-4-6",
          content: [{
            type: "tool_use",
            id: "toolu_01abc",
            name: "Skill",
            input: { skill: "commit" },
          }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "user",
        timestamp: "2025-05-10T10:00:02.000Z",
        message: {
          role: "user",
          content: [{
            tool_use_id: "toolu_01abc",
            type: "tool_result",
            content: "Skill loaded",
          }],
        },
        toolUseResult: { success: true, commandName: "commit" },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].skill_name).toBe("commit");
    expect(result.skills[0].invoked_by).toBe("user"); // /commit was user-invoked
  });

  test("extracts team creation", async () => {
    // ... similar pattern with TeamCreate tool call
  });

  test("extracts worktree creation", async () => {
    // ... similar pattern with EnterWorktree tool call
  });
});
```

**Step 5: Run tests**

Run: `bun test --cwd packages/core -- transcript-parser 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All pass (including existing tests — no regressions).

**Step 6: Commit**

```bash
git add packages/core/src/transcript-parser.ts packages/core/src/__tests__/transcript-parser.test.ts
git commit -m "feat: extract subagents, teams, skills, worktrees from transcripts"
```

---

### Task 7: Hook CLI Commands

**Dependencies:** Task 5 (handlers must exist to process emitted events)

**Files:**
- Modify: `packages/cli/src/commands/cc-hook.ts` — add subagent-start, subagent-stop, post-tool-use, worktree-create, worktree-remove subcommands

**Step 1: Add `subagent-start` subcommand**

Follow the exact pattern of the existing `session-start` subcommand in `cc-hook.ts`:

```typescript
hook.command("subagent-start")
  .description("Internal: handle SubagentStart CC hook")
  .action(async () => {
    try {
      const raw = await Bun.stdin.text();
      const ctx = JSON.parse(raw);
      const sessionId = ctx.session_id;
      const workspaceId = await resolveWorkspace(ctx.cwd);

      await runEmit("subagent.start", {
        data: {
          session_id: sessionId,
          agent_id: ctx.agent_id ?? ctx.agentId ?? "unknown",
          agent_type: ctx.agent_type ?? ctx.agentType ?? "unknown",
          agent_name: ctx.agent_name ?? ctx.agentName,
          model: ctx.model,
          team_name: ctx.team_name ?? ctx.teamName,
          isolation: ctx.isolation,
          run_in_background: ctx.run_in_background ?? ctx.runInBackground ?? false,
        },
        workspaceId,
      });
    } catch {}
    process.exit(0);
  });
```

**Step 2: Add `subagent-stop`, `worktree-create`, `worktree-remove` subcommands**

Same pattern, extracting relevant fields from stdin JSON.

**Step 3: Add `post-tool-use` subcommand**

This one dispatches based on `tool_name`:

```typescript
hook.command("post-tool-use")
  .description("Internal: handle PostToolUse CC hook")
  .action(async () => {
    try {
      const raw = await Bun.stdin.text();
      const ctx = JSON.parse(raw);
      const sessionId = ctx.session_id;
      const toolName = ctx.tool_name;
      const toolInput = ctx.tool_input ?? {};
      const toolResponse = ctx.tool_response ?? {};
      const workspaceId = await resolveWorkspace(ctx.cwd);

      if (toolName === "TeamCreate") {
        await runEmit("team.create", {
          data: {
            session_id: sessionId,
            team_name: toolInput.team_name,
            description: toolInput.description,
          },
          workspaceId,
        });
      } else if (toolName === "SendMessage") {
        await runEmit("team.message", {
          data: {
            session_id: sessionId,
            team_name: "", // derived from context or toolInput
            message_type: toolInput.type,
            from: "self",
            to: toolInput.recipient,
          },
          workspaceId,
        });
      } else if (toolName === "Skill") {
        await runEmit("skill.invoke", {
          data: {
            session_id: sessionId,
            skill_name: toolInput.skill,
            args: toolInput.args,
          },
          workspaceId,
        });
      } else if (toolName === "EnterWorktree") {
        await runEmit("worktree.create", {
          data: {
            session_id: sessionId,
            worktree_name: toolInput.name,
          },
          workspaceId,
        });
      }
    } catch {}
    process.exit(0);
  });
```

**Step 4: Run existing hook tests to verify no regressions**

Run: `bun test --cwd packages/cli 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All existing tests pass.

**Step 5: Commit**

```bash
git add packages/cli/src/commands/cc-hook.ts
git commit -m "feat: add CC hook handlers for subagents, post-tool-use, worktrees"
```

---

### Task 8: Hook Registration

**Dependencies:** Task 7 (hook commands must exist)

**Files:**
- Modify: `packages/cli/src/commands/hooks.ts` — register new hooks

**Step 1: Add new hook definitions**

In `hooks.ts`, find where `SessionStart` and `SessionEnd` hooks are defined. Add the new hooks following the same pattern:

```typescript
// The existing hook command format wraps stdin capture + background execution:
// bash -c 'data=$(cat); printf "%s" "$data" | fuel-code cc-hook <subcommand> &'

const NEW_HOOKS = {
  SubagentStart: {
    matcher: "",
    command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook subagent-start &'`,
  },
  SubagentStop: {
    matcher: "",
    command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook subagent-stop &'`,
  },
  PostToolUse: [
    {
      matcher: "TeamCreate",
      command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook post-tool-use &'`,
    },
    {
      matcher: "Skill",
      command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook post-tool-use &'`,
    },
    {
      matcher: "EnterWorktree",
      command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook post-tool-use &'`,
    },
  ],
  WorktreeCreate: {
    matcher: "",
    command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook worktree-create &'`,
  },
  WorktreeRemove: {
    matcher: "",
    command: `bash -c 'data=$(cat); printf "%s" "$data" | ${cliCmd} cc-hook worktree-remove &'`,
  },
};
```

**Step 2: Update `upsertHook` calls to register new hooks**

Add registrations in the install flow. The `upsertHook` function should handle both single-entry hooks (SubagentStart, SubagentStop, WorktreeCreate, WorktreeRemove) and multi-entry hooks (PostToolUse with 3 matchers).

**Step 3: Update `isFuelCodeHookCommand` detection**

Ensure the detection function recognizes the new subcommands (`subagent-start`, `subagent-stop`, `post-tool-use`, `worktree-create`, `worktree-remove`) so uninstall/update works correctly.

**Step 4: Update `hooks status` output**

Add the new hooks to the status display so `fuel-code hooks status` shows their registration state.

**Step 5: Test install/uninstall cycle manually**

Run: `fuel-code hooks install --cc-only`
Verify: `cat ~/.claude/settings.json | python3 -m json.tool` shows all new hooks.
Run: `fuel-code hooks status`
Verify: All hooks show as installed.
Run: `fuel-code hooks uninstall --cc-only`
Verify: All hooks removed from settings.json.

**Step 6: Commit**

```bash
git add packages/cli/src/commands/hooks.ts
git commit -m "feat: register SubagentStart/Stop, PostToolUse, Worktree hooks in CC settings"
```

---

### Task 9: Session Pipeline — Persist Relationships

**Dependencies:** Task 6 (parser must return relationship data)

**Files:**
- Modify: `packages/core/src/session-pipeline.ts`
- Test: `packages/core/src/__tests__/session-pipeline.test.ts`

**Step 1: Add `persistRelationships` function**

After the transcript is parsed and messages/blocks are inserted, add a new step:

```typescript
async function persistRelationships(
  sql: Sql,
  sessionId: string,
  parseResult: ParseResult,
  logger: Logger,
): Promise<void> {
  // 1. Upsert subagents
  for (const sa of parseResult.subagents) {
    const id = generateId();
    await sql`
      INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model,
                             team_name, isolation, run_in_background, spawning_tool_use_id,
                             status, started_at)
      VALUES (${id}, ${sessionId}, ${sa.agent_id}, ${sa.agent_type}, ${sa.agent_name ?? null},
              ${sa.model ?? null}, ${sa.team_name ?? null}, ${sa.isolation ?? null},
              ${sa.run_in_background}, ${sa.spawning_tool_use_id}, 'completed',
              ${sa.started_at ?? null})
      ON CONFLICT ON CONSTRAINT subagents_pkey DO NOTHING
    `;
  }

  // 2. Upsert teams
  for (const team of parseResult.teams) {
    const id = generateId();
    await sql`
      INSERT INTO teams (id, team_name, description, lead_session_id, created_at, member_count)
      VALUES (${id}, ${team.team_name}, ${team.description ?? null}, ${sessionId},
              NOW(), ${team.message_count})
      ON CONFLICT (team_name) DO UPDATE SET
        member_count = EXCLUDED.member_count,
        metadata = COALESCE(teams.metadata, '{}')
    `;
  }

  // 3. Insert skills
  for (const skill of parseResult.skills) {
    const id = generateId();
    await sql`
      INSERT INTO session_skills (id, session_id, skill_name, invoked_at, invoked_by, args)
      VALUES (${id}, ${sessionId}, ${skill.skill_name}, ${skill.invoked_at},
              ${skill.invoked_by}, ${skill.args ?? null})
    `;
  }

  // 4. Insert worktrees
  for (const wt of parseResult.worktrees) {
    const id = generateId();
    await sql`
      INSERT INTO session_worktrees (id, session_id, worktree_name, created_at)
      VALUES (${id}, ${sessionId}, ${wt.worktree_name ?? null}, ${wt.created_at})
    `;
  }

  // 5. Update session with team/permission info
  if (parseResult.teams.length > 0 || parseResult.permission_mode) {
    const teamName = parseResult.teams[0]?.team_name ?? null;
    const teamRole = teamName ? "lead" : null;
    const permMode = parseResult.permission_mode ?? null;
    await sql`
      UPDATE sessions SET
        team_name = COALESCE(${teamName}, team_name),
        team_role = COALESCE(${teamRole}, team_role),
        permission_mode = COALESCE(${permMode}, permission_mode)
      WHERE id = ${sessionId}
    `;
  }

  logger.info({
    sessionId,
    subagents: parseResult.subagents.length,
    teams: parseResult.teams.length,
    skills: parseResult.skills.length,
    worktrees: parseResult.worktrees.length,
  }, "persisted session relationships");
}
```

**Step 2: Call `persistRelationships` in the pipeline**

In `runSessionPipeline`, after the batch INSERT of messages/blocks and before the `transitionSession` call:

```typescript
await persistRelationships(sql, sessionId, parseResult, logger);
```

**Step 3: Write tests**

Add to `packages/core/src/__tests__/session-pipeline.test.ts`:

```typescript
test("pipeline persists subagents from parsed transcript", async () => {
  // ... mock S3 to return a transcript with Task tool calls
  // ... run pipeline
  // ... verify subagents INSERT was called with expected values
});
```

**Step 4: Run tests**

Run: `bun test --cwd packages/core -- session-pipeline 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All pass.

**Step 5: Commit**

```bash
git add packages/core/src/session-pipeline.ts packages/core/src/__tests__/session-pipeline.test.ts
git commit -m "feat: persist subagents, teams, skills, worktrees in session pipeline"
```

---

### Task 10: API Endpoints

**Dependencies:** Tasks 1, 2 (migration + types)

**Files:**
- Modify: `packages/server/src/routes/sessions.ts` — enhance detail, add sub-endpoints
- Create: `packages/server/src/routes/teams.ts`
- Modify: `packages/server/src/app.ts` — mount teams router
- Test: Integration tests (optional — existing e2e covers pattern)

**Step 1: Enhance session detail endpoint**

In `GET /api/sessions/:id`, after the main session query, add joins:

```typescript
// Fetch subagents for this session
const subagents = await sql`
  SELECT id, agent_id, agent_type, agent_name, model, status, started_at, ended_at, team_name
  FROM subagents WHERE session_id = ${id} ORDER BY started_at
`;

// Fetch skills
const skills = await sql`
  SELECT id, skill_name, invoked_at, invoked_by, args
  FROM session_skills WHERE session_id = ${id} ORDER BY invoked_at
`;

// Fetch worktrees
const worktrees = await sql`
  SELECT id, worktree_name, branch, created_at, removed_at, had_changes
  FROM session_worktrees WHERE session_id = ${id} ORDER BY created_at
`;

// Fetch team info if session is part of a team
let team = null;
if (session.team_name) {
  const [t] = await sql`SELECT * FROM teams WHERE team_name = ${session.team_name}`;
  team = t ?? null;
}

// Fetch resumed-from session
let resumedFrom = null;
if (session.resumed_from_session_id) {
  const [rf] = await sql`
    SELECT id, started_at, initial_prompt FROM sessions WHERE id = ${session.resumed_from_session_id}
  `;
  resumedFrom = rf ?? null;
}

// Add to response
return res.json({ ...session, subagents, skills, worktrees, team, resumed_from: resumedFrom });
```

**Step 2: Add sub-endpoints**

```typescript
// GET /api/sessions/:id/subagents
router.get("/sessions/:id/subagents", async (req, res) => {
  const rows = await sql`
    SELECT * FROM subagents WHERE session_id = ${req.params.id} ORDER BY started_at
  `;
  res.json(rows);
});

// GET /api/sessions/:id/skills
router.get("/sessions/:id/skills", async (req, res) => {
  const rows = await sql`
    SELECT * FROM session_skills WHERE session_id = ${req.params.id} ORDER BY invoked_at
  `;
  res.json(rows);
});

// GET /api/sessions/:id/worktrees
router.get("/sessions/:id/worktrees", async (req, res) => {
  const rows = await sql`
    SELECT * FROM session_worktrees WHERE session_id = ${req.params.id} ORDER BY created_at
  `;
  res.json(rows);
});
```

**Step 3: Add session list filters**

In `GET /api/sessions`, add query param support:

```typescript
// team filter
if (query.team) {
  conditions.push(sql`s.team_name = ${query.team}`);
}
// has_subagents filter
if (query.has_subagents === "true") {
  conditions.push(sql`s.subagent_count > 0`);
}
```

**Step 4: Create teams router**

Create `packages/server/src/routes/teams.ts`:

```typescript
import { Router } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";

export function createTeamsRouter(deps: { sql: Sql; logger: Logger }): Router {
  const { sql } = deps;
  const router = Router();

  // GET /api/teams
  router.get("/teams", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 250);
    const rows = await sql`
      SELECT t.*,
             s.initial_prompt as lead_prompt,
             s.started_at as lead_started_at
      FROM teams t
      LEFT JOIN sessions s ON t.lead_session_id = s.id
      ORDER BY t.created_at DESC
      LIMIT ${limit}
    `;
    res.json(rows);
  });

  // GET /api/teams/:name
  router.get("/teams/:name", async (req, res) => {
    const [team] = await sql`SELECT * FROM teams WHERE team_name = ${req.params.name}`;
    if (!team) return res.status(404).json({ error: "Team not found" });

    const members = await sql`
      SELECT * FROM subagents WHERE team_name = ${req.params.name} ORDER BY started_at
    `;

    res.json({ ...team, members });
  });

  return router;
}
```

**Step 5: Mount in app.ts**

In `packages/server/src/app.ts`, add:

```typescript
import { createTeamsRouter } from "./routes/teams.js";

// After other router mounts:
app.use("/api", createTeamsRouter({ sql, logger }));
```

**Step 6: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/src/routes/teams.ts packages/server/src/app.ts
git commit -m "feat: add API endpoints for subagents, teams, skills, worktrees"
```

---

### Task 11: TUI Session Detail Enhancements

**Dependencies:** Task 10 (API must return new data)

**Files:**
- Create: `packages/cli/src/tui/components/SubagentsPanel.tsx`
- Create: `packages/cli/src/tui/components/SkillsPanel.tsx`
- Modify: `packages/cli/src/tui/SessionDetailView.tsx`
- Modify: `packages/cli/src/tui/hooks/useSessionDetail.ts` (if exists)

**Step 1: Create `SubagentsPanel.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { Subagent } from "@fuel-code/shared";

interface Props {
  subagents: Subagent[];
}

export function SubagentsPanel({ subagents }: Props) {
  if (subagents.length === 0) return null;

  // Group by type
  const byType = new Map<string, Subagent[]>();
  for (const sa of subagents) {
    const group = byType.get(sa.agent_type) ?? [];
    group.push(sa);
    byType.set(sa.agent_type, group);
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Sub-agents ({subagents.length})</Text>
      {[...byType.entries()].map(([type, agents]) => (
        <Box key={type} flexDirection="column">
          <Text dimColor>{type} ({agents.length})</Text>
          {agents.map((sa) => (
            <Text key={sa.id}>
              {"  "}{sa.agent_name ?? sa.agent_id.slice(0, 7)}{" "}
              <Text color={sa.status === "completed" ? "green" : sa.status === "running" ? "yellow" : "red"}>
                [{sa.status}]
              </Text>
              {sa.model ? <Text dimColor> {sa.model.split("-").slice(-1)}</Text> : null}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
```

**Step 2: Create `SkillsPanel.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { SessionSkill } from "@fuel-code/shared";

interface Props {
  skills: SessionSkill[];
}

export function SkillsPanel({ skills }: Props) {
  if (skills.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Skills ({skills.length})</Text>
      {skills.map((s) => (
        <Text key={s.id}>
          {s.invoked_by === "user" ? "/" : ""}{s.skill_name}
          <Text dimColor> ({s.invoked_by ?? "unknown"})</Text>
        </Text>
      ))}
    </Box>
  );
}
```

**Step 3: Add to SessionDetailView**

In the sidebar section of `SessionDetailView.tsx`, add the new panels:

```tsx
import { SubagentsPanel } from "./components/SubagentsPanel.js";
import { SkillsPanel } from "./components/SkillsPanel.js";

// In the sidebar render (alongside ToolsUsedPanel, GitActivityPanel):
{session.subagents && <SubagentsPanel subagents={session.subagents} />}
{session.skills && <SkillsPanel skills={session.skills} />}
```

In the header section, add team badge and chain breadcrumb:

```tsx
// Team badge
{session.team_name && (
  <Text color="cyan">[team: {session.team_name} ({session.team_role})]</Text>
)}

// Session chain
{session.resumed_from && (
  <Text dimColor>Resumed from {session.resumed_from.id.slice(0, 8)}...</Text>
)}

// Worktree indicator
{session.worktrees?.length > 0 && (
  <Text color="magenta">[worktree: {session.worktrees[0].worktree_name}]</Text>
)}
```

**Step 4: Update session list badges**

In the session list view, add visual indicators:

```tsx
// After session prompt/summary text:
{session.subagent_count > 0 && <Text dimColor> [{session.subagent_count} agents]</Text>}
{session.team_name && <Text color="cyan"> [team]</Text>}
```

**Step 5: Commit**

```bash
git add packages/cli/src/tui/
git commit -m "feat: add subagents panel, skills panel, team badge to TUI session detail"
```

---

### Task 12: TUI Teams View

**Dependencies:** Task 10 (teams API), Task 11 (TUI patterns established)

**Files:**
- Create: `packages/cli/src/tui/TeamsListView.tsx`
- Create: `packages/cli/src/tui/TeamDetailView.tsx`
- Modify: `packages/cli/src/tui/App.tsx` — add teams view route
- Modify: `packages/cli/src/tui/Dashboard.tsx` (or equivalent) — add `t` keybind

**Step 1: Create `TeamsListView.tsx`**

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Team } from "@fuel-code/shared";

interface Props {
  apiClient: ApiClient;
  onSelectTeam: (teamName: string) => void;
  onBack: () => void;
}

export function TeamsListView({ apiClient, onSelectTeam, onBack }: Props) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get("/api/teams").then((data) => {
      setTeams(data);
      setLoading(false);
    });
  }, []);

  useInput((input, key) => {
    if (input === "j" || key.downArrow) setSelected((s) => Math.min(s + 1, teams.length - 1));
    if (input === "k" || key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    if (key.return) onSelectTeam(teams[selected].team_name);
    if (input === "b" || key.escape) onBack();
  });

  if (loading) return <Text>Loading teams...</Text>;
  if (teams.length === 0) return <Text dimColor>No teams found.</Text>;

  return (
    <Box flexDirection="column">
      <Text bold>Teams ({teams.length})</Text>
      {teams.map((t, i) => (
        <Box key={t.id}>
          <Text inverse={i === selected}>
            {t.team_name} — {t.member_count} members — {t.description?.slice(0, 60) ?? ""}
          </Text>
        </Box>
      ))}
      <Text dimColor>j/k navigate | Enter select | b back</Text>
    </Box>
  );
}
```

**Step 2: Create `TeamDetailView.tsx`**

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Team, Subagent } from "@fuel-code/shared";

interface Props {
  apiClient: ApiClient;
  teamName: string;
  onSelectSession: (sessionId: string) => void;
  onBack: () => void;
}

export function TeamDetailView({ apiClient, teamName, onSelectSession, onBack }: Props) {
  const [team, setTeam] = useState<(Team & { members: Subagent[] }) | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    apiClient.get(`/api/teams/${teamName}`).then(setTeam);
  }, [teamName]);

  useInput((input, key) => {
    if (!team) return;
    const members = team.members ?? [];
    if (input === "j" || key.downArrow) setSelected((s) => Math.min(s + 1, members.length - 1));
    if (input === "k" || key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    if (key.return && members[selected]) onSelectSession(members[selected].session_id);
    if (input === "b" || key.escape) onBack();
  });

  if (!team) return <Text>Loading...</Text>;

  return (
    <Box flexDirection="column">
      <Text bold>{team.team_name}</Text>
      {team.description && <Text dimColor>{team.description}</Text>}
      <Text>Members: {team.member_count} | Created: {team.created_at}</Text>
      <Box flexDirection="column" marginTop={1}>
        {(team.members ?? []).map((m, i) => (
          <Text key={m.id} inverse={i === selected}>
            {m.agent_name ?? m.agent_id.slice(0, 7)} [{m.agent_type}] — {m.status}
            {m.model ? ` (${m.model})` : ""}
          </Text>
        ))}
      </Box>
      <Text dimColor>j/k navigate | Enter view session | b back</Text>
    </Box>
  );
}
```

**Step 3: Update App.tsx view routing**

Add new view types:

```typescript
type View =
  | { name: "dashboard" }
  | { name: "session-detail"; sessionId: string }
  | { name: "teams" }
  | { name: "team-detail"; teamName: string }
```

Add rendering:

```tsx
{view.name === "teams" && (
  <TeamsListView
    apiClient={apiClient}
    onSelectTeam={(name) => setView({ name: "team-detail", teamName: name })}
    onBack={() => setView({ name: "dashboard" })}
  />
)}
{view.name === "team-detail" && (
  <TeamDetailView
    apiClient={apiClient}
    teamName={view.teamName}
    onSelectSession={(id) => setView({ name: "session-detail", sessionId: id })}
    onBack={() => setView({ name: "teams" })}
  />
)}
```

**Step 4: Add `t` keybind to dashboard**

In Dashboard component, add to `useInput`:

```typescript
if (input === "t") onNavigate({ name: "teams" });
```

Add to footer hint: `t teams`

**Step 5: Commit**

```bash
git add packages/cli/src/tui/
git commit -m "feat: add Teams list and detail views to TUI"
```

---

### Task 13: Backfill Scanner — Sub-agent Transcript Discovery

**Dependencies:** Tasks 6, 9 (parser + pipeline must handle sub-agent data)

**Files:**
- Modify: `packages/core/src/session-backfill.ts`
- Modify: `packages/cli/src/commands/cc-hook.ts` (session-end handler)
- Test: `packages/core/src/__tests__/session-backfill.test.ts`

**Context:** The backfill scanner (`session-backfill.ts`) currently **skips all subdirectories** in project dirs (line 388-391), which means `{sessionId}/subagents/agent-*.jsonl` files are entirely ignored. The `isSessionActive()` function (tail check for `/exit` + `lsof`) already works correctly for sub-agent files without modification.

**Step 1: Modify `scanForSessions` to discover sub-agent transcripts**

Currently at line 388:
```typescript
// Skip subdirectories (subagent transcripts live in {sessionId}/subagents/)
if (entry.isDirectory()) {
  result.skipped.subagents++;
  continue;
}
```

Replace with logic that enters the subdirectory if it matches the `{uuid}/subagents/` pattern:

```typescript
if (entry.isDirectory()) {
  // Check if this is a session directory with subagent transcripts
  const subagentsDir = path.join(entryPath, "subagents");
  if (fs.existsSync(subagentsDir)) {
    // Discover sub-agent transcript files
    try {
      const subEntries = fs.readdirSync(subagentsDir, { withFileTypes: true });
      for (const subEntry of subEntries) {
        if (!subEntry.isFile() || !subEntry.name.endsWith(".jsonl")) continue;
        const subPath = path.join(subagentsDir, subEntry.name);

        // Same active session check — lsof detects if sub-agent is still running
        if (isSessionActive(subPath)) {
          result.skipped.potentiallyActive++;
          continue;
        }

        // Extract agent ID from filename: "agent-a834e7d.jsonl" -> "a834e7d"
        const agentIdMatch = subEntry.name.match(/^agent-(.+)\.jsonl$/);
        if (!agentIdMatch) continue;

        // Parent session ID is the directory name (a UUID)
        const parentSessionId = entry.name;

        result.discoveredSubagents.push({
          agentId: agentIdMatch[1],
          parentSessionId,
          transcriptPath: subPath,
          projectDir,
          fileSizeBytes: fs.statSync(subPath).size,
        });
      }
    } catch {
      result.errors.push({ path: subagentsDir, error: "Failed to read subagents dir" });
    }
  }
  continue;
}
```

**Step 2: Add `DiscoveredSubagentTranscript` type and extend `ScanResult`**

```typescript
export interface DiscoveredSubagentTranscript {
  agentId: string;
  parentSessionId: string;
  transcriptPath: string;
  projectDir: string;
  fileSizeBytes: number;
}

// Add to ScanResult:
discoveredSubagents: DiscoveredSubagentTranscript[];
```

**Step 3: Process sub-agent transcripts in `ingestBackfillSessions`**

After each parent session is ingested and its transcript parsed, process its sub-agent transcripts:

```typescript
// For each parent session that was ingested, upload sub-agent transcripts
const subagentsForSession = discoveredSubagents.filter(
  sa => sa.parentSessionId === session.sessionId
);
for (const sa of subagentsForSession) {
  // Upload sub-agent transcript to S3
  const s3Key = `transcripts/${sa.parentSessionId}/subagents/${sa.agentId}.jsonl`;
  await uploadTranscript(sa.transcriptPath, s3Key, serverUrl, apiKey);
  // The pipeline's persistRelationships step handles the rest
}
```

**Step 4: Modify session-end hook to upload sub-agent transcripts**

In `packages/cli/src/commands/cc-hook.ts`, in the `session-end` handler, after uploading the main transcript:

```typescript
// Discover and upload sub-agent transcripts
const sessionDir = path.dirname(transcriptPath);
const subagentsDir = path.join(sessionDir, sessionId, "subagents");
if (fs.existsSync(subagentsDir)) {
  const subFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith(".jsonl"));
  for (const subFile of subFiles) {
    const subPath = path.join(subagentsDir, subFile);
    // Only upload if the sub-agent is no longer active
    if (!isSessionActive(subPath)) {
      const agentId = subFile.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      await runTranscriptUpload(sessionId, subPath, `subagents/${agentId}`);
    }
  }
}
```

**Step 5: Write tests**

Add to `packages/core/src/__tests__/session-backfill.test.ts`:

```typescript
describe("sub-agent transcript discovery", () => {
  test("discovers sub-agent transcripts in session subdirectories", async () => {
    // Create temp directory structure:
    // project-dir/
    //   session-uuid.jsonl
    //   session-uuid/subagents/agent-abc123.jsonl
    // Run scanForSessions
    // Verify discoveredSubagents includes the sub-agent file
  });

  test("skips active sub-agent transcripts via isSessionActive", async () => {
    // Create sub-agent transcript that's still "active" (mock lsof)
    // Verify it's in skipped.potentiallyActive, not in discovered
  });

  test("extracts agent ID from filename", async () => {
    // agent-a834e7d.jsonl -> agentId: "a834e7d"
    // agent-acompact-14c8fc.jsonl -> agentId: "acompact-14c8fc" (compact agent)
  });
});
```

**Step 6: Run tests**

Run: `bun test --cwd packages/core -- session-backfill 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All pass.

**Step 7: Commit**

```bash
git add packages/core/src/session-backfill.ts packages/core/src/__tests__/session-backfill.test.ts packages/cli/src/commands/cc-hook.ts
git commit -m "feat: discover and upload sub-agent transcripts in backfill and session-end"
```

---

## Summary

| Task | Description | Deps | Est. Size |
|------|-------------|------|-----------|
| 1 | Migration (005) | None | Small |
| 2 | Shared types | None | Small |
| 3 | Event types + Zod schemas | 1 | Medium |
| 4 | Git hooks worktree detection | 1 | Medium |
| 5 | Event handlers (7 new) | 1, 3 | Medium |
| 6 | Transcript parser enhancements | 2, 3 | Large |
| 7 | Hook CLI commands | 5 | Medium |
| 8 | Hook registration | 7 | Small |
| 9 | Session pipeline persist_relationships | 6 | Medium |
| 10 | API endpoints | 1, 2 | Medium |
| 11 | TUI session detail enhancements | 10 | Medium |
| 12 | TUI teams view | 10, 11 | Medium |
| 13 | Backfill scanner sub-agent discovery | 6, 9 | Medium |
