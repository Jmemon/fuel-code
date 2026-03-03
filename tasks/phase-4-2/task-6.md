# Task 6: CC Hook CLI Handlers (5 subcommands)

## Parallel Group: B

## Dependencies: Task 3 (event types to emit)

## Description

Add 5 new subcommands to `packages/cli/src/commands/cc-hook.ts` for the new Claude Code hooks. Follow the exact same defensive pattern as the existing `session-start` and `session-end` handlers: read stdin JSON, extract fields, resolve workspace, emit event, always exit 0, never write to stdout, swallow all errors.

### New Subcommands

**`fuel-code cc-hook subagent-start`**

CC provides via stdin:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "permission_mode": "default",
  "hook_event_name": "SubagentStart",
  "agent_id": "a834e7d28b48e3de6",
  "agent_type": "Explore"
}
```

Action: Emit `subagent.start` event with payload `{ session_id, agent_id, agent_type }`.

**`fuel-code cc-hook subagent-stop`**

CC provides via stdin:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "permission_mode": "default",
  "hook_event_name": "SubagentStop",
  "stop_hook_active": true,
  "agent_id": "a834e7d28b48e3de6",
  "agent_type": "Explore",
  "agent_transcript_path": "/path/to/subagents/agent-a834e7d.jsonl",
  "last_assistant_message": "..."
}
```

Action: Emit `subagent.stop` event with payload `{ session_id, agent_id, agent_type, agent_transcript_path }`.

**`fuel-code cc-hook post-tool-use`**

CC provides via stdin:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "TeamCreate",
  "tool_input": { "team_name": "my-team", "description": "..." },
  "tool_response": { ... },
  "tool_use_id": "toolu_01..."
}
```

Action: Dispatch based on `tool_name`:
- `TeamCreate` → emit `team.create` with `{ session_id, team_name, description }` from `tool_input`
- `Skill` → emit `skill.invoke` with `{ session_id, skill_name: tool_input.skill, args: tool_input.args }` from `tool_input`
- `EnterWorktree` → emit `worktree.create` with `{ session_id, worktree_name: tool_input.name }` from `tool_input`
- `SendMessage` → emit `team.message` with `{ session_id, team_name: <resolve from context>, message_type: tool_input.type, from: <current agent>, to: tool_input.recipient }` from `tool_input`
- Unknown `tool_name` → silently exit 0 (matchers should prevent this, but be safe)

**`fuel-code cc-hook worktree-create`**

CC provides via stdin:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "hook_event_name": "WorktreeCreate",
  "name": "bold-oak-a3f2"
}
```

Action: Emit `worktree.create` event with `{ session_id, worktree_name: name }`.

**`fuel-code cc-hook worktree-remove`**

CC provides via stdin:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "hook_event_name": "WorktreeRemove",
  "worktree_path": "/absolute/path/to/worktree"
}
```

Action: Emit `worktree.remove` event with `{ session_id, worktree_name: basename(worktree_path) }`.

### Defensive Requirements

Every handler MUST:
1. Wrap everything in try/catch — catch block logs to stderr and exits 0
2. Never write to stdout (CC captures stdout as hook output)
3. Handle empty stdin (exit 0)
4. Handle invalid JSON (exit 0)
5. Handle missing expected fields (exit 0 with stderr warning)
6. Use the same `resolveWorkspace(cwd)` call as session-start for workspace context
7. Use the existing `runEmit()` function or equivalent to emit the event (with local queue fallback)

### Hook Input Schema Notes

The schemas above are based on CC documentation. The handlers should be defensive about extra or missing fields:
- Use optional chaining (`?.`) for all field access
- Log the raw input at debug level for troubleshooting
- Don't crash on unexpected shapes — just skip and exit 0

## Relevant Files
- Modify: `packages/cli/src/commands/cc-hook.ts`

## Success Criteria
1. Each subcommand emits the correct event type from valid stdin JSON.
2. Each subcommand exits 0 on empty stdin, invalid JSON, missing fields, network errors.
3. No stdout output from any handler under any circumstance.
4. PostToolUse correctly dispatches TeamCreate → team.create, Skill → skill.invoke, EnterWorktree → worktree.create, SendMessage → team.message.
5. PostToolUse silently exits 0 for unknown tool_name.
6. Local event queue fallback works (events queued when server unreachable).
7. `fuel-code cc-hook --help` lists all 7 subcommands (existing 2 + new 5).
8. Existing session-start and session-end handlers are unaffected.
