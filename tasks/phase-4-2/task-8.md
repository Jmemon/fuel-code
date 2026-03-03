# Task 8: Hook Installer — Register New Hooks

## Parallel Group: C

## Dependencies: Task 6 (CC hook CLI subcommands must exist)

## Description

Update `packages/cli/src/commands/hooks.ts` to register 8 new hook entries across 5 CC hook events. The existing installer manages `SessionStart` and `SessionEnd`. This task adds `SubagentStart`, `SubagentStop`, `PostToolUse` (with 4 matchers), `WorktreeCreate`, and `WorktreeRemove`.

### Hook Entries to Register

In `~/.claude/settings.json` under the `hooks` key:

```json
{
  "hooks": {
    "SessionStart": [{ "type": "command", "command": "..." }],
    "SessionEnd": [{ "type": "command", "command": "..." }],
    "SubagentStart": [{
      "type": "command",
      "command": "fuel-code cc-hook subagent-start"
    }],
    "SubagentStop": [{
      "type": "command",
      "command": "fuel-code cc-hook subagent-stop"
    }],
    "PostToolUse": [
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "TeamCreate"
      },
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "Skill"
      },
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "EnterWorktree"
      },
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "SendMessage"
      }
    ],
    "WorktreeCreate": [{
      "type": "command",
      "command": "fuel-code cc-hook worktree-create"
    }],
    "WorktreeRemove": [{
      "type": "command",
      "command": "fuel-code cc-hook worktree-remove"
    }]
  }
}
```

### Implementation Notes

1. **PostToolUse matcher support**: The existing `upsertHook()` function (or equivalent) likely doesn't handle per-matcher entries. PostToolUse has multiple entries in the same array, each with a different `matcher` field. Create a helper that:
   - Reads the existing `PostToolUse` array
   - Adds/updates entries by matching on both `command` substring AND `matcher` value
   - Preserves non-fuel-code PostToolUse entries (other tools may have their own hooks)

2. **Idempotent install**: Running `fuel-code hooks install` twice should produce the same result. Check for existing entries before inserting.

3. **Uninstall**: `fuel-code hooks uninstall` should remove all 8 new entries (plus the existing 2). Detection by `fuel-code` or `cc-hook` substring in the command field. Must preserve non-fuel-code hooks.

4. **Status**: `fuel-code hooks status` should report all 10 hook entries (2 existing + 8 new). For PostToolUse, show each matcher separately.

5. **settings.json format**: The existing code reads/writes `~/.claude/settings.json`. The hooks key might not exist if it's a fresh install. Handle `hooks` key creation.

### Backward Compatibility

Running `fuel-code hooks install` on a machine with only SessionStart/SessionEnd should add the new hooks without disrupting the existing ones. The install is additive.

## Relevant Files
- Modify: `packages/cli/src/commands/hooks.ts`

## Success Criteria
1. `fuel-code hooks install` registers all 10 hook entries in `~/.claude/settings.json`.
2. PostToolUse has 4 separate entries with correct matchers (TeamCreate, Skill, EnterWorktree, SendMessage).
3. `fuel-code hooks install` run twice produces identical settings.json (idempotent).
4. `fuel-code hooks uninstall` removes all fuel-code hooks, preserves non-fuel-code hooks.
5. `fuel-code hooks status` reports all hooks with their registration state.
6. Non-fuel-code PostToolUse entries (from other tools) are preserved during install/uninstall.
7. Fresh machine (no settings.json or empty hooks key) installs cleanly.
8. Machine with only old SessionStart/SessionEnd hooks upgrades cleanly.
9. Existing hook tests pass.
