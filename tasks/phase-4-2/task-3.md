# Task 3: New Event Types (7)

## Parallel Group: A

## Dependencies: None

## Description

Add 7 new event types to `packages/shared/src/types/event.ts`. This is a purely additive change to the `EventType` union and `EVENT_TYPES` array. Add corresponding Zod schemas for event payload validation.

### New Event Types

```
subagent.start      Sub-agent spawned (from SubagentStart CC hook)
subagent.stop       Sub-agent finished (from SubagentStop CC hook)
team.create         Team created (from PostToolUse hook matching TeamCreate)
team.message        Inter-agent message (from PostToolUse hook matching SendMessage)
skill.invoke        Skill invoked (from PostToolUse hook matching Skill)
worktree.create     Worktree created (from WorktreeCreate CC hook)
worktree.remove     Worktree removed (from WorktreeRemove CC hook)
```

### Zod Schemas

Add to event payload schemas (in the same file or the appropriate schema file):

```typescript
// subagent.start
const SubagentStartPayload = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  agent_type: z.string(),
  agent_name: z.string().optional(),
  model: z.string().optional(),
  team_name: z.string().optional(),
  isolation: z.string().optional(),
  run_in_background: z.boolean().optional(),
});

// subagent.stop
const SubagentStopPayload = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  agent_type: z.string(),
  agent_transcript_path: z.string().optional(),
});

// team.create
const TeamCreatePayload = z.object({
  session_id: z.string(),
  team_name: z.string(),
  description: z.string().optional(),
});

// team.message
const TeamMessagePayload = z.object({
  session_id: z.string(),
  team_name: z.string(),
  message_type: z.string(),      // "message", "broadcast", "shutdown_request", etc.
  from: z.string().optional(),
  to: z.string().optional(),
});

// skill.invoke
const SkillInvokePayload = z.object({
  session_id: z.string(),
  skill_name: z.string(),
  args: z.string().optional(),
  invoked_by: z.string().optional(),
});

// worktree.create
const WorktreeCreatePayload = z.object({
  session_id: z.string(),
  worktree_name: z.string().optional(),
  branch: z.string().optional(),
});

// worktree.remove
const WorktreeRemovePayload = z.object({
  session_id: z.string(),
  worktree_name: z.string().optional(),
  had_changes: z.boolean().optional(),
});
```

Follow the existing pattern for how schemas are organized (check `packages/shared/src/schemas/` or wherever the current Zod schemas for event payloads live).

## Relevant Files
- Modify: `packages/shared/src/types/event.ts` (EventType union + EVENT_TYPES array)
- Modify or create: Event payload schema file(s) (follow existing pattern)

## Success Criteria
1. `EVENT_TYPES.length` is now 21 (was 14).
2. All 7 new strings are valid `EventType` values.
3. Zod schemas validate correct payloads and reject malformed ones.
4. The ingest endpoint (`POST /api/events/ingest`) accepts events with these new types without error.
5. Existing event types and their schemas are completely unaffected.
6. `bun run typecheck` passes.
7. Existing tests pass.
