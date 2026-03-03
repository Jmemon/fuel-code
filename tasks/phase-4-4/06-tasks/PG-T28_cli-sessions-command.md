# Task 28: CLI — `sessions` Command Teammate Display

## Phase: G — API + TUI + CLI
## Dependencies: T22, T23
## Parallelizable With: T27

---

## Description

Update the non-TUI `fuel-code sessions` command to display teammate information. This was called out in 04-notes.md — the design only specifies TUI changes but the CLI sessions command should also reflect teammates.

## Files

- **Modify**: `packages/cli/src/commands/sessions.ts` — update `formatSessionsTable` to show teammates instead of team_name-based grouping
- **Modify**: `packages/cli/src/commands/sessions.ts` — add `--teammates` flag or include by default

## Display Changes

Current grouping uses `team_name` on sessions to build box-drawing groups:
```
┌─ Team: ping-pong ─
│ ★ lead  Session abc123  ...
│ member  Session def456  ...
└──
```

New grouping: sessions with teammates show a teammates annotation line (similar to TUI):
```
● Session abc123 (claude-opus-4.6)  2h15m  [complete]
  "Implement agent teams support"
  └─ Teammates: alice, bob, player-a, player-b
  └─ Other: 10 utility agents
```

The ROLE column changes:
- `★ lead` → shown when session has teams (it IS the lead)
- `member` → removed (teammates are shown inline, not as separate sessions)

## How to Test

```bash
# Run sessions command
cd packages/cli && bun run fuel-code sessions --json | jq '.sessions[0].teammates'
cd packages/cli && bun run fuel-code sessions
```

## Success Criteria

1. Sessions with teammates show teammate names
2. Non-team sessions display unchanged
3. `--json` output includes teammates array
4. No reference to old `team_name`/`team_role` columns
5. ROLE column updated for new team model
