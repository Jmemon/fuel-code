# Task 2: Shared Types + ParseResult Extension

## Parallel Group: A

## Dependencies: None

## Description

Create four new type files in `packages/shared/src/types/` and extend existing types to support Phase 4-2 data. Also update the transcript parser's return statement to include empty arrays for the new `ParseResult` fields — this is a minimal, backward-compatible change that prevents downstream breakage.

### New Files

**`packages/shared/src/types/subagent.ts`**:
```typescript
export interface Subagent {
  id: string;
  session_id: string;
  agent_id: string;           // CC's internal ID (e.g., "a834e7d28b48e3de6")
  agent_type: string;         // "Explore", "Plan", "general-purpose", custom name
  agent_name?: string;        // for named agents (e.g., "phase-4-reviewer")
  model?: string;             // "claude-opus-4-6", "claude-haiku-4-5-20251001", etc.
  spawning_tool_use_id?: string;
  team_name?: string;
  isolation?: string;         // "worktree" or undefined
  run_in_background: boolean;
  status: 'running' | 'completed' | 'failed';
  started_at?: string;
  ended_at?: string;
  transcript_s3_key?: string;
  metadata: Record<string, unknown>;
}
```

**`packages/shared/src/types/team.ts`**:
```typescript
import type { Subagent } from './subagent.js';

export interface Team {
  id: string;
  team_name: string;
  description?: string;
  lead_session_id?: string;
  created_at: string;
  ended_at?: string;
  member_count: number;
  members?: Subagent[];       // joined from subagents table when requested
  metadata: Record<string, unknown>;
}
```

**`packages/shared/src/types/skill.ts`**:
```typescript
export interface SessionSkill {
  id: string;
  session_id: string;
  skill_name: string;
  invoked_at: string;
  invoked_by?: 'user' | 'claude';
  args?: string;
  metadata?: Record<string, unknown>;
}
```

**`packages/shared/src/types/worktree.ts`**:
```typescript
export interface SessionWorktree {
  id: string;
  session_id: string;
  worktree_name?: string;
  branch?: string;
  created_at: string;
  removed_at?: string;
  had_changes?: boolean;
  metadata?: Record<string, unknown>;
}
```

### Modifications to Existing Files

**`packages/shared/src/types/session.ts`** — Add optional fields:
```typescript
// Session chain
resumed_from_session_id?: string;

// Team membership
team_name?: string;
team_role?: 'lead' | 'member';

// Permission mode used during the session
permission_mode?: string;

// Joined data (populated by detail queries, not always present)
subagents?: Subagent[];
skills?: SessionSkill[];
worktrees?: SessionWorktree[];
team?: Team;
resumed_from?: { id: string; started_at: string; initial_prompt?: string };
resumed_by?: { id: string; started_at: string; initial_prompt?: string }[];
```

**`packages/shared/src/types/transcript.ts`** — Add parsed relationship types:
```typescript
export interface ParsedSubagent {
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

export interface ParsedTeam {
  team_name: string;
  description?: string;
  message_count: number;
}

export interface ParsedSkill {
  skill_name: string;
  invoked_at: string;
  invoked_by: 'user' | 'claude';
  args?: string;
}

export interface ParsedWorktree {
  worktree_name?: string;
  created_at: string;
}
```

Extend `ParseResult`:
```typescript
// Add to existing ParseResult interface
subagents: ParsedSubagent[];
teams: ParsedTeam[];
skills: ParsedSkill[];
worktrees: ParsedWorktree[];
permission_mode?: string;
resumed_from_session_id?: string;
```

**`packages/shared/src/types/index.ts`** — Add barrel exports for all new types.

**`packages/core/src/transcript-parser.ts`** — Update the return statement in `parseTranscript()` to include:
```typescript
subagents: [],
teams: [],
skills: [],
worktrees: [],
```
This is a **minimal** change — just add empty arrays to the return object so the extended `ParseResult` type is satisfied. The actual extraction logic is Task 7 and Task 9.

## Relevant Files
- Create: `packages/shared/src/types/subagent.ts`
- Create: `packages/shared/src/types/team.ts`
- Create: `packages/shared/src/types/skill.ts`
- Create: `packages/shared/src/types/worktree.ts`
- Modify: `packages/shared/src/types/session.ts`
- Modify: `packages/shared/src/types/transcript.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/core/src/transcript-parser.ts` (return statement only)

## Success Criteria
1. `bun run typecheck` passes across all packages (`shared`, `core`, `cli`, `server`).
2. All new types importable via `import { Subagent, Team, SessionSkill, SessionWorktree } from '@fuel-code/shared'`.
3. `ParseResult` includes `subagents`, `teams`, `skills`, `worktrees` arrays — empty by default.
4. `Session` interface additions are all **optional** — no breakage of existing code that constructs Session objects.
5. Existing parser callers receive empty arrays (not `undefined`) for the new fields.
6. All existing tests pass without modification.
